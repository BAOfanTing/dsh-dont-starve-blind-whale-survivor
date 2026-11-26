// 本地文件桥（Node 这一侧）
//
// 饥荒的 Lua 模组不能监听端口，所以游戏和 DSH 之间靠几个 json 文件说话：
//   模组写 whale_state.json / whale_io_state.json（状态）
//   我们写 whale_cmd.json / whale_io_cmd.json（指令）
//   模组写 whale_result.json / whale_io_result.json（结果）
//
// 两条通道：
//   - 持久化字符串通道：TheSim:SetPersistentString 落在存档目录（Cluster_N/<分片>/save 之类）
//   - io 通道：io.open 落在游戏进程的工作目录（一般是 <游戏目录>/bin64）
// 模组两边都写，我们也两边都写，谁在就用谁；找到了就记住，找不到就继续找。

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HttpServer } from './http-server.js'

export const STATE_NAMES = ['whale_state.json', 'whale_io_state.json']
export const CMD_NAMES = ['whale_cmd.json', 'whale_io_cmd.json']
export const RESULT_NAMES = ['whale_result.json', 'whale_io_result.json']
export const SETTINGS_NAMES = ['whale_settings.json', 'whale_io_settings.json']
export const PAUSE_NAMES = ['whale_pause.json', 'whale_io_pause.json']
export const SETTINGS_FILE = 'whale_settings.json'
export const IO_SETTINGS_FILE = 'whale_io_settings.json'
export const PAUSE_FILE = 'whale_pause.json'
export const IO_PAUSE_FILE = 'whale_io_pause.json'
export const HUD_FILE = 'whale_hud.json'
export const IO_HUD_FILE = 'whale_io_hud.json'
export const LEASE_NAMES = ['whale_lease.json', 'whale_io_lease.json']
export const LEASE_ACK_NAMES = ['whale_lease_ack.json', 'whale_io_lease_ack.json']
export const TOGGLE_FILE = 'whale_toggle.json'
export const IO_TOGGLE_FILE = 'whale_io_toggle.json'
export const HTTP_NAMES = ['whale_http.json', 'whale_io_http.json']
export const HTTP_FILE = 'whale_http.json'
export const IO_HTTP_FILE = 'whale_io_http.json'

const STALE_DIR_MS = 5000

/** 饥荒存档根目录的常见位置（含 OneDrive 把“文档”搬走的情况）。 */
export function kleiRoots() {
  const home = homedir()
  const roots = []
  const add = (path) => {
    if (path && !roots.includes(path) && existsSync(path)) roots.push(path)
  }
  for (const doc of ['Documents', 'OneDrive/Documents', 'OneDrive/文档', 'OneDrive/文檔', '文档', '文檔', 'OneDrive/我的文档']) {
    add(join(home, ...doc.split('/'), 'Klei'))
  }
  for (const env of [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]) {
    if (env) add(join(env, 'Klei'))
  }
  add(join(home, 'Klei'))
  return roots
}

/** 从 Steam 的 libraryfolders.vdf 里把游戏库目录都读出来。 */
function steamLibraries() {
  const libs = []
  const roots = [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    'D:\\Steam',
    'E:\\Steam',
    'F:\\Steam',
  ]
  for (let i = 67; i <= 90; i++) {
    const letter = String.fromCharCode(i)
    roots.push(`${letter}:\\Steam`, `${letter}:\\SteamLibrary`, `${letter}:\\SteamLibrary2`, `${letter}:\\Games\\Steam`)
  }
  for (const root of roots) {
    if (!existsSync(root)) continue
    // 这个目录本身就是个库
    const common = join(root, 'steamapps', 'common')
    if (existsSync(common) && !libs.includes(common)) libs.push(common)
    const vdf = join(root, 'steamapps', 'libraryfolders.vdf')
    if (!existsSync(vdf)) continue
    try {
      const text = readFileSync(vdf, 'utf8')
      for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) {
        const path = match[1].replace(/\\\\/g, '\\')
        const other = join(path, 'steamapps', 'common')
        if (existsSync(other) && !libs.includes(other)) libs.push(other)
        if (!libs.includes(path)) libs.push(path)
      }
    } catch {}
  }
  return libs
}

/** 找《饥荒联机版》的安装目录（第一次找到就返回）。only=true 时只认 explicit。 */
export function findGameDirs(explicit, { only = false } = {}) {
  const found = []
  const push = (dir) => {
    if (!dir || found.includes(dir)) return
    if (existsSync(join(dir, 'bin64')) || existsSync(join(dir, 'dontstarve_steam.exe')) || existsSync(join(dir, 'mods'))) {
      found.push(dir)
    }
  }
  if (explicit) push(explicit)
  if (only) return found
  for (const lib of steamLibraries()) {
    const common = basename(lib) === 'common' ? lib : join(lib, 'steamapps', 'common')
    for (const name of ["Don't Starve Together", 'Dont Starve Together', 'Don’t Starve Together']) {
      push(join(common, name))
    }
  }
  for (const root of ['C:\\Program Files (x86)\\GOG Galaxy\\Games', 'C:\\GOG Games', 'D:\\GOG Games', 'E:\\GOG Games']) {
    push(join(root, "Don't Starve Together"))
  }
  return found
}

const isIoDir = (dir) => /(^|[\\/])(bin|bin64)$/i.test(dir)

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 在某个目录下面（有限深度）找桥文件。 */
function scanForState(root, depth = 4) {
  const hits = []
  const walk = (dir, left) => {
    if (left < 0) return
    for (const entry of listDir(dir)) {
      const path = join(dir, entry.name)
      if (entry.isFile()) {
        if (STATE_NAMES.includes(entry.name) || CMD_NAMES.includes(entry.name)) hits.push(dir)
      } else if (entry.isDirectory() && left > 0) {
        if (entry.name === 'backup' || entry.name.endsWith('.zip')) continue
        walk(path, left - 1)
      }
    }
  }
  walk(root, depth)
  return hits
}

/** 饥荒的持久化字符串文件带一个 KLEI 头（形如 "KLEI     1 {json}"），读之前要剥掉。 */
export function stripKleiHeader(text) {
  return String(text ?? '').replace(/^\uFEFF?KLEI\s+\d+\s*/, '')
}

/** 反过来：写持久化字符串文件时要带上这个头，游戏才认得。 */
export function withKleiHeader(text) {
  return `KLEI     1 ${text}`
}

function readJson(path) {
  try {
    const text = stripKleiHeader(readFileSync(path, 'utf8'))
    if (!text.trim()) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

function writeAtomic(path, text) {
  // 并发安全：临时文件名带 pid + 随机串，避免两个写者同时用同一 .tmp 互相覆盖后 rename 出脏内容
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

export class GameBridge {
  constructor({ log = () => {}, gameDir = '', bridgeDir = '', pollMs = 150, lockDir = false, enableHttp = true } = {}) {
    this.log = log
    this.gameDir = gameDir
    this.bridgeDir = bridgeDir
    this.pollMs = pollMs
    this.lockDir = lockDir
    this.dirs = []
    this.locatedAt = 0
    this.lastStateText = null
    this.lastState = null
    this.lastStateAt = 0
    this.sequence = 0
    this.pendingPause = null
    this.lastSettings = null

    // Localhost HTTP 穿透通道
    this.enableHttp = enableHttp
    this.httpPort = 0
    this.httpToken = randomUUID().replace(/-/g, '').slice(0, 16)
    this.httpConnected = false
    this.lastHttpAt = 0
    this.pendingHttpCommands = []
    this.pendingHttpResults = new Map() // id -> resolve
    this.lastLeaseAck = null
    this.activeShardId = null

    if (this.enableHttp) {
      this.httpServer = new HttpServer(0, this.httpToken)
      this.httpServer.on('exchange', (payload, reply) => this.handleExchange(payload, reply))
      this.httpServer.listen().then((port) => {
        this.httpPort = port
        this.log('info', `Localhost HTTP bridge listening on 127.0.0.1:${port}`)
        this.syncHttpConfig()
      }).catch((err) => {
        this.log('warn', `Localhost HTTP bridge start failed: ${err?.message ?? err}`)
      })
    }
  }

  syncHttpConfig(dirs = this.dirs) {
    if (!this.httpPort || dirs.length === 0) return
    const payload = JSON.stringify({
      v: 1,
      port: this.httpPort,
      token: this.httpToken,
      url: `http://127.0.0.1:${this.httpPort}/v1/exchange`,
    })
    this.writeToAll((channel) => (channel === 'io' ? IO_HTTP_FILE : HTTP_FILE), payload, dirs)
  }

  /**
   * 评估分片状态的活跃权重。
   * 饥荒联机把世界分成 Master / Caves 两个分片，两个分片都会上报状态。
   * - 有玩家且 ready 的分片具有最高权重（4分）
   * - ready 的分片次之：主分片 2 分，洞穴分片 1 分
   * - 未就绪且无玩家分片权重最低（主分片 0.5，洞穴 0）
   * - 状态新鲜（< 15秒）再加 1 分
   */
  rank(state) {
    if (!state) return -1
    const json = state.json ?? state
    const data = json.data ?? {}
    const players = Number(data.players ?? 0)
    const ready = json.ready === true
    const shardId = String(data.identity?.shard_id ?? data.shard_id ?? '').toLowerCase()
    const isMaster = shardId === '1' || shardId === 'master' || shardId === ''
    const ageMs = state.ageMs ?? (json.t ? Math.max(0, Date.now() - Number(json.t) * 1000) : 0)

    let score = 0
    if (ready && players > 0) {
      score = 4
    } else if (ready) {
      score = isMaster ? 2 : 1
    } else {
      score = isMaster ? 0.5 : 0
    }
    if (ageMs < 15000) score += 1
    return score
  }

  handleExchange(payload, reply) {
    this.httpConnected = true
    this.lastHttpAt = Date.now()

    const state = payload?.state
    const shardId = payload?.shard_id ??
      state?.data?.identity?.shard_id ??
      state?.data?.shard_id ??
      null

    const hasData = state?.data != null
    const players = Number(state?.data?.players ?? 0)
    const ready = state?.ready === true
    // 判定是否有活跃玩家：有 data 时要求 players > 0 且 ready 为 true；
    // 简略 state（单测/模拟）未提供 data 时回退到仅检验 ready
    const hasPlayer = ready && (!hasData || players > 0)

    if (state) {
      const incomingRank = this.rank(state)
      const currentAgeMs = this.lastStateAt ? Date.now() - this.lastStateAt : Infinity
      const currentRank = this.lastState ? this.rank({ json: this.lastState, ageMs: currentAgeMs }) : -1

      const currentShardId = this.lastState?.data?.identity?.shard_id ??
        this.lastState?.data?.shard_id ??
        null

      const isSameShard = shardId != null && currentShardId != null && String(shardId) === String(currentShardId)

      // 只有在满足以下条件时才更新 this.lastState：
      // 1. 当前无状态，或者当前状态已陈旧 (> 15 秒)
      // 2. 来自同一个分片的状态更新
      // 3. 来自不同分片，且新分片的 rank 更优（例如玩家转入洞穴）
      const shouldUpdate = !this.lastState ||
        currentAgeMs > 15000 ||
        isSameShard ||
        incomingRank > currentRank

      if (shouldUpdate) {
        this.lastState = state
        this.lastStateText = state.text ?? ''
        this.lastStateAt = Date.now()
        this.activeShardId = shardId
        this.active = { dir: 'http', channel: 'http', shardId }
      }
    }

    if (payload?.result) {
      const res = payload.result
      const id = String(res.id ?? '')
      const resolve = this.pendingHttpResults.get(id)
      if (resolve) {
        this.pendingHttpResults.delete(id)
        resolve({ ok: res.ok === true, text: String(res.text ?? ''), reason: res.reason ?? null })
      }
    }

    if (payload?.ack) {
      this.lastLeaseAck = payload.ack
    }

    // 只有活跃（有玩家）的分片才能认领执行指令，防止空闲分片（如没有玩家的 Caves）截胡
    let cmds = []
    if (hasPlayer) {
      if (shardId == null) {
        cmds = this.pendingHttpCommands.splice(0, this.pendingHttpCommands.length)
      } else {
        const matched = []
        const remaining = []
        for (const cmd of this.pendingHttpCommands) {
          if (cmd.shard_id == null || String(cmd.shard_id) === String(shardId)) {
            matched.push(cmd)
          } else {
            remaining.push(cmd)
          }
        }
        cmds = matched
        this.pendingHttpCommands = remaining
      }
    }

    reply({
      ok: true,
      commands: cmds,
      settings: this.lastSettings,
      pause: this.pendingPause === true && cmds.length === 0 && this.pendingHttpCommands.length === 0,
      result_acked: payload?.result != null,
      authority: typeof this.getAuthority === 'function' ? this.getAuthority() : null,
    })
  }

  close() {
    this.httpServer?.close()
  }

  /** 现在知道的所有能写文件的目录（带通道类型）。 */
  locate(force = false) {
    const now = Date.now()
    if (!force && this.dirs.length > 0 && now - this.locatedAt < STALE_DIR_MS) return this.dirs
    const dirs = []
    const add = (dir) => {
      if (!dir || !existsSync(dir)) return
      if (!dirs.some((d) => d.dir === dir)) dirs.push({ dir, channel: isIoDir(dir) ? 'io' : 'persist' })
    }

    if (this.bridgeDir) add(this.bridgeDir)
    // 测试和“我知道文件在哪”的场景：只认这一个目录，不去翻游戏存档
    if (this.lockDir) {
      this.dirs = dirs
      this.locatedAt = now
      return dirs
    }

    for (const game of findGameDirs(this.gameDir)) {
      add(join(game, 'bin64'))
      add(join(game, 'bin'))
    }

    for (const root of kleiRoots()) {
      const dst = join(root, 'DoNotStarveTogether')
      if (!existsSync(dst)) continue
      for (const entry of listDir(dst)) {
        if (!entry.isDirectory()) continue
        const userDir = join(dst, entry.name)
        add(join(userDir, 'client_save'))
        for (const cluster of listDir(userDir)) {
          if (!cluster.isDirectory() || !/^Cluster_\d+$/i.test(cluster.name)) continue
          const clusterDir = join(userDir, cluster.name)
          for (const shard of listDir(clusterDir)) {
            if (!shard.isDirectory()) continue
            add(join(clusterDir, shard.name))
            add(join(clusterDir, shard.name, 'save'))
          }
        }
      }
      // 实在不认得路径：在存档目录里翻一遍
      for (const hit of scanForState(dst, 4)) add(hit)
    }

    this.dirs = dirs
    this.locatedAt = now
    this.log('info', `[Bridge] Located ${dirs.length} dirs: ${JSON.stringify(dirs)}`)
    this.syncHttpConfig(dirs)
    return dirs
  }

  /** 找最新的状态文件，返回 { json, dir, channel, path, mtimeMs, ageMs } 或 null。 */
  readState() {
    if (this.httpConnected && this.lastState && Date.now() - this.lastHttpAt < 10000) {
      return {
        json: this.lastState,
        dir: 'http',
        channel: 'http',
        path: `http://127.0.0.1:${this.httpPort}`,
        mtime: this.lastStateAt,
        mtimeMs: this.lastStateAt,
        ageMs: Date.now() - this.lastHttpAt,
      }
    }
    const candidates = []
    for (const { dir, channel } of this.locate()) {
      for (const name of channel === 'io' ? ['whale_io_state.json'] : ['whale_state.json']) {
        const path = join(dir, name)
        let stat
        try {
          stat = statSync(path)
        } catch {
          continue
        }
        const json = readJson(path)
        if (!json) continue
        candidates.push({
          json, dir, channel, path,
          // 保留 mtime 与 mtimeMs 两个字段以兼容历史读取方，避免时间差算出 NaN
          mtime: stat.mtimeMs,
          mtimeMs: stat.mtimeMs,
          // 夹到 >= 0：ext4 的 mtimeMs 是亚毫秒精度，可能比整毫秒的 Date.now() 略大，
          // 直接相减会得到极小负数（-0.x ms），让上层把"刚写好的状态"误判成异常。
          ageMs: Math.max(0, Date.now() - stat.mtimeMs),
        })
      }
    }
    let best = null
    for (const candidate of candidates) {
      if (best === null) {
        best = candidate
        continue
      }
      const diff = this.rank(candidate) - this.rank(best)
      if (diff > 0 || (diff === 0 && candidate.mtimeMs > best.mtimeMs)) best = candidate
    }
    if (best) {
      this.lastState = best.json
      this.lastStateAt = best.mtime
      this.lastStateText = best.json.text ?? ''
      // 记住"玩家在这个分片里"：动作只发给它，别让另一个分片（通常是没人的洞穴）抢答
      this.active = { dir: best.dir, channel: best.channel }
    }
    return best
  }

  /**
   * 这次动作该发给谁。
   * 饥荒联机把 Master / Caves 分成两个服务器进程，两个都在跑同一个模组、都在轮询指令文件：
   * 指令广播给两边时，没人的那一侧会立刻回一句「现在没有玩家」，把真正的结果挤掉。
   * 所以一旦读到过带玩家的状态，就只发给那个分片的目录。
   */
  commandDirs() {
    const active = this.active
    if (active && existsSync(active.dir)) return [active]
    // 还没确认过玩家在哪个分片：先读一次状态（readState 会记下 active），再决定发给谁
    const state = this.readState()
    if (state && this.active && existsSync(this.active.dir)) return [this.active]
    return this.locate(true)
  }

  /** 权威租约副本要发到 Lua 能读到的目录（命令目录 + 所有 locate 到的游戏/分片目录） */
  leaseDirs() {
    const dirs = []
    const add = (d) => {
      if (d?.dir && existsSync(d.dir) && !dirs.some((x) => x.dir === d.dir)) {
        dirs.push(d)
      }
    }
    for (const d of this.commandDirs()) add(d)
    for (const d of this.locate()) add(d)
    return dirs
  }

  /** 读 Lua 的撤销确认（两阶段换手用） */
  readLeaseAck() {
    if (this.lastLeaseAck) return this.lastLeaseAck
    for (const { dir } of this.commandDirs()) {
      for (const name of LEASE_ACK_NAMES) {
        const ack = readJson(join(dir, name))
        if (ack) return ack
      }
    }
    return null
  }

  /** 有没有连上游戏（状态文件是最近几秒内写的）。 */
  status() {
    if (this.httpConnected && Date.now() - this.lastHttpAt < 10000 && this.lastState) {
      const ageMs = Date.now() - this.lastHttpAt
      return {
        connected: true,
        fresh: true,
        ageMs,
        ready: this.lastState.ready === true,
        dir: 'http',
        channel: 'http',
        mod: this.lastState.mod ?? '?',
        reason: null,
      }
    }
    const state = this.readState()
    if (!state) {
      return { connected: false, reason: '找不到游戏的状态文件：确认游戏里装了大肥鱼饿不死模组、已经读档进世界', dirs: this.dirs.map((d) => d.dir) }
    }
    const fresh = state.ageMs < 15000
    return {
      connected: fresh,
      fresh,
      ageMs: state.ageMs,
      ready: state.json.ready === true,
      dir: state.dir,
      channel: state.channel,
      mod: state.json.mod ?? '?',
      reason: fresh ? null : `状态文件 ${Math.round(state.ageMs / 1000)} 秒没更新了（游戏暂停了？还是退出世界了？）`,
    }
  }

  writeToAll(nameFor, text, dirs = this.locate()) {
    let wrote = 0
    for (const { dir, channel } of dirs) {
      const name = nameFor(channel)
      try {
        // 持久化字符串通道要带 KLEI 头，游戏才读得出来；io 通道是纯文件
        writeAtomic(join(dir, name), channel === 'persist' ? withKleiHeader(text) : text)
        wrote++
      } catch (error) {
        this.log('warn', `写 ${join(dir, name)} 失败：${error?.message ?? error}`)
      }
    }
    return wrote
  }

  setPause(pause) {
    if (this.pendingPause === pause) return
    this.pendingPause = pause
    this.writeToAll((channel) => (channel === 'io' ? IO_PAUSE_FILE : PAUSE_FILE), JSON.stringify({ pause }))
  }

  pushSettings(settings) {
    this.lastSettings = settings
    const text = JSON.stringify(settings)
    return this.writeToAll((channel) => (channel === 'io' ? IO_SETTINGS_FILE : SETTINGS_FILE), text)
  }

  /** 客户端那一侧能读的目录（client_save / bin / bin64）——HUD 和快捷键的开关走这里。 */
  locateClient(force = false) {
    const all = this.locate(force)
    const client = all.filter(({ dir }) => /client_save$|[\\/](bin|bin64)$/i.test(dir))
    return client.length > 0 ? client : all
  }

  /** 把 HUD 内容写给游戏里的客户端小窗。 */
  writeHud(state) {
    const text = JSON.stringify(state)
    let wrote = 0
    for (const { dir, channel } of this.locateClient()) {
      try {
        const name = channel === 'io' ? IO_HUD_FILE : HUD_FILE
        writeAtomic(join(dir, name), channel === 'persist' ? withKleiHeader(text) : text)
        wrote++
      } catch (error) {
        this.log('warn', `写 HUD 失败：${error?.message ?? error}`)
      }
    }
    return wrote
  }

  /** 读游戏里按快捷键写出来的开关（F8 开/停；F7 现在只开关小窗，不写这里）。 */
  readToggle() {
    for (const { dir } of this.locateClient()) {
      for (const name of [TOGGLE_FILE, IO_TOGGLE_FILE]) {
        const value = readJson(join(dir, name))
        if (value && typeof value === 'object') return { ...value, file: name, dir }
      }
    }
    return null
  }

  /**
   * 发一个动作给游戏，等它做完。
   * 返回 { ok, text }；动作失败（游戏说做不了）也走 ok=false，不算异常。
   */
  async call(action, args, { timeoutMs = 180000, signal, onWait, envelope } = {}) {
    const dirs = this.commandDirs()
    if (dirs.length === 0 && !this.httpConnected) {
      throw new Error('找不到饥荒的文件桥：确认游戏装了大肥鱼饿不死模组、已经读档进世界（也可以在插件设置里填游戏目录）')
    }
    // 有信封时用信封里的 command_id 作为 id，保证 Node/Lua/结果三方对得上
    const id = envelope?.command_id ?? `${Date.now().toString(36)}-${++this.sequence}`
    const startedAt = Date.now()
    const payloadObj = { v: 1, id, action, args: args ?? {}, ts: startedAt, ...(envelope ?? {}) }
    const payload = JSON.stringify(payloadObj)

    const cleanPendingCommand = () => {
      const idx = this.pendingHttpCommands.findIndex((c) => c && c.id === id)
      if (idx !== -1) {
        this.pendingHttpCommands.splice(idx, 1)
      }
      this.pendingHttpResults.delete(id)
    }

    if (signal?.aborted) {
      cleanPendingCommand()
      throw new Error('动作在下发前已被取消')
    }

    // HTTP 快速通道：把指令排入待提取队列，并注册返回监听
    let httpPromise = null
    if (this.httpConnected) {
      this.pendingHttpCommands.push(payloadObj)
      httpPromise = new Promise((resolve) => {
        this.pendingHttpResults.set(id, resolve)
      })
    }

    const abortHandler = () => {
      cleanPendingCommand()
    }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', abortHandler, { once: true })
    }

    // 双通道冗余保护：即使启用了 HTTP，仍写一份磁盘，保证降级与单机工具测试一致性
    if (dirs.length > 0) {
      const wrote = this.writeToAll((channel) => (channel === 'io' ? CMD_NAMES[1] : CMD_NAMES[0]), payload, dirs)
      if (wrote === 0 && !this.httpConnected) throw new Error('指令写不进游戏目录（路径没权限？）')
    }
    this.setPause(false)

    const deadline = startedAt + timeoutMs
    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          cleanPendingCommand()
          throw new Error('动作被取消')
        }

        // 1. 优先等待 HTTP 快速返回（15ms 粒度快速判定）
        if (httpPromise) {
          const fastResult = await Promise.race([
            httpPromise,
            new Promise((resolve) => setTimeout(() => resolve(null), 15)),
          ])
          if (fastResult) return fastResult
        }

        // 2. 磁盘回退轮询核对
        for (const { dir, channel } of dirs) {
          const name = channel === 'io' ? RESULT_NAMES[1] : RESULT_NAMES[0]
          const result = readJson(join(dir, name))
          if (result && String(result.id) === id) {
            return { ok: result.ok === true, text: String(result.text ?? ''), reason: result.reason ?? null }
          }
        }
        if (onWait) onWait(Date.now() - startedAt)
        if (httpPromise) {
          // HTTP 通道进行中：等它或本节拍即可，别在 15ms 快速判定之后再白睡一整段 pollMs
          const viaHttp = await Promise.race([
            httpPromise.catch(() => null),
            new Promise((res) => setTimeout(res, this.pollMs)),
          ])
          if (viaHttp) return viaHttp
        } else {
          await new Promise((resolve) => setTimeout(resolve, this.pollMs))
        }
      }
      throw new Error(`等了 ${Math.round(timeoutMs / 60000)} 分钟还没做完（游戏里的动作可能还在继续，先 get_state 看看）`)
    } finally {
      if (signal && typeof signal.removeEventListener === 'function') {
        try { signal.removeEventListener('abort', abortHandler) } catch {}
      }
      cleanPendingCommand()
    }
  }
}

export { writeAtomic }
