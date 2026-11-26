// tests/task-instance-lifecycle.test.mjs
// Phase R.6: Task Identity & Skill Instance Lifecycle
//
// 验证内容：
// 1. 同一技能类型的两个不同任务拥有不同实例。
// 2. gather_log 完成后，gather_rocks 必须真实执行。
// 3. gather_rocks 不得继承 gather_log 的 skill_args。
// 4. 同一任务暂停后恢复原实例。
// 5. 同一任务重复启动不创建重复实例。
// 6. 任务第一次失败，冷却后创建新实例。
// 7. 新实例真正下发动作，而不是直接返回 failed。
// 8. 达到最大重试次数后任务进入 failed。
// 9. 手动 run_skill 不得覆盖自动任务实例。
// 10. 自动任务不得覆盖手动执行实例。
// 11. Reflex 抢占后恢复正确 task_id 和 instance_id。
// 12. 世界切换后实例隔离。
// 13. 两个不同技能实例不能同时控制角色。
// 14. get_state 不得触发任何动作。
// 15. 任务完成必须有对应目标的真实证据。
// 16. 旧版本 world memory 必须兼容迁移。
// 17. 完整集成场景：log×4, rocks×4, goldnugget×1 依次生成三个资源任务并真实达成。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeState } from '../../lib/state/snapshot.js'
import { TaskSkillOrchestrator } from '../../lib/planner/task-skill-orchestrator.js'
import { createWorldMemoryStore, emptyMemory, normalizeMemory } from '../../lib/planner/world-memory.js'
import { executeTool } from '../../lib/tools.js'
import { createPlanner } from '../../lib/planner/planner-core.js'
import { ensureSkillsRegistered } from '../../lib/skills/index.js'
import { SkillExecutor } from '../../lib/skills/skill-executor.js'
import { evaluateBoard, MAX_ATTEMPTS } from '../../lib/planner/task-board.js'

ensureSkillsRegistered()

function makeWorld(over = {}) {
  return {
    worldKey: 'cluster:R6/shard:1',
    x: 0,
    z: 0,
    prefab: 'wilson',
    health: 100,
    hunger: 90,
    sanity: 90,
    phase: 'day',
    inLight: true,
    items: {},
    resources: [
      { prefab: 'evergreen', work_action: 'CHOP', position: { x: 5, z: 5 } },
      { prefab: 'rock1', work_action: 'MINE', position: { x: -5, z: 5 } },
    ],
    harvestables: [
      { prefab: 'sapling', position: { x: 2, z: 2 }, harvest_ready: true },
      { prefab: 'grass', position: { x: 1, z: 1 }, harvest_ready: true },
    ],
    pickupables: [{ prefab: 'flint', position: { x: 3, z: 3 } }],
    food: [],
    structures: [],
    threats: [],
    dangerZones: [],
    ...over,
  }
}

let itemSeq = 0
function addItem(world, prefab, n = 1) {
  for (const it of Object.values(world.items)) {
    if (it.prefab === prefab) {
      it.count += n
      return
    }
  }
  world.items[String(itemSeq++)] = { prefab, count: n }
}

function rawOf(world) {
  const withDist = (items) => (items ?? []).map((it) => {
    const p = it?.position
    if (p && typeof p.x === 'number' && typeof p.z === 'number') {
      const d = Math.hypot(p.x - world.x, p.z - world.z)
      return { ...it, distance: Math.round(d * 10) / 10 }
    }
    return it
  })
  return {
    data: {
      schema: 'bws.state/1',
      observer: { snapshot_id: 's', sequence: 1, status: 'ok', timestamp: 1, sampled_at: 1, sample_age_ms: 0 },
      identity: { session_id: 'sess', cluster_id: 'R6', shard_id: '1', world_key: world.worldKey, world_key_source: 'cluster_id' },
      actor: { valid: true, alive: true, is_ghost: false, actor_type: 'player', prefab: world.prefab, name: 'W', tile_x: world.x, tile_z: world.z, x: world.x * 4, z: world.z * 4 },
      player: {
        health: { current: world.health, max: 100, percent: world.health },
        hunger: { current: world.hunger * 2, max: 200, percent: world.hunger },
        sanity: { current: world.sanity * 2, max: 200, percent: world.sanity },
        inventory: { items: world.items, slots: 15, is_full: false },
        equipment: { slots: {}, worn: [] },
        in_light: world.phase !== 'night' || world.inLight === true,
      },
      world: { day: 2, phase: world.phase, season: 'autumn' },
      nearby: {
        runtime_id: 'rt1',
        snapshot_id: 'r1-n2',
        status: 'ok',
        radius: 16,
        buckets: {
          resources: withDist(world.resources),
          food: withDist(world.food),
          harvestables: withDist(world.harvestables),
          pickupables: withDist(world.pickupables),
          structures: withDist(world.structures),
          threats: withDist(world.threats),
        },
      },
      danger_zones: world.dangerZones,
    },
  }
}

function snapOf(world) {
  return normalizeState(rawOf(world), { ageMs: 0 })
}

function makeDispatch(world, { rejectOn = () => null, calls = [] } = {}) {
  return async (tool, args) => {
    calls.push({ tool, args })
    const rej = rejectOn(tool, args)
    if (rej) return { status: 'rejected', reason: rej }
    switch (tool) {
      case 'move_to':
        world.x = args.x
        world.z = args.z
        return { status: 'succeeded' }
      case 'chop_nearest':
        addItem(world, 'log', 2)
        return { status: 'succeeded' }
      case 'mine_nearest':
        if (String(args.target_kind).includes('gold')) addItem(world, 'goldnugget', 1)
        else addItem(world, 'rocks', 2)
        return { status: 'succeeded' }
      case 'pickup_nearest':
        addItem(world, args.target_kind === 'goldnugget' ? 'goldnugget' : (args.target_kind ?? 'flint'), 1)
        return { status: 'succeeded' }
      case 'gather_area':
        if (args.prefab === 'grass') addItem(world, 'cutgrass', 2)
        else if (args.prefab === 'sapling') addItem(world, 'twigs', 2)
        return { status: 'succeeded' }
      case 'craft':
        if (args.recipe === 'torch') addItem(world, 'torch', 1)
        return { status: 'succeeded' }
      case 'build':
        world.structures.push({ prefab: args.recipe, position: { x: world.x, z: world.z }, distance: 1 })
        return { status: 'succeeded' }
      default:
        return { status: 'succeeded' }
    }
  }
}

// ─────────────────────────── 测试用例 ───────────────────────────

test('LIFECYCLE-01: 同一技能类型的两个不同任务拥有不同实例', async () => {
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'gather_log', title: '收集木头', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { log: 4 } } },
      { id: 'gather_rocks', title: '收集石头', status: 'pending', priority: 2, skill_id: 'gather_resources', skill_args: { target_items: { rocks: 4 } } },
    ],
  }
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world),
  })

  // 执行第一个任务
  await orch.tickOnce()
  const instLog = orch.executor.activeInstanceForTask('gather_log')
  assert.ok(instLog, 'gather_log 必须创建活动实例')
  assert.equal(instLog.task_id, 'gather_log')
  assert.equal(instLog.skill_id, 'gather_resources')

  // 模拟推进第二个任务
  await orch.executor.run('gather_resources', 'gather_rocks', { target_items: { rocks: 4 } })
  const instRocks = orch.executor.activeInstanceForTask('gather_rocks')
  assert.ok(instRocks, 'gather_rocks 必须创建活动实例')
  assert.equal(instRocks.task_id, 'gather_rocks')
  assert.equal(instRocks.skill_id, 'gather_resources')

  // 两者 instance_id 必须独立
  assert.notEqual(instLog.instance_id, instRocks.instance_id, '不同 task_id 必须拥有不同 instance_id')
})

test('LIFECYCLE-02: gather_log 完成后，gather_rocks 必须真实执行', async () => {
  const world = makeWorld()
  addItem(world, 'log', 4) // 预先满足木头需求
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'gather_log', title: '收集木头', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { log: 4 } } },
      { id: 'gather_rocks', title: '收集石头', status: 'pending', priority: 2, skill_id: 'gather_resources', skill_args: { target_items: { rocks: 4 } } },
    ],
  }
  const calls = []
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world, { calls }),
  })

  // 第 1 次 tick：gather_log 发现材料已满足，直接完成
  const res1 = await orch.tickOnce()
  assert.equal(res1.status, 'completed')
  assert.equal(res1.task_id, 'gather_log')
  assert.equal(calls.length, 0, '材料已齐全时不应下发动作')

  // 第 2 次 tick：应选中 gather_rocks 并真正执行动作
  const res2 = await orch.tickOnce()
  assert.equal(res2.task_id, 'gather_rocks')
  assert.notEqual(res2.status, 'completed', 'gather_rocks 未完成时不应借用前一任务判完成')
  assert.ok(calls.length > 0, 'gather_rocks 必须真正下发采集动作')
})

test('LIFECYCLE-03: gather_rocks 不得继承 gather_log 的 skill_args', async () => {
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'gather_log', title: '收集木头', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { log: 4 } } },
      { id: 'gather_rocks', title: '收集石头', status: 'pending', priority: 2, skill_id: 'gather_resources', skill_args: { target_items: { rocks: 4 } } },
    ],
  }
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world),
  })

  await orch.tickOnce()
  const instLog = orch.executor.activeInstanceForTask('gather_log')
  assert.deepEqual(instLog.skill_args, { target_items: { log: 4 } })

  await orch.executor.run('gather_resources', 'gather_rocks', { target_items: { rocks: 4 } })
  const instRocks = orch.executor.activeInstanceForTask('gather_rocks')
  assert.deepEqual(instRocks.skill_args, { target_items: { rocks: 4 } })
  assert.equal(instRocks.skill_args.target_items.log, undefined, 'gather_rocks 绝不得继承 gather_log 参数')
})

test('LIFECYCLE-04: 同一任务暂停后恢复原实例', async () => {
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'task_home', title: '建立家园', status: 'pending', priority: 1, skill_id: 'establish_home' },
    ],
  }
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world),
  })

  // 推进一步
  await orch.tickOnce()
  const inst1 = orch.executor.activeInstanceForTask('task_home')
  assert.ok(inst1)
  const initialId = inst1.instance_id

  // 暂停
  orch.executor.pause(inst1.instance_id, 'manual_pause')
  assert.equal(inst1.status, 'paused')

  // 恢复
  await orch.tickOnce()
  const inst2 = orch.executor.activeInstanceForTask('task_home')
  assert.equal(inst2.instance_id, initialId, '恢复执行必须复用同一个 instance_id')
  assert.equal(inst2.status, 'in_progress')
})

test('LIFECYCLE-05: 同一任务重复启动不创建重复实例', async () => {
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'task_g', title: '采集', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { log: 10 } } },
    ],
  }
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world),
  })

  await orch.tickOnce()
  const inst1 = orch.executor.activeInstanceForTask('task_g')
  await orch.tickOnce()
  const inst2 = orch.executor.activeInstanceForTask('task_g')

  assert.equal(inst1.instance_id, inst2.instance_id, '多次连续调度同一任务不创建新实例')
})

test('LIFECYCLE-06: 任务第一次失败，冷却后创建新实例', async () => {
  let now = 1000
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'task_fail', title: '易失败任务', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { log: 2 } } },
    ],
  }
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world, { rejectOn: () => 'tool_broken' }),
    now: () => now,
  })

  // 连续执行耗尽重试次数导致失败
  for (let i = 0; i < 4; i++) {
    await orch.tickOnce()
  }
  const oldInst = orch.executor.latestInstanceForTask('task_fail')
  assert.equal(oldInst.status, 'failed', '实例必须记录 failed')
  const task = mem.task_board.tasks.find((t) => t.id === 'task_fail')
  assert.ok(task.cooldown_until > now, '任务应进入冷却')

  // 跨过冷却时间
  now = task.cooldown_until + 1000

  // 修复执行环境并再次调度
  orch.dispatch = makeDispatch(world)
  orch.executor.dispatch = orch.dispatch
  await orch.tickOnce()

  const newInst = orch.executor.activeInstanceForTask('task_fail')
  assert.ok(newInst, '冷却结束后必须创建新实例')
  assert.notEqual(newInst.instance_id, oldInst.instance_id, '新实例必须拥有独立 instance_id')
  assert.equal(newInst.task_id, 'task_fail')
  assert.equal(oldInst.status, 'failed', '旧实例在历史中保持 failed 不被擦除')
})

test('LIFECYCLE-07: 新实例真正下发动作，而不是直接返回 failed', async () => {
  let now = 1000
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'task_retry', title: '重试任务', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { log: 2 } } },
    ],
  }
  const calls = []
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world, { rejectOn: () => 'temp_fail', calls }),
    now: () => now,
  })

  // 触发失败
  for (let i = 0; i < 4; i++) await orch.tickOnce()
  const task = mem.task_board.tasks.find((t) => t.id === 'task_retry')

  // 结束冷却
  now = task.cooldown_until + 1000
  calls.length = 0

  // 恢复环境并调度
  orch.dispatch = makeDispatch(world, { calls })
  orch.executor.dispatch = orch.dispatch
  const res = await orch.tickOnce()

  assert.notEqual(res.status, 'failed', '重试实例不能直接返回 failed')
  assert.ok(calls.length > 0, '重试实例必须真正发起动作调用')
})

test('LIFECYCLE-08: 达到最大重试次数后任务进入永久 failed', async () => {
  let now = 1000
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'task_perm_fail', title: '永久失败任务', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { log: 2 } } },
    ],
  }
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world, { rejectOn: () => 'fatal_rejection' }),
    now: () => now,
  })

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    for (let i = 0; i < 4; i++) await orch.tickOnce()
    const task = mem.task_board.tasks.find((t) => t.id === 'task_perm_fail')
    if (attempt < MAX_ATTEMPTS) {
      assert.equal(task.status, 'blocked')
      now = task.cooldown_until + 1000
    } else {
      assert.equal(task.status, 'failed', `达到最大尝试 ${MAX_ATTEMPTS} 次后任务必须永久 failed`)
    }
  }
})

test('LIFECYCLE-09 & 10: 手动 run_skill 与自动调度任务互不覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-iso-test-'))
  try {
    const store = createWorldMemoryStore({ dir })
    const planner = createPlanner({ memoryStore: store })
    const world = makeWorld()
    const bridge = {
      readState: () => ({ json: rawOf(world), ageMs: 0, path: 'fake.json' }),
      leaseDirs: () => [],
      readLeaseAck: () => null,
    }
    const ctx = {
      bridge,
      planner,
      notes: { read: () => '', write: () => {} },
      guides: {},
      extraInstructions: '',
      control: { activeLease: () => ({ valid: true, authorized_actions: ['all'] }), guard: () => null },
      dispatcher: { dispatch: async () => ({ status: 'succeeded' }), describe: () => 'ok' },
      executionMode: 'assisted',
    }

    // 1. 自动看板任务启动
    const mem = planner.memoryFor(snapOf(world))
    mem.task_board = {
      schema: 'bws.task-board/1',
      tasks: [{ id: 'auto_gather', title: '自动收集', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { log: 8 } } }],
    }
    // 先通过 run_skill 明确指定 task_id: 'auto_gather' 启动
    await executeTool('run_skill', { skill_id: 'gather_resources', task_id: 'auto_gather', skill_args: { target_items: { log: 8 } } }, ctx)
    const autoInst = ctx.orchestrator.executor.activeInstanceForTask('auto_gather')
    assert.ok(autoInst)
    assert.equal(autoInst.task_id, 'auto_gather')

    // 2. 手动 run_skill 启动（不带 task_id）
    await executeTool('run_skill', { skill_id: 'gather_resources', skill_args: { target_items: { rocks: 5 } } }, ctx)
    const manualInst = ctx.orchestrator.executor.activeInstanceForTask('manual:gather_resources')
    assert.ok(manualInst)
    assert.notEqual(manualInst.instance_id, autoInst.instance_id, '手动调用必须获得新实例')
    assert.equal(manualInst.task_id, 'manual:gather_resources')

    // 3. 验证自动任务的实例没有被篡改且已被抢占暂停
    const autoInstPaused = ctx.orchestrator.executor.instancesForTask('auto_gather')[0]
    assert.ok(autoInstPaused)
    assert.equal(autoInstPaused.task_id, 'auto_gather')
    assert.deepEqual(autoInstPaused.skill_args, { target_items: { log: 8 } })
    assert.equal(autoInstPaused.status, 'paused', '被手动技能抢占后自动任务实例应为 paused')
    assert.match(autoInstPaused.paused_reason, /preempted_by:/)

    // 4. 再次推进自动调度：自动任务安全恢复为 in_progress
    ctx.orchestrator.memory.task_board = {
      schema: 'bws.task-board/1',
      tasks: [{ id: 'auto_gather', title: '自动收集', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { log: 8 } } }],
    }
    await ctx.orchestrator.tickOnce()
    const autoInstResumed = ctx.orchestrator.executor.activeInstanceForTask('auto_gather')
    assert.ok(autoInstResumed)
    assert.equal(autoInstResumed.status, 'in_progress')
    const manualInstPaused = ctx.orchestrator.executor.instancesForTask('manual:gather_resources')[0]
    assert.equal(manualInstPaused.status, 'paused', '自动任务接管后手动实例应被暂停')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LIFECYCLE-11: Reflex 抢占后恢复正确 task_id 和 instance_id', async () => {
  const world = makeWorld({ phase: 'day', inLight: true })
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [{ id: 'task_work', title: '正常工作', status: 'pending', priority: 1, skill_id: 'gather_resources' }],
  }
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world),
  })

  // 正常执行
  await orch.tickOnce()
  const inst = orch.executor.activeInstanceForTask('task_work')
  const initialId = inst.instance_id

  // 突发黑夜无光 (P0)
  world.phase = 'night'
  world.inLight = false
  const resPreempt = await orch.tickOnce()
  assert.ok(['survival_preempted', 'survival_in_progress'].includes(resPreempt.status))
  assert.equal(inst.status, 'paused')
  assert.match(inst.paused_reason, /survival_preempt:dark/)

  // 恢复白天 (危机解除)
  world.phase = 'day'
  world.inLight = true
  const resRecover = await orch.tickOnce()
  assert.ok(!['survival_preempted', 'survival_in_progress'].includes(resRecover.status))
  assert.equal(inst.instance_id, initialId, '危机解除后必须恢复原有 instance_id')
  assert.equal(inst.task_id, 'task_work')
})

test('LIFECYCLE-12: 世界切换后实例隔离', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-world-iso-'))
  try {
    const store = createWorldMemoryStore({ dir })

    // 世界 1 运行任务
    const world1 = makeWorld({ worldKey: 'world-1' })
    const mem1 = store.load('world-1')
    mem1.task_board = { schema: 'bws.task-board/1', tasks: [{ id: 'task_w1', status: 'pending', priority: 1, skill_id: 'gather_resources' }] }
    const orch1 = new TaskSkillOrchestrator({
      memory: mem1,
      worldKey: 'world-1',
      readSnapshot: () => snapOf(world1),
      dispatch: async () => ({ status: 'succeeded' }),
      save: () => store.save(mem1),
    })
    await orch1.tickOnce()
    const instW1 = orch1.executor.activeInstanceForTask('task_w1')
    assert.ok(instW1)
    store.save(mem1)

    // 世界 2 加载
    const world2 = makeWorld({ worldKey: 'world-2' })
    const mem2 = store.load('world-2')
    const orch2 = new TaskSkillOrchestrator({
      memory: mem2,
      worldKey: 'world-2',
      readSnapshot: () => snapOf(world2),
      dispatch: async () => ({ status: 'succeeded' }),
      save: () => store.save(mem2),
    })
    const foundInW2 = orch2.executor.activeInstanceForTask('task_w1')
    assert.equal(foundInW2, null, '世界2中绝对不得读到世界1的技能实例')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LIFECYCLE-13: 两个不同技能实例不能同时控制角色', async () => {
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  const exec = new SkillExecutor({
    memory: mem,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world),
  })

  // 启动技能 1
  await exec.run('gather_resources', 'task_1')
  const inst1 = exec.activeInstanceForTask('task_1')
  assert.equal(inst1.status, 'in_progress')
  assert.equal(mem.active_skill_instance_id, inst1.instance_id)

  // 启动技能 2
  await exec.run('establish_home', 'task_2')
  const inst2 = exec.activeInstanceForTask('task_2')
  assert.equal(inst2.status, 'in_progress')
  assert.equal(mem.active_skill_instance_id, inst2.instance_id)

  // 验证技能 1 被暂停
  assert.equal(inst1.status, 'paused', '旧技能实例必须被单角色互斥原则暂停')
  assert.match(inst1.paused_reason, /preempted_by/)
})

test('LIFECYCLE-14: get_state 不得触发任何动作', async () => {
  const world = makeWorld()
  const planner = createPlanner()
  const calls = []
  const bridge = {
    readState: () => ({ json: rawOf(world), ageMs: 0, path: 'fake.json' }),
    leaseDirs: () => [],
    readLeaseAck: () => null,
  }
  const ctx = {
    bridge,
    planner,
    notes: { read: () => '', write: () => {} },
    guides: {},
    extraInstructions: '',
    control: { activeLease: () => ({ valid: true, authorized_actions: ['all'] }), guard: () => null },
    dispatcher: {
      dispatch: async (cmd) => {
        calls.push(cmd)
        return { status: 'succeeded' }
      },
      describe: () => 'ok',
    },
  }

  const out = await executeTool('get_state', {}, ctx)
  assert.ok(typeof out === 'string')
  assert.equal(calls.length, 0, 'get_state 必须纯只读，零 dispatcher 调用')
})

test('LIFECYCLE-15: 任务完成必须有对应目标的真实证据', async () => {
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'gather_log', title: '收集木头', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { log: 4 } }, target: { type: 'inventory', prefab: 'log', count: 4 } },
    ],
  }
  // 模拟假动作成功但背包没有真实增加木头
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: async () => ({ status: 'succeeded' }), // 假成功，不加 log
  })

  const res = await orch.tickOnce()
  assert.notEqual(res.status, 'completed', '背包未达到4个木头证据时，绝不能判完成')
  const task = mem.task_board.tasks.find((t) => t.id === 'gather_log')
  assert.notEqual(task.status, 'completed')
})

test('LIFECYCLE-16: 旧版本 world memory 必须兼容迁移', () => {
  const legacy = {
    worldKey: 'legacy_cluster',
    skill_instances: {
      gather_resources: {
        step_index: 1,
        calls: 2,
        data: { recipe: { boards: 1 } },
      },
    },
  }
  const norm = normalizeMemory(legacy, 'legacy_cluster')
  assert.ok(norm.skill_instances)
  // 能够通过兼容代理或 instance_id 访问
  const inst = norm.skill_instances.gather_resources
  assert.ok(inst, '必须能够兼容读取旧版以 skill_id 为 key 的实例')
  assert.equal(inst.step_index, 1)
})

test('LIFECYCLE-INTEGRATION: 完整三资源任务链真实执行与快照证据验证', async () => {
  // 初始背包为空，缺 log×4, rocks×4, goldnugget×1
  const world = makeWorld({ items: {} })
  // 基础工具齐全以支持采伐与开采
  addItem(world, 'axe', 1)
  addItem(world, 'pickaxe', 1)

  // 资源位置放近一点，避免多次移动步数
  world.resources = [
    { prefab: 'evergreen', work_action: 'CHOP', position: { x: 2, z: 2 } },
    { prefab: 'rock1', work_action: 'MINE', position: { x: -2, z: 2 } },
    { prefab: 'rock2', work_action: 'MINE', position: { x: 2, z: -2 } },
  ]

  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    goal: '收集建家核心物资',
    tasks: [
      { id: 'gather_log', title: '收集木头', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { log: 4 } }, target: { type: 'inventory', prefab: 'log', count: 4 } },
      { id: 'gather_rocks', title: '收集石头', status: 'pending', priority: 2, depends_on: ['gather_log'], skill_id: 'gather_resources', skill_args: { target_items: { rocks: 4 } }, target: { type: 'inventory', prefab: 'rocks', count: 4 } },
      { id: 'gather_goldnugget', title: '收集金块', status: 'pending', priority: 3, depends_on: ['gather_rocks'], skill_id: 'gather_resources', skill_args: { target_items: { goldnugget: 1 } }, target: { type: 'inventory', prefab: 'goldnugget', count: 1 } },
    ],
  }

  const calls = []
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world, { calls }),
  })

  // 循环调度推进至所有任务全部达成
  let maxTicks = 30
  while (maxTicks-- > 0) {
    const res = await orch.tickOnce()
    if (res.status === 'no_task') break
  }

  // 1. 验证背包最终确实包含了全部所需材料证据
  const finalSnap = snapOf(world)
  const items = Object.values(finalSnap.player.inventory.items)
  const logs = items.find((i) => i.prefab === 'log')?.count ?? 0
  const rocks = items.find((i) => i.prefab === 'rocks')?.count ?? 0
  const gold = items.find((i) => i.prefab === 'goldnugget')?.count ?? 0
  assert.ok(logs >= 4, `最终木头必须 >= 4，实际 ${logs}`)
  assert.ok(rocks >= 4, `最终石头必须 >= 4，实际 ${rocks}`)
  assert.ok(gold >= 1, `最终金块必须 >= 1，实际 ${gold}`)

  // 2. 验证三个独立 task_id 均已正确完成
  const tLog = mem.task_board.tasks.find((t) => t.id === 'gather_log')
  const tRocks = mem.task_board.tasks.find((t) => t.id === 'gather_rocks')
  const tGold = mem.task_board.tasks.find((t) => t.id === 'gather_goldnugget')
  assert.equal(tLog.status, 'completed', 'gather_log 必须完成')
  assert.equal(tRocks.status, 'completed', 'gather_rocks 必须完成')
  assert.equal(tGold.status, 'completed', 'gather_goldnugget 必须完成')

  // 3. 验证生成了三个独立的实例且具有不同 instance_id
  const instances = orch.executor.allInstances()
  const iLog = instances.find((x) => x.task_id === 'gather_log')
  const iRocks = instances.find((x) => x.task_id === 'gather_rocks')
  const iGold = instances.find((x) => x.task_id === 'gather_goldnugget')

  assert.ok(iLog, '必须存在 gather_log 实例')
  assert.ok(iRocks, '必须存在 gather_rocks 实例')
  assert.ok(iGold, '必须存在 gather_goldnugget 实例')

  assert.notEqual(iLog.instance_id, iRocks.instance_id)
  assert.notEqual(iRocks.instance_id, iGold.instance_id)
  assert.notEqual(iLog.instance_id, iGold.instance_id)

  // 4. 验证各自参数独立
  assert.deepEqual(iLog.skill_args, { target_items: { log: 4 } })
  assert.deepEqual(iRocks.skill_args, { target_items: { rocks: 4 } })
  assert.deepEqual(iGold.skill_args, { target_items: { goldnugget: 1 } })
})
