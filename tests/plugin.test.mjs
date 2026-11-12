// 插件本体：用一个假的 ctx 把 apply() 跑起来，确认它真的会把 MCP 服务器开起来、
// 会把设置推给游戏、退出时能收干净（不用启动 DSH，也不用打开游戏）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, buildInstructions, currentConfig, helpText, mcpClientRow, name, parseSseResult, PRESET_ID, resolveBasePreset, setupGateway, setupPreset } from '../lib/index.js'
import { FakeGame, tempDir } from './helpers.mjs'

function fakeCtx() {
  const cleanups = []
  const logs = []
  return {
    logger: (level, message) => logs.push(`${level}: ${message}`),
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    get: () => undefined,
    on: () => () => {},
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
    const { stripKleiHeader } = await import('../lib/bridge.js')
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
  assert.match(instructions, /每次行动前先调 get_state/)
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