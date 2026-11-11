// 路由表（M3：heartbeat + telemetry 已实现；commands 留到 M4）
//
// 已实现：
//   GET  /health                 免 token
//   GET  /api/v1/bridge/status   鉴权：连接状态 + 每个会话的明细
//   POST /api/v1/heartbeat       鉴权：心跳（3 秒一次）
//   POST /api/v1/telemetry       鉴权：状态推送（2 秒一次，带 sequence 做幂等）
//   POST /api/v1/probe           鉴权：M2 通信探针用，回显收到的 body 结构
// 占位（M4）：
//   POST /api/v1/commands/poll
//   POST /api/v1/commands/result

import type { BridgeConfig } from './config.js'
import type { BridgeState } from './state.js'
import type { Logger } from './logger.js'
import type { SessionManager } from './session.js'
import { HttpError } from './http.js'
import { parseHeartbeat, parsePoll, parseResultReport, parseTelemetry, PROTOCOL_VERSION } from './validate.js'
import { COMMAND_TYPES, type CommandQueue, type CommandRecord } from './commands.js'

export interface RequestContext {
  requestId: string
  body: unknown
  bodyBytes: number
  query: URLSearchParams
  config: BridgeConfig
  state: BridgeState
  sessions: SessionManager
  commands: CommandQueue
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

export interface RouteDeps {
  sessions: SessionManager
  commands: CommandQueue
}

/** 对外暴露的命令形状（只给游戏端需要的字段，不泄露内部记账） */
function publicCommand(command: CommandRecord) {
  return {
    id: command.id,
    type: command.type,
    params: command.params,
    status: command.status,
    created_at: command.createdAt,
    expires_at: command.expiresAt,
    deliveries: command.deliveries,
  }
}

function notImplemented(what: string): RouteResult {
  return {
    status: 501,
    body: {
      success: false,
      error: { code: 'not_implemented', message: `${what} 还没实现（计划在 M4）` },
    },
  }
}

export function createRoutes(deps: RouteDeps): Route[] {
  return [
    {
      method: 'GET',
      path: '/health',
      auth: false,
      handler: ({ config, state, sessions, receivedAt }) => ({
        status: 200,
        body: {
          success: true,
          version: '0.2.0-m5',
          protocol_version: config.protocolVersion,
          uptime_s: Math.round((receivedAt - config.startedAt) / 1000),
          server_time: receivedAt,
          bound: `${config.host}:${config.port}`,
          bridge: { started: true, connected: sessions.isConnected() || state.snapshot().connected },
        },
      }),
    },
    {
      method: 'GET',
      path: '/api/v1/bridge/status',
      auth: true,
      handler: ({ config, state, sessions, commands: queue, receivedAt }) => {
        const snapshot = state.snapshot()
        const current = sessions.current()
        const list = sessions.list()
        const connected = sessions.isConnected()
        return {
          status: 200,
          body: {
            success: true,
            protocol_version: config.protocolVersion,
            server_time: receivedAt,
            bridge: {
              started: true,
              connected,
              connected_reason: connected
                ? 'ok'
                : list.length === 0
                  ? '还没收到任何心跳（游戏没开？模组没启用？没进世界？）'
                  : '心跳超时（游戏可能暂停/退出了）',
              last_heartbeat_at: current?.lastHeartbeatAt ?? null,
              last_heartbeat_ago_ms: sessions.lastHeartbeatAgoMs(),
              session_id: current?.sessionId ?? null,
              shard: current?.shard ?? null,
              game_version: current?.gameVersion ?? null,
              last_sequence: current?.acknowledgedSequence ?? null,
              queued_commands: queue.pendingCount(),
              active_commands: queue.activeCount(),
              command_stats: queue.stats(),
              last_error: snapshot.lastError,
              requests: snapshot.requests,
              state_file: config.stateFile,
            },
            sessions: list.map((info) => ({
              session_id: info.sessionId,
              shard: info.shard,
              game_version: info.gameVersion,
              alive: sessions.isAlive(info),
              restored: info.restored,
              reconnects: info.reconnects,
              heartbeats: info.heartbeats,
              last_heartbeat_ago_ms: info.lastHeartbeatAt === null ? null : receivedAt - info.lastHeartbeatAt,
              telemetry_count: info.telemetryCount,
              last_sequence: info.lastSequence,
              acknowledged_sequence: info.acknowledgedSequence,
              duplicates: info.duplicates,
              gaps: info.gaps,
              last_payload_bytes: info.lastPayloadBytes,
              last_telemetry_ago_ms: info.lastTelemetryAt === null ? null : receivedAt - info.lastTelemetryAt,
              player_status: info.playerStatus,
            })),
          },
        }
      },
    },
    {
      method: 'POST',
      path: '/api/v1/heartbeat',
      auth: true,
      handler: ({ body, sessions, config, receivedAt }) => {
        const parsed = parseHeartbeat(body)
        sessions.heartbeat(parsed.sessionId, {
          playerStatus: parsed.playerStatus,
          gameVersion: parsed.gameVersion,
          shard: parsed.shard,
        })
        return {
          status: 200,
          body: {
            success: true,
            protocol_version: config.protocolVersion,
            server_time: receivedAt,
            server_status: {
              state: 'running',
              connected: sessions.isConnected(),
              sessions: sessions.list().length,
              uptime_s: Math.round((receivedAt - config.startedAt) / 1000),
            },
          },
        }
      },
    },
    {
      method: 'POST',
      path: '/api/v1/telemetry',
      auth: true,
      handler: ({ body, bodyBytes, sessions, config, receivedAt }) => {
        const parsed = parseTelemetry(body, bodyBytes)
        const result = sessions.telemetry(parsed.sessionId, parsed.sequence, parsed.data, parsed.payloadBytes)
        return {
          status: 200,
          body: {
            success: true,
            protocol_version: config.protocolVersion,
            server_time: receivedAt,
            acknowledged_sequence: result.acknowledgedSequence,
            duplicate: result.duplicate,
            gap: result.gap,
          },
        }
      },
    },
    {
      // M2 保留：只回显“收到了什么”，不执行任何游戏逻辑，也不回显 token
      method: 'POST',
      path: '/api/v1/probe',
      auth: true,
      handler: ({ body, config, receivedAt }) => {
        const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
        const keys = Object.keys(record).filter((key) => key !== 'token')
        return {
          status: 200,
          body: {
            success: true,
            protocol_version: config.protocolVersion,
            server_time: receivedAt,
            received: {
              is_object: body !== null && typeof body === 'object',
              token_present: typeof record.token === 'string',
              keys,
              echo: record.echo ?? null,
              pad_bytes: typeof record.pad === 'string' ? record.pad.length : 0,
            },
          },
        }
      },
    },
    {
      method: 'POST',
      path: '/api/v1/commands/poll',
      auth: true,
      handler: ({ body, sessions, commands: queue, config, receivedAt }) => {
        const parsed = parsePoll(body)
        const info = sessions.list().find((item) => item.sessionId === parsed.sessionId)
        const shard = parsed.shard ?? info?.shard ?? null

        // 会话已经死了（游戏重启/退出）→ 它手上未回执的命令状态未知，判 FAILED 且不重放
        for (const item of sessions.list()) {
          if (!sessions.isAlive(item)) queue.reapSession(item.sessionId)
        }

        const { command, pending } = queue.poll(parsed.sessionId, shard)
        return {
          status: 200,
          body: {
            success: true,
            protocol_version: config.protocolVersion,
            server_time: receivedAt,
            command: command === null ? null : publicCommand(command),
            pending_count: pending,
            last_acknowledged_id: parsed.lastAcknowledgedId,
          },
        }
      },
    },
    {
      method: 'POST',
      path: '/api/v1/commands/result',
      auth: true,
      handler: ({ body, sessions, commands: queue, config, receivedAt }) => {
        const parsed = parseResultReport(body)
        if (!sessions.list().some((item) => item.sessionId === parsed.sessionId)) {
          throw new HttpError(400, 'bad_request', '这个 session_id 还没发过心跳')
        }
        const settled = queue.settle(parsed.sessionId, {
          commandId: parsed.commandId,
          status: parsed.status,
          result: parsed.result,
          error: parsed.error,
          executionTime: parsed.executionTime,
        })
        if (!settled.ok || !settled.command) {
          const notFound = settled.reason === 'unknown_command'
          throw new HttpError(notFound ? 404 : 400, notFound ? 'not_found' : 'bad_request', `回执未被接受：${settled.reason ?? 'unknown'}`)
        }
        return {
          status: 200,
          body: {
            success: true,
            protocol_version: config.protocolVersion,
            server_time: receivedAt,
            command_id: settled.command.id,
            status: settled.command.status,
            duplicate: settled.duplicate,
            late: settled.command.late,
          },
        }
      },
    },
    {
      // 运维/联调用：人工下发一条测试命令（不属于游戏端协议）
      method: 'POST',
      path: '/api/v1/commands/enqueue',
      auth: true,
      handler: ({ body, commands: queue, config, receivedAt }) => {
        const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : null
        if (!record) throw new HttpError(400, 'bad_request', 'enqueue 请求体必须是 JSON 对象')
        const type = record.type
        if (typeof type !== 'string' || !(COMMAND_TYPES as readonly string[]).includes(type)) {
          throw new HttpError(400, 'bad_request', `type 必须是 ${COMMAND_TYPES.join('/')} 之一（本阶段不实现任何真实游戏动作）`)
        }
        const params = record.params === undefined ? {} : record.params
        if (params !== null && (typeof params !== 'object' || Array.isArray(params))) {
          throw new HttpError(400, 'bad_request', 'params 必须是对象')
        }
        const shard = typeof record.shard === 'string' ? record.shard : null
        let command: CommandRecord
        try {
          command = queue.enqueue(type, (params ?? {}) as Record<string, unknown>, { shard })
        } catch (error) {
          throw new HttpError(error instanceof Error && error.message.startsWith('queue_full') ? 429 : 400, 'bad_request', String((error as Error).message))
        }
        return {
          status: 200,
          body: {
            success: true,
            protocol_version: config.protocolVersion,
            server_time: receivedAt,
            command: publicCommand(command),
            pending_count: queue.pendingCount(),
          },
        }
      },
    },
    {
      // 运维/联调用：看命令队列现状
      method: 'GET',
      path: '/api/v1/commands',
      auth: true,
      handler: ({ commands: queue, config, receivedAt }) => ({
        status: 200,
        body: {
          success: true,
          protocol_version: config.protocolVersion,
          server_time: receivedAt,
          stats: queue.stats(),
          commands: queue.list(20).map((command: CommandRecord) => ({
            ...publicCommand(command),
            session_id: command.sessionId,
            result: command.result,
            error: command.error,
            execution_time: command.executionTime,
            late: command.late,
            note: command.note,
          })),
        },
      }),
    },
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

export { PROTOCOL_VERSION }
