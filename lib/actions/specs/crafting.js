// 制作与建造（3 个动作）
//
// 每个动作声明：riskLevel / category / description / 参数白名单 / 核对方式（verify）。
// 参数白名单是安全边界的一部分：args 里出现的其它键一律被拒（防模型夹带）。

import { countInInventory, equipmentItem, handItem, inventoryItems } from '../state-query.js'
import { TARGET_REF_ARGS } from '../target-kinds.js'

/**
 * TARGET-REFRESH：配方白名单的**唯一真来源**（Node 侧）。
 * 必须和 Lua 的 scripts/whale/craftrules.lua 的 C.RECIPES 逐条一致 ——
 * tests/recipe-parity.test.mjs 会解析那个文件做 parity 断言。
 * tech 只是"要不要科学机器"的说明与提示用；**权威判定在 Lua**
 * （builder:KnowsRecipe 会把附近的 prototyper 折算成临时科技加成，我们不去复制一套 TECH 表）。
 * 依据：本机 scripts.zip 的 recipes.lua。
 */
export const RECIPE_WHITELIST = {
  // TECH.NONE：不需要科技
  axe: { tech: 'NONE', ingredients: { twigs: 1, flint: 1 }, label: '斧头' },
  pickaxe: { tech: 'NONE', ingredients: { twigs: 2, flint: 2 }, label: '镐' },
  torch: { tech: 'NONE', ingredients: { cutgrass: 2, twigs: 2 }, label: '火把' },
  flowerhat: { tech: 'NONE', ingredients: { petals: 12 }, label: '花环' },
  // TECH.SCIENCE_ONE：第一阶段科技 —— 要站在科学机器旁边
  rope: { tech: 'SCIENCE_ONE', ingredients: { cutgrass: 3 }, label: '绳子' },
  boards: { tech: 'SCIENCE_ONE', ingredients: { log: 4 }, label: '木板' },
  backpack: { tech: 'SCIENCE_ONE', ingredients: { cutgrass: 4, twigs: 4 }, label: '背包' },
  spear: { tech: 'SCIENCE_ONE', ingredients: { twigs: 2, rope: 1, flint: 1 }, label: '长矛' },
  armorwood: { tech: 'SCIENCE_ONE', ingredients: { log: 8, rope: 2 }, label: '木甲' },
  // TENT：炼金引擎的前置材料（都是 TECH.SCIENCE_ONE，且都是**实物**不是建筑）
  cutstone: { tech: 'SCIENCE_ONE', ingredients: { rocks: 3 }, label: '石砖' },
  transistor: { tech: 'SCIENCE_ONE', ingredients: { goldnugget: 2, cutstone: 1 }, label: '电子元件' },
}

export const CRAFTABLE_RECIPES = Object.keys(RECIPE_WHITELIST)

/**
 * TARGET-REFRESH：`build` 能放的建筑（Node 侧唯一来源）。
 * 必须和 Lua 的 `BUILD_ALLOWED`（actions/crafting.lua）+ `BUILD_OK`（guard.lua）一致 ——
 * 有 tests/science-chain.test.mjs 盯着。
 * 注意 `sciencemachine` 是**给模型看的名字**，原生配方/建筑名是 `researchlab`（别名在 core.lua）；
 * 两个名字都收，避免模型照原生名填就被拒。
 *
 * TENT（2026-11-17）：加了帐篷链的两级建筑 ——
 *   researchlab2（炼金引擎，原生名）= boards×4 + cutstone×2 + transistor×2，TECH.SCIENCE_ONE
 *   tent（帐篷）= silk×6 + twigs×4 + rope×3，TECH.SCIENCE_TWO（要站在炼金引擎旁边）
 */
export const BUILDABLE_RECIPES = [
  'campfire', 'firepit', 'chest', 'treasurechest', 'cookpot', 'sciencemachine', 'researchlab',
  'alchemyengine', 'researchlab2', 'tent',
]

/** 模型名 → 原生建筑 prefab（核对用；和 Lua 的 RECIPE_ALIASES 同源） */
export const BUILD_PREFAB_MAP = {
  chest: 'treasurechest',
  sciencemachine: 'researchlab',
  alchemyengine: 'researchlab2',
  researchlab2: 'researchlab2',
}

export const craftingSpecs = {
  /**
   * SURVIVAL-06：建造（放到地上）。核对：附近多了一个该建筑。
   * 白名单与 Lua 侧一致：campfire / firepit / chest / cookpot / sciencemachine /
   * researchlab2（炼金引擎）/ tent（帐篷）。
   */
  build: {
    riskLevel: 'R2',
    category: 'crafting',
    description: '在地上造一个建筑',
    verifyWaitMs: 5000,
    args: {
      recipe: {
        type: 'string',
        pattern: '^[a-z0-9_]{1,32}$',
        maxLength: 32,
        // TARGET-REFRESH：和 craft 一样把 enum 锁死 —— 以前 schema 层放行任意名字，
        // 只在 verify 里拦，模型会白烧一次调用。
        enum: BUILDABLE_RECIPES,
        required: true,
      },
    },
    verify(before, after, args) {
      const prefab = String(args?.recipe ?? '')
      if (!BUILDABLE_RECIPES.includes(prefab)) return { ok: false, reason: 'recipe_not_allowed' }
      const actualPrefab = BUILD_PREFAB_MAP[prefab] ?? prefab
      const countNear = (snap) => {
        const buckets = snap?.nearby?.buckets ?? {}
        let n = 0
        for (const list of Object.values(buckets)) {
          const arr = Array.isArray(list) ? list : Object.values(list ?? {})
          for (const it of arr) if (it?.prefab === actualPrefab) n += 1
        }
        return n
      }
      const b = countNear(before)
      const a = countNear(after)
      if (a > b) return { ok: true, made: a - b, product: prefab }
      // ★ TARGET-REFRESH：这里原来有一条"材料被扣了就算成功"的弱证据（materials_consumed）。
      //   任务书明确禁止："不允许仅因背包材料减少就认为建造成功" —— 材料可能被别的动作吃掉、
      //   建造可能中途失败、产物也可能放下后立刻被拆。所以那条路径已删除：
      //   核对不上就是 unverified / build_not_found，绝不谎报成功。
      return { ok: false, reason: 'build_not_found' }
    },
  },
  /**
   * SURVIVAL-05：锅（放材料煮 / 拿成品）。核对：背包有变化。
   */
  cook: {
    riskLevel: 'R2',
    category: 'crafting',
    description: '往锅里放材料开始煮，或者把煮好的拿出来',
    requiresSnapshot: true,
    verifyWaitMs: 3000,
    args: {
      ...TARGET_REF_ARGS,
      items: { type: 'string', maxLength: 120 },
    },
    verify(before, after) {
      const items = (snap) => inventoryItems(snap)
      const m = (snap) => {
        const out = {}
        for (const i of items(snap)) if (i?.prefab) out[i.prefab] = (out[i.prefab] ?? 0) + Number(i.count ?? 1)
        return out
      }
      const b = m(before)
      const a = m(after)
      const keys = new Set([...Object.keys(b), ...Object.keys(a)])
      for (const k of keys) {
        const d = (a[k] ?? 0) - (b[k] ?? 0)
        if (d !== 0) return { ok: true, product: k, gained: d }
      }
      return { ok: false, reason: 'inventory_unchanged' }
    },
  },
  /**
   * SURVIVAL-01：制作白名单里的基础工具（torch / axe / pickaxe）。
   * recipe 必须是白名单里的名字，**不接受**任意配方、建造、摆建筑。
   */
  craft: {
    riskLevel: 'R2',
    category: 'crafting',
    description:
      '制作一个白名单配方。不需要科技：torch / axe / pickaxe / flowerhat；'
      + '第一阶段科技（要先 build sciencemachine 并站在它旁边）：rope / boards / backpack / spear / armorwood / cutstone / transistor',
    verifyWaitMs: 3000,
    args: {
      recipe: {
        type: 'string',
        maxLength: 32,
        pattern: '^[a-z0-9_]{1,32}$',
        enum: CRAFTABLE_RECIPES,
        required: true,
      },
    },
    /**
     * 核对：成品必须真的进了背包（数量 +1）。
     * 材料消耗由 Lua 侧先查（ingredients_missing / recipe_locked），这里只确认结果。
     */
    verify(before, after, args) {
      const recipe = String(args?.recipe ?? '')
      if (!Object.prototype.hasOwnProperty.call(RECIPE_WHITELIST, recipe)) {
        return { ok: false, reason: 'recipe_not_allowed' }
      }
      const b = countInInventory(before, recipe)
      const a = countInInventory(after, recipe)
      if (a > b) return { ok: true, made: a - b }
      // ★ 手部自动装备（torch 等）
      const handAfter = handItem(after)
      const handBefore = handItem(before)
      if (handAfter === recipe && handBefore !== recipe) {
        return { ok: true, made: 1, how: 'auto_equipped', hand: handAfter }
      }
      // ★ 头部自动装备（flowerhat 等）
      const headAfter = equipmentItem(after, 'head')
      const headBefore = equipmentItem(before, 'head')
      if (headAfter === recipe && headBefore !== recipe) {
        return { ok: true, made: 1, how: 'auto_equipped_head', head: headAfter }
      }
      return { ok: false, reason: 'craft_not_in_inventory', hand: handAfter }
    },
  },
}
