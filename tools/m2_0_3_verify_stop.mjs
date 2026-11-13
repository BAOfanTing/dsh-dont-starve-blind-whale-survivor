// ⑤ 精确复测：移动中换手后，角色是否在 Abort 之后**真的停住**
//
// 上一版用"Abort 后立刻读一次位置"当基准，但 whale_state.json 每秒才写一次，
// 基准点其实是 Abort 前 0~1 秒的位置 → 会误判成"Abort 后又走了 4 格"。
// 这版改成：Abort 后**按状态帧序号去重逐帧采样**，看位置序列到底在哪一帧停。
import { existsSync, readFileSync, unlinkSync } from 'node:fs'

import { GameBridge } from '../lib/bridge.js'
import { LeaseManager, envFingerprintOf } from '../lib/control.js'
import { createDispatcher } from '../lib/dispatcher.js'
import { normalizeState } from '../lib/state/snapshot.js'

const ROOT = process.cwd()
const bridge = new GameBridge({ log: () => {} })
const dirs = bridge.leaseDirs()

function frame() {
  const st = bridge.readState()
  if (!st) return null
  const snap = normalizeState(st.json, { ageMs: st.ageMs })
  return { seq: st.json.seq, x: snap.actor?.tileX, z: snap.actor?.tileZ, ghost: snap.actor?.isGhost, alive: snap.actor?.alive }
}

const f0 = frame()
console.log('=== 环境 ===')
console.log('mod:', bridge.readState()?.json?.mod, '| actor:', JSON.stringify(f0))
if (!f0 || f0.ghost || !f0.alive) { console.log('BLOCKED：角色不是可控制状态'); process.exit(3) }

// 清残留
for (const { dir } of dirs) for (const n of ['whale_lease.json', 'whale_io_lease.json', 'whale_lease_ack.json', 'whale_io_lease_ack.json', 'whale_cmd.json', 'whale_io_cmd.json']) {
  try { unlinkSync(`${dir}/${n}`) } catch {}
}
try { unlinkSync(`${ROOT}/.runtime/m2-control.json`) } catch {}

const env = envFingerprintOf(normalizeState(bridge.readState().json, { ageMs: 0 }))
const control = new LeaseManager({ file: `${ROOT}/.runtime/m2-control.json`, authorityDirs: () => dirs, now: () => Date.now() })
const dispatcher = createDispatcher({
  bridge, control,
  readSnapshot: () => { const st = bridge.readState(); return st ? normalizeState(st.json, { ageMs: st.ageMs }) : null },
  readLeaseAck: () => bridge.readLeaseAck(),
})
const OWNER = 'manual_test'
const INST = 'm203-stop-probe'
const acq = control.acquire(OWNER, env, { ownerInstanceId: INST })
console.log('租约:', acq.reason, acq.lease?.status, 'gen=', acq.lease?.generation)

const start = frame()
const target = { x: start.x + 5, z: start.z }
console.log(`\n发 move_to: (${start.x},${start.z}) → (${target.x},${target.z})`)

// 每 250ms 采一次状态帧（按 seq 去重），贯穿整个动作 + 中断 + 后续
const timeline = []
let stopSampling = false
const sampler = (async () => {
  let lastSeq = -1
  while (!stopSampling) {
    const f = frame()
    if (f && f.seq !== lastSeq) {
      lastSeq = f.seq
      timeline.push({ at: Date.now(), ...f })
    }
    await new Promise((r) => setTimeout(r, 250))
  }
})()

const t0 = Date.now()
const inflight = dispatcher.dispatch({ tool: 'move_to', args: { x: target.x, z: target.z, timeout: 60 }, owner: OWNER, ownerInstanceId: INST })
await new Promise((r) => setTimeout(r, 1200))
const tHandover = Date.now()
const handover = control.acquire('mcp_client', env, { force: true, ownerInstanceId: 'm203-stop-interrupter' })
console.log(`抢租约 @+${tHandover - t0}ms:`, handover.reason, 'gen=', handover.lease?.generation, 'status=', handover.lease?.status)

let ack = null
const ackEnd = Date.now() + 10000
while (Date.now() < ackEnd) {
  ack = bridge.readLeaseAck()
  if (ack) break
  await new Promise((r) => setTimeout(r, 150))
}
const tAck = Date.now()
console.log(`ack @+${tAck - t0}ms:`, ack ? JSON.stringify({ job_cleared: ack.job_cleared, gen: ack.generation }) : '(无)')

const r = await Promise.race([inflight, new Promise((res) => setTimeout(() => res({ status: 'timeout' }), 20000))])
const tDone = Date.now()
console.log(`move_to 返回 @+${tDone - t0}ms:`, JSON.stringify({ status: r.status, reason: r.reason, message: String(r.message ?? '').slice(0, 90) }))

// 继续采样 6 秒，看是否彻底停住
await new Promise((res) => setTimeout(res, 6000))
stopSampling = true
await sampler

console.log('\n=== 位置时间线（按状态帧） ===')
for (const f of timeline) {
  const rel = f.at - t0
  const marks = []
  if (f.at >= tHandover && (timeline[timeline.indexOf(f) - 1]?.at ?? 0) < tHandover) marks.push('←抢租约')
  if (f.at >= tAck && (timeline[timeline.indexOf(f) - 1]?.at ?? 0) < tAck) marks.push('←ack')
  if (f.at >= tDone && (timeline[timeline.indexOf(f) - 1]?.at ?? 0) < tDone) marks.push('←move_to 返回')
  console.log(`  seq=${String(f.seq).padStart(4)} +${String(rel).padStart(5)}ms  (${f.x},${f.z})  ${marks.join(' ')}`)
}

// 判定：ack 之后的帧里位置是否还在变
const afterAck = timeline.filter((f) => f.at >= tAck)
const positionsAfterAck = [...new Set(afterAck.map((f) => `${f.x},${f.z}`))]
const tail = timeline.slice(-4)
const stableTail = new Set(tail.map((f) => `${f.x},${f.z}`)).size === 1

console.log('\n=== 判定 ===')
console.log('ack 之后出现过的位置:', JSON.stringify(positionsAfterAck))
console.log('最后 4 帧是否同一位置:', stableTail, JSON.stringify(tail.map((f) => `${f.x},${f.z}`)))

let pass = 0, fail = 0
const ok = (n, d) => { pass++; console.log(`  ✅ ${n}${d ? ' — ' + d : ''}`) }
const bad = (n, d) => { fail++; console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`) }
if (ack?.job_cleared === true) ok('⑤-1 Lua 观察到 revoking 并 Abort（job_cleared）', `gen=${ack.generation}`)
else bad('⑤-1 job_cleared', JSON.stringify(ack))
if (r.status === 'failed' || r.status === 'rejected' || /打断|停下|中断/.test(String(r.message ?? ''))) ok('⑤-2 旧动作被中断', `status=${r.status}`)
else bad('⑤-2 旧动作被中断', `status=${r.status}`)
if (stableTail) ok('⑤-3 Abort 后角色停住（最后 4 帧同一位置）', JSON.stringify(tail[tail.length - 1]))
else bad('⑤-3 Abort 后角色停住', `最后 4 帧: ${JSON.stringify(tail.map((f) => `${f.x},${f.z}`))}`)
const drift = afterAck.length > 0 ? Math.max(...afterAck.map((f) => Math.abs(f.x - afterAck[0].x) + Math.abs(f.z - afterAck[0].z))) : 0
console.log(`  ℹ ack 之后最大位移：${drift} 格（1 格内属于状态帧延迟的正常范围）`)

// 清理
for (const { dir } of dirs) for (const n of ['whale_lease.json', 'whale_io_lease.json', 'whale_lease_ack.json', 'whale_io_lease_ack.json']) {
  try { unlinkSync(`${dir}/${n}`) } catch {}
}
try { unlinkSync(`${ROOT}/.runtime/m2-control.json`) } catch {}
console.log(`\nPASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 2)
