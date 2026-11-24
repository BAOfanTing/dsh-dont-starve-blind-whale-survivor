#!/usr/bin/env node
// Tier 1/2/3 三层漏斗编排：快而全，逐层加码，fail-fast。
//
//   Tier 1  确定性原子烟雾（~40s，0 token）   —— 内部调用 tools/run-live-tier1.mjs
//   Tier 2  极端场景注入（~2min，0 token）     —— 需 --injector 指定注入模块
//   Tier 3  真实 AI 自主生存长跑（5~15min，耗 token） —— 需 --ai-runner 指定运行器
//
// 诚实降级：Tier2/Tier3 依赖「能向游戏控制台灌指令 / 能驱动 AiRunner」的能力。
// 本仓库当前没有通用控制台通道，所以默认把这两层标为 skipped（并在 reason 里说清），
// 绝不含糊地报「通过」。等接上注入器/AiRunner 后，用 --injector / --ai-runner 打开即可。
//
// 用法：
//   node tools/run-e2e-suite.mjs                 # 跑 Tier1（Tier2/3 跳过）
//   node tools/run-e2e-suite.mjs --dry-run       # Tier1 只体检
//   node tools/run-e2e-suite.mjs --tier 1 --json
//   node tools/run-e2e-suite.mjs --injector ./tools/xxx-injector.mjs --ai-runner ./tools/xxx-ai.mjs
//
// 退出码：0 执行到的各层全过；2 有层失败；3 BLOCKED（游戏不可用）。

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

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
const ARGS = parseArgs(process.argv.slice(2))

function runTier1() {
  const args = [path.join(ROOT, 'tools', 'run-live-tier1.mjs'), '--json']
  if (ARGS['dry-run']) args.push('--dry-run')
  if (ARGS.bridgeDir) args.push('--bridgeDir', ARGS.bridgeDir)
  if (ARGS['move-to']) args.push('--move-to', ARGS['move-to'])
  const res = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 180000 })
  let parsed = null
  try { parsed = JSON.parse((res.stdout || '').trim().split('\n').slice(-1)[0]) } catch { /* 可能是多行，尝试整体 */ }
  if (!parsed) { try { parsed = JSON.parse(res.stdout) } catch {} }
  const status = res.status === 0 ? 'passed' : res.status === 3 ? 'blocked' : 'failed'
  return {
    tier: 1,
    status,
    exitCode: res.status,
    passed: status === 'passed',
    detail: parsed ?? { stdout: (res.stdout || '').slice(-2000), stderr: (res.stderr || '').slice(-2000) },
  }
}

async function runTier2() {
  if (!ARGS.injector) {
    return { tier: 2, status: 'skipped', passed: true, reason: '未配置 --injector（没有通用控制台注入通道），如实跳过' }
  }
  try {
    const mod = await import(path.resolve(ROOT, ARGS.injector))
    if (typeof mod.runScenarios !== 'function') throw new Error('注入模块必须导出 runScenarios(ctx)')
    const out = await mod.runScenarios({ root: ROOT, args: ARGS })
    const passed = out?.passed === true
    return { tier: 2, status: passed ? 'passed' : 'failed', passed, detail: out }
  } catch (e) {
    return { tier: 2, status: 'failed', passed: false, reason: String(e?.message ?? e) }
  }
}

async function runTier3() {
  if (!ARGS['ai-runner']) {
    return { tier: 3, status: 'skipped', passed: true, reason: '未配置 --ai-runner，如实跳过（避免烧 token 盲跑）' }
  }
  try {
    const mod = await import(path.resolve(ROOT, ARGS['ai-runner']))
    if (typeof mod.runAi !== 'function') throw new Error('AI 运行器必须导出 runAi(ctx)')
    const out = await mod.runAi({ root: ROOT, args: ARGS, maxSteps: Number(ARGS['max-steps'] || 40) })
    const passed = out?.passed === true
    return { tier: 3, status: passed ? 'passed' : 'failed', passed, detail: out }
  } catch (e) {
    return { tier: 3, status: 'failed', passed: false, reason: String(e?.message ?? e) }
  }
}

async function main() {
  const want = String(ARGS.tier || 'all')
  const runAll = want === 'all'
  const tiers = []

  console.log('=== 分层 E2E 测试（Tier 1 → 2 → 3）===')
  if (runAll || want === '1') {
    console.log('▶ Tier 1：确定性原子烟雾…')
    const t1 = runTier1()
    tiers.push(t1)
    console.log(`  ${icon(t1.status)} Tier1 ${t1.status}（exit=${t1.exitCode}）`)
    if (t1.status === 'blocked') return finish(tiers, 'blocked')
    if (t1.status === 'failed' && ARGS['fail-fast'] !== false) return finish(tiers, 'failed')
  }
  if (runAll || want === '2') {
    console.log('▶ Tier 2：极端场景注入…')
    const t2 = await runTier2()
    tiers.push(t2)
    console.log(`  ${icon(t2.status)} Tier2 ${t2.status}${t2.reason ? ' — ' + t2.reason : ''}`)
    if (t2.status === 'failed' && ARGS['fail-fast'] !== false) return finish(tiers, 'failed')
  }
  if (runAll || want === '3') {
    console.log('▶ Tier 3：真实 AI 自主长跑…')
    const t3 = await runTier3()
    tiers.push(t3)
    console.log(`  ${icon(t3.status)} Tier3 ${t3.status}${t3.reason ? ' — ' + t3.reason : ''}`)
  }
  const failed = tiers.some((t) => t.status === 'failed')
  return finish(tiers, failed ? 'failed' : 'passed')
}

function icon(s) { return s === 'passed' ? '✅' : s === 'blocked' ? '⛔' : s === 'skipped' ? '⏭' : '❌' }

function finish(tiers, overall) {
  const report = { schema: 'bws.e2e-suite/1', overall, passed: overall === 'passed', tiers }
  const outArgIdx = parseArgs(process.argv.slice(2)).out
  const out = outArgIdx || path.join(ROOT, '.runtime', 'e2e-suite.json')
  try { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2)) } catch {}
  if (ARGS.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  else console.log(`\n  总体：${overall}（报告 ${out}）`)
  process.exit(overall === 'passed' ? 0 : overall === 'blocked' ? 3 : 2)
}

main().catch((e) => { console.error(e); process.exit(1) })
