// 统一决策仲裁器（Decision Arbiter）—— 全系统**唯一**的「下一步」出口。
//
// 职责：把 derivePlan()（生存规则引擎）与 planner.plan()（阶段/任务看板/家园）合并裁决为单一 decision。
//   以前 get_state 同时渲染两套计划，各自判断、互不裁决；现在统一由此模块产出唯一决策。
//   「该做什么」。本模块把两个来源收敇成**一个 decision 对象**：
//
//     生存(P0/P1)  → 用 plan.js 的生存规则给下一步（保命规则全部保留，不丢能力）
//     发展(P2/P3)  → 用 planner-core 的任务看板选唯一任务 + nextHint
//     空闲/兜底(P3/P4) → 用 plan.js 的规则引擎（覆盖开局生存、存粮、探索）
//
// 边界：**纯逻辑，不下发任何动作、不写盘**（记忆持久化由 planner-core / world-memory 负责）。
// Reflex 仍在 Lua 端独立抢占动作；本模块只调整长期任务调度并给出下一步提示，不复制 Reflex。

import { survivalLevel } from './survival-priority.js'
import { getStage } from './development-stages.js'

/** 任务 id → 技能 id（任务与技能同批；建家链归 establish_home，采集归 gather_resources）。 */
const TASK_SKILL = {
  choose_camp_site: 'establish_home',
  travel_to_camp: 'establish_home',
  travel_to_backup: 'establish_home',
  build_first_structure: 'establish_home',
  set_home: 'establish_home',
}

function skillForTask(task) {
  if (!task) return null
  if (task.skill_id) {
    return { id: task.skill_id, phase: task.id, ...(task.skill_args ? { args: task.skill_args } : {}) }
  }
  const id = String(task.id ?? '')
  if (TASK_SKILL[id]) return { id: TASK_SKILL[id], phase: id }
  if (id.startsWith('food_') || id.startsWith('cook_') || id === 'stock_food') return { id: 'food_production', phase: id }
  if (id.startsWith('gather_')) return { id: 'gather_resources', phase: id }
  if (id.startsWith('build_')) return { id: 'craft_or_build', phase: id }
  if (id.startsWith('gear_')) return { id: 'craft_or_build', phase: id }
  return { id, phase: 'step' }
}

/** 生存规则引擎的 goalId → 技能 id（保命统一归 survival_stabilize，食物储备归 food_production）。 */
const SURVIVAL_GOALS = new Set([
  'revive', 'retreat', 'light', 'eat', 'sanity', 'heal', 'prep_light',
  'tool_axe', 'tool_pickaxe',
])

function skillForGoal(goalId) {
  if (!goalId) return null
  if (goalId === 'stock_food') return { id: 'food_production', phase: 'gather_ingredients' }
  if (SURVIVAL_GOALS.has(goalId)) return { id: 'survival_stabilize', phase: goalId }
  return { id: String(goalId), phase: 'step' }
}

const PRIORITY_LABEL = { 0: 'P0', 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4' }

/** 把任务的 target 翻译成一句「完成条件」，给模型一个可核对的验收标准。 */
export function completionForTask(task) {
  const t = task?.target ?? {}
  switch (t.type) {
    case 'camp_site':
      return '选定营地（主选 + 备选）并写入世界记忆'
    case 'move_to':
      return `到达 (${t.x},${t.z}) 附近（≤${t.arrival_radius ?? 2} 格）`
    case 'inventory':
      return `背包里 ${t.prefab} 达到 ${t.count}`
    case 'have_tool':
      return `拥有 ${t.prefab}`
    case 'structure':
      return `视野/记忆里真实出现 ${t.prefab} 建筑`
        + (t.near && typeof t.near.x === 'number' ? `（营地 (${t.near.x},${t.near.z}) 半径 ${t.near.radius ?? 10} 内）` : '')
    case 'home':
      return '核心建筑真实出现并登记 home_building_id'
    default:
      return task?.title ?? '任务目标达成'
  }
}

/**
 * 统一决策出口。
 * @param {object} snapshot 归一化快照
 * @param {{devPlan?:object|null, survivalPlan?:object|null}} src
 *   devPlan      planner-core.plan() 的结果（阶段 / 看板 / nextTask / next / memory）
 *   survivalPlan plan.js derivePlan() 的结果（生存规则引擎：title / why / next / goalId）
 * @returns {object} 唯一 decision
 */
export function arbitrate(snapshot, { devPlan = null, survivalPlan = null } = {}) {
  const survival = survivalLevel(snapshot)
  const isQuestGuideActive = Boolean(
    devPlan?.isQuestGuideActive ||
    (snapshot?.quest_guide?.installed && (snapshot.quest_guide.tracked_task || (Array.isArray(snapshot.quest_guide.open_tasks) && snapshot.quest_guide.open_tasks.length > 0)))
  )
  const stage = devPlan?.stage ?? getStage(devPlan?.stageIndex ?? 0)
  const board = devPlan?.board ?? null
  const nextTask = devPlan?.nextTask ?? null
  const blocked = (board?.tasks ?? [])
    .filter((t) => t.status === 'blocked')
    .map((t) => ({ id: t.id, reason: t.blocked_reason ?? 'blocked' }))

  const primaryGoal = isQuestGuideActive
    ? (board?.goal || '任务手册自主追踪')
    : stage.goal

  const base = {
    world_key: devPlan?.worldKey ?? snapshot?.identity?.worldKey ?? null,
    is_quest_guide_active: isQuestGuideActive,
    current_stage: isQuestGuideActive
      ? { index: 'QG', id: 'quest_guide', title: '任务手册自主追踪' }
      : { index: stage.index, id: stage.id, title: stage.title },
    primary_goal: primaryGoal,
    current_task: null,
    current_skill: null,
    task_progress: null,
    next_action: '',
    decision_reason: '',
    priority: 'P4',
    blocked_tasks: blocked,
    completion: null,
    goal_title: null,
  }

  // ① P0/P1：生存压倒一切（Reflex 在 Lua 端可独立抢占；这里只调整调度并给下一步）
  if (survival.blocking) {
    return {
      ...base,
      priority: PRIORITY_LABEL[survival.level] ?? 'P1',
      decision_reason: isQuestGuideActive
        ? `${survival.label}：先解决生存，安全后继续任务手册任务`
        : `${survival.label}：先解决生存，长期目标保留（阶段 ${stage.title}）`,
      goal_title: survivalPlan?.title ?? survival.label,
      next_action: String(survivalPlan?.next ?? ''),
      current_skill: skillForGoal(survivalPlan?.goalId) ?? { id: 'survival_stabilize', phase: survival.key },
    }
  }

  // ② P2/P3：当前发展阶段/任务手册的核心任务（看板里最高优先级的 ready/in_progress）
  if (nextTask && devPlan?.next) {
    return {
      ...base,
      priority: nextTask.priority <= 2 ? 'P2' : 'P3',
      decision_reason: isQuestGuideActive ? `任务手册目标：${nextTask.title}` : `当前阶段核心任务：${nextTask.title}`,
      goal_title: nextTask.title,
      current_task: { id: nextTask.id, title: nextTask.title, status: nextTask.status, priority: nextTask.priority },
      task_progress: nextTask.progress ?? { current: 0, required: 1 },
      current_skill: skillForTask(nextTask),
      next_action: String(devPlan.next),
      completion: completionForTask(nextTask),
    }
  }

  // ③ P3/P4：看板暂无具体任务（开局生存阶段 / 空闲）→ 生存规则引擎兜底
  // 当已有发展阶段且非开局阶段时，兜底应优先服务于当前发展阶段目标，避免旧规则引擎越级推荐中长期科技
  const fallbackGoal = isQuestGuideActive
    ? primaryGoal
    : ((stage.index > 0 && devPlan?.stage?.goal) ? devPlan.stage.goal : (survivalPlan?.title ?? stage.goal))
  const fallbackNext = (stage.index > 0 && devPlan?.next) ? devPlan.next : String(survivalPlan?.next ?? devPlan?.next ?? '')

  return {
    ...base,
    priority: 'P3',
    decision_reason: String(survivalPlan?.why ?? (isQuestGuideActive ? '任务手册追踪中' : `阶段「${stage.title}」推进中`)),
    goal_title: fallbackGoal,
    next_action: fallbackNext,
    current_skill: skillForGoal(survivalPlan?.goalId),
  }
}

/**
 * 渲染唯一决策段（文本给模型看）。只调用一次，绝不再叠加旧的 renderPlan / renderPlannerSection。
 * 保留「## 当前计划」标题以兼容既有阅读习惯与测试。
 * @param {object} decision arbitrate() 的结果
 * @param {object|null} devPlan 可选，用于附上任务看板列表
 */
export function renderDecision(decision, devPlan = null) {
  if (!decision) return ''
  const d = decision
  const lines = ['## 当前计划（统一决策）']

  const st = d.current_stage
  if (d.is_quest_guide_active) {
    lines.push(`当前主线模式：任务手册自主追踪${d.primary_goal ? ` —— ${d.primary_goal}` : ''}`)
  } else {
    lines.push(`当前发展阶段：${st ? `${st.index} ${st.title}` : '未知'}${d.primary_goal ? ` —— ${d.primary_goal}` : ''}`)
  }
  if (d.goal_title) lines.push(`当前主目标：${d.goal_title}`)
  if (d.current_task) {
    const p = d.task_progress ? `（${d.task_progress.current}/${d.task_progress.required}）` : ''
    lines.push(`当前任务：▶ ${d.current_task.id} · ${d.current_task.status}${p} — ${d.current_task.title}`)
  } else {
    lines.push('当前任务：无（生存/兜底模式）')
  }
  if (d.current_skill) lines.push(`当前 Skill：${d.current_skill.id} · ${d.current_skill.phase}`)
  lines.push(`优先级：${d.priority}｜决策依据：${d.decision_reason}`)
  if (d.next_action) lines.push(`当前下一步：${d.next_action}`)
  if (d.completion) lines.push(`完成条件：${d.completion}`)
  if (d.blocked_tasks?.length) {
    lines.push(`阻塞原因：${d.blocked_tasks.map((b) => `${b.id}(${b.reason})`).join('、')}`)
  }

  const tasks = devPlan?.board?.tasks ?? []
  if (tasks.length > 0) {
    lines.push('任务看板：')
    const ordered = [...tasks].sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)))
    const nextId = devPlan?.nextTask?.id
    for (const t of ordered) {
      const mark = t.id === nextId ? '▶ ' : '  '
      const prog = t.progress ? `(${t.progress.current}/${t.progress.required})` : ''
      const blocked = t.blocked_reason && t.status !== 'done' ? ` ⟵ ${t.blocked_reason}` : ''
      lines.push(`${mark}[P${t.priority}] ${t.id} · ${t.status} ${prog} ${t.title}${blocked}`)
    }
  }
  lines.push('（决策是唯一的；生存紧急时先保命，安全后自动回到当前阶段任务。Reflex 可在 Lua 端直接抢占动作。）')
  return lines.join('\n') + '\n'
}
