// Phase 6 M4 · Combat State Machine（战斗状态机）
//
// 任务书 §5 要求：
//   IDLE / ASSESSING / PREPARING / ENGAGING / EVADING / RETREATING / RECOVERING / COMPLETE / ABORTED
//   + 状态转移检查 + 动作取消 + 人工接管 + 中断恢复 + 进度监控 + 多敌人 + 武器护甲监控
//
// 这一层是 Node 侧的权威视图（Lua 的 combat_executor 是执行侧的同构状态机）。
// 为什么两边都要有：
//   · Lua 侧要 0.1 秒一次做 Kiting，必须有自己的高精度状态；
//   · Node 侧要能审计（"它到底走到哪一步了"）、要做到**同一时间只有一个战斗执行器**，
//     并且要能在 Bridge/游戏卡住时明确说"结果未知"，不能只信 Lua。

export const COMBAT_STATES = [
  'IDLE',
  'ASSESSING',
  'PREPARING',
  'ENGAGING',
  'EVADING',
  'RETREATING',
  'RECOVERING',
  'COMPLETE',
  'ABORTED',
] as const

export type CombatState = (typeof COMBAT_STATES)[number]

/** 合法转移表（和 combat_executor.lua 的 TRANSITIONS 保持一致） */
export const COMBAT_TRANSITIONS: Readonly<Record<CombatState, readonly CombatState[]>> = Object.freeze({
  IDLE: ['ASSESSING'],
  ASSESSING: ['PREPARING', 'EVADING', 'RETREATING', 'ABORTED', 'COMPLETE'],
  PREPARING: ['ENGAGING', 'RETREATING', 'ABORTED'],
  ENGAGING: ['EVADING', 'RETREATING', 'RECOVERING', 'COMPLETE', 'ABORTED'],
  EVADING: ['RETREATING', 'RECOVERING', 'COMPLETE', 'ABORTED'],
  RETREATING: ['RECOVERING', 'COMPLETE', 'ABORTED'],
  RECOVERING: ['COMPLETE', 'ABORTED'],
  COMPLETE: ['IDLE'],
  ABORTED: ['IDLE'],
})

export function canTransition(from: CombatState, to: CombatState): boolean {
  return COMBAT_TRANSITIONS[from].includes(to)
}

export const ACTIVE_STATES: readonly CombatState[] = ['ASSESSING', 'PREPARING', 'ENGAGING', 'EVADING', 'RETREATING', 'RECOVERING']
export const TERMINAL_STATES: readonly CombatState[] = ['COMPLETE', 'ABORTED']

export interface TransitionRecord {
  from: CombatState
  to: CombatState
  at: number
  why: string
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: CombatState,
    readonly to: CombatState,
  ) {
    super(`非法的战斗状态转移：${from} → ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

/** 一个战斗会话（一个玩家同一时间只能有一个） */
export class CombatStateMachine {
  private current: CombatState = 'IDLE'
  private readonly history: TransitionRecord[] = []

  constructor(
    readonly playerId: string,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): CombatState {
    return this.current
  }

  isActive(): boolean {
    return ACTIVE_STATES.includes(this.current)
  }

  isTerminal(): boolean {
    return TERMINAL_STATES.includes(this.current)
  }

  transition(to: CombatState, why: string): void {
    if (to === this.current) return
    if (!canTransition(this.current, to)) throw new IllegalTransitionError(this.current, to)
    this.history.push({ from: this.current, to, at: this.now(), why })
    this.current = to
  }

  /** 开始一场新战斗：终态先回 IDLE，再进 ASSESSING */
  begin(): void {
    if (this.isActive()) throw new Error('已经有一个战斗在执行（同一时间只允许一个战斗执行器）')
    if (this.isTerminal()) this.transition('IDLE', 'reset')
    this.transition('ASSESSING', 'start_combat')
  }

  abort(why: string): void {
    if (this.isTerminal()) return
    if (!canTransition(this.current, 'ABORTED')) {
      // 极端情况：状态机错乱时也要能停手，直接落到 ABORTED（并记审计）
      this.history.push({ from: this.current, to: 'ABORTED', at: this.now(), why: `${why}（强制）` })
      this.current = 'ABORTED'
      return
    }
    this.transition('ABORTED', why)
  }

  /** 中断后恢复：从终止态回 IDLE，允许下一场 */
  resetToIdle(why: string): void {
    if (!this.isTerminal()) return
    this.transition('IDLE', why)
  }

  getHistory(): TransitionRecord[] {
    return [...this.history]
  }

  /** 进度快照（给 get_combat_status 用） */
  snapshot(): {
    state: CombatState
    active: boolean
    terminal: boolean
    allowed_next: readonly CombatState[]
    history: TransitionRecord[]
  } {
    return {
      state: this.current,
      active: this.isActive(),
      terminal: this.isTerminal(),
      allowed_next: COMBAT_TRANSITIONS[this.current],
      history: this.getHistory(),
    }
  }
}

/** 全局单执行者锁：key = 玩家标识（guid / userid / sessionId） */
export class CombatLock {
  private holder: string | null = null

  acquire(playerId: string, owner: string): { ok: boolean; reason?: string } {
    if (this.holder !== null && this.holder !== playerId) {
      return { ok: false, reason: `玩家 ${playerId} 上已有战斗执行器：${this.holder}` }
    }
    this.holder = playerId
    return { ok: true }
  }

  release(playerId: string): void {
    if (this.holder === playerId) this.holder = null
  }

  getHolder(): string | null {
    return this.holder
  }
}
