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

import { pickNextTask, markDone, registerFailure, evaluateBoard, blockTask } from './task-board.js'
import { SkillExecutor } from '../skills/skill-executor.js'
import { survivalLevel } from './survival-priority.js'
import { recordExploration } from '../skills/explore-utils.js'

/**
 * 把 SkillExecutor 的原始状态映射成 Orchestrator/上层可识别的状态。
 * ★ 不做"原样透传"，也不把不同状态压成一个 in_progress：
 *   completed → completed；reflex_active → reflex_active；
 *   blocked / failed / unknown / awaiting_reconciliation / cancelled / timeout 各自保留；
 *   只有真正"还在推进"的 step_in_progress / step_verified 才算 in_progress。
 */
export function classifyExecutorStatus(result) {
  const status = String(result?.status ?? 'unknown')
  switch (status) {
    case 'completed': return 'completed'
    case 'reflex_active': return 'reflex_active'
    case 'blocked': return 'blocked'
    case 'failed': return 'failed'
    case 'rejected': return 'failed'
    case 'unknown': return 'unknown'
    case 'awaiting_reconciliation': return 'awaiting_reconciliation'
    case 'cancelled': return 'cancelled'
    case 'timeout': return 'timeout'
    case 'step_in_progress':
    case 'step_verified':
    case 'in_progress':
    case 'running':
      return 'in_progress'
    default:
      // 未知状态进入保护：按 unknown 处理，绝不当作"进行中"继续派发。
      return 'unknown'
  }
}

/** 把失败/阻塞 reason 归类成结构化的 blocked_kind（用于 Task Board 生命周期）。 */
export function blockedKindOf(reason) {
  const r = String(reason ?? '')
  if (/survival_preempt/.test(r)) return 'survival_preempt'
  if (/precondition|revive|retreat|死亡|灵魂/.test(r)) return 'precondition'
  if (/out_of_range|no_path|path_|unreachable|cannot_reach/.test(r)) return 'path_unreachable'
  if (/target_gone|entity_gone|no_target|target_missing|target_not_|not_ready|already_harvested/.test(r)) return 'target_missing'
  if (/ingredient|material|missing|resource|gather|no_food|all_food_candidates_blocked/.test(r)) return 'resource_missing'
  return 'external_condition'
}

/** 永久阻塞类型：必须人工核实/处理，绝不自动恢复为 ready。 */
const NON_TRANSIENT_BLOCK_KINDS = new Set(['unknown_outcome', 'cancelled'])
/** 软阻塞的重试退避基准（指数退避，MAX_ATTEMPTS 后升级为 failed）。 */
const BLOCK_RETRY_BASE_MS = 20_000


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
      const mapped = classifyExecutorStatus(result)
      if (mapped === 'completed') {
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
      } else if (mapped === 'failed') {
        this.memory.task_board = registerFailure(this.memory.task_board, effectiveTaskId, result.reason ?? 'failed', { now: this.now() })
        this.#logTask('BLOCKED', {
          task_id: effectiveTaskId,
          skill_id: skillId,
          instance_id: result.instance_id,
          status: 'failed',
          reason: result.reason ?? 'failed',
        })
      } else if (mapped === 'blocked') {
        const kind = blockedKindOf(result.reason)
        this.memory.task_board = blockTask(this.memory.task_board, effectiveTaskId, {
          kind,
          reason: result.reason ?? 'skill_blocked',
          retryAfterMs: NON_TRANSIENT_BLOCK_KINDS.has(kind) ? null : BLOCK_RETRY_BASE_MS,
          now: this.now(),
        })
        this.#logTask('BLOCKED', {
          task_id: effectiveTaskId,
          skill_id: skillId,
          instance_id: result.instance_id,
          status: 'blocked',
          reason: result.reason,
        })
      } else if (mapped === 'unknown') {
        this.memory.task_board = blockTask(this.memory.task_board, effectiveTaskId, {
          kind: 'unknown_outcome', reason: 'task_outcome_unknown', now: this.now(),
        })
        this.#logTask('BLOCKED', {
          task_id: effectiveTaskId, skill_id: skillId, instance_id: result.instance_id,
          status: 'unknown', reason: result.reason ?? 'task_outcome_unknown',
        })
      } else if (mapped === 'cancelled') {
        this.memory.task_board = blockTask(this.memory.task_board, effectiveTaskId, {
          kind: 'cancelled', reason: result.reason ?? 'cancelled', now: this.now(),
        })
        this.#logTask('BLOCKED', {
          task_id: effectiveTaskId, skill_id: skillId, instance_id: result.instance_id,
          status: 'cancelled', reason: result.reason ?? 'cancelled',
        })
      } else if (mapped === 'awaiting_reconciliation') {
        const t = this.memory.task_board.tasks.find((x) => x.id === effectiveTaskId)
        if (t && t.status !== 'in_progress') t.status = 'in_progress'
      } else {
        // in_progress / step_verified
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
    // ★ 修复：只有「Lua reflex 真的 active」或「真的被贴脸攻击(attacker)」才让位给 Lua；
    //   单纯"处于已知危险区(zone)"不能一直让位——Lua reflex 只对贴脸攻击反应，
    //   否则会出现"计划说先撤离、Autopilot 却 0 动作"的死锁（实测必现）。危险区由 step3
    //   的 survival_stabilize 主动 move_to 撤离。
    const reflexActive = snapshot?.reflex?.active === true
    if (reflexActive || (survival && survival.key === 'retreat' && survival.zone !== true)) {
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

      // ★ Phase R.7.4：不能把 blocked/failed/unknown/awaiting_reconciliation/cancelled/timeout
      //   统统包装成 survival_in_progress（那会把"失败/阻塞"伪装成"还在执行"，上层继续空转）。
      //   这里做明确的状态映射，并保留底层原因、实例 ID、步骤。
      const mapped = classifyExecutorStatus(emergencyResult)
      const base = {
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

      if (mapped === 'completed') {
        this.#logTask('COMPLETED', {
          task_id: emergencyTaskId,
          skill_id: 'survival_stabilize',
          instance_id: emergencyResult.instance_id,
          status: 'completed',
          reason: 'emergency_stabilized',
        })
        return { status: 'survival_stabilized', ...base }
      }

      if (mapped === 'reflex_active') {
        return {
          status: 'reflex_active',
          control_owner: 'lua_reflex',
          reflex_active: true,
          ordinary_actions_allowed: false,
          ...base,
          reason: emergencyResult.reason ?? 'reflex_active',
        }
      }

      if (mapped === 'in_progress') {
        return { status: 'survival_in_progress', ...base }
      }

      // blocked / failed / unknown / awaiting_reconciliation / cancelled / timeout / rejected
      // —— 原样上报，绝不伪装成"仍在执行"。
      this.#logTask(mapped === 'blocked' ? 'BLOCKED' : 'FAILED', {
        task_id: emergencyTaskId,
        skill_id: 'survival_stabilize',
        instance_id: emergencyResult.instance_id,
        status: mapped,
        reason: emergencyResult.reason ?? mapped,
        step: emergencyResult.step ?? null,
      })
      return { status: mapped, ...base }
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
    const mapped = classifyExecutorStatus(result)

    // ★ Phase R.7.4：按映射后的状态回写 Task Board。绝不能把 failed/blocked/unknown 忽略掉。
    if (mapped === 'reflex_active') {
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

    if (mapped === 'awaiting_reconciliation') {
      // 等待核实：保持 in_progress，不重复派发（executor 内部不会重发原动作）。
      const t = this.memory.task_board?.tasks?.find((x) => x.id === task.id)
      if (t && t.status !== 'in_progress') t.status = 'in_progress'
      try { this.save() } catch {}
      return { ...result, status: 'awaiting_reconciliation', task_id: task.id }
    }

    if (mapped === 'unknown') {
      // 未知状态终态保护：置为 blocked(unknown_outcome)，要求人工核实，绝不自动重发。
      this.memory.task_board = blockTask(this.memory.task_board, task.id, {
        kind: 'unknown_outcome', reason: 'task_outcome_unknown', now: this.now(),
      })
      this.#logTask('BLOCKED', {
        task_id: task.id, skill_id: skillId, instance_id: result.instance_id,
        status: 'unknown', reason: result.reason ?? 'task_outcome_unknown',
      })
      try { this.save() } catch {}
      return { ...result, status: 'unknown', task_id: task.id }
    }

    if (mapped === 'completed') {
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
    } else if (mapped === 'failed') {
      this.memory.task_board = registerFailure(this.memory.task_board, task.id, result.reason ?? 'failed', { now: this.now() })
      this.#logTask('BLOCKED', {
        task_id: task.id,
        skill_id: skillId,
        instance_id: result.instance_id,
        status: 'failed',
        reason: result.reason ?? 'failed',
      })
    } else if (mapped === 'blocked') {
      const kind = blockedKindOf(result.reason)
      const transient = !NON_TRANSIENT_BLOCK_KINDS.has(kind)
      this.memory.task_board = blockTask(this.memory.task_board, task.id, {
        kind,
        reason: result.reason ?? 'skill_blocked',
        retryAfterMs: transient ? BLOCK_RETRY_BASE_MS : null,
        now: this.now(),
      })
      this.#logTask('BLOCKED', {
        task_id: task.id,
        skill_id: skillId,
        instance_id: result.instance_id,
        status: 'blocked',
        reason: result.reason,
      })
    } else if (mapped === 'cancelled') {
      this.memory.task_board = blockTask(this.memory.task_board, task.id, {
        kind: 'cancelled', reason: result.reason ?? 'cancelled', now: this.now(),
      })
      this.#logTask('BLOCKED', {
        task_id: task.id, skill_id: skillId, instance_id: result.instance_id,
        status: 'cancelled', reason: result.reason ?? 'cancelled',
      })
    } else if (mapped === 'timeout') {
      this.memory.task_board = blockTask(this.memory.task_board, task.id, {
        kind: 'external_condition', reason: result.reason ?? 'timeout', retryAfterMs: BLOCK_RETRY_BASE_MS, now: this.now(),
      })
      this.#logTask('BLOCKED', {
        task_id: task.id, skill_id: skillId, instance_id: result.instance_id,
        status: 'timeout', reason: result.reason ?? 'timeout',
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
    return { ...result, status: mapped === 'in_progress' ? result.status : mapped, task_id: task.id }
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
