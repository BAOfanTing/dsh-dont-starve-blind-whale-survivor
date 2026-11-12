// Agent Loop（M4）
//
// 一轮对话的完整循环：
//   构建消息 → 请求 LLM → 有 tool_calls 就校验+执行+喂回 → 再请求 → … → 出最终答复
//
// 三条硬约束（任务书 §8）：
//   1. **必须正确保存 assistant 的 reasoning_content 与 tool_calls**：
//      DeepSeek 带 tools 时要求把历史 reasoning_content 完整回传，漏了直接 400。
//   2. **循环必须有上限**：MAX_AGENT_ROUNDS / MAX_TOOL_CALLS_PER_ROUND / AGENT_TIMEOUT_MS，
//      到限制就终止并报告原因，不能无限重试。
//   3. **工具调用不重试**：LLM 请求重试是幂等的，工具调用不是（虽然本阶段只读，
//      但语义上不能假设"执行两次没副作用"）。
//
// 内部 reasoning_content 不直接给用户看，只输出"工具调用摘要 + 最终答复"。

import type { LLMMessage, LLMProvider, LLMResponse, LLMToolCall } from '../llm/types.js'
import { ProviderError } from '../llm/types.js'
import type { ToolAdapter, ToolCallOutcome } from '../mcp/toolAdapter.js'
import { toToolMessage } from '../mcp/toolAdapter.js'
import type { Logger } from '../utils/logger.js'

export interface AgentLoopLimits {
  /** 最多几轮"请求模型"（含工具调用往返） */
  maxRounds: number
  /** 单轮最多执行几个工具调用 */
  maxToolCallsPerRound: number
  /** 单个工具的超时（由 ToolAdapter/McpClient 内部生效，这里只做记录与总预算判断） */
  toolTimeoutMs: number
  /** 整个 Agent 请求的总超时 */
  agentTimeoutMs: number
}

export const DEFAULT_LIMITS: AgentLoopLimits = {
  maxRounds: 4,
  maxToolCallsPerRound: 4,
  toolTimeoutMs: 15000,
  agentTimeoutMs: 60000,
}

/** 一次工具调用的可观测记录（给 API/UI 展示，不含内部 reasoning） */
export interface ToolTrace {
  round: number
  toolCallId: string
  name: string
  arguments: Record<string, unknown> | null
  ok: boolean
  elapsedMs: number
  errorCode?: string
  /** 结果摘要（截断，便于展示） */
  resultPreview: string
}

export type AgentStopReason =
  | 'final_answer'
  | 'max_rounds'
  | 'max_tool_calls'
  | 'agent_timeout'
  | 'provider_error'
  | 'no_tools_available'
  | 'cancelled'

export interface AgentRunResult {
  /** 最终答复（给用户看） */
  reply: string
  stopReason: AgentStopReason
  /** 补充说明（例如"达到轮次上限"） */
  stopDetail: string | null
  /** 轮次统计 */
  rounds: number
  toolCalls: ToolTrace[]
  /** 累计 token 用量 */
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  /** 总耗时 */
  elapsedMs: number
  /** 完整消息历史（调用方要存上下文就存这个） */
  messages: LLMMessage[]
  /** 出错时的错误码 */
  errorCode?: string
}

export interface AgentLoopOptions {
  limits?: Partial<AgentLoopLimits>
  /** 系统提示词 */
  systemPrompt?: string
  /** 中止信号 */
  signal?: AbortSignal
  /** 进度回调（未来给 DSH UI 做事件推送） */
  onEvent?: (event: AgentEvent) => void
}

export type AgentEvent =
  | { type: 'round_start'; round: number }
  | { type: 'llm_response'; round: number; hasToolCalls: boolean; toolNames: string[]; elapsedMs: number }
  | { type: 'tool_start'; round: number; name: string; toolCallId: string }
  | { type: 'tool_end'; round: number; name: string; ok: boolean; elapsedMs: number }
  | { type: 'stop'; reason: AgentStopReason }

function mergeLimits(partial?: Partial<AgentLoopLimits>): AgentLoopLimits {
  return { ...DEFAULT_LIMITS, ...(partial ?? {}) }
}

export class AgentLoop {
  private readonly limits: AgentLoopLimits

  constructor(
    private readonly provider: LLMProvider,
    private readonly adapter: ToolAdapter,
    private readonly logger: Logger,
    options: { limits?: Partial<AgentLoopLimits> } = {},
  ) {
    this.limits = mergeLimits(options.limits)
  }

  getLimits(): AgentLoopLimits {
    return { ...this.limits }
  }

  /**
   * 跑一轮完整对话。
   * @param history 已有对话历史（会被追加，不修改原数组）
   * @param userInput 本轮用户输入
   */
  async run(history: LLMMessage[], userInput: string, options: AgentLoopOptions = {}): Promise<AgentRunResult> {
    const startedAt = Date.now()
    const limits = { ...this.limits, ...(options.limits ?? {}) }
    const emit = options.onEvent ?? (() => undefined)

    const messages: LLMMessage[] = []
    if (options.systemPrompt !== undefined && options.systemPrompt.length > 0) {
      messages.push({ role: 'system', content: options.systemPrompt })
    }
    messages.push(...history)
    messages.push({ role: 'user', content: userInput })

    const toolCalls: ToolTrace[] = []
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    let rounds = 0

    const tools = this.adapter.toolDefinitions()
    const toolMap = new Map(tools.map((tool) => [tool.function.name, tool]))

    const finish = (reply: string, stopReason: AgentStopReason, stopDetail: string | null, errorCode?: string): AgentRunResult => {
      emit({ type: 'stop', reason: stopReason })
      return {
        reply,
        stopReason,
        stopDetail,
        rounds,
        toolCalls,
        usage,
        elapsedMs: Date.now() - startedAt,
        messages,
        ...(errorCode === undefined ? {} : { errorCode }),
      }
    }

    if (tools.length === 0) {
      // 没有可用工具：不要假装能查数据，直接说明
      return finish(
        '当前没有可用的只读工具（MCP Server 未连接或工具未适配），我无法查询游戏数据。',
        'no_tools_available',
        'toolDefinitions() 为空',
      )
    }

    while (rounds < limits.maxRounds) {
      // 总超时检查
      if (Date.now() - startedAt > limits.agentTimeoutMs) {
        return finish(
          `处理超时（超过 ${Math.round(limits.agentTimeoutMs / 1000)} 秒），已停止。已完成的工具调用见 structured 数据。`,
          'agent_timeout',
          `elapsed > ${limits.agentTimeoutMs}ms`,
        )
      }
      if (options.signal?.aborted === true) {
        return finish('已取消。', 'cancelled', 'signal aborted')
      }

      rounds += 1
      emit({ type: 'round_start', round: rounds })

      let response: LLMResponse
      try {
        response = await this.provider.chat(messages, {
          tools,
          // DeepSeek thinking 模式只用 auto；这里统一 auto（required 会被 Provider 降级）
          toolChoice: 'auto',
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : 'INTERNAL_ERROR'
        const message = String((error as Error)?.message ?? error)
        this.logger.error('LLM 调用失败', { round: rounds, code, message: message.slice(0, 200) })
        return finish(
          `模型调用失败（${code}）：${message}`,
          'provider_error',
          message,
          code,
        )
      }

      usage.promptTokens += response.usage.promptTokens ?? 0
      usage.completionTokens += response.usage.completionTokens ?? 0
      usage.totalTokens += response.usage.totalTokens ?? 0

      emit({
        type: 'llm_response',
        round: rounds,
        hasToolCalls: response.toolCalls.length > 0,
        toolNames: response.toolCalls.map((call) => call.name),
        elapsedMs: response.elapsedMs,
      })

      // 关键：assistant 消息必须完整保存（content + reasoningContent + toolCalls）
      // DeepSeek 带 tools 的请求要求把历史 reasoning_content 回传，否则 400
      messages.push({
        role: 'assistant',
        content: response.content,
        reasoningContent: response.reasoningContent,
        ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
      })

      if (response.toolCalls.length === 0) {
        // 没有工具调用 → 这就是最终答复
        const reply = (response.content ?? '').trim()
        return finish(
          reply.length > 0 ? reply : '（模型没有给出内容）',
          'final_answer',
          null,
        )
      }

      // 工具调用：先按上限截断（超出的明确告知模型）
      const calls = response.toolCalls.slice(0, limits.maxToolCallsPerRound)
      const dropped = response.toolCalls.length - calls.length
      if (dropped > 0) {
        this.logger.warn('单轮工具调用超上限，已截断', { requested: response.toolCalls.length, executed: calls.length })
      }

      for (const call of calls) {
        if (options.signal !== undefined && options.signal.aborted) {
          return finish('已取消。', 'cancelled', 'signal aborted during tool calls')
        }
        emit({ type: 'tool_start', round: rounds, name: call.name, toolCallId: call.id })
        const outcome = await this.executeOne(call, rounds, toolMap, options)
        toolCalls.push(outcome.trace)
        emit({
          type: 'tool_end',
          round: rounds,
          name: call.name,
          ok: outcome.result.ok,
          elapsedMs: outcome.result.elapsedMs,
        })
        // 工具结果 → role:tool 消息（保留 tool_call_id）
        messages.push(toToolMessage(outcome.result))
      }

      if (dropped > 0) {
        // 让模型知道有调用被丢了（否则它以为都执行了）
        messages.push({
          role: 'user',
          content: `（系统提示：本轮还有 ${dropped} 个工具调用超过单轮上限 ${limits.maxToolCallsPerRound}，未执行。请基于已有结果继续，或分多轮再查。）`,
        })
      }
    }

    // 达到轮次上限：明确报告，不假装完成
    return finish(
      `已达到最大轮次限制（${limits.maxRounds} 轮），未能得出最终结论。已执行的工具调用：${
        toolCalls.length === 0 ? '无' : toolCalls.map((trace) => trace.name).join('、')
      }。`,
      'max_rounds',
      `rounds=${rounds} >= maxRounds=${limits.maxRounds}`,
    )
  }

  /** 执行单个工具调用并产出 trace */
  private async executeOne(
    call: LLMToolCall,
    round: number,
    toolMap: Map<string, unknown>,
    _options: AgentLoopOptions,
  ): Promise<{ result: ToolCallOutcome; trace: ToolTrace }> {
    const startedAt = Date.now()
    let parsedArgs: Record<string, unknown> | null = null
    try {
      parsedArgs = JSON.parse(call.arguments.length > 0 ? call.arguments : '{}') as Record<string, unknown>
    } catch {
      parsedArgs = null
    }

    const result = await this.adapter.executeToolCall({ id: call.id, name: call.name, arguments: call.arguments })

    // 如果工具不在适配表里，adapter 已经返回 TOOL_NOT_ALLOWED；这里额外记一条日志便于审计
    if (!toolMap.has(call.name)) {
      this.logger.warn('模型请求了未适配的工具', { tool: call.name, round })
    }

    return {
      result,
      trace: {
        round,
        toolCallId: call.id,
        name: call.name,
        arguments: parsedArgs,
        ok: result.ok,
        elapsedMs: result.elapsedMs,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        resultPreview: result.content.slice(0, 200),
      },
    }
  }
}
