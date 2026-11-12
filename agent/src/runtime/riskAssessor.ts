// Risk Assessor（M4）：生存风险综合评估
//
// 关键设计（任务书 §10 明确要求）：
//   · **不允许把示例数值当作所有角色通用的死亡阈值** —— 所以阈值全部来自配置，
//     并且按角色可覆盖（薇洛/沃尔夫冈/WX-78 的饥饿上限不同）；
//   · 风险等级必须**综合多个因素**，不能只看一项；
//   · 输出要能解释"为什么是这个等级"（给 AI 和用户看）。

export type RiskLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export interface RiskThresholds {
  /** 生命低于这个百分比算危险 */
  healthLow: number
  healthCritical: number
  /** 饥饿低于这个百分比算危险 */
  hungerLow: number
  hungerCritical: number
  /** 理智低于这个百分比算危险 */
  sanityLow: number
  sanityCritical: number
  /** 体温低于/高于这个值算危险（饥荒里体温是摄氏度） */
  temperatureCold: number
  temperatureHot: number
  /** 附近敌对生物达到这个数量算危险 */
  hostileHigh: number
  hostileCritical: number
  /** 距离天黑还剩多少游戏日比例算"快天黑了"（of_day 阈值） */
  duskSoonRatio: number
}

/**
 * 默认阈值。**这只是保守起点，不是"通用死亡线"**：
 * 实际判定要看角色（不同角色饥饿/理智上限不同），调用方应传 characterOverrides。
 */
export const DEFAULT_THRESHOLDS: RiskThresholds = {
  healthLow: 50,
  healthCritical: 25,
  hungerLow: 30,
  hungerCritical: 15,
  sanityLow: 30,
  sanityCritical: 15,
  temperatureCold: 5,
  temperatureHot: 40,
  hostileHigh: 2,
  hostileCritical: 4,
  duskSoonRatio: 0.75,
}

/** 按角色覆盖阈值（例如 WX-78 饥饿上限 100 而薇洛 150，百分比判定仍用百分比，但绝对线可调） */
export interface CharacterProfile {
  prefab: string
  /** 覆盖任意阈值字段 */
  thresholds?: Partial<RiskThresholds>
}

export interface RiskInput {
  player?: {
    prefab?: string | null
    isGhost?: boolean | null
    healthPercent?: number | null
    hungerPercent?: number | null
    sanityPercent?: number | null
    temperature?: number | null
    dead?: boolean | null
  } | null
  world?: {
    phase?: string | null
    day?: number | null
    season?: string | null
    isRaining?: boolean | null
    isSnowing?: boolean | null
    /** 季节还剩几天（Planner 用） */
    remainingDaysInSeason?: number | null
    /** 当天进度 0~1（Planner 估算天黑用） */
    timeOfDay?: number | null
  } | null
  threats?: {
    hostileCount?: number | null
    nearestDistance?: number | null
  } | null
  inventory?: {
    itemCount?: number | null
    /** 有没有光源（火把/灯笼/营火材料） */
    hasLight?: boolean | null
    /** 有没有食物 */
    hasFood?: boolean | null
  } | null
  /** 数据是否过期（过期时所有判定要降级为"不确定"） */
  stale?: boolean
}

export interface RiskFactor {
  /** 因素标识 */
  key: string
  label: string
  level: RiskLevel
  /** 具体数值说明 */
  detail: string
  /** 这条对总体的影响权重（0~1） */
  weight: number
}

export interface RiskAssessment {
  level: RiskLevel
  /** 一句话结论 */
  summary: string
  factors: RiskFactor[]
  /** 数据是否过期（过期时结论不可靠） */
  stale: boolean
  /** 数据过期的说明 */
  staleNote: string | null
  /** 用的阈值（便于解释与审计） */
  thresholds: RiskThresholds
}

const LEVEL_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }

function worst(levels: RiskLevel[]): RiskLevel {
  let result: RiskLevel = 'LOW'
  for (const level of levels) if (LEVEL_ORDER[level] > LEVEL_ORDER[result]) result = level
  return result
}

export function assessRisk(input: RiskInput, options: { profile?: CharacterProfile; thresholds?: Partial<RiskThresholds> } = {}): RiskAssessment {
  const thresholds: RiskThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(options.thresholds ?? {}),
    ...(options.profile?.thresholds ?? {}),
  }
  const factors: RiskFactor[] = []
  const stale = input.stale === true

  const player = input.player ?? null
  const world = input.world ?? null
  const threats = input.threats ?? null
  const inventory = input.inventory ?? null

  // ── 死亡 / 幽灵：最高优先级，直接 CRITICAL ──
  if (player?.dead === true || player?.isGhost === true) {
    factors.push({
      key: 'death',
      label: player.isGhost === true ? '玩家处于幽灵状态' : '玩家已死亡',
      level: 'CRITICAL',
      detail: player.isGhost === true ? '需要复活（否则无法正常生存）' : '需要复活或重开',
      weight: 1,
    })
  }

  // ── 生命 ──
  if (typeof player?.healthPercent === 'number') {
    const hp = player.healthPercent
    const level: RiskLevel = hp <= thresholds.healthCritical ? 'CRITICAL' : hp <= thresholds.healthLow ? 'HIGH' : hp <= 70 ? 'MEDIUM' : 'LOW'
    factors.push({
      key: 'health',
      label: '生命值',
      level,
      detail: `${hp}%（危险线 ${thresholds.healthLow}% / 危殆线 ${thresholds.healthCritical}%）`,
      weight: 0.35,
    })
  }

  // ── 饥饿 ──
  if (typeof player?.hungerPercent === 'number') {
    const hunger = player.hungerPercent
    const level: RiskLevel =
      hunger <= thresholds.hungerCritical ? 'CRITICAL' : hunger <= thresholds.hungerLow ? 'HIGH' : hunger <= 50 ? 'MEDIUM' : 'LOW'
    factors.push({
      key: 'hunger',
      label: '饥饿',
      level,
      detail: `${hunger}%（危险线 ${thresholds.hungerLow}% / 危殆线 ${thresholds.hungerCritical}%）`,
      weight: 0.3,
    })
  }

  // ── 理智 ──
  if (typeof player?.sanityPercent === 'number') {
    const sanity = player.sanityPercent
    const level: RiskLevel =
      sanity <= thresholds.sanityCritical ? 'HIGH' : sanity <= thresholds.sanityLow ? 'MEDIUM' : 'LOW'
    factors.push({
      key: 'sanity',
      label: '理智',
      level,
      detail: `${sanity}%（危险线 ${thresholds.sanityLow}%）`,
      weight: 0.15,
    })
  }

  // ── 体温 ──
  if (typeof player?.temperature === 'number') {
    const temp = player.temperature
    const cold = temp <= thresholds.temperatureCold
    const hot = temp >= thresholds.temperatureHot
    factors.push({
      key: 'temperature',
      label: '体温',
      level: cold || hot ? 'HIGH' : 'LOW',
      detail: `${temp}°C${cold ? '（过冷）' : hot ? '（过热）' : '（正常）'}`,
      weight: 0.2,
    })
  }

  // ── 昼夜：快天黑且没光源 → 高危（饥荒里黑暗会死） ──
  if (world !== null) {
    const phase = world.phase ?? null
    const isNight = phase === 'night'
    const isDusk = phase === 'dusk'
    const hasLight = inventory?.hasLight === true
    if (isNight && !hasLight) {
      factors.push({
        key: 'darkness',
        label: '夜晚无光源',
        level: 'CRITICAL',
        detail: '当前是夜晚且没有光源，黑暗会造成伤害',
        weight: 1,
      })
    } else if (isDusk && !hasLight) {
      factors.push({
        key: 'dusk_no_light',
        label: '黄昏将至且无光源',
        level: 'HIGH',
        detail: '马上天黑但没有光源，需要立刻准备',
        weight: 0.6,
      })
    } else if (isNight) {
      factors.push({ key: 'night', label: '夜晚', level: 'MEDIUM', detail: '已入夜（有光源）', weight: 0.1 })
    } else if (isDusk) {
      factors.push({ key: 'dusk', label: '黄昏', level: 'MEDIUM', detail: '即将入夜', weight: 0.15 })
    }
  }

  // ── 季节 ──
  if (world?.season !== null && world?.season !== undefined) {
    const season = world.season
    if (season === 'winter') {
      factors.push({ key: 'season_winter', label: '冬季', level: 'MEDIUM', detail: '需要保暖，注意体温过低', weight: 0.2 })
    } else if (season === 'summer') {
      factors.push({ key: 'season_summer', label: '夏季', level: 'MEDIUM', detail: '注意过热与自燃', weight: 0.2 })
    } else if (season === 'spring') {
      factors.push({ key: 'season_spring', label: '春季', level: 'LOW', detail: '多雨，注意潮湿', weight: 0.1 })
    }
  }

  // ── 威胁 ──
  if (typeof threats?.hostileCount === 'number') {
    const count = threats.hostileCount
    const nearest = threats.nearestDistance
    const level: RiskLevel =
      count >= thresholds.hostileCritical ? 'CRITICAL' : count >= thresholds.hostileHigh ? 'HIGH' : count > 0 ? 'MEDIUM' : 'LOW'
    factors.push({
      key: 'threats',
      label: '附近敌对生物',
      level,
      detail: `${count} 个${typeof nearest === 'number' ? `，最近 ${nearest.toFixed(1)} 格` : ''}`,
      weight: 0.3,
    })
  }

  // ── 食物储备 ──
  if (inventory !== null && typeof inventory.hasFood === 'boolean') {
    const hunger = player?.hungerPercent
    if (inventory.hasFood === false && typeof hunger === 'number' && hunger <= 50) {
      factors.push({
        key: 'food',
        label: '没有食物且饥饿偏低',
        level: hunger <= thresholds.hungerLow ? 'CRITICAL' : 'HIGH',
        detail: `背包没有食物，饥饿 ${hunger}%`,
        weight: 0.5,
      })
    } else if (inventory.hasFood === false) {
      factors.push({ key: 'food', label: '背包没有食物', level: 'MEDIUM', detail: '需要补充食物来源', weight: 0.2 })
    }
  }

  const level = worst(factors.map((factor) => factor.level))
  const criticalCount = factors.filter((factor) => factor.level === 'CRITICAL').length
  const highCount = factors.filter((factor) => factor.level === 'HIGH').length

  const summaryParts: string[] = []
  if (criticalCount > 0) summaryParts.push(`${criticalCount} 项危急`)
  if (highCount > 0) summaryParts.push(`${highCount} 项高危`)
  const summary =
    factors.length === 0
      ? '没有足够数据做风险评估'
      : `${level}${summaryParts.length > 0 ? `（${summaryParts.join('、')}）` : ''}：` +
        factors
          .filter((factor) => factor.level !== 'LOW')
          .sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level])
          .slice(0, 3)
          .map((factor) => factor.label)
          .join('、')

  return {
    level,
    summary: factors.length === 0 ? summary : summary,
    factors: factors.sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]),
    stale,
    staleNote: stale ? '数据已过期，以上结论基于最后一次已知状态，不代表当前' : null,
    thresholds,
  }
}
