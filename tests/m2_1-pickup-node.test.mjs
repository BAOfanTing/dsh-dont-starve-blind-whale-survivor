// M2.1 Pickup：Node 侧（工具 Schema + Dispatcher + 结果核对）
//
// 证据类型：UNIT（假 bridge + 假快照 + 真实临时租约文件）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LeaseManager } from '../lib/control.js'
import { createDispatcher, validateArgs, ACTION_SPECS, OPEN_ACTIONS } from '../lib/dispatcher.js'
import { TOOLS, ACTION_NAMES } from '../lib/tools.js'

const ENV = { runtimeId: 'r-pick', sessionId: 'sess-P', shardId: '1', actorId: 'player:KU_p' }

const snap = (over = {}) => {
  const base = {
    stale: false,
    actor: { actorId: 'player:KU_p', valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0 },
    identity: { sessionId: 'sess-P', shardId: '1' },
    nearby: {
      runtime_id: 'r-pick',
      snapshot_id: 'r-pick-n7',
      status: 'ok',
      total_found: 3,
      total_returned: 3,
      buckets: {
        threats: [],
        food: [],
        resources: [
          { ref: '#1', prefab: 'twigs', label: '树枝', category: 'resources', distance: 1.2 },
          { ref: '#2', prefab: 'evergreen', label: '常青树', category: 'resources', distance: 2.0 },
        ],
        containers: [], structures: [], creatures: [], other: [],
      },
    },
    player: { inventory: { used: 0, slots: 15, items: [] } },
    ...over,
  }
  return {
    ...base,
    ...over,
    actor: { ...base.actor, ...(over.actor ?? {}) },
    identity: { ...base.identity, ...(over.identity ?? {}) },
    nearby: { ...base.nearby, ...(over.nearby ?? {}), buckets: over.nearby?.buckets ?? base.nearby.buckets },
    player: { ...base.player, ...(over.player ?? {}) },
  }
}

function harness({ snapshots, bridge = {}, withLease = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bws-m21-'))
  const file = join(dir, 'm2-control.json')
  const control = new LeaseManager({ file, now: () => Date.now() })
  if (withLease) control.acquire('f8_agent', ENV, { ownerInstanceId: 'inst-A' })
  let i = 0
  const list = snapshots ?? [snap(), snap({ player: { inventory: { used: 1, slots: 15, items: [{ prefab: 'twigs', count: 1, slot: 1 }] } } })]
  const calls = []
  const d = createDispatcher({
    bridge: { call: async (action, args, opts) => { calls.push({ action, args, envelope: opts?.envelope }); return { ok: true, text: '捡起了 树枝', ...(bridge.result ?? {}) } } },
    control,
    readSnapshot: () => list[Math.min(i++, list.length - 1)],
    now: () => 1700000000000,
    commandTtlMs: 8000,
    timeoutMs: 5000,
  })
  return { d, control, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const run = (h, args, owner = 'f8_agent') =>
  h.d.dispatch({ tool: 'pickup', args, owner, ownerInstanceId: owner === 'mcp_client' ? 'inst-B' : 'inst-A' })

// ─────────────────────────── 1. 工具 Schema ───────────────────────────

test('pickup-1 工具注册：pickup 在工具表里、必填 target_ref + snapshot_id、描述讲清限制', () => {
  assert.ok(OPEN_ACTIONS.includes('pickup'), 'dispatcher 白名单要有 pickup')
  assert.ok(ACTION_NAMES.has('pickup'), 'tools.js 动作集合要有 pickup')
  const tool = TOOLS.find((t) => t.name === 'pickup')
  assert.ok(tool, 'TOOLS 里要有 pickup')
  assert.deepEqual(tool.inputSchema.required, ['target_ref', 'snapshot_id'])
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['snapshot_id', 'target_ref'])
  // 描述必须写清"不许当树/建筑/容器/生物"，否则模型会乱试
  assert.match(tool.description, /树枝|twigs/)
  for (const word of ['树', '建筑', '容器', '生物', 'snapshot_id', 'out_of_range', 'inventory_full']) {
    assert.ok(tool.description.includes(word), `描述里要提到 ${word}`)
  }
  assert.doesNotMatch(tool.description, /拾取附近物品/, '不能写含糊描述')
})

test('pickup-2 参数 Schema：合法通过，缺参/格式错/超长/空串/未知字段/伪造授权字段全拒', () => {
  const spec = ACTION_SPECS.pickup
  assert.equal(validateArgs(spec, { target_ref: '#3', snapshot_id: 'r-pick-n7' }).ok, true)
  const bad = [
    [{ snapshot_id: 'x' }, 'missing_arg:target_ref'],
    [{ target_ref: '#3' }, 'missing_arg:snapshot_id'],
    [{ target_ref: '3', snapshot_id: 'x' }, 'bad_format:target_ref'],
    [{ target_ref: '#abc', snapshot_id: 'x' }, 'bad_format:target_ref'],
    [{ target_ref: '', snapshot_id: 'x' }, 'empty_string:target_ref'],
    [{ target_ref: '#12345', snapshot_id: 'x' }, 'bad_format:target_ref'],
    [{ target_ref: '#3', snapshot_id: 'x'.repeat(65) }, 'too_long:snapshot_id'],
    [{ target_ref: 3, snapshot_id: 'x' }, 'bad_type:target_ref'],
  ]
  for (const [args, reason] of bad) {
    const r = validateArgs(spec, args)
    assert.equal(r.ok, false, JSON.stringify(args))
    assert.equal(r.reason, reason, JSON.stringify(args))
  }
  // 模型塞授权字段 / prefab / 坐标 → 未知参数拒绝
  for (const extra of [{ prefab: 'twigs' }, { x: 1, z: 2 }, { owner_instance_id: 'x' }, { lease_generation: 9 }, { guid: 123 }]) {
    const r = validateArgs(spec, { target_ref: '#3', snapshot_id: 'r-pick-n7', ...extra })
    assert.equal(r.ok, false)
    assert.match(r.reason, /^unknown_arg:/)
  }
})

// ─────────────────────────── 2. 快照 / 租约 ───────────────────────────

test('pickup-3 snapshot_id 不是当前快照 → stale_snapshot，且不写命令', async () => {
  const h = harness({ snapshots: [snap(), snap()] })
  try {
    const r = await run(h, { target_ref: '#1', snapshot_id: 'r-pick-n6' })
    assert.equal(r.status, 'rejected')
    assert.equal(r.reason, 'stale_snapshot')
    assert.equal(h.calls.length, 0, '被拒时不能写命令')
  } finally { h.cleanup() }
})

test('pickup-4 没有控制权 → control_denied，且不写命令', async () => {
  const h = harness({ withLease: false, snapshots: [snap()] })
  try {
    const r = await run(h, { target_ref: '#1', snapshot_id: 'r-pick-n7' }, 'mcp_client')
    assert.equal(r.status, 'rejected')
    assert.equal(r.reason, 'control_denied')
    assert.equal(h.calls.length, 0)
  } finally { h.cleanup() }
})

test('pickup-5 合法请求：信封带 target_ref / snapshot_id / 全部授权字段，且授权字段取自权威租约', async () => {
  const h = harness()
  try {
    const r = await run(h, { target_ref: '#1', snapshot_id: 'r-pick-n7' })
    assert.equal(r.status, 'succeeded', JSON.stringify(r))
    assert.equal(h.calls.length, 1)
    const env = h.calls[0].envelope
    const fresh = h.control.readAuthority()
    assert.equal(env.action, 'pickup')
    assert.equal(env.target_ref, '#1')
    assert.equal(env.snapshot_id, 'r-pick-n7')
    assert.equal(env.owner_type, 'f8_agent')
    assert.equal(env.owner_instance_id, 'inst-A')
    assert.equal(env.authority_epoch, fresh.authority_epoch)
    assert.equal(env.lease_id, fresh.lease_id)
    assert.equal(env.lease_generation, fresh.generation)
    assert.equal(env.actor_id, 'player:KU_p')
    assert.ok(env.expires_at > env.created_at)
  } finally { h.cleanup() }
})

// ─────────────────────────── 3. 结果核对 ───────────────────────────

test('pickup-6 游戏说成功但背包没变化 → unverified（不报成功）', async () => {
  const h = harness({ snapshots: [snap(), snap(), snap(), snap(), snap()] }) // 背包始终是空的
  try {
    const r = await run(h, { target_ref: '#1', snapshot_id: 'r-pick-n7' })
    assert.equal(r.status, 'unverified', JSON.stringify(r))
    assert.equal(r.reason, 'inventory_unchanged')
  } finally { h.cleanup() }
})

test('pickup-7 背包里 twigs 数量增加 → 核对通过', async () => {
  // 先用掉两张（before/after 各自读），再验证 verify 本身
  const spec = ACTION_SPECS.pickup
  const before = snap()
  const after = snap({ player: { inventory: { used: 1, slots: 15, items: [{ prefab: 'twigs', count: 2, slot: 1 }] } } })
  const v = spec.verify(before, after, { target_ref: '#1' })
  assert.equal(v.ok, true)
  assert.equal(v.prefab, 'twigs')
  assert.equal(v.gained, 2)
  // 目标参考不存在时不能假装成功
  assert.equal(spec.verify(before, after, { target_ref: '#9' }).reason, 'unknown_ref')
  // 数量不变 → 不通过
  const same = spec.verify(before, before, { target_ref: '#1' })
  assert.equal(same.ok, false)
  assert.equal(same.reason, 'inventory_unchanged')
})

test('pickup-8 游戏明确拒绝（prefab_not_allowed 等）→ rejected 并保留原因', async () => {
  for (const reason of ['prefab_not_allowed', 'out_of_range', 'inventory_full', 'target_not_pickable', 'stale_generation']) {
    const h = harness({ snapshots: [snap(), snap()], bridge: { result: { ok: false, text: '拒绝：' + reason, reason } } })
    try {
      const r = await run(h, { target_ref: '#2', snapshot_id: 'r-pick-n7' })
      assert.equal(r.status, 'rejected', reason)
      assert.equal(r.reason, reason)
      assert.equal(h.calls.length, 1, '只发一次，不自动重试')
    } finally { h.cleanup() }
  }
})

test('pickup-9 等不到结果 → unknown，不重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-m21-'))
  const file = join(dir, 'm2-control.json')
  const control = new LeaseManager({ file, now: () => Date.now() })
  control.acquire('f8_agent', ENV, { ownerInstanceId: 'inst-A' })
  let calls = 0
  const d = createDispatcher({
    bridge: { call: async () => { calls++; throw new Error('等了 5 分钟还没做完（先 get_state 看看）') } },
    control,
    readSnapshot: () => snap(),
    now: () => 1700000000000,
  })
  try {
    const r = await d.dispatch({ tool: 'pickup', args: { target_ref: '#1', snapshot_id: 'r-pick-n7' }, owner: 'f8_agent', ownerInstanceId: 'inst-A' })
    assert.equal(r.status, 'unknown')
    assert.equal(calls, 1, 'unknown 不能触发自动重试')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pickup-10 move_to / stop 语义未变（仍只按坐标 / 无参数）', () => {
  assert.ok(OPEN_ACTIONS.includes('move_to') && OPEN_ACTIONS.includes('stop'))
  assert.equal(validateArgs(ACTION_SPECS.move_to, { x: 1, z: 2 }).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.move_to, { target_ref: '#1' }).ok, false)
  assert.equal(validateArgs(ACTION_SPECS.stop, {}).ok, true)
  assert.equal(ACTION_SPECS.move_to.requiresSnapshot, undefined, 'move_to 不需要快照')
})
