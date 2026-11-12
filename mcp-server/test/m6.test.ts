// Phase 5 M2 新增 get_control_status（只读），工具总数 12 → 13。
// M6 集成测试：用**官方 MCP Client**（不是手写 JSON-RPC）连真实服务器
//
// 覆盖：
//   1. stdio 传输：握手、能力发现、12 个工具全调一遍、6 个资源、4 个提示词
//   2. Streamable HTTP 传输：同样一套，验证双传输一致
//   3. Bridge 离线时的错误码（不编数据）
//   4. 并发调用（多个工具同时打）
//   5. 参数校验与只读约束
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createGameToolService } from '../src/server/createServer.js'
import { createHttpTransport } from '../src/transports/http.js'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/utils/logger.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, '..', 'src', 'index.js')

/** 读真实 token（与 Bridge/游戏端共用）；没有就退回测试用 token */
function realToken(): string {
  try {
    const token = readFileSync(join(HERE, '..', '..', '..', '.runtime', 'token.txt'), 'utf8').trim()
    if (token.length > 0) return token
  } catch {
    // ignore
  }
  return 'm6-test-token-0123456789'
}

const TOKEN = realToken()

const EXPECTED_TOOLS = [
  
    'build_campfire',
    'build_structure',
    'chop_tree',
    'craft_item',
    'eat_item',
    'equip_item',
    'gather_resource',
    'get_base_status',
    'get_bridge_status',
    'get_command_result',
    'get_control_status',
    'get_game_status',
    'get_inventory',
    'get_nearby_entities',
    'get_nearby_resources',
    'get_nearby_threats',
    'get_player_status',
    'get_recent_events',
    'get_world_status',
    'mine_rock',
    'move_to_target',
    'pick_up_item',
    'probe_game_actions',
    'refresh_game_state',
  ]

async function connectStdio(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: { ...process.env, BWS_MCP_TRANSPORT: 'stdio', BWS_TOKEN: TOKEN } as Record<string, string>,
  })
  const client = new Client({ name: 'm6-integration-client', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

interface HttpHarness {
  base: string
  close: () => Promise<void>
}

async function startHttpServer(): Promise<HttpHarness> {
  const config = { ...loadConfig({ BWS_TOKEN: TOKEN }), token: TOKEN }
  const logger = createLogger({ sink: () => {} })
  const service = createGameToolService(config, logger)
  const transport = createHttpTransport(service, config, logger, { host: '127.0.0.1', port: 0, token: TOKEN })
  const port = await transport.listen()
  return { base: `http://127.0.0.1:${port}`, close: () => transport.close() }
}

async function connectHttp(base: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(base), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  })
  const client = new Client({ name: 'm6-http-client', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

/** 调一个工具并返回 structuredContent（失败时返回 error payload） */
async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }
  return {
    isError: result.isError === true,
    text: String(result.content?.[0]?.text ?? ''),
    structured: result.structuredContent ?? {},
  }
}

test('stdio：官方 Client 握手 + 能力发现', async () => {
  const client = await connectStdio()
  try {
    assert.equal(client.getServerVersion()?.name, 'blind-whale-survivor')
    assert.match(String(client.getServerVersion()?.version), /^0\.3\.0-m\d+$/)
    assert.ok(client.getServerCapabilities()?.tools, '应声明 tools 能力')

    const { tools } = await client.listTools()
    assert.equal(tools.length, 24)
    assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS)
    // Phase 5 M3：2 个写动作工具显式标 false，其余只读
    const WRITE_TOOLS = new Set(['gather_resource', 'move_to_target', 'equip_item', 'chop_tree', 'mine_rock', 'pick_up_item', 'eat_item', 'craft_item', 'build_structure', 'build_campfire'])
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 4, `${tool.name} 缺描述`)
      assert.ok(tool.inputSchema, `${tool.name} 缺 inputSchema`)
      assert.equal(tool.annotations?.readOnlyHint, !WRITE_TOOLS.has(tool.name), `${tool.name} readOnlyHint 不对`)
    }
  } finally {
    await client.close()
  }
})

test('stdio：6 个资源 + 4 个提示词', async () => {
  const client = await connectStdio()
  try {
    const { resources } = await client.listResources()
    assert.equal(resources.length, 6)
    assert.deepEqual(
      resources.map((resource) => resource.uri).sort(),
      ['dst://game/bridge', 'dst://game/inventory', 'dst://game/nearby', 'dst://game/player', 'dst://game/status', 'dst://game/world'],
    )

    const { prompts } = await client.listPrompts()
    assert.equal(prompts.length, 4)
    assert.deepEqual(
      prompts.map((prompt) => prompt.name).sort(),
      ['night_preparation', 'resource_assessment', 'season_preparation', 'survival_report'],
    )
  } finally {
    await client.close()
  }
})

test('stdio：20 个工具全部可调用，且都不返回 NOT_IMPLEMENTED', async () => {
  const client = await connectStdio()
  try {
    const results: Array<{ name: string; isError: boolean; code?: string; text: string }> = []
    for (const name of EXPECTED_TOOLS) {
      const args =
        name === 'get_command_result' ? { command_id: 'cmd_nonexistent_1' }
          : name === 'gather_resource' ? { resource: 'twigs', count: 1 }
            : name === 'move_to_target' ? { resource: 'grass' }
              : name === 'equip_item' ? { item: 'axe' }
                : name === 'chop_tree' ? { confirmed: true }
                  : name === 'mine_rock' ? { confirmed: true }
                    : name === 'pick_up_item' ? { item: 'twigs' }
                    : name === 'eat_item' ? { confirmed: true }
                      : name === 'craft_item' ? { recipe: 'axe', confirmed: true }
                        : name === 'build_structure' ? { recipe: 'campfire', confirmed: true }
                          : name === 'build_campfire' ? { confirmed: true }
                            : {}
      const result = await callTool(client, name, args)
      const code = (result.structured.error as { code?: string } | undefined)?.code
      results.push({ name, isError: result.isError, code, text: result.text })
    }

    // 不允许任何工具再返回 NOT_IMPLEMENTED（20 个都实现了）
    for (const result of results) {
      assert.notEqual(result.code, 'NOT_IMPLEMENTED', `${result.name} 不该再是 NOT_IMPLEMENTED`)
      assert.ok(result.text.length > 0, `${result.name} 应返回文本内容`)
    }

    // 写动作工具在无控制权时应返回 SESSION_INVALID（程序层拒绝，不是崩溃）
    const allowedErrors = ['GAME_DISCONNECTED', 'BRIDGE_UNAVAILABLE', 'STATE_STALE', 'SESSION_INVALID', 'INVALID_ARGUMENT', 'TOOL_TIMEOUT']
    for (const result of results.filter((item) => item.isError)) {
      assert.ok(allowedErrors.includes(String(result.code)), `${result.name} 错误码异常：${String(result.code)}`)
    }

    // 至少有一个工具真的成功（Bridge 在跑的话）
    const succeeded = results.filter((item) => !item.isError)
    assert.ok(succeeded.length > 0, '至少应有一个工具成功：' + JSON.stringify(results.map((r) => [r.name, r.code])))
  } finally {
    await client.close()
  }
})

test('stdio：真实游戏数据（玩家/背包/世界/附近）', async () => {
  const client = await connectStdio()
  try {
    const status = await callTool(client, 'get_game_status')
    if (status.isError) {
      // 游戏没连上：必须是 GAME_DISCONNECTED，且不能编数据
      assert.equal((status.structured.error as { code?: string })?.code, 'GAME_DISCONNECTED')
      return
    }
    const freshness = status.structured.freshness as Record<string, unknown>
    assert.equal(typeof freshness.stale, 'boolean')
    assert.equal(typeof freshness.age_ms, 'number')
    assert.match(status.text, freshness.stale === true ? /数据已过期/ : /数据新鲜/)

    const player = await callTool(client, 'get_player_status')
    if (!player.isError) {
      const data = player.structured.player as Record<string, unknown>
      assert.ok(data, '应有 player 数据')
      assert.ok(['wilson', 'willow', 'wx78', 'wickerbottom', 'wolfgang', 'wendy', 'wx-78'].includes(String(data.prefab).toLowerCase()) || typeof data.prefab === 'string')
      const health = data.health as Record<string, unknown>
      assert.equal(typeof health.percent, 'number', '生命百分比应是数字')
      assert.ok(Number(health.percent) >= 0 && Number(health.percent) <= 100)
    }

    const world = await callTool(client, 'get_world_status')
    if (!world.isError) {
      const data = world.structured.world as Record<string, unknown>
      assert.ok(Number(data.day) >= 1, '天数应 ≥1')
      assert.ok(['day', 'dusk', 'night'].includes(String(data.phase)), 'phase 应是 day/dusk/night')
      assert.ok(['autumn', 'winter', 'spring', 'summer'].includes(String(data.season)))
    }

    const nearby = await callTool(client, 'get_nearby_entities', { limit: 5 })
    if (!nearby.isError) {
      const entities = nearby.structured.entities as Array<Record<string, unknown>>
      assert.ok(Array.isArray(entities))
      assert.ok(entities.length <= 5, 'limit 应生效')
      // 按距离排序
      const distances = entities.map((entity) => Number(entity.distance)).filter((value) => Number.isFinite(value))
      for (let i = 1; i < distances.length; i += 1) {
        assert.ok(distances[i]! >= distances[i - 1]!, '实体应按距离升序')
      }
    }
  } finally {
    await client.close()
  }
})

test('stdio：资源可读，且带新鲜度', async () => {
  const client = await connectStdio()
  try {
    const bridge = await client.readResource({ uri: 'dst://game/bridge' })
    const bridgeText = String((bridge.contents[0] as { text?: string })?.text ?? '')
    const bridgePayload = JSON.parse(bridgeText) as Record<string, unknown>
    assert.equal(bridgePayload.ok, true)
    assert.equal(bridgePayload.source, 'bridge')

    const player = await client.readResource({ uri: 'dst://game/player' })
    const playerText = String((player.contents[0] as { text?: string })?.text ?? '')
    const playerPayload = JSON.parse(playerText) as Record<string, unknown>
    // 有快照就带 freshness；没快照就是 GAME_DISCONNECTED
    if (playerPayload.ok === true) {
      assert.ok(playerPayload.freshness, '资源必须带 freshness')
    } else {
      assert.equal((playerPayload.error as { code?: string })?.code, 'GAME_DISCONNECTED')
    }
  } finally {
    await client.close()
  }
})

test('stdio：4 个提示词都能取，且都禁止写操作', async () => {
  const client = await connectStdio()
  try {
    for (const name of ['survival_report', 'resource_assessment', 'night_preparation', 'season_preparation']) {
      const result = await client.getPrompt({ name, arguments: {} })
      const text = String((result.messages[0]?.content as { text?: string })?.text ?? '')
      assert.ok(text.length > 100, `${name} 内容太短`)
      assert.match(text, /不能执行任何游戏动作/, `${name} 必须写明禁止写操作`)
      assert.match(text, /freshness\.stale/, `${name} 必须要求检查数据新鲜度`)
    }
  } finally {
    await client.close()
  }
})

test('stdio：参数校验 —— 越界参数被拒', async () => {
  const client = await connectStdio()
  try {
    // 半径超上限（schema 限制 2~20）
    const bad = await callTool(client, 'get_nearby_entities', { radius_tiles: 999 })
    assert.equal(bad.isError, true, '越界参数必须报错')
    assert.match(bad.text, /validation|radius_tiles/i)

    // 合法参数应通过校验
    const good = await callTool(client, 'get_nearby_entities', { radius_tiles: 8, limit: 3 })
    if (!good.isError) {
      assert.ok((good.structured.entities as unknown[]).length <= 3)
    }
  } finally {
    await client.close()
  }
})

test('stdio：并发调用 6 个工具（不串数据）', async () => {
  const client = await connectStdio()
  try {
    const names = ['get_player_status', 'get_world_status', 'get_inventory', 'get_bridge_status', 'get_nearby_entities', 'get_recent_events']
    const results = await Promise.all(names.map((name) => callTool(client, name, {})))
    assert.equal(results.length, 6)
    for (let i = 0; i < names.length; i += 1) {
      const result = results[i]!
      assert.ok(result.text.length > 0, `${names[i]} 应有文本`)
      // 每个工具的结构化输出形状要对（不串）
      if (names[i] === 'get_bridge_status' && !result.isError) {
        assert.equal(result.structured.source, 'bridge')
      }
      if (names[i] === 'get_recent_events' && !result.isError) {
        assert.ok(Array.isArray(result.structured.events))
      }
    }
  } finally {
    await client.close()
  }
})

test('HTTP：官方 Client 走 Streamable HTTP，能力与 stdio 一致', async () => {
  const h = await startHttpServer()
  const client = await connectHttp(h.base)
  try {
    const { tools } = await client.listTools()
    assert.equal(tools.length, 24)
    assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS)

    const { resources } = await client.listResources()
    assert.equal(resources.length, 6)

    const { prompts } = await client.listPrompts()
    assert.equal(prompts.length, 4)
  } finally {
    await client.close()
    await h.close()
  }
})

test('HTTP：工具调用结果与 stdio 一致（同一时刻对比）', async () => {
  const h = await startHttpServer()
  const httpClient = await connectHttp(h.base)
  const stdioClient = await connectStdio()
  try {
    const [viaHttp, viaStdio] = await Promise.all([
      callTool(httpClient, 'get_player_status'),
      callTool(stdioClient, 'get_player_status'),
    ])

    if (viaHttp.isError || viaStdio.isError) {
      // 游戏没连上时两者都应报同类错误
      const codeHttp = (viaHttp.structured.error as { code?: string })?.code
      const codeStdio = (viaStdio.structured.error as { code?: string })?.code
      assert.equal(codeHttp, codeStdio, '两种传输的错误码应一致')
      return
    }

    const playerHttp = viaHttp.structured.player as Record<string, unknown>
    const playerStdio = viaStdio.structured.player as Record<string, unknown>
    assert.equal(playerHttp.prefab, playerStdio.prefab, '玩家应相同')
    assert.deepEqual(playerHttp.tile, playerStdio.tile, '坐标应相同')
    assert.equal((playerHttp.health as Record<string, unknown>).percent, (playerStdio.health as Record<string, unknown>).percent)

    // 新鲜度字段两边都要有
    assert.ok(viaHttp.structured.freshness)
    assert.ok(viaStdio.structured.freshness)
  } finally {
    await stdioClient.close()
    await httpClient.close()
    await h.close()
  }
})

test('HTTP：多会话并发（两个客户端各自独立）', async () => {
  const h = await startHttpServer()
  const a = await connectHttp(h.base)
  const b = await connectHttp(h.base)
  try {
    const [ra, rb] = await Promise.all([callTool(a, 'get_bridge_status'), callTool(b, 'get_bridge_status')])
    for (const result of [ra, rb]) {
      assert.ok(result.text.length > 0)
      if (!result.isError) assert.equal(result.structured.source, 'bridge')
    }
    // 两个客户端都能独立发现工具
    const [la, lb] = await Promise.all([a.listTools(), b.listTools()])
    assert.equal(la.tools.length, 24)
    assert.equal(lb.tools.length, 24)
  } finally {
    await a.close()
    await b.close()
    await h.close()
  }
})

test('Bridge 离线：工具返回明确错误码，不编造数据', async () => {
  // 起一个指向"肯定没人监听"端口的服务
  const config = { ...loadConfig({ BWS_TOKEN: TOKEN }), token: TOKEN, bridgeUrl: 'http://127.0.0.1:9' }
  const logger = createLogger({ sink: () => {} })
  const service = createGameToolService(config, logger)
  const transport = createHttpTransport(service, config, logger, { host: '127.0.0.1', port: 0, token: TOKEN })
  const port = await transport.listen()
  const client = await connectHttp(`http://127.0.0.1:${port}`)
  try {
    const result = await callTool(client, 'get_player_status')
    assert.equal(result.isError, true, 'Bridge 不可用时必须报错')
    const code = (result.structured.error as { code?: string })?.code
    assert.equal(code, 'BRIDGE_UNAVAILABLE', '应是 BRIDGE_UNAVAILABLE，实际：' + String(code))
    const hint = String((result.structured.error as { hint?: string })?.hint ?? '')
    assert.match(hint, /health/, '应给出排查建议')
    // 绝不能出现编造的数据字段
    assert.equal(result.structured.player, undefined, '不许编造玩家数据')
  } finally {
    await client.close()
    await transport.close()
  }
})
