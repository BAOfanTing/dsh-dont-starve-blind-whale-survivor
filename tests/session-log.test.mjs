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
  assert.match(src, /instance\.start\(\)/, '插件启动要自动开始写日志')
  assert.match(src, /instance\.reset\(/, '新会话要触发覆盖重置')
  assert.match(src, /sessionLogEnabled: true/, '默认开启')
  const logSrc = fs.readFileSync(new URL('../lib/session-log.js', import.meta.url), 'utf8')
  assert.match(logSrc, /writeFileSync\(this\.outJsonl, '', 'utf8'\)/, '★ 覆盖写：启动时清空 jsonl')
  assert.match(logSrc, /writeFileSync\(this\.outTxt, '', 'utf8'\)/, '★ 覆盖写：启动时清空 txt')
  assert.match(logSrc, /copyFileSync\(this\.sources\.serverLog, this\.outServerLog\)/, 'server_log 覆盖复制')
})

// ── AI 操作 / 周边环境（导出的重点）────────────────────────────────────────

test('SL-9：AI 下的操作留痕 —— CALL 带参数、DONE 带结果，MCP 和 F8 都走同一条路', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // runTool 是所有入口（MCP 会话 / F8 内置 AI / dst 入口工具）的唯一执行点
  assert.match(src, /sessionLog\?\.beginTool\(/, 'runTool 下发前要记 CALL')
  assert.match(src, /sessionLog\?\.endTool\(/, 'runTool 拿到结果后要记 DONE')
  assert.match(src, /tool: toolName, args, by: owner/, 'CALL 要带动作名、参数、调用方')
  // 没走到 executeTool 就被挡下的（F8 正在玩 / 控制权没抢到）也要留痕，否则日志有空洞
  assert.match(src, /logBlockedTool\(toolName, args, owner, 'f8_agent_running'/)
  assert.match(src, /logBlockedTool\(toolName, args, 'f8_agent', acq\.reason/)
})

test('SL-10：beginTool/endTool 把操作与结果写进 jsonl 和 txt', () => {
  const dir = tempDir()
  const src = makeBridgeFiles(dir)
  const out = path.join(dir, 'session.jsonl')
  const r = new SessionRecorder({ ...src, out, stateEveryMs: 0, envEveryMs: 0 })

  const seq = r.beginTool({ tool: 'gather_area', args: { prefab: 'sapling', limit: 6 }, by: 'mcp_client' })
  r.endTool({ seq, tool: 'gather_area', by: 'mcp_client', ok: true, status: 'succeeded', ms: 4210, text: '采了 6 个（twigs+6）\n【已核对】twigs +6' })

  const events = r.events.filter((e) => e.kind === 'tool_call' || e.kind === 'tool_result')
  assert.equal(events.length, 2)
  const call = events[0]
  assert.equal(call.tool, 'gather_area')
  assert.deepEqual(call.args, { prefab: 'sapling', limit: 6 })
  assert.equal(call.by, 'mcp_client')
  assert.equal(call.seq, seq)
  const done = events[1]
  assert.equal(done.seq, seq, '★ 结果要和这次调用配上同一个 seq')
  assert.equal(done.ok, true)
  assert.equal(done.status, 'succeeded')
  assert.equal(done.ms, 4210)
  assert.match(done.text, /twigs \+6/)

  const txt = fs.readFileSync(r.txtOut, 'utf8')
  assert.match(txt, /CALL   \| #1 gather_area args=\{"prefab":"sapling","limit":6\} by=mcp_client/)
  assert.match(txt, /DONE   \| #1 gather_area ok status=succeeded 4210ms \d+字/)
  // 返回内容原样分行，人眼看 txt 不用解 \n 转义
  assert.match(txt, /^ {9}\| 采了 6 个（twigs\+6）$/m, '返回原文要能直接看懂')
  assert.match(txt, /^ {9}\| 【已核对】twigs \+6$/m, '★ 多行返回要分行写出，不是挤在一行')
})

test('SL-11：失败的操作也留痕，并被标成 FAIL', () => {
  const dir = tempDir()
  const src = makeBridgeFiles(dir)
  const r = new SessionRecorder({ ...src, out: path.join(dir, 's.jsonl'), stateEveryMs: 0, envEveryMs: 0 })
  const seq = r.beginTool({ tool: 'harvest', args: { target_ref: '#2' }, by: 'mcp_client' })
  r.endTool({ seq, tool: 'harvest', by: 'mcp_client', ok: false, status: 'rejected', reason: 'stale_snapshot', ms: 30, text: '失败：附近快照变了' })
  const done = r.events.find((e) => e.kind === 'tool_result')
  assert.equal(done.ok, false)
  assert.equal(done.reason, 'stale_snapshot')
  assert.match(fs.readFileSync(r.txtOut, 'utf8'), /DONE   \| #1 harvest FAIL status=rejected reason=stale_snapshot 30ms/)
})

test('SL-12：工具返回过长按 textCap 截断，但保留原始长度', () => {
  const dir = tempDir()
  const src = makeBridgeFiles(dir)
  const r = new SessionRecorder({ ...src, out: path.join(dir, 's.jsonl'), stateEveryMs: 0, envEveryMs: 0, textCap: 50 })
  const long = 'x'.repeat(200) + '结尾'
  const seq = r.beginTool({ tool: 'get_state', args: {}, by: 'mcp_client' })
  r.endTool({ seq, tool: 'get_state', by: 'mcp_client', ok: true, ms: 3, text: long })
  const done = r.events.find((e) => e.kind === 'tool_result')
  assert.equal(done.truncated, true)
  assert.equal(done.chars, long.length, '★ chars 是截断前的真实长度')
  assert.equal(done.text.length, 50)
  assert.doesNotMatch(done.text, /结尾/)
  assert.match(fs.readFileSync(r.txtOut, 'utf8'), /DONE   \| #1 get_state ok \d+ms 202字（超长已截断）/)
})

/** 造一份带「附近」的完整状态文件（字段抄真机 whale_state.json） */
function writeStateWithNearby(file, { nearbySid = 'n1', stateSid = 's1', day = 1 } = {}) {
  const state = {
    mod: '0.37.0',
    data: {
      schema: 'bws.state/1',
      observer: { snapshot_id: stateSid, sequence: 203, status: 'ok' },
      x: 6, z: 41,
      world: { day, phase: 'day' },
      player: {
        health: { current: 200, max: 200 },
        hunger: { current: 168.4375, max: 200 },
        sanity: { current: 200, max: 200 },
        inventory: { items: [{ prefab: 'dumbbell', count: 1, percent: 100 }] },
        equipment: { slots: {} },
      },
      warnings: ['快天黑了，先准备火把或火堆'],
      nearby: {
        status: 'ok', radius: 40, snapshot_id: nearbySid,
        total_found: 3, total_returned: 3, truncated: false,
        buckets: {
          threats: [{ ref: '#1', prefab: 'tentacle', label: '触手', position: { x: 13, z: 55 }, distance: 12.4, health: 500, max_health: 500 }],
          harvestables: [{ ref: '#2', prefab: 'berrybush', label: '浆果丛', position: { x: -4, z: 14 }, distance: 0.2, harvest_ready: true }],
          pickupables: [{ ref: '#3', prefab: 'flint', distance: 6.2 }],
        },
      },
    },
  }
  fs.writeFileSync(file, 'KLEI     1 ' + JSON.stringify(state))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('SL-13：周边环境换帧时记一条 ENV（含威胁/可拾取/可收获的位置与距离）', async () => {
  const dir = tempDir()
  writeStateWithNearby(path.join(dir, 'whale_state.json'), { nearbySid: 'n1' })
  const r = new SessionRecorder({ bridgeDir: dir, out: path.join(dir, 'session.jsonl'), stateEveryMs: 0, envEveryMs: 0 })

  r.tick()
  const first = r.events.filter((e) => e.kind === 'env')
  assert.equal(first.length, 1, '第一次要记一条')
  assert.equal(first[0].sid, 'n1')
  assert.equal(first[0].radius, 40)
  assert.equal(first[0].total_returned, 3)
  const joined = first[0].lines.join('\n')
  assert.match(joined, /触手/, '要能看到威胁')
  assert.match(joined, /浆果丛/, '要能看到可收获')
  assert.match(joined, /flint/, '要能看到可拾取')
  assert.match(joined, /\(13,55\)/, '要能看到位置')
  assert.match(joined, /距12.4/, '要能看到距离')
  assert.equal(first[0].nearby.buckets.threats[0].health, 500, '结构化数据也要留在 jsonl 里')

  // 同一帧再写一次（内容没变）不能重复记
  await sleep(20)
  writeStateWithNearby(path.join(dir, 'whale_state.json'), { nearbySid: 'n1' })
  r.tick()
  assert.equal(r.events.filter((e) => e.kind === 'env').length, 1, '★ 同一帧不重复记')

  // 换帧了要再记一条
  await sleep(20)
  writeStateWithNearby(path.join(dir, 'whale_state.json'), { nearbySid: 'n2' })
  r.tick()
  const envs = r.events.filter((e) => e.kind === 'env')
  assert.equal(envs.length, 2, '★ 换帧要再记一条')
  assert.equal(envs[1].sid, 'n2')

  const txt = fs.readFileSync(r.txtOut, 'utf8')
  assert.match(txt, /ENV    \| 帧=n1 day=1 phase=day pos=\(6,41\)/, 'ENV 行要带当天时间和位置')
  assert.match(txt, /^ {9}\| +威胁：#1 触手 \(13,55\) 距12\.4 500\/500血$/m)
})

test('SL-14：状态里带上附近快照号和危险提醒，方便和 ENV/CALL 对齐时间线', () => {
  const dir = tempDir()
  writeStateWithNearby(path.join(dir, 'whale_state.json'), { nearbySid: 'n7' })
  const r = new SessionRecorder({ bridgeDir: dir, out: path.join(dir, 's.jsonl'), stateEveryMs: 0, envEveryMs: 100000 })
  r.tick()
  const state = r.events.find((e) => e.kind === 'state')
  assert.equal(state.nearby_sid, 'n7')
  assert.deepEqual(state.warnings, ['快天黑了，先准备火把或火堆'])
})

test('SL-17：同一个附近帧只记一条 ENV —— 状态帧号每秒都换，不能当成换帧', async () => {
  // ★ 真机踩到：一局里 991 条 ENV 实际只有 213 帧（多出 4.6 倍）。原因是判定指纹里带了
  //   状态帧号（observer.snapshot_id），而状态帧每秒换一次、nearby 帧 4 秒才换一次。
  const dir = tempDir()
  const file = path.join(dir, 'whale_state.json')
  const r = new SessionRecorder({ bridgeDir: dir, out: path.join(dir, 's.jsonl'), stateEveryMs: 0, envEveryMs: 0 })
  for (const stateSid of ['s14', 's15', 's16', 's17']) {
    await sleep(15)
    writeStateWithNearby(file, { nearbySid: 'n1', stateSid })
    r.tick()
  }
  const envs = r.events.filter((e) => e.kind === 'env')
  assert.equal(envs.length, 1, '★ 同一帧不管附带多少个状态帧，都只记一条')
  assert.equal(envs[0].state_sid, 's14', '记第一次看到这帧时的状态帧号')
  // 真换帧了才再记一条
  await sleep(15)
  writeStateWithNearby(file, { nearbySid: 'n2', stateSid: 's18' })
  r.tick()
  assert.equal(r.events.filter((e) => e.kind === 'env').length, 2)
})

test('SL-15：没有状态文件/附近字段时 ENV 不记也不抛错（老存档、游戏没开）', () => {
  const dir = tempDir()
  const r = new SessionRecorder({ bridgeDir: dir, out: path.join(dir, 's.jsonl'), stateEveryMs: 0, envEveryMs: 0 })
  assert.doesNotThrow(() => r.tick())
  assert.equal(r.events.filter((e) => e.kind === 'env').length, 0)
  // 老格式：有 data 但没有 nearby
  fs.writeFileSync(path.join(dir, 'whale_state.json'), 'KLEI     1 {"data":{"players":1}}')
  assert.doesNotThrow(() => r.tick())
  assert.equal(r.events.filter((e) => e.kind === 'env').length, 0)
})

test('SL-16：clearState（覆盖写）会把操作序号和周边记忆一起清掉', () => {
  const dir = tempDir()
  writeStateWithNearby(path.join(dir, 'whale_state.json'), { nearbySid: 'n1' })
  const r = new SessionRecorder({ bridgeDir: dir, out: path.join(dir, 's.jsonl'), stateEveryMs: 0, envEveryMs: 0 })
  r.tick()
  r.beginTool({ tool: 'stop', args: {}, by: 'mcp_client' })
  assert.equal(r.events.filter((e) => e.kind === 'env').length, 1)

  r.clearState()
  assert.equal(r.events.length, 0)
  assert.equal(r.beginTool({ tool: 'stop', args: {}, by: 'mcp_client' }), 1, '序号要从头数')
  r.tick()
  assert.equal(r.events.filter((e) => e.kind === 'env').length, 1, '清空后同一帧要能重新记一条')
})
