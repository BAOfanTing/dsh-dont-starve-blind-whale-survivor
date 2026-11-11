// 内置 AI：用一个假的模型服务器驱动，验证它真的会看状态→调工具→把结果带回去，并且能停下
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { AiRunner } from '../lib/agent.js'
import { GameBridge } from '../lib/bridge.js'
import { FakeGame, tempDir } from './helpers.mjs'

/** 假模型：第一次回一个工具调用，第二次回纯文本。 */
function fakeModel(replies) {
  const seen = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push(JSON.parse(body))
    const reply = replies[Math.min(seen.length - 1, replies.length - 1)]
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: reply }] }))
  })
  return { server, seen }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('内置 AI：看状态 → 调工具 → 把结果回给模型 → 停下', async () => {
  const dir = tempDir()
  const game = new FakeGame(dir).start()
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true, pollMs: 20 })
  const { server, seen } = fakeModel([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'move_to', arguments: '{"x":3,"z":4}' } }],
    },
    { role: 'assistant', content: '走到 (3,4) 了，接下来去砍树' },
  ])
  const baseUrl = await listen(server)

  const toolCalls = []
  const statuses = []
  const runner = new AiRunner({
    bridge,
    log: () => {},
    settings: () => ({ apiKey: 'test-key', baseUrl, model: 'fake', maxTokens: 256 }),
    instructions: () => '你是大肥鱼',
    toolList: () => [
      { name: 'get_state', description: '看状态', inputSchema: { type: 'object', properties: {} } },
      { name: 'move_to', description: '走', inputSchema: { type: 'object', properties: { x: { type: 'integer' }, z: { type: 'integer' } } } },
    ],
    callTool: async (name, args) => {
      toolCalls.push({ name, args })
      return name === 'get_state' ? '第1天 你在 (0,0)' : '走到了 (3,4)'
    },
    onStatus: (status) => statuses.push(status),
  })

  runner.start()
  try {
    await sleep(400)
    assert.ok(toolCalls.some((c) => c.name === 'get_state'), '每步都该先看状态')
    assert.deepEqual(toolCalls.find((c) => c.name === 'move_to')?.args, { x: 3, z: 4 })
    // 模型第二次拿到的消息里应该有工具结果
    const second = seen[1]
    assert.ok(second, '应该有第二次请求')
    assert.ok(second.messages.some((m) => m.role === 'tool' && m.content.includes('走到了 (3,4)')), '工具结果要回给模型')
    assert.ok(second.tools.length >= 2, '工具定义要带上去')
    assert.equal(second.messages[0].role, 'system')
    assert.ok(statuses.some((s) => s.action && s.action.startsWith('move_to')), 'HUD 状态里应该出现正在做的动作')
  } finally {
    runner.stop('测试结束')
    game.stop()
    await new Promise((resolve) => server.close(resolve))
  }
  assert.ok(statuses.some((s) => s.running === false), '停下以后要通知一次状态')
})

test('没配 API Key 时不会乱调模型，而是给出提示', async () => {
  const dir = tempDir()
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true, pollMs: 20 })
  const statuses = []
  const runner = new AiRunner({
    bridge,
    log: () => {},
    settings: () => ({ apiKey: '', baseUrl: 'http://127.0.0.1:1', model: 'fake', maxTokens: 64 }),
    instructions: () => 'x',
    toolList: () => [],
    callTool: async () => 'x',
    onStatus: (status) => statuses.push(status),
  })
  runner.start()
  try {
    await sleep(150)
    const last = statuses[statuses.length - 1]
    assert.match(last.error, /API Key/)
  } finally {
    runner.stop('结束')
  }
})

test('游戏没连上时说清楚在等什么', async () => {
  const dir = tempDir()
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true, pollMs: 20 })
  const statuses = []
  const runner = new AiRunner({
    bridge,
    log: () => {},
    settings: () => ({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1', model: 'fake', maxTokens: 64 }),
    instructions: () => 'x',
    toolList: () => [],
    callTool: async () => 'x',
    onStatus: (status) => statuses.push(status),
  })
  runner.start()
  try {
    await sleep(150)
    const last = statuses[statuses.length - 1]
    assert.match(last.error, /等游戏/)
  } finally {
    runner.stop('结束')
  }
})
