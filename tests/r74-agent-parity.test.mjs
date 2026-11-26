// Phase R.7.4-B 回归测试 D / E：F8 与 DSH 工具列表模式一致性 + F8 无 tool call 治理。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AiRunner } from '../lib/agent.js'
import { toolList } from '../lib/tools.js'
import { toolsForExecutionMode, buildInstructions, currentConfig } from '../lib/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const namesOf = (list) => list.map((t) => t.name).sort()

test('R74-D1: F8 与 DSH 工具集合一致，且各模式符合 R8.4 工具裁剪', () => {
  for (const mode of ['autopilot', 'assisted', 'manual']) {
    const dsh = namesOf(toolsForExecutionMode({ executionMode: mode }))
    const direct = namesOf(toolList(mode))
    assert.deepEqual(dsh, direct, `${mode}: DSH 工具表应等于 toolList(mode)`)

    // F8 现在通过同一个函数取工具（AiRunner.toolList() 无参调用闭包）
    const runner = new AiRunner({ toolList: () => toolsForExecutionMode({ executionMode: mode }) })
    assert.deepEqual(namesOf(runner.toolList()), dsh, `${mode}: F8 与 DSH 工具集合必须一致`)
  }
  // Autopilot：只有高层接口白名单
  const auto = namesOf(toolsForExecutionMode({ executionMode: 'autopilot' }))
  assert.deepEqual(auto, ['advance_task', 'get_guide', 'get_state', 'stop', 'update_notes'])
  // Assisted / Manual：完整工具集（原子动作 + run_skill + advance_task）
  for (const mode of ['assisted', 'manual']) {
    const list = namesOf(toolsForExecutionMode({ executionMode: mode }))
    assert.ok(list.includes('advance_task') && list.includes('chop') && list.includes('run_skill'), `${mode}: 必须暴露完整工具集`)
  }
})

test('R74-D3: Autopilot 用高层任务驱动手册且不注入主攻略；Assisted（默认）/Manual 用完整动作手册（R8.4）', () => {
  assert.equal(currentConfig({}).executionMode, 'assisted', '插件默认 executionMode 应为 assisted')
  assert.ok(toolsForExecutionMode({}).some((t) => t.name === 'chop'), '默认配置应暴露完整工具集')
  const auto = buildInstructions({ main: '主攻略' }, 'autopilot')
  assert.match(auto, /Autopilot/, 'Autopilot 提示要写明模式')
  assert.match(auto, /advance_task/, 'Autopilot 手册要讲 advance_task')
  assert.match(auto, /budget_exhausted|stop_reason|回执/, 'Autopilot 手册要教怎么读回执')
  assert.ok(!/能用的动作共\s*\d+\s*个/.test(auto), 'Autopilot 不再展示完整动作清单')
  assert.ok(!/完整原子动作工具集/.test(auto), '不得再说 Autopilot 拥有完整原子工具集')
  assert.ok(!auto.includes('主攻略'), 'Autopilot 不自动塞入原子动作向主攻略')
  const assisted = buildInstructions({ main: '主攻略' }, 'assisted')
  assert.match(assisted, /能用的动作共\s*\d+\s*个/, 'Assisted 应保留完整动作清单')
  assert.match(assisted, /harvest_nearest/, 'Assisted 应说明原子动作')
  assert.ok(assisted.includes('主攻略'), 'Assisted 应注入主攻略')
  const manual = buildInstructions({ main: 'x' }, 'manual')
  assert.match(manual, /手动|只执行用户当下/, 'Manual 要强调单次指令')
  assert.equal(buildInstructions({ main: 'x' }), buildInstructions({ main: 'x' }, 'assisted'))
})

test('R74-D2: 回归守卫 —— index.js 用动态工具表闭包（跟随当前 executionMode），不是裸 toolList', () => {
  const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  assert.match(src, /toolList:\s*\(\)\s*=>\s*toolsForExecutionMode\(config\)/,
    'F8 必须用动态工具表闭包，跟随当前 executionMode')
  assert.doesNotMatch(src, /\n\s{4}toolList,\n/, '不能把裸函数 toolList 交给 AiRunner')
})

const F8_RAW_STATE = {
  text: '你：威尔逊',
  data: {
    schema: 'bws.state/1',
    observer: { snapshot_id: 'r1-n1', sequence: 1, status: 'ok', sample_age_ms: 0 },
    identity: { session_id: 's', cluster_id: 'c', shard_id: '1', world_key: 'w_f8', world_key_source: 'cluster_id' },
    actor: { valid: true, alive: true, is_ghost: false, actor_type: 'player', prefab: 'wilson', name: 'W', tile_x: 0, tile_z: 0, x: 0, z: 0 },
    player: {
      health: { current: 100, max: 100, percent: 100 },
      hunger: { current: 100, max: 100, percent: 100 },
      sanity: { current: 100, max: 100, percent: 100 },
      inventory: { items: {}, slots: 15, is_full: false },
      equipment: { slots: {}, worn: [] },
      in_light: true,
    },
    world: { day: 1, phase: 'day', season: 'autumn' },
    nearby: { runtime_id: 'rt', snapshot_id: 'r1-n1', status: 'ok', radius: 16, buckets: { resources: [], food: [], harvestables: [], pickupables: [], structures: [], threats: [] } },
    danger_zones: [],
  },
}

test('R74-E1: F8 只回自然语言、不调工具时，不误报执行、不绕过公共入口派发动作', async () => {
  const bridge = { readState: () => ({ json: F8_RAW_STATE, ageMs: 0, path: 'fake.json' }) }
  const logs = []
  const notes = []
  const toolCalls = []
  const sentMessages = []
  let chatCalls = 0
  const fakeSessionLog = {
    note: (m) => notes.push(String(m)),
    recordAiTurn: () => {},
    recordAiThought: () => {},
    archive: () => {},
  }
  const runner = new AiRunner({
    bridge,
    log: (level, msg) => logs.push(`${level}: ${msg}`),
    settings: () => ({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1', model: 'fake', maxTokens: 64 }),
    instructions: () => '你是大肥鱼',
    toolList: () => toolsForExecutionMode({ executionMode: 'autopilot' }),
    chatFn: async (config, messages) => {
      chatCalls++
      sentMessages.push(JSON.parse(JSON.stringify(messages)))
      return { content: '我准备移动到附近的草丛。', thought: null, toolCalls: [], rawToolCalls: undefined, usage: null }
    },
    callTool: async (name, args) => {
      toolCalls.push({ name, args })
      if (name === 'get_state') return '第1天 你在 (0,0)，附近有草丛'
      return '不应被调用'
    },
    sessionLog: () => fakeSessionLog,
    onStatus: () => {},
  })

  runner.start()
  await sleep(1600)
  runner.stop('测试结束')
  await sleep(50)

  assert.ok(chatCalls >= 2, '模型应被多次请求（有界重试）')
  // 空转时必须给过一次"没有调用工具/当前可用工具"的接口层纠偏
  const nudged = sentMessages.some((msgs) => msgs.some((m) => m.role === 'user' && /没有调用任何工具/.test(String(m.content ?? '')) && /advance_task/.test(String(m.content ?? ''))))
  assert.ok(nudged, '模型空转时应提示"没有调用任何工具 + 可用工具 + 用 advance_task"')
  // 关键：只允许只读 get_state；绝不能因为"模型说要移动"就自行派发 move_to / advance_task
  const mutating = toolCalls.filter((c) => c.name !== 'get_state')
  assert.deepEqual(mutating, [], `模型没有 tool call 时不得自行派发游戏动作（实际：${JSON.stringify(mutating)}）`)
  // 必须记录"没有 tool call"的完整诊断
  assert.ok(logs.some((l) => l.includes('NO_TOOL_CALL')), '必须记录 NO_TOOL_CALL 诊断日志')
  assert.ok(notes.some((n) => n.includes('没有发出工具调用')), '会话日志必须记录"没有发出工具调用"')
})

test('R74-E2: F8 无 tool call 的重试是有界的（IDLE_GIVE_UP 有限且会主动 stop）', () => {
  const src = readFileSync(join(ROOT, 'lib', 'agent.js'), 'utf8')
  const m = src.match(/const IDLE_GIVE_UP\s*=\s*(\d+)/)
  assert.ok(m, 'IDLE_GIVE_UP 必须是明确常量')
  assert.ok(Number(m[1]) > 0 && Number(m[1]) <= 20, 'IDLE_GIVE_UP 必须是有界的小整数')
  assert.match(src, /this\.stop\('连续没有动作'\)/, '达到上限后必须主动停止，不能无限空转')
})

test('R74-HYBRID-1: Assisted 模式指引复合技能优先 + 原子动作救场，Autopilot 不混入原子指引', () => {
  const assisted = buildInstructions({ main: '主攻略' }, 'assisted')
  assert.match(assisted, /复合技能优先/, 'Assisted 要明确混合执行原则')
  assert.match(assisted, /run_skill/, 'Assisted 要引导优先用 run_skill')
  assert.match(assisted, /max_steps/, 'Assisted 要说明批量 max_steps')
  assert.match(assisted, /blocked/, 'Assisted 要说明技能阻塞时用原子动作救场')
  const auto = buildInstructions({ main: '主攻略' }, 'autopilot')
  assert.ok(!auto.includes('复合技能优先'), 'Autopilot 不应出现 Assisted 混合指引')
  assert.ok(!auto.includes('复合技能 run_skill'), 'Autopilot 不应引导调用禁用的 run_skill')
  assert.match(auto, /不要在 Autopilot 下调原子动作.*run_skill/, 'Autopilot 只保留禁止直调 run_skill 的声明')
})

test('R74-HYBRID-2: AiRunner 支持 run_skill 同步已知背包，并在 blocked 时立即停批并重看状态以便原子救场', async () => {
  const snap = JSON.parse(JSON.stringify(F8_RAW_STATE))
  const calls = []
  const prompts = []
  let turn = 0
  const runner = new AiRunner({
    bridge: { readState: () => ({ json: snap, ageMs: 0, path: 'fake.json' }) },
    log: () => {},
    settings: () => ({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1', model: 'fake', maxTokens: 64 }),
    instructions: () => '混合模式规则',
    toolList: () => toolsForExecutionMode({ executionMode: 'assisted' }),
    chatFn: async (_cfg, messages) => {
      turn++
      prompts.push(String(messages[messages.length - 1]?.content ?? ''))
      if (turn === 1) {
        return {
          content: '',
          toolCalls: [{ id: 's1', name: 'run_skill', args: { skill_id: 'gather_resources', max_steps: 6 } }],
          rawToolCalls: [],
        }
      }
      if (turn === 2) {
        return {
          content: '',
          toolCalls: [
            { id: 's2', name: 'run_skill', args: { skill_id: 'establish_home', max_steps: 6 } },
            { id: 's3', name: 'move_to', args: { x: 1, z: 1 } },
          ],
          rawToolCalls: [],
        }
      }
      return { content: '停下', toolCalls: [], rawToolCalls: [] }
    },
    callTool: async (name) => {
      calls.push(name)
      if (name === 'get_state') return '状态'
      if (calls.filter((n) => n === 'run_skill').length === 1) {
        // 第一轮 run_skill 完成采集并把 log 放进快照背包
        snap.data.player.inventory.items = [{ prefab: 'log', count: 4 }]
        return '技能 gather_resources → completed\n进度：第 1 步'
      }
      // 第二轮 run_skill 阻塞：应打断同批 move_to，并强制下一轮重看 get_state
      return '技能 establish_home → blocked\n原因：no_camp_site'
    },
    onStatus: () => {},
  })

  runner.start()
  const deadline = Date.now() + 2500
  while (runner.running && Date.now() < deadline && turn < 3) await sleep(30)
  runner.stop('测试结束')
  await sleep(50)

  assert.equal(calls[0], 'get_state')
  assert.equal(calls[1], 'run_skill')
  // 第 2 轮复用状态，且应携带由 run_skill 同步的最新背包（log×4）
  assert.notEqual(calls[2], 'get_state', 'run_skill 完成后下一轮应复用快照，不额外 get_state')
  assert.match(prompts[1], /已知背包（来自已核对的结果）：log×4/)
  // 第 2 轮 run_skill 返回 blocked 后，同批 move_to 不得执行，且第 3 轮前必须自动重看 get_state
  assert.ok(!calls.includes('move_to'), 'run_skill blocked 后同批后续动作必须中止')
  assert.equal(calls[3], 'get_state', 'run_skill blocked 后下一轮必须刷新 get_state 以便原子动作救场')
})

test('R74-PAUSE-TIMING: AiRunner 仅在等待模型回复期间置 isThinking=true 并累计 thinkingMs', async () => {
  const seen = []
  let resolveChat = null
  const runner = new AiRunner({
    bridge: { readState: () => ({ json: F8_RAW_STATE, ageMs: 0, path: 'fake.json' }) },
    log: () => {},
    settings: () => ({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1', model: 'fake', maxTokens: 64 }),
    instructions: () => '规则',
    toolList: () => [],
    chatFn: () => new Promise((resolve) => {
      resolveChat = () => resolve({ content: '好', toolCalls: [], rawToolCalls: [] })
    }),
    callTool: async () => 'ok',
    onStatus: (s) => seen.push(s),
  })

  runner.start()
  const deadline = Date.now() + 1500
  while (!resolveChat && Date.now() < deadline) await sleep(20)
  assert.ok(resolveChat, '应进入 chatFn 等待状态')
  await sleep(60)
  const mid = runner.status()
  assert.equal(mid.isThinking, true)
  assert.ok(mid.thinkingMs >= 40, `thinkingMs 应随思考累计，实际 ${mid.thinkingMs}`)
  resolveChat()
  await sleep(50)
  const after = runner.status()
  assert.equal(after.isThinking, false)
  assert.equal(after.thinkingMs, 0)
  runner.stop('测试结束')
})
