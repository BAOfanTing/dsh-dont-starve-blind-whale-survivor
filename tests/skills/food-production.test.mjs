import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FOOD_PRIORITY,
  evaluateFoodStock,
  findNearbyCookpot,
  determineFoodPriority,
  selectIngredientsForPot,
  foodProduction,
} from '../../lib/skills/food-production-skill.js'
import { getSkill, hasSkill } from '../../lib/skills/skill-registry.js'
import '../../lib/skills/index.js' // 触发 ensureSkillsRegistered()

function makeSnapshot({
  health = 100,
  hunger = 100,
  sanity = 100,
  items = [],
  structures = [],
  actor = { valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0 },
} = {}) {
  return {
    schema: 'bws.state/1',
    actor,
    player: {
      health: { current: health, max: 100, percent: health },
      hunger: { current: hunger, max: 100, percent: hunger },
      sanity: { current: sanity, max: 100, percent: sanity },
      inventory: {
        items: items.map((it, idx) => ({ slot: idx + 1, ...it })),
      },
    },
    nearby: {
      snapshot_id: 's123',
      buckets: {
        structures,
      },
    },
  }
}

test('FP-1: 技能正确注册到技能注册表中', () => {
  assert.equal(hasSkill('food_production'), true)
  const skill = getSkill('food_production')
  assert.equal(skill.id, 'food_production')
  assert.equal(skill.steps.length, 5)
})

test('FP-2: evaluateFoodStock 准确统计熟食、生肉与填充物', () => {
  const snapshot = makeSnapshot({
    items: [
      { prefab: 'meatballs', count: 2 },
      { prefab: 'meat', count: 1 },
      { prefab: 'berries', count: 4 },
      { prefab: 'twigs', count: 10 }, // 非食物
    ],
  })
  const stock = evaluateFoodStock(snapshot)
  assert.equal(stock.cookedCount, 2)
  assert.equal(stock.meatCount, 1)
  assert.equal(stock.fillerCount, 4)
  assert.equal(stock.totalEdible, 7)
})

test('FP-3: determineFoodPriority 区分 P0 到 P4 优先级', () => {
  // P0: 濒死 (health < 25%)
  const sP0 = makeSnapshot({ health: 20, hunger: 90 })
  assert.equal(determineFoodPriority(sP0), FOOD_PRIORITY.P0_LETHAL)

  // P1: 饥饿临界 (hunger < 40%)
  const sP1 = makeSnapshot({ health: 80, hunger: 35 })
  assert.equal(determineFoodPriority(sP1), FOOD_PRIORITY.P1_CRITICAL)

  // P2: 食物储备不足 (totalEdible < 2 或 hunger < 60%)
  const sP2 = makeSnapshot({ health: 80, hunger: 55, items: [] })
  assert.equal(determineFoodPriority(sP2), FOOD_PRIORITY.P2_DEFICIT)

  // P3: 熟食储备不足 (cookedCount < 3)
  const sP3 = makeSnapshot({
    health: 90,
    hunger: 80,
    items: [{ prefab: 'berries', count: 5 }],
  })
  assert.equal(determineFoodPriority(sP3), FOOD_PRIORITY.P3_RESERVE)

  // P4: 食物与熟食充足
  const sP4 = makeSnapshot({
    health: 90,
    hunger: 80,
    items: [{ prefab: 'meatballs', count: 3 }],
  })
  assert.equal(determineFoodPriority(sP4), FOOD_PRIORITY.P4_SUFFICIENT)
})

test('FP-4: selectIngredientsForPot 优先组合肉丸（1肉+3填充物）', () => {
  const snapshot = makeSnapshot({
    items: [
      { prefab: 'monstermeat', count: 1 },
      { prefab: 'berries', count: 5 },
    ],
  })
  const ing = selectIngredientsForPot(snapshot)
  assert.deepEqual(ing, ['monstermeat', 'berries', 'berries', 'berries'])
})

test('FP-5: findNearbyCookpot 准确识别锅状态（已完成 > 空闲 > 烹饪中）', () => {
  const snapshot = makeSnapshot({
    structures: [
      { prefab: 'cookpot', ref: 'p1', handle: 'h1', stewer: { cooking: true, done: false, time_left: 15 } },
      { prefab: 'cookpot', ref: 'p2', handle: 'h2', stewer: { cooking: false, done: true, product: 'meatballs' } },
    ],
  })
  const info = findNearbyCookpot(snapshot)
  assert.equal(info.status, 'done')
  assert.equal(info.product, 'meatballs')
})

test('FP-6: 步骤 emergency_eat 在 P0/P1 时不完成，并给出采食/进食动作', () => {
  const step = foodProduction.steps.find((s) => s.id === 'emergency_eat')
  const ctx = {
    snapshot: makeSnapshot({
      hunger: 30,
      items: [{ prefab: 'berries', count: 2 }],
    }),
    now: 1000,
    memory: {},
  }
  assert.equal(step.isDone(ctx), false)
  const act = step.nextAction(ctx, { step_attempts: 0 })
  assert.ok(act)
  assert.equal(act.tool, 'eat')
  assert.equal(act.args.food, 'berries')
})

test('FP-7: 步骤 harvest_pot 在锅煮好时引导取出成品', () => {
  const step = foodProduction.steps.find((s) => s.id === 'harvest_pot')
  const ctx = {
    snapshot: makeSnapshot({
      hunger: 80,
      structures: [
        { prefab: 'cookpot', ref: 'p2', handle: 'h2', position: { x: 0, z: 0 }, stewer: { cooking: false, done: true, product: 'meatballs' } },
      ],
    }),
  }
  assert.equal(step.isDone(ctx), false)
  const act = step.nextAction(ctx)
  assert.equal(act.tool, 'cook')
  assert.equal(act.target_handle, 'h2')
})

test('FP-8: 步骤 cook_dish 材料齐备时引导下锅烹饪', () => {
  const step = foodProduction.steps.find((s) => s.id === 'cook_dish')
  const ctx = {
    snapshot: makeSnapshot({
      hunger: 80,
      items: [
        { prefab: 'meat', count: 1 },
        { prefab: 'berries', count: 3 },
      ],
      structures: [
        { prefab: 'cookpot', ref: 'p1', handle: 'h1', position: { x: 0, z: 0 }, stewer: { cooking: false, done: false } },
      ],
    }),
  }
  assert.equal(step.isDone(ctx), false)
  const act = step.nextAction(ctx)
  assert.equal(act.tool, 'cook')
  assert.equal(act.target_handle, 'h1')
  assert.equal(act.args.items, 'meat,berries,berries,berries')
})
