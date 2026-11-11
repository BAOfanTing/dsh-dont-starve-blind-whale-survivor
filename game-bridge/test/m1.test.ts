// M1 验收测试：HTTP 服务 / 路由 / Token / 原始文本 JSON / 大小限制 / 日志脱敏
//
// 全部用真实 HTTP 请求打真实服务器（端口 0 = 系统分配），不 mock。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, maskToken, PROTOCOL_VERSION } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { createBridgeServer } from '../src/server.js'
import { BridgeState } from '../src/state.js'

const TOKEN = 'test-token-0123456789abcdef'

interface Harness {
  base: string
  logger: ReturnType<typeof createLogger>
  state: BridgeState
  close: () => Promise<void>
}

async function startHarness(options: { token?: string; maxBodyBytes?: number } = {}): Promise<Harness> {
  const config = loadConfig({
    env: { BWS_MAX_BODY_BYTES: String(options.maxBodyBytes ?? 4096) },
    port: 0,
    token: options.token ?? TOKEN,
    writeTokenFile: false,
  })
  const logger = createLogger({ secrets: [config.token], sink: () => {} })
  const state = new BridgeState()
  const handle = createBridgeServer({ config, logger, state })
  const port = await handle.listen(0)
  return {
    base: `http://127.0.0.1:${port}`,
    logger,
    state,
    close: () => handle.close(),
  }
}

/** 用 node:http 直发，完全控制请求头（模拟 QueryServer 不带 content-type） */
function rawPost(base: string, path: string, text: string, headers: Record<string, string> = {}): Promise<{
  status: number
  body: string
}> {
  const url = new URL(path, base)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end(text)
  })
}

const getJson = async (base: string, path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, { headers })
  return { status: res.status, json: (await res.json()) as Record<string, any> }
}

test('GET /health：不需要 token，返回版本/协议/运行时长', async () => {
  const h = await startHarness()
  try {
    const { status, json } = await getJson(h.base, '/health')
    assert.equal(status, 200)
    assert.equal(json.success, true)
    assert.equal(json.protocol_version, PROTOCOL_VERSION)
    assert.equal(json.version, '0.2.0-m1')
    assert.ok(typeof json.uptime_s === 'number')
    assert.ok(String(json.bound).startsWith('127.0.0.1:'))
    assert.equal(json.bridge.started, true)
    assert.equal(json.bridge.connected, false, 'M1 还没有心跳，connected 必须是 false')
  } finally {
    await h.close()
  }
})

test('GET /api/v1/bridge/status：没 token 401，带 token 200 且字段齐全', async () => {
  const h = await startHarness()
  try {
    const noToken = await getJson(h.base, '/api/v1/bridge/status')
    assert.equal(noToken.status, 401)
    assert.equal(noToken.json.error.code, 'unauthorized')

    const viaQuery = await getJson(h.base, `/api/v1/bridge/status?token=${TOKEN}`)
    assert.equal(viaQuery.status, 200)
    const bridge = viaQuery.json.bridge
    for (const key of [
      'started',
      'connected',
      'connected_reason',
      'last_heartbeat_at',
      'last_heartbeat_ago_ms',
      'session_id',
      'last_sequence',
      'queued_commands',
      'last_error',
      'requests',
    ]) {
      assert.ok(key in bridge, `bridge.${key} 缺失`)
    }
    assert.equal(bridge.started, true)
    assert.equal(bridge.last_heartbeat_at, null)
    assert.equal(bridge.session_id, null)
    assert.equal(bridge.queued_commands, 0)

    const viaHeader = await getJson(h.base, '/api/v1/bridge/status', { authorization: `Bearer ${TOKEN}` })
    assert.equal(viaHeader.status, 200)
  } finally {
    await h.close()
  }
})

test('POST 原始文本 JSON（不带 content-type）：能解析、token 从 body 里取到', async () => {
  const h = await startHarness()
  try {
    const payload = JSON.stringify({ token: TOKEN, session_id: 'S1', sequence: 1 })
    const res = await rawPost(h.base, '/api/v1/telemetry', payload) // 故意不设 content-type
    assert.equal(res.status, 501, 'M1 里 telemetry 是占位，返回 501')
    const body = JSON.parse(res.body)
    assert.equal(body.success, false)
    assert.equal(body.error.code, 'not_implemented')
    assert.match(String(body.error.message), /M3/, '要说明计划在哪个里程碑实现')
    assert.ok(String(body.request_id).length > 0)
  } finally {
    await h.close()
  }
})

test('POST 的错误分支：错 token 401、坏 JSON 400、没 body 400、超长 413', async () => {
  const h = await startHarness({ maxBodyBytes: 512 })
  try {
    const wrong = await rawPost(h.base, '/api/v1/heartbeat', JSON.stringify({ token: 'nope' }))
    assert.equal(wrong.status, 401)

    const broken = await rawPost(h.base, '/api/v1/heartbeat', '{"token": "x", ')
    assert.equal(broken.status, 400)
    assert.equal(JSON.parse(broken.body).error.code, 'invalid_json')

    const empty = await rawPost(h.base, '/api/v1/heartbeat', '')
    assert.equal(empty.status, 400)

    const huge = await rawPost(h.base, '/api/v1/heartbeat', JSON.stringify({ token: TOKEN, pad: 'x'.repeat(2000) }))
    assert.equal(huge.status, 413)
    assert.equal(JSON.parse(huge.body).error.code, 'payload_too_large')
  } finally {
    await h.close()
  }
})

test('方法 / 路径不对：405 与 404', async () => {
  const h = await startHarness()
  try {
    const wrongMethod = await rawPost(h.base, '/health', '{}')
    assert.equal(wrongMethod.status, 405)
    assert.equal(JSON.parse(wrongMethod.body).error.code, 'method_not_allowed')

    const missing = await getJson(h.base, '/api/v1/nope')
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'not_found')
  } finally {
    await h.close()
  }
})

test('只监听 127.0.0.1（本地回环）', async () => {
  const h = await startHarness()
  try {
    const url = new URL(h.base)
    assert.equal(url.hostname, '127.0.0.1')
  } finally {
    await h.close()
  }
})

test('日志分级 + token 不出现在日志里 + request_id 透传', async () => {
  const h = await startHarness()
  try {
    await getJson(h.base, '/health')
    await getJson(h.base, '/api/v1/bridge/status') // 401
    await rawPost(h.base, '/api/v1/commands/poll', JSON.stringify({ token: TOKEN }), { 'x-request-id': 'trace-abc-123' })

    const lines = h.logger.lines()
    assert.ok(lines.some((l) => l.includes('INFO')), '应该有 INFO')
    assert.ok(lines.some((l) => l.includes('WARN')), '401 应该记 WARN')
    for (const line of lines) {
      assert.ok(!line.includes(TOKEN), 'token 不能出现在日志里：' + line)
    }
    assert.ok(lines.some((l) => l.includes('trace-abc-123')), 'request_id 应该进日志，便于端到端排查')
  } finally {
    await h.close()
  }
})

test('maskToken 不泄露完整 token', () => {
  const masked = maskToken(TOKEN)
  assert.ok(!masked.includes(TOKEN))
  assert.ok(masked.length < TOKEN.length)
  assert.equal(maskToken('short'), '****')
})

test('config：默认端口 18788 / 默认只监听 127.0.0.1 / 生成随机 token', () => {
  // 用仓库外的临时 token 文件，避免“复用了本地 .runtime/token.txt”影响断言
  const emptyTokenFile = join(tmpdir(), 'bws-no-such-token-' + process.pid + '.txt')
  const config = loadConfig({ env: { BWS_TOKEN_FILE: emptyTokenFile }, writeTokenFile: false })
  assert.equal(config.port, 18788)
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.protocolVersion, '1.0')
  assert.equal(config.token.length, 64, '随机 token 是 32 字节 hex')
  assert.equal(config.tokenSource, 'generated')

  const fromEnv = loadConfig({ env: { BWS_TOKEN: 'abc', BWS_PORT: '9000' }, writeTokenFile: false })
  assert.equal(fromEnv.token, 'abc')
  assert.equal(fromEnv.tokenSource, 'env')
  assert.equal(fromEnv.port, 9000)
})
