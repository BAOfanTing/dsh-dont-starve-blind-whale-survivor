// Phase 5 · Action Protocol（M1）
//
// 在 Phase 2 命令协议基础上扩展的**游戏动作协议**。
//
// 关键设计（任务书 §6）：
//   · 每条动作带 command_id / action_id / idempotency_key / session_id / controller_id /
//     timestamps / expected_state_sequence / action_type / payload；
//   · 9 态执行状态机（Phase 2 只有 7 态，这里补齐 PENDING/VALIDATING/ACCEPTED/RUNNING/
//     NEEDS_RECONCILIATION）；
//   · 断线导致"是否完成无法确认" → NEEDS_RECONCILIATION，**禁止盲目重放**；
//   · M1 只做协议与状态机，不下发任何真实动作。

/** 动作执行状态（9 态） */
export const ACTION_STATUSES = [
  'PENDING',
  'VALIDATING',
  'ACCEPTED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMEOUT',
  'NEEDS_RECONCILIATION',
] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]

export const TERMINAL_STATUSES: ReadonlySet<ActionStatus> = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMEOUT',
  'NEEDS_RECONCILIATION',
])

/** 合法状态迁移（非法迁移直接拒绝，不静默改状态） */
const TRANSITIONS: Record<ActionStatus, ReadonlySet<ActionStatus>> = {
  // 排队/校验/已接受阶段超时 → TIMEOUT（还没开始执行，结果确定是"没执行"）
  PENDING: new Set<ActionStatus>(['VALIDATING', 'ACCEPTED', 'CANCELLED', 'FAILED', 'TIMEOUT']),
  VALIDATING: new Set<ActionStatus>(['ACCEPTED', 'FAILED', 'CANCELLED', 'TIMEOUT']),
  ACCEPTED: new Set<ActionStatus>(['RUNNING', 'CANCELLED', 'TIMEOUT', 'FAILED']),
  // 执行中失联/超时 → 结果未知，必须 NEEDS_RECONCILIATION，不能直接标 TIMEOUT
  RUNNING: new Set<ActionStatus>(['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_RECONCILIATION']),
  SUCCEEDED: new Set<ActionStatus>(),
  FAILED: new Set<ActionStatus>(),
  CANCELLED: new Set<ActionStatus>(),
  // TIMEOUT 只针对"确定没执行"的动作，可以转需协调（若后来发现其实执行了）
  TIMEOUT: new Set<ActionStatus>(['NEEDS_RECONCILIATION']),
  NEEDS_RECONCILIATION: new Set<ActionStatus>(['SUCCEEDED', 'FAILED', 'CANCELLED']),
}

export function canTransition(from: ActionStatus, to: ActionStatus): boolean {
  return TRANSITIONS[from].has(to)
}

/** 控制模式（任务书 §5） */
export const CONTROL_MODES = ['MANUAL', 'SUPERVISED', 'AUTONOMOUS', 'PAUSED', 'EMERGENCY_STOP'] as const
export type ControlMode = (typeof CONTROL_MODES)[number]

/** 第一版动作类型白名单：M1 只登记，不实现执行 */
export const ACTION_TYPES = [
  'move_to', 'move_to_target', 'stop_movement', 'get_movement_status',
  'gather_resource', 'pick_up_item', 'collect_dropped_items',
  'equip_item', 'chop_tree', 'mine_rock',
  'eat_item', 'craft_item', 'build_structure', 'build_campfire',
  'get_action_status', 'cancel_action', 'get_control_status',
] as const
export type ActionType = (typeof ACTION_TYPES)[number]

/** 需要人工确认的动作（任务书 §11） */
export const CONFIRMATION_REQUIRED: ReadonlySet<ActionType> = new Set<ActionType>([
  'chop_tree', 'mine_rock', 'eat_item', 'craft_item', 'build_structure', 'build_campfire',
])

/** 纯查询类动作（不修改游戏状态，M1 允许 dry-run） */
export const READ_ONLY_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'get_movement_status', 'get_action_status', 'get_control_status',
])

export interface ActionCommand {
  command_id: string
  action_id: string
  idempotency_key: string
  session_id: string
  controller_id: string
  created_at: number
  expires_at: number
  expected_state_sequence: number | null
  action_type: ActionType
  payload: Record<string, unknown>
  /** 是否 dry-run（M1 强制 true） */
  dry_run: boolean
}

export type RejectReason =
  | 'INVALID_ARGUMENT'
  | 'UNKNOWN_ACTION'
  | 'CONTROL_NOT_HELD'
  | 'CONTROL_EXPIRED'
  | 'CONTROL_MODE_DENIED'
  | 'EMERGENCY_STOP'
  | 'SESSION_MISMATCH'
  | 'EXPIRED'
  | 'DUPLICATE'
  | 'NEEDS_RECONCILIATION'
  | 'ILLEGAL_TRANSITION'
  | 'NOT_IMPLEMENTED'

export interface ActionRecord {
  command: ActionCommand
  status: ActionStatus
  updated_at: number
  /** 状态迁移历史（可执行审计） */
  history: Array<{ status: ActionStatus; at: number; reason: string | null }>
  confirmation_required: boolean
  confirmed: boolean
  result: unknown
  error: { code: RejectReason; message: string } | null
  /** 幂等命中时指向首次执行的 action_id */
  deduplicated_from: string | null
}

/** 校验动作命令的必填字段与取值范围 */
export function parseActionCommand(raw: unknown, now: number): { ok: true; value: ActionCommand } | { ok: false; code: RejectReason; message: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: '请求体必须是 JSON 对象' }
  }
  const r = raw as Record<string, unknown>
  const str = (key: string, max = 128): string | null => {
    const v = r[key]
    return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null
  }

  const command_id = str('command_id')
  const action_id = str('action_id')
  const idempotency_key = str('idempotency_key')
  const controller_id = str('controller_id')
  const session_id = str('session_id')
  if (!command_id || !action_id || !idempotency_key || !controller_id || !session_id) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少或非法 command_id/action_id/idempotency_key/controller_id/session_id（字符串 1~128）' }
  }
  if (!(ACTION_TYPES as readonly string[]).includes(String(r.action_type))) {
    return { ok: false, code: 'UNKNOWN_ACTION', message: `未知动作：${String(r.action_type)}` }
  }
  const payload = r.payload
  if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'payload 必须是对象' }
  }
  const created_at = typeof r.created_at === 'number' && Number.isFinite(r.created_at) ? r.created_at : now
  const expires_at = typeof r.expires_at === 'number' && Number.isFinite(r.expires_at) ? r.expires_at : created_at + 60_000
  if (expires_at <= created_at) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'expires_at 必须大于 created_at' }
  }
  const seq = r.expected_state_sequence
  if (seq !== undefined && seq !== null && (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0)) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'expected_state_sequence 必须是 ≥0 的整数或 null' }
  }

  return {
    ok: true,
    value: {
      command_id,
      action_id,
      idempotency_key,
      session_id,
      controller_id,
      created_at,
      expires_at,
      expected_state_sequence: (seq as number | null) ?? null,
      action_type: r.action_type as ActionType,
      payload: (payload ?? {}) as Record<string, unknown>,
      dry_run: r.dry_run === true,
    },
  }
}
