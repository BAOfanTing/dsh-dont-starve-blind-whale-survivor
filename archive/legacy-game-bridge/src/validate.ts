// 请求体校验 + 解析（M3）
//
// 规矩：接口一律先校验再处理；错误码稳定、可读，方便游戏端日志直接定位。
// 注意：QueryServer 不带 content-type，所以这里只认"已经 JSON.parse 过的对象"，不看头部。

import { HttpError } from './http.js'

export const PROTOCOL_VERSION = '1.0'

const MAX_SESSION_ID = 128
const MAX_STRING = 256

export function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export function badRequest(message: string, code: 'bad_request' | 'invalid_json' = 'bad_request'): HttpError {
  return new HttpError(400, code, message)
}

export function requireSessionId(body: Record<string, unknown>): string {
  const value = body.session_id
  if (typeof value !== 'string' || value.length === 0) throw badRequest('缺少 session_id（字符串）')
  if (value.length > MAX_SESSION_ID) throw badRequest(`session_id 太长（>${MAX_SESSION_ID}）`)
  return value
}

export function requireSequence(body: Record<string, unknown>): number {
  const value = body.sequence
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw badRequest('sequence 必须是 ≥1 的整数')
  }
  return value
}

export function requireTimestamp(body: Record<string, unknown>): number {
  const value = body.timestamp
  if (typeof value !== 'number' || !Number.isFinite(value)) throw badRequest('timestamp 必须是数字')
  return value
}

export function checkProtocol(body: Record<string, unknown>): void {
  const value = body.protocol_version
  if (value === undefined) return // 老客户端不带也行
  if (typeof value !== 'string') throw badRequest('protocol_version 必须是字符串')
  if (value !== PROTOCOL_VERSION) {
    throw new HttpError(400, 'bad_request', `协议版本不支持：${value}（本机是 ${PROTOCOL_VERSION}）`)
  }
}

export function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw badRequest(`${field} 必须是字符串`)
  if (value.length > MAX_STRING) throw badRequest(`${field} 太长（>${MAX_STRING}）`)
  return value
}

// ───────────────────────── M4：命令轮询 / 回执 ─────────────────────────

const COMMAND_STATUS_SET = new Set(['QUEUED', 'DELIVERED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED'])

export interface ParsedPoll {
  sessionId: string
  lastAcknowledgedId: string | null
  shard: string | null
}

export function parsePoll(raw: unknown): ParsedPoll {
  const body = asObject(raw)
  if (!body) throw badRequest('poll 请求体必须是 JSON 对象')
  checkProtocol(body)
  const sessionId = requireSessionId(body)
  const lastAck = body.last_acknowledged_id
  if (lastAck !== undefined && lastAck !== null && typeof lastAck !== 'string') {
    throw badRequest('last_acknowledged_id 必须是字符串或 null')
  }
  return {
    sessionId,
    lastAcknowledgedId: typeof lastAck === 'string' ? lastAck : null,
    shard: optionalString(body.shard, 'shard'),
  }
}

export interface ParsedResultReport {
  sessionId: string
  commandId: string
  status: 'SUCCEEDED' | 'FAILED' | 'EXECUTING'
  result: unknown
  error: string | null
  executionTime: number | null
}

export function parseResultReport(raw: unknown): ParsedResultReport {
  const body = asObject(raw)
  if (!body) throw badRequest('result 请求体必须是 JSON 对象')
  checkProtocol(body)
  const sessionId = requireSessionId(body)

  const commandId = body.command_id
  if (typeof commandId !== 'string' || commandId.length === 0) throw badRequest('缺少 command_id')
  if (commandId.length > 128) throw badRequest('command_id 太长')

  const status = body.status
  if (typeof status !== 'string' || !COMMAND_STATUS_SET.has(status)) {
    throw badRequest('status 必须是 QUEUED/DELIVERED/EXECUTING/SUCCEEDED/FAILED/EXPIRED/CANCELLED 之一')
  }
  if (status !== 'SUCCEEDED' && status !== 'FAILED' && status !== 'EXECUTING') {
    throw badRequest('游戏端只能上报 EXECUTING / SUCCEEDED / FAILED')
  }

  const err = body.error
  if (err !== undefined && err !== null && typeof err !== 'string') throw badRequest('error 必须是字符串或 null')

  const execution = body.execution_time
  if (execution !== undefined && execution !== null && (typeof execution !== 'number' || !Number.isFinite(execution))) {
    throw badRequest('execution_time 必须是数字（秒）或 null')
  }

  return {
    sessionId,
    commandId,
    status,
    result: body.result ?? null,
    error: typeof err === 'string' ? err : null,
    executionTime: typeof execution === 'number' ? execution : null,
  }
}

export interface ParsedHeartbeat {
  sessionId: string
  timestamp: number
  playerStatus: unknown
  gameVersion: string | null
  shard: string | null
}

export function parseHeartbeat(raw: unknown): ParsedHeartbeat {
  const body = asObject(raw)
  if (!body) throw badRequest('heartbeat 请求体必须是 JSON 对象')
  checkProtocol(body)
  const sessionId = requireSessionId(body)
  const timestamp = requireTimestamp(body)
  const gameVersion = optionalString(body.game_version, 'game_version')
  const shard = optionalString(body.shard, 'shard')
  const playerStatus = body.player_status === undefined ? null : body.player_status
  if (playerStatus !== null && asObject(playerStatus) === null) throw badRequest('player_status 必须是对象')
  return { sessionId, timestamp, playerStatus, gameVersion, shard }
}

export interface ParsedTelemetry {
  sessionId: string
  sequence: number
  timestamp: number
  data: Record<string, unknown>
  payloadBytes: number
}

export function parseTelemetry(raw: unknown, rawTextBytes: number): ParsedTelemetry {
  const body = asObject(raw)
  if (!body) throw badRequest('telemetry 请求体必须是 JSON 对象')
  checkProtocol(body)
  const sessionId = requireSessionId(body)
  const sequence = requireSequence(body)
  const timestamp = requireTimestamp(body)
  const data = asObject(body.data)
  if (!data) throw badRequest('data 必须是对象（状态快照）')
  return { sessionId, sequence, timestamp, data, payloadBytes: rawTextBytes }
}
