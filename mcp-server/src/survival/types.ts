// Phase 6 · 决策层共享输入/输出类型
//
// 设计原则：
//   · 所有决策模块（威胁/战斗/规避/季节/Boss/仲裁）都吃同一份 `SurvivalContext`，
//     这样"程序层规则"只在一处解析数据，工具层只负责组装与表达；
//   · 每个输入字段都允许为 null —— 游戏给不出就是 null，**绝不猜**。
//     模块遇到 null 时必须降级成"数据不足"而不是编一个值（任务书 §14.12）。

export interface ThreatEntity {
  prefab: string
  name: string | null
  distance: number | null
  tile_x: number | null
  tile_z: number | null
  hp: number | null
  is_boss: boolean
  /** 是否正在追玩家（combat.target == player） */
  targeting_player: boolean | null
  /** 是否正处于出手动作（sg 有 attack 标签） */
  attacking: boolean | null
  /** 现在能不能打到玩家（combat:CanAttack） */
  can_attack_player: boolean | null
  attack_range: number | null
  attack_period: number | null
  attack_damage: number | null
  sleeping: boolean | null
  /** 数据从哪来：threat_block（Lua 威胁扫描）还是 nearby_fallback（老快照降级） */
  source: 'threat_block' | 'nearby_fallback'
}

export interface PlayerVitals {
  healthPercent: number | null
  hungerPercent: number | null
  sanityPercent: number | null
  temperature: number | null
  wetnessPercent: number | null
  dead: boolean
  isGhost: boolean
  tile: { x: number | null; z: number | null } | null
  worldPosition: { x: number | null; z: number | null } | null
  prefab: string | null
}

export interface EquippedItemView {
  prefab: string
  armorPercent: number | null
  usesLeft: number | null
}

export interface EquipmentView {
  hands: EquippedItemView | null
  body: EquippedItemView | null
  head: EquippedItemView | null
}

export interface InventoryItemView {
  prefab: string
  name: string | null
  count: number
  freshness: number | null
  fuel: number | null
  armor: number | null
  usesLeft: number | null
}

export interface WorldView {
  /** 游戏原始的 season 字段（autumn/winter/spring/summer），拿不到就是 null */
  season: string | null
  day: number | null
  elapsedDaysInSeason: number | null
  remainingDaysInSeason: number | null
  isDay: boolean | null
  isDusk: boolean | null
  isNight: boolean | null
  temperature: number | null
  isRaining: boolean | null
  isSnowing: boolean | null
  wetness: number | null
  /** 游戏自带的四季布尔开关（season 字段缺失时用它兜底判断） */
  seasonFlags: {
    autumn: boolean | null
    winter: boolean | null
    spring: boolean | null
    summer: boolean | null
  }
}

export interface EnvironmentView {
  lightSources: number | null
  inLight: boolean | null
  fires: Array<{ prefab: string; fuelPercent: number | null }>
  shard: string | null
}

/** 数据够了没有：决定上层能不能下结论 */
export type DataQuality = 'verified' | 'partial' | 'unverified'

export interface SurvivalContext {
  player: PlayerVitals
  equipment: EquipmentView
  inventory: InventoryItemView[]
  world: WorldView
  environment: EnvironmentView
  threats: ThreatEntity[]
  threatsMeta: {
    available: boolean
    hostileCount: number | null
    chasingCount: number | null
    attackingCount: number | null
    bossCount: number | null
    scannedRadiusTiles: number | null
    scannedAtTick: number | null
    source: 'threat_block' | 'nearby_fallback' | 'none'
  }
  /** 视野内最近威胁距离（格） */
  nearestThreatDistance: number | null
  /** 附近结构物数量（判定"有没有基地"的启发式输入；null = 没有扫描数据） */
  nearbyStructures: number | null
  dataQuality: DataQuality
  /** 数据新鲜度（由工具层填） */
  freshnessLine: string
  /** 玩家所在会话（有的话） */
  sessionId: string | null
  shard: string | null
}

/** 武器伤害估算（档案值；没有实时读数时用它评估"打不打得动"） */
export const WEAPON_DAMAGE: Readonly<Record<string, number>> = Object.freeze({
  spear: 34,
  golden_spear: 34,
  hambat: 59,
  tentaclespike: 51,
  nightsword: 68,
  glasscutter: 68,
  axe: 27.2,
  goldenaxe: 27.2,
  pickaxe: 27.2,
  goldenpickaxe: 27.2,
  hammer: 17,
  torch: 17,
  boomerang: 27.2,
  blowdart_sleep: 0,
  blowdart_fire: 0,
})

/** 护甲减伤（档案值，取"能否扛住 N 下"用的近似） */
export const ARMOR_ABSORB: Readonly<Record<string, number>> = Object.freeze({
  armorwood: 0.8,
  armor_sanity: 0.8,
  armorruins: 0.9,
  footballhat: 0.8,
  armor_skeleton: 0.8,
  beehat: 0.7,
  strawhat: 0.2,
  footballhelmet: 0.8,
  winterhat: 0.2,
})

/** 治疗物品与它们的恢复量（档案值，用于"够不够治一次"的判断） */
export const HEALING_ITEMS: Readonly<Record<string, number>> = Object.freeze({
  healingpotion: 20,
  healingsalve: 20,
  honey: 30,
  honeyham: 30,
  dragonpie: 40,
  trailmix: 30,
  butterflymuffin: 20,
  spider_gland: 8,
  gears: 60,
})
