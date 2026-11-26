// Autopilot 动作预算核算与结构化报告测试 (ISSUE-08)
import test from 'node:test'
import assert from 'node:assert/strict'

import { createWorldMemoryStore } from '../../lib/planner/world-memory.js'
import { WorldRuntimeManager } from '../../lib/planner/world-runtime-manager.js'

function createMockStore() {
  const data = {}
  return {
    load(key) {
      if (!data[key]) data[key] = { world_key: key, tasks: {}, active_skill_instance_id: null }
      return data[key]
    },
    save(mem) {
      data[mem.world_key] = mem
    },
  }
}

test('BUDGET-01: maxSteps 严格作为实际动作下发预算（Action Dispatch Budget）', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  const mem = store.load('world_budget_test')
  mem.task_board = {
    schema: 'bws.task-board/1',
    goal: '收集大量物资',
    tasks: [
      {
        id: 'gather_wood',
        title: '收集木头',
        priority: 'normal',
        status: 'ready',
        skill_id: 'gather_resources',
        skill_args: { target_items: { log: 10 } },
        attempts: 0,
        max_attempts: 10,
        cooldown_until: 0,
        progress: { current: 0, required: 10 },
      },
    ],
  }

  // 模拟一个包含很多木头的快照
  const snapshot = {
    identity: { worldKey: 'world_budget_test' },
    actor: { valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0 },
    player: { health: { percent: 100 }, hunger: { percent: 100 }, sanity: { percent: 100 }, in_light: true },
    nearby: {
      buckets: {
        pickupables: [
          { prefab: 'log', distance: 1.0, tileX: 0, tileZ: 1 },
          { prefab: 'log', distance: 1.2, tileX: 0, tileZ: 2 },
          { prefab: 'log', distance: 1.5, tileX: 1, tileZ: 1 },
          { prefab: 'log', distance: 1.8, tileX: 1, tileZ: 2 },
          { prefab: 'log', distance: 2.0, tileX: 2, tileZ: 2 },
        ],
      },
    },
    inventory: { items: [] },
  }

  let actionsDispatched = []
  const dispatcher = {
    dispatch: async (tool, args) => {
      const toolName = typeof tool === 'object' ? tool.tool : tool
      const toolArgs = typeof tool === 'object' ? tool.args : args
      actionsDispatched.push({ tool: toolName, args: toolArgs })
      return {
        status: 'succeeded',
        commandId: `cmd-${actionsDispatched.length}`,
        verified: true,
      }
    },
    describe: (o) => `动作 ${o.status}`,
  }

  const runtime = WorldRuntimeManager.getOrCreate({
    worldKey: 'world_budget_test',
    store,
    dispatcher,
    readSnapshot: () => snapshot,
    log: () => {},
  })

  // 请求执行 maxSteps = 3 个实际动作
  const report = await runtime.advanceTask({ maxSteps: 3 })

  // 验证实际执行动作数严格等于 3
  assert.equal(report.budget_used, 3)
  assert.equal(report.budget_remaining, 0)
  assert.equal(report.stop_reason, 'budget_exhausted')
  assert.equal(actionsDispatched.length, 3)
  assert.equal(report.actions_executed.length, 3)

  // 验证 actions_executed 记录包含完整字段
  for (let i = 0; i < 3; i++) {
    const act = report.actions_executed[i]
    assert.ok(act.tool, '必须有 tool')
    assert.ok(act.command_id, '必须有 command_id')
    assert.equal(act.command_id, `cmd-${i + 1}`)
    assert.equal(act.status, 'succeeded')
    assert.equal(act.verified, true)
  }
})

test('BUDGET-02: 完整结构化报告字段验证与空转安全终止', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  const mem = store.load('world_no_task')
  // 看板没有任务
  mem.task_board = {
    schema: 'bws.task-board/1',
    goal: '无目标',
    tasks: [],
  }

  const snapshot = {
    identity: { worldKey: 'world_no_task' },
    actor: { valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0 },
    player: { health: { percent: 100 }, hunger: { percent: 100 }, sanity: { percent: 100 }, in_light: true },
  }

  const dispatcher = {
    dispatch: async () => ({ status: 'succeeded' }),
    describe: () => '成功',
  }

  const runtime = WorldRuntimeManager.getOrCreate({
    worldKey: 'world_no_task',
    store,
    dispatcher,
    readSnapshot: () => snapshot,
    log: () => {},
  })

  const report = await runtime.advanceTask({ maxSteps: 5 })

  // 验证无任务时能够立即安全停止，不消耗动作预算
  assert.equal(report.task_status, 'no_task')
  assert.equal(report.stop_reason, 'no_task')
  assert.equal(report.budget_used, 0)
  assert.equal(report.budget_remaining, 5)
  assert.equal(report.actions_executed.length, 0)

  // 结构化报告字段齐备
  assert.ok('task_status' in report)
  assert.ok('task_id' in report)
  assert.ok('skill_id' in report)
  assert.ok('instance_id' in report)
  assert.ok('current_step' in report)
  assert.ok('actions_executed' in report)
  assert.ok('budget_used' in report)
  assert.ok('budget_remaining' in report)
  assert.ok('stop_reason' in report)
  assert.ok('survival_alert' in report)
})
