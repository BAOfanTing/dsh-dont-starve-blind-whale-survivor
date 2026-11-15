// 插件内置会话日志：覆盖写语义、t 非字符串兜底、数据源定位
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir } from './helpers.mjs'
import {
  SessionRecorder, SessionLog, eventsToText, stripKlei, decodeLogBytes,
  resolveLogSources, parseArgs,
} from '../lib/session-log.js'

function makeBridgeFiles(dir) {
  fs.writeFileSync(path.join(dir, 'whale_cmd.json'), 'KLEI     1 {"id":"c1","action":"probe","args":{"prefab":"grass"},"requested_by":"mcp_client"}')
  fs.writeFileSync(path.join(dir, 'whale_result.json'), 'KLEI     1 {"id":"c1","ok":true,"t":1794700000,"text":"找到了"}')
  fs.writeFileSync(path.join(dir, 'whale_state.json'), 'KLEI     1 {"mod":"0.37.0","data":{"day":18,"phase":"day","players":1,"player":{"health":{"current":200,"max":200},"hunger":{"current":100,"max":200},"sanity":{"current":200,"max":200},"inventory":{"items":[{"prefab":"torch","count":1,"percent":98}]},"equipment":{"slots":{}}},"actor":{"alive":true}}}')
  const log = path.join(dir, 'server_log.txt')
  fs.writeFileSync(log, '[00:00:01]: [Reflex] light_check:\n[00:00:02]: Spawn request: wolfgang\n')
  return { bridgeDir: dir, serverLog: log, chat: path.join(dir, 'chat') }
}

/** 造一个只会返回固定目录的假 bridge（不碰真实 KLEI 存档） */
function fakeBridge(dir) {
  return {
    readState: () => ({ dir }),
    locate: () => [{ dir, channel: 'persist' }],
  }
}

test('SL-1：result 事件里 t 是数字时间戳时，写盘不抛错、t 仍是 ISO 字符串', () => {
  const dir = tempDir()
  const src = makeBridgeFiles(dir)
  const out = path.join(dir, 'session.jsonl')
  const r = new SessionRecorder({ ...src, out, fromStart: true, stateEveryMs: 0 })
  const events = r.tick()
  const results = events.filter((e) => e.kind === 'result')
  assert.ok(results.length >= 1, '应该收到 result 事件')
  for (const e of results) {
    assert.equal(typeof e.t, 'string', 't 必须恒为字符串')
    assert.match(e.t, /^\d{4}-\d{2}-\d{2}T/, 't 要是 ISO 时间戳')
    assert.equal(typeof e.game_t, 'number', '游戏时间戳应保留在 game_t')
    assert.doesNotThrow(() => eventsToText(e))
  }
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n')
  assert.equal(lines.length, events.length, '每条事件都要落盘')
  for (const line of lines) JSON.parse(line)
})

test('SL-2：eventsToText 对 t 非字符串/缺失也不抛错', () => {
  assert.doesNotThrow(() => eventsToText({ kind: 'note', text: 'x', t: 12345 }))
  assert.doesNotThrow(() => eventsToText({ kind: 'note', text: 'x' }))
  assert.match(eventsToText({ kind: 'note', text: 'x', t: 12345 }), /NOTE/)
})

test('SL-3：SessionLog.start() 是覆盖写 —— 已存在的旧日志会被清空', () => {
  const dir = tempDir()
  const src = makeBridgeFiles(dir)
  const outDir = path.join(dir, 'logs')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'session.jsonl'), 'OLD LINE THAT MUST BE GONE\n')
  fs.writeFileSync(path.join(outDir, 'session.txt'), 'OLD TEXT THAT MUST BE GONE\n')
  fs.writeFileSync(path.join(outDir, 'server_log.txt'), 'OLD SERVER LOG\n')

  const sl = new SessionLog({ outDir, bridge: fakeBridge(dir), explicit: src, intervalMs: 100000, sourceEveryMs: 100000 })
  sl.start()
  try {
    const jsonl = fs.readFileSync(path.join(outDir, 'session.jsonl'), 'utf8')
    const txt = fs.readFileSync(path.join(outDir, 'session.txt'), 'utf8')
    assert.doesNotMatch(jsonl, /OLD LINE/, '★ 旧 jsonl 必须被覆盖掉')
    assert.doesNotMatch(txt, /OLD TEXT/, '★ 旧 txt 必须被覆盖掉')
    assert.match(txt, /日志已覆盖重置/, '新日志要有重置标记')
    assert.doesNotMatch(fs.readFileSync(path.join(outDir, 'server_log.txt'), 'utf8'), /OLD SERVER LOG/, 'server_log 也要覆盖复制')
  } finally {
    sl.stop()
  }
})

test('SL-4：reset() 再次调用仍是覆盖写（模拟新会话开始）', () => {
  const dir = tempDir()
  const src = makeBridgeFiles(dir)
  const outDir = path.join(dir, 'logs')
  const sl = new SessionLog({ outDir, bridge: fakeBridge(dir), explicit: src, intervalMs: 100000, sourceEveryMs: 100000 })
  sl.start()
  try {
    sl.recorder.tick()
    const before = fs.readFileSync(path.join(outDir, 'session.txt'), 'utf8')
    assert.ok(before.length > 0)
    sl.reset('新会话 abc')
    const after = fs.readFileSync(path.join(outDir, 'session.txt'), 'utf8')
    assert.doesNotMatch(after, /CMD|STATE|REFLEX/, '★ 新会话后不应残留上一次的事件')
    assert.match(after, /新会话 abc/)
  } finally {
    sl.stop()
  }
})

test('SL-5：resolveLogSources 从 save 目录推出 server_log 和 chat 目录', () => {
  const dir = tempDir()
  const save = path.join(dir, 'Master', 'save')
  fs.mkdirSync(save, { recursive: true })
  fs.mkdirSync(path.join(dir, 'Master', 'backup', 'server_chat_log'), { recursive: true })
  fs.writeFileSync(path.join(save, 'whale_state.json'), 'KLEI     1 {"data":{"players":1}}')
  fs.writeFileSync(path.join(dir, 'Master', 'server_log.txt'), 'log')
  const found = resolveLogSources(fakeBridge(save))
  assert.ok(found)
  assert.equal(found.bridgeDir, save)
  assert.equal(found.serverLog, path.join(dir, 'Master', 'server_log.txt'))
  assert.equal(found.chat, path.join(dir, 'Master', 'backup', 'server_chat_log'))
})

test('SL-6：stripKlei / decodeLogBytes 兜底不回归', () => {
  assert.equal(stripKlei('KLEI     1 {"a":1}'), '{"a":1}')
  assert.equal(decodeLogBytes(Buffer.from('hello', 'utf8')), 'hello')
})

test('SL-7：parseArgs 仍支持 CLI 老参数', () => {
  const a = parseArgs(['--out', 'x.jsonl', '--from-start', '--seconds', '10'])
  assert.equal(a.out, 'x.jsonl')
  assert.equal(a['from-start'], true)
  assert.equal(a.seconds, '10')
})

test('SL-8：插件源码里内置了 SessionLog 且默认开启覆盖写', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /new SessionLog\(/, 'apply() 里要实例化 SessionLog')
  assert.match(src, /sessionLog\.start\(\)/, '插件启动要自动开始写日志')
  assert.match(src, /sessionLog\.reset\(/, '新会话要触发覆盖重置')
  assert.match(src, /sessionLogEnabled: true/, '默认开启')
  const logSrc = fs.readFileSync(new URL('../lib/session-log.js', import.meta.url), 'utf8')
  assert.match(logSrc, /writeFileSync\(this\.outJsonl, '', 'utf8'\)/, '★ 覆盖写：启动时清空 jsonl')
  assert.match(logSrc, /writeFileSync\(this\.outTxt, '', 'utf8'\)/, '★ 覆盖写：启动时清空 txt')
  assert.match(logSrc, /copyFileSync\(this\.sources\.serverLog, this\.outServerLog\)/, 'server_log 覆盖复制')
})
