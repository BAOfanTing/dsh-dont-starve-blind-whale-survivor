// Phase 6 M1 · Threat Analyzer（威胁分析）
//
// 输入：`SurvivalContext`（真实游戏读数）
// 输出：0~100 的威胁评分 + 每个因素的可审计贡献 + 每个敌人一个"战术档案视图"
//
// 为什么评分要在这里（程序层）而不是提示词里：
//   任务书要求"评分必须有明确的计算依据和可配置参数"，并且"不能仅凭 prefab 名字推测攻击能力"。
//   所以：
//     1. 攻击能力优先取游戏运行时读数（combat:GetAttackRange / attackperiod / defaultdamage），
//        运行时有就用运行的，没有才退回 profiles.ts 的档案值，两者都没有 → 未知（保守避战）；
//     2. 权重全部可配（`ThreatConfig`），每个因素都输出 value/weight/contribution/reason，
//        上层可以解释"这 73 分是怎么来的"；
//     3. 硬规则（Boss / 被围攻 / 数据不足）单独兜底，不参与加权，防止权重调错就出人命。

import { getEnemyProfile, isKnownEnemy, type EnemyProfile } from './profiles.js'
import { ARMOR_ABSORB, WEAPON_DAMAGE, type SurvivalContext, type ThreatEntity } from './types.js'

export interface ThreatWeights {
  /** 敌人攻击能力（档案威胁等级 + 伤害 + 攻击距离） */
  capability: number
  /** 距离（越近越危险） */
  proximity: number
  /** 是否正在追击玩家 */
  chasing: number
  /** 敌对数量 */
  count: number
  /** 玩家生命状态 */
  player_health: number
  /** 玩家装备（武器/护甲） */
  equipment: number
  /** 环境（黑夜无光 / 潮湿 / 极温） */
  environment: number
  /** 逃跑难度（被包围 / 贴身 / 固定点伏击） */
  escape_difficulty: number
}

export const DEFAULT_THREAT_WEIGHTS: ThreatWeights = {
  capability: 0.26,
  proximity: 0.18,
  chasing: 0.16,
  count: 0.12,
  player_health: 0.14,
  equipment: 0.08,
  environment: 0.04,
  escape_difficulty: 0.02,
}

export interface ThreatConfig {
  weights: ThreatWeights
  /** 评分参考距离（格）：≥ 这个距离算"很远" */
  reference_distance_tiles: number
  /** 等级阈值 */
  thresholds: { low: number; medium: number; high: number; critical: number }
  /** 数量参考值：达到这个敌对数量算满格 */
  count_reference: number
}

export const DEFAULT_THREAT_CONFIG: ThreatConfig = {
  weights: DEFAULT_THREAT_WEIGHTS,
  reference_distance_tiles: 16,
  thresholds: { low: 10, medium: 30, high: 55, critical: 80 },
  count_reference: 4,
}

export type ThreatLevel = 'none' | 'low' | 'medium' | 'high' | 'critical'

export interface ThreatFactor {
  key: keyof ThreatWeights
  label: string
  /** 归一化后的危险程度 0~1（1 = 最危险） */
  value: number
  weight: number
  /** value * weight * 100 */
  contribution: number
  reason: string
}

/** 单个敌人的"实际能力"（运行时 > 档案 > 未知） */
export interface EffectiveCapability {
  attack_range: number
  attack_period: number
  damage: number
  source: 'runtime' | 'archive' | 'unknown'
  /** 一次攻击打在当前护甲上的净伤害（估算，可能为 null） */
  effective_damage: number | null
  /** 打几下能打死它（估算，可能为 null：缺最大生命） */
  hits_to_kill: number | null
}

export interface ThreatTargetView {
  prefab: string
  name: string
  distance: number | null
  hp_percent: number | null
  profile_threat_level: number
  verified: boolean
  combat_profile: EnemyProfile['combat_profile']
  recommended_strategy: EnemyProfile['recommended_strategy']
  special_abilities: string[]
  retreat_conditions: string[]
  auto_engage_allowed: boolean
  targeting_player: boolean | null
  attacking: boolean | null
  sleeping: boolean | null
  effective: EffectiveCapability
  /** 这个敌人的单体危险度 0~100 */
  danger: number
  note: string | null
}

export interface ThreatAssessment {
  score: number
  level: ThreatLevel
  /** 数据够不够下结论（不够时上层必须拒绝进入战斗） */
  data_ok: boolean
  data_quality: SurvivalContext['dataQuality']
  factors: ThreatFactor[]
  targets: ThreatTargetView[]
  primary: ThreatTargetView | null
  hostile_count: number
  chasing_count: number
  attacking_count: number
  boss_present: boolean
  boss_prefabs: string[]
  unknown_enemies: string[]
  recommended: 'ignore' | 'monitor' | 'prepare' | 'evade' | 'retreat'
  reasons: string[]
  config: ThreatConfig
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function armorAbsorb(ctx: SurvivalContext): number {
  let absorb = 0
  if (ctx.equipment.body !== null) {
    const prefab = ctx.equipment.body.prefab
    const known = ARMOR_ABSORB[prefab]
    if (known !== undefined) absorb = Math.max(absorb, known)
  }
  if (ctx.equipment.head !== null) {
    const prefab = ctx.equipment.head.prefab
    const known = ARMOR_ABSORB[prefab]
    if (known !== undefined) absorb = Math.max(absorb, known)
  }
  return clamp01(absorb)
}

function weaponDamage(ctx: SurvivalContext): number | null {
  if (ctx.equipment.hands === null) return 1 // 空手（拳击 ~10，这里按最低值处理）
  const known = WEAPON_DAMAGE[ctx.equipment.hands.prefab]
  return known ?? null
}

/** 单个敌人的实际能力：运行时读数优先，档案兜底，都没有 → unknown */
export function effectiveCapability(threat: ThreatEntity, ctx: SurvivalContext): EffectiveCapability {
  const profile = getEnemyProfile(threat.prefab)
  const runtimeRange = threat.attack_range
  const runtimePeriod = threat.attack_period
  const runtimeDamage = threat.attack_damage
  const hasRuntime = runtimeRange !== null || runtimePeriod !== null || runtimeDamage !== null

  const attackRange = runtimeRange ?? (profile.verified ? profile.attack_range : 2)
  const attackPeriod = runtimePeriod ?? (profile.verified ? profile.attack_period : 2)
  const damage = runtimeDamage ?? (profile.verified ? profile.damage : 20)
  const source: EffectiveCapability['source'] = hasRuntime ? 'runtime' : profile.verified ? 'archive' : 'unknown'

  const absorb = armorAbsorb(ctx)
  const effectiveDamage = source === 'unknown' ? null : Math.round(damage * (1 - absorb) * 10) / 10

  // 打几下能打死：需要目标最大生命，只有 hp% 时算不出来（不猜）
  const hitsToKill = null

  return {
    attack_range: attackRange,
    attack_period: attackPeriod,
    damage,
    source,
    effective_damage: effectiveDamage,
    hits_to_kill: hitsToKill,
  }
}

function targetDanger(threat: ThreatEntity, view: Omit<ThreatTargetView, 'danger'>, config: ThreatConfig): number {
  const capability = clamp01(view.profile_threat_level / 5)
  const proximity = threat.distance === null ? 0.5 : clamp01(1 - threat.distance / config.reference_distance_tiles)
  const chasing = threat.targeting_player === true ? 1 : threat.targeting_player === null ? 0.3 : 0
  const attacking = threat.attacking === true ? 1 : 0
  const sleeping = threat.sleeping === true ? -0.25 : 0
  const score = (capability * 0.45 + proximity * 0.25 + chasing * 0.2 + attacking * 0.1 + sleeping) * 100
  return Math.round(Math.max(0, Math.min(100, score)))
}

/** 逃跑难度 0~1：被包围 / 贴身 / 固定点伏击 → 难跑 */
function escapeDifficulty(ctx: SurvivalContext, config: ThreatConfig): { value: number; reason: string } {
  const active = ctx.threats.filter((threat) => threat.sleeping !== true)
  if (active.length === 0) return { value: 0, reason: '附近没有活跃的敌对生物' }
  const close = active.filter((threat) => threat.distance !== null && threat.distance <= 3).length
  const chasing = active.filter((threat) => threat.targeting_player === true).length
  const tiles = active
    .map((threat) => threat.tile_x !== null && threat.tile_z !== null ? { x: threat.tile_x, z: threat.tile_z } : null)
    .filter((value): value is { x: number; z: number } => value !== null)

  // 角度覆盖：威胁分布跨越越大，越像是被包围
  let spread = 0
  if (tiles.length >= 2 && ctx.player.tile !== null && ctx.player.tile.x !== null && ctx.player.tile.z !== null) {
    const angles = tiles.map((tile) => Math.atan2(tile.z - (ctx.player.tile?.z ?? 0), tile.x - (ctx.player.tile?.x ?? 0)))
    const min = Math.min(...angles)
    const max = Math.max(...angles)
    spread = (max - min) / (Math.PI * 2)
  }

  let value = 0.2
  const reasons: string[] = []
  if (close >= 2) {
    value += 0.25
    reasons.push(`${close} 个敌人贴身`)
  }
  if (chasing >= 3) {
    value += 0.25
    reasons.push(`${chasing} 个敌人正在追击`)
  }
  if (spread > 0.55) {
    value += 0.2
    reasons.push('敌人从多个方向包围')
  }
  if (active.some((threat) => getEnemyProfile(threat.prefab).combat_profile === 'ambush')) {
    value += 0.1
    reasons.push('有固定点伏击型敌人')
  }
  return {
    value: clamp01(value),
    reason: reasons.length > 0 ? reasons.join('，') : `威胁集中在同一方向（${active.length} 个），可以往反方向跑`,
  }
}

export function assessThreat(ctx: SurvivalContext, overrides: Partial<ThreatConfig> = {}): ThreatAssessment {
  const config: ThreatConfig = {
    ...DEFAULT_THREAT_CONFIG,
    ...overrides,
    weights: { ...DEFAULT_THREAT_WEIGHTS, ...(overrides.weights ?? {}) },
    thresholds: { ...DEFAULT_THREAT_CONFIG.thresholds, ...(overrides.thresholds ?? {}) },
  }

  const active = ctx.threats.filter((threat) => threat.sleeping !== true)
  const hostileCount = active.length
  const chasingCount = active.filter((threat) => threat.targeting_player === true).length
  const attackingCount = active.filter((threat) => threat.attacking === true).length
  const bossTargets = active.filter((threat) => threat.is_boss)
  const unknownEnemies = active.filter((threat) => !isKnownEnemy(threat.prefab)).map((threat) => threat.prefab)

  // 敌人战术档案视图
  const targets: ThreatTargetView[] = active.map((threat) => {
    const profile = getEnemyProfile(threat.prefab)
    const partial: Omit<ThreatTargetView, 'danger'> = {
      prefab: threat.prefab,
      name: profile.name !== '未知生物' ? profile.name : threat.name ?? threat.prefab,
      distance: threat.distance,
      hp_percent: threat.hp,
      profile_threat_level: profile.threat_level,
      verified: profile.verified,
      combat_profile: profile.combat_profile,
      recommended_strategy: profile.recommended_strategy,
      special_abilities: profile.special_abilities,
      retreat_conditions: profile.retreat_conditions,
      auto_engage_allowed: profile.auto_engage_allowed,
      targeting_player: threat.targeting_player,
      attacking: threat.attacking,
      sleeping: threat.sleeping,
      effective: effectiveCapability(threat, ctx),
      note: profile.verified ? profile.notes ?? null : '没有经过验证的战斗档案：默认保守避战',
    }
    return { ...partial, danger: targetDanger(threat, partial, config) }
  })
  targets.sort((a, b) => b.danger - a.danger)

  const primary = targets[0] ?? null
  const factors: ThreatFactor[] = []
  const reasons: string[] = []

  const push = (key: keyof ThreatWeights, label: string, value: number, reason: string) => {
    const weight = config.weights[key]
    factors.push({ key, label, value: clamp01(value), weight, contribution: Math.round(clamp01(value) * weight * 1000) / 10, reason })
  }

  // ① 敌人攻击能力
  const maxCapability = targets.reduce((acc, target) => Math.max(acc, target.profile_threat_level / 5), 0)
  push(
    'capability',
    '敌人攻击能力',
    maxCapability,
    primary === null
      ? '附近没有敌人'
      : `最强的是 ${primary.name}（威胁等级 ${primary.profile_threat_level}/5，攻击距离 ${primary.effective.attack_range} 格，单次约 ${primary.effective.damage} 伤害，来源 ${primary.effective.source}）`,
  )

  // ② 距离
  const proximity = ctx.nearestThreatDistance === null
    ? 0
    : clamp01(1 - ctx.nearestThreatDistance / config.reference_distance_tiles)
  push('proximity', '与玩家距离', proximity, ctx.nearestThreatDistance === null
    ? '不知道最近敌人有多远'
    : `最近的敌人 ${ctx.nearestThreatDistance} 格（参考距离 ${config.reference_distance_tiles} 格）`)

  // ③ 追击
  push('chasing', '是否正在追击', chasingCount > 0 ? Math.min(1, 0.6 + chasingCount * 0.2) : 0,
    chasingCount > 0 ? `${chasingCount} 个敌人正在追玩家` : '没有敌人在追击（或拿不到追击状态）')

  // ④ 数量
  push('count', '敌对数量', clamp01(hostileCount / config.count_reference),
    `${hostileCount} 个活跃敌对生物（满格参考 ${config.count_reference} 个）`)

  // ⑤ 玩家生命
  const hp = ctx.player.healthPercent
  const healthDanger = hp === null ? 0.5 : clamp01((70 - hp) / 55)
  push('player_health', '玩家生命状态', healthDanger, hp === null ? '拿不到玩家生命值（按中等风险处理）' : `生命 ${hp}%`)

  // ⑥ 玩家装备
  const weapon = weaponDamage(ctx)
  const absorb = armorAbsorb(ctx)
  let equipmentDanger = 0
  const equipmentReasons: string[] = []
  if (ctx.equipment.hands === null) {
    equipmentDanger += 0.5
    equipmentReasons.push('空手')
  } else if (weapon === null) {
    equipmentDanger += 0.25
    equipmentReasons.push(`手持 ${ctx.equipment.hands.prefab}（伤害未知）`)
  } else if (weapon < 25) {
    equipmentDanger += 0.3
    equipmentReasons.push(`武器偏弱（约 ${weapon} 伤害）`)
  }
  if (ctx.equipment.body === null && ctx.equipment.head === null) {
    equipmentDanger += 0.4
    equipmentReasons.push('没有护甲')
  } else if (absorb < 0.5) {
    equipmentDanger += 0.15
    equipmentReasons.push(`护甲减伤只有 ${Math.round(absorb * 100)}%`)
  }
  push('equipment', '玩家装备', clamp01(equipmentDanger),
    equipmentReasons.length > 0 ? equipmentReasons.join('，') : '武器护甲齐全')

  // ⑦ 环境
  let environmentDanger = 0
  const envReasons: string[] = []
  if (ctx.world.isNight === true && ctx.environment.inLight === false) {
    environmentDanger += 0.6
    envReasons.push('夜间且不在光照内')
  }
  if (ctx.player.temperature !== null && (ctx.player.temperature < 5 || ctx.player.temperature > 65)) {
    environmentDanger += 0.3
    envReasons.push(`体温 ${ctx.player.temperature}℃`)
  }
  if (ctx.player.sanityPercent !== null && ctx.player.sanityPercent < 20) {
    environmentDanger += 0.2
    envReasons.push(`理智 ${ctx.player.sanityPercent}%`)
  }
  push('environment', '环境条件', clamp01(environmentDanger),
    envReasons.length > 0 ? envReasons.join('，') : '环境没有额外加成')

  // ⑧ 逃跑难度
  const escape = escapeDifficulty(ctx, config)
  push('escape_difficulty', '逃跑难度', escape.value, escape.reason)

  let score = Math.round(factors.reduce((acc, factor) => acc + factor.contribution, 0))

  // ── 硬规则（不参与加权）──
  const hardReasons: string[] = []
  if (bossTargets.length > 0) {
    score = Math.max(score, 85)
    hardReasons.push(`附近有 Boss（${bossTargets.map((boss) => boss.prefab).join('/')}）：默认避战，战斗必须人工确认`)
  }
  if (chasingCount >= 3) {
    score = Math.max(score, 70)
    hardReasons.push(`${chasingCount} 个敌人同时追击：撤退优先`)
  }
  if (attackingCount > 0 && (ctx.nearestThreatDistance ?? 99) <= 3) {
    score = Math.max(score, 60)
    hardReasons.push('有敌人正在出手且贴身：先脱离再谈战斗')
  }
  if (unknownEnemies.length > 0) {
    hardReasons.push(`以下生物没有验证档案，按保守避战：${unknownEnemies.join('/')}`)
  }
  score = Math.max(0, Math.min(100, score))

  const t = config.thresholds
  let level: ThreatLevel = 'none'
  if (score >= t.critical) level = 'critical'
  else if (score >= t.high) level = 'high'
  else if (score >= t.medium) level = 'medium'
  else if (score >= t.low) level = 'low'

  const dataOk = ctx.dataQuality !== 'unverified' && ctx.player.healthPercent !== null
  if (!dataOk) {
    hardReasons.push('数据不足以评估威胁（拿不到玩家生命或威胁列表）：不给出战斗许可')
  }

  // 建议动作
  let recommended: ThreatAssessment['recommended'] = 'ignore'
  if (!dataOk) recommended = 'monitor'
  else if (level === 'critical') recommended = 'retreat'
  else if (level === 'high') recommended = 'evade'
  else if (level === 'medium') recommended = 'prepare'
  else if (level === 'low') recommended = 'monitor'

  for (const factor of factors) {
    if (factor.value >= 0.6) reasons.push(`${factor.label}：${factor.reason}`)
  }

  return {
    score,
    level,
    data_ok: dataOk,
    data_quality: ctx.dataQuality,
    factors,
    targets,
    primary,
    hostile_count: hostileCount,
    chasing_count: chasingCount,
    attacking_count: attackingCount,
    boss_present: bossTargets.length > 0,
    boss_prefabs: bossTargets.map((boss) => boss.prefab),
    unknown_enemies: unknownEnemies,
    recommended,
    reasons: [...reasons, ...hardReasons],
    config,
  }
}
