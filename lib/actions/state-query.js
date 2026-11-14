// 快照查询：只读当前状态快照，不碰游戏。
//
// 动作的 verify() 全部基于这里的函数做前后比对 —— 它们必须同时吃 Lua 的两种 JSON 形状：
//   · 背包 items 可能是数组，也可能是对象（空表 / 非连续表会被序列化成 {}）
//   · 装备栏可能是 slots 对象，也可能是 worn 数组
// 数漏形状会被误判成"动作失败"，真机已经踩过两次（SURVIVAL-09 / SURVIVAL-10）。
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

/** 所有桶的条目（顺序无关） */
export function allBucketItems(snapshot) {
  const buckets = snapshot?.nearby?.buckets
  if (!buckets) return []
  return Array.isArray(buckets) ? buckets.map((g) => g?.items ?? []) : Object.values(buckets)
}

/**
 * 在 after 快照里找"同一个实体"：prefab + 格子坐标一致。
 * 可收获对象（浆果丛）不会移动，所以这个匹配是可靠的；ref 会随排序变化，不能用来认实体。
 */
export function findSameEntity(snapshot, target) {
  const pos = target?.position ?? null
  if (!pos) return null
  for (const items of allBucketItems(snapshot)) {
    for (const item of items) {
      const p = item?.position
      if (item?.prefab === target.prefab && p && p.x === pos.x && p.z === pos.z) return item
    }
  }
  return null
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
 *
 * ★ 真机踩到的坑（Cluster_1 #26 craft torch）：
 *   Lua 序列化时**空表 / 非连续表会输出成 `{}`（对象）而不是 `[]`**。
 *   原来 countInInventory 里写的是 `if (!Array.isArray(items)) return 0` ——
 *   一旦 items 是 {}，背包就被当成"什么都没有"。
 *   于是：Lua 侧自己的 count_diff 明明算出了 `torch+1`（回执里就写着），
 *   Node 侧却判 craft_not_in_inventory —— 材料扣了、成品也进了包，却被报成失败。
 *
 * 数组和对象都要能吃。这不是放宽核对：该数出来的照样数，只是不因 JSON 形状数漏。
 */
export function inventoryItems(snapshot) {
  const items = snapshot?.player?.inventory?.items
  if (Array.isArray(items)) return items
  if (items && typeof items === 'object') return Object.values(items)
  return []
}

/**
 * 读"手上拿着什么"（prefab 名，没有就 null）。
 *
 * ★ 真机踩到的坑（Cluster_1 craft torch）：状态文件里装备栏**同时有两种形状**：
 *   `slots` 是按 key 的对象： `{ hands: { prefab: "torch", ... } }`
 *   `worn`  是按顺序的数组： `[ { key: "hands", label: "手持", item: { prefab: "torch" } } ]`
 *   原来只读 `worn.hands`（数组上取 key）→ 永远 null →
 *   空手做火把时 DoBuild 会自动装备到手上，却被判成"没做出来"。
 *
 * 两种形状都要认；都读不到就返回 null（不猜）。
 */
export function handItem(snapshot) {
  const eq = snapshot?.player?.equipment
  if (!eq || typeof eq !== 'object') return null

  // ① slots：对象，按 key 取（hands / HANDS）
  const slots = eq.slots
  if (slots && typeof slots === 'object' && !Array.isArray(slots)) {
    const h = slots.hands ?? slots.HANDS
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
      if (key !== 'hands') continue
      const it = entry?.item ?? entry
      if (typeof it === 'string' && it !== '') return it
      const prefab = it?.prefab ?? null
      if (typeof prefab === 'string') return prefab
    }
  }
  // ③ worn 也可能是对象（老格式）
  if (worn && typeof worn === 'object' && !Array.isArray(worn)) {
    const h = worn.hands ?? worn.HANDS
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
