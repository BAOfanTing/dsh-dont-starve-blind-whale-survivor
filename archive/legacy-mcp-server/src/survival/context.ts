// Phase 6 · 把 Bridge 快照翻译成决策层的 `SurvivalContext`
//
// 这一层是"唯一"读原始 JSON 的地方：上层决策模块只吃类型化对象。
// 原则：
//   · 拿不到 → null（绝不填 0/默认值假装有数据）；
//   · 威胁数据优先用 Lua 的 threats 段（有实时战斗状态），没有就降级用 nearby 里的 hostile，
//     并在 `threatsMeta.source` / `dataQuality` 里如实标注降级；
//   · 数据新鲜度由工具层传进来（这一层不判断"新不新"，只说"有没有"）。

import { asList, asDict, asNum, asStr, asBool, parseItems, type Dict } from '../tools/snapshot.js'
import type {
  DataQuality,
  EnvironmentView,
  EquipmentView,
  InventoryItemView,
  PlayerVitals,
  SurvivalContext,
  ThreatEntity,
  WorldView,
} from './types.js'

function boolOrNull(value: unknown): boolean | null {
  const b = asBool(value)
  return b
}

function parseEquipped(value: unknown) {
  const dict = asDict(value)
  if (dict === null) return null
  const prefab = asStr(dict.prefab)
  if (prefab === null) return null
  return {
    prefab,
    armorPercent: asNum(dict.armor_percent) ?? asNum(dict.armor),
    usesLeft: asNum(dict.uses_left),
  }
}

export function parsePlayer(snapshot: Dict): PlayerVitals {
  const player = asDict(snapshot.player)
  if (player === null) {
    return {
      healthPercent: null,
      hungerPercent: null,
      sanityPercent: null,
      temperature: null,
      wetnessPercent: null,
      dead: false,
      isGhost: false,
      tile: null,
      worldPosition: null,
      prefab: null,
    }
  }
  const pos = asDict(player.position)
  const health = asDict(player.health)
  const hunger = asDict(player.hunger)
  const sanity = asDict(player.sanity)
  const temp = asDict(player.temperature)
  const moisture = asDict(player.moisture)
  return {
    healthPercent: asNum(health?.percent),
    hungerPercent: asNum(hunger?.percent),
    sanityPercent: asNum(sanity?.percent),
    temperature: asNum(temp?.current),
    wetnessPercent: asNum(moisture?.percent),
    dead: asBool(health?.dead) === true,
    isGhost: asBool(player.is_ghost) === true,
    tile: pos === null ? null : { x: asNum(pos.tile_x), z: asNum(pos.tile_z) },
    worldPosition: pos === null ? null : { x: asNum(pos.x), z: asNum(pos.z) },
    prefab: asStr(player.prefab),
  }
}

export function parseEquipment(snapshot: Dict): EquipmentView {
  const inventory = asDict(snapshot.inventory)
  const equipment = asDict(inventory?.equipment)
  return {
    hands: parseEquipped(equipment?.hands),
    body: parseEquipped(equipment?.body),
    head: parseEquipped(equipment?.head),
  }
}

export function parseInventory(snapshot: Dict): InventoryItemView[] {
  const inventory = asDict(snapshot.inventory)
  return parseItems(inventory).map((item) => ({
    prefab: item.prefab,
    name: item.name,
    count: item.count,
    freshness: item.freshness,
    fuel: item.fuel,
    armor: item.armor,
    usesLeft: item.uses_left,
  }))
}

export function parseWorld(snapshot: Dict): WorldView {
  const world = asDict(snapshot.world)
  const weather = asDict(world?.weather)
  return {
    season: asStr(world?.season),
    day: asNum(world?.day),
    elapsedDaysInSeason: asNum(world?.elapsed_days_in_season),
    remainingDaysInSeason: asNum(world?.remaining_days_in_season),
    isDay: boolOrNull(world?.is_day),
    isDusk: boolOrNull(world?.is_dusk),
    isNight: boolOrNull(world?.is_night),
    temperature: asNum(world?.temperature),
    isRaining: boolOrNull(weather?.is_raining),
    isSnowing: boolOrNull(weather?.is_snowing),
    wetness: asNum(weather?.wetness),
    seasonFlags: {
      autumn: boolOrNull(world?.is_autumn),
      winter: boolOrNull(world?.is_winter),
      spring: boolOrNull(world?.is_spring),
      summer: boolOrNull(world?.is_summer),
    },
  }
}

/** 附近结构物数量（"像不像基地"的启发式输入）；没有 nearby 段返回 null */
export function parseNearbyStructureCount(snapshot: Dict): number | null {
  const nearby = asDict(snapshot.nearby)
  if (nearby === null) return null
  const entities = asList(nearby.entities)
  let count = 0
  let seen = 0
  for (const item of entities) {
    const dict = asDict(item)
    if (dict === null) continue
    seen += 1
    if (asStr(dict.category) === 'structure') count += 1
  }
  if (seen === 0) return null
  return count
}

export function parseEnvironment(snapshot: Dict): EnvironmentView {
  const env = asDict(snapshot.environment)
  const firesRaw = asList(env?.nearby_fires)
  const fires: Array<{ prefab: string; fuelPercent: number | null }> = []
  for (const item of firesRaw) {
    const dict = asDict(item)
    const prefab = asStr(dict?.prefab)
    if (prefab === null) continue
    fires.push({ prefab, fuelPercent: asNum(dict?.fuel_percent) })
  }
  return {
    lightSources: asNum(env?.light_sources_within_8),
    inLight: boolOrNull(env?.in_light),
    fires,
    shard: asStr(asDict(snapshot.observer)?.shard) ?? asStr(snapshot.shard),
  }
}

/** 威胁列表：优先 threats 段（实时战斗状态），否则从 nearby 降级 */
export function parseThreats(snapshot: Dict): { threats: ThreatEntity[]; meta: SurvivalContext['threatsMeta'] } {
  const block = asDict(snapshot.threats)
  if (block !== null) {
    const list = asList(block.threats)
    const threats: ThreatEntity[] = []
    for (const item of list) {
      const dict = asDict(item)
      const prefab = asStr(dict?.prefab)
      if (prefab === null) continue
      threats.push({
        prefab,
        name: asStr(dict?.name),
        distance: asNum(dict?.distance),
        tile_x: asNum(dict?.tile_x),
        tile_z: asNum(dict?.tile_z),
        hp: asNum(dict?.hp),
        is_boss: asBool(dict?.is_boss) === true,
        targeting_player: boolOrNull(dict?.targeting_player),
        attacking: boolOrNull(dict?.attacking),
        can_attack_player: boolOrNull(dict?.can_attack_player),
        attack_range: asNum(dict?.attack_range),
        attack_period: asNum(dict?.attack_period),
        attack_damage: asNum(dict?.attack_damage),
        sleeping: boolOrNull(dict?.sleeping),
        source: 'threat_block',
      })
    }
    threats.sort((a, b) => (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY))
    return {
      threats,
      meta: {
        available: true,
        hostileCount: asNum(block.hostile_count),
        chasingCount: asNum(block.chasing_count),
        attackingCount: asNum(block.attacking_count),
        bossCount: asNum(block.boss_count),
        scannedRadiusTiles: asNum(block.radius_tiles),
        scannedAtTick: asNum(block.scanned_at_tick),
        source: 'threat_block',
      },
    }
  }

  // 降级：老快照只有 nearby.entities（没有战斗状态）
  const nearby = asDict(snapshot.nearby)
  const entities = asList(nearby?.entities)
  const threats: ThreatEntity[] = []
  for (const item of entities) {
    const dict = asDict(item)
    const prefab = asStr(dict?.prefab)
    const category = asStr(dict?.category)
    if (prefab === null || category !== 'hostile') continue
    threats.push({
      prefab,
      name: asStr(dict?.name),
      distance: asNum(dict?.distance),
      tile_x: asNum(dict?.tile_x),
      tile_z: asNum(dict?.tile_z),
      hp: asNum(dict?.hp),
      is_boss: false,
      targeting_player: null,
      attacking: null,
      can_attack_player: null,
      attack_range: null,
      attack_period: null,
      attack_damage: null,
      sleeping: null,
      source: 'nearby_fallback',
    })
  }
  threats.sort((a, b) => (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY))
  return {
    threats,
    meta: {
      available: nearby !== null,
      hostileCount: threats.length,
      chasingCount: null,
      attackingCount: null,
      bossCount: null,
      scannedRadiusTiles: asNum(nearby?.radius_tiles),
      scannedAtTick: asNum(nearby?.scanned_at_tick),
      source: threats.length > 0 ? 'nearby_fallback' : 'none',
    },
  }
}

/** 组装完整的决策上下文 */
export function buildContext(
  snapshot: Dict,
  options: { freshnessLine?: string; sessionId?: string | null } = {},
): SurvivalContext {
  const player = parsePlayer(snapshot)
  const world = parseWorld(snapshot)
  const environment = parseEnvironment(snapshot)
  const equipment = parseEquipment(snapshot)
  const inventory = parseInventory(snapshot)
  const { threats, meta } = parseThreats(snapshot)

  const nearest = threats.length > 0
    ? threats.reduce<number | null>((acc, threat) => {
        if (threat.distance === null) return acc
        if (acc === null) return threat.distance
        return Math.min(acc, threat.distance)
      }, null)
    : null

  // 数据质量：有玩家读数 + 有威胁段（或明确"没有敌人"）才算 verified
  let dataQuality: DataQuality = 'unverified'
  const hasVitals = player.healthPercent !== null
  const hasThreatInfo = meta.available === true
  if (hasVitals && hasThreatInfo && meta.source === 'threat_block') dataQuality = 'verified'
  else if (hasVitals && hasThreatInfo) dataQuality = 'partial'
  else if (hasVitals) dataQuality = 'partial'

  return {
    player,
    equipment,
    inventory,
    world,
    environment,
    threats,
    threatsMeta: meta,
    nearestThreatDistance: nearest,
    nearbyStructures: parseNearbyStructureCount(snapshot),
    dataQuality,
    freshnessLine: options.freshnessLine ?? '',
    sessionId: options.sessionId ?? null,
    shard: environment.shard ?? null,
  }
}
