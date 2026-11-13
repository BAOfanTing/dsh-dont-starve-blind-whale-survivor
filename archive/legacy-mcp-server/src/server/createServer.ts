// Tool Registry + MCP Server 组装
//
// 关键约定：**注册表是唯一事实来源**。stdio 与 Streamable HTTP 都调用 createMcpServer()，
// 未来内置 Agent 也调同一个 GameToolService（M3 再抽出来），不允许各写一套工具。

import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import type { McpServerConfig } from '../config.js'
import { BridgeClient } from '../bridge/client.js'
import { errorResult, createToolDefinitions, runTool, type ToolContext, type ToolDefinition } from '../tools/definitions.js'
import { EventDetector } from '../tools/events.js'
import { registerResources } from '../resources/gameResources.js'
import { registerPrompts } from '../prompts/gamePrompts.js'
import type { Logger } from '../utils/logger.js'

export const SERVER_NAME = 'blind-whale-survivor'
export const SERVER_VERSION = '0.3.0-m4'

export interface GameToolService {
  context: ToolContext
  tools: ToolDefinition[]
  get(name: string): ToolDefinition | undefined
}

/** 业务层：工具 + Bridge 客户端（HTTP 传输与 stdio 共用，未来 Agent 也共用） */
export function createGameToolService(config: McpServerConfig, logger: Logger): GameToolService {
  const client = new BridgeClient(config, logger)
  const events = new EventDetector({ staleAfterMs: config.toolTimeoutMs })
  const tools = createToolDefinitions()
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return {
    context: { client, config, logger, events },
    tools,
    get: (name: string) => byName.get(name),
  }
}

/** 传输层：把业务层注册成 MCP Server（每个连接/实例调一次） */
export function createMcpServer(service: GameToolService, logger: Logger): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

  for (const tool of service.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // zod 4 实现 Standard Schema，SDK 据此生成 JSON Schema 并做参数校验
        inputSchema: tool.schema as unknown as StandardSchemaWithJSON,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: !tool.readOnly,
          idempotentHint: tool.readOnly,
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        const startedAt = Date.now()
        const toolArgs = (args ?? {}) as Record<string, unknown>
        const result = await runTool(tool, toolArgs, service.context)
        logger.info('工具执行', {
          tool: tool.name,
          ok: result.isError !== true,
          ms: Date.now() - startedAt,
          args: Object.keys(toolArgs),
          ...(result.isError ? { code: (result.structuredContent.error as { code?: string } | undefined)?.code } : {}),
        })
        return result as never
      },
    )
  }

  registerResources(server, service)
  registerPrompts(server, service)

  logger.info('工具/资源/提示词已注册', {
    tools: service.tools.length,
    resources: 6,
    prompts: 4,
  })
  return server
}

/** 直接执行某个工具（内置 Agent / 测试用，绕过 MCP 协议层） */
export async function callToolDirect(service: GameToolService, name: string, args: Record<string, unknown> = {}) {
  const tool = service.get(name)
  if (!tool) return errorResult({ code: 'INVALID_ARGUMENT', message: `没有这个工具：${name}` })
  const parsed = tool.schema.safeParse(args)
  if (!parsed.success) {
    return errorResult({
      code: 'INVALID_ARGUMENT',
      message: `参数不合法：${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`,
    })
  }
  return runTool(tool, parsed.data as Record<string, unknown>, service.context)
}
