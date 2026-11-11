// 配置：日志目录、要跟的文件、端口、轮询间隔、合并窗口
//
// 全部可以用环境变量覆盖，方便以后塞进插件里：
//   BWS_LOG_DIR      存档日志目录（默认自动在 OneDrive/文档 下找 Klei\DoNotStarveTogether）
//   BWS_LOG_FILES    逗号分隔的日志文件名（默认 master_server_log.txt,caves_server_log.txt）
//   BWS_INCLUDE_CLIENT=1 把 client_log.txt 也跟（默认不跟：客户端数据不权威）
//   BWS_PORT         HTTP 端口（默认 18081）
//   BWS_HOST         监听地址（默认 127.0.0.1，只本机）
//   BWS_POLL_MS      轮询日志的间隔毫秒（默认 300）
//   BWS_MAX_TICK_GAP state 与 nearby 配对允许的最大 tick 差（默认 3）
//   BWS_SCHEMA       状态契约路径（默认仓库里的 schema/state.schema.json）

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface BridgeConfig {
  logDir: string
  logFiles: string[]
  host: string
  port: number
  pollMs: number
  maxTickGap: number
  schemaPath: string
}

const HERE = dirname(fileURLToPath(import.meta.url))

/** Klei 存档目录的常见位置（OneDrive 会把“文档”搬走，所以都试一遍） */
export function defaultLogDirCandidates(home = homedir()): string[] {
  const docs = ['Documents', 'OneDrive/Documents', 'OneDrive/文档', 'OneDrive/文檔', '文档', '文檔']
  const out: string[] = []
  for (const doc of docs) {
    out.push(join(home, ...doc.split('/'), 'Klei', 'DoNotStarveTogether'))
  }
  for (const env of [process.env.OneDrive, process.env.OneDriveConsumer]) {
    if (env) out.push(join(env, 'Klei', 'DoNotStarveTogether'))
  }
  return out
}

export function resolveLogDir(env = process.env, exists = existsSync): string {
  if (env.BWS_LOG_DIR && exists(env.BWS_LOG_DIR)) return env.BWS_LOG_DIR
  const found = defaultLogDirCandidates().find((dir) => exists(dir))
  if (found) return found
  // 找不到就返回第一个候选，让上层报清楚的错误（而不是抛在启动里）
  return defaultLogDirCandidates()[0] ?? ''
}

export function resolveSchemaPath(env = process.env, exists = existsSync): string {
  if (env.BWS_SCHEMA) return env.BWS_SCHEMA
  // dist/src/config.js → 仓库根
  const fromRepo = resolve(HERE, '..', '..', 'schema', 'state.schema.json')
  if (exists(fromRepo)) return fromRepo
  return resolve(HERE, '..', '..', '..', 'schema', 'state.schema.json')
}

export function loadConfig(env = process.env): BridgeConfig {
  const files = env.BWS_LOG_FILES
    ? env.BWS_LOG_FILES.split(',').map((s) => s.trim()).filter(Boolean)
    : ['master_server_log.txt', 'caves_server_log.txt']
  if (env.BWS_INCLUDE_CLIENT === '1' && !files.includes('client_log.txt')) files.push('client_log.txt')

  return {
    logDir: resolveLogDir(env),
    logFiles: files,
    host: env.BWS_HOST ?? '127.0.0.1',
    port: Number(env.BWS_PORT ?? 18081),
    pollMs: Math.max(50, Number(env.BWS_POLL_MS ?? 300)),
    maxTickGap: Math.max(0, Number(env.BWS_MAX_TICK_GAP ?? 3)),
    schemaPath: resolveSchemaPath(env),
  }
}
