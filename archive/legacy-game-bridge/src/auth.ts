// Token 校验
//
// 三个来源都接受（因为游戏端 QueryServer 不一定能带请求头）：
//   1) JSON 请求体里的 token 字段（POST 主用）
//   2) 查询串 ?token=...
//   3) Authorization: Bearer <token>（curl / 调试用）
//
// 比较用「sha256 后再 timingSafeEqual」，避免长度差泄时间信息。

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { HttpError } from './http.js'

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export function tokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false
  return timingSafeEqual(digest(provided), digest(expected))
}

export interface TokenSources {
  body?: unknown
  query: URLSearchParams
  headers: IncomingMessage['headers']
}

export function extractToken(sources: TokenSources): string | null {
  const fromBody = sources.body
  if (typeof fromBody === 'object' && fromBody !== null && 'token' in fromBody) {
    const value = (fromBody as Record<string, unknown>).token
    if (typeof value === 'string' && value.length > 0) return value
  }
  const fromQuery = sources.query.get('token')
  if (fromQuery) return fromQuery
  const header = sources.headers.authorization
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    const value = header.slice(7).trim()
    if (value.length > 0) return value
  }
  return null
}

/** 校验失败统一抛 401（不带“token 对不对”的细节，避免被探测） */
export function requireToken(sources: TokenSources, expected: string): void {
  const provided = extractToken(sources)
  if (!tokenMatches(provided, expected)) {
    throw new HttpError(401, 'unauthorized', '缺少或错误的 token')
  }
}
