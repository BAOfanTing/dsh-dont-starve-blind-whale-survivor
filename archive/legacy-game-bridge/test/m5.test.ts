// M5 测试：状态持久化 + 断线恢复 + 幂等不因 Bridge 重启而破坏
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandQueue, normalizeResult } from '../src/commands.js'
import { loadStateFile, saveStateFile } from '../src/persist.js'
import { SessionManager } from '../src/session.js'

function tempStateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bws-state-'))
  return join(dir, 'bridge-state.json')
}

test('落盘 / 读取：原子写，坏文件不炸', () => {
  const file = tempStateFile()
  const sessions = new SessionManager({ now: () => 1000 })
  sessions.heartbeat('S1', { shard: 'master', gameVersion: 'release' })
  sessions.telemetry('S1', 7, { tick: 7 }, 1234)

  const saved = saveStateFile(file, sessions.export() as never, [])
  assert.equal(saved.ok, true)
  assert.ok(saved.bytes > 0)

  const loaded = loadStateFile(file)
  assert.equal(loaded.ok, true)
  assert.equal(loaded.state?.sessions.length, 1)
  assert.equal(loaded.state?.sessions[0]?.acknowledgedSequence, 7)
  rmSync(file)
})

test('恢复：会话的 sequence 记账还在 → 重启后重复 sequence 仍判 duplicate', () => {
  const file = tempStateFile()
  const first = new SessionManager({ now: () => 1000 })
  first.heartbeat('S1', {})
  first.telemetry('S1', 5, { tick: 5 }, 100)
  saveStateFile(file, first.export() as never, [])

  // 模拟 Bridge 重启
  const second = new SessionManager({ now: () => 2000 })
  const loaded = loadStateFile(file)
  assert.equal(second.restore(loaded.state!.sessions as never), 1)
  assert.equal(second.isConnected(), true, '恢复后先当活着（给游戏端一个心跳窗口）')

  const duplicate = second.telemetry('S1', 5, { tick: 5, again: true }, 100)
  assert.equal(duplicate.duplicate, true, '重启后同一个 sequence 必须仍判重复')
  assert.equal(duplicate.acknowledgedSequence, 5)

  const next = second.telemetry('S1', 6, { tick: 6 }, 100)
  assert.equal(next.duplicate, false)
  rmSync(file)
})

test('恢复：DELIVERED 的命令不重放；会话真不回来才判 unknown_completion', () => {
  const file = tempStateFile()
  let clock = 1000
  const queue = new CommandQueue({ now: () => clock })
  const sessions = new SessionManager({ now: () => clock })
  sessions.heartbeat('S1', { shard: 'master' })
  const command = queue.enqueue('get_state')
  queue.poll('S1', 'master')
  saveStateFile(file, sessions.export() as never, queue.export() as never)

  // 重启：clock 前进
  clock = 2000
  const queue2 = new CommandQueue({ now: () => clock })
  const sessions2 = new SessionManager({ now: () => clock })
  const loaded = loadStateFile(file)
  queue2.restore(loaded.state!.commands as never)
  sessions2.restore(loaded.state!.sessions as never)

  const restored = queue2.get(command.id)
  assert.equal(restored?.status, 'DELIVERED', '恢复后保持原状态，不自动重放也不自动失败')

  // 游戏端 3 秒内回来了 → 命令还能被它接着处理（同一条命令重投，游戏端按 id 去重）
  sessions2.heartbeat('S1', { shard: 'master' })
  assert.equal(sessions2.list()[0]?.reconnects, 1, '应记一次重连')

  // 另一种情况：游戏端一直没回来 → 心跳超时 → reap 判 unknown_completion
  clock += 30000
  assert.equal(sessions2.isConnected(), false)
  queue2.reapSession('S1')
  assert.equal(queue2.get(command.id)?.status, 'FAILED')
  assert.equal(queue2.get(command.id)?.error, 'unknown_completion')
  rmSync(file)
})

test('恢复：QUEUED 的命令能继续投递（不会丢）', () => {
  const file = tempStateFile()
  const queue = new CommandQueue({ now: () => 1000 })
  const command = queue.enqueue('ping')
  saveStateFile(file, [], queue.export() as never)

  const queue2 = new CommandQueue({ now: () => 2000 })
  queue2.restore(loadStateFile(file).state!.commands as never)
  const polled = queue2.poll('S9', 'master')
  assert.equal(polled.command?.id, command.id, '重启前排队的命令重启后还能投出去')
  rmSync(file)
})

test('恢复：已终态命令不会因为重启被重新执行', () => {
  const file = tempStateFile()
  const queue = new CommandQueue({ now: () => 1000 })
  const command = queue.enqueue('ping')
  queue.poll('S1', 'master')
  queue.settle('S1', { commandId: command.id, status: 'SUCCEEDED', result: { message: 'Pong from DST' } })
  saveStateFile(file, [], queue.export() as never)

  const queue2 = new CommandQueue({ now: () => 2000 })
  queue2.restore(loadStateFile(file).state!.commands as never)
  assert.equal(queue2.get(command.id)?.status, 'SUCCEEDED')
  assert.equal(queue2.poll('S2', 'master').command, null, '不能再投给任何会话')
  assert.equal(queue2.stats().SUCCEEDED, 1)
  rmSync(file)
})

test('恢复：id 计数器不会和新命令撞车', () => {
  const file = tempStateFile()
  const queue = new CommandQueue({ now: () => 1000 })
  queue.enqueue('ping')
  queue.enqueue('ping')
  saveStateFile(file, [], queue.export() as never)

  const queue2 = new CommandQueue({ now: () => 2000 })
  queue2.restore(loadStateFile(file).state!.commands as never)
  const fresh = queue2.enqueue('ping')
  const ids = queue2.list(10).map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length, '新命令 id 不能和恢复的重复：' + ids.join(','))
  assert.ok(fresh.id.length > 0)
  rmSync(file)
})

test('归一化：命令结果里的空表 {} 变成 []（get_state 的 items/entities）', () => {
  const normalized = normalizeResult({
    inventory: { slots: 15, used: 0, items: {}, equipment: {} },
    nearby: { entities: {}, returned: 0 },
    received_keys: { a: true },
    list: [1, 2, 3],
  }) as Record<string, any>
  assert.deepEqual(normalized.inventory.items, [])
  assert.deepEqual(normalized.nearby.entities, [])
  assert.deepEqual(normalized.list, [1, 2, 3])
  // 非空对象保持不变
  assert.deepEqual(normalized.inventory.equipment, {})
})

test('落盘文件是合法 JSON 且带版本号与时间戳', () => {
  const file = tempStateFile()
  saveStateFile(file, [], [])
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.version, 1)
  assert.ok(typeof raw.savedAt === 'number')
  assert.deepEqual(raw.sessions, [])
  assert.deepEqual(raw.commands, [])
  rmSync(file)
})
