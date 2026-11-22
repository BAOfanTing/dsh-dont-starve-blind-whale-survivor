import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foodAction } from '../lib/skills/food-candidate-selector.js'
import { SkillExecutor } from '../lib/skills/skill-executor.js'
import { registerSkill } from '../lib/skills/skill-registry.js'
import { createDispatcher } from '../lib/dispatcher.js'
import { emptyMemory } from '../lib/planner/world-memory.js'

test('SEEK-01: foodAction 在远距离目标时生成带 budget_s: 15 的 seek plan', () => {
  const snapshot = {
    identity: { worldKey: 'test_seek' },
    actor: { tileX: 0, tileZ: 0, hunger: { current: 30, max: 150 }, health: { current: 100, max: 150 } },
    ground: [
      { id: 'berry_1', prefab: 'berrybush', tileX: 25, tileZ: 25, ready: true },
    ],
    inventory: { items: [] },
  }
  const inst = { data: {} }
  const plan = foodAction(snapshot, inst, { need: 'hunger' })
  // P1：找不到食物时不再原地 seek，而是朝迷雾定向开图（exploreFrontier 给出 move_to）
  assert.equal(plan.tool, 'move_to', '找不到食物应改走 exploreFrontier 的 move_to 开图')
  assert.ok(typeof plan.args?.x === 'number' && typeof plan.args?.z === 'number')
})

test('SEEK-02: SkillExecutor.run() 将 plan 中的 budget_s 与 timeoutMs 正确传递给 dispatch', async () => {
  let passedOpts = null
  const dispatch = async (tool, args, opts) => {
    passedOpts = opts
    return { status: 'succeeded', verified: true }
  }

  const skillId = 'test_seek_budget_skill'
  let done = false
  try {
    registerSkill({
      id: skillId,
      steps: [
        {
          id: 'seek_step',
          isDone: () => done,
          nextAction: () => {
            done = true
            return { tool: 'seek', args: { prefab: 'berrybush' }, budget_s: 15, timeoutMs: 30000 }
          },
        },
      ],
    })
  } catch {}

  const executor = new SkillExecutor({
    memory: emptyMemory('test_world'),
    readSnapshot: () => ({
      identity: { worldKey: 'test_world' },
      actor: { health: { current: 150, max: 150 }, hunger: { current: 150, max: 150 }, sanity: { current: 200, max: 200 } },
    }),
    dispatch,
  })

  await executor.run(skillId, 'task_seek')
  assert.ok(passedOpts)
  assert.equal(passedOpts.budget_s, 15)
  assert.equal(passedOpts.timeoutMs, 30000)
})

test('SEEK-03 & 04: Dispatcher 组装 envelope.budget_s 并向 Bridge 传递有效 timeoutMs 和 signal', async () => {
  let calledBridgeEnvelope = null
  let calledBridgeTimeout = null
  let calledBridgeSignal = null

  const mockBridge = {
    call: async (action, args, opts = {}) => {
      calledBridgeEnvelope = opts.envelope
      calledBridgeTimeout = opts.timeoutMs
      calledBridgeSignal = opts.signal
      return { ok: true, data: { status: 'done', text: '找到目标' } }
    },
    readReport: () => null,
  }

  const dispatcher = createDispatcher({
    bridge: mockBridge,
    readSnapshot: () => ({
      identity: { worldKey: 'test_world' },
      actor: { valid: true, alive: true, isGhost: false },
    }),
    control: {
      status: () => ({ held: true }),
      validate: () => ({ ok: true, lease: { owner_type: 'agent', owner_instance_id: 'i1', authority_epoch: 1, lease_id: 'l1', generation: 1, expires_at: Date.now() + 60000 } }),
    },
    commandTtlMs: 30000,
    timeoutMs: 105000,
  })

  const abortController = new AbortController()

  // 下发 seek 动作，明确传递 budget_s: 15
  await dispatcher.dispatch({
    tool: 'seek',
    args: { prefab: 'berrybush' },
    owner: 'agent',
    budget_s: 15,
    signal: abortController.signal,
  })

  assert.ok(calledBridgeEnvelope)
  assert.equal(calledBridgeEnvelope.budget_s, 15, 'envelope.budget_s 必须正确填入 15')
  assert.equal(calledBridgeTimeout, 15 * 1000 + 15000, 'Bridge timeoutMs 必须动态计算为 30000ms (15s + 15s 缓冲)')
  assert.equal(calledBridgeSignal, abortController.signal, 'AbortSignal 必须透传给 Bridge')
})

test('SEEK-05: Non-seek 动作默认超时不被 seek budget 意外覆盖', async () => {
  let calledBridgeEnvelope = null
  let calledBridgeTimeout = null

  const mockBridge = {
    call: async (action, args, opts = {}) => {
      calledBridgeEnvelope = opts.envelope
      calledBridgeTimeout = opts.timeoutMs
      return { ok: true, data: { status: 'done', text: '砍倒了' } }
    },
    readReport: () => null,
  }

  const dispatcher = createDispatcher({
    bridge: mockBridge,
    readSnapshot: () => ({
      identity: { worldKey: 'test_world' },
      actor: { valid: true, alive: true, isGhost: false },
      nearby: { snapshot_id: 'snap_1', items: [{ ref: '#1', prefab: 'evergreen' }] },
    }),
    control: {
      status: () => ({ held: true }),
      validate: () => ({ ok: true, lease: { owner_type: 'agent', owner_instance_id: 'i1', authority_epoch: 1, lease_id: 'l1', generation: 1, expires_at: Date.now() + 60000 } }),
    },
    commandTtlMs: 30000,
    timeoutMs: 105000,
  })

  await dispatcher.dispatch({
    tool: 'chop',
    args: { target_ref: '#1', snapshot_id: 'snap_1' },
    owner: 'agent',
  })

  assert.ok(calledBridgeEnvelope)
  // R8.x A：普通动作现在按“分级超时上限”截断（chop=30s），不再沿用超长默认；仍与 seek 的独立预算无关。
  assert.equal(calledBridgeTimeout, 30000, '普通动作按分级上限 chop=30s')
  assert.equal(calledBridgeEnvelope.budget_s, 15, 'budget_s 由分级超时算出 (30 - 15 = 15s)')
})

test('SEEK-06: seek 动作在 abort 时立刻 reject 且不挂起等待', async () => {
  const mockBridge = {
    call: async () => new Promise(() => {}), // 模拟长时间挂起
    readReport: () => null,
  }

  const dispatcher = createDispatcher({
    bridge: mockBridge,
    readSnapshot: () => ({
      identity: { worldKey: 'test_world' },
      actor: { valid: true, alive: true, isGhost: false },
    }),
    control: {
      status: () => ({ held: true }),
      validate: () => ({ ok: true, lease: { owner_type: 'agent', owner_instance_id: 'i1', authority_epoch: 1, lease_id: 'l1', generation: 1, expires_at: Date.now() + 60000 } }),
    },
  })

  const controller = new AbortController()
  controller.abort() // 提前中止

  const outcome = await dispatcher.dispatch({
    tool: 'seek',
    args: { prefab: 'berrybush' },
    signal: controller.signal,
  })

  assert.equal(outcome.status, 'rejected')
  assert.equal(outcome.reason, 'aborted')
})
