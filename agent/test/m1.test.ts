// M1 测试：MCP Client 连接、能力发现、错误处理
//
// 用**真实 MCP Server**（在测试内启动，端口 0）验证 HTTP；
// stdio 模式拉起真实子进程验证。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { McpClient, McpToolError } from '../src/mcp/client.js'
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
  return 'm1-test-token-0123456789'
}

const TOKEN = realToken()
const quietLogger = () => createLogger({ level: 'error', sink: () => {} })

/** 起一个真实 MCP Server 子进程（HTTP 模式），端口由我们指定 */
async function startMcpServerHttp(): Promise<{ url: string; close: () => Promise<void> }> {
  const { spawn } = await import('node:child_process')
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, [MCP_ENTRY], {
    env: { ...process.env, BWS_MCP_TRANSPORT: 'http', BWS_MCP_HOST: '127.0.0.1', BWS_MCP_PORT: String(port), BWS_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const url = `http://127.0.0.1:${port}`
  // 等 /healthz 起来（最多 10 秒）
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`)
      if (response.ok) {
        return {
          url,
          close: async () => {
            child.kill()
            await new Promise((resolve) => child.once('exit', resolve))
          },
        }
      }
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  child.kill()
  throw new Error('MCP Server 没能在 10 秒内启动：' + url)
}

test('HTTP：连接真实 MCP Server，自动发现工具/资源/提示词', async () => {
  const server = await startMcpServerHttp()
  const config = { ...loadConfig({ BWS_TOKEN: TOKEN, BWS_MCP_URL: server.url }), mcpTransport: 'http' as const, mcpHttpUrl: server.url, token: TOKEN }
  const client = new McpClient(config, quietLogger())
  try {
    const status = await client.connect()
    assert.equal(status.state, 'connected')
    assert.equal(status.server?.name, 'blind-whale-survivor')
    assert.match(String(status.server?.version), /^0\.3\.0-m\d+$/)
    assert.ok(status.server?.protocolVersion, '应协商出协议版本')
    assert.ok(status.toolCount > 0, '应发现工具')

    // 工具清单不写死：断言与 MCP Server 实际返回一致
    const tools = client.listTools()
    assert.equal(tools.length, 12, `实际 ${tools.length} 个：` + tools.map((tool) => tool.name).join(','))
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'get_base_status',
      'get_bridge_status',
      'get_command_result',
      'get_game_status',
      'get_inventory',
      'get_nearby_entities',
      'get_nearby_resources',
      'get_nearby_threats',
      'get_player_status',
      'get_recent_events',
      'get_world_status',
      'refresh_game_state',
    ])
    for (const tool of tools) {
      assert.equal(tool.readOnly, true, `${tool.name} 应只读`)
      assert.ok(tool.description.length > 0, `${tool.name} 应有描述`)
      assert.ok(tool.inputSchema, `${tool.name} 应有 inputSchema`)
      assert.ok(Array.isArray(tool.required), `${tool.name} 的 required 应是数组`)
    }

    // 必填参数要能正确提取
    const commandResult = tools.find((tool) => tool.name === 'get_command_result')
    assert.deepEqual(commandResult?.required, ['command_id'], 'get_command_result 的必填参数应是 command_id')

    assert.equal(client.listResources().length, 6)
    assert.equal(client.listPrompts().length, 4)

    const promptNames = client.listPrompts().map((prompt) => prompt.name).sort()
    assert.deepEqual(promptNames, ['night_preparation', 'resource_assessment', 'season_preparation', 'survival_report'])
  } finally {
    await client.disconnect()
    await server.close()
  }
})

test('HTTP：调用真实工具（get_bridge_status）', async () => {
  const server = await startMcpServerHttp()
  const config = { ...loadConfig({ BWS_TOKEN: TOKEN }), mcpTransport: 'http' as const, mcpHttpUrl: server.url, token: TOKEN }
  const client = new McpClient(config, quietLogger())
  try {
    await client.connect()
    const result = await client.callTool('get_bridge_status', {})
    assert.ok(result.text.length > 0, '应有文本输出')
    assert.ok(result.structuredContent !== null, '应有结构化输出')
    // 成功或明确失败（Bridge 没跑），但必须有 source/error
    if (result.isError) {
      const code = (result.structuredContent?.error as { code?: string } | undefined)?.code
      assert.ok(['BRIDGE_UNAVAILABLE', 'GAME_DISCONNECTED', 'SESSION_INVALID'].includes(String(code)))
    } else {
      assert.equal(result.structuredContent?.source, 'bridge')
    }
    assert.equal(client.status().toolCalls, 1)
  } finally {
    await client.disconnect()
    await server.close()
  }
})

test('HTTP：读取资源和提示词', async () => {
  const server = await startMcpServerHttp()
  const config = { ...loadConfig({ BWS_TOKEN: TOKEN }), mcpTransport: 'http' as const, mcpHttpUrl: server.url, token: TOKEN }
  const client = new McpClient(config, quietLogger())
  try {
    await client.connect()
    // dst://game/bridge 不依赖游戏是否在跑，但依赖 Bridge 在跑；
    // Bridge 没起时 MCP Server 会抛错 —— 那也是真实行为，两种都接受
    try {
      const resource = await client.readResource('dst://game/bridge')
      assert.equal(resource.uri, 'dst://game/bridge')
      const payload = JSON.parse(resource.text) as Record<string, unknown>
      assert.equal(payload.ok, true)
      assert.equal(payload.source, 'bridge')
    } catch (error) {
      assert.match(String((error as Error).message), /Bridge|bridge/, '错误应指向 Bridge 不可用')
    }

    // 提示词不依赖任何外部服务，必须成功
    const prompt = await client.getPrompt('survival_report', { focus: 'safety' })
    assert.ok(prompt.length > 100)
    assert.match(prompt, /safety/)
  } finally {
    await client.disconnect()
    await server.close()
  }
})

test('stdio：拉起真实子进程，能力与 HTTP 一致', async () => {
  assert.ok(existsSync(MCP_ENTRY), 'mcp-server 需要先 build：' + MCP_ENTRY)
  const config = {
    ...loadConfig({ BWS_TOKEN: TOKEN }),
    mcpTransport: 'stdio' as const,
    mcpStdioCommand: process.execPath,
    mcpStdioArgs: [MCP_ENTRY],
    token: TOKEN,
  }
  const client = new McpClient(config, quietLogger())
  try {
    const status = await client.connect()
    assert.equal(status.state, 'connected')
    assert.equal(status.transport, 'stdio')
    assert.equal(status.server?.name, 'blind-whale-survivor')
    assert.equal(client.listTools().length, 12)
    assert.equal(client.listResources().length, 6)
    assert.equal(client.listPrompts().length, 4)
  } finally {
    await client.disconnect()
  }
})

test('未连接时调用工具 → MCP_NOT_CONNECTED', async () => {
  const config = { ...loadConfig({ BWS_TOKEN: TOKEN }), mcpTransport: 'http' as const, mcpHttpUrl: 'http://127.0.0.1:9', token: TOKEN }
  const client = new McpClient(config, quietLogger())
  await assert.rejects(
    () => client.callTool('get_player_status', {}),
    (error: unknown) => {
      assert.ok(error instanceof McpToolError)
      assert.equal(error.code, 'MCP_NOT_CONNECTED')
      return true
    },
  )
  assert.equal(client.status().state, 'disconnected')
})

test('连接不存在的 Server → 状态变 error，带错误信息', async () => {
  const config = { ...loadConfig({ BWS_TOKEN: TOKEN }), mcpTransport: 'http' as const, mcpHttpUrl: 'http://127.0.0.1:9', token: TOKEN, connectTimeoutMs: 2000 }
  const client = new McpClient(config, quietLogger(), { connectTimeoutMs: 2000 })
  await assert.rejects(() => client.connect())
  const status = client.status()
  assert.equal(status.state, 'error')
  assert.ok(status.lastError && status.lastError.length > 0, '应记录错误')
  assert.ok(status.lastErrorAt !== null)
})

test('调用不存在的工具 → MCP_TOOL_NOT_FOUND，并列出可用工具', async () => {
  const server = await startMcpServerHttp()
  const config = { ...loadConfig({ BWS_TOKEN: TOKEN }), mcpTransport: 'http' as const, mcpHttpUrl: server.url, token: TOKEN }
  const client = new McpClient(config, quietLogger())
  try {
    await client.connect()
    await assert.rejects(
      () => client.callTool('move_to', { x: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof McpToolError)
        assert.equal(error.code, 'MCP_TOOL_NOT_FOUND')
        const detail = error.detail as { available?: string[] }
        assert.ok(Array.isArray(detail.available) && detail.available.length === 12, '应列出 12 个可用工具')
        return true
      },
    )
    assert.equal(client.status().toolFailures, 1)
  } finally {
    await client.disconnect()
    await server.close()
  }
})

test('token 缺失时 HTTP 连接直接报错（不静默失败）', async () => {
  const config = { ...loadConfig({ BWS_TOKEN: '' }), mcpTransport: 'http' as const, mcpHttpUrl: 'http://127.0.0.1:8790', token: '' }
  const client = new McpClient(config, quietLogger())
  await assert.rejects(
    () => client.connect(),
    (error: unknown) => {
      assert.ok(error instanceof McpToolError)
      assert.equal(error.code, 'MCP_NOT_CONNECTED')
      assert.match(String(error.message), /token/)
      return true
    },
  )
})

test('reconnect：断开后能重新连上并计数', async () => {
  const server = await startMcpServerHttp()
  const config = { ...loadConfig({ BWS_TOKEN: TOKEN }), mcpTransport: 'http' as const, mcpHttpUrl: server.url, token: TOKEN }
  const client = new McpClient(config, quietLogger())
  try {
    await client.connect()
    assert.equal(client.status().reconnects, 0)
    const status = await client.reconnect()
    assert.equal(status.state, 'connected')
    assert.equal(status.reconnects, 1)
    assert.equal(client.listTools().length, 12, '重连后工具清单仍完整')
  } finally {
    await client.disconnect()
    await server.close()
  }
})

test('refreshCatalog：Server 工具变化后能刷新（不写死列表）', async () => {
  const server = await startMcpServerHttp()
  const config = { ...loadConfig({ BWS_TOKEN: TOKEN }), mcpTransport: 'http' as const, mcpHttpUrl: server.url, token: TOKEN }
  const client = new McpClient(config, quietLogger())
  try {
    await client.connect()
    const before = client.listTools().length
    const after = await client.refreshCatalog()
    assert.equal(after.tools, before, '刷新后数量应一致')
    assert.equal(after.resources, 6)
    assert.equal(after.prompts, 4)
  } finally {
    await client.disconnect()
    await server.close()
  }
})
