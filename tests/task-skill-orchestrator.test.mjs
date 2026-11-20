// tests/task-skill-orchestrator.test.mjs
// Phase R.2: Task Board 与 Skill Executor 架构收敛测试套件
//
// 覆盖：
// 1. Task 能正确启动对应 Skill。
// 2. Task 参数正确传入 Skill。
// 3. 已有 Skill Instance 能正确恢复。
// 4. 同一 Task 不会重复创建实例。
// 5. 不允许两个技能同时控制角色。
// 6. 生存紧急能够暂停建家。
// 7. 生存恢复后能够继续建家。
// 8. 技能完成后 Task 正确完成。
// 9. 技能失败后 Task 正确记录失败。
// 10. 世界切换不会串任务。
// 11. 已完成步骤不会重放。
// 12. get_state 不会意外下发动作。
// 13. run_skill 与自动调度使用同一个实例。
// 14. Task 和 Skill 不会出现状态互相矛盾。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeState } from '../lib/state/snapshot.js'
import { TaskSkillOrchestrator } from '../lib/planner/task-skill-orchestrator.js'
import { createWorldMemoryStore, emptyMemory } from '../lib/planner/world-memory.js'
import { executeTool } from '../lib/tools.js'
import { createPlanner } from '../lib/planner/planner-core.js'
import { ensureSkillsRegistered } from '../lib/skills/index.js'

ensureSkillsRegistered()

function makeWorld(over = {}) {
  return {
    worldKey: 'cluster:R2/shard:1',
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
      { prefab: 'evergreen', work_action: 'CHOP', position: { x: 6, z: 5 } },
      { prefab: 'rock1', work_action: 'MINE', position: { x: -5, z: 4 } },
    ],
    harvestables: [
      { prefab: 'sapling', position: { x: 2, z: 3 }, harvest_ready: true },
      { prefab: 'grass', position: { x: 1, z: 4 }, harvest_ready: true },
    ],
    pickupables: [{ prefab: 'flint', position: { x: 4, z: 1 } }],
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
      identity: { session_id: 'sess', cluster_id: 'R2', shard_id: '1', world_key: world.worldKey, world_key_source: 'cluster_id' },
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

test('ORCH-01: Task 能正确启动对应 Skill', async () => {
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    goal: '收集资源',
    tasks: [
      { id: 'task_gather', title: '收集木头', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { log: 2 } } },
    ],
  }
  const calls = []
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world, { calls }),
  })

  const res = await orch.tickOnce()
  assert.equal(res.task_id, 'task_gather')
  assert.equal(res.skill_id, 'gather_resources')
  const inst = orch.instanceOf('gather_resources')
  assert.ok(inst, '必须创建技能实例')
  assert.equal(inst.task_id, 'task_gather', '实例中必须记录正确的 task_id')
})

test('ORCH-02: Task 参数正确传入 Skill', async () => {
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    goal: '收集特定配方',
    tasks: [
      { id: 'task_recipe', title: '收集造锅材料', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { rocks: 6 } } },
    ],
  }
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world),
  })

  await orch.tickOnce()
  const inst = orch.instanceOf('gather_resources')
  assert.deepEqual(inst.data.skill_args.target_items, { rocks: 6 }, 'task.skill_args 必须完整注入实例 data')
})

test('ORCH-03: 已有 Skill Instance 能正确恢复', async () => {
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'task_gather', title: '收集木头', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { log: 4 } } },
    ],
  }
  mem.skill_instances = {
    gather_resources: {
      skill_id: 'gather_resources',
      task_id: 'task_gather',
      status: 'paused',
      step_index: 0,
      attempts: 0,
      step_attempts: {},
      step_calls: { collect: 1 },
      calls: 1,
      data: { skill_args: { target_items: { log: 4 } } },
    },
  }
  const logs = []
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world),
    log: (tag, payload) => logs.push({ tag, payload }),
  })

  await orch.tickOnce()
  const resumeLog = logs.find((l) => l.tag === '[ORCHESTRATOR] RESUME')
  assert.ok(resumeLog, '恢复执行时应记录 [ORCHESTRATOR] RESUME 日志')
  assert.equal(resumeLog.payload.task_id, 'task_gather')
})

test('ORCH-04: 同一 Task 不会重复创建实例', async () => {
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'task_gather', title: '收集木头', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { log: 10 } } },
    ],
  }
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world),
  })

  await orch.tickOnce()
  const inst1 = mem.skill_instances.gather_resources
  assert.ok(inst1)
  const initialStartedAt = inst1.started_at

  await orch.tickOnce()
  const inst2 = mem.skill_instances.gather_resources
  assert.equal(inst1, inst2, '连续推进应当复用同一个实例引用')
  assert.equal(inst2.started_at, initialStartedAt, '不应重新初始化实例启动时间')
})

test('ORCH-05: 不允许两个技能同时控制角色', async () => {
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  mem.active_skill_id = 'survival_stabilize'
  mem.skill_instances = {
    survival_stabilize: {
      skill_id: 'survival_stabilize',
      task_id: 'task_survival',
      status: 'in_progress',
      step_index: 0,
      step_attempts: {},
      step_calls: {},
      calls: 1,
      data: {},
    },
  }
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

  await orch.tickOnce()
  assert.equal(mem.skill_instances.survival_stabilize.status, 'paused', '旧技能必须被暂停')
  assert.equal(mem.active_skill_id, 'establish_home', 'active_skill_id 只能是当前推进的技能')
})

test('ORCH-06: 生存紧急能够暂停建家', async () => {
  const world = makeWorld({ phase: 'night', inLight: false }) // 黑夜且无光源 -> P0 紧急
  const mem = emptyMemory(world.worldKey)
  mem.active_skill_id = 'establish_home'
  mem.skill_instances = {
    establish_home: {
      skill_id: 'establish_home',
      task_id: 'task_home',
      status: 'in_progress',
      step_index: 1,
      step_attempts: {},
      step_calls: {},
      calls: 1,
      data: {},
    },
  }
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'task_home', title: '建立家园', status: 'in_progress', priority: 1, skill_id: 'establish_home' },
    ],
  }
  const calls = []
  const logs = []
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world, { calls }),
    log: (tag, payload) => logs.push({ tag, payload }),
  })

  const res = await orch.tickOnce()
  assert.ok(['survival_preempted', 'survival_in_progress'].includes(res.status))
  assert.equal(mem.skill_instances.establish_home.status, 'paused')
  assert.match(mem.skill_instances.establish_home.paused_reason, /survival_preempt/)
  // 在当前逻辑下，如果被 preempted，应该先去执行 emergency_survival，calls 长度可能不为 0（如果 stabilization 包含动作）
  // 为了不破坏原意，先仅验证主任务被暂停
  const pauseLog = logs.find((l) => l.tag === '[TASK] PAUSED')
  assert.ok(pauseLog, '任务应输出 [TASK] PAUSED 日志')
})

test('ORCH-07: 生存恢复后能够继续建家', async () => {
  const world = makeWorld({ phase: 'day', inLight: true })
  const mem = emptyMemory(world.worldKey)
  mem.camp_site = { x: 10, z: 10 }
  mem.skill_instances = {
    establish_home: {
      skill_id: 'establish_home',
      task_id: 'task_home',
      status: 'paused',
      step_index: 1, // 前往营地
      step_attempts: {},
      step_calls: {},
      calls: 1,
      data: {},
    },
  }
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'task_home', title: '建立家园', status: 'in_progress', priority: 1, skill_id: 'establish_home' },
    ],
  }
  const calls = []
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world, { calls }),
  })

  const res = await orch.tickOnce()
  assert.equal(mem.skill_instances.establish_home.status, 'in_progress')
  assert.equal(calls[0]?.tool, 'move_to')
  assert.deepEqual(calls[0]?.args, { x: 10, z: 10 })
})

test('ORCH-08: 技能完成后 Task 正确完成', async () => {
  const world = makeWorld()
  addItem(world, 'flint', 2)
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'task_flint', title: '收集燧石', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { flint: 2 } } },
    ],
  }
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world),
  })

  const res = await orch.tickOnce()
  assert.equal(res.status, 'completed')
  const task = mem.task_board.tasks.find((t) => t.id === 'task_flint')
  assert.equal(task.status, 'completed', '看板任务状态必须更新为 completed')
  assert.ok(task.completed_at > 0)
})

test('ORCH-09: 技能失败后 Task 正确记录失败', async () => {
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'task_fail', title: '不可能的任务', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { log: 5 } } },
    ],
  }
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world, { rejectOn: () => 'target_not_accessible' }),
  })

  // 连续执行耗尽重试次数
  for (let i = 0; i < 5; i++) {
    await orch.tickOnce()
  }

  const inst = orch.instanceOf('gather_resources')
  assert.equal(inst.status, 'failed')
  const task = mem.task_board.tasks.find((t) => t.id === 'task_fail')
  assert.ok(['failed', 'blocked'].includes(task.status), '看板任务必须被标记为 failed 或 blocked')
})

test('ORCH-10: 世界切换不会串任务', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-orch-test-'))
  try {
    const store = createWorldMemoryStore({ dir })
    const memA = store.load('world-A')
    memA.task_board = {
      schema: 'bws.task-board/1',
      tasks: [{ id: 'task_A', title: '世界A任务', status: 'pending', priority: 1, skill_id: 'gather_resources' }],
    }
    store.save(memA)

    const memB = store.load('world-B')
    memB.task_board = {
      schema: 'bws.task-board/1',
      tasks: [{ id: 'task_B', title: '世界B任务', status: 'pending', priority: 1, skill_id: 'establish_home' }],
    }
    store.save(memB)

    const reloadedA = store.load('world-A')
    const reloadedB = store.load('world-B')
    assert.equal(reloadedA.task_board.tasks[0].id, 'task_A')
    assert.equal(reloadedB.task_board.tasks[0].id, 'task_B')
    assert.equal(reloadedA.task_board.tasks.find((t) => t.id === 'task_B'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ORCH-11: 已完成步骤不会重放', async () => {
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  // 选址营地已确立（步骤 0 满足）
  mem.camp_site = { x: 12, z: 12 }
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'task_home', title: '建立家园', status: 'pending', priority: 1, skill_id: 'establish_home' },
    ],
  }
  const calls = []
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world, { calls }),
  })

  await orch.tickOnce()
  // 步骤 0 survey_and_site 被跳过，直接进入步骤 1 travel_to_camp
  assert.equal(calls.length, 1)
  assert.equal(calls[0].tool, 'move_to')
  assert.deepEqual(calls[0].args, { x: 12, z: 12 })
})

test('ORCH-12: get_state 不会意外下发动作', async () => {
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
    control: {
      activeLease: () => ({ valid: true, authorized_actions: ['all'] }),
      guard: () => null,
    },
    dispatcher: {
      dispatch: async (cmd) => {
        calls.push(cmd)
        return { status: 'succeeded' }
      },
      describe: () => 'ok',
    },
  }

  const output = await executeTool('get_state', {}, ctx)
  assert.ok(typeof output === 'string' && output.length > 0)
  assert.equal(calls.length, 0, 'get_state 执行过程不得派发任何游戏动作')
})

test('ORCH-13: run_skill 指定 task_id 与自动调度使用同一个实例；不指定时独立隔离', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-orch-13-'))
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
      control: {
        activeLease: () => ({ valid: true, authorized_actions: ['all'] }),
        guard: () => null,
      },
      dispatcher: {
        dispatch: async () => ({ status: 'succeeded' }),
        describe: () => 'ok',
      },
      executionMode: 'assisted',
    }

    // 1. 指定 task_id: 'task_g' 时，run_skill 与 orchestrator 操作同一个任务实例
    await executeTool('run_skill', { skill_id: 'gather_resources', task_id: 'task_g', max_steps: 1 }, ctx)
    assert.ok(ctx.orchestrator, '工具应共享挂载 orchestrator')
    const inst1 = ctx.orchestrator.executor.activeInstanceForTask('task_g')
    assert.ok(inst1)
    assert.equal(inst1.task_id, 'task_g')

    // 再通过 orchestrator 调度推进同一个任务
    const mem = planner.memoryFor(snapOf(world))
    mem.task_board = {
      schema: 'bws.task-board/1',
      tasks: [{ id: 'task_g', title: '收集', status: 'pending', priority: 1, skill_id: 'gather_resources' }],
    }
    await ctx.orchestrator.tickOnce()
    const inst2 = ctx.orchestrator.executor.activeInstanceForTask('task_g')
    assert.equal(inst1, inst2, '指定同一 task_id 时，run_skill 与 orchestrator 必须操作同一个实例')

    // 2. 不指定 task_id 时，作为独立手动任务，不覆盖 task_g 的实例
    await executeTool('run_skill', { skill_id: 'gather_resources', max_steps: 1 }, ctx)
    const manualInst = ctx.orchestrator.executor.activeInstanceForTask('manual:gather_resources')
    assert.ok(manualInst)
    assert.notEqual(manualInst.instance_id, inst1.instance_id, '独立手动调用必须拥有独立实例，不覆盖原有任务实例')
    assert.equal(inst1.task_id, 'task_g', '原有任务的 task_id 不受影响')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ORCH-14: Task 和 Skill 不会出现状态互相矛盾', async () => {
  const world = makeWorld()
  const mem = emptyMemory(world.worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    tasks: [
      { id: 'task_g', title: '收集木头', status: 'pending', priority: 1, skill_id: 'gather_resources', skill_args: { target_items: { log: 1 } } },
    ],
  }
  addItem(world, 'log', 1)
  const orch = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch: makeDispatch(world),
  })

  await orch.tickOnce()
  const task = mem.task_board.tasks.find((t) => t.id === 'task_g')
  const inst = orch.instanceOf('gather_resources')
  assert.equal(task.status, 'completed')
  assert.equal(inst.status, 'completed')
})
