// Phase 5 M6 · MCP 任务链工具测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTaskTools } from '../src/tools/taskTools.js'
import { createToolDefinitions, runTool } from '../src/tools/definitions.js'

const byName = () => new Map(createTaskTools().map((t) => [t.name, t]))

test('M6：新增 3 个任务链工具，MCP 总工具数 43', () => {
  assert.deepEqual(createTaskTools().map((t) => t.name).sort(),
    ['get_task_status', 'start_task', 'stop_task'])
  assert.equal(createToolDefinitions().length, 43)
})

test('M6：readOnly 标记正确（start/stop 写，status 只读）', () => {
  const m = byName()
  assert.equal(m.get('start_task')!.readOnly, false)
  assert.equal(m.get('stop_task')!.readOnly, false)
  assert.equal(m.get('get_task_status')!.readOnly, true)
})

test('M6：start_task Schema 只接受固定任务名', () => {
  const tool = byName().get('start_task')!
  for (const ok of ['survive_night', 'stock_logs', 'toolkit', 'forage']) {
    assert.equal(tool.schema.safeParse({ task: ok }).success, true, `${ok} 应通过`)
  }
  for (const bad of ['rm_rf', 'eval_lua', '任意脚本', '']) {
    assert.equal(tool.schema.safeParse({ task: bad }).success, false, `${bad} 应被拒`)
  }
  assert.equal(tool.schema.safeParse({}).success, false, 'task 必填')
})

/** 假上下文 */
function fakeCtx(control: Record<string, unknown>, commandResult: unknown = { running: false }) {
  const enqueued: Array<{ type: string; params: Record<string, unknown>; options: any }> = []
  const ctx = {
    client: {
      controlStatus: async () => ({ status: 200, data: { control }, elapsedMs: 1 }),
      enqueueCommand: async (type: string, params: Record<string, unknown>, options: any) => {
        enqueued.push({ type, params, options })
        return { status: 200, data: { command: { id: `cmd_${type}_1`, type, status: 'QUEUED' } }, elapsedMs: 1 }
      },
      getCommand: async () => ({
        status: 200,
        data: { command: { status: 'SUCCEEDED', result: commandResult } },
        elapsedMs: 1,
      }),
    },
    config: {}, logger: { info() {}, warn() {}, error() {}, debug() {} }, events: { observe() {} },
  } as any
  return { ctx, enqueued }
}

const OK_CONTROL = {
  mode: 'SUPERVISED', holder: 'C1', session_id: 'S1',
  emergency_stop: false, lease_expires_at: Date.now() + 60000,
}

test('M6：start_task 有控制权时下发，带 master 分片', async () => {
  const { ctx, enqueued } = fakeCtx(OK_CONTROL)
  const r = await runTool(byName().get('start_task')!, { task: 'survive_night' }, ctx)
  assert.equal(r.structuredContent.ok, true)
  assert.equal(enqueued[0]!.type, 'start_task')
  assert.deepEqual(enqueued[0]!.params, { task: 'survive_night' })
  assert.equal(enqueued[0]!.options.shard, 'master')
  assert.equal(enqueued[0]!.options.controllerId, 'C1')
})

test('M6：start_task / stop_task 需要控制权', async () => {
  for (const control of [
    { mode: 'SUPERVISED', holder: null, emergency_stop: false },
    { mode: 'EMERGENCY_STOP', holder: 'C1', emergency_stop: true, lease_expires_at: Date.now() + 60000 },
    { mode: 'MANUAL', holder: null, emergency_stop: false },
    { mode: 'PAUSED', holder: 'C1', emergency_stop: false, lease_expires_at: Date.now() + 60000 },
    { mode: 'SUPERVISED', holder: 'C1', emergency_stop: false, lease_expires_at: Date.now() - 1000 },
  ]) {
    const a = fakeCtx(control)
    const r1 = await runTool(byName().get('start_task')!, { task: 'forage' }, a.ctx)
    assert.equal(r1.structuredContent.ok, false, `mode=${control.mode} start 应被拒`)
    assert.equal((r1.structuredContent.error as any).code, 'SESSION_INVALID')
    assert.equal(a.enqueued.length, 0, '被拒时不该下发')

    const b = fakeCtx(control)
    const r2 = await runTool(byName().get('stop_task')!, {}, b.ctx)
    assert.equal(r2.structuredContent.ok, false, `mode=${control.mode} stop 应被拒`)
    assert.equal(b.enqueued.length, 0)
  }
})

test('M6：get_task_status 只读，不需要控制权', async () => {
  const { ctx, enqueued } = fakeCtx(
    { mode: 'SUPERVISED', holder: null, emergency_stop: false },
    { running: true, task: 'survive_night', step_index: 2, step_total: 5, steps_done: 1, steps_skipped: 0, current_why: '砍 1 棵树（拿木头）' },
  )
  const r = await runTool(byName().get('get_task_status')!, {}, ctx)
  assert.equal(r.structuredContent.ok, true)
  assert.equal(r.structuredContent.running, true)
  assert.equal(r.structuredContent.task, 'survive_night')
  assert.equal(enqueued[0]!.type, 'get_task_status')
  // 无控制权也应能查
  assert.equal(enqueued.length, 1)
})

test('M6：get_task_status 文案包含进度信息', async () => {
  const { ctx } = fakeCtx(OK_CONTROL, {
    running: true, task: 'stock_logs', step_index: 3, step_total: 5,
    steps_done: 2, steps_skipped: 0, current_why: '砍 3 棵树',
  })
  const r = await runTool(byName().get('get_task_status')!, {}, ctx)
  const text = String((r.content as any)[0].text)
  assert.match(text, /stock_logs/)
  assert.match(text, /3\/5/)
  assert.match(text, /砍 3 棵树/)
})

test('M6：get_task_status 未在跑时文案明确', async () => {
  const { ctx } = fakeCtx(OK_CONTROL, { running: false })
  const r = await runTool(byName().get('get_task_status')!, {}, ctx)
  assert.match(String((r.content as any)[0].text), /没有任务在跑/)
})

test('M6：stop_task 有控制权时下发', async () => {
  const { ctx, enqueued } = fakeCtx(OK_CONTROL, { running: false, stopped: true })
  const r = await runTool(byName().get('stop_task')!, {}, ctx)
  assert.equal(r.structuredContent.ok, true)
  assert.equal(enqueued[0]!.type, 'stop_task')
})
