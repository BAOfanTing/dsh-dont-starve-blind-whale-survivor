// OBSERVATION-01：观察节流 + 动作结果复用 + 批量中断 + JSON 合法性
//
// 这些测试跑**真实的 AiRunner / dispatcher / get_state 实现**（不 mock 关键逻辑），
// 用假的 bridge / callTool 提供可控的输入，验证行为而不是搜索 prompt 字符串。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AiRunner } from '../lib/agent.js'
import { createDispatcher } from '../lib/dispatcher.js'
import { normalizeState } from '../lib/state/snapshot.js'
import { executeTool } from '../lib/tools.js'

// ── 假 bridge：一份可控的状态文件 ──
function makeBridge(over = {}) {
  const raw = {
    data: {
      schema: 'bws.state/1',
      observer: { snapshot_id: 's10', sequence: 10, status: 'ok', timestamp: 1, sampled_at: 1, sample_age_ms: 0 },
      actor: {
        valid: true, actor_id: 'player:X', actor_type: 'player', prefab: 'wolfgang', name: '沃尔夫冈',
        alive: true, is_ghost: false, tile_x: 1, tile_z: 2, x: 4, y: 0, z: 8, ...(over.actor ?? {}),
      },
      player: {
        inventory: { used: 0, items: {}, slots: 15, is_full: false, ...(over.inventory ?? {}) },
        hunger: { current: 100, max: 200, percent: 50, ...(over.hunger ?? {}) },
        health: { current: 200, max: 200, percent: 100 },
        sanity: { current: 200, max: 200, percent: 100 },
        equipment: { worn: {}, slots: {} },
      },
      world: { day: 1, phase: 'day', phase_name: '白天', season_name: '秋季', status: 'ok', world_temperature: 20 },
      nearby: {
        status: 'ok', snapshot_id: 'r1-n2', radius: 16, max_total: 60, max_per_bucket: 12,
        total_found: 1, total_returned: 1, truncated: false, scan: { reused: false, age_ms: 0 },
        buckets: { harvestables: [{ ref: '#1', prefab: 'grass', label: '草', position: { x: 1, z: 2 }, distance: 0.5, harvest_ready: true }] },
        delta: { status: 'ok', added: [], removed: [], changed: [] },
      },
      ...(over.data ?? {}),
    },
  }
  const ageMs = over.ageMs ?? 0
  return {
    raw,
    readState: () => ({ json: raw, ageMs, mtimeMs: Date.now() - ageMs, path: 'fake.json' }),
    leaseDirs: () => [],
    readLeaseAck: () => null,
    call: async () => ({ ok: true, text: '好了' }),
    status: () => ({ connected: true }),
  }
}

/** 一个能驱动 AiRunner 的假模型：按脚本返回 toolCalls；脚本用尽后返回"没有动作"让 Agent 停下 */
function makeModel(script) {
  let i = 0
  return async () => {
    if (i >= script.length) return { content: '(想完了)', toolCalls: [], rawToolCalls: [] }
    const step = script[i]
    i++
    const calls = typeof step === 'function' ? step(i) : step
    return { content: '', toolCalls: calls.map((c, k) => ({ id: `c${i}_${k}`, name: c.name, args: c.args ?? {} })), rawToolCalls: calls }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 跑一小段 AiRunner，收集每次 callTool 的名字 */
async function runAgent({ bridge, script, maxMs = 1200, callToolImpl }) {
  const calls = []
  const runner = new AiRunner({
    log: () => {},
    bridge,
    chatFn: makeModel(script),
    settings: () => ({ apiKey: 'x', baseUrl: 'http://x', model: 'm', maxTokens: 64 }),
    instructions: () => '规则',
    toolList: () => [],
    callTool: async (name, args) => {
      calls.push(name)
      if (callToolImpl) return callToolImpl(name, args)
      return name === 'get_state' ? '状态文本' : 'ok'
    },
    onStatus: () => {},
  })
  runner.start()
  // 等它自己停下（脚本用尽 → 退避 → 连续没有动作 → 自己 stop），最多等 maxMs
  const deadline = Date.now() + maxMs
  while (runner.running && Date.now() < deadline) await sleep(50)
  if (runner.running) runner.stop('test')
  await sleep(150)
  return { calls, runner, stats: runner.observeStats?.() }
}

test('OBS-1：Agent 启动时必须先读一次完整状态', async () => {
  const bridge = makeBridge()
  const { calls } = await runAgent({
    bridge,
    script: [[{ name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } }]],
    maxMs: 800,
  })
  assert.equal(calls[0], 'get_state', `第一次调用必须是 get_state，实际 ${calls[0]}`)
})

test('OBS-2：后续轮次不再无条件自动 get_state（动作成功后复用结果）', async () => {
  const bridge = makeBridge()
  // 连续三步都成功；观察窗口 10 秒 / 3 次改动，短时间内不该反复观察
  const { calls } = await runAgent({
    bridge,
    script: [
      [{ name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } }],
      [{ name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } }],
      [{ name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } }],
    ],
    maxMs: 6000,
  })
  const getStates = calls.filter((c) => c === 'get_state').length
  const actions = calls.filter((c) => c !== 'get_state').length
  assert.ok(actions >= 2, `应该至少执行 2 个动作，实际 ${actions}`)
  assert.ok(getStates <= 2, `get_state 不该每轮都来（实际 ${getStates} 次，调用序列 ${calls.join(',')}）`)
})

test('OBS-3：动作结果不确定（unknown/unverified）后必须重新观察', async () => {
  const bridge = makeBridge()
  const { calls } = await runAgent({
    bridge,
    script: [
      [{ name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } }],
      [{ name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } }],
    ],
    callToolImpl: (name) => (name === 'get_state' ? '状态文本' : '结果未知（result_timeout），先 get_state 看看'),
    maxMs: 1200,
  })
  // 第一个动作 → unknown → 下一轮必须先 get_state 再动作
  const idx = calls.indexOf('gather')
  assert.ok(idx >= 0, '应该执行过 gather')
  const after = calls.slice(idx + 1)
  assert.equal(after[0], 'get_state', `unknown 之后应该先重新观察，实际 ${JSON.stringify(after)}`)
})

test('OBS-4：状态过期（暂停/退出）时不请求模型，只等', async () => {
  const bridge = makeBridge({ ageMs: 60_000 }) // 60 秒前写的 → stale
  const { calls } = await runAgent({
    bridge,
    script: [[{ name: 'gather', args: {} }]],
    maxMs: 1200,
  })
  assert.deepEqual(calls, [], `状态过期时不该调用任何工具，实际 ${JSON.stringify(calls)}`)
})

test('OBS-5：同一响应里前一个动作失败 → 后续动作不执行，并如实告知未执行', async () => {
  const bridge = makeBridge()
  const seen = []
  const results = []
  const runner = new AiRunner({
    log: () => {},
    bridge,
    settings: () => ({ apiKey: 'x', baseUrl: 'http://x', model: 'm', maxTokens: 64 }),
    instructions: () => '规则',
    toolList: () => [],
    callTool: async (name, args) => {
      seen.push(name)
      const text = name === 'get_state' ? '状态' : (name === 'gather' ? '失败：拒绝：not_ready（not_ready）' : 'ok')
      results.push(text)
      return text
    },
    onStatus: () => {},
  })
  // 一个响应里三个动作：gather 失败 → 后面两个不该跑
  let turn = 0
  runner.chatFn = async () => {
    if (turn++ > 0) return { content: '(完)', toolCalls: [], rawToolCalls: [] }
    return {
      content: '',
      toolCalls: [
        { id: 'a', name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } },
        { id: 'b', name: 'pickup', args: { target_ref: '#2', snapshot_id: 'r1-n2' } },
        { id: 'c', name: 'craft', args: { recipe: 'axe' } },
      ],
      rawToolCalls: [],
    }
  }
  runner.start()
  {
    const deadline = Date.now() + 4000
    while (runner.running && Date.now() < deadline) await sleep(50)
    if (runner.running) runner.stop('test')
    await sleep(150)
  }
  assert.ok(seen.includes('gather'), '第一个动作应该执行')
  assert.ok(!seen.includes('pickup'), `gather 失败后 pickup 不该执行，实际 ${JSON.stringify(seen)}`)
  assert.ok(!seen.includes('craft'), `gather 失败后 craft 不该执行，实际 ${JSON.stringify(seen)}`)
})

test('OBS-6：前一个成功 → 后续动作继续执行', async () => {
  const bridge = makeBridge()
  const seen = []
  const runner = new AiRunner({
    log: () => {},
    bridge,
    settings: () => ({ apiKey: 'x', baseUrl: 'http://x', model: 'm', maxTokens: 64 }),
    instructions: () => '规则',
    toolList: () => [],
    callTool: async (name) => { seen.push(name); return name === 'get_state' ? '状态' : '采了 草（cutgrass+1）' },
    onStatus: () => {},
  })
  let turn2 = 0
  runner.chatFn = async () => {
    if (turn2++ > 0) return { content: '(完)', toolCalls: [], rawToolCalls: [] }
    return {
      content: '',
      toolCalls: [
        { id: 'a', name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } },
        { id: 'b', name: 'gather', args: { target_ref: '#2', snapshot_id: 'r1-n2' } },
      ],
      rawToolCalls: [],
    }
  }
  runner.start()
  {
    const deadline = Date.now() + 4000
    while (runner.running && Date.now() < deadline) await sleep(50)
    if (runner.running) runner.stop('test')
    await sleep(150)
  }
  assert.ok(seen.filter((n) => n === 'gather').length >= 2, `两个 gather 都该执行，实际 ${JSON.stringify(seen)}`)
})

// ── dispatcher：核对结果要带回给模型 ──

function makeDispatcher(over = {}) {
  const bridge = makeBridge(over)
  const control = {
    validate: () => ({ ok: true, lease: { owner_type: 'system', owner_instance_id: 'i', authority_epoch: 'e', generation: 1, lease_id: 'l', expires_at: Date.now() + 30000 } }),
    readAuthority: () => ({ status: 'active' }),
    completeHandover: () => ({ ok: true }),
  }
  const dispatcher = createDispatcher({
    bridge,
    control,
    readSnapshot: () => normalizeState(bridge.readState().json, { ageMs: 0 }),
    log: () => {},
    readLeaseAck: () => null,
  })
  return { bridge, dispatcher }
}

test('OBS-18：动作成功后，下一轮提示里要带"已知背包"（来自已核对结果，模型不必再观察）', async () => {
  const bridge = makeBridge()
  const prompts = []
  let turn = 0
  const runner = new AiRunner({
    log: () => {}, bridge,
    chatFn: async (cfg, messages) => {
      turn++
      prompts.push(messages[messages.length - 1]?.content ?? '')
      if (turn === 1) return { content: '', toolCalls: [{ id: 'a', name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } }], rawToolCalls: [] }
      return { content: '(完)', toolCalls: [], rawToolCalls: [] }
    },
    settings: () => ({ apiKey: 'x', baseUrl: 'http://x', model: 'm', maxTokens: 64 }),
    instructions: () => '规则', toolList: () => [],
    callTool: async (name) => name === 'get_state' ? '状态' : '采了 草\n【已核对】cutgrass +1',
    onStatus: () => {},
  })
  runner.start()
  { const d = Date.now() + 4000; while (runner.running && Date.now() < d) await sleep(50); if (runner.running) runner.stop('t'); await sleep(150) }
  assert.ok(prompts.length >= 2, `至少两轮，实际 ${prompts.length}`)
  assert.match(prompts[1], /已知背包（来自已核对的结果）：cutgrass×1/, `第 2 轮要带已知背包，实际：${prompts[1]}`)
})

test('OBS-19：已知背包只认"已核对"的数据（失败回执不改记忆）', async () => {
  const bridge = makeBridge()
  const prompts = []
  let turn = 0
  const runner = new AiRunner({
    log: () => {}, bridge,
    chatFn: async (cfg, messages) => {
      turn++
      prompts.push(messages[messages.length - 1]?.content ?? '')
      if (turn === 1) return { content: '', toolCalls: [{ id: 'a', name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } }], rawToolCalls: [] }
      return { content: '(完)', toolCalls: [], rawToolCalls: [] }
    },
    settings: () => ({ apiKey: 'x', baseUrl: 'http://x', model: 'm', maxTokens: 64 }),
    instructions: () => '规则', toolList: () => [],
    // 失败回执里没有【已核对】，不该产生任何"已知背包"
    callTool: async (name) => name === 'get_state' ? '状态' : '失败：拒绝：not_ready（not_ready）',
    onStatus: () => {},
  })
  runner.start()
  { const d = Date.now() + 4000; while (runner.running && Date.now() < d) await sleep(50); if (runner.running) runner.stop('t'); await sleep(150) }
  // 失败会触发重新观察，所以提示里应该是"看状态"而不是"已知背包"
  const joined = prompts.join('\n')
  assert.ok(!/已知背包（来自已核对的结果）：cutgrass/.test(joined), '失败回执不能凭空产生背包记忆')
})

test('OBS-7：动作成功后 describe 要带上已核对的变化（不是只回一句"完成"）', async () => {
  const { dispatcher } = makeDispatcher()
  // 直接造一个 succeeded 结果走 describe
  const text = dispatcher.describe({
    status: 'succeeded',
    message: '采了 草（cutgrass+1）',
    verified: { product: 'cutgrass', gained: 1 },
  })
  assert.match(text, /cutgrass \+1/, `describe 应该写出已核对的变化，实际：${text}`)
  assert.match(text, /已核对/)
})

test('OBS-8：craft 的 describe 要写出成品与材料消耗', async () => {
  const { dispatcher } = makeDispatcher()
  const text = dispatcher.describe({ status: 'succeeded', message: '做好了 斧头（axe+1）', verified: { made: 1 } })
  assert.match(text, /成品 \+1/, `实际：${text}`)
})

test('OBS-16：craft 的核对要认"做好后自动装备"（torch 是 equippable，DoBuild 会直接拿在手里）', async () => {
  const { dispatcher } = makeDispatcher()
  const spec = dispatcher.specs.craft
  const before = { player: { inventory: { items: [{ prefab: 'cutgrass', count: 2 }, { prefab: 'twigs', count: 2 }] }, equipment: { worn: {} } } }
  const after = { player: { inventory: { items: [] }, equipment: { worn: { hands: 'torch' } } } }
  const v = spec.verify(before, after, { recipe: 'torch' })
  assert.equal(v.ok, true, '做好了并自动装备也算成功（不能只查背包）')
  assert.equal(v.how, 'auto_equipped')
  assert.equal(v.hand, 'torch')
  const text = dispatcher.describe({ status: 'succeeded', message: '做好了 火把（torch+1）', verified: v })
  assert.match(text, /已自动拿在手里/, `describe 要说明自动装备，实际：${text}`)
})

test('OBS-17：craft 什么都没发生时仍然判失败（不能因为加了自动装备就放松）', async () => {
  const { dispatcher } = makeDispatcher()
  const spec = dispatcher.specs.craft
  const before = { player: { inventory: { items: [{ prefab: 'twigs', count: 2 }] }, equipment: { worn: {} } } }
  const after = { player: { inventory: { items: [] }, equipment: { worn: {} } } } // 材料没了、成品也没有
  const v = spec.verify(before, after, { recipe: 'axe' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'craft_not_in_inventory')
})

test('OBS-14：move_to 的回执必须带"现在位置"，否则模型只能再观察一次', async () => {
  const { dispatcher } = makeDispatcher()
  const text = dispatcher.describe({
    status: 'succeeded',
    message: '走到了 (-19,33) 附近（还差 1.2 格）',
    verified: { pos: { x: -19, z: 33 }, dist: 1.2, from: { x: -22, z: 32 } },
  })
  assert.match(text, /现在位置 \(-19,33\)/, `回执要写出实际位置，实际：${text}`)
  assert.match(text, /距目标 1\.2 格/, '要写出距目标多远')
  assert.match(text, /-22,32 → -19,33/, '要写出从哪走到哪')
})

test('OBS-15：move_to 的 verify 真的会带 pos/dist（不是只在 describe 里编）', async () => {
  const { dispatcher } = makeDispatcher()
  const spec = dispatcher.specs.move_to
  const before = { actor: { tileX: -22, tileZ: 32 } }
  const after = { actor: { tileX: -19, tileZ: 33 } }
  const v = spec.verify(before, after, { x: -19, z: 33 })
  assert.equal(v.ok, true)
  assert.deepEqual(v.pos, { x: -19, z: 33 })
  assert.ok(Math.abs(v.dist - 0) < 0.01, `距离应该是 0，实际 ${v.dist}`)
  assert.deepEqual(v.from, { x: -22, z: 32 })
})

test('OBS-9：unknown 的 describe 必须明确"不要当成功"', async () => {
  const { dispatcher } = makeDispatcher()
  const text = dispatcher.describe({ status: 'unknown', reason: 'result_timeout', message: '' })
  assert.match(text, /不确定|不要当成功/, `实际：${text}`)
})

// ── JSON 输出 ──

test('OBS-10：get_state format=json 必须是纯 JSON（笔记在 notes 字段里）', async () => {
  const bridge = makeBridge()
  const ctx = {
    bridge,
    notes: { read: () => '历史笔记：上次死在 (-45,54)', write: () => {} },
    extraInstructions: '先建家',
    guides: {},
  }
  const text = await executeTool('get_state', { format: 'json' }, ctx)
  assert.ok(text.trim().startsWith('{'), `JSON 必须以 { 开头，实际开头：${text.slice(0, 40)}`)
  const parsed = JSON.parse(text) // 不能抛
  assert.equal(parsed.notes?.is_historical, true, '笔记要标成历史')
  assert.match(String(parsed.notes?.content), /上次死在/)
  assert.equal(parsed.player_instructions, '先建家')
  assert.equal(parsed.snapshot_id, 's10')
  assert.equal(parsed.nearby?.snapshot_id, 'r1-n2')
})

test('OBS-11：没有笔记时 JSON 里不该出现 notes 字段（但仍然是合法 JSON）', async () => {
  const bridge = makeBridge()
  const text = await executeTool('get_state', { format: 'json' }, { bridge, notes: { read: () => '', write: () => {} }, guides: {} })
  const parsed = JSON.parse(text)
  assert.equal(parsed.notes, undefined)
  assert.ok(parsed.ok !== undefined)
})

test('OBS-12：文本模式仍然正常（笔记在最前面、状态正文在）', async () => {
  const bridge = makeBridge()
  const text = await executeTool('get_state', {}, {
    bridge,
    notes: { read: () => '我的笔记：家在 (-22,32)', write: () => {} },
    guides: {},
  })
  assert.match(text, /我的笔记：家在/, '文本模式要显示笔记')
  assert.match(text, /状态快照序列号|快照/, '文本模式要有状态头')
  assert.ok(!text.trim().startsWith('{'), '文本模式不该是 JSON')
})

test('OBS-13：三个入口（RULES / Gateway / get_state 描述）的观察规则一致', async () => {
  const { RULES, TOOLS } = await import('../lib/tools.js')
  const gs = TOOLS.find((t) => t.name === 'get_state')
  // 三处都不能再出现"每次行动前"这种强制要求
  assert.ok(!/每次行动前先调 get_state/.test(RULES), 'RULES 不该保留旧的强制观察')
  assert.ok(!/每个动作前后都该先看这个/.test(gs.description), 'get_state 描述不该保留旧的强制观察')
  // 三处都应该表达"开始时一次 + 按需刷新"
  assert.match(RULES, /任务开始时/)
  assert.match(gs.description, /任务开始时|一次就够/)
})
