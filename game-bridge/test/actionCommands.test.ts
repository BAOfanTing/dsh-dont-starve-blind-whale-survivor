// Phase 5 M2 · Bridge 动作命令入队与控制权校验测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridgeServer } from '../src/server.js'
import { ControlStateStore } from '../src/control.js'
import { CommandQueue, COMMAND_TYPES } from '../src/commands.js'
import { SessionManager } from '../src/session.js'
import { BridgeState } from '../src/state.js'
import { createLogger } from '../src/logger.js'
import { loadConfig } from '../src/config.js'

const TOKEN = 'm2-action-token'
const config = { ...loadConfig({ token: TOKEN }), token: TOKEN }

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'bws-m2-action-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function start() {
  const t = tempDir()
  const control = new ControlStateStore({ path: join(t.dir, 'control.json') })
  const logger = createLogger({ secrets: [TOKEN], sink: () => {} })
  const handle = createBridgeServer({
    config, logger, state: new BridgeState(), sessions: new SessionManager(),
    commands: new CommandQueue(), control,
  })
  const port = await handle.listen(0)
  return { base: `http://127.0.0.1:${port}`, control, close: async () => { await handle.close(); t.cleanup() } }
}

const post = async (base: string, path: string, body: unknown) => {
  const r = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  })
  return { status: r.status, json: (await r.json()) as any }
}

test('M2：COMMAND_TYPES 含 3 个移动动作，测试命令仍在', () => {
  assert.ok(COMMAND_TYPES.includes('move_to'))
  assert.ok(COMMAND_TYPES.includes('stop_movement'))
  assert.ok(COMMAND_TYPES.includes('get_movement_status'))
  assert.ok(COMMAND_TYPES.includes('ping'))
  assert.equal(COMMAND_TYPES.length, 7)
})

test('M2：动作命令缺 controller_id/session_id → 400', async () => {
  const h = await start()
  try {
    const r = await post(h.base, '/api/v1/commands/enqueue', { type: 'move_to', params: { x: 10, z: 20 } })
    assert.equal(r.status, 400)
    assert.match(r.json.error.message, /controller_id/)
  } finally { await h.close() }
})

test('M2：无控制权时动作命令 → 403 CONTROL_NOT_HELD', async () => {
  const h = await start()
  try {
    const r = await post(h.base, '/api/v1/commands/enqueue', {
      type: 'move_to', controller_id: 'C1', session_id: 'S1', params: { x: 10, z: 20 },
    })
    assert.equal(r.status, 403)
    assert.match(r.json.error.message, /CONTROL_NOT_HELD/)
  } finally { await h.close() }
})

test('M2：有控制权时动作命令入队成功，且带上控制字段', async () => {
  const h = await start()
  try {
    h.control.update({
      mode: 'SUPERVISED', holder: 'C1', session_id: 'S1', lease_expires_at: Date.now() + 60000,
      emergency_stop: false, reason: '测试授权',
    })
    const r = await post(h.base, '/api/v1/commands/enqueue', {
      type: 'move_to', controller_id: 'C1', session_id: 'S1', params: { x: 10, z: 20 },
    })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.command.type, 'move_to')
    assert.equal(r.json.command.params.controller_id, 'C1')
    assert.equal(r.json.command.params.session_id, 'S1')
    assert.equal(r.json.command.params.x, 10)
  } finally { await h.close() }
})

test('M2：紧急停止后动作命令被拒（Bridge 层）', async () => {
  const h = await start()
  try {
    h.control.update({
      mode: 'EMERGENCY_STOP', holder: null, session_id: null, lease_expires_at: null,
      emergency_stop: true, reason: '紧急停止',
    })
    const r = await post(h.base, '/api/v1/commands/enqueue', {
      type: 'move_to', controller_id: 'C1', session_id: 'S1', params: { x: 1, z: 2 },
    })
    assert.equal(r.status, 403)
    assert.match(r.json.error.message, /EMERGENCY_STOP/)
  } finally { await h.close() }
})

test('M2：只读动作 get_movement_status 不需要控制权', async () => {
  const h = await start()
  try {
    const r = await post(h.base, '/api/v1/commands/enqueue', { type: 'get_movement_status', params: {} })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.command.type, 'get_movement_status')
  } finally { await h.close() }
})

test('M2：Phase 2 测试命令行为不变（ping 仍可直接入队）', async () => {
  const h = await start()
  try {
    const r = await post(h.base, '/api/v1/commands/enqueue', { type: 'ping', params: {} })
    assert.equal(r.status, 200)
    assert.equal(r.json.command.type, 'ping')
  } finally { await h.close() }
})

test('M2：未知命令仍被拒（白名单不开放任意动作）', async () => {
  const h = await start()
  try {
    const r = await post(h.base, '/api/v1/commands/enqueue', { type: 'eval_lua', params: { code: 'os.execute(...)' } })
    assert.equal(r.status, 400)
  } finally { await h.close() }
})

test('M2 回归：动作命令自动绑定 master 分片（真实踩到 caves 取走导致 no_player）', async () => {
  const h = await start()
  try {
    h.control.update({
      mode: 'SUPERVISED', holder: 'C1', session_id: 'S1', lease_expires_at: Date.now() + 60000,
      emergency_stop: false, reason: '测试授权',
    })
    const enq = await post(h.base, '/api/v1/commands/enqueue', {
      type: 'move_to', controller_id: 'C1', session_id: 'S1', params: { x: 1, z: 2 },
    })
    assert.equal(enq.status, 200)
    // 用 poll 模拟两个分片来取，验证 shard 绑定生效
    // 用 poll 模拟 caves 分片来取：应取不到这条动作
    const caves = await post(h.base, '/api/v1/commands/poll', {
      protocol_version: '1.0', token: TOKEN, session_id: 'CAVES', shard: 'caves', last_acknowledged_id: null,
    })
    assert.equal(caves.json.command?.type !== 'move_to', true, 'caves 分片不该取走 move_to')

    const master = await post(h.base, '/api/v1/commands/poll', {
      protocol_version: '1.0', token: TOKEN, session_id: 'MASTER', shard: 'master', last_acknowledged_id: null,
    })
    assert.equal(master.json.command?.type, 'move_to', 'master 分片应该取到 move_to')
  } finally { await h.close() }
})
