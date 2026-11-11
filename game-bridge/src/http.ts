// HTTP 小工具：请求体读取（有上限）、原始文本 JSON 解析、统一 JSON 响应
//
// 关键点（任务书要求）：
//   · QueryServer 不能自由设置请求头 → **不依赖 content-type**，直接按原始文本 JSON.parse；
//   · 请求体有大小上限，超了立刻 413 并断开；
//   · 所有响应统一 { success, ... } 形状，错误统一 { success:false, error:{code,message} }。

import type { IncomingMessage, ServerResponse } from 'node:http'

export type ErrorCode =
  | 'unauthorized'
  | 'invalid_json'
  | 'payload_too_large'
  | 'bad_request'
  | 'not_found'
  | 'method_not_allowed'
  | 'not_implemented'
  | 'internal_error'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** 读请求体（UTF-8 文本），超过 limit 直接抛 413 */
export function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const fail = (error: HttpError) => {
      if (settled) return
      settled = true
      reject(error)
    }

    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        // 直接把多余的字节读掉再回 413：如果这里 destroy，客户端只会看到 ECONNRESET，
        // 反而拿不到「请求体太大」这个明确错误。
        req.resume()
        fail(new HttpError(413, 'payload_too_large', `请求体超过上限 ${limit} 字节`))
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
      fail(new HttpError(400, 'bad_request', `读取请求体失败：${String(error.message)}`))
    })
  })
}

/** 把原始文本当 JSON 解析（不看 content-type） */
export function parseJsonText(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) throw new HttpError(400, 'invalid_json', '请求体是空的，需要 JSON 文本')
  try {
    return JSON.parse(trimmed)
  } catch (error) {
    throw new HttpError(400, 'invalid_json', `请求体不是合法 JSON：${String((error as Error).message)}`)
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(text)
}

/** request_id：优先用调用方给的（便于端到端排查），否则本地生成 */
export function requestIdOf(headerValue: string | string[] | undefined): string {
  const given = Array.isArray(headerValue) ? headerValue[0] : headerValue
  if (given && /^[A-Za-z0-9._:-]{1,64}$/.test(given)) return given
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
