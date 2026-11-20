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
  constructor({ worldKey, store, dispatcher, readSnapshot, guardBuild, log = () => {}, now = () => Date.now() }) {
    this.worldKey = worldKey
    this.store = store
    this.memory = this.store.load(worldKey)
    this.now = now
    this.log = log
    this.dispatcher = dispatcher
    this.readSnapshot = readSnapshot
    this.guardBuild = guardBuild
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
    if (this.cancelRequested) {
      throw new Error('runtime_cancelled: 当前运行时正在停止，拒绝新任务执行')
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
    return Boolean(this.busy || this.currentLockOwner)
  }

  queueLength() {
    return this.queue.length
  }

  async acquireLock({ taskId = null, timeoutMs = 15000 } = {}) {
    if (this.cancelRequested) {
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

    // 1. 原子标记停止请求
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
      try {
        this.log('info', `[RUNTIME] QUEUE_CANCELLED world_key=${this.worldKey} count=${cancelledCount}`)
      } catch {}
    }

    // 3. 广播取消信号
    if (this.activeAbortController) {
      try {
        this.activeAbortController.abort('stopped_by_user')
      } catch {}
    }

    // 4. 中断并取消技能实例
    if (activeInst) {
      this.executor.cancel(activeInst.instance_id, 'stopped_by_user')
    }

    // 5. 向底层下发 stop 动作（有界超时保障，防止挂起）
    let outcome = null
    const stopDeadline = Math.min(timeoutMs, 5000)
    try {
      const dispatchPromise = this.dispatcher.dispatch({
        tool: 'stop',
        args: {},
        owner: owner ?? this.owner ?? 'system',
        ownerInstanceId: ownerInstanceId ?? this.ownerInstanceId,
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

    // 7. 评估真实停止状态
    let stopStatus = 'cancelled'
    if (outcome?.status === 'succeeded' && lockReleased) {
      stopStatus = 'succeeded'
    } else if (!lockReleased || outcome?.status === 'unknown' || outcome?.reason === 'timeout') {
      stopStatus = 'unknown'
    } else if (outcome?.status === 'failed') {
      stopStatus = 'in_flight'
    } else if (outcome?.status === 'rejected') {
      stopStatus = outcome?.reason === 'reflex_active' ? 'cancelled' : 'in_flight'
    }

    const commandId = outcome?.commandId ?? null

    this.activeTaskId = null
    this.activeInstanceId = null
    this.cancelRequested = false

    try {
      this.log('info', `[RUNTIME] CANCEL_COMPLETED world_key=${this.worldKey} command_id=${commandId} status=${stopStatus}`)
    } catch {}

    const isOk = stopStatus === 'succeeded' || stopStatus === 'cancelled'
    return {
      ok: isOk,
      status: stopStatus,
      stop_requested: true,
      stop_status: stopStatus,
      active_command_id: commandId,
      active_task_id: activeTaskId,
      active_instance_id: activeInstanceId,
      next_action_allowed: false,
      detail: outcome?.message || (stopStatus === 'succeeded' ? '已停止当前动作与任务推进' : '停止请求处理中或超时'),
    }
  }

  /**
   * Autopilot 连续执行（ISSUE-08）：
   * maxSteps 作为【实际动作下发预算】（Action Dispatch Budget）。
   * 仅在真正下发了原子动作时扣减预算。
   * 同时设置 maxIdleTicks 避免死循环。
   * @param {{ maxSteps?: number }} [opts]
   */
  async advanceTask({ maxSteps = 8 } = {}) {
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
        let totalTicks = 0
        let stopReason = 'in_progress'

        try {
          this.log('info', `[AUTOPILOT] ADVANCE_START world_key=${this.worldKey} budget=${actionBudget}`)
        } catch {}

        while (actionsExecuted.length < actionBudget && totalTicks < MAX_TOTAL_TICKS) {
          if (abortController.signal.aborted) {
            stopReason = 'cancelled'
            break
          }
          totalTicks++
          lastResult = await this.orchestrator.tickOnce({ signal: abortController.signal })

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
              this.log('info', `[AUTOPILOT] STEP_DISPATCHED tool=${lastResult.action.tool} budget_used=${actionsExecuted.length}/${actionBudget}`)
            } catch {}
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
  async executeTask(skillId, taskId, skillArgs) {
    return this.withLock(async () => {
      const abortController = new AbortController()
      this.activeAbortController = abortController
      try {
        const res = await this.orchestrator.executeTask(skillId, taskId, skillArgs, { signal: abortController.signal })
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
}

/** 世界运行时管理器（单例管理器） */
export class WorldRuntimeManager {
  static #instances = new Map()

  /**
   * 获取或创建指定 worldKey 的权威 WorldRuntime
   */
  static getOrCreate({ worldKey, store, dispatcher, readSnapshot, guardBuild, log = () => {}, now = () => Date.now() }) {
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
