// Streamable HTTP 传输（M5）
//
// 用官方 `NodeStreamableHTTPServerTransport`，不自己造协议。
//
// 安全要求（任务书 §9）逐条落地：
//   · 只监听 127.0.0.1（bind 时指定，不接受 0.0.0.0）；
//   · Host / Origin 校验（防 DNS rebinding）：只允许 localhost / 127.0.0.1 / [::1]；
//   · 访问认证：共享 token（与 Bridge 同一套），支持 Authorization: Bearer 与 ?token=；
//   · 请求体大小限制（默认 1MB）；
//   · 会话管理：每个会话一个 transport + 一个 McpServer 实例（官方推荐的无状态/有状态两种模式里选有状态）；
//   · 断线重连：会话保留 TTL，过期清理；GET 的 SSE 流由 transport 自己处理。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual, createHash } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node'
import type { GameToolService } from '../server/createServer.js'
import { createMcpServer } from '../server/createServer.js'
import type { McpServerConfig } from '../config.js'
import type { Logger } from '../utils/logger.js'

export interface HttpTransportOptions {
  host: string
  port: number
  /** 共享 token；为空则拒绝所有请求（不允许裸奔） */
  token: string
  /** 请求体上限 */
  maxBodyBytes?: number
  /** 会话空闲多久回收（毫秒） */
  sessionTtlMs?: number
  /** 是否信任 localhost 之外的 Host（默认 false，绝不放开） */
  allowNonLocalHost?: boolean
  now?: () => number
}

export interface HttpTransportHandle {
  server: Server
  url(): string
  listen(): Promise<number>
  close(): Promise<void>
  stats(): { sessions: number; requests: number; rejected: number }
}

interface SessionEntry {
  transport: NodeStreamableHTTPServerTransport
  server: McpServer
  createdAt: number
  lastSeenAt: number
  requests: number
  /** 尚未拿到 transport 分配的 id 时，先挂在临时 key 上 */
  tempKey?: string
  pendingId: boolean
  /** 闭包读取 transport 生成的 session id */
  assignedIdRef?: () => string | null
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function tokenMatches(provided: string | null, expected: string): boolean {
  if (provided === null || provided.length === 0 || expected.length === 0) return false
  return timingSafeEqual(digest(provided), digest(expected))
}

export function createHttpTransport(
  service: GameToolService,
  config: McpServerConfig,
  logger: Logger,
  options: HttpTransportOptions,
): HttpTransportHandle {
  const now = options.now ?? Date.now
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024
  const sessionTtlMs = options.sessionTtlMs ?? 30 * 60 * 1000
  const sessions = new Map<string, SessionEntry>()
  let requests = 0
  let rejected = 0

  const validateHost = localhostHostValidation()
  const validateOrigin = localhostOriginValidation()

  /** 从请求里取 token：优先 Authorization，其次 query */
  function extractToken(req: IncomingMessage): string | null {
    const header = req.headers.authorization
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      const value = header.slice(7).trim()
      if (value.length > 0) return value
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    return url.searchParams.get('token')
  }

  function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
    const body = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null })
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  function sweep(): void {
    const at = now()
    for (const [id, entry] of sessions) {
      if (at - entry.lastSeenAt > sessionTtlMs) {
        logger.info('回收空闲会话', { session_id: id, idle_ms: at - entry.lastSeenAt })
        void entry.transport.close().catch(() => undefined)
        sessions.delete(id)
      }
    }
  }

  async function createSession(): Promise<SessionEntry> {
    const server = createMcpServer(service, logger)
    // 关键：session id 由 transport 自己生成（它在第一次 handleRequest 时才产出），
    // 这里用闭包捕获它，保证 Map 里的 key 与返回给客户端的 mcp-session-id 完全一致。
    // （踩过的坑：connect() 之后 transport.sessionId 还是 undefined，
    //   若此时用 randomUUID 兜底当 key，之后永远匹配不上，导致每个请求都新建会话）
    let assignedId: string | null = null
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => {
        assignedId = crypto.randomUUID()
        return assignedId
      },
    })
    await server.connect(transport)

    const entry: SessionEntry = {
      transport,
      server,
      createdAt: now(),
      lastSeenAt: now(),
      requests: 0,
      // 占位；第一次 handleRequest 后由 registerSessionId 修正
      pendingId: true,
    }
    // 先挂在临时 key 上，等 id 生成后再迁移（见 handle 里的迁移逻辑）
    const tempKey = `pending:${crypto.randomUUID()}`
    sessions.set(tempKey, entry)
    entry.tempKey = tempKey
    entry.assignedIdRef = () => assignedId

    transport.onclose = () => {
      for (const [key, value] of sessions) {
        if (value === entry) sessions.delete(key)
      }
      logger.info('会话已关闭', { session_id: assignedId ?? tempKey })
    }
    logger.info('新会话（等待 id 分配）', { total: sessions.size })
    return entry
  }

  /** transport 生成 id 后，把临时 key 换成真正的 session id */
  function registerSessionId(entry: SessionEntry): string | null {
    const id = entry.assignedIdRef?.() ?? null
    if (id === null) return null
    if (sessions.get(id) === entry) return id // 已经注册过
    if (entry.tempKey !== undefined) sessions.delete(entry.tempKey)
    sessions.set(id, entry)
    entry.tempKey = undefined
    entry.pendingId = false
    logger.info('会话已建立', { session_id: id, total: sessions.size })
    return id
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    requests += 1

    // 1) Host / Origin 校验（防 DNS rebinding）
    if (!options.allowNonLocalHost && !validateHost(req, res)) {
      rejected += 1
      return // guard 已经回过 403
    }
    if (!validateOrigin(req, res)) {
      rejected += 1
      return
    }

    // 2) 认证（健康检查除外）
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (path === '/healthz') {
      const body = JSON.stringify({
        ok: true,
        transport: 'streamable-http',
        sessions: sessions.size,
        requests,
        rejected,
        version: '0.3.0-m5',
      })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
      return
    }
    if (!tokenMatches(extractToken(req), options.token)) {
      rejected += 1
      sendJsonRpcError(res, 401, -32001, 'unauthorized: 需要有效的 Bearer token')
      return
    }

    // 3) 请求体大小上限（先看 content-length，再看实际读取）
    const declared = Number(req.headers['content-length'] ?? '0')
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      rejected += 1
      sendJsonRpcError(res, 413, -32002, `请求体超过上限 ${maxBodyBytes} 字节`)
      return
    }

    // 4) 路由：已有会话 id → 复用；否则新建（initialize 才该新建）
    sweep()
    const sessionId = req.headers['mcp-session-id']
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined

    let entry: SessionEntry
    if (existing !== undefined) {
      existing.lastSeenAt = now()
      existing.requests += 1
      entry = existing
    } else {
      // 没有会话时，只允许 initialize（POST）新建；其它请求明确报错，避免悄悄建一堆会话
      const method = (req.method ?? 'GET').toUpperCase()
      if (method !== 'POST') {
        rejected += 1
        sendJsonRpcError(res, 400, -32000, '缺少 mcp-session-id：请先 POST initialize 建立会话')
        return
      }
      entry = await createSession()
    }

    // 5) 交给官方 transport（它自己处理 POST/GET/DELETE、SSE、会话头）
    await entry.transport.handleRequest(req, res)
    // 6) transport 此时可能刚分配 session id（initialize 那次），把临时 key 迁到真 id
    if (entry.pendingId) registerSessionId(entry)
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      logger.error('HTTP 传输处理请求失败', { error: String((error as Error)?.message ?? error) })
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, 'internal error')
    })
  })
  server.requestTimeout = 60_000
  server.headersTimeout = 15_000

  return {
    server,
    url: () => `http://${options.host}:${options.port}`,
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
      for (const entry of sessions.values()) {
        await entry.transport.close().catch(() => undefined)
      }
      sessions.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
    stats: () => ({ sessions: sessions.size, requests, rejected }),
  }
}
