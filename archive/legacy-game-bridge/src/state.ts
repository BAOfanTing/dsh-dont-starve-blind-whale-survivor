// Bridge 运行态（M1 只保存最基础的东西；Session/命令队列在 M3/M4 接上）
//
// /api/v1/bridge/status 要回答的问题：
//   Bridge 是否启动 / 游戏是否连接 / 最近心跳时间 / 当前 Session /
//   最后收到的序列号 / 排队命令数 / 最近一次错误

export interface LastError {
  at: number
  code: string
  message: string
  requestId?: string
}

export interface BridgeStateSnapshot {
  started: boolean
  connected: boolean
  connectedReason: string
  lastHeartbeatAt: number | null
  lastHeartbeatAgoMs: number | null
  sessionId: string | null
  lastSequence: number | null
  queuedCommands: number
  lastError: LastError | null
  requests: { total: number; unauthorized: number; badRequests: number; serverErrors: number }
}

/** 判定“游戏是否连接”的阈值：心跳 3 秒一次，15 秒没动静就算断了 */
export const STALE_HEARTBEAT_MS = 15000

export class BridgeState {
  private connected = false
  private connectedReason = '还没有收到过游戏端的心跳（M3 才接）'
  private lastHeartbeatAt: number | null = null
  private sessionId: string | null = null
  private lastSequence: number | null = null
  private queuedCommands = 0
  private lastError: LastError | null = null
  private readonly counters = { total: 0, unauthorized: 0, badRequests: 0, serverErrors: 0 }

  constructor(private readonly now: () => number = Date.now) {}

  countRequest(): void {
    this.counters.total += 1
  }

  countUnauthorized(): void {
    this.counters.unauthorized += 1
  }

  countBadRequest(): void {
    this.counters.badRequests += 1
  }

  countServerError(): void {
    this.counters.serverErrors += 1
  }

  recordHeartbeat(at: number, sessionId: string | null): void {
    this.lastHeartbeatAt = at
    this.sessionId = sessionId ?? this.sessionId
    this.connected = true
    this.connectedReason = 'ok'
  }

  recordSequence(sequence: number): void {
    this.lastSequence = sequence
  }

  setQueuedCommands(count: number): void {
    this.queuedCommands = count
  }

  recordError(error: LastError): void {
    this.lastError = error
  }

  snapshot(): BridgeStateSnapshot {
    const at = this.now()
    // 心跳超时就不算连着（M3 起才有心跳，M1 永远 false）
    if (this.lastHeartbeatAt !== null && at - this.lastHeartbeatAt > STALE_HEARTBEAT_MS) {
      this.connected = false
      this.connectedReason = `心跳已 ${Math.round((at - this.lastHeartbeatAt) / 1000)} 秒没更新`
    }
    return {
      started: true,
      connected: this.connected,
      connectedReason: this.connectedReason,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastHeartbeatAgoMs: this.lastHeartbeatAt === null ? null : at - this.lastHeartbeatAt,
      sessionId: this.sessionId,
      lastSequence: this.lastSequence,
      queuedCommands: this.queuedCommands,
      lastError: this.lastError,
      requests: { ...this.counters },
    }
  }
}
