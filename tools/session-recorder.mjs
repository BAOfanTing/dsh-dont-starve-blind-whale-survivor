// 旁路会话记录器 CLI（SURVIVAL-02.1）。
// 核心实现已搬到 lib/session-log.js —— 插件发布包的 files 只含 lib/，
// tools/ 不会被打包，插件必须从 lib 里 import。这里只保留命令行入口，
// 并 re-export 给单测用（tests/session-recorder.test.mjs 从本文件导入）。
//
// 用法：
//   node tools/session-recorder.mjs --bridgeDir "<.../Cluster_2/Master/save>" \
//        --serverLog "<.../Cluster_2/Master/server_log.txt" \
//        --chat "<.../Cluster_2/Master/backup/server_chat_log" \
//        --out .runtime/session-record.jsonl --seconds 1800 --from-start
//
//   --note "文字"   只插入一条人工标注后退出
//   --once          只扫描一次后退出（测试用）
//   --from-start    连已有的历史日志行也收进来（默认只收启动后的新行）
//
// 产物：<out>.jsonl（结构化，每行一个事件） + 同名 .txt（一行一条，人眼直接看）。
//
// 注意：这个 CLI 是**增量追加**模式（历史排查用）；插件内置的 SessionLog 才是
// 「每次覆盖写」模式，见 lib/session-log.js。

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SessionRecorder, parseArgs } from '../lib/session-log.js'

export { SessionRecorder, parseArgs, stripKlei, eventsToText, decodeLogBytes, DEFAULT_LOG_RE } from '../lib/session-log.js'

function main() {
  const args = parseArgs(process.argv.slice(2))
  const recorder = new SessionRecorder({
    bridgeDir: args.bridgeDir,
    serverLog: args.serverLog,
    chat: args.chat,
    out: args.out,
    fromStart: args['from-start'] === true,
    stateEveryMs: args.stateEvery ? Number(args.stateEvery) : 5000,
  })

  if (args.note) { recorder.note(String(args.note)); return }
  if (args.once) { recorder.tick(); console.log(`recorded ${recorder.events.length} events -> ${recorder.out}`); return }

  const seconds = Number(args.seconds || 1800)
  recorder.start(Number(args.interval || 500))
  console.log(`[recorder] running ${seconds}s -> ${recorder.out} (${recorder.txtOut})`)
  setTimeout(() => {
    recorder.stop()
    console.log(`[recorder] done, ${recorder.events.length} events`)
  }, seconds * 1000).unref()
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void fileURLToPath(import.meta.url) // 保持与旧版相同的 import 面
  main()
}
