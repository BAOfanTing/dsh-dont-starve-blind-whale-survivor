// 工具层公共件：从 Bridge 快照里安全取数 + 统一的新鲜度信封
//
// 为什么单独一层：
//   1. 快照是 Lua 编码过来的松散 JSON（字段可能缺、空表可能是 {}），工具层不能到处写类型断言；
//   2. 「数据有多新」必须在每个工具里一致地表达，否则 AI 会把旧数据当当前状态；
//   3. 文本输出（给 AI 看）和结构化输出（给程序看）要保持一致。

import type { SnapshotRead } from '../bridge/client.js'

export type Dict = Record<string, unknown>

export function asDict(value: unknown): Dict | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : null
}

export function asNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function asStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/**
 * Lua 的空表既可能是数组也可能是对象，编码出来都是 {}。
 * 这里把"应该的数组"归一化成 []（telemetry 通道在 Bridge 侧做过，命令/快照通道要在这里兜）。
 */
export function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const dict = asDict(value)
  if (dict !== null && Object.keys(dict).length === 0) return []
  return []
}

/** 统一的"数据新鲜度"块：每个工具都带，绝不让调用方误以为这是当前状态 */
export interface Freshness {
  stale: boolean
  stale_reason: string | null
  age_ms: number
  snapshot_at: number | null
  stale_after_ms: number
  from_cache: boolean
  session_alive: boolean
  session_id: string
  shard: string | null
}

export function freshnessOf(read: SnapshotRead): Freshness {
  return {
    stale: read.stale,
    stale_reason: read.staleReason,
    age_ms: read.ageMs,
    snapshot_at: read.game.snapshot_at,
    stale_after_ms: read.game.stale_after_ms,
    from_cache: read.fromCache,
    session_alive: read.game.session.alive,
    session_id: read.game.session.session_id,
    shard: read.game.session.shard,
  }
}

/** 给 AI 看的第一行：新鲜度提示 */
export function freshnessLine(freshness: Freshness): string {
  if (freshness.stale) {
    const age = Math.max(0, Math.round(freshness.age_ms / 1000))
    return `⚠️ 数据已过期（${freshness.stale_reason ?? 'unknown'}，约 ${age} 秒前）—— 以下是最后一次已知状态，不代表当前`
  }
  const age = Math.max(0, Math.round(freshness.age_ms / 1000))
  return `数据新鲜（约 ${age} 秒前采集${freshness.from_cache ? '，来自缓存' : ''}）`
}

export interface NearbyEntity {
  prefab: string
  name: string | null
  category: string
  tile_x: number | null
  tile_z: number | null
  distance: number | null
  hp: number | null
  work_left: number | null
}

/** 把快照里的 nearby.entities 归一化成结构化列表（按距离升序） */
export function parseNearbyEntities(snapshot: Dict | null): NearbyEntity[] {
  const nearby = asDict(snapshot?.nearby)
  const raw = asList(nearby?.entities)
  const entities: NearbyEntity[] = []
  for (const item of raw) {
    const dict = asDict(item)
    if (dict === null) continue
    const prefab = asStr(dict.prefab)
    if (prefab === null) continue
    entities.push({
      prefab,
      name: asStr(dict.name),
      category: asStr(dict.category) ?? 'unknown',
      tile_x: asNum(dict.tile_x),
      tile_z: asNum(dict.tile_z),
      distance: asNum(dict.distance),
      hp: asNum(dict.hp),
      work_left: asNum(dict.work_left),
    })
  }
  entities.sort((a, b) => (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY))
  return entities
}

/** nearby 的元信息（扫了多少、返回多少、是否被裁剪） */
export function nearbyMeta(snapshot: Dict | null) {
  const nearby = asDict(snapshot?.nearby)
  if (nearby === null) {
    return { available: false as const, scanned: null, returned: null, truncated: null, radius_tiles: null, scanned_at_tick: null }
  }
  return {
    available: true as const,
    scanned: asNum(nearby.scanned),
    returned: asNum(nearby.returned),
    truncated: asBool(nearby.truncated),
    radius_tiles: asNum(nearby.radius_tiles),
    scanned_at_tick: asNum(nearby.scanned_at_tick),
  }
}

/** 物品：把 items 里的每个条目规范化（数量/耐久/新鲜度/燃料/护甲） */
export interface ItemView {
  prefab: string
  name: string | null
  count: number
  slot: number | null
  uses_left: number | null
  uses_max: number | null
  freshness: number | null
  fuel: number | null
  armor: number | null
}

export function parseItems(inventory: Dict | null): ItemView[] {
  const items = asList(inventory?.items)
  const out: ItemView[] = []
  for (const item of items) {
    const dict = asDict(item)
    if (dict === null) continue
    const prefab = asStr(dict.prefab)
    if (prefab === null) continue
    out.push({
      prefab,
      name: asStr(dict.name),
      count: asNum(dict.count) ?? 1,
      slot: asNum(dict.slot),
      uses_left: asNum(dict.uses_left),
      uses_max: asNum(dict.uses_max),
      freshness: asNum(dict.freshness),
      fuel: asNum(dict.fuel),
      armor: asNum(dict.armor),
    })
  }
  return out
}

export function itemLabel(item: ItemView): string {
  const name = item.name ?? item.prefab
  const parts = [item.count > 1 ? `${name} ×${item.count}` : name]
  if (item.uses_left !== null && item.uses_max !== null) parts.push(`耐久 ${item.uses_left}/${item.uses_max}`)
  if (item.freshness !== null) parts.push(`新鲜度 ${item.freshness}%`)
  if (item.fuel !== null) parts.push(`燃料 ${item.fuel}%`)
  if (item.armor !== null) parts.push(`护甲 ${item.armor}%`)
  return parts.join('，')
}
