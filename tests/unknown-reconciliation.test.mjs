import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SkillExecutor } from '../lib/skills/skill-executor.js'
import { registerSkill } from '../lib/skills/skill-registry.js'
import { emptyMemory } from '../lib/planner/world-memory.js'

function createMockExecutor({ dispatch, readSnapshot, now = () => 1000 }) {
  const memory = emptyMemory('test_world')
  const logs = []
  const executor = new SkillExecutor({
    memory,
    worldKey: 'test_world',
    readSnapshot,
    dispatch,
    log: (tag, payload) => logs.push({ tag, payload }),
    now,
  })
  return { executor, memory, logs }
}

// 注册专门的测试技能
try {
  registerSkill({
    id: 'test_craft_skill',
    steps: [
      {
        id: 'craft_step',
        isDone: (ctx) => (ctx.snapshot?.inventory?.items?.find((i) => i.prefab === 'torch')?.count || 0) >= 1,
        nextAction: () => ({ tool: 'craft', args: { recipe: 'torch' } }),
      },
    ],
  })
} catch {}

try {
  registerSkill({
    id: 'test_build_skill',
    steps: [
      {
        id: 'build_step',
        isDone: (ctx) => Boolean(ctx.snapshot?.structures?.find((s) => s.prefab === 'researchlab')),
        nextAction: () => ({ tool: 'build', args: { recipe: 'researchlab' } }),
      },
    ],
  })
} catch {}

try {
  registerSkill({
    id: 'test_eat_skill',
    steps: [
      {
        id: 'eat_step',
        isDone: (ctx) => (ctx.snapshot?.actor?.hunger?.current || 0) >= 60,
        nextAction: () => ({ tool: 'eat', args: { item: 'berries' } }),
      },
    ],
  })
} catch {}

try {
  registerSkill({
    id: 'test_gather_skill',
    steps: [
      {
        id: 'gather_step',
        isDone: (ctx) => (ctx.snapshot?.inventory?.items?.find((i) => i.prefab === 'log')?.count || 0) >= 2,
        nextAction: () => ({ tool: 'gather_area', args: { target: 'tree' } }),
      },
    ],
  })
} catch {}

try {
  registerSkill({
    id: 'test_move_skill',
    steps: [
      {
        id: 'move_step',
        isDone: (ctx) => ctx.snapshot?.actor?.tileX === 10 && ctx.snapshot?.actor?.tileZ === 10,
        nextAction: () => ({ tool: 'move_to', args: { x: 10, z: 10 } }),
      },
    ],
  })
} catch {}

test('UNKNOWN-01: Dispatch 返回 unknown 时进入 awaiting_reconciliation 且不重复下发原动作', async () => {
  let dispatchCount = 0
  const dispatch = async (tool, args) => {
    dispatchCount++
    return { status: 'unknown', reason: 'result_timeout', commandId: 'cmd_unknown_01' }
  }
  let currentSnapshot = {
    identity: { worldKey: 'test_world' },
    actor: { tileX: 0, tileZ: 0 },
    inventory: { items: [] },
  }
  const { executor } = createMockExecutor({
    dispatch,
    readSnapshot: () => currentSnapshot,
  })

  // 第一次 run: 下发动作并收到 unknown
  const res1 = await executor.run('test_craft_skill', 'task_craft')
  assert.equal(res1.status, 'awaiting_reconciliation')
  assert.equal(dispatchCount, 1)

  const inst = executor.latestInstanceForTask('task_craft')
  assert.equal(inst.status, 'awaiting_reconciliation')
  assert.equal(inst.reconciliation.command_id, 'cmd_unknown_01')
  assert.equal(inst.reconciliation.reconcile_attempts, 0)

  // 第二次 run (快照仍未见产物): 触发对账，但绝不能重新 dispatch
  const res2 = await executor.run('test_craft_skill', 'task_craft')
  assert.equal(res2.status, 'awaiting_reconciliation')
  assert.equal(dispatchCount, 1, '对账期间严禁重新 dispatch 下发动作')
  assert.equal(inst.reconciliation.reconcile_attempts, 1)
})

test('UNKNOWN-02: Build 动作 unknown 通过快照出现建筑成功对账推进', async () => {
  let dispatchCount = 0
  const dispatch = async () => {
    dispatchCount++
    return { status: 'unknown', reason: 'result_timeout', commandId: 'cmd_build_02' }
  }

  let snapshot = {
    identity: { worldKey: 'test_world' },
    actor: { tileX: 0, tileZ: 0 },
    inventory: { items: [{ prefab: 'goldnugget', count: 10 }, { prefab: 'log', count: 10 }, { prefab: 'rocks', count: 10 }] },
    structures: [],
  }

  const { executor, logs } = createMockExecutor({
    dispatch,
    readSnapshot: () => snapshot,
  })

  // 1. 初次执行建造科学机器，返回 unknown
  const res1 = await executor.run('test_build_skill', 'task_build')
  assert.equal(res1.status, 'awaiting_reconciliation')
  assert.equal(dispatchCount, 1)

  // 2. 游戏底层实际建造成功，快照中出现建筑
  snapshot = {
    ...snapshot,
    structures: [{ prefab: 'researchlab', tileX: 0, tileZ: 0 }],
  }

  // 3. 再次 run，对账检测到建筑出现，步骤完成
  const res2 = await executor.run('test_build_skill', 'task_build')
  assert.equal(res2.status, 'completed')
  assert.equal(dispatchCount, 1, '无需重发建造动作，对账直接判定完成')

  const reconciledLog = logs.find((l) => l.tag.includes('RECONCILIATION_COMPLETED'))
  assert.ok(reconciledLog, '必须记录对账成功日志')
})

test('UNKNOWN-03: Craft 动作 unknown 通过背包物品增加成功对账', async () => {
  let dispatchCount = 0
  const dispatch = async () => {
    dispatchCount++
    return { status: 'unknown', reason: 'result_timeout', commandId: 'cmd_craft_03' }
  }

  let snapshot = {
    identity: { worldKey: 'test_world' },
    actor: { tileX: 0, tileZ: 0 },
    inventory: { items: [{ prefab: 'twigs', count: 5 }, { prefab: 'cutgrass', count: 5 }] },
  }

  const { executor } = createMockExecutor({
    dispatch,
    readSnapshot: () => snapshot,
  })

  // 1. 制作火把，返回 unknown
  const res1 = await executor.run('test_craft_skill', 'task_torch')
  assert.equal(res1.status, 'awaiting_reconciliation')
  assert.equal(dispatchCount, 1)

  // 2. 背包里出现火把
  snapshot = {
    identity: { worldKey: 'test_world' },
    actor: { tileX: 0, tileZ: 0 },
    inventory: { items: [{ prefab: 'torch', count: 1 }] },
  }

  // 3. 对账生效
  const res2 = await executor.run('test_craft_skill', 'task_torch')
  assert.equal(res2.status, 'completed')
  assert.equal(dispatchCount, 1)
})

test('UNKNOWN-04: Eat 动作 unknown 通过饱食度/血量变化成功对账', async () => {
  let dispatchCount = 0
  const dispatch = async () => {
    dispatchCount++
    return { status: 'unknown', reason: 'result_timeout', commandId: 'cmd_eat_04' }
  }

  let hunger = 30
  const snapshotReader = () => ({
    identity: { worldKey: 'test_world' },
    actor: {
      tileX: 0,
      tileZ: 0,
      hunger: { current: hunger, max: 150 },
    },
    inventory: { items: [{ prefab: 'berries', count: 2 }] },
  })

  const { executor } = createMockExecutor({
    dispatch,
    readSnapshot: snapshotReader,
  })

  const res1 = await executor.run('test_eat_skill', 'task_eat')
  assert.equal(res1.status, 'awaiting_reconciliation')
  assert.equal(dispatchCount, 1)

  // 模拟饱食度上升
  hunger = 80
  const res2 = await executor.run('test_eat_skill', 'task_eat')
  assert.equal(res2.status, 'completed')
  assert.equal(dispatchCount, 1)
})

test('UNKNOWN-05: Harvest/pickup 动作 unknown 通过产物增加成功对账', async () => {
  let dispatchCount = 0
  const dispatch = async () => {
    dispatchCount++
    return { status: 'unknown', reason: 'result_timeout', commandId: 'cmd_gather_05' }
  }

  let logCount = 0
  const snapshotReader = () => ({
    identity: { worldKey: 'test_world' },
    actor: { tileX: 0, tileZ: 0 },
    inventory: { items: logCount > 0 ? [{ prefab: 'log', count: logCount }] : [] },
  })

  const { executor } = createMockExecutor({
    dispatch,
    readSnapshot: snapshotReader,
  })

  const res1 = await executor.run('test_gather_skill', 'task_gather')
  assert.equal(res1.status, 'awaiting_reconciliation')
  assert.equal(dispatchCount, 1)

  // 产物进入背包
  logCount = 2
  const res2 = await executor.run('test_gather_skill', 'task_gather')
  assert.equal(res2.status, 'completed')
  assert.equal(dispatchCount, 1)
})

test('UNKNOWN-06: Move/seek 动作 unknown 通过坐标变化对账', async () => {
  let dispatchCount = 0
  const dispatch = async () => {
    dispatchCount++
    return { status: 'unknown', reason: 'result_timeout', commandId: 'cmd_move_06' }
  }

  let actorX = 0
  let actorZ = 0
  const snapshotReader = () => ({
    identity: { worldKey: 'test_world' },
    actor: { tileX: actorX, tileZ: actorZ },
    inventory: { items: [] },
  })

  const { executor } = createMockExecutor({
    dispatch,
    readSnapshot: snapshotReader,
  })

  const res1 = await executor.run('test_move_skill', 'task_move')
  assert.equal(res1.status, 'awaiting_reconciliation')
  assert.equal(dispatchCount, 1)

  // 到达目标
  actorX = 10
  actorZ = 10
  const res2 = await executor.run('test_move_skill', 'task_move')
  assert.equal(res2.status, 'completed')
  assert.equal(dispatchCount, 1)
})

test('UNKNOWN-07: 对账超出最大尝试次数 (3次) 进入终态 unknown，严禁盲目重发', async () => {
  let dispatchCount = 0
  const dispatch = async () => {
    dispatchCount++
    return { status: 'unknown', reason: 'result_timeout', commandId: 'cmd_exhaust_07' }
  }

  const snapshot = {
    identity: { worldKey: 'test_world' },
    actor: { tileX: 0, tileZ: 0 },
    inventory: { items: [] },
  }

  const { executor, logs } = createMockExecutor({
    dispatch,
    readSnapshot: () => snapshot,
  })

  // 初始下发
  const res1 = await executor.run('test_craft_skill', 'task_exhaust')
  assert.equal(res1.status, 'awaiting_reconciliation')

  // 第 1 次对账失败
  const r1 = await executor.run('test_craft_skill', 'task_exhaust')
  assert.equal(r1.status, 'awaiting_reconciliation')

  // 第 2 次对账失败
  const r2 = await executor.run('test_craft_skill', 'task_exhaust')
  assert.equal(r2.status, 'awaiting_reconciliation')

  // 第 3 次对账失败 -> 达到 max_reconcile_attempts (3次)，预算耗尽，转为终态 unknown
  const r3 = await executor.run('test_craft_skill', 'task_exhaust')
  assert.equal(r3.status, 'unknown')
  assert.equal(r3.reason, 'reconciliation_budget_exhausted')
  assert.equal(dispatchCount, 1, '整个过程绝对不能重发动作')

  const failLog = logs.find((l) => l.tag.includes('RECONCILIATION_FAILED'))
  assert.ok(failLog, '必须记录对账失败日志')
})

test('UNKNOWN-08: Command ID 与命令身份保留并在对账与日志中完整追踪', async () => {
  const dispatch = async () => {
    return { status: 'unknown', reason: 'result_timeout', commandId: 'traceable_cmd_id_999' }
  }

  const { executor, logs } = createMockExecutor({
    dispatch,
    readSnapshot: () => ({
      identity: { worldKey: 'test_world' },
      actor: { tileX: 0, tileZ: 0 },
      inventory: { items: [] },
    }),
  })

  const res = await executor.run('test_craft_skill', 'task_trace')
  assert.equal(res.action.command_id, 'traceable_cmd_id_999')

  const unknownLog = logs.find((l) => l.tag.includes('ACTION_UNKNOWN'))
  assert.ok(unknownLog)
  assert.equal(unknownLog.payload.command_id, 'traceable_cmd_id_999')
})
