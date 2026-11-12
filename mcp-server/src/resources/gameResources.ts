// MCP Resources（M4）
//
// 6 个只读资源，全部从 Bridge 的最新快照读取：
//   dst://game/status     总览
//   dst://game/player     玩家
//   dst://game/inventory  背包
//   dst://game/world      世界
//   dst://game/nearby     附近实体
//   dst://game/bridge     通道状态
//
// 与 Tools 的区别（MCP 规范语义）：
//   · Resource 是"可以被客户端直接挂载/轮询的文档"，返回 text 或 blob；
//   · Tool 是"AI 主动调用的动作"，带参数与结构化输出。
//   这里 Resource 给的是同一份数据的 JSON 文本，方便客户端做上下文注入。

import type { McpServer } from '@modelcontextprotocol/server'
import type { GameToolService } from '../server/createServer.js'
import { asDict, freshnessLine, freshnessOf, parseItems, parseNearbyEntities, nearbyMeta } from '../tools/snapshot.js'

export interface ResourceSpec {
  uri: string
  name: string
  title: string
  description: string
  mimeType: string
}

export const RESOURCE_SPECS: ResourceSpec[] = [
  {
    uri: 'dst://game/status',
    name: 'game-status',
    title: '游戏总状态',
    description: '玩家、世界、背包、附近实体的总览，含数据新鲜度',
    mimeType: 'application/json',
  },
  {
    uri: 'dst://game/player',
    name: 'game-player',
    title: '玩家状态',
    description: '当前玩家的生命/饥饿/理智/位置/幽灵状态',
    mimeType: 'application/json',
  },
  {
    uri: 'dst://game/inventory',
    name: 'game-inventory',
    title: '背包',
    description: '背包物品与装备栏，含数量/耐久/新鲜度/燃料',
    mimeType: 'application/json',
  },
  {
    uri: 'dst://game/world',
    name: 'game-world',
    title: '世界状态',
    description: '天数/季节/昼夜/天气/温度/月相',
    mimeType: 'application/json',
  },
  {
    uri: 'dst://game/nearby',
    name: 'game-nearby',
    title: '附近实体',
    description: '附近实体列表（按距离排序）与类别统计',
    mimeType: 'application/json',
  },
  {
    uri: 'dst://game/bridge',
    name: 'game-bridge',
    title: 'Bridge 通道',
    description: 'MCP Server 与 Game Bridge 的连接状态、会话、命令队列',
    mimeType: 'application/json',
  },
]

/** 统一读一次快照，产出资源文档 */
async function buildResource(service: GameToolService, uri: string): Promise<{ text: string; payload: Record<string, unknown> }> {
  const { client, events } = service.context

  if (uri === 'dst://game/bridge') {
    const health = await client.health()
    const status = await client.status()
    const bridge = asDict(status.data.bridge) ?? {}
    const sessions = Array.isArray(status.data.sessions) ? status.data.sessions : []
    const payload = {
      ok: true,
      source: 'bridge',
      fetched_at: new Date().toISOString(),
      bridge_url: client.url,
      health: health.data,
      bridge,
      sessions,
      session_count: sessions.length,
      alive_session_count: sessions.filter((session) => (session as { alive?: boolean }).alive === true).length,
    }
    return { text: JSON.stringify(payload, null, 2), payload }
  }

  const read = await client.readSnapshot()
  const snapshot = asDict(read.game.snapshot)
  const freshness = freshnessOf(read)
  events.observe(snapshot, { stale: read.stale, staleReason: read.staleReason })

  if (snapshot === null) {
    const payload = { ok: false, freshness, error: { code: 'GAME_DISCONNECTED', message: 'Bridge 里没有可用的游戏快照' } }
    return { text: JSON.stringify(payload, null, 2), payload }
  }

  if (uri === 'dst://game/player') {
    const payload = { ok: true, freshness, player: asDict(snapshot.player) }
    return { text: JSON.stringify(payload, null, 2), payload }
  }
  if (uri === 'dst://game/inventory') {
    const inventory = asDict(snapshot.inventory)
    const payload = { ok: true, freshness, inventory: inventory === null ? null : { ...inventory, items: parseItems(inventory) } }
    return { text: JSON.stringify(payload, null, 2), payload }
  }
  if (uri === 'dst://game/world') {
    const payload = { ok: true, freshness, world: asDict(snapshot.world) }
    return { text: JSON.stringify(payload, null, 2), payload }
  }
  if (uri === 'dst://game/nearby') {
    const meta = nearbyMeta(snapshot)
    const entities = parseNearbyEntities(snapshot)
    const counts: Record<string, number> = {}
    for (const entity of entities) counts[entity.category] = (counts[entity.category] ?? 0) + 1
    const payload = { ok: true, freshness, nearby_meta: meta, counts, entities }
    return { text: JSON.stringify(payload, null, 2), payload }
  }

  // dst://game/status
  const inventory = asDict(snapshot.inventory)
  const items = parseItems(inventory)
  const payload = {
    ok: true,
    freshness,
    summary: freshnessLine(freshness),
    session: { session_id: freshness.session_id, shard: freshness.shard, alive: freshness.session_alive },
    player: asDict(snapshot.player),
    world: asDict(snapshot.world),
    inventory: inventory === null ? null : { slots: inventory.slots ?? null, used: inventory.used ?? items.length, items },
    nearby: nearbyMeta(snapshot),
  }
  return { text: JSON.stringify(payload, null, 2), payload }
}

export function registerResources(server: McpServer, service: GameToolService): void {
  for (const spec of RESOURCE_SPECS) {
    server.registerResource(
      spec.name,
      spec.uri,
      { title: spec.title, description: spec.description, mimeType: spec.mimeType },
      async (uri: URL) => {
        const built = await buildResource(service, uri.toString())
        return { contents: [{ uri: uri.toString(), mimeType: spec.mimeType, text: built.text }] }
      },
    )
  }
}
