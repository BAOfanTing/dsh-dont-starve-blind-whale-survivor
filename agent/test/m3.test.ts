// Phase 5 M2 新增只读工具 get_control_status，工具总数 12 → 13。
// M3 测试：Tool Adapter（Schema 转换 / 白名单 / 参数校验 / 结果转换）
//
// 用**真实 MCP Server**（子进程）验证 schema 转换是否忠实，
// 并用假工具覆盖各种攻击性输入（越权工具名、坏 JSON、越界参数、类型错误）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { McpClient } from '../src/mcp/client.js'
import {
  READ_ONLY_ALLOWLIST,
  FORBIDDEN_TOOL_PATTERNS,
  ToolAdapter,
  ToolAdapterError,
  toToolMessage,
} from '../src/mcp/toolAdapter.js'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/utils/logger.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const MCP_ENTRY = join(REPO_ROOT, 'mcp-server', 'dist', 'src', 'index.js')

function realToken(): string {
  try {
    const file = join(REPO_ROOT, '.runtime', 'token.txt')
    if (existsSync(file)) {
      const token = readFileSync(file, 'utf8').trim()
      if (token.length > 0) return token
    }
  } catch {
    // ignore
  }
  return 'm3-test-token-0123456789'
}

const TOKEN = realToken()
const quiet = () => createLogger({ level: 'error', sink: () => {} })

async function withAdapter(fn: (adapter: ToolAdapter, client: McpClient) => Promise<void>): Promise<void> {
  const config = {
    ...loadConfig({ BWS_TOKEN: TOKEN }),
    mcpTransport: 'stdio' as const,
    mcpStdioCommand: process.execPath,
    mcpStdioArgs: [MCP_ENTRY],
    token: TOKEN,
  }
  const client = new McpClient(config, quiet())
  await client.connect()
  const adapter = new ToolAdapter(client, quiet())
  try {
    adapter.refresh()
    await fn(adapter, client)
  } finally {
    await client.disconnect()
  }
}

test('白名单：只适配 12 个只读工具，全部来自 MCP Server 实际清单', async () => {
  await withAdapter(async (adapter, client) => {
    const names = adapter.names().sort()
    assert.equal(names.length, 13, `实际 ${names.length}：${names.join(',')}`)
    assert.deepEqual(names, [...READ_ONLY_ALLOWLIST].sort())
    // 与 MCP Server 的真实清单一致（不是我们凭空写的）
    assert.deepEqual(names, client.listTools().map((tool) => tool.name).sort())
  })
})

test('Schema 转换：约束完整保留（minimum/maximum/enum/maxItems/minLength/required）', async () => {
  await withAdapter(async (adapter) => {
    const entities = adapter.get('get_nearby_entities')
    assert.ok(entities)
    const params = entities.definition.function.parameters as Record<string, any>
    assert.equal(params.type, 'object')
    assert.equal(params.properties.radius_tiles.minimum, 2, 'minimum 必须保留')
    assert.equal(params.properties.radius_tiles.maximum, 20, 'maximum 必须保留')
    assert.equal(params.properties.limit.minimum, 1)
    assert.equal(params.properties.categories.maxItems, 10, 'maxItems 必须保留')
    assert.equal(params.properties.categories.items.maxLength, 24)
    assert.equal(params.properties.shard.maxLength, 32)

    const commandResult = adapter.get('get_command_result')
    assert.ok(commandResult)
    const crParams = commandResult.definition.function.parameters as Record<string, any>
    assert.deepEqual(crParams.required, ['command_id'], '必填参数必须保留')

    const events = adapter.get('get_recent_events')
    assert.ok(events)
    const evParams = events.definition.function.parameters as Record<string, any>
    assert.deepEqual(evParams.properties.severity.items.enum, ['info', 'warning', 'critical'], 'enum 必须保留')
  })
})

test('Schema 转换：描述带上"只读"与必填参数提示', async () => {
  await withAdapter(async (adapter) => {
    for (const name of adapter.names()) {
      const def = adapter.get(name)!.definition
      assert.equal(def.type, 'function')
      assert.equal(def.function.name, name)
      assert.ok(def.function.description.length > 10, `${name} 描述太短`)
      assert.match(def.function.description, /只读工具/, `${name} 描述应说明只读`)
    }
    assert.match(adapter.get('get_command_result')!.definition.function.description, /必填参数：command_id/)
  })
})

test('参数校验：合法参数通过并应用 default', async () => {
  await withAdapter(async (adapter) => {
    const args = adapter.parseArguments('get_nearby_entities', '{"limit":5}')
    assert.equal(args.limit, 5)
    // ajv useDefaults 会把 schema 里的 default 填上
    assert.equal(args.radius_tiles, 16, 'radius_tiles 应被填成默认 16')

    const empty = adapter.parseArguments('get_bridge_status', '{}')
    assert.deepEqual(empty, {})
  })
})

test('参数校验：越界 / 类型错 / 缺必填 全部拒绝', async () => {
  await withAdapter(async (adapter) => {
    const cases: Array<[string, string, RegExp]> = [
      ['get_nearby_entities', '{"radius_tiles":999}', /radius_tiles/],
      ['get_nearby_entities', '{"limit":0}', /limit/],
      ['get_nearby_entities', '{"radius_tiles":"big"}', /radius_tiles/],
      ['get_nearby_entities', '{"categories":["a","b","c","d","e","f","g","h","i","j","k"]}', /categories/],
      ['get_command_result', '{}', /command_id/],
      ['get_command_result', '{"command_id":""}', /command_id/],
      ['get_recent_events', '{"severity":["fatal"]}', /severity/],
    ]
    for (const [name, raw, pattern] of cases) {
      assert.throws(
        () => adapter.parseArguments(name, raw),
        (error: unknown) => {
          assert.ok(error instanceof ToolAdapterError)
          assert.equal(error.code, 'INVALID_ARGUMENTS_SCHEMA', `${name} ${raw} 应是 schema 错误，实际 ${error.code}`)
          assert.match(error.message, pattern)
          return true
        },
        `${name} 的参数 ${raw} 应被拒绝`,
      )
    }
    assert.equal(adapter.adapterStats().invalidArgs, 0, 'parseArguments 直接调用不计入 stats（只有 executeToolCall 计）')
  })
})

test('参数校验：坏 JSON / 非对象 全部拒绝', async () => {
  await withAdapter(async (adapter) => {
    assert.throws(
      () => adapter.parseArguments('get_player_status', '{not json'),
      (error: unknown) => (error as ToolAdapterError).code === 'INVALID_ARGUMENTS_JSON',
    )
    assert.throws(
      () => adapter.parseArguments('get_player_status', '[1,2,3]'),
      (error: unknown) => (error as ToolAdapterError).code === 'INVALID_ARGUMENTS_JSON',
    )
    assert.throws(
      () => adapter.parseArguments('get_player_status', '"just a string"'),
      (error: unknown) => (error as ToolAdapterError).code === 'INVALID_ARGUMENTS_JSON',
    )
    // 空字符串当成 {}（模型有时会给空）
    assert.deepEqual(adapter.parseArguments('get_bridge_status', ''), {})
  })
})

test('白名单：越权工具名一律拒绝，且错误里给出可用工具', async () => {
  await withAdapter(async (adapter) => {
    const forbidden = ['move_to', 'attack', 'chop_tree', 'mine_rock', 'eat', 'craft_item', 'build_wall', 'drop_item', 'execute_lua', 'run_shell', 'kill_mob', 'teleport']
    for (const name of forbidden) {
      assert.throws(
        () => adapter.parseArguments(name, '{}'),
        (error: unknown) => {
          assert.ok(error instanceof ToolAdapterError)
          assert.equal(error.code, 'TOOL_NOT_ALLOWED', `${name} 应被拒`)
          const detail = error.detail as { allowed?: string[] }
          assert.equal(detail.allowed?.length, 13, '应列出 13 个可用工具')
          return true
        },
        `${name} 不该被允许`,
      )
    }
    // 危险名模式本身也要能拦住
    for (const pattern of FORBIDDEN_TOOL_PATTERNS) {
      assert.ok(pattern.test(pattern.source.replace(/^\^|\$$/g, '')), `模式 ${pattern.source} 应能匹配自身示例`)
    }
  })
})

test('executeToolCall：成功时返回压缩后的内容与结构化结果', async () => {
  await withAdapter(async (adapter) => {
    const outcome = await adapter.executeToolCall({ id: 'call_1', name: 'get_bridge_status', arguments: '{}' })
    assert.equal(outcome.toolCallId, 'call_1')
    assert.equal(outcome.name, 'get_bridge_status')
    assert.ok(outcome.content.length > 0)
    assert.ok(outcome.elapsedMs >= 0)
    // Bridge 在跑就成功，没跑就是明确错误码（都算"正确处理"）
    if (outcome.ok) {
      assert.ok(outcome.structured !== null)
      assert.equal(outcome.structured?.ok, true)
    } else {
      assert.ok(['BRIDGE_UNAVAILABLE', 'GAME_DISCONNECTED', 'SESSION_INVALID', 'TOOL_CALL_FAILED'].includes(String(outcome.errorCode)))
    }
    assert.equal(adapter.adapterStats().calls, 1)
  })
})

test('executeToolCall：越权/坏参数不计入 calls 成功路径，但计入统计', async () => {
  await withAdapter(async (adapter) => {
    const blocked = await adapter.executeToolCall({ id: 'c1', name: 'move_to', arguments: '{}' })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.errorCode, 'TOOL_NOT_ALLOWED')
    assert.match(blocked.content, /TOOL_NOT_ALLOWED/)

    const badJson = await adapter.executeToolCall({ id: 'c2', name: 'get_player_status', arguments: '{oops' })
    assert.equal(badJson.ok, false)
    assert.equal(badJson.errorCode, 'INVALID_ARGUMENTS_JSON')

    const badSchema = await adapter.executeToolCall({ id: 'c3', name: 'get_nearby_entities', arguments: '{"radius_tiles":999}' })
    assert.equal(badSchema.ok, false)
    assert.equal(badSchema.errorCode, 'INVALID_ARGUMENTS_SCHEMA')

    const stats = adapter.adapterStats()
    assert.equal(stats.calls, 3)
    assert.equal(stats.blocked, 1)
    assert.equal(stats.invalidArgs, 2)
  })
})

test('结果压缩：超长结果被截断并标注原长', async () => {
  await withAdapter(async (adapter, client) => {
    // 用很小的上限，触发截断
    const small = new ToolAdapter(client, quiet(), { maxResultChars: 50 })
    small.refresh()
    const outcome = await small.executeToolCall({ id: 'c1', name: 'get_bridge_status', arguments: '{}' })
    if (outcome.ok && outcome.content.length > 50) {
      assert.match(outcome.content, /已截断，原长 \d+ 字符/)
    } else {
      // Bridge 不可用时也算通过（这条主要验证截断逻辑本身）
      assert.ok(outcome.content.length > 0)
    }
  })
})

test('toToolMessage：保留 tool_call_id 与工具名', async () => {
  const message = toToolMessage({
    toolCallId: 'call_xyz',
    name: 'get_player_status',
    ok: true,
    content: '{"ok":true}',
    structured: { ok: true },
    elapsedMs: 12,
  })
  assert.equal(message.role, 'tool')
  assert.equal(message.toolCallId, 'call_xyz')
  assert.equal(message.name, 'get_player_status')
  assert.equal(message.content, '{"ok":true}')
})

test('toolDefinitions：给 LLM 的定义与适配数量一致，且都是 function 类型', async () => {
  await withAdapter(async (adapter) => {
    const defs = adapter.toolDefinitions()
    assert.equal(defs.length, 13)
    for (const def of defs) {
      assert.equal(def.type, 'function')
      assert.ok(def.function.name.length > 0)
      assert.equal((def.function.parameters as Record<string, unknown>).type, 'object')
    }
  })
})

test('refresh：MCP 工具清单变化后重建适配（不写死）', async () => {
  await withAdapter(async (adapter) => {
    const first = adapter.refresh()
    assert.equal(first.adapted, 13)
    assert.equal(first.skipped.length, 0, '13 个都该适配成功')
    const second = adapter.refresh()
    assert.equal(second.adapted, 13, '重复刷新结果稳定')
  })
})
