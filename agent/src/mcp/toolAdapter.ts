// Tool Adapter（M3）：MCP 工具 → Function Calling 定义 + 参数校验 + 只读白名单
//
// 三个安全边界（任务书 §7 与 §13 要求，**必须程序层执行，不能只靠提示词**）：
//   1. 白名单：只允许 12 个只读工具；不在名单里的工具**连定义都不给模型**，调用也直接拒。
//   2. 参数校验：模型给的 arguments 是字符串，必须 JSON.parse 成功 + 通过 JSON Schema 校验才能执行。
//   3. 约束保留：MCP Server 的 minimum/maximum/enum/maxItems 等原样带进 Function Calling 定义，
//      让模型知道边界；校验时用同一份 schema（ajv），模型越界直接拒绝而不是让工具层报错。
//
// 工具结果 → role:tool 消息：保留 tool_call_id，内容压成模型能读的紧凑 JSON（避免超长）。

import { createRequire } from 'node:module'
import type { ValidateFunction } from 'ajv'

// ajv v8 是 CJS，NodeNext + ESM 下类型/构造互操作很别扭；
// 用 createRequire 拿真实构造函数，避免 ESM 类型解析问题（运行时也确定拿得到）。
const require_ = createRequire(import.meta.url)
type AjvInstance = {
  compile: (schema: unknown) => ValidateFunction
}
type AjvConstructor = new (options?: Record<string, unknown>) => AjvInstance
const Ajv = require_('ajv') as AjvConstructor
import type { McpClient, McpToolInfo } from '../mcp/client.js'
import type { LLMToolDefinition } from '../llm/types.js'
import type { Logger } from '../utils/logger.js'

/** 只读白名单（任务书 §13 列出的 12 个；以 Phase 3 实际注册的工具为准） */
export const READ_ONLY_ALLOWLIST = [
  'get_game_status',
  'get_bridge_status',
  'get_player_status',
  'get_inventory',
  'get_world_status',
  'get_nearby_entities',
  'get_nearby_resources',
  'get_nearby_threats',
  'get_base_status',
  'refresh_game_state',
  'get_recent_events',
  'get_command_result',
] as const

export type AllowedToolName = (typeof READ_ONLY_ALLOWLIST)[number]

/** 显式禁止的动作类工具名（防止以后 MCP Server 加了写操作工具被悄悄放行） */
export const FORBIDDEN_TOOL_PATTERNS = [
  /^move/i,
  /^attack/i,
  /^chop/i,
  /^mine/i,
  /^eat/i,
  /^craft/i,
  /^build/i,
  /^drop/i,
  /^kill/i,
  /^teleport/i,
  /^exec/i,
  /^shell/i,
  /^lua/i,
]

export type AdapterErrorCode =
  | 'TOOL_NOT_ALLOWED'
  | 'TOOL_NOT_FOUND'
  | 'INVALID_ARGUMENTS_JSON'
  | 'INVALID_ARGUMENTS_SCHEMA'
  | 'TOOL_CALL_FAILED'

export class ToolAdapterError extends Error {
  constructor(
    readonly code: AdapterErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'ToolAdapterError'
  }
}

export interface AdaptedTool {
  /** MCP 工具名（也是 Function Calling 的 function.name） */
  name: string
  /** 给模型的 Function Calling 定义 */
  definition: LLMToolDefinition
  /** 原始 MCP 信息 */
  mcp: McpToolInfo
  /** 编译后的校验器（懒编译） */
  validate?: ValidateFunction
}

export interface ToolCallOutcome {
  toolCallId: string
  name: string
  ok: boolean
  /** 给模型读的文本（成功=数据摘要；失败=错误说明） */
  content: string
  /** 结构化结果（成功时的 structuredContent；失败时的 error） */
  structured: Record<string, unknown> | null
  elapsedMs: number
  errorCode?: AdapterErrorCode | string
}

export interface ToolAdapterOptions {
  /** 覆盖白名单（测试用）；不传用 READ_ONLY_ALLOWLIST */
  allowlist?: readonly string[]
  /** 工具结果最大字符数（超过截断，避免把上下文塞爆） */
  maxResultChars?: number
  /** 单个工具的额外超时（默认用 McpClient 的） */
  toolTimeoutMs?: number
}

export class ToolAdapter {
  private readonly ajv: AjvInstance
  private readonly adapted = new Map<string, AdaptedTool>()
  private readonly allowlist: Set<string>
  private readonly maxResultChars: number
  /** 调用统计（给 API 展示用） */
  private readonly stats = { calls: 0, blocked: 0, invalidArgs: 0, failures: 0 }

  constructor(
    private readonly client: McpClient,
    private readonly logger: Logger,
    options: ToolAdapterOptions = {},
  ) {
    this.allowlist = new Set(options.allowlist ?? READ_ONLY_ALLOWLIST)
    this.maxResultChars = options.maxResultChars ?? 4000
    // strict: false —— MCP Server 的 schema 里有 $schema/default 等字段，ajv 严格模式会报未知关键字。
    // validateSchema: false —— MCP Server 声明 $schema 为 draft 2020-12，而 ajv 默认实例只认 draft-07，
    // 直接编译会报 "no schema with key or ref https://json-schema.org/draft/2020-12/schema"。
    // 我们实际用到的关键字（type/properties/required/minimum/maximum/enum/maxItems/minLength）
    // 在 draft-07 语义一致，所以剥掉 $schema 用默认方言校验是安全的（见 compileSchema）。
    this.ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false, useDefaults: true, validateSchema: false })
  }

  /** 剥掉 $schema 声明再编译（避免 draft 版本不匹配导致编译失败） */
  private compileSchema(schema: Record<string, unknown>): ValidateFunction {
    const { $schema: _ignored, ...rest } = schema
    return this.ajv.compile(rest)
  }

  /** 从 MCP Client 的当前工具清单重建（MCP Server 变了就再调一次） */
  refresh(): { adapted: number; skipped: Array<{ name: string; reason: string }> } {
    this.adapted.clear()
    const skipped: Array<{ name: string; reason: string }> = []

    for (const tool of this.client.listTools()) {
      const verdict = this.checkAllowed(tool.name)
      if (!verdict.allowed) {
        skipped.push({ name: tool.name, reason: verdict.reason })
        continue
      }
      const schema = tool.inputSchema
      let validate: ValidateFunction | undefined
      try {
        validate = this.compileSchema(schema)
      } catch (error) {
        // schema 编译不了就不给模型用（避免"给了定义但校验不了"的危险状态）
        skipped.push({ name: tool.name, reason: `schema 编译失败：${String((error as Error)?.message ?? error)}` })
        continue
      }
      this.adapted.set(tool.name, {
        name: tool.name,
        mcp: tool,
        definition: {
          type: 'function',
          function: {
            name: tool.name,
            description: this.buildDescription(tool),
            // 原样带上 MCP Server 的 schema（约束保留：minimum/maximum/enum/maxItems/minLength…）
            parameters: schema,
          },
        },
        validate,
      })
    }

    const allowed = [...this.adapted.keys()]
    this.logger.info('Tool Adapter 就绪', {
      adapted: allowed.length,
      allowed,
      skipped: skipped.map((item) => item.name),
    })
    return { adapted: allowed.length, skipped }
  }

  /** 白名单 + 危险名双重检查 */
  private checkAllowed(name: string): { allowed: boolean; reason: string } {
    if (!this.allowlist.has(name)) {
      return { allowed: false, reason: '不在只读白名单内' }
    }
    for (const pattern of FORBIDDEN_TOOL_PATTERNS) {
      if (pattern.test(name)) {
        return { allowed: false, reason: `命中危险动作模式 ${pattern.source}` }
      }
    }
    return { allowed: true, reason: 'ok' }
  }

  /** 描述里补上"只读"与必填参数，帮模型少犯错 */
  private buildDescription(tool: McpToolInfo): string {
    const parts = [tool.description]
    if (tool.required.length > 0) parts.push(`必填参数：${tool.required.join(', ')}`)
    parts.push('（只读工具，不会修改游戏状态）')
    return parts.join(' ').slice(0, 900)
  }

  /** 给 LLM 的工具定义（只包含白名单内的） */
  toolDefinitions(): LLMToolDefinition[] {
    return [...this.adapted.values()].map((item) => item.definition)
  }

  /** 已适配的工具名 */
  names(): string[] {
    return [...this.adapted.keys()]
  }

  get(name: string): AdaptedTool | undefined {
    return this.adapted.get(name)
  }

  adapterStats(): { adapted: number; calls: number; blocked: number; invalidArgs: number; failures: number } {
    return {
      adapted: this.adapted.size,
      calls: this.stats.calls,
      blocked: this.stats.blocked,
      invalidArgs: this.stats.invalidArgs,
      failures: this.stats.failures,
    }
  }

  /**
   * 解析 + 校验模型给的 arguments。
   * **这是安全边界**：任何一步失败都必须拒绝执行。
   */
  parseArguments(name: string, rawArguments: string): Record<string, unknown> {
    const tool = this.adapted.get(name)
    if (!tool) {
      // 不在白名单 → 明确拒绝（不区分"不存在"和"被禁"，避免模型反复试探）
      const verdict = this.checkAllowed(name)
      throw new ToolAdapterError('TOOL_NOT_ALLOWED', `工具 ${name} 不被允许：${verdict.reason}`, {
        allowed: [...this.adapted.keys()],
      })
    }

    // 1) 必须能 JSON.parse
    let parsed: unknown
    const text = rawArguments.trim().length === 0 ? '{}' : rawArguments
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new ToolAdapterError('INVALID_ARGUMENTS_JSON', `工具 ${name} 的 arguments 不是合法 JSON：${String((error as Error)?.message ?? error)}`, {
        raw: rawArguments.slice(0, 300),
      })
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ToolAdapterError('INVALID_ARGUMENTS_JSON', `工具 ${name} 的 arguments 必须是 JSON 对象`, {
        got: Array.isArray(parsed) ? 'array' : typeof parsed,
      })
    }

    // 2) 必须通过 JSON Schema 校验（含 min/max/enum/maxItems）
    const validate = tool.validate
    if (validate !== undefined) {
      const valid = validate(parsed)
      if (!valid) {
        const issues = (validate.errors ?? []).map((error) => {
          const path = error.instancePath.length > 0 ? error.instancePath : '(root)'
          return `${path} ${error.message ?? ''}`.trim()
        })
        throw new ToolAdapterError('INVALID_ARGUMENTS_SCHEMA', `工具 ${name} 的参数不合法：${issues.join('; ')}`, {
          errors: validate.errors ?? [],
          raw: parsed,
        })
      }
    }
    return parsed as Record<string, unknown>
  }

  /**
   * 执行一次工具调用（含校验 + 结果压缩）。
   * 注意：**不做重试** —— 工具调用可能带副作用（虽然本阶段只读），重试语义不安全。
   */
  async executeToolCall(call: { id: string; name: string; arguments: string }): Promise<ToolCallOutcome> {
    const startedAt = Date.now()
    this.stats.calls += 1

    let args: Record<string, unknown>
    try {
      args = this.parseArguments(call.name, call.arguments)
    } catch (error) {
      if (error instanceof ToolAdapterError) {
        if (error.code === 'TOOL_NOT_ALLOWED') this.stats.blocked += 1
        else this.stats.invalidArgs += 1
        this.logger.warn('工具调用被拒绝', { tool: call.name, code: error.code, message: error.message.slice(0, 160) })
        return {
          toolCallId: call.id,
          name: call.name,
          ok: false,
          content: `[${error.code}] ${error.message}`,
          structured: { ok: false, error: { code: error.code, message: error.message, detail: error.detail ?? null } },
          elapsedMs: Date.now() - startedAt,
          errorCode: error.code,
        }
      }
      throw error
    }

    try {
      const result = await this.client.callTool(call.name, args)
      const content = this.compress(result.text, result.structuredContent)
      if (result.isError) this.stats.failures += 1
      return {
        toolCallId: call.id,
        name: call.name,
        ok: !result.isError,
        content,
        structured: result.structuredContent,
        elapsedMs: Date.now() - startedAt,
        ...(result.isError
          ? { errorCode: String((result.structuredContent?.error as { code?: string } | undefined)?.code ?? 'TOOL_ERROR') }
          : {}),
      }
    } catch (error) {
      this.stats.failures += 1
      const message = String((error as Error)?.message ?? error)
      this.logger.error('工具执行失败', { tool: call.name, error: message.slice(0, 200) })
      return {
        toolCallId: call.id,
        name: call.name,
        ok: false,
        content: `[TOOL_CALL_FAILED] ${message}`,
        structured: { ok: false, error: { code: 'TOOL_CALL_FAILED', message } },
        elapsedMs: Date.now() - startedAt,
        errorCode: 'TOOL_CALL_FAILED',
      }
    }
  }

  /**
   * 把工具结果压成模型能读的紧凑文本。
   * 优先用 structuredContent（结构化、字段少），其次原始文本；超长截断并说明。
   */
  private compress(text: string, structured: Record<string, unknown> | null): string {
    let payload: string
    if (structured !== null) {
      // 去掉体积大的冗余字段（raw_snapshot 等），模型通常用不到
      const trimmed = { ...structured }
      delete trimmed.raw_snapshot
      try {
        payload = JSON.stringify(trimmed)
      } catch {
        payload = text
      }
    } else {
      payload = text
    }
    if (payload.length <= this.maxResultChars) return payload
    return `${payload.slice(0, this.maxResultChars)}…（已截断，原长 ${payload.length} 字符）`
  }
}

/** 工具结果 → LLM 的 role:tool 消息（保留 tool_call_id） */
export function toToolMessage(outcome: ToolCallOutcome): {
  role: 'tool'
  content: string
  toolCallId: string
  name: string
} {
  return {
    role: 'tool',
    content: outcome.content,
    toolCallId: outcome.toolCallId,
    name: outcome.name,
  }
}
