// Provider 工厂：按配置创建 DeepSeek 官方或本地 OpenAI 兼容 Provider
//
// 设计原则（任务书 §5）：
//   · 模型名一律走配置，不写死；
//   · 两种 Provider 共用一份实现（协议相同），差异靠 preset 区分；
//   · 拿不到 API Key 时**不假装可用**：创建成功但 healthCheck 会报 misconfigured。

import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openaiProvider.js'
import type { LLMProvider } from './types.js'
import type { AgentConfig } from '../config.js'
import type { Logger } from '../utils/logger.js'

export function createProvider(config: AgentConfig, logger: Logger): LLMProvider {
  const base: OpenAICompatibleConfig = {
    preset: config.llmPreset,
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
    thinking: config.llmThinking,
    reasoningField: config.llmReasoningField,
    reasoningEffort: config.llmReasoningEffort,
    maxTokens: config.llmMaxTokens,
    temperature: config.llmTemperature,
    timeoutMs: config.llmTimeoutMs,
    maxRetries: config.llmMaxRetries,
    contextLength: config.llmContextLength,
    maxOutputTokens: config.llmMaxOutputTokens,
  }
  logger.info('创建 LLM Provider', {
    preset: base.preset,
    base_url: base.baseUrl,
    model: base.model,
    thinking: base.thinking,
    reasoning_effort: base.reasoningEffort,
    max_tokens: base.maxTokens,
    timeout_ms: base.timeoutMs,
    max_retries: base.maxRetries,
    has_api_key: base.apiKey.length > 0,
  })
  return new OpenAICompatibleProvider(base, logger)
}
