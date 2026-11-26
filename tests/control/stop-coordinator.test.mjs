// R8.0 StopCoordinator（P1）：纯协调层单元测试。
// 只验证状态机 / 幂等合并 / 超时隔离 / 不伪造成功 / 不提前释放 Lease —— 不涉及真实 Runtime 或游戏。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { StopCoordinator, StopPhase } from '../../lib/control/stop-coordinator.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const authority = (generation, extra = {}) => ({
  generation,
  owner_type: 'f8_agent',
  owner_instance_id: 'inst-A',
  authority_epoch: `epoch-${generation}`,
  lease_id: `lease-${generation}`,
  ...extra,
})

test('ST-03：多个入口并发停止 → 只跑一次，所有调用方拿到同一个结果', async () => {
  let stopCalls = 0
  let leaseRelease = 0
  const co = new StopCoordinator({
    readAuthority: () => authority(7),
    runtimeStop: async () => { stopCalls++; await sleep(30); return { status: 'succeeded', lock_released: true, command_id: 'cmd-1' } },
    releaseLease: async () => { leaseRelease++ },
    defaultTimeoutMs: 2000,
  })

  const [a, b, c] = await Promise.all([
    co.requestStop({ source: 'f8' }),
    co.requestStop({ source: 'mcp' }),
    co.requestStop({ source: 'toggle.stop' }),
  ])
  assert.equal(stopCalls, 1, '并发停止只能真正执行一次')
  assert.equal(leaseRelease, 1, '确认停止后才释放一次 Lease')
  assert.equal(a, b, '同一停止过程 → 同一个结果对象')
  assert.equal(a, c, '同一停止过程 → 同一个结果对象')
  assert.equal(a.status, 'stopped')
  assert.equal(a.ok, true)
  assert.equal(a.generation, 7)
  assert.equal(a.quarantined, false)
  assert.equal(a.next_action_allowed, true)
})

test('ST-04：Lua/运行时一直不返回 → 超时进入隔离，绝不伪造成功，绝不释放 Lease', async () => {
  let leaseRelease = 0
  const co = new StopCoordinator({
    readAuthority: () => authority(1),
    runtimeStop: () => new Promise(() => {}), // 永不结束（模拟无 ACK / 卡住）
    releaseLease: async () => { leaseRelease++ },
    defaultTimeoutMs: 80,
  })

  const t0 = Date.now()
  const r = await co.requestStop({ source: 'mcp' })
  assert.ok(Date.now() - t0 < 2000, '必须有界超时，不能挂死')
  assert.equal(r.status, 'unknown')
  assert.equal(r.ok, false, '超时不能当作成功')
  assert.equal(r.quarantined, true)
  assert.equal(r.next_action_allowed, false)
  assert.equal(leaseRelease, 0, '未确认停止 → 禁止释放 Lease')
  assert.equal(co.isQuarantined(), true)
  assert.equal(co.canAcceptNewWork(), false, '隔离中禁止新任务')
})

test('ST-04b：stop 报成功但 Runtime 锁没释放 → 仍是 unknown + 隔离（不提前放行）', async () => {
  let leaseRelease = 0
  const co = new StopCoordinator({
    readAuthority: () => authority(2),
    runtimeStop: async () => ({ status: 'succeeded', lock_released: false, command_id: 'cmd-x' }),
    releaseLease: async () => { leaseRelease++ },
    defaultTimeoutMs: 1000,
  })
  const r = await co.requestStop({ source: 'f8' })
  assert.equal(r.status, 'unknown')
  assert.equal(r.quarantined, true)
  assert.equal(leaseRelease, 0, '锁未释放不算安全交接')
})

test('ST-09：已完成 → 重复 stop 幂等（不再执行）；新世代 → 重新执行', async () => {
  let gen = 1
  let stopCalls = 0
  const co = new StopCoordinator({
    readAuthority: () => authority(gen),
    runtimeStop: async () => { stopCalls++; return { status: 'succeeded', lock_released: true, command_id: `cmd-${gen}` } },
    releaseLease: async () => {},
    defaultTimeoutMs: 1000,
  })
  const r1 = await co.requestStop({ source: 'f8' })
  assert.equal(r1.status, 'stopped')
  assert.equal(stopCalls, 1)

  const r2 = await co.requestStop({ source: 'mcp' })
  assert.equal(r2, r1, '同一世代重复 stop 直接返回上次结果，不重复执行')
  assert.equal(stopCalls, 1)

  gen = 2
  const r3 = await co.requestStop({ source: 'mcp' })
  assert.equal(stopCalls, 2, '新世代应重新走一次停止')
  assert.notEqual(r3, r1)
  assert.equal(r3.generation, 2)
})

test('ST-04c：隔离只能由「锁真实释放」解除（tryRecover）', async () => {
  let released = false
  const co = new StopCoordinator({
    readAuthority: () => authority(3),
    runtimeStop: () => new Promise(() => {}),
    isLockReleased: () => released,
    releaseLease: async () => {},
    defaultTimeoutMs: 60,
  })
  const r = await co.requestStop({ source: 'mcp' })
  assert.equal(r.quarantined, true)

  const rec1 = co.tryRecover()
  assert.equal(rec1.recovered, false)
  assert.equal(rec1.reason, 'lock_still_held')
  assert.equal(co.isQuarantined(), true)

  released = true
  const rec2 = co.tryRecover()
  assert.equal(rec2.recovered, true)
  assert.equal(co.isQuarantined(), false)
  assert.equal(co.canAcceptNewWork(), true)
})

test('Reflex 拒绝（cancelled）→ 明确返回 refused：不伪造成功、不隔离、不放租约', async () => {
  let leaseRelease = 0
  const co = new StopCoordinator({
    readAuthority: () => authority(4),
    runtimeStop: async () => ({ status: 'cancelled', reason: 'reflex_active', command_id: 'cmd-r' }),
    releaseLease: async () => { leaseRelease++ },
    defaultTimeoutMs: 1000,
  })
  const r = await co.requestStop({ source: 'f8' })
  assert.equal(r.status, 'refused')
  assert.equal(r.ok, false)
  assert.equal(r.quarantined, false)
  assert.equal(leaseRelease, 0)
  assert.equal(co.canAcceptNewWork(), true, 'Reflex 拒绝不是隔离，不是停止成功')
})

test('基础状态机：初始 idle / stopping 判定 / getStatus 形状', () => {
  const co = new StopCoordinator()
  assert.equal(co.phase, StopPhase.IDLE)
  assert.equal(co.isStopping(), false)
  assert.equal(co.canAcceptNewWork(), true)
  const s = co.getStatus()
  assert.equal(s.phase, 'idle')
  assert.equal(s.quarantined, false)
  assert.equal(typeof s.diagnostics, 'object')
})

test('隔离中再次停止：仍会停 Agent（修复 F8 停不下来）', async () => {
  let agentStops = 0
  let released = false
  const co = new StopCoordinator({
    readAuthority: () => ({ generation: 9 }),
    getAgent: () => ({ stop: () => { agentStops++ }, waitIdle: async () => true }),
    getRuntime: () => ({}),
    runtimeStop: () => new Promise(() => {}), // 首次永不确认 → 隔离
    releaseLease: async () => {},
    isLockReleased: () => released,
    defaultTimeoutMs: 50,
  })
  const r1 = await co.requestStop({ source: 'f8' })
  assert.equal(r1.quarantined, true)
  const before = agentStops
  const r2 = await co.requestStop({ source: 'f8' })
  assert.ok(agentStops > before, '隔离中再次 stop 仍必须调用 Agent.stop（不能 no-op）')
  assert.equal(r2.quarantined, true)
})

test('隔离中若旧执行链已释放锁 → 再次停止自动解除隔离并完成', async () => {
  let released = false
  let calls = 0
  const co = new StopCoordinator({
    readAuthority: () => ({ generation: 10 }),
    getAgent: () => ({ stop: () => {}, waitIdle: async () => true }),
    getRuntime: () => ({}),
    runtimeStop: () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve({ status: 'succeeded', lock_released: true, command_id: 'c2' })),
    releaseLease: async () => {},
    isLockReleased: () => released,
    defaultTimeoutMs: 50,
  })
  const r1 = await co.requestStop({ source: 'f8' })
  assert.equal(r1.quarantined, true)
  released = true // 旧执行链已退出
  const r2 = await co.requestStop({ source: 'f8' })
  assert.notEqual(r2.quarantined, true, '锁释放后应解除隔离')
  assert.equal(co.isQuarantined(), false)
})
