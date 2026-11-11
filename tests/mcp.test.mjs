// MCP 服务器：握手、工具列表、调工具（含 SSE 心跳）、设置接口、状态页
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GameBridge } from '../lib/bridge.js'
import { createMcpServer } from '../lib/mcp-server.js'
import { executeTool, toolList, BUNDLED_GUIDES } from '../lib/tools.js'
import { FakeGame, tempDir } from './helpers.mjs'

function settingsStub() {
  return {
    port: 0,
    gameDir: '',
    actionTimeoutMinutes: 1,
    freezeTime: false,
    idleSeconds: 8,
    extraInstructions: '先建家',
  }
}

async function makeServer(dir) {
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true, pollMs: 20 })
  let notes = ''
  const settings = settingsStub()
  const server = createMcpServer({
    log: () => {},
    bridge,
    settings: () => settings,
    toolList,
    instructions: () => '# 规则\n\n## 游戏常识\n\n攻略正文\n\n## 通过 MCP 玩的额外说明\n- 别的',
    executeTool: (name, args) => executeTool(name, args, {
      bridge,
      notes: { read: () => notes, write: (text) => { notes = text } },
      guides: BUNDLED_GUIDES,
      extraInstructions: settings.extraInstructions,
      actionTimeoutMs: 2000,
    }),
  })
  await server.start(0)
  return { server, bridge, url: server.url }
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const type = res.headers.get('content-type') ?? ''
  if (type.includes('text/event-stream')) {
    const text = await res.text()
    const data = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
    return JSON.parse(data)
  }
  return await res.json()
}

test('initialize 会返回工具能力和说明', async () => {
  const dir = tempDir()
  const { server, url } = await makeServer(dir)
  const body = await rpc(url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } })
  assert.equal(body.result.serverInfo.name, 'dst-whale-bridge')
  assert.equal(body.result.capabilities.tools.listChanged, false)
  assert.match(body.result.instructions, /游戏常识/)
  await server.stop()
})

test('tools/list 里有 get_state 和主要动作', async () => {
  const dir = tempDir()
  const { server, url } = await makeServer(dir)
  const body = await rpc(url, 'tools/list', {})
  const names = body.result.tools.map((tool) => tool.name)
  for (const want of ['get_state', 'get_guide', 'move_to', 'chop', 'mine', 'attack', 'eat', 'craft', 'build', 'sleep', 'say', 'stop']) {
    assert.ok(names.includes(want), `缺少工具 ${want}`)
  }
  assert.equal(names.length, toolList().length)
  await server.stop()
})

test('get_state 读不到游戏时给清楚的提示', async () => {
  const dir = tempDir()
  const { server, url } = await makeServer(dir)
  const body = await rpc(url, 'tools/call', { name: 'get_state', arguments: {} })
  assert.match(body.result.content[0].text, /连不上游戏/)
  await server.stop()
})

test('get_state 会带上笔记和额外要求', async () => {
  const dir = tempDir()
  const game = new FakeGame(dir).start()
  const { server, url } = await makeServer(dir)
  await rpc(url, 'tools/call', { name: 'update_notes', arguments: { notes: '家在建 (3,4)' } })
  const body = await rpc(url, 'tools/call', { name: 'get_state', arguments: {} })
  const text = body.result.content[0].text
  assert.match(text, /家在建 \(3,4\)/)
  assert.match(text, /先建家/)
  assert.match(text, /威尔逊/)
  game.stop()
  await server.stop()
})

test('动作会被转给游戏，结果原样返回（走 SSE）', async () => {
  const dir = tempDir()
  const game = new FakeGame(dir).start()
  game.handler = (cmd) => ({ ok: cmd.args.count === 3, text: `chop ${cmd.args.count}` })
  const { server, url } = await makeServer(dir)
  const ok = await rpc(url, 'tools/call', { name: 'chop', arguments: { count: 3 } })
  assert.equal(ok.result.content[0].text, 'chop 3')
  const bad = await rpc(url, 'tools/call', { name: 'chop', arguments: { count: 1 } })
  assert.match(bad.result.content[0].text, /^失败：/)
  game.stop()
  await server.stop()
})

test('没有这个工具会报错，不会把服务器搞挂', async () => {
  const dir = tempDir()
  const { server, url } = await makeServer(dir)
  const body = await rpc(url, 'tools/call', { name: 'fly', arguments: {} })
  assert.match(body.result.content[0].text, /没有这个工具/)
  const missing = await rpc(url, 'no/such/method', {})
  assert.equal(missing.error.code, -32601)
  await server.stop()
})

test('设置接口：GET 拿版本号，POST 推给游戏', async () => {
  const dir = tempDir()
  const { server, url } = await makeServer(dir)
  const base = url.replace('/mcp', '')
  const before = await (await fetch(`${base}/settings`)).json()
  assert.ok(before.revision)
  const res = await fetch(`${base}/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { freezeTime: true } }),
  })
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.match(body.message, /推送到游戏/)
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const pushed = JSON.parse(readFileSync(join(dir, 'whale_settings.json'), 'utf8'))
  assert.equal(pushed.freezeTime, true)
  await server.stop()
})

test('状态页会说明连没连上', async () => {
  const dir = tempDir()
  const { server, url } = await makeServer(dir)
  const text = await (await fetch(url.replace('/mcp', '/status'))).text()
  assert.match(text, /大肥鱼饿不死/)
  assert.match(text, /没连上/)
  await server.stop()
})

test('通知（没有 id）返回 202，不算请求', async () => {
  const dir = tempDir()
  const { server, url } = await makeServer(dir)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  assert.equal(res.status, 202)
  await server.stop()
})
