// HTTP 服务：路由分发 + body 解析 + token 校验 + 统一错误处理 + 访问日志
//
// 只监听 127.0.0.1（config.host 默认值），不提供 CORS，不做任何“代理外部请求”的事。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { requireToken } from './auth.js'
import type { BridgeConfig } from './config.js'
import { HttpError, parseJsonText, readBody, requestIdOf, sendJson } from './http.js'
import type { Logger } from './logger.js'
import { createRoutes, findRoute, methodNotAllowed, type RequestContext, type Route } from './routes.js'
import type { SessionManager } from './session.js'
import { BridgeState } from './state.js'

export interface ServerDeps {
  config: BridgeConfig
  logger: Logger
  state: BridgeState
  sessions: SessionManager
  routes?: Route[]
  now?: () => number
}

export interface BridgeServerHandle {
  server: Server
  listen(port?: number): Promise<number>
  close(): Promise<void>
}

export function createBridgeServer(deps: ServerDeps): BridgeServerHandle {
  const now = deps.now ?? Date.now
  const routes = deps.routes ?? createRoutes({ sessions: deps.sessions })

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res)
  })
  // 不要让一个慢客户端把连接挂死
  server.requestTimeout = deps.config.requestTimeoutMs
  server.headersTimeout = Math.min(deps.config.requestTimeoutMs, 10000)
  server.keepAliveTimeout = 5000

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = now()
    const requestId = requestIdOf(req.headers['x-request-id'])
    const url = new URL(req.url ?? '/', `http://${deps.config.host}:${deps.config.port}`)
    const method = (req.method ?? 'GET').toUpperCase()
    deps.state.countRequest()

    let logged = false
    const finish = (status: number, code?: string) => {
      if (logged) return
      logged = true
      const duration = now() - startedAt
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
      deps.logger[level](`${method} ${url.pathname} → ${status}${code ? ' ' + code : ''}`, {
        request_id: requestId,
        duration_ms: duration,
      })
    }

    try {
      const { route, pathExists } = findRoute(routes, method, url.pathname)
      if (!route) {
        if (pathExists) throw methodNotAllowed(routes, url.pathname)
        throw new HttpError(404, 'not_found', `没有这个接口：${url.pathname}`)
      }

      // POST 一律按原始文本解析 JSON（QueryServer 可能不带 content-type）
      let body: unknown = undefined
      let bodyBytes = 0
      if (method === 'POST') {
        const text = await readBody(req, deps.config.maxBodyBytes)
        bodyBytes = Buffer.byteLength(text)
        body = parseJsonText(text)
      }

      if (route.auth) {
        requireToken({ body, query: url.searchParams, headers: req.headers }, deps.config.token)
      }

      const ctx: RequestContext = {
        requestId,
        body,
        bodyBytes,
        query: url.searchParams,
        config: deps.config,
        state: deps.state,
        sessions: deps.sessions,
        logger: deps.logger,
        receivedAt: startedAt,
      }
      const result = route.handler(ctx)
      sendJson(res, result.status, { ...(result.body as Record<string, unknown>), request_id: requestId })
      finish(result.status)
    } catch (error) {
      const httpError =
        error instanceof HttpError
          ? error
          : new HttpError(500, 'internal_error', `服务器内部错误：${String((error as Error)?.message ?? error)}`)

      if (httpError.status === 401) deps.state.countUnauthorized()
      if (httpError.status === 400 || httpError.status === 413) deps.state.countBadRequest()
      if (httpError.status >= 500) deps.state.countServerError()

      if (httpError.status >= 500) {
        deps.logger.error(`处理 ${method} ${url.pathname} 出错：${httpError.message}`, { request_id: requestId })
        deps.state.recordError({ at: now(), code: httpError.code, message: httpError.message, requestId })
      }

      const pending = (error as { pendingBody?: string }).pendingBody
      void pending
      if (!res.headersSent) {
        // 413 说明请求体还有没读完的字节：回完就关掉这条连接，别让它继续往上灌
        const extra: Record<string, string> = httpError.status === 413 ? { connection: 'close' } : {}
        sendJson(
          res,
          httpError.status,
          {
            success: false,
            error: { code: httpError.code, message: httpError.message },
            request_id: requestId,
          },
          extra,
        )
      }
      finish(httpError.status, httpError.code)
    }
  }

  return {
    server,
    listen(port?: number) {
      const target = port ?? deps.config.port
      return new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          const address = server.address()
          resolve(typeof address === 'object' && address ? address.port : target)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(target, deps.config.host)
      })
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
