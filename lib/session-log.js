// 会话日志（插件内置）：把「AI 下了什么操作 / 游戏回了什么 / 角色周边是什么 / 反射做了什么 /
// 状态变成什么」汇成一条时间线，写进插件目录下的 latestLogs/。
//
// 设计边界（重要）：
//   · **只读游戏侧**：不写桥文件、不下指令、不改文件桥协议、不加游戏工具。
//   · **不依赖 DSH/模型**：直接读 whale_cmd.json / whale_result.json / whale_state.json /
//     server_log.txt / server_chat_log*.txt，任何入口（MCP、F8、手写命令）都记得到。
//     AI 主动下发的操作（含 get_state 这类只读动作）走 beginTool/endTool，由 lib/index.js
//     在 runTool 里统一调用 —— 那条路径不写桥文件，只能这样记。
//   · **覆盖写，不是增量累积**：每次启动 / 每个新会话开始时把 session.txt、session.jsonl
//     清空重写，server_log.txt 覆盖复制。latestLogs/ 永远只保留「最新一次」的记录。
//     （同一次会话内部是 append，否则每条事件都要重写整个文件。）
//   · 日志按字节增量读（中文可能跨两次读取），文件被截断/轮转会自动重来；
//     同一条命令/回执按 id 去重。
//   · 工具返回是**整段**留下的（这是排查问题的日志，截掉尾巴等于把线索丢了），
//     只用一个很宽的 textCap（默认 20000 字）兜底，防止某次异常巨大的返回把文件撑爆；
//     真触发时事件里会标 truncated 和原始字数。
//
// tools/session-recorder.mjs 只是这个模块的 CLI 薄封装，保持 `npm run record` 与单测可用。

import fs from 'node:fs'
import path from 'node:path'
import { nearbyLines } from './state/snapshot.js'

const KLEI = /^KLEI\s+\d+\s*/
export const stripKlei = (text) => String(text ?? '').replace(KLEI, '')

/**
 * 日志编码兜底：DST 的 server_log.txt 中文是 GBK，chat log 是 UTF-8。
 * 先按 UTF-8 解；出现替换符（U+FFFD）说明不是 UTF-8，改用 GBK 再解一次。
 */
export function decodeLogBytes(buf) {
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try { return new TextDecoder('gbk', { fatal: false }).decode(buf) }
  catch { return utf8 }
}

export const DEFAULT_LOG_RE = /\[Reflex\]|Death Announcement|Resurrect|Spawn request|Loading mod:|Overriding mod|Server Auto|Sim unpaused|Sim paused|Deleting user|Serializing world|Lua error|stack traceback|WARNING|warning/i

/**
 * 工具返回写进日志前最多留多少字符。
 * 定得比较宽（20000）：这是排查问题的日志，`get_state format=json` 带 40 个附近物件时
 * 就有好几千字，截掉尾巴正好把要看的东西丢了。这个值只是防止某次返回异常巨大把文件撑爆。
 */
export const DEFAULT_TEXT_CAP = 20000

/** .txt 里续行（工具返回、附近环境）的前缀：跟首行 8 位时间戳一样宽，续行的 | 就能和首行对齐。 */
const CONT = ' '.repeat(8)

/** 按 cap 截断，返回 { text, chars, truncated }；chars 是截断前的原始长度。 */
export function capText(text, cap = DEFAULT_TEXT_CAP) {
  const s = String(text ?? '')
  if (!(cap > 0) || s.length <= cap) return { text: s, chars: s.length, truncated: false }
  return { text: s.slice(0, cap), chars: s.length, truncated: true }
}

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[name] = true
    else { out[name] = next; i += 1 }
  }
  return out
}

function short(value) { return value == null ? '-' : String(value) }

export function eventsToText(event) {
  // t 恒为 ISO 字符串（见 _emit）；防御性兜底，避免非字符串再次让写盘整体失败
  const stamp = String(event?.t ?? '')
  const head = stamp.length >= 19 ? stamp.slice(11, 19) : stamp
  switch (event?.kind) {
    case 'cmd':
      return `${head} | CMD    | ${short(event.action)} id=${short(event.id)} args=${JSON.stringify(event.args ?? {})} by=${short(event.requested_by)}${event.initial ? ' (initial)' : ''}`
    case 'result':
      return `${head} | RESULT | ok=${event.ok} id=${short(event.id)} text=${short(event.text)}${event.initial ? ' (initial)' : ''}`
    case 'state':
      return `${head} | STATE  | mod=${short(event.mod)} day=${short(event.day)} phase=${short(event.phase)} hp=${short(event.hp)} hunger=${short(event.hunger)} sanity=${short(event.sanity)} hand=${short(event.hand)} inv=[${short(event.inv)}] pos=${short(event.pos)} ghost=${event.ghost} dead=${event.dead} age=${short(event.age_ms)}ms`
    // AI 回合：记录当前步骤与输入上下文
    case 'ai_turn': {
      const stepPart = event.step != null ? ` #${short(event.step)}` : ''
      const envPart = (event.day != null || event.phase != null)
        ? ` [${short(event.phase ?? '未知')} 第${short(event.day ?? '?')}天]`
        : ''
      const lead = `${head} | TURN   |${stepPart}${envPart}${event.observeReason ? ` reason=${short(event.observeReason)}` : ''}`
      const lines = [lead]
      if (event.plan) lines.push(`${CONT} | 当前计划：${short(event.plan)}`)
      if (event.inv) lines.push(`${CONT} | 已知背包：${short(event.inv)}`)
      if (event.preview) lines.push(`${CONT} | 提示摘要：${short(event.preview)}`)
      return lines.join('\n')
    }
    // AI 思考：记录模型深度思考过程、文字回复与耗时
    case 'ai_thought': {
      const stepPart = event.step != null ? ` #${short(event.step)}` : ''
      const meta = [
        event.latencyMs != null ? `耗时=${short(event.latencyMs)}ms` : null,
        event.model ? `模型=${short(event.model)}` : null,
        event.tokens != null ? `tokens=${short(event.tokens)}` : null,
        Array.isArray(event.toolCalls) ? `动作数=${event.toolCalls.length}` : null,
      ].filter(Boolean).join(' ')
      const lead = `${head} | THINK  |${stepPart}${meta ? ' ' + meta : ''}`
      const lines = [lead]
      if (event.thought) {
        const thoughtLines = String(event.thought).split(/\r?\n/).map((l) => `${CONT} | [思考] ${l}`)
        lines.push(...thoughtLines)
      }
      if (event.content) {
        const contentLines = String(event.content).split(/\r?\n/).map((l) => `${CONT} | [回复] ${l}`)
        lines.push(...contentLines)
      }
      return lines.join('\n')
    }
    // AI 下的操作（call=刚要下发，done=拿到结果；带可选的 step 关联）
    case 'tool_call': {
      const stepPart = event.step != null ? ` [S${short(event.step)}]` : ''
      return `${head} | CALL   | #${short(event.seq)}${stepPart} ${short(event.tool)} args=${JSON.stringify(event.args ?? {})} by=${short(event.by)}${event.internal ? ' (内置AI)' : ''}`
    }
    // 返回内容按原样分行写出来（续行不带时间戳），人眼看 txt 时不用去解 \n 转义
    case 'tool_result': {
      const stepPart = event.step != null ? ` [S${short(event.step)}]` : ''
      const flags = [
        event.ok ? 'ok' : 'FAIL',
        event.status ? `status=${short(event.status)}` : null,
        event.reason ? `reason=${short(event.reason)}` : null,
        `${short(event.ms)}ms`,
        `${short(event.chars)}字${event.truncated ? '（超长已截断）' : ''}`,
      ].filter(Boolean).join(' ')
      const title = `${head} | DONE   | #${short(event.seq)}${stepPart} ${short(event.tool)} ${flags}`
      const body = String(event.text ?? '').split(/\r?\n/).map((line) => `${CONT} | ${line}`)
      return [title, ...body].join('\n')
    }
    // 角色周边环境（附近快照换帧时记一次）
    case 'env': {
      const lead = `${head} | ENV    | 帧=${short(event.sid)} day=${short(event.day)} phase=${short(event.phase)} pos=(${short(event.pos)})`
        + ` hp=${short(event.hp)} hunger=${short(event.hunger)} sanity=${short(event.sanity)}`
        + ` 半径=${short(event.radius)} 共=${short(event.total_returned)}/${short(event.total_found)}${event.truncated ? '(截断)' : ''}`
      const body = (Array.isArray(event.lines) ? event.lines : []).map((line) => `${CONT} | ${line}`)
      return [lead, ...body].join('\n')
    }
    case 'reflex':
      return `${head} | REFLEX | ${short(event.line)}`
    case 'death':
      return `${head} | DEATH  | ${short(event.line)}`
    case 'game_log':
      return `${head} | LOG    | [${short(event.source)}] ${short(event.line)}`
    case 'note':
      return `${head} | NOTE   | ${short(event.text)}`
    default:
      return `${head} | ${short(event?.kind)} | ${JSON.stringify(event)}`
  }
}

export class SessionRecorder {
  /**
   * @param {object} opts
   * @param {string} opts.bridgeDir  whale_*.json 所在目录
   * @param {string} [opts.serverLog] server_log.txt
   * @param {string} [opts.chat] 聊天日志文件或其所在目录
   * @param {string} [opts.out] 输出 .jsonl 路径（同时写同名 .txt）
   * @param {number} [opts.stateEveryMs] 状态采样间隔
   * @param {number} [opts.envEveryMs] 周边环境检查间隔（只在附近快照换帧时记一次）
   * @param {number} [opts.textCap] 工具返回最多写多少字符
   * @param {boolean} [opts.fromStart] 是否连历史日志一起收
   * @param {RegExp} [opts.logRe] 只收匹配的服务端日志行
   */
  constructor(opts = {}) {
    this.bridgeDir = opts.bridgeDir || process.cwd()
    this.cmdFile = opts.cmdFile || path.join(this.bridgeDir, 'whale_cmd.json')
    this.resultFile = opts.resultFile || path.join(this.bridgeDir, 'whale_result.json')
    this.stateFile = opts.stateFile || path.join(this.bridgeDir, 'whale_state.json')
    this.serverLog = opts.serverLog || path.join(path.dirname(this.bridgeDir), 'server_log.txt')
    this.chatFiles = []
    if (opts.chat) {
      try {
        if (fs.statSync(opts.chat).isDirectory()) {
          for (const name of fs.readdirSync(opts.chat)) {
            if (name.endsWith('.txt')) this.chatFiles.push(path.join(opts.chat, name))
          }
          const parentLog = path.join(opts.chat, '..', 'server_chat_log.txt')
          if (fs.existsSync(parentLog)) this.chatFiles.push(parentLog)
        } else this.chatFiles.push(opts.chat)
      } catch { /* 目录还不存在，忽略 */ }
    }
    this.out = opts.out || path.join('.runtime', 'session-record.jsonl')
    this.txtOut = this.out.replace(/\.jsonl$/i, '') + '.txt'
    this.stateEveryMs = opts.stateEveryMs ?? 5000
    this.envEveryMs = opts.envEveryMs ?? 1000
    this.stateThrottleMs = opts.stateThrottleMs ?? 30000
    this.textCap = opts.textCap ?? DEFAULT_TEXT_CAP
    this.logRe = opts.logRe || DEFAULT_LOG_RE
    this.fromStart = opts.fromStart === true

    this.events = []
    this.seenCmd = new Set()
    this.seenResult = new Set()
    this.offsets = new Map()
    this.partials = new Map()
    this.lastStateAt = 0
    this.lastStateSig = null
    this.lastStateEmittedAt = 0
    this.lastEnvAt = 0
    this.lastEnvMtime = null
    this.lastEnvSig = null
    this.callSeq = 0
    this.firstScan = true
    this.archivedReasons = new Set()
  }

  /** 切换数据源（玩家重进/换分片时用），不动输出文件。 */
  setSources({ bridgeDir, serverLog, chat } = {}) {
    if (bridgeDir) {
      this.bridgeDir = bridgeDir
      this.cmdFile = path.join(bridgeDir, 'whale_cmd.json')
      this.resultFile = path.join(bridgeDir, 'whale_result.json')
      this.stateFile = path.join(bridgeDir, 'whale_state.json')
      this.serverLog = serverLog || path.join(path.dirname(bridgeDir), 'server_log.txt')
    }
    if (serverLog) this.serverLog = serverLog
    if (chat) {
      this.chatFiles = []
      try {
        if (fs.statSync(chat).isDirectory()) {
          for (const name of fs.readdirSync(chat)) {
            if (name.endsWith('.txt')) this.chatFiles.push(path.join(chat, name))
          }
        } else this.chatFiles.push(chat)
      } catch { /* ignore */ }
    }
  }

  _emit(event) {
    // ★ t 恒为 ISO 字符串：事件里若带数字时间戳（result 的 res.t），重命名为 game_t，
    //   绝不能覆盖 t —— 否则 eventsToText 的 t.slice(11,19) 会抛错、整条事件写盘失败。
    const full = { ...event, t: new Date().toISOString() }
    this.events.push(full)
    if (this.out) {
      try {
        fs.mkdirSync(path.dirname(this.out), { recursive: true })
        fs.appendFileSync(this.out, JSON.stringify(full) + '\n')
        fs.appendFileSync(this.txtOut, eventsToText(full) + '\n')
      } catch (e) {
        process.stderr.write(`[session-log] 写盘失败：${e.message}\n`)
      }
    }
    return full
  }

  _readJson(file) {
    try { return JSON.parse(stripKlei(fs.readFileSync(file, 'utf8'))) }
    catch { return null }
  }

  /** 增量读日志文件；按字节处理（中文可能跨两次读取），处理截断/轮转，保留半截字节。 */
  _tail(file) {
    let size
    try { size = fs.statSync(file).size } catch { return [] }
    let offset = this.offsets.get(file)
    if (offset === undefined) {
      offset = this.fromStart ? 0 : size
      this.offsets.set(file, offset)
    }
    if (size < offset) { offset = 0; this.partials.set(file, Buffer.alloc(0)) }
    if (size === offset) return []
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(size - offset)
    let read = 0
    try { read = fs.readSync(fd, buf, 0, buf.length, offset) } finally { fs.closeSync(fd) }
    this.offsets.set(file, size)

    const prev = this.partials.get(file) || Buffer.alloc(0)
    const all = Buffer.concat([prev, buf.subarray(0, read)])
    const end = all.lastIndexOf(0x0a)
    if (end < 0) { this.partials.set(file, all); return [] }
    this.partials.set(file, all.subarray(end + 1))
    return decodeLogBytes(all.subarray(0, end))
      .split(/\r?\n/)
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.length > 0)
  }

  _scanCmdResult() {
    const cmd = this._readJson(this.cmdFile)
    if (cmd && cmd.id && !this.seenCmd.has(cmd.id)) {
      this.seenCmd.add(cmd.id)
      this._emit({
        kind: 'cmd',
        id: cmd.id,
        action: cmd.action ?? cmd.name ?? null,
        args: cmd.args ?? {},
        requested_by: cmd.requested_by ?? cmd.owner_type ?? null,
        game_t: cmd.ts ?? null,
        initial: this.firstScan,
      })
    }
    const res = this._readJson(this.resultFile)
    if (res && res.id && !this.seenResult.has(`${res.id}:${res.ok}:${res.text}`)) {
      this.seenResult.add(`${res.id}:${res.ok}:${res.text}`)
      this._emit({
        kind: 'result',
        id: res.id,
        ok: res.ok === true,
        text: res.text ?? null,
        game_t: res.t ?? null,
        initial: this.firstScan,
      })
    }
  }

  _scanState() {
    const now = Date.now()
    if (now - this.lastStateAt < this.stateEveryMs) return
    this.lastStateAt = now
    const raw = this._readJson(this.stateFile)
    if (!raw) return
    const d = raw.data || {}
    const p = d.player || {}
    const w = d.world || {}
    const invRaw = p.inventory && p.inventory.items
    const inv = Array.isArray(invRaw) ? invRaw : Object.values(invRaw || {})
    const items = inv.map((i) => `${i?.prefab ?? '?'}:${i?.count ?? 1}${i?.percent != null ? `(${i.percent}%)` : ''}`).join(',')
    const slots = (p.equipment && p.equipment.slots) || {}
    const hand = slots.hands ? (slots.hands.prefab ?? slots.hands) : null
    let age = null
    try { age = Date.now() - fs.statSync(this.stateFile).mtimeMs } catch { /* ignore */ }

    const warnings = Array.isArray(d.warnings) ? d.warnings.map(String) : []
    const hpStr = p.health ? `${p.health.current}/${p.health.max}` : ''
    const hungerStr = p.hunger ? `${p.hunger.current}/${p.hunger.max}` : ''
    const sanityStr = p.sanity ? `${p.sanity.current}/${p.sanity.max}` : ''
    const dayVal = w.day ?? d.day ?? ''
    const phaseVal = w.phase ?? d.phase ?? ''
    const posStr = `(${d.x ?? '?'},${d.z ?? '?'})`
    const deadVal = d.dead === true
    const ghostVal = Boolean(d.actor?.is_ghost)
    const sig = `${dayVal}|${phaseVal}|${hpStr}|${hungerStr}|${sanityStr}|${hand}|${items}|${posStr}|${deadVal}|${ghostVal}|${warnings.join(';')}`

    // 状态去重降噪：若数值指纹未变且未到最大保活间隔（30秒），跳过无意义的重复刷屏
    if (this.lastStateSig != null && sig === this.lastStateSig && (now - this.lastStateEmittedAt < this.stateThrottleMs)) {
      return
    }
    this.lastStateSig = sig
    this.lastStateEmittedAt = now

    this._emit({
      kind: 'state',
      mod: raw.mod ?? null,
      seq: raw.seq ?? null,
      day: w.day ?? d.day ?? null,
      phase: w.phase ?? d.phase ?? null,
      season: w.season ?? d.season ?? null,
      hp: hpStr || null,
      hunger: hungerStr || null,
      sanity: sanityStr || null,
      ghost: ghostVal,
      dead: deadVal,
      hand: hand ?? null,
      inv: items,
      pos: posStr,
      // 这份状态里"附近"是哪一帧、有没有危险提醒：排查时用它和 ENV/CALL 对齐时间线
      nearby_sid: d.nearby?.snapshot_id ?? null,
      warnings,
      age_ms: age == null ? null : Math.round(age),
    })

    if (deadVal || ghostVal) {
      this.archive('death')
    }
  }

  /**
   * 记一次「角色周边环境」：只在附近快照换帧时写一条（否则每 5 秒一次全是重复）。
   * 文件 mtime 没变就不解析，省掉每秒一次的 JSON.parse。
   */
  _scanEnv() {
    const now = Date.now()
    if (now - this.lastEnvAt < this.envEveryMs) return
    this.lastEnvAt = now
    let mtime
    try { mtime = fs.statSync(this.stateFile).mtimeMs } catch { return }
    if (mtime === this.lastEnvMtime) return
    this.lastEnvMtime = mtime
    const raw = this._readJson(this.stateFile)
    const d = raw?.data
    if (!d || typeof d !== 'object') return
    const nearby = d.nearby && typeof d.nearby === 'object' ? d.nearby : null
    if (!nearby) return
    // 换帧判定：**只认 nearby 自己的快照号**。
    // ★ 真机踩到（日志里 991 条 ENV 却只有 213 帧，多出 4.6 倍）：这里原本把
    //   d.observer.snapshot_id（状态帧号）也塞进指纹，可状态帧每秒都换、nearby 帧
    //   4 秒才换一次（scan_seconds=4）→ 同一帧被记了 4~5 遍，纯噪音。
    //   老格式没有 nearby.snapshot_id 时才退回内容指纹。
    const sig = nearby.snapshot_id != null
      ? String(nearby.snapshot_id)
      : JSON.stringify([
        nearby.status ?? null,
        nearby.radius ?? null,
        nearby.total_found ?? null,
        nearby.total_returned ?? null,
        nearby.buckets ?? null,
      ])
    if (sig === this.lastEnvSig) return
    this.lastEnvSig = sig
    const p = d.player || {}
    const w = d.world || {}
    this._emit({
      kind: 'env',
      sid: nearby.snapshot_id ?? null,
      state_sid: d.observer?.snapshot_id ?? null,
      status: nearby.status ?? null,
      radius: nearby.radius ?? null,
      total_found: nearby.total_found ?? null,
      total_returned: nearby.total_returned ?? null,
      truncated: nearby.truncated === true,
      runtime_id: nearby.runtime_id ?? null,
      pos: `${d.x ?? '?'},${d.z ?? '?'}`,
      day: w.day ?? d.day ?? null,
      phase: w.phase ?? d.phase ?? null,
      hp: p.health ? `${p.health.current}/${p.health.max}` : null,
      hunger: p.hunger ? `${p.hunger.current}/${p.hunger.max}` : null,
      sanity: p.sanity ? `${p.sanity.current}/${p.sanity.max}` : null,
      nearby,
      // 模型当时看到的那段「附近」文本（和 get_state 用的是同一个渲染器）
      lines: nearbyLines(nearby),
    })
  }

  _scanLogs() {
    const sources = [{ file: this.serverLog, source: 'server' }]
    for (const f of this.chatFiles) sources.push({ file: f, source: 'chat' })
    for (const { file, source } of sources) {
      for (const line of this._tail(file)) {
        if (!this.logRe.test(line)) continue
        let kind = 'game_log'
        if (/\[Reflex\]/.test(line)) kind = 'reflex'
        else if (/Death Announcement|死于/.test(line)) {
          kind = 'death'
          this.archive('death')
        }
        this._emit({ kind, source, line })
      }
    }
  }

  /** 扫一次；返回本次新增的事件（测试可直接调） */
  tick() {
    const before = this.events.length
    this._scanCmdResult()
    this._scanState()
    this._scanEnv()
    this._scanLogs()
    this.firstScan = false
    return this.events.slice(before)
  }

  /**
   * 现场自动归档（遇死/遇错不被下次启动覆盖）：
   * 复制当前 session.txt 与 session.jsonl 到 archives/ 目录。
   */
  archive(reason = 'manual') {
    if (this.archivedReasons.has(reason)) return null
    this.archivedReasons.add(reason)
    if (!this.out || !fs.existsSync(this.out)) return null
    try {
      const baseDir = path.dirname(this.out)
      const archiveDir = path.join(baseDir, 'archives')
      fs.mkdirSync(archiveDir, { recursive: true })
      const pad = (n) => String(n).padStart(2, '0')
      const d = new Date()
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
      const targetTxt = path.join(archiveDir, `session_${stamp}_${reason}.txt`)
      const targetJsonl = path.join(archiveDir, `session_${stamp}_${reason}.jsonl`)
      if (fs.existsSync(this.txtOut)) fs.copyFileSync(this.txtOut, targetTxt)
      fs.copyFileSync(this.out, targetJsonl)
      this.note(`现场已自动归档：${path.basename(targetTxt)}（原因：${reason}）`)
      return targetTxt
    } catch (e) {
      process.stderr.write(`[session-log] 归档失败：${e.message}\n`)
      return null
    }
  }

  /**
   * 记一次 AI 下发的操作（下发前调）。返回配对用的 seq，交给 endTool。
   * get_state 这类只读动作不写桥文件，只能靠这里留痕。
   */
  beginTool({ tool, args, by, internal, step } = {}) {
    this.callSeq += 1
    const seq = this.callSeq
    this._emit({
      kind: 'tool_call',
      seq,
      step: step ?? null,
      tool: tool ?? null,
      args: args ?? {},
      by: by ?? null,
      internal: internal === true,
    })
    return seq
  }

  /** 记一次操作的结果（拿到返回后调）。text 按 textCap 截断。 */
  endTool({ seq, tool, ok, ms, text, by, status, reason, step } = {}) {
    const capped = capText(text, this.textCap)
    return this._emit({
      kind: 'tool_result',
      seq: seq ?? null,
      step: step ?? null,
      tool: tool ?? null,
      by: by ?? null,
      ok: ok !== false,
      status: status ?? null,
      reason: reason ?? null,
      ms: Math.max(0, Math.round(Number(ms) || 0)),
      chars: capped.chars,
      truncated: capped.truncated,
      text: capped.text,
    })
  }

  /** 记一次 AI 回合开始与输入关键信息（计划、已知背包、提示摘要） */
  recordAiTurn({ step, day, phase, observeReason, plan, inv, preview } = {}) {
    return this._emit({
      kind: 'ai_turn',
      step: step ?? null,
      day: day ?? null,
      phase: phase ?? null,
      observeReason: observeReason ?? null,
      plan: plan ?? null,
      inv: inv ?? null,
      preview: preview ?? null,
    })
  }

  /** 记一次 AI 思考过程、模型回复与耗时 */
  recordAiThought({ step, thought, content, model, latencyMs, tokens, toolCalls } = {}) {
    return this._emit({
      kind: 'ai_thought',
      step: step ?? null,
      thought: thought ?? null,
      content: content ?? null,
      model: model ?? null,
      latencyMs: latencyMs != null ? Math.round(Number(latencyMs)) : null,
      tokens: tokens ?? null,
      toolCalls: toolCalls ?? null,
    })
  }

  note(text) { return this._emit({ kind: 'note', text }) }

  /** 清空内部去重状态，配合 SessionLog.reset() 做「覆盖写」 */
  clearState() {
    this.events.length = 0
    this.seenCmd.clear()
    this.seenResult.clear()
    this.offsets.clear()
    this.partials.clear()
    this.lastStateAt = 0
    this.lastStateSig = null
    this.lastStateEmittedAt = 0
    this.lastEnvAt = 0
    this.lastEnvMtime = null
    this.lastEnvSig = null
    this.callSeq = 0
    this.firstScan = true
    this.archivedReasons.clear()
  }

  start(intervalMs = 500) {
    this.tick()
    this.timer = setInterval(() => {
      try { this.tick() } catch (e) { process.stderr.write(`[session-log] tick 出错：${e.message}\n`) }
    }, intervalMs)
    return this
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    return this
  }
}

/** 从 GameBridge 找到「活跃分片」的日志源：save 目录、server_log.txt、chat 目录。 */
export function resolveLogSources(bridge, explicit = {}) {
  let dir = explicit.bridgeDir || null
  if (!dir) {
    try {
      const state = bridge?.readState?.()
      if (state?.dir) dir = state.dir
    } catch { /* ignore */ }
  }
  if (!dir) {
    try {
      for (const { dir: d } of bridge?.locate?.() || []) {
        if (fs.existsSync(path.join(d, 'whale_state.json'))) { dir = d; break }
      }
    } catch { /* ignore */ }
  }
  if (!dir) return null
  let master = dir
  if (path.basename(dir).toLowerCase() === 'save') master = path.dirname(dir)
  let serverLog = explicit.serverLog || path.join(master, 'server_log.txt')
  if (!fs.existsSync(serverLog)) serverLog = path.join(dir, 'server_log.txt')
  const chat = explicit.chat || path.join(master, 'backup', 'server_chat_log')
  return { bridgeDir: dir, serverLog, chat }
}

/**
 * 插件内置的会话日志：自动定位源、覆盖写、持续记录。
 *
 * @param {object} opts
 * @param {string} opts.outDir  latestLogs 目录
 * @param {object} opts.bridge  GameBridge 实例（用来找活跃分片）
 * @param {function} [opts.log] 日志函数
 * @param {number} [opts.intervalMs] 扫描间隔
 * @param {number} [opts.stateEveryMs] 状态采样间隔
 * @param {number} [opts.envEveryMs] 周边环境检查间隔
 * @param {number} [opts.textCap] 工具返回最多写多少字符
 * @param {number} [opts.sourceEveryMs] 重新定位数据源的间隔
 * @param {object} [opts.explicit] 显式指定 { bridgeDir, serverLog, chat }
 */
export class SessionLog {
  constructor(opts = {}) {
    this.outDir = opts.outDir
    this.bridge = opts.bridge
    this.log = opts.log || (() => {})
    this.intervalMs = opts.intervalMs ?? 500
    this.stateEveryMs = opts.stateEveryMs ?? 5000
    this.envEveryMs = opts.envEveryMs ?? 1000
    this.sourceEveryMs = opts.sourceEveryMs ?? 5000
    this.textCap = opts.textCap
    this.explicit = opts.explicit || {}

    this.outJsonl = path.join(this.outDir, 'session.jsonl')
    this.outTxt = path.join(this.outDir, 'session.txt')
    this.outServerLog = path.join(this.outDir, 'server_log.txt')
    this.recorder = new SessionRecorder({
      out: this.outJsonl,
      stateEveryMs: this.stateEveryMs,
      envEveryMs: this.envEveryMs,
      ...(this.textCap === undefined ? {} : { textCap: this.textCap }),
    })
    this.timer = null
    this.lastSourceAt = 0
    this.sources = null
    this.started = false
  }

  /** 覆盖写：清空 session.*、覆盖复制 server_log.txt，重置去重状态。 */
  reset(reason = 'start') {
    fs.mkdirSync(this.outDir, { recursive: true })
    fs.writeFileSync(this.outJsonl, '', 'utf8')
    fs.writeFileSync(this.outTxt, '', 'utf8')
    if (this.sources?.serverLog && fs.existsSync(this.sources.serverLog)) {
      try { fs.copyFileSync(this.sources.serverLog, this.outServerLog) } catch { /* ignore */ }
    }
    this.recorder.clearState()
    this.recorder.note(`日志已覆盖重置（${reason}）`)
    this.log('info', `[session-log] 覆盖写重置：${reason} -> ${this.outDir}`)
  }

  _resolveSources(force = false) {
    const now = Date.now()
    if (!force && this.sources && now - this.lastSourceAt < this.sourceEveryMs) return
    const found = resolveLogSources(this.bridge, this.explicit)
    this.lastSourceAt = now
    if (!found) return
    const changed = !this.sources || this.sources.bridgeDir !== found.bridgeDir
    this.sources = found
    if (changed) {
      this.recorder.setSources(found)
      // 换分片（玩家重进/换世界）= 新会话，覆盖写
      if (this.started) this.reset(`切换数据源 ${found.bridgeDir}`)
    }
  }

  start() {
    this._resolveSources(true)
    this.reset('插件启动')
    this.started = true
    this.timer = setInterval(() => {
      try {
        this._resolveSources()
        this.recorder.tick()
        // server_log.txt 覆盖复制（不是增量追加）：始终是当前游戏日志的最新快照
        if (this.sources?.serverLog && fs.existsSync(this.sources.serverLog)) {
          try { fs.copyFileSync(this.sources.serverLog, this.outServerLog) } catch { /* ignore */ }
        }
      } catch (e) {
        this.log('warn', `[session-log] tick 出错：${e.message}`)
      }
    }, this.intervalMs)
    return this
  }

  note(text) { return this.recorder.note(text) }

  /** AI 下发操作：见 SessionRecorder.beginTool / endTool */
  beginTool(opts) { return this.recorder.beginTool(opts) }
  endTool(opts) { return this.recorder.endTool(opts) }

  /** AI 对话与思考留痕 */
  recordAiTurn(opts) { return this.recorder.recordAiTurn(opts) }
  recordAiThought(opts) { return this.recorder.recordAiThought(opts) }

  /** 现场自动归档 */
  archive(reason) { return this.recorder.archive(reason) }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.started = false
    return this
  }
}
