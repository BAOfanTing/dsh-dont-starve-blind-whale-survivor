import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recordTargetFailure,
  purgeExpiredFailures,
  collectFoodCandidates,
  MAX_TARGET_FAILURES,
} from '../lib/skills/food-candidate-selector.js'

test('FOOD-CIRCUIT-01: 目标冷却到期后可重新被选中，即使失败次数 >= 5（绝无永久封禁）', () => {
  const failureMemory = {}
  const targetId = 'harvest:berrybush@10,10'
  const t0 = 1000

  // 连续失败 6 次
  for (let i = 0; i < 6; i++) {
    recordTargetFailure(failureMemory, targetId, 'action_failed', t0)
  }
  assert.equal(failureMemory[targetId].failure_count, 6)
  const cooldownUntil = failureMemory[targetId].blocked_until
  assert.ok(cooldownUntil > t0)

  const snapshot = {
    actor: { tileX: 0, tileZ: 0 },
    nearby: {
      buckets: {
        harvestables: [
          { prefab: 'berrybush', x: 10, z: 10, ready: true },
        ],
      },
    },
    ground: [],
  }

  // 冷却期内：目标不可达（reachable: false）
  const duringCooldown = collectFoodCandidates(snapshot, { failureMemory, now: t0 + 1000 })
  const targetDuring = duringCooldown.find((c) => c.target_id === targetId)
  assert.ok(targetDuring)
  assert.equal(targetDuring.reachable, false, '冷却期内目标应当标记为不可达')

  // 冷却到期后 (cooldownUntil + 1)：目标恢复可达（reachable: true）
  const afterCooldown = collectFoodCandidates(snapshot, { failureMemory, now: cooldownUntil + 1 })
  const targetAfter = afterCooldown.find((c) => c.target_id === targetId)
  assert.ok(targetAfter)
  assert.equal(targetAfter.reachable, true, '冷却到期后必须恢复可达状态，不得永久封禁')
})

test('FOOD-CIRCUIT-02: reflex_active 抢占不计入目标失败', () => {
  const failureMemory = {}
  const targetId = 'entity:berrybush@10,10'
  const t0 = 1000

  recordTargetFailure(failureMemory, targetId, 'reflex_active', t0)
  assert.equal(failureMemory[targetId], undefined, '保命反射抢占绝不得计入目标失败')
})

test('FOOD-CIRCUIT-03: actor_busy 忙碌不计入目标失败', () => {
  const failureMemory = {}
  const targetId = 'entity:berrybush@10,10'
  const t0 = 1000

  recordTargetFailure(failureMemory, targetId, 'actor_busy', t0)
  assert.equal(failureMemory[targetId], undefined, '角色动作忙碌绝不得计入目标失败')
})

test('FOOD-CIRCUIT-04: result_timeout 与 awaiting_reconciliation 不对目标记录惩罚', () => {
  const failureMemory = {}
  const targetId = 'entity:berrybush@10,10'
  const t0 = 1000

  recordTargetFailure(failureMemory, targetId, 'result_timeout', t0)
  recordTargetFailure(failureMemory, targetId, 'awaiting_reconciliation', t0)
  assert.equal(failureMemory[targetId], undefined, '超时与对账状态不得当作普通动作失败拉黑目标')
})

test('FOOD-CIRCUIT-05: 指数退避冷却上限封顶 60s', () => {
  const failureMemory = {}
  const targetId = 'entity:berrybush@10,10'
  const t0 = 1000

  // 连续失败 10 次
  for (let i = 0; i < 10; i++) {
    recordTargetFailure(failureMemory, targetId, 'pick_failed', t0)
  }
  const cooldownDuration = failureMemory[targetId].blocked_until - t0
  assert.ok(cooldownDuration <= 60_000, `冷却时间 (${cooldownDuration}ms) 必须封顶在 60000ms 内`)
  assert.equal(cooldownDuration, 60_000)
})

test('FOOD-CIRCUIT-06: purgeExpiredFailures 清理超过 TTL (120s) 的记录', () => {
  const failureMemory = {
    'target_old': { failure_count: 3, blocked_until: 5000, updated_at: 5000 },
    'target_new': { failure_count: 1, blocked_until: 150000, updated_at: 140000 },
  }
  const now = 135000 // 距离 target_old 超过 120s
  purgeExpiredFailures(failureMemory, now)

  assert.equal(failureMemory['target_old'], undefined, '超过 TTL 的陈旧记录应被自动清理')
  assert.ok(failureMemory['target_new'], '活跃记录应当保留')
})

test('FOOD-CIRCUIT-07: 容量限制淘汰最老记录不超过 50 条', () => {
  const failureMemory = {}
  for (let i = 0; i < 60; i++) {
    failureMemory[`target_${i}`] = {
      failure_count: 1,
      blocked_until: 1000 + i * 10,
      updated_at: 1000 + i * 10,
    }
  }

  purgeExpiredFailures(failureMemory, 1000, 50)
  const count = Object.keys(failureMemory).length
  assert.ok(count <= 50, `失败字典容量必须受限（当前 ${count} <= 50）`)
  // 最老的 target_0 应被淘汰
  assert.equal(failureMemory['target_0'], undefined)
  // 最新的 target_59 应保留
  assert.ok(failureMemory['target_59'])
})

test('FOOD-CIRCUIT-08: target_gone 与 no_target 及时清除目标', () => {
  const failureMemory = {
    'entity:berrybush@10,10': { failure_count: 2, blocked_until: 50000 },
  }
  recordTargetFailure(failureMemory, 'entity:berrybush@10,10', 'target_gone', 1000)
  assert.equal(failureMemory['entity:berrybush@10,10'], undefined, '目标消失后应直接从失败记忆中移除')
})
