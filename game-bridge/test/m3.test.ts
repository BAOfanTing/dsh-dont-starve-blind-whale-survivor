// M3 测试：SessionManager（会话/幂等/超时）+ heartbeat / telemetry 接口
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { createBridgeServer } from '../src/server.js'
import { SessionManager } from '../src/session.js'
import { BridgeState } from '../src/state.js'

const TOKEN = 'm3-token-0123456789abcdef'

interface Harness {
  base: string
  sessions: SessionManager
  close: () => Promise<void>
}

async function startHarness(options: { now?: () => number } = {}): Promise<Harness> {
  const config = loadConfig({ env: {}, port: 0, token: TOKEN, writeTokenFile: false })
  const logger = createLogger({ secrets: [config.token], sink: () => {} })
  const state = new BridgeState()
  const sessions = new SessionManager(options.now ? { now: options.now } : {})
  const handle = createBridgeServer({ config, logger, state, sessions })
  const port = await handle.listen(0)
  return { base: `http://127.0.0.1:${port}`, sessions, close: () => handle.close() }
}

function postJson(base: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const url = new URL(path, base)
  const text = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: {} },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, json: raw ? (JSON.parse(raw) as Record<string, any>) : {} })
        })
      },
    )
    req.on('error', reject)
    req.end(text)
  })
}

const heartbeatBody = (sessionId = 'S1') => ({
  protocol_version: '1.0',
  token: TOKEN,
  session_id: sessionId,
  timestamp: 1794410000,
  player_status: { present: true, prefab: 'willow', health_percent: 87.5, tile_x: 4, tile_z: -16 },
  game_version: '762172',
})

const telemetryBody = (sequence: number, sessionId = 'S1', extra: Record<string, unknown> = {}) => ({
  protocol_version: '1.0',
  token: TOKEN,
  session_id: sessionId,
  sequence,
  timestamp: 1794410000,
  data: { tick: sequence, player: { prefab: 'willow' }, ...extra },
})

test('SessionManager：心跳更新、超时判定、会话列表', () => {
  let clock = 1000
  const sessions = new SessionManager({ heartbeatTimeoutMs: 10000, now: () => clock })
  sessions.heartbeat('S1', { playerStatus: { present: true }, gameVersion: '762172', shard: 'master' })
  assert.equal(sessions.isConnected(), true)
  const info = sessions.list()[0]
  assert.equal(info?.sessionId, 'S1')
  assert.equal(info?.gameVersion, '762172')
  assert.equal(info?.heartbeats, 1)

  clock += 9000
  assert.equal(sessions.isConnected(), true, '9 秒内还算连着')
  clock += 2000
  assert.equal(sessions.isConnected(), false, '超过 10 秒算断线')
})

test('SessionManager：sequence 幂等（重复不覆盖快照）+ 跳号记 gap', () => {
  const sessions = new SessionManager()
  const first = sessions.telemetry('S1', 1, { value: 'A' }, 100)
  assert.equal(first.duplicate, false)
  assert.equal(first.acknowledgedSequence, 1)

  const duplicate = sessions.telemetry('S1', 1, { value: 'B' }, 100)
  assert.equal(duplicate.duplicate, true, '同一个 sequence 再来一次要判重复')
  assert.equal(duplicate.acknowledgedSequence, 1)
  const info = sessions.list()[0]
  assert.deepEqual(info?.latest, { value: 'A' }, '重复包不能覆盖快照')

  const gap = sessions.telemetry('S1', 4, { value: 'C' }, 120)
  assert.equal(gap.gap, true, '1 → 4 中间丢了包，要记 gap')
  assert.equal(gap.acknowledgedSequence, 4)
  assert.equal(sessions.list()[0]?.gaps, 1)
})

test('SessionManager：current() 优先选有快照且心跳活的会话', () => {
  let clock = 1000
  const sessions = new SessionManager({ now: () => clock })
  sessions.heartbeat('CARES', {})
  sessions.telemetry('CARES', 1, { who: 'caves' }, 10)
  clock += 100
  sessions.heartbeat('MASTER', {})
  sessions.telemetry('MASTER', 1, { who: 'master' }, 10)
  assert.equal(sessions.current()?.sessionId, 'MASTER', '最近的会话优先')
  clock += 20000
  assert.equal(sessions.isConnected(), false)
})

test('POST /api/v1/heartbeat：200 + server_status', async () => {
  const h = await startHarness()
  try {
    const res = await postJson(h.base, '/api/v1/heartbeat', heartbeatBody())
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(res.json.success, true)
    assert.equal(res.json.protocol_version, '1.0')
    assert.equal(res.json.server_status.state, 'running')
    assert.equal(res.json.server_status.connected, true)
    assert.ok(typeof res.json.server_time === 'number')
  } finally {
    await h.close()
  }
})

test('POST /api/v1/telemetry：200 + acknowledged_sequence；重复 sequence 标 duplicate', async () => {
  const h = await startHarness()
  try {
    const first = await postJson(h.base, '/api/v1/telemetry', telemetryBody(1))
    assert.equal(first.status, 200)
    assert.equal(first.json.acknowledged_sequence, 1)
    assert.equal(first.json.duplicate, false)

    const again = await postJson(h.base, '/api/v1/telemetry', telemetryBody(1))
    assert.equal(again.status, 200)
    assert.equal(again.json.duplicate, true)
    assert.equal(again.json.acknowledged_sequence, 1)

    const next = await postJson(h.base, '/api/v1/telemetry', telemetryBody(2))
    assert.equal(next.json.acknowledged_sequence, 2)
    assert.equal(next.json.duplicate, false)
  } finally {
    await h.close()
  }
})

test('参数校验：缺字段/类型错/协议版本不支持 → 400（带稳定错误码）', async () => {
  const h = await startHarness()
  try {
    const cases: Array<[string, unknown, RegExp]> = [
      ['/api/v1/heartbeat', { token: TOKEN }, /session_id/],
      ['/api/v1/heartbeat', { token: TOKEN, session_id: 'S1', timestamp: 'now' }, /timestamp/],
      ['/api/v1/heartbeat', { token: TOKEN, session_id: 'S1', timestamp: 1, protocol_version: '9.9' }, /协议版本/],
      ['/api/v1/telemetry', { token: TOKEN, session_id: 'S1', timestamp: 1, sequence: 0, data: {} }, /sequence/],
      ['/api/v1/telemetry', { token: TOKEN, session_id: 'S1', timestamp: 1, sequence: 1 }, /data/],
      ['/api/v1/telemetry', { token: TOKEN, session_id: 'S1', timestamp: 1, sequence: 1.5, data: {} }, /sequence/],
    ]
    for (const [path, body, pattern] of cases) {
      const res = await postJson(h.base, path, body)
      assert.equal(res.status, 400, `${path} ${JSON.stringify(body)} 应该 400`)
      assert.equal(res.json.error.code, 'bad_request')
      assert.match(String(res.json.error.message), pattern)
    }
  } finally {
    await h.close()
  }
})

test('鉴权：心跳/状态推送没 token 都 401', async () => {
  const h = await startHarness()
  try {
    const hb = await postJson(h.base, '/api/v1/heartbeat', { session_id: 'S1', timestamp: 1 })
    assert.equal(hb.status, 401)
    const tel = await postJson(h.base, '/api/v1/telemetry', { session_id: 'S1', sequence: 1, timestamp: 1, data: {} })
    assert.equal(tel.status, 401)
  } finally {
    await h.close()
  }
})

test('bridge/status：能看到会话明细与连接状态', async () => {
  const h = await startHarness()
  try {
    await postJson(h.base, '/api/v1/heartbeat', heartbeatBody('S-MASTER'))
    await postJson(h.base, '/api/v1/telemetry', telemetryBody(3, 'S-MASTER'))

    const res = await fetch(`${h.base}/api/v1/bridge/status?token=${TOKEN}`)
    const body = (await res.json()) as Record<string, any>
    assert.equal(res.status, 200)
    assert.equal(body.bridge.connected, true)
    assert.equal(body.bridge.session_id, 'S-MASTER')
    assert.equal(body.bridge.last_sequence, 3)
    assert.equal(body.bridge.game_version, '762172')
    assert.equal(body.sessions.length, 1)
    assert.equal(body.sessions[0].acknowledged_sequence, 3)
    assert.equal(body.sessions[0].alive, true)
    assert.equal(body.sessions[0].player_status.prefab, 'willow')
  } finally {
    await h.close()
  }
})
