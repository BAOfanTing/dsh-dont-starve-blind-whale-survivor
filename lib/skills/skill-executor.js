// 技能执行器（Skill Executor）：把「复合技能」拆成**一次调用推进一个有边界的步骤**。
//
// 设计（任务书 §三/§五）：
//   · 增量执行：run_skill(skill_id) 第一次创建会话，之后每次调用继续当前步骤；
//     每次最多下发**一个**原子动作，绝不在 Node 主循环里长时间阻塞、绝不并行动作。
//   · 真实证据：步骤是否完成由 step.isDone(最新快照) 判定，**不看** dispatcher 的 ok=true。
//     （例如 build 科学机器：必须观察到建筑真实出现；collect gold：背包金块数确实变多。）
//   · 中断安全：中断后重新进入时，先跳过 isDone 已经为真的步骤，**不重放已完成的动作**。
//   · 单角色单技能：同一时间只有一个技能 in_progress；启动新技能会暂停旧技能（保留步骤进度）。
//   · 持久化：实例状态写回 world memory（memory.skill_instances），换进程/重连可恢复。
//
// 执行链：Skill → Step → 原子动作 → Dispatcher（唯一出口）→ Lua → 新快照 → 验证 → 更新进度。
// 本模块**不**重新实现移动/采集/制作，也不自带执行通道。

import { getSkill } from './skill-registry.js'
import { survivalLevel } from '../planner/survival-priority.js'
import { evaluateTarget } from '../planner/task-board.js'
import { wrapSkillInstances } from '../planner/world-memory.js'

const LOG = {
  START: 'START', RESUME: 'RESUME', STEP_START: 'STEP_START', ACTION_DISPATCH: 'ACTION_DISPATCH',
  STEP_VERIFIED: 'STEP_VERIFIED', STEP_FAILED: 'STEP_FAILED', PAUSED: 'PAUSED', RECOVERED: 'RECOVERED', FINISHED: 'FINISHED',
}

let instanceSeq = 0
function generateInstanceId(taskId, skillId, now) {
  instanceSeq += 1
  const clean = String(taskId || skillId || 'skill').replace(/[^a-zA-Z0-9_-]/g, '_')
  return `inst_${clean}_${now}_${instanceSeq}`
}

function newInstance(skillId, taskId, skillArgs = null, now = Date.now()) {
  const instanceId = generateInstanceId(taskId, skillId, now)
  const args = (skillArgs && typeof skillArgs === 'object' && !Array.isArray(skillArgs))
    ? { ...skillArgs }
    : null
  const data = {}
  if (args) {
    data.skill_args = { ...args }
    if (args.recipe && typeof args.recipe === 'object') {
      data.recipe = args.recipe
    }
  }
  return {
    instance_id: instanceId,
    task_id: taskId,
    skill_id: skillId,
    skill_args: args,
    status: 'pending',
    step_index: 0,
    attempts: 0,
    step_attempts: {},
    step_calls: {},
    calls: 0,
    data,
    blocked_reason: null,
    paused_reason: null,
    last_action: null,
    last_outcome: null,
    created_at: now,
    started_at: now,
    updated_at: now,
    completed_at: null,
    failed_at: null,
  }
}

/** 从 out_of_range 回执里解析目标坐标（如「...在 15.2 格外 (37,-45)：先 move_to」）。 */
function parseCoords(message) {
  const m = String(message ?? '').match(/\((-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\)/)
  if (!m) return null
  return { x: Math.round(Number(m[1])), z: Math.round(Number(m[2])) }
}

export class SkillExecutor {
  /**
   * @param {object} opts
   * @param {object} opts.memory   世界记忆（可变；实例存在 memory.skill_instances）
   * @param {string|null} [opts.worldKey]
   * @param {() => object|null} opts.readSnapshot 读最新归一化快照
   * @param {(tool:string,args:object)=>Promise<object>} opts.dispatch 走 dispatcher
   * @param {(outcome:object)=>string} [opts.describe]
   * @param {(tag:string,payload:object)=>void} [opts.log]
   * @param {()=>void} [opts.save]  持久化记忆
   * @param {()=>number} [opts.now]
   */
  constructor({ memory, worldKey = null, readSnapshot, dispatch, describe = null, log = () => {}, save = () => {}, now = () => Date.now() }) {
    this.memory = memory && typeof memory === 'object' ? memory : {}
    this.worldKey = worldKey
    this.readSnapshot = readSnapshot
    this.dispatch = dispatch
    this.describe = describe
    this.log = log
    this.save = save
    this.now = now
  }

  #migrateLegacyInstances() {
    const rawMap = this.memory.skill_instances
    if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return

    const entries = Object.entries(rawMap).filter(([k]) => k !== '__isProxy')
    const needsMigration = !rawMap.__isProxy || entries.some(([k, v]) => !v || typeof v !== 'object' || Array.isArray(v) || v.instance_id !== k)

    if (!needsMigration) return

    const migrated = {}
    const usedIds = new Set()

    for (const [key, raw] of entries) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue

      // 如果这个 entry 只是旧键副本（例如 key 是 gather_resources，而 raw.instance_id 已经作为另一个键存在且内容一致），跳过冗余旧键
      if (raw.instance_id && key !== raw.instance_id && (rawMap[raw.instance_id] || migrated[raw.instance_id])) {
        continue
      }

      const item = { ...raw }
      const skillId = typeof item.skill_id === 'string' && item.skill_id.length > 0
        ? item.skill_id
        : (key.startsWith('inst_') ? null : key)

      let iid = typeof item.instance_id === 'string' && item.instance_id.length > 0 ? item.instance_id : null
      if (!iid) {
        if (key.startsWith('inst_')) {
          iid = key
        } else {
          const baseName = item.task_id || skillId || key
          const ts = item.started_at || item.created_at || this.now()
          iid = `inst_${baseName}_${ts}`
        }
      }

      if (usedIds.has(iid)) {
        let counter = 1
        let candidate = `${iid}_${counter}`
        while (usedIds.has(candidate)) {
          counter++
          candidate = `${iid}_${counter}`
        }
        iid = candidate
      }
      usedIds.add(iid)

      item.instance_id = iid
      // 如果没有 task_id，但 key 既不是 inst_ 也不是复合 task_id，说明是旧版以 skill_id 为键的手动技能记录
      if (!item.task_id) {
        item.task_id = `manual:${skillId || key}`
      }
      item.skill_id = skillId || (item.task_id.startsWith('manual:') ? item.task_id.slice(7) : item.task_id)
      item.skill_args = item.skill_args || item.data?.skill_args || null
      item.step_index = Number.isInteger(item.step_index) ? item.step_index : 0
      item.created_at = Number(item.created_at || item.started_at || this.now())
      item.updated_at = Number(item.updated_at || this.now())
      item.status = typeof item.status === 'string' ? item.status : 'pending'

      migrated[iid] = item
    }

    if (!this.memory.active_skill_instance_id && this.memory.active_skill_id) {
      const match = Object.values(migrated).find((x) => x.skill_id === this.memory.active_skill_id && (x.status === 'in_progress' || x.status === 'paused'))
      if (match) this.memory.active_skill_instance_id = match.instance_id
    }

    this.memory.skill_instances = wrapSkillInstances(migrated)
  }

  #ensure() {
    if (!this.memory.skill_instances || typeof this.memory.skill_instances !== 'object' || Array.isArray(this.memory.skill_instances)) {
      this.memory.skill_instances = wrapSkillInstances({})
    }
    this.#migrateLegacyInstances()
    if (!('active_skill_id' in this.memory)) this.memory.active_skill_id = null
    if (!('active_skill_instance_id' in this.memory)) this.memory.active_skill_instance_id = null
    return this.memory.skill_instances
  }

  #snapshot() {
    try { return this.readSnapshot?.() ?? null } catch { return null }
  }

  #ctx(inst = null) {
    return { snapshot: this.#snapshot(), memory: this.memory, worldKey: this.worldKey, now: this.now(), instance: inst }
  }

  #log(tag, fields = {}) {
    try {
      this.log(`[SKILL] ${tag}`, {
        world_key: this.worldKey,
        task_id: fields.task_id ?? null,
        skill_id: fields.skill_id ?? null,
        instance_id: fields.instance_id ?? null,
        step_id: fields.step_id ?? null,
        status: fields.status ?? null,
        reason: fields.reason ?? null,
        ...fields,
      })
    } catch {}
  }

  #save() { try { this.save() } catch {} }

  /** 全部实例列表 */
  allInstances() {
    return Object.values(this.#ensure())
  }

  /** 根据 instance_id 获取实例 */
  instanceById(instanceId) {
    if (!instanceId) return null
    return this.#ensure()[String(instanceId)] ?? null
  }

  /** 当前控制角色的活动实例（若有） */
  activeInstance() {
    const activeId = this.memory.active_skill_instance_id
    if (activeId) {
      const inst = this.instanceById(activeId)
      if (inst && (inst.status === 'in_progress' || inst.status === 'paused' || inst.status === 'pending')) return inst
    }
    return this.allInstances().find((x) => x.status === 'in_progress') ?? null
  }

  /** 为某个任务查找当前未终态的活动实例 */
  activeInstanceForTask(taskId) {
    if (!taskId) return null
    const list = this.allInstances().filter((x) => x.task_id === taskId && !['completed', 'failed', 'cancelled'].includes(x.status))
    if (list.length === 0) return null
    return list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0]
  }

  /** 为某个任务查找最近的实例（含已完成/已失败，按 updated_at 倒序） */
  latestInstanceForTask(taskId) {
    if (!taskId) return null
    const list = this.allInstances().filter((x) => x.task_id === taskId)
    if (list.length === 0) return null
    return list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0]
  }

  /** 为某个任务查找所有历史实例（按创建时间正序） */
  instancesForTask(taskId) {
    if (!taskId) return []
    return this.allInstances().filter((x) => x.task_id === taskId).sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
  }

  /** 兼容旧版查询：支持 instance_id / task_id / skill_id */
  instanceOf(id) {
    if (!id) return null
    const key = String(id)
    const direct = this.#ensure()[key]
    if (direct) return direct
    // 优先匹配活跃 task_id
    const activeTask = this.activeInstanceForTask(key)
    if (activeTask) return activeTask
    // 匹配最近 task_id
    const latestTask = this.latestInstanceForTask(key)
    if (latestTask) return latestTask
    // 匹配活跃 skill_id
    const activeSkill = this.allInstances().find((x) => x.skill_id === key && !['completed', 'failed', 'cancelled'].includes(x.status))
    if (activeSkill) return activeSkill
    // 匹配最近 skill_id
    const matchingSkill = this.allInstances().filter((x) => x.skill_id === key).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0]
    return matchingSkill ?? null
  }

  /** 暂停某个任务或技能的活动实例（保留步骤进度） */
  pause(skillOrTaskId, reason = 'paused') {
    const inst = this.activeInstanceForTask(skillOrTaskId) || this.instanceById(skillOrTaskId) || this.instanceOf(skillOrTaskId)
    if (!inst || inst.status !== 'in_progress') return { ok: false, reason: 'not_active' }
    inst.status = 'paused'
    inst.paused_reason = reason
    inst.blocked_reason = reason
    inst.updated_at = this.now()
    if (this.memory.active_skill_instance_id === inst.instance_id) this.memory.active_skill_instance_id = null
    if (this.memory.active_skill_id === inst.skill_id) this.memory.active_skill_id = null
    this.#log(LOG.PAUSED, {
      skill_id: inst.skill_id,
      task_id: inst.task_id,
      instance_id: inst.instance_id,
      reason,
      step_id: this.#stepId(inst),
    })
    this.#save()
    return { ok: true, instance_id: inst.instance_id }
  }

  /** 取消某个任务或技能的实例 */
  cancel(skillOrTaskId, reason = 'cancelled') {
    const inst = this.activeInstanceForTask(skillOrTaskId) || this.instanceById(skillOrTaskId) || this.instanceOf(skillOrTaskId)
    if (!inst) return { ok: false, reason: 'unknown_skill_instance' }
    inst.status = 'cancelled'
    inst.blocked_reason = reason
    inst.updated_at = this.now()
    if (this.memory.active_skill_instance_id === inst.instance_id) this.memory.active_skill_instance_id = null
    if (this.memory.active_skill_id === inst.skill_id) this.memory.active_skill_id = null
    this.#save()
    return { ok: true, instance_id: inst.instance_id }
  }

  #stepId(inst) {
    const skill = getSkill(inst?.skill_id)
    return skill?.steps?.[inst.step_index]?.id ?? null
  }

  /** 启动/恢复新实例前，暂停其它 in_progress 的实例（单角色单技能）。 */
  #pauseOthers(currentInstanceId) {
    const insts = this.#ensure()
    for (const inst of Object.values(insts)) {
      if (!inst || inst.instance_id === currentInstanceId) continue
      if (inst.status === 'in_progress') {
        inst.status = 'paused'
        inst.paused_reason = `preempted_by:${currentInstanceId}`
        inst.blocked_reason = `preempted_by:${currentInstanceId}`
        inst.updated_at = this.now()
        this.#log(LOG.PAUSED, {
          skill_id: inst.skill_id,
          task_id: inst.task_id,
          instance_id: inst.instance_id,
          reason: `preempted_by:${currentInstanceId}`,
          step_id: this.#stepId(inst),
        })
      }
    }
    if (this.memory.active_skill_instance_id && this.memory.active_skill_instance_id !== currentInstanceId) {
      this.memory.active_skill_instance_id = null
    }
  }

  #finish(inst, status, reason = null) {
    inst.status = status
    inst.blocked_reason = reason
    inst.updated_at = this.now()
    if (status === 'completed') inst.completed_at = this.now()
    if (status === 'failed') inst.failed_at = this.now()
    if (this.memory.active_skill_instance_id === inst.instance_id) this.memory.active_skill_instance_id = null
    if (this.memory.active_skill_id === inst.skill_id) this.memory.active_skill_id = null
    this.#log(status === 'completed' ? LOG.FINISHED : LOG.STEP_FAILED, {
      skill_id: inst.skill_id,
      task_id: inst.task_id,
      instance_id: inst.instance_id,
      step_id: this.#stepId(inst),
      reason,
      progress: `${inst.step_index}/${getSkill(inst.skill_id)?.steps?.length ?? '?'}`,
    })
    this.#save()
  }

  /**
   * 推进技能一步（一次调用最多一个原子动作）。
   * @param {string} skillId 技能 ID
   * @param {string|object|null} [taskIdOrArgs] 关联的任务 ID 或技能参数
   * @param {object|null} [maybeArgs] 可选参数，合并并持久化至实例 data.skill_args；后续恢复时自动保留
   * @returns {Promise<{status:string, skill_id:string, task_id?:string, instance_id?:string, step?:string, reason?:string, detail?:string, verified?:any}>}
   */
  async run(skillId, taskIdOrArgs = null, maybeArgs = null) {
    const id = String(skillId)
    let taskId = null
    let skillArgs = null

    if (typeof taskIdOrArgs === 'string') {
      taskId = taskIdOrArgs
      skillArgs = maybeArgs && typeof maybeArgs === 'object' && !Array.isArray(maybeArgs) ? maybeArgs : null
    } else if (taskIdOrArgs && typeof taskIdOrArgs === 'object' && !Array.isArray(taskIdOrArgs)) {
      skillArgs = taskIdOrArgs
      taskId = typeof maybeArgs === 'string' ? maybeArgs : null
    }

    if (!taskId) {
      taskId = `manual:${id}`
    }

    const skill = getSkill(id)
    if (!skill) return { status: 'rejected', skill_id: id, task_id: taskId, reason: 'unknown_skill', detail: `没有这个技能：${id}（可用：见工具说明）` }

    const insts = this.#ensure()
    let inst = this.activeInstanceForTask(taskId)

    if (!inst) {
      const latest = this.latestInstanceForTask(taskId)
      if (latest && latest.status === 'completed') {
        const effectiveArgs = skillArgs ?? latest.skill_args
        const checkInst = { ...latest, skill_args: effectiveArgs, data: { ...(latest.data ?? {}), skill_args: effectiveArgs, recipe: effectiveArgs?.recipe ?? latest.data?.recipe } }
        if (this.#completed(skill, checkInst)) {
          return { status: 'completed', skill_id: id, task_id: taskId, instance_id: latest.instance_id, detail: '该任务技能已完成（记忆里已有实例），不重复执行' }
        }
        inst = newInstance(id, taskId, effectiveArgs, this.now())
        insts[inst.instance_id] = inst
      } else if (latest && latest.status === 'failed') {
        const effectiveArgs = skillArgs ?? latest.skill_args
        inst = newInstance(id, taskId, effectiveArgs, this.now())
        inst.attempts = (latest.attempts || 0) + 1
        insts[inst.instance_id] = inst
      } else if (latest && latest.status === 'cancelled') {
        const effectiveArgs = skillArgs ?? latest.skill_args
        inst = newInstance(id, taskId, effectiveArgs, this.now())
        insts[inst.instance_id] = inst
      } else {
        inst = newInstance(id, taskId, skillArgs, this.now())
        insts[inst.instance_id] = inst
      }
    }

    // 技能参数注入与持久化
    if (skillArgs && typeof skillArgs === 'object' && !Array.isArray(skillArgs)) {
      inst.skill_args = { ...(inst.skill_args ?? {}), ...skillArgs }
      if (!inst.data || typeof inst.data !== 'object') inst.data = {}
      inst.data.skill_args = { ...(inst.data.skill_args ?? {}), ...inst.skill_args }
      if (skillArgs.recipe && typeof skillArgs.recipe === 'object') {
        inst.data.recipe = skillArgs.recipe
      }
    }

    // 单角色单技能：先暂停其它技能
    this.#pauseOthers(inst.instance_id)

    if (inst.status !== 'in_progress') {
      const resuming = inst.status === 'paused' && inst.step_index > 0
      inst.status = 'in_progress'
      inst.paused_reason = null
      inst.updated_at = this.now()
      this.#log(resuming ? LOG.RESUME : LOG.START, {
        skill_id: id,
        task_id: taskId,
        instance_id: inst.instance_id,
        step_id: this.#stepId(inst),
        status: inst.status,
        progress: `${inst.step_index}/${skill.steps.length}`,
      })
    }
    this.memory.active_skill_instance_id = inst.instance_id
    this.memory.active_skill_id = id
    this.#save()

    // 生存紧急检查
    if (id !== 'survival_stabilize') {
      let lv = null
      try { lv = survivalLevel(this.#snapshot()) } catch {}
      if (lv && lv.blocking) {
        inst.status = 'paused'
        inst.paused_reason = `survival_preempt:${lv.key}`
        inst.blocked_reason = `survival_preempt:${lv.key}`
        inst.updated_at = this.now()
        if (this.memory.active_skill_instance_id === inst.instance_id) this.memory.active_skill_instance_id = null
        if (this.memory.active_skill_id === id) this.memory.active_skill_id = null
        this.#log(LOG.PAUSED, {
          skill_id: id,
          task_id: taskId,
          instance_id: inst.instance_id,
          step_id: this.#stepId(inst),
          status: 'paused',
          reason: `survival_preempt:${lv.key}`,
        })
        this.#save()
        return {
          status: 'blocked',
          skill_id: id,
          task_id: taskId,
          instance_id: inst.instance_id,
          reason: `survival_preempt:${lv.key}`,
          detail: `检测到生存紧急（${lv.label}），已暂停 ${id} 并保留进度；请先 run_skill survival_stabilize，安全后再继续`,
        }
      }
    }

    // 前置条件
    if (typeof skill.preconditions === 'function') {
      let pre
      try { pre = skill.preconditions(this.#ctx(inst)) } catch (e) { pre = { ok: false, reason: `precondition_error:${e?.message ?? e}` } }
      if (pre && pre.ok === false) {
        inst.status = 'paused'
        inst.blocked_reason = pre.reason ?? 'preconditions_unmet'
        inst.updated_at = this.now()
        this.#log(LOG.PAUSED, {
          skill_id: id,
          task_id: taskId,
          instance_id: inst.instance_id,
          step_id: this.#stepId(inst),
          status: 'paused',
          reason: inst.blocked_reason,
        })
        this.#save()
        return { status: 'blocked', skill_id: id, task_id: taskId, instance_id: inst.instance_id, reason: inst.blocked_reason }
      }
    }

    // 整体完成？
    if (this.#completed(skill, inst)) return this.#done(inst, skill)

    const maxAttempts = skill.retry_policy?.max_step_attempts ?? 3
    const maxCalls = skill.timeout_policy?.max_calls_per_step ?? 8

    // 跳过已完成步骤（中断后不重复已完成的动作）
    let i = inst.step_index
    let ctx = this.#ctx(inst)
    while (i < skill.steps.length && this.#safeIsDone(skill.steps[i], ctx)) {
      inst.step_index = i + 1
      i += 1
      ctx = this.#ctx(inst)
    }
    if (inst.step_index >= skill.steps.length) {
      if (this.#completed(skill, inst)) return this.#done(inst, skill)
      // 所有步骤都"已完成"但整体 completion 不满足：交给 completion 判定，暂停等待
      inst.status = 'paused'
      inst.blocked_reason = 'steps_done_completion_unmet'
      this.#save()
      return { status: 'blocked', skill_id: id, task_id: taskId, instance_id: inst.instance_id, reason: 'steps_done_completion_unmet' }
    }

    const step = skill.steps[i]
    const stepAttempts = inst.step_attempts[step.id] ?? 0
    const stepCalls = inst.step_calls[step.id] ?? 0

    // 选下一步原子动作：若上一步因 out_of_range 留下了目标坐标，先走过去（位置问题不是技能失败）
    let plan
    if (inst.data && inst.data.approach) {
      plan = { tool: 'move_to', args: { x: inst.data.approach.x, z: inst.data.approach.z } }
    } else {
      try { plan = step.nextAction(ctx, inst) } catch (e) { plan = { blocked: `step_plan_error:${e?.message ?? e}` } }
    }
    if (plan && plan.blocked) {
      inst.status = 'paused'
      inst.blocked_reason = plan.blocked
      inst.updated_at = this.now()
      this.#log(LOG.PAUSED, {
        skill_id: id,
        task_id: taskId,
        instance_id: inst.instance_id,
        step_id: step.id,
        status: 'paused',
        reason: plan.blocked,
      })
      this.#save()
      return { status: 'blocked', skill_id: id, task_id: taskId, instance_id: inst.instance_id, step: step.id, reason: plan.blocked }
    }
    if (!plan || plan.done) {
      inst.step_index = i + 1
      inst.step_attempts[step.id] = 0
      inst.step_calls[step.id] = 0
      inst.updated_at = this.now()
      this.#log(LOG.STEP_VERIFIED, {
        skill_id: id,
        task_id: taskId,
        instance_id: inst.instance_id,
        step_id: step.id,
        status: 'verified',
        result: 'done_without_action',
        reason: 'done_without_action',
      })
      this.#save()
      if (this.#completed(skill, inst) || inst.step_index >= skill.steps.length) return this.#done(inst, skill)
      return { status: 'step_verified', skill_id: id, task_id: taskId, instance_id: inst.instance_id, step: step.id }
    }

    // 预算：同一步骤反复调用不收敛就失败，避免无限采集
    if (stepCalls >= maxCalls) {
      inst.status = 'failed'
      inst.failed_at = this.now()
      inst.blocked_reason = `step_budget_exhausted:${step.id}`
      if (this.memory.active_skill_instance_id === inst.instance_id) this.memory.active_skill_instance_id = null
      if (this.memory.active_skill_id === id) this.memory.active_skill_id = null
      this.#log(LOG.STEP_FAILED, {
        skill_id: id,
        task_id: taskId,
        instance_id: inst.instance_id,
        step_id: step.id,
        status: 'failed',
        reason: 'budget_exhausted',
        attempts: stepAttempts,
      })
      this.#save()
      return { status: 'failed', skill_id: id, task_id: taskId, instance_id: inst.instance_id, step: step.id, reason: 'budget_exhausted' }
    }

    // 下发一个原子动作（唯一执行通道）
    this.#log(LOG.STEP_START, {
      skill_id: id,
      task_id: taskId,
      instance_id: inst.instance_id,
      step_id: step.id,
      status: 'in_progress',
      progress: `${i}/${skill.steps.length}`,
    })
    this.#log(LOG.ACTION_DISPATCH, {
      skill_id: id,
      task_id: taskId,
      instance_id: inst.instance_id,
      step_id: step.id,
      status: 'dispatching',
      tool: plan.tool,
      args: plan.args,
    })
    let outcome
    try {
      outcome = await this.dispatch(plan.tool, plan.args)
    } catch (e) {
      outcome = { status: 'failed', reason: 'dispatch_threw', message: String(e?.message ?? e) }
    }
    inst.calls = (inst.calls ?? 0) + 1
    inst.step_calls[step.id] = stepCalls + 1
    inst.last_action = { tool: plan.tool, args: plan.args }
    inst.last_outcome = { status: outcome?.status ?? null, reason: outcome?.reason ?? null }
    // 已经执行了这次"接近"移动 → 清掉待接近标记（下次重新按技能逻辑判断）
    if (plan.tool === 'move_to' && inst.data && inst.data.approach) delete inst.data.approach
    // seek 只"报告位置"不移动：它找到目标并报出坐标时，下一步自动 move_to 过去（否则原地反复 seek）
    if (plan.tool === 'seek' && outcome?.status === 'succeeded') {
      const c = parseCoords(outcome?.message)
      if (c) { if (!inst.data) inst.data = {}; inst.data.approach = c }
    }
    inst.updated_at = this.now()

    const detail = this.describe ? this.describe(outcome) : ''

    // ★ 真实证据：重新读快照，由 step.isDone 判定，绝不信 ok=true
    const afterCtx = this.#ctx(inst)
    const doneNow = this.#safeIsDone(step, afterCtx)
    if (doneNow) {
      inst.step_index = i + 1
      inst.step_attempts[step.id] = 0
      inst.step_calls[step.id] = 0
      inst.blocked_reason = null
      inst.updated_at = this.now()
      this.#log(LOG.STEP_VERIFIED, {
        skill_id: id,
        task_id: taskId,
        instance_id: inst.instance_id,
        step_id: step.id,
        status: 'verified',
        result: outcome?.status ?? null,
        progress: `${inst.step_index}/${skill.steps.length}`,
      })
      this.#save()
      if (this.#completed(skill, inst) || inst.step_index >= skill.steps.length) return this.#done(inst, skill)
      return { status: 'step_verified', skill_id: id, task_id: taskId, instance_id: inst.instance_id, step: step.id, verified: outcome?.status ?? null, detail }
    }

    // 没验证通过：区分"明确失败"与"已下发但还没生效（继续）"
    const hardFail = outcome?.status === 'rejected' || outcome?.status === 'failed' || outcome?.status === 'unknown'
    if (hardFail) {
      // 位置问题（out_of_range）：不是技能失败。解析回执里的真实坐标，下一步先走过去。
      if (outcome?.reason === 'out_of_range') {
        const c = parseCoords(outcome?.message)
        if (c) {
          if (!inst.data) inst.data = {}
          inst.data.approach = c
          this.#save()
          return { status: 'step_in_progress', skill_id: id, task_id: taskId, instance_id: inst.instance_id, step: step.id, reason: 'approaching', detail: `目标太远，先去 (${c.x},${c.z}) 再动手` }
        }
      }
      inst.step_attempts[step.id] = stepAttempts + 1
      const exhausted = inst.step_attempts[step.id] >= maxAttempts
      this.#log(LOG.STEP_FAILED, {
        skill_id: id,
        task_id: taskId,
        instance_id: inst.instance_id,
        step_id: step.id,
        status: outcome?.status ?? 'failed',
        result: outcome?.status,
        reason: outcome?.reason ?? null,
        attempts: inst.step_attempts[step.id],
      })
      if (exhausted) {
        inst.status = 'failed'
        inst.failed_at = this.now()
        inst.blocked_reason = `step_failed:${step.id}:${outcome?.reason ?? 'failed'}`
        if (this.memory.active_skill_instance_id === inst.instance_id) this.memory.active_skill_instance_id = null
        if (this.memory.active_skill_id === id) this.memory.active_skill_id = null
        this.#save()
        return { status: 'failed', skill_id: id, task_id: taskId, instance_id: inst.instance_id, step: step.id, reason: outcome?.reason ?? 'failed', detail }
      }
      this.#save()
      return { status: 'step_in_progress', skill_id: id, task_id: taskId, instance_id: inst.instance_id, step: step.id, reason: outcome?.reason ?? null, detail }
    }

    // ok 已下发但还没核对上（例如走位/建造需要下一帧）：继续，由预算兜底
    this.#save()
    return { status: 'step_in_progress', skill_id: id, task_id: taskId, instance_id: inst.instance_id, step: step.id, detail }
  }

  #safeIsDone(step, ctx) {
    try { return step.isDone(ctx) === true } catch { return false }
  }

  #completed(skill, inst) {
    if (inst.task_id && this.memory.task_board?.tasks) {
      const task = this.memory.task_board.tasks.find((t) => t.id === inst.task_id)
      if (task && task.target && typeof task.target === 'object' && Object.keys(task.target).length > 0) {
        try {
          const ev = evaluateTarget(task.target, this.#snapshot(), this.memory)
          if (ev.done === true) return true
        } catch {}
      }
    }
    // 没有 completion() 的技能：所有步骤都做完了就算完成。
    if (typeof skill.completion !== 'function') return inst.step_index >= skill.steps.length
    try { return skill.completion(this.#ctx(inst)) === true } catch { return false }
  }

  #done(inst, skill) {
    inst.status = 'completed'
    inst.completed_at = this.now()
    inst.updated_at = this.now()
    if (this.memory.active_skill_instance_id === inst.instance_id) this.memory.active_skill_instance_id = null
    if (this.memory.active_skill_id === inst.skill_id) this.memory.active_skill_id = null
    this.#log(LOG.FINISHED, {
      skill_id: inst.skill_id,
      task_id: inst.task_id,
      instance_id: inst.instance_id,
      step_id: this.#stepId(inst),
      progress: `${skill.steps.length}/${skill.steps.length}`,
      result: 'completed',
    })
    this.#save()
    return {
      status: 'completed',
      skill_id: inst.skill_id,
      task_id: inst.task_id,
      instance_id: inst.instance_id,
      detail: '技能完成（已用快照证据核对）',
    }
  }
}

/**
 * 便捷函数：构造并推进一次技能。供 tools.js 的 run_skill 使用。
 * @returns {Promise<object>}
 */
export async function runSkillOnce(skillId, opts, skillArgs = null) {
  const exec = new SkillExecutor(opts)
  return exec.run(skillId, skillArgs)
}
