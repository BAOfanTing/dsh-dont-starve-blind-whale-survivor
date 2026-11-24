#!/usr/bin/env node
// Tier 1：确定性原子烟雾测试（约 40 秒，0 LLM token）。
//
// 直接复用并扩展 tools/verify-live.mjs 的能力：按顺序驱动一组最基础的原子动作，
// doctor → move_to → pickup_nearest → harvest_nearest → craft(axe/torch)
//        → chop_nearest → mine_nearest → eat → stop。
//
// 关键设计（否则真机验收会很脆、全是噪音）：
//   · 区分「代码 Bug」和「环境噪音」：
//       - 硬故障（hardFail）：stale_snapshot / bridge_error / threw / unknown /
//         授权失败 …… 这些是**必须立刻停下修**的真问题；
//       - 软跳过（skip）：附近没燧石、没树、背包没吃的、材料不够 …… 只记一条 warn，
//         不算失败，否则每次出生点资源不同都会误报。
//   · 拿不到状态文件 = BLOCKED（游戏没进世界），退出码 3，不当作代码失败。
//
// 用法：
//   node tools/run-live-tier1.mjs                       # 跑全套
//   node tools/run-live-tier1.mjs --dry-run             # 只 doctor，不动作
//   node tools/run-live-tier1.mjs --move-to 10,5 --json
//   node tools/run-live-tier1.mjs --bridgeDir "<.../save>"
//
// 退出码：0 通过；2 有硬故障；3 BLOCKED（游戏/状态不可用）。

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GameBridge } from '../lib/bridge.js'
import { LeaseManager, envFingerprintOf } from '../lib/control.js'
import { createDispatcher } from '../lib/dispatcher.js'
import { normalizeState } from '../lib/state/snapshot.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const rawArgs = process.argv.slice(2)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (!k.startsWith('--')) continue
    const name = k.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[name] = true
    else { out[name] = next; i += 1 }
  }
  return out
}
const ARGS = parseArgs(rawArgs)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 会让整条流水线立即失败的「真 Bug」原因（错的是代码，不是环境）。 */
const HARD_FAIL_REASONS = new Set([
  'stale_snapshot', 'stale_snapshot_circuit_open',
  'bridge_error', 'threw', 'unknown',
  'not_authorized', 'authority_revoking', 'authority_mismatch', 'lease_invalid', 'lease_expired',
  'schema_error', 'protocol_version_mismatch',
])

async function acquireLease(control, bridge, env, { owner, ownerInstanceId, tries = 20, gapMs = 300 } = {}) {
  let last = null
  for (let i = 0; i < tries; i += 1) {
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

function doctor(bridge, snap, st) {
  const problems = []
  if (!st) { problems.push('读不到 whale_state.json（游戏没进世界 / 模组没装）'); return { ok: false, problems } }
  const ageSec = Math.round((Number.isFinite(st.ageMs) ? st.ageMs : 1e9) / 1000)
  if (ageSec > 30) problems.push(`状态文件 ${ageSec}s 没更新（游戏可能暂停：node tools/unpause.mjs）`)
  if (!(snap.actor?.valid && snap.actor?.alive && !snap.actor?.isGhost)) {
    problems.push(`角色不可操作（valid=${snap.actor?.valid} alive=${snap.actor?.alive} ghost=${snap.actor?.isGhost}）`)
  }
  return { ok: problems.length === 0, problems, ageSec }
}

/** 打一条动作，返回 {status, reason, classify: pass|skip|fail}。 */
async function runStep(name, tool, args, ctx) {
  const { bridge, control, owner, ownerInstanceId, readSnapshot } = ctx
  const before = readSnapshot()
  if (!before) return { name, tool, status: 'blocked', reason: 'no_state', classify: 'fail' }
  const env = envFingerprintOf(before)
  const acq = await acquireLease(control, bridge, env, { owner, ownerInstanceId })
  if (!acq?.ok) {
    return { name, tool, status: 'blocked', reason: `no_lease:${acq?.reason ?? 'unknown'}`, classify: 'fail' }
  }
  const dispatcher = createDispatcher({ bridge, control, readSnapshot, log: () => {} })
  let result
  try {
    result = await dispatcher.dispatch({ tool, args, owner, ownerInstanceId })
  } catch (e) {
    try { control.release?.(owner, { ownerInstanceId }) } catch {}
    return { name, tool, status: 'threw', reason: String(e?.message ?? e), classify: 'fail' }
  }
  try { control.release?.(owner, { ownerInstanceId }) } catch {}

  const status = result?.status ?? 'unknown'
  const reason = result?.reason ?? null
  let classify
  if (status === 'succeeded') classify = 'pass'
  else if (reason && HARD_FAIL_REASONS.has(String(reason))) classify = 'fail'
  else classify = 'skip' // 资源不足 / 够不着 / 材料不够 等环境噪音
  return { name, tool, status, reason, classify, verified: result?.verified ?? null }
}

function buildSteps(snap) {
  const moveTo = ARGS['move-to']
  let mx = null
  let mz = null
  if (moveTo && String(moveTo).includes(',')) {
    [mx, mz] = String(moveTo).split(',').map((v) => Number(v))
  } else if (snap?.actor && Number.isFinite(snap.actor.tileX) && Number.isFinite(snap.actor.tileZ)) {
    mx = Math.round(snap.actor.tileX)
    mz = Math.round(snap.actor.tileZ)
  }
  const steps = []
  if (Number.isFinite(mx) && Number.isFinite(mz)) steps.push({ name: 'move_to', tool: 'move_to', args: { x: mx, z: mz } })
  steps.push(
    { name: 'pickup_flint', tool: 'pickup_nearest', args: { target_kind: 'flint' } },
    { name: 'harvest_berry', tool: 'harvest_nearest', args: { target_kind: 'berrybush' } },
    { name: 'craft_axe', tool: 'craft', args: { recipe: 'axe' } },
    { name: 'craft_torch', tool: 'craft', args: { recipe: 'torch' } },
    { name: 'chop_tree', tool: 'chop_nearest', args: { target_kind: 'tree' } },
    { name: 'mine_gold', tool: 'mine_nearest', args: { target_kind: 'gold_vein' } },
    { name: 'eat', tool: 'eat', args: {} },
    { name: 'stop', tool: 'stop', args: {} },
  )
  return steps
}

async function main() {
  const bridgeDir = ARGS.bridgeDir || ''
  const bridge = new GameBridge({ log: () => {}, bridgeDir, lockDir: Boolean(bridgeDir) })
  const st = bridge.readState()
  if (!st) {
    console.log('⛔ BLOCKED：读不到状态文件（游戏没进世界 / 模组没装 / 状态文件路径不对）')
    console.log('   下一步：① 打开《饥荒联机版》读档进世界；② node tools/install-mod.mjs；③ node tools/unpause.mjs')
    process.exit(3)
  }
  const snap = normalizeState(st.json, { ageMs: st.ageMs, path: st.path })
  const doc = doctor(bridge, snap, st)
  const report = { tier: 'tier1', doctor: doc, steps: [], passed: false, blocked: false }

  console.log('=== Tier 1：确定性原子烟雾测试 ===')
  console.log(`  状态文件：${st.path ?? st.dir}（${doc.ageSec}s 前）`)
  console.log(`  角色：${snap.actor?.actorId ?? '-'}  可操作=${snap.actor?.valid && snap.actor?.alive && !snap.actor?.isGhost}`)
  if (!doc.ok) {
    console.log(`  ⚠ 体检未完全通过：${doc.problems.join('；')}`)
  }

  if (ARGS['dry-run']) {
    report.blocked = !doc.ok && !!st
    report.passed = false
    console.log('  （--dry-run：只做体检，不下动作）')
    emit(report)
    process.exit(doc.ok ? 0 : 3)
  }

  const owner = 'manual_test'
  const ownerInstanceId = 'run-live-tier1'
  const control = new LeaseManager({ file: path.join(ROOT, '.runtime', 'm2-control.json'), authorityDirs: () => bridge.leaseDirs() })
  const readSnapshot = () => { const s = bridge.readState(); return s ? normalizeState(s.json, { ageMs: s.ageMs, path: s.path }) : null }
  const ctx = { bridge, control, owner, ownerInstanceId, readSnapshot }

  const steps = buildSteps(snap)
  for (const step of steps) {
    const r = await runStep(step.name, step.tool, step.args, ctx)
    report.steps.push(r)
    const icon = r.classify === 'pass' ? '✅' : r.classify === 'skip' ? '⏭' : '❌'
    console.log(`  ${icon} ${step.name.padEnd(14)} ${r.classify.padEnd(4)} status=${r.status}${r.reason ? ' reason=' + r.reason : ''}`)
    if (r.classify === 'fail' && ARGS['fail-fast'] !== false) {
      console.log('  ⛔ 命中硬故障，fail-fast 立即停止。')
      break
    }
  }

  const hardFails = report.steps.filter((s) => s.classify === 'fail')
  const passes = report.steps.filter((s) => s.classify === 'pass')
  report.hardFails = hardFails.length
  report.passes = passes.length
  report.passed = doc.ok && hardFails.length === 0
  console.log(`\n  结果：通过 ${passes.length} / 硬故障 ${hardFails.length} / 共 ${report.steps.length} 步`)
  if (report.passed) console.log('  ✅ Tier 1 通过')
  else if (hardFails.length) console.log('  ❌ Tier 1 有硬故障，需要修复')
  emit(report)
  process.exit(report.passed ? 0 : 2)
}

function emit(report) {
  if (ARGS.json) process.stdout.write(JSON.stringify(report) + '\n')
}

main().catch((e) => { console.error(e); process.exit(1) })
