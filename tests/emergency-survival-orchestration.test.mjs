// 紧急生存调度、Reflex 抢占与停止语义测试 (ISSUE-05, ISSUE-06, ISSUE-07)
import test from 'node:test'
import assert from 'node:assert/strict'

import { createWorldMemoryStore } from '../lib/planner/world-memory.js'
import { WorldRuntimeManager } from '../lib/planner/world-runtime-manager.js'
import { createDispatcher } from '../lib/dispatcher.js'
import { TaskSkillOrchestrator } from '../lib/planner/task-skill-orchestrator.js'
import { SkillExecutor } from '../lib/skills/skill-executor.js'

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

test('REFLEX-01: 当 snapshot.reflex.active=true 时，Orchestrator 暂停普通任务并让出控制权给 Reflex', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  const mem = store.load('world_reflex_1')
  mem.task_board = {
    schema: 'bws.task-board/1',
    goal: '收集基础物资',
    tasks: [
      {
        id: 'gather_log',
        title: '收集木头',
        priority: 'normal',
        status: 'in_progress',
        skill_id: 'gather_resources',
        attempts: 0,
      },
    ],
  }

  // 快照处于 Reflex 逃跑中
  const snapshot = {
    identity: { worldKey: 'world_reflex_1' },
    actor: { valid: true, alive: true, isGhost: false, tileX: 10, tileZ: 10 },
    player: { health: { percent: 20 }, hunger: { percent: 80 } },
    reflex: {
      active: true,
      enabled: true,
      intent: 'flee',
      recent: ['flee'],
    },
  }

  let dispatched = []
  const dispatcher = {
    dispatch: async (req) => {
      dispatched.push(req)
      return { status: 'succeeded' }
    },
    describe: (o) => `动作 ${o.status}`,
  }

  const orchestrator = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: 'world_reflex_1',
    readSnapshot: () => snapshot,
    dispatch: dispatcher.dispatch,
    save: () => {},
  })

  const res = await orchestrator.tickOnce()
  assert.equal(res.status, 'reflex_active')
  assert.equal(res.control_owner, 'lua_reflex')
  assert.equal(res.ordinary_actions_allowed, false)
  assert.equal(dispatched.length, 0, 'Reflex 激活期间严禁下发任何普通动作冲撞 Reflex')
})

test('REFLEX-02: Dispatcher 在 before.reflex.active=true 时硬拦截普通动作，但允许 stop 动作', async () => {
  const snapshot = {
    identity: { worldKey: 'world_reflex_disp', sessionId: 'sess', shardId: 'shard1', actorId: 'player' },
    actor: { valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0 },
    reflex: { active: true, intent: 'flee' },
  }

  let bridgeCalls = []
  const bridge = {
    call: async (tool, args, opts) => {
      bridgeCalls.push({ tool, args, opts })
      return { ok: true, text: '成功' }
    },
  }

  const control = {
    validate: () => ({ ok: true, lease: { owner_type: 'mcp_client', owner_instance_id: 'inst', authority_epoch: 'epoch1', lease_id: 'l1', generation: 1, expires_at: Date.now() + 60000 } }),
    status: () => ({}),
  }

  const dispatcher = createDispatcher({
    bridge,
    control,
    readSnapshot: () => snapshot,
  })

  // 普通动作 move_to 必须被拦截为 reflex_active
  const resMove = await dispatcher.dispatch({ tool: 'move_to', args: { x: 5, z: 5 } })
  assert.equal(resMove.status, 'rejected')
  assert.equal(resMove.reason, 'reflex_active')
  assert.equal(bridgeCalls.length, 0, 'move_to 不得发往游戏')

  // 安全停止动作 stop 必须允许发往下层
  const resStop = await dispatcher.dispatch({ tool: 'stop', args: {} })
  assert.equal(resStop.status, 'succeeded')
  assert.equal(bridgeCalls.length, 1)
  assert.equal(bridgeCalls[0].tool, 'stop')
})

test('EMERGENCY-01: 当处于饥饿或残血状态时，Orchestrator 内部自动调度 survival_stabilize 自救闭环', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  const mem = store.load('world_emergency_1')
  mem.task_board = {
    schema: 'bws.task-board/1',
    goal: '长远科技发展',
    tasks: [
      {
        id: 'build_first_structure',
        title: '建造科学机器',
        priority: 'high',
        status: 'ready',
        skill_id: 'build_structure',
        skill_args: { recipe: 'researchlab' },
        attempts: 0,
      },
    ],
  }

  // 饥饿濒危快照（hunger = 20%），背包有浆果
  let snap = {
    identity: { worldKey: 'world_emergency_1' },
    actor: { valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0 },
    player: {
      health: { percent: 80 },
      hunger: { percent: 20 },
      sanity: { percent: 90 },
      in_light: true,
      inventory: {
        items: [
          { prefab: 'berries', count: 3, edible: true },
        ],
      },
    },
  }

  let actionsDispatched = []
  const dispatcher = {
    dispatch: async (tool, args) => {
      const toolName = typeof tool === 'object' ? tool.tool : tool
      const toolArgs = typeof tool === 'object' ? tool.args : args
      actionsDispatched.push({ tool: toolName, args: toolArgs })
      if (toolName === 'eat') {
        // 吃完食物后饥饿恢复
        snap = {
          ...snap,
          player: {
            ...snap.player,
            hunger: { percent: 70 },
            inventory: { items: [{ prefab: 'berries', count: 2, edible: true }] },
          },
        }
      }
      return { status: 'succeeded', verified: true }
    },
    describe: (o) => `动作 ${o.status}`,
  }

  const orchestrator = new TaskSkillOrchestrator({
    memory: mem,
    worldKey: 'world_emergency_1',
    readSnapshot: () => snap,
    dispatch: dispatcher.dispatch,
    save: () => {},
  })

  // tickOnce 应该自动接管紧急生存，生成 eat 动作
  const res = await orchestrator.tickOnce()
  assert.ok(['survival_in_progress', 'survival_stabilized'].includes(res.status))
  assert.equal(res.task_id, 'emergency:survival_stabilize')
  assert.equal(res.skill_id, 'survival_stabilize')
  assert.equal(actionsDispatched.length, 1)
  assert.equal(actionsDispatched[0].tool, 'eat')
  assert.equal(actionsDispatched[0].args.food, 'berries')
})

test('STOP-01: WorldRuntime.stop 立即清理活动实例与队列，并以短超时下发底层 stop', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()

  let stopCallOpts = null
  const dispatcher = {
    dispatch: async (req) => {
      if (req.tool === 'stop') {
        return { status: 'succeeded', commandId: 'cmd-stop-123' }
      }
      return { status: 'succeeded' }
    },
    describe: () => '已停止',
  }

  const runtime = WorldRuntimeManager.getOrCreate({
    worldKey: 'world_stop_test',
    store,
    dispatcher,
    readSnapshot: () => ({ identity: { worldKey: 'world_stop_test' } }),
    log: () => {},
  })

  // 模拟一个正在运行的任务与技能实例
  runtime.activeTaskId = 'build_first_structure'
  runtime.activeInstanceId = 'inst-active-456'

  const stopResult = await runtime.stop({ timeoutMs: 5000 })
  assert.equal(stopResult.stop_requested, true)
  assert.equal(stopResult.stop_status, 'succeeded')
  assert.equal(stopResult.active_command_id, 'cmd-stop-123')
  assert.equal(stopResult.active_task_id, 'build_first_structure')
  assert.equal(stopResult.active_instance_id, 'inst-active-456')
  assert.equal(stopResult.next_action_allowed, false)

  assert.equal(runtime.activeTaskId, null)
  assert.equal(runtime.activeInstanceId, null)
  assert.equal(runtime.queue.length, 0)
})
