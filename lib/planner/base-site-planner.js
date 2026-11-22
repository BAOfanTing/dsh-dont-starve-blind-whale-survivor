// 家园选址（Base Site Planner）：从**已观察到的**数据给候选营地点打分。
//
// 关键约束（任务书 §四）：
//   · 只用真实观察到的地图数据（本项目 = nearby 16 格 + danger_zones + 角色位置）。
//   · **不把未探索区域当安全区**，**不按直线距离瞎选**，**不选危险区**。
//   · 信息不足 → 明确返回 sufficient_info=false 并要求先探索（有目的、有预算）。
//   · camp_site 只是选址坐标，不等于 home（home 必须在建造后用真实建筑锚点设定，见 planner-core）。
//
// 局限（诚实标注）：本项目 Lua 不导出地图栅格，因此"跨水连通性"只能用"是否在已观察范围内"近似；
// 返回里会带 connectivity_mode='observed_nearby_only'，绝不假装做了全局路径规划。

const TILE = 1 // nearby 的 position/distance 都以"格子"为单位，与 actor.tileX/tileZ 一致

export function isTree(item) {
  return item?.work_action === 'CHOP' || /tree|evergreen|deciduous|birch/i.test(String(item?.prefab ?? ''))
}
export function isRock(item) {
  return item?.work_action === 'MINE' || /^rock|boulder/i.test(String(item?.prefab ?? ''))
}
export function isGoldVein(item) {
  return item?.prefab === 'rock2' || /gold/i.test(String(item?.prefab ?? ''))
}
export function isBerryBush(item) {
  return /berrybush/i.test(String(item?.prefab ?? ''))
}
export function isCarrotPlant(item) {
  return item?.prefab === 'carrot_planted'
}

function bucket(snapshot, key) {
  const buckets = snapshot?.nearby?.buckets
  if (!buckets) return []
  if (Array.isArray(buckets)) return buckets.find((g) => g?.kind === key)?.items ?? []
  const list = buckets[key]
  return Array.isArray(list) ? list : Object.values(list ?? {})
}

function posOf(item) {
  const p = item?.position ?? (item?.x !== undefined ? { x: item.x, z: item.z } : null)
  if (p && typeof p.x === 'number' && typeof p.z === 'number') return { x: p.x, z: p.z }
  return null
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

const clamp01 = (v) => Math.max(0, Math.min(1, v))

/** 收集所有带坐标的观察实体，按桶归好 */
function observed(snapshot) {
  const out = { resources: [], food: [], threats: [], structures: [], all: [] }
  for (const key of ['resources', 'food', 'pickupables', 'harvestables', 'structures', 'threats', 'creatures']) {
    for (const it of bucket(snapshot, key)) {
      const p = posOf(it)
      if (!p) continue
      const entry = { item: it, pos: p }
      out.all.push(entry)
      if (key === 'resources') out.resources.push(entry)
      else if (key === 'food') out.food.push(entry)
      else if (key === 'structures') out.structures.push(entry)
      if (key === 'threats') out.threats.push(entry)
      // harvestables/pickupables 里也可能是食物来源
      if ((key === 'harvestables' || key === 'pickupables') && (isBerryBush(it) || isCarrotPlant(it))) out.food.push(entry)
    }
  }
  return out
}

/** 候选点是否落在任何危险区（快照近期 + 记忆历史） */
export function isInDangerZone(point, snapshot, memory = {}) {
  const zones = [...(snapshot?.dangerZones ?? []), ...(memory?.danger_zones ?? [])]
  for (const z of zones) {
    if (typeof z?.x !== 'number' || typeof z?.z !== 'number') continue
    if (dist(point, z) <= Number(z.radius ?? 10)) return true
  }
  return false
}

function nearestThreatDist(point, threats) {
  let best = Infinity
  for (const t of threats) {
    const d = dist(point, t.pos)
    if (d < best) best = d
  }
  return best
}

function countNear(point, entries, radius) {
  let n = 0
  for (const e of entries) if (dist(point, e.pos) <= radius) n += 1
  return n
}

/** 单一候选点打分。返回 { score, scores, rejected, reason } */
export function scoreCandidate(point, obs, snapshot, memory = {}) {
  if (!point || typeof point.x !== 'number' || typeof point.z !== 'number') {
    return { score: 0, rejected: true, reason: 'no_position', scores: {} }
  }
  if (isInDangerZone(point, snapshot, memory)) {
    return { score: 0, rejected: true, reason: 'in_danger_zone', scores: {} }
  }
  const threatDist = nearestThreatDist(point, obs.threats)
  if (threatDist <= 4 * TILE) {
    return { score: 0, rejected: true, reason: 'threat_too_close', scores: { threatDist } }
  }

  const trees = obs.resources.filter((e) => isTree(e.item)).length
  const rocks = obs.resources.filter((e) => isRock(e.item)).length
  const gold = obs.resources.filter((e) => isGoldVein(e.item)).length
  const foods = obs.food.length

  // 各指标都在 0..1
  const terrainSafety = Number.isFinite(threatDist) ? clamp01(threatDist / (12 * TILE)) : 1
  const resourceScore = clamp01((countNear(point, obs.resources.filter((e) => isTree(e.item) || isRock(e.item)), 12 * TILE) + gold * 2) / 10)
  const foodScore = clamp01(countNear(point, obs.food, 12 * TILE) / 5)
  // 建筑空间：周围 3 格内不过度拥挤（越开阔越好）。
  const density = countNear(point, obs.all, 3 * TILE)
  const spaceScore = clamp01(1 - (density - 3) / 10)
  // 连通性：只确认"在已观察范围内"≈附近可达。
  const actor = snapshot?.actor
  const actorPos = (actor && typeof actor.tileX === 'number') ? { x: actor.tileX, z: actor.tileZ } : point
  const actorDist = dist(point, actorPos)
  const connectivityScore = actorDist <= 16 * TILE ? 1 : 0.5
  // 资源多样性（树/石/金 种类越多越适合长期营建）。
  const kindsNear = new Set()
  for (const e of obs.resources) if (dist(e.pos, point) <= 12 * TILE) kindsNear.add(isTree(e.item) ? 'tree' : isRock(e.item) ? 'rock' : 'other')
  const diversityScore = clamp01(kindsNear.size / 2)
  // 海岸/水域惩罚：观测里有水点就计算；没有则 0（数据缺失不臆测）。
  const nearWater = Array.isArray(obs.water) ? countNear(point, obs.water, 6 * TILE) : Number(obs.waterNearCount ?? 0)
  const coastPenalty = clamp01(nearWater / 3)
  // 交通：可达但**不要贴着脚下**——营地要专门过去建，不是站哪建哪。
  const tooClosePenalty = actorDist < 6 * TILE ? clamp01((6 * TILE - actorDist) / (6 * TILE)) * 0.20 : 0
  const footPenalty = actorDist < 1.5 * TILE ? 0.15 : 0
  const dangerPenalty = clamp01((countNear(point, obs.threats, 8 * TILE)) / 2)
  const transportScore = clamp01(1 - actorDist / (20 * TILE))

  const scores = { terrainSafety, resourceScore, foodScore, spaceScore, connectivityScore, diversityScore, coastPenalty, transportScore, dangerPenalty }
  // 重新加权：资源/开阔/多样性更重；"就近"权重降低；靠海重罚。
  const score = clamp01(
    terrainSafety * 0.22
    + resourceScore * 0.30
    + foodScore * 0.15
    + spaceScore * 0.18
    + connectivityScore * 0.08
    + diversityScore * 0.07
    + transportScore * 0.05
    - dangerPenalty * 0.40
    - coastPenalty * 0.30
    - tooClosePenalty
    - footPenalty,
  )

  const reasonBits = []
  reasonBits.push(`安全${Math.round(terrainSafety * 100)}%`)
  if (trees || rocks) reasonBits.push(`树${trees}/石${rocks}${gold ? `/金${gold}` : ''}`)
  if (foods) reasonBits.push(`食物源${foods}`)
  if (nearWater) reasonBits.push(`近水${Math.round(coastPenalty * 100)}%（减分）`)
  reasonBits.push(`距角色${actorDist.toFixed(0)}格`)
  return { score, rejected: false, reason: reasonBits.join('，'), scores }
}

/** 生成候选点：角色位置 + 资源/食物聚类中心 + 角色到资源的中点。全部来自观察。 */
function candidatePoints(snapshot, obs) {
  const pts = []
  const push = (p) => {
    if (!p) return
    const x = Math.round(p.x * 10) / 10
    const z = Math.round(p.z * 10) / 10
    if (!pts.some((q) => Math.abs(q.x - x) < 1.5 && Math.abs(q.z - z) < 1.5)) pts.push({ x, z })
  }
  const actor = snapshot?.actor
  if (actor && typeof actor.tileX === 'number') push({ x: actor.tileX, z: actor.tileZ })

  // 资源/食物聚类：以每个实体为种子，取其周围同类质心（粗聚类，够选点用）
  const seeds = [...obs.resources, ...obs.food]
  for (const seed of seeds) {
    const sameKind = [...obs.resources, ...obs.food].filter((e) => dist(e.pos, seed.pos) <= 6 * TILE)
    if (sameKind.length === 0) continue
    const cx = sameKind.reduce((s, e) => s + e.pos.x, 0) / sameKind.length
    const cz = sameKind.reduce((s, e) => s + e.pos.z, 0) / sameKind.length
    push({ x: cx, z: cz })
  }
  return pts.slice(0, 8)
}

/**
 * 主入口：给当前快照算候选营地。
 * @returns {{
 *   sufficient_info:boolean, need_explore:boolean, explore_reason:string|null,
 *   primary:object|null, backup:object|null, candidates:object[],
 *   connectivity_mode:string, reasons:string[]
 * }}
 */
export function planBaseSite(snapshot, memory = {}, opts = {}) {
  const minScore = Number(opts.minScore ?? 0.35)
  if (!snapshot?.actor || typeof snapshot.actor.tileX !== 'number') {
    return {
      sufficient_info: false, need_explore: true, explore_reason: '角色位置读不到',
      primary: null, backup: null, candidates: [], connectivity_mode: 'observed_nearby_only',
      reasons: ['无法读取角色位置，不能选址'],
    }
  }

  const obs = observed(snapshot)
  const resourceKinds = new Set(obs.resources.map((e) => (isTree(e.item) ? 'tree' : isRock(e.item) ? 'rock' : 'other')))
  const hasBuildResource = obs.resources.some((e) => isTree(e.item) || isRock(e.item))
  const hasFood = obs.food.length > 0

  // 信息是否足够：附近得看到建造资源 + 食物，才可能"选个能长期发展的地方"
  const reasons = []
  const sufficient = hasBuildResource && (hasFood || obs.food.length === 0 && resourceKinds.size >= 1 && opts.allowNoFood === true)
  if (!hasBuildResource) reasons.push('附近没观察到树/石头（无法判断建造空间与资源）')
  if (!hasFood) reasons.push('附近没观察到食物来源')

  const candidates = []
  for (const p of candidatePoints(snapshot, obs)) {
    const scored = scoreCandidate(p, obs, snapshot, memory)
    candidates.push({ x: p.x, z: p.z, ...scored })
  }
  const viable = candidates.filter((c) => !c.rejected && c.score >= minScore)
    .sort((a, b) => b.score - a.score)

  if (!sufficient) {
    return {
      sufficient_info: false,
      need_explore: true,
      explore_reason: reasons.join('；') || '观察信息不足，先探索附近',
      primary: null,
      backup: null,
      candidates,
      connectivity_mode: 'observed_nearby_only',
      reasons,
    }
  }
  if (viable.length === 0) {
    const rejects = candidates.filter((c) => c.rejected)
    return {
      sufficient_info: false,
      need_explore: true,
      explore_reason: rejects.length > 0
        ? `候选点都不安全或不达标（${[...new Set(rejects.map((c) => c.reason))].join('、')}），需要换个方向探索`
        : '没有达到最低分的安全候选点，需要继续探索',
      primary: null,
      backup: null,
      candidates,
      connectivity_mode: 'observed_nearby_only',
      reasons,
    }
  }

  const primary = { x: viable[0].x, z: viable[0].z, score: round2(viable[0].score), reason: viable[0].reason }
  const backup = viable[1]
    ? { x: viable[1].x, z: viable[1].z, score: round2(viable[1].score), reason: viable[1].reason }
    : null
  return {
    sufficient_info: true,
    need_explore: false,
    explore_reason: null,
    primary,
    backup,
    candidates,
    connectivity_mode: 'observed_nearby_only',
    reasons: [`主选 (${primary.x},${primary.z})：${primary.reason}`],
  }
}

const round2 = (v) => Math.round(v * 100) / 100
