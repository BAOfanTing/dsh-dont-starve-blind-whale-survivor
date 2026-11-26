// 会话日志「质检员（Oracle）」——全自动测试闭环的第 4 步。
//
// 作用：把 latestLogs/session.jsonl（结构化事件流）+ server_log.txt（游戏原生日志）
// 自动扫描成一份 2~5 KB、可直接喂给 Coding Agent 的 issue-report。
//
// 设计边界（重要，和项目其他部分保持一致）：
//   · **纯确定性**：不联网、不依赖模型、不写桥文件、不改游戏。只读日志。
//   · **可单测**：核心 analyzeSession(events, serverLog) 是纯函数，测试用内存事件即可。
//   · **压缩而不丢线索**：每个故障只截取前后 contextRadius 条事件 + 完整堆栈/ENV/STATE，
//     目标体积 2~5 KB；比把整份 session.jsonl 丢给大模型精准十倍、也更省 token。
//
// 故障分级：
//   S0 崩溃：server_log 出现 Lua error / stack traceback / attempt to；
//            或某个动作 status 变成 threw / bridge_error。
//   S0 死亡：出现 DEATH 事件，或 STATE 里 dead=true / ghost=true。
//   S1 卡死：连续 >=3 次相同 tool+reason（repeated_failed_action、stale_snapshot_circuit_open、
//            out_of_range 循环、unverified 循环）；或 idle_give_up；或 result_timeout / unknown 终态。
//   S1 状态失真：STATE 超过 staleMs(默认 15s) 未更新；或 unverified 占比 > 15%；
//                或 REFLEX 报缺料但同一时刻 ENV 里明明在范围内。
//   S2 目标未达：跑满步数预算却仍未达成剧本断言（默认：做出火把 / 活过第一夜）。
//
// 健康分（用于自动回滚判断，越大越好）：
//   存活天数×100 + 里程碑得分 - Lua 报错×500 - 死循环×100 - unverified率×50

import fs from 'node:fs'
import path from 'node:path'
import { decodeLogBytes } from '../session-log.js'

export const REPORT_SCHEMA = 'bws.issue-report/1'

/** 默认识别参数。命令行/主控都可覆盖。 */
export const DEFAULT_OPTS = {
  staleMs: 15000,
  unverifiedRateThreshold: 0.15,
  loopConsecutive: 3,
  budgetSteps: 40,
  contextRadius: 12,
  contextTextCap: 600,
  maxReportBytes: 5000,
  enableReflexEnvCheck: true,
  // 里程碑权重（S2 目标）。可按剧本覆盖。
  milestoneWeights: { torch: 20, sciencemachine: 30, surviveNight1: 40 },
  // S2 判定里「必须达成」的里程碑，缺一个就报目标未达。
  requiredMilestones: ['torch', 'surviveNight1'],
}

const CRASH_RE = /\bLua error\b|stack traceback|attempt to (index|call|concatenate|compare|perform|arithmetic)/i

/** 生成一个稳定、可读的故障 id：SEV-CODE-序号 */
function faultId(severity, code, n) {
  return `${severity}-${code}-${n}`
}

/** 把事件里可能很长的 text 截断，避免报告被单条工具返回撑爆。 */
function capText(text, cap) {
  const s = String(text ?? '')
  return s.length <= cap ? s : `${s.slice(0, cap)}…（+${s.length - cap}字）`
}

/**
 * 逐行解析 session.jsonl；坏行跳过（日志可能正在写、尾行可能半截）。
 * @returns {{events: object[], total: number, bad: number}}
 */
export function parseSessionJsonl(text) {
  const events = []
  let bad = 0
  let total = 0
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    total += 1
    try { events.push(JSON.parse(s)) } catch { bad += 1 }
  }
  return { events, total, bad }
}

/** 读 session.jsonl（容忍不存在）。 */
export function readSessionJsonl(file) {
  try {
    return parseSessionJsonl(fs.readFileSync(file, 'utf8'))
  } catch {
    return { events: [], total: 0, bad: 0 }
  }
}

/** 读 server_log.txt（DST 中文是 GBK，先按字节解）。 */
export function readServerLog(file) {
  try {
    const buf = fs.readFileSync(file)
    return decodeLogBytes(buf).split(/\r?\n/).filter((l) => l.length > 0)
  } catch {
    return []
  }
}

/** 事件时间戳（毫秒）。ISO 字符串或数字都兼容；拿不到返回 null。 */
function eventTime(ev) {
  if (!ev) return null
  const t = ev.t
  if (typeof t === 'number' && Number.isFinite(t)) return t
  if (typeof t === 'string') {
    const ms = Date.parse(t)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

/** 从事件里抽「动作尝试」：tool_result（AI 路径）与 result（桥/手动路径）统一。 */
export function extractAttempts(events) {
  const out = []
  events.forEach((ev, index) => {
    if (ev?.kind === 'tool_result') {
      out.push({
        source: 'tool_result',
        index,
        tool: ev.tool ?? null,
        status: ev.status ?? null,
        reason: ev.reason ?? null,
        ok: ev.ok !== false,
        text: ev.text ?? '',
        t: eventTime(ev),
        step: ev.step ?? null,
      })
    } else if (ev?.kind === 'result') {
      // 桥原始回执：没有 tool/status，退化为按 ok + text 判断
      out.push({
        source: 'result',
        index,
        tool: null,
        status: ev.ok === true ? 'succeeded' : 'failed',
        reason: null,
        ok: ev.ok === true,
        text: ev.text ?? '',
        t: eventTime(ev),
        step: null,
      })
    }
  })
  return out
}

/** 取最近一个位于 index 之前（含）的某类事件。 */
function latestBefore(events, index, kind) {
  for (let i = Math.min(index, events.length - 1); i >= 0; i -= 1) {
    if (events[i]?.kind === kind) return { event: events[i], index: i }
  }
  return null
}

/** 生成一条精简事件：按 kind 白名单保留排查必需字段，长文本截断，整体压到很小。 */
function compactEvent(ev, cap) {
  if (!ev || typeof ev !== 'object') return ev
  const k = ev.kind
  const t = ev.t
  if (k === 'state') {
    return {
      kind: k, t, day: ev.day, phase: ev.phase, hp: ev.hp, hunger: ev.hunger, sanity: ev.sanity,
      hand: ev.hand, inv: capText(ev.inv, 100), pos: ev.pos, dead: ev.dead, ghost: ev.ghost, age_ms: ev.age_ms,
      warnings: Array.isArray(ev.warnings) ? ev.warnings.slice(0, 3).map((w) => capText(w, 70)) : undefined,
    }
  }
  if (k === 'env') {
    return {
      kind: k, t, sid: ev.sid, pos: ev.pos, day: ev.day, phase: ev.phase,
      total_found: ev.total_found, total_returned: ev.total_returned, truncated: ev.truncated,
      lines: Array.isArray(ev.lines) ? ev.lines.slice(0, 6).map((l) => capText(l, 110)) : undefined,
    }
  }
  if (k === 'tool_result') return { kind: k, t, tool: ev.tool, status: ev.status, reason: ev.reason, ok: ev.ok, text: capText(ev.text, 260) }
  if (k === 'tool_call' || k === 'cmd') return { kind: k, t, action: ev.action, tool: ev.tool, args: ev.args }
  if (k === 'reflex' || k === 'death' || k === 'game_log') return { kind: k, t, line: capText(ev.line, 260) }
  const clone = { kind: k, t }
  if (typeof ev.text === 'string') clone.text = capText(ev.text, cap)
  if (typeof ev.line === 'string') clone.line = capText(ev.line, cap)
  return clone
}

/**
 * 体积预算：报告超过 maxBytes 时按「先砍上下文条数、再砍单条长度/冗余结构」逐级压缩，
 * 目标 2~5KB。绝不删除 faults 本身（那才是要修的线索）。
 */
export function shrinkToBudget(report, maxBytes = 5000) {
  // 按「落盘时的 pretty JSON」计量，否则 CLI 用 2 空格缩进写出会超出预算。
  const size = () => Buffer.byteLength(JSON.stringify(report, null, 2))
  if (size() <= maxBytes) return report
  for (const f of report.faults) {
    const evs = f.evidence?.events
    if (Array.isArray(evs) && evs.length > 6) f.evidence.events = [...evs.slice(0, 3), ...evs.slice(-3)]
    if (Array.isArray(f.detail)) f.detail = f.detail.slice(0, 3).map((d) => capText(d, 260))
    else if (typeof f.detail === 'string') f.detail = capText(f.detail, 360)
  }
  if (size() <= maxBytes) return report
  for (const f of report.faults) {
    const evs = f.evidence?.events
    if (Array.isArray(evs) && evs.length > 4) f.evidence.events = [...evs.slice(0, 2), ...evs.slice(-2)]
    if (Array.isArray(f.evidence?.server_log)) f.evidence.server_log = f.evidence.server_log.slice(0, 8).map((l) => capText(l, 200))
    if (f.evidence?.state) f.evidence.state = { kind: 'state', t: f.evidence.state.t, day: f.evidence.state.day, phase: f.evidence.state.phase, hp: f.evidence.state.hp, dead: f.evidence.state.dead, ghost: f.evidence.state.ghost }
    if (f.evidence?.env) f.evidence.env = { kind: 'env', t: f.evidence.env.t, sid: f.evidence.env.sid, pos: f.evidence.env.pos, total_found: f.evidence.env.total_found, total_returned: f.evidence.env.total_returned }
  }
  if (size() <= maxBytes) return report
  // pass3 兜底：再压到每条故障仅留 2 条上下文、detail 更短
  for (const f of report.faults) {
    const evs = f.evidence?.events
    if (Array.isArray(evs) && evs.length > 2) f.evidence.events = [evs[0], evs[evs.length - 1]]
    if (typeof f.detail === 'string') f.detail = capText(f.detail, 200)
  }
  if (size() <= maxBytes) return report
  // pass4 终极兜底：删冗余结构（meta/health 与 summary 重复，window 可从 events 推出）
  delete report.meta
  delete report.health
  for (const f of report.faults) if (f.evidence) delete f.evidence.window
  return report
}

/** 以 index 为中心截取上下文窗口 + 当时最近的一份 STATE / ENV。 */
function buildEvidence(events, index, opts) {
  const from = Math.max(0, index - opts.contextRadius)
  const to = Math.min(events.length - 1, index + opts.contextRadius)
  const window = []
  for (let i = from; i <= to; i += 1) window.push(compactEvent(events[i], opts.contextTextCap))
  const state = latestBefore(events, index, 'state')
  const env = latestBefore(events, index, 'env')
  return {
    window: { from, to, count: window.length },
    events: window,
    state: state ? compactEvent(state.event, opts.contextTextCap) : null,
    env: env ? compactEvent(env.event, opts.contextTextCap) : null,
  }
}

/** 检测 S0 崩溃：server_log 里的 Lua 错误 / 堆栈。 */
function detectCrashes(serverLines, opts) {
  const hits = []
  for (let i = 0; i < serverLines.length; i += 1) {
    if (CRASH_RE.test(serverLines[i])) hits.push(i)
  }
  if (hits.length === 0) return []
  const first = hits[0]
  const from = Math.max(0, first - opts.contextRadius)
  const to = Math.min(serverLines.length - 1, first + opts.contextRadius)
  const context = serverLines.slice(from, to + 1).map((l) => capText(l, opts.contextTextCap))
  return [{
    id: faultId('S0', 'crash', 1),
    severity: 'S0',
    code: 'crash',
    title: `游戏端 Lua 报错 / 堆栈（${hits.length} 处命中）`,
    detail: hits.slice(0, 5).map((i) => capText(serverLines[i], 300)),
    evidence: {
      window: { from, to, count: context.length },
      server_log: context,
      match_count: hits.length,
    },
  }]
}

/** 检测 S0 死亡：DEATH 事件或 STATE dead/ghost。 */
function detectDeath(events, opts) {
  let idx = -1
  let line = ''
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]
    if (ev?.kind === 'death') { idx = i; line = ev.line ?? ''; break }
    if (ev?.kind === 'state' && (ev.dead === true || ev.ghost === true)) {
      idx = i; line = `STATE dead=${ev.dead} ghost=${ev.ghost} hp=${ev.hp}`; break
    }
  }
  if (idx < 0) return []
  return [{
    id: faultId('S0', 'death', 1),
    severity: 'S0',
    code: 'death',
    title: '角色死亡 / 变鬼',
    detail: capText(line, 300),
    evidence: buildEvidence(events, idx, opts),
  }]
}

/** 动作尝试的「失败指纹」：tool（或 result 用 text 摘要）+ reason/status。 */
function failureKey(attempt) {
  const tool = attempt.tool || 'action'
  const reason = attempt.reason || attempt.status || 'failed'
  return `${tool}|${reason}`
}

/** 检测 S1 卡死：连续相同失败、idle_give_up、result_timeout、unknown 终态。 */
function detectLoops(events, opts) {
  // 只用带 tool + reason/status 的 tool_result 做「失败指纹」。
  // 桥原始 result 回执没有 tool/reason，多个不同动作失败会被归一成同一个 key → 误报死循环，
  // 因此 result 回执不参与死循环/终态判定（宁可漏报也不误报），只参与 unverified/里程碑统计。
  const attempts = extractAttempts(events).filter((a) => a.source === 'tool_result' && (a.reason || a.status))
  const faults = []

  // 1) 连续 >= loopConsecutive 次相同失败指纹
  let run = []
  let runKey = null
  const flush = () => {
    if (run.length >= opts.loopConsecutive) {
      const trigger = run[run.length - 1].index
      faults.push({
        id: faultId('S1', 'loop', faults.length + 1),
        severity: 'S1',
        code: 'loop',
        title: `死循环：连续 ${run.length} 次相同失败（${runKey}）`,
        detail: `${run[0].tool || 'action'} 以相同 reason 连续失败 ${run.length} 次，起点事件 #${run[0].index}。`,
        evidence: buildEvidence(events, trigger, opts),
      })
    }
    run = []
    runKey = null
  }
  for (const a of attempts) {
    const failed = a.ok === false || (a.status != null && a.status !== 'succeeded' && a.status !== 'ok')
    if (!failed) { flush(); continue }
    const key = failureKey(a)
    if (key === runKey) run.push(a)
    else { flush(); runKey = key; run = [a] }
  }
  flush()

  // 2) 明确的终态故障（单次即报）
  attempts.forEach((a) => {
    const reason = String(a.reason ?? '').toLowerCase()
    const status = String(a.status ?? '').toLowerCase()
    const text = String(a.text ?? '').toLowerCase()
    const isIdle = reason === 'idle_give_up' || text.includes('idle_give_up')
    const isTimeout = reason === 'result_timeout' || status === 'timeout'
    const isUnknown = status === 'unknown' || reason === 'unknown'
    // 已作为连续 loop 报过的，避免重复；这里只补单点终态
    if (!isIdle && !isTimeout && !isUnknown) return
    const code = isIdle ? 'idle_give_up' : isTimeout ? 'result_timeout' : 'unknown'
    faults.push({
      id: faultId('S1', code, faults.length + 1),
      severity: 'S1',
      code,
      title: { idle_give_up: 'AI 放弃（idle_give_up）', result_timeout: '动作结果超时（result_timeout）', unknown: '动作落入未知终态（unknown）' }[code],
      detail: `事件 #${a.index}：tool=${a.tool || '-'} status=${a.status || '-'} reason=${a.reason || '-'}`,
      evidence: buildEvidence(events, a.index, opts),
    })
  })

  return faults
}

/** 检测 S1 状态失真：STATE 断档 > staleMs；unverified 占比过高；REFLEX 与 ENV 矛盾。 */
function detectStateDistortion(events, opts) {
  const faults = []

  // 1) STATE 断档
  // 注意：记录器对 STATE 有「30s 去重保活」，所以**相邻 STATE 事件间隔**天然可能是 30s，
  // 拿它判 stale 会误报。真正的「新鲜度」是每份 state 自带的 age_ms（= 距状态文件 mtime）。
  // 因此优先用 age_ms；只有在整份日志都没有 age_ms（老格式/手造 fixture）时才退回事件间隔。
  const stateIdx = []
  events.forEach((ev, i) => { if (ev?.kind === 'state') stateIdx.push(i) })
  let worstGap = 0
  let worstIdx = -1
  let hasAgeMs = false
  for (const i of stateIdx) {
    const age = Number(events[i]?.age_ms)
    if (Number.isFinite(age)) {
      hasAgeMs = true
      if (age > worstGap) { worstGap = age; worstIdx = i }
    }
  }
  if (!hasAgeMs) {
    for (let k = 1; k < stateIdx.length; k += 1) {
      const a = eventTime(events[stateIdx[k - 1]])
      const b = eventTime(events[stateIdx[k]])
      if (a == null || b == null) continue
      const gap = b - a
      if (gap > worstGap) { worstGap = gap; worstIdx = stateIdx[k] }
    }
  }
  if (worstIdx >= 0 && worstGap > opts.staleMs) {
    faults.push({
      id: faultId('S1', 'state_stale', 1),
      severity: 'S1',
      code: 'state_stale',
      title: `STATE 超过 ${Math.round(opts.staleMs / 1000)} 秒未更新（实测 ${Math.round(worstGap / 1000)}s）`,
      detail: `${hasAgeMs ? '状态文件新鲜度' : '状态采样间隔'} ${worstGap}ms，超过阈值 ${opts.staleMs}ms（事件 #${worstIdx}）。`,
      evidence: buildEvidence(events, worstIdx, opts),
    })
  }

  // 2) unverified 占比
  const attempts = extractAttempts(events).filter((a) => a.status != null)
  if (attempts.length > 0) {
    const unverified = attempts.filter((a) => String(a.status).toLowerCase() === 'unverified')
    const rate = unverified.length / attempts.length
    if (rate > opts.unverifiedRateThreshold) {
      const idx = unverified.length ? unverified[unverified.length - 1].index : 0
      faults.push({
        id: faultId('S1', 'unverified_rate', 1),
        severity: 'S1',
        code: 'unverified_rate',
        title: `unverified 占比过高（${(rate * 100).toFixed(1)}% > ${(opts.unverifiedRateThreshold * 100).toFixed(0)}%）`,
        detail: `${unverified.length}/${attempts.length} 次动作未能核实结果。`,
        evidence: buildEvidence(events, idx, opts),
      })
    }
  }

  // 3) REFLEX 报缺料但 ENV 里明明在范围内（启发式，按需开启）
  if (opts.enableReflexEnvCheck) {
    const envIdx = []
    events.forEach((ev, i) => { if (ev?.kind === 'env') envIdx.push(i) })
    events.forEach((ev, i) => {
      if (ev?.kind !== 'reflex') return
      const line = String(ev.line ?? '')
      if (!/缺|没有|没找到|missing|no such|not found/i.test(line)) return
      const prefab = matchReferencedPrefab(line)
      if (!prefab) return
      // 找 i 之后 15 秒内最近的 ENV，看它是否包含该 prefab
      const near = nearestEnvWithin(events, envIdx, i, opts.staleMs)
      if (!near) return
      const hay = envText(events[near])
      if (!hay.includes(prefab)) return
      faults.push({
        id: faultId('S1', 'reflex_env_contradiction', faults.length + 1),
        severity: 'S1',
        code: 'reflex_env_contradiction',
        title: `REFLEX 报缺「${prefab}」，但 ENV 显示范围内存在`,
        detail: capText(line, 300),
        evidence: buildEvidence(events, near, opts),
      })
    })
  }

  return faults
}

/** REFLEX 文本里提到的、我们认识的 prefab 关键字。返回规范 prefab 名或 null。 */
const PREFAB_SYNONYMS = [
  ['gold_vein', ['gold_vein', '金矿', 'gold']],
  ['flint', ['flint', '燧石']],
  ['twigs', ['twigs', '树苗', '树枝']],
  ['grass', ['grass', '草', '草丛']],
  ['berries', ['berries', 'berry', '浆果']],
  ['rocks', ['rock', '石头', 'ordinary_rock']],
  ['log', ['log', '木头', 'wood']],
]
export function matchReferencedPrefab(text) {
  const s = String(text ?? '').toLowerCase()
  for (const [canon, words] of PREFAB_SYNONYMS) {
    if (words.some((w) => s.includes(w.toLowerCase()))) return canon
  }
  return null
}

/** 在 events 里从 i 往后找时间差 <= windowMs 的最近一个 ENV 事件下标。 */
function nearestEnvWithin(events, envIdx, i, windowMs) {
  const t0 = eventTime(events[i]) ?? 0
  for (const j of envIdx) {
    if (j < i) continue
    const tj = eventTime(events[j]) ?? 0
    if (tj - t0 <= windowMs) return j
    break
  }
  return null
}

/** ENV 事件的文本化（lines + nearby buckets 里的 prefab 名）。 */
function envText(ev) {
  const parts = []
  if (Array.isArray(ev?.lines)) parts.push(...ev.lines)
  const buckets = ev?.nearby?.buckets
  if (buckets && typeof buckets === 'object') {
    for (const arr of Object.values(buckets)) {
      if (Array.isArray(arr)) for (const it of arr) if (it?.prefab) parts.push(String(it.prefab))
    }
  }
  return parts.join('\n').toLowerCase()
}

/** 里程碑识别：从事件流里推断「做出火把 / 造出科学机器 / 活过第一夜」。 */
export function detectMilestones(events) {
  let torch = false
  let sciencemachine = false
  let surviveNight1 = false
  let maxDay = 0
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]
    if (ev?.kind === 'state') {
      const d = Number(ev.day)
      if (Number.isFinite(d) && d > maxDay) maxDay = d
      if (d >= 2) surviveNight1 = true
      if (String(ev.hand ?? '').toLowerCase() === 'torch') torch = true
      if (typeof ev.inv === 'string' && /\btorch\b/i.test(ev.inv)) {
        torch = true
      } else if (Array.isArray(ev.inv)) {
        if (ev.inv.some((it) => String(it?.prefab ?? it ?? '').toLowerCase() === 'torch')) torch = true
      }
    }
    if (ev?.kind === 'env') {
      const structs = ev.nearby?.buckets?.structures
      const structList = Array.isArray(structs) ? structs : (structs && typeof structs === 'object' ? Object.values(structs) : [])
      if (structList.some((s) => {
        const p = String(s?.prefab ?? '').toLowerCase()
        return p === 'researchlab' || p === 'sciencemachine'
      })) {
        sciencemachine = true
      }
      if (Array.isArray(ev.lines) && ev.lines.some((l) => /\bresearchlab\b|sciencemachine|科学机器/i.test(String(l)))) {
        sciencemachine = true
      }
    }
    if (ev?.kind === 'tool_call' || ev?.kind === 'cmd') {
      const action = String(ev.action ?? ev.tool ?? '')
      const args = ev.args ?? {}
      const recipe = String(args.recipe ?? args.prefab ?? args.item ?? '').toLowerCase()
      const isCraft = /craft|build|make/.test(action)
      if (isCraft && /torch/.test(recipe)) {
        // 需要「同一个动作」的成功回执才算数（按 id/seq 精确匹配，避免串到别的动作）
        if (nextSuccess(events, i, ev.id, ev.seq)) torch = true
      }
      if (isCraft && /sciencemachine|science_machine|science machine/.test(recipe)) {
        if (nextSuccess(events, i, ev.id, ev.seq)) sciencemachine = true
      }
    }
  }
  return { torch, sciencemachine, surviveNight1, maxDay }
}

/**
 * 从 index 往后找 6 条内「同一个动作」的成功回执。
 * 有 id（cmd 路径）就要求 result.id 相等；有 seq（tool_call 路径）就要求 tool_result.seq 相等。
 */
function nextSuccess(events, index, id, seq) {
  for (let i = index + 1; i < Math.min(events.length, index + 7); i += 1) {
    const ev = events[i]
    if (ev?.kind === 'tool_result' && ev.ok === true && (ev.status == null || ev.status === 'succeeded')) {
      if (seq == null || ev.seq === seq) return true
      continue
    }
    if (ev?.kind === 'result' && ev.ok === true) {
      if (id == null || ev.id === id) return true
    }
  }
  return false
}

/** 检测 S2 目标未达：跑满步数预算却仍缺必达里程碑。 */
function detectUnmetGoals(events, milestones, opts) {
  const attempts = extractAttempts(events)
  let maxStep = attempts.length
  for (const ev of events) {
    if (ev?.kind === 'ai_turn' && Number.isFinite(Number(ev.step))) maxStep = Math.max(maxStep, Number(ev.step))
  }
  if (maxStep < opts.budgetSteps) return []
  const missing = opts.requiredMilestones.filter((m) => !milestones[m])
  if (missing.length === 0) return []
  const idx = Math.max(0, events.length - 1)
  const label = { torch: '做出火把', sciencemachine: '造出科学机器', surviveNight1: '活过第一夜' }
  return [{
    id: faultId('S2', 'goal_missed', 1),
    severity: 'S2',
    code: 'goal_missed',
    title: `跑满 ${maxStep} 步仍未达成目标：${missing.map((m) => label[m]).join('、')}`,
    detail: `步数预算 ${opts.budgetSteps} 已用尽，缺失里程碑：${missing.join(', ')}。`,
    evidence: buildEvidence(events, idx, opts),
  }]
}

/** 计算健康分（越大越好）。 */
export function computeHealthScore({ survivedDays = 0, milestones = {}, luaErrors = 0, loops = 0, unverifiedRate = 0 }, opts = DEFAULT_OPTS) {
  const weights = opts.milestoneWeights ?? DEFAULT_OPTS.milestoneWeights
  let milestoneScore = 0
  for (const [k, w] of Object.entries(weights)) if (milestones[k]) milestoneScore += w
  return Math.round(
    survivedDays * 100
    + milestoneScore
    - luaErrors * 500
    - loops * 100
    - unverifiedRate * 50,
  )
}

/**
 * 核心：分析一次会话，产出 issue-report 对象（纯函数）。
 * @param {{events?: object[], serverLog?: string[]}} input
 * @param {object} [opts] 覆盖 DEFAULT_OPTS
 */
export function analyzeSession(input = {}, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts }
  const events = Array.isArray(input.events) ? input.events : []
  const serverLog = Array.isArray(input.serverLog) ? input.serverLog : []

  const crashes = detectCrashes(serverLog, o)
  const deaths = detectDeath(events, o)
  const loops = detectLoops(events, o)
  const distortion = detectStateDistortion(events, o)
  const milestones = detectMilestones(events)
  const goals = detectUnmetGoals(events, milestones, o)

  const faults = [...crashes, ...deaths, ...loops, ...distortion, ...goals]

  const attempts = extractAttempts(events).filter((a) => a.status != null)
  const unverified = attempts.filter((a) => String(a.status).toLowerCase() === 'unverified').length
  const unverifiedRate = attempts.length ? unverified / attempts.length : 0

  const luaErrors = crashes.reduce((n, f) => n + (f.evidence?.match_count ?? 0), 0)
  const loopCount = loops.filter((f) => f.code === 'loop').length
  const score = computeHealthScore({
    survivedDays: milestones.maxDay,
    milestones,
    luaErrors,
    loops: loopCount,
    unverifiedRate,
  }, o)

  const countBy = (sev) => faults.filter((f) => f.severity === sev).length
  const s0 = countBy('S0')
  const s1 = countBy('S1')
  const s2 = countBy('S2')

  const kinds = {}
  let firstT = null
  let lastT = null
  for (const ev of events) {
    const k = ev?.kind ?? 'unknown'
    kinds[k] = (kinds[k] ?? 0) + 1
    const t = eventTime(ev)
    if (t != null) { if (firstT == null) firstT = t; lastT = t }
  }

  const steps = Math.max(attempts.length, ...events.filter((e) => e?.kind === 'ai_turn').map((e) => Number(e.step) || 0), 0)

  const result = {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    summary: {
      criticalCount: s0 + s1, // 只有 S0/S1 算「严重故障」，S2 是目标未达
      s0,
      s1,
      s2,
      faults: faults.length,
      score,
      survivedDays: milestones.maxDay,
      milestones,
      unverifiedRate: Number(unverifiedRate.toFixed(3)),
      steps,
      eventCount: events.length,
      serverLogLines: serverLog.length,
    },
    faults,
    health: { survivedDays: milestones.maxDay, milestones, luaErrors, loops: loopCount, unverifiedRate: Number(unverifiedRate.toFixed(3)), score },
    meta: {
      eventCount: events.length,
      kinds,
      firstT: firstT == null ? null : new Date(firstT).toISOString(),
      lastT: lastT == null ? null : new Date(lastT).toISOString(),
      mod: firstByKind(events, 'state')?.mod ?? null,
      day: firstByKind(events, 'state')?.day ?? null,
      phase: firstByKind(events, 'state')?.phase ?? null,
    },
  }
  const budget = o.maxReportBytes === 0 ? 0 : (o.maxReportBytes ?? 5000)
  return budget > 0 ? shrinkToBudget(result, budget) : result
}

function firstByKind(events, kind) {
  for (const ev of events) if (ev?.kind === kind) return ev
  return null
}

/** 便捷：直接分析一个 latestLogs 目录（session.jsonl + server_log.txt）。 */
export function analyzeDirectory(dir, opts = {}) {
  const { events } = readSessionJsonl(path.join(dir, 'session.jsonl'))
  const serverLog = readServerLog(path.join(dir, 'server_log.txt'))
  return analyzeSession({ events, serverLog }, opts)
}

/** 人眼摘要（CLI / 主控日志用）。 */
export function renderSummary(report) {
  const s = report.summary
  const lines = []
  lines.push(`issue-report: ${s.faults} 故障（S0=${s.s0} S1=${s.s1} S2=${s.s2}），严重=${s.criticalCount}，健康分=${s.score}`)
  lines.push(`  事件=${s.eventCount} 步数=${s.steps} 存活天数=${s.survivedDays} 里程碑=${JSON.stringify(s.milestones)} unverified率=${(s.unverifiedRate * 100).toFixed(1)}%`)
  if (report.faults.length === 0) lines.push('  ✅ 无故障')
  for (const f of report.faults) lines.push(`  [${f.severity}] ${f.code}: ${f.title}`)
  return lines.join('\n')
}
