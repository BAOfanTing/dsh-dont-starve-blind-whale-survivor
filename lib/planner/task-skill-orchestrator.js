// 任务技能编排器（Orchestrator）：连接 Task Board 和 Skill Executor，实现自动化推进。
//
// 职责（任务书 §六/§七）：
// 1. 获取当前主任务 (Task)。
// 2. 检查任务是否允许执行（依赖、冷却、是否 blocked）。
// 3. 启动或恢复对应 Skill Instance。
// 4. 推进技能执行一步 (Skill Executor.run)。
// 5. 将执行结果 (status, detail) 更新进任务状态 (Task Board)。
// 6. 处理 Reflex 抢占 (暂停/恢复)。
//
// 边界：
//   · **只负责调度，不复制状态机**。
//   · 绝不下发动作（调 Dispatcher）。

import { pickNextTask, markDone, registerFailure } from './task-board.js'
import { SkillExecutor } from '../skills/skill-executor.js'
import { survivalLevel } from './survival-priority.js'

export class TaskSkillOrchestrator {
  constructor({ memory, worldKey, readSnapshot, dispatch, save, log = () => {}, now = () => Date.now() }) {
    this.memory = memory
    this.worldKey = worldKey
    this.readSnapshot = readSnapshot
    this.dispatch = dispatch
    this.save = save
    this.log = log
    this.now = now
    this.executor = new SkillExecutor({ memory, worldKey, readSnapshot, dispatch, save, log, now })
  }

  #log(tag, fields = {}) {
    try {
      this.log(`[ORCHESTRATOR] ${tag}`, { world_key: this.worldKey, ...fields })
    } catch {}
  }

  /**
   * 自动推进任务：
   * 1. 仲裁得到当前最高优先级的 Task。
   * 2. 若有生存紧急：暂停所有技能，直接返回生存状态。
   * 3. 运行对应的 Skill。
   * 4. 根据运行结果更新 Task 状态。
   */
  async tick() {
    const snapshot = this.readSnapshot()
    const task = pickNextTask(this.memory.task_board)
    if (!task) return { status: 'no_task' }

    // 生存紧急检查
    let survival = null
    try { survival = survivalLevel(snapshot) } catch {}
    if (survival && survival.blocking) {
      // 暂停当前 Skill
      if (this.memory.active_skill_id) {
        this.executor.pause(this.memory.active_skill_id, `survival_preempt:${survival.key}`)
      }
      return { status: 'survival_preempted', survival: survival.key }
    }

    // 执行任务
    this.#log('DISPATCH', { task_id: task.id, skill_id: task.skill_id })
    const result = await this.executor.run(task.skill_id, task.skill_args)

    // 更新任务看板
    if (result.status === 'completed') {
      this.memory.task_board = markDone(this.memory.task_board, task.id, { now: this.now() })
      this.#log('COMPLETED', { task_id: task.id, skill_id: task.skill_id })
    } else if (result.status === 'failed') {
      this.memory.task_board = registerFailure(this.memory.task_board, task.id, result.reason ?? 'failed', { now: this.now() })
      this.#log('FAILED', { task_id: task.id, skill_id: task.skill_id, reason: result.reason })
    } else {
      // 处理 In Progress / Blocked (比如缺材料、不可达)
      if (result.status === 'blocked') {
        this.#log('BLOCKED', { task_id: task.id, skill_id: task.skill_id, reason: result.reason })
      }
    }
    this.save()
    return { ...result, task_id: task.id }
  }
}
