// 快照查询：只读当前状态快照，不碰游戏。
//
// 动作的 verify() 全部基于这里的函数做前后比对 —— 它们必须同时兼容 Lua 的两种 JSON 形状：
//   · 背包 items 可能是数组，也可能是对象（空表 / 非连续表会被序列化成 {}）
//   · 装备栏可能是 slots 对象，也可能是 worn 数组
/** 从快照的 nearby 桶里按 #N 取条目本身（只读快照，不碰游戏） */
export function itemOfRef(snapshot, ref) {
  if (!snapshot || typeof ref !== "string") return null
  for (const items of allBucketItems(snapshot)) {
    for (const item of items) {
      if (item?.ref === ref) return item
    }
  }
  return null
}

/**
 * 按**稳定句柄**（h…）取快照里的条目。
 * 当模型只给 target_handle（不带 target_ref/snapshot_id）时，verify 靠它定位目标。
 */
export function itemOfHandle(snapshot, handle) {
  if (!snapshot || typeof handle !== "string" || handle === "") return null
  for (const items of allBucketItems(snapshot)) {
    for (const item of items) {
      if (item?.handle === handle) return item
    }
  }
  return null
}

/**
 * 取"这次动作操作的那个目标条目"：优先 target_ref（当前帧 #N），否则退回 target_handle。
 * 两者都没有 → null（调用方按 unknown_ref 处理，语义不变）。
 */
export function targetItem(snapshot, args) {
  const byRef = itemOfRef(snapshot, args?.target_ref)
  if (byRef) return byRef
  return itemOfHandle(snapshot, args?.target_handle)
}

/**
 * 当前快照里"某一类目标"中最近的一个。
 * 只用于核对（before/after 比对），不用于发指令 —— 真正选目标的是 Lua。
 * 返回 { item, distance } 或 null。
 */
export function nearestByPrefabs(snapshot, prefabs) {
  const want = new Set(Array.isArray(prefabs) ? prefabs : [])
  let best = null
  for (const items of allBucketItems(snapshot)) {
    for (const item of items ?? []) {
      if (!item?.prefab || !want.has(item.prefab)) continue
      const d = typeof item.distance === 'number' ? item.distance : Infinity
      if (!best || d < best.distance) best = { item, distance: d }
    }
  }
  return best
}

/** 所有桶的条目（顺序无关） */
export function allBucketItems(snapshot) {
  const buckets = snapshot?.nearby?.buckets
  if (!buckets) return []
  return Array.isArray(buckets) ? buckets.map((g) => g?.items ?? []) : Object.values(buckets)
}

/**
 * 在 after 快照里找"同一个实体"。
 *
 * 匹配优先级（从强到弱）：
 *   ① handle 相同 —— 稳定句柄跨扫描不变，**对会移动的生物也成立**
 *   ② prefab + 格子坐标一致 —— 不可移动对象（浆果丛/树/建筑）的可靠判据
 *   ③ prefab 相同且位置差 < 1 格 —— 生物小幅移动后的兜底
 *
 * ①③ 避免移动中的生物仅因坐标变化就被误判为 target_gone。
 */
export function findSameEntity(snapshot, target) {
  if (!target) return null
  const handle = target.handle
  if (typeof handle === 'string' && handle !== '') {
    const byHandle = itemOfHandle(snapshot, handle)
    if (byHandle) return byHandle
  }
  const pos = target?.position ?? null
  if (!pos) return null
  let loose = null
  for (const items of allBucketItems(snapshot)) {
    for (const item of items) {
      if (item?.prefab !== target.prefab) continue
      const p = item?.position
      if (!p) continue
      if (p.x === pos.x && p.z === pos.z) return item
      if (loose === null) {
        const dx = Number(p.x) - Number(pos.x)
        const dz = Number(p.z) - Number(pos.z)
        if (Number.isFinite(dx) && Number.isFinite(dz) && Math.abs(dx) <= 1 && Math.abs(dz) <= 1) {
          loose = item
        }
      }
    }
  }
  return loose
}
/** 从快照的 nearby 桶里按 #N 找 prefab（只读快照，不碰游戏） */
export function prefabOfRef(snapshot, ref) {
  const buckets = snapshot?.nearby?.buckets
  if (!buckets || typeof ref !== 'string') return null
  const groups = Array.isArray(buckets) ? buckets.map((g) => g?.items ?? []) : Object.values(buckets)
  for (const items of groups) {
    for (const item of items ?? []) {
      if (item?.ref === ref) return item.prefab ?? null
    }
  }
  return null
}

/** 背包里某个 prefab 的总数（含堆叠数量） */
/**
 * 把背包物品统一成数组。
 * Lua 序列化时**空表 / 非连续表会输出成 `{}` 而不是 `[]`**，因此数组和对象两种形态均须支持。
 */
export function inventoryItems(snapshot) {
  const items = snapshot?.player?.inventory?.items
  if (Array.isArray(items)) return items
  if (items && typeof items === 'object') return Object.values(items)
  return []
}

/**
 * 读指定槽位（如 "hands"）上的物品 prefab 名，没有就 null。
 * 装备栏同时兼容 slots 对象与 worn 数组两种序列化形状。
 */
export function handItem(snapshot) {
  return equipmentItem(snapshot, 'hands')
}

export function equipmentItem(snapshot, slot) {
  const eq = snapshot?.player?.equipment
  if (!eq || typeof eq !== 'object') return null

  // ① slots：对象，按 key 取（hands / HANDS）
  const slots = eq.slots
  if (slots && typeof slots === 'object' && !Array.isArray(slots)) {
    const h = slots[slot] ?? slots[slot.toUpperCase()]
    if (typeof h === 'string' && h !== '') return h
    if (h && typeof h === 'object') {
      const prefab = h.prefab ?? h.item ?? null
      if (typeof prefab === 'string') return prefab
    }
  }

  // ② worn：数组，按 key 找
  const worn = eq.worn
  if (Array.isArray(worn)) {
    for (const entry of worn) {
      const key = String(entry?.key ?? entry?.slot_key ?? entry?.slot ?? '').toLowerCase()
      if (key !== slot) continue
      const it = entry?.item ?? entry
      if (typeof it === 'string' && it !== '') return it
      const prefab = it?.prefab ?? null
      if (typeof prefab === 'string') return prefab
    }
  }
  // ③ worn 也可能是对象（老格式）
  if (worn && typeof worn === 'object' && !Array.isArray(worn)) {
    const h = worn[slot] ?? worn[slot.toUpperCase()]
    if (typeof h === 'string' && h !== '') return h
    if (h && typeof h === 'object' && typeof h.prefab === 'string') return h.prefab
  }
  return null
}

export function countInInventory(snapshot, prefab) {
  let total = 0
  for (const item of inventoryItems(snapshot)) {
    if (item?.prefab === prefab) total += Number(item.count ?? 1)
  }
  return total
}
