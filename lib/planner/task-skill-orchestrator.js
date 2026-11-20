// 任务技能编排器（Orchestrator）：连接 Task Board 和 Skill Executor，实现自动化推进。
//
// 职责（任务书 §二/§六/§七/§九）：
// 1. 获取当前唯一主任务 (Task)。
// 2. 读取 task.skill_id 与 task.skill_args。
// 3. 检查任务是否允许执行（依赖、冷却、是否 blocked）。
// 4. 启动或恢复对应 Skill Instance。
// 5. 推进技能执行一步 (Skill Executor.run)。
// 6. 将执行结果 (status, detail, verified) 回写进任务状态 (Task Board)。
// 7. 处理 Reflex 抢占 (暂停/恢复)。
// 8. 统一标准化日志输出 ([TASK], [ORCHESTRATOR], [SKILL])。
//
// 边界：
//   · **只负责调度，不复制状态机**。
//   · 绝不下发动作（调 Dispatcher）。

import { pickNextTask, markDone, registerFailure, evaluateBoard } from './task-board.js'
import { SkillExecutor } from '../skills/skill-executor.js'
import { survivalLevel } from './survival-priority.js'
import { recordExploration } from '../skills/explore-utils.js'

export class TaskSkillOrchestrator {
  constructor({ memory, worldKey = null, readSnapshot, dispatch, save = () => {}, log = () => {}, now = () => Date.now(), executor = null }) {
    this.memory = memory && typeof memory === 'object' ? memory : {}
    this.worldKey = worldKey ?? null
    this.readSnapshot = readSnapshot
    this.dispatch = dispatch
    this.save = save
    this.log = log
    this.now = now
    this.executor = executor || new SkillExecutor({ memory: this.memory, worldKey, readSnapshot, dispatch, save, log, now })
  }

  #logOrchestrator(tag, fields = {}) {
    try {
      this.log(`[ORCHESTRATOR] ${tag}`, {
        world_key: this.worldKey,
        task_id: fields.task_id ?? null,
        skill_id: fields.skill_id ?? null,
        step_id: fields.step_id ?? null,
        status: fields.status ?? null,
        reason: fields.reason ?? null,
        ...fields,
      })
    } catch {}
  }

  #logTask(tag, fields = {}) {
    try {
      this.log(`[TASK] ${tag}`, {
        world_key: this.worldKey,
        task_id: fields.task_id ?? null,
        skill_id: fields.skill_id ?? null,
        step_id: fields.step_id ?? null,
        status: fields.status ?? null,
        reason: fields.reason ?? null,
        ...fields,
      })
    } catch {}
  }

  /** 获取技能实例 */
  instanceOf(skillId) {
    return this.executor.instanceOf(skillId)
  }

  /** 暂停技能 */
  pause(skillId, reason = 'paused') {
    return this.executor.pause(skillId, reason)
  }

  /** 取消技能 */
  cancel(skillId, reason = 'cancelled') {
    return this.executor.cancel(skillId, reason)
  }

  /** 人工处理 unknown 任务结果 */
  resolveUnknownTask(taskId, opts) {
    return this.executor.resolveUnknownTask(taskId, opts)
  }

  /**
   * 执行指定任务/技能，并统一更新 Task Board 状态（若 task_id 对应看板中的任务）。
   * @param {string} skillId
   * @param {string} [taskId]
   * @param {object} [skillArgs]
   * @param {{ signal?: AbortSignal, owner?: string, ownerInstanceId?: string }} [opts]
   */
  async executeTask(skillId, taskId, skillArgs, { signal, owner = 'system', ownerInstanceId = null } = {}) {
    const effectiveTaskId = taskId || `manual:${skillId}`
    const isBoardTask = Boolean(this.memory.task_board?.tasks?.some((t) => t.id === effectiveTaskId))

    const result = await this.executor.run(skillId, effectiveTaskId, skillArgs, { signal, owner, ownerInstanceId })

    if (isBoardTask) {
      if (result.status === 'completed') {
        this.memory.task_board = markDone(this.memory.task_board, effectiveTaskId, {
          now: this.now(),
          status: 'completed',
          completionEvidence: result.verified ?? { skill_completed: true },
        })
        this.#logTask('COMPLETED', {
          task_id: effectiveTaskId,
          skill_id: skillId,
          instance_id: result.instance_id,
          status: 'completed',
          reason: 'skill_completed',
        })
      } else if (result.status === 'failed') {
        this.memory.task_board = registerFailure(this.memory.task_board, effectiveTaskId, result.reason ?? 'failed', { now: this.now() })
        this.#logTask('BLOCKED', {
          task_id: effectiveTaskId,
          skill_id: skillId,
          instance_id: result.instance_id,
          status: 'failed',
          reason: result.reason ?? 'failed',
        })
      } else if (result.status === 'blocked') {
        const t = this.memory.task_board.tasks.find((x) => x.id === effectiveTaskId)
        if (t) {
          t.status = 'blocked'
          t.blocked_reason = result.reason ?? 'skill_blocked'
        }
        this.#logTask('BLOCKED', {
          task_id: effectiveTaskId,
          skill_id: skillId,
          instance_id: result.instance_id,
          status: 'blocked',
          reason: result.reason,
        })
      } else if (result.status === 'awaiting_reconciliation' || result.status === 'unknown') {
        const t = this.memory.task_board.tasks.find((x) => x.id === effectiveTaskId)
        if (t) {
          if (result.status === 'unknown') {
            t.status = 'blocked'
            t.blocked_reason = 'task_outcome_unknown'
          } else if (t.status !== 'in_progress') {
            t.status = 'in_progress'
          }
        }
      } else {
        const t = this.memory.task_board.tasks.find((x) => x.id === effectiveTaskId)
        if (t && t.status !== 'in_progress') {
          t.status = 'in_progress'
          this.#logTask('START', {
            task_id: effectiveTaskId,
            skill_id: skillId,
            instance_id: result.instance_id,
            status: 'in_progress',
          })
        }
      }
      try { this.save() } catch {}
    }

    return result
  }

  /**
   * 自动推进单步任务：
   * 1. 检查生存紧急；若有则暂停普通技能并让位生存。
   * 2. 仲裁得到当前最高优先级的 Task。
   * 3. 运行对应的 Skill。
   * 4. 根据运行结果更新 Task 看板状态。
   * @param {{ signal?: AbortSignal, owner?: string, ownerInstanceId?: string }} [opts]
   */
  async tickOnce({ signal, owner = 'system', ownerInstanceId = null } = {}) {
    const snapshot = typeof this.readSnapshot === 'function' ? this.readSnapshot() : null
    if (snapshot && this.memory) {
      try { recordExploration(this.memory, snapshot) } catch {}
    }

    // 1. 角色状态检查（死亡/灵魂状态）
    let survival = null
    try { survival = survivalLevel(snapshot) } catch {}
    if (survival && survival.key === 'revive') {
      const activeInst = this.executor.activeInstance()
      if (activeInst) {
        this.executor.pause(activeInst.instance_id, 'revive_waiting')
      }
      return {
        status: 'revive_waiting',
        control_owner: 'system',
        ordinary_actions_allowed: false,
        reason: survival.label,
      }
    }

    // 2. Reflex 接管状态检查（ISSUE-05）
    const reflexActive = snapshot?.reflex?.active === true
    if (reflexActive || (survival && survival.key === 'retreat')) {
      const activeInst = this.executor.activeInstance()
      if (activeInst) {
        this.executor.pause(activeInst.instance_id, 'reflex_active')
        this.#logTask('PAUSED', {
          task_id: activeInst.task_id,
          skill_id: activeInst.skill_id,
          instance_id: activeInst.instance_id,
          status: 'paused',
          reason: 'reflex_active',
        })
      }
      try {
        this.log('[REFLEX] YIELD_CONTROL', {
          intent: snapshot?.reflex?.intent ?? 'retreat',
          active: reflexActive,
          survival: survival?.key ?? null,
        })
      } catch {}
      return {
        status: 'reflex_active',
        control_owner: 'lua_reflex',
        reflex_active: true,
        ordinary_actions_allowed: false,
        reason: reflexActive
          ? `reflex_active:${snapshot?.reflex?.intent || 'in_progress'}`
          : (survival?.label || 'retreat'),
        intent: snapshot?.reflex?.intent || 'retreat',
      }
    }

    // 3. P0/P1 生存紧急检查与仲裁（ISSUE-06）：饥饿、天黑无光、低血时内部调度 survival_stabilize
    if (survival && survival.blocking) {
      const emergencyTaskId = 'emergency:survival_stabilize'
      const activeInst = this.executor.activeInstance()
      if (activeInst && activeInst.task_id !== emergencyTaskId) {
        this.executor.pause(activeInst.instance_id, `survival_preempt:${survival.key}`)
        this.#logTask('PAUSED', {
          task_id: activeInst.task_id,
          skill_id: activeInst.skill_id,
          instance_id: activeInst.instance_id,
          status: 'paused',
          reason: `survival_preempt:${survival.key}`,
        })
      }

      this.#logOrchestrator('EMERGENCY_SURVIVAL', {
        survival_key: survival.key,
        survival_label: survival.label,
        status: 'dispatching',
      })

      const emergencyResult = await this.executor.run('survival_stabilize', emergencyTaskId, null, { signal, owner, ownerInstanceId })

      if (emergencyResult.status === 'completed') {
        this.#logTask('COMPLETED', {
          task_id: emergencyTaskId,
          skill_id: 'survival_stabilize',
          instance_id: emergencyResult.instance_id,
          status: 'completed',
          reason: 'emergency_stabilized',
        })
        return {
          status: 'survival_stabilized',
          survival: survival.key,
          task_id: emergencyTaskId,
          skill_id: 'survival_stabilize',
          instance_id: emergencyResult.instance_id,
          action: emergencyResult.action ?? null,
          step: emergencyResult.step ?? null,
          verified: emergencyResult.verified ?? null,
          detail: emergencyResult.detail ?? null,
        }
      }

      if (emergencyResult.status === 'reflex_active') {
        return {
          status: 'reflex_active',
          control_owner: 'lua_reflex',
          reflex_active: true,
          ordinary_actions_allowed: false,
          task_id: emergencyTaskId,
          skill_id: 'survival_stabilize',
          instance_id: emergencyResult.instance_id,
          action: emergencyResult.action ?? null,
          reason: emergencyResult.reason ?? 'reflex_active',
        }
      }

      return {
        status: 'survival_in_progress',
        survival: survival.key,
        task_id: emergencyTaskId,
        skill_id: 'survival_stabilize',
        instance_id: emergencyResult.instance_id,
        action: emergencyResult.action ?? null,
        step: emergencyResult.step ?? null,
        reason: emergencyResult.reason ?? null,
        verified: emergencyResult.verified ?? null,
        detail: emergencyResult.detail ?? null,
      }
    }

    // 重新评审看板：使冷却自然放行、外部完成自然达标、依赖自然解锁
    if (this.memory.task_board && Array.isArray(this.memory.task_board.tasks)) {
      this.memory.task_board = evaluateBoard(this.memory.task_board, {
        snapshot,
        memory: this.memory,
        now: this.now(),
      })
    }

    const task = pickNextTask(this.memory.task_board)
    if (!task) return { status: 'no_task' }

    this.#logTask('SELECTED', {
      task_id: task.id,
      skill_id: task.skill_id ?? task.id,
      status: task.status,
    })

    const skillId = task.skill_id ?? task.id
    const skillArgs = task.skill_args ?? null

    // 检查任务是否允许执行
    if (task.status === 'completed') {
      return { status: 'completed', task_id: task.id, skill_id: skillId }
    }
    if (task.status === 'blocked') {
      this.#logTask('BLOCKED', {
        task_id: task.id,
        skill_id: skillId,
        status: 'blocked',
        reason: task.blocked_reason,
      })
      return { status: 'blocked', task_id: task.id, skill_id: skillId, reason: task.blocked_reason }
    }

    // 检查实例是恢复还是启动
    const existing = this.executor.activeInstanceForTask(task.id)
    const isResuming = existing && existing.status === 'paused'
    if (isResuming) {
      this.#logOrchestrator('RESUME', {
        task_id: task.id,
        skill_id: skillId,
        instance_id: existing.instance_id,
        step_id: existing?.step_index,
        status: 'resuming',
      })
    } else {
      this.#logOrchestrator('DISPATCH', {
        task_id: task.id,
        skill_id: skillId,
        status: 'dispatching',
      })
    }

    // 执行技能（传入 task.id 和 skillArgs）
    const result = await this.executor.run(skillId, task.id, skillArgs, { signal, owner, ownerInstanceId })

    // 回写 Task Board
    if (result.status === 'reflex_active') {
      return {
        status: 'reflex_active',
        control_owner: 'lua_reflex',
        reflex_active: true,
        ordinary_actions_allowed: false,
        task_id: task.id,
        skill_id: skillId,
        instance_id: result.instance_id,
        action: result.action ?? null,
        reason: result.reason ?? 'reflex_active',
      }
    }

    if (result.status === 'awaiting_reconciliation' || result.status === 'unknown') {
      const t = this.memory.task_board?.tasks?.find((x) => x.id === task.id)
      if (t) {
        if (result.status === 'unknown') {
          t.status = 'blocked'
          t.blocked_reason = 'task_outcome_unknown'
        } else if (t.status !== 'in_progress') {
          t.status = 'in_progress'
        }
      }
      try { this.save() } catch {}
      return {
        ...result,
        task_id: task.id,
      }
    }

    if (result.status === 'completed') {
      this.memory.task_board = markDone(this.memory.task_board, task.id, {
        now: this.now(),
        status: 'completed',
        completionEvidence: result.verified ?? { skill_completed: true },
      })
      this.#logTask('COMPLETED', {
        task_id: task.id,
        skill_id: skillId,
        instance_id: result.instance_id,
        status: 'completed',
        reason: 'skill_completed',
      })
    } else if (result.status === 'failed') {
      this.memory.task_board = registerFailure(this.memory.task_board, task.id, result.reason ?? 'failed', { now: this.now() })
      this.#logTask('BLOCKED', {
        task_id: task.id,
        skill_id: skillId,
        instance_id: result.instance_id,
        status: 'failed',
        reason: result.reason ?? 'failed',
      })
    } else if (result.status === 'blocked') {
      if (this.memory.task_board?.tasks) {
        const t = this.memory.task_board.tasks.find((x) => x.id === task.id)
        if (t) {
          t.status = 'blocked'
          t.blocked_reason = result.reason ?? 'skill_blocked'
        }
      }
      this.#logTask('BLOCKED', {
        task_id: task.id,
        skill_id: skillId,
        instance_id: result.instance_id,
        status: 'blocked',
        reason: result.reason,
      })
    } else {
      // in_progress / step_verified
      if (this.memory.task_board?.tasks) {
        const t = this.memory.task_board.tasks.find((x) => x.id === task.id)
        if (t && t.status !== 'in_progress') {
          t.status = 'in_progress'
          this.#logTask('START', {
            task_id: task.id,
            skill_id: skillId,
            instance_id: result.instance_id,
            status: 'in_progress',
          })
        }
      }
    }

    try { this.save() } catch {}
    return { ...result, task_id: task.id }
  }

  /**
   * 自动推进任务（带有限步长预算兜底）：
   * @param {{ maxSteps?: number, signal?: AbortSignal }} [options]
   */
  async tick({ maxSteps = 1, signal = null } = {}) {
    const budget = Math.max(1, Math.min(10, Math.trunc(Number(maxSteps)) || 1))
    let last = null
    for (let i = 0; i < budget; i++) {
      if (signal?.aborted) break
      last = await this.tickOnce({ signal })
      if (['completed', 'failed', 'blocked', 'no_task', 'survival_preempted', 'reflex_active', 'revive_waiting', 'survival_stabilized', 'awaiting_reconciliation', 'unknown', 'cancelled'].includes(last?.status)) {
        break
      }
    }
    return last
  }
}
