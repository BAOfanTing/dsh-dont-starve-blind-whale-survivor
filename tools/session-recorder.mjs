// 旁路会话记录器（SURVIVAL-02.1）：把「谁下了什么动作 / 游戏回了什么 / 反射做了什么 / 状态变成什么」
// 汇成一条时间线，方便事后排查。
//
// 设计边界（重要）：
//   · **只读**：不写任何桥文件，不往游戏里下任何指令，不改文件桥协议、不加游戏工具。
//   · **不依赖 DSH/模型**：直接读 whale_cmd.json / whale_result.json / whale_state.json /
//     server_log.txt / server_chat_log*.txt，所以任何入口（MCP、F8、手写命令）的动作都记得到。
//   · 同一条命令/回执按 id 去重；日志按文件偏移增量读，文件被截断/轮转会自动重来。
//
// 用法：
//   node tools/session-recorder.mjs --bridgeDir "<.../Cluster_2/Master/save>" \
//        --serverLog "<.../Cluster_2/Master/server_log.txt" \
//        --chat "<.../Cluster_2/Master/backup/server_chat_log" \
//        --out .runtime/session-record.jsonl --seconds 1800 --from-start
//
//   --note "文字"   只插入一条人工标注后退出（用于给时间线打点）
//   --once          只扫描一次后退出（测试用）
//   --from-start    连已有的历史日志行也收进来（默认只收启动后的新行）
//
// 产物：<out>.jsonl（结构化，每行一个事件） + 同名 .txt（一行一条，人眼直接看）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const KLEI = /^KLEI\s+\d+\s*/
const stripKlei = (text) => String(text ?? '').replace(KLEI, '')

/**
 * 日志编码兜底：DST 的 server_log.txt 中文是 **GBK**，而 chat log 是 UTF-8。
 * 先按 UTF-8 解；出现替换符（U+FFFD）说明不是 UTF-8，改用 GBK 再解一次。
 * 不做这个兜底会把字节替换成 U+FFFD，中文全丢（排查时看不出是谁重连了）。
 */
function decodeLogBytes(buf) {
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try { return new TextDecoder('gbk', { fatal: false }).decode(buf) }
  catch { return utf8 }
}

const DEFAULT_LOG_RE = /\[Reflex\]|Death Announcement|Resurrect|Spawn request|Loading mod:|Overriding mod|Server Auto|Sim unpaused|Sim paused|Deleting user|Serializing world|Lua error|stack traceback|WARNING|warning/i

function parseArgs(argv) {
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

function eventsToText(event) {
  const head = event.t.slice(11, 19)
  switch (event.kind) {
    case 'cmd':
      return `${head} | CMD    | ${short(event.action)} id=${short(event.id)} args=${JSON.stringify(event.args ?? {})} by=${short(event.requested_by)}${event.initial ? ' (initial)' : ''}`
    case 'result':
      return `${head} | RESULT | ok=${event.ok} id=${short(event.id)} text=${short(event.text)}${event.initial ? ' (initial)' : ''}`
    case 'state':
      return `${head} | STATE  | mod=${short(event.mod)} day=${short(event.day)} phase=${short(event.phase)} hp=${short(event.hp)} hunger=${short(event.hunger)} sanity=${short(event.sanity)} hand=${short(event.hand)} inv=[${short(event.inv)}] pos=${short(event.pos)} ghost=${event.ghost} dead=${event.dead} age=${short(event.age_ms)}ms`
    case 'reflex':
      return `${head} | REFLEX | ${short(event.line)}`
    case 'death':
      return `${head} | DEATH  | ${short(event.line)}`
    case 'game_log':
      return `${head} | LOG    | [${short(event.source)}] ${short(event.line)}`
    case 'note':
      return `${head} | NOTE   | ${short(event.text)}`
    default:
      return `${head} | ${short(event.kind)} | ${JSON.stringify(event)}`
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
    this.logRe = opts.logRe || DEFAULT_LOG_RE
    this.fromStart = opts.fromStart === true

    this.events = []
    this.seenCmd = new Set()
    this.seenResult = new Set()
    this.offsets = new Map()
    this.partials = new Map()
    this.lastStateAt = 0
    this.firstScan = true
  }

  _emit(event) {
    const full = { t: new Date().toISOString(), ...event }
    this.events.push(full)
    if (this.out) {
      try {
        fs.mkdirSync(path.dirname(this.out), { recursive: true })
        fs.appendFileSync(this.out, JSON.stringify(full) + '\n')
        fs.appendFileSync(this.txtOut, eventsToText(full) + '\n')
      } catch (e) {
        // 记录器自己不能因为写盘失败而死掉
        process.stderr.write(`[recorder] 写盘失败：${e.message}\n`)
      }
    }
    return full
  }

  _readJson(file) {
    try { return JSON.parse(stripKlei(fs.readFileSync(file, 'utf8'))) }
    catch { return null }
  }

  /** 增量读日志文件；按**字节**处理（中文可能是多字节且跨两次读取），
   *  处理文件截断/轮转，保留未成行的半截字节。 */
  _tail(file) {
    let size
    try { size = fs.statSync(file).size } catch { return [] }
    let offset = this.offsets.get(file)
    if (offset === undefined) {
      offset = this.fromStart ? 0 : size
      this.offsets.set(file, offset)
    }
    if (size < offset) { offset = 0; this.partials.set(file, Buffer.alloc(0)) }  // 被截断/轮转
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
        ts: cmd.ts ?? null,
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
        t: res.t ?? null,
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
    this._emit({
      kind: 'state',
      mod: raw.mod ?? null,
      seq: raw.seq ?? null,
      day: w.day ?? d.day ?? null,
      phase: w.phase ?? d.phase ?? null,
      hp: p.health ? `${p.health.current}/${p.health.max}` : null,
      hunger: p.hunger ? `${p.hunger.current}/${p.hunger.max}` : null,
      sanity: p.sanity ? `${p.sanity.current}/${p.sanity.max}` : null,
      ghost: d.actor ? d.actor.is_ghost : null,
      dead: d.dead ?? null,
      hand: hand ?? null,
      inv: items,
      pos: `(${d.x ?? '?'},${d.z ?? '?'})`,
      age_ms: age == null ? null : Math.round(age),
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
        else if (/Death Announcement|死于/.test(line)) kind = 'death'
        this._emit({ kind, source, line })
      }
    }
  }

  /** 扫一次；返回本次新增的事件（测试可直接调） */
  tick() {
    const before = this.events.length
    this._scanCmdResult()
    this._scanState()
    this._scanLogs()
    this.firstScan = false
    return this.events.slice(before)
  }

  note(text) { return this._emit({ kind: 'note', text }) }

  start(intervalMs = 500) {
    this.tick()
    this.timer = setInterval(() => {
      try { this.tick() } catch (e) { process.stderr.write(`[recorder] tick 出错：${e.message}\n`) }
    }, intervalMs)
    return this
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.note('recorder stopped')
    return this
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const recorder = new SessionRecorder({
    bridgeDir: args.bridgeDir,
    serverLog: args.serverLog,
    chat: args.chat,
    out: args.out,
    fromStart: args['from-start'] === true,
    stateEveryMs: args.stateEvery ? Number(args.stateEvery) : 5000,
  })

  if (args.note) { recorder.note(String(args.note)); return }
  if (args.once) { recorder.tick(); console.log(`recorded ${recorder.events.length} events -> ${recorder.out}`); return }

  const seconds = Number(args.seconds || 1800)
  recorder.start(Number(args.interval || 500))
  console.log(`[recorder] running ${seconds}s -> ${recorder.out} (${recorder.txtOut})`)
  setTimeout(() => {
    recorder.stop()
    console.log(`[recorder] done, ${recorder.events.length} events`)
  }, seconds * 1000).unref()
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}

export { parseArgs, stripKlei, eventsToText }
