// 统一错误码（MCP 工具层）
//
// 任务书要求区分这 8 类；所有工具的错误都必须是其中之一，
// 这样 AI 客户端能自己决定"等一会儿再试"还是"参数写错了"。

export const TOOL_ERROR_CODES = [
  'GAME_DISCONNECTED',
  'SESSION_INVALID',
  'STATE_STALE',
  'BRIDGE_UNAVAILABLE',
  'INVALID_ARGUMENT',
  'TOOL_TIMEOUT',
  'NOT_IMPLEMENTED',
  'INTERNAL_ERROR',
] as const

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number]

export interface ToolErrorPayload {
  code: ToolErrorCode
  message: string
  /** 给 AI 的下一步建议（可选，但很有用） */
  hint?: string
  /** 附带的原始信息（比如 Bridge 的 HTTP 状态） */
  detail?: unknown
}

export class ToolError extends Error {
  readonly payload: ToolErrorPayload

  constructor(code: ToolErrorCode, message: string, options: { hint?: string; detail?: unknown } = {}) {
    super(message)
    this.name = 'ToolError'
    this.payload = { code, message, hint: options.hint, detail: options.detail }
  }
}

export function notImplemented(what: string, milestone: string): ToolError {
  return new ToolError('NOT_IMPLEMENTED', `${what} 还没实现（计划在 ${milestone}）`, {
    hint: '本阶段只开放只读查询，且只实现了已确认可用的部分',
  })
}
