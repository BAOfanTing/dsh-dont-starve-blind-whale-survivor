// 食物多候选决策与目标熔断选择器 (bws.food-candidate-selector)
//
// 解决实战问题（ISSUE-04 / ISSUE-05）：
//   1. 不再只选单一最近目标，建立多目标候选集（背包/地面/成熟植株）。
//   2. 区分食物营养与用途（饥饿、生命、理智），杜绝把花瓣当万能饱食食物。
//   3. 区分目标失败类型（reflex_active / actor_busy 不拉黑目标；target_gone 清理记录）。
//   4. 目标级失败与短期熔断（blocked_until），冷却到期后自动恢复重新评分，杜绝永久封禁。
//   5. 限制失败记忆规模与定期清理（TTL / LRU）。
//   6. 有界定向探索与超时保护，seek 预算 15s 真正进入执行链。

import { EDIBLE } from './skill-utils.js'
import { findKnownResource, exploreFrontier } from './explore-utils.js'

/** 默认目标连续失败阈值与熔断冷却时间 (毫秒) */
export const MAX_TARGET_FAILURES = 2
export const TARGET_COOLDOWN_BASE_MS = 20_000

/**
 * 饥荒食物效果权威数据（hunger / health / sanity）
 * 与游戏原生数据对齐：
 * 花瓣 petals: hunger=0, health=1, sanity=0（吃）/ 5（采）
 * 熟食优于生食，高价值蔬菜（茄子/南瓜）强力回血
 */
export const FOOD_EFFECTS = {
  // 熟食（高饱食度 / 高回血）
  meat_cooked: { hunger: 25, health: 3, sanity: 0, veggie: false },
  smallmeat_cooked: { hunger: 12.5, health: 1, sanity: 0, veggie: false },
  froglegs_cooked: { hunger: 12.5, health: 1, sanity: 0, veggie: false },
  fish_cooked: { hunger: 12.5, health: 2, sanity: 0, veggie: false },
  eggplant_cooked: { hunger: 25, health: 20, sanity: 0, veggie: true },
  pumpkin_cooked: { hunger: 37.5, health: 8, sanity: 0, veggie: true },
  carrot_cooked: { hunger: 12.5, health: 3, sanity: 0, veggie: true },
  corn_cooked: { hunger: 25, health: 3, sanity: 0, veggie: true },
  berries_cooked: { hunger: 12.5, health: 1, sanity: 0, veggie: true },
  berries_juicy_cooked: { hunger: 18.75, health: 1, sanity: 0, veggie: true },
  acorn_cooked: { hunger: 12.5, health: 1, sanity: 0, veggie: true },

  // 生基础食物
  honey: { hunger: 9.375, health: 3, sanity: 0, veggie: false },
  meat: { hunger: 25, health: 1, sanity: -10, veggie: false },
  smallmeat: { hunger: 12.5, health: 1, sanity: -10, veggie: false },
  froglegs: { hunger: 12.5, health: 0, sanity: -10, veggie: false },
  fish: { hunger: 12.5, health: 1, sanity: 0, veggie: false },
  pumpkin: { hunger: 37.5, health: 3, sanity: 0, veggie: true },
  eggplant: { hunger: 25, health: 8, sanity: 0, veggie: true },
  corn: { hunger: 25, health: 3, sanity: 0, veggie: true },
  carrot: { hunger: 12.5, health: 1, sanity: 0, veggie: true },
  berries: { hunger: 9.375, health: 0, sanity: 0, veggie: true },
  berries_juicy: { hunger: 12.5, health: 0, sanity: 0, veggie: true },

  // 花瓣：0 饥饿，1 生命，0 理智（吃）
  petals: { hunger: 0, health: 1, sanity: 0, veggie: true, special: 'petals' },
}

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
  const inv = snapshot?.player?.inventory?.items || snapshot?.inventory?.items || snapshot?.inventory
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
 * 计算食物对于特定生存需求的营养价值评分
 */
function scoreFoodEffect(prefab, need = null) {
  const eff = FOOD_EFFECTS[prefab] || (EDIBLE.has(prefab) ? { hunger: 5, health: 0, sanity: 0 } : { hunger: 0, health: 0, sanity: 0 })
  if (need === 'hunger') {
    if (eff.hunger <= 0) return -9999 // 不能解饥饿（杜绝花瓣）
    return eff.hunger * 20 + eff.health * 2 + (eff.sanity < 0 ? eff.sanity * 5 : 0)
  }
  if (need === 'health') {
    if (eff.health <= 0) return -9999 // 不能回血
    return eff.health * 30 + eff.hunger * 2 + (eff.sanity < 0 ? eff.sanity * 5 : 0)
  }
  if (need === 'sanity') {
    if (eff.sanity < 0) return -9999 // 负理智食物严禁在理智需求时使用（杜绝生肉/生蛙腿等）
    return eff.sanity * 30 + eff.hunger * 2
  }
  if (need === 'both') {
    return eff.hunger * 15 + eff.health * 20 + (eff.sanity < 0 ? eff.sanity * 5 : eff.sanity * 2)
  }
  // 综合评估
  return eff.hunger * 10 + eff.health * 10 + (eff.sanity < 0 ? eff.sanity * 5 : eff.sanity * 2)
}

/**
 * 收集并评分当前快照下所有安全食物候选集
 * @param {object} snapshot
 * @param {{ failureMemory?: object, now?: number, need?: string }} [opts]
 * @returns {Array<object>} 候选目标列表（按评分降序排列）
 */
export function collectFoodCandidates(snapshot, { failureMemory = {}, now = Date.now(), need = null } = {}) {
  const candidates = []
  const actor = snapshot?.actor
  const actorPos = actor && typeof actor.tileX === 'number' ? { x: actor.tileX, z: actor.tileZ } : null

  // 1. 背包内安全食物
  for (const it of inventoryItems(snapshot)) {
    const prefab = String(it?.prefab ?? '')
    if (EDIBLE.has(prefab)) {
      const eff = FOOD_EFFECTS[prefab] || { hunger: 10, health: 0, sanity: 0 }
      // 若当前需求仅为 hunger，花瓣等不恢复饥饿的物品不得作为候选
      if (need === 'hunger' && eff.hunger <= 0) continue
      // 若当前需求仅为 health，不回血的物品不得作为首选
      if (need === 'health' && eff.health <= 0) continue

      const effectScore = scoreFoodEffect(prefab, need)
      if (effectScore <= -9000) continue

      const freshness = typeof it?.freshness === 'number' ? it.freshness : (typeof it?.perish_percent === 'number' ? it.perish_percent : 1)
      const targetId = it?.id ? `inv:${it.id}` : `inv:${prefab}`
      candidates.push({
        target_id: targetId,
        id: it?.id ?? targetId,
        prefab,
        position: actorPos,
        distance: 0,
        source: 'inventory',
        reachable: true,
        failed_count: 0,
        blocked_until: 0,
        effects: eff,
        score: 1000 + (Number(it?.count ?? 1) * 10) + effectScore + (freshness * 50),
        raw: it,
      })
    }
  }

  // 2. 地面可拾取食物
  for (const it of bucketItems(snapshot, 'pickupables')) {
    const prefab = String(it?.prefab ?? '')
    if (EDIBLE.has(prefab)) {
      const eff = FOOD_EFFECTS[prefab] || { hunger: 10, health: 0, sanity: 0 }
      if (need === 'hunger' && eff.hunger <= 0) continue
      if (need === 'health' && eff.health <= 0) continue

      const pos = posOf(it)
      let dist = typeof it.distance === 'number' ? it.distance : 999
      if (pos && actorPos) {
        dist = Math.min(dist, Math.hypot(pos.x - actorPos.x, pos.z - actorPos.z))
      }
      const tid = targetIdOf(it, 'pickup')
      const failRec = failureMemory[tid]
      const failedCount = failRec?.failure_count ?? 0
      const blockedUntil = failRec?.blocked_until ?? 0
      // 冷却到期后必须能够恢复参与评分，绝不永久封禁！
      const isBlocked = blockedUntil > now
      const effectScore = scoreFoodEffect(prefab, need)

      candidates.push({
        target_id: tid,
        prefab,
        position: pos,
        distance: dist,
        source: 'pickupables',
        reachable: !isBlocked,
        failed_count: failedCount,
        blocked_until: blockedUntil,
        effects: eff,
        // 评分：基础分 500 - 距离惩罚 - 失败惩罚 + 营养价值
        score: isBlocked ? -100 : (500 - dist * 15 - Math.min(5, failedCount) * 40 + effectScore),
        raw: it,
      })
    }
  }

  // 3. 成熟植株：采下来的是**真实产物**（berrybush->berries / carrot_planted->carrot）。
  //    P1-4：不再对植株硬编码 effects，也不把生蘑菇当食物（生红蘑菇 -20 血、生绿/蓝蘑菇掉理智，均不在 AUTO_SAFE）。
  for (const it of bucketItems(snapshot, 'harvestables')) {
    const prefab = String(it?.prefab ?? '')
    const isRipe = it?.harvest_ready !== false
    if (!isRipe) continue
    let product = null
    if (/berrybush/i.test(prefab)) product = /juicy/i.test(prefab) ? 'berries_juicy' : 'berries'
    else if (/carrot/i.test(prefab)) product = 'carrot'
    else if (/mushroom|_cap$/i.test(prefab)) product = null   // 生蘑菇不纳入（需先 cook）
    else if (it?.is_food === true && EDIBLE.has(prefab)) product = prefab
    if (!product) continue
    const eff = FOOD_EFFECTS[product]
    if (!eff) continue
    if (need === 'hunger' && eff.hunger <= 0) continue
    if (need === 'health' && eff.health <= 0) continue
    const effectScore = scoreFoodEffect(product, need)
    if (effectScore <= -9000) continue
    const pos = posOf(it)
    let dist = typeof it.distance === 'number' ? it.distance : 999
    if (pos && actorPos) dist = Math.min(dist, Math.hypot(pos.x - actorPos.x, pos.z - actorPos.z))
    const tid = targetIdOf(it, 'harvest')
    const failRec = failureMemory[tid]
    const failedCount = failRec?.failure_count ?? 0
    const blockedUntil = failRec?.blocked_until ?? 0
    const isBlocked = blockedUntil > now
    candidates.push({
      target_id: tid,
      prefab: product,
      position: pos,
      distance: dist,
      source: 'harvestables',
      reachable: !isBlocked,
      failed_count: failedCount,
      blocked_until: blockedUntil,
      effects: eff,
      score: isBlocked ? -100 : (300 - dist * 12 - Math.min(5, failedCount) * 35 + effectScore),
      raw: it,
    })
  }

  // 排序：评分高的排在前面
  candidates.sort((a, b) => b.score - a.score)
  return candidates
}

/**
 * 记录目标执行失败（熔断记录）
 * 区分失败类型（ISSUE-05）：
 * 1. reflex_active: 控制权被抢占，不计入目标失败。
 * 2. actor_busy: 执行冲突，不计入目标失败。
 * 3. result_timeout / awaiting_reconciliation: 结果未知需对账，不计入目标失败。
 * 4. target_gone: 目标消失，清理记忆。
 * 5. stuck / out_of_range: 记录短期熔断与指数退避（上限 60s）。
 * @param {object} failureMemory
 * @param {string} targetId
 * @param {string} reason
 * @param {number} [now]
 */
export function recordTargetFailure(failureMemory, targetId, reason = 'failed', now = Date.now()) {
  if (!failureMemory || !targetId) return

  // 过滤不应计为目标失败的系统状态
  if (reason === 'reflex_active' || reason === 'actor_busy' || reason === 'result_timeout' || reason === 'awaiting_reconciliation') {
    return
  }

  // 目标已消失：直接清理旧记录
  if (reason === 'target_gone' || reason === 'entity_gone' || reason === 'no_target') {
    delete failureMemory[targetId]
    return
  }

  // 记录短期熔断
  const cur = failureMemory[targetId] || { failure_count: 0 }
  const count = cur.failure_count + 1
  const cooldown = Math.min(60_000, TARGET_COOLDOWN_BASE_MS * Math.pow(1.5, Math.min(4, count - 1)))
  failureMemory[targetId] = {
    target_id: targetId,
    failure_count: count,
    blocked_until: now + cooldown,
    last_failure_reason: reason,
    updated_at: now,
  }
}

/**
 * 清除已过期的熔断记录并限制记忆规模
 */
export function purgeExpiredFailures(failureMemory, now = Date.now(), maxRecords = 50) {
  if (!failureMemory) return
  const TTL = 120_000 // 记录 TTL 120 秒
  for (const [k, v] of Object.entries(failureMemory)) {
    if (!v) {
      delete failureMemory[k]
      continue
    }
    const lastActive = v.updated_at || v.blocked_until || 0
    if (now - lastActive > TTL || (v.blocked_until <= now && now - v.blocked_until > 30_000)) {
      delete failureMemory[k]
    }
  }

  // 限制失败记忆规模，防止无限累加
  const entries = Object.entries(failureMemory)
  if (entries.length > maxRecords) {
    entries.sort((a, b) => (a[1]?.updated_at || 0) - (b[1]?.updated_at || 0))
    const toRemove = entries.length - maxRecords
    for (let i = 0; i < toRemove; i++) {
      delete failureMemory[entries[i][0]]
    }
  }
}

/**
 * 多候选食物决策执行函数
 * @param {object} snapshot
 * @param {{ inst?: object, failureMemory?: object, now?: number, need?: string }} [opts]
 */
export function foodAction(snapshot, second = {}, third = {}) {
  let opts = {}
  if (second && (second.data || second.instance_id)) {
    opts = { ...(third || {}), inst: second }
  } else {
    opts = second || {}
  }
  const { inst = null, failureMemory = null, now = Date.now(), need = null, memory = null } = opts

  // 绑定 instance 的失败记忆字典
  let effFailureMemory = failureMemory
  if (!effFailureMemory && inst) {
    if (!inst.data) inst.data = {}
    if (!inst.data.food_failures) inst.data.food_failures = {}
    effFailureMemory = inst.data.food_failures
  }
  purgeExpiredFailures(effFailureMemory, now)

  // 判定当前生存需求
  let effectiveNeed = need
  if (!effectiveNeed) {
    const hungerP = snapshot?.player?.hunger?.percent ?? 100
    const healthP = snapshot?.player?.health?.percent ?? 100
    const isWolfgang = snapshot?.actor?.prefab === 'wolfgang'
    const hgThresh = isWolfgang ? 55 : 40
    if (hungerP < hgThresh && healthP < 45) effectiveNeed = 'both'
    else if (hungerP < hgThresh) effectiveNeed = 'hunger'
    else if (healthP < 45) effectiveNeed = 'health'
  }

  const candidates = collectFoodCandidates(snapshot, { failureMemory: effFailureMemory ?? {}, now, need: effectiveNeed })

  // 1. 优先吃背包里的现成合适食物
  const invFood = candidates.find((c) => c.source === 'inventory' && c.reachable)
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

  // 3. 所有可见候选都已熔断或处于冷却中
  const blockedCount = candidates.filter((c) => !c.reachable).length
  if (candidates.length > 0 && blockedCount === candidates.length) {
    return {
      blocked: `所有可见食物目标均不可达或处于熔断冷却中 (${blockedCount} 个目标失败)`,
      reason: 'all_food_candidates_blocked',
    }
  }

  // 4. 附近没有食物 → 先查 WorldMemory 已知食物资源：导航过去，不再二次盲找！
  const effMemory = memory || inst?.memory || null
  const actor = snapshot?.actor
  const actorPos = actor && typeof actor.tileX === 'number' ? { x: actor.tileX, z: actor.tileZ } : null

  if (effMemory && actorPos) {
    const knownFood = findKnownResource(effMemory, (r) => r.category === 'food', actorPos)
    if (knownFood) {
      const dist = Math.hypot(knownFood.x - actorPos.x, knownFood.z - actorPos.z)
      if (dist > 2.5) {
        return {
          tool: 'move_to',
          args: { x: Math.round(knownFood.x), z: Math.round(knownFood.z) },
          target_id: knownFood.id,
        }
      }
    }
  }

  // 5. 兜底（启动有边界的短时探索 seek）：
  return {
    tool: 'seek',
    args: { prefab: 'berrybush', step: 6, max_tiles: 24, look: 16 },
    budget_s: 15, // 寻食限制短时预算 15s
  }
}
