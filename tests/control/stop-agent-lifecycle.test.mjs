// R8.0 P2：AiRunner 世代化（runId）—— 旧 Agent 晚到的模型响应不能派发动作；
// 旧一轮的 finally 不能清掉新一轮的运行状态（ST-05 / ST-06）。
// 纯 Agent 单元测试：注入 readSnapshot / chatFn / callTool，不碰游戏。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AiRunner } from '../../lib/agent.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SNAP = {
  stale: false,
  actor: { valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0 },
  player: { hunger: { percent: 100 }, health: { percent: 100 }, sanity: { percent: 100 }, inventory: { items: [] } },
  nearby: { buckets: {} },
  world: { day: 1, phase: 'day' },
  identity: { worldKey: 'w' },
}

function makeRunner({ chatFn, callTool }) {
  return new AiRunner({
    bridge: {},
    log: () => {},
    readSnapshot: () => SNAP,
    settings: () => ({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1', model: 'fake', maxTokens: 64 }),
    instructions: () => 'sys',
    toolList: () => [
      { name: 'get_state', description: '看', inputSchema: { type: 'object', properties: {} } },
      { name: 'move_to', description: '走', inputSchema: { type: 'object', properties: {} } },
    ],
    callTool,
    chatFn,
    onStatus: () => {},
  })
}

/** 轮询等待条件成立 */
async function waitFor(fn, ms = 1500) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (fn()) return true
    await sleep(10)
  }
  return false
}

test('ST-05：旧 Agent 的模型响应在 stop→start 之后才返回 → 绝不派发任何游戏动作', async () => {
  const toolCalls = []
  let chatCalls = 0
  let resolveOld = null
  const chatFn = (_config, _messages) => {
    chatCalls++
    if (chatCalls === 1) {
      // 第一轮（旧世代）挂起，稍后再返回一个 move_to 工具调用
      return new Promise((resolve) => { resolveOld = resolve })
    }
    return Promise.resolve({ content: '空转', thought: null, toolCalls: [], rawToolCalls: [] })
  }
  const runner = makeRunner({
    chatFn,
    callTool: async (name, args) => { toolCalls.push({ name, args }); return 'ok' },
  })

  runner.start()
  assert.ok(await waitFor(() => !!resolveOld), '第一轮应到达模型请求')
  const run1 = runner.getRunId()

  // 用户停止 → 立刻阻止新工具；随后新一轮开始
  runner.stop('用户停止')
  assert.equal(runner.running, false)
  runner.start()
  const run2 = runner.getRunId()
  assert.notEqual(run2, run1, '新一次 start 必须是新世代')

  // 旧世代晚到的模型响应（带 move_to）
  resolveOld({
    content: '',
    thought: null,
    toolCalls: [{ id: 'old-1', name: 'move_to', args: { x: 9, z: 9 } }],
    rawToolCalls: [{ id: 'old-1', type: 'function', function: { name: 'move_to', arguments: '{"x":9,"z":9}' } }],
  })
  await sleep(150)

  assert.equal(toolCalls.some((c) => c.name === 'move_to'), false, '旧世代的工具调用绝不能派发')
  runner.stop('测试结束')
})

test('ST-06：旧一轮的 finally 延迟执行 → 不能清掉新一轮的运行状态', async () => {
  let chatCalls = 0
  let resolveOld = null
  const chatFn = (_config, _messages) => {
    chatCalls++
    if (chatCalls === 1) return new Promise((resolve) => { resolveOld = resolve })
    return Promise.resolve({ content: '空转', thought: null, toolCalls: [], rawToolCalls: [] })
  }
  const runner = makeRunner({ chatFn, callTool: async () => 'ok' })

  runner.start()
  assert.ok(await waitFor(() => !!resolveOld))
  runner.stop('旧一轮结束') // 旧一轮 running=false，但它仍挂在 model 请求上

  runner.start() // 新一轮
  const run2 = runner.getRunId()
  assert.equal(runner.running, true)

  // 旧世代模型响应晚到 → 旧 loop 收尾（触发旧 finally）
  resolveOld({ content: '', thought: null, toolCalls: [], rawToolCalls: [] })
  await sleep(150)

  assert.equal(runner.running, true, '旧 finally 绝不能把新一轮的 running 置 false')
  assert.equal(runner.getRunId(), run2, 'running 世代必须仍是新一轮')
  runner.stop('测试结束')
})

test('基础：start/stop 世代递增、running 状态正确', () => {
  const runner = makeRunner({
    chatFn: () => Promise.resolve({ content: 'x', thought: null, toolCalls: [], rawToolCalls: [] }),
    callTool: async () => 'ok',
  })
  const before = runner.getRunId()
  assert.equal(runner.start(), true)
  assert.equal(runner.running, true)
  assert.equal(runner.getRunId(), before + 1)
  assert.equal(runner.start(), false, '已在运行不能重复 start')
  runner.stop('x')
  assert.equal(runner.running, false)
})
