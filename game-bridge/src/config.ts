// Phase 2 · Bridge 配置
//
// 规矩（来自任务书）：
//   · 只监听 127.0.0.1；
//   · 默认端口 18788（原定 8788 被本机其它进程占用）；
//   · 随机共享 Token（可用环境变量覆盖，方便联调）；
//   · 请求体有上限；
//   · 协议版本 protocol_version = "1.0"。
//
// 全部可用环境变量覆盖：
//   BWS_HOST / BWS_PORT / BWS_TOKEN / BWS_MAX_BODY_BYTES / BWS_TOKEN_FILE / BWS_LOG_LEVEL

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROTOCOL_VERSION = '1.0'

export interface BridgeConfig {
  host: string
  port: number
  token: string
  tokenSource: 'env' | 'file' | 'generated'
  tokenFile: string
  maxBodyBytes: number
  requestTimeoutMs: number
  stateFile: string
  saveIntervalMs: number
  /** 快照超过这个年龄就算过期（工具层据此返回 STATE_STALE） */
  stateStaleMs: number
  protocolVersion: string
  startedAt: number
}

const HERE = dirname(fileURLToPath(import.meta.url))
/** dist/src/config.js → 仓库根（再往上一层才是整个仓库） */
export const REPO_ROOT = resolve(HERE, '..', '..', '..')

export function resolveTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.BWS_TOKEN_FILE ?? '.runtime/token.txt'
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw)
}

export function resolveStateFile(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.BWS_STATE_FILE ?? '.runtime/bridge-state.json'
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw)
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv
  /** 测试里传 0 表示让系统分配端口 */
  port?: number
  token?: string
  /** 测试里不要落盘 */
  writeTokenFile?: boolean
}

export function loadConfig(options: LoadConfigOptions = {}): BridgeConfig {
  const env = options.env ?? process.env
  const tokenFile = resolveTokenFile(env)

  let token = options.token ?? env.BWS_TOKEN ?? ''
  let tokenSource: BridgeConfig['tokenSource'] = 'env'
  if (!token) {
    // 复用上次写下的 token：Bridge 重启后 token 不变，游戏端不用跟着改配置
    try {
      const existing = readFileSync(tokenFile, 'utf8').trim()
      if (/^[0-9a-fA-F]{16,128}$/.test(existing)) {
        token = existing
        tokenSource = 'file'
      }
    } catch {
      // 没有就没有，下面生成
    }
  }
  if (!token) {
    token = randomBytes(32).toString('hex')
    tokenSource = 'generated'
  }

  const port = options.port ?? Number(env.BWS_PORT ?? 18788)
  const maxBodyBytes = Number(env.BWS_MAX_BODY_BYTES ?? 128 * 1024)

  const config: BridgeConfig = {
    host: env.BWS_HOST ?? '127.0.0.1',
    port: Number.isFinite(port) ? port : 18788,
    token,
    tokenSource,
    tokenFile,
    maxBodyBytes: Number.isFinite(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : 128 * 1024,
    requestTimeoutMs: Number(env.BWS_REQUEST_TIMEOUT_MS ?? 15000),
    stateFile: resolveStateFile(env),
    saveIntervalMs: Number(env.BWS_SAVE_MS ?? 5000),
    stateStaleMs: Number(env.BWS_STATE_STALE_MS ?? 15000),
    protocolVersion: PROTOCOL_VERSION,
    startedAt: Date.now(),
  }

  // 生成的 token 落到文件里，游戏端 / curl 才有办法拿到它（不写进日志）
  if (options.writeTokenFile !== false && tokenSource === 'generated') {
    try {
      mkdirSync(dirname(tokenFile), { recursive: true })
      writeFileSync(tokenFile, token + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch {
      // 写不了文件不算致命：启动日志会提醒
    }
  }

  return config
}

/** token 只用于比较/显示，不落日志：显示成前 4 位 + 省略 */
export function maskToken(token: string): string {
  if (token.length <= 8) return '****'
  return `${token.slice(0, 4)}…${token.slice(-2)}（长度 ${token.length}）`
}
