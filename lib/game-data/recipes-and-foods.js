// Node 侧《饥荒联机版》配方与安全食物唯一数据源（Single Source of Truth）
//
// 目的：避免同一份建筑配方、工具配方、中间产物依赖和食物白名单散落在
// plan.js / planner-core.js / craft-or-build.js / quest-guide-adapter.js /
// development-stages.js / target-kinds.js / food-candidate-selector.js 等多处各自抄写、改一处漏四处。
//
// 权威依据：
//   · 制作/建筑：DontStarveWhaleSurvivor/scripts/whale/craftrules.lua & 原生 scripts/recipes.lua
//   · 食物白名单：DontStarveWhaleSurvivor/scripts/whale/eatrules.lua & 原生 prefabs
// 跨文件一致性由 tests/skills/recipe-parity.test.mjs 与 tests/skills/game-data-parity.test.mjs 联合守护。

/** 第一座核心科学建筑配方（researchlab / sciencemachine） */
export const CORE_RECIPE = Object.freeze({ goldnugget: 1, log: 4, rocks: 4 })

/**
 * 可制作物品配方白名单（与 Lua scripts/whale/craftrules.lua 的 C.RECIPES 逐条一致）。
 */
export const CRAFT_RECIPES = Object.freeze({
  // TECH.NONE：不需要科技
  axe: Object.freeze({ tech: 'NONE', ingredients: Object.freeze({ twigs: 1, flint: 1 }), label: '斧头' }),
  pickaxe: Object.freeze({ tech: 'NONE', ingredients: Object.freeze({ twigs: 2, flint: 2 }), label: '镐' }),
  torch: Object.freeze({ tech: 'NONE', ingredients: Object.freeze({ cutgrass: 2, twigs: 2 }), label: '火把' }),
  flowerhat: Object.freeze({ tech: 'NONE', ingredients: Object.freeze({ petals: 12 }), label: '花环' }),
  // TECH.SCIENCE_ONE：第一阶段科技（需站在科学机器旁）
  shovel: Object.freeze({ tech: 'SCIENCE_ONE', ingredients: Object.freeze({ twigs: 2, flint: 2 }), label: '铲子' }),
  rope: Object.freeze({ tech: 'SCIENCE_ONE', ingredients: Object.freeze({ cutgrass: 3 }), label: '绳子' }),
  boards: Object.freeze({ tech: 'SCIENCE_ONE', ingredients: Object.freeze({ log: 4 }), label: '木板' }),
  backpack: Object.freeze({ tech: 'SCIENCE_ONE', ingredients: Object.freeze({ cutgrass: 4, twigs: 4 }), label: '背包' }),
  spear: Object.freeze({ tech: 'SCIENCE_ONE', ingredients: Object.freeze({ twigs: 2, rope: 1, flint: 1 }), label: '长矛' }),
  armorwood: Object.freeze({ tech: 'SCIENCE_ONE', ingredients: Object.freeze({ log: 8, rope: 2 }), label: '木甲' }),
  cutstone: Object.freeze({ tech: 'SCIENCE_ONE', ingredients: Object.freeze({ rocks: 3 }), label: '石砖' }),
  transistor: Object.freeze({ tech: 'SCIENCE_ONE', ingredients: Object.freeze({ goldnugget: 2, cutstone: 1 }), label: '电子元件' }),
  // TECH.SCIENCE_TWO：第二阶段科技（需站在炼金引擎旁）
  goldenaxe: Object.freeze({ tech: 'SCIENCE_TWO', ingredients: Object.freeze({ twigs: 4, goldnugget: 2 }), label: '黄金斧头' }),
  goldenpickaxe: Object.freeze({ tech: 'SCIENCE_TWO', ingredients: Object.freeze({ twigs: 4, goldnugget: 2 }), label: '黄金镐' }),
  goldenshovel: Object.freeze({ tech: 'SCIENCE_TWO', ingredients: Object.freeze({ twigs: 4, goldnugget: 2 }), label: '黄金铲' }),
})

/** 只能靠 craft 得到的中间产物（从 CRAFT_RECIPES 派生） */
export const CRAFTED_DEPS = Object.freeze({
  boards: Object.freeze({ craft: 'boards', from: CRAFT_RECIPES.boards.ingredients }),
  rope: Object.freeze({ craft: 'rope', from: CRAFT_RECIPES.rope.ingredients }),
  cutstone: Object.freeze({ craft: 'cutstone', from: CRAFT_RECIPES.cutstone.ingredients }),
  transistor: Object.freeze({ craft: 'transistor', from: CRAFT_RECIPES.transistor.ingredients }),
})

/** 规划/技能使用的标准建筑配方（与原生 scripts/recipes.lua 一致） */
export const BUILD_RECIPES = Object.freeze({
  campfire: Object.freeze({ log: 2, cutgrass: 3 }),
  firepit: Object.freeze({ log: 2, rocks: 12 }),
  chest: Object.freeze({ boards: 3 }),
  cookpot: Object.freeze({ charcoal: 6, twigs: 6, cutstone: 3 }),
  sciencemachine: CORE_RECIPE,
  researchlab2: Object.freeze({ boards: 4, cutstone: 2, transistor: 2 }),
  tent: Object.freeze({ silk: 6, twigs: 4, rope: 3 }),
})

/** 建筑模型名与原生实体名的别名映射（与 Lua RECIPE_ALIASES 同源） */
export const BUILD_PREFAB_MAP = Object.freeze({
  chest: 'treasurechest',
  sciencemachine: 'researchlab',
  alchemyengine: 'researchlab2',
  researchlab2: 'researchlab2',
})

/** 允许 build 工具摆放的建筑枚举（含模型别名与原生名） */
export const BUILDABLE_RECIPES = Object.freeze([
  'campfire', 'firepit', 'chest', 'treasurechest', 'cookpot', 'sciencemachine', 'researchlab',
  'alchemyengine', 'researchlab2', 'tent',
])

/** 所有已核对的建筑实体/逻辑名集合 */
export const STRUCTURE_PREFABS = new Set(BUILDABLE_RECIPES)

/** 一级科技配方集合（需科学机器） */
export const TECH_ONE_ITEMS = new Set(
  Object.entries(CRAFT_RECIPES).filter(([, v]) => v.tech === 'SCIENCE_ONE').map(([k]) => k),
)

/** 一级科技建筑集合（需科学机器） */
export const TECH_ONE_BUILDINGS = new Set(['cookpot', 'researchlab2', 'alchemyengine'])

/** 二级科技配方/建筑集合（需炼金引擎） */
export const TECH_TWO_ITEMS = new Set([
  ...Object.entries(CRAFT_RECIPES).filter(([, v]) => v.tech === 'SCIENCE_TWO').map(([k]) => k),
  'tent',
])

/** 需要科技站（一级或二级）才能制作的物品集合 */
export const ALL_TECH_CRAFT_ITEMS = new Set([...TECH_ONE_ITEMS, ...Object.entries(CRAFT_RECIPES).filter(([, v]) => v.tech === 'SCIENCE_TWO').map(([k]) => k)])

/** 任务手册等补充配方（不在 craft 工具白名单，但用于规划缺口计算） */
export const EXTRA_KNOWN_RECIPES = Object.freeze({
  hammer: Object.freeze({ twigs: 3, rocks: 3, cutgrass: 6 }),
  footballhat: Object.freeze({ pigskin: 1, rope: 1 }),
})

/** 汇总配方字典（涵盖 CRAFT_RECIPES + BUILD_RECIPES + 别名 + 补充配方） */
export const ALL_KNOWN_RECIPES = Object.freeze({
  ...Object.fromEntries(Object.entries(CRAFT_RECIPES).map(([k, v]) => [k, v.ingredients])),
  ...BUILD_RECIPES,
  treasurechest: BUILD_RECIPES.chest,
  researchlab: BUILD_RECIPES.sciencemachine,
  alchemyengine: BUILD_RECIPES.researchlab2,
  ...EXTRA_KNOWN_RECIPES,
})

// ─────────────────────────── 安全食物数据 ───────────────────────────

/**
 * 自动进食安全食物白名单（与 Lua eatrules.lua E.AUTO_SAFE 完全对齐，不含生蘑菇/怪物肉）。
 */
export const AUTO_SAFE_FOODS = Object.freeze([
  'berries', 'berries_juicy', 'carrot', 'corn', 'pumpkin', 'eggplant', 'honey',
  'meat', 'smallmeat', 'froglegs', 'fish', 'acorn_cooked', 'petals',
  'green_cap_cooked', 'blue_cap_cooked',
  'meat_cooked', 'smallmeat_cooked', 'froglegs_cooked', 'fish_cooked',
  'berries_cooked', 'berries_juicy_cooked', 'carrot_cooked', 'corn_cooked',
  'pumpkin_cooked', 'eggplant_cooked',
  'meatballs', 'meatstew', 'butterflymuffin', 'dragonpie', 'frogglebunwich', 'perogies',
  'fishsticks', 'ratatouille', 'fruitmedley', 'honeyham', 'baconeggs', 'turkeydinner',
])

/** 饥荒食物效果数值（与游戏原生一致） */
export const FOOD_EFFECTS = Object.freeze({
  // 熟食
  meat_cooked: Object.freeze({ hunger: 25, health: 3, sanity: 0, veggie: false }),
  smallmeat_cooked: Object.freeze({ hunger: 12.5, health: 1, sanity: 0, veggie: false }),
  froglegs_cooked: Object.freeze({ hunger: 12.5, health: 1, sanity: 0, veggie: false }),
  fish_cooked: Object.freeze({ hunger: 12.5, health: 2, sanity: 0, veggie: false }),
  eggplant_cooked: Object.freeze({ hunger: 25, health: 20, sanity: 0, veggie: true }),
  pumpkin_cooked: Object.freeze({ hunger: 37.5, health: 8, sanity: 0, veggie: true }),
  carrot_cooked: Object.freeze({ hunger: 12.5, health: 3, sanity: 0, veggie: true }),
  corn_cooked: Object.freeze({ hunger: 25, health: 3, sanity: 0, veggie: true }),
  berries_cooked: Object.freeze({ hunger: 12.5, health: 1, sanity: 0, veggie: true }),
  berries_juicy_cooked: Object.freeze({ hunger: 18.75, health: 1, sanity: 0, veggie: true }),
  acorn_cooked: Object.freeze({ hunger: 12.5, health: 1, sanity: 0, veggie: true }),
  green_cap_cooked: Object.freeze({ hunger: 0, health: -1, sanity: 15, veggie: true }),
  blue_cap_cooked: Object.freeze({ hunger: 0, health: -3, sanity: 10, veggie: true }),

  // 锅料理
  meatballs: Object.freeze({ hunger: 62.5, health: 3, sanity: 5, dish: true }),
  meatstew: Object.freeze({ hunger: 150, health: 12, sanity: 5, dish: true }),
  butterflymuffin: Object.freeze({ hunger: 37.5, health: 20, sanity: 5, dish: true }),
  dragonpie: Object.freeze({ hunger: 75, health: 40, sanity: 5, dish: true }),
  frogglebunwich: Object.freeze({ hunger: 37.5, health: 20, sanity: 5, dish: true }),
  perogies: Object.freeze({ hunger: 37.5, health: 40, sanity: 5, dish: true }),
  fishsticks: Object.freeze({ hunger: 37.5, health: 40, sanity: 5, dish: true }),
  ratatouille: Object.freeze({ hunger: 25, health: 3, sanity: 5, dish: true }),
  fruitmedley: Object.freeze({ hunger: 25, health: 20, sanity: 5, dish: true }),
  honeyham: Object.freeze({ hunger: 75, health: 30, sanity: 5, dish: true }),
  baconeggs: Object.freeze({ hunger: 75, health: 20, sanity: 5, dish: true }),
  turkeydinner: Object.freeze({ hunger: 75, health: 20, sanity: 5, dish: true }),

  // 生基础食物
  honey: Object.freeze({ hunger: 9.375, health: 3, sanity: 0, veggie: false }),
  meat: Object.freeze({ hunger: 25, health: 1, sanity: -10, veggie: false }),
  smallmeat: Object.freeze({ hunger: 12.5, health: 1, sanity: -10, veggie: false }),
  froglegs: Object.freeze({ hunger: 12.5, health: 0, sanity: -10, veggie: false }),
  fish: Object.freeze({ hunger: 12.5, health: 1, sanity: 0, veggie: false }),
  pumpkin: Object.freeze({ hunger: 37.5, health: 3, sanity: 0, veggie: true }),
  eggplant: Object.freeze({ hunger: 25, health: 8, sanity: 0, veggie: true }),
  corn: Object.freeze({ hunger: 25, health: 3, sanity: 0, veggie: true }),
  carrot: Object.freeze({ hunger: 12.5, health: 1, sanity: 0, veggie: true }),
  berries: Object.freeze({ hunger: 9.375, health: 0, sanity: 0, veggie: true }),
  berries_juicy: Object.freeze({ hunger: 12.5, health: 0, sanity: 0, veggie: true }),

  // 花瓣（吃只回 1 血、0 饥饿）
  petals: Object.freeze({ hunger: 0, health: 1, sanity: 0, veggie: true, special: 'petals' }),
})

/** 完整自动安全食物 Set（含花瓣与烤绿/蓝蘑菇） */
export const AUTO_SAFE_FOOD_SET = new Set(AUTO_SAFE_FOODS)

/** 能补充饥饿的安全食物 Set（排除 hunger=0 的花瓣与烤蘑菇） */
export const EDIBLE_HUNGER_FOOD_SET = new Set(
  AUTO_SAFE_FOODS.filter((p) => (FOOD_EFFECTS[p]?.hunger ?? 0) > 0),
)

/** 安全回血食物 Set（health>0 且不扣理智，且排除回血极微的花瓣） */
export const HEALING_FOOD_SET = new Set(
  AUTO_SAFE_FOODS.filter((p) => p !== 'petals' && (FOOD_EFFECTS[p]?.health ?? 0) > 0 && (FOOD_EFFECTS[p]?.sanity ?? 0) >= 0),
)

/** 烹饪锅肉类食材集合 */
export const COOKPOT_MEAT_PREFABS = new Set([
  'meat', 'smallmeat', 'froglegs', 'fish', 'monstermeat',
  'meat_cooked', 'smallmeat_cooked', 'froglegs_cooked', 'fish_cooked',
])

/** 烹饪锅蔬果填充食材集合 */
export const COOKPOT_FILLER_PREFABS = new Set([
  'berries', 'berries_juicy', 'carrot', 'corn', 'pumpkin', 'eggplant',
  'berries_cooked', 'berries_juicy_cooked', 'carrot_cooked', 'red_cap', 'blue_cap',
])

// ─────────────────────────── 可装备物品数据 ───────────────────────────

/** 允许 equip 动作装备的物品白名单（与 Lua equiprules.lua Q.ITEMS 对齐） */
export const EQUIPPABLE_ITEMS = Object.freeze([
  'torch', 'axe', 'pickaxe', 'shovel', 'goldenaxe', 'goldenpickaxe', 'goldenshovel',
  'lantern', 'minerhat', 'flowerhat', 'spear',
])
