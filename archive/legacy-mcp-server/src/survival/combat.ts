// Phase 6 M3 · Combat Readiness + M2 · Combat Planner 决策
//
// 两件事放在一个文件里，因为它们是同一套判断的两面：
//   assessReadiness() 回答"我现在打得过吗"（逐项检查 + 阻断项）
//   decideCombat()    回答"那到底该怎么做"（ENGAGE / PREPARE / EVADE / RETREAT）
//
// 任务书 §4 明确写：**不能仅通过一个固定生命值阈值决定战斗**。
// 所以这里的门槛是动态的：生命阈值随"敌人威胁等级 / 是否被追击 / 护甲减伤"浮动，
// 并且还要过"武器、护甲、治疗、食物、光源、精神、体温、敌人数量、数据可信度"这一串检查。
//
// 安全默认：
//   · 决策结果永远 `auto_executable: false` —— 第一版只有 SUPERVISED_COMBAT（人工确认）；
//   · 数据不足（拿到不到生命/威胁）时**绝不 ENGAGE**；
//   · Boss 一律 requires_human_confirmation，且默认避战。

import { getEnemyProfile, isBossPrefab } from './profiles.js'
import type { ThreatAssessment } from './threat.js'
import { ARMOR_ABSORB, HEALING_ITEMS, WEAPON_DAMAGE, type SurvivalContext } from './types.js'

export interface CombatConfig {
  /** 生命硬底线（%）：低于这个值任何情况下都不开打 */
  hard_min_hp: number
  /** 动态阈值基数（%） */
  base_hp_threshold: number
  /** 每级敌人威胁等级抬高多少个百分点 */
  hp_per_threat_level: number
  /** 每个追击者抬高多少个百分点 */
  hp_per_chaser: number
  /** 护甲减伤能压低多少个百分点（减伤 100% → 压 20 点） */
  armor_threshold_relief: number
  /** 同时最多打几个敌人 */
  max_engage_count: number
  /** 允许开打的最低饥饿（%） */
  min_hunger_percent: number
  /** 允许开打的最低理智（%） */
  min_sanity_percent: number
  /** 武器最低伤害 */
  min_weapon_damage: number
  /** 治疗物品合计至少要能回多少血 */
  min_healing_hp: number
  /** 可接受的体温区间（℃） */
  temperature_ok: [number, number]
}

export const DEFAULT_COMBAT_CONFIG: CombatConfig = {
  hard_min_hp: 25,
  base_hp_threshold: 30,
  hp_per_threat_level: 5,
  hp_per_chaser: 4,
  armor_threshold_relief: 20,
  max_engage_count: 2,
  min_hunger_percent: 20,
  min_sanity_percent: 15,
  min_weapon_damage: 25,
  min_healing_hp: 30,
  temperature_ok: [-5, 60],
}

export interface ReadinessCheck {
  key: string
  label: string
  ok: boolean
  /** blocker = 不能开打；warning = 能打但要小心；info = 只是告知 */
  severity: 'blocker' | 'warning' | 'info'
  detail: string
}

export interface CombatReadiness {
  ready: boolean
  score: number
  checks: ReadinessCheck[]
  blockers: string[]
  warnings: string[]
  weapon: { prefab: string | null; damage: number | null; source: 'equipped' | 'none' | 'unknown' }
  armor: { body: string | null; head: string | null; absorb: number }
  healing: { items: string[]; total_hp: number; known: boolean }
  food: { count: number; best: string | null }
  light: { in_light: boolean | null; sources: number | null }
  /** 战斗区域评估（我们没有地形数据，如实标注） */
  battle_area: { terrain_known: boolean; hazards: string[]; note: string }
  retreat_route: { available: boolean; direction: { x: number; z: number } | null; note: string }
  config: CombatConfig
}

function absorbOf(ctx: SurvivalContext): number {
  let absorb = 0
  for (const item of [ctx.equipment.body, ctx.equipment.head]) {
    if (item === null) continue
    const known = ARMOR_ABSORB[item.prefab]
    if (known !== undefined) absorb = Math.max(absorb, known)
  }
  return absorb
}

function armorUsable(item: { prefab: string; armorPercent: number | null } | null): boolean {
  if (item === null) return false
  if (item.armorPercent === null) return true // 拿不到耐久就不当阻断项
  return item.armorPercent > 5
}

export function assessReadiness(ctx: SurvivalContext, overrides: Partial<CombatConfig> = {}): CombatReadiness {
  const config: CombatConfig = { ...DEFAULT_COMBAT_CONFIG, ...overrides }
  const checks: ReadinessCheck[] = []
  const blockers: string[] = []
  const warnings: string[] = []

  const add = (check: ReadinessCheck) => {
    checks.push(check)
    if (!check.ok && check.severity === 'blocker') blockers.push(check.label)
    if (!check.ok && check.severity === 'warning') warnings.push(check.label)
  }

  // ① 生命
  const hp = ctx.player.healthPercent
  add({
    key: 'health',
    label: '生命值',
    ok: hp !== null && hp >= config.base_hp_threshold,
    severity: 'blocker',
    detail: hp === null ? '拿不到生命值' : `${hp}%（开打底线 ${config.base_hp_threshold}%，硬底线 ${config.hard_min_hp}%）`,
  })

  // ② 饥饿 / ③ 理智
  const hunger = ctx.player.hungerPercent
  add({
    key: 'hunger',
    label: '饥饿值',
    ok: hunger !== null && hunger >= config.min_hunger_percent,
    severity: 'warning',
    detail: hunger === null ? '拿不到饥饿值' : `${hunger}%（低于 ${config.min_hunger_percent}% 会边打边掉血上限）`,
  })
  const sanity = ctx.player.sanityPercent
  add({
    key: 'sanity',
    label: '理智值',
    ok: sanity !== null && sanity >= config.min_sanity_percent,
    severity: 'warning',
    detail: sanity === null ? '拿不到理智值' : `${sanity}%`,
  })

  // ④ 体温
  const temp = ctx.player.temperature
  add({
    key: 'temperature',
    label: '体温',
    ok: temp === null ? false : temp >= config.temperature_ok[0] && temp <= config.temperature_ok[1],
    severity: 'warning',
    detail: temp === null ? '拿不到体温' : `${temp}℃（可接受 ${config.temperature_ok[0]}~${config.temperature_ok[1]}℃）`,
  })

  // ⑤ 武器
  const hands = ctx.equipment.hands
  const weaponDamage = hands === null ? null : WEAPON_DAMAGE[hands.prefab] ?? null
  add({
    key: 'weapon',
    label: '武器',
    ok: weaponDamage !== null && weaponDamage >= config.min_weapon_damage,
    severity: 'blocker',
    detail: hands === null
      ? '手上没有武器'
      : weaponDamage === null
        ? `手持 ${hands.prefab}（伤害未知，无法确认是否够用）`
        : `${hands.prefab} 约 ${weaponDamage} 伤害（要求 ≥ ${config.min_weapon_damage}）`,
  })

  // ⑥ 护甲
  const bodyUsable = armorUsable(ctx.equipment.body)
  const headUsable = armorUsable(ctx.equipment.head)
  const absorb = absorbOf(ctx)
  add({
    key: 'armor',
    label: '护甲',
    ok: bodyUsable || headUsable,
    severity: 'blocker',
    detail: `${ctx.equipment.body === null ? '身上无护甲' : `身体 ${ctx.equipment.body.prefab}（${ctx.equipment.body.armorPercent ?? '?'}%）`}；${
      ctx.equipment.head === null ? '头部无护甲' : `头部 ${ctx.equipment.head.prefab}（${ctx.equipment.head.armorPercent ?? '?'}%）`
    }；估算减伤 ${Math.round(absorb * 100)}%`,
  })

  // ⑦ 治疗物品
  let healingTotal = 0
  const healingItems: string[] = []
  let healingKnown = true
  for (const item of ctx.inventory) {
    const value = HEALING_ITEMS[item.prefab]
    if (value === undefined) continue
    healingItems.push(`${item.prefab}×${item.count}`)
    healingTotal += value * item.count
  }
  if (ctx.inventory.length === 0) healingKnown = false
  add({
    key: 'healing',
    label: '治疗物品',
    ok: healingKnown && healingTotal >= config.min_healing_hp,
    severity: healingKnown ? 'blocker' : 'warning',
    detail: healingKnown
      ? `${healingItems.length === 0 ? '没有' : healingItems.join('/')}，合计约 ${healingTotal} 点（要求 ≥ ${config.min_healing_hp}）`
      : '背包数据为空，无法确认治疗物品',
  })

  // ⑧ 食物
  const foodPrefabs = ['berries', 'carrot', 'corn', 'mushroom', 'red_cap', 'green_cap', 'blue_cap', 'meat', 'cookedmeat', 'monstermeat', 'seeds', 'honey', 'fish']
  const food = ctx.inventory.filter((item) => foodPrefabs.includes(item.prefab))
  const foodCount = food.reduce((acc, item) => acc + item.count, 0)
  add({
    key: 'food',
    label: '食物储备',
    ok: foodCount >= 2,
    severity: 'warning',
    detail: `背包里 ${foodCount} 个可吃的东西`,
  })

  // ⑨ 光源（夜间必须）
  const isNight = ctx.world.isNight === true
  const inLight = ctx.environment.inLight
  add({
    key: 'light',
    label: '光源',
    ok: isNight ? inLight !== false : true,
    severity: 'blocker',
    detail: isNight
      ? inLight === null
        ? '夜间，但拿不到光照状态'
        : inLight
          ? '夜间且在光照内'
          : '夜间且不在光照内（打起来理智会掉光）'
      : '白天，不需要额外光源',
  })

  // ⑩ 敌人数量与能力（由 threat 层给，这里只做数量门槛）
  const enemyCount = ctx.threats.filter((threat) => threat.sleeping !== true).length
  const maxCount = config.max_engage_count + (absorb >= 0.8 ? 1 : 0)
  add({
    key: 'enemy_count',
    label: '敌人数量',
    ok: enemyCount === 0 || enemyCount <= maxCount,
    severity: 'blocker',
    detail: `同时 ${enemyCount} 个活跃敌人（本次允许 ≤ ${maxCount} 个）`,
  })

  // ⑪ 数据可信度
  add({
    key: 'data',
    label: '数据可信度',
    ok: ctx.dataQuality === 'verified',
    severity: 'warning',
    detail: ctx.dataQuality === 'verified' ? '威胁与玩家数据都来自游戏实时读数' : `数据质量 ${ctx.dataQuality}（威胁信息可能缺失）`,
  })

  // 战斗区域 + 撤退路线（诚实：没有地形数据）
  const hazards: string[] = []
  if (ctx.environment.fires.some((fire) => fire.fuelPercent !== null && fire.fuelPercent < 20)) {
    hazards.push('附近火堆快灭了')
  }
  if (ctx.world.isRaining === true) hazards.push('正在下雨（火把/火堆受影响）')
  if (ctx.threats.some((threat) => threat.is_boss)) hazards.push('Boss 级目标')

  const threatTiles = ctx.threats
    .map((threat) => ({ x: threat.tile_x, z: threat.tile_z }))
    .filter((tile): tile is { x: number; z: number } => tile.x !== null && tile.z !== null)
  let retreatDirection: { x: number; z: number } | null = null
  if (ctx.player.tile !== null && ctx.player.tile.x !== null && ctx.player.tile.z !== null) {
    const px = ctx.player.tile.x
    const pz = ctx.player.tile.z
    let dx = 0
    let dz = 0
    for (const tile of threatTiles) {
      const vx = px - tile.x
      const vz = pz - tile.z
      const len = Math.hypot(vx, vz) || 1
      dx += vx / len
      dz += vz / len
    }
    if (dx !== 0 || dz !== 0) {
      const len = Math.hypot(dx, dz) || 1
      retreatDirection = { x: Math.round((px + (dx / len) * 10) * 10) / 10, z: Math.round((pz + (dz / len) * 10) * 10) / 10 }
    }
  }

  const scoreParts = checks.filter((check) => check.severity !== 'info')
  const passed = scoreParts.filter((check) => check.ok).length
  const score = scoreParts.length === 0 ? 0 : Math.round((passed / scoreParts.length) * 100)

  return {
    ready: blockers.length === 0,
    score,
    checks,
    blockers,
    warnings,
    weapon: {
      prefab: hands?.prefab ?? null,
      damage: weaponDamage,
      source: hands === null ? 'none' : weaponDamage === null ? 'unknown' : 'equipped',
    },
    armor: {
      body: ctx.equipment.body?.prefab ?? null,
      head: ctx.equipment.head?.prefab ?? null,
      absorb,
    },
    healing: { items: healingItems, total_hp: healingTotal, known: healingKnown },
    food: { count: foodCount, best: food[0]?.prefab ?? null },
    light: { in_light: inLight, sources: ctx.environment.lightSources },
    battle_area: {
      terrain_known: false,
      hazards,
      note: '没有地形/可通行性数据：走位由游戏自身寻路处理，这里只记录已知危险',
    },
    retreat_route: {
      // 没有威胁 = 任何方向都能走；有威胁但没有坐标 = 算不出方向（如实报 false）
      available: threatTiles.length === 0 || retreatDirection !== null,
      direction: retreatDirection,
      note: retreatDirection !== null
        ? '方向 = 背离所有已知威胁的合向量，10 格之外'
        : threatTiles.length === 0
          ? '附近没有敌人：任何方向都是安全的'
          : '拿不到坐标，无法给出撤退方向',
    },
    config,
  }
}

export type CombatDecisionKind = 'ENGAGE' | 'PREPARE' | 'EVADE' | 'RETREAT'

export interface CombatPolicy {
  /** 第一版固定 SUPERVISED_COMBAT */
  mode: 'SUPERVISED_COMBAT' | 'AUTONOMOUS'
  requires_confirmation: boolean
  /** 程序能否自动执行（本阶段恒 false：撤退/躲避也要人授权后才下发） */
  auto_executable: boolean
  boss: boolean
}

export interface CombatDecision {
  decision: CombatDecisionKind
  /** 0~100 的决策把握（不是威胁分，是"这个判断有多确定"） */
  confidence: number
  policy: CombatPolicy
  reasons: string[]
  blockers: string[]
  target: { prefab: string; name: string; distance: number | null; hp_percent: number | null } | null
  /** 开打前必须满足的前置条件（给 AI/人看的清单） */
  preconditions: string[]
  /** 动态生命阈值（解释"为什么不是固定 30%"） */
  hp_threshold: number
  threat_score: number
  readiness_score: number
}

export interface CombatDecisionInput {
  ctx: SurvivalContext
  threat: ThreatAssessment
  readiness: CombatReadiness
  /** 是否已经在交战中（决定 RETREAT 还是 EVADE） */
  engaged?: boolean
  /** 明确指定的目标 prefab（来自 evaluate_combat_target） */
  target_prefab?: string | null
  config?: Partial<CombatConfig>
}

/** 动态生命阈值：不是固定值，随敌人强度与被追击程度浮动 */
export function dynamicHpThreshold(threat: ThreatAssessment, readiness: CombatReadiness, config: CombatConfig): number {
  const maxLevel = threat.targets.reduce((acc, target) => Math.max(acc, target.profile_threat_level), 0)
  const threshold = config.base_hp_threshold
    + maxLevel * config.hp_per_threat_level
    + threat.chasing_count * config.hp_per_chaser
    - readiness.armor.absorb * config.armor_threshold_relief
  return Math.round(Math.max(config.hard_min_hp, Math.min(75, threshold)))
}

export function decideCombat(input: CombatDecisionInput): CombatDecision {
  const config: CombatConfig = { ...DEFAULT_COMBAT_CONFIG, ...(input.config ?? {}) }
  const { ctx, threat, readiness } = input
  const engaged = input.engaged === true
  const reasons: string[] = []
  const preconditions: string[] = []
  const hp = ctx.player.healthPercent
  const threshold = dynamicHpThreshold(threat, readiness, config)
  const isBossFight = threat.boss_present || (typeof input.target_prefab === 'string' && isBossPrefab(input.target_prefab))

  const policy: CombatPolicy = {
    mode: 'SUPERVISED_COMBAT',
    requires_confirmation: true,
    auto_executable: false,
    boss: threat.boss_present,
  }

  const target = threat.primary === null
    ? null
    : {
        prefab: threat.primary.prefab,
        name: threat.primary.name,
        distance: threat.primary.distance,
        hp_percent: threat.primary.hp_percent,
      }

  const finish = (decision: CombatDecisionKind, confidence: number): CombatDecision => ({
    decision,
    confidence,
    policy,
    reasons,
    blockers: readiness.blockers,
    target,
    preconditions,
    hp_threshold: threshold,
    threat_score: threat.score,
    readiness_score: readiness.score,
  })

  // ① 已经死了 / 数据不足：绝不进入战斗
  if (ctx.player.dead || ctx.player.isGhost) {
    reasons.push('角色已死亡/幽灵状态：任何战斗都无意义')
    return finish('RETREAT', 100)
  }
  if (!threat.data_ok) {
    reasons.push('数据不足以评估威胁（拿不到生命值或威胁列表）：按规则拒绝进入战斗')
    return finish('RETREAT', 90)
  }

  // ② Boss：默认避战；只有"专门指定打这个 Boss 且准备齐全"才给 PREPARE/ENGAGE 报告
  if (isBossFight) {
    if (input.target_prefab !== null && input.target_prefab !== undefined && threat.targets.some((t) => t.prefab === input.target_prefab)) {
      if (readiness.ready && (hp ?? 0) >= 60) {
        reasons.push('目标是 Boss 且准备齐全：可以进入人工监督战斗（必须人工确认，程序不会自动开打）')
        preconditions.push('人工确认后才会下发 start_combat', '战斗期间保持 2 秒一次的控制权复核')
        return finish('ENGAGE', 55)
      }
      reasons.push('目标是 Boss，但准备不齐：先按 Boss Planner 的清单准备')
      preconditions.push(...readiness.blockers)
      return finish('PREPARE', 70)
    }
    reasons.push('附近出现 Boss：第一版一律避战（不主动开打）')
    return finish('RETREAT', 85)
  }

  // ③ 生命低于动态阈值：撤（打起来了就是 RETREAT，还没打就是 EVADE）
  if (hp !== null && hp <= threshold) {
    reasons.push(`生命 ${hp}% ≤ 动态阈值 ${threshold}%（由威胁等级/追击数量/护甲减伤算出）`)
    return finish(engaged ? 'RETREAT' : 'EVADE', 90)
  }
  if (hp !== null && hp < config.hard_min_hp) {
    reasons.push(`生命 ${hp}% 低于硬底线 ${config.hard_min_hp}%：不打`)
    return finish(engaged ? 'RETREAT' : 'EVADE', 95)
  }

  // ④ 被围攻 / 数量超限
  const absorb = readiness.armor.absorb
  const maxCount = config.max_engage_count + (absorb >= 0.8 ? 1 : 0)
  if (threat.hostile_count > maxCount) {
    reasons.push(`同时 ${threat.hostile_count} 个敌人，超过可应对上限 ${maxCount}：先脱离再单杀`)
    return finish(engaged ? 'RETREAT' : 'EVADE', 85)
  }

  // ⑤ 未验证敌人：不给开打许可（保守避战）
  if (threat.unknown_enemies.length > 0) {
    reasons.push(`有未验证档案的敌人（${threat.unknown_enemies.join('/')}）：按规则不允许自动交战`)
    return finish(engaged ? 'RETREAT' : 'EVADE', 80)
  }

  // ⑥ 准备不足 → PREPARE
  if (!readiness.ready) {
    reasons.push(`战前检查没有全过：${readiness.blockers.join('、')}`)
    preconditions.push(...readiness.blockers)
    return finish('PREPARE', 75)
  }

  // ⑦ 可以打，但只给人看、要人确认
  reasons.push(`准备齐全（${readiness.score}/100），威胁 ${threat.score}/100（${threat.level}），可以进入人工监督战斗`)
  if (threat.targets.some((t) => t.recommended_strategy === 'avoid')) {
    reasons.push('注意：其中有敌人的档案建议是"避战"，人工确认前请再考虑')
  }
  preconditions.push('start_combat 必须带 confirmed=true（SUPERVISED_COMBAT）')
  preconditions.push(`低于 ${threshold}% 生命会自动脱离`)
  return finish('ENGAGE', Math.min(90, 40 + Math.round(readiness.score / 2)))
}
