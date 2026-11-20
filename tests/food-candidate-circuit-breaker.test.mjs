// ISSUE-04 测试：多候选食物决策、熔断机制与生存完成判定
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectFoodCandidates,
  foodAction,
  recordTargetFailure,
  purgeExpiredFailures,
} from '../lib/skills/food-candidate-selector.js'
import { survivalStabilize } from '../lib/skills/survival-stabilize.js'

function makeTestSnapshot({ inv = [], pickups = [], harvests = [], threats = [], hunger = 20, health = 50, inLight = true, isGhost = false } = {}) {
  return {
    schema: 'bws.state/1',
    actor: { tileX: 0, tileZ: 0, isGhost },
    player: {
      hunger: { current: hunger, max: 150, percent: Math.round((hunger / 150) * 100) },
      health: { current: health, max: 150, percent: Math.round((health / 150) * 100) },
      in_light: inLight,
      inventory: {
        items: inv.map((prefab, i) => ({ slot: i + 1, prefab, count: 1 })),
      },
      equipment: { slots: {} },
    },
    nearby: {
      buckets: {
        pickupables: pickups.map((p, i) => ({
          ref: `#p${i + 1}`,
          prefab: p.prefab,
          position: { x: p.x, z: p.z },
          distance: Math.hypot(p.x, p.z),
          target_handle: p.handle,
        })),
        harvestables: harvests.map((h, i) => ({
          ref: `#h${i + 1}`,
          prefab: h.prefab,
          position: { x: h.x, z: h.z },
          distance: Math.hypot(h.x, h.z),
          harvest_ready: h.ready !== false,
          target_handle: h.handle,
        })),
        threats: threats.map((t, i) => ({
          ref: `#t${i + 1}`,
          prefab: t.prefab,
          is_attacker: t.attacker ?? true,
          is_targeting_you: t.targeting ?? true,
        })),
      },
    },
  }
}

test('FOOD-01: 背包有安全食物时最高优先级直接 eat', () => {
  const snap = makeTestSnapshot({
    inv: ['berries'],
    pickups: [{ prefab: 'carrot', x: 1, z: 1 }],
  })
  const act = foodAction(snap)
  assert.equal(act.tool, 'eat', '背包有食物应直接 eat')
})

test('FOOD-02: 附近有地面可拾取食物时优先选择并生成移动或拾取动作', () => {
  // 近处地面食物（<=2.2）
  const snapNear = makeTestSnapshot({
    pickups: [{ prefab: 'berries', x: 1, z: 1 }],
  })
  const actNear = foodAction(snapNear)
  assert.equal(actNear.tool, 'pickup_food', '距离 <=2.2 应直接拾取')

  // 远处地面食物 (>2.2)
  const snapFar = makeTestSnapshot({
    pickups: [{ prefab: 'berries', x: 5, z: 5 }],
  })
  const actFar = foodAction(snapFar)
  assert.equal(actFar.tool, 'move_to', '距离较远应先 move_to')
  assert.deepEqual(actFar.args, { x: 5, z: 5 })
})

test('FOOD-03: 附近有成熟胡萝卜/浆果丛时可正确选择', () => {
  const snap = makeTestSnapshot({
    harvests: [
      { prefab: 'berrybush', x: 1, z: 1, ready: true },
    ],
  })
  const act = foodAction(snap)
  assert.equal(act.tool, 'harvest_nearest', '附近成熟植株应采摘')
})

test('FOOD-04: 最近目标失败并熔断后，自动选择下一个候选目标', () => {
  const now = 100_000
  const inst = {
    data: {
      food_failures: {},
    },
  }
  // 两个地面食物：A 在 (2,2) 较近，B 在 (6,6) 稍远
  const snap = makeTestSnapshot({
    pickups: [
      { prefab: 'berries', x: 2, z: 2, handle: 'h_target_a' },
      { prefab: 'carrot', x: 6, z: 6, handle: 'h_target_b' },
    ],
  })

  // 第一次：选中最近的 A
  const act1 = foodAction(snap, { inst, now })
  assert.equal(act1.target_id, 'h_target_a')

  // 模拟目标 A 发生寻路卡死并连续失败 2 次进入熔断
  recordTargetFailure(inst.data.food_failures, 'h_target_a', 'stuck', now)
  recordTargetFailure(inst.data.food_failures, 'h_target_a', 'stuck', now + 1000)

  // 第二次：目标 A 熔断后，应自动切换为目标 B
  const act2 = foodAction(snap, { inst, now: now + 2000 })
  assert.equal(act2.target_id, 'h_target_b', '目标 A 熔断后应自动降级选择目标 B')
  assert.equal(act2.tool, 'move_to')
  assert.deepEqual(act2.args, { x: 6, z: 6 })
})

test('FOOD-05: 熔断过期后目标可以重新评估', () => {
  const now = 100_000
  const inst = {
    data: {
      food_failures: {},
    },
  }
  const snap = makeTestSnapshot({
    pickups: [{ prefab: 'berries', x: 2, z: 2, handle: 'h_target_a' }],
  })

  // 目标 A 失败 2 次进入熔断（冷却 40s）
  recordTargetFailure(inst.data.food_failures, 'h_target_a', 'stuck', now)
  recordTargetFailure(inst.data.food_failures, 'h_target_a', 'stuck', now)

  // 冷却中（now + 10s）：被阻断
  const actBlocked = foodAction(snap, { inst, now: now + 10_000 })
  assert.ok(actBlocked.blocked, '冷却期间应阻止继续向目标 A 移动')

  // 冷却过期后（now + 60s）：清除过期记录并重新评估
  const actRecovered = foodAction(snap, { inst, now: now + 60_000 })
  assert.equal(actRecovered.target_id, 'h_target_a', '冷却过期后应能重新尝试')
})

test('FOOD-06: 所有可见目标都不可达时返回明确 blocked，而不是无限循环', () => {
  const now = 100_000
  const inst = {
    data: {
      food_failures: {},
    },
  }
  const snap = makeTestSnapshot({
    pickups: [
      { prefab: 'berries', x: 2, z: 2, handle: 'h1' },
      { prefab: 'carrot', x: 3, z: 3, handle: 'h2' },
    ],
  })

  // 全部目标均熔断
  recordTargetFailure(inst.data.food_failures, 'h1', 'stuck', now)
  recordTargetFailure(inst.data.food_failures, 'h1', 'stuck', now)
  recordTargetFailure(inst.data.food_failures, 'h2', 'stuck', now)
  recordTargetFailure(inst.data.food_failures, 'h2', 'stuck', now)

  const act = foodAction(snap, { inst, now: now + 5000 })
  assert.ok(act.blocked, '所有食物目标均不可达时应返回 blocked')
  assert.equal(act.reason, 'all_food_candidates_blocked')
})

test('FOOD-07: 生存技能完成条件严格校验健康、饥饿、威胁与幽灵状态', () => {
  // 1. 饥饿未达标：不能完成
  const snapHungry = makeTestSnapshot({ hunger: 30, health: 100, inLight: true })
  assert.equal(survivalStabilize.completion({ snapshot: snapHungry }), false, '饥饿不足不能完成')

  // 2. 有暗影怪追击威胁：不能完成
  const snapThreat = makeTestSnapshot({
    hunger: 100, health: 100, inLight: true,
    threats: [{ prefab: 'crawlinghorror', attacker: true }],
  })
  assert.equal(survivalStabilize.completion({ snapshot: snapThreat }), false, '存在威胁攻击时不能完成')

  // 3. 灵魂状态：绝不能完成
  const snapGhost = makeTestSnapshot({ hunger: 100, health: 100, inLight: true, isGhost: true })
  assert.equal(survivalStabilize.completion({ snapshot: snapGhost }), false, '角色处于灵魂状态绝不能算生存稳定')

  // 4. 处于安全指标：完成
  const snapStable = makeTestSnapshot({ hunger: 100, health: 100, inLight: true, threats: [] })
  assert.equal(survivalStabilize.completion({ snapshot: snapStable }), true, '各项指标健康时生存稳定完成')
})
