// MCP 服务器：握手、工具列表、调工具（含 SSE 心跳）、设置接口、状态页
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GameBridge, stripKleiHeader } from '../lib/bridge.js'
import { createMcpServer } from '../lib/mcp-server.js'
import { executeTool, toolList, BUNDLED_GUIDES } from '../lib/tools.js'
import { join } from 'node:path'
import { FakeGame, tempDir } from './helpers.mjs'
import { LeaseManager } from '../lib/control.js'
import { readSnapshot } from '../lib/tools.js'

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

async function makeServer(dir, { owner = 'mcp_client' } = {}) {
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true, pollMs: 20 })
  const control = new LeaseManager({ file: join(dir, 'm2-control.json'), now: () => Date.now() })
  // M2.0：动作必须有租约。先用当前快照的环境指纹拿一次。
  const env = (() => {
    const s = readSnapshot({ bridge })
    return {
      runtimeId: s?.nearby?.runtime_id ?? null,
      sessionId: s?.identity?.sessionId ?? null,
      shardId: s?.identity?.shardId ?? null,
      actorId: s?.actor?.actorId ?? null,
    }
  })()
  control.acquire(owner, env, { ownerInstanceId: 'mcp-test-instance' })
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
      control,
      owner,
      ownerInstanceId: 'mcp-test-instance',
      notes: { read: () => notes, write: (text) => { notes = text } },
      guides: BUNDLED_GUIDES,
      extraInstructions: settings.extraInstructions,
      actionTimeoutMs: 2000,
    }),
  })
  await server.start(0)
  return { server, bridge, control, owner, url: server.url }
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

test('tools/list 只暴露 3 个本地工具 + 8 个白名单动作，且名字唯一', async () => {
  const dir = tempDir()
  const { server, url } = await makeServer(dir)
  const body = await rpc(url, 'tools/list', {})
  const names = body.result.tools.map((tool) => tool.name)
  // SURVIVAL-01：新增 gather / eat / craft / equip（7 → 11）
  for (const want of ['get_state', 'get_guide', 'update_notes', 'move_to', 'stop', 'pickup', 'harvest',
    'gather', 'eat', 'craft', 'equip', 'gather_area', 'seek',
    'chop', 'mine', 'dig', 'hammer', 'attack', 'kill', 'wait', 'drop',
    'unequip', 'say', 'fuel', 'use', 'inspect',
    'container_take', 'container_put', 'give', 'cook',
    'build', 'recipes', 'lookup', 'probe']) {
    assert.ok(names.includes(want), `缺少工具 ${want}`)
  }
  assert.equal(names.length, toolList().length)
  assert.equal(names.length, 34, '模型可见工具应该是 34 个（SURVIVAL-06 加了 build/recipes/lookup/probe）')
  assert.equal(new Set(names).size, names.length, '工具名不能重复（M2.2.1 修过 pickup/harvest 重复注册）')
  // 未开放的动作不再出现在工具表里（模型只看见 dispatcher 白名单里的动作）
  for (const gone of ['pick', 'act', 'heal', 'night_watch', 'store']) {
    assert.ok(!names.includes(gone), `${gone} 没开放，不该出现在工具表里`)
  }
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

test('动作会被转给游戏，结果原样返回（走 SSE）；未开放的动作直接拒绝', async () => {
  const dir = tempDir()
  const game = new FakeGame(dir).start()
  game.modern = true
  game.writeModernState()
  game.handler = (cmd) => ({ ok: true, text: `停了（${cmd.action}）` })
  const { server, url } = await makeServer(dir)

  // M2.0 开放的 R1 动作：stop
  const ok = await rpc(url, 'tools/call', { name: 'stop', arguments: {} })
  assert.match(ok.result.content[0].text, /停了（stop）/)

  // 未开放动作：工具表里没有它，调用直接被拒，而且绝不许进游戏
  // SURVIVAL-03：chop 已开放，换成仍然未开放的 cook
  const before = game.commands.length
  const closed = await rpc(url, 'tools/call', { name: 'night_watch', arguments: {} })
  assert.match(closed.result.content[0].text, /没有这个工具/)
  assert.equal(game.commands.length, before, '被拒的动作不该写进游戏命令')

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
  const pushed = JSON.parse(stripKleiHeader(readFileSync(join(dir, 'whale_settings.json'), 'utf8')))
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
