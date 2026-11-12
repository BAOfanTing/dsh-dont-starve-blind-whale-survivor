// M2.0：Control Lease + Action Dispatcher（Node 侧）
//
// 全部是纯 Node 单测（假 bridge / 假快照），属于 UNIT；真机验证见 docs/M2_runtime_manual_checklist.md。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LeaseManager } from '../lib/control.js'
import { createDispatcher, validateArgs, ACTION_SPECS, OPEN_ACTIONS } from '../lib/dispatcher.js'

const ENV = { runtimeId: 'r-test-0001', sessionId: 'sess-A', shardId: '1', actorId: 'player:KU_x' }

const leaseAt = (now) => new LeaseManager({ file: '', now: () => now.value, ttlMs: 1000 })

// ─────────────────────────── Lease ───────────────────────────

test('lease-1 首次获取：generation=1', () => {
  const now = { value: 1000 }
  const c = leaseAt(now)
  const r = c.acquire('f8_agent', ENV)
  assert.equal(r.ok, true)
  assert.equal(r.lease.generation, 1)
  assert.equal(r.reason, 'acquired')
  assert.equal(c.validate('f8_agent', { env: ENV }).ok, true)
})

test('lease-2 同一个 owner 再获取 = 续租，世代不变（否则会废掉自己飞行中的命令）', () => {
  const now = { value: 1000 }
  const c = leaseAt(now)
  c.acquire('f8_agent', ENV)
  now.value = 1500
  const r = c.acquire('f8_agent', ENV)
  assert.equal(r.reason, 'renewed')
  assert.equal(r.lease.generation, 1)
  assert.equal(r.lease.expiresAt, 1500 + 1000)
})

test('lease-3 不同 owner 竞争：明确拒绝并告知持有者', () => {
  const now = { value: 1000 }
  const c = leaseAt(now)
  c.acquire('f8_agent', ENV)
  const r = c.acquire('mcp_client', ENV)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'lease_held')
  assert.equal(r.holder, 'f8_agent')
  // MCP 的校验也必须是失败（不能因为"申请过"就有权限）
  assert.equal(c.validate('mcp_client', { env: ENV }).ok, false)
})

test('lease-4 强制换手（人工接管）：世代 +1，旧世代立刻失效', () => {
  const now = { value: 1000 }
  const c = leaseAt(now)
  c.acquire('f8_agent', ENV)
  const r = c.acquire('manual_test', ENV, { force: true })
  assert.equal(r.ok, true)
  assert.equal(r.lease.generation, 2)
  assert.equal(c.validate('f8_agent', { env: ENV, generation: 1 }).ok, false)
  assert.equal(c.validate('f8_agent', { env: ENV, generation: 1 }).reason, 'not_owner')
  assert.equal(c.validate('manual_test', { env: ENV, generation: 2 }).ok, true)
})

test('lease-5 续租 / 释放只有持有者能做', () => {
  const now = { value: 1000 }
  const c = leaseAt(now)
  c.acquire('f8_agent', ENV)
  assert.equal(c.renew('mcp_client', ENV).reason, 'not_owner')
  assert.equal(c.renew('f8_agent', ENV).ok, true)
  assert.equal(c.release('mcp_client').reason, 'not_owner')
  assert.equal(c.release('f8_agent').ok, true)
  assert.equal(c.validate('f8_agent', { env: ENV }).reason, 'no_lease')
})

test('lease-6 过期：校验失败；再获取时世代 +1', () => {
  const now = { value: 1000 }
  const c = leaseAt(now)
  c.acquire('f8_agent', ENV)
  now.value = 3000 // 超过 ttl
  assert.equal(c.validate('f8_agent', { env: ENV }).reason, 'lease_expired')
  const r = c.acquire('mcp_client', ENV)
  assert.equal(r.ok, true)
  assert.equal(r.lease.generation, 2, '过期后换手也要涨世代')
})

test('lease-7 环境变化（重启/换世界/换角色）→ 旧租约失效、世代 +1', () => {
  const now = { value: 1000 }
  const c = leaseAt(now)
  c.acquire('f8_agent', ENV)
  for (const patch of [
    { runtimeId: 'r-new-0002' },
    { sessionId: 'sess-B' },
    { shardId: '2' },
    { actorId: 'player:KU_y' },
  ]) {
    const fresh = leaseAt(now)
    fresh.acquire('f8_agent', ENV)
    const r = fresh.acquire('f8_agent', { ...ENV, ...patch })
    assert.equal(r.ok, true, JSON.stringify(patch))
    assert.equal(r.lease.generation, 2, '环境变了必须换代')
    assert.equal(r.reason, 'env_changed_reacquired')
  }
})

test('lease-8 旧世代校验 → stale_generation', () => {
  const now = { value: 1000 }
  const c = leaseAt(now)
  c.acquire('f8_agent', ENV)
  c.acquire('mcp_client', ENV, { force: true }) // generation=2
  const r = c.validate('mcp_client', { env: ENV, generation: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'stale_generation')
})

test('lease-9 作废（紧急停止）→ 之后谁都没有权限', () => {
  const now = { value: 1000 }
  const c = leaseAt(now)
  c.acquire('f8_agent', ENV)
  c.invalidate('emergency')
  assert.equal(c.validate('f8_agent', { env: ENV }).reason, 'no_lease')
})

// ─────────────────────────── Dispatcher ───────────────────────────

const snap = (over = {}) => {
  const base = {
    stale: false,
    actor: { actorId: 'player:KU_x', valid: true, alive: true, isGhost: false, tileX: 1, tileZ: 2 },
    identity: { sessionId: 'sess-A', shardId: '1' },
    nearby: { runtime_id: 'r-test-0001', snapshot_id: 'r-test-0001-n3' },
  }
  return {
    ...base,
    ...over,
    actor: { ...base.actor, ...(over.actor ?? {}) },
    identity: { ...base.identity, ...(over.identity ?? {}) },
    nearby: { ...base.nearby, ...(over.nearby ?? {}) },
  }
}

function makeHarness({ snapshots = [snap(), snap({ actor: { tileX: 5, tileZ: 2 } })], bridgeResult = { ok: true, text: '走过去了' }, throwError = null } = {}) {
  const commands = []
  let index = 0
  const bridge = {
    async call(action, args, opts) {
      commands.push({ action, args, envelope: opts?.envelope })
      if (throwError) throw new Error(throwError)
      return bridgeResult
    },
  }
  const control = new LeaseManager({ file: '', now: () => Date.now() })
  control.acquire('f8_agent', ENV)
  const dispatcher = createDispatcher({
    bridge,
    control,
    readSnapshot: () => snapshots[Math.min(index++, snapshots.length - 1)],
    now: () => 1700000000000,
    commandTtlMs: 8000,
    timeoutMs: 5000,
  })
  return { dispatcher, control, commands }
}

test('dispatcher-1 未开放的动作：拒绝，且不写任何命令', async () => {
  const { dispatcher, commands } = makeHarness()
  for (const name of ['chop', 'attack', 'craft', 'gather', 'act']) {
    const r = await dispatcher.dispatch({ tool: name, args: {}, owner: 'f8_agent' })
    assert.equal(r.status, 'rejected')
    assert.equal(r.reason, 'action_not_allowed')
  }
  assert.equal(commands.length, 0)
})

test('dispatcher-2 参数校验：未知字段/NaN/无穷/越界/缺参/非整数 全部拒绝，且不写命令', async () => {
  const { dispatcher, commands } = makeHarness()
  const bad = [
    [{ x: 1, z: 2, fly: true }, 'unknown_arg:fly'],
    [{ x: Number.NaN, z: 2 }, 'bad_type:x'],
    [{ x: Number.POSITIVE_INFINITY, z: 2 }, 'infinite:x'],
    [{ x: 99999, z: 2 }, 'out_of_range:x'],
    [{ x: 1 }, 'missing_arg:z'],
    [{ x: 1.5, z: 2 }, 'not_integer:x'],
  ]
  for (const [args, reason] of bad) {
    const r = await dispatcher.dispatch({ tool: 'move_to', args, owner: 'f8_agent' })
    assert.equal(r.status, 'rejected', JSON.stringify(args))
    assert.equal(r.reason, reason, JSON.stringify(args))
  }
  assert.equal(commands.length, 0)
})

test('dispatcher-3 没有控制权：拒绝，且不发命令', async () => {
  const { dispatcher, commands } = makeHarness()
  const r = await dispatcher.dispatch({ tool: 'stop', args: {}, owner: 'mcp_client' })
  assert.equal(r.status, 'rejected')
  assert.equal(r.reason, 'control_denied')
  assert.equal(commands.length, 0)
})

test('dispatcher-4 快照过期 / 角色异常：拒绝，且不发命令', async () => {
  const stale = makeHarness({ snapshots: [snap({ stale: true })] })
  assert.equal((await stale.dispatcher.dispatch({ tool: 'stop', args: {}, owner: 'f8_agent' })).reason, 'game_not_ready')
  assert.equal(stale.commands.length, 0)

  for (const [actor, reason] of [
    [{ valid: false }, 'actor_invalid'],
    [{ alive: false }, 'actor_dead'],
    [{ isGhost: true }, 'actor_is_ghost'],
  ]) {
    const base = snap()
    const h = makeHarness({ snapshots: [{ ...base, actor: { ...base.actor, ...actor } }] })
    const r = await h.dispatcher.dispatch({ tool: 'stop', args: {}, owner: 'f8_agent' })
    assert.equal(r.reason, reason)
    assert.equal(h.commands.length, 0)
  }
})

test('dispatcher-5 正常 move_to：命令信封字段齐全（Lua 会用同一套再校验一遍）', async () => {
  const { dispatcher, commands } = makeHarness()
  const r = await dispatcher.dispatch({ tool: 'move_to', args: { x: 5, z: 2 }, owner: 'f8_agent' })
  assert.equal(r.status, 'succeeded', JSON.stringify(r))
  assert.equal(commands.length, 1)
  const env = commands[0].envelope
  assert.equal(env.protocol_version, 1)
  assert.match(env.command_id, /^[0-9a-f-]{36}$/)
  assert.equal(env.action, 'move_to')
  assert.equal(env.requested_by, 'f8_agent')
  assert.equal(env.lease_generation, 1)
  assert.equal(env.runtime_id, 'r-test-0001')
  assert.equal(env.session_id, 'sess-A')
  assert.equal(env.shard_id, '1')
  assert.equal(env.actor_id, 'player:KU_x')
  assert.equal(env.snapshot_id, 'r-test-0001-n3')
  assert.ok(env.expires_at > env.created_at, '命令必须有有效期')
})

test('dispatcher-6 游戏说成功但位置没变 → unverified（不报成功）', async () => {
  const { dispatcher } = makeHarness({ snapshots: [snap(), snap()] }) // 前后位置一样
  const r = await dispatcher.dispatch({ tool: 'move_to', args: { x: 9, z: 9 }, owner: 'f8_agent' })
  assert.equal(r.status, 'unverified')
  assert.equal(r.reason, 'position_unchanged')
})

test('dispatcher-7 游戏明确失败 → failed（带原因）', async () => {
  const { dispatcher } = makeHarness({ bridgeResult: { ok: false, text: '走不到 (9,9)', reason: 'cant_reach' } })
  const r = await dispatcher.dispatch({ tool: 'move_to', args: { x: 9, z: 9 }, owner: 'f8_agent' })
  assert.equal(r.status, 'failed')
  assert.equal(r.reason, 'cant_reach')
  assert.match(dispatcher.describe(r), /失败/)
})

test('dispatcher-8 Lua 侧拒绝（旧世代）→ rejected，不重试', async () => {
  const { dispatcher, commands } = makeHarness({ bridgeResult: { ok: false, text: '拒绝：stale_generation', reason: 'stale_generation' } })
  const r = await dispatcher.dispatch({ tool: 'stop', args: {}, owner: 'f8_agent' })
  assert.equal(r.status, 'rejected')
  assert.equal(r.reason, 'stale_generation')
  assert.equal(commands.length, 1, '只发一次，绝不自动重试')
})

test('dispatcher-9 等不到结果（超时）→ unknown，且不自动重试', async () => {
  const { dispatcher, commands } = makeHarness({ throwError: '等了 2 分钟还没做完（游戏里的动作可能还在继续，先 get_state 看看）' })
  const r = await dispatcher.dispatch({ tool: 'move_to', args: { x: 5, z: 2 }, owner: 'f8_agent' })
  assert.equal(r.status, 'unknown')
  assert.equal(r.reason, 'result_timeout')
  assert.equal(commands.length, 1, 'unknown 不能触发自动重试')
  assert.match(dispatcher.describe(r), /先 get_state/)
})

test('dispatcher-10 F8 持有租约时，MCP 的请求被拒；换手后 F8 的旧世代被拒', async () => {
  const { dispatcher, control } = makeHarness()
  assert.equal((await dispatcher.dispatch({ tool: 'stop', args: {}, owner: 'mcp_client' })).reason, 'control_denied')

  control.acquire('mcp_client', ENV, { force: true }) // 人工/换手 → generation 2
  const oldGen = control.validate('f8_agent', { env: ENV, generation: 1 })
  assert.equal(oldGen.ok, false)
  const r = await dispatcher.dispatch({ tool: 'stop', args: {}, owner: 'f8_agent' })
  assert.equal(r.reason, 'control_denied')
})

test('dispatcher-11 白名单只有两个 R1 动作；规格里有 riskLevel', () => {
  assert.deepEqual(OPEN_ACTIONS.sort(), ['move_to', 'stop'])
  for (const name of OPEN_ACTIONS) {
    assert.ok(ACTION_SPECS[name].riskLevel === 'R1', name)
  }
  // validateArgs 本身可单独用
  assert.equal(validateArgs(ACTION_SPECS.stop, {}).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.stop, { x: 1 }).ok, false)
})
