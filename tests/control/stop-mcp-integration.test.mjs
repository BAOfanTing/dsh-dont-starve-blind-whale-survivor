// R8.0 P4：stop-mcp-integration —— DSH/MCP 在 F8 持租约运行中发 stop 的协调契约（ST-02）。
// 这是 StopCoordinator 层的集成契约测试：验证「以持有者身份下发 stop、先停 Agent、确认后才释放租约、
// 且绝不先 acquire 抢租约」。真正的 index.js 插件装配较难单测，这里锁住协调器与各依赖的调用顺序/身份契约。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { StopCoordinator } from '../../lib/control/stop-coordinator.js'

test('ST-02：F8 持租约运行中，DSH 发 stop → 以持有者身份下发、先停 Agent、确认后才释放租约、不抢租约', async () => {
  const holder = { owner_type: 'f8_agent', owner_instance_id: 'instA', generation: 5, authority_epoch: 'e', lease_id: 'l' }
  const calls = []
  let optsSeen = null
  let releasedHolder = null
  let agentStopped = 0

  const control = {
    readAuthority: () => holder,
    acquire: () => { throw new Error('stop 绝不能先 acquire 抢租约（会导致与 F8 死等）') },
  }

  const co = new StopCoordinator({
    control,
    // 协调器直接用 readAuthority（不走 control.acquire）
    readAuthority: () => holder,
    getAgent: () => ({
      stop: (reason) => { agentStopped++; calls.push('agent.stop:' + reason) },
      waitIdle: async () => true,
    }),
    getRuntime: () => ({}),
    runtimeStop: (opts) => {
      calls.push('runtime.stop')
      optsSeen = opts
      return Promise.resolve({ status: 'succeeded', lock_released: true, command_id: 'cmd-stop-x', detail: '已停止' })
    },
    releaseLease: async ({ holder: h }) => { releasedHolder = h; calls.push('releaseLease') },
    isLockReleased: () => true,
    defaultTimeoutMs: 1000,
  })

  const r = await co.requestStop({ source: 'mcp_stop', requester: 'mcp_client', reason: 'DSH stop' })

  assert.equal(r.status, 'stopped')
  assert.equal(r.ok, true)
  assert.equal(r.generation, 5)
  // 顺序：先停 Agent，再下发 runtime stop
  assert.equal(agentStopped, 1, '必须先停 Agent')
  assert.ok(calls.indexOf('agent.stop:DSH stop') < calls.indexOf('runtime.stop'), '顺序：先停 Agent 再 runtime.stop')
  // 身份：用持有者 f8_agent，而不是 mcp_client
  assert.equal(optsSeen.owner, 'f8_agent', 'stop 必须以租约持有者身份下发')
  assert.equal(optsSeen.ownerInstanceId, 'instA')
  // 确认后才释放租约，且释放的是持有者
  assert.ok(calls.indexOf('runtime.stop') < calls.indexOf('releaseLease'), '先确认停止再释放租约')
  assert.equal(releasedHolder.owner, 'f8_agent')
})

test('ST-02b：stop 未确认（超时）时，绝不释放租约', async () => {
  const holder = { owner_type: 'f8_agent', owner_instance_id: 'instA', generation: 6 }
  let released = 0
  const co = new StopCoordinator({
    readAuthority: () => holder,
    getAgent: () => ({ stop: () => {}, waitIdle: async () => true }),
    getRuntime: () => ({}),
    runtimeStop: () => new Promise(() => {}), // 永不确认
    releaseLease: async () => { released++ },
    isLockReleased: () => false,
    defaultTimeoutMs: 60,
  })
  const r = await co.requestStop({ source: 'mcp_stop', requester: 'mcp_client' })
  assert.equal(r.status, 'unknown')
  assert.equal(r.quarantined, true)
  assert.equal(released, 0, '未确认停止 → 绝不释放租约')
})
