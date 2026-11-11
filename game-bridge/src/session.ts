// SessionManager（M3）
//
// 每个游戏会话（= 一个分片进程里的一次进世界）一条记录：
//   · 最近心跳时间 → 判断"游戏是否连接"
//   · sequence / acknowledged_sequence → 幂等与断线恢复的依据
//   · 最近一次 telemetry 的 data → 对外快照（M3 只做缓存，不做业务解析）
//
// 幂等规则（M3 核心）：
//   · sequence <= acknowledged_sequence → 视为重复，**不覆盖快照**，返回同一个 ack（duplicate: true）
//   · sequence > ack + 1 → 说明中间丢了包，记 gap（仍然接受，取最新的）
//   · 同一会话的 session_id 由游戏端生成，包含分片与启动时间

export interface SessionInfo {
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

export interface SessionManagerOptions {
  /** 多久没心跳算断线（心跳间隔 3 秒，默认 10 秒） */
  heartbeatTimeoutMs?: number
  /** 最多保留多少个会话记录（防止内存无限长） */
  maxSessions?: number
  now?: () => number
}

function blank(sessionId: string, at: number): SessionInfo {
  return {
    sessionId,
    shard: null,
    gameVersion: null,
    createdAt: at,
    lastHeartbeatAt: null,
    lastTelemetryAt: null,
    lastSequence: 0,
    acknowledgedSequence: 0,
    heartbeats: 0,
    telemetryCount: 0,
    duplicates: 0,
    gaps: 0,
    lastPayloadBytes: 0,
    playerStatus: null,
    latest: null,
    latestAt: null,
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionInfo>()
  private readonly now: () => number
  private readonly heartbeatTimeoutMs: number
  private readonly maxSessions: number

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? Date.now
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10000
    this.maxSessions = options.maxSessions ?? 16
  }

  private ensure(sessionId: string): SessionInfo {
    let info = this.sessions.get(sessionId)
    if (!info) {
      info = blank(sessionId, this.now())
      this.sessions.set(sessionId, info)
      this.prune()
    }
    return info
  }

  private prune(): void {
    if (this.sessions.size <= this.maxSessions) return
    const sorted = [...this.sessions.values()].sort(
      (a, b) => (b.lastHeartbeatAt ?? b.createdAt) - (a.lastHeartbeatAt ?? a.createdAt),
    )
    for (const info of sorted.slice(this.maxSessions)) this.sessions.delete(info.sessionId)
  }

  heartbeat(sessionId: string, payload: { playerStatus?: unknown; gameVersion?: string | null; shard?: string | null }): SessionInfo {
    const info = this.ensure(sessionId)
    info.lastHeartbeatAt = this.now()
    info.heartbeats += 1
    if (payload.playerStatus !== undefined) info.playerStatus = payload.playerStatus
    if (payload.gameVersion) info.gameVersion = payload.gameVersion
    if (payload.shard) info.shard = payload.shard
    return info
  }

  /**
   * 收一条 telemetry。返回 { duplicate, acknowledgedSequence, gap }
   * duplicate=true 表示这条 sequence 已经处理过（不覆盖快照）。
   */
  telemetry(
    sessionId: string,
    sequence: number,
    data: unknown,
    payloadBytes: number,
  ): { duplicate: boolean; acknowledgedSequence: number; gap: boolean } {
    const info = this.ensure(sessionId)
    const at = this.now()

    if (sequence <= info.acknowledgedSequence) {
      info.duplicates += 1
      info.lastTelemetryAt = at
      return { duplicate: true, acknowledgedSequence: info.acknowledgedSequence, gap: false }
    }

    const gap = sequence > info.acknowledgedSequence + 1
    if (gap) info.gaps += 1

    info.lastSequence = sequence
    info.acknowledgedSequence = sequence
    info.telemetryCount += 1
    info.lastTelemetryAt = at
    info.lastPayloadBytes = payloadBytes
    info.latest = data
    info.latestAt = at
    return { duplicate: false, acknowledgedSequence: info.acknowledgedSequence, gap }
  }

  isAlive(info: SessionInfo): boolean {
    if (info.lastHeartbeatAt === null) return false
    return this.now() - info.lastHeartbeatAt <= this.heartbeatTimeoutMs
  }

  /** 对外选一个"当前会话"：优先心跳活着且有快照的，再按最近心跳排序 */
  current(): SessionInfo | null {
    const alive = [...this.sessions.values()].filter((info) => this.isAlive(info))
    const pool = alive.length > 0 ? alive : [...this.sessions.values()]
    if (pool.length === 0) return null
    pool.sort((a, b) => {
      const aReady = a.latest !== null ? 1 : 0
      const bReady = b.latest !== null ? 1 : 0
      if (aReady !== bReady) return bReady - aReady
      return (b.lastHeartbeatAt ?? 0) - (a.lastHeartbeatAt ?? 0)
    })
    return pool[0] ?? null
  }

  isConnected(): boolean {
    return [...this.sessions.values()].some((info) => this.isAlive(info))
  }

  lastHeartbeatAgoMs(): number | null {
    const times = [...this.sessions.values()].map((i) => i.lastHeartbeatAt).filter((v): v is number => v !== null)
    if (times.length === 0) return null
    return this.now() - Math.max(...times)
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].sort((a, b) => (b.lastHeartbeatAt ?? b.createdAt) - (a.lastHeartbeatAt ?? a.createdAt))
  }

  forTestsClear(): void {
    this.sessions.clear()
  }
}
