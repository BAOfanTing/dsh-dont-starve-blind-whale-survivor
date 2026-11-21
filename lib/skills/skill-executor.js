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
import { recordTargetFailure } from './food-candidate-selector.js'

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
    const list = this.allInstances().filter((x) => x.task_id === taskId && !['completed', 'failed', 'cancelled', 'unknown'].includes(x.status))
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

  /**
   * 人工处理 unknown 任务结果（ISSUE-02 / Section 3.3）
   * 必须明确指定 taskId, instanceId, commandId 与 resolution。
   * @param {string} taskId
   * @param {{ instanceId: string, commandId: string, resolution: 'completed'|'abandoned'|'unexecuted', evidence?: any }} opts
   */
  resolveUnknownTask(taskId, { instanceId, commandId, resolution, evidence = null } = {}) {
    if (!taskId || !instanceId || !commandId || !resolution) {
      return { ok: false, reason: 'missing_required_params', message: '必须指定 taskId, instanceId, commandId 与 resolution' }
    }
    const inst = this.instanceById(instanceId)
    if (!inst || inst.task_id !== taskId) {
      return { ok: false, reason: 'instance_not_found', message: `未找到任务 ${taskId} 对应的实例 ${instanceId}` }
    }
    if (inst.status !== 'unknown') {
      return { ok: false, reason: 'not_unknown', message: `实例 ${instanceId} 状态不是 unknown，当前状态为 ${inst.status}` }
    }
    const recordedCmdId = inst.reconciliation?.command_id || inst.last_action?.command_id || null
    if (recordedCmdId && recordedCmdId !== commandId) {
      return { ok: false, reason: 'command_id_mismatch', message: `command_id 不匹配：记录为 ${recordedCmdId}，提供为 ${commandId}` }
    }

    if (resolution === 'completed') {
      inst.status = 'completed'
      inst.completed_at = this.now()
      inst.verified = evidence || { manual_resolved: true }
      inst.blocked_reason = null
      inst.updated_at = this.now()
      if (this.memory.active_skill_instance_id === inst.instance_id) this.memory.active_skill_instance_id = null
      if (this.memory.task_board?.tasks) {
        const t = this.memory.task_board.tasks.find((x) => x.id === taskId)
        if (t) {
          t.status = 'completed'
          t.completion_evidence = evidence || { manual_resolved: true }
        }
      }
      this.#save()
      return { ok: true, status: 'completed', task_id: taskId, instance_id: instanceId }
    } else if (resolution === 'abandoned') {
      inst.status = 'cancelled'
      inst.blocked_reason = 'manual_abandoned'
      inst.updated_at = this.now()
      if (this.memory.active_skill_instance_id === inst.instance_id) this.memory.active_skill_instance_id = null
      if (this.memory.task_board?.tasks) {
        const t = this.memory.task_board.tasks.find((x) => x.id === taskId)
        if (t) {
          t.status = 'blocked'
          t.blocked_reason = 'manual_abandoned'
        }
      }
      this.#save()
      return { ok: true, status: 'cancelled', task_id: taskId, instance_id: instanceId }
    } else if (resolution === 'unexecuted') {
      inst.status = 'failed'
      inst.blocked_reason = 'manual_unexecuted_retry'
      inst.updated_at = this.now()
      if (this.memory.active_skill_instance_id === inst.instance_id) this.memory.active_skill_instance_id = null
      if (this.memory.task_board?.tasks) {
        const t = this.memory.task_board.tasks.find((x) => x.id === taskId)
        if (t) {
          t.status = 'pending'
          t.blocked_reason = null
        }
      }
      this.#save()
      return { ok: true, status: 'resolved_unexecuted', task_id: taskId, instance_id: instanceId }
    }

    return { ok: false, reason: 'unsupported_resolution', message: `不支持的处理决定：${resolution}` }
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
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [runOpts] 额外执行选项（如取消信号、超时预算）
   * @returns {Promise<{status:string, skill_id:string, task_id?:string, instance_id?:string, step?:string, reason?:string, detail?:string, verified?:any}>}
   */
  async run(skillId, taskIdOrArgs = null, maybeArgs = null, runOpts = null) {
    const id = String(skillId)
    let taskId = null
    let skillArgs = null
    let options = (runOpts && typeof runOpts === 'object') ? runOpts : {}

    if (typeof taskIdOrArgs === 'string') {
      taskId = taskIdOrArgs
      if (maybeArgs && typeof maybeArgs === 'object' && !Array.isArray(maybeArgs)) {
        if (maybeArgs.signal && !options.signal) options.signal = maybeArgs.signal
        if (maybeArgs.owner && !options.owner) options.owner = maybeArgs.owner
        if (maybeArgs.ownerInstanceId && !options.ownerInstanceId) options.ownerInstanceId = maybeArgs.ownerInstanceId
        skillArgs = maybeArgs
      }
    } else if (taskIdOrArgs && typeof taskIdOrArgs === 'object' && !Array.isArray(taskIdOrArgs)) {
      skillArgs = taskIdOrArgs
      if (typeof maybeArgs === 'string') {
        taskId = maybeArgs
      } else if (maybeArgs && typeof maybeArgs === 'object') {
        if (!runOpts) options = maybeArgs
      }
    }

    if (!taskId) {
      taskId = `manual:${id}`
    }

    const signal = options?.signal ?? null
    if (signal?.aborted) {
      return {
        status: 'cancelled',
        skill_id: id,
        task_id: taskId,
        reason: 'aborted',
        detail: '执行在启动前已被中止',
      }
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
      } else if (latest && latest.status === 'unknown') {
        // ★ UNKNOWN 终态保护：严禁被自动重置为 in_progress 或盲目创建新实例重放！
        const cmdId = latest.reconciliation?.command_id || latest.last_action?.command_id || 'unknown'
        const tool = latest.reconciliation?.tool || latest.last_action?.tool || 'unknown'
        // R8.x C：只认证据——新鲜快照显示技能目标已完成就自动恢复；否则保持 unknown（严禁盲目重发）。
        try { if (this.#completed(skill, latest)) return this.#done(latest, skill) } catch {}
        return {
          status: 'blocked',
          skill_id: id,
          task_id: taskId,
          instance_id: latest.instance_id,
          reason: 'task_outcome_unknown',
          detail: `任务结果仍然未知，实例不可自动恢复。原 command_id：${cmdId}，原动作：${tool}。需要先检查真实游戏状态并人工处理未知结果`,
          action: {
            tool,
            command_id: cmdId,
            status: 'unknown',
            verified: false,
          },
        }
      } else {
        inst = newInstance(id, taskId, skillArgs, this.now())
        insts[inst.instance_id] = inst
      }
    }

    if (inst.status === 'unknown') {
      const cmdId = inst.reconciliation?.command_id || inst.last_action?.command_id || 'unknown'
      const tool = inst.reconciliation?.tool || inst.last_action?.tool || 'unknown'
      // R8.x C：只认证据——快照显示已完成则自动恢复；否则保持 unknown（严禁盲目重发）。
      try { if (this.#completed(skill, inst)) return this.#done(inst, skill) } catch {}
      return {
        status: 'blocked',
        skill_id: id,
        task_id: taskId,
        instance_id: inst.instance_id,
        reason: 'task_outcome_unknown',
        detail: `任务结果仍然未知，实例不可自动恢复。原 command_id：${cmdId}，原动作：${tool}。需要先检查真实游戏状态并人工处理未知结果`,
        action: {
          tool,
          command_id: cmdId,
          status: 'unknown',
          verified: false,
        },
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

    if (inst.status !== 'in_progress' && inst.status !== 'awaiting_reconciliation') {
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

    // ISSUE-02: 处于等待结果对账状态的实例，优先执行快照证据核验，严禁重复发送原动作
    if (inst.status === 'awaiting_reconciliation' && inst.reconciliation) {
      const rec = inst.reconciliation
      rec.reconcile_attempts = (rec.reconcile_attempts || 0) + 1
      rec.last_reconcile_at = this.now()

      this.#log('RECONCILIATION_STARTED', {
        skill_id: id,
        task_id: taskId,
        instance_id: inst.instance_id,
        step_id: rec.step_id,
        command_id: rec.command_id,
        tool: rec.tool,
        attempts: rec.reconcile_attempts,
      })

      const afterCtx = this.#ctx(inst)
      const currentStep = skill.steps[inst.step_index]
      const stepMatches = currentStep && currentStep.id === rec.step_id
      const isDoneNow = stepMatches && this.#safeIsDone(currentStep, afterCtx)

      if (isDoneNow) {
        // 对账成功：动作已经在游戏中实际执行并生效！
        this.#log('RECONCILIATION_COMPLETED', {
          skill_id: id,
          task_id: taskId,
          instance_id: inst.instance_id,
          step_id: rec.step_id,
          command_id: rec.command_id,
        })
        inst.status = 'in_progress'
        inst.step_index = inst.step_index + 1
        inst.step_attempts[rec.step_id] = 0
        inst.step_calls[rec.step_id] = 0
        inst.reconciliation = null
        inst.blocked_reason = null
        inst.updated_at = this.now()
        this.#save()

        const actionRec = {
          tool: rec.tool,
          args: rec.args,
          command_id: rec.command_id,
          status: 'succeeded',
          verified: true,
        }

        if (this.#completed(skill, inst) || inst.step_index >= skill.steps.length) {
          const doneRes = this.#done(inst, skill)
          doneRes.action = actionRec
          return doneRes
        }
        return {
          status: 'step_verified',
          skill_id: id,
          task_id: taskId,
          instance_id: inst.instance_id,
          step: rec.step_id,
          verified: true,
          detail: '未知动作对账成功：经最新快照核实，动作已在游戏中生效完成',
          action: actionRec,
        }
      }

      // 未核对成功：检查对账预算
      const maxReconcile = rec.max_reconcile_attempts || 3
      if (rec.reconcile_attempts >= maxReconcile) {
        this.#log('RECONCILIATION_FAILED', {
          skill_id: id,
          task_id: taskId,
          instance_id: inst.instance_id,
          step_id: rec.step_id,
          command_id: rec.command_id,
          reason: 'reconciliation_budget_exhausted',
        })
        inst.status = 'unknown'
        inst.blocked_reason = `reconciliation_budget_exhausted:${rec.step_id}:${rec.command_id}`
        inst.updated_at = this.now()
        this.#save()
        return {
          status: 'unknown',
          skill_id: id,
          task_id: taskId,
          instance_id: inst.instance_id,
          step: rec.step_id,
          reason: 'reconciliation_budget_exhausted',
          detail: `结果对账超过预算（尝试 ${rec.reconcile_attempts} 次仍未检测到生效证据），为防止产生副作用禁止盲目重发`,
          action: {
            tool: rec.tool,
            args: rec.args,
            command_id: rec.command_id,
            status: 'unknown',
            verified: false,
          },
        }
      }

      // 仍在对账等待期，保持 awaiting_reconciliation，不重新发送动作
      this.#save()
      return {
        status: 'awaiting_reconciliation',
        skill_id: id,
        task_id: taskId,
        instance_id: inst.instance_id,
        step: rec.step_id,
        reason: 'awaiting_reconciliation',
        detail: `动作结果未知，正在等待对账确认 (尝试 ${rec.reconcile_attempts}/${maxReconcile})，暂不重发`,
        action: {
          tool: rec.tool,
          args: rec.args,
          command_id: rec.command_id,
          status: 'unknown',
          verified: false,
        },
      }
    }

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
      outcome = await this.dispatch(plan.tool, plan.args, {
        signal,
        budget_s: plan.budget_s,
        timeoutMs: plan.timeoutMs,
        owner: options?.owner ?? 'system',
        ownerInstanceId: options?.ownerInstanceId ?? null,
      })
    } catch (e) {
      outcome = { status: 'failed', reason: 'dispatch_threw', message: String(e?.message ?? e) }
    }
    inst.calls = (inst.calls ?? 0) + 1
    inst.step_calls[step.id] = stepCalls + 1
    inst.last_action = { tool: plan.tool, args: plan.args }
    inst.last_outcome = { status: outcome?.status ?? null, reason: outcome?.reason ?? null }

    // 取消检查：如果被信号中止或底层返回 cancelled
    if (outcome?.status === 'cancelled' || signal?.aborted) {
      inst.status = 'cancelled'
      inst.cancelled_at = this.now()
      inst.blocked_reason = 'cancelled'
      if (this.memory.active_skill_instance_id === inst.instance_id) this.memory.active_skill_instance_id = null
      if (this.memory.active_skill_id === id) this.memory.active_skill_id = null
      this.#save()
      return {
        status: 'cancelled',
        skill_id: id,
        task_id: taskId,
        instance_id: inst.instance_id,
        step: step.id,
        reason: outcome?.reason ?? 'cancelled',
        detail: '动作执行已被取消',
        action: {
          tool: plan.tool,
          args: plan.args,
          command_id: outcome?.commandId ?? null,
          status: 'cancelled',
          verified: false,
        },
      }
    }

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
      const actionRec = {
        tool: plan.tool,
        args: plan.args,
        command_id: outcome?.commandId ?? null,
        status: outcome?.status ?? 'succeeded',
        verified: true,
      }
      if (this.#completed(skill, inst) || inst.step_index >= skill.steps.length) {
        const doneRes = this.#done(inst, skill)
        doneRes.action = actionRec
        return doneRes
      }
      return { status: 'step_verified', skill_id: id, task_id: taskId, instance_id: inst.instance_id, step: step.id, verified: outcome?.status ?? null, detail, action: actionRec }
    }

    // ISSUE-02 / Phase 4: 结果未知、超时或 unverified（且快照尚未观察到完成证据）：进入 awaiting_reconciliation，严禁直接作为普通失败或重新发送动作
    const needsReconciliation = outcome?.status === 'unknown' || outcome?.reason === 'result_timeout' || outcome?.status === 'unverified'
    if (needsReconciliation) {
      const snap = this.#snapshot()
      inst.status = 'awaiting_reconciliation'
      inst.reconciliation = {
        command_id: outcome?.commandId ?? null,
        tool: plan.tool,
        args: plan.args,
        task_id: taskId,
        instance_id: inst.instance_id,
        step_id: step.id,
        issued_at: this.now(),
        last_reconcile_at: this.now(),
        reconcile_attempts: 0,
        original_result_status: outcome?.status ?? 'unknown',
        original_reason: outcome?.reason ?? null,
        before_snapshot_id: snap?.observer?.snapshot_id ?? null,
        before_snapshot_sequence: snap?.observer?.sequence ?? null,
      }
      inst.blocked_reason = `awaiting_reconciliation:${step.id}:${outcome?.commandId ?? 'unknown'}`
      inst.updated_at = this.now()
      this.#log('ACTION_UNKNOWN', {
        skill_id: id,
        task_id: taskId,
        instance_id: inst.instance_id,
        step_id: step.id,
        command_id: outcome?.commandId ?? null,
        tool: plan.tool,
        reason: outcome?.reason ?? outcome?.status ?? 'unknown',
      })
      this.#save()
      const actionRec = {
        tool: plan.tool,
        args: plan.args,
        command_id: outcome?.commandId ?? null,
        status: outcome?.status ?? 'unknown',
        reason: outcome?.reason ?? outcome?.status ?? 'unknown',
        verified: false,
      }
      return {
        status: 'awaiting_reconciliation',
        skill_id: id,
        task_id: taskId,
        instance_id: inst.instance_id,
        step: step.id,
        reason: 'awaiting_reconciliation',
        detail: outcome?.status === 'unverified'
          ? `动作已执行但快照核验未通过（unverified: ${outcome?.reason ?? 'verify_failed'}），已进入对账状态等待新鲜快照确认`
          : `动作下发后结果未知（${outcome?.reason ?? 'unknown'}），已进入对账状态，防止重复执行`,
        action: actionRec,
      }
    }

    // 没验证通过：区分"明确失败"与"已下发但还没生效（继续）"
    const hardFail = outcome?.status === 'rejected' || outcome?.status === 'failed'
    if (hardFail) {
      if (plan.target_id) {
        if (!inst.data) inst.data = {}
        if (!inst.data.food_failures) inst.data.food_failures = {}
        recordTargetFailure(inst.data.food_failures, plan.target_id, outcome?.reason ?? 'action_failed', this.now())
      }
      // Reflex 抢占（ISSUE-05）：Lua 保命反射正在逃跑或接管，暂停当前技能保留进度，不计入失败重试
      if (outcome?.reason === 'reflex_active') {
        inst.status = 'paused'
        inst.paused_reason = 'reflex_active'
        inst.blocked_reason = 'reflex_active'
        inst.updated_at = this.now()
        if (this.memory.active_skill_instance_id === inst.instance_id) this.memory.active_skill_instance_id = null
        if (this.memory.active_skill_id === id) this.memory.active_skill_id = null
        this.#log(LOG.PAUSED, {
          skill_id: id,
          task_id: taskId,
          instance_id: inst.instance_id,
          step_id: step.id,
          status: 'paused',
          reason: 'reflex_active',
        })
        this.#save()
        return {
          status: 'reflex_active',
          skill_id: id,
          task_id: taskId,
          instance_id: inst.instance_id,
          step: step.id,
          reason: 'reflex_active',
          detail: '保命反射（Reflex）正在接管中，技能已暂停保留进度',
          action: {
            tool: plan.tool,
            args: plan.args,
            command_id: outcome?.commandId ?? null,
            status: outcome?.status ?? 'rejected',
            reason: 'reflex_active',
            verified: false,
          },
        }
      }
      // 位置问题（out_of_range）：不是技能失败。解析回执里的真实坐标，下一步先走过去。
      if (outcome?.reason === 'out_of_range') {
        const c = parseCoords(outcome?.message)
        if (c) {
          if (!inst.data) inst.data = {}
          inst.data.approach = c
          this.#save()
          return {
            status: 'step_in_progress',
            skill_id: id,
            task_id: taskId,
            instance_id: inst.instance_id,
            step: step.id,
            reason: 'approaching',
            detail: `目标太远，先去 (${c.x},${c.z}) 再动手`,
            action: { tool: plan.tool, args: plan.args, command_id: outcome?.commandId ?? null, status: outcome?.status ?? 'rejected', verified: false },
          }
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
      const actionRec = {
        tool: plan.tool,
        args: plan.args,
        command_id: outcome?.commandId ?? null,
        status: outcome?.status ?? 'failed',
        verified: false,
      }
      if (exhausted) {
        inst.status = 'failed'
        inst.failed_at = this.now()
        inst.blocked_reason = `step_failed:${step.id}:${outcome?.reason ?? 'failed'}`
        if (this.memory.active_skill_instance_id === inst.instance_id) this.memory.active_skill_instance_id = null
        if (this.memory.active_skill_id === id) this.memory.active_skill_id = null
        this.#save()
        return { status: 'failed', skill_id: id, task_id: taskId, instance_id: inst.instance_id, step: step.id, reason: outcome?.reason ?? 'failed', detail, action: actionRec }
      }
      this.#save()
      return { status: 'step_in_progress', skill_id: id, task_id: taskId, instance_id: inst.instance_id, step: step.id, reason: outcome?.reason ?? null, detail, action: actionRec }
    }

    // ok 已下发但还没核对上（例如走位/建造需要下一帧）：继续，由预算兜底
    this.#save()
    const actionRec = {
      tool: plan.tool,
      args: plan.args,
      command_id: outcome?.commandId ?? null,
      status: outcome?.status ?? 'in_progress',
      verified: Boolean(outcome?.verified),
    }
    return { status: 'step_in_progress', skill_id: id, task_id: taskId, instance_id: inst.instance_id, step: step.id, detail, action: actionRec }
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
          return ev.done === true
        } catch {
          return false
        }
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
