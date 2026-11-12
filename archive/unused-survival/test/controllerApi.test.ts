// Phase 5 M1 · Controller HTTP API 测试（dry-run）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createController } from '../src/controllerApi.js'

interface H { base: string; close: () => Promise<void> }

async function start(): Promise<H> {
  const c = createController()
  const port = await c.listen()
  return { base: `http://127.0.0.1:${port}`, close: () => c.close() }
}

const post = async (base: string, path: string, body: unknown = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, json: (await r.json()) as Record<string, any> }
}
const get = async (base: string, path: string) => {
  const r = await fetch(base + path)
  return { status: r.status, json: (await r.json()) as Record<string, any> }
}
const cmd = (id: string, key: string, type = 'gather_resource', controller_id = 'C1') => ({
  command_id: 'c_' + id, action_id: id, idempotency_key: key, session_id: 'S1', controller_id,
  created_at: Date.now(), expires_at: Date.now() + 60000, expected_state_sequence: 1,
  action_type: type, payload: { prefab: 'twigs' }, dry_run: true,
})

test('HTTP：/health 显示 dry_run_only=true、初始 SUPERVISED', async () => {
  const h = await start()
  try {
    const r = await get(h.base, '/health')
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.dry_run_only, true)
    assert.equal(r.json.mode, 'SUPERVISED')
  } finally { await h.close() }
})

test('HTTP：未获控制权提交动作 → 409 CONTROL_NOT_HELD', async () => {
  const h = await start()
  try {
    const r = await post(h.base, '/api/actions/submit', cmd('a1', 'K1'))
    assert.equal(r.status, 409)
    assert.equal(r.json.error?.code, 'CONTROL_NOT_HELD')
    assert.equal(r.json.record.status, 'FAILED')
  } finally { await h.close() }
})

test('HTTP：acquire → submit → dry-run → 查询记录（完整审计）', async () => {
  const h = await start()
  try {
    const acq = await post(h.base, '/api/control/acquire', { controller_id: 'C1', session_id: 'S1' })
    assert.equal(acq.status, 200)
    const sub = await post(h.base, '/api/actions/submit', cmd('a1', 'K1'))
    assert.equal(sub.status, 200)
    assert.equal(sub.json.status, 'PENDING')
    const dry = await post(h.base, '/api/actions/dry-run', { action_id: 'a1', controller_id: 'C1' })
    assert.equal(dry.status, 200)
    assert.equal(dry.json.status, 'SUCCEEDED')
    assert.equal(dry.json.record.result.executed, false, '没执行真实动作')

    const rec = await get(h.base, '/api/actions/a1')
    assert.equal(rec.status, 200)
    assert.deepEqual(rec.json.record.history.map((x: any) => x.status), ['PENDING', 'VALIDATING', 'ACCEPTED', 'RUNNING', 'SUCCEEDED'])
    const list = await get(h.base, '/api/actions')
    assert.equal(list.json.records.length, 1)
    assert.equal(list.json.stats.dry_runs, 1)
  } finally { await h.close() }
})

test('HTTP：重复 idempotency_key 不新增记录（幂等）', async () => {
  const h = await start()
  try {
    await post(h.base, '/api/control/acquire', { controller_id: 'C1', session_id: 'S1' })
    const a = await post(h.base, '/api/actions/submit', cmd('a1', 'SAME'))
    const b = await post(h.base, '/api/actions/submit', cmd('a2', 'SAME'))
    assert.equal(a.status, 200)
    assert.equal(b.json.duplicate, true)
    assert.equal(b.json.deduplicated_from, 'a1')
    const list = await get(h.base, '/api/actions')
    assert.equal(list.json.records.length, 1, '只应有 1 条记录')
  } finally { await h.close() }
})

test('HTTP：控制权切换/紧急停止', async () => {
  const h = await start()
  try {
    await post(h.base, '/api/control/acquire', { controller_id: 'C1', session_id: 'S1' })
    await post(h.base, '/api/actions/submit', cmd('a1', 'K1'))
    const stop = await post(h.base, '/api/control/emergency-stop', { reason: '测试' })
    assert.equal(stop.status, 200)
    assert.equal(stop.json.status.mode, 'EMERGENCY_STOP')
    assert.equal(stop.json.cancelled, 1)
    const after = await post(h.base, '/api/actions/submit', cmd('a2', 'K2'))
    assert.equal(after.json.error?.code, 'EMERGENCY_STOP')
    const cleared = await post(h.base, '/api/control/clear-emergency')
    assert.equal(cleared.json.status.mode, 'SUPERVISED')
  } finally { await h.close() }
})

test('HTTP：需确认动作先 confirm 再 dry-run', async () => {
  const h = await start()
  try {
    await post(h.base, '/api/control/acquire', { controller_id: 'C1', session_id: 'S1' })
    await post(h.base, '/api/actions/submit', cmd('a1', 'K1', 'chop_tree'))
    const before = await post(h.base, '/api/actions/dry-run', { action_id: 'a1', controller_id: 'C1' })
    assert.equal(before.json.status, 'VALIDATING')
    await post(h.base, '/api/actions/confirm', { action_id: 'a1', controller_id: 'C1' })
    const after = await post(h.base, '/api/actions/dry-run', { action_id: 'a1', controller_id: 'C1' })
    assert.equal(after.json.status, 'SUCCEEDED')
  } finally { await h.close() }
})

test('HTTP：坏 JSON / 未知动作 / 取消动作', async () => {
  const h = await start()
  try {
    const bad = await fetch(h.base + '/api/actions/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
    assert.equal(bad.status, 400)
    assert.equal(((await bad.json()) as any).error.code, 'INVALID_JSON')

    await post(h.base, '/api/control/acquire', { controller_id: 'C1', session_id: 'S1' })
    const unknown = await post(h.base, '/api/actions/submit', { ...cmd('a1', 'K1'), action_type: 'eval_lua' })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.json.error.code, 'UNKNOWN_ACTION')

    await post(h.base, '/api/actions/submit', cmd('a2', 'K2'))
    const cancel = await post(h.base, '/api/actions/cancel', { action_id: 'a2', controller_id: 'C1' })
    assert.equal(cancel.json.status, 'CANCELLED')
  } finally { await h.close() }
})

test('HTTP：未知路径 404 并列出接口', async () => {
  const h = await start()
  try {
    const r = await get(h.base, '/nope')
    assert.equal(r.status, 404)
    assert.ok(Array.isArray(r.json.endpoints))
  } finally { await h.close() }
})
