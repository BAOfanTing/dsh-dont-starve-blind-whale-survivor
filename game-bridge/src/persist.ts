// 状态持久化（M5）
//
// 为什么需要：Bridge 重启（手动重启、崩溃、机器重启）后如果什么都不记得，会出两个问题：
//   1. 已经接受但没执行的命令丢了（游戏端永远等不到）；
//   2. **sequence 记账清零** → 游戏端继续用旧 sequence 推数据时，会被当成"新数据"重复入库，
//      幂等就破了。
//
// 所以把「会话（含 sequence 记账）+ 命令队列」落盘。规矩：
//   · 原子写：先写 .tmp 再 rename，避免写一半断电留下坏文件；
//   · 带 schema_version，未来改结构时能识别；
//   · 落盘失败不致命（只丢恢复能力），但要在日志里 WARN；
//   · **DELIVERED/EXECUTING 的命令恢复后不重放**：交给 CommandQueue.reapSession 判 unknown_completion。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const PERSIST_VERSION = 1

export interface PersistedSession {
  sessionId: string
  shard: string | null
  gameVersion: string | null
  createdAt: number
  lastHeartbeatAt: number | null
  lastTelemetryAt: number | null
  lastSequence: number
  acknowledgedSequence: number
  heartbeats: number
  telemetryCount: number
  duplicates: number
  gaps: number
  lastPayloadBytes: number
  playerStatus: unknown
  latest: unknown
  latestAt: number | null
}

export interface PersistedCommand {
  id: string
  type: string
  params: Record<string, unknown>
  status: string
  createdAt: number
  expiresAt: number
  sessionId: string | null
  shard: string | null
  deliveredAt: number | null
  deliveries: number
  executingAt: number | null
  finishedAt: number | null
  result: unknown
  error: string | null
  executionTime: number | null
  late: boolean
  note: string | null
}

export interface PersistedState {
  version: number
  savedAt: number
  sessions: PersistedSession[]
  commands: PersistedCommand[]
}

export function saveStateFile(
  path: string,
  sessions: PersistedSession[],
  commands: PersistedCommand[],
): { ok: boolean; bytes: number; error?: string } {
  const payload: PersistedState = { version: PERSIST_VERSION, savedAt: Date.now(), sessions, commands }
  const text = JSON.stringify(payload)
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
    return { ok: true, bytes: Buffer.byteLength(text) }
  } catch (error) {
    return { ok: false, bytes: 0, error: String((error as Error)?.message ?? error) }
  }
}

export function loadStateFile(path: string): { ok: boolean; state?: PersistedState; reason?: string } {
  if (!existsSync(path)) return { ok: false, reason: 'no_file' }
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as PersistedState
    if (parsed === null || typeof parsed !== 'object') return { ok: false, reason: 'not_object' }
    if (parsed.version !== PERSIST_VERSION) return { ok: false, reason: `version_mismatch:${parsed.version}` }
    if (!Array.isArray(parsed.sessions) || !Array.isArray(parsed.commands)) {
      return { ok: false, reason: 'shape_invalid' }
    }
    return { ok: true, state: parsed }
  } catch (error) {
    return { ok: false, reason: `parse_failed:${String((error as Error)?.message ?? error)}` }
  }
}
