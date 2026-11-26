// 食物生产与储备系统技能 (bws.food-production)
//
// 食物生产闭环技能：
//   感知食物 → 评估库存 → 评估饥饿趋势 → 搜集食材 → 建造烹饪设施 → 烹饪 → 取出成品 → 进食 → 补充储备。
//
// 食物优先级：
//   P0：生命危险（血量 <25% / 濒死），立即使用现有安全回血食物。
//   P1：饥饿临界（饥饿 <40% / 沃尔夫冈 <55%），优先寻找并获取立即可食食物（决不能等锅饿死）。
//   P2：食物储备不足（熟食/安全食物 < 2 份，或饥饿 <65%），规划持续采集和烹饪。
//   P3：有安全余量时建立熟食储备（肉丸等，保质期长且营养高，目标 2~4 份）。
//   P4：食物充足时不浪费资源继续制作。
//
// 遇到无锅或无材料条件时，平滑回退到现有安全采食链。

import { countInInventory, inventoryItems } from '../actions/state-query.js'
import { EDIBLE } from './skill-utils.js'
import { foodAction, FOOD_EFFECTS } from './food-candidate-selector.js'
import { hasStructure } from '../planner/development-stages.js'

import {
  COOKPOT_FILLER_PREFABS,
  COOKPOT_MEAT_PREFABS,
} from '../game-data/recipes-and-foods.js'

export const FOOD_PRIORITY = {
  P0_LETHAL: 'P0',
  P1_CRITICAL: 'P1',
  P2_DEFICIT: 'P2',
  P3_RESERVE: 'P3',
  P4_SUFFICIENT: 'P4',
}

const FILLER_PREFABS = COOKPOT_FILLER_PREFABS
const MEAT_PREFABS = COOKPOT_MEAT_PREFABS

function pct(stat) {
  if (typeof stat?.percent === 'number') return stat.percent
  if (typeof stat?.current === 'number' && typeof stat?.max === 'number' && stat.max > 0) {
    return (stat.current / stat.max) * 100
  }
  return 100
}

function actorPos(snapshot) {
  const a = snapshot?.actor
  if (a && typeof a.tileX === 'number' && typeof a.tileZ === 'number') return { x: a.tileX, z: a.tileZ }
  return null
}

function bucketItems(snapshot, key) {
  const buckets = snapshot?.nearby?.buckets
  if (!buckets) return []
  if (Array.isArray(buckets)) return buckets.find((g) => g?.kind === key)?.items ?? []
  const list = buckets[key]
  return Array.isArray(list) ? list : Object.values(list ?? {})
}

/** 评估当前库存中的熟食与安全食物储备 */
export function evaluateFoodStock(snapshot) {
  let cookedCount = 0
  let totalEdible = 0
  let meatCount = 0
  let fillerCount = 0
  const items = inventoryItems(snapshot)

  for (const it of items) {
    const prefab = String(it?.prefab ?? '')
    const count = Number(it?.count ?? 1)
    if (EDIBLE.has(prefab)) {
      totalEdible += count
      const eff = FOOD_EFFECTS[prefab]
      if (eff?.dish || /_cooked$/i.test(prefab)) {
        cookedCount += count
      }
    }
    if (MEAT_PREFABS.has(prefab)) {
      meatCount += count
    } else if (FILLER_PREFABS.has(prefab)) {
      fillerCount += count
    }
  }

  return { cookedCount, totalEdible, meatCount, fillerCount }
}

/** 找到附近最好的锅及其实时状态 */
export function findNearbyCookpot(snapshot) {
  const pots = bucketItems(snapshot, 'structures').filter((it) => it?.prefab === 'cookpot')
  if (pots.length === 0) return null

  // 优先选已煮好成品的锅，其次空闲锅，最后正在煮的锅
  const readyPot = pots.find((it) => it?.stewer?.done)
  if (readyPot) return { pot: readyPot, status: 'done', product: readyPot.stewer.product }

  const idlePot = pots.find((it) => !it?.stewer?.cooking && !it?.stewer?.done)
  if (idlePot) return { pot: idlePot, status: 'idle' }

  const cookingPot = pots.find((it) => it?.stewer?.cooking)
  if (cookingPot) return { pot: cookingPot, status: 'cooking', timeLeft: cookingPot.stewer.time_left ?? 0 }

  return { pot: pots[0], status: 'unknown' }
}

/** 判定食物优先级 */
export function determineFoodPriority(snapshot) {
  const health = pct(snapshot?.player?.health)
  const hunger = pct(snapshot?.player?.hunger)
  const isWolfgang = snapshot?.actor?.prefab === 'wolfgang'
  const hgThresh = isWolfgang ? 55 : 40

  if (health < 25) return FOOD_PRIORITY.P0_LETHAL
  if (hunger < hgThresh) return FOOD_PRIORITY.P1_CRITICAL

  const { cookedCount, totalEdible } = evaluateFoodStock(snapshot)
  if (totalEdible < 2 || hunger < (isWolfgang ? 70 : 60)) return FOOD_PRIORITY.P2_DEFICIT
  if (cookedCount < 3) return FOOD_PRIORITY.P3_RESERVE

  return FOOD_PRIORITY.P4_SUFFICIENT
}

/** 挑选一组最适合投入锅的 4 样食材 */
export function selectIngredientsForPot(snapshot) {
  const inv = inventoryItems(snapshot)
  const meats = []
  const fillers = []

  for (const it of inv) {
    const prefab = String(it?.prefab ?? '')
    const count = Number(it?.count ?? 1)
    if (MEAT_PREFABS.has(prefab)) {
      for (let i = 0; i < count; i++) meats.push(prefab)
    } else if (FILLER_PREFABS.has(prefab)) {
      for (let i = 0; i < count; i++) fillers.push(prefab)
    }
  }

  // 1. 最优配方：肉丸（1 份肉 + 3 份填充物）
  if (meats.length >= 1 && fillers.length >= 3) {
    return [meats[0], fillers[0], fillers[1], fillers[2]]
  }

  // 2. 纯肉汤（3 份肉 + 1 份肉/填充物）
  if (meats.length >= 4) {
    return [meats[0], meats[1], meats[2], meats[3]]
  }

  // 3. 纯素杂烩（4 份果蔬）
  if (fillers.length >= 4) {
    return [fillers[0], fillers[1], fillers[2], fillers[3]]
  }

  // 4. 其它凑齐 4 样
  const combined = [...meats, ...fillers]
  if (combined.length >= 4) {
    return combined.slice(0, 4)
  }

  return null
}

export const foodProduction = {
  id: 'food_production',
  name: '食物生产系统',
  version: 1,

  preconditions(ctx) {
    const actor = ctx.snapshot?.actor
    if (!actor || actor.alive === false || actor.isGhost === true) {
      return { ok: false, reason: '角色不可用' }
    }
    return { ok: true }
  },

  steps: [
    // ① 应急进食：若角色处于 P0 濒死或 P1 饥饿临界，绝不等锅，立刻进食现有食物或就地采食！
    {
      id: 'emergency_eat',
      title: '紧急进食保命',
      isDone(ctx) {
        const p = determineFoodPriority(ctx.snapshot)
        return p !== FOOD_PRIORITY.P0_LETHAL && p !== FOOD_PRIORITY.P1_CRITICAL
      },
      nextAction(ctx, inst) {
        return foodAction(ctx.snapshot, { inst, memory: ctx.memory, now: ctx.now })
      },
    },

    // ② 锅成品收获：若锅里有煮好的熟食，优先取出放进背包
    {
      id: 'harvest_pot',
      title: '从锅中取出煮好的成品',
      isDone(ctx) {
        const potInfo = findNearbyCookpot(ctx.snapshot)
        return !potInfo || potInfo.status !== 'done'
      },
      nextAction(ctx) {
        const potInfo = findNearbyCookpot(ctx.snapshot)
        if (!potInfo || potInfo.status !== 'done') return { done: true }
        const pot = potInfo.pot
        const a = actorPos(ctx.snapshot)
        const p = pot.position
        const dist = (a && p) ? Math.hypot(a.x - p.x, a.z - p.z) : (pot.distance ?? 0)

        if (dist > 2.0 && p) {
          return { tool: 'move_to', args: { x: Math.round(p.x), z: Math.round(p.z) }, target_id: `cookpot:${pot.handle || pot.ref}` }
        }
        return {
          tool: 'cook',
          target_handle: pot.handle,
          args: {
            ...(pot.handle ? { target_handle: pot.handle } : {}),
            target_ref: pot.ref,
            snapshot_id: ctx.snapshot?.nearby?.snapshot_id,
          },
          target_id: `cookpot:${pot.handle || pot.ref}`,
        }
      },
    },

    // ③ 收集食材：若有空闲锅但材料不足 4 样，进行有针对性的食材采集
    {
      id: 'gather_ingredients',
      title: '收集烹饪所需食材（肉类与浆果/蔬菜）',
      isDone(ctx) {
        const { cookedCount } = evaluateFoodStock(ctx.snapshot)
        if (cookedCount >= 3) return true
        const ingredients = selectIngredientsForPot(ctx.snapshot)
        return Boolean(ingredients)
      },
      nextAction(ctx, inst) {
        return foodAction(ctx.snapshot, { inst, memory: ctx.memory, now: ctx.now, need: 'hunger' })
      },
    },

    // ④ 下锅烹饪：材料齐备时靠近锅投放食材并开始煮
    {
      id: 'cook_dish',
      title: '将食材投入烹饪锅制作料理',
      isDone(ctx) {
        const potInfo = findNearbyCookpot(ctx.snapshot)
        if (!potInfo) return true // 无锅则跳过
        return potInfo.status === 'cooking' || potInfo.status === 'done'
      },
      nextAction(ctx) {
        const potInfo = findNearbyCookpot(ctx.snapshot)
        if (!potInfo || potInfo.status !== 'idle') return { done: true }
        const ingredients = selectIngredientsForPot(ctx.snapshot)
        if (!ingredients) return { done: true }

        const pot = potInfo.pot
        const a = actorPos(ctx.snapshot)
        const p = pot.position
        const dist = (a && p) ? Math.hypot(a.x - p.x, a.z - p.z) : (pot.distance ?? 0)

        if (dist > 2.0 && p) {
          return { tool: 'move_to', args: { x: Math.round(p.x), z: Math.round(p.z) }, target_id: `cookpot:${pot.handle || pot.ref}` }
        }

        return {
          tool: 'cook',
          target_handle: pot.handle,
          args: {
            ...(pot.handle ? { target_handle: pot.handle } : {}),
            target_ref: pot.ref,
            snapshot_id: ctx.snapshot?.nearby?.snapshot_id,
            items: ingredients.join(','),
          },
          target_id: `cookpot:${pot.handle || pot.ref}`,
        }
      },
    },

    // ⑤ 维持与补充储备：检查储备状态，达标则完成，未达标根据饥饿度进食
    {
      id: 'maintain_stock',
      title: '维持食物储备',
      isDone(ctx) {
        const p = determineFoodPriority(ctx.snapshot)
        return p === FOOD_PRIORITY.P4_SUFFICIENT || p === FOOD_PRIORITY.P3_RESERVE
      },
      nextAction(ctx, inst) {
        return foodAction(ctx.snapshot, { inst, memory: ctx.memory, now: ctx.now })
      },
    },
  ],

  completion(ctx) {
    const { cookedCount, totalEdible } = evaluateFoodStock(ctx.snapshot)
    const hunger = pct(ctx.snapshot?.player?.hunger)
    return totalEdible >= 2 && hunger >= 60
  },

  failure(ctx) {
    const actor = ctx.snapshot?.actor
    return Boolean(actor && (actor.alive === false || actor.isGhost === true))
  },
}
