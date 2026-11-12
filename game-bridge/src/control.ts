// Phase 5 M2 · Bridge 侧控制权持久化
//
// 为什么单独一个文件、不塞进 PersistedState：
//   PersistedState 是 Phase 2 的落盘结构（version=1，含 sessions/commands），
//   改它的结构就要升 version，会让已有的 bridge-state.json 恢复失效。
//   控制权是 Phase 5 新增的、独立生命周期的数据，单独落盘最安全。
//
// 职责：把 Control Manager 的状态落到 Bridge（跨层一致性的权威副本），
//       并提供给 Lua 执行端查询（Lua 每个动作执行前要再校验一次）。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type ControlMode = 'MANUAL' | 'SUPERVISED' | 'AUTONOMOUS' | 'PAUSED' | 'EMERGENCY_STOP'

export interface ControlState {
  version: number
  mode: ControlMode
  holder: string | null
  session_id: string | null
  lease_expires_at: number | null
  emergency_stop: boolean
  updated_at: number
  /** 每次变更追加一条，最多保留 50 条 */
  history: Array<{ at: number; mode: ControlMode; holder: string | null; reason: string }>
}

export const CONTROL_STATE_VERSION = 1

export function defaultControlState(now = Date.now()): ControlState {
  return {
    version: CONTROL_STATE_VERSION,
    mode: 'SUPERVISED',
    holder: null,
    session_id: null,
    lease_expires_at: null,
    emergency_stop: false,
    updated_at: now,
    history: [{ at: now, mode: 'SUPERVISED', holder: null, reason: '初始化（默认监督模式）' }],
  }
}

export interface ControlStateStoreOptions {
  path: string
  now?: () => number
}

/** 落盘 + 内存缓存；写入失败不致命（只丢恢复能力），但会在 status 里标记 */
export class ControlStateStore {
  private state: ControlState
  private readonly now: () => number
  private lastError: string | null = null

  constructor(private readonly options: ControlStateStoreOptions) {
    this.now = options.now ?? Date.now
    this.state = this.load() ?? defaultControlState(this.now())
  }

  private load(): ControlState | null {
    if (!existsSync(this.options.path)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.options.path, 'utf8')) as ControlState
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== CONTROL_STATE_VERSION) return null
      if (typeof parsed.mode !== 'string' || !Array.isArray(parsed.history)) return null
      return parsed
    } catch {
      return null
    }
  }

  private save(): void {
    const text = JSON.stringify(this.state)
    try {
      mkdirSync(dirname(this.options.path), { recursive: true })
      const tmp = this.options.path + '.tmp'
      writeFileSync(tmp, text, 'utf8')
      renameSync(tmp, this.options.path)
      this.lastError = null
    } catch (error) {
      this.lastError = String((error as Error)?.message ?? error)
    }
  }

  get(): ControlState {
    return { ...this.state, history: [...this.state.history] }
  }

  /** 覆盖式更新（Controller 同步过来的权威状态） */
  update(input: Omit<ControlState, 'version' | 'updated_at' | 'history'> & { reason: string }): ControlState {
    const at = this.now()
    this.state = {
      version: CONTROL_STATE_VERSION,
      mode: input.mode,
      holder: input.holder,
      session_id: input.session_id,
      lease_expires_at: input.lease_expires_at,
      emergency_stop: input.emergency_stop,
      updated_at: at,
      history: [
        ...this.state.history,
        { at, mode: input.mode, holder: input.holder, reason: input.reason },
      ].slice(-50),
    }
    this.save()
    return this.get()
  }

  /**
   * Lua 执行端的二次校验：给定 controller_id / session_id，判断此刻是否允许执行写动作。
   * 这是 Bridge 侧的权威判定，Lua 不自己存状态，每次动作前问一次。
   */
  assertCanExecute(controllerId: string, sessionId: string, readOnly = false): { allowed: boolean; code: string; message: string } {
    const s = this.state
    const at = this.now()
    if (s.emergency_stop || s.mode === 'EMERGENCY_STOP') {
      return { allowed: false, code: 'EMERGENCY_STOP', message: '紧急停止中，所有动作被拒' }
    }
    if (s.mode === 'MANUAL') {
      return { allowed: false, code: 'MANUAL_OVERRIDE', message: '人工接管中' }
    }
    if (s.mode === 'PAUSED') {
      return { allowed: false, code: 'CONTROL_MODE_DENIED', message: '已暂停' }
    }
    if (readOnly) return { allowed: true, code: 'OK', message: 'ok' }
    if (s.holder === null) {
      return { allowed: false, code: 'CONTROL_NOT_HELD', message: '没有控制器持有写权限' }
    }
    if (s.holder !== controllerId) {
      return { allowed: false, code: 'CONTROL_NOT_HELD', message: `控制权属于 ${s.holder}` }
    }
    if (s.session_id !== null && s.session_id !== sessionId) {
      return { allowed: false, code: 'SESSION_MISMATCH', message: 'session_id 与控制权记录不一致' }
    }
    if (s.lease_expires_at === null || at >= s.lease_expires_at) {
      return { allowed: false, code: 'CONTROL_EXPIRED', message: '控制权 lease 已过期' }
    }
    return { allowed: true, code: 'OK', message: 'ok' }
  }

  status() {
    return {
      ...this.get(),
      persisted: true,
      last_error: this.lastError,
    }
  }
}
