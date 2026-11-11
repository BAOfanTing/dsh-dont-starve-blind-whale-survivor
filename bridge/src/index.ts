// 入口：装日志 tail → 校验记录 → 喂给状态仓库 → 起 HTTP
//
// 用法：
//   npm run build && node dist/src/index.js
//   或：BWS_PORT=18081 node dist/src/index.js
//
// 环境变量见 src/config.ts 顶部说明。

import { existsSync } from 'node:fs'
import { loadConfig } from './config.js'
import { LogTailer } from './logTailer.js'
import { createValidator, validateRecord, type WireRecord } from './record.js'
import { createBridgeServer } from './server.js'
import { StateStore } from './store.js'

const VERSION = '0.1.0'

function main(): void {
  const config = loadConfig()
  const log = (level: string, message: string) => console.log(`[${new Date().toISOString()}] ${level} ${message}`)

  if (!config.logDir || !existsSync(config.logDir)) {
    log('warn', `找不到日志目录：${config.logDir || '(空)'}`)
    log('warn', '用 BWS_LOG_DIR 指定 Klei\\DoNotStarveTogether 目录后重试')
  }
  if (!existsSync(config.schemaPath)) {
    log('warn', `找不到 schema：${config.schemaPath}（记录将不做校验）`)
  }

  const validate = existsSync(config.schemaPath) ? createValidator(config.schemaPath) : null
  const store = new StateStore({ maxTickGap: config.maxTickGap })

  const tailer = new LogTailer({
    logDir: config.logDir,
    files: config.logFiles,
    pollMs: config.pollMs,
    onRecord: (record: WireRecord) => {
      const checked = validate ? validateRecord(validate, record) : { record }
      store.apply(record, checked.errors)
    },
    onParseFail: (info) => log('debug', `跳过坏行（${info.file}）：${info.reason} ${info.detail ?? ''}`.trim()),
  })

  const server = createBridgeServer({ config, store, tailer, version: VERSION })

  server.listen(config.port, config.host, () => {
    log('info', `Bridge 已启动：http://${config.host}:${config.port}/health`)
    log('info', `日志目录：${config.logDir}`)
    log('info', `跟的文件：${config.logFiles.join(', ')}（轮询 ${config.pollMs}ms）`)
    tailer.start()
  })

  const shutdown = (signal: string) => {
    log('info', `收到 ${signal}，收工`)
    tailer.stop()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main()
