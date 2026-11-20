// 食物多候选决策与目标熔断选择器 (bws.food-candidate-selector)
//
// 解决实战问题（ISSUE-04）：
//   1. 不再只选单一最近目标，建立多目标候选集（背包/地面/成熟植株）。
//   2. 目标级失败与熔断记忆（stuck / out_of_range / target_gone）。
//   3. 连续失败目标进入短期冷却 (blocked_until)，自动切换到其他候选目标。
//   4. 有界定向探索与超时保护，防止单次 seek 持续卡死整个运行时。

import { EDIBLE } from './skill-utils.js'

/** 默认目标连续失败阈值与熔断冷却时间 (毫秒) */
export const MAX_TARGET_FAILURES = 2
export const TARGET_COOLDOWN_BASE_MS = 20_000

function posOf(item) {
  if (!item) return null
  const p = item.position
  if (p && typeof p.x === 'number' && typeof p.z === 'number') return { x: p.x, z: p.z }
  if (typeof item.x === 'number' && typeof item.z === 'number') return { x: item.x, z: item.z }
  if (typeof item.tile_x === 'number' && typeof item.tile_z === 'number') return { x: item.tile_x, z: item.tile_z }
  return null
}

function bucketItems(snapshot, key) {
  const buckets = snapshot?.nearby?.buckets
  if (!buckets) return []
  if (Array.isArray(buckets)) return buckets.find((g) => g?.kind === key)?.items ?? []
  const list = buckets[key]
  return Array.isArray(list) ? list : Object.values(list ?? {})
}

function inventoryItems(snapshot) {
  const inv = snapshot?.player?.inventory?.items
  if (!inv) return []
  return Array.isArray(inv) ? inv : Object.values(inv)
}

/**
 * 构造稳定 target_id
 */
export function targetIdOf(item, source = 'entity') {
  if (item?.target_handle) return String(item.target_handle)
  if (item?.ref) return `${source}:${item.ref}`
  const p = posOf(item)
  const posKey = p ? `@${Math.round(p.x)},${Math.round(p.z)}` : ''
  return `${source}:${item?.prefab || 'unknown'}${posKey}`
}

/**
 * 收集并评分当前快照下所有安全食物候选集
 * @param {object} snapshot
 * @param {{ failureMemory?: object, now?: number }} [opts]
 * @returns {Array<object>} 候选目标列表（按评分降序排列）
 */
export function collectFoodCandidates(snapshot, { failureMemory = {}, now = Date.now() } = {}) {
  const candidates = []
  const actor = snapshot?.actor
  const actorPos = actor && typeof actor.tileX === 'number' ? { x: actor.tileX, z: actor.tileZ } : null

  // 1. 背包内安全食物
  for (const it of inventoryItems(snapshot)) {
    const prefab = String(it?.prefab ?? '')
    if (EDIBLE.has(prefab)) {
      candidates.push({
        target_id: `inv:${prefab}`,
        prefab,
        position: actorPos,
        distance: 0,
        source: 'inventory',
        reachable: true,
        failed_count: 0,
        blocked_until: 0,
        score: 1000 + (Number(it?.count ?? 1) * 10),
        raw: it,
      })
    }
  }

  // 2. 地面可拾取食物
  for (const it of bucketItems(snapshot, 'pickupables')) {
    const prefab = String(it?.prefab ?? '')
    if (EDIBLE.has(prefab)) {
      const pos = posOf(it)
      let dist = typeof it.distance === 'number' ? it.distance : 999
      if (pos && actorPos) {
        dist = Math.min(dist, Math.hypot(pos.x - actorPos.x, pos.z - actorPos.z))
      }
      const tid = targetIdOf(it, 'pickup')
      const failRec = failureMemory[tid]
      const failedCount = failRec?.failure_count ?? 0
      const blockedUntil = failRec?.blocked_until ?? 0
      const isBlocked = blockedUntil > now || failedCount >= MAX_TARGET_FAILURES

      candidates.push({
        target_id: tid,
        prefab,
        position: pos,
        distance: dist,
        source: 'pickupables',
        reachable: !isBlocked,
        failed_count: failedCount,
        blocked_until: blockedUntil,
        // 评分：基础分 500 - 距离惩罚 - 失败惩罚
        score: isBlocked ? -100 : (500 - dist * 15 - failedCount * 100),
        raw: it,
      })
    }
  }

  // 3. 成熟农作物与植株（成熟浆果、胡萝卜等）
  for (const it of bucketItems(snapshot, 'harvestables')) {
    const prefab = String(it?.prefab ?? '')
    const isFoodPlant = /berrybush|carrot|mushroom/i.test(prefab) || it?.is_food === true
    const isRipe = it?.harvest_ready !== false
    if (isFoodPlant && isRipe) {
      const pos = posOf(it)
      let dist = typeof it.distance === 'number' ? it.distance : 999
      if (pos && actorPos) {
        dist = Math.min(dist, Math.hypot(pos.x - actorPos.x, pos.z - actorPos.z))
      }
      const tid = targetIdOf(it, 'harvest')
      const failRec = failureMemory[tid]
      const failedCount = failRec?.failure_count ?? 0
      const blockedUntil = failRec?.blocked_until ?? 0
      const isBlocked = blockedUntil > now || failedCount >= MAX_TARGET_FAILURES

      candidates.push({
        target_id: tid,
        prefab,
        position: pos,
        distance: dist,
        source: 'harvestables',
        reachable: !isBlocked,
        failed_count: failedCount,
        blocked_until: blockedUntil,
        score: isBlocked ? -100 : (300 - dist * 12 - failedCount * 80),
        raw: it,
      })
    }
  }

  // 排序：评分高的排在前面
  candidates.sort((a, b) => b.score - a.score)
  return candidates
}

/**
 * 记录目标执行失败（熔断记录）
 * @param {object} failureMemory
 * @param {string} targetId
 * @param {string} reason
 * @param {number} [now]
 */
export function recordTargetFailure(failureMemory, targetId, reason = 'failed', now = Date.now()) {
  if (!failureMemory || !targetId) return
  const cur = failureMemory[targetId] || { failure_count: 0 }
  const count = cur.failure_count + 1
  const cooldown = TARGET_COOLDOWN_BASE_MS * Math.pow(2, Math.min(3, count - 1))
  failureMemory[targetId] = {
    target_id: targetId,
    failure_count: count,
    blocked_until: now + cooldown,
    last_failure_reason: reason,
  }
}

/**
 * 清除已过期的熔断记录
 */
export function purgeExpiredFailures(failureMemory, now = Date.now()) {
  if (!failureMemory) return
  for (const [k, v] of Object.entries(failureMemory)) {
    if (v && v.blocked_until <= now && v.failure_count < 5) {
      delete failureMemory[k]
    }
  }
}

/**
 * 多候选食物决策执行函数（替换旧版单一 foodAction）
 * @param {object} snapshot
 * @param {{ inst?: object, failureMemory?: object, now?: number }} [opts]
 */
export function foodAction(snapshot, { inst = null, failureMemory = null, now = Date.now() } = {}) {
  // 绑定 instance 的失败记忆字典
  if (!failureMemory && inst) {
    if (!inst.data) inst.data = {}
    if (!inst.data.food_failures) inst.data.food_failures = {}
    failureMemory = inst.data.food_failures
  }
  purgeExpiredFailures(failureMemory, now)

  const candidates = collectFoodCandidates(snapshot, { failureMemory: failureMemory ?? {}, now })

  // 1. 优先吃背包里的现成食物
  const invFood = candidates.find((c) => c.source === 'inventory')
  if (invFood) {
    return { tool: 'eat', args: { food: invFood.prefab }, target_id: invFood.target_id }
  }

  // 2. 选择可达的最高分目标
  const available = candidates.filter((c) => c.reachable)
  if (available.length > 0) {
    const best = available[0]
    if (best.source === 'pickupables') {
      if (best.distance > 2.2 && best.position) {
        return {
          tool: 'move_to',
          args: { x: Math.round(best.position.x), z: Math.round(best.position.z) },
          target_id: best.target_id,
        }
      }
      return { tool: 'pickup_food', args: {}, target_id: best.target_id }
    }
    if (best.source === 'harvestables') {
      if (best.distance > 1.5 && best.position) {
        return {
          tool: 'move_to',
          args: { x: Math.round(best.position.x), z: Math.round(best.position.z) },
          target_id: best.target_id,
        }
      }
      return { tool: 'harvest_nearest', args: { target_kind: 'ripe_food_plant' }, target_id: best.target_id }
    }
  }

  // 3. 所有可见候选都已熔断或失败
  const blockedCount = candidates.filter((c) => !c.reachable).length
  if (candidates.length > 0 && blockedCount === candidates.length) {
    return {
      blocked: `所有可见食物目标均不可达或处于熔断冷却中 (${blockedCount} 个目标失败)`,
      reason: 'all_food_candidates_blocked',
    }
  }

  // 4. 附近确实没有食物 → 启动有边界的短时探索（seek）
  return {
    tool: 'seek',
    args: { prefab: 'berrybush', step: 6, max_tiles: 24, look: 16 },
    budget_s: 15, // 寻食限制短时预算 15s，避免 100s 卡死
  }
}
