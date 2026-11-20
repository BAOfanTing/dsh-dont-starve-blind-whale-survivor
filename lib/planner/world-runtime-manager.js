// 世界运行时管理器 (WorldRuntimeManager)：维护世界级执行上下文、并发互斥与执行链路。
// 职责：
// 1. 初始化世界级记忆存储 (WorldMemoryStore)，同 world_key 共享单例 Runtime。
// 2. 协调 TaskSkillOrchestrator 与 SkillExecutor。
// 3. 确保同一世界 (worldKey) 执行并发互斥 (有界锁 / Mutex)。
// 4. 提供 advance_task (Autopilot) 统一执行入口，返回完整结构化报告。

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

    // 互斥执行队列 (Mutex)
    this.busy = false
    this.queue = []

    this.executor = new SkillExecutor({
      memory: this.memory,
      worldKey,
      readSnapshot,
      dispatch: async (tool, args) => {
        if (tool === 'build' && typeof guardBuild === 'function') {
          const s = (typeof this.readSnapshot === 'function') ? this.readSnapshot() : readSnapshot()
          if (s && !s.stale) {
            const gate = guardBuild(args?.recipe, s)
            if (gate) return { status: 'rejected', reason: gate.reason, message: gate.message }
          }
        }
        return this.dispatcher.dispatch({ tool, args })
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
   * 使用互斥锁包裹执行
   * @template T
   * @param {() => Promise<T>} fn
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<T>}
   */
  async withLock(fn, { timeoutMs = 15000 } = {}) {
    if (!this.busy) {
      this.busy = true
      try {
        return await fn()
      } finally {
        this.busy = false
        if (this.queue.length > 0) {
          const next = this.queue.shift()
          next()
        }
      }
    }

    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        // 从队列移除
        const idx = this.queue.indexOf(runNext)
        if (idx !== -1) this.queue.splice(idx, 1)
        reject(new Error('runtime_busy: 等待世界执行锁超时'))
      }, timeoutMs)

      const runNext = async () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.busy = true
        try {
          const res = await fn()
          resolve(res)
        } catch (err) {
          reject(err)
        } finally {
          this.busy = false
          if (this.queue.length > 0) {
            const next = this.queue.shift()
            next()
          }
        }
      }

      this.queue.push(runNext)
    })
  }

  /**
   * 停止当前世界运行时的执行（ISSUE-07）：
   * 立即中断当前正在执行的动作或技能，清理队列与状态，并向底层下发 stop。
   */
  async stop({ timeoutMs = 5000 } = {}) {
    const activeTaskId = this.activeTaskId
    const activeInst = this.executor.activeInstance()
    const activeInstanceId = activeInst?.instance_id ?? this.activeInstanceId ?? null

    // 1. 中断并取消当前的技能实例
    if (activeInst) {
      this.executor.cancel(activeInst.instance_id, 'stopped_by_user')
    }

    // 2. 清理排队队列与活跃状态
    this.queue = []
    this.busy = false
    this.activeTaskId = null
    this.activeInstanceId = null

    // 3. 向底层下发 stop 动作（短超时保障，防止挂起）
    let outcome = null
    try {
      outcome = await this.dispatcher.dispatch({
        tool: 'stop',
        args: {},
        owner: 'system',
      })
    } catch (err) {
      outcome = { status: 'failed', reason: 'dispatch_error', message: String(err?.message ?? err) }
    }

    const succeeded = outcome?.status === 'succeeded'
    const commandId = outcome?.commandId ?? null

    try {
      this.log('info', `[AUTOPILOT] STOPPED command_id=${commandId} task_id=${activeTaskId} instance_id=${activeInstanceId}`)
    } catch {}

    return {
      stop_requested: true,
      stop_status: succeeded ? 'succeeded' : 'in_flight',
      active_command_id: commandId,
      active_task_id: activeTaskId,
      active_instance_id: activeInstanceId,
      next_action_allowed: false,
      detail: outcome?.message || (succeeded ? '已停止当前动作与任务推进' : '停止请求已下发'),
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
    return this.withLock(async () => {
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
        totalTicks++
        lastResult = await this.orchestrator.tickOnce()

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
    })
  }

  /**
   * 执行指定任务/技能
   */
  async executeTask(skillId, taskId, skillArgs) {
    return this.withLock(async () => {
      const res = await this.orchestrator.executeTask(skillId, taskId, skillArgs)
      this.activeTaskId = res?.task_id ?? taskId ?? null
      this.activeInstanceId = res?.instance_id ?? null
      return res
    })
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
      // 刷新依赖引用，防止闭包失效
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
