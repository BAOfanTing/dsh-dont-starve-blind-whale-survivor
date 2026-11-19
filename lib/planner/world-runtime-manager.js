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
          const s = readSnapshot()
          if (s && !s.stale) {
            const gate = guardBuild(args?.recipe, s)
            if (gate) return { status: 'rejected', reason: gate.reason, message: gate.message }
          }
        }
        return dispatcher.dispatch({ tool, args })
      },
      describe: (o) => dispatcher.describe(o),
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
      readSnapshot,
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
   * Autopilot 连续执行
   * @param {{ maxSteps?: number }} [opts]
   */
  async advanceTask({ maxSteps = 8 } = {}) {
    return this.withLock(async () => {
      const budget = Math.max(1, Math.min(10, Math.trunc(Number(maxSteps)) || 8))
      const actionsExecuted = []
      let lastResult = null
      let stepsExecuted = 0

      for (let i = 0; i < budget; i++) {
        lastResult = await this.orchestrator.tickOnce()
        stepsExecuted++

        if (lastResult.action) {
          actionsExecuted.push({
            tool: lastResult.action.tool,
            status: lastResult.status,
            verified: Boolean(lastResult.verified),
          })
        }

        if (['completed', 'failed', 'blocked', 'no_task', 'survival_preempted'].includes(lastResult.status)) {
          break
        }
      }

      this.activeTaskId = lastResult?.task_id ?? null
      this.activeInstanceId = lastResult?.instance_id ?? null

      const isFinished = ['completed', 'failed', 'blocked', 'no_task', 'survival_preempted'].includes(lastResult?.status)
      const overallStatus = isFinished ? lastResult.status : 'in_progress'

      return {
        status: overallStatus,
        world_key: this.worldKey,
        task_id: lastResult?.task_id ?? null,
        skill_id: lastResult?.skill_id ?? null,
        instance_id: lastResult?.instance_id ?? null,
        steps_executed: stepsExecuted,
        actions_executed: actionsExecuted,
        task_status: overallStatus,
        next_step: lastResult?.step ?? null,
        remaining_budget: Math.max(0, budget - stepsExecuted),
        stop_reason: stepsExecuted >= budget ? 'budget_exhausted' : (lastResult?.status ?? 'stopped'),
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
