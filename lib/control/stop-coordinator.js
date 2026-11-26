// R8.0：统一停止协调器（StopCoordinator）。
//
// 目标：F8 / DSH-MCP / 游戏停止开关 / 插件卸载 / Agent 空转 —— 只有**一个**停止协调入口。
// 本文件是**纯协调层**：它自己不碰游戏，也不直接下发命令；底层停止仍由
//   WorldRuntime → Dispatcher → GameBridge → Lua Guard → Lua Actions 完成。
//
// 设计红线（任务书 §三/§九）：
//   · 停止未确认前，**不释放 Lease**、**不开放控制权交接**（releaseLease 由本类在确认后回调）。
//   · 超时 ≠ 成功：超时/拿不到 ACK/锁未释放 → status=unknown + 进入 quarantine。
//   · 同一运行世代的并发停止合并成**同一个 Promise**，只跑一次。
//   · 隔离只能由「旧执行链真正安全退出（锁已释放）」来解除，不能用超时清标志。
//
// P1 阶段：本类不接入任何现有入口（F8/MCP）；只提供完整状态机与 requestStop 语义，
// 由注入的依赖驱动，便于单元测试。后续 P2–P4 再接线真实 Runtime/Agent/Lease。

export const StopPhase = Object.freeze({
  IDLE: 'idle',
  STOP_REQUESTED: 'stop_requested',
  REJECTING_NEW_WORK: 'rejecting_new_work',
  CANCELLING_AGENT: 'cancelling_agent',
  CANCELLING_SKILL: 'cancelling_skill',
  DISPATCHING_STOP: 'dispatching_stop',
  AWAITING_LUA_ACK: 'awaiting_lua_ack',
  AWAITING_RUNTIME_RELEASE: 'awaiting_runtime_release',
  STOPPED: 'stopped',
  LEASE_HANDOVER: 'lease_handover',
  STOP_UNKNOWN: 'stop_unknown',
  QUARANTINE: 'quarantine',
})

const STOPPING_PHASES = new Set([
  StopPhase.STOP_REQUESTED,
  StopPhase.REJECTING_NEW_WORK,
  StopPhase.CANCELLING_AGENT,
  StopPhase.CANCELLING_SKILL,
  StopPhase.DISPATCHING_STOP,
  StopPhase.AWAITING_LUA_ACK,
  StopPhase.AWAITING_RUNTIME_RELEASE,
  StopPhase.LEASE_HANDOVER,
])

/** 带超时的 Promise；超时用一个带标记的错误拒绝，且不会遗留未处理的 rejection。 */
function withTimeout(promise, ms, tag) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`stop_timeout:${tag}`)
      err.__stopTimeout = true
      err.code = 'stop_timeout'
      reject(err)
    }, Math.max(1, ms))
  })
  // 避免 race 失败后原 promise 再 reject 造成 unhandledRejection
  try { promise.catch(() => {}) } catch {}
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

export class StopCoordinator {
  /**
   * @param {object} deps
   * @param {object} [deps.control]         LeaseManager（用 readAuthority 读当前世代/持有者）
   * @param {() => object|null} [deps.getRuntime] 取当前 active WorldRuntime（可能为 null）
   * @param {() => object|null} [deps.getAgent]   取当前 AiRunner（可能为 null）
   * @param {() => object|null} [deps.readAuthority] 直接读权威租约（优先于 control.readAuthority）
   * @param {(opts:object)=>Promise<object>} [deps.runtimeStop] 注入的底层停止执行（测试/接线用）
   * @param {(info:object)=>Promise<void>} [deps.releaseLease] 确认停止后释放/交接租约
   * @param {() => boolean|Promise<boolean>} [deps.isLockReleased] 查询 Runtime 锁是否已释放
   * @param {() => number} [deps.now]
   * @param {(level:string,msg:string)=>void} [deps.log]
   * @param {number} [deps.defaultTimeoutMs]
   */
  constructor({
    control = null,
    getRuntime = () => null,
    getAgent = () => null,
    readAuthority = null,
    runtimeStop = null,
    releaseLease = null,
    isLockReleased = null,
    now = () => Date.now(),
    log = () => {},
    defaultTimeoutMs = 8000,
  } = {}) {
    this.control = control
    this.getRuntime = getRuntime
    this.getAgent = getAgent
    this.readAuthority = readAuthority
    this.runtimeStop = runtimeStop
    this.releaseLease = releaseLease
    this.isLockReleased = isLockReleased
    this.now = now
    this.log = log
    this.defaultTimeoutMs = defaultTimeoutMs

    this.phase = StopPhase.IDLE
    this.generation = null
    this.quarantined = false
    this._inflight = null
    this._last = null
    this._diag = {}
  }

  // ── 只读状态 ──
  getStatus() {
    return {
      phase: this.phase,
      generation: this.generation,
      quarantined: this.quarantined,
      stopping: this.isStopping(),
      canAcceptNewWork: this.canAcceptNewWork(),
      last: this._last,
      diagnostics: { ...this._diag },
    }
  }

  isStopping() {
    return STOPPING_PHASES.has(this.phase)
  }

  isQuarantined() {
    return this.quarantined
  }

  /**
   * 是否允许新任务 / 新执行进入（停止中或隔离中 → 不允许）。
   *
   * ★ 真机事故（2026-11-26，新存档复现）：`stop` 超时进入隔离后，租约文件其实已经是
   *   `released`、状态文件也在正常刷新，但这里只看内存里的 `quarantined` 标志，
   *   于是"隔离"变成了永久状态 —— 模型连 `gather_area` 都发不出去，只能一直调 stop，
   *   而 stop 又因为拿不到 ACK 继续报 unknown。等于整个存档卡死。
   *
   *   隔离的本意是"旧执行链还没安全退出时别开新活"。既然 `tryRecover()` 已经能
   *   可靠判断"锁是不是真的释放了"，这里就该顺手问一次，而不是把恢复责任
   *   推给每个调用方（它们大多只会检查 `canAcceptNewWork`，不会主动 reset）。
   */
  canAcceptNewWork() {
    if (this.quarantined) {
      let recovered = false
      try { recovered = this.tryRecover()?.recovered === true } catch { recovered = false }
      if (!recovered) return false
    }
    return !this.isStopping() && !this.quarantined
  }

  // ── 内部工具 ──
  _authority() {
    try {
      if (typeof this.readAuthority === 'function') return this.readAuthority()
      if (this.control && typeof this.control.readAuthority === 'function') return this.control.readAuthority()
    } catch {}
    return null
  }

  _generation() {
    const a = this._authority()
    return a && a.generation != null ? a.generation : null
  }

  _holder() {
    const a = this._authority()
    if (!a) return null
    return {
      owner: a.owner_type ?? null,
      ownerInstanceId: a.owner_instance_id ?? null,
      generation: a.generation ?? null,
      authority_epoch: a.authority_epoch ?? null,
      lease_id: a.lease_id ?? null,
    }
  }

  _setPhase(phase, extra) {
    this.phase = phase
    if (extra) Object.assign(this._diag, extra)
    try { this.log('info', `[STOP] phase=${phase} world_owner=${this._diag.owner ?? '?'} gen=${this.generation ?? '?'}`) } catch {}
  }

  _buildResult(status, extra = {}) {
    const stopped = status === 'stopped'
    const quarantined = status === 'unknown' || this.quarantined
    return {
      ok: stopped,
      status, // 'stopped' | 'unknown' | 'refused' | 'idle'
      phase: this.phase,
      generation: this.generation,
      stop_requested: true,
      command_id: extra.command_id ?? null,
      active_task_id: this._diag.active_task_id ?? null,
      active_instance_id: this._diag.active_instance_id ?? null,
      quarantined,
      next_action_allowed: stopped && !quarantined,
      detail: extra.detail ?? '',
    }
  }

  /**
   * 请求停止（幂等、可并发合并）。调用方只表达意图，不直接操作底层。
   * @returns {Promise<object>} StopResult
   */
  async requestStop({ source = 'unknown', reason = 'user_stop', timeoutMs = this.defaultTimeoutMs, requester = null, releaseLease = true } = {}) {
    // ★ 任何入口、任何状态（含隔离/幂等）都必须先让 Agent 停手 —— 否则一旦隔离，F8 会“停不下来”。
    try { const a = this.getAgent?.(); if (a && typeof a.stop === 'function') a.stop(reason) } catch {}

    // 隔离中：先尝试在旧执行链已退出后解除隔离；解除不了则返回隔离态（此时 Agent 已停）
    if (this.quarantined) {
      const rec = this.tryRecover()
      if (!rec.recovered) {
        const r = this._buildResult('unknown', {
          detail: '隔离中且旧执行链尚未确认退出，禁止新任务与租约交接（Agent 已停止）',
        })
        this._last = r
        return r
      }
    }

    const gen = this._generation()

    // 已完成且同一非空世代：幂等返回上次结果，不再重复执行（gen===null 时不命中旧结果）
    if (this.phase === StopPhase.STOPPED && this._last && gen !== null && gen === this._last.generation) {
      return this._last
    }

    // 并发合并：已有正在进行的停止 → 共享同一个 Promise（同一次停止过程）
    if (this._inflight) {
      return this._inflight.promise
    }

    const token = { generation: gen, source, reason, requester, startedAt: this.now() }
    const holder = this._holder()
    this._diag = {
      source, reason, requester,
      generation: gen,
      owner: holder?.owner ?? null,
      owner_instance: holder?.ownerInstanceId ?? null,
      startedAt: token.startedAt,
    }
    this.generation = gen

    const promise = this._run(token, { timeoutMs, releaseLease, holder })
    this._inflight = { generation: gen, promise }
    // 结束时清 inflight（成功/失败都清；隔离态用 quarantined 标志继续拦截）
    promise.finally(() => {
      if (this._inflight && this._inflight.promise === promise) this._inflight = null
    })
    return promise
  }

  async _run(token, { timeoutMs, releaseLease, holder }) {
    this._setPhase(StopPhase.STOP_REQUESTED)
    try {
      const runtime = this.getRuntime?.() ?? null

      // 1) 拒绝新工作
      this._setPhase(StopPhase.REJECTING_NEW_WORK)
      if (runtime && typeof runtime.beginStop === 'function') { try { runtime.beginStop() } catch {} }

      // 2) 停止 Agent（模型请求 + 禁止后续工具）
      this._setPhase(StopPhase.CANCELLING_AGENT)
      const agent = this.getAgent?.() ?? null
      // Agent 已在 requestStop 入口统一停手（隔离/幂等也会停）；这里只等它退出，避免重复 stop 计数
      if (agent && typeof agent.waitIdle === 'function') {
        try { await withTimeout(Promise.resolve(agent.waitIdle()), Math.max(1, Math.floor(timeoutMs / 3)), 'agent_wait_idle') } catch {}
      }

      // 3) 取消当前技能
      this._setPhase(StopPhase.CANCELLING_SKILL)
      if (runtime && typeof runtime.cancelActive === 'function') { try { runtime.cancelActive(token.reason) } catch {} }

      // 4) 下发底层 stop（以「当前租约持有者」身份，避免 request 者与 holder 不一致被 guard 拒）
      this._setPhase(StopPhase.DISPATCHING_STOP)
      let stopRet = null
      const stopper = this.runtimeStop || (runtime && typeof runtime.stop === 'function' ? (opts) => runtime.stop(opts) : null)
      if (!stopper) {
        // 没有运行时（尚未进世界/没有活动执行）：本质无游戏动作在跑
        stopRet = { status: 'succeeded', lock_released: true, command_id: null, detail: 'no_runtime_no_action' }
      } else {
        const opts = {
          owner: holder?.owner ?? (token.requester || 'system'),
          ownerInstanceId: holder?.ownerInstanceId ?? null,
          generation: token.generation,
          timeoutMs,
          source: token.source,
          reason: token.reason,
        }
        stopRet = await withTimeout(Promise.resolve(stopper(opts)), timeoutMs, 'runtime_stop')
      }
      this._setPhase(StopPhase.AWAITING_LUA_ACK, { command_id: stopRet?.command_id ?? null })

      // 5) 等 Runtime 锁真实释放
      this._setPhase(StopPhase.AWAITING_RUNTIME_RELEASE)
      let lockReleased
      if (typeof this.isLockReleased === 'function') {
        try { lockReleased = !!(await withTimeout(Promise.resolve(this.isLockReleased()), Math.max(1, Math.floor(timeoutMs / 2)), 'lock_release')) } catch { lockReleased = false }
      } else {
        lockReleased = stopRet?.lock_released !== false
      }

      // 6) 判定
      const ackOk = stopRet && stopRet.status === 'succeeded'
      const refused = stopRet && ['cancelled', 'refused_reflex', 'reflex_active'].includes(stopRet.status)

      if (refused) {
        // 例如 Reflex 保命占用：明确"没停成"，不伪造成功、不隔离、不放 Lease
        this._setPhase(StopPhase.IDLE)
        const res = this._buildResult('refused', {
          command_id: stopRet?.command_id ?? null,
          detail: '停止未执行（可能 Reflex 正在保命接管），请稍后再停；旧执行链未受影响',
        })
        this._last = res
        return res
      }

      if (ackOk && lockReleased) {
        this._setPhase(StopPhase.STOPPED, { command_id: stopRet?.command_id ?? null })
        this._diag.active_task_id = stopRet?.active_task_id ?? this._diag.active_task_id ?? null
        this._diag.active_instance_id = stopRet?.active_instance_id ?? this._diag.active_instance_id ?? null
        // 只有确认停止后，才允许释放/交接 Lease
        if (releaseLease && typeof this.releaseLease === 'function' && holder) {
          this._setPhase(StopPhase.LEASE_HANDOVER)
          try {
            await this.releaseLease({ holder, generation: token.generation, reason: token.reason })
          } catch (err) {
            this._diag.lease_release_error = String(err?.message ?? err)
          }
          this._setPhase(StopPhase.STOPPED)
        }
        const res = this._buildResult('stopped', {
          command_id: stopRet?.command_id ?? null,
          detail: stopRet?.detail || '已停止当前动作与任务推进，锁已释放',
        })
        this._last = res
        return res
      }

      // 未确认 → unknown + quarantine（绝不伪造成功、绝不释放 Lease）
      this._enterQuarantine(token, {
        command_id: stopRet?.command_id ?? null,
        stop_status: stopRet?.status ?? null,
        lock_released: !!lockReleased,
      })
      return this._last
    } catch (err) {
      const timeout = Boolean(err?.__stopTimeout) || /stop_timeout|timeout/i.test(String(err?.message ?? err))
      this._enterQuarantine(token, { error: String(err?.message ?? err), timeout })
      return this._last
    }
  }

  _enterQuarantine(token, info) {
    this.quarantined = true
    this.generation = token.generation
    this._setPhase(StopPhase.QUARANTINE, { ...info })
    this._last = this._buildResult('unknown', {
      command_id: info.command_id ?? null,
      detail: '停止结果未确认（超时/未收到 Lua ACK/运行时锁未释放）：进入隔离，禁止新任务与租约交接，等待旧执行链真正安全退出',
    })
  }

  /** 仅当「旧执行链真正退出（锁已释放）」才允许安全解除隔离；否则保持隔离。 */
  tryRecover() {
    if (!this.quarantined) return { recovered: false, reason: 'not_quarantined' }
    let released = false
    try { released = typeof this.isLockReleased === 'function' ? !!this.isLockReleased() : false } catch { released = false }
    if (!released) return { recovered: false, reason: 'lock_still_held' }
    this.quarantined = false
    this.phase = StopPhase.IDLE
    this._last = this._buildResult('idle', { detail: '旧执行链已安全退出，隔离解除' })
    return { recovered: true }
  }

  /**
   * 新任务/新会话启动前复位已停止状态。
   *
   * ★ 真机事故（2026-11-26）：stop 超时进入隔离后，即使**租约文件已经是 `released`**、
   *   游戏状态也在正常刷新（说明旧执行链早就退出了），这里仍然因为 `this.quarantined`
   *   直接返回 false —— 于是一路隔离到底：模型连 `harvest_nearest` 都发不出去，
   *   角色在青蛙围攻中血掉到 13% 也救不了。
   *   隔离的本意是"旧执行链还没安全退出时别开新活"，而不是"隔离以后永远解不开"。
   *   所以这里先尝试一次 `tryRecover()`（它自己会校验锁是否真的释放），
   *   只有锁确实还握着时才继续拒绝。
   */
  reset() {
    if (this.quarantined) {
      let recovered = false
      try { recovered = this.tryRecover()?.recovered === true } catch { recovered = false }
      if (!recovered) return false
    }
    if (this.isStopping()) return false
    if (this.phase === StopPhase.STOPPED) {
      this.phase = StopPhase.IDLE
      this._last = null
    }
    return true
  }

  async waitForStopped({ timeoutMs = 10000 } = {}) {
    if (!this.isStopping()) return this._last
    const start = this.now()
    while (this.isStopping() && this.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 20))
    }
    return this._last
  }
}

export default StopCoordinator
