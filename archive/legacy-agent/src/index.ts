// Agent 入口（M6）
//
// 两种运行模式：
//   1. --serve：起 HTTP API（给 DSH / 外部客户端用）
//   2. --llm / 默认：M1/M2 的探测模式
//
// 用法：
//   node dist/src/index.js --serve                     # 起 API（默认 127.0.0.1:8791）
//   node dist/src/index.js --serve --port 8792
//   node dist/src/index.js --llm                       # 探测 LLM Provider
//   node dist/src/index.js                             # 只连 MCP 打印能力

import { loadConfig, type AgentConfig } from './config.js'
import { createProvider } from './llm/factory.js'
import type { LLMProvider, ModelInfo, ProviderHealth } from './llm/types.js'
import { McpClient } from './mcp/client.js'
import { Agent } from './runtime/agent.js'
import { createAgentApi } from './api/agentApi.js'
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

  let toolProbe: { supported: boolean; detail: string }
  const probe = (llm as unknown as { probeToolCalls?: () => Promise<{ supported: boolean; detail: string }> }).probeToolCalls
  if (typeof probe === 'function') {
    toolProbe = await probe.call(llm)
  } else {
    toolProbe = { supported: modelInfo.supportsToolCalls, detail: 'Provider 未提供探测方法' }
  }

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

/** 起 Agent HTTP API（给测试与 CLI 共用） */
export async function serveAgent(
  config: AgentConfig,
  logger: Logger,
  options: { port?: number; provider?: LLMProvider } = {},
): Promise<{ agent: Agent; api: ReturnType<typeof createAgentApi>; port: number }> {
  const agent = new Agent(config, logger, options.provider === undefined ? {} : { provider: options.provider })
  await agent.connect()
  const api = createAgentApi(agent, config, logger, {
    host: config.apiHost,
    port: options.port ?? config.apiPort,
    token: config.token,
  })
  const port = await api.listen()
  return { agent, api, port }
}

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger({ level: config.logLevel, secrets: [config.token, config.llmApiKey] })
  const wantServe = process.argv.includes('--serve')
  const wantLlm = process.argv.includes('--llm')
  const portArgIndex = process.argv.indexOf('--port')
  const explicitPort = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : undefined

  logger.info('Blind Whale Survivor Agent 启动', {
    version: '0.4.0-m6',
    mode: wantServe ? 'HTTP API' : wantLlm ? 'LLM 探测' : 'MCP 探测',
    mcp_transport: config.mcpTransport,
    llm_preset: config.llmPreset,
    llm_model: config.llmModel,
    has_llm_key: config.llmApiKey.length > 0,
    token_source: config.tokenSource,
  })

  if (wantServe) {
    if (config.token.length === 0) {
      logger.error('拒绝启动：HTTP API 必须配 token（不允许裸奔）')
      process.exit(2)
    }
    try {
      const { agent, api, port } = await serveAgent(config, logger, explicitPort === undefined ? {} : { port: explicitPort })
      logger.info('Agent HTTP API 已就绪', {
        url: `http://${config.apiHost}:${port}`,
        health: `http://${config.apiHost}:${port}/health`,
        events: `http://${config.apiHost}:${port}/api/agent/events`,
        tools: agent.adapter.names().length,
        note: '只监听本机；需要 Bearer token',
      })
      const shutdown = (signal: string) => {
        logger.info(`收到 ${signal}，关闭 Agent API`)
        void api.close().then(() => agent.disconnect()).then(() => process.exit(0))
        setTimeout(() => process.exit(0), 2000).unref()
      }
      process.on('SIGINT', () => shutdown('SIGINT'))
      process.on('SIGTERM', () => shutdown('SIGTERM'))
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      logger.error(code === 'EADDRINUSE' ? `端口 ${config.apiPort} 已被占用` : 'Agent API 启动失败：' + String((error as Error)?.message ?? error))
      process.exit(2)
    }
  }

  if (wantLlm) {
    const result = await probeLlm(config, logger)
    logger.info('=== Provider 健康 ===', { state: result.health.state, message: result.health.message, latency_ms: result.health.latencyMs })
    logger.info('=== 模型信息 ===', {
      provider: result.modelInfo.provider,
      model: result.modelInfo.model,
      supports_tool_calls: result.modelInfo.supportsToolCalls,
      supports_thinking: result.modelInfo.supportsThinking,
    })
    logger.info('=== Function Calling 实测 ===', { supported: result.toolProbe.supported, detail: result.toolProbe.detail.slice(0, 160) })
    logger.info('=== 普通对话 ===', {
      ok: result.simpleChat.ok,
      content: (result.simpleChat.content ?? '').slice(0, 80),
      reasoning_chars: result.simpleChat.reasoningChars,
      error: result.simpleChat.error,
    })
    if (result.health.state !== 'ok') {
      logger.error('Provider 不可用', { state: result.health.state, message: result.health.message })
      process.exit(1)
    }
    logger.info('M2 完成：Provider 可用')
    return
  }

  // 默认：MCP 探测
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
