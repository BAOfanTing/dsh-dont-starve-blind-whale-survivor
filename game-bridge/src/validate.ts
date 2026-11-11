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
