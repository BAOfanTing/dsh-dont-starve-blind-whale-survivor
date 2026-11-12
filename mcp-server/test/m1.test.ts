// M1 验收测试：真实 stdio 子进程 + 真实 JSON-RPC 握手
//
// 覆盖：
//   1. initialize 握手（协议版本协商、serverInfo）
//   2. notifications/initialized 之后 tools/list 能列出全部 12 个工具
//   3. tools/call：get_bridge_status 真的打到 Game Bridge（真实 HTTP）
//   4. tools/call：未实现的工具返回 NOT_IMPLEMENTED（不编数据）
//   5. stdout 只有 JSON-RPC（日志必须都在 stderr）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, '..', 'src', 'index.js')

interface Harness {
  child: ChildProcessWithoutNullStreams
  stderr: () => string
  stdoutLines: () => string[]
  request: (id: number, method: string, params?: unknown) => Promise<Record<string, any>>
  notify: (method: string, params?: unknown) => void
  close: () => Promise<void>
}

function startServer(env: Record<string, string> = {}): Harness {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, ...env, BWS_MCP_TRANSPORT: 'stdio' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams

  let stderrText = ''
  const outLines: string[] = []
  const waiters = new Map<number, (value: Record<string, any>) => void>()
  let buffer = ''

  child.stderr.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString('utf8')
  })
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length > 0) {
        outLines.push(line)
        try {
          const message = JSON.parse(line) as Record<string, any>
          if (typeof message.id === 'number' && waiters.has(message.id)) {
            waiters.get(message.id)?.(message)
            waiters.delete(message.id)
          }
        } catch {
          // 非 JSON 行会被单独断言出来（说明 stdout 被污染了）
        }
      }
      index = buffer.indexOf('\n')
    }
  })

  const send = (payload: unknown) => {
    child.stdin.write(JSON.stringify(payload) + '\n')
  }

  return {
    child,
    stderr: () => stderrText,
    stdoutLines: () => [...outLines],
    notify: (method, params) => send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }),
    request: (id, method, params) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`请求 ${method} 超时（10 秒）`)), 10000)
        waiters.set(id, (value) => {
          clearTimeout(timer)
          resolve(value)
        })
        send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
      }),
    close: async () => {
      child.stdin.end()
      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

test('initialize 握手 + tools/list 列出全部工具', async () => {
  const h = startServer()
  try {
    const init = await h.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      clientInfo: { name: 'm1-test-client', version: '1.0.0' },
    })
    assert.ok(init.result, 'initialize 必须有 result：' + JSON.stringify(init))
    assert.ok(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'].includes(init.result.protocolVersion))
    assert.equal(init.result.serverInfo.name, 'blind-whale-survivor')
    assert.match(String(init.result.serverInfo.version), /^0\.3\.0-m\d+$/)
    assert.ok(init.result.capabilities.tools, '必须声明 tools 能力')

    h.notify('notifications/initialized')
    const list = await h.request(2, 'tools/list')
    assert.ok(Array.isArray(list.result.tools))
    assert.equal(list.result.tools.length, 12, '应注册 12 个工具，实际 ' + list.result.tools.length)

    const names = list.result.tools.map((t: { name: string }) => t.name).sort()
    assert.deepEqual(names, [
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
    for (const tool of list.result.tools) {
      assert.ok(tool.description && tool.description.length > 4, `${tool.name} 缺描述`)
      assert.ok(tool.inputSchema, `${tool.name} 缺 inputSchema`)
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} 必须标成只读`)
    }
  } finally {
    await h.close()
  }
})

test('tools/call：M1 阶段曾用 NOT_IMPLEMENTED 占位，现在 12 个工具全部已实现', async () => {
  const h = startServer()
  try {
    await h.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'm1-test', version: '1' },
    })
    h.notify('notifications/initialized')

    // 12 个工具都实现了：随便挑一个真跑，不应再返回 NOT_IMPLEMENTED
    const call = await h.request(2, 'tools/call', { name: 'get_recent_events', arguments: {} })
    const structured = call.result.structuredContent as Record<string, any>
    const code = structured.error?.code
    assert.notEqual(code, 'NOT_IMPLEMENTED', '12 个工具已全部实现，不应再有 NOT_IMPLEMENTED')
    // 允许成功，也允许因 Bridge/游戏不可用而失败 —— 但错误码必须是真实原因
    if (call.result.isError) {
      assert.ok(['GAME_DISCONNECTED', 'BRIDGE_UNAVAILABLE', 'STATE_STALE'].includes(String(code)), '错误码应是真实原因：' + String(code))
    } else {
      assert.equal(structured.ok, true)
      assert.ok(Array.isArray(structured.events))
    }
  } finally {
    await h.close()
  }
})

test('tools/call：get_bridge_status 打到真实 Bridge（或如实报 BRIDGE_UNAVAILABLE）', async () => {
  const h = startServer()
  try {
    await h.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'm1-test', version: '1' },
    })
    h.notify('notifications/initialized')

    const call = await h.request(2, 'tools/call', { name: 'get_bridge_status', arguments: {} })
    const structured = call.result.structuredContent as Record<string, any>
    if (call.result.isError) {
      // Bridge 没起时必须是 BRIDGE_UNAVAILABLE，而不是瞎编一个状态
      assert.equal(structured.error.code, 'BRIDGE_UNAVAILABLE')
      assert.match(String(structured.error.hint ?? ''), /health/)
    } else {
      assert.equal(structured.ok, true)
      assert.equal(structured.source, 'bridge')
      assert.ok(structured.bridge.url === undefined || typeof structured.bridge_url === 'string')
      assert.ok(typeof structured.bridge.connected === 'boolean')
      assert.ok(Array.isArray(structured.sessions))
      assert.ok(typeof call.result.content[0].text === 'string')
      assert.match(call.result.content[0].text, /Bridge 通道/)
    }
  } finally {
    await h.close()
  }
})

test('stdout 只有 JSON-RPC：日志全部在 stderr', async () => {
  const h = startServer()
  try {
    await h.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'm1-test', version: '1' },
    })
    h.notify('notifications/initialized')
    await h.request(2, 'tools/list')

    for (const line of h.stdoutLines()) {
      assert.doesNotThrow(() => JSON.parse(line), 'stdout 出现非 JSON 行：' + line)
    }
    assert.match(h.stderr(), /已注册/, 'stderr 应该有日志')
    assert.match(h.stderr(), /stdio 传输已就绪/)
  } finally {
    await h.close()
  }
})

test('未知工具 → isError；参数越界由 SDK 依据 inputSchema 拦下', async () => {
  const h = startServer()
  try {
    await h.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'm1-test', version: '1' },
    })
    h.notify('notifications/initialized')

    // 1) 未知工具：SDK 报错
    const unknown = await h.request(2, 'tools/call', { name: 'not_a_tool', arguments: {} })
    assert.ok(unknown.error !== undefined || unknown.result?.isError === true, '未知工具必须报错：' + JSON.stringify(unknown))

    // 2) 参数越界：SDK 依据我们提供的 inputSchema 在进入 handler 前就拦下了
    //    注意（实测差异）：SDK 返回的是标准 isError + 文本，**不带 structuredContent**；
    //    结构化错误码用于“业务层校验”（M3 接真实数据后出现，例如半径超过 Bridge 扫描上限）。
    const badArgs = await h.request(3, 'tools/call', {
      name: 'get_nearby_entities',
      arguments: { radius_tiles: 999, limit: 0 },
    })
    assert.equal(badArgs.result?.isError, true, '越界参数必须是错误结果：' + JSON.stringify(badArgs))
    const text = String(badArgs.result?.content?.[0]?.text ?? '')
    assert.match(text, /validation error/i)
    assert.match(text, /radius_tiles/)
    assert.match(text, /limit/)
  } finally {
    await h.close()
  }
})
