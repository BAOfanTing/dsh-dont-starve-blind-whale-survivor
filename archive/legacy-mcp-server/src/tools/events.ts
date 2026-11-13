// 事件流（M4）
//
// 为什么要自己算：Bridge 只存"最新快照"，没有历史。MCP 层每次读快照时对比上一次，
// 就能产出"发生了什么"的事件 —— 这是 AI 判断局势变化最直接的信息。
//
// 设计取舍：
//   · 事件在 **MCP 进程内**产生（不污染 Bridge / 游戏端），Bridge 重启不影响游戏；
//   · 环形缓冲（默认 200 条），避免无限增长；
//   · 事件只在"值真的变了"时产生，避免每 2 秒刷一条"没变化"；
//   · 阈值可调（血量掉多少算"受伤"、饥饿掉多少算"饿了"），避免噪声。

import { asBool, asDict, asNum, asStr, type Dict } from '../tools/snapshot.js'

export type EventKind =
  | 'health_dropped'
  | 'health_restored'
  | 'hunger_dropped'
  | 'hunger_restored'
  | 'sanity_dropped'
  | 'sanity_restored'
  | 'player_died'
  | 'player_revived'
  | 'became_ghost'
  | 'phase_changed'
  | 'day_changed'
  | 'season_changed'
  | 'weather_changed'
  | 'threats_appeared'
  | 'threats_cleared'
  | 'inventory_changed'
  | 'nearby_item_appeared'
  | 'state_stale'
  | 'state_recovered'

export interface GameEvent {
  /** 单调递增序号（同一次 MCP 进程内） */
  seq: number
  /** 事件发生时的游戏 tick（来自快照） */
  tick: number | null
  /** 检测到事件的时刻（毫秒） */
  at: number
  kind: EventKind
  /** 严重程度，AI 用它排序 */
  severity: 'info' | 'warning' | 'critical'
  /** 一句话描述（中文） */
  message: string
  /** 结构化细节（前后值等） */
  detail: Record<string, unknown>
}

export interface EventDetectorOptions {
  /** 血量下降超过这个百分点才算"受伤" */
  healthDropThreshold?: number
  /** 饥饿下降超过这个百分点才算"饿了" */
  hungerDropThreshold?: number
  /** 理智下降超过这个百分点才算"理智下降" */
  sanityDropThreshold?: number
  /** 环形缓冲上限 */
  maxEvents?: number
  /** 连续多久没新快照算"过期事件"（毫秒） */
  staleAfterMs?: number
  now?: () => number
}

interface PlayerState {
  healthPercent: number | null
  hungerPercent: number | null
  sanityPercent: number | null
  isGhost: boolean | null
  dead: boolean | null
}

interface WorldState {
  day: number | null
  phase: string | null
  season: string | null
  raining: boolean | null
  snowing: boolean | null
  temperature: number | null
}

interface ThreatState {
  hostileCount: number
  nearestDistance: number | null
  nearestName: string | null
}

interface SnapshotState {
  tick: number | null
  player: PlayerState
  world: WorldState
  threats: ThreatState
  itemCount: number
  inventorySignature: string
}

function readPlayer(snapshot: Dict | null): PlayerState {
  const player = asDict(snapshot?.player)
  const health = asDict(player?.health)
  const hunger = asDict(player?.hunger)
  const sanity = asDict(player?.sanity)
  return {
    healthPercent: asNum(health?.percent),
    hungerPercent: asNum(hunger?.percent),
    sanityPercent: asNum(sanity?.percent),
    isGhost: asBool(player?.is_ghost),
    dead: asBool(health?.dead),
  }
}

function readWorld(snapshot: Dict | null): WorldState {
  const world = asDict(snapshot?.world)
  const weather = asDict(world?.weather)
  return {
    day: asNum(world?.day),
    phase: asStr(world?.phase),
    season: asStr(world?.season),
    raining: asBool(weather?.is_raining),
    snowing: asBool(weather?.is_snowing),
    temperature: asNum(world?.temperature),
  }
}

function readThreats(snapshot: Dict | null): ThreatState {
  const nearby = asDict(snapshot?.nearby)
  const entities = Array.isArray(nearby?.entities) ? (nearby?.entities as unknown[]) : []
  let hostileCount = 0
  let nearestDistance: number | null = null
  let nearestName: string | null = null
  for (const item of entities) {
    const entity = asDict(item)
    if (entity === null) continue
    if (asStr(entity.category) !== 'hostile') continue
    hostileCount += 1
    const distance = asNum(entity.distance)
    if (distance !== null && (nearestDistance === null || distance < nearestDistance)) {
      nearestDistance = distance
      nearestName = asStr(entity.name) ?? asStr(entity.prefab)
    }
  }
  return { hostileCount, nearestDistance, nearestName }
}

function readInventorySignature(snapshot: Dict | null): { signature: string; count: number } {
  const inventory = asDict(snapshot?.inventory)
  const items = Array.isArray(inventory?.items) ? (inventory?.items as unknown[]) : []
  const parts: string[] = []
  for (const item of items) {
    const dict = asDict(item)
    if (dict === null) continue
    parts.push(`${asStr(dict.prefab) ?? '?'}x${asNum(dict.count) ?? 1}`)
  }
  parts.sort()
  return { signature: parts.join('|'), count: items.length }
}

function capture(snapshot: Dict | null): SnapshotState {
  const inventory = readInventorySignature(snapshot)
  return {
    tick: asNum(snapshot?.tick),
    player: readPlayer(snapshot),
    world: readWorld(snapshot),
    threats: readThreats(snapshot),
    itemCount: inventory.count,
    inventorySignature: inventory.signature,
  }
}

const PHASE_LABEL: Record<string, string> = { day: '白天', dusk: '黄昏', night: '夜晚' }
const SEASON_LABEL: Record<string, string> = { autumn: '秋季', winter: '冬季', spring: '春季', summer: '夏季' }

export class EventDetector {
  private readonly events: GameEvent[] = []
  private seq = 0
  private previous: SnapshotState | null = null
  private lastStale: boolean | null = null
  private readonly healthDrop: number
  private readonly hungerDrop: number
  private readonly sanityDrop: number
  private readonly maxEvents: number
  private readonly now: () => number

  constructor(options: EventDetectorOptions = {}) {
    // 阈值故意设得小：饥荒里饥饿大约每秒掉 0.1~0.2%，4 秒掉不到 1%，
    // 阈值设 3 就永远不触发。默认改成 0.5%，能捕捉到真实变化又不会被浮点噪声刷屏。
    this.healthDrop = options.healthDropThreshold ?? 1
    this.hungerDrop = options.hungerDropThreshold ?? 0.5
    this.sanityDrop = options.sanityDropThreshold ?? 1
    this.maxEvents = options.maxEvents ?? 200
    this.now = options.now ?? Date.now
  }

  private push(kind: EventKind, severity: GameEvent['severity'], message: string, detail: Record<string, unknown>, tick: number | null) {
    this.seq += 1
    this.events.push({ seq: this.seq, tick, at: this.now(), kind, severity, message, detail })
    while (this.events.length > this.maxEvents) this.events.shift()
  }

  /**
   * 喂一份快照，产出新事件。
   * stale=true 时只产生"数据过期/恢复"事件，不比较数值（旧数据比较没有意义）。
   */
  observe(snapshot: Dict | null, options: { stale: boolean; staleReason?: string | null } = { stale: false }): GameEvent[] {
    const before = this.events.length
    const tick = asNum(snapshot?.tick)

    // 过期状态切换
    if (this.lastStale !== options.stale) {
      if (options.stale) {
        this.push('state_stale', 'warning', `游戏数据过期（${options.staleReason ?? 'unknown'}），后续数值可能不代表当前`, { stale_reason: options.staleReason ?? null }, tick)
      } else if (this.lastStale === true) {
        this.push('state_recovered', 'info', '游戏数据恢复新鲜', {}, tick)
      }
      this.lastStale = options.stale
    }

    if (options.stale) {
      // 过期数据不参与差分（避免拿旧值当变化）
      return this.events.slice(before)
    }

    const current = capture(snapshot)
    const previous = this.previous
    this.previous = current
    if (previous === null) return this.events.slice(before)

    // ── 玩家：生命 / 饥饿 / 理智 / 死亡 / 幽灵 ──
    const hpBefore = previous.player.healthPercent
    const hpAfter = current.player.healthPercent
    if (hpBefore !== null && hpAfter !== null) {
      const delta = hpAfter - hpBefore
      if (delta <= -this.healthDrop) {
        this.push('health_dropped', delta <= -20 ? 'critical' : 'warning', `生命下降 ${Math.abs(Math.round(delta))}%（${Math.round(hpBefore)}% → ${Math.round(hpAfter)}%）`, { before: hpBefore, after: hpAfter, delta }, tick)
      } else if (delta >= this.healthDrop) {
        this.push('health_restored', 'info', `生命恢复 ${Math.round(delta)}%（${Math.round(hpBefore)}% → ${Math.round(hpAfter)}%）`, { before: hpBefore, after: hpAfter, delta }, tick)
      }
    }

    const hungerBefore = previous.player.hungerPercent
    const hungerAfter = current.player.hungerPercent
    if (hungerBefore !== null && hungerAfter !== null) {
      const delta = hungerAfter - hungerBefore
      if (delta <= -this.hungerDrop) {
        this.push('hunger_dropped', hungerAfter <= 15 ? 'critical' : 'info', `饥饿下降 ${Math.abs(Math.round(delta))}%（现在 ${Math.round(hungerAfter)}%）`, { before: hungerBefore, after: hungerAfter, delta }, tick)
      } else if (delta >= this.hungerDrop) {
        this.push('hunger_restored', 'info', `饥饿恢复 ${Math.round(delta)}%（现在 ${Math.round(hungerAfter)}%）`, { before: hungerBefore, after: hungerAfter, delta }, tick)
      }
    }

    const sanityBefore = previous.player.sanityPercent
    const sanityAfter = current.player.sanityPercent
    if (sanityBefore !== null && sanityAfter !== null) {
      const delta = sanityAfter - sanityBefore
      if (delta <= -this.sanityDrop) {
        this.push('sanity_dropped', sanityAfter <= 20 ? 'warning' : 'info', `理智下降 ${Math.abs(Math.round(delta))}%（现在 ${Math.round(sanityAfter)}%）`, { before: sanityBefore, after: sanityAfter, delta }, tick)
      } else if (delta >= this.sanityDrop) {
        this.push('sanity_restored', 'info', `理智恢复 ${Math.round(delta)}%`, { before: sanityBefore, after: sanityAfter, delta }, tick)
      }
    }

    if (previous.player.dead === false && current.player.dead === true) {
      this.push('player_died', 'critical', '玩家死亡', {}, tick)
    } else if (previous.player.dead === true && current.player.dead === false) {
      this.push('player_revived', 'info', '玩家复活', {}, tick)
    }
    if (previous.player.isGhost === false && current.player.isGhost === true) {
      this.push('became_ghost', 'critical', '玩家变成幽灵状态（需要复活）', {}, tick)
    }

    // ── 世界：天数 / 昼夜 / 季节 / 天气 ──
    if (previous.world.day !== null && current.world.day !== null && current.world.day !== previous.world.day) {
      this.push('day_changed', 'info', `进入第 ${current.world.day} 天`, { before: previous.world.day, after: current.world.day }, tick)
    }
    if (previous.world.phase !== null && current.world.phase !== null && current.world.phase !== previous.world.phase) {
      const from = PHASE_LABEL[previous.world.phase] ?? previous.world.phase
      const to = PHASE_LABEL[current.world.phase] ?? current.world.phase
      this.push('phase_changed', current.world.phase === 'night' ? 'warning' : 'info', `昼夜变化：${from} → ${to}`, { before: previous.world.phase, after: current.world.phase }, tick)
    }
    if (previous.world.season !== null && current.world.season !== null && current.world.season !== previous.world.season) {
      const from = SEASON_LABEL[previous.world.season] ?? previous.world.season
      const to = SEASON_LABEL[current.world.season] ?? current.world.season
      this.push('season_changed', 'warning', `季节变化：${from} → ${to}`, { before: previous.world.season, after: current.world.season }, tick)
    }
    const weatherBefore = `${previous.world.raining === true ? '雨' : ''}${previous.world.snowing === true ? '雪' : ''}` || '晴'
    const weatherAfter = `${current.world.raining === true ? '雨' : ''}${current.world.snowing === true ? '雪' : ''}` || '晴'
    if (weatherBefore !== weatherAfter) {
      this.push('weather_changed', weatherAfter === '晴' ? 'info' : 'warning', `天气变化：${weatherBefore} → ${weatherAfter}`, { before: weatherBefore, after: weatherAfter }, tick)
    }

    // ── 威胁 ──
    if (current.threats.hostileCount > previous.threats.hostileCount) {
      this.push(
        'threats_appeared',
        'warning',
        `附近出现敌对生物（${previous.threats.hostileCount} → ${current.threats.hostileCount}）${current.threats.nearestName !== null ? `，最近：${current.threats.nearestName} 距离 ${current.threats.nearestDistance ?? '?'}` : ''}`,
        { before: previous.threats.hostileCount, after: current.threats.hostileCount, nearest: current.threats.nearestName, distance: current.threats.nearestDistance },
        tick,
      )
    } else if (current.threats.hostileCount === 0 && previous.threats.hostileCount > 0) {
      this.push('threats_cleared', 'info', '附近敌对生物已消失', { before: previous.threats.hostileCount }, tick)
    }

    // ── 背包 ──
    if (current.inventorySignature !== previous.inventorySignature) {
      this.push('inventory_changed', 'info', `背包变化（${previous.itemCount} → ${current.itemCount} 种物品）`, { before: previous.inventorySignature, after: current.inventorySignature }, tick)
    }

    return this.events.slice(before)
  }

  /** 取最近事件（可按类型/严重程度过滤） */
  recent(options: { limit?: number; kinds?: EventKind[]; severity?: Array<GameEvent['severity']>; sinceSeq?: number } = {}): GameEvent[] {
    let list = [...this.events]
    if (options.kinds !== undefined && options.kinds.length > 0) list = list.filter((event) => options.kinds!.includes(event.kind))
    if (options.severity !== undefined && options.severity.length > 0) list = list.filter((event) => options.severity!.includes(event.severity))
    if (options.sinceSeq !== undefined) list = list.filter((event) => event.seq > options.sinceSeq!)
    const limit = options.limit ?? 20
    return list.slice(-limit)
  }

  stats(): { total: number; buffered: number; last_seq: number; by_kind: Record<string, number> } {
    const byKind: Record<string, number> = {}
    for (const event of this.events) byKind[event.kind] = (byKind[event.kind] ?? 0) + 1
    return { total: this.seq, buffered: this.events.length, last_seq: this.seq, by_kind: byKind }
  }

  reset(): void {
    this.events.length = 0
    this.previous = null
    this.lastStale = null
  }
}
