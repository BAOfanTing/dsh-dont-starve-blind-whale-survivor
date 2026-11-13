// LLM Provider 统一接口（M2）
//
// 目标：让 Agent Loop（M4）不关心底层是哪家模型。所有 Provider 都实现同一组方法，
// 并且**能力差异要显式表达**（比如"这家不支持 function calling"必须能被上层检测到，
// 而不是假装成功）。
//
// 参考实现：DeepSeek 官方 API（OpenAI 兼容）与任意本地 OpenAI 兼容服务。
// 官方文档依据（2026-11 实测）：
//   · 模型名：deepseek-flash / deepseek-v4-pro（不写死，走配置）
//   · thinking 开关：extra_body = { thinking: { type: 'enabled' | 'disabled' } }，默认 enabled
//   · 思考强度：reasoning_effort = 'low' | 'high' | 'max'
//   · 带 tools 的请求必须把历史 reasoning_content 原样传回，否则 400
//   · thinking 模式不支持 temperature / presence_penalty / frequency_penalty

/** 统一的对话消息（内部表示，与厂商格式解耦） */
export type LLMRole = 'system' | 'user' | 'assistant' | 'tool'

export interface LLMToolCall {
  id: string
  name: string
  /** 模型给的原始 JSON 字符串（**必须**先 JSON.parse + schema 校验才能用） */
  arguments: string
}

export interface LLMMessage {
  role: LLMRole
  content: string | null
  /** assistant 专用：思考内容。带 tools 时必须回传（DeepSeek 要求） */
  reasoningContent?: string | null
  /** assistant 专用：本轮的多个工具调用 */
  toolCalls?: LLMToolCall[]
  /** tool 专用：对应哪个 tool_call */
  toolCallId?: string
  /** tool 专用：工具名（部分厂商要求） */
  name?: string
}

/** Function Calling 的工具定义（OpenAI 格式） */
export interface LLMToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface LLMChatOptions {
  tools?: LLMToolDefinition[]
  /** auto（默认）/ none / required。DeepSeek thinking 模式下只用 auto 或 none */
  toolChoice?: 'auto' | 'none' | 'required'
  maxTokens?: number
  temperature?: number
  /** 是否开启思考模式；不传则用 Provider 默认 */
  thinking?: boolean
  /** 思考强度（DeepSeek: low/high/max） */
  reasoningEffort?: 'low' | 'high' | 'max'
  /** 中止信号（用于 /api/agent/cancel） */
  signal?: AbortSignal
}

export interface LLMUsage {
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  /** 缓存命中的 token（有就记，没有就 null） */
  cachedTokens: number | null
  /** 思考型模型的推理 token（有就记，没有就 null） */
  reasoningTokens: number | null
}

export interface LLMResponse {
  /** 最终回答（可能是 null，当模型只返回 tool_calls 时） */
  content: string | null
  /** 思考内容（不直接展示给用户，只用于回传） */
  reasoningContent: string | null
  /** 本轮的工个调用（空数组表示没有） */
  toolCalls: LLMToolCall[]
  /** 结束原因：stop / tool_calls / length / content_filter */
  finishReason: string
  usage: LLMUsage
  model: string
  /** 这一轮花了多久（毫秒） */
  elapsedMs: number
}

export interface ModelInfo {
  provider: string
  model: string
  baseUrl: string
  /** 是否支持 function calling（**实测结论**，不是配置声明） */
  supportsToolCalls: boolean
  /** 是否支持思考模式 */
  supportsThinking: boolean
  contextLength: number | null
  maxOutputTokens: number | null
}

export type ProviderHealthState = 'ok' | 'degraded' | 'unavailable' | 'misconfigured'

export interface ProviderHealth {
  state: ProviderHealthState
  /** 人读的说明 */
  message: string
  /** 探测耗时 */
  latencyMs: number | null
  /** 具体错误码/原因 */
  detail?: unknown
  checkedAt: number
}

/** Provider 统一接口 */
export interface LLMProvider {
  /** 发一轮对话 */
  chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse>
  /** 模型信息（含**实测**的 function calling 支持情况） */
  getModelInfo(): Promise<ModelInfo>
  /** 健康检查（不抛错，用 state 表达） */
  healthCheck(): Promise<ProviderHealth>
  /** 关闭底层连接（如果有） */
  close?(): Promise<void>
}

/** Provider 错误分类（上层据此决定是重试、降级还是直接报错） */
export type ProviderErrorCode =
  | 'MISSING_API_KEY'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'MODEL_NOT_FOUND'
  | 'TOOL_CALLS_UNSUPPORTED'
  | 'BAD_REQUEST'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'SERVER_ERROR'
  | 'BAD_RESPONSE'

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly detail?: unknown,
    /** 是否值得重试 */
    readonly retryable: boolean = false,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
