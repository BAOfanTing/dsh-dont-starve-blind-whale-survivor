// Phase 5 M2 · Controller → Bridge 控制权同步
//
// 跨层一致性的方向（只有一个写者，责任清晰）：
//   Control Manager（权威） --每次变更--> Bridge /api/v1/control/sync（持久化）
//   Lua 执行端 ------------- 每个动作前 --> Bridge /api/v1/control/assert（二次校验）
//
// 同步失败**不阻塞**控制逻辑，但会记录错误并在 /health 暴露，避免"以为同步了其实没同步"。

import type { ControlStatus } from './controlManager.js'

export interface BridgeSyncOptions {
  bridgeUrl: string
  token: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class BridgeControlSync {
  private lastError: string | null = null
  private lastSyncedAt: number | null = null
  private syncCount = 0
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(private readonly options: BridgeSyncOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 2000
  }

  /** 推一次状态给 Bridge。返回是否成功（失败只记日志，不抛） */
  async push(status: ControlStatus, reason: string): Promise<boolean> {
    const body = {
      mode: status.mode,
      holder: status.holder,
      session_id: status.session_id,
      lease_expires_at: status.expires_at,
      emergency_stop: status.emergency_stop,
      reason,
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      let response: Response
      try {
        response = await this.fetchImpl(`${this.options.bridgeUrl}/api/v1/control/sync`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.token}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) {
        this.lastError = `HTTP ${response.status}`
        return false
      }
      this.lastError = null
      this.lastSyncedAt = Date.now()
      this.syncCount += 1
      return true
    } catch (error) {
      this.lastError = String((error as Error)?.message ?? error)
      return false
    }
  }

  status() {
    return {
      bridge_url: this.options.bridgeUrl,
      last_error: this.lastError,
      last_synced_at: this.lastSyncedAt,
      sync_count: this.syncCount,
    }
  }
}
