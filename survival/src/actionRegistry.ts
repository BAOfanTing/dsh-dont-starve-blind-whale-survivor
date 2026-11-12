// Phase 5 · Action Registry（M1）
//
// 职责：动作执行记录、状态机迁移、幂等去重、取消/超时/需协调、dry-run。
//
// 任务书 §6 硬规矩：
//   · 命令唯一性（command_id 全局唯一）
//   · 幂等去重（idempotency_key 命中 → 返回首次记录，不重复执行）
//   · 断线导致"是否完成无法确认" → NEEDS_RECONCILIATION，禁止盲目重放
//   · 控制权切换时取消旧控制器未完成任务
//   · 动作超时、取消、目标有效性、session 检查
//   · 执行进度反馈 + 结果状态验证
//
// M1 全部 dry-run：validate/accept/run/succeed 只改记录，**不下发任何真实动作**。

import {
  ACTION_STATUSES,
  CONFIRMATION_REQUIRED,
  READ_ONLY_ACTIONS,
  TERMINAL_STATUSES,
  canTransition,
  type ActionCommand,
  type ActionRecord,
  type ActionStatus,
  type ActionType,
  type RejectReason,
} from './protocol.js'
import { ControlDenied, ControlManager } from './controlManager.js'

export interface ActionRegistryOptions {
  now?: () => number
  /** 最多保留多少条记录（防无限增长） */
  maxRecords?: number
  /** M1：是否强制 dry-run（默认 true） */
  forceDryRun?: boolean
}

export interface SubmitResult {
  ok: boolean
  action_id: string
  status: ActionStatus
  record?: ActionRecord
  error?: { code: RejectReason; message: string }
  /** 幂等命中：返回的是首次执行的记录 */
  duplicate?: boolean
  deduplicated_from?: string
}

export class ActionRegistry {
  private readonly records = new Map<string, ActionRecord>()
  /** idempotency_key → 首次 action_id */
  private readonly byIdempotency = new Map<string, string>()
  private readonly now: () => number
  private readonly maxRecords: number
  private readonly forceDryRun: boolean

  constructor(
    private readonly control: ControlManager,
    options: ActionRegistryOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.maxRecords = options.maxRecords ?? 500
    this.forceDryRun = options.forceDryRun ?? true
    this.control.setPendingActionCounter(() => this.pendingCount())
  }

  /** 非终态动作数量（控制权切换时用来统计要取消多少） */
  pendingCount(): number {
    let n = 0
    for (const r of this.records.values()) if (!TERMINAL_STATUSES.has(r.status)) n += 1
    return n
  }

  get(action_id: string): ActionRecord | null {
    const r = this.records.get(action_id)
    if (r === undefined) return null
    return {
      ...r,
      history: [...r.history],
      command: { ...r.command, payload: { ...r.command.payload } },
      error: r.error === null ? null : { ...r.error },
    }
  }

  list(options: { controller_id?: string; status?: ActionStatus; limit?: number } = {}): ActionRecord[] {
    let out = [...this.records.values()]
    if (options.controller_id !== undefined) out = out.filter((r) => r.command.controller_id === options.controller_id)
    if (options.status !== undefined) out = out.filter((r) => r.status === options.status)
    out.sort((a, b) => b.command.created_at - a.command.created_at)
    return out.slice(0, options.limit ?? 50).map((r) => this.get(r.command.action_id)!)
  }

  stats(): { total: number; pending: number; by_status: Record<string, number>; dry_runs: number; duplicates: number } {
    const by_status: Record<string, number> = {}
    let dry_runs = 0
    let duplicates = 0
    for (const s of ACTION_STATUSES) by_status[s] = 0
    for (const r of this.records.values()) {
      by_status[r.status] = (by_status[r.status] ?? 0) + 1
      if (r.command.dry_run) dry_runs += 1
      if (r.deduplicated_from !== null) duplicates += 1
    }
    return { total: this.records.size, pending: this.pendingCount(), by_status, dry_runs, duplicates }
  }

  /** 提交一条动作命令（M1 只登记，不执行） */
  submit(command: ActionCommand): SubmitResult {
    const at = this.now()

    // 1) 幂等去重：同一个 idempotency_key 直接返回首次记录
    const existingId = this.byIdempotency.get(command.idempotency_key)
    if (existingId !== undefined) {
      const existing = this.records.get(existingId)
      if (existing !== undefined) {
        return {
          ok: true,
          action_id: existing.command.action_id,
          status: existing.status,
          record: this.get(existing.command.action_id)!,
          duplicate: true,
          deduplicated_from: existing.command.action_id,
        }
      }
    }

    // 2) action_id 唯一
    if (this.records.has(command.action_id)) {
      return {
        ok: false,
        action_id: command.action_id,
        status: 'FAILED',
        error: { code: 'DUPLICATE', message: `action_id 已存在：${command.action_id}` },
      }
    }

    // 3) 过期
    if (at > command.expires_at) {
      return this.failEarly(command, 'EXPIRED', '动作已过期')
    }

    // 4) M1 强制 dry-run（防止误开真实执行）
    const effective: ActionCommand = { ...command, dry_run: this.forceDryRun ? true : command.dry_run }

    // 5) 权限校验（只读查询类不需要写权限）
    const readOnly = READ_ONLY_ACTIONS.has(effective.action_type)
    try {
      this.control.assertCanExecute(effective.controller_id, effective.session_id, { readOnly })
    } catch (error) {
      if (error instanceof ControlDenied) {
        return this.failEarly(effective, error.code as RejectReason, error.message)
      }
      throw error
    }

    // 6) 需要人工确认的动作：M1 记录 confirmed=false（不做真实执行）
    const requiresConfirmation = CONFIRMATION_REQUIRED.has(effective.action_type)
    const record: ActionRecord = {
      command: effective,
      status: 'PENDING',
      updated_at: at,
      history: [{ status: 'PENDING', at, reason: 'submitted' }],
      confirmation_required: requiresConfirmation,
      confirmed: false,
      result: null,
      error: null,
      deduplicated_from: null,
    }
    this.records.set(effective.action_id, record)
    this.byIdempotency.set(effective.idempotency_key, effective.action_id)
    this.prune()

    return { ok: true, action_id: effective.action_id, status: 'PENDING', record: this.get(effective.action_id)! }
  }

  private failEarly(command: ActionCommand, code: RejectReason, message: string): SubmitResult {
    const at = this.now()
    const record: ActionRecord = {
      command,
      status: 'FAILED',
      updated_at: at,
      history: [{ status: 'FAILED', at, reason: message }],
      confirmation_required: false,
      confirmed: false,
      result: null,
      error: { code, message },
      deduplicated_from: null,
    }
    this.records.set(command.action_id, record)
    return { ok: false, action_id: command.action_id, status: 'FAILED', record, error: { code, message } }
  }

  /** 状态迁移（带合法性检查） */
  transition(action_id: string, to: ActionStatus, reason: string | null = null): SubmitResult {
    const record = this.records.get(action_id)
    if (record === undefined) {
      return { ok: false, action_id, status: 'FAILED', error: { code: 'INVALID_ARGUMENT', message: `没有这个动作：${action_id}` } }
    }
    if (!canTransition(record.status, to)) {
      return {
        ok: false,
        action_id,
        status: record.status,
        record: this.get(action_id)!,
        error: { code: 'ILLEGAL_TRANSITION', message: `不能从 ${record.status} 转到 ${to}` },
      }
    }
    const at = this.now()
    record.status = to
    record.updated_at = at
    record.history.push({ status: to, at, reason })
    return { ok: true, action_id, status: to, record: this.get(action_id)! }
  }

  /** 取消（只有 holder / 人工能取消；终态不能取消） */
  cancel(action_id: string, controller_id: string, options: { human?: boolean } = {}): SubmitResult {
    const record = this.records.get(action_id)
    if (record === undefined) {
      return { ok: false, action_id, status: 'FAILED', error: { code: 'INVALID_ARGUMENT', message: '没有这个动作' } }
    }
    if (record.command.controller_id !== controller_id && options.human !== true) {
      return { ok: false, action_id, status: record.status, error: { code: 'CONTROL_NOT_HELD', message: '不能取消别人的动作' } }
    }
    if (TERMINAL_STATUSES.has(record.status)) {
      return { ok: false, action_id, status: record.status, error: { code: 'ILLEGAL_TRANSITION', message: `已终结（${record.status}），不能取消` } }
    }
    return this.transition(action_id, 'CANCELLED', '用户/控制器取消')
  }

  /** 控制权切换时，把某控制器的所有未终结动作取消（M1 关键：防止旧控制器残留） */
  cancelPendingFor(controller_id: string, reason = '控制权切换'): number {
    let n = 0
    for (const record of this.records.values()) {
      if (record.command.controller_id !== controller_id) continue
      if (TERMINAL_STATUSES.has(record.status)) continue
      // 直接走合法迁移：PENDING/VALIDATING/ACCEPTED/RUNNING → CANCELLED
      if (canTransition(record.status, 'CANCELLED')) {
        this.transition(record.command.action_id, 'CANCELLED', reason)
        n += 1
      }
    }
    return n
  }

  /** 超时扫描：未执行完的超时 → TIMEOUT；执行中失联 → NEEDS_RECONCILIATION（结果未知，禁止重放） */
  sweepTimeouts(): number {
    const at = this.now()
    let n = 0
    for (const record of this.records.values()) {
      if (TERMINAL_STATUSES.has(record.status)) continue
      if (at <= record.command.expires_at) continue
      if (record.status === 'RUNNING') {
        this.transition(record.command.action_id, 'NEEDS_RECONCILIATION', '执行中失联，动作是否完成无法确认')
        n += 1
      } else if (canTransition(record.status, 'TIMEOUT')) {
        this.transition(record.command.action_id, 'TIMEOUT', '动作超时（未执行）')
        n += 1
      }
    }
    return n
  }

  /**
   * 断线导致结果未知 → NEEDS_RECONCILIATION。
   * 只允许 RUNNING / TIMEOUT 进入；进入后**禁止重新执行**（isReplayAllowed 返回 false）。
   */
  reconcile(action_id: string, reason = '游戏断线，动作是否完成无法确认'): SubmitResult {
    const record = this.records.get(action_id)
    if (record === undefined) {
      return { ok: false, action_id, status: 'FAILED', error: { code: 'INVALID_ARGUMENT', message: '没有这个动作' } }
    }
    if (record.status === 'NEEDS_RECONCILIATION') {
      return { ok: true, action_id, status: 'NEEDS_RECONCILIATION', record: this.get(action_id)! }
    }
    return this.transition(action_id, 'NEEDS_RECONCILIATION', reason)
  }

  /** 是否允许重放（NEEDS_RECONCILIATION 一律禁止） */
  isReplayAllowed(action_id: string): boolean {
    const r = this.records.get(action_id)
    if (r === undefined) return false
    if (r.status === 'NEEDS_RECONCILIATION') return false
    return r.status === 'FAILED' || r.status === 'CANCELLED' || r.status === 'TIMEOUT'
  }

  /** 人工确认（SUPERVISED 模式下，需确认的动作才能进入 ACCEPTED） */
  confirm(action_id: string, controller_id: string): SubmitResult {
    const r = this.records.get(action_id)
    if (r === undefined) {
      return { ok: false, action_id, status: 'FAILED', error: { code: 'INVALID_ARGUMENT', message: '没有这个动作' } }
    }
    if (r.command.controller_id !== controller_id) {
      return { ok: false, action_id, status: r.status, error: { code: 'CONTROL_NOT_HELD', message: '只有提交者能确认' } }
    }
    r.confirmed = true
    r.updated_at = this.now()
    return { ok: true, action_id, status: r.status, record: this.get(action_id)! }
  }

  /**
   * Dry-run 全流程：PENDING → VALIDATING → ACCEPTED → RUNNING → SUCCEEDED。
   * 支持从 VALIDATING 续跑（人工确认后再次调用）。
   * 每一步都走合法迁移，且**不调用任何游戏 API**。
   */
  dryRun(action_id: string, controller_id: string): SubmitResult {
    const r = this.records.get(action_id)
    if (r === undefined) {
      return { ok: false, action_id, status: 'FAILED', error: { code: 'INVALID_ARGUMENT', message: '没有这个动作' } }
    }
    if (r.command.controller_id !== controller_id) {
      return { ok: false, action_id, status: r.status, error: { code: 'CONTROL_NOT_HELD', message: '只有提交者能执行 dry-run' } }
    }
    if (!r.command.dry_run) {
      return { ok: false, action_id, status: r.status, error: { code: 'NOT_IMPLEMENTED', message: 'M1 只允许 dry-run，真实执行未实现' } }
    }
    if (TERMINAL_STATUSES.has(r.status)) {
      return { ok: false, action_id, status: r.status, error: { code: 'ILLEGAL_TRANSITION', message: `已终结（${r.status}），不能重复执行` } }
    }

    // 第一步：进入 VALIDATING（若已在 VALIDATING 则跳过，支持确认后续跑）
    if (r.status === 'PENDING') {
      const res = this.transition(action_id, 'VALIDATING', '校验参数与前置条件（dry-run）')
      if (!res.ok) return res
    }

    // 需人工确认但还没确认：停在 VALIDATING，不判 FAILED（终态无法续跑）
    if (r.confirmation_required && r.confirmed !== true) {
      return {
        ok: false,
        action_id,
        status: 'VALIDATING',
        record: this.get(action_id)!,
        error: { code: 'CONTROL_MODE_DENIED', message: 'SUPERVISED 模式需要人工确认，确认前不执行' },
      }
    }

    // 后续步骤：根据当前状态决定从哪一步继续
    const remaining: Array<{ from: ActionStatus; to: ActionStatus; reason: string }> = [
      { from: 'VALIDATING', to: 'ACCEPTED', reason: '控制权与前置条件通过（dry-run）' },
      { from: 'ACCEPTED', to: 'RUNNING', reason: '模拟执行（未调用游戏 API）' },
      { from: 'RUNNING', to: 'SUCCEEDED', reason: 'dry-run 完成' },
    ]
    for (const step of remaining) {
      const current = this.records.get(action_id)!
      if (current.status !== step.from) continue // 已走过这步
      const res = this.transition(action_id, step.to, step.reason)
      if (!res.ok) return res
      if (step.to === 'SUCCEEDED') {
        const rec = this.records.get(action_id)!
        rec.result = { dry_run: true, executed: false, action_type: rec.command.action_type }
      }
    }
    return { ok: true, action_id, status: this.records.get(action_id)!.status, record: this.get(action_id)! }
  }

  /** 紧急停止：取消所有非终态动作（不被队列阻塞，同步执行） */
  emergencyCancelAll(reason = '紧急停止'): number {
    let n = 0
    for (const record of this.records.values()) {
      if (TERMINAL_STATUSES.has(record.status)) continue
      if (canTransition(record.status, 'CANCELLED')) {
        this.transition(record.command.action_id, 'CANCELLED', reason)
        n += 1
      } else if (record.status === 'RUNNING') {
        this.transition(record.command.action_id, 'NEEDS_RECONCILIATION', reason)
        n += 1
      }
    }
    return n
  }

  private prune(): void {
    if (this.records.size <= this.maxRecords) return
    const sorted = [...this.records.values()].sort((a, b) => a.updated_at - b.updated_at)
    for (const r of sorted.slice(0, this.records.size - this.maxRecords)) {
      this.records.delete(r.command.action_id)
      this.byIdempotency.delete(r.command.idempotency_key)
    }
  }
}
