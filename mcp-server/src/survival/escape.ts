// Phase 6 M2 · Escape Planner（危险规避）
//
// 独立于战斗系统：即使这一局根本没打算打怪，也得会跑。
// 覆盖任务书 §7 列的七类危险：敌对生物 / 群体 / Boss / 黑夜无光 / 低温 / 高温 / 火灾 / 闪电降雨。
//
// 输出的是"选项 + 方向 + 建议动作"，**不直接执行**：
//   · 撤退/躲避在明确授权后可自动执行（`auto_allowed: true`，由上层确认后下发 Lua 命令）；
//   · 光源/取暖/降温/防火这类要动背包的动作一律需要人工确认（auto_allowed: false）。
//
// 需要如实说明的限制：我们**没有**地形、可通行性、地图数据。
// 方向只是"背离威胁的合向量"，真正绕障碍是游戏自己的寻路（locomotor）在做。
// 所以这里的 confidence 最高只给 medium，并且 notes 里写清楚。

import { getEnemyProfile } from './profiles.js'
import type { SurvivalContext } from './types.js'

export type EscapeKind =
  | 'retreat_enemies'
  | 'evade_group'
  | 'boss_avoid'
  | 'darkness_light'
  | 'cold'
  | 'heat'
  | 'fire'
  | 'lightning_rain'
  | 'none'

export interface EscapeOption {
  kind: EscapeKind
  /** 越大越紧急 */
  priority: number
  urgency: 'P0' | 'P1' | 'P2'
  /** 建议走到的格子坐标（世界格），没有就是 null */
  direction: { x: number; z: number } | null
  distance_tiles: number | null
  /** 建议使用的工具名（都是已实现的工具） */
  actions: string[]
  reason: string
  risk: string
  /** 明确授权后可自动执行（本阶段只有撤退/躲避为 true） */
  auto_allowed: boolean
  confidence: 'high' | 'medium' | 'low'
}

export interface EscapePlan {
  data_ok: boolean
  situation: {
    hostile_count: number
    chasing_count: number
    nearest_distance: number | null
    boss_present: boolean
    is_night: boolean | null
    in_light: boolean | null
    player_temperature: number | null
    wetness: number | null
    is_raining: boolean | null
    nearest_fire_fuel: number | null
    tile: { x: number | null; z: number | null } | null
  }
  options: EscapeOption[]
  best: EscapeOption | null
  /** 是否建议中断当前的普通任务（采集/探索） */
  interrupt_current_task: boolean
  notes: string[]
}

export interface EscapeOptions {
  /** 营地格子坐标（有就优先往营地跑） */
  camp?: { x: number; z: number } | null
  /** 逃生目标距离（格） */
  flee_distance_tiles?: number
  /** 低温/高温阈值（℃） */
  cold_threshold?: number
  heat_threshold?: number
}

const CANDIDATE_DIRECTIONS: Array<{ label: string; dx: number; dz: number }> = [
  { label: '北', dx: 0, dz: 1 },
  { label: '东北', dx: 0.707, dz: 0.707 },
  { label: '东', dx: 1, dz: 0 },
  { label: '东南', dx: 0.707, dz: -0.707 },
  { label: '南', dx: 0, dz: -1 },
  { label: '西南', dx: -0.707, dz: -0.707 },
  { label: '西', dx: -1, dz: 0 },
  { label: '西北', dx: -0.707, dz: 0.707 },
]

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 选一个"离所有威胁最远"的方向（同时考虑营地） */
function pickFleeDirection(
  ctx: SurvivalContext,
  distanceTiles: number,
  camp: { x: number; z: number } | null,
): { direction: { x: number; z: number } | null; label: string | null; minDistance: number | null } {
  const px = ctx.player.tile?.x ?? null
  const pz = ctx.player.tile?.z ?? null
  if (px === null || pz === null) return { direction: null, label: null, minDistance: null }

  const threats = ctx.threats
    .map((threat) => ({ x: threat.tile_x, z: threat.tile_z }))
    .filter((tile): tile is { x: number; z: number } => tile.x !== null && tile.z !== null)

  if (threats.length === 0) {
    return { direction: { x: px, z: pz + distanceTiles }, label: '北', minDistance: null }
  }

  let best: { label: string; x: number; z: number; score: number; minDistance: number } | null = null
  for (const candidate of CANDIDATE_DIRECTIONS) {
    const x = px + candidate.dx * distanceTiles
    const z = pz + candidate.dz * distanceTiles
    let minDistance = Number.POSITIVE_INFINITY
    for (const threat of threats) {
      const d = Math.hypot(threat.x - x, threat.z - z)
      if (d < minDistance) minDistance = d
    }
    // 逃跑方向也要考虑"别跑到营地反方向太远"
    let score = minDistance
    if (camp !== null) {
      const campDistance = Math.hypot(camp.x - x, camp.z - z)
      score -= campDistance * 0.15
    }
    if (best === null || score > best.score) {
      best = { label: candidate.label, x: round1(x), z: round1(z), score, minDistance }
    }
  }
  if (best === null) return { direction: null, label: null, minDistance: null }
  return { direction: { x: best.x, z: best.z }, label: best.label, minDistance: round1(best.minDistance) }
}

export function planEscape(ctx: SurvivalContext, options: EscapeOptions = {}): EscapePlan {
  const fleeDistance = options.flee_distance_tiles ?? 12
  const coldThreshold = options.cold_threshold ?? 0
  const heatThreshold = options.heat_threshold ?? 65
  const camp = options.camp ?? null
  const notes: string[] = []
  const list: EscapeOption[] = []

  const active = ctx.threats.filter((threat) => threat.sleeping !== true)
  const hostileCount = active.length
  const chasingCount = active.filter((threat) => threat.targeting_player === true).length
  const bossPresent = active.some((threat) => threat.is_boss)
  const flee = pickFleeDirection(ctx, fleeDistance, camp)
  const nearestFire = ctx.environment.fires.length > 0
    ? Math.min(...ctx.environment.fires.map((fire) => fire.fuelPercent ?? 100))
    : null

  // ① 黑夜没光：最致命的一类（Charlie 会直接杀）
  if (ctx.world.isNight === true && ctx.environment.inLight === false) {
    list.push({
      kind: 'darkness_light',
      priority: 100,
      urgency: 'P0',
      direction: null,
      distance_tiles: null,
      actions: ['equip_item(torch)', 'craft_item(torch)', 'build_campfire'],
      reason: '夜间且不在光照范围内：再不点灯就会被暗影生物攻击',
      risk: '现做火把要 2 草 2 枝，材料不够就得往火堆方向跑',
      auto_allowed: false,
      confidence: 'high',
    })
    notes.push('光源状态来自引擎 Light 组件统计（light_sources_within_8）；为 0 且 in_light=false 才判定黑暗')
  } else if (ctx.world.isDusk === true && ctx.environment.inLight === false
    && !ctx.inventory.some((item) => ['torch', 'lantern', 'minerhat', 'pumpkin_lantern'].includes(item.prefab))
    && (ctx.environment.lightSources ?? 0) === 0) {
    // 真机发现（2026-11-12）：只判 is_night 会漏掉黄昏 —— 等真黑了才报警，那时已经在挨打了。
    // 黄昏 + 没光 + 背包里也没有光源 = 现在就该备好，而不是等到夜里。
    list.push({
      kind: 'darkness_light',
      priority: 65,
      urgency: 'P2',
      direction: null,
      distance_tiles: null,
      actions: ['gather_resource', 'craft_item', 'build_campfire', 'move_to_target'],
      reason: '黄昏了、不在光照内、背包里也没有光源：太阳一落就会挨暗影生物的攻击',
      risk: '现在做火把要 2 草 2 枝 / 营火要 3 草 2 木；材料不够就得先往基地/火堆方向走',
      auto_allowed: false,
      confidence: 'high',
    })
  }

  // ② 低温 / ③ 高温
  const temp = ctx.player.temperature
  if (temp !== null && temp <= coldThreshold) {
    list.push({
      kind: 'cold',
      priority: 95,
      urgency: 'P0',
      direction: nearestFire !== null ? null : flee.direction,
      distance_tiles: nearestFire !== null ? null : fleeDistance,
      actions: nearestFire !== null ? ['build_campfire', 'add_fuel'] : ['build_campfire', 'equip_item(winter_hat)'],
      reason: `体温 ${temp}℃ 已进入寒冷区：先保暖再谈其他`,
      risk: '寒冷会持续掉血，且夜里找柴火很危险',
      auto_allowed: false,
      confidence: 'high',
    })
  } else if (temp !== null && temp > coldThreshold && temp <= coldThreshold + 8) {
    notes.push(`体温 ${temp}℃ 接近寒冷线，注意保暖装备`)
  }
  if (temp !== null && temp >= heatThreshold) {
    list.push({
      kind: 'heat',
      priority: 93,
      urgency: 'P0',
      direction: null,
      distance_tiles: null,
      actions: ['craft_item(campfire)', 'build_campfire'],
      reason: `体温 ${temp}℃ 过热：需要降温（冰火堆/阴凉/降温装备）`,
      risk: '夏季过热比寒冷更致命，掉血很快',
      auto_allowed: false,
      confidence: 'high',
    })
  }

  // ④ 群体敌人 / ⑤ 普通敌人 / ⑥ Boss
  if (bossPresent) {
    list.push({
      kind: 'boss_avoid',
      priority: 88,
      urgency: 'P0',
      direction: flee.direction,
      distance_tiles: fleeDistance,
      actions: ['retreat_from_combat', 'move_to'],
      reason: `附近有 Boss（${active.filter((t) => t.is_boss).map((t) => t.prefab).join('/')}）：第一版一律避战`,
      risk: 'Boss 会追很远，且会拆建筑；往营地反方向跑',
      auto_allowed: true,
      confidence: 'medium',
    })
  }
  if (hostileCount >= 3 || chasingCount >= 2) {
    list.push({
      kind: 'evade_group',
      priority: 85,
      urgency: 'P1',
      direction: flee.direction,
      distance_tiles: fleeDistance,
      actions: ['evade_threat', 'retreat_from_combat'],
      reason: `${hostileCount} 个敌对生物、其中 ${chasingCount} 个在追：群体战打不了，先拉开`,
      risk: '跑的过程中会被追上咬几口；尽量往开阔方向跑',
      auto_allowed: true,
      confidence: 'medium',
    })
  } else if (hostileCount > 0) {
    list.push({
      kind: 'retreat_enemies',
      priority: chasingCount > 0 ? 70 : 40,
      urgency: chasingCount > 0 ? 'P1' : 'P2',
      direction: chasingCount > 0 ? flee.direction : null,
      distance_tiles: chasingCount > 0 ? fleeDistance : null,
      actions: chasingCount > 0 ? ['retreat_from_combat'] : ['move_to'],
      reason: chasingCount > 0
        ? `${hostileCount} 个敌对生物里已有 ${chasingCount} 个在追：先脱战`
        : `${hostileCount} 个敌对生物在附近但没在追：离开这片区域即可`,
      risk: '离得近的敌人可能被惊动',
      auto_allowed: true,
      confidence: 'medium',
    })
  }

  // ⑦ 火灾风险（火堆快灭 / 附近有火）
  if (nearestFire !== null && nearestFire < 25) {
    list.push({
      kind: 'fire',
      priority: 60,
      urgency: 'P1',
      direction: null,
      distance_tiles: null,
      actions: ['build_campfire'],
      reason: `附近火堆燃料只剩 ${nearestFire}%：夜里很快会灭`,
      risk: '加燃料的动作目前没有独立工具，只能重建营火（需要 3 草 2 木）',
      auto_allowed: false,
      confidence: 'medium',
    })
  }

  // ⑧ 闪电 / 降雨
  if (ctx.world.isRaining === true) {
    const wet = ctx.player.wetnessPercent
    const rainyRisk = wet !== null && wet >= 35
    list.push({
      kind: 'lightning_rain',
      priority: rainyRisk ? 55 : 30,
      urgency: 'P2',
      direction: null,
      distance_tiles: null,
      actions: ['craft_item(campfire)', 'equip_item(torch)'],
      reason: rainyRisk
        ? `下雨且潮湿 ${wet}%：潮湿会掉体温、雷雨天还有落雷风险`
        : '正在下雨：注意别站在空旷地，火把/火堆会受影响',
      risk: '春季雷雨会随机落雷，站在水边/空旷地更危险',
      auto_allowed: false,
      confidence: 'medium',
    })
  }

  if (list.length === 0) {
    list.push({
      kind: 'none',
      priority: 0,
      urgency: 'P2',
      direction: null,
      distance_tiles: null,
      actions: [],
      reason: '当前没有需要规避的危险',
      risk: '',
      auto_allowed: false,
      confidence: 'medium',
    })
  }

  list.sort((a, b) => b.priority - a.priority)

  const best = list[0] ?? null
  const dataOk = ctx.dataQuality !== 'unverified'
  if (!dataOk) notes.push('数据质量不足：危险判断可能不完整，按"更保守"处理')
  if (!ctx.player.tile || ctx.player.tile.x === null) {
    notes.push('拿不到玩家坐标：无法给出逃跑方向，只能给动作建议')
  }
  notes.push('地形/可通行性未知：方向是"背离威胁的合向量"，实际绕障碍由游戏寻路负责')

  return {
    data_ok: dataOk,
    situation: {
      hostile_count: hostileCount,
      chasing_count: chasingCount,
      nearest_distance: ctx.nearestThreatDistance,
      boss_present: bossPresent,
      is_night: ctx.world.isNight,
      in_light: ctx.environment.inLight,
      player_temperature: temp,
      wetness: ctx.player.wetnessPercent,
      is_raining: ctx.world.isRaining,
      nearest_fire_fuel: nearestFire,
      tile: ctx.player.tile,
    },
    options: list,
    best,
    interrupt_current_task: (best?.urgency === 'P0' || best?.urgency === 'P1') && best.kind !== 'none',
    notes,
  }
}

/** 给"要不要躲"的一个粗判：给 Decision Engine 用 */
export function isImminentDanger(ctx: SurvivalContext): { danger: boolean; reason: string } {
  const active = ctx.threats.filter((threat) => threat.sleeping !== true)
  const chasing = active.filter((threat) => threat.targeting_player === true)
  if (ctx.world.isNight === true && ctx.environment.inLight === false) {
    return { danger: true, reason: '夜间没有光源' }
  }
  if (active.some((threat) => threat.is_boss && (threat.distance ?? 99) <= 12)) {
    return { danger: true, reason: 'Boss 在 12 格内' }
  }
  if (chasing.length > 0 && (ctx.nearestThreatDistance ?? 99) <= 4) {
    return { danger: true, reason: `${chasing.length} 个敌人在贴身追击` }
  }
  if (active.length >= 4) {
    return { danger: true, reason: `${active.length} 个敌对生物同时在场` }
  }
  const profiles = active.map((threat) => getEnemyProfile(threat.prefab))
  if (profiles.some((profile) => profile.threat_level >= 4 && (ctx.nearestThreatDistance ?? 99) <= 6)) {
    return { danger: true, reason: '高威胁生物在 6 格内' }
  }
  return { danger: false, reason: '没有迫在眉睫的危险' }
}
