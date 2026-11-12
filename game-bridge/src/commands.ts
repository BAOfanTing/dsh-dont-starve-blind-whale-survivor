// CommandQueue（M4）
//
// 命令状态机：
//   QUEUED ──poll──> DELIVERED ──(可选 EXECUTING)──> SUCCEEDED / FAILED
//     │                    │
//     └── 过期 ──> EXPIRED  └── 会话丢失 ──> FAILED(error=unknown_completion)
//   任意非终态 ──cancel──> CANCELLED
//
// 可靠性的几条硬规矩：
//   1. **重复请求不得导致重复执行**：同一 command_id 的结果只认第一次，之后的算 duplicate；
//   2. **不能盲目重放旧命令**：DELIVERED/EXECUTING 的命令如果其会话已经死了（游戏重启/换会话），
//      标记 FAILED + error=unknown_completion，绝不再投一次；如果之后又收到迟到结果，接受并标 late；
//   3. 投递失败可重投：DELIVERED 超过 redeliverAfterMs 还没结果 → 同一条命令再投一次（同一个 id，游戏端靠 id 去重）；
//   4. 队列有上限、命令有 TTL，防止无限堆积。

// Phase 5 M2/M3 扩展：前 4 个是 Phase 2 测试命令；之后是移动(M2)与采集(M3)动作。
// 动作命令走同一套状态机（QUEUED→DELIVERED→EXECUTING→终态），但 Lua 执行端会额外做
// 控制权二次校验（POST /api/v1/control/assert），未授权直接回 FAILED，不执行。
export const COMMAND_TYPES = [
  'ping', 'echo', 'get_state', 'refresh_state',
  'move_to', 'stop_movement', 'get_movement_status',
  // Phase 5 M3：基础资源采集
  'gather_resource', 'move_to_target', 'probe_game_actions',
  // Phase 5 M4：工具使用
  'equip_item', 'chop_tree', 'mine_rock', 'pick_up_item',
  // Phase 5 M5：进食 / 制作 / 建造
  'eat_item', 'craft_item', 'build_structure', 'build_campfire',
  // Phase 5 M6：任务链
  'start_task', 'stop_task', 'get_task_status',
] as const
/** 会修改游戏状态的命令类型（Lua 端必须二次校验控制权） */
export const ACTION_COMMAND_TYPES = ['move_to', 'stop_movement', 'gather_resource', 'move_to_target',
  'equip_item', 'chop_tree', 'mine_rock', 'pick_up_item',
  'eat_item', 'craft_item', 'build_structure', 'build_campfire',
  'start_task', 'stop_task'] as const
/** 只读动作命令（不需要控制权） */
export const READ_ONLY_COMMAND_TYPES = ['get_movement_status', 'probe_game_actions', 'get_task_status'] as const
/** 需要绑定 master 分片的命令（写动作 + 依赖 master 执行器状态的只读查询） */
export const MASTER_SHARD_COMMANDS: ReadonlySet<string> = new Set([
  ...ACTION_COMMAND_TYPES, 'get_movement_status', 'probe_game_actions',
])
export type CommandType = (typeof COMMAND_TYPES)[number]

export const COMMAND_STATUSES = [
  'QUEUED',
  'DELIVERED',
  'EXECUTING',
  'SUCCEEDED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
] as const
export type CommandStatus = (typeof COMMAND_STATUSES)[number]

const TERMINAL: ReadonlySet<CommandStatus> = new Set(['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED'])

export interface CommandRecord {
  id: string
  type: CommandType
  params: Record<string, unknown>
  status: CommandStatus
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

export interface QueueOptions {
  /** 队列最多排多少条（超了拒绝新命令） */
  maxQueue?: number
  /** 命令多久没被取走就算过期 */
  ttlMs?: number
  /** DELIVERED 之后多久没结果就再投一次（游戏端按 id 去重） */
  redeliverAfterMs?: number
  /** 结果里 result 字段的最大字节数（超了截断并标记） */
  maxResultBytes?: number
  now?: () => number
}

export interface PollResult {
  command: CommandRecord | null
  pending: number
}

/**
 * 命令结果的归一化：Lua 的空表既可能是数组也可能是对象，编码出来都是 {}。
 * telemetry 通道在 M3 就做了归一化，命令结果通道之前漏了（get_state 的 inventory.items 会变成 {}）。
 */
export function normalizeResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeResult(item))
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    const isArrayKey = key === 'items' || key === 'entities' || key === 'received_keys'
    if (isArrayKey && item !== null && typeof item === 'object' && !Array.isArray(item)) {
      // 空对象 → 空数组（Lua 空表）
      out[key] = Object.keys(item as Record<string, unknown>).length === 0 ? [] : normalizeResult(item)
    } else {
      out[key] = normalizeResult(item)
    }
  }
  return out
}

function shorten(result: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  let text: string
  try {
    text = JSON.stringify(result ?? null)
  } catch {
    return { value: null, truncated: true }
  }
  if (Buffer.byteLength(text) <= maxBytes) return { value: result, truncated: false }
  // 截断：保留形状，去掉内容
  return { value: { truncated: true, original_bytes: Buffer.byteLength(text) }, truncated: true }
}

export class CommandQueue {
  private readonly commands = new Map<string, CommandRecord>()
  private sequence = 0
  private readonly now: () => number
  private readonly maxQueue: number
  private readonly ttlMs: number
  private readonly redeliverAfterMs: number
  private readonly maxResultBytes: number

  constructor(options: QueueOptions = {}) {
    this.now = options.now ?? Date.now
    this.maxQueue = options.maxQueue ?? 100
    this.ttlMs = options.ttlMs ?? 60000
    this.redeliverAfterMs = options.redeliverAfterMs ?? 5000
    this.maxResultBytes = options.maxResultBytes ?? 64 * 1024
  }

  /** 入队。类型必须在白名单里（本阶段只有 4 个测试命令） */
  enqueue(type: string, params: Record<string, unknown> = {}, options: { shard?: string | null } = {}): CommandRecord {
    if (!(COMMAND_TYPES as readonly string[]).includes(type)) {
      throw new Error(`unsupported_command_type: ${type}（本阶段只允许 ${COMMAND_TYPES.join('/')}）`)
    }
    this.expire()
    const queued = [...this.commands.values()].filter((command) => command.status === 'QUEUED').length
    if (queued >= this.maxQueue) throw new Error(`queue_full: 队列已满（${this.maxQueue}）`)

    this.sequence += 1
    const at = this.now()
    const id = `cmd_${at.toString(36)}_${this.sequence.toString(36)}`
    const record: CommandRecord = {
      id,
      type: type as CommandType,
      params,
      status: 'QUEUED',
      createdAt: at,
      expiresAt: at + this.ttlMs,
      sessionId: null,
      shard: options.shard ?? null,
      deliveredAt: null,
      deliveries: 0,
      executingAt: null,
      finishedAt: null,
      result: null,
      error: null,
      executionTime: null,
      late: false,
      note: null,
    }
    this.commands.set(id, record)
    return record
  }

  /** 把过期的 QUEUED 命令标成 EXPIRED */
  expire(): number {
    const at = this.now()
    let count = 0
    for (const command of this.commands.values()) {
      if (command.status === 'QUEUED' && at > command.expiresAt) {
        command.status = 'EXPIRED'
        command.finishedAt = at
        command.error = 'expired'
        count += 1
      }
    }
    return count
  }

  /**
   * 会话来轮询：
   *   · 先处理过期；
   *   · 优先重投"已经投给它但超时没结果"的命令；
   *   · 再取一条 QUEUED（按创建时间）。
   */
  poll(sessionId: string, shard: string | null): PollResult {
    this.expire()
    const at = this.now()

    const redeliver = [...this.commands.values()].find(
      (command) =>
        command.sessionId === sessionId &&
        (command.status === 'DELIVERED' || command.status === 'EXECUTING') &&
        command.deliveredAt !== null &&
        at - command.deliveredAt >= this.redeliverAfterMs,
    )
    if (redeliver) {
      redeliver.deliveredAt = at
      redeliver.deliveries += 1
      return { command: redeliver, pending: this.pendingCount() }
    }

    const next = [...this.commands.values()]
      .filter((command) => command.status === 'QUEUED')
      .filter((command) => command.shard === null || command.shard === shard)
      .sort((a, b) => a.createdAt - b.createdAt)[0]
    if (!next) return { command: null, pending: this.pendingCount() }

    next.status = 'DELIVERED'
    next.sessionId = sessionId
    next.shard = shard ?? next.shard
    next.deliveredAt = at
    next.deliveries += 1
    return { command: next, pending: this.pendingCount() }
  }

  /**
   * 收执行回执。第一次为准，重复回执只返回当前状态（duplicate: true）。
   * 如果命令已被判 unknown_completion（会话丢失）却又收到迟到结果，接受并标 late。
   */
  settle(
    sessionId: string,
    payload: { commandId: string; status: CommandStatus; result?: unknown; error?: string | null; executionTime?: number | null },
  ): { ok: boolean; reason?: string; command?: CommandRecord; duplicate: boolean } {
    const command = this.commands.get(payload.commandId)
    if (!command) return { ok: false, reason: 'unknown_command', duplicate: false }
    if (command.sessionId !== null && command.sessionId !== sessionId) {
      return { ok: false, reason: 'session_mismatch', command, duplicate: false }
    }
    if (payload.status === 'EXECUTING') {
      if (TERMINAL.has(command.status)) return { ok: true, command, duplicate: true }
      command.status = 'EXECUTING'
      command.executingAt = this.now()
      return { ok: true, command, duplicate: false }
    }

    const isTerminalReport = payload.status === 'SUCCEEDED' || payload.status === 'FAILED'
    if (!isTerminalReport) return { ok: false, reason: 'invalid_status', command, duplicate: false }

    const alreadyTerminal = TERMINAL.has(command.status)
    if (alreadyTerminal) {
      const wasUnknown = command.status === 'FAILED' && command.error === 'unknown_completion'
      if (wasUnknown) {
        // 迟到结果：说明命令其实执行完了，按上报结果修正，并标 late
        const shortened = shorten(payload.result, this.maxResultBytes)
        command.status = payload.status
        command.result = shortened.value
        command.error = payload.error ?? null
        command.executionTime = payload.executionTime ?? null
        command.finishedAt = this.now()
        command.late = true
        return { ok: true, command, duplicate: false }
      }
      return { ok: true, command, duplicate: true }
    }

    const shortened = shorten(normalizeResult(payload.result), this.maxResultBytes)
    command.status = payload.status
    command.result = shortened.value
    command.error = payload.error ?? null
    command.executionTime = payload.executionTime ?? null
    command.finishedAt = this.now()
    if (shortened.truncated) command.note = 'result_truncated'
    return { ok: true, command, duplicate: false }
  }

  /**
   * 会话消失（游戏重启/换会话）：已投递但没结果的命令状态未知，
   * **不重放**，直接判 FAILED + unknown_completion。
   */
  reapSession(sessionId: string, reason = 'unknown_completion'): number {
    let count = 0
    for (const command of this.commands.values()) {
      if (
        command.sessionId === sessionId &&
        (command.status === 'DELIVERED' || command.status === 'EXECUTING')
      ) {
        command.status = 'FAILED'
        command.error = reason
        command.finishedAt = this.now()
        command.note = 'session_lost'
        count += 1
      }
    }
    return count
  }

  cancel(id: string, reason = 'cancelled'): boolean {
    const command = this.commands.get(id)
    if (!command || TERMINAL.has(command.status)) return false
    command.status = 'CANCELLED'
    command.error = reason
    command.finishedAt = this.now()
    return true
  }

  pendingCount(): number {
    return [...this.commands.values()].filter((command) => command.status === 'QUEUED').length
  }

  activeCount(): number {
    return [...this.commands.values()].filter(
      (command) => command.status === 'QUEUED' || command.status === 'DELIVERED' || command.status === 'EXECUTING',
    ).length
  }

  /** 导出（落盘用） */
  export(): CommandRecord[] {
    return [...this.commands.values()]
  }

  /**
   * 从落盘数据恢复。已终态的原样恢复（绝不重放）；
   * DELIVERED / EXECUTING 的保持原状态，等轮询侧按“会话是否还活着”决定 reap。
   */
  restore(records: CommandRecord[]): number {
    let count = 0
    for (const record of records) {
      if (record === null || typeof record !== 'object') continue
      if (typeof record.id !== 'string' || record.id.length === 0) continue
      this.commands.set(record.id, {
        ...record,
        params: (record.params ?? {}) as Record<string, unknown>,
        late: record.late === true,
        note: record.note ?? null,
      })
      count += 1
      // 让 id 计数器不会和恢复进来的冲突
      const suffix = Number.parseInt(String(record.id).split('_').pop() ?? '0', 36)
      if (Number.isFinite(suffix) && suffix > this.sequence) this.sequence = suffix
    }
    return count
  }

  get(id: string): CommandRecord | null {
    return this.commands.get(id) ?? null
  }

  list(limit = 50): CommandRecord[] {
    return [...this.commands.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
  }

  stats(): Record<CommandStatus | 'total', number> {
    const counts: Record<string, number> = { total: this.commands.size }
    for (const status of COMMAND_STATUSES) counts[status] = 0
    for (const command of this.commands.values()) counts[command.status] = (counts[command.status] ?? 0) + 1
    return counts as Record<CommandStatus | 'total', number>
  }
}
