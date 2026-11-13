// 分级日志：INFO / WARN / ERROR
//
// 要求：token 不能出现在普通日志里。所有日志走这里，统一做一次脱敏（把配置里的 token 换成 ***）。

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
  /** 记录过的所有行（测试用来断言“日志里没有 token”） */
  lines(): string[]
}

export interface LoggerOptions {
  /** 需要脱敏的字符串（通常是 token） */
  secrets?: string[]
  /** 额外输出目标，默认 console.log */
  sink?: (line: string) => void
  /** 低于这个级别不输出（默认 INFO 全输出） */
  minLevel?: LogLevel
}

const ORDER: Record<LogLevel, number> = { INFO: 0, WARN: 1, ERROR: 2 }

export function createLogger(options: LoggerOptions = {}): Logger {
  const secrets = (options.secrets ?? []).filter((s) => s.length > 0)
  const sink = options.sink ?? ((line: string) => console.log(line))
  const minLevel = options.minLevel ?? 'INFO'
  const history: string[] = []

  const redact = (text: string): string => {
    let out = text
    for (const secret of secrets) out = out.split(secret).join('***')
    return out
  }

  const emit = (level: LogLevel, message: string, extra?: Record<string, unknown>) => {
    if (ORDER[level] < ORDER[minLevel]) return
    const stamp = new Date().toISOString()
    const tail = extra && Object.keys(extra).length > 0 ? ' ' + redact(JSON.stringify(extra)) : ''
    const line = `[${stamp}] ${level} ${redact(message)}${tail}`
    history.push(line)
    sink(line)
  }

  return {
    info: (message, extra) => emit('INFO', message, extra),
    warn: (message, extra) => emit('WARN', message, extra),
    error: (message, extra) => emit('ERROR', message, extra),
    lines: () => [...history],
  }
}
