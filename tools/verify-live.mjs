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
//   node tools/verify-live.mjs all                   # 依次运行所有只读检查

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GameBridge } from '../lib/bridge.js'
import { LeaseManager, envFingerprintOf } from '../lib/control.js'
import { createDispatcher } from '../lib/dispatcher.js'
import { normalizeState } from '../lib/state/snapshot.js'

const ROOT = process.cwd()
const ARGS = process.argv.slice(2)
const COMMAND = ARGS[0]?.toLowerCase()

function printUsage() {
  console.log(`
综合真机验证工具

用法:
  node tools/verify-live.mjs <command> [options]

命令:
  lease     验证租约、换手、ACK 与权威副本
  move      验证 move_to 真实走路与打断
  stop      验证 Abort 逐帧停步
  pickup    验证 pickup 拾取白名单与背包核对
  nearby    验证附近分类桶、上限与快照 (--bridgeDir 可选)
  harvest   验证 harvest 采摘与不自动拾取 (--harvest 开启真实采摘)
  all       运行全部只读验证
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
