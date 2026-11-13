// MCP Server 配置（全部可环境变量覆盖）
//
// 只有三种使用方式共享同一套业务逻辑：stdio / Streamable HTTP / 内置 Agent，
// 所以配置在这里集中解析，任何传输层都不自己读环境变量。

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** dist/src/config.js → 仓库根 */
export const REPO_ROOT = resolve(HERE, '..', '..', '..')

export type TransportKind = 'stdio' | 'http'

export interface McpServerConfig {
  /** stdio（默认，给本地 MCP 客户端）或 http（Streamable HTTP，给 DSH/内置 Agent） */
  transport: TransportKind
  /** Game Bridge 地址 */
  bridgeUrl: string
  /** 共享 token（与游戏端、Bridge 用的是同一个） */
  token: string
  tokenSource: 'env' | 'file' | 'missing'
  /** 单个工具的总超时（毫秒） */
  toolTimeoutMs: number
  /** HTTP 传输监听（M5 才真正启用） */
  httpHost: string
  httpPort: number
  /** 日志级别 */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export function resolveToken(env: NodeJS.ProcessEnv = process.env): { token: string; source: McpServerConfig['tokenSource'] } {
  if (env.BWS_TOKEN && env.BWS_TOKEN.length > 0) return { token: env.BWS_TOKEN, source: 'env' }
  const file = env.BWS_TOKEN_FILE ? (isAbsolute(env.BWS_TOKEN_FILE) ? env.BWS_TOKEN_FILE : resolve(REPO_ROOT, env.BWS_TOKEN_FILE)) : resolve(REPO_ROOT, '.runtime/token.txt')
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim()
    if (token.length > 0) return { token, source: 'file' }
  }
  return { token: '', source: 'missing' }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  const { token, source } = resolveToken(env)
  const transport = (env.BWS_MCP_TRANSPORT ?? 'stdio').toLowerCase() === 'http' ? 'http' : 'stdio'
  return {
    transport,
    bridgeUrl: (env.BWS_BRIDGE_URL ?? 'http://127.0.0.1:18788').replace(/\/+$/, ''),
    token,
    tokenSource: source,
    toolTimeoutMs: Number(env.BWS_TOOL_TIMEOUT_MS ?? 5000),
    httpHost: env.BWS_MCP_HOST ?? '127.0.0.1',
    httpPort: Number(env.BWS_MCP_PORT ?? 8790),
    logLevel: (['debug', 'info', 'warn', 'error'] as const).includes((env.BWS_MCP_LOG ?? 'info') as never)
      ? ((env.BWS_MCP_LOG ?? 'info') as McpServerConfig['logLevel'])
      : 'info',
  }
}
