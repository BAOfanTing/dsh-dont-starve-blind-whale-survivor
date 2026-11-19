// TARGET-REFRESH §5：长期记忆绑定 World/Save
//
// 真机证据（session.txt）：换了存档之后，笔记里还留着旧基地坐标 (21,-81)，
// 而角色其实已经在 (-21,-5) —— 模型照着旧坐标走，整个计划从一开始就是错的。
//
// 规则：笔记按 world_key（cluster_id + shard_id，读不到才退回 session_id）分开存；
// 旧世界的笔记**不删**，但当前世界看不到、也不会被当成当前坐标。
//
// 证据类型：
//   · UNIT        —— notes-store + get_state + plan（真实现，假 bridge）
//   · INTEGRATION —— observe.lua 真的输出 world_key（fengari）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createNotesStore, sanitizeWorldKey } from '../lib/notes-store.js'
import { createWorldMemoryStore, emptyMemory, normalizeMemory } from '../lib/planner/world-memory.js'
import { executeTool } from '../lib/tools.js'
import { derivePlan } from '../lib/plan.js'
import { MOD, loadTargets } from './target-harness.mjs'

const tempDir = () => mkdtempSync(join(tmpdir(), 'bws-notes-'))

// ─────────────────────────── notes-store（UNIT）───────────────────────────

test('WM-1：不同世界写不同文件，互相看不见', () => {
  const dir = tempDir()
  try {
    const store = createNotesStore({ dir })
    store.write('基地在 (21,-81)，箱子里有木头', 'cluster:AAA/shard:1')
    store.write('基地在 (-21,-5)，新世界重来', 'cluster:BBB/shard:1')

    assert.equal(store.read('cluster:AAA/shard:1').content.includes('(21,-81)'), true)
    assert.equal(store.read('cluster:BBB/shard:1').content.includes('(-21,-5)'), true)
    // ★ 核心要求：新世界**看不到**旧世界的基地坐标
    assert.equal(store.read('cluster:BBB/shard:1').content.includes('(21,-81)'), false)
    assert.equal(store.read('cluster:AAA/shard:1').content.includes('(-21,-5)'), false)
    // 旧世界的笔记没被删
    assert.deepEqual(store.listWorlds(), ['cluster_AAA_shard_1', 'cluster_BBB_shard_1'])
    assert.notEqual(store.pathFor('cluster:AAA/shard:1'), store.pathFor('cluster:BBB/shard:1'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('WM-2：world_key 读不到 → 退回旧的单文件笔记，并且**明确标成未绑定世界**', () => {
  const dir = tempDir()
  try {
    const store = createNotesStore({ dir })
    store.write('这是老版本留下的笔记', null)
    assert.equal(store.read(null).content, '这是老版本留下的笔记')
    assert.equal(store.read(null).legacy, true)
    assert.equal(store.read('unknown').legacy, true, 'unknown 也走 legacy')
    assert.equal(store.pathFor(null), store.legacyPath)
    // 有 world_key 时**不能**去读 legacy（否则旧坐标又回来了）
    assert.equal(store.read('cluster:AAA/shard:1').content, '')
    assert.equal(store.read('cluster:AAA/shard:1').legacy, false)
    // 目录里只能看到真正有世界键的那份
    assert.deepEqual(store.listWorlds(), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('WM-3：world_key 会被清洗成安全文件名（不能借它跳出目录）', () => {
  assert.equal(sanitizeWorldKey('cluster:AAA/shard:1'), 'cluster_AAA_shard_1')
  assert.equal(sanitizeWorldKey('../../etc/passwd'), 'etc_passwd')
  assert.equal(sanitizeWorldKey('  cluster-A  '), 'cluster-A')
  assert.equal(sanitizeWorldKey(''), null)
  assert.equal(sanitizeWorldKey('   '), null)
  assert.equal(sanitizeWorldKey('unknown'), null)
  assert.equal(sanitizeWorldKey(null), null)
  const dir = tempDir()
  try {
    const store = createNotesStore({ dir })
    const p = store.write('x', '../../evil')
    assert.ok(p.startsWith(join(dir, 'notes')), `落盘路径必须还在 notes 目录里，实际 ${p}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ─────────────────────────── get_state（UNIT）───────────────────────────

const stateJson = ({ worldKey, worldKeySource = 'cluster_id', sessionId = 'sess-1' } = {}) => ({
  schema: 'bws.state/1',
  observer: { snapshot_id: 's1', sequence: 1, status: 'ok', timestamp: 1, sampled_at: 1, sample_age_ms: 0 },
  identity: worldKey === undefined
    ? { session_id: sessionId, cluster_id: null, cluster_id_source: 'unavailable', shard_id: '1' }
    : { session_id: sessionId, cluster_id: 'AAA', cluster_id_source: 'the_net', shard_id: '1', world_key: worldKey, world_key_source: worldKeySource },
  actor: { valid: true, alive: true, is_ghost: false, actor_type: 'player', prefab: 'wilson', name: '威尔逊', tile_x: 0, tile_z: 0 },
  player: {
    health: { current: 200, max: 200 }, hunger: { current: 200, max: 200 }, sanity: { current: 200, max: 200 },
    inventory: { used: 0, slots: 15, items: [] }, equipment: { slots: {}, worn: [] },
  },
  world: { day: 1, phase: 'day', phase_name: '白天', season: 'autumn', status: 'ok' },
  nearby: { status: 'ok', runtime_id: 'rt-1', snapshot_id: 'rt-1-n1', radius: 16, buckets: {}, total_returned: 0, total_found: 0, truncated: false, scan: { reused: false, age_ms: 0, scan_seconds: 4 } },
  warnings: [],
})

function ctxFor({ dir, json }) {
  const store = createNotesStore({ dir })
  const bridge = {
    // 状态文件的外层包装是 { data: <state> }（模组就是这么写的）
    readState: () => ({ json: { data: json }, ageMs: 0, mtimeMs: Date.now() }),
    call: async () => ({ ok: true, text: '' }),
    leaseDirs: () => [],
    readLeaseAck: () => null,
  }
  return {
    ctx: {
      bridge,
      notes: { read: (wk) => store.read(wk).content, write: (t, wk) => store.write(t, wk) },
      guides: {},
      extraInstructions: '',
    },
    store,
  }
}

test('WM-4：get_state 会显示"笔记按世界分开存"，并且只显示当前世界的笔记', async () => {
  const dir = tempDir()
  try {
    const { ctx, store } = ctxFor({ dir, json: stateJson({ worldKey: 'cluster:AAA/shard:1' }) })
    store.write('基地在 (21,-81)', 'cluster:OLD/shard:1')
    store.write('基地在 (-21,-5)', 'cluster:AAA/shard:1')

    const text = await executeTool('get_state', {}, ctx)
    assert.match(text, /cluster:AAA\/shard:1/, '要显示当前世界标识')
    assert.match(text, /\(-21,-5\)/, '要显示本世界的笔记')
    assert.doesNotMatch(text, /\(21,-81\)/, '**绝不能**把旧世界的基地坐标带出来')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('WM-5：世界换了 → get_state 明确提示"旧世界的坐标/目标已归档"', async () => {
  const dir = tempDir()
  try {
    const holder = { json: stateJson({ worldKey: 'cluster:OLD/shard:1' }) }
    const store = createNotesStore({ dir })
    const ctx = {
      bridge: {
        readState: () => ({ json: { data: holder.json }, ageMs: 0, mtimeMs: Date.now() }),
        call: async () => ({ ok: true, text: '' }),
      },
      notes: { read: (wk) => store.read(wk).content, write: (t, wk) => store.write(t, wk) },
      guides: {},
      extraInstructions: '',
    }
    store.write('基地在 (21,-81)', 'cluster:OLD/shard:1')
    const before = await executeTool('get_state', {}, ctx)
    assert.match(before, /\(21,-81\)/)

    // 换世界
    holder.json = stateJson({ worldKey: 'cluster:NEW/shard:1' })
    const after = await executeTool('get_state', {}, ctx)
    assert.match(after, /世界换了/, '要明确提示世界换过')
    assert.match(after, /cluster:OLD\/shard:1/)
    assert.match(after, /cluster:NEW\/shard:1/)
    assert.doesNotMatch(after, /\(21,-81\)/, '换世界后旧坐标必须消失')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('WM-6：JSON 模式里带 world_key；update_notes 写进当前世界', async () => {
  const dir = tempDir()
  try {
    const { ctx, store } = ctxFor({ dir, json: stateJson({ worldKey: 'cluster:AAA/shard:1' }) })
    // identity 里一定有世界键（笔记为空时也要能看出来"这是哪个世界"）
    const empty = JSON.parse(await executeTool('get_state', { format: 'json' }, ctx))
    assert.equal(empty.identity.world_key, 'cluster:AAA/shard:1')
    assert.equal(empty.identity.world_key_source, 'cluster_id')

    // 有笔记时，notes 上也要带世界键
    store.write('家在 (-21,-5)', 'cluster:AAA/shard:1')
    const parsed = JSON.parse(await executeTool('get_state', { format: 'json' }, ctx))
    assert.equal(parsed.notes?.world_key, 'cluster:AAA/shard:1')
    assert.equal(parsed.notes?.world_key_source, 'cluster_id')
    assert.equal(parsed.notes?.content, '家在 (-21,-5)')

    const written = await executeTool('update_notes', { notes: '家搬到 (-30,-8)' }, ctx)
    assert.match(written, /本世界 cluster:AAA\/shard:1/)
    assert.equal(store.read('cluster:AAA/shard:1').content, '家搬到 (-30,-8)')
    assert.equal(store.read('cluster:OLD/shard:1').content, '', '不能写到别的世界去')
    // 落盘路径确实按世界分了
    assert.ok(store.pathFor('cluster:AAA/shard:1').includes('notes'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ─────────────────────────── plan（UNIT）───────────────────────────

test('WM-7：换世界后上一份计划作废（不把旧世界的目标带过来）', () => {
  const snap = (worldKey, runtimeId) => ({
    status: 'ok',
    identity: { worldKey, sessionId: 's-x' },
    nearby: { runtime_id: runtimeId, buckets: {} },
    player: { hunger: { current: 200, max: 200 }, health: { current: 200, max: 200 }, sanity: { current: 200, max: 200 }, inventory: { items: [] }, equipment: { slots: {} } },
    world: { day: 1, phase: 'day' },
  })
  const first = derivePlan(snap('cluster:OLD/shard:1', 'rt-old'))
  const sameWorld = derivePlan(snap('cluster:OLD/shard:1', 'rt-old'), first)
  assert.equal(sameWorld.changed, false, '同一个世界、同一个运行实例 → 计划保持稳定')
  assert.equal(sameWorld.since, first.since, 'since 不能变')

  const otherWorld = derivePlan(snap('cluster:NEW/shard:1', 'rt-new'), first)
  assert.notEqual(otherWorld.world, first.world, '世界变了 → plan.world 必须变')
  assert.equal(otherWorld.changed, true, '世界变了 → 计划必须重推（不复用旧世界的目标）')
})

// ─────────────────────────── observe.lua（INTEGRATION）───────────────────────────

test('WM-8（INTEGRATION）：Lua 观察器真的输出 world_key / world_key_source', async () => {
  const env = await loadTargets({})
  env.buildNearby()
  env.run('do local d = Whale.observe.BuildData(Whale.actor.get_actor(), { seq = 1, now = NOW }) '
    + 'OUT = tostring(d.identity.world_key) .. "|" .. tostring(d.identity.world_key_source) end')
  const out = env.get('OUT')
  const [key, source] = out.split('|')
  // 假环境里 TheNet:GetClusterID() 返回 cluster-A → 应该按 cluster 走，而不是退回 session
  assert.equal(key, 'cluster:cluster-A/shard:1')
  assert.equal(source, 'cluster_id')
})

test('WM-9（INTEGRATION）：cluster_id 读不到时退回 session_id，并**如实标注**来源', () => {
  const observe = readFileSync(join(MOD, 'scripts', 'whale', 'observe.lua'), 'utf8')
  assert.match(observe, /world_key_of/, 'observe.lua 要有 world_key 的唯一来源函数')
  assert.match(observe, /cluster:/, '优先用 cluster_id')
  assert.match(observe, /session:/, '读不到才退回 session_id')
  assert.match(observe, /"none"/, '都读不到要如实标 none，不能编造')
  // world_key 必须进 data.identity（Node 侧从那里取）
  assert.match(observe, /world_key = wk/)
  assert.match(observe, /world_key_source = wk_source/)
})

test('WM-10：世界记忆 schema 完整性与 skill_instances / explored_regions / known_resources 持久化', () => {
  const dir = tempDir()
  try {
    const store = createWorldMemoryStore({ dir })
    const empty = emptyMemory('cluster:test/shard:1')
    assert.deepEqual(empty.skill_instances, {})
    assert.deepEqual(empty.explored_regions, [])
    assert.deepEqual(empty.known_resources, [])

    // 容错与自愈：脏输入时补齐默认结构
    const corrupted = {
      worldKey: 'cluster:test/shard:1',
      skill_instances: null,
      explored_regions: 'bad_array',
      known_resources: null,
    }
    const normalized = normalizeMemory(corrupted, 'cluster:test/shard:1')
    assert.deepEqual(normalized.skill_instances, {})
    assert.deepEqual(normalized.explored_regions, [])
    assert.deepEqual(normalized.known_resources, [])

    // 正常持久化与读取
    store.save({
      worldKey: 'cluster:test/shard:1',
      skill_instances: { gather_resources: { step: 'chop', data: { log: 4 } } },
      explored_regions: ['spawn_meadow', 'forest_edge'],
      known_resources: [{ prefab: 'goldnugget', x: 12, z: -34 }],
    })
    const loaded = store.load('cluster:test/shard:1')
    assert.deepEqual(loaded.skill_instances, { gather_resources: { step: 'chop', data: { log: 4 } } })
    assert.deepEqual(loaded.explored_regions, ['spawn_meadow', 'forest_edge'])
    assert.deepEqual(loaded.known_resources, [{ prefab: 'goldnugget', x: 12, z: -34 }])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
