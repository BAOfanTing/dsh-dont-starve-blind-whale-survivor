// 测试用的「假游戏」：只用文件说话，模拟游戏里的 Lua 模组
// （真模组也是这么干的：写 whale_state.json，读 whale_cmd.json，写 whale_result.json）

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripKleiHeader } from '../lib/bridge.js'

export function tempDir(prefix = 'whale-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeAtomic(path, text) {
  writeFileSync(`${path}.tmp`, text, 'utf8')
  renameSync(`${path}.tmp`, path)
}

export class FakeGame {
  constructor(dir) {
    this.dir = dir
    this.timer = null
    this.seen = new Set()
    this.commands = []
    this.handler = (_cmd) => ({ ok: true, text: '好了' })
    this.stateText = '世界：第1天 · 白天\n你：威尔逊'
    this.ready = true
    this.extra = {}
  }

  writeState(patch = {}) {
    const payload = {
      v: 1,
      seq: 1,
      t: Math.floor(Date.now() / 1000),
      mod: '0.1.0',
      ready: this.ready,
      text: this.stateText,
      data: { ready: this.ready, x: 1, z: 2, day: 1, phase: 'day' },
      ...patch,
    }
    this.lastState = payload
    writeAtomic(join(this.dir, 'whale_state.json'), JSON.stringify(payload))
    return payload
  }

  start() {
    mkdirSync(this.dir, { recursive: true })
    this.writeState()
    this.timer = setInterval(() => this.tick(), 40)
    return this
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try {
      rmSync(join(this.dir, 'whale_cmd.json.tmp'), { force: true })
    } catch {}
  }

  tick() {
    // 状态偶尔刷新一下，模拟游戏在跑
    try {
      this.writeState()
    } catch {}
    const cmdPath = join(this.dir, 'whale_cmd.json')
    if (!existsSync(cmdPath)) return
    let cmd
    try {
      // 真游戏读持久化字符串时会自动去掉 KLEI 头
      cmd = JSON.parse(stripKleiHeader(readFileSync(cmdPath, 'utf8')))
    } catch {
      return
    }
    if (!cmd || !cmd.id || this.seen.has(cmd.id)) return
    this.seen.add(cmd.id)
    this.commands.push(cmd)
    const result = this.handler(cmd)
    if (result === undefined) return // 模拟长动作：先不回
    this.respond(cmd.id, result.ok, result.text)
  }

  respond(id, ok, text) {
    writeAtomic(join(this.dir, 'whale_result.json'), JSON.stringify({ v: 1, id, ok, text, t: Math.floor(Date.now() / 1000) }))
  }
}
