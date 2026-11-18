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

/**
 * TARGET-REFRESH：按**稳定句柄**（h…）取快照里的条目。
 *
 * 为什么需要它：模型可以只给 target_handle（不带 target_ref/snapshot_id），
 * 这时 args.target_ref 是 undefined —— 如果 verify 仍然只认 itemOfRef(args.target_ref)，
 * 就会永远返回 unknown_ref，把一次真实的成功动作判成"没核对上"
 * （真机 session 8fab0944：`attack {target_handle:"hi0"}` 打了蜘蛛巢 5 下，回执却是 unknown_ref）。
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
 * TARGET-REFRESH：当前快照里"某一类目标"中最近的一个。
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
 *   ① handle 相同 —— TARGET-REFRESH 的稳定句柄，**对会移动的生物也成立**
 *   ② prefab + 格子坐标一致 —— 不可移动对象（浆果丛/树/建筑）的可靠判据
 *   ③ prefab 相同且位置差 < 1 格 —— 生物小幅移动后的兜底
 *
 * ★ 为什么需要 ①③：原来只有 ②。蜘蛛被打了会跑，坐标一变就被当成"目标不见了"，
 *   于是 verify 走 target_gone 分支 —— 攻击还没打死也被判成"打倒了"，
 *   或者明明血在掉却报 work_state_unchanged。
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
