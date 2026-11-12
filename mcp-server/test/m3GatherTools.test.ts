// Phase 5 M3 · MCP 采集工具的单元测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGatherTools } from '../src/tools/gatherTools.js'
import { createToolDefinitions, runTool } from '../src/tools/definitions.js'

function names(tools: Array<{ name: string }>) {
  return tools.map((t) => t.name)
}

test('M3：新增 3 个采集工具，MCP 总工具数 20（含 M4 4 个）', () => {
  const gather = createGatherTools()
  assert.deepEqual(names(gather).sort(), ['gather_resource', 'move_to_target', 'probe_game_actions'])
  assert.equal(createToolDefinitions().length, 24)
})

test('M3：2 个写动作标 readOnly=false，探测工具标 true', () => {
  const byName = new Map(createGatherTools().map((t) => [t.name, t]))
  assert.equal(byName.get('gather_resource')!.readOnly, false)
  assert.equal(byName.get('move_to_target')!.readOnly, false)
  assert.equal(byName.get('probe_game_actions')!.readOnly, true)
})

test('M3：gather_resource Zod Schema 约束（enum / count / radius）', () => {
  const tool = createGatherTools().find((t) => t.name === 'gather_resource')!
  // 合法
  assert.equal(tool.schema.safeParse({ resource: 'twigs', count: 3, radius: 8 }).success, true)
  assert.equal(tool.schema.safeParse({ resource: 'berries' }).success, true, 'count/radius 有默认值')
  // 非法：任意资源名、越界数量、越界半径
  assert.equal(tool.schema.safeParse({ resource: 'spider' }).success, false, '不接受任意 prefab 名')
  assert.equal(tool.schema.safeParse({ resource: 'deerclops' }).success, false)
  assert.equal(tool.schema.safeParse({ resource: 'twigs', count: 999 }).success, false)
  assert.equal(tool.schema.safeParse({ resource: 'twigs', count: 0 }).success, false)
  assert.equal(tool.schema.safeParse({ resource: 'twigs', radius: 999 }).success, false)
  assert.equal(tool.schema.safeParse({ resource: 'twigs', count: 1.5 }).success, false, '数量必须整数')
})

test('M3：move_to_target / probe_game_actions 的 Schema', () => {
  const byName = new Map(createGatherTools().map((t) => [t.name, t]))
  const move = byName.get('move_to_target')!
  assert.equal(move.schema.safeParse({ resource: 'grass' }).success, true)
  assert.equal(move.schema.safeParse({ resource: 'logs' }).success, false)
  const probe = byName.get('probe_game_actions')!
  assert.equal(probe.schema.safeParse({}).success, true)
})

/** 造一个假 ToolContext：controlStatus 可注入，enqueueCommand 记录调用 */
function fakeContext(control: Record<string, unknown>) {
  const enqueued: Array<{ type: string; params: Record<string, unknown>; options: unknown }> = []
  const ctx = {
    client: {
      controlStatus: async () => ({ status: 200, data: { control }, elapsedMs: 1 }),
      enqueueCommand: async (type: string, params: Record<string, unknown>, options: unknown) => {
        enqueued.push({ type, params, options })
        return { status: 200, data: { command: { id: 'cmd_test_1', type, status: 'QUEUED' } }, elapsedMs: 1 }
      },
      getCommand: async () => ({ status: 'SUCCEEDED', result: { ok: true } }),
    },
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    events: { observe() {} },
  } as any
  return { ctx, enqueued }
}

test('M3：无控制权时 gather_resource 被程序层拒绝（不靠提示词）', async () => {
  const { ctx, enqueued } = fakeContext({ mode: 'SUPERVISED', holder: null, emergency_stop: false })
  const tool = createGatherTools().find((t) => t.name === 'gather_resource')!
  const result = await runTool(tool, { resource: 'twigs', count: 1, radius: 12 }, ctx)
  assert.equal(result.structuredContent.ok, false)
  assert.equal((result.structuredContent.error as any).code, 'SESSION_INVALID')
  assert.equal(enqueued.length, 0, '绝不下发动作')
})

test('M3：紧急停止 / 人工接管 / PAUSED / lease 过期 全部拒绝', async () => {
  const cases = [
    { mode: 'EMERGENCY_STOP', holder: 'C1', emergency_stop: true, lease_expires_at: Date.now() + 60000 },
    { mode: 'MANUAL', holder: null, emergency_stop: false, lease_expires_at: null },
    { mode: 'PAUSED', holder: 'C1', emergency_stop: false, lease_expires_at: Date.now() + 60000 },
    { mode: 'SUPERVISED', holder: 'C1', emergency_stop: false, lease_expires_at: Date.now() - 1000 },
  ]
  for (const control of cases) {
    const { ctx, enqueued } = fakeContext(control)
    const tool = createGatherTools().find((t) => t.name === 'gather_resource')!
    const result = await runTool(tool, { resource: 'twigs', count: 1, radius: 12 }, ctx)
    assert.equal(result.structuredContent.ok, false, `mode=${control.mode} 应被拒`)
    assert.equal((result.structuredContent.error as any).code, 'SESSION_INVALID')
    assert.equal(enqueued.length, 0)
  }
})

test('M3：有有效控制权时下发动作，返回 action_id，并带上 holder 作为 controller_id', async () => {
  const { ctx, enqueued } = fakeContext({
    mode: 'SUPERVISED', holder: 'C1', session_id: 'S1',
    emergency_stop: false, lease_expires_at: Date.now() + 60000,
  })
  const tool = createGatherTools().find((t) => t.name === 'gather_resource')!
  const result = await runTool(tool, { resource: 'twigs', count: 3, radius: 8 }, ctx)
  assert.equal(result.structuredContent.ok, true)
  assert.equal(result.structuredContent.action_id, 'cmd_test_1')
  assert.equal(result.structuredContent.controller_id, 'C1')
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0]!.type, 'gather_resource')
  assert.deepEqual(enqueued[0]!.params, { resource: 'twigs', count: 3, radius: 8 })
  assert.equal((enqueued[0]!.options as any).shard, 'master', '必须绑 master 分片')
  assert.equal((enqueued[0]!.options as any).controllerId, 'C1')
  assert.equal((enqueued[0]!.options as any).sessionId, 'S1')
})

test('M3：move_to_target 同样查控制权并绑 master', async () => {
  const { ctx, enqueued } = fakeContext({
    mode: 'SUPERVISED', holder: 'C1', session_id: 'S1',
    emergency_stop: false, lease_expires_at: Date.now() + 60000,
  })
  const tool = createGatherTools().find((t) => t.name === 'move_to_target')!
  const result = await runTool(tool, { resource: 'grass', radius: 6 }, ctx)
  assert.equal(result.structuredContent.ok, true)
  assert.equal(enqueued[0]!.type, 'move_to_target')
  assert.deepEqual(enqueued[0]!.params, { resource: 'grass', radius: 6 })
  assert.equal((enqueued[0]!.options as any).shard, 'master')
})

test('M3：probe_game_actions 是只读工具，不需要控制权', async () => {
  const { ctx, enqueued } = fakeContext({ mode: 'SUPERVISED', holder: null, emergency_stop: false })
  const tool = createGatherTools().find((t) => t.name === 'probe_game_actions')!
  const result = await runTool(tool, {}, ctx)
  assert.equal(result.structuredContent.ok, true)
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0]!.type, 'probe_game_actions')
  assert.equal((enqueued[0]!.options as any).controllerId, undefined, '只读探测不带控制字段')
})
