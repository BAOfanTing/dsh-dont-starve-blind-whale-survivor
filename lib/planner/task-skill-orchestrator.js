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

  /**
   * 自动推进单步任务：
   * 1. 检查生存紧急；若有则暂停普通技能并让位生存。
   * 2. 仲裁得到当前最高优先级的 Task。
   * 3. 运行对应的 Skill。
   * 4. 根据运行结果更新 Task 看板状态。
   */
  async tickOnce() {
    const snapshot = typeof this.readSnapshot === 'function' ? this.readSnapshot() : null

    // 生存紧急检查（P0/P1）
    let survival = null
    try { survival = survivalLevel(snapshot) } catch {}
    if (survival && survival.blocking) {
      const activeInst = this.executor.activeInstance()
      if (activeInst) {
        this.executor.pause(activeInst.instance_id, `survival_preempt:${survival.key}`)
        this.#logTask('PAUSED', {
          task_id: activeInst.task_id,
          skill_id: activeInst.skill_id,
          instance_id: activeInst.instance_id,
          status: 'paused',
          reason: `survival_preempt:${survival.key}`,
        })
      }
      return { status: 'survival_preempted', survival: survival.key }
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
    const result = await this.executor.run(skillId, task.id, skillArgs)

    // 回写 Task Board
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
   * @param {{ maxSteps?: number }} [options]
   */
  async tick({ maxSteps = 1 } = {}) {
    const budget = Math.max(1, Math.min(10, Math.trunc(Number(maxSteps)) || 1))
    let last = null
    for (let i = 0; i < budget; i++) {
      last = await this.tickOnce()
      if (['completed', 'failed', 'blocked', 'no_task', 'survival_preempted'].includes(last.status)) {
        break
      }
    }
    return last
  }
}
