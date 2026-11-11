import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogTailer } from '../src/logTailer.js'
import type { WireRecord } from '../src/record.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bws-tail-'))
}

function makeTailer(dir: string, options: { backfillBytes?: number } = {}) {
  const records: WireRecord[] = []
  const parseFails: string[] = []
  const tailer = new LogTailer({
    logDir: dir,
    files: ['master_server_log.txt'],
    pollMs: 1000,
    backfillBytes: options.backfillBytes ?? 0,
    onRecord: (record) => records.push(record),
    onParseFail: (info) => parseFails.push(info.reason),
  })
  return { tailer, records, parseFails }
}

const stateLine = (tick: number) =>
  `[00:00:${String(tick).padStart(2, '0')}]: [BWS] {"schema_version":"1","type":"state","phase":1,"observer_version":"0.3.0","side":"server","shard":"master","session":"S1","t":179441000${tick},"tick":${tick},"observer":{"interval":2,"tick":${tick},"errors":0,"players":{"count":1}}}\n`

test('只读新增内容：第一次读完，后面只追加', () => {
  const dir = tempDir()
  const file = join(dir, 'master_server_log.txt')
  writeFileSync(file, stateLine(1) + stateLine(2), 'utf8')
  const { tailer, records } = makeTailer(dir)

  tailer.pollOnce()
  assert.equal(records.length, 2, '首次应该读到已有的两行')

  tailer.pollOnce()
  assert.equal(records.length, 2, '没有新内容就不该重复读')

  appendFileSync(file, stateLine(3), 'utf8')
  tailer.pollOnce()
  assert.equal(records.length, 3, '追加一行应该只读这一行')
  assert.equal(records[2]?.tick, 3)
})

test('半截行：先不解析，等下一段到齐再拼起来', () => {
  const dir = tempDir()
  const file = join(dir, 'master_server_log.txt')
  writeFileSync(file, '', 'utf8')
  const { tailer, records } = makeTailer(dir)

  const line = stateLine(7)
  const cut = Math.floor(line.length / 2)
  appendFileSync(file, line.slice(0, cut), 'utf8')
  tailer.pollOnce()
  assert.equal(records.length, 0, '半截行不该被解析')
  assert.ok(tailer.status()[0]!.pendingBytes > 0, '应该留在 buffer 里')

  appendFileSync(file, line.slice(cut), 'utf8')
  tailer.pollOnce()
  assert.equal(records.length, 1, '补齐后应该解析出 1 条')
  assert.equal(records[0]?.tick, 7)
  assert.equal(tailer.status()[0]!.pendingBytes, 0)
})

test('文件被清空/轮转：offset 归零重读', () => {
  const dir = tempDir()
  const file = join(dir, 'master_server_log.txt')
  writeFileSync(file, stateLine(1) + stateLine(2), 'utf8')
  const { tailer, records } = makeTailer(dir)
  tailer.pollOnce()
  assert.equal(records.length, 2)

  // 模拟游戏重开清空日志
  writeFileSync(file, stateLine(9), 'utf8')
  tailer.pollOnce()
  assert.equal(records.length, 3, '清空后应该重新读出 1 条')
  assert.equal(records[2]?.tick, 9)
  assert.equal(tailer.status()[0]!.rotations, 1)
})

test('文件不存在时不崩，标 missing，出现后自动开始读', () => {
  const dir = tempDir()
  const { tailer, records } = makeTailer(dir)
  tailer.pollOnce()
  assert.equal(tailer.status()[0]!.missing, true)
  assert.equal(records.length, 0)

  writeFileSync(join(dir, 'master_server_log.txt'), stateLine(4), 'utf8')
  tailer.pollOnce()
  assert.equal(tailer.status()[0]!.missing, false)
  assert.equal(records.length, 1)
})

test('回填：从文件尾部开始读，并丢掉起始的半截行', () => {
  const dir = tempDir()
  const file = join(dir, 'master_server_log.txt')
  const lines = [stateLine(1), stateLine(2), stateLine(3), stateLine(4)]
  writeFileSync(file, lines.join(''), 'utf8')
  const lineLength = lines[0]!.length
  // 只回填最后 2.5 行 → 起点落在第 2 行中间
  const { tailer, records } = makeTailer(dir, { backfillBytes: Math.floor(lineLength * 2.5) })
  tailer.pollOnce()
  assert.ok(records.length >= 2, '应该读到尾部完整的行')
  const ticks = records.map((r) => r.tick)
  assert.deepEqual(ticks, [3, 4], '半截的那一行要丢掉，只保留完整的')
})

test('普通行（没有 [BWS] 标记）不算解析失败', () => {
  const dir = tempDir()
  const file = join(dir, 'master_server_log.txt')
  writeFileSync(file, '[00:00:01]: 别的模组在打印\n[00:00:02]: [BWS] {"type":"state",\n', 'utf8')
  const { tailer, records, parseFails } = makeTailer(dir)
  tailer.pollOnce()
  assert.equal(records.length, 0)
  assert.equal(parseFails.length, 1, '只有带标记的坏 JSON 才算失败')
  assert.equal(tailer.status()[0]!.lines, 2)
})
