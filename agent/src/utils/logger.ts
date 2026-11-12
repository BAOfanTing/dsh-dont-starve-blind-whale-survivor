// 日志：分级 + token 脱敏（沿用 Phase 2/3 的风格，便于串起来排查）

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
  lines(): string[]
}

export interface LoggerOptions {
  level?: LogLevel
  secrets?: string[]
  sink?: (line: string) => void
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info'
  const secrets = (options.secrets ?? []).filter((secret) => secret.length > 0)
  const sink = options.sink ?? ((line: string) => process.stderr.write(line + '\n'))
  const history: string[] = []

  const redact = (text: string): string => {
    let out = text
    for (const secret of secrets) out = out.split(secret).join('***')
    return out
  }

  const emit = (kind: LogLevel, message: string, extra?: Record<string, unknown>) => {
    if (ORDER[kind] < ORDER[level]) return
    const stamp = new Date().toISOString()
    const tail = extra && Object.keys(extra).length > 0 ? ' ' + redact(JSON.stringify(extra)) : ''
    const line = `[${stamp}] ${kind.toUpperCase()} [bws-agent] ${redact(message)}${tail}`
    history.push(line)
    sink(line)
  }

  return {
    debug: (message, extra) => emit('debug', message, extra),
    info: (message, extra) => emit('info', message, extra),
    warn: (message, extra) => emit('warn', message, extra),
    error: (message, extra) => emit('error', message, extra),
    lines: () => [...history],
  }
}
