// 会话日志质检员（Oracle）单测：把「5 类硬故障 + 健康分 + 上下文窗口」用内存事件锁死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  analyzeSession,
  analyzeDirectory,
  parseSessionJsonl,
  computeHealthScore,
  detectMilestones,
  matchReferencedPrefab,
  DEFAULT_OPTS,
} from '../../lib/autodev/session-oracle.js'
import { tempDir } from '../helpers/helpers.mjs'

// 有序递增的 ISO 时间戳生成器（t=0 起的秒）
function mkClock(startMs = Date.parse('2026-01-01T00:00:00Z')) {
  let t = startMs
  return {
    at(ms) { t = startMs + ms; return new Date(t).toISOString() },
    tick(ms = 1000) { t += ms; return new Date(t).toISOString() },
  }
}

test('ORACLE-1：parseSessionJsonl 容忍坏行/空行/尾行半截', () => {
  const text = '{"kind":"state","t":"2026-01-01T00:00:00Z"}\n\n{bad json}\n{"kind":"note","text":"x"}\n{"kind":"trunc'
  const r = parseSessionJsonl(text)
  assert.equal(r.events.length, 2)
  assert.equal(r.bad, 2) // 坏 JSON + 尾行半截，各算一条
})

test('ORACLE-2：干净全绿会话无故障，且里程碑都识别到、分数合理', () => {
  const c = mkClock()
  const events = [
    { kind: 'state', day: 1, phase: 'day', hp: '150/150', dead: false, ghost: false, t: c.at(0) },
    { kind: 'cmd', action: 'craft', args: { recipe: 'torch' }, t: c.at(1000) },
    { kind: 'tool_result', tool: 'craft', status: 'succeeded', ok: true, t: c.at(2000) },
    { kind: 'state', day: 2, phase: 'day', hp: '140/150', dead: false, ghost: false, t: c.at(4000) },
  ]
  const report = analyzeSession({ events, serverLog: [] })
  assert.equal(report.summary.criticalCount, 0)
  assert.equal(report.faults.length, 0)
  assert.equal(report.summary.milestones.torch, true)
  assert.equal(report.summary.milestones.surviveNight1, true)
  assert.ok(report.summary.score >= 200, `score=${report.summary.score}`)
})

test('ORACLE-3：server_log 出现 Lua error → S0 崩溃', () => {
  const report = analyzeSession({
    events: [{ kind: 'note', text: 'start', t: '2026-01-01T00:00:00Z' }],
    serverLog: ['[00:01]: loading', '[00:02]: Lua error: attempt to index a nil value', '[00:03]: stack traceback:'],
  })
  assert.equal(report.summary.s0 >= 1, true)
  assert.ok(report.faults.some((f) => f.code === 'crash' && f.severity === 'S0'))
  assert.equal(report.summary.criticalCount >= 1, true)
})

test('ORACLE-4：STATE ghost=true → S0 死亡', () => {
  const report = analyzeSession({
    events: [{ kind: 'state', day: 2, ghost: true, dead: false, hp: '0/150', t: '2026-01-01T00:00:00Z' }],
  })
  assert.ok(report.faults.some((f) => f.code === 'death' && f.severity === 'S0'))
})

test('ORACLE-5：连续 3 次相同失败 → S1 死循环，且上下文窗口被截断', () => {
  const c = mkClock()
  const events = []
  // 先塞 20 条噪声，确保上下文窗口不会把全部事件都塞进报告
  for (let i = 0; i < 20; i += 1) events.push({ kind: 'game_log', line: `noise ${i}`, t: c.tick(500) })
  for (let i = 0; i < 3; i += 1) {
    events.push({ kind: 'tool_result', tool: 'chop_nearest', status: 'failed', reason: 'out_of_range', ok: false, t: c.tick(1000) })
  }
  const report = analyzeSession({ events })
  const loop = report.faults.find((f) => f.code === 'loop')
  assert.ok(loop, '应识别出死循环')
  assert.equal(loop.severity, 'S1')
  const maxWindow = DEFAULT_OPTS.contextRadius * 2 + 1
  assert.ok(loop.evidence.events.length <= maxWindow, `窗口 ${loop.evidence.events.length} 应 <= ${maxWindow}`)
})

test('ORACLE-6：unverified 占比 > 15% → S1', () => {
  const c = mkClock()
  const events = []
  for (let i = 0; i < 10; i += 1) {
    events.push({ kind: 'tool_result', tool: 'pickup_nearest', status: i < 2 ? 'unverified' : 'succeeded', ok: true, t: c.tick(500) })
  }
  const report = analyzeSession({ events })
  assert.ok(report.faults.some((f) => f.code === 'unverified_rate'))
})

test('ORACLE-7：STATE 超过 15s 未更新 → S1 状态失真', () => {
  const c = mkClock()
  const events = [
    { kind: 'state', day: 1, phase: 'day', t: c.at(0) },
    { kind: 'state', day: 1, phase: 'dusk', t: c.at(20000) },
  ]
  const report = analyzeSession({ events })
  assert.ok(report.faults.some((f) => f.code === 'state_stale'))
})

test('ORACLE-7b：age_ms 新鲜但事件间隔 30s（记录器去重保活）→ 不应误报 stale', () => {
  const c = mkClock()
  const events = [
    { kind: 'state', day: 1, age_ms: 300, t: c.at(0) },
    { kind: 'state', day: 1, age_ms: 200, t: c.at(30000) },
  ]
  const report = analyzeSession({ events })
  assert.equal(report.faults.some((f) => f.code === 'state_stale'), false)
})

test('ORACLE-8：REFLEX 报缺燧石但 ENV 里存在 → S1 矛盾', () => {
  const c = mkClock()
  const events = [
    { kind: 'state', day: 1, t: c.at(0) },
    { kind: 'reflex', line: '[Reflex] craft_axe: 缺燧石 flint', t: c.at(1000) },
    {
      kind: 'env', t: c.at(2000), lines: ['flint x1', 'twigs x2'],
      nearby: { buckets: { resources: [{ prefab: 'flint' }] } },
    },
  ]
  const report = analyzeSession({ events })
  assert.ok(report.faults.some((f) => f.code === 'reflex_env_contradiction'))
})

test('ORACLE-9：跑满预算步数仍缺里程碑 → S2 目标未达（不算严重故障）', () => {
  const c = mkClock()
  const events = []
  for (let i = 0; i < DEFAULT_OPTS.budgetSteps; i += 1) {
    events.push({ kind: 'tool_result', tool: 'pickup_nearest', status: 'succeeded', ok: true, t: c.tick(500) })
  }
  const report = analyzeSession({ events })
  assert.ok(report.faults.some((f) => f.code === 'goal_missed' && f.severity === 'S2'))
  assert.equal(report.summary.criticalCount, 0, 'S2 不计入严重故障')
  assert.equal(report.summary.s2 >= 1, true)
})

test('ORACLE-10：computeHealthScore 公式（存活×100 + 里程碑 - 报错×500 - 循环×100 - unverified×50）', () => {
  const score = computeHealthScore({ survivedDays: 2, milestones: { torch: true, surviveNight1: true }, luaErrors: 1, loops: 1, unverifiedRate: 0.2 })
  // 200 + (20+40) - 500 - 100 - 10 = -370
  assert.equal(score, 200 + 60 - 500 - 100 - 10)
})

test('ORACLE-11：detectMilestones / matchReferencedPrefab 基本正确', () => {
  const m = detectMilestones([
    { kind: 'cmd', action: 'craft', args: { recipe: 'torch' }, t: '2026-01-01T00:00:01Z' },
    { kind: 'tool_result', tool: 'craft', status: 'succeeded', ok: true, t: '2026-01-01T00:00:02Z' },
    { kind: 'state', day: 2, t: '2026-01-01T00:00:03Z' },
  ])
  assert.equal(m.torch, true)
  assert.equal(m.surviveNight1, true)
  assert.equal(matchReferencedPrefab('缺 金矿 gold'), 'gold_vein')
  assert.equal(matchReferencedPrefab('随便一句话'), null)
})

test('ORACLE-13：桥原始 result 失败（无 tool/reason）不应误判死循环', () => {
  const c = mkClock()
  const events = []
  for (let i = 0; i < 3; i += 1) events.push({ kind: 'result', ok: false, text: `rejected_${i}`, id: `r${i}`, t: c.tick(1000) })
  const report = analyzeSession({ events })
  assert.equal(report.faults.some((f) => f.code === 'loop'), false)
})

test('ORACLE-14：里程碑按 id/seq 精确匹配，别把别的动作的 ok 当成功', () => {
  const c = mkClock()
  const mismatched = detectMilestones([
    { kind: 'cmd', id: 'c1', action: 'craft', args: { recipe: 'torch' }, t: c.at(0) },
    { kind: 'result', id: 'c2', ok: true, text: 'move ok', t: c.at(1000) },
  ])
  assert.equal(mismatched.torch, false)
  const matched = detectMilestones([
    { kind: 'cmd', id: 'c1', action: 'craft', args: { recipe: 'torch' }, t: c.at(0) },
    { kind: 'result', id: 'c1', ok: true, text: '做好了火把', t: c.at(1000) },
  ])
  assert.equal(matched.torch, true)
})

test('ORACLE-15：Autopilot/Assisted 模式从 state/env 事件也能识别 torch 与 sciencemachine 里程碑', () => {
  const mFromHand = detectMilestones([
    { kind: 'tool_call', tool: 'advance_task', args: {}, t: '2026-01-01T00:00:01Z' },
    { kind: 'state', day: 1, hand: 'torch', inv: 'twigs:2', t: '2026-01-01T00:00:02Z' },
    {
      kind: 'env',
      nearby: { buckets: { structures: [{ prefab: 'researchlab' }] } },
      lines: [],
      t: '2026-01-01T00:00:03Z',
    },
  ])
  assert.equal(mFromHand.torch, true)
  assert.equal(mFromHand.sciencemachine, true)

  const mFromInvAndLines = detectMilestones([
    { kind: 'tool_call', tool: 'run_skill', args: { skill_id: 'craft_or_build' }, t: '2026-01-01T00:00:01Z' },
    { kind: 'state', day: 2, hand: null, inv: 'cutgrass:1,torch:1', t: '2026-01-01T00:00:02Z' },
    { kind: 'env', lines: ['[建筑] #1 科学机器 (1,2)'], t: '2026-01-01T00:00:03Z' },
  ])
  assert.equal(mFromInvAndLines.torch, true)
  assert.equal(mFromInvAndLines.sciencemachine, true)
  assert.equal(mFromInvAndLines.surviveNight1, true)
})

test('ORACLE-12：analyzeDirectory 能从真实文件读并产出报告', () => {  const dir = tempDir('oracle-')
  fs.writeFileSync(path.join(dir, 'session.jsonl'), [
    JSON.stringify({ kind: 'state', day: 1, ghost: true, t: '2026-01-01T00:00:00Z' }),
  ].join('\n'))
  fs.writeFileSync(path.join(dir, 'server_log.txt'), 'hello\nLua error: boom\n')
  const report = analyzeDirectory(dir)
  assert.equal(report.faults.length >= 2, true) // 崩溃 + 死亡
  assert.equal(report.meta.eventCount, 1)
})
