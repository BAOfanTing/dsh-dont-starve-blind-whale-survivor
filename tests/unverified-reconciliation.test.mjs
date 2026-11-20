// unverified-reconciliation.test.mjs
// Phase R.7.3: unverified 状态进入对账与核验防重发机制测试

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SkillExecutor } from '../lib/skills/skill-executor.js'
import { registerSkill } from '../lib/skills/skill-registry.js'
import { emptyMemory } from '../lib/planner/world-memory.js'

function createMockExecutor({ dispatch, readSnapshot, now = () => 1000 }) {
  const memory = emptyMemory('test_world_unverified')
  const logs = []
  const executor = new SkillExecutor({
    memory,
    worldKey: 'test_world_unverified',
    readSnapshot,
    dispatch,
    log: (tag, payload) => logs.push({ tag, payload }),
    now,
  })
  return { executor, memory, logs }
}

try {
  registerSkill({
    id: 'test_unverified_skill',
    steps: [
      {
        id: 'unverified_step',
        isDone: (ctx) => (ctx.snapshot?.inventory?.items?.find((i) => i.prefab === 'log')?.count || 0) >= 1,
        nextAction: () => ({ tool: 'chop', args: { target: 'evergreen' } }),
      },
    ],
  })
} catch {}

test('UNVERIFIED-01: Dispatch 返回 unverified 时进入 awaiting_reconciliation 且不触发立即重发或硬失败', async () => {
  let dispatchCount = 0
  const dispatch = async () => {
    dispatchCount++
    return {
      status: 'unverified',
      reason: 'verify_failed',
      commandId: 'cmd_unverified_01',
      verified: false,
    }
  }

  const currentSnapshot = {
    identity: { worldKey: 'test_world_unverified' },
    actor: { tileX: 0, tileZ: 0 },
    inventory: { items: [] },
  }

  const { executor, logs } = createMockExecutor({
    dispatch,
    readSnapshot: () => currentSnapshot,
  })

  const res = await executor.run('test_unverified_skill', 'task_unverified_1')
  assert.equal(res.status, 'awaiting_reconciliation')
  assert.equal(dispatchCount, 1)
  assert.equal(res.action.command_id, 'cmd_unverified_01')
  assert.equal(res.action.status, 'unverified')
  assert.equal(res.action.verified, false)

  const inst = executor.instanceOf('test_unverified_skill')
  assert.ok(inst)
  assert.equal(inst.status, 'awaiting_reconciliation')
  assert.equal(inst.reconciliation.command_id, 'cmd_unverified_01')
  assert.equal(inst.reconciliation.original_result_status, 'unverified')
})

test('UNVERIFIED-02: 快照更新证实动作生效后，对账成功推进且不重复下发动作', async () => {
  let dispatchCount = 0
  const dispatch = async () => {
    dispatchCount++
    return {
      status: 'unverified',
      reason: 'verify_failed',
      commandId: 'cmd_unverified_02',
      verified: false,
    }
  }

  let items = []
  const snapshotReader = () => ({
    identity: { worldKey: 'test_world_unverified' },
    actor: { tileX: 0, tileZ: 0 },
    inventory: { items },
  })

  const { executor, logs } = createMockExecutor({
    dispatch,
    readSnapshot: snapshotReader,
  })

  // 第 1 轮：动作下发，返回 unverified，进入对账
  const res1 = await executor.run('test_unverified_skill', 'task_unverified_2')
  assert.equal(res1.status, 'awaiting_reconciliation')
  assert.equal(dispatchCount, 1)

  // 随后快照中出现了砍树产物 log（游戏实际已经执行成功）
  items = [{ prefab: 'log', count: 1 }]

  // 第 2 轮：再次调用 run()，核实已完成
  const res2 = await executor.run('test_unverified_skill', 'task_unverified_2')
  assert.equal(res2.status, 'completed')
  assert.equal(dispatchCount, 1, '对账成功推进绝不重新下发动作')

  const inst = executor.instanceOf('test_unverified_skill')
  assert.equal(inst.status, 'completed')
  assert.equal(inst.reconciliation, null)

  const reconcileLog = logs.find((l) => l.tag.includes('RECONCILIATION_COMPLETED'))
  assert.ok(reconcileLog, '必须记录对账成功日志')
})

test('UNVERIFIED-03: unverified 状态对账尝试耗尽 (3次) 后转为终态 unknown，防止死循环', async () => {
  let dispatchCount = 0
  const dispatch = async () => {
    dispatchCount++
    return {
      status: 'unverified',
      reason: 'verify_failed',
      commandId: 'cmd_unverified_03',
      verified: false,
    }
  }

  const snapshot = {
    identity: { worldKey: 'test_world_unverified' },
    actor: { tileX: 0, tileZ: 0 },
    inventory: { items: [] },
  }

  const { executor, logs } = createMockExecutor({
    dispatch,
    readSnapshot: () => snapshot,
  })

  // 初始下发
  const res1 = await executor.run('test_unverified_skill', 'task_unverified_3')
  assert.equal(res1.status, 'awaiting_reconciliation')

  // 第 1 次对账失败
  const r1 = await executor.run('test_unverified_skill', 'task_unverified_3')
  assert.equal(r1.status, 'awaiting_reconciliation')

  // 第 2 次对账失败
  const r2 = await executor.run('test_unverified_skill', 'task_unverified_3')
  assert.equal(r2.status, 'awaiting_reconciliation')

  // 第 3 次对账失败 -> 达到 maxReconcile (3次)，转入保护终态 unknown
  const r3 = await executor.run('test_unverified_skill', 'task_unverified_3')
  assert.equal(r3.status, 'unknown')
  assert.equal(r3.reason, 'reconciliation_budget_exhausted')
  assert.equal(dispatchCount, 1, '整个对账生命周期严禁重发动作')

  const failLog = logs.find((l) => l.tag.includes('RECONCILIATION_FAILED'))
  assert.ok(failLog, '必须记录对账失败日志')
})
