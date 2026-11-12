// Agent HTTP API（M6）
//
// 接口（任务书 §14）：
//   GET  /health                     健康检查（免认证）
//   GET  /api/agent/status           Agent 状态（MCP/工具/上下文/限制/Provider）
//   POST /api/agent/chat             一次对话
//   POST /api/agent/cancel           取消正在进行的对话
//   POST /api/agent/session/reset    重置会话
//   GET  /api/agent/events           SSE 事件流（预留，供 DSH UI 显示工具调用过程）
//
// 安全：
//   · 只绑 127.0.0.1（bind 时指定）；
//   · 共享 token（Bearer 或 ?token=）；
//   · 请求体大小上限；
//   · 参数校验（session_id 必填、消息长度上限）；
//   · **不做公网暴露**，也没有 CORS 放开。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto'
import type { Agent, AgentChatResult, AgentStatus } from '../runtime/agent.js'
import type { AgentEvent } from '../runtime/agentLoop.js'
import type { AgentConfig } from '../config.js'
import type { Logger } from '../utils/logger.js'

export interface AgentApiOptions {
  host: string
  port: number
  /** 共享 token；为空则拒绝所有（不允许裸奔） */
  token: string
  /** 请求体上限 */
  maxBodyBytes?: number
  /** 单次对话超时（服务端兜底） */
  chatTimeoutMs?: number
  /** 消息最大长度 */
  maxMessageChars?: number
}

export interface AgentApiHandle {
  server: Server
  listen(): Promise<number>
  close(): Promise<void>
  stats(): { requests: number; rejected: number; chats: number; activeChats: number; events: number }
}

interface ChatJob {
  id: string
  sessionId: string
  controller: AbortController
  startedAt: number
  done: boolean
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function tokenMatches(provided: string | null, expected: string): boolean {
  if (provided === null || provided.length === 0 || expected.length === 0) return false
  return timingSafeEqual(digest(provided), digest(expected))
}

export function createAgentApi(agent: Agent, config: AgentConfig, logger: Logger, options: AgentApiOptions): AgentApiHandle {
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024
  const chatTimeoutMs = options.chatTimeoutMs ?? 90000
  const maxMessageChars = options.maxMessageChars ?? 4000
  const jobs = new Map<string, ChatJob>()
  const eventClients = new Set<ServerResponse>()
  const counters = { requests: 0, rejected: 0, chats: 0, events: 0 }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      req.on('data', (chunk: Buffer) => {
        if (settled) return
        size += chunk.length
        if (size > maxBodyBytes) {
          settled = true
          req.resume()
          reject(new Error(`请求体超过上限 ${maxBodyBytes} 字节`))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
      req.on('error', (error) => {
        if (settled) return
        settled = true
        reject(error)
      })
    })
  }

  function extractToken(req: IncomingMessage, query: URLSearchParams): string | null {
    const header = req.headers.authorization
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      const value = header.slice(7).trim()
      if (value.length > 0) return value
    }
    return query.get('token')
  }

  /** 把事件广播给所有 SSE 客户端 */
  function broadcast(event: AgentEvent & { sessionId?: string; conversationId?: string }): void {
    counters.events += 1
    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const client of eventClients) {
      try {
        client.write(payload)
      } catch {
        eventClients.delete(client)
      }
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    counters.requests += 1
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const method = (req.method ?? 'GET').toUpperCase()

    // 健康检查：免认证，只给最小信息
    if (path === '/health' && method === 'GET') {
      const status = agent.status()
      sendJson(res, 200, {
        ok: true,
        service: 'blind-whale-survivor-agent',
        version: '0.4.0-m6',
        ready: status.ready,
        mcp_state: status.mcp.state,
        tools: status.tools.adapted,
        provider: status.provider.model,
        has_api_key: status.provider.hasApiKey,
        uptime_s: Math.round(process.uptime()),
        stats: { ...counters, activeChats: [...jobs.values()].filter((job) => !job.done).length },
      })
      return
    }

    // 认证
    if (!tokenMatches(extractToken(req, url.searchParams), options.token)) {
      counters.rejected += 1
      sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '需要有效的 Bearer token' } })
      return
    }

    // GET /api/agent/status
    if (path === '/api/agent/status' && method === 'GET') {
      const status: AgentStatus = agent.status()
      sendJson(res, 200, {
        ok: true,
        ...status,
        stats: { ...counters, activeChats: [...jobs.values()].filter((job) => !job.done).length },
      })
      return
    }

    // GET /api/agent/events（SSE）
    if (path === '/api/agent/events' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify({ type: 'hello', message: '事件流已连接' })}\n\n`)
      eventClients.add(res)
      req.on('close', () => {
        eventClients.delete(res)
      })
      return
    }

    // POST /api/agent/chat
    if (path === '/api/agent/chat' && method === 'POST') {
      let text: string
      try {
        text = await readBody(req)
      } catch (error) {
        counters.rejected += 1
        sendJson(res, 413, { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: String((error as Error).message) } })
        return
      }
      let body: Record<string, unknown>
      try {
        const parsed = JSON.parse(text.length > 0 ? text : '{}') as unknown
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('请求体必须是 JSON 对象')
        }
        body = parsed as Record<string, unknown>
      } catch (error) {
        counters.rejected += 1
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: String((error as Error).message) } })
        return
      }

      const sessionId = body.session_id
      if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
        counters.rejected += 1
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session_id 必填（字符串，≤128）' } })
        return
      }
      const message = body.message
      if (typeof message !== 'string' || message.trim().length === 0) {
        counters.rejected += 1
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'message 必填（非空字符串）' } })
        return
      }
      if (message.length > maxMessageChars) {
        counters.rejected += 1
        sendJson(res, 400, {
          ok: false,
          error: { code: 'INVALID_ARGUMENT', message: `message 太长（>${maxMessageChars} 字符）` },
        })
        return
      }
      const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : undefined
      const withAssessment = body.with_assessment === true
      const stream = body.stream === true

      const job: ChatJob = {
        id: randomUUID(),
        sessionId,
        controller: new AbortController(),
        startedAt: Date.now(),
        done: false,
      }
      jobs.set(job.id, job)
      counters.chats += 1

      const timer = setTimeout(() => job.controller.abort(), chatTimeoutMs)
      try {
        const result: AgentChatResult = await agent.chat(message, {
          sessionId,
          ...(conversationId === undefined ? {} : { conversationId }),
          withAssessment,
          signal: job.controller.signal,
          onEvent: (event) => {
            broadcast({ ...event, sessionId, ...(conversationId === undefined ? {} : { conversationId }) })
          },
        })
        job.done = true
        sendJson(res, 200, {
          ok: true,
          job_id: job.id,
          reply: result.reply,
          stop_reason: result.stopReason,
          stop_detail: result.stopDetail,
          rounds: result.rounds,
          tool_calls: result.toolCalls,
          usage: result.usage,
          elapsed_ms: result.elapsedMs,
          conversation_id: result.conversationId,
          guard_note: result.guardNote,
          ...(result.risk === undefined ? {} : { risk: result.risk }),
          ...(result.plan === undefined ? {} : { plan: result.plan }),
          ...(result.planText === undefined ? {} : { plan_text: result.planText }),
          ...(stream ? {} : {}),
        })
      } catch (error) {
        job.done = true
        const message_ = String((error as Error)?.message ?? error)
        logger.error('Agent chat 失败', { sessionId, error: message_.slice(0, 200) })
        sendJson(res, 500, { ok: false, error: { code: 'CHAT_FAILED', message: message_ } })
      } finally {
        clearTimeout(timer)
        // 保留一小段时间供 /cancel 查询，之后清理
        setTimeout(() => jobs.delete(job.id), 60000).unref()
      }
      return
    }

    // POST /api/agent/cancel
    if (path === '/api/agent/cancel' && method === 'POST') {
      let text: string
      try {
        text = await readBody(req)
      } catch {
        text = ''
      }
      let body: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(text.length > 0 ? text : '{}') as unknown
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
      } catch {
        // 忽略：允许空 body
      }
      const jobId = typeof body.job_id === 'string' ? body.job_id : undefined
      const sessionId = typeof body.session_id === 'string' ? body.session_id : undefined

      const cancelled: string[] = []
      for (const job of jobs.values()) {
        if (job.done) continue
        if (jobId !== undefined && job.id !== jobId) continue
        if (jobId === undefined && sessionId !== undefined && job.sessionId !== sessionId) continue
        job.controller.abort()
        cancelled.push(job.id)
      }
      sendJson(res, 200, {
        ok: true,
        cancelled: cancelled.length,
        job_ids: cancelled,
        note: cancelled.length === 0 ? '没有正在进行的对话' : '已请求取消',
      })
      return
    }

    // POST /api/agent/session/reset
    if (path === '/api/agent/session/reset' && method === 'POST') {
      let text: string
      try {
        text = await readBody(req)
      } catch {
        text = ''
      }
      let body: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(text.length > 0 ? text : '{}') as unknown
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
      } catch {
        // 忽略
      }
      const sessionId = body.session_id
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        counters.rejected += 1
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session_id 必填' } })
        return
      }
      const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : undefined
      const conversation = agent.reset(sessionId, conversationId)
      sendJson(res, 200, {
        ok: true,
        conversation_id: conversation.conversationId,
        messages: conversation.messages.length,
        turns: conversation.turns,
      })
      return
    }

    sendJson(res, 404, {
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: `没有这个接口：${method} ${path}`,
        endpoints: [
          'GET /health',
          'GET /api/agent/status',
          'GET /api/agent/events',
          'POST /api/agent/chat',
          'POST /api/agent/cancel',
          'POST /api/agent/session/reset',
        ],
      },
    })
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      logger.error('Agent API 处理请求失败', { error: String((error as Error)?.message ?? error) })
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'internal error' } })
      }
    })
  })
  server.requestTimeout = 120000
  server.headersTimeout = 20000

  return {
    server,
    listen: () =>
      new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          const address = server.address()
          resolve(typeof address === 'object' && address ? address.port : options.port)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(options.port, options.host)
      }),
    close: async () => {
      for (const client of eventClients) {
        try {
          client.end()
        } catch {
          // ignore
        }
      }
      eventClients.clear()
      for (const job of jobs.values()) job.controller.abort()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
    stats: () => ({
      requests: counters.requests,
      rejected: counters.rejected,
      chats: counters.chats,
      activeChats: [...jobs.values()].filter((job) => !job.done).length,
      events: counters.events,
    }),
  }
}
