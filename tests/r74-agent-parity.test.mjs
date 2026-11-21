// Phase R.7.4-B 回归测试 D / E：F8 与 DSH 工具列表模式一致性 + F8 无 tool call 治理。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AiRunner } from '../lib/agent.js'
import { toolList } from '../lib/tools.js'
import { toolsForExecutionMode, buildInstructions } from '../lib/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const namesOf = (list) => list.map((t) => t.name).sort()

test('R74-D1: 三种执行模式下，F8 与 DSH 的工具集合完全一致，且与当前配置匹配', () => {
  for (const mode of ['autopilot', 'assisted', 'manual']) {
    const dsh = namesOf(toolsForExecutionMode({ executionMode: mode }))
    const direct = namesOf(toolList(mode))
    assert.deepEqual(dsh, direct, `${mode}: DSH 工具表应等于 toolList(mode)`)

    // F8 现在通过同一个函数取工具（AiRunner.toolList() 无参调用闭包）
    const runner = new AiRunner({ toolList: () => toolsForExecutionMode({ executionMode: mode }) })
    assert.deepEqual(namesOf(runner.toolList()), dsh, `${mode}: F8 与 DSH 工具集合必须一致`)

    // 三模式工具集完全一致：完整原子动作 + run_skill + advance_task
    assert.ok(dsh.includes('advance_task') && dsh.includes('chop') && dsh.includes('run_skill'), `${mode}: 必须暴露完整工具集`)
  }
})

test('R74-D3: 三模式都用完整动作手册；Autopilot 额外强调“持续自主”，Manual 强调单次', () => {
  const auto = buildInstructions({ main: '主攻略' }, 'autopilot')
  assert.match(auto, /Autopilot/, 'Autopilot 提示要写明模式')
  assert.match(auto, /能用的动作共\s*\d+\s*个/, 'Autopilot 也要展示完整动作清单（现在是完整工具集）')
  assert.match(auto, /持续自主|自己规划|连续自主/, 'Autopilot 要强调持续自主')
  const assisted = buildInstructions({ main: '主攻略' }, 'assisted')
  assert.match(assisted, /能用的动作共\s*\d+\s*个/, 'Assisted 应保留完整动作清单')
  assert.match(assisted, /harvest_nearest/, 'Assisted 应说明原子动作')
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
