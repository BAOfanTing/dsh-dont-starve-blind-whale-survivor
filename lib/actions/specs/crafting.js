// 制作与建造（3 个动作）
//
// 每个动作声明：riskLevel / category / description / 参数白名单 / 核对方式（verify）。
// 参数白名单是安全边界的一部分：args 里出现的其它键一律被拒（防模型夹带）。

import { countInInventory, equipmentItem, handItem, inventoryItems } from '../state-query.js'
import { TARGET_REF_ARGS } from '../target-kinds.js'
import {
  CRAFT_RECIPES,
  BUILDABLE_RECIPES as SHARED_BUILDABLE_RECIPES,
  BUILD_PREFAB_MAP as SHARED_BUILD_PREFAB_MAP,
} from '../../game-data/recipes-and-foods.js'

/**
 * 配方白名单的**唯一真来源**（数据定义在 lib/game-data/recipes-and-foods.js）。
 * 必须和 Lua 的 scripts/whale/craftrules.lua 的 C.RECIPES 逐条一致 ——
 * tests/skills/recipe-parity.test.mjs 与 tests/skills/game-data-parity.test.mjs 会做 parity 断言。
 */
export const RECIPE_WHITELIST = CRAFT_RECIPES

export const CRAFTABLE_RECIPES = Object.keys(RECIPE_WHITELIST)

export const BUILDABLE_RECIPES = [...SHARED_BUILDABLE_RECIPES]

/** 模型名 → 原生建筑 prefab（核对用；和 Lua 的 RECIPE_ALIASES 同源） */
export const BUILD_PREFAB_MAP = SHARED_BUILD_PREFAB_MAP

export const craftingSpecs = {
  /**
   * 建造（放到地上）。核对：附近多了一个该建筑。
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
        // 与 craft 一样在 schema 层锁定 enum，避免非法配方名走到 verify 才被拦截。
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
      // 严禁仅因背包材料减少就认为建造成功：材料可能被别的动作消耗，
      // 必须以附近确实出现目标建筑为准；核对不上即返回 build_not_found。
      return { ok: false, reason: 'build_not_found' }
    },
  },
  /**
   * 锅（放材料煮 / 拿成品）。核对：背包变化或烹饪锅处于 cooking 状态。
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
      // 锅自身状态核验：若锅在烹饪中，或产物因背包满掉在地上，均核对成功
      const findPotStewer = (snap) => {
        const buckets = snap?.nearby?.buckets ?? {}
        for (const list of Object.values(buckets)) {
          const arr = Array.isArray(list) ? list : Object.values(list ?? {})
          for (const it of arr) {
            if (it?.prefab === 'cookpot' && it?.stewer) return it.stewer
          }
        }
        return null
      }
      const stAfter = findPotStewer(after)
      if (stAfter?.cooking) {
        return { ok: true, status: 'cooking', time_left: stAfter.time_left }
      }
      return { ok: false, reason: 'inventory_unchanged' }
    },
  },
  /**
   * 制作白名单里的基础物品（火把/工具/中间材料等）。
   * recipe 必须是白名单里的名字，不接受任意配方或建造类配方。
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
