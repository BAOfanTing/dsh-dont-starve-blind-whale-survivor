// 测试用的「假游戏」：只用文件说话，模拟游戏里的 Lua 模组
// （真模组也是这么干的：写 whale_state.json，读 whale_cmd.json，写 whale_result.json）

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripKleiHeader } from '../../lib/bridge.js'

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
    this.modern = false // true = tick 时写新格式（带 actor/identity/nearby）
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

  /** 构造包含 actor/identity/nearby 的完整结构化状态快照 */
  writeModernState(overrides = {}) {
    const payload = {
      v: 1,
      seq: 7,
      t: Math.floor(Date.now() / 1000),
      mod: '0.14.0',
      ready: true,
      text: '# 快照 s7 · 第1天 · 白天',
      data: {
        schema: 'bws.state/1',
        identity: { session_id: 'sess-test', cluster_id: null, cluster_id_source: 'unavailable', shard_id: '1' },
        actor: {
          actor_id: 'player:KU_test', actor_id_kind: 'stable', actor_type: 'player', prefab: 'warly',
          name: '沃利', valid: true, alive: true, is_ghost: false, missing_components: [],
          tile_x: 1, tile_z: 2,
        },
        player: { inventory: { slots: 15, used: 0, items: [] } },
        world: { day: 1, phase: 'day', season: 'autumn' },
        warnings: [],
        nearby: {
          status: 'empty', schema: 'bws.nearby/1', runtime_id: 'r-test-0001', snapshot_id: 'r-test-0001-n1',
          radius: 16, scan_seconds: 4, total_found: 0, total_returned: 0, truncated: false,
          buckets: { threats: [], food: [], resources: [], containers: [], structures: [], creatures: [], other: [] },
          delta: { status: 'baseline', added_count: 0, removed_count: 0, changed_count: 0, added: [], removed: [], changed: [] },
          scan: { reused: false, timestamp: Math.floor(Date.now() / 1000), age_ms: 0, duration_ms: 0.5, duration_source: 'os.clock' },
        },
        observer: { snapshot_id: 's7', sequence: 7, timestamp: 1, sampled_at: 1, sample_age_ms: 0,
                    reused: false, status: 'ok', errors: [], unavailable_fields: [] },
      },
      ...overrides,
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
      if (this.modern) this.writeModernState()
      else this.writeState()
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

// 权威租约文件与 Lua io.open 模拟
export const LEASE_SCHEMA = 'bws.control-lease/1'

export function authority(over = {}) {
  return {
    schema: LEASE_SCHEMA,
    status: 'active',
    authority_epoch: 'epoch-A',
    generation: 12,
    owner_type: 'f8_agent',
    owner_instance_id: 'instance-A',
    lease_id: 'lease-A',
    runtime_id: 'r1794500000-0001',
    session_id: 'sess-R',
    shard_id: '1',
    actor_id: 'player:KU_r',
    acquired_at: 1794500000000,
    expires_at: 1794500060000,
    previous_owner_type: null,
    previous_owner_instance_id: null,
    ...over,
  }
}

/** 生成一段 Lua：把权威 JSON 挂到 GLOBAL.io.open 可读的虚拟文件里。传 null = 文件不存在 */
export function luaIoFiles(files) {
  const entries = Object.entries(files)
    .map(([name, value]) => {
      if (value === null || value === undefined) return ''
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return `IO_FILES[${JSON.stringify(name)}] = ${JSON.stringify(text)}`
    })
    .join('\n')
  return `
IO_FILES = {}
${entries}
GLOBAL.io = {
    open = function(name, mode)
        local text = IO_FILES[name]
        if text == nil or mode ~= "r" then return nil end
        return {
            read = function(self, how) return text end,
            close = function(self) return true end,
        }
    end
}
`
}

/** 命令信封（与 dispatcher 生成的字段一致） */
export function command(authorityRecord, over = {}) {
  const a = authorityRecord ?? authority()
  return {
    protocol_version: 1,
    command_id: 'cmd-1',
    action: 'move_to',
    args: { x: 3, z: 4 },
    requested_by: a.owner_type,
    owner_type: a.owner_type,
    owner_instance_id: a.owner_instance_id,
    authority_epoch: a.authority_epoch,
    lease_id: a.lease_id,
    lease_generation: a.generation,
    lease_expires_at: a.expires_at,
    runtime_id: a.runtime_id,
    session_id: a.session_id,
    shard_id: a.shard_id,
    actor_id: a.actor_id,
    created_at: 1794500000000,
    expires_at: 1794500008000,
    ...over,
  }
}
