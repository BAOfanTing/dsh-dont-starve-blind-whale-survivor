// TARGET-REFRESH §2：stale_snapshot 熔断
//
// 真机证据（latestLogs/session.txt #33…#82）：模型连续 23 次用**同一个旧引用** pickup "#1"，
// 只是把 snapshot_id 一路往上猜（n217 → n220 → n226 → … → n420），每次都 stale_snapshot。
//
// 熔断只做一件事：**不再把注定失败的请求发到游戏**，并把替代方案说清楚。
// 它绝不放宽校验、绝不自动 +1、绝不换用"同编号的另一个实体"。
//
// 证据类型：UNIT（Node dispatcher + 假 bridge + 假快照；不碰 Lua、不碰游戏）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LeaseManager } from '../../lib/control.js'
import { createDispatcher } from '../../lib/dispatcher.js'

const ENV = { runtimeId: 'r-stale', sessionId: 'sess-S', shardId: '1', actorId: 'player:KU_s' }
const FIXED_NOW = 1700000000000

/** 一份快照：nearby.snapshot_id 就是模型要填的那个 */
const snap = ({ snapshotId = 'r-stale-n10', runtimeId = 'r-stale', picked = false } = {}) => ({
  stale: false,
  actor: { actorId: 'player:KU_s', valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0 },
  identity: { sessionId: 'sess-S', shardId: '1' },
  nearby: {
    runtime_id: runtimeId,
    snapshot_id: snapshotId,
    status: 'ok',
    total_found: 1,
    total_returned: 1,
    // 捡到手之后：这块燧石从「可拾取」桶里消失（verify 的"目标消失 + 背包 +1"路径）
    buckets: { pickupables: picked ? [] : [{ ref: '#1', prefab: 'flint', distance: 0.5 }] },
  },
  player: {
    inventory: {
      used: picked ? 1 : 0,
      slots: 15,
      items: picked ? [{ prefab: 'flint', count: 1 }] : [],
    },
  },
})

/**
 * 假 dispatcher。
 * ★ 快照必须是**一份当前状态**（而不是"每次调用换一份"）：dispatcher 在一次 dispatch 里会读好几次
 *   （before + verify 轮询），每次都给新快照的话就测不出 stale 了。
 */
function harness({ current = 'r-stale-n10', runtimeId = 'r-stale' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bws-stale-'))
  const control = new LeaseManager({ file: join(dir, 'lease.json'), now: () => Date.now() })
  control.acquire('f8_agent', ENV, { ownerInstanceId: 'inst-A' })
  const calls = []
  const state = { current, runtimeId, picked: false }
  const d = createDispatcher({
    bridge: {
      call: async (action, args, opts) => {
        calls.push({ action, args, envelope: opts?.envelope })
        state.picked = true // 假装游戏真的执行了
        return { ok: true, text: '捡起了 燧石' }
      },
    },
    control,
    readSnapshot: () => snap({ snapshotId: state.current, runtimeId: state.runtimeId, picked: state.picked }),
    now: () => FIXED_NOW,
    commandTtlMs: 8000,
    timeoutMs: 3000,
  })
  return {
    d,
    calls,
    state,
    setCurrent: (id, rt = state.runtimeId) => { state.current = id; state.runtimeId = rt },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const run = (h, args) => h.d.dispatch({ tool: 'pickup', args, owner: 'f8_agent', ownerInstanceId: 'inst-A' })

test('SC-1：第一次 stale_snapshot 返回明确状态，且**一条命令都不发**', async () => {
  const h = harness({ current: 'r-stale-n11' })
  try {
    const r = await run(h, { target_ref: '#1', snapshot_id: 'r-stale-n10' })
    assert.equal(r.status, 'rejected')
    assert.equal(r.reason, 'stale_snapshot')
    assert.equal(h.calls.length, 0, '被拒的请求不该写命令文件')
    // 必须明确告诉模型"不要加 1 / 不要预补偿"，并给出不会过期的替代方案
    assert.match(r.message, /不要.*加 1|不要.*预补偿/)
    assert.match(r.message, /pickup_nearest/, '要给出实时目标选择这条替代路')
    assert.match(r.message, /target_handle/, '要给出稳定句柄这条替代路')
    assert.equal(r.stale?.count, 1)
  } finally { h.cleanup() }
})

test('SC-2：同一个旧引用第二次（哪怕 snapshot_id 被往上猜）→ 熔断，仍然不发命令', async () => {
  const h = harness({ current: 'r-stale-n11' })
  try {
    const first = await run(h, { target_ref: '#1', snapshot_id: 'r-stale-n10' })
    assert.equal(first.reason, 'stale_snapshot')

    // 真机形态：模型不改 target_ref，只把 snapshot_id 往上猜
    h.setCurrent('r-stale-n12')
    const second = await run(h, { target_ref: '#1', snapshot_id: 'r-stale-n11' })
    assert.equal(second.reason, 'stale_snapshot_circuit_open', `实际 ${second.reason}`)
    assert.equal(second.stale?.circuit, 'open')
    assert.equal(second.stale?.count, 2)
    assert.match(second.message, /熔断/)

    h.setCurrent('r-stale-n13')
    const third = await run(h, { target_ref: '#1', snapshot_id: 'r-stale-n12' })
    assert.equal(third.reason, 'stale_snapshot_circuit_open')
    assert.equal(third.stale?.count, 3, '连续失败次数要记下来')
    assert.equal(h.calls.length, 0, '熔断之后一次都不该发到游戏')

    const status = h.d.status()
    assert.ok(Array.isArray(status.stale) && status.stale.length === 1, '熔断状态要能从 status() 看到')
    assert.equal(status.stale[0].count, 3)
  } finally { h.cleanup() }
})

test('SC-3：换了目标引用（#1 → #2）→ 熔断清零，重新按第一次处理', async () => {
  const h = harness({ current: 'r-stale-n11' })
  try {
    await run(h, { target_ref: '#1', snapshot_id: 'r-stale-n10' })
    h.setCurrent('r-stale-n12')
    const opened = await run(h, { target_ref: '#1', snapshot_id: 'r-stale-n11' })
    assert.equal(opened.reason, 'stale_snapshot_circuit_open')

    // 目标引用变了 → 这是"当前目标改变"，熔断清零
    h.setCurrent('r-stale-n13')
    const other = await run(h, { target_ref: '#2', snapshot_id: 'r-stale-n12' })
    assert.equal(other.reason, 'stale_snapshot', `换引用后应该回到普通 stale，实际 ${other.reason}`)
    assert.equal(other.stale?.count, 1)
  } finally { h.cleanup() }
})

test('SC-4：动作成功 → 熔断清零（下一次 stale 从 1 重新数）', async () => {
  const h = harness({ current: 'r-stale-n11' })
  try {
    await run(h, { target_ref: '#1', snapshot_id: 'r-stale-n10' })
    h.setCurrent('r-stale-n12')
    const opened = await run(h, { target_ref: '#1', snapshot_id: 'r-stale-n11' })
    assert.equal(opened.reason, 'stale_snapshot_circuit_open')

    // 模型照做：重新 get_state 拿到 n12 并**原样照抄** → 放行 → 核对通过
    h.setCurrent('r-stale-n12')
    const ok = await run(h, { target_ref: '#1', snapshot_id: 'r-stale-n12' })
    assert.equal(h.calls.length, 1, '引用正确时必须真的发到游戏')
    assert.equal(ok.status, 'succeeded', `实际 ${ok.status}/${ok.reason}`)

    // 成功之后熔断记录被清掉 → 下一次 stale 又是第 1 次
    h.setCurrent('r-stale-n20')
    const after = await run(h, { target_ref: '#1', snapshot_id: 'r-stale-n19' })
    assert.equal(after.reason, 'stale_snapshot', `实际 ${after.reason}`)
    assert.equal(after.stale?.count, 1, '成功之后必须清零')
  } finally { h.cleanup() }
})

test('SC-5：runtime_id 变了（换世界/重载）→ 熔断清零', async () => {
  const h = harness({ current: 'r-stale-n11' })
  try {
    await run(h, { target_ref: '#1', snapshot_id: 'r-stale-n10' })
    h.setCurrent('r-stale-n12')
    const opened = await run(h, { target_ref: '#1', snapshot_id: 'r-stale-n11' })
    assert.equal(opened.reason, 'stale_snapshot_circuit_open')

    // 换世界：runtime 变了
    h.setCurrent('r-other-n1', 'r-other')
    const afterWorld = await run(h, { target_ref: '#1', snapshot_id: 'r-stale-n12' })
    assert.equal(afterWorld.reason, 'stale_snapshot', `换世界后应该重新从 1 数，实际 ${afterWorld.reason}`)
    assert.equal(afterWorld.stale?.count, 1)
  } finally { h.cleanup() }
})

test('SC-6：用 target_handle 时**根本不走快照校验**（所以永远不会有 stale）', async () => {
  const h = harness({ current: 'r-stale-n10' })
  try {
    // 就算塞一个明显过期的 snapshot_id，只要走句柄就不该 stale
    const r = await run(h, { target_handle: 'h1a', snapshot_id: 'r-stale-OLD' })
    assert.notEqual(r.reason, 'stale_snapshot')
    assert.notEqual(r.reason, 'stale_snapshot_circuit_open')
    assert.equal(h.calls.length, 1, '句柄路径必须真的发命令（是否执行由 Lua 的真实实体复检决定）')
    assert.equal(h.calls[0].envelope.args.target_handle, 'h1a')
  } finally { h.cleanup() }
})

test('SC-7：不给任何引用 → 明确报缺参（不能被静默放过）', async () => {
  const h = harness()
  try {
    const r = await run(h, {})
    assert.equal(r.status, 'rejected')
    assert.match(r.reason, /^missing_arg:/)
    assert.equal(h.calls.length, 0)
  } finally { h.cleanup() }
})

test('SC-8：熔断只按 (动作, #N) 记账 —— 别的动作不受牵连', async () => {
  const h = harness({ current: 'r-stale-n11' })
  try {
    await run(h, { target_ref: '#1', snapshot_id: 'r-stale-n10' })
    h.setCurrent('r-stale-n12')
    const opened = await run(h, { target_ref: '#1', snapshot_id: 'r-stale-n11' })
    assert.equal(opened.reason, 'stale_snapshot_circuit_open')

    // 换动作：应该重新从第 1 次开始（不同的 key）
    h.setCurrent('r-stale-n13')
    const chop = await h.d.dispatch({
      tool: 'chop', args: { target_ref: '#1', snapshot_id: 'r-stale-n12' }, owner: 'f8_agent', ownerInstanceId: 'inst-A',
    })
    assert.equal(chop.reason, 'stale_snapshot', `换动作后应重新计数，实际 ${chop.reason}`)
    assert.equal(chop.stale?.count, 1)
  } finally { h.cleanup() }
})
