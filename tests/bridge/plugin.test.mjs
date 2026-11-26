// 插件本体：用一个假的 ctx 把 apply() 跑起来，确认它真的会把 MCP 服务器开起来、
// 会把设置推给游戏、退出时能收干净（不用启动 DSH，也不用打开游戏）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  apply, buildInstructions, currentConfig, helpText, mcpClientRow, name,
  parseSseResult, PRESET_ID, resolveBasePreset, setupGateway, setupPreset,
  isDstTool, extractDshMessage,
} from '../../lib/index.js'
import { FakeGame, tempDir } from '../helpers/helpers.mjs'

function fakeCtx() {
  const cleanups = []
  const logs = []
  const listeners = new Map()
  return {
    logger: (level, message) => logs.push(`${level}: ${message}`),
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    get: () => undefined,
    on: (evt, cb) => {
      let list = listeners.get(evt)
      if (!list) listeners.set(evt, (list = []))
      list.push(cb)
      return () => {
        const idx = list.indexOf(cb)
        if (idx >= 0) list.splice(idx, 1)
      }
    },
    emit: (evt, ...args) => {
      const list = listeners.get(evt) || []
      for (const cb of [...list]) cb(...args)
    },
    logs,
    dispose: () => {
      while (cleanups.length > 0) {
        const cleanup = cleanups.pop()
        try {
          cleanup()
        } catch {}
      }
    },
  }
}

async function waitFor(check, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  return false
}

test('插件叫 dsh-dont-starve-blind-whale-survivor，预设 id 和入口工具名字对得上', () => {
  assert.equal(name, 'dsh-dont-starve-blind-whale-survivor')
  assert.equal(PRESET_ID, 'dsh-dont-starve-blind-whale-survivor')
})

test('apply() 会把 MCP 服务器开起来，并把设置推到游戏目录', async () => {
  const dir = tempDir()
  const game = new FakeGame(dir).start()
  const port = 18000 + Math.floor(Math.random() * 500)
  const ctx = fakeCtx()
  apply(ctx, {
    port,
    bridgeDir: dir,
    autoInstallMod: false,
    presetEnabled: false,
    gatewayEnabled: false,
    sessionLogEnabled: false, // 别让插件测试污染真实 latestLogs/
  })
  try {
    const up = await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/status`)
        return res.ok
      } catch {
        return false
      }
    })
    assert.ok(up, 'MCP 服务器没起来')
    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).text()
    assert.match(status, /大肥鱼饿不死/)

    // 设置同步：游戏目录里应该出现 whale_settings.json
    const { readFileSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const pushed = await waitFor(() => existsSync(join(dir, 'whale_settings.json')))
    assert.ok(pushed, '设置没推给游戏')
    const { stripKleiHeader } = await import('../../lib/bridge.js')
    const settings = JSON.parse(stripKleiHeader(readFileSync(join(dir, 'whale_settings.json'), 'utf8')))
    assert.equal(settings.generatedBy, 'dsh-dont-starve-blind-whale-survivor')
  } finally {
    ctx.dispose()
    game.stop()
    // 让服务器把端口关干净再结束，不然 Windows 上退出时会报 libuv 的断言
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})

test('设置里有活引用（volatile）时也能取到值', () => {
  const config = { port: { get: () => 18080 }, extraInstructions: { get: () => '先建家' } }
  const c = currentConfig(config)
  assert.equal(c.port, 18080)
  assert.equal(c.extraInstructions, '先建家')
  assert.equal(c.autoContinue, true) // 没设置的用默认值
})

test('连接说明里有规则和主攻略，help 文本会把攻略摘掉', () => {
  const instructions = buildInstructions({ main: '主攻略正文：先做斧头' })
  // OBSERVATION-01：观察规则从"每次行动前"改成"任务开始时一次 + 按需刷新"
  assert.match(instructions, /任务开始时.*get_state/, '应该要求任务开始时读一次')
  assert.match(instructions, /不要每做一个动作就重看/, '应该明确不必每个动作都重看')
  assert.ok(!/每次行动前先调 get_state/.test(instructions), '不能保留旧的"每次行动前"要求')
  assert.match(instructions, /主攻略正文/)
  const help = helpText(instructions, [
    { name: 'chop', description: '砍树。要有斧头', inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: [] } },
  ])
  assert.match(help, /dst/)
  assert.match(help, /chop\(count\?\)/)
  assert.doesNotMatch(help, /主攻略正文/) // 攻略要用 get_guide 按需读
})

test('预设里的 MCP 客户端指向插件自己的端口', () => {
  const row = mcpClientRow({ port: 18081, actionTimeoutMinutes: 5 })
  assert.equal(row.id, 'mcp-dst')
  assert.equal(row.name, '@deepseek-ai/dsh-mcp-client')
  assert.equal(row.config.url, 'http://127.0.0.1:18081/mcp')
  assert.equal(row.config.transport, 'streamable-http')
  assert.equal(row.config.toolCallTimeoutMs, 5 * 60 * 1000)
})

test('SSE 解析能跳过心跳行', () => {
  const text = ': keep-alive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n'
  const message = parseSseResult(text)
  assert.equal(message.id, 1)
  assert.deepEqual(message.result, { content: [] })
})

function fakePresetsService() {
  const definitions = new Map()
  definitions.set('standard', { config: { plugins: [{ id: 'base-row' }] } })
  const registered = []
  const removed = []
  return {
    definitions,
    registered,
    removed,
    async register(preset) {
      registered.push(preset)
      return () => removed.push(preset.id)
    },
  }
}

function harnessCtx(services) {
  const cleanups = []
  return {
    logger: () => {},
    get: (name) => services[name],
    on: () => () => {},
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    dispose: () => {
      while (cleanups.length > 0) {
        try {
          cleanups.pop()()
        } catch {}
      }
    },
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('基础预设找不到时自动挑一个能用的（不同机器预设 id 不一样）', () => {
  const definitions = new Map([['aurabot-private', { config: { plugins: [] } }]])
  const found = resolveBasePreset({ definitions }, 'standard')
  assert.equal(found.id, 'aurabot-private')

  const both = new Map([['standard', { config: { plugins: [] } }], ['aurabot-private', { config: { plugins: [] } }]])
  assert.equal(resolveBasePreset({ definitions: both }, 'standard').id, 'standard')
  assert.equal(resolveBasePreset({ definitions: new Map() }, 'standard'), null)
})

test('预设开关：打开就注册，关掉就撤销（不用重启 DSH）', async () => {
  const presets = fakePresetsService()
  const ctx = harnessCtx({ agentPresets: presets })
  let enabled = false
  const config = {
    presetEnabled: { get: () => enabled },
    presetName: { get: () => '大肥鱼饿不死' },
    basePreset: { get: () => 'standard' },
    port: { get: () => 18090 },
    actionTimeoutMinutes: { get: () => 5 },
  }
  setupPreset(ctx, config, () => {}, { everyMs: 10 })
  try {
    await wait(60)
    assert.equal(presets.registered.length, 0, '开关关着时不该注册')

    enabled = true
    await wait(80)
    assert.equal(presets.registered.length, 1, '打开开关后应该注册一个预设')
    const preset = presets.registered[0]
    assert.equal(preset.id, PRESET_ID)
    assert.equal(preset.name, '大肥鱼饿不死')
    assert.ok(preset.plugins.some((row) => row.id === 'mcp-dst'), '预设里应该有连游戏的 MCP 客户端')
    assert.ok(preset.plugins.some((row) => row.id === 'base-row'), '预设里应该带着基础预设的插件')

    // 名字改了要重新注册
    config.presetName = { get: () => '大肥鱼' }
    await wait(80)
    assert.equal(presets.registered.length, 2, '改了名字应该重新注册')
    assert.equal(presets.registered[1].name, '大肥鱼')

    enabled = false
    await wait(80)
    assert.ok(presets.removed.length >= 1, '关掉开关后应该撤销')
  } finally {
    ctx.dispose()
  }
})

test('dst 入口工具：设置打开才注册，关掉就撤掉', async () => {
  const registered = []
  const tools = {
    register(tool) {
      registered.push(tool)
      return () => {}
    },
  }
  const ctx = harnessCtx({ tools })
  let enabled = false
  const config = {
    gatewayEnabled: { get: () => enabled },
    port: { get: () => 18090 },
    actionTimeoutMinutes: { get: () => 5 },
  }
  setupGateway(ctx, config, () => {}, { everyMs: 10 })
  try {
    await wait(30)
    assert.equal(registered.length, 0)
    enabled = true
    await wait(60)
    assert.equal(registered.length, 1)
    assert.equal(registered[0].name, 'dst')
    enabled = false
    await wait(60)
    // 撤掉以后不再注册
    assert.equal(registered.length, 1)
  } finally {
    ctx.dispose()
  }
})

test('isDstTool 能准确识别入口工具、MCP 工具和裸动作名', () => {
  assert.equal(isDstTool('dst'), true)
  assert.equal(isDstTool('mcp__dst__chop'), true)
  assert.equal(isDstTool('mcp__dst__gather_area'), true)
  assert.equal(isDstTool('chop'), true)
  assert.equal(isDstTool('gather_area'), true)
  assert.equal(isDstTool('get_state'), true)
  assert.equal(isDstTool('get_guide'), true)

  assert.equal(isDstTool('browser_navigate'), false)
  assert.equal(isDstTool('mcp__other__tool'), false)
  assert.equal(isDstTool(''), false)
  assert.equal(isDstTool(null), false)
})

test('extractDshMessage 能提取 reasoning_content、<think> 标签和结构化 thinking', () => {
  // 1. DeepSeek API reasoning_content 格式
  const d1 = extractDshMessage({
    reasoning_content: '需要先造一把斧头砍树',
    content: '好的，正在制作斧头。',
  })
  assert.equal(d1.thought, '需要先造一把斧头砍树')
  assert.equal(d1.content, '好的，正在制作斧头。')

  // 2. <think> 标签在正文中
  const d2 = extractDshMessage({
    content: '<think>周围天黑了，赶紧装备火把</think>已为你装备火把。',
  })
  assert.equal(d2.thought, '周围天黑了，赶紧装备火把')
  assert.equal(d2.content, '已为你装备火把。')

  // 3. 结构化 thinking part + tool-call
  const d3 = extractDshMessage({
    content: [
      { type: 'thinking', thinking: '目标是一棵常青树' },
      { type: 'text', text: '前往砍树。' },
      { type: 'tool-call', name: 'mcp__dst__chop', arguments: { target_ref: '#2' } },
    ],
  })
  assert.equal(d3.thought, '目标是一棵常青树')
  assert.equal(d3.content, '前往砍树。')
  assert.deepEqual(d3.toolCalls, [{ name: 'mcp__dst__chop', args: { target_ref: '#2' } }])

  // 4. OpenAI 格式 tool_calls
  const d4 = extractDshMessage({
    content: '开始采集草',
    tool_calls: [
      { function: { name: 'gather_area', arguments: '{"prefab":"grass"}' } },
    ],
  })
  assert.equal(d4.thought, null)
  assert.equal(d4.content, '开始采集草')
  assert.deepEqual(d4.toolCalls, [{ name: 'gather_area', args: { prefab: 'grass' } }])
})

test('DSH 会话中玩游戏时，assistant/message 的思考与回复自动留痕并关联 step', async () => {
  const dir = tempDir()
  const logDir = path.join(dir, 'logs')
  const ctx = fakeCtx()
  const port = 18000 + Math.floor(Math.random() * 500)
  apply(ctx, {
    port,
    bridgeDir: dir,
    sessionLogEnabled: true,
    sessionLogDir: logDir,
    autoInstallMod: false,
    presetEnabled: false,
    gatewayEnabled: false,
  })

  try {
    const session = { id: 'sess_123', presetId: PRESET_ID }

    // 1. turn/start
    ctx.emit('session/event', session, { type: 'turn/start' })

    // 2. assistant/message 带思考和回复
    ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: {
        message: {
          reasoning_content: '黑夜即将降临，先做火把',
          content: '正在为你制作火把。',
          model: 'deepseek-r1',
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        },
      },
    })

    const txtFile = path.join(logDir, 'session.txt')
    await waitFor(async () => fs.existsSync(txtFile) && fs.readFileSync(txtFile, 'utf8').includes('THINK'), 1500)

    const txt = fs.readFileSync(txtFile, 'utf8')
    assert.match(txt, /TURN   \| #1 reason=dsh_turn/)
    assert.match(txt, /THINK  \| #1 模型=deepseek-r1 tokens=150/)
    assert.match(txt, /\[思考\] 黑夜即将降临，先做火把/)
    assert.match(txt, /\[回复\] 正在为你制作火把。/)

    // 3. 模拟 DSH MCP client 调用工具，验证 CALL/DONE 自动关联 [S1]
    const mcpRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_guide', arguments: { topic: 'main' } },
      }),
    })
    assert.equal(mcpRes.status, 200)

    const updatedTxt = fs.readFileSync(txtFile, 'utf8')
    assert.match(updatedTxt, /CALL   \| #1 \[S1\] get_guide/)
    assert.match(updatedTxt, /DONE   \| #1 \[S1\] get_guide ok/)
  } finally {
    ctx.dispose()
  }
})