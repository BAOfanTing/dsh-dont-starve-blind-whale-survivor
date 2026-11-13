// M2.0.2 真机验证（安全：只用 stop；不移动角色、不改世界状态）
// 步骤全部走产品代码：GameBridge + LeaseManager + dispatcher 的 envelope 生成
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { stripKleiHeader, GameBridge } from '../lib/bridge.js'
import { LeaseManager, envFingerprintOf } from '../lib/control.js'
import { normalizeState } from '../lib/state/snapshot.js'
import { createDispatcher } from '../lib/dispatcher.js'

const ROOT = process.cwd()
const bridge = new GameBridge({ log: () => {} })
const state = bridge.readState()
if (!state) { console.log('FAIL: 找不到状态文件'); process.exit(1) }
console.log('状态目录:', state.dir)
console.log('mod:', state.json.mod, '| ready:', state.json.ready, '| players:', state.json.data?.players)

const snapshot = normalizeState(state.json, { ageMs: state.ageMs })
const env = envFingerprintOf(snapshot)
console.log('env:', JSON.stringify(env))
console.log('actor:', JSON.stringify({ actorId: snapshot.actor?.actorId, valid: snapshot.actor?.valid, alive: snapshot.actor?.alive, isGhost: snapshot.actor?.isGhost, tileX: snapshot.actor?.tileX, tileZ: snapshot.actor?.tileZ }))

const dirs = bridge.leaseDirs()
console.log('leaseDirs:', JSON.stringify(dirs.map((d) => d.dir)))

const leaseFile = `${ROOT}/.runtime/m2-control.json`
// 清掉上一轮残留的确认文件（否则 completeHandover 会读到旧 epoch 的 ack）
for (const { dir } of dirs) {
  for (const name of ['whale_lease_ack.json', 'whale_io_lease_ack.json']) {
    try { unlinkSync(`${dir}/${name}`) } catch {}
  }
}
const control = new LeaseManager({ file: leaseFile, authorityDirs: () => dirs, now: () => Date.now() })

/** 发一条命令并等结果；返回 {ok, text, reason, id} */
async function send(label, envelopeOverride, args = {}) {
  const id = `m202-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const envelope = {
    protocol_version: 1,
    command_id: id,
    action: 'stop',
    args,
    requested_by: 'manual_test',
    ...(envelopeOverride ?? {}),
  }
  const text = JSON.stringify({ v: 1, id, action: 'stop', args, ts: Date.now(), ...envelope })
  // 清掉两个通道的旧命令文件，避免 poll_command 反复读到上一条
  for (const { dir } of bridge.commandDirs()) {
    for (const name of ['whale_cmd.json', 'whale_io_cmd.json']) {
      try { unlinkSync(`${dir}/${name}`) } catch {}
    }
  }
  // 直接用产品的写命令通道
  const wrote = bridge.writeToAll((channel) => (channel === 'io' ? 'whale_io_cmd.json' : 'whale_cmd.json'), text, bridge.commandDirs())
  console.log(`[${label}] 写入 ${wrote} 个目录，id=${id}`)
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    for (const { dir, channel } of bridge.commandDirs()) {
      const p = `${dir}/${channel === 'io' ? 'whale_io_result.json' : 'whale_result.json'}`
      if (!existsSync(p)) continue
      try {
        const r = JSON.parse(stripKleiHeader(readFileSync(p, 'utf8')))
        if (String(r.id) === id) return { ...r, label }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return { label, ok: null, reason: 'timeout', text: '15 秒内没等到结果' }
}

/** 记录角色坐标（从最新状态文件） */
function actorPos() {
  const s = bridge.readState()
  if (!s) return null
  const n = normalizeState(s.json, { ageMs: s.ageMs })
  return { tileX: n.actor?.tileX, tileZ: n.actor?.tileZ }
}

const results = []
const before = actorPos()

// ── 1) 目前没有权威文件：旧格式命令必须 fail-closed ──
results.push(await send('T1 无权威文件（旧格式命令）', { lease_generation: 1 }))

// ── 2) 用产品 LeaseManager 发布 active 租约 ──
const acq = control.acquire('manual_test', env, { ownerInstanceId: 'm202-runtime-probe' })
console.log('[发布] acquire:', acq.reason, 'gen=', acq.lease?.generation, 'status=', acq.lease?.status)
const fresh = control.readAuthority()
console.log('[发布] 权威文件:', JSON.stringify({
  epoch: fresh.authority_epoch, gen: fresh.generation, owner: fresh.owner_type,
  instance: fresh.owner_instance_id, lease_id: fresh.lease_id, status: fresh.status,
}))
const okEnvelope = {
  owner_type: fresh.owner_type,
  owner_instance_id: fresh.owner_instance_id,
  authority_epoch: fresh.authority_epoch,
  lease_id: fresh.lease_id,
  lease_generation: fresh.generation,
  lease_expires_at: fresh.expires_at,
  runtime_id: env.runtimeId,
  session_id: env.sessionId,
  shard_id: env.shardId,
  actor_id: env.actorId,
  snapshot_id: snapshot.nearby?.snapshot_id ?? null,
  created_at: Date.now(),
  expires_at: Date.now() + 8000,
}

// ── 3) 合法命令（stop，安全）→ 应被接受 ──
results.push(await send('T2 合法命令（active）', okEnvelope))

// ── 4) 旧 generation → stale_generation ──
results.push(await send('T3 旧 generation', { ...okEnvelope, lease_generation: fresh.generation - 1, created_at: Date.now(), expires_at: Date.now() + 8000 }))

// ── 5) 伪造未来 generation → future_generation ──
results.push(await send('T4 伪造 gen=999', { ...okEnvelope, lease_generation: 999, created_at: Date.now(), expires_at: Date.now() + 8000 }))

// ── 6) 错误 owner_instance_id → wrong_instance ──
results.push(await send('T5 错误实例', { ...okEnvelope, owner_instance_id: 'someone-else', created_at: Date.now(), expires_at: Date.now() + 8000 }))

// ── 7) 换手：发布 revoking（另一个实例）→ 所有命令拒绝 ──
const handover = control.acquire('mcp_client', env, { ownerInstanceId: 'm202-other-process', force: true })
console.log('[换手] acquire:', handover.reason, 'gen=', handover.lease?.generation, 'status=', handover.lease?.status)
results.push(await send('T6 revoking 期间旧命令', okEnvelope))
// Lua 应该写 ack 文件
const ack = bridge.readLeaseAck()
console.log('[换手] Lua 确认:', ack ? JSON.stringify(ack) : '（还没读到）')

// ── 8) 完成换手后：旧持有者的命令必拒 ──
if (ack) {
  const done = control.completeHandover(ack)
  console.log('[换手] completeHandover:', done.reason, 'status=', done.lease?.status)
}
results.push(await send('T7 换手后旧持有者命令', okEnvelope))

// ── 9) 删除权威文件 → fail-closed ──
for (const { dir } of dirs) {
  for (const name of ['whale_io_lease.json', 'whale_lease.json']) {
    try { unlinkSync(`${dir}/${name}`) } catch {}
  }
}
try { unlinkSync(leaseFile) } catch {}
console.log('[删除] 权威文件已移除，等 6 秒让 Lua 的 ps 缓存过期（AUTHORITY_CACHE_MAX_AGE=5）')
await new Promise((r) => setTimeout(r, 6000))
results.push(await send('T8 权威文件缺失', okEnvelope))

const after = actorPos()
console.log('\n=== 结果汇总 ===')
for (const r of results) console.log(`${r.label}: ok=${r.ok} reason=${r.reason ?? '-'} text=${String(r.text ?? '').slice(0, 90)}`)
console.log('角色坐标 before/after:', JSON.stringify(before), JSON.stringify(after))
console.log('坐标是否变化:', JSON.stringify(before) !== JSON.stringify(after))
