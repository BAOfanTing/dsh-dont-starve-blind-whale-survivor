// 世界运行时管理器 (WorldRuntimeManager)：维护世界级执行上下文、并发互斥与执行链路。
// 职责：
// 1. 初始化世界级记忆存储 (WorldMemoryStore)，同 world_key 共享单例 Runtime。
// 2. 协调 TaskSkillOrchestrator 与 SkillExecutor。
// 3. 确保同一世界 (worldKey) 执行并发互斥 (有界所有权互斥锁 / Mutex)。
// 4. 提供安全的 Stop / Cancel 协调机制，防止并发冲突与旧任务 finally 释放新任务锁。
// 5. 提供 advance_task (Autopilot) 统一执行入口，返回完整结构化报告。

import { createWorldMemoryStore } from './world-memory.js'
import { TaskSkillOrchestrator } from './task-skill-orchestrator.js'
import { SkillExecutor } from '../skills/index.js'

/** 单个世界的权威运行时上下文 */
export class WorldRuntime {
  constructor({ worldKey, store, dispatcher, readSnapshot, guardBuild, readAuthority = null, log = () => {}, now = () => Date.now() }) {
    this.worldKey = worldKey
    this.store = store
    this.memory = this.store.load(worldKey)
    this.now = now
    this.log = log
    this.dispatcher = dispatcher
    this.readSnapshot = readSnapshot
    this.guardBuild = guardBuild
    this.readAuthority = typeof readAuthority === 'function' ? readAuthority : null
    this.createdAt = now()
    this.updatedAt = now()
    this.activeTaskId = null
    this.activeInstanceId = null

    // 互斥执行与所有权状态（ISSUE-01）
    this.lockSeq = 0
    this.currentLockOwner = null
    this.busy = false
    this.queue = []
    this.cancelRequested = false
    this.quarantined = false
    this.activeAbortController = null

    this.executor = new SkillExecutor({
      memory: this.memory,
      worldKey,
      readSnapshot,
      dispatch: async (tool, args, opts = {}) => {
        if (tool === 'build' && typeof this.guardBuild === 'function') {
          const s = (typeof this.readSnapshot === 'function') ? this.readSnapshot() : readSnapshot()
          if (s && !s.stale) {
            const gate = this.guardBuild(args?.recipe, s)
            if (gate) return { status: 'rejected', reason: gate.reason, message: gate.message }
          }
        }
        return this.dispatcher.dispatch({
          tool,
          args,
          owner: opts.owner ?? 'system',
          ownerInstanceId: opts.ownerInstanceId ?? null,
          signal: opts.signal,
          budget_s: opts.budget_s,
          timeoutMs: opts.timeoutMs,
        })
      },
      describe: (o) => this.dispatcher.describe(o),
      log: (tag, payload) => {
        try {
          this.log('info', `[SKILL] ${tag} ${JSON.stringify(payload)}`)
        } catch {}
      },
      save: () => {
        try {
          this.updatedAt = this.now()
          this.store.save(this.memory)
        } catch {}
      },
      now: this.now,
    })

    this.orchestrator = new TaskSkillOrchestrator({
      memory: this.memory,
      worldKey,
      readSnapshot: () => (typeof this.readSnapshot === 'function' ? this.readSnapshot() : readSnapshot()),
      dispatch: this.executor.dispatch,
      save: this.executor.save,
      log: (event, payload) => {
        try {
          this.log('info', `[ORCHESTRATOR] ${event} ${JSON.stringify(payload)}`)
        } catch {}
      },
      executor: this.executor,
      now: this.now,
    })
  }

  /**
   * 使用具有明确所有权的互斥锁包裹执行
   * @template T
   * @param {() => Promise<T>} fn
   * @param {{ taskId?: string, timeoutMs?: number }} [opts]
   * @returns {Promise<T>}
   */
  async withLock(fn, { taskId = null, timeoutMs = 15000 } = {}) {
    if (this.cancelRequested || this.quarantined) {
      throw new Error('runtime_cancelled: 当前运行时正在停止或处于隔离中，拒绝新任务执行')
    }

    if (!this.currentLockOwner) {
      const ownerId = `lock_${++this.lockSeq}_${this.now()}`
      this.currentLockOwner = ownerId
      this.busy = true
      try {
        try {
          this.log('info', `[RUNTIME] RUNTIME_LOCK_ACQUIRED world_key=${this.worldKey} owner=${ownerId} task_id=${taskId ?? 'none'}`)
        } catch {}
        return await fn()
      } finally {
        this.#releaseLock(ownerId)
      }
    }

    return new Promise((resolve, reject) => {
      const ownerId = `lock_${++this.lockSeq}_${this.now()}`
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const idx = this.queue.findIndex((item) => item.ownerId === ownerId)
        if (idx !== -1) {
          this.queue[idx].cancelled = true
          this.queue.splice(idx, 1)
        }
        reject(new Error('runtime_busy: 等待世界执行锁超时'))
      }, timeoutMs)

      const queueItem = {
        ownerId,
        taskId: taskId || null,
        resolve,
        reject,
        timer,
        cancelled: false,
        run: async () => {
          if (settled || queueItem.cancelled) return
          settled = true
          clearTimeout(timer)
          if (this.cancelRequested) {
            queueItem.cancelled = true
            reject(new Error('runtime_cancelled: 运行时正在停止，排队任务已取消'))
            this.#drainQueue()
            return
          }
          this.currentLockOwner = ownerId
          this.busy = true
          try {
            try {
              this.log('info', `[RUNTIME] RUNTIME_LOCK_ACQUIRED world_key=${this.worldKey} owner=${ownerId} task_id=${taskId ?? 'none'}`)
            } catch {}
            const res = await fn()
            resolve(res)
          } catch (err) {
            reject(err)
          } finally {
            this.#releaseLock(ownerId)
          }
        },
      }

      this.queue.push(queueItem)
    })
  }

  isBusy() {
    return Boolean(this.busy || this.currentLockOwner || this.quarantined)
  }

  queueLength() {
    return this.queue.length
  }

  async acquireLock({ taskId = null, timeoutMs = 15000 } = {}) {
    if (this.cancelRequested || this.quarantined) {
      return { acquired: false, reason: 'runtime_cancelled' }
    }
    if (!this.currentLockOwner) {
      const ownerId = `lock_${++this.lockSeq}_${this.now()}`
      this.currentLockOwner = ownerId
      this.busy = true
      return { acquired: true, ownerId }
    }
    return new Promise((resolve) => {
      const ownerId = `lock_${++this.lockSeq}_${this.now()}`
      const timer = setTimeout(() => {
        resolve({ acquired: false, reason: 'timeout' })
      }, timeoutMs)
      this.queue.push({
        ownerId,
        taskId,
        timer,
        run: () => {
          clearTimeout(timer)
          this.currentLockOwner = ownerId
          this.busy = true
          resolve({ acquired: true, ownerId })
        },
      })
    })
  }

  releaseLock(ownerId) {
    if (this.currentLockOwner !== ownerId) {
      return false
    }
    this.#releaseLock(ownerId)
    return true
  }

  #releaseLock(ownerId) {
    if (this.currentLockOwner !== ownerId) {
      // 关键所有权保护：严禁旧任务的 finally 释放新任务持有的锁！
      return
    }
    this.currentLockOwner = null
    this.busy = false
    try {
      this.log('info', `[RUNTIME] RUNTIME_LOCK_RELEASED world_key=${this.worldKey} owner=${ownerId}`)
    } catch {}
    if (this.quarantined) {
      this.quarantined = false
      this.cancelRequested = false
      this.activeTaskId = null
      this.activeInstanceId = null
      try {
        this.log('info', `[RUNTIME] QUARANTINE_LIFTED world_key=${this.worldKey}`)
      } catch {}
    }
    this.#drainQueue()
  }

  #drainQueue() {
    if (this.cancelRequested || this.currentLockOwner) return
    while (this.queue.length > 0 && !this.currentLockOwner) {
      const next = this.queue.shift()
      if (!next || next.cancelled) continue
      next.run()
      break
    }
  }

  /**
   * 停止当前世界运行时的执行（ISSUE-01 / P0 级别取消协调机制）：
   * 1. 原子登记 stop 请求，阻止新任务进锁。
   * 2. 取消排队中的所有待执行任务。
   * 3. 向当前执行链传播取消信号 (AbortController)。
   * 4. 标记取消活跃技能实例。
   * 5. 通过唯一 Dispatcher 下发底层 stop。
   * 6. 有界等待当前执行流程安全退出，确保锁所有权不发生并发撕裂。
   */
  async stop({ timeoutMs = 5000, owner = 'system', ownerInstanceId = null } = {}) {
    const activeTaskId = this.activeTaskId
    const activeInst = this.executor.activeInstance()
    const activeInstanceId = activeInst?.instance_id ?? this.activeInstanceId ?? null

    try {
      this.log('info', `[RUNTIME] CANCEL_REQUESTED world_key=${this.worldKey} task_id=${activeTaskId} instance_id=${activeInstanceId} owner=${owner}`)
    } catch {}

    // 1. 原子标记停止请求（阻止新任务进锁）
    this.cancelRequested = true

    // 2. 取消排队中的任务
    const cancelledCount = this.queue.length
    while (this.queue.length > 0) {
      const item = this.queue.shift()
      if (item) {
        item.cancelled = true
        if (item.timer) clearTimeout(item.timer)
        try { item.reject(new Error('cancelled_by_stop')) } catch {}
      }
    }
    if (cancelledCount > 0) {
      try { this.log('info', `[RUNTIME] QUEUE_CANCELLED world_key=${this.worldKey} count=${cancelledCount}`) } catch {}
    }

    // 3. 广播取消信号（传到 orchestrator/executor/dispatcher）
    if (this.activeAbortController) {
      try { this.activeAbortController.abort('stopped_by_user') } catch {}
    }

    // 4. 中断并取消当前技能实例
    if (activeInst) {
      this.executor.cancel(activeInst.instance_id, 'stopped_by_user')
    }

    // 5. 以「当前租约持有者」身份下发底层 stop（R8.0 D6：否则 F8 持租约时会被 control_denied）
    let holderOwner = owner
    let holderInstance = ownerInstanceId
    try {
      const auth = typeof this.readAuthority === 'function' ? this.readAuthority() : null
      if (auth && auth.owner_type) {
        holderOwner = auth.owner_type
        holderInstance = auth.owner_instance_id ?? null
      }
    } catch {}

    let outcome = null
    const stopDeadline = Math.min(timeoutMs, 5000)
    try {
      const dispatchPromise = this.dispatcher.dispatch({
        tool: 'stop',
        args: {},
        owner: holderOwner ?? 'system',
        ownerInstanceId: holderInstance,
        timeoutMs: stopDeadline,
      })
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('stop_timeout')), stopDeadline)
      })
      outcome = await Promise.race([dispatchPromise, timeoutPromise])
    } catch (err) {
      if (String(err?.message).includes('stop_timeout')) {
        outcome = { status: 'unknown', reason: 'timeout', message: '停止指令执行超时' }
      } else {
        outcome = { status: 'failed', reason: 'dispatch_error', message: String(err?.message ?? err) }
      }
    }

    // 6. 有界等待原持有锁退出
    let lockReleased = false
    if (this.currentLockOwner) {
      const startWait = this.now()
      const maxWait = stopDeadline
      while (this.currentLockOwner && (this.now() - startWait < maxWait)) {
        await new Promise((r) => setTimeout(r, 20))
      }
      lockReleased = !this.currentLockOwner
    } else {
      lockReleased = true
    }

    // 7. 判定（R8.0 D7）：只有「成功 + 锁已释放」= confirmed；否则一律隔离，绝不清标志
    const ackOk = outcome?.status === 'succeeded'
    const reflexDeclined = outcome?.status === 'cancelled'
      || outcome?.reason === 'reflex_active' || outcome?.reason === 'reflex'
    let stopStatus
    let confirmed = false
    let clearFlags = false
    let doQuarantine = false
    if (ackOk && lockReleased) {
      stopStatus = 'succeeded'
      confirmed = true
      clearFlags = true
    } else if (reflexDeclined) {
      stopStatus = 'cancelled'
      clearFlags = true // 被 Reflex 拒绝：运行时恢复可用（但不宣称成功）
    } else {
      stopStatus = 'unknown'
      doQuarantine = true
    }

    const commandId = outcome?.commandId ?? null

    if (clearFlags) {
      this.activeTaskId = null
      this.activeInstanceId = null
      this.cancelRequested = false
      this.quarantined = false
    }
    if (doQuarantine) {
      this.quarantined = true
      this.cancelRequested = true
      try {
        this.log('warn', `[RUNTIME] STOP_QUARANTINE_ACTIVE world_key=${this.worldKey} task_id=${activeTaskId} reason=${outcome?.reason ?? 'unconfirmed'}`)
      } catch {}
    }

    try {
      this.log('info', `[RUNTIME] CANCEL_COMPLETED world_key=${this.worldKey} command_id=${commandId} status=${stopStatus} confirmed=${confirmed}`)
    } catch {}

    const detailMsg = outcome?.message || (confirmed
      ? '已停止当前动作与任务推进'
      : (reflexDeclined
        ? '停止被 Reflex 保命占用拒绝（旧任务未受影响）'
        : (!lockReleased ? '旧任务执行尚未退出，运行时处于隔离保护中' : '停止未得到确认，运行时进入隔离')))
    return {
      ok: confirmed,
      status: stopStatus,
      stop_requested: true,
      stop_status: stopStatus,
      confirmed,
      active_command_id: commandId,
      active_task_id: activeTaskId,
      active_instance_id: activeInstanceId,
      next_action_allowed: false,
      detail: detailMsg,
    }
  }


  /**
   * 从 store 重新载入世界记忆（就地同步共享对象）。
   * R8.0 附带修复：store.load 每次返回新对象，而 executor/orchestrator 在构造时持有
   * this.memory 的引用；若不在每次执行前重载，planner 落到磁盘的新看板对 Runtime 不可见，
   * 会表现为 get_state 有 ready 任务、但 advance_task 永远 no_task。
   */
  reloadMemory() {
    try {
      const fresh = this.store.load(this.worldKey)
      if (fresh && this.memory) {
        for (const k of Object.keys(this.memory)) { if (!(k in fresh)) delete this.memory[k] }
        Object.assign(this.memory, fresh)
      }
    } catch {}
    return this.memory
  }

  /**
   * Autopilot 连续执行（ISSUE-08）：
   * maxSteps 作为【实际动作下发预算】（Action Dispatch Budget）。
   * 仅在真正下发了原子动作时扣减预算。
   * 同时设置 maxIdleTicks 避免死循环。
   * @param {{ maxSteps?: number, owner?: string, ownerInstanceId?: string }} [opts]
   */
  async advanceTask({ maxSteps = 8, owner = 'system', ownerInstanceId = null } = {}) {
    this.reloadMemory()
    try {
      return await this.withLock(async () => {
      const abortController = new AbortController()
      this.activeAbortController = abortController

      try {
        const actionBudget = Math.max(1, Math.min(10, Math.trunc(Number(maxSteps)) || 8))
        const actionsExecuted = []
        let lastResult = null
        let ticksWithoutAction = 0
        const MAX_IDLE_TICKS = 10
        const MAX_TOTAL_TICKS = actionBudget * 3 + MAX_IDLE_TICKS
        // ★ Phase R.7.4：同一次 advance_task 里，同一目标的同一动作反复失败（尤其 rejected）
        //   绝不能当成"有效进展"一直烧预算。真机踩到过一整轮 10 次 gather_area→rejected，
        //   角色原地不动、任务毫无推进。这里对"连续失败"设硬上限：连续 3 次失败就停。
        const FAILURE_STATUSES = new Set(['rejected', 'failed', 'unverified', 'unknown', 'cancelled'])
        const REPEAT_FAIL_LIMIT = 3
        const sigOf = (a) => (a ? `${a.tool}|${JSON.stringify(a.args ?? {})}` : null)
        let prevFailSig = null
        let repeatFailStreak = 0
        let consecutiveFailures = 0
        let lastFailure = null
        let totalTicks = 0
        let stopReason = 'in_progress'

        try {
          this.log('info', `[AUTOPILOT] ADVANCE_START world_key=${this.worldKey} budget=${actionBudget} owner=${owner}`)
        } catch {}

        while (actionsExecuted.length < actionBudget && totalTicks < MAX_TOTAL_TICKS) {
          if (abortController.signal.aborted) {
            stopReason = 'cancelled'
            break
          }
          totalTicks++
          lastResult = await this.orchestrator.tickOnce({
            signal: abortController.signal,
            owner,
            ownerInstanceId,
          })

          if (lastResult.action) {
            actionsExecuted.push({
              tool: lastResult.action.tool,
              args: lastResult.action.args ?? {},
              command_id: lastResult.action.command_id ?? null,
              status: lastResult.action.status ?? lastResult.status,
              verified: Boolean(lastResult.action.verified),
            })
            ticksWithoutAction = 0
            try {
              this.log('info', `[AUTOPILOT] STEP_DISPATCHED tool=${lastResult.action.tool} status=${lastResult.action.status ?? lastResult.status} budget_used=${actionsExecuted.length}/${actionBudget}`)
            } catch {}

            // 失败动作识别：rejected/failed/unverified/unknown/cancelled 都不算有效进展。
            const actStatus = String(lastResult.action.status ?? lastResult.status ?? '')
            if (FAILURE_STATUSES.has(actStatus)) {
              consecutiveFailures++
              lastFailure = {
                tool: lastResult.action.tool,
                args: lastResult.action.args ?? {},
                status: actStatus,
                reason: lastResult.reason ?? null,
                step: lastResult.step ?? null,
              }
              const sig = sigOf(lastResult.action)
              if (sig && sig === prevFailSig) repeatFailStreak++
              else repeatFailStreak = 1
              prevFailSig = sig
              try {
                this.log('warn', `[AUTOPILOT] ACTION_FAILED tool=${lastResult.action.tool} status=${actStatus} reason=${lastResult.reason ?? ''} repeat=${repeatFailStreak} consecutive=${consecutiveFailures}`)
              } catch {}
              if (repeatFailStreak >= REPEAT_FAIL_LIMIT || consecutiveFailures >= REPEAT_FAIL_LIMIT) {
                stopReason = 'repeated_failed_action'
                try {
                  this.log('warn', `[AUTOPILOT] STOP_REPEATED_FAILED_ACTION world_key=${this.worldKey} tool=${lastResult.action.tool} repeat=${repeatFailStreak}`)
                } catch {}
                break
              }
            } else {
              consecutiveFailures = 0
              repeatFailStreak = 0
              prevFailSig = null
            }
          } else {
            ticksWithoutAction++
            if (ticksWithoutAction >= MAX_IDLE_TICKS) {
              stopReason = 'idle_limit_reached'
              break
            }
          }

          const terminalStatuses = [
            'completed', 'failed', 'blocked', 'no_task',
            'survival_preempted', 'reflex_active', 'revive_waiting', 'survival_stabilized',
            'awaiting_reconciliation', 'unknown', 'cancelled',
          ]
          if (terminalStatuses.includes(lastResult.status)) {
            stopReason = lastResult.status
            break
          }
        }

        if (actionsExecuted.length >= actionBudget && stopReason === 'in_progress') {
          stopReason = 'budget_exhausted'
          try {
            this.log('info', `[AUTOPILOT] BUDGET_EXHAUSTED world_key=${this.worldKey} actions=${actionsExecuted.length}`)
          } catch {}
        }

        this.activeTaskId = lastResult?.task_id ?? null
        this.activeInstanceId = lastResult?.instance_id ?? null

        let taskStatus = 'in_progress'
        if (lastResult?.status === 'completed') taskStatus = 'completed'
        else if (lastResult?.status === 'failed' || lastResult?.status === 'blocked') taskStatus = 'blocked'
        else if (lastResult?.status === 'survival_preempted') taskStatus = 'survival_preempted'
        else if (lastResult?.status === 'no_task') taskStatus = 'no_task'
        else if (lastResult?.status === 'awaiting_reconciliation') taskStatus = 'awaiting_reconciliation'
        else if (lastResult?.status === 'unknown') taskStatus = 'unknown'
        else if (lastResult?.status === 'cancelled') taskStatus = 'cancelled'
        else if (lastResult?.status === 'timeout') taskStatus = 'unknown'
        // 因为反复失败而中止：即使最后一帧状态是 in_progress，也要如实标成 blocked，不能谎报"进行中"。
        if (stopReason === 'repeated_failed_action' && ['in_progress', 'survival_in_progress'].includes(taskStatus)) {
          taskStatus = 'blocked'
        }

        let survivalAlert = null
        if (['survival_in_progress', 'survival_stabilized', 'survival_preempted'].includes(lastResult?.status)) {
          survivalAlert = { key: lastResult?.survival ?? null, status: lastResult.status }
        } else if (lastResult?.status === 'reflex_active') {
          survivalAlert = { key: 'reflex', status: 'reflex_active', reason: lastResult?.reason }
        }

        return {
          task_status: taskStatus,
          status: taskStatus,
          world_key: this.worldKey,
          task_id: lastResult?.task_id ?? null,
          skill_id: lastResult?.skill_id ?? null,
          instance_id: lastResult?.instance_id ?? null,
          current_step: lastResult?.step ?? null,
          next_step: lastResult?.step ?? null,
          actions_executed: actionsExecuted,
          budget_used: actionsExecuted.length,
          budget_remaining: Math.max(0, actionBudget - actionsExecuted.length),
          steps_executed: actionsExecuted.length,
          remaining_budget: Math.max(0, actionBudget - actionsExecuted.length),
          stop_reason: stopReason,
          // 便于排查"为什么停了"：最后一次失败的动作 + 同动作重复次数。
          failed_action: lastFailure,
          repeated_failed_action: stopReason === 'repeated_failed_action',
          survival_alert: survivalAlert,
          raw: lastResult,
        }
      } finally {
        if (this.activeAbortController === abortController) {
          this.activeAbortController = null
        }
      }
    })
    } catch (err) {
      if (String(err?.message).includes('runtime_cancelled') || String(err?.message).includes('cancelled_by_stop')) {
        return {
          task_status: 'cancelled',
          status: 'cancelled',
          world_key: this.worldKey,
          task_id: null,
          skill_id: null,
          instance_id: null,
          actions_executed: [],
          budget_used: 0,
          steps_executed: 0,
          stop_reason: 'cancelled_by_stop',
          detail: '运行时正在停止，任务已取消',
        }
      }
      throw err
    }
  }

  /**
   * 执行指定任务/技能
   */
  async executeTask(skillId, taskId, skillArgs, { owner = 'system', ownerInstanceId = null } = {}) {
    this.reloadMemory()
    return this.withLock(async () => {
      const abortController = new AbortController()
      this.activeAbortController = abortController
      try {
        const res = await this.orchestrator.executeTask(skillId, taskId, skillArgs, {
          signal: abortController.signal,
          owner,
          ownerInstanceId,
        })
        this.activeTaskId = res?.task_id ?? taskId ?? null
        this.activeInstanceId = res?.instance_id ?? null
        return res
      } finally {
        if (this.activeAbortController === abortController) {
          this.activeAbortController = null
        }
      }
    }, { taskId })
  }

  /**
   * 人工处理 unknown 任务结果
   */
  resolveUnknownTask(taskId, opts) {
    return this.executor.resolveUnknownTask(taskId, opts)
  }
}

/** 世界运行时管理器（单例管理器） */
export class WorldRuntimeManager {
  static #instances = new Map()

  /**
   * 获取或创建指定 worldKey 的权威 WorldRuntime
   */
  static getOrCreate({ worldKey, store, dispatcher, readSnapshot, guardBuild, readAuthority = null, log = () => {}, now = () => Date.now() }) {
    const key = String(worldKey || 'unknown_world')
    let runtime = this.#instances.get(key)
    if (!runtime) {
      const memStore = store ?? createWorldMemoryStore()
      runtime = new WorldRuntime({
        worldKey: key,
        store: memStore,
        dispatcher,
        readSnapshot,
        guardBuild,
        readAuthority,
        log,
        now,
      })
      this.#instances.set(key, runtime)
      try {
        log('info', `[RUNTIME] CREATED world_key=${key}`)
      } catch {}
    } else {
      // 刷新依赖引用，防止闭包失效；若存在活动执行，平滑更新引用
      if (dispatcher) runtime.dispatcher = dispatcher
      if (readSnapshot) {
        runtime.readSnapshot = readSnapshot
        runtime.executor.readSnapshot = readSnapshot
        runtime.orchestrator.readSnapshot = () => (typeof runtime.readSnapshot === 'function' ? runtime.readSnapshot() : readSnapshot())
      }
      if (guardBuild) runtime.guardBuild = guardBuild
      if (readAuthority) runtime.readAuthority = readAuthority
      if (log) {
        runtime.log = log
        runtime.executor.log = (tag, payload) => {
          try { log('info', `[SKILL] ${tag} ${JSON.stringify(payload)}`) } catch {}
        }
        runtime.orchestrator.log = (tag, payload) => {
          try { log('info', `[ORCHESTRATOR] ${tag} ${JSON.stringify(payload)}`) } catch {}
        }
      }
    }
    return runtime
  }

  /**
   * 清理运行时（测试或世界卸载用）
   */
  static clear(worldKey = null) {
    if (worldKey) {
      this.#instances.delete(String(worldKey))
    } else {
      this.#instances.clear()
    }
  }
}
