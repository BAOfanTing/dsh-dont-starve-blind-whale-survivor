#!/usr/bin/env node
/**
 * 长跑日志同步器（只读游戏侧文件，绝不写回游戏）。
 *
 * 用法：
 *   node tools/sync-longrun-logs.mjs                                  # 只同步
 *   node tools/sync-longrun-logs.mjs --note "gather_area grass -> ok 3"  # 同步 + 记一条操作
 *   node tools/sync-longrun-logs.mjs --note "..." --tag ANALYSIS          # 记一条分析
 *
 * latestLogs/ 只保留 4 份（其余都是同一份数据的副本，已删）：
 *   session.txt       记录器输出：人可读会话时间线（CMD/RESULT/REFLEX/DEATH/STATE）
 *   session.jsonl     记录器输出：同上的结构化版本（脚本分析用）
 *   server_log.txt    游戏服务端原始日志（反射诊断、Spawn/Deleting 都在这）
 *   notes.md          我每次操作与分析结论（--note 追加）
 *
 * 记录器由独立后台进程持续写 session.*；本脚本只负责同步 server_log.txt 与追加 notes.md。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'latestLogs')

const DEFAULT_KLEI = 'C:\\Users\\BAOfanTing\\OneDrive\\文档\\Klei\\DoNotStarveTogether\\893016408\\Cluster_2\\Master'

function parseArgs(argv) {
  const out = { note: null, tag: null, klei: DEFAULT_KLEI }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--note' && argv[i + 1]) out.note = argv[++i]
    else if (argv[i] === '--tag' && argv[i + 1]) out.tag = argv[++i]
    else if (argv[i] === '--klei' && argv[i + 1]) out.klei = argv[++i]
    else if (argv[i] === '--help') out.help = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('node tools/sync-longrun-logs.mjs [--note "记录"] [--tag ANALYSIS] [--klei <Cluster Master 目录>]')
  process.exit(0)
}

fs.mkdirSync(OUT, { recursive: true })

const serverLog = path.join(args.klei, 'server_log.txt')
let logCopy = { copied: false }
try {
  if (fs.existsSync(serverLog)) {
    fs.copyFileSync(serverLog, path.join(OUT, 'server_log.txt'))
    logCopy = { copied: true, bytes: fs.statSync(path.join(OUT, 'server_log.txt')).size }
  } else logCopy = { copied: false, reason: 'missing' }
} catch (e) {
  logCopy = { copied: false, reason: String(e.message || e) }
}

// 从桥文件读一份精简状态，纯用于本次 --note 的上下文（不落盘成单独文件）
function readBridgeJson(file) {
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^KLEI\s+\d+\s*/, ''))
  } catch { return null }
}
const state = readBridgeJson(path.join(args.klei, 'save', 'whale_state.json'))
const d = state?.data || {}
const w = d.world || {}
const p = d.player || {}
const hp = p.health?.current ?? null
const hunger = p.hunger?.current ?? null
const sanity = p.sanity?.current ?? null
const rawItems = p.inventory?.items
const itemList = Array.isArray(rawItems) ? rawItems : Object.values(rawItems || {})
const inv = itemList.map((it) => `${it?.prefab ?? '?'}×${it?.count ?? 1}`).join(',')

const ts = new Date().toISOString()
let noteLine = null
if (args.note) {
  const label = args.tag === 'ANALYSIS' ? '分析' : '操作'
  const ctx = `day${w.day ?? '?'} ${w.phase ?? '?'} hp${hp ?? '?'} hunger${hunger ?? '?'} sanity${sanity ?? '?'} inv[${inv}]`
  noteLine = `- [${ts}] [${label}] ${args.note}  \`\`${ctx}\`\`\n`
  try { fs.appendFileSync(path.join(OUT, 'notes.md'), noteLine) } catch { /* ignore */ }
}

console.log(JSON.stringify({
  ok: true, ts, out: OUT, serverLog: logCopy,
  context: { day: w.day ?? null, phase: w.phase ?? null, hp, hunger, sanity, inv, dead: d.dead ?? null },
  noteWritten: Boolean(noteLine),
}, null, 2))
