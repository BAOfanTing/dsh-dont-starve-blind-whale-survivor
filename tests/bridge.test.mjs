// 文件桥：找文件、读状态、发指令等结果、推设置、暂停开关
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GameBridge, stripKleiHeader } from '../lib/bridge.js'
import { FakeGame, tempDir } from './helpers.mjs'

test('找不到游戏时 state() 是空的，status() 会说清楚原因', () => {
  const dir = tempDir()
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true })
  assert.equal(bridge.readState(), null)
  const status = bridge.status()
  assert.equal(status.connected, false)
  assert.match(status.reason, /找不到/)
})

test('能读到模组写的状态，并认得出它是新的', () => {
  const dir = tempDir()
  const game = new FakeGame(dir).start()
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true })
  const state = bridge.readState()
  assert.ok(state)
  assert.equal(state.json.ready, true)
  assert.match(state.json.text, /威尔逊/)
  const status = bridge.status()
  assert.equal(status.connected, true)
  assert.equal(status.channel, 'persist')
  game.stop()
})

test('发指令会等游戏回结果', async () => {
  const dir = tempDir()
  const game = new FakeGame(dir).start()
  game.handler = (cmd) => ({ ok: true, text: `砍了 ${cmd.args.count ?? 1} 棵树` })
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true, pollMs: 20 })
  const result = await bridge.call('chop', { count: 2 }, { timeoutMs: 3000 })
  assert.equal(result.ok, true)
  assert.match(result.text, /砍了 2 棵树/)
  assert.equal(game.commands.length, 1)
  assert.equal(game.commands[0].action, 'chop')
  assert.deepEqual(game.commands[0].args, { count: 2 })
  game.stop()
})

test('游戏说做不了时 result.ok = false，但不算异常', async () => {
  const dir = tempDir()
  const game = new FakeGame(dir).start()
  game.handler = () => ({ ok: false, text: '附近没有能砍的东西' })
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true, pollMs: 20 })
  const result = await bridge.call('chop', {}, { timeoutMs: 3000 })
  assert.equal(result.ok, false)
  assert.match(result.text, /附近没有/)
  game.stop()
})

test('动作超时会报错，消息里说清楚等了多少', async () => {
  const dir = tempDir()
  const game = new FakeGame(dir).start()
  game.handler = () => undefined // 永远不回
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true, pollMs: 20 })
  await assert.rejects(
    () => bridge.call('sleep', {}, { timeoutMs: 300 }),
    /还没做完/,
  )
  game.stop()
})

test('设置和暂停开关会写到游戏目录', () => {
  const dir = tempDir()
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true })
  const wrote = bridge.pushSettings({ freezeTime: true, extra: '先建家' })
  assert.equal(wrote, 1)
  const settings = JSON.parse(stripKleiHeader(readFileSync(join(dir, 'whale_settings.json'), 'utf8')))
  assert.equal(settings.freezeTime, true)

  bridge.setPause(true)
  assert.ok(existsSync(join(dir, 'whale_pause.json')))
  assert.equal(JSON.parse(stripKleiHeader(readFileSync(join(dir, 'whale_pause.json'), 'utf8'))).pause, true)

  // 同一个值不重复写（省得每秒都写盘）
  const before = readFileSync(join(dir, 'whale_pause.json'), 'utf8')
  bridge.setPause(true)
  assert.equal(readFileSync(join(dir, 'whale_pause.json'), 'utf8'), before)
})

test('io 通道目录用另一套文件名（bin64 那种）', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const root = tempDir()
  const dir = join(root, 'bin64')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'whale_io_state.json'), JSON.stringify({
    v: 1, seq: 1, t: Math.floor(Date.now() / 1000), mod: '0.1.0', ready: true, text: 'io 通道', data: {},
  }), 'utf8')
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true, pollMs: 20 })
  const state = bridge.readState()
  assert.ok(state)
  assert.equal(state.channel, 'io')
  assert.match(state.json.text, /io 通道/)

  // 指令也要写成 io 那套名字
  const game = new FakeGame(dir)
  game.tick = function tickIo() {
    const cmdPath = join(this.dir, 'whale_io_cmd.json')
    if (!existsSync(cmdPath)) return
    const cmd = JSON.parse(readFileSync(cmdPath, 'utf8'))
    this.commands.push(cmd)
    writeFileSync(join(this.dir, 'whale_io_result.json'), JSON.stringify({ v: 1, id: cmd.id, ok: true, text: '干完了' }), 'utf8')
  }
  const timer = setInterval(() => game.tick(), 20)
  const result = await bridge.call('pick', {}, { timeoutMs: 2000 })
  clearInterval(timer)
  assert.equal(result.ok, true)
  assert.equal(result.text, '干完了')
})

test('HUD：插件写的小窗内容客户端能读，快捷键写的开关插件能读', () => {
  const dir = tempDir()
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true })
  assert.equal(bridge.writeHud({ v: 1, ai: true, step: 3, lines: ['正在做：chop'] }), 1)
  const rawHud = readFileSync(join(dir, 'whale_hud.json'), 'utf8')
  assert.match(rawHud, /^KLEI\s+1 /, '持久化字符串通道写出去的文件要带 KLEI 头，游戏才认')
  const hud = JSON.parse(stripKleiHeader(rawHud))
  assert.equal(hud.ai, true)
  assert.equal(hud.step, 3)
  assert.deepEqual(hud.lines, ['正在做：chop'])

  // 游戏里按 F8 写出来的开关
  writeFileSync(join(dir, 'whale_toggle.json'), JSON.stringify({ ai: true, stop: false, ts: 123 }), 'utf8')
  const toggle = bridge.readToggle()
  assert.equal(toggle.ai, true)
  assert.equal(toggle.ts, 123)
})