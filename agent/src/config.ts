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
  }
}
