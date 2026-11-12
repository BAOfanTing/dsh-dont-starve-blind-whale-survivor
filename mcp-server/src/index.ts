// Phase 3 MCP Server 入口（M1）
//
// 用法：
//   node dist/src/index.js                        # stdio（默认，MCP 客户端拉起子进程时用）
//   BWS_MCP_TRANSPORT=http node dist/src/index.js # Streamable HTTP（M5 实现）
//
// 环境变量：
//   BWS_BRIDGE_URL       Game Bridge 地址（默认 http://127.0.0.1:18788）
//   BWS_TOKEN / BWS_TOKEN_FILE   共享 token（默认读 .runtime/token.txt）
//   BWS_TOOL_TIMEOUT_MS  单个工具超时（默认 5000）
//   BWS_MCP_LOG          debug|info|warn|error（默认 info）
//   BWS_MCP_HOST/PORT    HTTP 传输监听（默认 127.0.0.1:8790，M5 启用）

import { loadConfig } from './config.js'
import { createGameToolService } from './server/createServer.js'
import { startStdioServer } from './transports/stdio.js'
import { createHttpTransport } from './transports/http.js'
import { createLogger } from './utils/logger.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger({ level: config.logLevel, secrets: [config.token] })

  logger.info('Blind Whale Survivor MCP Server 启动', {
    version: '0.3.0-m1',
    transport: config.transport,
    bridge_url: config.bridgeUrl,
    token_source: config.tokenSource,
    tool_timeout_ms: config.toolTimeoutMs,
  })
  if (config.tokenSource === 'missing') {
    logger.warn('没有找到 token：只读查询会失败', {
      hint: '用 BWS_TOKEN 指定，或先跑 node tools/write-bws-config.mjs',
    })
  }

  const service = createGameToolService(config, logger)

  if (config.transport === 'http') {
    if (config.token.length === 0) {
      logger.error('拒绝启动：HTTP 传输必须配 token（不允许裸奔）', {
        hint: '用 BWS_TOKEN 指定，或先跑 node tools/write-bws-config.mjs',
      })
      process.exit(2)
    }
    const transport = createHttpTransport(service, config, logger, {
      host: config.httpHost,
      port: config.httpPort,
      token: config.token,
    })
    try {
      const port = await transport.listen()
      logger.info('Streamable HTTP 传输已就绪', {
        url: `http://${config.httpHost}:${port}`,
        health: `http://${config.httpHost}:${port}/healthz`,
        note: '只监听本机；需要 Bearer token；Host/Origin 已校验',
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (code === 'EADDRINUSE') {
        logger.error(`端口 ${config.httpPort} 已被占用`, { hint: '换端口：set BWS_MCP_PORT=8791' })
      } else {
        logger.error('HTTP 传输启动失败：' + String((error as Error)?.message ?? error))
      }
      process.exit(2)
    }
    const shutdown = (signal: string) => {
      logger.info(`收到 ${signal}，关闭 HTTP 传输`)
      void transport.close().then(() => process.exit(0))
      setTimeout(() => process.exit(0), 2000).unref()
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    return
  }

  const handle = await startStdioServer(service, logger)

  const shutdown = (signal: string) => {
    logger.info(`收到 ${signal}，关闭 MCP Server`)
    void handle.close().then(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  // 启动失败也要走 stderr，别污染 stdout
  process.stderr.write(`[bws-mcp] ERROR 启动失败：${String((error as Error)?.stack ?? error)}\n`)
  process.exit(1)
})
