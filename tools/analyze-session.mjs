#!/usr/bin/env node
// 会话日志质检 CLI（Oracle）：把 latestLogs 压成 issue-report.json。
//
// 用法：
//   node tools/analyze-session.mjs                       # 分析 latestLogs/ → .runtime/issue-report.json
//   node tools/analyze-session.mjs --dir latestLogs
//   node tools/analyze-session.mjs --jsonl path/session.jsonl --server-log path/server_log.txt
//   node tools/analyze-session.mjs --out .runtime/issue-report.json --budget-steps 40 --json
//
// 退出码：
//   0  无严重故障（S0/S1 == 0）
//   2  有严重故障（S0 崩溃/死亡 或 S1 卡死/状态失真）
//   1  脚本自身出错
//
// 这是一个「纯确定性」脚本：只读日志，不联网、不调模型、不碰游戏。

import fs from 'node:fs'
import path from 'node:path'
import { analyzeSession, readSessionJsonl, readServerLog, renderSummary } from '../lib/autodev/session-oracle.js'

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

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dir = args.dir || 'latestLogs'
  const jsonlPath = args.jsonl || path.join(dir, 'session.jsonl')
  const serverLogPath = args['server-log'] || path.join(dir, 'server_log.txt')
  const outPath = args.out || path.join('.runtime', 'issue-report.json')

  if (!fs.existsSync(jsonlPath)) {
    console.error(`✗ 找不到 session.jsonl：${jsonlPath}`)
    console.error('  先跑一次真机测试（latestLogs/ 由插件 SessionLog 覆盖写），或用 --jsonl 指定路径。')
    process.exit(1)
  }

  const { events, bad } = readSessionJsonl(jsonlPath)
  const serverLog = readServerLog(serverLogPath)

  const opts = {}
  if (args['budget-steps'] != null) opts.budgetSteps = Number(args['budget-steps'])
  if (args['stale-ms'] != null) opts.staleMs = Number(args['stale-ms'])
  if (args['context-radius'] != null) opts.contextRadius = Number(args['context-radius'])
  if (args['max-bytes'] != null) opts.maxReportBytes = Number(args['max-bytes'])

  if (bad > 0) console.error(`⚠ 跳过了 ${bad} 行无法解析的日志（可能是正在写入的尾行）`)

  const report = analyzeSession({ events, serverLog }, opts)

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8')

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    console.log(renderSummary(report))
    console.log(`  报告已写入：${outPath}（约 ${(fs.statSync(outPath).size / 1024).toFixed(1)} KB）`)
  }

  process.exit(report.summary.criticalCount === 0 ? 0 : 2)
}

main()
