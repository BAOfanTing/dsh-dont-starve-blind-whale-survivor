// 旁路会话记录器：只读桥文件与游戏日志，汇成一条可排查的时间线。
// 这里用临时目录造假文件，跑**真实实现**（不 mock 记录逻辑）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { tempDir } from './helpers.mjs'
import { SessionRecorder, stripKlei, eventsToText } from '../tools/session-recorder.mjs'

function fixture() {
  const dir = tempDir('session-recorder-')
  const bridgeDir = path.join(dir, 'save')
  fs.mkdirSync(bridgeDir, { recursive: true })
  const cmd = path.join(bridgeDir, 'whale_cmd.json')
  const result = path.join(bridgeDir, 'whale_result.json')
  const state = path.join(bridgeDir, 'whale_state.json')
  const log = path.join(dir, 'server_log.txt')
  const chat = path.join(dir, 'chat.txt')
  const out = path.join(dir, 'record.jsonl')
  fs.writeFileSync(log, '')
  fs.writeFileSync(chat, '')
  return { dir, bridgeDir, cmd, result, state, log, chat, out }
}

const cmdJson = (id, action, args) => JSON.stringify({
  v: 1, id, action, args, ts: 1794660623583, requested_by: 'mcp_client', owner_type: 'mcp_client',
})
const resultJson = (id, ok, text) => JSON.stringify({ ok, t: 1794660626, id, text, v: 1 })
const stateJson = (over = {}) => JSON.stringify({
  mod: '0.32.2', seq: 7,
  data: {
    schema: 'bws.state/1', x: -12, z: 34, day: 2, phase: 'day', dead: false,
    actor: { valid: true, is_ghost: false, actor_id: 'player:X' },
    player: {
      health: { current: 200, max: 200 }, hunger: { current: 150, max: 200 },
      sanity: { current: 190, max: 200 },
      inventory: { items: { 0: { prefab: 'torch', count: 1, percent: 62 } }, slots: 15 },
      equipment: { slots: { hands: { prefab: 'torch', percent: 62 } }, worn: [] },
    },
    world: { day: 2, phase: 'day' },
    nearby: { status: 'ok', buckets: {} },
  },
  ...over,
})

const makeRecorder = (f, extra = {}) => new SessionRecorder({
  bridgeDir: f.bridgeDir,
  serverLog: f.log,
  chat: f.chat,
  out: f.out,
  fromStart: true,
  stateEveryMs: 0,
  ...extra,
})

test('REC-1：KLEI 头剥得掉，普通 JSON 不受影响', () => {
  assert.equal(stripKlei('KLEI     1 {"a":1}'), '{"a":1}')
  assert.equal(stripKlei('{"a":1}'), '{"a":1}')
})

test('REC-2：一条命令、一条回执、一份状态、一行反射日志都进时间线', () => {
  const f = fixture()
  fs.writeFileSync(f.cmd, 'KLEI     1 ' + cmdJson('c1', 'craft', { recipe: 'torch' }))
  fs.writeFileSync(f.result, 'KLEI     1 ' + resultJson('c1', true, '做好了 火把'))
  fs.writeFileSync(f.state, 'KLEI     1 ' + stateJson())
  fs.writeFileSync(f.log, '[00:01:00]: [Reflex] craft_torch:\n  started=true\n')
  fs.writeFileSync(f.chat, '[00:01:01]: [Death Announcement] ... 死于： 黑暗.\n')

  const rec = makeRecorder(f)
  const events = rec.tick()
  const kinds = events.map((e) => e.kind)
  assert.ok(kinds.includes('cmd'), '要记下调用了什么动作')
  assert.ok(kinds.includes('result'), '要记下游戏回了什么')
  assert.ok(kinds.includes('state'), '要记下当时状态')
  assert.ok(kinds.includes('reflex'), '要记下反射诊断')
  assert.ok(kinds.includes('death'), '要单独标出死亡')

  const cmd = events.find((e) => e.kind === 'cmd')
  assert.equal(cmd.action, 'craft')
  assert.deepEqual(cmd.args, { recipe: 'torch' })
  assert.equal(cmd.requested_by, 'mcp_client')
  assert.equal(events.find((e) => e.kind === 'result').ok, true)

  const st = events.find((e) => e.kind === 'state')
  assert.equal(st.day, 2)
  assert.equal(st.hp, '200/200')
  assert.equal(st.hand, 'torch')
  assert.match(st.inv, /torch:1\(62%\)/)
})

test('REC-3：同一条命令/回执不重复记（单槽文件会被反复读到）', () => {
  const f = fixture()
  fs.writeFileSync(f.cmd, 'KLEI     1 ' + cmdJson('c1', 'stop', {}))
  fs.writeFileSync(f.result, 'KLEI     1 ' + resultJson('c1', true, '停下了'))
  fs.writeFileSync(f.state, 'KLEI     1 ' + stateJson())
  const rec = makeRecorder(f)
  rec.tick(); rec.tick(); rec.tick()
  assert.equal(rec.events.filter((e) => e.kind === 'cmd').length, 1)
  assert.equal(rec.events.filter((e) => e.kind === 'result').length, 1)
})

test('REC-4：日志增量读，只收新行；文件被截断会重来', () => {
  const f = fixture()
  fs.writeFileSync(f.state, 'KLEI     1 ' + stateJson())
  fs.writeFileSync(f.log, '[00:00:01]: [Reflex] light_check:\n')
  const rec = makeRecorder(f)
  const first = rec.tick().filter((e) => e.kind === 'reflex')
  assert.equal(first.length, 1)

  fs.appendFileSync(f.log, '[00:00:02]: [Reflex] craft_torch:\n')
  const second = rec.tick().filter((e) => e.kind === 'reflex')
  assert.equal(second.length, 1, '只该收新加的那一行')
  assert.match(second[0].line, /craft_torch/)

  fs.writeFileSync(f.log, '[00:00:03]: [Reflex] reset:\n')  // 模拟日志轮转/截断
  const third = rec.tick().filter((e) => e.kind === 'reflex')
  assert.equal(third.length, 1)
  assert.match(third[0].line, /reset/)
})

test('REC-5：默认从日志末尾开始，不把历史刷进新会话；--from-start 才收历史', () => {
  const f = fixture()
  fs.writeFileSync(f.state, 'KLEI     1 ' + stateJson())
  fs.writeFileSync(f.log, '[00:00:01]: [Reflex] old line\n')
  const tailOnly = makeRecorder(f, { fromStart: false })
  assert.equal(tailOnly.tick().filter((e) => e.kind === 'reflex').length, 0)
  fs.appendFileSync(f.log, '[00:00:02]: [Reflex] new line\n')
  assert.equal(tailOnly.tick().filter((e) => e.kind === 'reflex').length, 1)

  const withHistory = makeRecorder(f, { fromStart: true })
  assert.equal(withHistory.tick().filter((e) => e.kind === 'reflex').length, 2)
})

test('REC-6：记录器只读桥文件，绝不改写它们', () => {
  const f = fixture()
  const cmdText = 'KLEI     1 ' + cmdJson('c1', 'eat', {})
  const stateText = 'KLEI     1 ' + stateJson()
  fs.writeFileSync(f.cmd, cmdText)
  fs.writeFileSync(f.state, stateText)
  const rec = makeRecorder(f)
  rec.tick()
  assert.equal(fs.readFileSync(f.cmd, 'utf8'), cmdText, '命令文件不能被动过')
  assert.equal(fs.readFileSync(f.state, 'utf8'), stateText, '状态文件不能被动过')
})

test('REC-7：人工标注与产物文件（jsonl + 可读 txt）都对', () => {
  const f = fixture()
  fs.writeFileSync(f.state, 'KLEI     1 ' + stateJson())
  const rec = makeRecorder(f)
  rec.tick()
  rec.note('开始验证第一夜')
  assert.ok(fs.existsSync(f.out), 'jsonl 要落盘')
  const txt = f.out.replace(/\.jsonl$/, '.txt')
  assert.ok(fs.existsSync(txt), '可读文本也要落盘')
  const lines = fs.readFileSync(f.out, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.some((e) => e.kind === 'note' && e.text === '开始验证第一夜'))
  assert.match(fs.readFileSync(txt, 'utf8'), /STATE\s+\|/)
  assert.match(eventsToText({ t: new Date().toISOString(), kind: 'cmd', action: 'craft', id: 'x', args: {} }), /CMD/)
})
