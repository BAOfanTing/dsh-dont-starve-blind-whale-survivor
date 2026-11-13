// M2.0.3 真机验证 ④⑤（需要角色**活着**）
//  ④ move_to 真实执行与核对（短距离，验证位置变化 + dispatcher 核对）
//  ⑤ 运行中移动动作的换手中断（移动途中抢租约 → Lua 应 Abort、角色停下、旧动作不再继续）
//
// 用法：node tools/m2_0_3_verify_move.mjs
// 前置：游戏在跑、玩家**活着**（非 ghost）、当前分片有 leaseDirs。
import { existsSync, readFileSync, unlinkSync } from 'node:fs'

import { GameBridge } from '../lib/bridge.js'
import { LeaseManager, envFingerprintOf } from '../lib/control.js'
import { createDispatcher } from '../lib/dispatcher.js'
import { normalizeState } from '../lib/state/snapshot.js'

const ROOT = process.cwd()
const HEADER = 'KLEI     1 '
const bridge = new GameBridge({ log: () => {} })
const dirs = bridge.leaseDirs()

function snapNow() {
  const st = bridge.readState()
  if (!st) return null
  return { st, snap: normalizeState(st.json, { ageMs: st.ageMs }) }
}

function posOf(snap) {
  return { x: snap?.actor?.tileX, z: snap?.actor?.tileZ }
}

const results = []
const ok = (n, d) => { results.push({ n, pass: true, d }); console.log(`  ✅ ${n}${d ? ' — ' + d : ''}`) }
const bad = (n, d) => { results.push({ n, pass: false, d }); console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`) }

const first = snapNow()
if (!first) { console.log('FAIL 读不到状态'); process.exit(1) }
const env = envFingerprintOf(first.snap)
console.log('=== 环境 ===')
console.log('mod:', first.st.json.mod, '| players:', first.st.json.data?.players, '| ready:', first.st.json.ready)
console.log('actor:', JSON.stringify({ id: first.snap.actor?.actorId, valid: first.snap.actor?.valid, alive: first.snap.actor?.alive, ghost: first.snap.actor?.isGhost, type: first.st.json.data?.actor?.actor_type }))
console.log('位置:', JSON.stringify(posOf(first.snap)))

if (first.snap.actor?.isGhost === true) {
  console.log('\nBLOCKED：角色是灵魂（playerghost），动作会被正确拒绝。请先复活/重开一局。')
  process.exit(3)
}
if (first.snap.actor?.alive !== true) {
  console.log('\nBLOCKED：角色已死亡。请先复活/重开一局。')
  process.exit(3)
}

// 清残留
for (const { dir } of dirs) for (const n of ['whale_lease.json', 'whale_io_lease.json', 'whale_lease_ack.json', 'whale_io_lease_ack.json', 'whale_cmd.json', 'whale_io_cmd.json']) {
  try { unlinkSync(`${dir}/${n}`) } catch {}
}
try { unlinkSync(`${ROOT}/.runtime/m2-control.json`) } catch {}

const control = new LeaseManager({ file: `${ROOT}/.runtime/m2-control.json`, authorityDirs: () => dirs, now: () => Date.now() })
const dispatcher = createDispatcher({
  bridge,
  control,
  readSnapshot: () => snapNow()?.snap ?? null,
  readLeaseAck: () => bridge.readLeaseAck(),
  commandTtlMs: 8000,
  timeoutMs: 60000,
})

const OWNER = 'manual_test'
const INST = 'm203-move-probe'
const acq = control.acquire(OWNER, env, { ownerInstanceId: INST })
console.log('\n租约:', acq.reason, 'status=', acq.lease?.status, 'gen=', acq.lease?.generation)
if (acq.lease?.status === 'revoking') {
  const ack = bridge.readLeaseAck()
  if (ack) control.completeHandover(ack)
}

// ═══════════ ④ move_to 真实执行 ═══════════
console.log('\n=== ④ move_to 真实执行与核对 ===')
const before = posOf(snapNow().snap)
// 目标：水平方向 2 格（短距离，避开危险区）
const tx = before.x + 2
const tz = before.z
console.log('起点:', JSON.stringify(before), '→ 目标:', tx, tz)
const r4 = await dispatcher.dispatch({ tool: 'move_to', args: { x: tx, z: tz, timeout: 20 }, owner: OWNER, ownerInstanceId: INST })
console.log('  dispatch:', JSON.stringify({ status: r4.status, reason: r4.reason, message: String(r4.message ?? '').slice(0, 80) }))
// 等状态文件刷新到新位置
const deadline = Date.now() + 8000
let after = before
while (Date.now() < deadline) {
  const s = snapNow()
  after = posOf(s.snap)
  if (after.x !== before.x || after.z !== before.z) break
  await new Promise((r) => setTimeout(r, 300))
}
const moved = after.x !== before.x || after.z !== before.z
const reached = Math.abs(after.x - tx) <= 1 && Math.abs(after.z - tz) <= 1
if (r4.status === 'succeeded' && moved) ok('④-1 move_to 成功且位置真的变了', `${JSON.stringify(before)} → ${JSON.stringify(after)}`)
else if (moved && r4.status !== 'succeeded') bad('④-1 move_to 结果与实际不一致', `status=${r4.status} 但位置变了 ${JSON.stringify(after)}`)
else bad('④-1 move_to 成功且位置真的变了', `status=${r4.status} reason=${r4.reason} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
if (reached) ok('④-2 到达目标 1 格内', `目标 ${tx},${tz} 实际 ${JSON.stringify(after)}`)
else console.log(`  ℹ 未精确到达（可接受：走路被打断/绕路），实际 ${JSON.stringify(after)}`)

// ═══════════ ⑤ 移动中换手 ═══════════
console.log('\n=== ⑤ 运行中移动动作的换手中断 ===')
const startPos = posOf(snapNow().snap)
// 发一个较远的目标（10 格），让动作持续一段时间
const far = { x: startPos.x + 10, z: startPos.z }
console.log('发远距离 move_to:', JSON.stringify(startPos), '→', far.x, far.z)
const inflight = dispatcher.dispatch({ tool: 'move_to', args: { x: far.x, z: far.z, timeout: 60 }, owner: OWNER, ownerInstanceId: INST })
// 1.5 秒后（角色应该正在走）抢租约 → 触发 revoking
await new Promise((r) => setTimeout(r, 1500))
const midPos = posOf(snapNow().snap)
const handover = control.acquire('mcp_client', env, { force: true, ownerInstanceId: 'm203-interrupter' })
console.log('  抢租约:', handover.reason, 'gen=', handover.lease?.generation, 'status=', handover.lease?.status)
console.log('  移动中位置:', JSON.stringify(midPos))
// 等 Lua 观察到 revoking 并 Abort
const ackDeadline = Date.now() + 10000
let ack = null
while (Date.now() < ackDeadline) {
  ack = bridge.readLeaseAck()
  if (ack) break
  await new Promise((r) => setTimeout(r, 200))
}
console.log('  ack:', ack ? JSON.stringify({ job_cleared: ack.job_cleared, gen: ack.generation }) : '(无)')
// 动作应该被中断返回（ok=false「被打断」或 unknown）
const r5 = await Promise.race([inflight, new Promise((r) => setTimeout(() => r({ status: 'timeout', reason: 'still-running' }), 15000))])
console.log('  move_to 结果:', JSON.stringify({ status: r5.status, reason: r5.reason, message: String(r5.message ?? '').slice(0, 100) }))
// 再等 3 秒，确认角色停下（位置不再变化）
const p1 = posOf(snapNow().snap)
await new Promise((r) => setTimeout(r, 3000))
const p2 = posOf(snapNow().snap)
const stopped = p1.x === p2.x && p1.z === p2.z
if (ack && ack.job_cleared === true) ok('⑤-1 Lua 观察到 revoking 并 Abort（job_cleared）', `gen=${ack.generation}`)
else if (ack) bad('⑤-1 job_cleared 不是 true', JSON.stringify(ack))
else bad('⑤-1 Lua 写换手确认', '没读到 ack')
if (r5.status === 'failed' || r5.status === 'rejected' || r5.status === 'unknown' || /打断|停下|中断/.test(String(r5.message ?? ''))) ok('⑤-2 旧动作被中断（没有继续跑完）', `status=${r5.status} reason=${r5.reason}`)
else bad('⑤-2 旧动作被中断', `status=${r5.status}（若 succeeded 说明换手没能打断移动）`)
if (stopped) ok('⑤-3 角色停住（3 秒内位置不变）', JSON.stringify(p2))
else bad('⑤-3 角色停住', `${JSON.stringify(p1)} → ${JSON.stringify(p2)}`)

// 清理
for (const { dir } of dirs) for (const n of ['whale_lease.json', 'whale_io_lease.json', 'whale_lease_ack.json', 'whale_io_lease_ack.json']) {
  try { unlinkSync(`${dir}/${n}`) } catch {}
}
try { unlinkSync(`${ROOT}/.runtime/m2-control.json`) } catch {}

console.log('\n=== 汇总 ===')
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? '  |  ' + r.d : ''}`)
const failed = results.filter((r) => !r.pass).length
console.log(`\n共 ${results.length} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 2)
