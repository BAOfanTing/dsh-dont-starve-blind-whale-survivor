// 层级规划 / 任务看板 / 家园系统（Phase B/C）测试。
//
// 证据类型：UNIT（真实现 + 临时目录记忆库 + 合成快照）。
// 真机验收（Phase F）不在自动化里做 —— 不能用模拟冒充真实游戏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeState } from '../../lib/state/snapshot.js'
import { executeTool } from '../../lib/tools.js'
import { createWorldMemoryStore } from '../../lib/planner/world-memory.js'
import { createPlanner } from '../../lib/planner/planner-core.js'
import { planBaseSite } from '../../lib/planner/base-site-planner.js'
import { survivalLevel } from '../../lib/planner/survival-priority.js'
import {
  evaluateBoard, mergeBoard, registerFailure, markDone, validateBoard, pickNextTask, MAX_ATTEMPTS,
} from '../../lib/planner/task-board.js'

const temp = () => mkdtempSync(join(tmpdir(), 'bws-plan-'))
const ITEMS = (...entries) => Object.fromEntries(entries.map(([prefab, count, extra], i) => [String(i), { prefab, count, ...(extra ?? {}) }]))

/** 造一份归一化快照；worldKey 决定世界隔离。 */
function makeSnap({
  worldKey = 'cluster:A/shard:1',
  tileX = 0, tileZ = 0,
  health = 100, hunger = 90, sanity = 90,
  phase = 'day', day = 2,
  items = {},
  resources = [], food = [], harvestables = [], structures = [], threats = [],
  dangerZones = [],
} = {}) {
  const raw = {
    data: {
      schema: 'bws.state/1',
      observer: { snapshot_id: 's1', sequence: 1, status: 'ok', timestamp: 1, sampled_at: 1, sample_age_ms: 0 },
      identity: { session_id: 'sess', cluster_id: 'A', shard_id: '1', world_key: worldKey, world_key_source: 'cluster_id' },
      actor: { valid: true, alive: true, is_ghost: false, actor_type: 'player', prefab: 'wilson', name: '威尔逊', tile_x: tileX, tile_z: tileZ, x: tileX * 4, z: tileZ * 4 },
      player: {
        health: { current: health, max: 100, percent: health },
        hunger: { current: hunger, max: 200, percent: hunger },
        sanity: { current: sanity, max: 200, percent: sanity },
        inventory: { items, slots: 15, is_full: false },
        equipment: { slots: {}, worn: [] },
        in_light: phase !== 'night',
      },
      world: { day, phase, phase_name: phase === 'night' ? '夜晚' : '白天', season: 'autumn', season_name: '秋季' },
      nearby: { runtime_id: 'rt1', snapshot_id: 'r1-n2', status: 'ok', radius: 16, buckets: { resources, food, harvestables, structures, threats } },
      danger_zones: dangerZones,
    },
  }
  return normalizeState(raw, { ageMs: 0 })
}

const STABLE_ITEMS = ITEMS(['torch', 1, { percent: 100 }], ['berries', 2], ['axe', 1])
const GOOD_WORLD = {
  resources: [
    { prefab: 'evergreen', work_action: 'CHOP', position: { x: 6, z: 5 }, distance: 5 },
    { prefab: 'rock1', work_action: 'MINE', position: { x: -5, z: 4 }, distance: 6 },
  ],
  harvestables: [{ prefab: 'berrybush', position: { x: 3, z: 2 }, distance: 3, harvest_ready: true }],
}

function withPlanner() {
  const dir = temp()
  const store = createWorldMemoryStore({ dir })
  return { dir, store, planner: createPlanner({ memoryStore: store }) }
}

// ─────────────────────────── 任务规划 ───────────────────────────

test('PLAN-A1：全新世界 → 阶段 0（开局生存）', () => {
  const { dir, planner } = withPlanner()
  try {
    const r = planner.plan(makeSnap({ items: {} }))
    assert.equal(r.stageIndex, 0)
    assert.equal(r.stage.id, 'opening_survival')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PLAN-A2：生存稳定 + 附近资源/食物 → 自动启动选址并落 camp_site', () => {
  const { dir, planner } = withPlanner()
  try {
    const r = planner.plan(makeSnap({ items: STABLE_ITEMS, ...GOOD_WORLD }))
    assert.ok(r.stageIndex >= 1, '生存稳定后应进入建立家园阶段')
    assert.ok(r.memory.camp_site, '信息足够时应选定营地')
    const ids = (r.board.tasks ?? []).map((t) => t.id)
    assert.ok(ids.includes('choose_camp_site'))
    assert.ok(ids.includes('travel_to_camp'), '选定营地后应自动生成前往任务')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PLAN-A3：信息不足 → 不选营地，要求先探索', () => {
  const { dir, planner } = withPlanner()
  try {
    const r = planner.plan(makeSnap({ items: STABLE_ITEMS }))
    assert.equal(r.memory.camp_site, null)
    assert.equal(r.sitePlan.sufficient_info, false)
    assert.equal(r.sitePlan.need_explore, true)
    assert.match(r.next, /探索|seek/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PLAN-A4：不允许绕过选址直接建造科技建筑', () => {
  const { dir, store, planner } = withPlanner()
  try {
    // 已进入建立家园阶段、但还没选营地
    store.save({ worldKey: 'cluster:A/shard:1', current_stage: 1, camp_site: null, completed_milestones: [] })
    const snap = makeSnap({ items: STABLE_ITEMS, ...GOOD_WORLD })
    const gate = planner.guardBuild('sciencemachine', snap)
    assert.ok(gate, '还没选营地时必须拒绝建科学机器')
    assert.equal(gate.reason, 'no_camp_site')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PLAN-A5：选了营地但没到场 → 拒绝建第一个科学机器', () => {
  const { dir, planner } = withPlanner()
  try {
    // 先在同一世界选定营地（角色在 0,0）
    planner.plan(makeSnap({ items: STABLE_ITEMS, ...GOOD_WORLD }))
    // 角色跑到 40,40（远超营地半径）
    const far = makeSnap({ tileX: 40, tileZ: 40, items: STABLE_ITEMS, ...GOOD_WORLD })
    const gate = planner.guardBuild('sciencemachine', far)
    assert.ok(gate)
    assert.equal(gate.reason, 'not_at_camp')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PLAN-A6：营地附近建好科学机器 → 自动记录 home（camp_site ≠ home）', () => {
  const { dir, store, planner } = withPlanner()
  try {
    // 第一次：选定营地
    planner.plan(makeSnap({ items: STABLE_ITEMS, ...GOOD_WORLD }))
    const camp = store.load('cluster:A/shard:1').camp_site
    assert.ok(camp && !store.load('cluster:A/shard:1').home_building_id)

    // 第二次：营地位置真的出现科学机器
    const built = makeSnap({
      items: STABLE_ITEMS, ...GOOD_WORLD,
      structures: [{ prefab: 'researchlab', position: { x: camp.x, z: camp.z }, distance: 1 }],
    })
    const r = planner.plan(built)
    assert.ok(r.memory.home_building_id, '科学机器真实出现后应记录 home')
    assert.match(r.memory.home_building_id, /building:researchlab@/)
    assert.ok(r.memory.home_anchor && typeof r.memory.home_anchor.x === 'number')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PLAN-A7：home 落盘 —— 重开 planner 仍读得到', () => {
  const dir = temp()
  try {
    const store1 = createWorldMemoryStore({ dir })
    const p1 = createPlanner({ memoryStore: store1 })
    p1.plan(makeSnap({ items: STABLE_ITEMS, ...GOOD_WORLD }))
    const camp = store1.load('cluster:A/shard:1').camp_site
    p1.plan(makeSnap({ items: STABLE_ITEMS, ...GOOD_WORLD, structures: [{ prefab: 'researchlab', position: { x: camp.x, z: camp.z }, distance: 1 }] }))
    const homeId = store1.load('cluster:A/shard:1').home_building_id
    assert.ok(homeId)

    // 换一个 planner 实例（模拟重启）读同一个世界
    const store2 = createWorldMemoryStore({ dir })
    const p2 = createPlanner({ memoryStore: store2 })
    const r = p2.plan(makeSnap({ items: STABLE_ITEMS, ...GOOD_WORLD }))
    assert.equal(r.memory.home_building_id, homeId, '重启后家的记忆必须还在')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PLAN-A8：换世界不继承旧 home（按 world_key 隔离）', () => {
  const dir = temp()
  try {
    const store = createWorldMemoryStore({ dir })
    const planner = createPlanner({ memoryStore: store })
    planner.plan(makeSnap({ worldKey: 'cluster:A/shard:1', items: STABLE_ITEMS, ...GOOD_WORLD }))
    const camp = store.load('cluster:A/shard:1').camp_site
    planner.plan(makeSnap({ worldKey: 'cluster:A/shard:1', items: STABLE_ITEMS, ...GOOD_WORLD, structures: [{ prefab: 'researchlab', position: { x: camp.x, z: camp.z }, distance: 1 }] }))
    assert.ok(store.load('cluster:A/shard:1').home_building_id)

    // 另一个世界：全新，不能有 A 世界的家
    const rB = planner.plan(makeSnap({ worldKey: 'cluster:B/shard:1', items: {} }))
    assert.equal(rB.memory.home_building_id, null)
    assert.equal(rB.memory.camp_site, null)
    assert.equal(rB.stageIndex, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PLAN-A9：已有家 → 基地建筑不在锚点范围内被拒，范围内放行', () => {
  const dir = temp()
  try {
    const store = createWorldMemoryStore({ dir })
    const planner = createPlanner({ memoryStore: store })
    // 直接构造一份带家的记忆（跳过繁琐流程）
    const home = { id: 'building:researchlab@0,0', prefab: 'researchlab', x: 0, z: 0 }
    store.save({
      worldKey: 'cluster:A/shard:1', current_stage: 2, home_building_id: home.id,
      home_anchor: { prefab: 'researchlab', x: 0, z: 0, radius: 10 }, known_buildings: [home],
      completed_milestones: [], camp_site: { x: 0, z: 0 },
    })
    const farChest = planner.guardBuild('chest', makeSnap({ tileX: 30, tileZ: 30 }))
    assert.ok(farChest)
    assert.equal(farChest.reason, 'out_of_home_range')
    const nearChest = planner.guardBuild('chest', makeSnap({ tileX: 3, tileZ: 2 }))
    assert.equal(nearChest, null, '在家的半径内应允许建造')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ─────────────────────────── 家园选址 ───────────────────────────

test('HOME-1：落在危险区内的候选一律否决 → 不选主选，要求换方向探索', () => {
  const snap = makeSnap({
    tileX: 0, tileZ: 0,
    ...GOOD_WORLD,
    // 一大片危险区盖住所有候选点：任何"在危险区里"的点都不能当营地
    dangerZones: [{ x: 0, z: 0, radius: 40, source: 'spiderden' }],
  })
  const site = planBaseSite(snap, {})
  assert.equal(site.primary, null, '危险区里不能选出营地')
  assert.equal(site.need_explore, true)
})

test('HOME-2：空世界（无观察）→ 信息不足，要求探索', () => {
  const site = planBaseSite(makeSnap({ items: STABLE_ITEMS }), {})
  assert.equal(site.sufficient_info, false)
  assert.equal(site.need_explore, true)
})

test('HOME-3：资源+食物充足的安静空地 → 选出主选与备选', () => {
  const site = planBaseSite(makeSnap({ ...GOOD_WORLD }), {})
  assert.equal(site.sufficient_info, true)
  assert.ok(site.primary && typeof site.primary.x === 'number')
  assert.ok(site.connectivity_mode === 'observed_nearby_only')
})

// ─────────────────────────── 任务看板状态机 ───────────────────────────

test('BOARD-1：依赖未满足 → 任务 blocked（优先级不能绕过依赖）', () => {
  const board = validateBoard({
    goal: 'g',
    tasks: [
      { id: 'a', title: 'A', priority: 1, target: { type: 'camp_site' } },
      { id: 'b', title: 'B', priority: 1, depends_on: ['a'], target: { type: 'home' } },
    ],
  })
  const snap = makeSnap({})
  let view = evaluateBoard(board, { snapshot: snap, memory: {} })
  const b = view.tasks.find((t) => t.id === 'b')
  assert.equal(b.status, 'blocked')
  assert.match(b.blocked_reason, /dependencies:a/)

  // a 完成后 b 的依赖满足；b 的目标(home)还没达成 → 应为 ready（可执行），不再被依赖 blocked
  view = markDone(view, 'a')
  view = evaluateBoard(view, { snapshot: snap, memory: { camp_site: { x: 1, z: 1 } } })
  assert.equal(view.tasks.find((t) => t.id === 'a').status, 'done')
  assert.equal(view.tasks.find((t) => t.id === 'b').status, 'ready')
})

test('BOARD-2：失败有上限 + 冷却（不无限重试）', () => {
  let board = validateBoard({ goal: 'g', tasks: [{ id: 'a', title: 'A', priority: 1, target: { type: 'camp_site' } }] })
  const now = 1_000_000
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    board = registerFailure(board, 'a', 'target_gone', { now })
  }
  assert.equal(board.tasks[0].status, 'failed')
  assert.equal(board.tasks[0].attempts, MAX_ATTEMPTS)
})

test('BOARD-3：合并保活 —— 未完成任务的 attempts/进度不因刷新丢失', () => {
  let board = validateBoard({ goal: 'g', tasks: [{ id: 'a', title: 'A', priority: 1, target: { type: 'inventory', prefab: 'log', count: 4 } }] })
  board = registerFailure(board, 'a', 'x', { now: 1000 })
  assert.equal(board.tasks[0].attempts, 1)
  // 下一次规划又给了同名任务（新默认 attempts=0）——合并后必须保留 attempts=1
  const merged = mergeBoard(board, [{ id: 'a', title: 'A2', priority: 1, target: { type: 'inventory', prefab: 'log', count: 4 } }])
  assert.equal(merged.tasks[0].attempts, 1)
  assert.equal(merged.tasks[0].title, 'A2', '规划字段允许更新')
})

test('BOARD-4：pickNextTask 选最高优先级 ready', () => {
  const board = validateBoard({
    goal: 'g',
    tasks: [
      { id: 'low', title: 'L', priority: 3, target: { type: 'camp_site' } },
      { id: 'high', title: 'H', priority: 1, target: { type: 'camp_site' } },
    ],
  })
  const view = evaluateBoard(board, { snapshot: makeSnap({}), memory: {} })
  assert.equal(pickNextTask(view).id, 'high')
})

// ─────────────────────────── 生存优先级 ───────────────────────────

test('SURV-1：天黑没光 → P0 blocking，普通任务让位', () => {
  const snap = makeSnap({ phase: 'night', items: {} })
  snap.player.in_light = false
  const lv = survivalLevel(snap)
  assert.equal(lv.level, 0)
  assert.equal(lv.blocking, true)
  const { dir, planner } = withPlanner()
  try {
    const r = planner.plan(snap)
    assert.match(r.next, /生存/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('SURV-2：状态稳定 → 允许推进发展任务', () => {
  const lv = survivalLevel(makeSnap({ items: STABLE_ITEMS }))
  assert.equal(lv.blocking, false)
})

// ─────────────────────────── 技能：缺料触发收集 ───────────────────────────

test('SKILL-1：核心材料不足（缺金块）→ 看板出现 gather_goldnugget 任务', () => {
  const { dir, planner } = withPlanner()
  try {
    // 有工具/食物/光，但背包没有 goldnugget；附近有树/石/食物 → 会选营地
    const items = ITEMS(['torch', 1, { percent: 100 }], ['berries', 2], ['axe', 1], ['log', 4], ['rocks', 4])
    planner.plan(makeSnap({ items, ...GOOD_WORLD })) // 第一次：选定营地
    const r = planner.plan(makeSnap({ items, ...GOOD_WORLD })) // 第二次：生成完整建家链
    const ids = (r.board.tasks ?? []).map((t) => t.id)
    assert.ok(ids.includes('gather_goldnugget'), `应生成缺金块的收集任务，实际：${ids.join(',')}`)
    assert.ok(ids.includes('build_first_structure'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ─────────────────────────── 与工具层集成（get_state / build gate） ───────────────────────────

test('INT-1：get_state 文本带「发展阶段 / 任务看板」段（装配 planner 时）', async () => {
  const dir = temp()
  try {
    const store = createWorldMemoryStore({ dir })
    const planner = createPlanner({ memoryStore: store })
    // 用与 makeSnap 相同的原始 data 形状（executeTool 内部会重新 normalize）
    const raw = {
      data: {
        schema: 'bws.state/1',
        observer: { snapshot_id: 's1', sequence: 1, status: 'ok', timestamp: 1, sampled_at: 1, sample_age_ms: 0 },
        identity: { session_id: 'sess', cluster_id: 'A', shard_id: '1', world_key: 'cluster:A/shard:1', world_key_source: 'cluster_id' },
        actor: { valid: true, alive: true, is_ghost: false, actor_type: 'player', prefab: 'wilson', name: '威尔逊', tile_x: 0, tile_z: 0, x: 0, z: 0 },
        player: {
          health: { current: 100, max: 100, percent: 100 }, hunger: { current: 180, max: 200, percent: 90 },
          sanity: { current: 180, max: 200, percent: 90 },
          inventory: { items: { 0: { prefab: 'torch', count: 1, percent: 100 }, 1: { prefab: 'berries', count: 2 }, 2: { prefab: 'axe', count: 1 } }, slots: 15, is_full: false },
          equipment: { slots: {}, worn: [] }, in_light: true,
        },
        world: { day: 2, phase: 'day', phase_name: '白天', season: 'autumn', season_name: '秋季' },
        nearby: { runtime_id: 'rt1', snapshot_id: 'r1-n2', status: 'ok', radius: 16, buckets: {
          resources: [{ prefab: 'evergreen', work_action: 'CHOP', position: { x: 6, z: 5 }, distance: 5 }],
          harvestables: [{ prefab: 'berrybush', position: { x: 3, z: 2 }, distance: 3, harvest_ready: true }],
        } },
        danger_zones: [],
      },
    }
    const bridge = { readState: () => ({ json: raw, ageMs: 0, path: 'fake.json' }), leaseDirs: () => [], readLeaseAck: () => null }
    const ctx = { bridge, planner, notes: { read: () => '', write: () => {} }, guides: {}, extraInstructions: '' }
    const text = await executeTool('get_state', {}, ctx)
    assert.match(text, /发展阶段/)
    assert.match(text, /任务看板|下一步/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('INT-2：executeTool(build) 在有 planner 时被家园门槛拦下（未选址）', async () => {
  const dir = temp()
  try {
    const store = createWorldMemoryStore({ dir })
    const planner = createPlanner({ memoryStore: store })
    const raw = {
      data: {
        schema: 'bws.state/1',
        observer: { snapshot_id: 's1', sequence: 1, status: 'ok', timestamp: 1, sampled_at: 1, sample_age_ms: 0 },
        identity: { session_id: 'sess', cluster_id: 'A', shard_id: '1', world_key: 'cluster:A/shard:1', world_key_source: 'cluster_id' },
        actor: { valid: true, alive: true, is_ghost: false, actor_type: 'player', prefab: 'wilson', name: '威尔逊', tile_x: 0, tile_z: 0, x: 0, z: 0 },
        player: {
          health: { current: 100, max: 100, percent: 100 }, hunger: { current: 180, max: 200, percent: 90 }, sanity: { current: 180, max: 200, percent: 90 },
          inventory: { items: { 0: { prefab: 'goldnugget', count: 1 }, 1: { prefab: 'log', count: 4 }, 2: { prefab: 'rocks', count: 4 } }, slots: 15, is_full: false },
          equipment: { slots: {}, worn: [] }, in_light: true,
        },
        world: { day: 2, phase: 'day', phase_name: '白天', season: 'autumn', season_name: '秋季' },
        nearby: { runtime_id: 'rt1', snapshot_id: 'r1-n2', status: 'ok', radius: 16, buckets: { resources: [], food: [], harvestables: [], structures: [], threats: [] } },
        danger_zones: [],
      },
    }
    const bridge = { readState: () => ({ json: raw, ageMs: 0, path: 'fake.json' }), leaseDirs: () => [], readLeaseAck: () => null }
    const ctx = { bridge, planner, notes: { read: () => '', write: () => {} }, guides: {}, extraInstructions: '', executionMode: 'assisted' }
    // 材料齐（1金4木4石），但还没活稳（阶段0）/没选营地 → 必须被拒，绝不就地建
    const text = await executeTool('build', { recipe: 'sciencemachine' }, ctx)
    assert.match(text, /失败/)
    assert.match(text, /not_ready_stage|no_camp_site|营地/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PLAN-A10：开局阶段（还没活稳）即使材料齐全也不许建科学机器（不进阶段1就不许建家）', () => {
  const { dir, planner } = withPlanner()
  try {
    // 有资源但 Stage0 未完成（没有工具/食物/光源）→ camp_site 不落定
    const r = planner.plan(makeSnap({ items: {}, ...GOOD_WORLD }))
    assert.equal(r.stageIndex, 0)
    assert.equal(r.memory.camp_site, null, 'Stage0 不许抢先在出生点定营地')
    const gate = planner.guardBuild('sciencemachine', makeSnap({ items: {}, ...GOOD_WORLD }))
    assert.ok(gate)
    assert.equal(gate.reason, 'not_ready_stage')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PLAN-A11：选址不偏爱"脚下那一格"（营地是专门过去建的地方）', () => {
  const site = planBaseSite(makeSnap({ ...GOOD_WORLD }), {})
  assert.equal(site.sufficient_info, true)
  // 主选不应恰好等于角色所在的 (0,0)
  assert.ok(!(site.primary.x === 0 && site.primary.z === 0), `主选不该是脚下限，实际 ${JSON.stringify(site.primary)}`)
})
