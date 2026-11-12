// Phase 5 M2 新增 get_control_status（只读），工具总数 12 → 13。
// M5 测试：Streamable HTTP 传输
//
// 用**真实 HTTP 请求**打真实服务器（端口 0 由系统分配），验证：
//   握手、会话管理、Host/Origin 校验、token 认证、请求体上限、与 stdio 结果一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createGameToolService } from '../src/server/createServer.js'
import { createHttpTransport } from '../src/transports/http.js'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/utils/logger.js'

const TOKEN = 'm5-http-token-0123456789abcdef'

interface Harness {
  base: string
  close: () => Promise<void>
  stats: () => { sessions: number; requests: number; rejected: number }
}

async function startHttp(options: { token?: string; maxBodyBytes?: number; allowNonLocalHost?: boolean } = {}): Promise<Harness> {
  const config = { ...loadConfig({ BWS_TOKEN: options.token ?? TOKEN }), token: options.token ?? TOKEN }
  const logger = createLogger({ sink: () => {} })
  const service = createGameToolService(config, logger)
  const transport = createHttpTransport(service, config, logger, {
    host: '127.0.0.1',
    port: 0,
    token: options.token ?? TOKEN,
    maxBodyBytes: options.maxBodyBytes,
    allowNonLocalHost: options.allowNonLocalHost,
  })
  const port = await transport.listen()
  return { base: `http://127.0.0.1:${port}`, close: () => transport.close(), stats: () => transport.stats() }
}

/** 发一个 JSON-RPC 请求，返回 { status, sessionId, json } */
async function rpc(
  base: string,
  body: unknown,
  options: { token?: string | null; sessionId?: string; headers?: Record<string, string>; method?: string } = {},
): Promise<{ status: number; sessionId: string | null; json: Record<string, any> | null; text: string }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...options.headers,
  }
  const token = options.token === undefined ? TOKEN : options.token
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (options.sessionId) headers['mcp-session-id'] = options.sessionId

  const response = await fetch(base, {
    method: options.method ?? 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json: Record<string, any> | null = null
  try {
    // Streamable HTTP 可能返回 SSE（data: {...}），这里两种都兼容
    if (text.startsWith('event:') || text.startsWith('data:')) {
      const dataLine = text.split('\n').find((line) => line.startsWith('data:'))
      json = dataLine ? (JSON.parse(dataLine.slice(5).trim()) as Record<string, any>) : null
    } else if (text.length > 0) {
      json = JSON.parse(text) as Record<string, any>
    }
  } catch {
    json = null
  }
  return { status: response.status, sessionId: response.headers.get('mcp-session-id'), json, text }
}

/** 原生 http.request：fetch 会覆盖 Host 头，测 DNS rebinding 必须用它 */
function rawRequest(
  base: string,
  options: { headers?: Record<string, string>; body?: string; method?: string } = {},
): Promise<{ status: number; text: string }> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: options.method ?? 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end(options.body ?? '')
  })
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'm5-http-test', version: '1' } },
}

test('HTTP：/healthz 不需要 token', async () => {
  const h = await startHttp()
  try {
    const response = await fetch(`${h.base}/healthz`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, any>
    assert.equal(body.ok, true)
    assert.equal(body.transport, 'streamable-http')
    assert.match(String(body.version), /^0\.3\.0-m\d+$/)
  } finally {
    await h.close()
  }
})

test('HTTP：没有 token → 401，且不建会话', async () => {
  const h = await startHttp()
  try {
    const noToken = await rpc(h.base, INIT, { token: null })
    assert.equal(noToken.status, 401)
    assert.equal(noToken.json?.error?.code, -32001)
    assert.equal(h.stats().sessions, 0, '认证失败不该建会话')

    const wrongToken = await rpc(h.base, INIT, { token: 'wrong-token' })
    assert.equal(wrongToken.status, 401)
    assert.equal(h.stats().sessions, 0)
  } finally {
    await h.close()
  }
})

test('HTTP：完整握手 + tools/list（与 stdio 同一套工具）', async () => {
  const h = await startHttp()
  try {
    const init = await rpc(h.base, INIT)
    assert.equal(init.status, 200, init.text)
    assert.ok(init.sessionId, '应返回 mcp-session-id')
    assert.equal(init.json?.result?.serverInfo?.name, 'blind-whale-survivor')

    // 发 initialized 通知
    await rpc(h.base, { jsonrpc: '2.0', method: 'notifications/initialized' }, { sessionId: init.sessionId! })

    const list = await rpc(h.base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { sessionId: init.sessionId! })
    const tools = list.json?.result?.tools as Array<{ name: string }>
    assert.equal(tools.length, 20, 'HTTP 与 stdio 必须同一套工具：' + JSON.stringify(list.json).slice(0, 300))

    const prompts = await rpc(h.base, { jsonrpc: '2.0', id: 3, method: 'prompts/list' }, { sessionId: init.sessionId! })
    assert.equal((prompts.json?.result?.prompts as unknown[]).length, 4)

    const resources = await rpc(h.base, { jsonrpc: '2.0', id: 4, method: 'resources/list' }, { sessionId: init.sessionId! })
    assert.equal((resources.json?.result?.resources as unknown[]).length, 6)

    assert.equal(h.stats().sessions, 1, '整个握手只该有 1 个会话')
  } finally {
    await h.close()
  }
})

test('HTTP：会话复用 —— 同一 session-id 的多次请求不新建会话', async () => {
  const h = await startHttp()
  try {
    const init = await rpc(h.base, INIT)
    const sessionId = init.sessionId!
    for (let i = 2; i <= 5; i += 1) {
      const response = await rpc(h.base, { jsonrpc: '2.0', id: i, method: 'tools/list' }, { sessionId })
      assert.equal(response.status, 200)
    }
    assert.equal(h.stats().sessions, 1, '应复用同一个会话')
  } finally {
    await h.close()
  }
})

test('HTTP：缺少 session-id 的 GET 被明确拒绝（不悄悄建会话）', async () => {
  const h = await startHttp()
  try {
    const response = await rpc(h.base, undefined, { method: 'GET' })
    assert.equal(response.status, 400)
    assert.match(String(response.json?.error?.message ?? ''), /mcp-session-id/)
    assert.equal(h.stats().sessions, 0)
  } finally {
    await h.close()
  }
})

test('HTTP：Host 头不是本机 → 403（防 DNS rebinding）', async () => {
  const h = await startHttp()
  try {
    const response = await rawRequest(h.base, {
      headers: { authorization: `Bearer ${TOKEN}`, host: 'evil.example.com' },
      body: JSON.stringify(INIT),
    })
    assert.equal(response.status, 403, response.text.slice(0, 200))
    assert.equal(h.stats().sessions, 0)
  } finally {
    await h.close()
  }
})

test('HTTP：Origin 不是本机 → 403', async () => {
  const h = await startHttp()
  try {
    const response = await rawRequest(h.base, {
      headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example.com' },
      body: JSON.stringify(INIT),
    })
    assert.equal(response.status, 403, response.text.slice(0, 200))
  } finally {
    await h.close()
  }
})

test('HTTP：请求体超过上限 → 413', async () => {
  const h = await startHttp({ maxBodyBytes: 512 })
  try {
    const huge = { ...INIT, params: { ...INIT.params, pad: 'x'.repeat(2000) } }
    const response = await rpc(h.base, huge)
    assert.equal(response.status, 413)
    assert.equal(response.json?.error?.code, -32002)
  } finally {
    await h.close()
  }
})

test('HTTP：tools/call 走真实 Bridge（结果与 stdio 一致）', async () => {
  const h = await startHttp()
  try {
    const init = await rpc(h.base, INIT)
    const sessionId = init.sessionId!
    await rpc(h.base, { jsonrpc: '2.0', method: 'notifications/initialized' }, { sessionId })

    const call = await rpc(
      h.base,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_bridge_status', arguments: {} } },
      { sessionId },
    )
    const structured = call.json?.result?.structuredContent as Record<string, any>
    assert.ok(structured, '应有 structuredContent：' + call.text.slice(0, 300))
    // 成功（Bridge 在跑）或明确失败（Bridge 没跑），不允许是 NOT_IMPLEMENTED
    if (call.json?.result?.isError === true) {
      // 测试用的 token 与真实 Bridge 的不同，所以 SESSION_INVALID 也是正确结果
      assert.ok(
        ['BRIDGE_UNAVAILABLE', 'GAME_DISCONNECTED', 'SESSION_INVALID'].includes(String(structured.error?.code)),
        '错误码应是真实原因：' + String(structured.error?.code),
      )
    } else {
      assert.equal(structured.ok, true)
      assert.equal(structured.source, 'bridge')
    }
  } finally {
    await h.close()
  }
})

test('HTTP：没有 token 的配置直接拒绝启动', async () => {
  const config = { ...loadConfig({ BWS_TOKEN: '' }), token: '' }
  const logger = createLogger({ sink: () => {} })
  const service = createGameToolService(config, logger)
  const transport = createHttpTransport(service, config, logger, { host: '127.0.0.1', port: 0, token: '' })
  try {
    const port = await transport.listen()
    const response = await rawRequest(`http://127.0.0.1:${port}`, { body: JSON.stringify(INIT) })
    assert.equal(response.status, 401, '空 token 配置下任何请求都必须被拒')
  } finally {
    await transport.close()
  }
})
