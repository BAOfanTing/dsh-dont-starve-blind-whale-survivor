// Phase 5 · Control Manager（M1）
//
// 任务书 §5：统一控制权管理器。
//
// 硬规矩：
//   1. 同一时间**只允许一个控制器**持有游戏写权限（Lease）；
//   2. 人工接管优先级最高（MANUAL 会立刻撤销 AI lease）；
//   3. Lease 带过期时间，过期后普通操作一律拒绝；
//   4. 控制权切换时，旧控制器的未完成任务必须被取消；
//   5. 紧急停止不允许被动作队列阻塞（同步立即生效）；
//   6. 外部 MCP 客户端与内置 Agent 共享同一份控制权（这里就是唯一权威源）；
//   7. 未获得控制权只能读状态和制定计划。

import { CONTROL_MODES, type ControlMode, type ActionStatus } from './protocol.js'

export interface ControlLease {
  controller_id: string
  session_id: string
  mode: ControlMode
  acquired_at: number
  expires_at: number
  renewed_at: number
  /** 这个 lease 撤销过多少次未完成任务（可观测） */
  preempted_actions: number
}

export interface ControlStatus {
  mode: ControlMode
  holder: string | null
  session_id: string | null
  lease_valid: boolean
  expires_at: number | null
  remaining_ms: number | null
  emergency_stop: boolean
  history_count: number
  last_change: { at: number; from: ControlMode | null; to: ControlMode; reason: string } | null
}

export interface ControlChange {
  at: number
  from: ControlMode | null
  to: ControlMode
  reason: string
  controller_id: string | null
}

export interface ControlManagerOptions {
  /** 默认控制模式，第一版 SUPERVISED */
  defaultMode?: ControlMode
  /** Lease 时长（毫秒） */
  leaseMs?: number
  /** renew 时可以续多久 */
  renewMs?: number
  now?: () => number
}

export class ControlDenied extends Error {
  constructor(readonly code: 'CONTROL_NOT_HELD' | 'CONTROL_EXPIRED' | 'CONTROL_MODE_DENIED' | 'EMERGENCY_STOP' | 'MANUAL_OVERRIDE', message: string) {
    super(message)
    this.name = 'ControlDenied'
  }
}

export class ControlManager {
  private mode: ControlMode
  private lease: ControlLease | null = null
  private emergency = false
  private readonly history: ControlChange[] = []
  private readonly now: () => number
  private readonly leaseMs: number
  private readonly renewMs: number

  constructor(options: ControlManagerOptions = {}) {
    this.mode = options.defaultMode ?? 'SUPERVISED'
    this.now = options.now ?? Date.now
    this.leaseMs = options.leaseMs ?? 30_000
    this.renewMs = options.renewMs ?? 30_000
  }

  /** 哪些动作是非终态的（切换控制权时要取消） */
  setPendingActionCounter(counter: () => number): void {
    this.pendingCounter = counter
  }
  private pendingCounter: () => number = () => 0

  /** 记录一次控制权变更 */
  private change(to: ControlMode, reason: string): void {
    const at = this.now()
    this.history.push({
      at,
      from: this.history.length > 0 ? this.history[this.history.length - 1]!.to : null,
      to,
      reason,
      controller_id: this.lease?.controller_id ?? null,
    })
    this.lastChange = { at, from: this.history.length > 1 ? this.history[this.history.length - 2]!.to : null, to, reason }
  }
  private lastChange: ControlStatus['last_change'] = null

  /** 当前 lease 是否仍然有效 */
  leaseValid(): boolean {
    if (this.lease === null) return false
    return this.now() < this.lease.expires_at
  }

  /**
   * 申请控制权。
   * MANUAL / EMERGENCY_STOP / PAUSED 下不允许 AI 取得写权限。
   * 若已有其他控制器持有有效 lease：
   *   · 人工接管（MANUAL）可以抢占；
   *   · 普通控制器不能抢占（除非对方 lease 已过期）。
   */
  acquireControl(params: { controller_id: string; session_id: string; mode?: ControlMode }, options: { human?: boolean } = {}): ControlLease {
    const at = this.now()

    if (this.emergency) {
      throw new ControlDenied('EMERGENCY_STOP', '紧急停止已激活，拒绝申请控制权')
    }
    if (this.mode === 'MANUAL' && !options.human) {
      throw new ControlDenied('MANUAL_OVERRIDE', '人工接管中，AI 不能取得控制权')
    }
    if (this.mode === 'PAUSED') {
      throw new ControlDenied('CONTROL_MODE_DENIED', '已暂停，拒绝申请控制权')
    }

    const requestedMode = params.mode ?? this.mode

    // 已有有效 lease 且不是同一个控制器 → 检查能否抢占
    if (this.lease !== null && this.leaseValid() && this.lease.controller_id !== params.controller_id) {
      const canPreempt = options.human === true || requestedMode === 'MANUAL'
      if (!canPreempt) {
        throw new ControlDenied('CONTROL_NOT_HELD', `控制权已被 ${this.lease.controller_id} 持有，且 lease 未过期`)
      }
      // 抢占：撤销旧 lease，并记下它有多少未完成任务需要取消
      const cancelled = this.pendingCounter()
      this.lease.preempted_actions = cancelled
      this.change(this.mode, `preempt: ${this.lease.controller_id} → ${params.controller_id}（${cancelled} 个未完成任务待取消）`)
      this.lease = null
    }

    const lease: ControlLease = {
      controller_id: params.controller_id,
      session_id: params.session_id,
      mode: requestedMode,
      acquired_at: at,
      expires_at: at + this.leaseMs,
      renewed_at: at,
      preempted_actions: 0,
    }
    this.lease = lease
    if (requestedMode === 'MANUAL') {
      this.mode = 'MANUAL'
      this.change('MANUAL', '人工接管')
    } else {
      this.change(this.mode, `控制权授予 ${params.controller_id}`)
    }
    return { ...lease }
  }

  /** 主动释放（只有 holder 本人或人工能释放） */
  releaseControl(controller_id: string, options: { human?: boolean } = {}): boolean {
    if (this.lease === null) return false
    if (this.lease.controller_id !== controller_id && options.human !== true) {
      throw new ControlDenied('CONTROL_NOT_HELD', `只有 ${this.lease.controller_id} 能释放控制权`)
    }
    this.lease = null
    this.change(this.mode, `释放控制权（${controller_id}）`)
    return true
  }

  /** 续约（必须持有有效 lease） */
  renewControl(controller_id: string): ControlLease {
    if (this.emergency) {
      throw new ControlDenied('EMERGENCY_STOP', '紧急停止已激活，拒绝续约')
    }
    if (this.lease === null || this.lease.controller_id !== controller_id) {
      throw new ControlDenied('CONTROL_NOT_HELD', '没有持有控制权')
    }
    if (!this.leaseValid()) {
      throw new ControlDenied('CONTROL_EXPIRED', 'lease 已过期，需重新申请')
    }
    // 续约时长 = 这份 lease 的原始时长（首次 acquire 时就定下），不受 renewMs 覆盖，
    // 保证「续约」语义稳定：remaining 回到初始 lease 时长。
    const originalDuration = this.lease.expires_at - this.lease.acquired_at
    const duration = Math.min(originalDuration, this.renewMs)
    this.lease.renewed_at = this.now()
    this.lease.expires_at = this.now() + duration
    // acquired_at 跟着前移，后续每次 renew 都基于当前周期
    this.lease.acquired_at = this.lease.renewed_at
    return { ...this.lease }
  }

  /**
   * 动作执行前的权限校验。
   * 纯查询类动作（get_* / status）不需要写权限。
   */
  assertCanExecute(controller_id: string, session_id: string, options: { readOnly?: boolean; actionStatus?: ActionStatus } = {}): void {
    if (this.emergency) {
      throw new ControlDenied('EMERGENCY_STOP', '紧急停止中，所有动作被拒')
    }
    if (this.mode === 'MANUAL' || this.mode === 'PAUSED') {
      throw new ControlDenied('CONTROL_MODE_DENIED', `当前模式 ${this.mode}，拒绝执行动作`)
    }
    if (options.readOnly === true) return

    if (this.lease === null) {
      throw new ControlDenied('CONTROL_NOT_HELD', '没有控制器持有写权限')
    }
    if (this.lease.controller_id !== controller_id) {
      throw new ControlDenied('CONTROL_NOT_HELD', `控制权属于 ${this.lease.controller_id}`)
    }
    if (this.lease.session_id !== session_id) {
      throw new ControlDenied('CONTROL_NOT_HELD', 'session_id 与控制权记录不一致')
    }
    if (!this.leaseValid()) {
      throw new ControlDenied('CONTROL_EXPIRED', '控制权 lease 已过期')
    }
  }

  /** 人工接管（最高优先级，立即撤销 AI lease） */
  takeManualControl(reason = '人工接管'): ControlStatus {
    this.emergency = false
    if (this.lease !== null) {
      this.lease.preempted_actions = this.pendingCounter()
      this.lease = null
    }
    this.mode = 'MANUAL'
    this.change('MANUAL', reason)
    return this.getControlStatus()
  }

  /** 从人工接管切回 SUPERVISED（默认；不自动恢复 AUTONOMOUS） */
  releaseManualControl(): ControlStatus {
    this.mode = 'SUPERVISED'
    this.change('SUPERVISED', '人工释放接管')
    return this.getControlStatus()
  }

  /** 暂停 AI（保留 lease 但拒绝执行） */
  pause(reason = '用户暂停'): ControlStatus {
    this.mode = 'PAUSED'
    this.change('PAUSED', reason)
    return this.getControlStatus()
  }

  /** 恢复（回到 SUPERVISED，不是 AUTONOMOUS） */
  resume(): ControlStatus {
    if (this.emergency) {
      throw new ControlDenied('EMERGENCY_STOP', '紧急停止状态需显式清除')
    }
    this.mode = 'SUPERVISED'
    this.change('SUPERVISED', '恢复监督模式')
    return this.getControlStatus()
  }

  /** 切到受限自主模式（必须显式调用，且需人工接管已释放） */
  enableAutonomous(reason = '显式开启受限自主'): ControlStatus {
    if (this.mode === 'MANUAL') {
      throw new ControlDenied('MANUAL_OVERRIDE', '人工接管中不能开自主模式')
    }
    this.mode = 'AUTONOMOUS'
    this.change('AUTONOMOUS', reason)
    return this.getControlStatus()
  }

  /** 紧急停止：同步立即生效，撤销 lease，不被任何队列阻塞 */
  emergencyStop(reason = '紧急停止'): ControlStatus {
    this.emergency = true
    if (this.lease !== null) {
      this.lease.preempted_actions = this.pendingCounter()
      this.lease = null
    }
    this.mode = 'EMERGENCY_STOP'
    this.change('EMERGENCY_STOP', reason)
    return this.getControlStatus()
  }

  /** 清除紧急停止（必须显式，且回到 SUPERVISED） */
  clearEmergencyStop(reason = '手动清除紧急停止'): ControlStatus {
    this.emergency = false
    this.mode = 'SUPERVISED'
    this.change('SUPERVISED', reason)
    return this.getControlStatus()
  }

  getControlStatus(): ControlStatus {
    const at = this.now()
    const valid = this.leaseValid()
    return {
      mode: this.mode,
      holder: this.lease?.controller_id ?? null,
      session_id: this.lease?.session_id ?? null,
      lease_valid: valid,
      expires_at: this.lease?.expires_at ?? null,
      remaining_ms: this.lease === null ? null : Math.max(0, this.lease.expires_at - at),
      emergency_stop: this.emergency,
      history_count: this.history.length,
      last_change: this.lastChange === null ? null : { ...this.lastChange },
    }
  }

  getHistory(): ControlChange[] {
    return this.history.map((item) => ({ ...item }))
  }

  /** 供动作注册表查询：某个控制器是否仍持有有效 lease */
  isHolder(controller_id: string): boolean {
    return this.lease !== null && this.leaseValid() && this.lease.controller_id === controller_id
  }

  isEmergency(): boolean {
    return this.emergency
  }
}
