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

export const STATE_NAMES = ['whale_state.json', 'whale_io_state.json']
export const CMD_NAMES = ['whale_cmd.json', 'whale_io_cmd.json']
export const RESULT_NAMES = ['whale_result.json', 'whale_io_result.json']
export const SETTINGS_NAMES = ['whale_settings.json', 'whale_io_settings.json']
export const PAUSE_NAMES = ['whale_pause.json', 'whale_io_pause.json']
export const SETTINGS_FILE = 'whale_settings.json'
export const IO_SETTINGS_FILE = 'whale_io_settings.json'
export const PAUSE_FILE = 'whale_pause.json'
export const IO_PAUSE_FILE = 'whale_io_pause.json'

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

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

export class GameBridge {
  constructor({ log = () => {}, gameDir = '', bridgeDir = '', pollMs = 150, lockDir = false } = {}) {
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
    return dirs
  }

  /** 找最新的状态文件，返回 { json, dir, channel, path, ageMs } 或 null。 */
  readState() {
    let best = null
    for (const { dir, channel } of this.locate()) {
      for (const name of channel === 'io' ? ['whale_io_state.json'] : ['whale_state.json']) {
        const path = join(dir, name)
        let stat
        try {
          stat = statSync(path)
        } catch {
          continue
        }
        if (!best || stat.mtimeMs > best.mtime) {
          const json = readJson(path)
          if (json) best = { json, dir, channel, path, mtime: stat.mtimeMs, ageMs: Date.now() - stat.mtimeMs }
        }
      }
    }
    if (best) {
      this.lastState = best.json
      this.lastStateAt = best.mtime
      this.lastStateText = best.json.text ?? ''
    }
    return best
  }

  /** 有没有连上游戏（状态文件是最近几秒内写的）。 */
  status() {
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

  writeToAll(nameFor, text) {
    let wrote = 0
    for (const { dir, channel } of this.locate()) {
      const name = nameFor(channel)
      try {
        writeAtomic(join(dir, name), text)
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
    const text = JSON.stringify(settings)
    return this.writeToAll((channel) => (channel === 'io' ? IO_SETTINGS_FILE : SETTINGS_FILE), text)
  }

  /**
   * 发一个动作给游戏，等它做完。
   * 返回 { ok, text }；动作失败（游戏说做不了）也走 ok=false，不算异常。
   */
  async call(action, args, { timeoutMs = 180000, signal, onWait } = {}) {
    const dirs = this.locate(true)
    if (dirs.length === 0) {
      throw new Error('找不到饥荒的文件桥：确认游戏装了大肥鱼饿不死模组、已经读档进世界（也可以在插件设置里填游戏目录）')
    }
    const id = `${Date.now().toString(36)}-${++this.sequence}`
    const startedAt = Date.now()
    const payload = JSON.stringify({ v: 1, id, action, args: args ?? {}, ts: startedAt })
    const wrote = this.writeToAll((channel) => (channel === 'io' ? CMD_NAMES[1] : CMD_NAMES[0]), payload)
    if (wrote === 0) throw new Error('指令写不进游戏目录（路径没权限？）')
    this.setPause(false)

    const deadline = startedAt + timeoutMs
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('动作被取消')
      for (const { dir, channel } of this.locate()) {
        const name = channel === 'io' ? RESULT_NAMES[1] : RESULT_NAMES[0]
        const result = readJson(join(dir, name))
        if (result && String(result.id) === id) {
          return { ok: result.ok === true, text: String(result.text ?? '') }
        }
      }
      if (onWait) onWait(Date.now() - startedAt)
      await new Promise((resolve) => setTimeout(resolve, this.pollMs))
    }
    throw new Error(`等了 ${Math.round(timeoutMs / 60000)} 分钟还没做完（游戏里的动作可能还在继续，先 get_state 看看）`)
  }
}

export { writeAtomic }
