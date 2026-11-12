// Agent 配置（M1）
//
// 只做 M1 需要的部分：MCP 连接（HTTP + stdio）、日志、超时。
// LLM / Agent Loop 的配置等 M2/M4 再加，避免提前堆无用字段。

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** dist/src/config.js → 仓库根 */
export const REPO_ROOT = resolve(HERE, '..', '..', '..')

export type McpTransportKind = 'http' | 'stdio'

export interface AgentConfig {
  /** 连接 MCP Server 的方式：http（默认，走 Streamable HTTP）或 stdio（拉起子进程） */
  mcpTransport: McpTransportKind
  /** Streamable HTTP 地址 */
  mcpHttpUrl: string
  /** stdio 模式：启动 MCP Server 的命令与参数 */
  mcpStdioCommand: string
  mcpStdioArgs: string[]
  /** 共享 token（HTTP 传输的 Bearer；stdio 模式通过 env 传给子进程） */
  token: string
  tokenSource: 'env' | 'file' | 'missing'
  /** MCP 工具调用超时 */
  toolTimeoutMs: number
  /** 连接超时 */
  connectTimeoutMs: number
  /** 日志级别 */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** Agent HTTP API（M6 才用，M1 先读进来） */
  apiHost: string
  apiPort: number

  // ───────────── LLM Provider（M2）─────────────
  /** deepseek：官方 API 约定（thinking 走 extra_body、必须回传 reasoning_content）；openai-compatible：只发标准字段 */
  llmPreset: 'deepseek' | 'openai-compatible'
  llmBaseUrl: string
  llmApiKey: string
  llmModel: string
  /** 默认是否开思考（仅 deepseek preset 生效） */
  llmThinking: boolean
  llmReasoningEffort: 'low' | 'high' | 'max'
  llmMaxTokens: number
  llmTemperature: number | null
  llmTimeoutMs: number
  llmMaxRetries: number
  llmContextLength: number | null
  llmMaxOutputTokens: number | null
}

export function resolveToken(env: NodeJS.ProcessEnv = process.env): { token: string; source: AgentConfig['tokenSource'] } {
  if (env.BWS_TOKEN && env.BWS_TOKEN.length > 0) return { token: env.BWS_TOKEN, source: 'env' }
  const file = env.BWS_TOKEN_FILE
    ? isAbsolute(env.BWS_TOKEN_FILE)
      ? env.BWS_TOKEN_FILE
      : resolve(REPO_ROOT, env.BWS_TOKEN_FILE)
    : resolve(REPO_ROOT, '.runtime/token.txt')
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim()
    if (token.length > 0) return { token, source: 'file' }
  }
  return { token: '', source: 'missing' }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const { token, source } = resolveToken(env)
  const transport = (env.BWS_AGENT_MCP_TRANSPORT ?? 'http').toLowerCase() === 'stdio' ? 'stdio' : 'http'
  const mcpServerEntry = resolve(REPO_ROOT, 'mcp-server', 'dist', 'src', 'index.js')

  const logLevel = (env.BWS_AGENT_LOG ?? 'info').toLowerCase()
  return {
    mcpTransport: transport,
    mcpHttpUrl: (env.BWS_MCP_URL ?? 'http://127.0.0.1:8790').replace(/\/+$/, ''),
    mcpStdioCommand: env.BWS_MCP_STDIO_COMMAND ?? process.execPath,
    mcpStdioArgs: env.BWS_MCP_STDIO_ARGS
      ? env.BWS_MCP_STDIO_ARGS.split(' ').filter((part) => part.length > 0)
      : [mcpServerEntry],
    token,
    tokenSource: source,
    toolTimeoutMs: Number(env.BWS_AGENT_TOOL_TIMEOUT_MS ?? 15000),
    connectTimeoutMs: Number(env.BWS_AGENT_CONNECT_TIMEOUT_MS ?? 10000),
    logLevel: (['debug', 'info', 'warn', 'error'] as const).includes(logLevel as never)
      ? (logLevel as AgentConfig['logLevel'])
      : 'info',
    apiHost: env.BWS_AGENT_HOST ?? '127.0.0.1',
    apiPort: Number(env.BWS_AGENT_PORT ?? 8791),

    // ── LLM ──
    llmPreset: (env.BWS_LLM_PRESET ?? 'deepseek').toLowerCase() === 'openai-compatible' ? 'openai-compatible' : 'deepseek',
    llmBaseUrl: (env.BWS_LLM_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
    llmApiKey: env.BWS_LLM_API_KEY ?? env.DEEPSEEK_API_KEY ?? env.OPENAI_API_KEY ?? '',
    // 模型名不写死：默认值只是方便，任何值都能覆盖
    llmModel: env.BWS_LLM_MODEL ?? env.DEEPSEEK_MODEL ?? 'deepseek-flash',
    llmThinking: (env.BWS_LLM_THINKING ?? 'true').toLowerCase() !== 'false',
    llmReasoningEffort: ((): 'low' | 'high' | 'max' => {
      const raw = (env.BWS_LLM_REASONING_EFFORT ?? 'high').toLowerCase()
      return raw === 'low' || raw === 'max' ? raw : 'high'
    })(),
    llmMaxTokens: Number(env.BWS_LLM_MAX_TOKENS ?? 2048),
    llmTemperature: env.BWS_LLM_TEMPERATURE === undefined ? null : Number(env.BWS_LLM_TEMPERATURE),
    llmTimeoutMs: Number(env.BWS_LLM_TIMEOUT_MS ?? 60000),
    llmMaxRetries: Number(env.BWS_LLM_MAX_RETRIES ?? 2),
    llmContextLength: env.BWS_LLM_CONTEXT_LENGTH === undefined ? null : Number(env.BWS_LLM_CONTEXT_LENGTH),
    llmMaxOutputTokens: env.BWS_LLM_MAX_OUTPUT_TOKENS === undefined ? null : Number(env.BWS_LLM_MAX_OUTPUT_TOKENS),
  }
}
