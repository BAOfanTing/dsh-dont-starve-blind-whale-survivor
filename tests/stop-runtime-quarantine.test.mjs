// stop-runtime-quarantine.test.mjs
// Phase R.7.3: 验证 Stop 超时未放锁时的 Quarantine 隔离屏障与锁释放自愈

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WorldRuntime } from '../lib/planner/world-runtime-manager.js'
import { createWorldMemoryStore } from '../lib/planner/world-memory.js'

test('QUARANTINE-01: 当持有锁的任务在 stop 超时内未释放时，进入 quarantined 状态并拒绝后续任务', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'bws-quarantine-'))
  const memoryStore = createWorldMemoryStore({ dir: join(tempDir, 'mem') })
  const worldKey = 'world-test-quarantine-1'

  let slowTaskRelease = null
  const slowTaskDone = new Promise((resolve) => {
    slowTaskRelease = resolve
  })

  const mockDispatcher = {
    specs: {},
    describe: () => 'ok',
    dispatch: async (req) => {
      if (req.tool === 'stop') {
        return { status: 'succeeded', commandId: 'cmd-stop-q1' }
      }
      return { status: 'succeeded' }
    },
  }

  const runtime = new WorldRuntime({
    worldKey,
    store: memoryStore,
    dispatcher: mockDispatcher,
    readSnapshot: () => ({ identity: { worldKey }, actor: {} }),
  })

  // 1. 模拟一个正在执行的长任务占用锁
  let lockAcquired = false
  const longRunningPromise = runtime.withLock(async () => {
    lockAcquired = true
    await slowTaskDone
    return 'slow_task_done'
  }, { taskId: 'slow_task' })

  assert.equal(lockAcquired, true)
  assert.equal(runtime.isBusy(), true)

  // 2. 在锁尚未释放时触发 stop，设置较短的等待超时 (100ms)
  const stopReport = await runtime.stop({ timeoutMs: 100 })

  // 验证停止状态为 unknown，next_action_allowed 为 false
  assert.equal(stopReport.status, 'unknown')
  assert.equal(stopReport.next_action_allowed, false)
  assert.equal(runtime.quarantined, true, '必须处于 quarantined 隔离屏障中')
  assert.equal(runtime.cancelRequested, true, 'cancelRequested 必须保持 true')
  assert.equal(runtime.isBusy(), true, 'quarantine 期间 isBusy 必须为 true')

  // 3. 验证此时新任务被完全阻断
  await assert.rejects(
    async () => {
      await runtime.withLock(async () => 'new_task', { taskId: 'new_task_blocked' })
    },
    { message: /runtime_cancelled/ }
  )

  const acqRes = await runtime.acquireLock({ taskId: 'new_task_acquire' })
  assert.equal(acqRes.acquired, false)
  assert.equal(acqRes.reason, 'runtime_cancelled')

  // 4. 原长任务终于完成并释放锁
  slowTaskRelease()
  const longRes = await longRunningPromise
  assert.equal(longRes, 'slow_task_done')

  // 5. 验证锁释放后，quarantined 与 cancelRequested 自愈解除
  assert.equal(runtime.quarantined, false, '锁真正释放后 quarantine 必须解除')
  assert.equal(runtime.cancelRequested, false, '锁真正释放后 cancelRequested 必须解除')
  assert.equal(runtime.isBusy(), false)

  // 6. 新任务现在可以正常执行
  const resultAfterHealing = await runtime.withLock(async () => 'success_after_quarantine', { taskId: 'post_quarantine' })
  assert.equal(resultAfterHealing, 'success_after_quarantine')
})

test('QUARANTINE-02: 当持有锁的任务在 stop 超时内正常退出时，不进入 quarantined 状态', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'bws-quarantine-'))
  const memoryStore = createWorldMemoryStore({ dir: join(tempDir, 'mem') })
  const worldKey = 'world-test-quarantine-2'

  const mockDispatcher = {
    specs: {},
    describe: () => 'ok',
    dispatch: async (req) => {
      if (req.tool === 'stop') {
        return { status: 'succeeded', commandId: 'cmd-stop-q2' }
      }
      return { status: 'succeeded' }
    },
  }

  const runtime = new WorldRuntime({
    worldKey,
    store: memoryStore,
    dispatcher: mockDispatcher,
    readSnapshot: () => ({ identity: { worldKey }, actor: {} }),
  })

  // 快速完成的任务
  const taskPromise = runtime.withLock(async () => {
    await new Promise((r) => setTimeout(r, 20))
    return 'quick_task_done'
  })

  const stopReport = await runtime.stop({ timeoutMs: 500 })
  await taskPromise

  assert.equal(stopReport.status, 'succeeded')
  assert.equal(stopReport.next_action_allowed, false)
  assert.equal(runtime.quarantined, false)
  assert.equal(runtime.cancelRequested, false)

  // 锁已正常释放且未进入隔离，后续新任务可正常执行
  const nextRes = await runtime.withLock(async () => 'next_allowed')
  assert.equal(nextRes, 'next_allowed')
})

test('QUARANTINE-03（D6）：stop 以「当前租约持有者」身份下发，而不是请求者', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'bws-holder-'))
  const memoryStore = createWorldMemoryStore({ dir: join(tempDir, 'mem') })
  const seen = {}
  const mockDispatcher = {
    specs: {},
    describe: () => 'ok',
    dispatch: async (req) => {
      if (req.tool === 'stop') { seen.owner = req.owner; seen.instance = req.ownerInstanceId; return { status: 'succeeded', commandId: 'c-holder' } }
      return { status: 'succeeded' }
    },
  }
  const runtime = new WorldRuntime({
    worldKey: 'world-holder-1',
    store: memoryStore,
    dispatcher: mockDispatcher,
    readSnapshot: () => ({ identity: { worldKey: 'world-holder-1' }, actor: {} }),
    readAuthority: () => ({ owner_type: 'f8_agent', owner_instance_id: 'inst-A', generation: 5 }),
  })
  const res = await runtime.stop({ owner: 'mcp_client', ownerInstanceId: 'inst-M', timeoutMs: 1000 })
  assert.equal(seen.owner, 'f8_agent', 'stop 必须以租约持有者身份下发（否则被 control_denied）')
  assert.equal(seen.instance, 'inst-A')
  assert.equal(res.status, 'succeeded')
})

test('QUARANTINE-04（D7）：stop 命令失败（且无锁）不能被当成成功清标志，必须进入隔离', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'bws-d7-'))
  const memoryStore = createWorldMemoryStore({ dir: join(tempDir, 'mem') })
  const mockDispatcher = {
    specs: {},
    describe: () => 'ok',
    dispatch: async (req) => {
      if (req.tool === 'stop') return { status: 'failed', reason: 'dispatch_error' }
      return { status: 'succeeded' }
    },
  }
  const runtime = new WorldRuntime({
    worldKey: 'world-d7-1',
    store: memoryStore,
    dispatcher: mockDispatcher,
    readSnapshot: () => ({ identity: { worldKey: 'world-d7-1' }, actor: {} }),
  })
  const res = await runtime.stop({ timeoutMs: 1000 })
  assert.equal(res.status, 'unknown')
  assert.equal(res.ok, false)
  assert.equal(runtime.quarantined, true, '命令失败不能清掉隔离（D7）')
  assert.equal(runtime.cancelRequested, true)
  assert.equal(runtime.isBusy(), true)
})
