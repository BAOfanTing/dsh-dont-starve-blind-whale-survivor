// Phase 6 M4 · Combat Controller（Node 侧战斗编排器）
//
// 职责：
//   1. 把"战斗决策"翻译成一条 Lua 命令（start_combat / retreat_from_combat / evade_threat / abort_combat）；
//   2. 保证**同一时间只有一个战斗执行器**（CombatLock + 状态机双保险）；
//   3. 每次下发前在程序层复检：要不要确认、目标是否在白名单、是不是 Boss、控制权有没有；
//   4. 把 Lua 侧的真实状态（get_combat_status）合并进来，让上层看到"到底打到哪一步了"。
//
// 刻意不做的事：
//   · 不在这里做 Kiting（那是 Lua 0.1 秒 tick 的事）；
//   · 不自己申请控制权（控制权只能由人授予）；
//   · 不因为"看起来该打"就自动开打（本阶段没有 AUTONOMOUS）。

import { autoEngageList, getEnemyProfile, isBossPrefab } from './profiles.js'
import type { CombatDecision } from './combat.js'
import { CombatLock, CombatStateMachine, type CombatState } from './combatState.js'

export interface EnqueueResult {
  commandId: string
  status: string
}

export interface CombatControllerDeps {
  /** 下发命令（由 MCP 工具层接到 Bridge）；reject 表示下发失败 */
  enqueue: (type: string, params: Record<string, unknown>) => Promise<EnqueueResult>
  /** 查 Lua 侧战斗状态（走 get_combat_status 命令）；拿不到返回 null */
  readLuaStatus: () => Promise<Record<string, unknown> | null>
  now?: () => number
}

export interface StartCombatRequest {
  playerId: string
  targetPrefab: string | null
  /** 人工确认（必须显式 true） */
  confirmed: boolean
  /** Node 侧的决策结论；只有 ENGAGE 才允许下发 */
  decision: CombatDecision | null
  params?: {
    radius?: number
    max_enemies?: number
    max_duration_s?: number
    retreat_hp_percent?: number
    kite_distance?: number
  }
  /** 控制权状态（由工具层查好传进来，避免控制器自己偷偷申请） */
  control: { holder: string | null; leaseValid: boolean; canExecute: boolean; sessionId: string }
}

export interface StartCombatResult {
  ok: boolean
  code?: string
  message?: string
  commandId?: string
  state?: CombatState
}

export interface NodeCombatView {
  state: CombatState
  active: boolean
  terminal: boolean
  allowed_next: readonly CombatState[]
  history: Array<{ from: CombatState; to: CombatState; at: number; why: string }>
  active_command: { commandId: string; targetPrefab: string | null; startedAt: number } | null
  lock_holder: string | null
}

export class CombatController {
  private readonly machine = new CombatStateMachine('player', Date.now)
  private readonly lock = new CombatLock()
  private active: { commandId: string; targetPrefab: string | null; startedAt: number } | null = null

  constructor(private readonly deps: CombatControllerDeps) {}

  /** 当前 Node 侧视图 */
  get view(): NodeCombatView {
    return {
      ...this.machine.snapshot(),
      active_command: this.active,
      lock_holder: this.lock.getHolder(),
    }
  }

  /** 合并 Lua 侧状态（拿不到就如实返回 null） */
  async status(): Promise<{
    node_view: NodeCombatView
    lua_status: Record<string, unknown> | null
    lua_available: boolean
  }> {
    let lua: Record<string, unknown> | null = null
    try {
      lua = await this.deps.readLuaStatus()
    } catch {
      lua = null
    }
    return { node_view: this.view, lua_status: lua, lua_available: lua !== null }
  }

  async start(request: StartCombatRequest): Promise<StartCombatResult> {
    const { playerId, targetPrefab, confirmed, decision, control } = request

    // ① 人工确认
    if (confirmed !== true) {
      return { ok: false, code: 'confirmation_required', message: 'start_combat 需要人工确认（confirmed=true）：第一版只有 SUPERVISED_COMBAT' }
    }
    // ② 控制权（程序层，不靠提示词）
    if (!control.canExecute || control.holder === null || !control.leaseValid) {
      return { ok: false, code: 'CONTROL_REQUIRED', message: '没有有效控制权（holder/lease）：先由人授予控制权' }
    }
    // ③ 决策必须明确是 ENGAGE
    if (decision === null) {
      return { ok: false, code: 'DECISION_REQUIRED', message: '缺少战斗决策：先跑 get_combat_recommendation' }
    }
    if (decision.decision !== 'ENGAGE') {
      return {
        ok: false,
        code: `DECISION_${decision.decision}`,
        message: `决策是 ${decision.decision}，不是 ENGAGE：${decision.reasons.join('；')}`,
      }
    }
    // ④ 目标白名单 / Boss 硬拦
    if (targetPrefab !== null && targetPrefab.length > 0) {
      if (isBossPrefab(targetPrefab)) {
        return { ok: false, code: 'BOSS_REQUIRES_SUPERVISION', message: `${targetPrefab} 是 Boss：本阶段不允许通过 start_combat 开战` }
      }
      const profile = getEnemyProfile(targetPrefab)
      if (!profile.auto_engage_allowed) {
        return {
          ok: false,
          code: 'UNVERIFIED_ENEMY',
          message: `${targetPrefab} 不在自动交战白名单（允许的：${autoEngageList().join('/')}）`,
        }
      }
    }
    // ⑤ 单执行者
    const lock = this.lock.acquire(playerId, 'combat')
    if (!lock.ok) {
      return { ok: false, code: 'COMBAT_BUSY', message: lock.reason ?? '已有战斗在执行' }
    }
    if (this.machine.isActive()) {
      this.lock.release(playerId)
      return { ok: false, code: 'COMBAT_BUSY', message: `战斗状态机仍在 ${this.machine.state}，先 abort_combat` }
    }

    try {
      const submitted = await this.deps.enqueue('start_combat', {
        ...(targetPrefab === null ? {} : { target_prefab: targetPrefab }),
        ...(request.params?.radius === undefined ? {} : { radius: request.params.radius }),
        ...(request.params?.max_enemies === undefined ? {} : { max_enemies: request.params.max_enemies }),
        ...(request.params?.max_duration_s === undefined ? {} : { max_duration_s: request.params.max_duration_s }),
        ...(request.params?.retreat_hp_percent === undefined ? {} : { retreat_hp_percent: request.params.retreat_hp_percent }),
        ...(request.params?.kite_distance === undefined ? {} : { kite_distance: request.params.kite_distance }),
        confirmed: true,
      })
      this.machine.begin()
      this.active = { commandId: submitted.commandId, targetPrefab, startedAt: this.deps.now?.() ?? Date.now() }
      return { ok: true, commandId: submitted.commandId, state: this.machine.state }
    } catch (error) {
      this.lock.release(playerId)
      return { ok: false, code: 'ENQUEUE_FAILED', message: String((error as Error).message ?? error) }
    }
  }

  /** 撤退（明确授权后可自动执行；这里仍然要求控制权） */
  async retreat(playerId: string, control: StartCombatRequest['control'], params: Record<string, unknown> = {}): Promise<StartCombatResult> {
    if (!control.canExecute || control.holder === null) {
      return { ok: false, code: 'CONTROL_REQUIRED', message: '没有有效控制权' }
    }
    if (this.machine.state === 'ENGAGING' || this.machine.state === 'ASSESSING' || this.machine.state === 'PREPARING') {
      this.machine.transition('RETREATING', 'retreat_command')
    }
    try {
      const submitted = await this.deps.enqueue('retreat_from_combat', params)
      return { ok: true, commandId: submitted.commandId, state: this.machine.state }
    } catch (error) {
      return { ok: false, code: 'ENQUEUE_FAILED', message: String((error as Error).message ?? error) }
    }
  }

  /** 规避（明确授权后可自动执行） */
  async evade(playerId: string, control: StartCombatRequest['control'], params: Record<string, unknown> = {}): Promise<StartCombatResult> {
    if (!control.canExecute || control.holder === null) {
      return { ok: false, code: 'CONTROL_REQUIRED', message: '没有有效控制权' }
    }
    if (this.machine.isActive()) {
      return { ok: false, code: 'COMBAT_BUSY', message: `战斗仍在进行（${this.machine.state}），先 abort_combat` }
    }
    try {
      const submitted = await this.deps.enqueue('evade_threat', params)
      return { ok: true, commandId: submitted.commandId, state: this.machine.state }
    } catch (error) {
      return { ok: false, code: 'ENQUEUE_FAILED', message: String((error as Error).message ?? error) }
    }
  }

  /** 中止：永远允许，立刻生效（紧急停止的最高优先级在这里体现） */
  async abort(playerId: string, control: StartCombatRequest['control']): Promise<StartCombatResult> {
    this.machine.abort('abort_command')
    this.lock.release(playerId)
    this.active = null
    if (!control.canExecute || control.holder === null) {
      return { ok: false, code: 'CONTROL_REQUIRED', message: '没有有效控制权：请在游戏里用紧急停止（F7 / stop）停手' }
    }
    try {
      const submitted = await this.deps.enqueue('abort_combat', {})
      return { ok: true, commandId: submitted.commandId, state: this.machine.state }
    } catch (error) {
      return { ok: false, code: 'ENQUEUE_FAILED', message: String((error as Error).message ?? error) }
    }
  }

  /** 战斗结束后回到 IDLE（允许下一场） */
  resetAfterTerminal(): void {
    if (this.machine.isTerminal()) {
      this.machine.resetToIdle('acknowledged')
      this.lock.release(this.lock.getHolder() ?? '')
      this.active = null
    }
  }
}

export function createCombatController(deps: CombatControllerDeps): CombatController {
  return new CombatController(deps)
}
