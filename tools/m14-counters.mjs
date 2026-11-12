// m14-watch 的统计口径（纯函数，无副作用，便于单元测试）
//
// 为什么要单独一层：watcher 每 500ms 轮询一次状态文件，而状态文件约 1 秒才更新一次、
// 附近完整扫描约 4 秒才更新一次。直接把"轮询次数"当成"游戏观察次数"会严重高估，
// 也会让 reused/fresh 的比例失真。
//
// 统计口径（三层，必须分开）：
//   1. poll_count            watcher 轮询了几次（跟时间有关，跟游戏无关）
//   2. unique_file_versions  状态文件真正"换了一版"几次（去重后）
//   3. unique_snapshot_ids   其中 nearby 扫描快照有几个（扫描比写盘更慢）
//
// 去重键：session_id + shard_id + runtime_id + sequence
//   · 带上 runtime_id 是为了处理"游戏重启后 sequence 归零"的情况：
//     重启后 runtime_id 变了，即便 sequence 从 1 重新开始，也不会被误判成同一个版本。
//   · 缺 runtime_id（0.13.2 以前的状态）时退回 sequence 键，并在结果里标注
//     version_key_kind = "sequence"，提醒这批数据的去重不可靠。

export const VERSION_KEY_KINDS = {
  full: 'session+shard+runtime+sequence',
  sequence: 'sequence',
}

/** 从一个归一化快照里取"版本号"要素 */
export function versionPartsOf(snapshot) {
  return {
    sessionId: snapshot?.identity?.sessionId ?? null,
    shardId: snapshot?.identity?.shardId ?? null,
    runtimeId: snapshot?.nearby?.runtime_id ?? null,
    sequence: snapshot?.sequence ?? null,
  }
}

/**
 * 生成去重键。
 * @returns {{ key: string|null, kind: string }}
 */
export function versionKeyOf(snapshot) {
  const parts = versionPartsOf(snapshot)
  if (parts.sequence === null || parts.sequence === undefined) return { key: null, kind: VERSION_KEY_KINDS.sequence }
  if (parts.runtimeId) {
    return {
      key: [parts.sessionId ?? '?', parts.shardId ?? '?', parts.runtimeId, parts.sequence].join('|'),
      kind: VERSION_KEY_KINDS.full,
    }
  }
  // 没有 runtime_id：只能退到 sequence（跨重启不可靠，结果里会标出来）
  return { key: `seq:${parts.sequence}`, kind: VERSION_KEY_KINDS.sequence }
}

/**
 * 统计器。
 * 用法：
 *   const stats = createWatchStats()
 *   stats.poll({ snapshot })            // 每轮询一次调一次
 *   stats.poll({ parseError: '...' })   // 解析失败也要记
 *   stats.summary()
 */
export function createWatchStats() {
  const versions = new Map() // key -> { sequence, reused, snapshotId }
  const snapshotIds = new Set()
  let pollCount = 0
  let missingFrames = 0
  let parseErrors = 0
  let keyKinds = new Set()

  return {
    poll({ snapshot = null, parseError = null } = {}) {
      pollCount++
      if (parseError) parseErrors++
      if (!snapshot) {
        if (!parseError) missingFrames++ // 解析失败是"有文件但读不懂"，不算 missing
        return
      }
      const { key, kind } = versionKeyOf(snapshot)
      if (key === null) {
        missingFrames++
        return
      }
      keyKinds.add(kind)
      if (!versions.has(key)) {
        versions.set(key, {
          sequence: snapshot.sequence ?? null,
          reused: snapshot.nearby?.scan?.reused === true,
          snapshotId: snapshot.nearby?.snapshot_id ?? null,
        })
      }
      const snapshotId = snapshot.nearby?.snapshot_id
      if (snapshotId) snapshotIds.add(snapshotId)
    },

    summary() {
      const all = [...versions.values()]
      const reused = all.filter((v) => v.reused).length
      const fresh = all.length - reused
      const ratio = (n) => (all.length === 0 ? null : Math.round((n / all.length) * 1000) / 1000)
      return {
        poll_count: pollCount,
        unique_file_versions: all.length,
        duplicate_polls: Math.max(0, pollCount - all.length - missingFrames),
        unique_snapshot_ids: snapshotIds.size,
        reused_file_versions: reused,
        fresh_scan_file_versions: fresh,
        reused_ratio: ratio(reused),
        fresh_scan_ratio: ratio(fresh),
        missing_frames: missingFrames,
        parse_errors: parseErrors,
        version_key_kind: keyKinds.size === 1 ? [...keyKinds][0] : keyKinds.size === 0 ? null : 'mixed',
      }
    },
  }
}
