// 任务看板（Task Board）：中期任务的显式状态机。
//
// 解决的老问题（见 docs/ARCHITECTURE_ANALYSIS.md）：
//   · plan.js 是一维优先级，没有"任务状态/依赖"，于是材料齐了就在脚下建机器；
//   · 失败后反复给同一句建议，没有 attempts / 冷却 / 换方案；
//   · 每轮重新规划，做完一个不知道下一步，长期任务一重启就丢。
//
// 设计（对齐任务书 §三，按本项目实际裁剪，不引入无用字段）：
//   · 任务结构：id/title/stage/priority/depends_on/target/attempts/status/progress/blocked_reason/search_budget。
//   · 依赖 DAG：依赖没 done → 任务 blocked，**优先级不能绕过依赖**。
//   · 完成必须有证据：由 evaluateTarget() 从快照+记忆算，绝不看"模型说做完了"。
//   · 失败有上限+冷却：attempts 到上限 → failed；否则 cooldown 期间不再调度。
//   · 合并保活：刷新看板时保留未完成的有效任务（attempts/progress 不丢）。
//
// 本文件是**纯逻辑**：不碰文件、不碰游戏；持久化由 world-memory.js 负责。

import { countInInventory, handItem, inventoryItems } from '../actions/state-query.js'
import { matchStructure } from './prefab-utils.js'
import { edibleCount } from '../skills/skill-utils.js'

export const BOARD_SCHEMA = 'bws.task-board/1'
export const MAX_TASKS = 8
export const MAX_ATTEMPTS = 4
/** 失败后默认冷却（毫秒）；指数退避：base * 2^(attempts-1) */
export const BASE_COOLDOWN_MS = 20_000

export const TERMINAL_STATUS = new Set(['done', 'completed', 'failed', 'cancelled'])
export const ACTIVE_STATUS = new Set(['pending', 'ready', 'in_progress', 'blocked', 'scheduled'])

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/

const nowMs = () => Date.now()

// ─────────────────────────── 快照读取小工具（只读） ───────────────────────────

function bucketItems(snapshot, key) {
  const buckets = snapshot?.nearby?.buckets
  if (!buckets) return []
  if (Array.isArray(buckets)) return buckets.find((g) => g?.kind === key)?.items ?? []
  const list = buckets[key]
  return Array.isArray(list) ? list : Object.values(list ?? {})
}

function itemsOfPos(snapshot, key, predicate = () => true) {
  const out = []
  for (const item of bucketItems(snapshot, key)) {
    if (!predicate(item)) continue
    const pos = item?.position ?? (item?.x !== undefined ? { x: item.x, z: item.z } : null)
    out.push({ item, pos: pos && typeof pos.x === 'number' && typeof pos.z === 'number' ? pos : null })
  }
  return out
}

/** 背包 + 手上 + 身上（body/head）某 prefab 的总数 —— 用于"装备好了没有"的证据 */
export function ownedCount(snapshot, prefab) {
  let n = countInInventory(snapshot, prefab)
  const eq = snapshot?.player?.equipment
  const slots = eq?.slots
  // 去重：observe 的 equipment 同时有 slots 与 worn，同一件装备会在两边都有。
  // 有 slots 就只按槽位统计一次（含 hands/head/body）；没有 slots 才退回 worn / handItem。
  if (slots && typeof slots === 'object') {
    for (const v of Object.values(slots)) {
      const p = typeof v === 'string' ? v : (v?.prefab ?? v?.item ?? null)
      if (p === prefab) n += 1
    }
  } else if (Array.isArray(eq?.worn)) {
    for (const entry of eq.worn) {
      const p = entry?.item?.prefab ?? entry?.item ?? null
      if (p === prefab) n += 1
    }
  } else if (handItem(snapshot) === prefab) {
    n += 1
  }
  return n
}

// ─────────────────────────── 目标核对（完成证据） ───────────────────────────

/**
 * 判断一个任务的 target 在当前快照/记忆下完成到什么程度。
 * 返回 { current, required, done, known, reason }：
 *   · known=false 表示"读不到判定所需数据"，任务应 blocked，不能假装完成也不能假装失败。
 * 支持的 target.type（够覆盖阶段 0..6 的实际需要）：
 *   inventory / have_tool / structure / placement_structure / camp_site / home / move_to / explored / custom
 */
export function evaluateTarget(target, snapshot, memory = {}) {
  const t = target ?? {}
  if (!t.type) {
    return { current: 0, required: 1, done: false, known: true }
  }
  switch (t.type) {
    case 'inventory': {
      const need = Math.max(1, Number(t.count ?? 1))
      const have = ownedCount(snapshot, String(t.prefab ?? ''))
      return { current: Math.min(have, need), required: need, done: have >= need, known: true }
    }
    case 'edible':
    case 'food': {
      const need = Math.max(1, Number(t.count ?? 1))
      const have = edibleCount(snapshot)
      return { current: Math.min(have, need), required: need, done: have >= need, known: true }
    }
    case 'have_tool': {
      const have = ownedCount(snapshot, String(t.prefab ?? ''))
      return { current: Math.min(have, 1), required: 1, done: have >= 1, known: true }
    }
    case 'structure': {
      const prefab = String(t.prefab ?? '')
      const near = t.near ?? null
      const hits = itemsOfPos(snapshot, 'structures', (it) => matchStructure(it, prefab))
      let matched = hits
      let outsideRadius = false
      if (near && typeof near.x === 'number' && typeof near.z === 'number') {
        const radius = Number(near.radius ?? 10)
        matched = hits.filter(({ pos }) => pos && Math.hypot(pos.x - near.x, pos.z - near.z) <= radius)
        if (hits.length > 0 && matched.length === 0) {
          outsideRadius = true
        }
      }
      // 记忆里"已验证存在"的同类建筑也算（离开视野不重复建；见 known_buildings）
      // 必须严格校验坐标：若指定了营地范围，位置必须在营地半径内，缺少坐标或超出半径的记录不能算完成
      const knownBuilding = (memory?.known_buildings ?? []).find((b) => {
        if (!matchStructure(b, prefab)) return false
        if (!near || typeof near.x !== 'number' || typeof near.z !== 'number') return true
        if (typeof b.x !== 'number' || typeof b.z !== 'number') return false
        return Math.hypot(b.x - near.x, b.z - near.z) <= Number(near.radius ?? 10)
      })
      const done = matched.length > 0 || Boolean(knownBuilding)
      const reason = done ? undefined : (outsideRadius ? 'structure_outside_camp_radius' : undefined)
      return { current: done ? 1 : 0, required: 1, done, known: true, ...(reason ? { reason } : {}) }
    }
    case 'camp_site': {
      const has = Boolean(memory?.camp_site && typeof memory.camp_site.x === 'number')
      return { current: has ? 1 : 0, required: 1, done: has, known: true }
    }
    case 'home': {
      const has = typeof memory?.home_building_id === 'string' && memory.home_building_id !== ''
      return { current: has ? 1 : 0, required: 1, done: has, known: true }
    }
    case 'move_to': {
      const a = snapshot?.actor
      if (!a || typeof a.tileX !== 'number' || typeof a.tileZ !== 'number') {
        return { current: 0, required: 1, done: false, known: false, reason: 'no_position' }
      }
      const radius = Number(t.arrival_radius ?? 2)
      const dist = Math.hypot(a.tileX - Number(t.x), a.tileZ - Number(t.z))
      const done = dist <= radius
      return { current: done ? 1 : 0, required: 1, done, known: true, distance: dist }
    }
    case 'explored': {
      // 由观察写入的记忆标记（planner-core 在真实走出一段后写 explored_regions）
      const done = Boolean(memory?.explored_regions?.[t.region_id]) || (memory?.explored_region_count ?? 0) >= Number(t.count ?? 1)
      return { current: done ? 1 : 0, required: 1, done, known: true }
    }
    case 'quest_complete': {
      const qid = String(t.quest_id ?? '')
      const questDone = Boolean(
        snapshot?.quest_guide?.done_tasks?.[qid] ||
        (snapshot?.quest_guide?.tracked_task?.id === qid && snapshot?.quest_guide?.tracked_task?.done)
      )
      if (questDone) {
        return { current: 1, required: 1, done: true, known: true }
      }
      if (t.fallback_prefab) {
        const have = ownedCount(snapshot, String(t.fallback_prefab))
        const need = Math.max(1, Number(t.count ?? 1))
        if (have >= need) {
          return { current: Math.min(have, need), required: need, done: true, known: true }
        }
        const hits = itemsOfPos(snapshot, 'structures', (it) => matchStructure(it, String(t.fallback_prefab)))
        const known = (memory?.known_buildings ?? []).some((b) => matchStructure(b, String(t.fallback_prefab)))
        if (hits.length > 0 || known) {
          return { current: 1, required: 1, done: true, known: true }
        }
      }
      return { current: 0, required: 1, done: false, known: true }
    }
    case 'custom': {
      // 由外部 evaluator 覆盖；这里默认未知
      return { current: 0, required: 1, done: false, known: false, reason: 'no_evaluator' }
    }
    default:
      return { current: 0, required: 1, done: false, known: false, reason: `unsupported_target:${t.type}` }
  }
}

// ─────────────────────────── 校验 ───────────────────────────

export function normalizeTask(task) {
  const t = { ...task }
  t.id = String(t.id ?? '')
  t.title = String(t.title ?? t.id ?? '')
  t.stage = t.stage ?? 'general'
  t.priority = Number.isInteger(t.priority) ? t.priority : 3
  t.status = t.status ?? 'pending'
  t.depends_on = Array.isArray(t.depends_on) ? [...new Set(t.depends_on.map(String))] : []
  t.target = t.target && typeof t.target === 'object' ? t.target : {}
  t.attempts = Number.isInteger(t.attempts) ? t.attempts : 0
  t.cooldown_until = Number(t.cooldown_until ?? 0)
  t.progress = t.progress && typeof t.progress === 'object' ? t.progress : { current: 0, required: 1 }
  t.blocked_reason = t.blocked_reason ?? null
  t.blocked_kind = t.blocked_kind ?? null
  t.failure_history = Array.isArray(t.failure_history) ? t.failure_history : []
  t.search_budget = t.search_budget && typeof t.search_budget === 'object' ? t.search_budget : null
  t.skill_id = typeof t.skill_id === 'string' ? t.skill_id : null
  t.skill_args = t.skill_args && typeof t.skill_args === 'object' ? t.skill_args : null
  t.completion_evidence = t.completion_evidence && typeof t.completion_evidence === 'object' ? t.completion_evidence : null
  t.created_at = Number(t.created_at ?? 0)
  t.updated_at = Number(t.updated_at ?? 0)
  return t
}

/** 校验一份看板；不合法抛 Error（调用方应捕获并保留上一份有效看板）。 */
export function validateBoard(board) {
  const tasks = board?.tasks
  if (!Array.isArray(tasks)) throw new Error('board.tasks 必须是数组')
  if (tasks.length > MAX_TASKS) throw new Error(`看板最多 ${MAX_TASKS} 个任务`)
  const byId = new Map()
  const out = []
  for (const raw of tasks) {
    const t = normalizeTask(raw)
    if (!ID_RE.test(t.id)) throw new Error(`非法任务 id：${t.id}`)
    if (byId.has(t.id)) throw new Error(`重复任务 id：${t.id}`)
    if (!(t.priority >= 1 && t.priority <= 5)) throw new Error(`任务优先级必须是 1-5：${t.id}`)
    for (const dep of t.depends_on) {
      if (!ID_RE.test(dep)) throw new Error(`依赖 id 非法：${dep}`)
    }
    byId.set(t.id, t)
    out.push(t)
  }
  // 依赖必须指向存在任务 + 无环
  const visiting = new Set()
  const visited = new Set()
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`任务依赖有环：${id}`)
    if (visited.has(id)) return
    const t = byId.get(id)
    if (!t) throw new Error(`依赖了不存在的任务：${id}`)
    visiting.add(id)
    for (const dep of t.depends_on) {
      if (!byId.has(dep)) throw new Error(`任务 ${id} 依赖了不存在的任务 ${dep}`)
      visit(dep)
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const t of out) visit(t.id)
  return { schema: BOARD_SCHEMA, goal: String(board?.goal ?? ''), tasks: out }
}

// ─────────────────────────── 状态推进 ───────────────────────────

/**
 * 重新评估整张看板：算进度、依赖放行、冷却、失败上限。返回新的不可变看板。
 * @param {object} board  validateBoard 的结果
 * @param {{snapshot:object, memory:object, evaluator?:Function, now?:number}} ctx
 */
export function evaluateBoard(board, ctx = {}) {
  const snapshot = ctx.snapshot ?? null
  const memory = ctx.memory ?? {}
  const now = Number.isFinite(ctx.now) ? ctx.now : nowMs()
  const evaluator = typeof ctx.evaluator === 'function' ? ctx.evaluator : null

  const tasks = (board?.tasks ?? []).map((raw) => {
    const t = normalizeTask(raw)
    // 已终态的任务不再重算（done/failed/cancelled 是锁存的）
    // 例外：因“控制权/租约”等**基础设施瞬时原因**失败的，允许重新排队——
    // 否则一次租约抖动（control_denied / lease_expired）会把任务永久判死，角色再也不动。
    if (TERMINAL_STATUS.has(t.status)) {
      const transient = t.status === 'failed'
        && /control_denied|lease_expired|runtime_cancelled|aborted/i.test(String(t.blocked_reason ?? ''))
      if (transient) {
        t.status = 'ready'
        t.attempts = 0
        t.blocked_reason = null
        t.blocked_kind = null
        t.cooldown_until = 0
        t.updated_at = now
      } else {
        return t
      }
    }

    let result
    try {
      result = evaluator ? (evaluator(t, snapshot, memory) ?? evaluateTarget(t.target, snapshot, memory))
        : evaluateTarget(t.target, snapshot, memory)
    } catch (error) {
      result = { current: 0, required: 1, done: false, known: false, reason: `evaluator_error:${error?.message ?? error}` }
    }
    const { current = 0, required = 1, done = false, known = true, reason = null } = result ?? {}
    t.progress = { current, required }

    if (done) {
      t.status = 'done'
      t.blocked_reason = null
      t.blocked_kind = null
      t.updated_at = now
      return t
    }
    if (t.attempts >= MAX_ATTEMPTS) {
      t.status = 'failed'
      t.blocked_kind = 'attempts_exhausted'
      t.blocked_reason = t.blocked_reason ?? 'attempts_exhausted'
      t.updated_at = now
      return t
    }
    if (!known) {
      t.status = 'blocked'
      t.blocked_kind = 'external_condition'
      t.blocked_reason = reason ?? 'telemetry_unavailable'
      t.updated_at = now
      return t
    }
    if (t.cooldown_until > now) {
      t.status = 'blocked'
      // 保留真实的阻塞类型（resource_missing / path_unreachable…），不要一律标成 cooldown，
      // 否则排查时看不出到底为什么卡住；只有原本没有类型时才写 cooldown。
      t.blocked_kind = t.blocked_kind && t.blocked_kind !== 'cooldown' ? t.blocked_kind : 'cooldown'
      t.blocked_reason = `cooldown:${Math.ceil((t.cooldown_until - now) / 1000)}s`
      t.updated_at = now
      return t
    }
    // 检查是否曾因前置条件未满足而 blocked
    if (raw.status === 'blocked' && raw.blocked_kind === 'precondition') {
      const checkPre = typeof ctx.checkPreconditions === 'function' ? ctx.checkPreconditions(t) : null
      if (checkPre === false) {
        t.status = 'blocked'
        t.blocked_kind = 'precondition'
        t.blocked_reason = raw.blocked_reason
        t.updated_at = now
        return t
      }
    }
    // 如果外部条件仍受阻
    if (result && result.blocked) {
      t.status = 'blocked'
      t.blocked_kind = result.blocked_kind || 'external_condition'
      t.blocked_reason = result.reason || 'condition_unmet'
      t.updated_at = now
      return t
    }
    // ★ 关键修复（Phase R.7.4）：只要是 blocked 状态，就必须有**明确的恢复条件**才允许重新变 ready。
    //   之前这里只在 `raw.blocked_kind` 存在时才保留 blocked —— 于是"只写 blocked_reason、没写
    //   blocked_kind"的任务会被下面那句无条件重置成 ready，形成 ready→执行→blocked→ready 无限横跳。
    //   现在：
    //     · dependency —— 交给下面的依赖放行段统一处理（依赖满足后自然变 ready）；
    //     · unknown_outcome / cancelled —— 必须人工核实/处理，绝不自动恢复；
    //     · 其它类型 —— 只有「退避计时到点」或「显式 resolved / checkPreconditions 通过」才恢复。
    if (raw.status === 'blocked') {
      const kind = raw.blocked_kind ?? 'external_condition'
      if (kind === 'dependency') {
        // 交给依赖段处理
      } else if (kind === 'unknown_outcome' || kind === 'cancelled') {
        t.status = 'blocked'
        t.blocked_kind = kind
        t.blocked_reason = raw.blocked_reason ?? kind
        t.updated_at = now
        return t
      } else {
        const timerExpired = Number.isFinite(raw.cooldown_until) && raw.cooldown_until > 0 && raw.cooldown_until <= now
        const resolved = (ctx.resolvedBlockedTaskIds && ctx.resolvedBlockedTaskIds.includes(t.id))
          || (typeof ctx.checkPreconditions === 'function' && ctx.checkPreconditions(t) === true)
        if (!(timerExpired || resolved)) {
          t.status = 'blocked'
          t.blocked_kind = kind
          t.blocked_reason = raw.blocked_reason ?? 'blocked'
          t.updated_at = now
          return t
        }
      }
    }
    t.status = current > 0 ? 'in_progress' : 'ready'
    t.blocked_reason = null
    t.blocked_kind = null
    t.updated_at = now
    return t
  })

  // 依赖放行：依赖没 done/completed → 任务 blocked（优先级不能绕过依赖）
  const byId = new Map(tasks.map((t) => [t.id, t]))
  for (const t of tasks) {
    if (TERMINAL_STATUS.has(t.status)) continue
    const waiting = t.depends_on.filter((dep) => {
      const s = byId.get(dep)?.status
      return s !== 'done' && s !== 'completed'
    })
    if (waiting.length > 0 && t.status !== 'blocked') {
      t.status = 'blocked'
      t.blocked_kind = 'dependency'
      t.blocked_reason = `dependencies:${waiting.join(',')}`
    }
  }

  const ready_task_ids = tasks
    .filter((t) => t.status === 'ready' || t.status === 'in_progress' || t.status === 'pending')
    .sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)))
    .map((t) => t.id)

  return { schema: BOARD_SCHEMA, goal: String(board?.goal ?? ''), tasks, ready_task_ids }
}

/** 选出下一个该做的任务（最高优先级 ready/in_progress/pending）。没有返回 null。 */
export function pickNextTask(board) {
  const tasks = board?.tasks ?? []
  const ready = tasks
    .filter((t) => t.status === 'ready' || t.status === 'in_progress' || t.status === 'pending')
    .sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)))
  return ready[0] ?? null
}

/**
 * 记一次失败：attempts+1，指数退避冷却；到上限则置为 failed。
 * 返回更新后的任务（原地修改不可变副本）。
 */
export function registerFailure(board, taskId, reason, { now = nowMs(), baseCooldownMs = BASE_COOLDOWN_MS } = {}) {
  const tasks = (board?.tasks ?? []).map((raw) => {
    const t = normalizeTask(raw)
    if (t.id !== taskId) return t
    t.attempts += 1
    const r = String(reason ?? 'failed')
    t.failure_history = [...t.failure_history, { attempt: t.attempts, reason: r, at: now }]
    if (t.attempts >= MAX_ATTEMPTS) {
      t.status = 'failed'
      t.blocked_kind = 'attempts_exhausted'
      t.blocked_reason = r
    } else {
      t.status = 'blocked'
      t.blocked_kind = 'cooldown'
      t.cooldown_until = now + baseCooldownMs * 2 ** (t.attempts - 1)
      t.blocked_reason = `retry_cooldown:${Math.ceil((t.cooldown_until - now) / 1000)}s`
    }
    t.updated_at = now
    return t
  })
  return { ...board, tasks }
}

/**
 * 统一的 blocked 写入入口：所有把任务置为 blocked 的路径都必须走这里。
 * ★ 为什么必须统一：以前经常只写 `task.status='blocked'; task.blocked_reason=...`，
 *   却没有 `blocked_kind`。evaluateBoard 见到"有 reason 没 kind"会把它当成普通未完成，
 *   下一轮又重置成 ready —— 形成 ready → 执行 → blocked → ready 的无限横跳。
 *
 * @param {object} board
 * @param {string} taskId
 * @param {{kind?:string, reason?:string, retryAfterMs?:number|null, now?:number, baseCooldownMs?:number}} [opts]
 *   retryAfterMs 为数字时，按"软阻塞"处理：attempts+1、写入指数退避 cooldown_until；
 *   attempts 达到 MAX_ATTEMPTS 后升级为 failed（终态）。这样既不会无限重试，也不会永久卡死。
 */
export function blockTask(board, taskId, { kind = 'external_condition', reason = 'blocked', retryAfterMs = null, now = nowMs(), baseCooldownMs = BASE_COOLDOWN_MS } = {}) {
  const tasks = (board?.tasks ?? []).map((raw) => {
    const t = normalizeTask(raw)
    if (t.id !== taskId) return t
    t.blocked_kind = kind
    t.blocked_reason = String(reason ?? 'blocked')
    t.updated_at = now
    if (retryAfterMs !== null && retryAfterMs !== undefined && Number.isFinite(Number(retryAfterMs))) {
      t.attempts += 1
      t.failure_history = [...t.failure_history, { attempt: t.attempts, reason: t.blocked_reason, kind, at: now }]
      if (t.attempts >= MAX_ATTEMPTS) {
        t.status = 'failed'
        t.blocked_kind = 'attempts_exhausted'
        t.blocked_reason = t.blocked_reason || 'attempts_exhausted'
      } else {
        t.status = 'blocked'
        t.cooldown_until = now + baseCooldownMs * 2 ** (t.attempts - 1)
      }
    } else {
      t.status = 'blocked'
    }
    return t
  })
  return { ...board, tasks }
}

/** 记一次成功（由外部证据确认后调用）。 */
export function markDone(board, taskId, { now = nowMs(), status = 'done', completionEvidence = null } = {}) {
  const tasks = (board?.tasks ?? []).map((raw) => {
    const t = normalizeTask(raw)
    if (t.id !== taskId) return t
    t.status = status
    t.completed_at = now
    if (completionEvidence) t.completion_evidence = completionEvidence
    t.blocked_reason = null
    t.progress = { current: t.progress?.required ?? 1, required: t.progress?.required ?? 1 }
    t.updated_at = now
    return t
  })
  return { ...board, tasks }
}

/**
 * 合并看板：保留旧看板里**未完成的有效任务**（attempts/进度不丢），补进新任务。
 * 新任务里若与旧任务同 id，则用旧任务的运行时字段（attempts/cooldown/status）覆盖新的默认值，
 * 只允许新任务更新标题/目标/优先级（规划层面）。
 * 终态任务保留（作为完成记录），但超出上限时优先丢最老的终态任务。
 */
export function mergeBoard(prevBoard, nextTasks, { goal = null, now = nowMs(), snapshot = null, memory = null } = {}) {
  const prev = (prevBoard?.tasks ?? []).map(normalizeTask)
  const prevById = new Map(prev.map((t) => [t.id, t]))
  const merged = []
  const seen = new Set()

  for (const raw of nextTasks ?? []) {
    const nt = normalizeTask(raw)
    seen.add(nt.id)
    const old = prevById.get(nt.id)
    if (old && !TERMINAL_STATUS.has(old.status)) {
      // 保活：运行时状态以旧为准，规划字段以新为准
      merged.push({
        ...nt,
        attempts: old.attempts,
        cooldown_until: old.cooldown_until,
        status: old.status === 'in_progress' ? 'in_progress' : old.status,
        progress: old.progress,
        blocked_reason: old.blocked_reason,
        blocked_kind: old.blocked_kind,
        failure_history: old.failure_history,
        created_at: old.created_at || now,
        updated_at: now,
      })
    } else if (old && TERMINAL_STATUS.has(old.status)) {
      // 检查旧终态是否依然有效。如果规划重新给出了新目标，且新目标尚未完成，则允许重置为 ready
      let isStillDone = true

      // 1. 如果有快照，以快照的客观事实核对
      if (snapshot) {
        if (nt.target?.type === 'quest_complete') {
          const qid = String(nt.target.quest_id ?? '')
          const questDone = Boolean(
            snapshot.quest_guide?.done_tasks?.[qid] ||
            (snapshot.quest_guide?.tracked_task?.id === qid && snapshot.quest_guide?.tracked_task?.done)
          )
          if (!questDone) {
            if (nt.target.fallback_prefab) {
              const have = ownedCount(snapshot, String(nt.target.fallback_prefab))
              const need = Math.max(1, Number(nt.target.count ?? 1))
              if (have < need) isStillDone = false
            } else {
              isStillDone = false
            }
          }
        } else if (nt.target?.type === 'inventory') {
          const have = ownedCount(snapshot, String(nt.target.prefab))
          const need = Math.max(1, Number(nt.target.count ?? 1))
          if (have < need) isStillDone = false
        }
      }

      // 2. 规划若变更了制作目标配方，或提高了所需数量，旧完成状态作废
      if (nt.target?.fallback_prefab && old.target?.fallback_prefab && nt.target.fallback_prefab !== old.target.fallback_prefab) {
        isStillDone = false
      }
      if (Number(nt.target?.count ?? 0) > Number(old.target?.count ?? 0)) {
        isStillDone = false
      }

      if (isStillDone) {
        merged.push({ ...old })
      } else {
        merged.push({
          ...nt,
          status: 'ready',
          attempts: 0,
          cooldown_until: 0,
          created_at: old.created_at || now,
          updated_at: now,
        })
      }
    } else {
      merged.push({ ...nt, created_at: nt.created_at || now, updated_at: now })
    }
  }

  // 保留旧看板里、这次规划没提到但**仍未完成**的任务（不能被模型悄悄删掉）
  for (const old of prev) {
    if (seen.has(old.id)) continue
    if (TERMINAL_STATUS.has(old.status)) continue
    merged.push({ ...old, updated_at: now })
  }

  // 上限：先丢最老的终态任务，再按优先级截断活跃任务
  let out = merged
  if (out.length > MAX_TASKS) {
    const terminal = out.filter((t) => TERMINAL_STATUS.has(t.status))
      .sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0))
    const active = out.filter((t) => !TERMINAL_STATUS.has(t.status))
      .sort((a, b) => a.priority - b.priority)
    const keepTerminalCount = Math.max(0, MAX_TASKS - active.length)
    const kept = [...active, ...terminal.slice(Math.max(0, terminal.length - keepTerminalCount))]
    out = kept.slice(0, MAX_TASKS)
  }

  return {
    schema: BOARD_SCHEMA,
    goal: goal ?? prevBoard?.goal ?? '',
    tasks: out,
    ready_task_ids: [],
  }
}

/** 活跃（未终态）任务 */
export function activeTasks(board) {
  return (board?.tasks ?? []).filter((t) => !TERMINAL_STATUS.has(t.status))
}

/** 依赖闭包里还差哪些没 done（调试/渲染用） */
export function pendingDependencies(board, taskId) {
  const byId = new Map((board?.tasks ?? []).map((t) => [t.id, t]))
  const t = byId.get(taskId)
  if (!t) return []
  return t.depends_on.filter((dep) => byId.get(dep)?.status !== 'done')
}
