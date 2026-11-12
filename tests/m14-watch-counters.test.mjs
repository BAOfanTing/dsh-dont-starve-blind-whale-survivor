// m14-watch 统计口径的单元测试（纯函数，不需要游戏）
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createWatchStats, versionKeyOf, VERSION_KEY_KINDS } from '../tools/m14-counters.mjs'

const snap = ({ sequence = 1, session = 'sess', shard = '1', runtime = 'r1-0001', snapshotId = 'n1', reused = false } = {}) => ({
  sequence,
  identity: { sessionId: session, shardId: shard },
  nearby: { runtime_id: runtime, snapshot_id: snapshotId, scan: { reused } },
})

test('watcher-1 同一个状态版本被轮询两次，只算一个 unique_file_version', () => {
  const stats = createWatchStats()
  stats.poll({ snapshot: snap({ sequence: 5 }) })
  stats.poll({ snapshot: snap({ sequence: 5 }) })
  const s = stats.summary()
  assert.equal(s.poll_count, 2)
  assert.equal(s.unique_file_versions, 1)
  assert.equal(s.duplicate_polls, 1)
})

test('watcher-2 同一个 nearby.snapshot_id 对应多个状态版本时，只算一个 unique_snapshot_id', () => {
  const stats = createWatchStats()
  stats.poll({ snapshot: snap({ sequence: 10, snapshotId: 'r1-0001-n3', reused: false }) })
  stats.poll({ snapshot: snap({ sequence: 11, snapshotId: 'r1-0001-n3', reused: true }) })
  stats.poll({ snapshot: snap({ sequence: 12, snapshotId: 'r1-0001-n3', reused: true }) })
  const s = stats.summary()
  assert.equal(s.unique_file_versions, 3, '三个不同的 sequence = 三个文件版本')
  assert.equal(s.unique_snapshot_ids, 1, '同一个扫描快照只算一次')
})

test('watcher-3 reused / fresh 按唯一文件版本计数', () => {
  const stats = createWatchStats()
  // 版本 A：新扫描；版本 B/C：复用
  stats.poll({ snapshot: snap({ sequence: 20, snapshotId: 'n7', reused: false }) })
  stats.poll({ snapshot: snap({ sequence: 21, snapshotId: 'n7', reused: true }) })
  stats.poll({ snapshot: snap({ sequence: 22, snapshotId: 'n7', reused: true }) })
  // 同一版本重复轮询不应重复计数
  stats.poll({ snapshot: snap({ sequence: 22, snapshotId: 'n7', reused: true }) })
  const s = stats.summary()
  assert.equal(s.fresh_scan_file_versions, 1)
  assert.equal(s.reused_file_versions, 2)
  assert.equal(s.reused_ratio, 0.667)
  assert.equal(s.fresh_scan_ratio, 0.333)
})

test('watcher-4 游戏重启后 sequence 归零，不会错误去重（靠 runtime_id）', () => {
  const stats = createWatchStats()
  stats.poll({ snapshot: snap({ sequence: 90, runtime: 'r-old-0001', snapshotId: 'r-old-0001-n30' }) })
  // 重启：sequence 回到 1，runtime_id 变了
  stats.poll({ snapshot: snap({ sequence: 1, runtime: 'r-new-0002', snapshotId: 'r-new-0002-n1' }) })
  const s = stats.summary()
  assert.equal(s.unique_file_versions, 2, '重启后的 seq=1 是新版本，不能和旧的合并')
  assert.equal(s.unique_snapshot_ids, 2)
  assert.equal(s.version_key_kind, VERSION_KEY_KINDS.full)
})

test('watcher-5 没有 runtime_id（0.13.2 以前）时退回 sequence 键，并标注不可靠', () => {
  const stats = createWatchStats()
  const legacy = snap({ sequence: 7, runtime: null, snapshotId: 'n7' })
  stats.poll({ snapshot: legacy })
  stats.poll({ snapshot: legacy })
  const s = stats.summary()
  assert.equal(s.unique_file_versions, 1)
  assert.equal(s.version_key_kind, VERSION_KEY_KINDS.sequence)
  // 键本身也要能造出来
  assert.equal(versionKeyOf(legacy).key, 'seq:7')
})

test('watcher-6 JSON 解析错误被保留，且不污染版本计数', () => {
  const stats = createWatchStats()
  stats.poll({ snapshot: snap({ sequence: 1 }) })
  stats.poll({ parseError: 'Unexpected end of JSON input' })
  stats.poll({ snapshot: null }) // 文件不存在
  const s = stats.summary()
  assert.equal(s.parse_errors, 1)
  assert.equal(s.missing_frames, 1)
  assert.equal(s.unique_file_versions, 1)
  assert.equal(s.poll_count, 3)
})

test('watcher-7 nearby 为空（empty）不会被算成错误，也不影响版本统计', () => {
  const stats = createWatchStats()
  const empty = snap({ sequence: 3, snapshotId: 'n3' })
  empty.nearby.status = 'empty'
  empty.nearby.scan.reused = false
  stats.poll({ snapshot: empty })
  const s = stats.summary()
  assert.equal(s.unique_file_versions, 1)
  assert.equal(s.fresh_scan_file_versions, 1)
  assert.equal(s.parse_errors, 0)
  assert.equal(s.missing_frames, 0)
})
