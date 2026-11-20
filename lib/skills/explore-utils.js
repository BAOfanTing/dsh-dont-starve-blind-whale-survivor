// 定向开图与世界资源记忆导航 (Explore & Resource Navigation)
//
// 核心思想：
// 1. 彻底解决旧版 seek 原地画圈、盲目耗费轮次的问题。
// 2. 结合 32 格远景雷达，沿途看到的关键资源（矿石、成熟浆果丛、胡萝卜、蜂巢、发条怪、猪人房等）
//    实时登记到 WorldMemory (known_resources)，走过的区域记入 (explored_regions)。
// 3. 当附近 32 格内没有所需资源时，优先从 WorldMemory 的 known_resources 中导航过去。
// 4. 当 WorldMemory 也没有该资源时，采用玩家视角的真实探索逻辑：
//    避开已知危险区，朝未探索黑色迷雾方向直线前压 20 格探路 (exploreFrontier)。

const round1 = (v) => Math.round(v * 10) / 10

function itemPos(item) {
  const p = item?.position
  if (p && typeof p.x === 'number' && typeof p.z === 'number') return { x: p.x, z: p.z }
  if (typeof item?.x === 'number' && typeof item?.z === 'number') return { x: item.x, z: item.z }
  return null
}

function actorPosOf(snapshot) {
  const a = snapshot?.actor
  if (!a) return null
  const x = typeof a.tileX === 'number' ? a.tileX : (typeof a.x === 'number' ? a.x : null)
  const z = typeof a.tileZ === 'number' ? a.tileZ : (typeof a.z === 'number' ? a.z : null)
  return (typeof x === 'number' && typeof z === 'number') ? { x, z } : null
}

function bucketItems(snapshot, key) {
  const buckets = snapshot?.nearby?.buckets
  if (!buckets) return []
  if (Array.isArray(buckets)) return buckets.find((g) => g?.kind === key)?.items ?? []
  const list = buckets[key]
  return Array.isArray(list) ? list : Object.values(list ?? {})
}

export const RADAR_RESOURCES = {
  // 矿石
  rock1: 'mineral',
  rock2: 'mineral',
  rocks: 'mineral',
  boulders: 'mineral',
  goldnugget: 'mineral',
  nitre: 'mineral',
  flint: 'mineral',
  // 成熟食物
  berrybush: 'food',
  berrybush_juicy: 'food',
  berrybush2: 'food',
  carrot_planted: 'food',
  carrot: 'food',
  // 核心采集植物
  sapling: 'plant',
  grass: 'plant',
  reeds: 'plant',
  // 地标与关键生态
  pighouse: 'landmark',
  mermhouse: 'landmark',
  beebox: 'landmark',
  beehive: 'landmark',
  chess: 'landmark',
}

/**
 * 沿途更新开图区域与关键资源到 WorldMemory
 * @param {object} memory
 * @param {object} snapshot
 */
export function recordExploration(memory, snapshot) {
  if (!memory || typeof memory !== 'object') return
  const actorPos = actorPosOf(snapshot)

  // 1. 记录走过的区域 (explored_regions)
  if (actorPos) {
    if (!Array.isArray(memory.explored_regions)) memory.explored_regions = []
    const cx = Math.floor(actorPos.x / 16)
    const cz = Math.floor(actorPos.z / 16)
    const regId = `chunk_${cx}_${cz}`
    const existing = memory.explored_regions.find((r) => r && r.id === regId)
    if (existing) {
      existing.visited_at = Date.now()
    } else {
      memory.explored_regions.push({
        id: regId,
        cx,
        cz,
        x: cx * 16 + 8,
        z: cz * 16 + 8,
        radius: 16,
        visited_at: Date.now(),
      })
      if (memory.explored_regions.length > 120) {
        memory.explored_regions.sort((a, b) => (b.visited_at || 0) - (a.visited_at || 0))
        memory.explored_regions = memory.explored_regions.slice(0, 120)
      }
    }
    try {
      memory.explored_regions[regId] = true
    } catch {}
    memory.explored_region_count = memory.explored_regions.length
  }

  // 2. 记录沿途发现的关键资源 (known_resources)
  if (!Array.isArray(memory.known_resources)) memory.known_resources = []
  const resourcesMap = new Map((memory.known_resources ?? []).map((r) => [r.id, r]))

  for (const bucketKey of ['resources', 'harvestables', 'pickupables', 'structures']) {
    for (const it of bucketItems(snapshot, bucketKey)) {
      const prefab = String(it?.prefab ?? '').toLowerCase()
      const category = RADAR_RESOURCES[prefab]
      if (!category) continue
      const pos = itemPos(it)
      if (!pos) continue
      const id = `${prefab}@${round1(pos.x)},${round1(pos.z)}`
      resourcesMap.set(id, {
        id,
        prefab,
        category,
        x: round1(pos.x),
        z: round1(pos.z),
        updated_at: Date.now(),
      })
    }
  }

  // 贴身距离复核：若角色已走到某已知资源旁（< 2.5格），且当前快照中已无该物品，说明已被采走或消耗，及时清理
  if (actorPos) {
    for (const [id, res] of resourcesMap.entries()) {
      const d = Math.hypot(res.x - actorPos.x, res.z - actorPos.z)
      if (d < 2.5) {
        let stillThere = false
        for (const bucketKey of ['resources', 'harvestables', 'pickupables', 'structures']) {
          for (const it of bucketItems(snapshot, bucketKey)) {
            if (String(it?.prefab ?? '').toLowerCase() === res.prefab) {
              const p = itemPos(it)
              if (p && Math.hypot(p.x - res.x, p.z - res.z) < 1.5) {
                stillThere = true
                break
              }
            }
          }
          if (stillThere) break
        }
        if (!stillThere) {
          resourcesMap.delete(id)
        }
      }
    }
  }

  memory.known_resources = [...resourcesMap.values()].slice(-150)
}

/**
 * 从 WorldMemory 中查找最符合条件的已知资源
 * @param {object} memory
 * @param {(res: object) => boolean} predicate
 * @param {{ x: number, z: number }} [actorPos]
 * @returns {object|null}
 */
export function findKnownResource(memory, predicate, actorPos = null) {
  if (!memory || !Array.isArray(memory.known_resources)) return null
  const candidates = memory.known_resources.filter(predicate)
  if (candidates.length === 0) return null

  if (!actorPos) return candidates[0]
  return candidates.slice().sort((a, b) => {
    const da = Math.hypot(a.x - actorPos.x, a.z - actorPos.z)
    const db = Math.hypot(b.x - actorPos.x, b.z - actorPos.z)
    return da - db
  })[0]
}

/**
 * 朝未知黑色迷雾方向直线探路（直接下发 move_to 前压 20 格）
 * 避开已知的 danger_zones，挑选最少探索过的扇面方向。
 * @param {object} snapshot
 * @param {object} memory
 * @param {{ distance?: number }} [opts]
 * @returns {{ tool: string, args: object }}
 */
export function exploreFrontier(snapshot, memory, { distance = 20 } = {}) {
  const actorPos = actorPosOf(snapshot)
  if (!actorPos) {
    return { tool: 'seek', args: { prefab: 'tree', max_tiles: distance, step: 6 } }
  }

  // 8 个候选方向角（0, 45, 90, 135, 180, 225, 270, 315 度）
  const angles = [
    0,
    Math.PI / 4,
    Math.PI / 2,
    (3 * Math.PI) / 4,
    Math.PI,
    (-3 * Math.PI) / 4,
    -Math.PI / 2,
    -Math.PI / 4,
  ]

  const dangerZones = memory?.danger_zones ?? []
  const explored = memory?.explored_regions ?? []

  let bestScore = -Infinity
  let bestTarget = { x: actorPos.x + distance, z: actorPos.z }
  let bestAngle = 0

  for (const angle of angles) {
    const candX = actorPos.x + distance * Math.cos(angle)
    const candZ = actorPos.z + distance * Math.sin(angle)

    let score = 100

    // 1. 危险区惩罚
    for (const dz of dangerZones) {
      if (typeof dz?.x === 'number' && typeof dz?.z === 'number') {
        const d = Math.hypot(candX - dz.x, candZ - dz.z)
        const safeRadius = (dz.radius ?? 10) + 4
        if (d < safeRadius) {
          score -= 100000 // 绝对避开危险区
        }
      }
    }

    // 2. 离已探索区域越远，得分越高（代表黑色迷雾）
    if (explored.length > 0) {
      let minExploredDist = Infinity
      for (const reg of explored) {
        if (typeof reg?.x === 'number' && typeof reg?.z === 'number') {
          const d = Math.hypot(candX - reg.x, candZ - reg.z)
          if (d < minExploredDist) minExploredDist = d
        }
      }
      score += minExploredDist * 5
    }

    // 3. 探路方向连续性（避免原地 180 度来回折返）
    if (typeof memory?._last_explore_angle === 'number') {
      const diff = Math.abs(angle - memory._last_explore_angle)
      const normDiff = Math.min(diff, 2 * Math.PI - diff)
      score -= normDiff * 8
    }

    if (score > bestScore) {
      bestScore = score
      bestTarget = { x: candX, z: candZ }
      bestAngle = angle
    }
  }

  if (memory) {
    memory._last_explore_angle = bestAngle
  }

  return {
    tool: 'move_to',
    args: {
      x: Math.round(bestTarget.x),
      z: Math.round(bestTarget.z),
    },
  }
}
