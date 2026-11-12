// Phase 5 M4 · MCP 工具使用工具单元测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createToolUseTools } from '../src/tools/toolUseTools.js'
import { createToolDefinitions, runTool } from '../src/tools/definitions.js'

const byName = () => new Map(createToolUseTools().map((t) => [t.name, t]))

test('M4：新增 4 个工具使用工具，MCP 总工具数 20', () => {
  assert.deepEqual(createToolUseTools().map((t) => t.name).sort(),
    ['chop_tree', 'equip_item', 'mine_rock', 'pick_up_item'])
  assert.equal(createToolDefinitions().length, 27)
})

test('M4：4 个工具都标 readOnly=false', () => {
  for (const tool of createToolUseTools()) {
    assert.equal(tool.readOnly, false, `${tool.name} 应是写动作`)
  }
})

test('M4：equip_item Schema（enum 白名单）', () => {
  const tool = byName().get('equip_item')!
  assert.equal(tool.schema.safeParse({ item: 'axe' }).success, true)
  assert.equal(tool.schema.safeParse({ item: 'pickaxe' }).success, true)
  assert.equal(tool.schema.safeParse({ item: 'torch' }).success, true)
  assert.equal(tool.schema.safeParse({ item: 'spear' }).success, false, '不接受任意物品')
  assert.equal(tool.schema.safeParse({}).success, false, 'item 必填')
})

test('M4：chop_tree / mine_rock Schema（count 1..5、target enum、confirmed）', () => {
  const chop = byName().get('chop_tree')!
  assert.equal(chop.schema.safeParse({}).success, true, 'confirmed 有默认值')
  assert.equal(chop.schema.safeParse({ count: 6 }).success, false, 'count 上限 5')
  assert.equal(chop.schema.safeParse({ count: 0 }).success, false)
  assert.equal(chop.schema.safeParse({ target: 'rock1' }).success, false, 'chop 不接受矿石目标')
  assert.equal(chop.schema.safeParse({ target: 'evergreen' }).success, true)
  const mine = byName().get('mine_rock')!
  assert.equal(mine.schema.safeParse({ target: 'evergreen' }).success, false, 'mine 不接受树目标')
  assert.equal(mine.schema.safeParse({ target: 'rock1' }).success, true)
})

test('M4：pick_up_item Schema（enum 白名单）', () => {
  const tool = byName().get('pick_up_item')!
  assert.equal(tool.schema.safeParse({ item: 'flint' }).success, true)
  assert.equal(tool.schema.safeParse({ item: 'goldnugget' }).success, false)
  assert.equal(tool.schema.safeParse({}).success, false)
})

/** 假上下文：controlStatus 可注入，enqueueCommand 记录调用 */
function fakeCtx(control: Record<string, unknown>) {
  const enqueued: Array<{ type: string; params: Record<string, unknown>; options: any }> = []
  const ctx = {
    client: {
      controlStatus: async () => ({ status: 200, data: { control }, elapsedMs: 1 }),
      enqueueCommand: async (type: string, params: Record<string, unknown>, options: any) => {
        enqueued.push({ type, params, options })
        return { status: 200, data: { command: { id: 'cmd_m4_1', type, status: 'QUEUED' } }, elapsedMs: 1 }
      },
      getCommand: async () => ({ status: 'SUCCEEDED', result: { ok: true } }),
    },
    config: {}, logger: { info() {}, warn() {}, error() {}, debug() {} }, events: { observe() {} },
  } as any
  return { ctx, enqueued }
}

const OK_CONTROL = { mode: 'SUPERVISED', holder: 'C1', session_id: 'S1', emergency_stop: false, lease_expires_at: Date.now() + 60000 }

test('M4：chop_tree 未确认 → 被拒，绝不下发（程序层强制）', async () => {
  const { ctx, enqueued } = fakeCtx(OK_CONTROL)
  const tool = byName().get('chop_tree')!
  const result = await runTool(tool, { count: 1, radius: 12, confirmed: false }, ctx)
  assert.equal(result.structuredContent.ok, false)
  assert.equal((result.structuredContent.error as any).code, 'INVALID_ARGUMENT')
  assert.match(String((result.structuredContent.error as any).message), /人工确认/)
  assert.equal(enqueued.length, 0, '未确认绝不下发')
})

test('M4：chop_tree 确认后下发，带 confirmed=true 与 master 分片', async () => {
  const { ctx, enqueued } = fakeCtx(OK_CONTROL)
  const tool = byName().get('chop_tree')!
  const result = await runTool(tool, { count: 2, radius: 10, confirmed: true }, ctx)
  assert.equal(result.structuredContent.ok, true)
  assert.equal(result.structuredContent.action_id, 'cmd_m4_1')
  assert.equal(enqueued[0]!.type, 'chop_tree')
  assert.equal(enqueued[0]!.params.confirmed, true)
  assert.equal(enqueued[0]!.options.shard, 'master')
  assert.equal(enqueued[0]!.options.controllerId, 'C1')
})

test('M4：mine_rock 未确认被拒、确认后下发', async () => {
  const bad = fakeCtx(OK_CONTROL)
  const r1 = await runTool(byName().get('mine_rock')!, { confirmed: false }, bad.ctx)
  assert.equal(r1.structuredContent.ok, false)
  assert.equal(bad.enqueued.length, 0)
  const ok = fakeCtx(OK_CONTROL)
  const r2 = await runTool(byName().get('mine_rock')!, { count: 1, radius: 12, confirmed: true }, ok.ctx)
  assert.equal(r2.structuredContent.ok, true)
  assert.equal(ok.enqueued[0]!.params.confirmed, true)
})

test('M4：equip_item / pick_up_item 需要控制权', async () => {
  for (const control of [
    { mode: 'SUPERVISED', holder: null, emergency_stop: false },
    { mode: 'EMERGENCY_STOP', holder: 'C1', emergency_stop: true, lease_expires_at: Date.now() + 60000 },
    { mode: 'MANUAL', holder: null, emergency_stop: false },
    { mode: 'PAUSED', holder: 'C1', emergency_stop: false, lease_expires_at: Date.now() + 60000 },
    { mode: 'SUPERVISED', holder: 'C1', emergency_stop: false, lease_expires_at: Date.now() - 1000 },
  ]) {
    const eq = fakeCtx(control)
    const r1 = await runTool(byName().get('equip_item')!, { item: 'axe' }, eq.ctx)
    assert.equal(r1.structuredContent.ok, false, `mode=${control.mode} equip 应被拒`)
    assert.equal(eq.enqueued.length, 0)
    const pk = fakeCtx(control)
    const r2 = await runTool(byName().get('pick_up_item')!, { item: 'flint' }, pk.ctx)
    assert.equal(r2.structuredContent.ok, false, `mode=${control.mode} pickup 应被拒`)
    assert.equal(pk.enqueued.length, 0)
  }
})

test('M4：有控制权时 equip_item / pick_up_item 正常下发', async () => {
  const eq = fakeCtx(OK_CONTROL)
  const r1 = await runTool(byName().get('equip_item')!, { item: 'axe' }, eq.ctx)
  assert.equal(r1.structuredContent.ok, true)
  assert.deepEqual(eq.enqueued[0]!.params, { item: 'axe' })
  const pk = fakeCtx(OK_CONTROL)
  const r2 = await runTool(byName().get('pick_up_item')!, { item: 'flint', count: 3, radius: 8 }, pk.ctx)
  assert.equal(r2.structuredContent.ok, true)
  assert.deepEqual(pk.enqueued[0]!.params, { item: 'flint', count: 3, radius: 8 })
})
