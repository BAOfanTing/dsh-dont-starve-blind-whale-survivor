// Phase R.7：WorldRuntimeManager, advance_task, execution modes, and concurrency integration tests

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorldRuntimeManager, WorldRuntime } from '../lib/planner/world-runtime-manager.js'
import { toolList, executeTool } from '../lib/tools.js'
import { emptyMemory } from '../lib/planner/world-memory.js'

function createMockStore() {
  const data = new Map()
  return {
    load: (wk) => {
      const key = wk || 'unknown_world'
      if (!data.has(key)) data.set(key, emptyMemory(key))
      return data.get(key)
    },
    save: (mem) => {
      data.set(mem.world_key || 'unknown_world', mem)
    },
    data,
  }
}

test('RUNTIME-01: 相同 world_key 返回同一个单例 WorldRuntime，不同 world_key 严格隔离', () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  const dispatcher = { dispatch: async () => ({ status: 'succeeded' }), describe: () => 'ok' }
  const readSnapshot = () => ({ identity: { worldKey: 'world_A' } })

  const rtA1 = WorldRuntimeManager.getOrCreate({ worldKey: 'world_A', store, dispatcher, readSnapshot })
  const rtA2 = WorldRuntimeManager.getOrCreate({ worldKey: 'world_A', store, dispatcher, readSnapshot })
  const rtB = WorldRuntimeManager.getOrCreate({ worldKey: 'world_B', store, dispatcher, readSnapshot: () => ({ identity: { worldKey: 'world_B' } }) })

  assert.equal(rtA1, rtA2, '相同 worldKey 必须共享同一个 WorldRuntime 实例')
  assert.notEqual(rtA1, rtB, '不同 worldKey 必须隔离不同的 WorldRuntime')
  assert.equal(rtA1.memory, rtA2.memory, '相同 worldKey 必须共享同一份内存引用')
  assert.notEqual(rtA1.memory, rtB.memory, '不同 worldKey 内存独立')
})

test('RUNTIME-02: 并发互斥锁生效，两个并发请求串行执行不冲突', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  let running = 0
  let maxConcurrent = 0
  const dispatcher = {
    dispatch: async () => {
      running++
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise((r) => setTimeout(r, 20))
      running--
      return { status: 'succeeded' }
    },
    describe: () => 'ok',
  }
  const readSnapshot = () => ({
    identity: { worldKey: 'world_mutex' },
    actor: { tileX: 0, tileZ: 0 },
  })

  const rt = WorldRuntimeManager.getOrCreate({ worldKey: 'world_mutex', store, dispatcher, readSnapshot })

  // 模拟两个并发任务执行
  const [res1, res2] = await Promise.all([
    rt.withLock(async () => {
      running++
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise((r) => setTimeout(r, 20))
      running--
      return 'task_1_done'
    }),
    rt.withLock(async () => {
      running++
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise((r) => setTimeout(r, 20))
      running--
      return 'task_2_done'
    }),
  ])

  assert.equal(res1, 'task_1_done')
  assert.equal(res2, 'task_2_done')
  assert.equal(maxConcurrent, 1, '临界区内并发数最大只能为 1，确保世界互斥')
})

test('AUTOPILOT-01: 三种模式暴露完全相同的完整工具集（模式只影响驱动，不裁剪工具）', () => {
  const autopilotTools = toolList('autopilot').map((t) => t.name)
  const assistedTools = toolList('assisted').map((t) => t.name)
  const manualTools = toolList('manual').map((t) => t.name)
  const unknownModeTools = toolList('unknown_mode_xyz').map((t) => t.name)

  assert.deepEqual(autopilotTools, assistedTools, 'Autopilot 与 Assisted 工具集必须一致')
  assert.deepEqual(autopilotTools, manualTools, 'Autopilot 与 Manual 工具集必须一致')
  assert.deepEqual(unknownModeTools, autopilotTools, '未知模式也返回完整工具集（不裁剪）')
  for (const n of ['advance_task', 'run_skill', 'get_state', 'get_guide', 'update_notes', 'stop', 'move_to', 'pickup_nearest', 'harvest_nearest', 'craft', 'build', 'attack']) {
    assert.ok(autopilotTools.includes(n), `Autopilot 也必须暴露 ${n}`)
  }
})

test('AUTOPILOT-02: executeTool 不再按 executionMode 拦截任何工具（模式只影响驱动）', async () => {
  const call = async (name, args, mode) => {
    try { return String(await executeTool(name, args, { executionMode: mode, bridge: null, log: () => {} })) }
    catch (e) { return 'THREW:' + String(e?.message ?? e) }
  }
  // Autopilot 下调用原子动作 / run_skill：允许（可能因无游戏/无 bridge 失败，但**不是**权限拒绝）
  assert.ok(!(await call('move_to', { x: 10, z: 10 }, 'autopilot')).includes('禁止直接调用底层原子动作'), 'Autopilot 不再按模式拦截 move_to')
  assert.ok(!(await call('run_skill', { skill_id: 'survival_stabilize' }, 'autopilot')).includes('禁止通过【run_skill】'), 'Autopilot 不再按模式拦截 run_skill')
  // Manual 下调用 advance_task：允许（不再禁用）
  assert.ok(!(await call('advance_task', {}, 'manual')).includes('禁止调用【advance_task】'), 'Manual 不再禁用 advance_task')
})

test('AUTOPILOT-03: advance_task 能够根据任务看板连续执行多个原子动作并返回结构化报告', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  const mem = store.load('world_advance')
  mem.task_board = {
    schema: 'bws.task-board/1',
    goal: '收集基础物资',
    tasks: [
      {
        id: 'gather_log',
        title: '收集木头',
        priority: 'normal',
        status: 'ready',
        skill_id: 'gather_resources',
        skill_args: { target_items: { log: 2 } },
        attempts: 0,
        max_attempts: 3,
        cooldown_until: 0,
        progress: { current: 0, required: 2 },
      },
    ],
  }

  let snapshotCounter = 0
  const snapshots = [
    { identity: { worldKey: 'world_advance' }, inventory: { items: [] }, actor: { tileX: 0, tileZ: 0 } },
    { identity: { worldKey: 'world_advance' }, inventory: { items: [{ prefab: 'log', count: 1 }] }, actor: { tileX: 1, tileZ: 1 } },
    { identity: { worldKey: 'world_advance' }, inventory: { items: [{ prefab: 'log', count: 2 }] }, actor: { tileX: 2, tileZ: 2 } },
  ]

  let actionsDispatched = []
  const dispatcher = {
    dispatch: async ({ tool, args }) => {
      actionsDispatched.push({ tool, args })
      snapshotCounter++
      return { status: 'succeeded', verified: true }
    },
    describe: (o) => `动作 ${o.status}`,
  }

  const readSnapshot = () => snapshots[Math.min(snapshotCounter, snapshots.length - 1)]

  const ctx = {
    executionMode: 'autopilot',
    planner: {
      store,
      memoryFor: () => mem,
      guardBuild: () => null,
    },
    bridge: {},
    owner: 'mcp_client',
    ownerInstanceId: 'test-inst',
  }

  // 覆盖 readSnapshot
  const runtime = WorldRuntimeManager.getOrCreate({
    worldKey: 'world_advance',
    store,
    dispatcher,
    readSnapshot,
    log: () => {},
  })

  // advanceTask 最多 5 步
  const report = await runtime.advanceTask({ maxSteps: 5 })
  assert.ok(report.steps_executed >= 1, 'advanceTask 应该推进了步骤')
  assert.equal(report.world_key, 'world_advance')
  assert.equal(report.task_id, 'gather_log')
  assert.ok(['in_progress', 'completed', 'budget_exhausted', 'stopped'].includes(report.status))
})
