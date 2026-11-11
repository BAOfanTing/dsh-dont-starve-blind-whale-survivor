// 日志：**只能写 stderr**
//
// stdio 传输下 stdout 是 MCP 协议专用通道，任何一行多余输出都会破坏 JSON-RPC。
// 所以这里统一走 stderr，并且带上级别与时间戳。

import type { McpServerConfig } from '../config.js'

const ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
  /** 测试断言用：拿到的历史行 */
  lines(): string[]
}

export interface LoggerOptions {
  level?: McpServerConfig['logLevel']
  /** 需要脱敏的字符串（token） */
  secrets?: string[]
  sink?: (line: string) => void
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info'
  const secrets = (options.secrets ?? []).filter((s) => s.length > 0)
  // 默认写 stderr：stdout 留给 MCP 协议
  const sink = options.sink ?? ((line: string) => process.stderr.write(line + '\n'))
  const history: string[] = []

  const redact = (text: string): string => {
    let out = text
    for (const secret of secrets) out = out.split(secret).join('***')
    return out
  }

  const emit = (kind: keyof typeof ORDER, message: string, extra?: Record<string, unknown>) => {
    if (ORDER[kind] < ORDER[level]) return
    const stamp = new Date().toISOString()
    const tail = extra && Object.keys(extra).length > 0 ? ' ' + redact(JSON.stringify(extra)) : ''
    const line = `[${stamp}] ${kind.toUpperCase()} [bws-mcp] ${redact(message)}${tail}`
    history.push(line)
    sink(line)
  }

  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
    lines: () => [...history],
  }
}
