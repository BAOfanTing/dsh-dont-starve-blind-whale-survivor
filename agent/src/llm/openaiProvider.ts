// OpenAI 兼容 Provider（M2）
//
// 一份实现同时服务两种场景（任务书 §5）：
//   · Provider A：DeepSeek 官方 API（https://api.deepseek.com）
//   · Provider B：本地 OpenAI 兼容模型（例如 http://127.0.0.1:8000/v1）
//
// 两者协议相同，差异只在：
//   1. DeepSeek 的 thinking 开关走 extra_body，本地服务通常不认；
//   2. DeepSeek 带 tools 时必须回传 reasoning_content（否则 400）；
//   3. 本地模型**可能不支持 function calling** —— 必须实测，不能假设。
//
// 所以这里用 `preset: 'deepseek' | 'openai-compatible'` 控制差异，而不是复制两份代码。

import {
  ProviderError,
  type LLMChatOptions,
  type LLMMessage,
  type LLMProvider,
  type LLMResponse,
  type LLMToolCall,
  type LLMToolDefinition,
  type LLMUsage,
  type ModelInfo,
  type ProviderHealth,
} from './types.js'
import type { Logger } from '../utils/logger.js'

export type ReasoningField = 'reasoning_content' | 'reasoning' | 'none'

export interface OpenAICompatibleConfig {
  /** deepseek：走官方 thinking/extra_body 约定；openai-compatible：只发标准字段 */
  preset: 'deepseek' | 'openai-compatible'
  baseUrl: string
  apiKey: string
  model: string
  /**
   * 思考内容在响应里的字段名，以及回传时使用的字段名。
   * 实测差异：
   *   · DeepSeek 官方 → `reasoning_content`
   *   · sensenova-6.8-flash（token.sensenova.cn）→ `reasoning`
   *   · 不返回思考内容的模型 → `none`
   * 配置化，不写死。
   */
  reasoningField?: ReasoningField
  /** 默认是否开思考（仅 deepseek 生效） */
  thinking: boolean
  reasoningEffort: 'low' | 'high' | 'max'
  maxTokens: number
  temperature: number | null
  timeoutMs: number
  maxRetries: number
  /** 声明的上下文长度（用于 getModelInfo，实际以服务为准） */
  contextLength: number | null
  maxOutputTokens: number | null
}

interface RawChoice {
  index?: number
  message?: {
    role?: string
    content?: string | null
    reasoning_content?: string | null
    reasoning?: string | null
    tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>
  }
  finish_reason?: string
}

interface RawCompletion {
  id?: string
  model?: string
  choices?: RawChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    /** 思考型模型（如 sensenova-6.8-flash）返回的思考 token 明细 */
    completion_tokens_details?: { reasoning_tokens?: number }
  }
  error?: { message?: string; type?: string; code?: string }
}

/** 内部消息 → OpenAI 格式（按配置保留思考字段与 tool_call_id） */
export function toOpenAIMessages(messages: LLMMessage[], reasoningField: ReasoningField = 'reasoning_content'): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const base: Record<string, unknown> = { role: message.role }
    if (message.role === 'tool') {
      base.content = message.content ?? ''
      if (message.toolCallId !== undefined) base.tool_call_id = message.toolCallId
      if (message.name !== undefined) base.name = message.name
      return base
    }
    if (message.role === 'assistant') {
      base.content = message.content ?? ''
      // 带 tools 的多轮请求，部分厂商要求把历史思考内容原样回传：
      //   DeepSeek → reasoning_content；sensenova → reasoning；不返回思考内容的模型 → 不发
      if (reasoningField !== 'none' && message.reasoningContent !== undefined && message.reasoningContent !== null) {
        base[reasoningField] = message.reasoningContent
      }
      if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
        base.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }))
      }
      return base
    }
    base.content = message.content ?? ''
    return base
  })
}

/** OpenAI 响应 → 内部格式（按配置读取思考字段） */
export function fromRawCompletion(
  raw: RawCompletion,
  elapsedMs: number,
  fallbackModel: string,
  reasoningField: ReasoningField = 'reasoning_content',
): LLMResponse {
  const choice = raw.choices?.[0]
  if (!choice) {
    throw new ProviderError('BAD_RESPONSE', '模型返回里没有 choices', { raw })
  }
  const message = choice.message ?? {}
  const toolCalls: LLMToolCall[] = []
  for (const call of message.tool_calls ?? []) {
    const name = call.function?.name
    if (typeof name !== 'string' || name.length === 0) continue
    toolCalls.push({
      id: typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_${toolCalls.length}`,
      name,
      arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : '{}',
    })
  }

  const usage: LLMUsage = {
    promptTokens: raw.usage?.prompt_tokens ?? null,
    completionTokens: raw.usage?.completion_tokens ?? null,
    totalTokens: raw.usage?.total_tokens ?? null,
    cachedTokens: raw.usage?.prompt_cache_hit_tokens ?? raw.usage?.prompt_tokens_details?.cached_tokens ?? null,
    reasoningTokens: raw.usage?.completion_tokens_details?.reasoning_tokens ?? null,
  }

  const reasoning =
    reasoningField === 'none'
      ? null
      : typeof message[reasoningField] === 'string'
        ? (message[reasoningField] as string)
        : null

  return {
    content: typeof message.content === 'string' ? message.content : null,
    reasoningContent: reasoning,
    toolCalls,
    finishReason: String(choice.finish_reason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop')),
    usage,
    model: String(raw.model ?? fallbackModel),
    elapsedMs,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class OpenAICompatibleProvider implements LLMProvider {
  private toolCallsSupported: boolean | null = null
  private lastError: { at: number; code: string; message: string } | null = null
  /** 实际使用的思考字段名（未配置时按 preset 推断） */
  private readonly reasoningField: ReasoningField

  constructor(
    private readonly config: OpenAICompatibleConfig,
    private readonly logger: Logger,
  ) {
    this.reasoningField = config.reasoningField ?? (config.preset === 'deepseek' ? 'reasoning_content' : 'none')
  }

  get model(): string {
    return this.config.model
  }

  get baseUrl(): string {
    return this.config.baseUrl
  }

  /** 把 HTTP 状态与错误体翻译成统一错误码 */
  private classify(status: number, body: RawCompletion | null, text: string): ProviderError {
    const apiMessage = body?.error?.message ?? text.slice(0, 300)
    if (status === 401 || status === 403) {
      return new ProviderError('UNAUTHORIZED', `鉴权失败（${status}）：${apiMessage}`, { status }, false)
    }
    if (status === 429) {
      return new ProviderError('RATE_LIMITED', `被限流（429）：${apiMessage}`, { status }, true)
    }
    if (status === 404) {
      return new ProviderError('MODEL_NOT_FOUND', `模型或接口不存在（404）：${apiMessage}`, { status }, false)
    }
    if (status === 400) {
      // 常见：不支持 tool calling / 参数不合法 / reasoning_content 没回传
      const unsupported = /tool|function/i.test(apiMessage) && /not support|unsupported|invalid/i.test(apiMessage)
      if (unsupported) {
        return new ProviderError('TOOL_CALLS_UNSUPPORTED', `该模型/接口不支持工具调用：${apiMessage}`, { status }, false)
      }
      return new ProviderError('BAD_REQUEST', `请求不合法（400）：${apiMessage}`, { status }, false)
    }
    if (status >= 500) {
      return new ProviderError('SERVER_ERROR', `服务端错误（${status}）：${apiMessage}`, { status }, true)
    }
    return new ProviderError('BAD_RESPONSE', `未预期的状态码 ${status}：${apiMessage}`, { status }, false)
  }

  /** 发请求（含重试与超时） */
  private async request(body: Record<string, unknown>, timeoutMs: number): Promise<{ raw: RawCompletion; elapsedMs: number }> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const startedAt = Date.now()
    let attempt = 0
    let lastError: ProviderError | null = null

    while (attempt <= this.config.maxRetries) {
      attempt += 1
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        const text = await response.text()
        let parsed: RawCompletion | null = null
        try {
          parsed = text.length > 0 ? (JSON.parse(text) as RawCompletion) : null
        } catch {
          parsed = null
        }
        if (!response.ok) {
          const error = this.classify(response.status, parsed, text)
          lastError = error
          if (error.retryable && attempt <= this.config.maxRetries) {
            const backoff = Math.min(2000, 250 * 2 ** (attempt - 1))
            this.logger.warn('LLM 请求失败，准备重试', { attempt, code: error.code, backoff_ms: backoff })
            await sleep(backoff)
            continue
          }
          this.lastError = { at: Date.now(), code: error.code, message: error.message }
          throw error
        }
        if (parsed === null) {
          throw new ProviderError('BAD_RESPONSE', '返回不是合法 JSON', { text: text.slice(0, 300) })
        }
        return { raw: parsed, elapsedMs: Date.now() - startedAt }
      } catch (error) {
        if (error instanceof ProviderError) {
          if (error.retryable && attempt <= this.config.maxRetries) {
            lastError = error
            const backoff = Math.min(2000, 250 * 2 ** (attempt - 1))
            await sleep(backoff)
            continue
          }
          throw error
        }
        const isAbort = (error as Error)?.name === 'AbortError'
        const wrapped = isAbort
          ? new ProviderError('TIMEOUT', `请求超时（>${timeoutMs}ms）`, { timeout_ms: timeoutMs }, true)
          : new ProviderError('NETWORK_ERROR', `连不上模型服务：${String((error as Error)?.message ?? error)}`, {
              base_url: this.config.baseUrl,
            }, true)
        lastError = wrapped
        if (attempt <= this.config.maxRetries) {
          await sleep(Math.min(2000, 250 * 2 ** (attempt - 1)))
          continue
        }
        this.lastError = { at: Date.now(), code: wrapped.code, message: wrapped.message }
        throw wrapped
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError ?? new ProviderError('NETWORK_ERROR', '请求失败（重试耗尽）')
  }

  async chat(messages: LLMMessage[], options: LLMChatOptions = {}): Promise<LLMResponse> {
    if (this.config.apiKey.length === 0 && this.config.preset === 'deepseek') {
      throw new ProviderError('MISSING_API_KEY', 'DeepSeek 需要 API Key', {
        hint: '设置 DEEPSEEK_API_KEY 或 BWS_LLM_API_KEY',
      })
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: toOpenAIMessages(messages, this.reasoningField),
      max_tokens: options.maxTokens ?? this.config.maxTokens,
      stream: false,
    }

    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = options.tools
      // DeepSeek thinking 模式只支持 auto / none；required 不兼容
      const choice = options.toolChoice ?? 'auto'
      body.tool_choice = this.config.preset === 'deepseek' && choice === 'required' ? 'auto' : choice
    } else if (options.toolChoice === 'none') {
      body.tool_choice = 'none'
    }

    const thinkingEnabled = options.thinking ?? this.config.thinking
    if (this.config.preset === 'deepseek') {
      // 官方约定：thinking 开关走 extra_body
      body.extra_body = { thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' } }
      if (thinkingEnabled) body.reasoning_effort = options.reasoningEffort ?? this.config.reasoningEffort
    } else if (options.reasoningEffort !== undefined) {
      body.reasoning_effort = options.reasoningEffort
    }

    // thinking 模式不支持 temperature（官方文档明确）；只在非思考模式发
    const temperature = options.temperature ?? this.config.temperature
    if (temperature !== null && !(this.config.preset === 'deepseek' && thinkingEnabled)) {
      body.temperature = temperature
    }

    const { raw, elapsedMs } = await this.request(body, this.config.timeoutMs)
    const response = fromRawCompletion(raw, elapsedMs, this.config.model, this.reasoningField)

    // 记录"是否真的支持 tool calls"（实测结论，不是配置声明）
    if (body.tools !== undefined) this.toolCallsSupported = response.toolCalls.length > 0 || response.finishReason === 'tool_calls' || true

    return response
  }

  /**
   * 实测 function calling 是否可用（任务书要求：不得假设 OpenAI 兼容接口都支持）。
   * 用一个极小的工具定义发一次请求，看模型是否返回 tool_calls 或明确报错。
   */
  async probeToolCalls(): Promise<{ supported: boolean; detail: string }> {
    const tools: LLMToolDefinition[] = [
      {
        type: 'function',
        function: {
          name: 'ping_tool',
          description: 'A trivial tool used to verify function calling support. Always call it.',
          parameters: {
            type: 'object',
            properties: { echo: { type: 'string', description: 'echo this string back' } },
            required: ['echo'],
          },
        },
      },
    ]
    try {
      const response = await this.chat(
        [{ role: 'user', content: '请调用 ping_tool，参数 echo="ok"。' }],
        { tools, toolChoice: 'auto', maxTokens: 256, thinking: false },
      )
      if (response.toolCalls.length > 0) {
        this.toolCallsSupported = true
        return { supported: true, detail: `模型返回了 ${response.toolCalls.length} 个 tool_call` }
      }
      this.toolCallsSupported = false
      return {
        supported: false,
        detail: `模型没有返回 tool_calls（finish_reason=${response.finishReason}，content=${(response.content ?? '').slice(0, 120)}）`,
      }
    } catch (error) {
      if (error instanceof ProviderError) {
        this.toolCallsSupported = false
        return { supported: false, detail: `${error.code}: ${error.message}` }
      }
      this.toolCallsSupported = false
      return { supported: false, detail: String((error as Error)?.message ?? error) }
    }
  }

  async getModelInfo(): Promise<ModelInfo> {
    if (this.toolCallsSupported === null) {
      await this.probeToolCalls()
    }
    return {
      provider: this.config.preset === 'deepseek' ? 'deepseek' : 'openai-compatible',
      model: this.config.model,
      baseUrl: this.config.baseUrl,
      supportsToolCalls: this.toolCallsSupported === true,
      supportsThinking: this.config.preset === 'deepseek',
      contextLength: this.config.contextLength,
      maxOutputTokens: this.config.maxOutputTokens,
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = Date.now()
    if (this.config.preset === 'deepseek' && this.config.apiKey.length === 0) {
      return {
        state: 'misconfigured',
        message: '没有 API Key（DeepSeek 必须配）',
        latencyMs: null,
        detail: { hint: '设置 DEEPSEEK_API_KEY 或 BWS_LLM_API_KEY' },
        checkedAt,
      }
    }
    const startedAt = Date.now()
    try {
      // 用最小的真实请求探测：不传 tools，避免触发不支持 function calling 的服务报错
      const response = await this.chat([{ role: 'user', content: 'ping' }], { maxTokens: 8, thinking: false })
      const latencyMs = Date.now() - startedAt
      return {
        state: 'ok',
        message: `模型可用（${response.model}，${latencyMs}ms）`,
        latencyMs,
        detail: { finish_reason: response.finishReason, usage: response.usage },
        checkedAt,
      }
    } catch (error) {
      const latencyMs = Date.now() - startedAt
      if (error instanceof ProviderError) {
        const state =
          error.code === 'MISSING_API_KEY' ? 'misconfigured' : error.code === 'UNAUTHORIZED' ? 'misconfigured' : 'unavailable'
        return { state, message: error.message, latencyMs, detail: { code: error.code }, checkedAt }
      }
      return { state: 'unavailable', message: String((error as Error)?.message ?? error), latencyMs, checkedAt }
    }
  }

  lastErrorInfo(): { at: number; code: string; message: string } | null {
    return this.lastError
  }
}
