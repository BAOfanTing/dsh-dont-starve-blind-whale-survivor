// Phase 5 M2 新增只读工具 get_control_status，工具总数 12 → 13。
// M6 测试：Agent HTTP API（认证 / 参数校验 / 各接口 / SSE 事件）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { Agent } from '../src/runtime/agent.js'
import { createAgentApi } from '../src/api/agentApi.js'
import { loadConfig, type AgentConfig } from '../src/config.js'
import { createLogger } from '../src/utils/logger.js'
import type { LLMChatOptions, LLMMessage, LLMProvider, LLMResponse } from '../src/llm/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')

function realToken(): string {
  try {
    const file = join(REPO_ROOT, '.runtime', 'token.txt')
    if (existsSync(file)) {
      const token = readFileSync(file, 'utf8').trim()
      if (token.length > 0) return token
    }
  } catch {
    // ignore
  }
  return 'm6-api-token-0123456789'
}

const TOKEN = realToken()
const quiet = () => createLogger({ level: 'error', sink: () => {} })

/** 假 Provider：不调工具，直接回答（避免依赖游戏/网络） */
class EchoProvider implements LLMProvider {
  calls = 0
  async chat(messages: LLMMessage[], _options: LLMChatOptions = {}): Promise<LLMResponse> {
    this.calls += 1
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')
    return {
      content: `收到：${String(lastUser?.content ?? '').slice(0, 40)}`,
      reasoningContent: null,
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: null, reasoningTokens: null },
      model: 'echo',
      elapsedMs: 1,
    }
  }
  async getModelInfo() {
    return { provider: 'echo', model: 'echo', baseUrl: 'echo', supportsToolCalls: false, supportsThinking: false, contextLength: null, maxOutputTokens: null }
  }
  async healthCheck() {
    return { state: 'ok' as const, message: 'ok', latencyMs: 1, checkedAt: Date.now() }
  }
}

interface Harness {
  base: string
  agent: Agent
  close: () => Promise<void>
}

async function startApi(): Promise<Harness> {
  const config: AgentConfig = {
    ...loadConfig({ BWS_TOKEN: TOKEN }),
    mcpTransport: 'stdio',
    mcpStdioCommand: process.execPath,
    mcpStdioArgs: [join(REPO_ROOT, 'mcp-server', 'dist', 'src', 'index.js')],
    token: TOKEN,
    llmPreset: 'openai-compatible',
    llmModel: 'echo',
    llmApiKey: 'x',
  }
  const agent = new Agent(config, quiet(), { provider: new EchoProvider() })
  await agent.connect()
  const api = createAgentApi(agent, config, quiet(), { host: '127.0.0.1', port: 0, token: TOKEN })
  const port = await api.listen()
  return {
    base: `http://127.0.0.1:${port}`,
    agent,
    close: async () => {
      await api.close()
      await agent.disconnect()
    },
  }
}

async function get(base: string, path: string, options: { token?: string | null } = {}) {
  const headers: Record<string, string> = {}
  const token = options.token === undefined ? TOKEN : options.token
  if (token !== null) headers.authorization = `Bearer ${token}`
  const response = await fetch(base + path, { headers })
  const text = await response.text()
  let json: Record<string, any> | null = null
  try {
    json = text.length > 0 ? (JSON.parse(text) as Record<string, any>) : null
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

async function post(base: string, path: string, body: unknown, options: { token?: string | null } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const token = options.token === undefined ? TOKEN : options.token
  if (token !== null) headers.authorization = `Bearer ${token}`
  const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  let json: Record<string, any> | null = null
  try {
    json = text.length > 0 ? (JSON.parse(text) as Record<string, any>) : null
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

test('GET /health：免认证，返回服务与就绪状态', async () => {
  const h = await startApi()
  try {
    const result = await get(h.base, '/health', { token: null })
    assert.equal(result.status, 200)
    assert.equal(result.json?.ok, true)
    assert.equal(result.json?.service, 'blind-whale-survivor-agent')
    assert.match(String(result.json?.version), /^0\.4\.0-m\d+$/)
    assert.equal(typeof result.json?.ready, 'boolean')
    assert.equal(result.json?.tools, 14, 'health.tools 是 Agent 适配的只读工具数（14，2 个写工具被跳过）')
  } finally {
    await h.close()
  }
})

test('认证：无 token / 错 token → 401；?token= 也接受', async () => {
  const h = await startApi()
  try {
    assert.equal((await get(h.base, '/api/agent/status', { token: null })).status, 401)
    assert.equal((await get(h.base, '/api/agent/status', { token: 'wrong' })).status, 401)

    const viaQuery = await fetch(`${h.base}/api/agent/status?token=${TOKEN}`)
    assert.equal(viaQuery.status, 200)
  } finally {
    await h.close()
  }
})

test('GET /api/agent/status：返回 MCP/工具/上下文/限制/Provider', async () => {
  const h = await startApi()
  try {
    const result = await get(h.base, '/api/agent/status')
    assert.equal(result.status, 200)
    assert.equal(result.json?.ok, true)
    assert.equal(result.json?.ready, true)
    assert.equal(result.json?.mcp?.state, 'connected')
    assert.equal(result.json?.tools?.adapted, 14)
    assert.equal(result.json?.tools?.names?.length, 14)
    assert.ok(result.json?.limits?.maxRounds > 0)
    assert.equal(result.json?.provider?.model, 'echo')
  } finally {
    await h.close()
  }
})

test('POST /api/agent/chat：正常对话（含上下文写回）', async () => {
  const h = await startApi()
  try {
    const result = await post(h.base, '/api/agent/chat', { session_id: 'api-test', message: '你好' })
    assert.equal(result.status, 200, result.text.slice(0, 200))
    assert.equal(result.json?.ok, true)
    assert.match(String(result.json?.reply), /收到：你好/)
    assert.equal(result.json?.stop_reason, 'final_answer')
    assert.ok(result.json?.job_id)
    assert.equal(result.json?.conversation_id, 'api-test:default')

    // 上下文应被写回
    const history = h.agent.context.history('api-test')
    assert.equal(history.length, 2, '应有 user + assistant 两条')
  } finally {
    await h.close()
  }
})

test('POST /api/agent/chat：写操作意图被前置说明', async () => {
  const h = await startApi()
  try {
    const result = await post(h.base, '/api/agent/chat', { session_id: 'guard-test', message: '帮我把那棵树砍了' })
    assert.equal(result.status, 200)
    assert.ok(result.json?.guard_note, '应有 guard_note')
    assert.match(String(result.json?.guard_note), /只读查询/)
    assert.match(String(result.json?.reply), /只读查询/, 'reply 里也应包含说明')
  } finally {
    await h.close()
  }
})

test('POST /api/agent/chat：参数校验（缺 session_id / 缺 message / 空 message / 超长）', async () => {
  const h = await startApi()
  try {
    const noSession = await post(h.base, '/api/agent/chat', { message: 'hi' })
    assert.equal(noSession.status, 400)
    assert.equal(noSession.json?.error?.code, 'INVALID_ARGUMENT')

    const noMessage = await post(h.base, '/api/agent/chat', { session_id: 's' })
    assert.equal(noMessage.status, 400)

    const emptyMessage = await post(h.base, '/api/agent/chat', { session_id: 's', message: '   ' })
    assert.equal(emptyMessage.status, 400)

    const tooLong = await post(h.base, '/api/agent/chat', { session_id: 's', message: 'x'.repeat(5000) })
    assert.equal(tooLong.status, 400)
    assert.match(String(tooLong.json?.error?.message), /太长/)
  } finally {
    await h.close()
  }
})

test('POST /api/agent/chat：坏 JSON → 400', async () => {
  const h = await startApi()
  try {
    const response = await fetch(`${h.base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: '{not json',
    })
    assert.equal(response.status, 400)
    const body = (await response.json()) as Record<string, any>
    assert.equal(body.error?.code, 'INVALID_JSON')
  } finally {
    await h.close()
  }
})

test('POST /api/agent/chat：with_assessment 返回风险与计划', async () => {
  const h = await startApi()
  try {
    const result = await post(h.base, '/api/agent/chat', { session_id: 'assess-test', message: '给我一份生存报告', with_assessment: true })
    assert.equal(result.status, 200)
    // 游戏没在跑时 risk 可能是 undefined（数据不可用），但只要有数据就必须带 level
    if (result.json?.risk !== undefined) {
      assert.ok(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(String(result.json.risk.level)))
      assert.ok(Array.isArray(result.json.plan?.steps))
      assert.ok(typeof result.json.plan_text === 'string')
    }
  } finally {
    await h.close()
  }
})

test('POST /api/agent/session/reset：清空会话', async () => {
  const h = await startApi()
  try {
    await post(h.base, '/api/agent/chat', { session_id: 'reset-test', message: '你好' })
    assert.equal(h.agent.context.history('reset-test').length, 2)

    const reset = await post(h.base, '/api/agent/session/reset', { session_id: 'reset-test' })
    assert.equal(reset.status, 200)
    assert.equal(reset.json?.ok, true)
    assert.equal(reset.json?.messages, 0)
    assert.equal(h.agent.context.history('reset-test').length, 0)

    const noSession = await post(h.base, '/api/agent/session/reset', {})
    assert.equal(noSession.status, 400)
  } finally {
    await h.close()
  }
})

test('POST /api/agent/cancel：没有进行中的对话时如实说明', async () => {
  const h = await startApi()
  try {
    const result = await post(h.base, '/api/agent/cancel', { session_id: 'nobody' })
    assert.equal(result.status, 200)
    assert.equal(result.json?.ok, true)
    assert.equal(result.json?.cancelled, 0)
    assert.match(String(result.json?.note), /没有正在进行/)
  } finally {
    await h.close()
  }
})

test('GET /api/agent/events：SSE 连接能收到 hello 与后续事件', async () => {
  const h = await startApi()
  try {
    const controller = new AbortController()
    const response = await fetch(`${h.base}/api/agent/events?token=${TOKEN}`, { signal: controller.signal })
    assert.equal(response.status, 200)
    assert.match(String(response.headers.get('content-type')), /text\/event-stream/)

    const reader = response.body?.getReader()
    assert.ok(reader)
    const decoder = new TextDecoder()
    let buffer = ''
    // 读第一段（hello）
    const first = await reader.read()
    buffer += decoder.decode(first.value ?? new Uint8Array(), { stream: true })
    assert.match(buffer, /事件流已连接/)

    // 触发一次 chat，应该能收到事件
    void post(h.base, '/api/agent/chat', { session_id: 'sse-test', message: '你好' })
    let gotEvent = false
    for (let i = 0; i < 20 && !gotEvent; i += 1) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true })
      if (/round_start|llm_response|stop/.test(buffer)) gotEvent = true
    }
    assert.equal(gotEvent, true, 'SSE 应收到 chat 过程事件：' + buffer.slice(0, 300))

    controller.abort()
    await reader.cancel().catch(() => undefined)
  } finally {
    await h.close()
  }
})

test('未知路径 → 404 并列出可用接口', async () => {
  const h = await startApi()
  try {
    const result = await get(h.base, '/api/agent/nope')
    assert.equal(result.status, 404)
    assert.equal(result.json?.error?.code, 'NOT_FOUND')
    assert.ok(Array.isArray(result.json?.error?.endpoints))
    assert.ok((result.json?.error?.endpoints as string[]).includes('POST /api/agent/chat'))
  } finally {
    await h.close()
  }
})

test('请求体超上限 → 413', async () => {
  const config: AgentConfig = {
    ...loadConfig({ BWS_TOKEN: TOKEN }),
    mcpTransport: 'stdio',
    mcpStdioCommand: process.execPath,
    mcpStdioArgs: [join(REPO_ROOT, 'mcp-server', 'dist', 'src', 'index.js')],
    token: TOKEN,
  }
  const agent = new Agent(config, quiet(), { provider: new EchoProvider() })
  await agent.connect()
  const api = createAgentApi(agent, config, quiet(), { host: '127.0.0.1', port: 0, token: TOKEN, maxBodyBytes: 512 })
  const port = await api.listen()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ session_id: 's', message: 'x'.repeat(2000) }),
    })
    assert.equal(response.status, 413)
  } finally {
    await api.close()
    await agent.disconnect()
  }
})
