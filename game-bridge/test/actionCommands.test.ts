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

test('M2/M3：COMMAND_TYPES 含移动 + 采集动作，测试命令仍在', () => {
  assert.ok(COMMAND_TYPES.includes('move_to'))
  assert.ok(COMMAND_TYPES.includes('stop_movement'))
  assert.ok(COMMAND_TYPES.includes('get_movement_status'))
  assert.ok(COMMAND_TYPES.includes('ping'))
  assert.equal(COMMAND_TYPES.length, 21, '4 测试 + 3 移动 + 3 采集 + 4 工具 + 4 生存 + 3 任务')
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

test('M2 回归：get_movement_status 也绑定 master 分片（真机踩到 caves 取走查到空实例）', async () => {
  const h = await start()
  try {
    const enq = await post(h.base, '/api/v1/commands/enqueue', { type: 'get_movement_status', params: {} })
    assert.equal(enq.status, 200)
    const caves = await post(h.base, '/api/v1/commands/poll', {
      protocol_version: '1.0', token: TOKEN, session_id: 'CAVES2', shard: 'caves', last_acknowledged_id: null,
    })
    assert.equal(caves.json.command?.type !== 'get_movement_status', true, 'caves 不该取走只读状态查询')
    const master = await post(h.base, '/api/v1/commands/poll', {
      protocol_version: '1.0', token: TOKEN, session_id: 'MASTER2', shard: 'master', last_acknowledged_id: null,
    })
    assert.equal(master.json.command?.type, 'get_movement_status', 'master 应取到只读状态查询')
  } finally { await h.close() }
})

test('M3：COMMAND_TYPES 含 3 个采集相关命令', () => {
  assert.ok(COMMAND_TYPES.includes('gather_resource'))
  assert.ok(COMMAND_TYPES.includes('move_to_target'))
  assert.ok(COMMAND_TYPES.includes('probe_game_actions'))
  assert.equal(COMMAND_TYPES.length, 21, '4 测试 + 3 移动 + 3 采集 + 4 工具 + 4 生存 + 3 任务')
})

test('M3：gather_resource 需要控制权 + 自动绑定 master，probe_game_actions 只读且绑 master', async () => {
  const h = await start()
  try {
    const denied = await post(h.base, '/api/v1/commands/enqueue', {
      type: 'gather_resource', controller_id: 'C1', session_id: 'S1', params: { resource: 'twigs' },
    })
    assert.equal(denied.status, 403, '无控制权应拒绝')

    h.control.update({
      mode: 'SUPERVISED', holder: 'C1', session_id: 'S1', lease_expires_at: Date.now() + 60000,
      emergency_stop: false, reason: 'M3 测试',
    })
    const ok = await post(h.base, '/api/v1/commands/enqueue', {
      type: 'gather_resource', controller_id: 'C1', session_id: 'S1', params: { resource: 'twigs', count: 3 },
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.command.type, 'gather_resource')
    assert.equal(ok.json.command.params.controller_id, 'C1')

    // caves 不该取走采集动作
    const caves = await post(h.base, '/api/v1/commands/poll', {
      protocol_version: '1.0', token: TOKEN, session_id: 'CAVES_M3', shard: 'caves', last_acknowledged_id: null,
    })
    assert.notEqual(caves.json.command?.type, 'gather_resource')
    const master = await post(h.base, '/api/v1/commands/poll', {
      protocol_version: '1.0', token: TOKEN, session_id: 'MASTER_M3', shard: 'master', last_acknowledged_id: null,
    })
    assert.equal(master.json.command?.type, 'gather_resource')

    // 只读探测不需要控制权，但仍绑 master
    const probe = await post(h.base, '/api/v1/commands/enqueue', { type: 'probe_game_actions', params: {} })
    assert.equal(probe.status, 200)
    const caves2 = await post(h.base, '/api/v1/commands/poll', {
      protocol_version: '1.0', token: TOKEN, session_id: 'CAVES_M3B', shard: 'caves', last_acknowledged_id: null,
    })
    assert.notEqual(caves2.json.command?.type, 'probe_game_actions')
  } finally { await h.close() }
})
