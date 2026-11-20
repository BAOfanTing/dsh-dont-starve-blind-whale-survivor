// TARGET-REFRESH：实时目标选择的 target_kind 枚举（**Node 侧唯一来源**）
//
// 为什么要有这个文件：
//   真机日志（session.txt，Mod 0.38.4）里 94 次工具调用有 23 次 pickup stale_snapshot、
//   3 次 chop、2 次 harvest —— 因为 #N 只在当前扫描帧内有效，而模型一轮思考 30~60 秒。
//   修法不是放宽校验，而是让模型只说"要哪一类东西"，由 Lua 在授权那一刻用当前世界状态
//   重新找目标（见 DontStarveWhaleSurvivor/scripts/whale/targetrules.lua）。
//
// 这个文件必须和 Lua 的 T.KIND_ACTION / T.KIND_PREFABS / T.TREE_PREFIXES **逐条一致**：
//   tests/target-nearest.test.mjs 会解析 targetrules.lua 做 parity 断言。
//   两边不一致的后果很具体 —— 模型按 Node 的枚举传值，Lua 却说不认识；
//   或者 Node 以为"该涨 flint"，Lua 实际捡了别的，于是核对把成功判成失败。
//
// 本文件只描述"类别是什么"，不做任何 IO、不碰游戏。

/** 类别 → 动作类型。pickup=捡地面材料，food=捡地面食物，chop/mine=作业，harvest=采成熟植株 */
export const KIND_ACTION = {
  // 地面材料（pickup_nearest）
  flint: 'pickup',
  twigs: 'pickup',
  cutgrass: 'pickup',
  log: 'pickup',
  rocks: 'pickup',
  goldnugget: 'pickup',
  charcoal: 'pickup',
  petals: 'pickup',
  // 地面食物（pickup_food）
  safe_ground_food: 'food',
  carrot: 'food',
  berries: 'food',
  berries_juicy: 'food',
  pumpkin: 'food',
  corn: 'food',
  eggplant: 'food',
  honey: 'food',
  meat: 'food',
  smallmeat: 'food',
  froglegs: 'food',
  fish: 'food',
  // 砍树（chop_nearest）
  tree: 'chop',
  // 挖矿（mine_nearest）
  ordinary_rock: 'mine',
  gold_vein: 'mine',
  // 采成熟食物植株（harvest_nearest）
  ripe_food_plant: 'harvest',
  berrybush: 'harvest',
  juicy_berrybush: 'harvest',
  carrot_plant: 'harvest',
  mushroom: 'harvest',
}

/** 每个类别的 prefab 白名单（精确匹配）。tree 例外：用 TREE_PREFIXES 前缀匹配。 */
export const KIND_PREFABS = {
  flint: ['flint'],
  twigs: ['twigs'],
  cutgrass: ['cutgrass'],
  log: ['log'],
  rocks: ['rocks'],
  goldnugget: ['goldnugget'],
  charcoal: ['charcoal'],
  petals: ['petals'],
  carrot: ['carrot'],
  berries: ['berries'],
  berries_juicy: ['berries_juicy'],
  pumpkin: ['pumpkin'],
  corn: ['corn'],
  eggplant: ['eggplant'],
  honey: ['honey'],
  meat: ['meat'],
  smallmeat: ['smallmeat'],
  froglegs: ['froglegs'],
  fish: ['fish'],
  // 依据本机 scripts.zip 的 prefabs/rocks.lua:65-85 战利品表：
  //   rock1 → rocks/nitre/flint（无金）；rock2 → rocks/goldnugget/flint
  //   ⇒ gold_vein 恰好就是 rock2，不是"看起来像"猜出来的
  ordinary_rock: ['rock1', 'rock_flintless', 'rock_flintless_med', 'rock_flintless_low'],
  gold_vein: ['rock2'],
  berrybush: ['berrybush', 'berrybush2'],
  juicy_berrybush: ['berrybush_juicy'],
  carrot_plant: ['carrot_planted'],
  mushroom: ['red_mushroom', 'green_mushroom', 'blue_mushroom'],
}

/** 树的前缀白名单（evergreens.lua 的树名是拼出来的，逐条列会和游戏更新漂移） */
export const TREE_PREFIXES = [
  'evergreen',
  'twiggy',
  'deciduoustree',
  'marsh_tree',
  'mushtree',
  'livingtree',
  'marbletree',
  'winter_tree',
  'moontree',
  'palmconetree',
  'driftwood',
]

/** 自动进食的安全地面食物（与 eatrules.lua 的 AUTO_SAFE 对齐，**生蘑菇不算**） */
export const AUTO_SAFE_FOODS = [
  'berries', 'berries_juicy', 'carrot', 'corn', 'pumpkin', 'eggplant', 'honey',
  'meat', 'smallmeat', 'froglegs', 'fish', 'acorn_cooked', 'petals',
  'meat_cooked', 'smallmeat_cooked', 'froglegs_cooked', 'fish_cooked',
  'berries_cooked', 'berries_juicy_cooked', 'carrot_cooked', 'corn_cooked',
  'pumpkin_cooked', 'eggplant_cooked',
]

/** pickuprules.lua.PREFABS（地面可拾取白名单）——Node 侧只用于"就地找最近目标"的核对 */
export const GROUND_PICKUP_PREFABS = [
  'twigs', 'cutgrass', 'flint',
  // 砍树/挖矿的产物（真机踩到：树砍倒了、木头在地上，但 log 不在白名单 → 永远捡不起来）
  'log', 'rocks', 'goldnugget', 'nitre', 'charcoal', 'pinecone', 'acorn',
  'carrot', 'berries', 'berries_juicy', 'corn', 'pumpkin', 'eggplant',
  'red_cap', 'blue_cap', 'green_cap', 'honey', 'meat', 'smallmeat', 'froglegs', 'fish',
  'meat_cooked', 'smallmeat_cooked', 'froglegs_cooked', 'fish_cooked',
  'berries_cooked', 'berries_juicy_cooked', 'carrot_cooked', 'corn_cooked',
  'pumpkin_cooked', 'eggplant_cooked',
]

/**
 * 每个类别"成功时会多出来什么"。
 * 这是 nearest 类动作的**权威核对依据**：Node 不知道 Lua 最终选了哪个实体，
 * 但知道"这一类东西到手后会进什么"。所以只认"背包里该集合真的 +N"，
 * 不看 Lua 函数返回了什么。
 */
export const KIND_PRODUCTS = {
  flint: ['flint'],
  twigs: ['twigs'],
  cutgrass: ['cutgrass'],
  log: ['log'],
  rocks: ['rocks'],
  goldnugget: ['goldnugget'],
  charcoal: ['charcoal'],
  safe_ground_food: AUTO_SAFE_FOODS,
  tree: ['log', 'charcoal', 'livinglog'],
  ordinary_rock: ['rocks', 'flint', 'nitre', 'marble'],
  gold_vein: ['goldnugget', 'rocks', 'flint', 'nitre'],
  ripe_food_plant: ['berries', 'berries_juicy', 'carrot', 'red_cap', 'green_cap', 'blue_cap'],
  berrybush: ['berries'],
  juicy_berrybush: ['berries_juicy'],
  carrot_plant: ['carrot'],
  mushroom: ['red_cap', 'green_cap', 'blue_cap'],
}

/** 每个类别"目标本身长什么样"（用于"目标消失"这条弱证据，以及 before 快照里定位最近目标） */
export function kindPrefabs(kind) {
  if (kind === 'safe_ground_food') return AUTO_SAFE_FOODS
  if (kind === 'ripe_food_plant') return [
    ...KIND_PREFABS.berrybush, ...KIND_PREFABS.juicy_berrybush,
    ...KIND_PREFABS.carrot_plant, ...KIND_PREFABS.mushroom,
  ]
  return KIND_PREFABS[kind] ?? []
}

/** 这一类成功后会多出什么（找不到就退回"目标自己"） */
export function kindProducts(kind) {
  return KIND_PRODUCTS[kind] ?? kindPrefabs(kind)
}

/** kind 是否在白名单里 */
export function isKind(kind) {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(KIND_ACTION, kind)
}

/** 动作名 → 类别类型（pickup_nearest → pickup；pickup_food → food） */
export function kindTypeForAction(action) {
  return action === 'pickup_food' ? 'food' : String(action).replace(/_nearest$/, '')
}

/** 某一类动作合法的 kind 列表（工具 enum 用；顺序固定，便于测试与提示词稳定） */
export function kindsFor(action) {
  const want = kindTypeForAction(action)
  return Object.keys(KIND_ACTION).filter((k) => KIND_ACTION[k] === want).sort()
}

/** 能否用这个动作调这个 kind（防止 chop_nearest 去挖石头这种错配） */
export function isKindForAction(action, kind) {
  return KIND_ACTION[kind] === kindTypeForAction(action)
}

/** prefab 是否属于这个类别（tree 走前缀表） */
export function prefabAllowed(kind, prefab) {
  if (typeof prefab !== 'string') return false
  if (kind === 'tree') return TREE_PREFIXES.some((p) => prefab.startsWith(p))
  const set = KIND_PREFABS[kind]
  return Array.isArray(set) ? set.includes(prefab) : false
}

export const KIND_LIST = Object.keys(KIND_ACTION).sort()

/**
 * TARGET-REFRESH：所有"要指定一个具体目标"的动作共用的参数片段 —— 两种引用二选一：
 *   · target_ref (#N) + snapshot_id  = 当前帧的引用（语义完全不变）
 *   · target_handle (h…)             = 跨扫描稳定的句柄（目标消失即失效，绝不替换成别的东西）
 *
 * target_ref / snapshot_id 仍然标 required：**没有** handle 时它们就是必填（语义不变）。
 * 带 handle 时由 validateArgs 单独放宽（见 dispatcher.js），而不是在这里写成可选 ——
 * 否则"两个都不给"会被静默放过，问题被推迟到 Lua 才暴露。
 */
export const TARGET_REF_ARGS = {
  target_ref: { type: 'string', pattern: '^#[1-9][0-9]{0,3}$', maxLength: 8, required: true },
  snapshot_id: { type: 'string', maxLength: 64, required: true },
  target_handle: { type: 'string', pattern: '^h[0-9a-z]{1,8}$', maxLength: 10 },
}
