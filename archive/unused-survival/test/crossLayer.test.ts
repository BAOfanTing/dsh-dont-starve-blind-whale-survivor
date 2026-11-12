// Phase 5 M2 · Controller → Bridge 跨层同步测试
//
// 分工：Controller 侧验证「控制权变更真的发出同步请求、失败不阻塞」；
//       Bridge 侧（game-bridge/test/control.test.ts）验证「收到后落盘、重启恢复、Lua assert 判定」。
// 两边各自测清，再用 demo-m2.mjs 起真实 Bridge + Controller 做端到端对账。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createController } from '../src/controllerApi.js'

interface SyncCall { url: string; body: any; auth: string | null }

/** 记录同步请求的假 fetch */
function recorder(shouldFail = false): { fn: typeof fetch; calls: SyncCall[] } {
  const calls: SyncCall[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    if (shouldFail) throw new Error('Bridge 连不上')
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')),
      auth: headers.authorization ?? null,
    })
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  }) as typeof fetch
  return { fn, calls }
}

test('M2：Controller 启动即推初始 SUPERVISED 状态给 Bridge', async () => {
  const rec = recorder()
  const c = createController({ bridge: { url: 'http://bridge', token: 'T' }, fetchImpl: rec.fn })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(rec.calls.length, 1)
  assert.match(rec.calls[0]!.url, /\/api\/v1\/control\/sync$/)
  assert.equal(rec.calls[0]!.auth, 'Bearer T')
  assert.equal(rec.calls[0]!.body.mode, 'SUPERVISED')
  assert.equal(rec.calls[0]!.body.holder, null)
  assert.equal(rec.calls[0]!.body.emergency_stop, false)
  await c.close()
})

test('M2：acquire 后同步 holder/session/lease_expires_at', async () => {
  const rec = recorder()
  const c = createController({ bridge: { url: 'http://bridge', token: 'T' }, fetchImpl: rec.fn })
  const port = await c.listen()
  try {
    const acq = await (await fetch(`http://127.0.0.1:${port}/api/control/acquire`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controller_id: 'C1', session_id: 'S1' }),
    })).json() as any
    assert.equal(acq.ok, true)
    await new Promise((r) => setTimeout(r, 30))
    const last = rec.calls.at(-1)!
    assert.equal(last.body.holder, 'C1')
    assert.equal(last.body.session_id, 'S1')
    assert.ok(last.body.lease_expires_at > Date.now(), 'lease 过期时间要同步')
  } finally { await c.close() }
})

test('M2：紧急停止同步 EMERGENCY_STOP，holder 清空', async () => {
  const rec = recorder()
  const c = createController({ bridge: { url: 'http://bridge', token: 'T' }, fetchImpl: rec.fn })
  const port = await c.listen()
  try {
    const base = `http://127.0.0.1:${port}`
    await fetch(base + '/api/control/acquire', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controller_id: 'C1', session_id: 'S1' }),
    })
    const stop = await (await fetch(base + '/api/control/emergency-stop', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'M2 测试' }),
    })).json() as any
    assert.equal(stop.status.mode, 'EMERGENCY_STOP')
    await new Promise((r) => setTimeout(r, 30))
    const last = rec.calls.at(-1)!
    assert.equal(last.body.mode, 'EMERGENCY_STOP')
    assert.equal(last.body.emergency_stop, true)
    assert.equal(last.body.holder, null)
  } finally { await c.close() }
})

test('M2：同步失败不阻塞控制逻辑，/health 暴露 last_error', async () => {
  const rec = recorder(true)
  const c = createController({ bridge: { url: 'http://bridge', token: 'T' }, fetchImpl: rec.fn })
  const port = await c.listen()
  try {
    const acq = await (await fetch(`http://127.0.0.1:${port}/api/control/acquire`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controller_id: 'C1', session_id: 'S1' }),
    })).json() as any
    assert.equal(acq.ok, true, 'Bridge 挂了控制权操作照常可用')
    await new Promise((r) => setTimeout(r, 30))
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as any
    assert.match(String(health.bridge_sync.last_error), /Bridge 连不上/)
    assert.equal(health.bridge_sync.sync_count, 0)
  } finally { await c.close() }
})

test('M2：release 后同步 holder=null（Lua 端随后应拒绝写动作）', async () => {
  const rec = recorder()
  const c = createController({ bridge: { url: 'http://bridge', token: 'T' }, fetchImpl: rec.fn })
  const port = await c.listen()
  try {
    const base = `http://127.0.0.1:${port}`
    await fetch(base + '/api/control/acquire', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controller_id: 'C1', session_id: 'S1' }),
    })
    await fetch(base + '/api/control/release', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controller_id: 'C1' }),
    })
    await new Promise((r) => setTimeout(r, 30))
    const last = rec.calls.at(-1)!
    assert.equal(last.body.holder, null)
  } finally { await c.close() }
})

test('M2：没配 bridge 时 sync=null，M1 行为不变（向后兼容）', async () => {
  const c = createController()
  const port = await c.listen()
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as any
    assert.equal(health.bridge_sync, null)
    assert.equal(health.version, '0.5.0-m2')
  } finally { await c.close() }
})
