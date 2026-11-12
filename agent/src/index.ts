// M2 入口：探测 LLM Provider（不跑 Agent Loop，那是 M4）
//
// 用法：
//   node dist/src/index.js --llm          # 探测 LLM（健康检查 + function calling 实测）
//   node dist/src/index.js                # 默认只做 MCP 连接（M1 行为）
//
// 环境变量见 config.ts（BWS_LLM_* / DEEPSEEK_*）。

import { loadConfig, type AgentConfig } from './config.js'
import { createProvider } from './llm/factory.js'
import type { LLMProvider, ModelInfo, ProviderHealth } from './llm/types.js'
import { McpClient } from './mcp/client.js'
import { createLogger, type Logger } from './utils/logger.js'

export interface LlmProbeResult {
  health: ProviderHealth
  modelInfo: ModelInfo
  toolProbe: { supported: boolean; detail: string }
  simpleChat: { ok: boolean; content: string | null; reasoningChars: number; usage: Record<string, unknown> | null; error?: string }
}

/** 探测 LLM：健康检查 + 模型信息 + function calling 实测 + 一次普通对话 */
export async function probeLlm(config: AgentConfig, logger: Logger, provider?: LLMProvider): Promise<LlmProbeResult> {
  const llm = provider ?? createProvider(config, logger)
  const health = await llm.healthCheck()
  const modelInfo = await llm.getModelInfo()

  // function calling 实测（只有 OpenAICompatibleProvider 有 probeToolCalls）
  let toolProbe: { supported: boolean; detail: string }
  const probe = (llm as unknown as { probeToolCalls?: () => Promise<{ supported: boolean; detail: string }> }).probeToolCalls
  if (typeof probe === 'function') {
    toolProbe = await probe.call(llm)
  } else {
    toolProbe = { supported: modelInfo.supportsToolCalls, detail: 'Provider 未提供探测方法' }
  }

  // 一次普通对话（验证 content 与 reasoning_content 都能取到）
  let simpleChat: LlmProbeResult['simpleChat']
  try {
    const response = await llm.chat([{ role: 'user', content: '用一句中文回答：你好' }], { maxTokens: 64 })
    simpleChat = {
      ok: true,
      content: response.content,
      reasoningChars: response.reasoningContent?.length ?? 0,
      usage: response.usage as unknown as Record<string, unknown>,
    }
  } catch (error) {
    simpleChat = { ok: false, content: null, reasoningChars: 0, usage: null, error: String((error as Error)?.message ?? error) }
  }

  return { health, modelInfo, toolProbe, simpleChat }
}

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger({ level: config.logLevel, secrets: [config.token, config.llmApiKey] })
  const wantLlm = process.argv.includes('--llm')

  logger.info('Blind Whale Survivor Agent 启动', {
    version: '0.4.0-m2',
    mode: wantLlm ? 'M2 LLM 探测' : 'M1 MCP 连接',
    mcp_transport: config.mcpTransport,
    mcp_target: config.mcpTransport === 'http' ? config.mcpHttpUrl : config.mcpStdioArgs.join(' '),
    llm_preset: config.llmPreset,
    llm_base_url: config.llmBaseUrl,
    llm_model: config.llmModel,
    has_llm_key: config.llmApiKey.length > 0,
  })

  if (wantLlm) {
    const result = await probeLlm(config, logger)
    logger.info('=== Provider 健康 ===', {
      state: result.health.state,
      message: result.health.message,
      latency_ms: result.health.latencyMs,
    })
    logger.info('=== 模型信息 ===', {
      provider: result.modelInfo.provider,
      model: result.modelInfo.model,
      supports_tool_calls: result.modelInfo.supportsToolCalls,
      supports_thinking: result.modelInfo.supportsThinking,
    })
    logger.info('=== Function Calling 实测 ===', {
      supported: result.toolProbe.supported,
      detail: result.toolProbe.detail.slice(0, 160),
    })
    logger.info('=== 普通对话 ===', {
      ok: result.simpleChat.ok,
      content: (result.simpleChat.content ?? '').slice(0, 80),
      reasoning_chars: result.simpleChat.reasoningChars,
      usage: result.simpleChat.usage,
      error: result.simpleChat.error,
    })

    if (result.health.state !== 'ok') {
      logger.error('Provider 不可用，M2 未通过', { state: result.health.state, message: result.health.message })
      logger.error('排查建议', {
        key: config.llmApiKey.length === 0 ? '没有 API Key：设置 DEEPSEEK_API_KEY' : 'Key 已加载',
        local: '本地模型：BWS_LLM_PRESET=openai-compatible BWS_LLM_BASE_URL=http://127.0.0.1:8000/v1',
        model: `当前模型 ${config.llmModel}，可用 BWS_LLM_MODEL 覆盖`,
      })
      process.exit(1)
    }
    logger.info('M2 完成：Provider 可用')
    return
  }

  // M1 行为：连 MCP Server 打印能力
  const client = new McpClient(config, logger)
  try {
    await client.connect()
    const tools = client.listTools()
    logger.info('MCP 能力', { tools: tools.length, resources: client.listResources().length, prompts: client.listPrompts().length })
    for (const tool of tools) logger.info(`  👁 ${tool.name}`, { required: tool.required })
  } catch (error) {
    logger.error('MCP 连接失败', { error: String((error as Error)?.message ?? error) })
    process.exit(1)
  } finally {
    await client.disconnect()
  }
}

const isDirectRun = process.argv[1] !== undefined && process.argv[1].endsWith('index.js')
if (isDirectRun) {
  main().catch((error: unknown) => {
    process.stderr.write(`[bws-agent] 启动失败：${String((error as Error)?.stack ?? error)}\n`)
    process.exit(1)
  })
}
