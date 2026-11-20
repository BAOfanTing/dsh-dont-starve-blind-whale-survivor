// runtime-control-ownership.test.mjs
// Phase R.7.3: 复合执行链控制权身份透传测试

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WorldRuntimeManager } from '../lib/planner/world-runtime-manager.js'
import { createWorldMemoryStore } from '../lib/planner/world-memory.js'
import { executeTool } from '../lib/tools.js'
import { LeaseManager } from '../lib/control.js'

function makeMockState(worldKey = 'world-test-1') {
  return {
    data: {
      schema: 'bws.state/1',
      identity: {
        world_key: worldKey,
        session_id: 'sess-1',
        runtime_id: 'r-test',
        shard_id: '1',
      },
      actor: {
        actor_id: 'player:KU_test',
        valid: true,
        alive: true,
        is_ghost: false,
        x: 0,
        z: 0,
        tile_x: 0,
        tile_z: 0,
        prefab: 'wilson',
      },
      player: {
        health: { percent: 100 },
        hunger: { percent: 100 },
        sanity: { percent: 100 },
        in_light: true,
        inventory: { items: [{ prefab: 'axe', count: 1 }] },
      },
      nearby: {
        runtime_id: 'r-test',
        snapshot_id: 'r100',
        buckets: {
          resources: [
            { prefab: 'evergreen', x: 2, z: 2, work_action: 'CHOP', target_handle: 'h_tree_1' },
          ],
          harvestables: [],
          pickupables: [],
          structures: [],
        },
      },
      world: { phase: 'day' },
      reflex: { active: false },
    },
  }
}

function makeMockBridge(worldKey = 'world-test-1', calls = []) {
  return {
    readState: () => ({ json: makeMockState(worldKey), dir: 'mock', channel: 'io', ageMs: 100 }),
    status: () => ({ connected: true }),
    call: async (tool, args, opts) => {
      calls.push({ tool, args, ...opts })
      return { ok: true, text: 'done' }
    },
  }
}

function makeControlFor(owner, ownerInstanceId) {
  const tempDir = mkdtempSync(join(tmpdir(), 'bws-lease-'))
  const leaseFile = join(tempDir, 'lease.json')
  const control = new LeaseManager({ file: leaseFile })
  const env = { runtimeId: 'r-test', sessionId: 'sess-1', shardId: '1', actorId: 'player:KU_test' }
  control.acquire(owner, env, { ownerInstanceId })
  return control
}

test('OWNERSHIP-01: run_skill 透传 owner 和 ownerInstanceId 到 Dispatcher 与 Bridge 信封', async () => {
  const bridgeCalls = []
  const worldKey = 'world-test-ownership-1'
  WorldRuntimeManager.clear(worldKey)

  const tempDir = mkdtempSync(join(tmpdir(), 'bws-mem-'))
  const memoryStore = createWorldMemoryStore({ dir: join(tempDir, 'mem') })
  const control = makeControlFor('mcp_client', 'inst-mcp-999')
  const bridge = makeMockBridge(worldKey, bridgeCalls)

  const ctx = {
    owner: 'mcp_client',
    ownerInstanceId: 'inst-mcp-999',
    executionMode: 'assisted',
    control,
    planner: { store: memoryStore, memoryFor: () => memoryStore.load(worldKey) },
    bridge,
  }

  const res = await executeTool('run_skill', { skill_id: 'gather_resources', max_steps: 1 }, ctx)
  assert.ok(bridgeCalls.length >= 1, `Bridge 应当接收到下发的原子动作命令，实际输出: ${res}`)
  const call = bridgeCalls[0]
  assert.ok(call.envelope, '下发命令必须包含控制权信封')
  assert.equal(call.envelope.requested_by, 'mcp_client', '信封 requested_by 必须为 mcp_client')
  assert.equal(call.envelope.owner_type, 'mcp_client', '信封 owner_type 必须为 mcp_client')
  assert.equal(call.envelope.owner_instance_id, 'inst-mcp-999', '信封 owner_instance_id 必须为 inst-mcp-999')
})

test('OWNERSHIP-02: advance_task (Autopilot) 透传 owner 和 ownerInstanceId 到 Dispatcher 与 Bridge 信封', async () => {
  const bridgeCalls = []
  const worldKey = 'world-test-ownership-2'
  WorldRuntimeManager.clear(worldKey)

  const tempDir = mkdtempSync(join(tmpdir(), 'bws-mem-'))
  const memoryStore = createWorldMemoryStore({ dir: join(tempDir, 'mem') })
  const control = makeControlFor('mcp_client', 'inst-mcp-888')
  const bridge = makeMockBridge(worldKey, bridgeCalls)

  const mem = memoryStore.load(worldKey)
  mem.task_board = {
    tasks: [
      {
        id: 'task-test-gather',
        title: '采集资源',
        skill_id: 'gather_resources',
        status: 'ready',
        target: { type: 'inventory', prefab: 'log', count: 2 },
        priority: 1,
        attempts: 0,
        cooldown_until: 0,
      },
    ],
  }
  memoryStore.save(mem)

  const ctx = {
    owner: 'mcp_client',
    ownerInstanceId: 'inst-mcp-888',
    executionMode: 'autopilot',
    control,
    planner: { store: memoryStore, memoryFor: () => memoryStore.load(worldKey) },
    bridge,
  }

  const rep = await executeTool('advance_task', { max_steps: 1 }, ctx)
  assert.ok(bridgeCalls.length >= 1, `Bridge 应当接收到动作，实际结果: ${rep}`)
  const call = bridgeCalls[0]
  assert.ok(call.envelope, '下发命令必须包含控制权信封')
  assert.equal(call.envelope.requested_by, 'mcp_client', 'advance_task 下发必须保留 mcp_client')
  assert.equal(call.envelope.owner_type, 'mcp_client', 'advance_task 租约拥有者必须为 mcp_client')
  assert.equal(call.envelope.owner_instance_id, 'inst-mcp-888', 'advance_task 实例标识必须为 inst-mcp-888')
})

test('OWNERSHIP-03: F8 内置 AI 调用复合技能携带 f8_agent 身份', async () => {
  const bridgeCalls = []
  const worldKey = 'world-test-ownership-3'
  WorldRuntimeManager.clear(worldKey)

  const tempDir = mkdtempSync(join(tmpdir(), 'bws-mem-'))
  const memoryStore = createWorldMemoryStore({ dir: join(tempDir, 'mem') })
  const control = makeControlFor('f8_agent', 'inst-f8-777')
  const bridge = makeMockBridge(worldKey, bridgeCalls)

  const ctx = {
    owner: 'f8_agent',
    ownerInstanceId: 'inst-f8-777',
    executionMode: 'assisted',
    control,
    planner: { store: memoryStore, memoryFor: () => memoryStore.load(worldKey) },
    bridge,
  }

  const res = await executeTool('run_skill', { skill_id: 'gather_resources', max_steps: 1 }, ctx)
  assert.ok(bridgeCalls.length >= 1, `Bridge 应当收到 F8 动作，实际输出: ${res}`)
  const call = bridgeCalls[0]
  assert.ok(call.envelope, '信封必须存在')
  assert.equal(call.envelope.requested_by, 'f8_agent', 'F8 调用 requested_by 必须传递 f8_agent')
  assert.equal(call.envelope.owner_type, 'f8_agent', 'F8 调用 owner_type 必须传递 f8_agent')
  assert.equal(call.envelope.owner_instance_id, 'inst-f8-777', 'F8 调用 owner_instance_id 必须传递 inst-f8-777')
})

test('OWNERSHIP-04: 同一 WorldRuntime 连续不同调用者不串用身份且不残留', async () => {
  const dispatched = []
  const mockDispatcher = {
    specs: {},
    describe: () => 'ok',
    dispatch: async (req) => {
      dispatched.push({ ...req })
      return { status: 'succeeded', commandId: 'cmd-test', verified: true }
    },
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'bws-mem-'))
  const memoryStore = createWorldMemoryStore({ dir: join(tempDir, 'mem') })
  const worldKey = 'world-test-ownership-4'
  WorldRuntimeManager.clear(worldKey)

  const runtime = WorldRuntimeManager.getOrCreate({
    worldKey,
    store: memoryStore,
    dispatcher: mockDispatcher,
    readSnapshot: () => makeMockState(worldKey).data,
    guardBuild: () => null,
  })

  // 第一轮：MCP client
  await runtime.executeTask('gather_resources', 'task-1', null, {
    owner: 'mcp_client',
    ownerInstanceId: 'inst-mcp-1',
  })

  // 第二轮：F8 agent
  await runtime.executeTask('gather_resources', 'task-2', null, {
    owner: 'f8_agent',
    ownerInstanceId: 'inst-f8-2',
  })

  // 第三轮：system fallback
  await runtime.executeTask('gather_resources', 'task-3', null, {})

  assert.equal(dispatched.length, 3)
  assert.equal(dispatched[0].owner, 'mcp_client')
  assert.equal(dispatched[0].ownerInstanceId, 'inst-mcp-1')

  assert.equal(dispatched[1].owner, 'f8_agent')
  assert.equal(dispatched[1].ownerInstanceId, 'inst-f8-2')

  assert.equal(dispatched[2].owner, 'system')
  assert.equal(dispatched[2].ownerInstanceId, null)
})

test('OWNERSHIP-05: 两个相同 worldKey 的并发排队调用保持各自所有权身份', async () => {
  const dispatched = []
  const mockDispatcher = {
    specs: {},
    describe: () => 'ok',
    dispatch: async (req) => {
      await new Promise((r) => setTimeout(r, 20))
      dispatched.push({ ...req })
      return { status: 'succeeded', commandId: 'cmd-queued', verified: true }
    },
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'bws-mem-'))
  const memoryStore = createWorldMemoryStore({ dir: join(tempDir, 'mem') })
  const worldKey = 'world-test-ownership-5'
  WorldRuntimeManager.clear(worldKey)

  const runtime = WorldRuntimeManager.getOrCreate({
    worldKey,
    store: memoryStore,
    dispatcher: mockDispatcher,
    readSnapshot: () => makeMockState(worldKey).data,
    guardBuild: () => null,
  })

  // 并发触发两个任务
  const p1 = runtime.executeTask('gather_resources', 'task-p1', null, {
    owner: 'mcp_client',
    ownerInstanceId: 'inst-mcp-p1',
  })

  const p2 = runtime.executeTask('gather_resources', 'task-p2', null, {
    owner: 'f8_agent',
    ownerInstanceId: 'inst-f8-p2',
  })

  await Promise.all([p1, p2])

  assert.equal(dispatched.length, 2)
  assert.equal(dispatched[0].owner, 'mcp_client')
  assert.equal(dispatched[0].ownerInstanceId, 'inst-mcp-p1')
  assert.equal(dispatched[1].owner, 'f8_agent')
  assert.equal(dispatched[1].ownerInstanceId, 'inst-f8-p2')
})
