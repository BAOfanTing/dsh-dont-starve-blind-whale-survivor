// M2.0.2：Control Lease + Action Dispatcher（Node 侧）
//
// 纯 Node 单测（假 bridge / 假快照 / 真实临时租约文件），属于 UNIT。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LeaseManager } from '../lib/control.js'
import { createDispatcher, validateArgs, ACTION_SPECS, OPEN_ACTIONS } from '../lib/dispatcher.js'

const ENV = { runtimeId: 'r-test-0001', sessionId: 'sess-A', shardId: '1', actorId: 'player:KU_x' }

function leaseAt(now, ttlMs = 1000) {
  const dir = mkdtempSync(join(tmpdir(), 'bws-m2-disp-'))
  const file = join(dir, 'm2-control.json')
  return {
    c: new LeaseManager({ file, now: () => now.value, ttlMs }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// ─────────────────────────── Lease ───────────────────────────

test('lease-1 首次获取：generation=1 / active', () => {
  const now = { value: 1000 }
  const { c, cleanup } = leaseAt(now)
  try {
    const r = c.acquire('f8_agent', ENV, { ownerInstanceId: 'instance-A' })
    assert.equal(r.ok, true)
    assert.equal(r.lease.generation, 1)
    assert.equal(r.lease.status, 'active')
    assert.equal(c.validate('f8_agent', { ownerInstanceId: 'instance-A', env: ENV }).ok, true)
  } finally { cleanup() }
})

test('lease-2 同一实例再获取 = 续租，世代不变', () => {
  const now = { value: 1000 }
  const { c, cleanup } = leaseAt(now)
  try {
    c.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
    now.value = 1500
    const r = c.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
    assert.equal(r.reason, 'renewed')
    assert.equal(r.lease.generation, 1)
    assert.equal(r.lease.expires_at, 1500 + 1000)
  } finally { cleanup() }
})

test('lease-3 不同实例竞争：明确拒绝或进入 revoking，且原持有者随即失效', () => {
  const now = { value: 1000 }
  const { c, cleanup } = leaseAt(now)
  try {
    c.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
    const r = c.acquire('mcp_client', ENV, { ownerInstanceId: 'B' })
    // 两阶段换手：发布 revoking（不是直接给 active）
    assert.equal(r.lease.status, 'revoking')
    assert.equal(r.lease.generation, 2)
    const check = c.validate('mcp_client', { ownerInstanceId: 'B', env: ENV })
    assert.equal(check.ok, false, 'revoking 期间谁都不能执行动作')
    assert.equal(check.reason, 'authority_revoking')
  } finally { cleanup() }
})

test('lease-4 强制换手（人工接管）：generation +1，旧世代立刻失效', () => {
  const now = { value: 1000 }
  const { c, cleanup } = leaseAt(now)
  try {
    c.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
    const r = c.acquire('manual_test', ENV, { force: true, ownerInstanceId: 'M' })
    assert.equal(r.lease.generation, 2)
    assert.equal(r.lease.status, 'revoking')
    assert.equal(c.validate('f8_agent', { ownerInstanceId: 'A', generation: 1, env: ENV }).ok, false)
  } finally { cleanup() }
})

test('lease-5 续租 / 释放只有同实例能做', () => {
  const now = { value: 1000 }
  const { c, cleanup } = leaseAt(now)
  try {
    c.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
    assert.equal(c.renew('mcp_client', ENV, { ownerInstanceId: 'B' }).reason, 'wrong_owner')
    assert.equal(c.renew('f8_agent', ENV, { ownerInstanceId: 'A' }).ok, true)
    assert.equal(c.release('f8_agent', { ownerInstanceId: 'B' }).reason, 'wrong_owner_instance')
    assert.equal(c.release('f8_agent', { ownerInstanceId: 'A' }).ok, true)
    assert.equal(c.validate('f8_agent', { ownerInstanceId: 'A', env: ENV }).reason, 'stale_lease')
  } finally { cleanup() }
})

test('lease-6 过期：校验失败；再获取时 generation +1', () => {
  const now = { value: 1000 }
  const { c, cleanup } = leaseAt(now)
  try {
    c.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
    now.value = 3000
    assert.equal(c.validate('f8_agent', { ownerInstanceId: 'A', env: ENV }).reason, 'lease_expired')
    const r = c.acquire('mcp_client', ENV, { ownerInstanceId: 'B' })
    assert.equal(r.lease.generation, 2)
  } finally { cleanup() }
})

test('lease-7 环境变化（重启/换世界/换分片/换角色）→ 换代 + revoking', () => {
  for (const patch of [
    { runtimeId: 'r-new-0002' }, { sessionId: 'sess-B' }, { shardId: '2' }, { actorId: 'player:KU_y' },
  ]) {
    const now = { value: 1000 }
    const { c, cleanup } = leaseAt(now)
    try {
      c.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
      const r = c.acquire('f8_agent', { ...ENV, ...patch }, { ownerInstanceId: 'A' })
      assert.equal(r.lease.generation, 2, JSON.stringify(patch))
      assert.equal(r.lease.status, 'revoking')
    } finally { cleanup() }
  }
})

test('lease-8 旧世代校验 → stale_generation', () => {
  const now = { value: 1000 }
  const { c, cleanup } = leaseAt(now)
  try {
    c.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
    c.acquire('mcp_client', ENV, { force: true, ownerInstanceId: 'B' })
    // completeHandover 模拟 Lua 确认
    const fresh = c.readAuthority()
    assert.equal(c.completeHandover({ authority_epoch: fresh.authority_epoch, generation: fresh.generation, runtime_id: fresh.runtime_id, lease_id: fresh.lease_id, job_cleared: true, acked_at: Date.now() }).ok, true)
    const r = c.validate('mcp_client', { ownerInstanceId: 'B', generation: 1, env: ENV })
    assert.equal(r.reason, 'stale_generation')
  } finally { cleanup() }
})

test('lease-9 作废（紧急停止）→ 之后谁都没有权限', () => {
  const now = { value: 1000 }
  const { c, cleanup } = leaseAt(now)
  try {
    c.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
    c.invalidate('emergency')
    assert.equal(c.validate('f8_agent', { ownerInstanceId: 'A', env: ENV }).reason, 'stale_lease')
  } finally { cleanup() }
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
    ...base, ...over,
    actor: { ...base.actor, ...(over.actor ?? {}) },
    identity: { ...base.identity, ...(over.identity ?? {}) },
    nearby: { ...base.nearby, ...(over.nearby ?? {}) },
  }
}

function makeHarness({ snapshots = [snap(), snap({ actor: { tileX: 5, tileZ: 2 } })], bridgeResult = { ok: true, text: '走过去了' }, throwError = null, withLease = true } = {}) {
  const commands = []
  let index = 0
  const bridge = {
    async call(action, args, opts) {
      commands.push({ action, args, envelope: opts?.envelope })
      if (throwError) throw new Error(throwError)
      return bridgeResult
    },
  }
  const dir = mkdtempSync(join(tmpdir(), 'bws-m2-disp-'))
  const file = join(dir, 'm2-control.json')
  const control = new LeaseManager({ file, now: () => Date.now() })
  if (withLease) control.acquire('f8_agent', ENV, { ownerInstanceId: 'instance-A' })
  const dispatcher = createDispatcher({
    bridge, control,
    readSnapshot: () => snapshots[Math.min(index++, snapshots.length - 1)],
    now: () => 1700000000000,
    commandTtlMs: 8000, timeoutMs: 5000,
  })
  return { dispatcher, control, commands, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const dispatch = (h, tool = 'stop', args = {}, owner = 'f8_agent') =>
  h.dispatcher.dispatch({ tool, args, owner, ownerInstanceId: owner === 'mcp_client' ? 'instance-B' : 'instance-A' })

test('dispatcher-1 未开放的动作：拒绝，且不写任何命令', async () => {
  const h = makeHarness()
  try {
    // SURVIVAL-05：container_*/give/cook 已开放；换成仍然**未开放**的
    for (const name of ['build', 'recipes', 'lookup', 'probe', 'pick', 'act']) {
      const r = await dispatch(h, name)
      assert.equal(r.status, 'rejected')
      assert.equal(r.reason, 'action_not_allowed')
    }
    assert.equal(h.commands.length, 0)
  } finally { h.cleanup() }
})

test('dispatcher-2 参数校验：未知字段/NaN/无穷/越界/缺参/非整数 全部拒绝，且不写命令', async () => {
  const h = makeHarness()
  try {
    const bad = [
      [{ x: 1, z: 2, fly: true }, 'unknown_arg:fly'],
      [{ x: Number.NaN, z: 2 }, 'bad_type:x'],
      [{ x: Number.POSITIVE_INFINITY, z: 2 }, 'infinite:x'],
      [{ x: 99999, z: 2 }, 'out_of_range:x'],
      [{ x: 1 }, 'missing_arg:z'],
      [{ x: 1.5, z: 2 }, 'not_integer:x'],
    ]
    for (const [args, reason] of bad) {
      const r = await h.dispatcher.dispatch({ tool: 'move_to', args, owner: 'f8_agent', ownerInstanceId: 'instance-A' })
      assert.equal(r.status, 'rejected', JSON.stringify(args))
      assert.equal(r.reason, reason, JSON.stringify(args))
    }
    assert.equal(h.commands.length, 0)
  } finally { h.cleanup() }
})

test('dispatcher-3 没有控制权：拒绝，且不发命令', async () => {
  const h = makeHarness({ withLease: false })
  try {
    const r = await dispatch(h, 'stop', {}, 'mcp_client')
    assert.equal(r.status, 'rejected')
    assert.equal(r.reason, 'control_denied')
    assert.equal(h.commands.length, 0)
  } finally { h.cleanup() }
})

test('dispatcher-4 快照过期 / 角色异常：拒绝，且不发命令', async () => {
  const stale = makeHarness({ snapshots: [snap({ stale: true })] })
  try {
    // SURVIVAL-01：stale 但还有角色 → 明确报 game_paused（比原来笼统的 game_not_ready 更精确）
    assert.equal((await dispatch(stale)).reason, 'game_paused')
    assert.equal(stale.commands.length, 0)
  } finally { stale.cleanup() }

  for (const [actor, reason] of [
    [{ valid: false }, 'actor_invalid'],
    [{ alive: false }, 'actor_dead'],
    [{ isGhost: true }, 'actor_is_ghost'],
  ]) {
    const h = makeHarness({ snapshots: [snap({ actor })] })
    try {
      const r = await dispatch(h)
      assert.equal(r.reason, reason)
      assert.equal(h.commands.length, 0)
    } finally { h.cleanup() }
  }
})

test('dispatcher-5 正常 move_to：命令信封含全部权威字段（Lua 会用同一套再校验）', async () => {
  const h = makeHarness()
  try {
    const r = await h.dispatcher.dispatch({ tool: 'move_to', args: { x: 5, z: 2 }, owner: 'f8_agent', ownerInstanceId: 'instance-A' })
    assert.equal(r.status, 'succeeded', JSON.stringify(r))
    assert.equal(h.commands.length, 1)
    const env = h.commands[0].envelope
    assert.equal(env.protocol_version, 1)
    assert.match(env.command_id, /^[0-9a-f-]{36}$/)
    assert.equal(env.owner_type, 'f8_agent')
    assert.equal(env.owner_instance_id, 'instance-A')
    assert.equal(env.authority_epoch, h.control.readAuthority().authority_epoch)
    assert.equal(env.lease_id, h.control.readAuthority().lease_id)
    assert.equal(env.lease_generation, 1)
    assert.equal(env.runtime_id, 'r-test-0001')
    assert.equal(env.session_id, 'sess-A')
    assert.equal(env.shard_id, '1')
    assert.equal(env.actor_id, 'player:KU_x')
    assert.ok(env.expires_at > env.created_at)
  } finally { h.cleanup() }
})

test('dispatcher-6 游戏说成功但位置没变 → unverified（不报成功）', async () => {
  const h = makeHarness({ snapshots: [snap(), snap()] })
  try {
    const r = await h.dispatcher.dispatch({ tool: 'move_to', args: { x: 9, z: 9 }, owner: 'f8_agent', ownerInstanceId: 'instance-A' })
    assert.equal(r.status, 'unverified')
  } finally { h.cleanup() }
})

test('dispatcher-7 游戏明确失败 → failed（带原因）', async () => {
  const h = makeHarness({ bridgeResult: { ok: false, text: '走不到 (9,9)', reason: 'cant_reach' } })
  try {
    const r = await dispatch(h)
    assert.equal(r.status, 'failed')
    assert.equal(r.reason, 'cant_reach')
    assert.match(h.dispatcher.describe(r), /失败/)
  } finally { h.cleanup() }
})

test('dispatcher-8 Lua 侧拒绝（旧世代）→ rejected，不重试', async () => {
  const h = makeHarness({ bridgeResult: { ok: false, text: '拒绝：stale_generation', reason: 'stale_generation' } })
  try {
    const r = await dispatch(h)
    assert.equal(r.status, 'rejected')
    assert.equal(r.reason, 'stale_generation')
    assert.equal(h.commands.length, 1)
  } finally { h.cleanup() }
})

test('dispatcher-9 等不到结果（超时）→ unknown，且不自动重试', async () => {
  const h = makeHarness({ throwError: '等了 2 分钟还没做完（游戏里的动作可能还在继续，先 get_state 看看）' })
  try {
    const r = await dispatch(h)
    assert.equal(r.status, 'unknown')
    assert.equal(h.commands.length, 1)
    assert.match(h.dispatcher.describe(r), /先 get_state/)
  } finally { h.cleanup() }
})

test('dispatcher-10 F8 持有租约时，MCP 的请求被拒', async () => {
  const h = makeHarness()
  try {
    const r = await dispatch(h, 'stop', {}, 'mcp_client')
    assert.equal(r.reason, 'control_denied')
    // 另一个进程换手后，F8 立刻失效
    h.control.acquire('mcp_client', ENV, { ownerInstanceId: 'instance-B' })
    const old = await dispatch(h)
    assert.equal(old.reason, 'control_denied')
  } finally { h.cleanup() }
})

test('dispatcher-11 白名单：move_to/stop 是 R1，pickup/harvest 是 R2；规格里有 riskLevel', () => {
  // SURVIVAL-01：新增 gather / eat / craft / equip
  assert.deepEqual(OPEN_ACTIONS.slice().sort(), ['attack', 'chop', 'container_put', 'container_take', 'cook', 'craft', 'dig', 'drop', 'eat', 'equip', 'fuel', 'gather', 'gather_area', 'give', 'hammer', 'harvest', 'inspect', 'kill', 'mine', 'move_to', 'pickup', 'say', 'seek', 'stop', 'unequip', 'use', 'wait'])
  assert.equal(ACTION_SPECS.move_to.riskLevel, 'R1')
  assert.equal(ACTION_SPECS.stop.riskLevel, 'R1')
  assert.equal(ACTION_SPECS.pickup.riskLevel, 'R2')
  assert.equal(ACTION_SPECS.harvest.riskLevel, 'R2')
  assert.equal(ACTION_SPECS.gather.riskLevel, 'R2')
  assert.equal(ACTION_SPECS.eat.riskLevel, 'R1')
  assert.equal(ACTION_SPECS.craft.riskLevel, 'R2')
  assert.equal(ACTION_SPECS.equip.riskLevel, 'R1')
  assert.equal(validateArgs(ACTION_SPECS.stop, {}).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.stop, { x: 1 }).ok, false)
})
