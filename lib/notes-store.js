// 长期笔记存储：**按世界（存档 + 分片）隔离**
//
// 防止跨存档读取到旧世界的基地坐标或进度笔记。
//
// 规则（明确、失败要安全）：
//   · world_key 由游戏侧给出（observe.lua：cluster_id + shard_id，读不到才退回 session_id）。
//   · 每个 world_key 一个文件：<dir>/notes/<sanitized-world-key>.md
//   · world_key 读不到（老存档 / 世界还没起来）→ 用**旧的单文件** notes.md（向后兼容）。
//     这种情况明确标成 "unknown world"，不会把某个具体世界的坐标偷偷带过来。
//   · **旧世界的笔记不删**：换回来还能看见；只是当前世界看不到、也不会被当成当前坐标。
//
// 这个模块只碰文件系统，不碰游戏、不碰桥。测试直接构造临时目录验它。

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** world_key → 安全的文件名片段（只留字母数字和 -_.；其余换成 _） */
export function sanitizeWorldKey(worldKey) {
  if (typeof worldKey !== 'string') return null
  const trimmed = worldKey.trim()
  if (trimmed === '' || trimmed === 'unknown') return null
  const safe = trimmed.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 120)
  return safe === '' ? null : safe
}

export function defaultNotesDir(home = process.env.DSH_HOME
  || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')) {
  return join(home, 'plugins-data', 'dsh-dont-starve-blind-whale-survivor')
}

export function createNotesStore({ dir = defaultNotesDir() } = {}) {
  const legacyPath = join(dir, 'notes.md')
  const worldDir = join(dir, 'notes')

  /** 当前世界对应的笔记文件；world_key 读不到就退回旧的单文件 */
  function pathFor(worldKey) {
    const safe = sanitizeWorldKey(worldKey)
    return safe === null ? legacyPath : join(worldDir, `${safe}.md`)
  }

  /**
   * 读笔记。返回 { content, path, worldKey, legacy }。
   * world_key 读不到时用 legacy 文件，并显式标 legacy=true —— 调用方要把它当"不确定属于哪个世界"。
   */
  function read(worldKey) {
    const path = pathFor(worldKey)
    const legacy = path === legacyPath
    try {
      return { content: readFileSync(path, 'utf8'), path, worldKey: legacy ? null : worldKey, legacy }
    } catch {
      return { content: '', path, worldKey: legacy ? null : worldKey, legacy }
    }
  }

  /** 写笔记（覆盖写）。返回落盘路径。 */
  function write(text, worldKey) {
    const path = pathFor(worldKey)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, String(text ?? ''), 'utf8')
    return path
  }

  /** 这个目录下已经有哪些世界的笔记（诊断/测试用） */
  function listWorlds() {
    try {
      return readdirSync(worldDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort()
    } catch {
      return []
    }
  }

  return { dir, legacyPath, worldDir, pathFor, read, write, listWorlds }
}
