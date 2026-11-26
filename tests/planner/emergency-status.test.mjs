// Phase R.7.4-A 回归测试 B：紧急生存状态传播 + advance_task 重复失败保护。
//
// 真机问题：
//   1) survival_stabilize 返回 blocked/failed/unknown 时，Orchestrator 把它们
//      统统包装成 survival_in_progress（伪装成"还在执行"）。
//   2) 一次 advance_task 里同一动作（gather_area）连续 rejected 10 次，烧光预算却毫无进展。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TaskSkillOrchestrator, classifyExecutorStatus } from '../../lib/planner/task-skill-orchestrator.js'
import { WorldRuntimeManager } from '../../lib/planner/world-runtime-manager.js'

function nightSnap() {
  return {
    identity: { worldKey: 'w_r74' },
    actor: { valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0 },
    player: {
      health: { percent: 100 }, hunger: { percent: 100 }, sanity: { percent: 100 },
      in_light: false, inventory: { items: [] }, equipment: { slots: {}, worn: [] },
    },
    world: { phase: 'night' },
    nearby: { buckets: { threats: [], pickupables: [], harvestables: [], resources: [] } },
  }
}

/** 用一个可控的假 executor 驱动 Orchestrator 的紧急生存分支。 */
function orchWith(executorResult) {
  const executor = {
    run: async () => ({ instance_id: 'inst_r74', step: 'light', ...executorResult }),
    activeInstance: () => null,
    pause: () => ({ ok: true }),
  }
  return new TaskSkillOrchestrator({
    memory: { skill_instances: {}, task_board: { schema: 'bws.task-board/1', tasks: [] } },
    worldKey: 'w_r74',
    readSnapshot: nightSnap,
    dispatch: async () => ({ status: 'succeeded' }),
    executor,
  })
}

test('R74-B0: classifyExecutorStatus 不做"压扁成 in_progress"的映射', () => {
  assert.equal(classifyExecutorStatus({ status: 'completed' }), 'completed')
  assert.equal(classifyExecutorStatus({ status: 'reflex_active' }), 'reflex_active')
  assert.equal(classifyExecutorStatus({ status: 'blocked' }), 'blocked')
  assert.equal(classifyExecutorStatus({ status: 'failed' }), 'failed')
  assert.equal(classifyExecutorStatus({ status: 'unknown' }), 'unknown')
  assert.equal(classifyExecutorStatus({ status: 'awaiting_reconciliation' }), 'awaiting_reconciliation')
  assert.equal(classifyExecutorStatus({ status: 'cancelled' }), 'cancelled')
  assert.equal(classifyExecutorStatus({ status: 'timeout' }), 'timeout')
  assert.equal(classifyExecutorStatus({ status: 'step_in_progress' }), 'in_progress')
  assert.equal(classifyExecutorStatus({ status: 'some_new_status' }), 'unknown')
})

for (const [raw, expected] of [
  ['blocked', 'blocked'],
  ['failed', 'failed'],
  ['unknown', 'unknown'],
  ['awaiting_reconciliation', 'awaiting_reconciliation'],
  ['cancelled', 'cancelled'],
  ['step_in_progress', 'survival_in_progress'],
  ['completed', 'survival_stabilized'],
  ['reflex_active', 'reflex_active'],
]) {
  test(`survival_stabilize 返回 ${raw} → Orchestrator 状态为 ${expected}，不伪装成进行中`, async () => {
    const orch = orchWith({ status: raw, reason: `reason_${raw}` })
    const res = await orch.tickOnce()
    assert.equal(res.status, expected, `status=${raw} 应映射为 ${expected}`)
    if (['blocked', 'failed', 'unknown', 'awaiting_reconciliation', 'cancelled'].includes(expected)) {
      // 底层原因、实例 ID 都必须保留，不能被吞掉
      assert.equal(res.reason, `reason_${raw}`, '必须保留底层失败/阻塞原因')
      assert.equal(res.instance_id, 'inst_r74', '必须保留技能实例 ID')
      assert.notEqual(res.status, 'survival_in_progress', '绝不能把失败伪装成"仍在执行"')
    }
  })
}

test('advance_task 遇到同一动作连续 rejected 时，会在 3 次内停下，不会烧光 10 次预算', async () => {
  WorldRuntimeManager.clear()
  const store = {
    _m: {},
    load(k) { if (!this._m[k]) this._m[k] = { world_key: k, skill_instances: {}, task_board: { schema: 'bws.task-board/1', tasks: [] } }; return this._m[k] },
    save(m) { this._m[m.world_key] = m },
  }
  const dispatched = []
  const dispatcher = {
    dispatch: async (req) => { dispatched.push(req); return { status: 'rejected', reason: 'gather_area_failed' } },
    describe: () => '失败',
  }
  const runtime = WorldRuntimeManager.getOrCreate({
    worldKey: 'w_repeat',
    store,
    dispatcher,
    readSnapshot: () => ({ identity: { worldKey: 'w_repeat' }, actor: { valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0 }, player: { in_light: true, health: { percent: 100 }, hunger: { percent: 100 } } }),
    log: () => {},
  })
  // 直接桩掉 orchestrator：模拟一次 tick 就产生一个 rejected 的 gather_area 动作
  runtime.orchestrator = {
    tickOnce: async () => ({
      status: 'step_in_progress',
      task_id: 't1',
      step: 'collect',
      reason: 'gather_area_failed',
      action: { tool: 'gather_area', args: { prefab: 'grass' }, status: 'rejected', verified: false, command_id: 'cmd-x' },
    }),
  }
  const report = await runtime.advanceTask({ maxSteps: 10 })
  assert.equal(report.stop_reason, 'repeated_failed_action', '重复失败必须被识别并中止')
  assert.equal(report.repeated_failed_action, true)
  assert.ok(report.actions_executed.length <= 3, `不能在重复失败上空转 10 次（实际 ${report.actions_executed.length}）`)
  assert.equal(report.task_status, 'blocked', '反复失败的任务不能谎报为进行中')
  assert.equal(report.failed_action.tool, 'gather_area')
  // 所有动作都如实标记为未核验，绝不能当成有效进展
  for (const a of report.actions_executed) assert.equal(a.verified, false)
  WorldRuntimeManager.clear()
})
