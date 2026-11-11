// stdio 传输（M1 唯一启用的传输）
//
// 规矩：
//   · stdout **只**走 MCP JSON-RPC；日志一律 stderr；
//   · 连接生命周期 = 进程生命周期；
//   · 配置从环境变量来（客户端拉起子进程时传）。

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { createMcpServer, type GameToolService } from '../server/createServer.js'
import type { Logger } from '../utils/logger.js'

export interface StdioHandle {
  close(): Promise<void>
}

export async function startStdioServer(service: GameToolService, logger: Logger): Promise<StdioHandle> {
  const server = createMcpServer(service, logger)
  const transport = new StdioServerTransport(undefined, undefined, {
    // 单条消息上限，防止异常大的请求把进程吃满
    maxBufferSize: 4 * 1024 * 1024,
  })
  await server.connect(transport)
  logger.info('stdio 传输已就绪（stdout 仅用于 MCP 协议）')
  return {
    close: async () => {
      await server.close()
    },
  }
}
