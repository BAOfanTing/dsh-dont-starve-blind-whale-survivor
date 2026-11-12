// Agent 入口（M1）
//
// M1 只做一件事：连上 Phase 3 的 MCP Server，打印它到底提供了什么。
// 不接 LLM、不跑 Agent Loop、不做决策 —— 那些是 M2/M4/M5。
//
// 用法：
//   node dist/src/index.js                        # 默认走 Streamable HTTP（连已运行的 MCP Server）
//   BWS_AGENT_MCP_TRANSPORT=stdio node dist/src/index.js   # 拉起子进程走 stdio
//
// 环境变量：
//   BWS_MCP_URL            MCP Server 地址（默认 http://127.0.0.1:8790）
//   BWS_AGENT_MCP_TRANSPORT  http | stdio（默认 http）
//   BWS_TOKEN / BWS_TOKEN_FILE  共享 token（默认读 .runtime/token.txt）
//   BWS_AGENT_TOOL_TIMEOUT_MS    工具调用超时（默认 15000）
//   BWS_AGENT_LOG          debug|info|warn|error

import { loadConfig } from './config.js'
import { McpClient } from './mcp/client.js'
import { createLogger } from './utils/logger.js'

export interface ProbeResult {
  ok: boolean
  status: ReturnType<McpClient['status']>
  tools: Array<{ name: string; readOnly: boolean; required: string[]; description: string }>
  resources: Array<{ uri: string; name: string }>
  prompts: Array<{ name: string; arguments: number }>
  error?: string
}

/** 连接 + 发现，返回结构化结果（给 CLI 和测试共用） */
export async function probeMcpServer(options: { config?: ReturnType<typeof loadConfig>; logger?: ReturnType<typeof createLogger> } = {}): Promise<ProbeResult> {
  const config = options.config ?? loadConfig()
  const logger = options.logger ?? createLogger({ level: config.logLevel, secrets: [config.token] })
  const client = new McpClient(config, logger)
  try {
    await client.connect()
    return {
      ok: true,
      status: client.status(),
      tools: client.listTools().map((tool) => ({
        name: tool.name,
        readOnly: tool.readOnly,
        required: tool.required,
        description: tool.description,
      })),
      resources: client.listResources().map((resource) => ({ uri: resource.uri, name: resource.name })),
      prompts: client.listPrompts().map((prompt) => ({ name: prompt.name, arguments: prompt.arguments.length })),
    }
  } catch (error) {
    return {
      ok: false,
      status: client.status(),
      tools: [],
      resources: [],
      prompts: [],
      error: String((error as Error)?.message ?? error),
    }
  } finally {
    await client.disconnect()
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger({ level: config.logLevel, secrets: [config.token] })

  logger.info('Blind Whale Survivor Agent 启动（M1：只做 MCP 连接与能力发现）', {
    version: '0.4.0-m1',
    transport: config.mcpTransport,
    target: config.mcpTransport === 'http' ? config.mcpHttpUrl : `${config.mcpStdioCommand} ${config.mcpStdioArgs.join(' ')}`,
    token_source: config.tokenSource,
    tool_timeout_ms: config.toolTimeoutMs,
  })

  const client = new McpClient(config, logger)
  try {
    await client.connect()
  } catch (error) {
    logger.error('连接失败，M1 无法继续', { error: String((error as Error)?.message ?? error) })
    logger.error('排查建议', {
      http: `确认 MCP Server 在跑：$env:BWS_MCP_TRANSPORT='http'; node mcp-server/dist/src/index.js（端口 8790）`,
      stdio: '或改用 stdio：$env:BWS_AGENT_MCP_TRANSPORT=\'stdio\'',
      token: config.tokenSource === 'missing' ? '没找到 token：先跑 node tools/write-bws-config.mjs' : 'token 已加载',
    })
    process.exit(1)
  }

  const status = client.status()
  const tools = client.listTools()
  const resources = client.listResources()
  const prompts = client.listPrompts()

  logger.info('=== MCP Server 信息 ===', {
    server: `${status.server?.name}@${status.server?.version}`,
    protocol: status.server?.protocolVersion,
    capabilities: Object.keys(status.server?.capabilities ?? {}),
  })

  logger.info(`=== 工具清单（${tools.length} 个，全部来自 listTools，未写死）===`)
  for (const tool of tools) {
    logger.info(`  ${tool.readOnly ? '👁 ' : '⚠️ '}${tool.name}`, {
      title: tool.title,
      required: tool.required,
      desc: tool.description.slice(0, 60),
    })
  }

  logger.info(`=== 资源（${resources.length} 个）===`)
  for (const resource of resources) logger.info(`  ${resource.uri}`, { name: resource.name })

  logger.info(`=== 提示词（${prompts.length} 个）===`)
  for (const prompt of prompts) {
    logger.info(`  ${prompt.name}`, { args: prompt.arguments.map((argument) => argument.name) })
  }

  // 冒烟测试：调一个只读工具，证明链路真的通（不是只连上）
  if (tools.some((tool) => tool.name === 'get_bridge_status')) {
    try {
      const result = await client.callTool('get_bridge_status', {})
      logger.info('冒烟测试 get_bridge_status', {
        isError: result.isError,
        text: result.text.split('\n')[0]?.slice(0, 100),
      })
    } catch (error) {
      logger.warn('冒烟测试失败', { error: String((error as Error)?.message ?? error) })
    }
  }

  await client.disconnect()
  logger.info('M1 完成：连接与能力发现正常', {
    tools: tools.length,
    resources: resources.length,
    prompts: prompts.length,
  })
}

// 只有直接运行时才执行（被测试 import 时不要跑 main）
const isDirectRun = process.argv[1] !== undefined && process.argv[1].endsWith('index.js')
if (isDirectRun) {
  main().catch((error: unknown) => {
    process.stderr.write(`[bws-agent] 启动失败：${String((error as Error)?.stack ?? error)}\n`)
    process.exit(1)
  })
}
