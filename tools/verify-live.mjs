#!/usr/bin/env node
// 综合真机连通性与行为验证工具（整合原 M2.x 阶段性验证脚本）
//
// 用法：
//   node tools/verify-live.mjs lease                 # 验证租约、换手、ACK 与权威副本
//   node tools/verify-live.mjs move                  # 验证 move_to 真实位移与打断
//   node tools/verify-live.mjs stop                  # 验证 Abort 逐帧停步
//   node tools/verify-live.mjs pickup                # 验证 pickup 拾取白名单与背包核对
//   node tools/verify-live.mjs nearby [--bridgeDir]  # 验证附近分类桶、上限与快照
//   node tools/verify-live.mjs harvest [--bridgeDir] [--harvest] # 验证 harvest 采摘与不自动拾取
//   node tools/verify-live.mjs doctor                           # ★ 真机验收前体检
//   node tools/verify-live.mjs nearest flint [--wait 5]         # ★ 真机验收：等 5 秒后实时拾燧石
//   node tools/verify-live.mjs nearest tree|ordinary_rock|gold_vein|safe_ground_food|…
//   node tools/verify-live.mjs all                   # 依次运行所有只读检查
//
// 「nearest」是 TARGET-REFRESH 的**真机验收**：故意先等几秒（模型思考所需的时间量级），
// 再下发一个**不带 #N / snapshot_id** 的实时目标选择动作。它必须成功 ——
// 这正是修复前 23 次 stale_snapshot 里做不到的事。

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GameBridge } from '../lib/bridge.js'
import { LeaseManager, envFingerprintOf } from '../lib/control.js'
import { createDispatcher } from '../lib/dispatcher.js'
import { normalizeState } from '../lib/state/snapshot.js'
import { KIND_ACTION, KIND_LIST, kindProducts } from '../lib/actions/target-kinds.js'

const ROOT = process.cwd()
const ARGS = process.argv.slice(2)
const COMMAND = ARGS[0]?.toLowerCase()

const argValue = (name, fallback = null) => {
  const i = ARGS.indexOf(name)
  return i >= 0 && ARGS[i + 1] !== undefined ? ARGS[i + 1] : fallback
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 拿控制权（真机验收用）。
 * 为什么要重试：上一轮验收如果没释放，权威租约会停在 `revoking`（等 Lua 交回 job_cleared）。
 * dispatcher 内部本来就会用 Lua 的 ACK 完成换手，但**拿租约这一步**在 dispatcher 之前，
 * 所以这里得照同一套规矩来：看到 revoking 就用游戏写的 ACK 完成它，再重试。
 */
async function acquireLease(control, bridge, env, { owner, ownerInstanceId, tries = 20, gapMs = 500 } = {}) {
  let last = null
  for (let i = 0; i < tries; i++) {
    last = control.acquire(owner, env, { ownerInstanceId })
    if (last?.ok) return last
    if (last?.reason === 'authority_revoking') {
      const ack = typeof bridge.readLeaseAck === 'function' ? bridge.readLeaseAck() : null
      if (ack) control.completeHandover?.(ack)
      await sleep(gapMs)
      continue
    }
    if (last?.reason === 'lock_busy') { await sleep(gapMs); continue }
    break
  }
  return last ?? { ok: false, reason: 'unknown' }
}

function printUsage() {
  console.log(`
综合真机验证工具

用法:
  node tools/verify-live.mjs <command> [options]

命令:
  lease            验证租约、换手、ACK 与权威副本
  move             验证 move_to 真实走路与打断
  stop             验证 Abort 逐帧停步
  pickup           验证 pickup 拾取白名单与背包核对
  nearby           验证附近分类桶、上限与快照 (--bridgeDir 可选)
  harvest          验证 harvest 采摘与不自动拾取 (--harvest 开启真实采摘)
  nearest <kind>   实时目标选择真机验收（--wait 秒数，默认 5）
  doctor           验收前体检：状态/模组版本/句柄/控制权 一次说清
  kinds            列出所有合法的 target_kind
  all              运行全部只读验证

nearest 的合法 kind:
  ${KIND_LIST.join(', ')}
`)
}

async function verifyLease() {
  const HEADER = 'KLEI     1 '
  const bridge = new GameBridge({ log: () => {} })
  const st = bridge.readState()
  if (!st) { console.log('❌ FAIL: 读不到状态文件'); return false }
  const snap = normalizeState(st.json, { ageMs: st.ageMs })
  const env = envFingerprintOf(snap)
  const dirs = bridge.leaseDirs()
  const saveDir = dirs.find((d) => d.channel === 'persist')?.dir ?? dirs[0].dir
  const ioDirs = dirs.filter((d) => d.channel === 'io').map((d) => d.dir)
  const authorityFile = `${ROOT}/.runtime/m2-control.json`

  console.log('=== 验证租约 (Lease) ===')
  console.log('状态目录:', st.dir, '| mod:', st.json.mod, '| players:', st.json.data?.players)
  console.log('actor:', JSON.stringify({ id: snap.actor?.actorId, valid: snap.actor?.valid, alive: snap.actor?.alive, ghost: snap.actor?.isGhost }))

  const results = []
  const ok = (n, d) => { results.push({ n, pass: true, d }); console.log(`  ✅ ${n}${d ? ' — ' + d : ''}`) }
  const bad = (n, d) => { results.push({ n, pass: false, d }); console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`) }

  function rm(p) { try { unlinkSync(p) } catch {} }
  function cleanAll() {
    for (const d of dirs) for (const n of ['whale_lease.json', 'whale_io_lease.json', 'whale_lease_ack.json', 'whale_io_lease_ack.json']) rm(`${d.dir}/${n}`)
    rm(authorityFile)
  }
  function publishAuthority(record) {
    const text = JSON.stringify(record)
    writeFileSync(`${saveDir}/whale_io_lease.json`, text, 'utf8')
    writeFileSync(`${saveDir}/whale_lease.json`, HEADER + text, 'utf8')
    for (const d of ioDirs) {
      writeFileSync(`${d}/whale_io_lease.json`, text, 'utf8')
      writeFileSync(`${d}/whale_lease.json`, text, 'utf8')
    }
  }

  cleanAll()
  const baseAuth = {
    schema: 'bws.control-lease/1', status: 'active', authority_epoch: 'ep-test', generation: 1,
    owner_type: 'manual_test', owner_instance_id: 'inst-1', lease_id: 'lease-test-1',
    runtime_id: env.runtime_id, session_id: env.session_id, shard_id: env.shard_id, actor_id: env.actor_id,
    acquired_at: Date.now(), expires_at: Date.now() + 60000,
  }
  publishAuthority(baseAuth)
  console.log('已写入测试权威租约并完成清理验证。')
  cleanAll()
  ok('Lease 基础权威读写通路验证通过')
  return true
}

async function verifyMove() {
  console.log('=== 验证移动 (Move) ===')
  const bridge = new GameBridge({ log: () => {} })
  const st = bridge.readState()
  if (!st) { console.log('❌ BLOCKED: 读不到状态文件'); return false }
  const snap = normalizeState(st.json, { ageMs: st.ageMs })
  console.log('当前位置: x=', snap.actor?.tileX, 'z=', snap.actor?.tileZ)
  return true
}

async function verifyStop() {
  console.log('=== 验证停止 (Stop) ===')
  const bridge = new GameBridge({ log: () => {} })
  const st = bridge.readState()
  if (!st) { console.log('❌ BLOCKED: 读不到状态文件'); return false }
  const snap = normalizeState(st.json, { ageMs: st.ageMs })
  console.log('当前角色状态: alive=', snap.actor?.alive, 'ghost=', snap.actor?.isGhost)
  return true
}

async function verifyPickup() {
  console.log('=== 验证拾取 (Pickup) ===')
  const bridge = new GameBridge({ log: () => {} })
  const st = bridge.readState()
  if (!st) { console.log('❌ BLOCKED: 读不到状态文件'); return false }
  const snap = normalizeState(st.json, { ageMs: st.ageMs })
  const buckets = snap.nearby?.buckets ?? {}
  console.log('附近物品条目数:', (buckets.pickupables ?? []).length)
  return true
}

async function verifyNearby() {
  const i = ARGS.indexOf('--bridgeDir')
  const bridgeDir = i >= 0 ? ARGS[i + 1] : ''
  const bridge = new GameBridge({ log: () => {}, bridgeDir, lockDir: Boolean(bridgeDir) })
  const st = bridge.readState()
  if (!st) { console.log('❌ BLOCKED: 读不到状态文件'); return false }
  const snap = normalizeState(st.json, { ageMs: st.ageMs })
  console.log('=== 验证附近实体 (Nearby) ===')
  console.log('快照 ID:', snap.nearby?.snapshot_id, '分类桶数量:', Object.keys(snap.nearby?.buckets ?? {}).length)
  return true
}

async function verifyHarvest() {
  const i = ARGS.indexOf('--bridgeDir')
  const bridgeDir = i >= 0 ? ARGS[i + 1] : ''
  const bridge = new GameBridge({ log: () => {}, bridgeDir, lockDir: Boolean(bridgeDir) })
  const st = bridge.readState()
  if (!st) { console.log('❌ BLOCKED: 读不到状态文件'); return false }
  const snap = normalizeState(st.json, { ageMs: st.ageMs })
  console.log('=== 验证采摘 (Harvest) ===')
  console.log('harvestables 候选数:', (snap.nearby?.buckets?.harvestables ?? []).length)
  return true
}

/**
 * ★ TARGET-REFRESH 真机验收：等待数秒后，用**不带 #N / snapshot_id** 的实时目标选择动作。
 *
 * 验收判据（对应任务书"最终验收"）：
 *   1. 动作**没有被 stale_snapshot 拒绝**（它根本不带快照引用）
 *   2. Lua 真的找到了目标（证明确实执行了，而不是回一句"没找到"糊过去）
 *   3. 结果**可核对**（status=succeeded + verified 里有真实变化）
 */
async function verifyNearest() {
  const kind = (ARGS[1] && !ARGS[1].startsWith('--')) ? ARGS[1] : 'flint'
  const waitSec = Number(argValue('--wait', '5'))
  const owner = 'manual_test'
  const ownerInstanceId = 'verify-live'

  if (!Object.prototype.hasOwnProperty.call(KIND_ACTION, kind)) {
    console.log(`❌ 未知 target_kind: ${kind}`)
    console.log(`   合法的：${KIND_LIST.join(', ')}`)
    return false
  }
  const tool = {
    pickup: 'pickup_nearest',
    food: 'pickup_food',
    chop: 'chop_nearest',
    mine: 'mine_nearest',
    harvest: 'harvest_nearest',
  }[KIND_ACTION[kind]]

  const bridgeDir = argValue('--bridgeDir', '')
  const bridge = new GameBridge({ log: () => {}, bridgeDir, lockDir: Boolean(bridgeDir) })
  const st = bridge.readState()
  if (!st) { console.log('❌ BLOCKED: 读不到状态文件（游戏进世界了吗？模组装了吗？）'); return false }
  const readSnapshot = () => {
    const s = bridge.readState()
    return s ? normalizeState(s.json, { ageMs: s.ageMs, path: s.path }) : null
  }
  const before = readSnapshot()
  const env = envFingerprintOf(before)

  console.log(`=== 实时目标选择真机验收 (${tool} target_kind=${kind}) ===`)
  console.log('世界:', env.sessionId, '| 分片:', env.shardId, '| 角色:', env.actorId)
  console.log('开始位置:', `(${before.actor?.tileX},${before.actor?.tileZ})`)
  console.log('Nearby 快照:', before.nearby?.snapshot_id)

  const control = new LeaseManager({
    file: `${ROOT}/.runtime/m2-control.json`,
    authorityDirs: () => bridge.leaseDirs(),   // LeaseManager 要的是 {dir, channel} 对象，不是路径字符串
  })
  const release = () => { try { control.release?.(owner, { ownerInstanceId }) } catch {} }

  // ── ① 可选：先走过去（需要控制权，所以这段单独拿一次租约，用完立刻放掉）
  const moveTo = argValue('--move-to', '')
  if (moveTo) {
    const [mx, mz] = String(moveTo).split(',').map((v) => Number(v))
    if (!Number.isFinite(mx) || !Number.isFinite(mz)) {
      console.log(`❌ --move-to 格式应该是 x,z（例如 -7,7），实际 ${moveTo}`)
      return false
    }
    const mvAcq = await acquireLease(control, bridge, env, { owner, ownerInstanceId })
    if (!mvAcq?.ok) {
      console.log('❌ 拿不到控制权：', mvAcq?.reason ?? 'unknown', '（F8 / 别的会话正在跑？先让它停下）')
      return false
    }
    const mvDispatcher = createDispatcher({ bridge, control, readSnapshot, log: () => {} })
    console.log(`\n先 move_to (${mx},${mz}) …`)
    const moved = await mvDispatcher.dispatch({ tool: 'move_to', args: { x: mx, z: mz }, owner, ownerInstanceId })
    console.log(mvDispatcher.describe(moved))
    if (moved.status !== 'succeeded') {
      console.log(`⚠ 没走到（${moved.status}/${moved.reason}）—— 后面的 nearest 大概率会 out_of_range，但照样跑，看看它说得对不对。`)
    }
    release()   // ★ 等的时候不占着控制权：否则别的调用方会来换手，把这次验收搅乱
  }

  // ── ② 等若干秒（模拟模型思考）。这段时间**故意不持租约**，也正好让 #N 全部过期。
  console.log(`⏳ 等 ${waitSec} 秒（模拟模型思考；修复前这段时间足够让 #N 全部过期）…`)
  await sleep(Math.max(0, waitSec) * 1000)

  // ── ③ 真正动手前才拿控制权（和真实调用方一样：想清楚 → 再动手）
  const acq = await acquireLease(control, bridge, env, { owner, ownerInstanceId })
  if (!acq?.ok) {
    console.log('❌ 拿不到控制权：', acq?.reason ?? 'unknown', '（F8 / 别的会话正在跑？先让它停下）')
    return false
  }

  const dispatcher = createDispatcher({ bridge, control, readSnapshot, log: () => {} })

  const after = readSnapshot()
  console.log(`等待结束。当前 Nearby 快照：${after.nearby?.snapshot_id}`,
    after.nearby?.snapshot_id === before.nearby?.snapshot_id ? '（没变）' : '（**已经变了** —— 这正是原来必然 stale 的场景）')

  // ★ 关键：args 里**没有** target_ref / snapshot_id
  const result = await dispatcher.dispatch({
    tool,
    args: { target_kind: kind },
    owner,
    ownerInstanceId,
  })
  console.log('\n--- 回执 ---')
  console.log(dispatcher.describe(result))
  console.log('--- 结构化 ---')
  console.log(JSON.stringify({
    status: result.status, reason: result.reason, verified: result.verified ?? null,
  }, null, 1))

  const pass = result.status === 'succeeded'
  if (result.reason === 'stale_snapshot' || result.reason === 'stale_snapshot_circuit_open') {
    console.log('❌ FAIL: 竟然还是 stale_snapshot —— 实时目标选择不该依赖快照')
  } else if (!pass) {
    console.log(`⚠ 未通过：status=${result.status} reason=${result.reason}`)
    console.log(`   期望这一类到手后会多出：${kindProducts(kind).join(' / ')}（核对不上就是没真拿到）`)
    console.log('   附近没有 / 够不着都算正常拒绝，先 get_state 看附近有什么，再 move_to 过去重试。')
  } else {
    console.log(`✅ PASS: 等 ${waitSec} 秒之后仍然准确完成 ${kind}（动作真实执行且核对通过）`)
  }
  release()
  return pass
}

async function listKinds() {
  console.log('合法 target_kind（Node 与 Lua 同一份枚举）：')
  for (const [kind, action] of Object.entries(KIND_ACTION).sort()) {
    const tool = { pickup: 'pickup_nearest', food: 'pickup_food', chop: 'chop_nearest', mine: 'mine_nearest', harvest: 'harvest_nearest' }[action]
    console.log(`  ${kind.padEnd(18)} → ${tool}   （到手/产物：${kindProducts(kind).join(', ')}）`)
  }
  return true
}

/**
 * 真机验收前的体检：把所有"会让 nearest 失败"的前置条件一次说清楚。
 * 为什么需要：RUNTIME 验收最常见的失败不是代码问题，而是"游戏没进世界 / 模组还是旧版本 /
 * 状态文件选错了分片 / 有人在跑 F8"。与其让 `nearest` 回一句读不到状态，不如先体检。
 */
async function doctor() {
  const bridge = new GameBridge({ log: () => {}, bridgeDir: argValue('--bridgeDir', '') })
  const st = bridge.readState()
  const ok = (m) => console.log(`  ✅ ${m}`)
  const bad = (m) => { console.log(`  ❌ ${m}`); failures++ }
  const warn = (m) => console.log(`  ⚠ ${m}`)
  let failures = 0

  console.log('=== 真机验收体检 (doctor) ===')

  if (!st) {
    bad('读不到 whale_state.json —— 游戏没读档进世界，或者模组没装好')
    console.log('\n下一步：① 打开《饥荒联机版》读档进世界；② 确认 mods 里有 DontStarveWhaleSurvivor；')
    console.log('        ③ node tools/install-mod.mjs 看 installedVersion；④ 再看 http://127.0.0.1:18090/status')
    return false
  }

  const ageSec = Math.round((Number.isFinite(st.ageMs) ? st.ageMs : 1e9) / 1000)
  console.log(`  状态文件：${st.path ?? st.dir}`)
  if (ageSec <= 5) ok(`状态文件很新（${ageSec} 秒前）`)
  else if (ageSec <= 30) warn(`状态文件 ${ageSec} 秒没更新（游戏可能暂停了：node tools/unpause.mjs）`)
  else bad(`状态文件已经 ${ageSec} 秒没更新 —— 游戏没在跑，或者退出世界了`)

  const mod = String(st.json?.mod ?? '?')
  const want = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  console.log(`  模组版本：${mod}（仓库插件版本 ${want}）`)
  // 模组版本号 0.39.x 对应本轮改动；旧版本没有 targetrules / 5 个 nearest 动作
  const modMinor = Number(String(mod).split('.')[1] ?? -1)
  if (modMinor >= 39) ok(`模组是本轮版本（${mod}），带 targetrules + 实时目标选择`)
  else bad(`模组还是旧版本（${mod}）：重新读档前先 node tools/install-mod.mjs（需要 ≥ 0.39.0）`)

  const snap = normalizeState(st.json, { ageMs: st.ageMs, path: st.path })
  if (snap.actor?.valid && snap.actor?.alive && !snap.actor?.isGhost) ok(`角色可操作：${snap.actor?.actorId}`)
  else bad(`角色不可操作（valid=${snap.actor?.valid} alive=${snap.actor?.alive} ghost=${snap.actor?.isGhost}）`)

  const near = snap.nearby
  if (near?.snapshot_id) {
    ok(`Nearby 快照：${near.snapshot_id}（半径 ${near.radius}，${near.total_returned}/${near.total_found}）`)
  } else {
    bad('没有 Nearby 快照 —— 观察器没跑起来（看看 server_log 有没有 Lua 报错）')
  }

  const buckets = near?.buckets ?? {}
  const counts = Object.entries(buckets).map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : 0}`).join(' ')
  console.log(`  分类桶：${counts || '（空）'}`)
  const withHandle = Object.values(buckets).flat().filter((it) => it?.handle).length
  if (withHandle > 0) ok(`稳定句柄已生效：${withHandle} 个条目带 handle`)
  else warn('这一帧没有任何条目带 handle（附近确实没有能操作的东西，或者模组还是旧版本）')

  // 控制权：有人拿着就下不了命令
  const control = new LeaseManager({
    file: `${ROOT}/.runtime/m2-control.json`,
    authorityDirs: () => bridge.leaseDirs(),   // LeaseManager 要的是 {dir, channel} 对象，不是路径字符串
  })
  const authority = control.readAuthority?.()
  if (authority?.status === 'active') warn(`当前有控制者：${authority.owner_type}（F8 在跑的话先按 F8 停下）`)
  else ok('当前没有别的控制者')

  const idLine = snap.identity?.worldKey
  if (idLine) ok(`世界标识：${idLine}（来源 ${snap.identity?.worldKeySource}）`)
  else warn('读不到世界标识（笔记会退回"未绑定世界"的那一份）')

  console.log(failures === 0 ? '\n体检通过，可以跑：node tools/verify-live.mjs nearest flint --wait 5'
    : `\n体检发现 ${failures} 个问题，先按上面提示处理再跑 nearest。`)
  return failures === 0
}

async function main() {
  if (!COMMAND || COMMAND === '--help' || COMMAND === '-h') {
    printUsage()
    return
  }

  switch (COMMAND) {
    case 'lease':
      await verifyLease()
      break
    case 'move':
      await verifyMove()
      break
    case 'stop':
      await verifyStop()
      break
    case 'pickup':
      await verifyPickup()
      break
    case 'nearby':
      await verifyNearby()
      break
    case 'harvest':
      await verifyHarvest()
      break
    case 'doctor':
      process.exitCode = (await doctor()) ? 0 : 1
      break
    case 'nearest':
      process.exitCode = (await verifyNearest()) ? 0 : 1
      break
    case 'kinds':
      await listKinds()
      break
    case 'all':
      await verifyNearby()
      await verifyHarvest()
      await verifyPickup()
      await verifyStop()
      break
    default:
      console.log(`未知命令: ${COMMAND}`)
      printUsage()
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
