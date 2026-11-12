// 状态仓库：把 state / nearby 记录合并成对外的一份快照
//
// 规则（来自里程碑 6 的契约，见 docs/phase1/05-state-schema.md）：
//   · 只采信 side === "server" 的记录（客户端 components 是 replica，不权威）；
//   · tick 可能不在顶层（老版本在 observer.tick）→ 统一归一化；
//   · nearby 与 state 用 tick 配对，允许差 maxTickGap 个周期，差得多就不给；
//   · Lua 空表会被编码成 {} → items / entities 归一化成数组；
//   · 同一个 session+tick+type 只算一次（日志被重读时去重）；
//   · 收到新的 boot 记录 = 重进世界 → 清掉该分片的快照并记 restart；
//   · **Master 和 Caves 是两个进程、两个 session**，各自都在发状态：
//     所以按 session 分别存，对外优先给「有玩家」的那个（不然 caves 空着时会顶掉主世界）。

import type { WireRecord } from './record.js'

export type RecordKind = 'boot' | 'state' | 'nearby' | 'ignored'

export interface StoreOptions {
  maxTickGap: number
  includeClient?: boolean
  /** 多个分片都在写时，优先用「有玩家」的那个快照（默认 true） */
  preferPlayerShard?: boolean
  now?: () => number
}

export interface StoreCounts {
  boot: number
  state: number
  nearby: number
  ignored: number
  duplicates: number
  invalid: number
}

export interface NormalizedItem {
  prefab: string
  name?: string
  count: number
  slot?: number
  uses_left?: number
  uses_max?: number
  freshness?: number
  fuel?: number
  armor?: number
}

export interface NormalizedState {
  schema_version: string
  timestamp: { unix?: number; real_s?: number; sim_tick?: number }
  session?: string
  side?: string
  shard?: string
  tick: number
  player?: Record<string, unknown>
  inventory?: Record<string, unknown> & { items: NormalizedItem[] }
  world?: Record<string, unknown>
  observer?: Record<string, unknown>
}

export interface NormalizedNearby {
  tick: number
  radius_tiles?: number
  scanned?: number
  returned?: number
  truncated?: boolean
  trimmed?: boolean
  scanned_at_tick?: number
  counts?: Record<string, number>
  entities: Array<Record<string, unknown>>
}

export interface MergedState extends NormalizedState {
  nearby?: NormalizedNearby
  nearby_tick?: number
  nearby_stale?: boolean
}

export interface ShardStatus {
  session: string
  shard: string | null
  side: string | null
  tick: number | null
  hasPlayer: boolean
  lastRecordAgoMs: number | null
  counts: StoreCounts
}

export interface StoreStatus {
  connected: boolean
  reason?: string
  session: string | null
  shard: string | null
  side: string | null
  tick: number | null
  bootAt: number | null
  lastRecordAt: number | null
  lastRecordAgoMs: number | null
  lastStateAt: number | null
  restarts: number
  counts: StoreCounts
  invalidSamples: Array<{ at: number; errors: string[] }>
  hasSnapshot: boolean
  shards: ShardStatus[]
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** tick 归一化：0.6.0+ 在顶层，更早版本在 observer.tick */
export function tickOf(record: WireRecord): number | undefined {
  const direct = asNumber(record.tick)
  if (direct !== undefined) return direct
  const observer = asObject(record.observer)
  return asNumber(observer?.tick)
}

export function normalizeItem(raw: unknown): NormalizedItem | null {
  const item = asObject(raw)
  if (!item || typeof item.prefab !== 'string') return null
  const out: NormalizedItem = { prefab: item.prefab, count: asNumber(item.count) ?? 1 }
  if (typeof item.name === 'string') out.name = item.name
  const slot = asNumber(item.slot)
  if (slot !== undefined) out.slot = slot
  for (const key of ['uses_left', 'uses_max', 'freshness', 'fuel', 'armor'] as const) {
    const value = asNumber(item[key])
    if (value !== undefined) out[key] = value
  }
  return out
}

export function normalizeInventory(
  raw: unknown,
): (Record<string, unknown> & { items: NormalizedItem[] }) | undefined {
  const inv = asObject(raw)
  if (!inv) return undefined
  const items = asArray(inv.items)
    .map(normalizeItem)
    .filter((item): item is NormalizedItem => item !== null)
  const out: Record<string, unknown> & { items: NormalizedItem[] } = { ...inv, items }
  const equipment = asObject(inv.equipment)
  if (equipment) {
    const normalized: Record<string, NormalizedItem> = {}
    for (const slot of ['hands', 'head', 'body'] as const) {
      const item = normalizeItem(equipment[slot])
      if (item) normalized[slot] = item
    }
    out.equipment = normalized
  }
  return out
}

export function normalizeState(record: WireRecord): NormalizedState | null {
  const tick = tickOf(record)
  if (tick === undefined) return null
  const state: NormalizedState = {
    schema_version: String(record.schema_version ?? '1'),
    timestamp: {
      unix: asNumber(record.t),
      real_s: asNumber(record.rt),
      sim_tick: asNumber(record.sim_tick),
    },
    tick,
  }
  if (typeof record.session === 'string') state.session = record.session
  if (typeof record.side === 'string') state.side = record.side
  if (typeof record.shard === 'string') state.shard = record.shard
  const player = asObject(record.player)
  if (player) state.player = player
  const inventory = normalizeInventory(record.inventory)
  if (inventory) state.inventory = inventory
  const world = asObject(record.world)
  if (world) state.world = world
  const observer = asObject(record.observer)
  if (observer) state.observer = observer
  return state
}

export function normalizeNearby(record: WireRecord): NormalizedNearby | null {
  const tick = tickOf(record) ?? asNumber(record.scanned_at_tick)
  if (tick === undefined) return null
  const counts = asObject(record.counts)
  const nearby: NormalizedNearby = {
    tick,
    entities: asArray(record.entities).filter((e): e is Record<string, unknown> => asObject(e) !== undefined),
  }
  const radius = asNumber(record.radius_tiles)
  if (radius !== undefined) nearby.radius_tiles = radius
  const scanned = asNumber(record.scanned)
  if (scanned !== undefined) nearby.scanned = scanned
  const returned = asNumber(record.returned)
  if (returned !== undefined) nearby.returned = returned
  if (typeof record.truncated === 'boolean') nearby.truncated = record.truncated
  if (typeof record.trimmed === 'boolean') nearby.trimmed = record.trimmed
  if (typeof record.oversize === 'boolean' && nearby.trimmed === undefined) nearby.trimmed = record.oversize
  const scannedAt = asNumber(record.scanned_at_tick)
  if (scannedAt !== undefined) nearby.scanned_at_tick = scannedAt
  if (counts) {
    const clean: Record<string, number> = {}
    for (const [key, value] of Object.entries(counts)) {
      const n = asNumber(value)
      if (n !== undefined) clean[key] = n
    }
    nearby.counts = clean
  }
  return nearby
}

function emptyCounts(): StoreCounts {
  return { boot: 0, state: 0, nearby: 0, ignored: 0, duplicates: 0, invalid: 0 }
}

interface ShardEntry {
  session: string
  shard: string | null
  side: string | null
  bootAt: number | null
  lastState: NormalizedState | null
  lastNearby: NormalizedNearby | null
  stateAt: number | null
  recordAt: number | null
  counts: StoreCounts
  /** 去重用：同一个 tick+type 只算一次（boot 时清空） */
  seen: Set<string>
}

export class StateStore {
  private readonly now: () => number
  /** 每个 session（= 每个分片进程）一份快照 */
  private readonly shards = new Map<string, ShardEntry>()
  private restarts = 0
  private lastRecordAt: number | null = null
  private counts: StoreCounts = emptyCounts()
  private invalidSamples: Array<{ at: number; errors: string[] }> = []

  constructor(private readonly opts: StoreOptions) {
    this.now = opts.now ?? Date.now
  }

  private entry(session: string, record?: WireRecord): ShardEntry {
    let entry = this.shards.get(session)
    if (!entry) {
      entry = {
        session,
        shard: null,
        side: null,
        bootAt: null,
        lastState: null,
        lastNearby: null,
        stateAt: null,
        recordAt: null,
        counts: emptyCounts(),
        seen: new Set<string>(),
      }
      this.shards.set(session, entry)
    }
    if (record) {
      if (typeof record.shard === 'string') entry.shard = record.shard
      if (typeof record.side === 'string') entry.side = record.side
    }
    return entry
  }

  /** 吃一条记录。invalidErrors 非空表示 schema 校验没过（计入 invalid，不进快照）。 */
  apply(record: WireRecord, invalidErrors?: string[]): RecordKind {
    const at = this.now()
    const session = typeof record.session === 'string' ? record.session : '-'
    const entry = this.entry(session, record)

    if (invalidErrors && invalidErrors.length > 0) {
      this.counts.invalid += 1
      entry.counts.invalid += 1
      this.invalidSamples.push({ at, errors: invalidErrors.slice(0, 5) })
      if (this.invalidSamples.length > 20) this.invalidSamples.shift()
      return 'ignored'
    }

    // 客户端记录不采信（replica 数据不全）
    if (typeof record.side === 'string' && record.side !== 'server' && !this.opts.includeClient) {
      this.counts.ignored += 1
      entry.counts.ignored += 1
      return 'ignored'
    }

    if (record.type !== 'boot') {
      const dedupeKey = record.type + '|' + String(tickOf(record) ?? record.t ?? '-')
      if (entry.seen.has(dedupeKey)) {
        this.counts.duplicates += 1
        entry.counts.duplicates += 1
        return 'ignored'
      }
      entry.seen.add(dedupeKey)
      if (entry.seen.size > 512) {
        const first = entry.seen.values().next()
        if (!first.done) entry.seen.delete(first.value)
      }
    }

    this.lastRecordAt = at
    entry.recordAt = at

    if (record.type === 'boot') {
      if (entry.bootAt !== null) this.restarts += 1
      entry.bootAt = at
      entry.lastState = null
      entry.lastNearby = null
      entry.stateAt = null
      entry.seen.clear()
      entry.counts.boot += 1
      this.counts.boot += 1
      return 'boot'
    }

    if (record.type === 'state') {
      const state = normalizeState(record)
      if (!state) {
        this.counts.invalid += 1
        entry.counts.invalid += 1
        return 'ignored'
      }
      entry.lastState = state
      entry.stateAt = at
      entry.shard = state.shard ?? entry.shard
      entry.side = state.side ?? entry.side
      entry.counts.state += 1
      this.counts.state += 1
      return 'state'
    }

    if (record.type === 'nearby') {
      const nearby = normalizeNearby(record)
      if (!nearby) {
        this.counts.invalid += 1
        entry.counts.invalid += 1
        return 'ignored'
      }
      entry.lastNearby = nearby
      entry.counts.nearby += 1
      this.counts.nearby += 1
      return 'nearby'
    }

    this.counts.ignored += 1
    entry.counts.ignored += 1
    return 'ignored'
  }

  private hasPlayer(entry: ShardEntry): boolean {
    const player = entry.lastState?.player
    if (!player) return false
    return player.valid !== false
  }

  /**
   * 选一份快照：优先「有玩家」的分片（Master/Caves 都在发状态，没人的那个不该顶上来），
   * 同一优先级里取最新的一份。
   */
  private pick(): ShardEntry | null {
    const candidates = [...this.shards.values()].filter((entry) => entry.lastState !== null)
    if (candidates.length === 0) return null
    const withPlayer = candidates.filter((entry) => this.hasPlayer(entry))
    const preferPlayer = this.opts.preferPlayerShard ?? true
    const pool = preferPlayer && withPlayer.length > 0 ? withPlayer : candidates
    pool.sort((a, b) => (b.stateAt ?? 0) - (a.stateAt ?? 0))
    return pool[0] ?? null
  }

  /** 合并后的快照；还没有 state 时返回 null */
  state(): MergedState | null {
    const best = this.pick()
    if (!best || !best.lastState) return null
    const merged: MergedState = { ...best.lastState }
    if (best.lastNearby) {
      const gap = Math.abs(best.lastState.tick - best.lastNearby.tick)
      if (gap <= this.opts.maxTickGap) {
        merged.nearby = best.lastNearby
        merged.nearby_tick = best.lastNearby.tick
        merged.nearby_stale = gap > 0
      }
    }
    return merged
  }

  status(staleMs = 15000): StoreStatus {
    const at = this.now()
    const ago = this.lastRecordAt === null ? null : at - this.lastRecordAt
    const connected = ago !== null && ago <= staleMs
    const best = this.pick()
    return {
      connected,
      reason: connected
        ? undefined
        : this.lastRecordAt === null
          ? '还没收到任何 [BWS] 记录（游戏没开？模组没启用？没进世界？）'
          : '最近一条记录是 ' + Math.round((ago ?? 0) / 1000) + ' 秒前的（游戏可能暂停/退出了）',
      session: best?.session ?? null,
      shard: best?.shard ?? null,
      side: best?.side ?? null,
      tick: best?.lastState?.tick ?? null,
      bootAt: best?.bootAt ?? null,
      lastRecordAt: this.lastRecordAt,
      lastRecordAgoMs: ago,
      lastStateAt: best?.stateAt ?? null,
      restarts: this.restarts,
      counts: { ...this.counts },
      invalidSamples: this.invalidSamples.slice(-5),
      hasSnapshot: best !== null,
      shards: [...this.shards.values()].map((entry) => ({
        session: entry.session,
        shard: entry.shard,
        side: entry.side,
        tick: entry.lastState?.tick ?? null,
        hasPlayer: this.hasPlayer(entry),
        lastRecordAgoMs: entry.recordAt === null ? null : at - entry.recordAt,
        counts: { ...entry.counts },
      })),
    }
  }
}
