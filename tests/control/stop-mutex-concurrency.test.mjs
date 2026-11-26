import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorldRuntimeManager, WorldRuntime } from '../../lib/planner/world-runtime-manager.js'
import { emptyMemory } from '../../lib/planner/world-memory.js'

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

function seedTask(mem, taskId = 'gather_log') {
  mem.task_board = {
    schema: 'bws.task-board/1',
    goal: '收集基础物资',
    tasks: [
      {
        id: taskId,
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
}

function parseReq(first, maybeArgs, maybeOpts) {
  if (typeof first === 'object' && first !== null) {
    return {
      tool: first.tool,
      args: first.args ?? {},
      opts: first,
    }
  }
  return {
    tool: first,
    args: maybeArgs ?? {},
    opts: maybeOpts ?? {},
  }
}

test('STOP-01: 空闲状态下 Stop 正常完成且下发底座 stop', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  const dispatches = []
  const dispatcher = {
    dispatch: async (first, maybeArgs, maybeOpts) => {
      const { tool, args, opts } = parseReq(first, maybeArgs, maybeOpts)
      dispatches.push({ tool, args, opts })
      return { status: 'succeeded', message: '停下了' }
    },
    describe: () => 'ok',
  }
  const rt = WorldRuntimeManager.getOrCreate({
    worldKey: 'world_stop_01',
    store,
    dispatcher,
    readSnapshot: () => ({ identity: { worldKey: 'world_stop_01' } }),
  })

  const res = await rt.stop({ timeoutMs: 1000 })
  assert.equal(res.ok, true)
  assert.equal(res.status, 'succeeded')
  assert.equal(rt.isBusy(), false)
  assert.equal(dispatches.length, 1)
  assert.equal(dispatches[0].tool, 'stop')
})

test('STOP-02: 动作执行中收到 Stop，AbortSignal 触发且取消传播', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  const mem = store.load('world_stop_02')
  seedTask(mem)

  let actionAborted = false
  let actionResolve
  const actionPromise = new Promise((r) => { actionResolve = r })

  const dispatcher = {
    dispatch: async (first, maybeArgs, maybeOpts) => {
      const { tool, opts } = parseReq(first, maybeArgs, maybeOpts)
      if (tool === 'stop') {
        return { status: 'succeeded', message: '底层已停下' }
      }
      opts?.signal?.addEventListener('abort', () => {
        actionAborted = true
        actionResolve({ status: 'cancelled', reason: 'aborted' })
      })
      return actionPromise
    },
    describe: () => 'ok',
  }

  const rt = WorldRuntimeManager.getOrCreate({
    worldKey: 'world_stop_02',
    store,
    dispatcher,
    readSnapshot: () => ({
      identity: { worldKey: 'world_stop_02' },
      actor: { tileX: 0, tileZ: 0 },
      ground: [],
      inventory: { items: [] },
    }),
  })

  // 启动后台任务
  const advanceP = rt.advanceTask({ timeoutMs: 3000 })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(rt.isBusy(), true, '执行中 Runtime 应当处于 busy 状态')

  // 发起 stop
  const stopP = rt.stop({ timeoutMs: 2000 })
  const stopRes = await stopP
  assert.equal(stopRes.ok, true)
  assert.equal(actionAborted, true, '底层 dispatch 必须收到 AbortSignal')

  const advRes = await advanceP
  assert.equal(rt.isBusy(), false)
  assert.ok(['cancelled', 'in_progress', 'paused'].includes(advRes.status))
})

test('STOP-03: Stop 后原执行流程无法继续发送下一步动作', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  let dispatchCount = 0

  const dispatcher = {
    dispatch: async (first, maybeArgs, maybeOpts) => {
      const { tool, opts } = parseReq(first, maybeArgs, maybeOpts)
      dispatchCount++
      if (tool === 'stop') return { status: 'succeeded' }
      if (opts?.signal?.aborted) return { status: 'cancelled' }
      await new Promise((r) => setTimeout(r, 30))
      return { status: 'in_progress' }
    },
    describe: () => 'ok',
  }

  const rt = WorldRuntimeManager.getOrCreate({
    worldKey: 'world_stop_03',
    store,
    dispatcher,
    readSnapshot: () => ({ identity: { worldKey: 'world_stop_03' } }),
  })

  const p1 = rt.advanceTask({ timeoutMs: 2000 })
  await new Promise((r) => setTimeout(r, 10))
  await rt.stop({ timeoutMs: 2000 })
  await p1

  const countAfterStop = dispatchCount
  // 等待一段时间，证明不会再触发下一步动作
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(dispatchCount, countAfterStop, 'Stop 后原流程不得再发新动作')
})

test('STOP-04: Stop 时存在排队请求，队列中的任务被安全取消', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  const mem = store.load('world_stop_04')
  seedTask(mem)

  let firstResolve
  const firstBlock = new Promise((r) => { firstResolve = r })

  const dispatcher = {
    dispatch: async (first, maybeArgs, maybeOpts) => {
      const { tool } = parseReq(first, maybeArgs, maybeOpts)
      if (tool === 'stop') return { status: 'succeeded' }
      await firstBlock
      return { status: 'succeeded' }
    },
    describe: () => 'ok',
  }

  const rt = WorldRuntimeManager.getOrCreate({
    worldKey: 'world_stop_04',
    store,
    dispatcher,
    readSnapshot: () => ({
      identity: { worldKey: 'world_stop_04' },
      actor: { tileX: 0, tileZ: 0 },
      ground: [],
      inventory: { items: [] },
    }),
  })

  // 任务1占有锁并在 dispatch 中等待
  const p1 = rt.advanceTask({ timeoutMs: 2000 })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(rt.isBusy(), true)

  // 任务2进入排队队列
  const p2 = rt.advanceTask({ timeoutMs: 2000 })
  assert.equal(rt.queueLength(), 1, '任务2应当已进入队列')

  // 发起 stop
  const stopP = rt.stop({ timeoutMs: 2000 })
  firstResolve()
  await stopP

  const res2 = await p2
  assert.equal(res2.status, 'cancelled')
  assert.equal(res2.stop_reason, 'cancelled_by_stop')
  assert.equal(rt.queueLength(), 0, '队列应当已被清空')
})

test('STOP-05: Stop 后新任务不能在旧动作退出前开始', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  const mem = store.load('world_stop_05')
  seedTask(mem)

  let oldActionExited = false
  let newActionStarted = false
  let releaseOld
  const oldActionPromise = new Promise((r) => { releaseOld = r })

  const dispatcher = {
    dispatch: async (first, maybeArgs, maybeOpts) => {
      const { tool, opts } = parseReq(first, maybeArgs, maybeOpts)
      if (tool === 'stop') return { status: 'succeeded' }

      if (newActionStarted && !oldActionExited) {
        throw new Error('并发冲突：旧动作未退出时新动作已经下发！')
      }

      opts?.signal?.addEventListener('abort', () => {
        setTimeout(() => {
          oldActionExited = true
          releaseOld({ status: 'cancelled' })
        }, 30)
      })
      return oldActionPromise
    },
    describe: () => 'ok',
  }

  const rt = WorldRuntimeManager.getOrCreate({
    worldKey: 'world_stop_05',
    store,
    dispatcher,
    readSnapshot: () => ({
      identity: { worldKey: 'world_stop_05' },
      actor: { tileX: 0, tileZ: 0 },
      ground: [],
      inventory: { items: [] },
    }),
  })

  const p1 = rt.advanceTask({ timeoutMs: 2000 })
  await new Promise((r) => setTimeout(r, 20))

  // 异步触发 stop
  const stopP = rt.stop({ timeoutMs: 2000 })

  // 紧接着触发新任务
  const p2 = rt.advanceTask({ timeoutMs: 2000 }).then((res) => {
    newActionStarted = true
    return res
  })

  const stopRes = await stopP
  assert.equal(stopRes.ok, true)
  assert.equal(oldActionExited, true, '旧动作必须在 stop 完成时已经退出')

  await p1
  const res2 = await p2
  assert.equal(res2.status, 'cancelled')
})

test('STOP-06: 旧执行流程 finally 不得释放新执行流程的锁 (Mutex 所有权隔离)', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  const rt = WorldRuntimeManager.getOrCreate({
    worldKey: 'world_stop_06',
    store,
    dispatcher: { dispatch: async () => ({ status: 'succeeded' }), describe: () => 'ok' },
    readSnapshot: () => ({ identity: { worldKey: 'world_stop_06' } }),
  })

  // 获取第一个锁
  const lock1 = await rt.acquireLock({ taskId: 'task_1', timeoutMs: 1000 })
  assert.ok(lock1.acquired)
  const owner1 = lock1.ownerId

  // 释放锁 1
  rt.releaseLock(owner1)
  assert.equal(rt.isBusy(), false)

  // 获取第二个锁
  const lock2 = await rt.acquireLock({ taskId: 'task_2', timeoutMs: 1000 })
  assert.ok(lock2.acquired)
  const owner2 = lock2.ownerId
  assert.notEqual(owner1, owner2)

  // 模拟旧任务 1 的 finally 运行，尝试用旧 owner1 释放锁
  const released = rt.releaseLock(owner1)
  assert.equal(released, false, '旧 owner 绝不允许释放新锁')
  assert.equal(rt.isBusy(), true, '锁依然必须由 owner2 持有')

  // 真正合法释放
  const releasedReal = rt.releaseLock(owner2)
  assert.equal(releasedReal, true)
  assert.equal(rt.isBusy(), false)
})

test('STOP-07: 重复 Stop 不得制造并发状态或死锁', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  let stopCallCount = 0
  const dispatcher = {
    dispatch: async (first, maybeArgs, maybeOpts) => {
      const { tool } = parseReq(first, maybeArgs, maybeOpts)
      if (tool === 'stop') {
        stopCallCount++
        await new Promise((r) => setTimeout(r, 20))
        return { status: 'succeeded' }
      }
      return { status: 'succeeded' }
    },
    describe: () => 'ok',
  }
  const rt = WorldRuntimeManager.getOrCreate({
    worldKey: 'world_stop_07',
    store,
    dispatcher,
    readSnapshot: () => ({ identity: { worldKey: 'world_stop_07' } }),
  })

  // 连续并发触发 3 次 stop
  const results = await Promise.all([
    rt.stop({ timeoutMs: 1000 }),
    rt.stop({ timeoutMs: 1000 }),
    rt.stop({ timeoutMs: 1000 }),
  ])

  for (const res of results) {
    assert.equal(res.ok, true)
  }
  assert.equal(rt.isBusy(), false)
})

test('STOP-08: Stop 与 Reflex 抢占同时发生时，保留 Reflex 保命优先级', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  const dispatcher = {
    dispatch: async (first, maybeArgs, maybeOpts) => {
      const { tool } = parseReq(first, maybeArgs, maybeOpts)
      if (tool === 'stop') {
        return { status: 'rejected', reason: 'reflex_active' }
      }
      return { status: 'rejected', reason: 'reflex_active' }
    },
    describe: () => 'ok',
  }

  const rt = WorldRuntimeManager.getOrCreate({
    worldKey: 'world_stop_08',
    store,
    dispatcher,
    readSnapshot: () => ({ identity: { worldKey: 'world_stop_08' } }),
  })

  const stopRes = await rt.stop({ timeoutMs: 1000 })
  // Stop 应当如实记录状态，不宣称成功，不强关 Reflex
  assert.ok(['unknown', 'in_flight', 'cancelled'].includes(stopRes.status))
  assert.equal(rt.isBusy(), false)
})

test('STOP-09: Stop 超时不能伪装成功，必须返回准确状态', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  const dispatcher = {
    dispatch: async (first, maybeArgs, maybeOpts) => {
      const { tool } = parseReq(first, maybeArgs, maybeOpts)
      if (tool === 'stop') {
        // 模拟底层 stop 严重超时 (300ms)
        await new Promise((r) => setTimeout(r, 300))
        return { status: 'succeeded' }
      }
      return { status: 'succeeded' }
    },
    describe: () => 'ok',
  }

  const rt = WorldRuntimeManager.getOrCreate({
    worldKey: 'world_stop_09',
    store,
    dispatcher,
    readSnapshot: () => ({ identity: { worldKey: 'world_stop_09' } }),
  })

  // stop 设置超短超时 (50ms)
  const stopRes = await rt.stop({ timeoutMs: 50 })
  assert.equal(stopRes.ok, false)
  assert.notEqual(stopRes.status, 'succeeded', '超时绝不能伪装成成功')
  assert.equal(stopRes.status, 'unknown')
})

test('STOP-10: 原动作已经完成后收到 Stop，必须保留真实完成结果', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  const mem = store.load('world_stop_10')
  seedTask(mem)

  let actionDone = false
  const dispatcher = {
    dispatch: async (first, maybeArgs, maybeOpts) => {
      const { tool } = parseReq(first, maybeArgs, maybeOpts)
      if (tool === 'stop') return { status: 'succeeded' }
      actionDone = true
      return { status: 'succeeded', verified: true }
    },
    describe: () => 'ok',
  }

  let step = 0
  const snapshots = [
    { identity: { worldKey: 'world_stop_10' }, actor: { tileX: 0, tileZ: 0 }, inventory: { items: [] } },
    { identity: { worldKey: 'world_stop_10' }, actor: { tileX: 0, tileZ: 0 }, inventory: { items: [{ prefab: 'log', count: 2 }] } },
  ]
  const rt = WorldRuntimeManager.getOrCreate({
    worldKey: 'world_stop_10',
    store,
    dispatcher,
    readSnapshot: () => snapshots[step++] || snapshots[1],
  })

  const advRes = await rt.advanceTask({ maxSteps: 1, timeoutMs: 2000 })
  assert.equal(actionDone, true)
  assert.equal(advRes.actions_executed.length, 1)

  const stopRes = await rt.stop({ timeoutMs: 1000 })
  assert.equal(stopRes.ok, true)
  assert.equal(stopRes.status, 'succeeded')
  // 原动作执行结果保留，不被倒退
  assert.notEqual(advRes.status, 'cancelled')
})
