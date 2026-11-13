// Task Planner（M4）：从游戏状态生成带优先级的生存计划
//
// 定位：**只生成建议，不执行**（任务书 §9：目前只生成建议计划，不执行游戏操作）。
//
// 与 Risk Assessor 的分工：
//   · Risk Assessor 回答"现在有多危险"；
//   · Task Planner 回答"接下来该做什么，按什么顺序"。
//
// 目标分层（任务书要求）：紧急生存 / 短期 / 中期 / 长期。

import type { RiskAssessment } from './riskAssessor.js'

export type GoalHorizon = 'immediate' | 'short' | 'mid' | 'long'
export type PlanPriority = 1 | 2 | 3 | 4 | 5

export interface PlanStep {
  /** 步骤序号（从 1 开始，按执行顺序） */
  order: number
  horizon: GoalHorizon
  priority: PlanPriority
  /** 动作描述（给人看，不是命令） */
  action: string
  /** 为什么要做（关联到具体风险或目标） */
  reason: string
  /** 依据（数据来源，例如 "饥饿 12%"） */
  evidence: string
  /** 是否属于"立刻要命"的事 */
  urgent: boolean
}

export interface SurvivalPlan {
  /** 一句话总览 */
  headline: string
  /** 风险等级（来自 Risk Assessor） */
  riskLevel: RiskAssessment['level']
  steps: PlanStep[]
  /** 按 horizon 分组统计 */
  summary: Record<GoalHorizon, number>
  /** 数据过期提示 */
  staleNote: string | null
  /** 生成时的上下文快照（便于 AI 引用） */
  context: Record<string, unknown>
}

export interface PlanInput {
  risk: RiskAssessment
  player?: {
    prefab?: string | null
    healthPercent?: number | null
    hungerPercent?: number | null
    sanityPercent?: number | null
    temperature?: number | null
    isGhost?: boolean | null
    dead?: boolean | null
  } | null
  world?: {
    phase?: string | null
    day?: number | null
    season?: string | null
    remainingDaysInSeason?: number | null
    timeOfDay?: number | null
  } | null
  threats?: { hostileCount?: number | null; nearestName?: string | null; nearestDistance?: number | null } | null
  inventory?: { itemCount?: number | null; hasLight?: boolean | null; hasFood?: boolean | null; items?: string[] | null } | null
  /** 附近资源摘要（来自 get_nearby_resources） */
  resources?: { harvestable?: number | null; tree?: number | null; rock?: number | null; item?: number | null } | null
  stale?: boolean
}

const PRIORITY_LABEL: Record<PlanPriority, string> = { 1: '最高', 2: '高', 3: '中', 4: '低', 5: '最低' }
export const PRIORITY_TEXT = PRIORITY_LABEL

/** 根据输入生成计划（纯函数，好测） */
export function buildPlan(input: PlanInput): SurvivalPlan {
  const steps: Omit<PlanStep, 'order'>[] = []
  const player = input.player ?? null
  const world = input.world ?? null
  const threats = input.threats ?? null
  const inventory = input.inventory ?? null
  const resources = input.resources ?? null
  const risk = input.risk

  const push = (step: Omit<PlanStep, 'order'>) => steps.push(step)

  // ── 紧急：死亡 / 幽灵 ──
  if (player?.dead === true) {
    push({
      horizon: 'immediate',
      priority: 1,
      urgent: true,
      action: '先复活（找复活台/肉块雕像，或让队友复活你）',
      reason: '死亡状态下无法做任何生存操作',
      evidence: '玩家已死亡',
    })
  } else if (player?.isGhost === true) {
    push({
      horizon: 'immediate',
      priority: 1,
      urgent: true,
      action: '作为幽灵去找复活方式（复活台 / 肉块雕像 / 队友）',
      reason: '幽灵状态无法进食与战斗',
      evidence: '玩家处于幽灵状态',
    })
  }

  // ── 紧急：夜晚无光源 ──
  const phase = world?.phase ?? null
  const hasLight = inventory?.hasLight === true
  if ((phase === 'night' || phase === 'dusk') && !hasLight) {
    push({
      horizon: 'immediate',
      priority: 1,
      urgent: true,
      action: '立刻做火把/营火（草 + 树枝，或草 + 木头）',
      reason: '饥荒里黑暗会直接造成伤害，没有光源等于等死',
      evidence: `当前 ${phase === 'night' ? '夜晚' : '黄昏'}，背包无光源`,
    })
  }

  // ── 紧急：生命过低 ──
  if (typeof player?.healthPercent === 'number' && player.healthPercent <= risk.thresholds.healthCritical) {
    push({
      horizon: 'immediate',
      priority: 1,
      urgent: true,
      action: '脱离战斗、远离威胁，找安全位置回血（食物/药膏/睡觉）',
      reason: '生命已到危殆线，再挨一下就会死',
      evidence: `生命 ${player.healthPercent}% ≤ ${risk.thresholds.healthCritical}%`,
    })
  }

  // ── 紧急：附近敌对生物 ──
  if (typeof threats?.hostileCount === 'number' && threats.hostileCount > 0) {
    const critical = threats.hostileCount >= risk.thresholds.hostileCritical
    push({
      horizon: 'immediate',
      priority: critical ? 1 : 2,
      urgent: critical,
      action: critical ? '立刻逃跑或拉开距离（不要硬打）' : '保持距离，评估是否要绕开',
      reason: critical ? '附近敌对生物数量已到危险水平' : '附近有敌对生物，可能主动攻击',
      evidence: `${threats.hostileCount} 个敌对${threats.nearestName ? `，最近：${threats.nearestName}` : ''}${
        typeof threats.nearestDistance === 'number' ? `（${threats.nearestDistance.toFixed(1)} 格）` : ''
      }`,
    })
  }

  // ── 短期：饥饿 ──
  if (typeof player?.hungerPercent === 'number' && player.hungerPercent <= risk.thresholds.hungerLow) {
    const hasFood = inventory?.hasFood === true
    push({
      horizon: 'short',
      priority: 2,
      urgent: player.hungerPercent <= risk.thresholds.hungerCritical,
      action: hasFood ? '立刻吃背包里的食物' : '去采集食物（浆果/胡萝卜/蘑菇）或打猎',
      reason: '饥饿过低会掉血，且无法恢复生命',
      evidence: `饥饿 ${player.hungerPercent}%${hasFood ? '，背包有食物' : '，背包没食物'}`,
    })
  }

  // ── 短期：食物储备 ──
  // 注意：饥饿已经偏低时，上面那条「去采集食物」已经覆盖了这件事，
  // 这里再产一条会重复（实测踩到：两条都是"找吃的"）。
  // 所以只在「饥饿尚可、但背包没存货」时给储备提醒。
  const hungerLow = typeof player?.hungerPercent === 'number' && player.hungerPercent <= risk.thresholds.hungerLow
  if (inventory !== null && inventory.hasFood === false && hungerLow !== true) {
    const nearbyFood = (resources?.harvestable ?? 0) > 0
    push({
      horizon: 'short',
      priority: nearbyFood ? 3 : 2,
      urgent: false,
      action: nearbyFood ? '采集附近的可食用资源，建立食物储备' : '扩大搜索范围找食物来源',
      reason: '背包没有食物储备，饥饿会持续下降',
      evidence: nearbyFood ? `附近有 ${resources?.harvestable} 个可采集物` : '附近没有明显可采集物',
    })
  }

  // ── 短期：理智 ──
  if (typeof player?.sanityPercent === 'number' && player.sanityPercent <= risk.thresholds.sanityLow) {
    push({
      horizon: 'short',
      priority: 3,
      urgent: false,
      action: '恢复理智（采花、吃熟食、远离黑暗与怪物、睡觉）',
      reason: '理智过低会出现幻觉与影怪',
      evidence: `理智 ${player.sanityPercent}%`,
    })
  }

  // ── 短期：体温 ──
  if (typeof player?.temperature === 'number') {
    const temp = player.temperature
    if (temp <= risk.thresholds.temperatureCold) {
      push({
        horizon: 'short',
        priority: 2,
        urgent: true,
        action: '取暖（靠近营火/穿保暖衣物/用保暖石）',
        reason: '体温过低会持续掉血',
        evidence: `体温 ${temp}°C ≤ ${risk.thresholds.temperatureCold}°C`,
      })
    } else if (temp >= risk.thresholds.temperatureHot) {
      push({
        horizon: 'short',
        priority: 2,
        urgent: true,
        action: '降温（远离火源/用冰块或遮阳/换薄衣服）',
        reason: '体温过高会中暑掉血',
        evidence: `体温 ${temp}°C ≥ ${risk.thresholds.temperatureHot}°C`,
      })
    }
  }

  // ── 中期：资源储备 ──
  const treeCount = resources?.tree ?? 0
  const rockCount = resources?.rock ?? 0
  if (treeCount + rockCount > 0) {
    push({
      horizon: 'mid',
      priority: 4,
      urgent: false,
      action: `采集基础资源（附近有 ${treeCount} 棵树、${rockCount} 处矿石）`,
      reason: '木材与石头是建造与工具的基础',
      evidence: `附近资源：树 ${treeCount}、石 ${rockCount}`,
    })
  } else if (resources !== null) {
    push({
      horizon: 'mid',
      priority: 4,
      urgent: false,
      action: '探索周围寻找资源点（树/石头/草）',
      reason: '当前视野内没有基础资源',
      evidence: '附近没有可采集的树或矿石',
    })
  }

  // ── 中期：季节准备 ──
  const season = world?.season ?? null
  const remaining = world?.remainingDaysInSeason ?? null
  if (season === 'autumn' && typeof remaining === 'number' && remaining <= 5) {
    push({
      horizon: 'mid',
      priority: 3,
      urgent: false,
      action: '抓紧准备过冬物资（保暖衣物、食物储备、燃料）',
      reason: '秋季即将结束，冬季食物稀缺且需要保暖',
      evidence: `秋季还剩 ${remaining} 天`,
    })
  } else if (season === 'winter') {
    push({
      horizon: 'mid',
      priority: 3,
      urgent: false,
      action: '保持体温与食物储备，减少远距离探索',
      reason: '冬季体温下降快，食物来源少',
      evidence: `当前是冬季${typeof remaining === 'number' ? `，还剩 ${remaining} 天` : ''}`,
    })
  } else if (season === 'spring') {
    push({
      horizon: 'mid',
      priority: 4,
      urgent: false,
      action: '准备雨具（雨伞/雨衣），注意潮湿导致理智下降',
      reason: '春季多雨，潮湿会加速理智流失',
      evidence: '当前是春季',
    })
  } else if (season === 'summer') {
    push({
      horizon: 'mid',
      priority: 3,
      urgent: false,
      action: '准备降温手段（冰块/遮阳），注意自燃',
      reason: '夏季过热会掉血，且物体会自燃',
      evidence: '当前是夏季',
    })
  }

  // ── 长期：基地与探索 ──
  push({
    horizon: 'long',
    priority: 5,
    urgent: false,
    action: '规划长期基地位置（靠近资源与道路，避开危险区域）',
    reason: '稳定基地能大幅降低长期生存难度',
    evidence: world?.day !== null && world?.day !== undefined ? `已生存到第 ${world.day} 天` : '尚无天数信息',
  })

  // 排序：horizon 紧急度 → priority → 原始顺序
  const horizonOrder: Record<GoalHorizon, number> = { immediate: 0, short: 1, mid: 2, long: 3 }
  const sorted = steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => {
      const horizonDiff = horizonOrder[a.step.horizon] - horizonOrder[b.step.horizon]
      if (horizonDiff !== 0) return horizonDiff
      if (a.step.priority !== b.step.priority) return a.step.priority - b.step.priority
      return a.index - b.index
    })
    .map((item, index) => ({ ...item.step, order: index + 1 }))

  const summary: Record<GoalHorizon, number> = { immediate: 0, short: 0, mid: 0, long: 0 }
  for (const step of sorted) summary[step.horizon] += 1

  const urgentCount = sorted.filter((step) => step.urgent).length
  const immediateCount = sorted.filter((step) => step.horizon === 'immediate').length
  // headline 必须与 urgent/immediate 一致：有紧急项就不能说"没有紧急威胁"
  const headline =
    sorted.length === 0
      ? '数据不足，暂时无法给出计划'
      : urgentCount > 0 || immediateCount > 0
        ? `有 ${Math.max(urgentCount, immediateCount)} 件紧急事项要立刻处理，其中最高优先级：${sorted[0]!.action}`
        : `当前没有紧急威胁，建议按顺序推进 ${sorted.length} 项计划（优先：${sorted[0]!.action}）`

  return {
    headline,
    riskLevel: risk.level,
    steps: sorted,
    summary,
    staleNote: input.stale === true ? '数据已过期，计划基于最后一次已知状态，执行前请重新查询' : null,
    context: {
      player: player ?? null,
      world: world ?? null,
      threats: threats ?? null,
      inventory: inventory ?? null,
      resources: resources ?? null,
      risk_level: risk.level,
      risk_summary: risk.summary,
    },
  }
}

/** 把计划渲染成给 AI/用户看的文本 */
export function renderPlan(plan: SurvivalPlan): string {
  const horizonLabel: Record<GoalHorizon, string> = { immediate: '紧急生存', short: '短期', mid: '中期', long: '长期' }
  const lines: string[] = []
  if (plan.staleNote !== null) lines.push(`⚠️ ${plan.staleNote}`)
  lines.push(`风险等级：${plan.riskLevel}`)
  lines.push(plan.headline)
  lines.push('')
  for (const step of plan.steps) {
    const tag = step.urgent ? '【紧急】' : ''
    lines.push(`${step.order}. ${tag}[${horizonLabel[step.horizon]}/优先级${PRIORITY_LABEL[step.priority]}] ${step.action}`)
    lines.push(`   理由：${step.reason}`)
    lines.push(`   依据：${step.evidence}`)
  }
  return lines.join('\n')
}
