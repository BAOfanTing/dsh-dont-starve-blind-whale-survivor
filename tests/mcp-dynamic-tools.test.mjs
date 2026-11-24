import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createMcpServer } from '../lib/mcp-server.js'
import { toolList, executeTool, normalizeExecutionMode } from '../lib/tools.js'

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

function postJson(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const body = JSON.stringify(data)
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) })
          } catch {
            resolve({ status: res.statusCode, headers: res.headers, text })
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

test('MCP-01 ~ MCP-04: SSE 连接、listChanged 声明、模式切换通知与 tools/list 动态拉取', async () => {
  let currentSettings = { executionMode: 'autopilot' }
  const mockBridge = {
    pushSettings: () => 1,
  }

  const port = await getFreePort()
  const mcp = createMcpServer({
    log: () => {},
    bridge: mockBridge,
    settings: () => currentSettings,
    executeTool: async (name, args) => `executed:${name}`,
    toolList: () => toolList(currentSettings.executionMode),
    instructions: () => 'test instructions',
  })

  mcp.setSettingsHandler((next) => {
    currentSettings = { ...currentSettings, ...next }
  })

  await mcp.start(port)

  try {
    // 1. Initialize
    const initRes = await postJson(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    })
    assert.equal(initRes.status, 200)
    assert.equal(initRes.body.result.capabilities.tools.listChanged, true, 'MCP 必须声明 listChanged: true')

    // 2. 初始 autopilot 模式下的 tools/list
    const listRes1 = await postJson(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    })
    const toolNames1 = listRes1.body.result.tools.map((t) => t.name)
    assert.ok(toolNames1.includes('advance_task'), 'autopilot 暴露 advance_task')
    assert.ok(!toolNames1.includes('chop'), 'autopilot 不暴露原子动作 chop（只给高层接口）')
    assert.ok(!toolNames1.includes('run_skill'), 'autopilot 不暴露 run_skill')
    assert.deepEqual(toolNames1.slice().sort(), ['advance_task', 'get_guide', 'get_state', 'stop', 'update_notes'],
      'autopilot 工具集 = 高层接口白名单')

    // 3. 建立 SSE 连接
    const sseEvents = []
    let sseResolve
    const sseEventReceived = new Promise((r) => { sseResolve = r })

    const sseReq = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'GET',
      },
      (res) => {
        res.on('data', (chunk) => {
          const str = chunk.toString()
          sseEvents.push(str)
          if (str.includes('notifications/tools/list_changed')) {
            sseResolve(str)
          }
        })
      }
    )
    sseReq.end()

    // 等待 SSE 连接建立
    await new Promise((r) => setTimeout(r, 50))

    // 4. 调用 /settings 切换为 manual 模式
    const setRes = await postJson(`http://127.0.0.1:${port}/settings`, {
      settings: { executionMode: 'manual' },
    })
    assert.equal(setRes.status, 200)

    // 5. 验证 SSE 收到 notifications/tools/list_changed 通知
    const received = await Promise.race([
      sseEventReceived,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSE 通知等待超时')), 2000)),
    ])
    assert.ok(received.includes('notifications/tools/list_changed'), '服务端必须向 SSE 发送 list_changed 通知')

    // 6. 客户端重新拉取 tools/list
    const listRes2 = await postJson(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    })
    const toolNames2 = listRes2.body.result.tools.map((t) => t.name)
    assert.ok(toolNames2.includes('advance_task'), 'manual 也包含 advance_task（三模式统一工具集）')
    assert.ok(toolNames2.includes('chop'), 'manual 暴露底层动作 chop')
    assert.ok(toolNames2.includes('run_skill'), 'manual 暴露 run_skill')

    sseReq.destroy()
  } finally {
    await mcp.stop()
  }
})

test('MCP-05: Autopilot 直调原子动作被拒；Assisted/Manual 不按模式拦截（R8.4）', async () => {
  const REJECT = 'Autopilot 模式下不允许模型直接调用原子动作，请使用 advance_task 推进当前 Task Board 任务。'
  const call = async (name, args, mode) => {
    try { return String(await executeTool(name, args, { executionMode: mode, log: () => {} })) }
    catch (e) { return 'THREW:' + String(e?.message ?? e) }
  }
  // autopilot 调 chop：进入 dispatcher 之前就被固定文案拒绝
  assert.equal(await call('chop', { target_ref: '#1', snapshot_id: 's1' }, 'autopilot'), REJECT)
  // manual 调 advance_task：不按模式拦截
  assert.ok(!(await call('advance_task', {}, 'manual')).includes('不允许模型直接调用原子动作'))
})

test('MCP-06: SSE 客户端断开后安全注销，防止内存泄漏', async () => {
  const port = await getFreePort()
  const mcp = createMcpServer({
    log: () => {},
    bridge: { pushSettings: () => 1 },
    settings: () => ({ executionMode: 'autopilot' }),
    executeTool: async () => 'ok',
    toolList: () => [],
    instructions: () => '',
  })
  await mcp.start(port)

  try {
    const sseReq = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'GET' })
    sseReq.end()
    await new Promise((r) => setTimeout(r, 50))

    // 主动断开
    sseReq.destroy()
    await new Promise((r) => setTimeout(r, 50))

    // 再次触发通知，不应崩溃
    assert.doesNotThrow(() => {
      mcp.notifyListChanged()
    })
  } finally {
    await mcp.stop()
  }
})
