// M1.4 真机采样器（独立工具，**只读**）
//
// 目标：把「附近实体结构化观察」在真实 DST 里跑出来的样子完整记下来，供验收判断用：
//   · nearby 三态（ok / empty / error）
//   · 七个分类桶各自的数量
//   · #N 引用：唯一性、连续性、同一快照内是否稳定、新快照是否按规则重排
//   · total_found / total_returned / truncated 是否自洽
//   · Delta：baseline / added / removed / changed 的变化轨迹
//   · scan.duration_ms、scan.reused、scan.timestamp
//   · 状态文件的新鲜度、写入间隔、nearby JSON 体积
//
// 安全边界：
//   · 只读状态文件（lib/bridge.js readState），**从不调用 bridge.call**，不给游戏发任何动作
//   · 不写游戏目录、不改存档、不改 mod 配置
//   · 不改生产代码；不改 tools/m12-watch.mjs（M1.2 的验收工具保持原样）
//
// 用法：
//   node tools/m14-watch.mjs --seconds 60
//   node tools/m14-watch.mjs --seconds 60 --interval 500 --out tests/artifacts/M1_4

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { GameBridge } from '../lib/bridge.js'
import { normalizeState } from '../lib/state/snapshot.js'
import { createWatchStats } from './watch-counters.mjs'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const seconds = Number(arg('seconds', 60)) || 60
const intervalMs = Number(arg('interval', 500)) || 500
const outDir = arg('out', join('tests', 'artifacts', 'M1_4'))
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

const BUCKETS = ['threats', 'food', 'resources', 'containers', 'structures', 'creatures', 'other']

const bridge = new GameBridge({ log: (level, msg) => console.log(`[${level}] ${msg}`) })

// ── 采样状态 ──
const frames = []
const counters = createWatchStats() // 轮询 / 文件版本 / 扫描快照 三层分开统计
const parseErrors = []
const perSnapshot = new Map() // snapshot_id → { firstSeen, lastSeen, refs, refsStable, ... }
const deltaTimeline = []      // 每次 delta 内容变化都记一条
let lastDeltaKey = null
const statusCounts = { ok: 0, empty: 0, error: 0, missing: 0, unknown: 0 }
const bucketSeen = Object.fromEntries(BUCKETS.map((k) => [k, 0]))
const nearbyBytes = []
const mtimeDeltas = []
let lastMtime = null
let seqRegressions = 0
let lastSeq = null
const refIssues = []
const totalsIssues = []

const flatRefs = (nearby) => {
  const out = []
  const buckets = nearby?.buckets
  if (!buckets) return out
  if (Array.isArray(buckets)) {
    // 旧结构（M1.1）：[{kind,label,items}]，没有 ref
    for (const group of buckets) for (const item of group.items ?? []) out.push(item)
    return out
  }
  for (const key of Object.keys(buckets)) {
    const list = buckets[key]
    if (Array.isArray(list)) for (const item of list) out.push(item)
  }
  return out
}

const bucketCounts = (nearby) => {
  const counts = {}
  const buckets = nearby?.buckets
  for (const key of BUCKETS) counts[key] = 0
  if (!buckets) return counts
  if (Array.isArray(buckets)) {
    for (const group of buckets) {
      const kind = group.kind ?? 'other'
      counts[kind] = (counts[kind] ?? 0) + (group.items?.length ?? 0)
    }
    return counts
  }
  for (const key of Object.keys(buckets)) {
    counts[key] = Array.isArray(buckets[key]) ? buckets[key].length : 0
  }
  return counts
}

console.log(`M1.4 采样：${seconds} 秒 / 每 ${intervalMs}ms → ${outDir}`)
console.log('（只读：不发任何游戏动作，随时 Ctrl+C）\n')

const startedAt = Date.now()
while (Date.now() - startedAt < seconds * 1000) {
  const t = Date.now()
  let state = null
  try {
    state = bridge.readState()
  } catch (error) {
    parseErrors.push({ t, where: 'readState', message: String(error?.message ?? error) })
  }

  if (!state) {
    statusCounts.missing++
    counters.poll({ snapshot: null })
    frames.push({ t, status: 'missing' })
    await new Promise((r) => setTimeout(r, intervalMs))
    continue
  }

  const ageMs = Number.isFinite(state.ageMs) ? state.ageMs : Math.max(0, t - Number(state.mtimeMs ?? 0))
  let snapshot = null
  try {
    snapshot = normalizeState(state.json, { ageMs, path: state.path })
  } catch (error) {
    parseErrors.push({ t, where: 'normalizeState', message: String(error?.message ?? error) })
  }
  counters.poll({ snapshot, parseError: parseErrors.length > 0 ? parseErrors[parseErrors.length - 1].message : null })

  const nearby = snapshot?.nearby ?? null
  const refs = flatRefs(nearby)
  const counts = bucketCounts(nearby)
  for (const key of BUCKETS) if (counts[key] > 0) bucketSeen[key]++

  // 引用唯一性 / 连续性
  const refValues = refs.map((r) => r.ref).filter(Boolean)
  if (refValues.length > 0) {
    const unique = new Set(refValues)
    if (unique.size !== refValues.length) {
      refIssues.push({ t, kind: 'duplicate_ref', refs: refValues, snapshotId: nearby?.snapshot_id })
    }
    const numbers = refValues.map((r) => Number(String(r).replace('#', ''))).sort((a, b) => a - b)
    for (let i = 0; i < numbers.length; i++) {
      if (numbers[i] !== i + 1) {
        refIssues.push({ t, kind: 'not_continuous', refs: refValues, snapshotId: nearby?.snapshot_id })
        break
      }
    }
  }

  // totals 自洽
  if (nearby && nearby.status !== 'error') {
    if (nearby.total_returned !== refs.length) {
      totalsIssues.push({ t, kind: 'returned_mismatch', total_returned: nearby.total_returned, actual: refs.length })
    }
    if (typeof nearby.total_found === 'number' && typeof nearby.total_returned === 'number') {
      if (nearby.total_returned > nearby.total_found) {
        totalsIssues.push({ t, kind: 'returned_gt_found', found: nearby.total_found, returned: nearby.total_returned })
      }
      const expectedTruncated = nearby.total_returned < nearby.total_found
      if (nearby.truncated !== expectedTruncated) {
        totalsIssues.push({ t, kind: 'truncated_mismatch', truncated: nearby.truncated, found: nearby.total_found, returned: nearby.total_returned })
      }
    }
  }

  // 按 snapshot_id 归并（同一快照的引用必须稳定）
  const sid = nearby?.snapshot_id
  if (sid) {
    const entry = perSnapshot.get(sid) ?? { snapshotId: sid, firstSeen: t, lastSeen: t, samples: 0, refs: null, refsStable: true, reusedSeen: false, freshSeen: false }
    entry.lastSeen = t
    entry.samples++
    const sig = JSON.stringify(refValues)
    if (entry.refs === null) entry.refs = sig
    else if (entry.refs !== sig) {
      entry.refsStable = false
      refIssues.push({ t, kind: 'refs_changed_within_snapshot', snapshotId: sid })
    }
    if (nearby.scan?.reused === true) entry.reusedSeen = true
    else entry.freshSeen = true
    perSnapshot.set(sid, entry)
  }

  // Delta 轨迹
  const delta = nearby?.delta
  if (delta) {
    const key = JSON.stringify([delta.status, delta.added_count, delta.removed_count, delta.changed_count])
    if (key !== lastDeltaKey) {
      lastDeltaKey = key
      deltaTimeline.push({
        t,
        snapshotId: sid,
        status: delta.status,
        added_count: delta.added_count,
        removed_count: delta.removed_count,
        changed_count: delta.changed_count,
        added: delta.added ?? [],
        removed: delta.removed ?? [],
        changed: delta.changed ?? [],
      })
    }
  }

  // 序列 / 新鲜度 / 体积
  if (lastSeq !== null && snapshot?.sequence !== null && snapshot.sequence < lastSeq) seqRegressions++
  if (snapshot?.sequence !== null) lastSeq = snapshot.sequence
  if (Number.isFinite(ageMs)) {
    const mtime = t - ageMs
    if (lastMtime !== null && Math.abs(mtime - lastMtime) > 50) mtimeDeltas.push(Math.abs(mtime - lastMtime))
    lastMtime = mtime
  }
  if (nearby) nearbyBytes.push(Buffer.byteLength(JSON.stringify(nearby), 'utf8'))

  const statusKey = ['ok', 'empty', 'error'].includes(nearby?.status) ? nearby.status : (nearby ? 'unknown' : 'unknown')
  statusCounts[statusKey] = (statusCounts[statusKey] ?? 0) + 1

  frames.push({
    t,
    ageMs,
    stale: snapshot?.stale ?? null,
    sequence: snapshot?.sequence ?? null,
    schema: snapshot?.schema ?? null,
    actorId: snapshot?.actor?.actorId ?? null,
    actorTile: snapshot?.actor ? [snapshot.actor.tileX, snapshot.actor.tileZ] : null,
    playerInventoryUsed: snapshot?.player?.inventory?.used ?? null,
    worldDay: snapshot?.world?.day ?? null,
    nearby: nearby
      ? {
          status: nearby.status,
          schema: nearby.schema,
          snapshotId: nearby.snapshot_id,
          radius: nearby.radius,
          totalFound: nearby.total_found,
          totalReturned: nearby.total_returned,
          truncated: nearby.truncated,
          bucketCounts: counts,
          delta: delta
            ? { status: delta.status, added: delta.added_count, removed: delta.removed_count, changed: delta.changed_count }
            : null,
          scan: nearby.scan ?? null,
          refs: refValues,
        }
      : null,
  })

  await new Promise((r) => setTimeout(r, intervalMs))
}

// ── 汇总 ──
const median = (list) => {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const snapshotIds = [...perSnapshot.keys()]
const snapshotsWithData = snapshotIds.map((id) => perSnapshot.get(id))
const lastFrame = [...frames].reverse().find((f) => f.nearby) ?? null

const summary = {
  startedAt: new Date(startedAt).toISOString(),
  finishedAt: new Date().toISOString(),
  seconds,
  intervalMs,
  frames: frames.length,
  statePath: bridge.readState()?.path ?? null,
  statusCounts,
  bucketsObserved: bucketSeen,
  snapshots: {
    count: snapshotIds.length,
    ids: snapshotIds,
    allRefsStableWithinSnapshot: snapshotsWithData.every((s) => s.refsStable),
    reusedSnapshots: snapshotsWithData.filter((s) => s.reusedSeen && !s.freshSeen).length,
    freshSnapshots: snapshotsWithData.filter((s) => s.freshSeen).length,
  },
  // 三层口径（0.13.4 修：不要把"轮询次数"当成"观察次数"）
  cache: counters.summary(),
  sequence: { last: lastSeq, regressions: seqRegressions },
  writeIntervalMsMedian: median(mtimeDeltas),
  nearbyBytes: {
    min: nearbyBytes.length ? Math.min(...nearbyBytes) : null,
    max: nearbyBytes.length ? Math.max(...nearbyBytes) : null,
    median: median(nearbyBytes),
  },
  scanDurationMsSeen: [...new Set(frames.map((f) => f.nearby?.scan?.duration_ms).filter((v) => v !== undefined && v !== null))].slice(0, 20),
  refIssues,
  totalsIssues,
  deltaTimeline,
  deltaStatusesSeen: [...new Set(deltaTimeline.map((d) => d.status))],
  lastFrame,
  parseErrors,
  verdict: {
    nearbySeen: lastFrame !== null,
    threeStates: statusCounts,
    emptyIsNotError: !(statusCounts.empty > 0 && statusCounts.error > 0 && lastFrame?.nearby?.status === 'unknown'),
    refsOk: refIssues.length === 0,
    totalsOk: totalsIssues.length === 0,
  },
}

mkdirSync(outDir, { recursive: true })
const jsonPath = join(outDir, `m14-runtime-${stamp}.json`)
writeFileSync(jsonPath, JSON.stringify({ summary, frames, perSnapshot: snapshotsWithData }, null, 1), 'utf8')

const lines = [
  `# M1.4 真机采样 ${summary.startedAt}`,
  '',
  `- 采样：${summary.frames} 帧 / ${seconds} 秒（每 ${intervalMs}ms）`,
  `- 状态文件：${summary.statePath ?? '**没找到**'}`,
  `- nearby 三态计数：ok=${statusCounts.ok ?? 0} empty=${statusCounts.empty ?? 0} error=${statusCounts.error ?? 0} missing=${statusCounts.missing ?? 0} unknown=${statusCounts.unknown ?? 0}`,
  `- 七个桶（出现过的帧数）：${JSON.stringify(bucketSeen)}`,
  `- 轮询 ${summary.cache.poll_count} 次 ｜ 唯一文件版本 ${summary.cache.unique_file_versions} ｜ 重复轮询 ${summary.cache.duplicate_polls}`,
  `- 其中 reused 版本 ${summary.cache.reused_file_versions} ｜ 新扫描版本 ${summary.cache.fresh_scan_file_versions} ｜ 复用率 ${summary.cache.reused_ratio}`,
  `- 去重键：${summary.cache.version_key_kind} ｜ 解析错误 ${summary.cache.parse_errors} ｜ 缺文件帧 ${summary.cache.missing_frames}`,
  `- 扫描快照：${summary.snapshots.count} 个 ${JSON.stringify(summary.snapshots.ids)}`,
  `  · 同一快照内引用稳定：${summary.snapshots.allRefsStableWithinSnapshot}`,
  `  · 纯复用快照：${summary.snapshots.reusedSnapshots} ｜ 含新扫描的快照：${summary.snapshots.freshSnapshots}`,
  `- 序列：last=${summary.sequence.last} 回退=${summary.sequence.regressions}`,
  `- 写盘间隔中位数：${summary.writeIntervalMsMedian ?? '—'} ms`,
  `- nearby JSON 体积：min=${summary.nearbyBytes.min} / median=${summary.nearbyBytes.median} / max=${summary.nearbyBytes.max} 字节`,
  `- scan.duration_ms 观察到：${JSON.stringify(summary.scanDurationMsSeen)}`,
  `- Delta 状态：${JSON.stringify(summary.deltaStatusesSeen)} ｜ 轨迹条数：${deltaTimeline.length}`,
  `- 引用问题：${refIssues.length} ｜ totals 问题：${totalsIssues.length} ｜ JSON 解析错误：${parseErrors.length}`,
  '',
  lastFrame?.nearby
    ? `最后一帧：status=${lastFrame.nearby.status} found=${lastFrame.nearby.totalFound} returned=${lastFrame.nearby.totalReturned} truncated=${lastFrame.nearby.truncated} 桶=${JSON.stringify(lastFrame.nearby.bucketCounts)}`
    : '最后一帧：没有 nearby 数据',
  '',
  '## Delta 轨迹',
  ...(deltaTimeline.length
    ? deltaTimeline.map((d) => `- ${new Date(d.t).toISOString()} 快照 ${d.snapshotId} ${d.status} added=${d.added_count} removed=${d.removed_count} changed=${d.changed_count}`)
    : ['- （窗口内 delta 没有变化）']),
]
if (refIssues.length) lines.push('', '## 引用问题', ...refIssues.slice(0, 20).map((x) => `- ${JSON.stringify(x)}`))
if (totalsIssues.length) lines.push('', '## totals 问题', ...totalsIssues.slice(0, 20).map((x) => `- ${JSON.stringify(x)}`))
if (parseErrors.length) lines.push('', '## JSON / 解析错误', ...parseErrors.slice(0, 10).map((x) => `- ${JSON.stringify(x)}`))

writeFileSync(join(outDir, `m14-runtime-${stamp}.md`), lines.join('\n') + '\n', 'utf8')
console.log('\n' + lines.join('\n'))
console.log(`\n原始数据：${jsonPath}`)
