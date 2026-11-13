// MCP Client（M1）
//
// 职责：把 Phase 3 的 MCP Server 连起来，并暴露"能发现什么、能不能调"。
// **不写死工具列表** —— 全部来自 listTools()，Server 变了自动跟着变。
//
// 两种传输共用同一套逻辑（任务书要求）：
//   · http：StreamableHTTPClientTransport（默认，连已运行的 Server）
//   · stdio：StdioClientTransport（拉起子进程，用于本地/兼容性测试）
//
// 连接状态机：disconnected → connecting → connected → (error|disconnected)
// 断线后可 reconnect()；工具调用失败会被翻译成明确错误，不吞掉。

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { AgentConfig } from '../config.js'
import type { Logger } from '../utils/logger.js'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface McpToolInfo {
  name: string
  title: string | null
  description: string
  /** 原始 JSON Schema（来自 MCP Server，不做改写） */
  inputSchema: Record<string, unknown>
  /** 是否只读（来自 annotations.readOnlyHint） */
  readOnly: boolean
  /** 必填参数（从 inputSchema.required 提取） */
  required: string[]
}

export interface McpResourceInfo {
  uri: string
  name: string
  title: string | null
  description: string | null
  mimeType: string | null
}

export interface McpPromptInfo {
  name: string
  title: string | null
  description: string | null
  arguments: Array<{ name: string; description: string | null; required: boolean }>
}

export interface ServerInfo {
  name: string
  version: string
  protocolVersion: string | null
  capabilities: Record<string, unknown>
}

export interface ConnectionStatus {
  state: ConnectionState
  transport: 'http' | 'stdio'
  target: string
  server: ServerInfo | null
  toolCount: number
  resourceCount: number
  promptCount: number
  connectedAt: number | null
  lastErrorAt: number | null
  lastError: string | null
  reconnects: number
  toolCalls: number
  toolFailures: number
}

export class McpToolError extends Error {
  constructor(
    readonly code: 'MCP_NOT_CONNECTED' | 'MCP_TOOL_NOT_FOUND' | 'MCP_TOOL_FAILED' | 'MCP_TIMEOUT',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'McpToolError'
  }
}

export interface McpClientOptions {
  connectTimeoutMs?: number
  toolTimeoutMs?: number
  now?: () => number
}

export class McpClient {
  private client: Client | null = null
  private state: ConnectionState = 'disconnected'
  private server: ServerInfo | null = null
  private tools: McpToolInfo[] = []
  private resources: McpResourceInfo[] = []
  private prompts: McpPromptInfo[] = []
  private connectedAt: number | null = null
  private lastError: string | null = null
  private lastErrorAt: number | null = null
  private reconnects = 0
  private toolCalls = 0
  private toolFailures = 0
  private readonly now: () => number
  private readonly connectTimeoutMs: number
  private readonly toolTimeoutMs: number

  constructor(
    private readonly config: AgentConfig,
    private readonly logger: Logger,
    options: McpClientOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.connectTimeoutMs = options.connectTimeoutMs ?? config.connectTimeoutMs
    this.toolTimeoutMs = options.toolTimeoutMs ?? config.toolTimeoutMs
  }

  get target(): string {
    return this.config.mcpTransport === 'http' ? this.config.mcpHttpUrl : `${this.config.mcpStdioCommand} ${this.config.mcpStdioArgs.join(' ')}`
  }

  status(): ConnectionStatus {
    return {
      state: this.state,
      transport: this.config.mcpTransport,
      target: this.target,
      server: this.server,
      toolCount: this.tools.length,
      resourceCount: this.resources.length,
      promptCount: this.prompts.length,
      connectedAt: this.connectedAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      reconnects: this.reconnects,
      toolCalls: this.toolCalls,
      toolFailures: this.toolFailures,
    }
  }

  /** 建传输：http 或 stdio，逻辑只在这里分叉 */
  private createTransport() {
    if (this.config.mcpTransport === 'http') {
      if (this.config.token.length === 0) {
        throw new McpToolError('MCP_NOT_CONNECTED', 'HTTP 传输需要 token（MCP Server 会拒绝无认证请求）', {
          hint: '用 BWS_TOKEN 指定，或确认 .runtime/token.txt 存在',
        })
      }
      return new StreamableHTTPClientTransport(new URL(this.config.mcpHttpUrl), {
        requestInit: { headers: { authorization: `Bearer ${this.config.token}` } },
      })
    }
    // stdio：把 token 通过环境变量传给子进程
    return new StdioClientTransport({
      command: this.config.mcpStdioCommand,
      args: this.config.mcpStdioArgs,
      env: {
        ...process.env,
        BWS_MCP_TRANSPORT: 'stdio',
        ...(this.config.token.length > 0 ? { BWS_TOKEN: this.config.token } : {}),
      } as Record<string, string>,
    })
  }

  /** 连接 + 自动发现（工具/资源/提示词） */
  async connect(): Promise<ConnectionStatus> {
    if (this.state === 'connected') return this.status()
    this.state = 'connecting'
    const startedAt = this.now()
    try {
      const client = new Client({ name: 'blind-whale-survivor-agent', version: '0.4.0-m1' }, { capabilities: {} })
      const transport = this.createTransport()
      await this.withTimeout(client.connect(transport), this.connectTimeoutMs, 'MCP 连接超时')
      this.client = client
      this.state = 'connected'
      this.connectedAt = this.now()
      this.lastError = null

      const version = client.getServerVersion()
      this.server = {
        name: version?.name ?? 'unknown',
        version: version?.version ?? 'unknown',
        protocolVersion: (client.getNegotiatedProtocolVersion?.() as string | undefined) ?? null,
        capabilities: (client.getServerCapabilities?.() ?? {}) as Record<string, unknown>,
      }
      this.logger.info('已连接 MCP Server', {
        transport: this.config.mcpTransport,
        target: this.target,
        server: `${this.server.name}@${this.server.version}`,
        protocol: this.server.protocolVersion,
        ms: this.now() - startedAt,
      })

      await this.refreshCatalog()
      return this.status()
    } catch (error) {
      this.state = 'error'
      this.lastError = String((error as Error)?.message ?? error)
      this.lastErrorAt = this.now()
      this.client = null
      this.logger.error('连接 MCP Server 失败', { target: this.target, error: this.lastError })
      throw error
    }
  }

  /** 重新连接（先断开再连），用于断线恢复 */
  async reconnect(): Promise<ConnectionStatus> {
    await this.disconnect()
    this.reconnects += 1
    this.logger.info('尝试重连 MCP Server', { attempt: this.reconnects })
    return this.connect()
  }

  async disconnect(): Promise<void> {
    if (this.client !== null) {
      try {
        await this.client.close()
      } catch (error) {
        this.logger.warn('关闭 MCP 连接时出错', { error: String((error as Error)?.message ?? error) })
      }
    }
    this.client = null
    this.state = 'disconnected'
    this.tools = []
    this.resources = []
    this.prompts = []
    this.server = null
  }

  /**
   * 刷新工具/资源/提示词清单。
   * Server 端工具变了（重新部署/换版本）就调这个，不写死列表。
   */
  async refreshCatalog(): Promise<{ tools: number; resources: number; prompts: number }> {
    const client = this.requireClient()

    const [toolsResult, resourcesResult, promptsResult] = await Promise.all([
      client.listTools().catch((error: unknown) => {
        this.logger.warn('listTools 失败', { error: String((error as Error)?.message ?? error) })
        return { tools: [] as unknown[] }
      }),
      client.listResources().catch((error: unknown) => {
        this.logger.warn('listResources 失败（可能 Server 未声明该能力）', { error: String((error as Error)?.message ?? error) })
        return { resources: [] as unknown[] }
      }),
      client.listPrompts().catch((error: unknown) => {
        this.logger.warn('listPrompts 失败（可能 Server 未声明该能力）', { error: String((error as Error)?.message ?? error) })
        return { prompts: [] as unknown[] }
      }),
    ])

    this.tools = (toolsResult.tools as Array<Record<string, any>>).map((tool) => {
      const schema = (tool.inputSchema ?? {}) as Record<string, unknown>
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
      return {
        name: String(tool.name),
        title: typeof tool.title === 'string' ? tool.title : null,
        description: String(tool.description ?? ''),
        inputSchema: schema,
        readOnly: tool.annotations?.readOnlyHint === true,
        required,
      }
    })
    this.resources = (resourcesResult.resources as Array<Record<string, any>>).map((resource) => ({
      uri: String(resource.uri),
      name: String(resource.name ?? ''),
      title: typeof resource.title === 'string' ? resource.title : null,
      description: typeof resource.description === 'string' ? resource.description : null,
      mimeType: typeof resource.mimeType === 'string' ? resource.mimeType : null,
    }))
    this.prompts = (promptsResult.prompts as Array<Record<string, any>>).map((prompt) => ({
      name: String(prompt.name),
      title: typeof prompt.title === 'string' ? prompt.title : null,
      description: typeof prompt.description === 'string' ? prompt.description : null,
      arguments: Array.isArray(prompt.arguments)
        ? (prompt.arguments as Array<Record<string, any>>).map((argument) => ({
            name: String(argument.name),
            description: typeof argument.description === 'string' ? argument.description : null,
            required: argument.required === true,
          }))
        : [],
    }))

    this.logger.info('能力已发现', { tools: this.tools.length, resources: this.resources.length, prompts: this.prompts.length })
    return { tools: this.tools.length, resources: this.resources.length, prompts: this.prompts.length }
  }

  listTools(): McpToolInfo[] {
    return [...this.tools]
  }

  findTool(name: string): McpToolInfo | undefined {
    return this.tools.find((tool) => tool.name === name)
  }

  listResources(): McpResourceInfo[] {
    return [...this.resources]
  }

  listPrompts(): McpPromptInfo[] {
    return [...this.prompts]
  }

  /** 调工具：超时 + 错误分类，返回值保留 MCP 原始结构 */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<{
    isError: boolean
    text: string
    structuredContent: Record<string, unknown> | null
    raw: unknown
  }> {
    const client = this.requireClient()
    if (this.findTool(name) === undefined) {
      // 未知工具也算一次失败的调用尝试（统计要如实反映"AI 试图调了不该调的东西"）
      this.toolCalls += 1
      this.toolFailures += 1
      throw new McpToolError('MCP_TOOL_NOT_FOUND', `MCP Server 没有这个工具：${name}`, {
        available: this.tools.map((tool) => tool.name),
      })
    }

    this.toolCalls += 1
    const startedAt = this.now()
    try {
      const result = (await this.withTimeout(
        client.callTool({ name, arguments: args }),
        this.toolTimeoutMs,
        `工具 ${name} 调用超时（>${this.toolTimeoutMs}ms）`,
      )) as {
        content?: Array<{ type: string; text?: string }>
        structuredContent?: Record<string, unknown>
        isError?: boolean
      }
      const isError = result.isError === true
      if (isError) this.toolFailures += 1
      const text = String(result.content?.[0]?.text ?? '')
      this.logger.debug('工具调用完成', { tool: name, isError, ms: this.now() - startedAt })
      return { isError, text, structuredContent: result.structuredContent ?? null, raw: result }
    } catch (error) {
      this.toolFailures += 1
      if (error instanceof McpToolError) throw error
      throw new McpToolError('MCP_TOOL_FAILED', `工具 ${name} 调用失败：${String((error as Error)?.message ?? error)}`, {
        tool: name,
        ms: this.now() - startedAt,
      })
    }
  }

  async readResource(uri: string): Promise<{ uri: string; mimeType: string | null; text: string }> {
    const client = this.requireClient()
    const result = (await this.withTimeout(client.readResource({ uri }), this.toolTimeoutMs, `读取资源 ${uri} 超时`)) as {
      contents: Array<{ uri: string; mimeType?: string; text?: string }>
    }
    const first = result.contents[0]
    if (!first) throw new McpToolError('MCP_TOOL_FAILED', `资源 ${uri} 没有返回内容`)
    return { uri: first.uri, mimeType: first.mimeType ?? null, text: String(first.text ?? '') }
  }

  async getPrompt(name: string, args: Record<string, string> = {}): Promise<string> {
    const client = this.requireClient()
    const result = (await this.withTimeout(client.getPrompt({ name, arguments: args }), this.toolTimeoutMs, `获取提示词 ${name} 超时`)) as {
      messages: Array<{ content?: { type: string; text?: string } }>
    }
    return String(result.messages[0]?.content?.text ?? '')
  }

  private requireClient(): Client {
    if (this.client === null || this.state !== 'connected') {
      throw new McpToolError('MCP_NOT_CONNECTED', '还没连接 MCP Server', {
        state: this.state,
        target: this.target,
        hint: '先调用 connect()，或检查 MCP Server 是否在运行',
      })
    }
    return this.client
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new McpToolError('MCP_TIMEOUT', message, { timeout_ms: timeoutMs })), timeoutMs)
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }
}
