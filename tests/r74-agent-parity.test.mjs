// Phase R.7.4-B 回归测试 D / E：F8 与 DSH 工具列表模式一致性 + F8 无 tool call 治理。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AiRunner } from '../lib/agent.js'
import { toolList } from '../lib/tools.js'
import { toolsForExecutionMode } from '../lib/index.js'

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

    if (mode === 'autopilot') {
      assert.ok(dsh.includes('advance_task'))
      assert.ok(!dsh.includes('chop'), 'autopilot 不能暴露底层动作 chop')
      assert.ok(!dsh.includes('run_skill'), 'autopilot 不能暴露 run_skill')
    }
    if (mode === 'manual') {
      assert.ok(!dsh.includes('advance_task'), 'manual 必须隐藏 advance_task')
      assert.ok(dsh.includes('chop') && dsh.includes('run_skill'), 'manual 必须暴露原子动作与技能')
    }
    if (mode === 'assisted') {
      assert.ok(dsh.includes('advance_task') && dsh.includes('chop') && dsh.includes('run_skill'))
    }
  }
})

test('R74-D2: 回归守卫 —— index.js 不能把裸 toolList 直接传给 AiRunner（那会永远用 autopilot）', () => {
  const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  assert.match(src, /toolList:\s*\(\)\s*=>\s*toolsForExecutionMode\(config\)/,
    'F8 必须用动态工具表闭包，跟随当前 executionMode')
  assert.doesNotMatch(src, /\n\s{4}toolList,\n/, '不能再把裸函数 toolList 交给 AiRunner')
  // 旧 bug 行为演示：裸 toolList 无参调用 = autopilot，在 manual 下会看不到 chop
  const buggy = new AiRunner({ toolList })
  assert.ok(!namesOf(buggy.toolList()).includes('chop'), '裸 toolList 会退回 autopilot —— 正是必须用闭包的原因')
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
    chatFn: async () => {
      chatCalls++
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
