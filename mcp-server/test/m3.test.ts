// M3 测试：10 个只读工具的真实解析逻辑
//
// 用真实 HTTP 假 Bridge 返回**仿真快照**（字段与游戏端 state_serializer 输出一致），
// 逐个工具验证：结构化字段、文本摘要、类别过滤、新鲜度标注、错误分支。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { BridgeClient } from '../src/bridge/client.js'
import { loadConfig } from '../src/config.js'
import { createToolDefinitions, runTool, type ToolContext } from '../src/tools/definitions.js'
import { createLogger } from '../src/utils/logger.js'

const textOf = (result: { content: Array<{ text: string }> }): string => String(result.content[0]?.text ?? '')

const TOOLS = createToolDefinitions()
const byName = new Map(TOOLS.map((tool) => [tool.name, tool]))

function snapshotPayload(overrides: { stale?: boolean; snapshot?: Record<string, unknown> } = {}) {
  const baseSnapshot = {
    schema_version: '1',
    tick: 128,
    session: '26FA73B94506B226',
    side: 'server',
    shard: 'master',
    timestamp: { unix: 1794447000, real_s: 300, sim_tick: 7200 },
    player: {
      valid: true,
      prefab: 'wilson',
      name: '威尔逊',
      guid: 117116,
      userid: 'KU_dsu8_vGS',
      is_ghost: false,
      position: { x: -470.2, y: 0, z: 74.1, tile_x: -118, tile_z: 18 },
      health: { current: 120, max: 150, percent: 80, dead: false },
      hunger: { current: 90, max: 150, percent: 60 },
      sanity: { current: 160, max: 200, percent: 80 },
      temperature: { current: 28.4 },
      moisture: { value: 0, percent: 0 },
    },
    inventory: {
      slots: 15,
      used: 3,
      is_full: false,
      items: [
        { prefab: 'axe', name: '斧头', count: 1, slot: 1, uses_left: 70, uses_max: 100 },
        { prefab: 'berries', name: '浆果', count: 4, slot: 2, freshness: 88 },
        { prefab: 'torch', name: '火把', count: 1, slot: 3, fuel: 45 },
      ],
      equipment: { hands: { prefab: 'axe', name: '斧头', count: 1, uses_left: 70, uses_max: 100 } },
    },
    world: {
      day: 5,
      cycles: 4,
      phase: 'day',
      is_day: true,
      is_dusk: false,
      is_night: false,
      season: 'autumn',
      season_progress: 0.25,
      elapsed_days_in_season: 4,
      remaining_days_in_season: 16,
      temperature: 28.4,
      time: { of_day: 0.3, in_phase: 0.2 },
      moon: { phase: 'quarter', is_full_moon: false, is_new_moon: false, is_waxing_moon: true },
      weather: { is_raining: false, is_snowing: false, is_wet: false, is_snow_covered: false, is_acid_raining: false, precipitation_rate: 0, wetness: 0, snow_level: 0 },
      shard: 'master',
    },
    nearby: {
      radius_tiles: 16,
      scanned: 40,
      returned: 6,
      truncated: false,
      scanned_at_tick: 128,
      counts: { tree: 2, harvestable: 2, hostile: 1, structure: 1 },
      entities: [
        { prefab: 'evergreen', name: '常青树', category: 'tree', tile_x: -116, tile_z: 18, distance: 2.1, work_left: 15 },
        { prefab: 'grass', name: '草', category: 'harvestable', tile_x: -119, tile_z: 19, distance: 1.4 },
        { prefab: 'spider', name: '蜘蛛', category: 'hostile', tile_x: -117, tile_z: 17, distance: 1.9, hp: 75 },
        { prefab: 'rabbit', name: '兔子', category: 'creature', tile_x: -120, tile_z: 20, distance: 3.6, hp: 25 },
        { prefab: 'chest', name: '箱子', category: 'structure', tile_x: -118, tile_z: 16, distance: 2.0 },
        { prefab: 'flint', name: '燧石', category: 'item', tile_x: -115, tile_z: 18, distance: 3.1 },
      ],
    },
  }
  const snapshot = overrides.snapshot ?? baseSnapshot
  return {
    success: true,
    protocol_version: '1.0',
    server_time: Date.now(),
    session: {
      session_id: '26FA73B94506B226-master-1794410203',
      shard: 'master',
      game_version: 'release',
      alive: !overrides.stale,
      reconnects: 0,
      heartbeats: 100,
      acknowledged_sequence: 128,
      duplicates: 0,
      gaps: 0,
      player_status: { present: true },
    },
    snapshot,
    snapshot_at: Date.now() - 500,
    snapshot_age_ms: 500,
    stale: overrides.stale ?? false,
    stale_reason: overrides.stale === true ? 'heartbeat_timeout' : null,
    stale_after_ms: 15000,
    other_sessions: 1,
  }
}

async function harness(options: { stale?: boolean; snapshot?: Record<string, unknown>; handler?: (path: string) => { status: number; body: unknown } } = {}) {
  const hits: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    hits.push(url.pathname)
    if (options.handler) {
      const custom = options.handler(url.pathname)
      const text = JSON.stringify(custom.body)
      res.writeHead(custom.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
      return
    }
    if (url.pathname === '/health') {
      const text = JSON.stringify({ success: true, bound: '127.0.0.1:18788' })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(text)
      return
    }
    if (url.pathname === '/api/v1/bridge/status') {
      const text = JSON.stringify({
        success: true,
        bridge: { connected: true, connected_reason: 'ok', last_heartbeat_ago_ms: 700, queued_commands: 0, active_commands: 0 },
        sessions: [{ session_id: 'S1', shard: 'master', alive: true, heartbeats: 100, telemetry_count: 120, acknowledged_sequence: 128, duplicates: 0, gaps: 0, last_payload_bytes: 6100 }],
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(text)
      return
    }
    if (url.pathname === '/api/v1/state') {
      const text = JSON.stringify(snapshotPayload({ stale: options.stale, snapshot: options.snapshot }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(text)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"success":false}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const base = `http://127.0.0.1:${port}`
  const config = { ...loadConfig({ BWS_TOKEN: 'test-token' }), bridgeUrl: base, token: 'test-token', toolTimeoutMs: 3000 }
  const logger = createLogger({ sink: () => {} })
  const ctx: ToolContext = { client: new BridgeClient(config, logger, { cacheTtlMs: 0 }), config, logger }
  return {
    ctx,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const tool = byName.get(name)
      assert.ok(tool, `没有这个工具：${name}`)
      return runTool(tool, args, ctx)
    },
  }
}

test('工具清单：12 个工具，全部只读，无重复', () => {
  assert.equal(TOOLS.length, 12)
  const names = TOOLS.map((tool) => tool.name)
  assert.equal(new Set(names).size, 12)
  for (const tool of TOOLS) {
    assert.equal(tool.readOnly, true, `${tool.name} 必须只读`)
    assert.ok(tool.description.length > 8, `${tool.name} 描述太短`)
    assert.ok(tool.schema !== undefined, `${tool.name} 缺 schema`)
  }
  // 只读工具里不允许出现任何写操作命名
  // 按词边界匹配，避免 threats 里的 "eat" 这类误伤
  const forbidden = ['move', 'attack', 'chop', 'mine', 'eat', 'craft', 'build', 'drop', 'kill', 'teleport']
  for (const tool of TOOLS) {
    const segments = tool.name.split('_')
    for (const word of forbidden) {
      assert.ok(!segments.includes(word), `工具名不应包含写操作：${tool.name}（${word}）`)
    }
  }
})

test('get_player_status：解析出生命/饥饿/理智/坐标', async () => {
  const h = await harness()
  try {
    const result = await h.call('get_player_status')
    assert.equal(result.isError, undefined)
    const data = result.structuredContent as Record<string, any>
    assert.equal(data.ok, true)
    assert.equal(data.freshness.stale, false)
    assert.equal(data.player.name, '威尔逊')
    assert.deepEqual(data.player.tile, { x: -118, z: 18 })
    assert.equal(data.player.health?.percent, 80)
    assert.equal(data.player.hunger?.percent, 60)
    assert.equal(data.player.sanity?.percent, 80)
    assert.equal(data.player.temperature, 28.4)
    assert.match(textOf(result), /数据新鲜/)
    assert.match(textOf(result), /威尔逊/)
  } finally {
    await h.close()
  }
})

test('get_inventory：物品数量/耐久/新鲜度/燃料 + 装备栏', async () => {
  const h = await harness()
  try {
    const result = await h.call('get_inventory')
    const data = result.structuredContent as Record<string, any>
    assert.equal(data.slots, 15)
    assert.equal(data.used, 3)
    assert.equal(data.items.length, 3)
    const axe = data.items.find((item: any) => item.prefab === 'axe') ?? {}
    assert.equal(axe.uses_left, 70)
    assert.equal(axe.uses_max, 100)
    const berries = data.items.find((item: any) => item.prefab === 'berries') ?? {}
    assert.equal(berries.count, 4)
    assert.equal(berries.freshness, 88)
    const torch = data.items.find((item: any) => item.prefab === 'torch') ?? {}
    assert.equal(torch.fuel, 45)
    assert.equal(data.equipment.hands?.prefab, 'axe')
    assert.match(textOf(result), /斧头/)
    assert.match(textOf(result), /耐久 70\/100/)
    assert.match(textOf(result), /燃料 45%/)
  } finally {
    await h.close()
  }
})

test('get_world_status：天数/季节/昼夜/天气/月相', async () => {
  const h = await harness()
  try {
    const result = await h.call('get_world_status')
    const data = result.structuredContent as Record<string, any>
    assert.equal(data.world.day, 5)
    assert.equal(data.world.phase, 'day')
    assert.equal(data.world.season, 'autumn')
    assert.equal(data.world.remaining_days_in_season, 16)
    assert.equal(data.world.weather?.is_raining, false)
    assert.equal(data.world.moon?.phase, 'quarter')
    assert.match(textOf(result), /第 5 天/)
  } finally {
    await h.close()
  }
})

test('get_nearby_entities：按距离排序 + 类别过滤 + 类别统计', async () => {
  const h = await harness()
  try {
    const all = await h.call('get_nearby_entities', {})
    const data = all.structuredContent as Record<string, any>
    assert.equal(data.total_before_filter, 6)
    assert.equal(data.entities.length, 6)
    // 最近的应该是草（1.4）
    assert.equal(data.entities[0]?.prefab, 'grass')
    assert.equal(data.counts?.tree, 1, 'counts 按实际实体统计，不信 fixture 里手写的数字')

    const filtered = await h.call('get_nearby_entities', { categories: ['tree', 'item'] })
    const filteredData = filtered.structuredContent as Record<string, any>
    assert.equal(filteredData.entities.length, 2, 'fixture 里只有 1 棵树 + 1 个掉落物')
    assert.ok(filteredData.entities.every((entity: any) => ['tree', 'item'].includes(entity.category)))

    const limited = await h.call('get_nearby_entities', { limit: 2 })
    assert.equal((limited.structuredContent as Record<string, any>).entities.length, 2)
  } finally {
    await h.close()
  }
})

test('get_nearby_resources：只返回可获取资源类别', async () => {
  const h = await harness()
  try {
    const result = await h.call('get_nearby_resources', {})
    const data = result.structuredContent as Record<string, any>
    // tree/harvestable/item 有，hostile/creature/structure 没有
    assert.equal(data.by_category?.tree, 1)
    assert.equal(data.by_category?.harvestable, 1)
    assert.equal(data.by_category?.item, 1)
    assert.equal(data.by_category?.hostile, undefined)
    assert.equal(data.total, 3)
    assert.match(textOf(result), /附近 16 格内资源/)
  } finally {
    await h.close()
  }
})

test('get_nearby_threats：敌对优先，威胁等级正确', async () => {
  const h = await harness()
  try {
    const result = await h.call('get_nearby_threats', {})
    const data = result.structuredContent as Record<string, any>
    assert.equal(data.threat_level, 'high')
    assert.equal(data.hostile_count, 1)
    assert.equal(data.creature_count, 1)
    assert.equal(data.nearest?.prefab, 'spider', '蜘蛛 1.9 比兔子 3.6 近')
    assert.match(textOf(result), /威胁等级：高/)
  } finally {
    await h.close()
  }
})

test('get_base_status：启发式基地判定', async () => {
  const h = await harness()
  try {
    const result = await h.call('get_base_status', {})
    const data = result.structuredContent as Record<string, any>
    assert.equal(data.structures.length, 1)
    assert.equal(data.containers, 1)
    // 有结构 + 容器，但没有光源 → score 2 → looks_like_base
    assert.equal(data.heuristic_score, 2)
    assert.equal(data.verdict, 'looks_like_base')
    assert.match(textOf(result), /启发式/)
  } finally {
    await h.close()
  }
})

test('数据过期时：工具如实标注 stale，而不是假装新鲜', async () => {
  const h = await harness({ stale: true })
  try {
    const result = await h.call('get_player_status')
    const data = result.structuredContent as Record<string, any>
    assert.equal(data.freshness.stale, true)
    assert.equal(data.freshness.stale_reason, 'heartbeat_timeout')
    assert.equal(data.freshness.session_alive, false)
    assert.match(textOf(result), /数据已过期/)
    assert.match(textOf(result), /不代表当前/)
  } finally {
    await h.close()
  }
})

test('快照缺 nearby 时：环境类工具明确报错（不编数据）', async () => {
  const h = await harness({ snapshot: { player: { prefab: 'wilson' }, world: { day: 1 } } })
  try {
    const result = await h.call('get_nearby_entities', {})
    assert.equal(result.isError, true)
    const data = result.structuredContent as Record<string, any>
    assert.equal(data.ok, false)
    assert.equal(data.error.code, 'NOT_IMPLEMENTED')
    assert.match(String(data.error.hint), /refresh_game_state/)
  } finally {
    await h.close()
  }
})

test('没有玩家时：get_player_status 报 GAME_DISCONNECTED 并给分片提示', async () => {
  const h = await harness({ snapshot: { world: { day: 1 }, inventory: { slots: 15, used: 0, items: [] } } })
  try {
    const result = await h.call('get_player_status')
    assert.equal(result.isError, true)
    const data = result.structuredContent as Record<string, any>
    assert.equal(data.error.code, 'GAME_DISCONNECTED')
    assert.match(String(data.error.hint), /shard/)
  } finally {
    await h.close()
  }
})

test('get_recent_events：还没实现，老实返回 NOT_IMPLEMENTED', async () => {
  const h = await harness()
  try {
    const result = await h.call('get_recent_events', {})
    assert.equal(result.isError, true)
    const data = result.structuredContent as Record<string, any>
    assert.equal(data.error.code, 'NOT_IMPLEMENTED')
    assert.match(String(data.error.hint), /get_player_status/)
  } finally {
    await h.close()
  }
})

test('get_command_result：格式校验 + 查不到时报错', async () => {
  const h = await harness({
    handler: (path) => {
      if (path === '/api/v1/commands') {
        return { status: 200, body: { success: true, commands: [{ id: 'cmd_1', type: 'ping', status: 'SUCCEEDED', deliveries: 1, execution_time: 0.001, result: { message: 'Pong from DST' }, late: false }] } }
      }
      return { status: 404, body: { success: false } }
    },
  })
  try {
    const bad = await h.call('get_command_result', { command_id: 'not_a_command_id' })
    assert.equal(bad.isError, true)
    assert.equal((bad.structuredContent as Record<string, any>).error.code, 'INVALID_ARGUMENT')

    const ok = await h.call('get_command_result', { command_id: 'cmd_1' })
    assert.equal(ok.isError, undefined)
    const data = ok.structuredContent as Record<string, any>
    assert.equal(data.command?.status, 'SUCCEEDED')
    assert.deepEqual(data.command.result, { message: 'Pong from DST' })

    const missing = await h.call('get_command_result', { command_id: 'cmd_nope' })
    assert.equal(missing.isError, true)
    assert.equal((missing.structuredContent as Record<string, any>).error.code, 'INVALID_ARGUMENT')
  } finally {
    await h.close()
  }
})

test('refresh_game_state：下发命令并等结果，成功后强制读新快照', async () => {
  const h = await harness({
    handler: (path) => {
      if (path === '/api/v1/commands/enqueue') {
        return { status: 200, body: { success: true, command: { id: 'cmd_r1', type: 'refresh_state', status: 'QUEUED' } } }
      }
      if (path === '/api/v1/commands') {
        return { status: 200, body: { success: true, commands: [{ id: 'cmd_r1', type: 'refresh_state', status: 'SUCCEEDED', deliveries: 1, execution_time: 0.02, result: { refreshed: true, tick: 200, nearby_returned: 12 } }] } }
      }
      if (path === '/api/v1/state') {
        return { status: 200, body: snapshotPayload() }
      }
      return { status: 404, body: { success: false } }
    },
  })
  try {
    const result = await h.call('refresh_game_state', { include_nearby: true })
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
    const data = result.structuredContent as Record<string, any>
    assert.equal(data.command?.status, 'SUCCEEDED')
    assert.equal(data.command?.result?.tick, 200)
    assert.match(textOf(result), /刷新完成/)
  } finally {
    await h.close()
  }
})

test('get_bridge_status：通道状态 + 快照新鲜度', async () => {
  const h = await harness()
  try {
    const result = await h.call('get_bridge_status', {})
    const data = result.structuredContent as Record<string, any>
    assert.equal(data.bridge.connected, true)
    assert.equal(data.session_count, 1)
    assert.equal(data.alive_session_count, 1)
    assert.equal(data.snapshot?.stale, false)
    assert.match(textOf(result), /Bridge 通道/)
  } finally {
    await h.close()
  }
})
