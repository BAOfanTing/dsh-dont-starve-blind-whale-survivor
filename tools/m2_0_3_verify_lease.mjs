// M2.0.3 真机验证 ①②③（按用户列的待验证项）
//  ① 实际 0.14.3 是否加载 —— 用**行为证据**（不是 modinfo 字符串）
//  ② ACK 清理状态 —— 残留/删除后 fail-closed/新确认可收敛
//  ③ 权威副本冲突保护 —— 多目录副本被篡改时 Lua 是否误信
//
// 只用 stop，不移动角色。所有写盘都走与产品一致的路径/编码（persist 带 KLEI 头、io 纯 JSON）。
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'

import { GameBridge } from '../lib/bridge.js'
import { LEASE_SCHEMA, LeaseManager, envFingerprintOf } from '../lib/control.js'
import { normalizeState } from '../lib/state/snapshot.js'

const HEADER = 'KLEI     1 '
const bridge = new GameBridge({ log: () => {} })
const st = bridge.readState()
if (!st) { console.log('FAIL 读不到状态文件'); process.exit(1) }
const snap = normalizeState(st.json, { ageMs: st.ageMs })
const env = envFingerprintOf(snap)
const dirs = bridge.leaseDirs()
const saveDir = dirs.find((d) => d.channel === 'persist')?.dir ?? dirs[0].dir
const ioDirs = dirs.filter((d) => d.channel === 'io').map((d) => d.dir)
const authorityFile = `${process.cwd()}/.runtime/m2-control.json`

console.log('=== 环境 ===')
console.log('状态目录:', st.dir, '| mod:', st.json.mod, '| players:', st.json.data?.players, '| ready:', st.json.ready)
console.log('actor:', JSON.stringify({ id: snap.actor?.actorId, valid: snap.actor?.valid, alive: snap.actor?.alive, ghost: snap.actor?.isGhost, x: snap.actor?.tileX, z: snap.actor?.tileZ }))
console.log('env:', JSON.stringify(env))
console.log('saveDir:', saveDir)
console.log('ioDirs:', JSON.stringify(ioDirs))

const results = []
const ok = (name, detail) => { results.push({ name, pass: true, detail }); console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`) }
const bad = (name, detail) => { results.push({ name, pass: false, detail }); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`) }

function rm(p) { try { unlinkSync(p) } catch {} }
function cleanAll() {
  for (const d of dirs) for (const n of ['whale_lease.json', 'whale_io_lease.json', 'whale_lease_ack.json', 'whale_io_lease_ack.json']) rm(`${d.dir}/${n}`)
  rm(authorityFile)
}
/** 与产品一致地写一份权威到所有副本 */
function publishAuthority(record) {
  const text = JSON.stringify(record)
  writeFileSync(`${saveDir}/whale_io_lease.json`, text, 'utf8')
  writeFileSync(`${saveDir}/whale_lease.json`, HEADER + text, 'utf8')
  for (const d of ioDirs) {
    writeFileSync(`${d}/whale_io_lease.json`, text, 'utf8')
    writeFileSync(`${d}/whale_lease.json`, text, 'utf8')
  }
}
function readAck() { return bridge.readLeaseAck() }
async function waitFor(fn, ms = 8000, step = 200) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, step))
  }
  return null
}

/** 发一条 stop 命令（清旧命令再写，避免重放干扰），等结果 */
async function sendStop(envelope, label) {
  const id = `m203-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const cmd = {
    v: 1, id, action: 'stop', args: {}, ts: Date.now(),
    protocol_version: 1, command_id: id, action_name: undefined,
    ...envelope,
  }
  delete cmd.action_name
  const text = JSON.stringify(cmd)
  for (const { dir } of bridge.commandDirs()) {
    rm(`${dir}/whale_cmd.json`)
    rm(`${dir}/whale_io_cmd.json`)
  }
  // persist 通道带 KLEI 头（Lua 用 ps_read 读它）
  for (const { dir, channel } of bridge.commandDirs()) {
    writeFileSync(`${dir}/${channel === 'io' ? 'whale_io_cmd.json' : 'whale_cmd.json'}`, channel === 'io' ? text : HEADER + text, 'utf8')
  }
  const got = await waitFor(() => {
    for (const { dir, channel } of bridge.commandDirs()) {
      const p = `${dir}/${channel === 'io' ? 'whale_io_result.json' : 'whale_result.json'}`
      if (!existsSync(p)) continue
      try {
        const r = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF?KLEI\s+\d+\s*/, ''))
        if (String(r.id) === id) return r
      } catch {}
    }
    return null
  }, 15000)
  console.log(`  [${label}] id=${id} → ${got ? `ok=${got.ok} reason=${got.reason ?? '-'} text=${String(got.text ?? '').slice(0, 40)}` : '(无回执)'}`)
  return got
}

// ═══════════════════════ ① 0.14.3 是否真的加载 ═══════════════════════
console.log('\n=== ① 0.14.3 加载（行为证据） ===')
cleanAll()
const c1 = new LeaseManager({ file: authorityFile, authorityDirs: () => dirs, now: () => Date.now() })
const r1 = c1.acquire('manual_test', env, { ownerInstanceId: 'm203-probe' })
const A = c1.readAuthority()
console.log('  权威:', JSON.stringify({ status: A.status, gen: A.generation, epoch: A.authority_epoch.slice(0, 8), lease: A.lease_id.slice(0, 8) }))
const envelope = {
  owner_type: A.owner_type,
  owner_instance_id: A.owner_instance_id,
  authority_epoch: A.authority_epoch,
  lease_id: A.lease_id,
  lease_generation: A.generation,
  lease_expires_at: A.expires_at,
  runtime_id: env.runtimeId,
  session_id: env.sessionId,
  shard_id: env.shardId,
  actor_id: env.actorId,
  created_at: Date.now(),
  expires_at: Date.now() + 8000,
}

// 证据 1：同一条命令被反复轮询读取，0.14.3 有 last_cmd_id 单槽去重 → 结果不会被 duplicate_command 覆盖
const first = await sendStop(envelope, '①-1 合法命令')
if (first?.ok === true) {
  const resPath = `${bridge.commandDirs()[0].dir}/whale_result.json`
  const before = statSync(resPath).mtimeMs
  const beforeText = readFileSync(resPath, 'utf8')
  await new Promise((r) => setTimeout(r, 3000)) // Lua 每 0.3s 重读同一文件
  const afterText = readFileSync(resPath, 'utf8')
  const after = statSync(resPath).mtimeMs
  if (afterText === beforeText && after === before) ok('①-1 命令单槽去重（0.14.3 专属）', '3 秒内同一命令未被重复处理')
  else bad('①-1 命令单槽去重（0.14.3 专属）', `结果被覆盖：before=${beforeText.slice(0, 60)} after=${afterText.slice(0, 60)}`)
} else {
  bad('①-1 合法命令未成功', JSON.stringify(first))
}

// 证据 2：ack 去重键带 epoch（0.14.3 专属）——同一 generation、不同 epoch 必须写新 ack
console.log('  证据 2：ack 去重键是否带 epoch')
const handover = c1.acquire('mcp_client', env, { force: true, ownerInstanceId: 'm203-other' })
console.log('  换手:', handover.reason, 'gen=', handover.lease?.generation, 'status=', handover.lease?.status)
const ack1 = await waitFor(() => readAck(), 8000)
if (!ack1) bad('①-2 ack 生成', '没读到 ack')
else {
  console.log('  ack1:', JSON.stringify({ epoch: String(ack1.authority_epoch).slice(0, 8), gen: ack1.generation, acked_at: ack1.acked_at, lease: String(ack1.lease_id).slice(0, 8) }))
  // 用**同一 generation**但新 epoch 重发权威 → 0.14.3 应写新 ack，0.14.2 会因 generation 相同而跳过
  const cur = c1.readAuthority()
  const forged = { ...cur, authority_epoch: 'epoch-probe-2', lease_id: 'lease-probe-2', status: 'revoking' }
  publishAuthority(forged)
  const ack2 = await waitFor(() => {
    const a = readAck()
    return a && a.authority_epoch === 'epoch-probe-2' ? a : null
  }, 8000)
  if (ack2) ok('①-2 ack 去重键带 epoch（0.14.3 专属）', `同 generation(${ack2.generation}) 新 epoch 写入了新确认`)
  else bad('①-2 ack 去重键带 epoch（0.14.3 专属）', '同 generation 换 epoch 后没有新 ack（说明是 0.14.2 的 generation 去重）')

  // 证据 3：acked_at 是否为正常墙钟毫秒（诊断项）
  const t = Number(ack1.acked_at)
  if (Number.isFinite(t) && t > 1e12) ok('①-3 acked_at 正常毫秒', String(t))
  else bad('①-3 acked_at 正常毫秒', `值=${t}（32 位整数溢出；仅诊断字段，Node 不校验）`)
}

// ═══════════════════════ ② ACK 清理状态 ═══════════════════════
console.log('\n=== ② ACK 清理状态 ===')
// 重新做一次干净换手，拿到有效 ack
cleanAll()
const c2 = new LeaseManager({ file: authorityFile, authorityDirs: () => dirs, now: () => Date.now() })
c2.acquire('manual_test', env, { ownerInstanceId: 'probe-A' })
c2.acquire('mcp_client', env, { force: true, ownerInstanceId: 'probe-B' })
const goodAck = await waitFor(() => readAck(), 8000)
const pending = c2.readAuthority()
console.log('  待确认租约:', JSON.stringify({ status: pending?.status, gen: pending?.generation }))

// 2-a 读到有效 ack → 能完成换手
if (goodAck) {
  const done = c2.completeHandover({ authority_epoch: goodAck.authority_epoch, generation: goodAck.generation, runtime_id: goodAck.runtime_id, lease_id: goodAck.lease_id })
  if (done.ok && done.lease?.status === 'active') ok('②-1 有效 ack → active', `gen=${done.lease.generation}`)
  else bad('②-1 有效 ack → active', JSON.stringify(done))
} else bad('②-1 有效 ack → active', '没读到 ack')

// 2-b 再换手 + 清除 ack → 必须保持 revoking（fail-closed），动作被拒
const h2 = c2.acquire('manual_test', env, { force: true, ownerInstanceId: 'probe-C' })
const statusBeforeClean = c2.readAuthority()?.status
for (const { dir } of dirs) { rm(`${dir}/whale_lease_ack.json`); rm(`${dir}/whale_io_lease_ack.json`) }
await new Promise((r) => setTimeout(r, 700)) // 给 Lua 一点时间（它会重新写 ack）
// 反复删 + 立刻判定：只要没有有效 ack 就不能 active
const cand = readAck()
const cleared = cand === null
const attempt = c2.completeHandover(cand)
const afterStatus = c2.readAuthority()?.status
if (cleared && !attempt.ok && afterStatus === 'revoking') ok('②-2 ack 被清 → 保持 revoking', `换手前状态=${statusBeforeClean}，completeHandover=${attempt.reason}`)
else if (!cleared) {
  // Lua 抢在我们前面重写了 ack —— 也算正确（它会持续补写）
  ok('②-2 ack 被清后 Lua 立即补写', `读回 epoch=${String(cand.authority_epoch).slice(0, 8)} gen=${cand.generation}`)
} else bad('②-2 ack 被清 → 保持 revoking', `status=${afterStatus} reason=${attempt.reason}`)

// 2-c 陈旧 ack（错 epoch / 错 lease_id / 错 runtime）都不能完成换手
const cur2 = c2.readAuthority()
const staleCases = [
  ['错 epoch', { authority_epoch: 'stale-epoch', generation: cur2.generation, runtime_id: cur2.runtime_id, lease_id: cur2.lease_id }],
  ['错 lease_id', { authority_epoch: cur2.authority_epoch, generation: cur2.generation, runtime_id: cur2.runtime_id, lease_id: 'stale-lease' }],
  ['错 runtime', { authority_epoch: cur2.authority_epoch, generation: cur2.generation, runtime_id: 'r-old', lease_id: cur2.lease_id }],
  ['错 generation', { authority_epoch: cur2.authority_epoch, generation: cur2.generation + 5, runtime_id: cur2.runtime_id, lease_id: cur2.lease_id }],
]
let staleAllRejected = true
for (const [name, ack] of staleCases) {
  const r = c2.completeHandover(ack)
  if (r.ok) { staleAllRejected = false; bad(`②-3 陈旧 ack 被拒（${name}）`, '竟然通过了') }
}
if (staleAllRejected) ok('②-3 陈旧 ack 全部被拒', '错 epoch/lease_id/runtime/generation 各 1 例')

// 2-d 清理后动作必须被拒（Lua 看不到 active 权威就不放行）
const fenced = await sendStop({ ...envelope, lease_generation: c2.readAuthority()?.generation, created_at: Date.now(), expires_at: Date.now() + 8000 }, '②-4 清理后发命令')
if (fenced && fenced.ok === false && ['authority_revoking', 'stale_generation', 'authority_unavailable', 'stale_lease'].includes(fenced.reason)) {
  ok('②-4 清理后动作被拒', `reason=${fenced.reason}`)
} else bad('②-4 清理后动作被拒', JSON.stringify(fenced))

// ═══════════════════════ ③ 权威副本冲突保护 ═══════════════════════
console.log('\n=== ③ 权威副本冲突保护 ===')
cleanAll()
const c3 = new LeaseManager({ file: authorityFile, authorityDirs: () => dirs, now: () => Date.now() })
c3.acquire('manual_test', env, { ownerInstanceId: 'probe-3' })
const base = c3.readAuthority()
// 3-a 六个副本内容一致（gen/epoch/lease_id）
const copies = []
for (const { dir } of dirs) for (const n of ['whale_lease.json', 'whale_io_lease.json']) {
  const p = `${dir}/${n}`
  if (!existsSync(p)) { copies.push({ p, exists: false }); continue }
  const a = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF?KLEI\s+\d+\s*/, ''))
  copies.push({ p, exists: true, gen: a.generation, epoch: a.authority_epoch, lease: a.lease_id })
}
const allSame = copies.every((c) => c.exists && c.gen === base.generation && c.epoch === base.authority_epoch)
if (allSame) ok('③-1 所有副本一致', `${copies.length} 份 gen=${base.generation}`)
else bad('③-1 所有副本一致', JSON.stringify(copies))

// 3-b 篡改 io 目录副本（bin64），save 目录保持真实权威 → Lua 必须仍按 save 的权威判定
const env3 = { ...envelope, authority_epoch: base.authority_epoch, lease_id: base.lease_id, lease_generation: base.generation, owner_type: base.owner_type, owner_instance_id: base.owner_instance_id, lease_expires_at: base.expires_at, created_at: Date.now(), expires_at: Date.now() + 8000 }
const good = await sendStop(env3, '③-2 篡改前（应成功）')
for (const d of ioDirs) {
  const forged = { ...base, generation: 999, lease_id: 'forged-lease', authority_epoch: 'forged-epoch', owner_instance_id: 'forged-owner' }
  writeFileSync(`${d}/whale_lease.json`, JSON.stringify(forged), 'utf8')
  writeFileSync(`${d}/whale_io_lease.json`, JSON.stringify(forged), 'utf8')
}
const afterTamper = await sendStop(env3, '③-3 篡改 bin64 副本后（应仍成功）')
if (good?.ok === true && afterTamper?.ok === true) ok('③-2 Lua 不读 bin64 副本', '篡改 io 目录副本不影响判定（走 persist 通道）')
else bad('③-3 篡改 bin64 后仍应成功', JSON.stringify({ good: good?.reason, afterTamper: afterTamper?.reason }))

// 3-c 按被篡改的值发命令 → 必须被判 future_generation（证明它没被信任）
const forgedEnv = { ...env3, lease_generation: 999, authority_epoch: 'forged-epoch', lease_id: 'forged-lease', owner_instance_id: 'forged-owner' }
const forgedCmd = await sendStop(forgedEnv, '③-4 用伪造值发命令（应拒）')
if (forgedCmd?.ok === false) ok('③-4 伪造副本值不被信任', `reason=${forgedCmd.reason}`)
else bad('③-4 伪造副本值不被信任', JSON.stringify(forgedCmd))

// 3-d 篡改 save 目录（Lua 真正读的那份）→ 必须立即生效（说明 Lua 读的就是它，没有额外缓存兜底）
const forgedSave = { ...base, generation: 777, lease_id: 'save-forged', authority_epoch: 'save-epoch', owner_instance_id: 'save-forged-owner' }
writeFileSync(`${saveDir}/whale_lease.json`, HEADER + JSON.stringify(forgedSave), 'utf8')
await new Promise((r) => setTimeout(r, 1200)) // 等一个 tick 让 ps 缓存刷新
const saveCmd = await sendStop({ ...env3, lease_generation: 777, authority_epoch: 'save-epoch', lease_id: 'save-forged', owner_instance_id: 'save-forged-owner' }, '③-5 篡改 save 权威后按新值发命令')
if (saveCmd?.ok === true) ok('③-5 Lua 读的就是 save 目录那份', '改 save 立即生效（篡改 save 等于篡改权威 → 需文件系统层保护）')
else bad('③-5 Lua 读的就是 save 目录那份', `reason=${saveCmd?.reason}（若为 stale/unavailable 说明还有别的来源）`)

// 清理
cleanAll()
console.log('\n=== 汇总 ===')
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  |  ' + r.detail : ''}`)
const failed = results.filter((r) => !r.pass).length
console.log(`\n共 ${results.length} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 2)
