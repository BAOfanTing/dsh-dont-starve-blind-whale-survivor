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
export const SUPPORTED_SCHEMAS = new Set(['bws.world-memory/1'])

/** 记忆根目录（和笔记同一个插件数据目录下的 planner-memory/） */
export function defaultMemoryDir(home) {
  return join(defaultNotesDir(home), 'planner-memory')
}

/** 从归一化快照里取当前世界标识；取不到返回 null（不猜）。 */
export function worldKeyOfSnapshot(snapshot) {
  const k = snapshot?.identity?.worldKey
  return typeof k === 'string' && k !== '' && k !== 'unknown' ? k : null
}

/**
 * 包装 skill_instances 字典，使其支持：
 * 1. 原生以 instance_id 为权威键；
 * 2. 兼容旧代码直接用 .<skill_id> 或 .<task_id> 读取对应的活动或最新实例；
 * 3. 保持 JSON 序列化与 assert.deepEqual 只比较自身权威字段。
 */
export function wrapSkillInstances(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return {}
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop !== 'string' || prop in t || prop === 'then' || prop === 'inspect') {
        return Reflect.get(t, prop, receiver)
      }
      const values = Object.values(t).filter((x) => x && typeof x === 'object')
      const activeMatch = values.find((x) => (x.task_id === prop || x.skill_id === prop) && !['completed', 'failed', 'cancelled'].includes(x.status))
      if (activeMatch) return activeMatch
      const latestMatch = values.filter((x) => x.task_id === prop || x.skill_id === prop).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0]
      if (latestMatch) return latestMatch
      return undefined
    },
  })
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
    active_skill_instance_id: null,
    task_board: null,
    skill_instances: wrapSkillInstances({}),
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

export const ARRAY_FIELDS = [
  'completed_milestones',
  'blocked_tasks',
  'danger_zones',
  'known_buildings',
  'recent_failures',
  'explored_regions',
  'known_resources',
]

/**
 * 校验一份记忆对象的结构完整性与字段有效性
 * @param {object} memory
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateMemory(memory) {
  const errors = []
  if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
    return { valid: false, errors: ['memory must be an object'] }
  }
  if (!SUPPORTED_SCHEMAS.has(memory.schema)) {
    errors.push(`unsupported schema: ${memory.schema}`)
  }
  if (memory.current_stage !== undefined) {
    if (typeof memory.current_stage !== 'number' || !Number.isFinite(memory.current_stage) || memory.current_stage < 0 || memory.current_stage > 6) {
      errors.push(`current_stage out of range: ${memory.current_stage}`)
    }
  }
  if (memory.camp_site && (typeof memory.camp_site.x !== 'number' || typeof memory.camp_site.z !== 'number' || !Number.isFinite(memory.camp_site.x) || !Number.isFinite(memory.camp_site.z))) {
    errors.push('camp_site must have valid numeric x and z')
  }
  if (memory.backup_site && (typeof memory.backup_site.x !== 'number' || typeof memory.backup_site.z !== 'number' || !Number.isFinite(memory.backup_site.x) || !Number.isFinite(memory.backup_site.z))) {
    errors.push('backup_site must have valid numeric x and z')
  }
  if (memory.home_anchor && (typeof memory.home_anchor.x !== 'number' || typeof memory.home_anchor.z !== 'number' || !Number.isFinite(memory.home_anchor.x) || !Number.isFinite(memory.home_anchor.z))) {
    errors.push('home_anchor must have valid numeric x and z')
  }
  for (const field of ARRAY_FIELDS) {
    if (memory[field] !== undefined && !Array.isArray(memory[field])) {
      errors.push(`field ${field} must be an array`)
    }
  }
  if (memory.skill_instances !== undefined && (typeof memory.skill_instances !== 'object' || Array.isArray(memory.skill_instances))) {
    errors.push('skill_instances must be an object')
  }
  if (memory.active_skill_instance_id !== undefined && memory.active_skill_instance_id !== null && typeof memory.active_skill_instance_id !== 'string') {
    errors.push('active_skill_instance_id must be a string or null')
  }
  return { valid: errors.length === 0, errors }
}

/**
 * 版本升级与自愈迁移：
 * 将旧版 / 无版本 / 字段损坏的记忆平滑升级到 targetSchema。
 * @param {object} raw
 * @param {string} [targetSchema]
 * @returns {object}
 */
export function migrateMemory(raw, targetSchema = MEMORY_SCHEMA) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyMemory()
  }
  const migrated = { ...raw }
  const originalSchema = raw.schema ?? null

  // 1. Schema 判定与升级
  if (!originalSchema || !SUPPORTED_SCHEMAS.has(originalSchema)) {
    migrated.schema = targetSchema
    migrated._migrated_from = originalSchema ?? 'legacy_unversioned'
  }

  // 2. 坐标与锚点自愈
  if (migrated.camp_site && (typeof migrated.camp_site.x !== 'number' || typeof migrated.camp_site.z !== 'number' || !Number.isFinite(migrated.camp_site.x) || !Number.isFinite(migrated.camp_site.z))) {
    migrated.camp_site = null
  }
  if (migrated.backup_site && (typeof migrated.backup_site.x !== 'number' || typeof migrated.backup_site.z !== 'number' || !Number.isFinite(migrated.backup_site.x) || !Number.isFinite(migrated.backup_site.z))) {
    migrated.backup_site = null
  }
  if (migrated.home_anchor && (typeof migrated.home_anchor.x !== 'number' || typeof migrated.home_anchor.z !== 'number' || !Number.isFinite(migrated.home_anchor.x) || !Number.isFinite(migrated.home_anchor.z))) {
    migrated.home_anchor = null
  }
  if (migrated.home_building_id !== null && typeof migrated.home_building_id !== 'string') {
    migrated.home_building_id = null
  }

  // 3. 阶段与目标自愈
  if (typeof migrated.current_stage !== 'number' || !Number.isFinite(migrated.current_stage)) {
    migrated.current_stage = 0
  }
  migrated.current_stage = Math.max(0, Math.min(6, Math.trunc(migrated.current_stage)))
  if (migrated.current_goal !== null && typeof migrated.current_goal !== 'string') {
    migrated.current_goal = null
  }

  // 4. 技能与任务结构自愈
  migrated.active_skill_id = typeof migrated.active_skill_id === 'string' && migrated.active_skill_id.length > 0 ? migrated.active_skill_id : null
  migrated.active_skill_instance_id = typeof migrated.active_skill_instance_id === 'string' && migrated.active_skill_instance_id.length > 0 ? migrated.active_skill_instance_id : null
  if (!migrated.skill_instances || typeof migrated.skill_instances !== 'object' || Array.isArray(migrated.skill_instances)) {
    migrated.skill_instances = wrapSkillInstances({})
  } else {
    migrated.skill_instances = wrapSkillInstances(migrated.skill_instances)
    if (!migrated.active_skill_instance_id && migrated.active_skill_id) {
      const match = Object.values(migrated.skill_instances).find((x) => x.skill_id === migrated.active_skill_id && (x.status === 'in_progress' || x.status === 'paused'))
      if (match && match.instance_id) migrated.active_skill_instance_id = match.instance_id
    }
  }
  if (migrated.task_board && (typeof migrated.task_board !== 'object' || Array.isArray(migrated.task_board))) {
    migrated.task_board = null
  }

  // 5. 数组字段自愈
  for (const field of ARRAY_FIELDS) {
    if (!Array.isArray(migrated[field])) {
      migrated[field] = []
    }
  }

  // 6. 时间戳自愈
  if (typeof migrated.updatedAt !== 'number' || !Number.isFinite(migrated.updatedAt)) {
    migrated.updatedAt = 0
  }

  return migrated
}

/** 把读到的 JSON 合并进缺省结构：缺字段补默认，绝不因为文件被改坏就把整份记忆丢掉。 */
export function normalizeMemory(raw, worldKey = null) {
  const base = emptyMemory(worldKey)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  const migrated = migrateMemory(raw, MEMORY_SCHEMA)
  const out = { ...base, ...migrated, schema: MEMORY_SCHEMA }
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
  out.active_skill_id = typeof out.active_skill_id === 'string' && out.active_skill_id.length > 0 ? out.active_skill_id : null
  out.active_skill_instance_id = typeof out.active_skill_instance_id === 'string' && out.active_skill_instance_id.length > 0 ? out.active_skill_instance_id : null
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

  /** 读一份记忆；文件不存在/损坏都返回空记忆（不抛错，失败要安全）。支持自动升级与自愈。 */
  function load(worldKey = null) {
    const path = pathFor(worldKey)
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      const normalized = normalizeMemory(raw, sanitizeWorldKey(worldKey) === null ? null : worldKey)
      // 若发生了 schema 升级或数据自愈修复，自动保存最新格式（自愈落盘）
      if (raw && (raw.schema !== MEMORY_SCHEMA || raw._migrated_from || !raw.skill_instances)) {
        try {
          if (sanitizeWorldKey(worldKey) !== null) save(normalized)
        } catch {}
      }
      return normalized
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
