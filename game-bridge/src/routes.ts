// 路由表（M1）
//
// 已完成：GET /health、GET /api/v1/bridge/status
// 占位（返回 501，等 M3/M4 实现）：/api/v1/telemetry、/api/v1/heartbeat、
//                                    /api/v1/commands/poll、/api/v1/commands/result
// 占位路由**仍会先做 body 解析 + token 校验**，这样 M1 就能端到端验证
// “原始文本 JSON（无 content-type）+ token 在 body 里”这条链路。

import type { BridgeConfig } from './config.js'
import type { BridgeState } from './state.js'
import type { Logger } from './logger.js'
import { HttpError } from './http.js'

export interface RequestContext {
  requestId: string
  body: unknown
  query: URLSearchParams
  config: BridgeConfig
  state: BridgeState
  logger: Logger
  receivedAt: number
}

export interface RouteResult {
  status: number
  body: unknown
}

export interface Route {
  method: 'GET' | 'POST'
  path: string
  auth: boolean
  handler: (ctx: RequestContext) => RouteResult
}

function notImplemented(what: string): RouteResult {
  return {
    status: 501,
    body: {
      success: false,
      error: { code: 'not_implemented', message: `${what} 还没实现（计划在 M3/M4）` },
    },
  }
}

export function createRoutes(): Route[] {
  return [
    {
      method: 'GET',
      path: '/health',
      auth: false,
      handler: ({ config, state, receivedAt }) => ({
        status: 200,
        body: {
          success: true,
          version: '0.2.0-m1',
          protocol_version: config.protocolVersion,
          uptime_s: Math.round((receivedAt - config.startedAt) / 1000),
          server_time: receivedAt,
          bound: `${config.host}:${config.port}`,
          bridge: { started: state.snapshot().started, connected: state.snapshot().connected },
        },
      }),
    },
    {
      method: 'GET',
      path: '/api/v1/bridge/status',
      auth: true,
      handler: ({ config, state, receivedAt }) => {
        const snapshot = state.snapshot()
        return {
          status: 200,
          body: {
            success: true,
            protocol_version: config.protocolVersion,
            server_time: receivedAt,
            bridge: {
              started: snapshot.started,
              connected: snapshot.connected,
              connected_reason: snapshot.connectedReason,
              last_heartbeat_at: snapshot.lastHeartbeatAt,
              last_heartbeat_ago_ms: snapshot.lastHeartbeatAgoMs,
              session_id: snapshot.sessionId,
              last_sequence: snapshot.lastSequence,
              queued_commands: snapshot.queuedCommands,
              last_error: snapshot.lastError,
              requests: snapshot.requests,
            },
          },
        }
      },
    },
    { method: 'POST', path: '/api/v1/telemetry', auth: true, handler: () => notImplemented('状态推送 /api/v1/telemetry') },
    { method: 'POST', path: '/api/v1/heartbeat', auth: true, handler: () => notImplemented('心跳 /api/v1/heartbeat') },
    { method: 'POST', path: '/api/v1/commands/poll', auth: true, handler: () => notImplemented('命令轮询 /api/v1/commands/poll') },
    { method: 'POST', path: '/api/v1/commands/result', auth: true, handler: () => notImplemented('命令回执 /api/v1/commands/result') },
  ]
}

export function findRoute(routes: Route[], method: string, pathname: string): { route?: Route; pathExists: boolean } {
  const pathExists = routes.some((route) => route.path === pathname)
  const route = routes.find((candidate) => candidate.path === pathname && candidate.method === method)
  return { route, pathExists }
}

export function methodNotAllowed(routes: Route[], pathname: string): HttpError {
  const allow = routes.filter((route) => route.path === pathname).map((route) => route.method)
  return new HttpError(405, 'method_not_allowed', `这个路径只接受 ${allow.join('/')}`)
}
