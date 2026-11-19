// 世界记忆（World Memory）：按世界（存档 + 分片）分开存的长期发展状态。
//
// 为什么需要：现在 plan.js 是纯函数，重启 Node / 换 F8 与 MCP 入口就什么都记不住。
// 本模块把"阵营/家/阶段/任务看板/已完成里程碑/已知建筑/近期失败"落盘，**按 world_key 分文件**，
// 换世界绝不继承旧家的坐标（复用 notes-store 的 sanitizeWorldKey，和笔记同一套隔离规则）。
//
// 边界：
//   · 只碰文件系统，不碰游戏、不碰桥。
//   · world_key 读不到（老存档/世界未就绪）→ 用"未绑定世界"的暂存文件，但**明确标 worldKey=null**，
//     调用方不得把里面的坐标当成当前世界的。
//   · 只写结构化字段；自由文本笔记仍然走 notes-store，二者互不覆盖。

import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { sanitizeWorldKey, defaultNotesDir } from '../notes-store.js'

export const MEMORY_SCHEMA = 'bws.world-memory/1'

/** 记忆根目录（和笔记同一个插件数据目录下的 planner-memory/） */
export function defaultMemoryDir(home) {
  return join(defaultNotesDir(home), 'planner-memory')
}

/** 从归一化快照里取当前世界标识；取不到返回 null（不猜）。 */
export function worldKeyOfSnapshot(snapshot) {
  const k = snapshot?.identity?.worldKey
  return typeof k === 'string' && k !== '' && k !== 'unknown' ? k : null
}

/** 一份全新的空记忆（给定 worldKey 可为 null） */
export function emptyMemory(worldKey = null) {
  return {
    schema: MEMORY_SCHEMA,
    worldKey: worldKey ?? null,
    camp_site: null,
    backup_site: null,
    home_building_id: null,
    home_anchor: null,
    current_stage: 0,
    current_goal: null,
    active_skill_id: null,
    task_board: null,
    skill_instances: {},
    explored_regions: [],
    known_resources: [],
    completed_milestones: [],
    blocked_tasks: [],
    danger_zones: [],
    known_buildings: [],
    recent_failures: [],
    updatedAt: 0,
  }
}

const ARRAY_FIELDS = [
  'completed_milestones',
  'blocked_tasks',
  'danger_zones',
  'known_buildings',
  'recent_failures',
  'explored_regions',
  'known_resources',
]

/** 把读到的 JSON 合并进缺省结构：缺字段补默认，绝不因为文件被改坏就把整份记忆丢掉。 */
export function normalizeMemory(raw, worldKey = null) {
  const base = emptyMemory(worldKey)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  const out = { ...base, ...raw, schema: MEMORY_SCHEMA }
  // worldKey 永远以"当前世界"为准，不信任文件里写的（防止有人把旧世界文件拷过来冒充）
  out.worldKey = worldKey ?? null
  for (const field of ARRAY_FIELDS) {
    if (!Array.isArray(out[field])) out[field] = []
  }
  if (!out.skill_instances || typeof out.skill_instances !== 'object' || Array.isArray(out.skill_instances)) {
    out.skill_instances = {}
  }
  if (typeof out.current_stage !== 'number' || !Number.isFinite(out.current_stage)) out.current_stage = 0
  out.current_stage = Math.max(0, Math.min(6, Math.trunc(out.current_stage)))
  if (out.camp_site && (typeof out.camp_site.x !== 'number' || typeof out.camp_site.z !== 'number')) out.camp_site = null
  if (out.backup_site && (typeof out.backup_site.x !== 'number' || typeof out.backup_site.z !== 'number')) out.backup_site = null
  if (out.home_building_id !== null && typeof out.home_building_id !== 'string') out.home_building_id = null
  out.active_skill_id = typeof out.active_skill_id === 'string' ? out.active_skill_id : null
  return out
}

/**
 * 世界记忆存储。
 * @param {{dir?:string}} opts
 */
export function createWorldMemoryStore({ dir = defaultMemoryDir() } = {}) {
  const unknownPath = join(dir, '_unbound-world.json')

  function pathFor(worldKey) {
    const safe = sanitizeWorldKey(worldKey)
    return safe === null ? unknownPath : join(dir, 'worlds', `${safe}.json`)
  }

  /** 读一份记忆；文件不存在/损坏都返回空记忆（不抛错，失败要安全）。 */
  function load(worldKey = null) {
    const path = pathFor(worldKey)
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      return normalizeMemory(raw, sanitizeWorldKey(worldKey) === null ? null : worldKey)
    } catch {
      return emptyMemory(sanitizeWorldKey(worldKey) === null ? null : worldKey)
    }
  }

  /** 覆盖写一份记忆；自动补 updatedAt。返回落盘路径。 */
  function save(memory) {
    const mem = normalizeMemory(memory, memory?.worldKey ?? null)
    mem.updatedAt = Date.now()
    const path = pathFor(mem.worldKey)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(mem, null, 2), 'utf8')
    return path
  }

  /** 局部更新：读 → 合并 → 写。patch 里的数组字段是**替换**语义（调用方自己维护历史）。 */
  function update(worldKey, patch) {
    const mem = load(worldKey)
    const next = { ...mem, ...(patch ?? {}) }
    // worldKey 不能通过 patch 篡改
    next.worldKey = mem.worldKey
    save(next)
    return normalizeMemory(next, mem.worldKey)
  }

  /** 这个目录下已有哪些世界（诊断/测试用） */
  function listWorlds() {
    try {
      return readdirSync(join(dir, 'worlds')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()
    } catch {
      return []
    }
  }

  /** 清空某个世界的记忆（测试/显式重置用） */
  function reset(worldKey) {
    try { rmSync(pathFor(worldKey), { force: true }) } catch {}
  }

  return { dir, pathFor, load, save, update, listWorlds, reset, unknownPath }
}
