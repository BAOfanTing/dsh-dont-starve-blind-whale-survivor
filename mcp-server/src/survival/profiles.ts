// Phase 6 · 敌人战术档案（单一事实来源）
//
// 为什么要有这张表：
//   任务书明确禁止「仅凭 prefab 名字推测攻击能力」。这份表就是"档案"本体：
//   每个可交战的生物都必须在这里有一条经过人工整理的记录，没记录的生物一律按
//   **保守避战** 处理（`unverified`），永远不进 auto_engage。
//
// 数据来源三级（字段里分别标注）：
//   1. `runtime`：游戏运行时的真实读数（threat_observer.lua 从 combat 组件读
//      attack_range / attack_period / attack_damage）。**优先级最高**，上层永远先看它；
//   2. `archive`：社区/源码整理的档案值（本文件里的数值），用于没有实时读数时兜底，
//      并在输出里标 `source: 'archive'`；
//   3. `unknown`：连档案都没有 → 保守值 + 禁止自动交战。
//
// ⚠️ 档案值（attack_period / damage）是社区数据，**不是本次真机测出来的**。
//    `verified: true` 表示"已加入自动交战白名单并通过沙盒验证"，
//    不代表"数值已被真机核对"。真机核对结果会写进 docs/phase6 的测试报告。

export type CombatProfile =
  | 'melee_light' // 轻近战
  | 'melee_heavy' // 重近战
  | 'swarm' // 群体
  | 'ranged' // 远程
  | 'tank' // 高血高防
  | 'ambush' // 伏击/固定点
  | 'boss'

export type RecommendedStrategy = 'engage' | 'kite' | 'avoid' | 'supervised_only'

export interface EnemyProfile {
  prefab: string
  /** 中文名（文本输出用；游戏里 STRINGS.NAMES 有就给游戏名） */
  name: string
  /** 1~5：1=几乎没有威胁，5=接近 Boss */
  threat_level: 1 | 2 | 3 | 4 | 5
  /** 攻击距离（格）——档案值，运行时以 combat:GetAttackRange() 为准 */
  attack_range: number
  /** 出手间隔（秒）——档案值 */
  attack_period: number
  /** 单次基础伤害（未计护甲）——档案值 */
  damage: number
  combat_profile: CombatProfile
  special_abilities: string[]
  recommended_strategy: RecommendedStrategy
  retreat_conditions: string[]
  /**
   * 是否允许自动交战（第一版只有验证过的普通敌人为 true）。
   * ⚠️ Lua 侧 combat_executor.lua 的 AUTONOMOUS_ENEMIES 必须与此完全一致，
   *    tests/phase6-lua.test.mjs 会逐项比对。
   */
  auto_engage_allowed: boolean
  /** 是否有档案（false = 只知道 prefab 名字，必须保守避战） */
  verified: boolean
  notes?: string
}

/** 默认（未知生物）档案：保守值 + 禁止自动交战 */
export const UNKNOWN_ENEMY: EnemyProfile = {
  prefab: '__unknown__',
  name: '未知生物',
  threat_level: 3,
  attack_range: 2,
  attack_period: 2,
  damage: 20,
  combat_profile: 'melee_heavy',
  special_abilities: [],
  recommended_strategy: 'avoid',
  retreat_conditions: ['没有经过验证的战斗档案：默认避战'],
  auto_engage_allowed: false,
  verified: false,
  notes: '没有档案的生物一律按保守避战处理（任务书 §3）',
}

function enemy(profile: EnemyProfile): EnemyProfile {
  return profile
}

/** 第一批普通敌人档案（auto_engage_allowed = true 的必须与 Lua 白名单一致） */
const ENEMY_LIST: EnemyProfile[] = [
  enemy({
    prefab: 'hound',
    name: '猎犬',
    threat_level: 3,
    attack_range: 2,
    attack_period: 2,
    damage: 20,
    combat_profile: 'melee_light',
    special_abilities: ['成群出现', '夜间/猎犬潮突袭'],
    recommended_strategy: 'kite',
    retreat_conditions: ['同时 ≥3 只且无护甲', '生命 < 35%', '夜间且无光源'],
    auto_engage_allowed: true,
    verified: true,
    notes: '移动快、出手快；单只可以打，成群要拉距离单杀',
  }),
  enemy({
    prefab: 'spider',
    name: '蜘蛛',
    threat_level: 2,
    attack_range: 2,
    attack_period: 3,
    damage: 20,
    combat_profile: 'swarm',
    special_abilities: ['巢穴附近成群', '战士蜘蛛会呼叫支援'],
    recommended_strategy: 'kite',
    retreat_conditions: ['蜘蛛巢在附近且数量持续增加', '生命 < 30%'],
    auto_engage_allowed: true,
    verified: true,
  }),
  enemy({
    prefab: 'spider_warrior',
    name: '战士蜘蛛',
    threat_level: 3,
    attack_range: 2,
    attack_period: 4,
    damage: 20,
    combat_profile: 'melee_heavy',
    special_abilities: ['血量高', '会呼叫蜘蛛'],
    recommended_strategy: 'kite',
    retreat_conditions: ['同场还有 ≥2 只其他蜘蛛', '无护甲'],
    auto_engage_allowed: true,
    verified: true,
  }),
  enemy({
    prefab: 'mosquito',
    name: '蚊子',
    threat_level: 1,
    attack_range: 2,
    attack_period: 2,
    damage: 3,
    combat_profile: 'swarm',
    special_abilities: ['吸血', '数量多'],
    recommended_strategy: 'engage',
    retreat_conditions: ['数量 > 5 且没有护甲'],
    auto_engage_allowed: true,
    verified: true,
  }),
  enemy({
    prefab: 'killerbee',
    name: '杀人蜂',
    threat_level: 2,
    attack_range: 2,
    attack_period: 2,
    damage: 10,
    combat_profile: 'swarm',
    special_abilities: ['成群追击', '速度快'],
    recommended_strategy: 'kite',
    retreat_conditions: ['数量 > 4', '生命 < 40%'],
    auto_engage_allowed: true,
    verified: true,
  }),
  enemy({
    prefab: 'frog',
    name: '青蛙',
    threat_level: 2,
    attack_range: 2,
    attack_period: 2,
    damage: 8,
    combat_profile: 'melee_light',
    special_abilities: ['被攻击后会呼叫同伴', '青蛙雨'],
    recommended_strategy: 'kite',
    retreat_conditions: ['同时 ≥4 只（青蛙雨）'],
    auto_engage_allowed: true,
    verified: true,
  }),
  enemy({
    prefab: 'merm',
    name: '鱼人',
    threat_level: 3,
    attack_range: 2,
    attack_period: 2,
    damage: 20,
    combat_profile: 'melee_heavy',
    special_abilities: ['沼泽成群', '鱼人守卫更强'],
    recommended_strategy: 'kite',
    retreat_conditions: ['同时 ≥2 只', '生命 < 40%'],
    auto_engage_allowed: true,
    verified: true,
  }),

  // ────────── 以下有档案，但**不允许自动交战**（第一批先避战，观察 + 人工决策）──────────
  enemy({
    prefab: 'tentacle',
    name: '触手',
    threat_level: 4,
    attack_range: 3.5,
    attack_period: 2,
    damage: 34,
    combat_profile: 'ambush',
    special_abilities: ['固定点伏击', '攻击距离比玩家长'],
    recommended_strategy: 'avoid',
    retreat_conditions: ['无法风筝（固定点 + 长手）', '生命 < 50%'],
    auto_engage_allowed: false,
    verified: true,
    notes: '打触手需要贴边等它出手后打一下，属于需要精细走位的目标，第一批不做',
  }),
  enemy({
    prefab: 'tallbird',
    name: '高鸟',
    threat_level: 4,
    attack_range: 2,
    attack_period: 2,
    damage: 50,
    combat_profile: 'melee_heavy',
    special_abilities: ['伤害高', '会守护巢穴'],
    recommended_strategy: 'avoid',
    retreat_conditions: ['生命 < 60%', '没有护甲'],
    auto_engage_allowed: false,
    verified: true,
  }),
  enemy({
    prefab: 'knight',
    name: '发条骑士',
    threat_level: 4,
    attack_range: 2,
    attack_period: 2,
    damage: 40,
    combat_profile: 'melee_heavy',
    special_abilities: ['伤害高', '常与主教/战车成群'],
    recommended_strategy: 'avoid',
    retreat_conditions: ['同时遇到 ≥2 个发条生物', '没有护甲'],
    auto_engage_allowed: false,
    verified: true,
  }),
  enemy({
    prefab: 'bishop',
    name: '发条主教',
    threat_level: 4,
    attack_range: 8,
    attack_period: 4,
    damage: 40,
    combat_profile: 'ranged',
    special_abilities: ['远程电球', '攻击距离极长'],
    recommended_strategy: 'avoid',
    retreat_conditions: ['风筝很难（远程）', '生命 < 70%'],
    auto_engage_allowed: false,
    verified: true,
  }),
  enemy({
    prefab: 'rook',
    name: '发条战车',
    threat_level: 4,
    attack_range: 2,
    attack_period: 2,
    damage: 45,
    combat_profile: 'tank',
    special_abilities: ['冲锋', '血量高'],
    recommended_strategy: 'avoid',
    retreat_conditions: ['无法打断冲锋时', '生命 < 60%'],
    auto_engage_allowed: false,
    verified: true,
  }),
  enemy({
    prefab: 'spider_spitter',
    name: '喷吐蜘蛛',
    threat_level: 3,
    attack_range: 8,
    attack_period: 4,
    damage: 20,
    combat_profile: 'ranged',
    special_abilities: ['远程吐网/吐酸'],
    recommended_strategy: 'avoid',
    retreat_conditions: ['被远程压制时'],
    auto_engage_allowed: false,
    verified: true,
  }),
  enemy({
    prefab: 'krampus',
    name: '坎普斯',
    threat_level: 3,
    attack_range: 2,
    attack_period: 2,
    damage: 25,
    combat_profile: 'melee_light',
    special_abilities: ['偷东西', '成群出现'],
    recommended_strategy: 'avoid',
    retreat_conditions: ['同时 ≥2 只'],
    auto_engage_allowed: false,
    verified: true,
  }),
  enemy({
    prefab: 'ghost',
    name: '幽灵',
    threat_level: 3,
    attack_range: 2,
    attack_period: 2,
    damage: 20,
    combat_profile: 'melee_light',
    special_abilities: ['夜间出现', '飘移'],
    recommended_strategy: 'avoid',
    retreat_conditions: ['夜间无光源'],
    auto_engage_allowed: false,
    verified: true,
  }),
]

export const ENEMY_PROFILES: Readonly<Record<string, EnemyProfile>> = Object.freeze(
  Object.fromEntries(ENEMY_LIST.map((profile) => [profile.prefab, profile])),
)

/** 取档案：没有档案返回 UNKNOWN_ENEMY（conservative），调用方可用 `verified` 判断 */
export function getEnemyProfile(prefab: string): EnemyProfile {
  const found = ENEMY_PROFILES[prefab]
  if (found === undefined) return { ...UNKNOWN_ENEMY, prefab, name: prefab }
  return found
}

export function isKnownEnemy(prefab: string): boolean {
  return ENEMY_PROFILES[prefab] !== undefined
}

/** 允许自动交战的 prefab 列表（与 Lua 的 AUTONOMOUS_ENEMIES 必须一致） */
export function autoEngageList(): string[] {
  return ENEMY_LIST.filter((profile) => profile.auto_engage_allowed).map((profile) => profile.prefab).sort()
}

// ───────────────────────── Boss 档案 ─────────────────────────

export type BossRecommendation = 'OBSERVE' | 'PREPARE' | 'AVOID' | 'SUPERVISED_COMBAT'

export interface BossProfile {
  prefab: string
  name: string
  /** 已知最大生命（社区档案值；游戏内以 health 组件为准） */
  hp: number
  damage: number
  attack_range: number
  special_abilities: string[]
  /** 出现条件说明（不写死日期，只描述"什么时候要小心"） */
  spawn_hint: string
  /** 战前必须准备的东西（缺一项就不能开打） */
  required_prep: string[]
  /** 默认建议（本阶段一律不自动开打） */
  default_recommendation: BossRecommendation
  notes?: string
}

const BOSS_LIST: BossProfile[] = [
  {
    prefab: 'deerclops',
    name: '独眼巨鹿（Deerclops）',
    hp: 2000,
    damage: 150,
    attack_range: 3,
    special_abilities: ['大面积冰冻/砸地', '会拆建筑', '攻击间隔长（可以多次风筝）'],
    spawn_hint: '冬季后期（游戏内 first winter 附近）会循声而来',
    required_prep: ['护甲 ≥1 套且耐久 >50%', '武器伤害 ≥34', '治疗物品 ≥4', '火堆/光源', '撤离路线'],
    default_recommendation: 'AVOID',
    notes: '本阶段只做识别 + 避战 + 战前准备报告；开打必须人工确认',
  },
  {
    prefab: 'bearger',
    name: '熊獾（Bearger）',
    hp: 3000,
    damage: 200,
    attack_range: 3,
    special_abilities: ['横扫', '会吃地上的食物', '拆建筑'],
    spawn_hint: '秋季后期',
    required_prep: ['护甲 ≥1 套且耐久 >50%', '武器伤害 ≥34', '治疗物品 ≥5', '撤离路线'],
    default_recommendation: 'AVOID',
  },
  {
    prefab: 'moose',
    name: '鹿角鹅（Moose/Goose）',
    hp: 3000,
    damage: 150,
    attack_range: 3,
    special_abilities: ['下蛋', '小鹅群攻', '会追很远'],
    spawn_hint: '春季，靠近池塘/草地',
    required_prep: ['护甲 ≥1 套', '武器伤害 ≥34', '治疗物品 ≥4'],
    default_recommendation: 'AVOID',
  },
  {
    prefab: 'antlion',
    name: '蚁狮（Antlion）',
    hp: 1000,
    damage: 100,
    attack_range: 4,
    special_abilities: ['沙尘暴', '地震/塌陷', '需要献祭安抚'],
    spawn_hint: '夏季沙漠',
    required_prep: ['护甲', '降温装备', '献祭物资（可选）'],
    default_recommendation: 'AVOID',
    notes: '主要风险是地震与沙尘暴，不是正面战斗',
  },
  {
    prefab: 'beequeen',
    name: '蜂后（Bee Queen）',
    hp: 22500,
    damage: 120,
    attack_range: 3,
    special_abilities: ['召唤蜂群', '场地持续压制'],
    spawn_hint: '蜂巢附近激活',
    required_prep: ['大量护甲', '群体 AOE 手段', '治疗物品 ≥10', '撤离路线'],
    default_recommendation: 'AVOID',
    notes: '本阶段不做自动击杀',
  },
  {
    prefab: 'dragonfly',
    name: '龙蝇（Dragonfly）',
    hp: 27500,
    damage: 150,
    attack_range: 3,
    special_abilities: ['火焰 AOE', '熔岩池', '召唤熔岩虫'],
    spawn_hint: '沙漠熔岩区',
    required_prep: ['防火装备', '大量护甲', '治疗物品 ≥10'],
    default_recommendation: 'AVOID',
  },
  {
    prefab: 'klaus',
    name: '克劳斯（Klaus）',
    hp: 10000,
    damage: 150,
    attack_range: 3,
    special_abilities: ['召唤鹿', '冰/火阶段'],
    spawn_hint: '冬季，无主包裹',
    required_prep: ['护甲', '治疗物品 ≥6'],
    default_recommendation: 'AVOID',
  },
  {
    prefab: 'malbatross',
    name: '邪天翁（Malbatross）',
    hp: 5000,
    damage: 100,
    attack_range: 4,
    special_abilities: ['海上追击', '召唤小怪'],
    spawn_hint: '海上',
    required_prep: ['船', '护甲'],
    default_recommendation: 'AVOID',
  },
  {
    prefab: 'toadstool',
    name: '毒菌蟾蜍（Toadstool）',
    hp: 20000,
    damage: 100,
    attack_range: 3,
    special_abilities: ['孢子云', '召唤蘑菇怪'],
    spawn_hint: '洞穴',
    required_prep: ['大量护甲', '解毒/治疗'],
    default_recommendation: 'AVOID',
  },
  {
    prefab: 'spiderqueen',
    name: '蜘蛛女王（Spider Queen）',
    hp: 1250,
    damage: 80,
    attack_range: 3,
    special_abilities: ['持续召唤蜘蛛', '吐网'],
    spawn_hint: '蜘蛛巢升级',
    required_prep: ['护甲', 'AOE'],
    default_recommendation: 'AVOID',
  },
  {
    prefab: 'stalker',
    name: '远古守护者（Ancient Guardian）',
    hp: 4000,
    damage: 100,
    attack_range: 3,
    special_abilities: ['冲锋撞击'],
    spawn_hint: '遗迹迷宫',
    required_prep: ['护甲', '光源'],
    default_recommendation: 'AVOID',
  },
  {
    prefab: 'crabking',
    name: '蟹王（Crab King）',
    hp: 8000,
    damage: 80,
    attack_range: 4,
    special_abilities: ['海域', '召唤螃蟹'],
    spawn_hint: '海上',
    required_prep: ['船', '护甲'],
    default_recommendation: 'AVOID',
  },
]

export const BOSS_PROFILES: Readonly<Record<string, BossProfile>> = Object.freeze(
  Object.fromEntries(BOSS_LIST.map((profile) => [profile.prefab, profile])),
)

export function getBossProfile(prefab: string): BossProfile | null {
  return BOSS_PROFILES[prefab] ?? null
}

export function isBossPrefab(prefab: string): boolean {
  return BOSS_PROFILES[prefab] !== undefined
}

/** Boss prefab 列表（与 Lua 的 BOSS_PREFABS 必须一致） */
export function bossList(): string[] {
  return BOSS_LIST.map((profile) => profile.prefab).sort()
}
