#!/usr/bin/env node
// 全自动游玩测试闭环 —— 主控编排。
//
//   静态门禁 → 环境重置(可选) → 分层真机测试(可选) → Oracle 压缩报告
//            → 健康分评分/回滚 → 护栏审计 → (可选)调用 Coding Agent → 下一轮
//
// 安全默认（重要）：
//   · 默认是「dry」模式：只跑静态门禁（lint/check:docs/test）+ 对**现有** latestLogs 做 Oracle 分析，
//     不重启游戏、不 git commit/rollback、不调 Coding Agent。
//   · 真正动游戏 / 改 git / 叫 Agent，必须显式 --live / --allow-git / --agent-cmd。
//   · git 回滚只在 --allow-git 时发生，且只在「分数下降/护栏失守」时执行 —— 绝不无声毁数据。
//
// 用法：
//   node tools/auto-dev-loop.mjs                     # dry：静态 + 分析现有日志，产出摘要
//   node tools/auto-dev-loop.mjs --dry-run           # 同上（显式）
//   node tools/auto-dev-loop.mjs --live --golden-save <dir> --server-reset-cmd "..." --max-steps 40
//   node tools/auto-dev-loop.mjs --live --allow-git --agent-cmd "claude -p"
//
// 退出码：0 全绿；2 有故障/需人工；1 脚本自身出错。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { analyzeDirectory, renderSummary } from '../lib/autodev/session-oracle.js'
import { auditDiff, evaluateIteration } from '../lib/autodev/guardrails.js'
import { GameBridge } from '../lib/bridge.js'
import { SessionRecorder, resolveLogSources } from '../lib/session-log.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOG_DIR = path.join(ROOT, 'latestLogs')
const RUNTIME = path.join(ROOT, '.runtime')

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
const LIVE = ARGS.live === true
const ALLOW_GIT = ARGS['allow-git'] === true && !ARGS['dry-run']
const MAX_ITERS = ARGS['dry-run'] ? 1 : Number(ARGS.iterations || 5)
const MAX_STAGNANT = Number(ARGS['max-stagnant'] || 2)

function runCmd(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: true, timeout: opts.timeoutMs || 600000 })
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim()
  return { ok: res.status === 0, code: res.status, tail: out.split('\n').slice(-25).join('\n') }
}

function git(args) {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return { ok: res.status === 0, code: res.status, out: `${res.stdout || ''}${res.stderr || ''}`.trim() }
}

// ── 边跑边录：LIVE 时用 SessionRecorder 捕获本轮真机事件，Oracle 才能分析「这一轮」
let _recorder = null
let _recSources = null
function startRecording() {
  try {
    const bridge = new GameBridge({ log: () => {} })
    const src = resolveLogSources(bridge)
    if (!src) { console.log('   ⚠ 找不到日志源，本轮 Oracle 将分析已有 latestLogs'); return }
    fs.mkdirSync(LOG_DIR, { recursive: true })
    for (const n of ['session.jsonl', 'session.txt']) { try { fs.rmSync(path.join(LOG_DIR, n)) } catch {} }
    _recorder = new SessionRecorder({
      bridgeDir: src.bridgeDir, serverLog: src.serverLog, chat: src.chat,
      out: path.join(LOG_DIR, 'session.jsonl'), fromStart: false, stateEveryMs: 5000,
    })
    _recorder.start(500)
    _recSources = src
    console.log(`   记录器已启动：${src.bridgeDir}`)
  } catch (e) {
    console.log(`   ⚠ 记录器启动失败：${e?.message ?? e}`)
  }
}
async function stopRecording() {
  if (!_recorder) return
  await new Promise((r) => setTimeout(r, 4000))
  try { _recorder.stop() } catch {}
  try {
    if (_recSources?.serverLog && fs.existsSync(_recSources.serverLog)) {
      const raw = fs.readFileSync(_recSources.serverLog)
      const buf = raw.length > 120000 ? raw.subarray(raw.length - 120000) : raw
      fs.writeFileSync(path.join(LOG_DIR, 'server_log.txt'), buf)
    }
  } catch { /* ignore */ }
  console.log('   记录器已停止，日志已写入 latestLogs/')
  _recorder = null
}

// ── 第 1 步：静态 + 单测快检（10s~40s 拦截低级错误）
function runStaticGate() {
  console.log('① 静态与单测快检…')
  const lint = runCmd('npm', ['run', 'lint'])
  if (!lint.ok) return { ok: false, stage: 'lint', tail: lint.tail }
  const docs = runCmd('npm', ['run', 'check:docs'])
  if (!docs.ok) return { ok: false, stage: 'check:docs', tail: docs.tail }
  const test = runCmd('npm', ['test'])
  if (!test.ok) return { ok: false, stage: 'test', tail: test.tail }
  console.log('   ✅ lint / check:docs / test 全绿')
  return { ok: true }
}

// ── 第 2 步：环境重置（仅 --live）
function resetEnvironment() {
  console.log('② 环境重置与热加载…')
  const mod = runCmd('node', ['tools/install-mod.mjs'])
  console.log(`   install-mod：${mod.ok ? 'OK' : '失败'} ${mod.tail.split('\n').slice(-1)[0] || ''}`)
  if (ARGS['golden-save']) {
    const src = ARGS['golden-save']
    const dst = ARGS['save-target'] || path.join(LOG_DIR)
    console.log(`   还原黄金存档：${src} → ${dst}（请确认真实存档目录后再依赖此项）`)
    // 真实覆盖逻辑依赖具体 Cluster 路径，这里只做存在性校验，避免误删用户存档。
    if (!fs.existsSync(src)) console.log('   ⚠ 黄金存档目录不存在，跳过还原')
  } else {
    console.log('   ⚠ 未指定 --golden-save，跳过黄金存档还原（随机地图噪音会保留）')
  }
  if (ARGS['server-reset-cmd']) {
    const r = runCmd(ARGS['server-reset-cmd'], [])
    console.log(`   重启/重置服务器：${r.ok ? 'OK' : '失败'}`)
  } else {
    console.log('   ⚠ 未指定 --server-reset-cmd，跳过自动重启（需人工重开 / c_reset）')
  }
  const unp = runCmd('node', ['tools/unpause.mjs'])
  console.log(`   解除暂停：exit=${unp.code}`)
  return { ok: mod.ok }
}

// ── 第 3 步：分层真机测试（仅 --live；否则对现有日志做静态分析）
function runTierSuite() {
  const args = ['tools/run-e2e-suite.mjs', '--json']
  if (ARGS['dry-run']) args.push('--dry-run')
  if (ARGS.bridgeDir) args.push('--bridgeDir', ARGS.bridgeDir)
  if (ARGS['max-steps']) args.push('--max-steps', String(ARGS['max-steps']))
  if (ARGS.injector) args.push('--injector', ARGS.injector)
  if (ARGS['ai-runner']) args.push('--ai-runner', ARGS['ai-runner'])
  const res = runCmd('node', args)
  let parsed = null
  try { parsed = JSON.parse(res.tail) } catch { /* 末行可能是 JSON，交给下面兜底 */ }
  return { ok: res.ok, code: res.code, report: parsed, tail: res.tail }
}

// ── 第 4 步：Oracle 分析
function runOracle() {
  console.log('④ 故障检测与报告压缩（Oracle）…')
  if (!fs.existsSync(path.join(LOG_DIR, 'session.jsonl'))) {
    console.log('   ⚠ latestLogs/session.jsonl 不存在，跳过分析（真机跑过一轮后才有）')
    return { report: null, criticalCount: 0, score: 0 }
  }
  const opts = {}
  if (ARGS['max-steps']) opts.budgetSteps = Number(ARGS['max-steps'])
  const report = analyzeDirectory(LOG_DIR, opts)
  fs.mkdirSync(RUNTIME, { recursive: true })
  fs.writeFileSync(path.join(RUNTIME, 'issue-report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log(renderSummary(report).split('\n').map((l) => '   ' + l).join('\n'))
  return { report, criticalCount: report.summary.criticalCount, s2: report.summary.s2, score: report.summary.score }
}

function writeSummary(state) {
  const lines = []
  lines.push('# AUTODEV_SUMMARY')
  lines.push('')
  lines.push(`- 模式：${LIVE ? 'LIVE（会动游戏）' : 'dry（只静态+分析现有日志）'}`)
  lines.push(`- 结束时间：${new Date().toISOString()}`)
  lines.push(`- 最终动作：**${state.finalAction}** — ${state.finalReason}`)
  lines.push(`- 最佳健康分：${state.bestScore === -Infinity ? '-' : state.bestScore}`)
  lines.push('')
  lines.push('## 各轮结果')
  lines.push('')
  lines.push('| 轮次 | 单测 | 严重故障 | S2目标未达 | 健康分 | 决策 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const it of state.history) {
    lines.push(`| ${it.iter} | ${it.unitOk ? '✅' : '❌'} | ${it.criticalCount} | ${it.s2 ?? 0} | ${it.score} | ${it.action} |`)
  }
  if (state.topFaults?.length) {
    lines.push('')
    lines.push('## Top 故障（先修这些）')
    lines.push('')
    for (const f of state.topFaults.slice(0, 5)) lines.push(`- [${f.severity}] ${f.code}: ${f.title}`)
  }
  lines.push('')
  lines.push('## 下一步')
  if (!LIVE) {
    lines.push('- 这是 dry 运行。要真正跑真机闭环：`node tools/auto-dev-loop.mjs --live --golden-save <黄金存档> --server-reset-cmd "<重启命令>" --max-steps 40`')
    lines.push('- 要开启自动修复：追加 `--allow-git --agent-cmd "claude -p"`（或在 CI 里换成 codex）。')
  } else if (state.finalAction === 'stop') {
    lines.push('- 已自动停机并保留最佳检查点。请人工 Review 本摘要与 `.runtime/issue-report.json`。')
  } else {
    lines.push('- 继续观察或让 Coding Agent 修复 Top 1 根因后重跑。')
  }
  const out = ARGS['out-summary'] || path.join(RUNTIME, 'AUTODEV_SUMMARY.md')
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8')
  return out
}

async function main() {
  console.log(`=== 全自动测试闭环（${LIVE ? 'LIVE' : 'dry'}）===`)
  fs.mkdirSync(RUNTIME, { recursive: true })
  const state = { history: [], bestScore: -Infinity, finalAction: '', finalReason: '', topFaults: [] }

  for (let iter = 1; iter <= MAX_ITERS; iter += 1) {
    console.log(`\n──── 第 ${iter}/${MAX_ITERS} 轮 ────`)
    const rec = { iter, unitOk: false, criticalCount: 0, score: 0, action: '' }

    const staticRes = runStaticGate()
    rec.unitOk = staticRes.ok
    if (!staticRes.ok) {
      const d = evaluateIteration({ iter, maxIters: MAX_ITERS, score: -Infinity, bestScore: state.bestScore, unitOk: false })
      rec.action = d.action
      console.log(`   ❌ 静态门禁未过（${staticRes.stage}）：${staticRes.tail}`)
      state.history.push(rec)
      state.finalAction = d.action
      state.finalReason = d.reason
      if (!ARGS['agent-cmd']) break
      await maybeInvokeAgent(staticRes)
      continue
    }

    if (LIVE && !ARGS['skip-reset']) resetEnvironment()

    let tierOk = true
    let tierReport = null
    if (LIVE) {
      if (!ARGS['no-record']) startRecording()
      const t = runTierSuite()
      tierOk = t.ok
      tierReport = t.report
      if (!ARGS['no-record']) await stopRecording()
      console.log(`③ 分层测试：${t.ok ? '通过' : '有失败'}`)
    }

    const orc = runOracle()
    rec.criticalCount = orc.criticalCount
    rec.s2 = orc.s2 ?? 0
    rec.score = orc.score
    state.topFaults = orc.report?.faults ?? []

    // 护栏审计（仅当 git 可用且有改动时）
    let guardrailOk = true
    if (ALLOW_GIT) {
      const diff = git(['--no-color', 'diff', 'HEAD'])
      if (diff.ok && diff.out) {
        const audit = auditDiff(diff.out)
        guardrailOk = audit.ok
        if (!audit.ok) console.log(`   ❌ 护栏失守：${audit.violations.map((v) => v.code).join(', ')}`)
        if (audit.touchedProtected.length) console.log(`   ⚠ 本轮碰了核心文件：${audit.touchedProtected.join(', ')}（须确保专项测试全绿）`)
      }
    }

    const decision = evaluateIteration({
      iter, maxIters: MAX_ITERS, score: rec.score, bestScore: state.bestScore,
      unitOk: rec.unitOk, guardrailOk, stagnantRounds: state.stagnantRounds ?? 0, maxStagnant: MAX_STAGNANT,
    })
    state.stagnantRounds = decision.stagnantRounds ?? 0
    rec.action = decision.action
    state.history.push(rec)

    // git 提交/回滚（仅 --allow-git）
    if (ALLOW_GIT) applyGit(decision)

    if (decision.action === 'commit') state.bestScore = decision.bestScore

    // 全绿且无严重故障、也无「目标未达」→ 结束
    const allGreen = orc.criticalCount === 0 && (orc.s2 ?? 0) === 0 && tierOk
    if (allGreen) {
      state.finalAction = 'commit'
      state.finalReason = '全链路通过：静态+单测绿、真机测试无严重故障'
      console.log('   ✅ 全链路通过！')
      if (ALLOW_GIT) git(['add', '-A']) && git(['commit', '-m', `test(auto): iter ${iter} all green`])
      break
    }

    state.finalAction = decision.action
    state.finalReason = decision.reason
    console.log(`   决策：${decision.action} — ${decision.reason}`)

    if (decision.action === 'stop') break
    if (!ARGS['agent-cmd']) {
      state.finalAction = 'report_only'
      state.finalReason = `已产出 issue-report（严重故障 ${orc.criticalCount}、S2 ${orc.s2 ?? 0}）；未配置 --agent-cmd，停在人工修复阶段`
      console.log('   ℹ 未配置 --agent-cmd，停在报告阶段（可人工按 issue-report 修复后重跑）。')
      break
    }
    await maybeInvokeAgent(orc.report)
  }

  const summaryPath = writeSummary(state)
  console.log(`\n摘要已写入：${summaryPath}`)
  if (ARGS.json) process.stdout.write(JSON.stringify({ ...state, summaryPath }, null, 2) + '\n')
  const last = state.history.at(-1)
  const okGreen = state.finalAction === 'commit' && last?.criticalCount === 0 && (last?.s2 ?? 0) === 0
  process.exit(okGreen ? 0 : 2)
}

function applyGit(decision) {
  if (decision.action === 'commit') {
    git(['add', '-A'])
    const r = git(['commit', '-m', `wip(auto): score=${decision.bestScore ?? ''}`])
    console.log(`   git commit：${r.ok ? 'OK' : r.out.split('\n')[0]}`)
  } else if (decision.action === 'rollback') {
    const r = git(['reset', '--hard', 'HEAD'])
    console.log(`   git reset --hard：${r.ok ? 'OK' : r.out.split('\n')[0]}`)
  }
}

async function maybeInvokeAgent(report) {
  const cmd = ARGS['agent-cmd']
  if (!cmd) return
  console.log(`   调用 Coding Agent：${cmd}`)
  const promptFile = path.join(ROOT, 'tools', 'prompts', 'autofix-agent.md')
  const reportPath = path.join(RUNTIME, 'issue-report.json')
  // 具体 CLI 参数因 agent 而异，这里给出通用约定：环境变量传入报告路径与提示词路径。
  const res = spawnSync(cmd, [], {
    cwd: ROOT, shell: true, encoding: 'utf8', timeout: 1800000,
    env: { ...process.env, BWS_ISSUE_REPORT: reportPath, BWS_PROMPT_FILE: promptFile },
  })
  console.log(`   Agent 退出码：${res.status}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
