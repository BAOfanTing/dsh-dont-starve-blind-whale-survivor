// Phase 2 Bridge 入口（M1）
//
// 启动：
//   npm run build && node dist/src/index.js
//   powershell -ExecutionPolicy Bypass -File ..\start-game-bridge.ps1
//
// 环境变量见 src/config.ts。

import { loadConfig, maskToken } from './config.js'
import { createLogger } from './logger.js'
import { createBridgeServer } from './server.js'
import { CommandQueue } from './commands.js'
import { saveStateFile, loadStateFile } from './persist.js'
import { SessionManager } from './session.js'
import { BridgeState } from './state.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger({ secrets: [config.token] })
  const state = new BridgeState()
  const sessions = new SessionManager()
  const commands = new CommandQueue()

  // 恢复上次的状态：会话（含 sequence 记账）+ 命令队列
  const restored = loadStateFile(config.stateFile)
  if (restored.ok && restored.state) {
    const sessionCount = sessions.restore(restored.state.sessions as never)
    const commandCount = commands.restore(restored.state.commands as never)
    const pending = commands.pendingCount()
    logger.info('已恢复上次的状态', {
      state_file: config.stateFile,
      sessions: sessionCount,
      commands: commandCount,
      queued_commands: pending,
      saved_at: restored.state.savedAt,
    })
  } else {
    logger.info('没有可恢复的状态（首次启动或文件不可用）', { state_file: config.stateFile, reason: restored.reason })
  }

  const handle = createBridgeServer({ config, logger, state, sessions, commands })

  const saveNow = (why: string) => {
    const result = saveStateFile(config.stateFile, sessions.export(), commands.export())
    if (!result.ok) {
      logger.warn('状态落盘失败（只影响重启后恢复）', { why, error: result.error })
    }
    return result
  }
  const saveTimer = setInterval(() => saveNow('interval'), config.saveIntervalMs)
  if (typeof saveTimer.unref === 'function') saveTimer.unref()

  try {
    const port = await handle.listen()
    config.port = port
    logger.info(`Bridge 已启动，监听 http://${config.host}:${port}（只本机）`, {
      protocol_version: config.protocolVersion,
      version: '0.2.0-m5',
    })
    logger.info('Token 已就绪（不写日志）', {
      token_source: config.tokenSource,
      token_mask: maskToken(config.token),
      token_file: config.tokenSource === 'generated' ? config.tokenFile : '(使用环境变量)',
    })
    logger.info(
      '请求体上限 ' + config.maxBodyBytes + ' 字节；接口：GET /health、GET /api/v1/bridge/status、'
      + 'POST /api/v1/heartbeat、POST /api/v1/telemetry、POST /api/v1/commands/{poll,result}',
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (code === 'EADDRINUSE') {
      logger.error(`端口 ${config.port} 已被占用，Bridge 起不来`, { hint: '换端口：set BWS_PORT=18888，或停掉占用该端口的进程' })
    } else if (code === 'EACCES') {
      logger.error(`没有权限监听 ${config.host}:${config.port}`, { hint: '换一个空闲端口' })
    } else {
      logger.error('Bridge 启动失败：' + String((error as Error)?.message ?? error))
    }
    process.exit(2)
  }

  const shutdown = (signal: string) => {
    logger.info(`收到 ${signal}，正在关闭 Bridge`)
    clearInterval(saveTimer)
    saveNow('shutdown')
    void handle.close().then(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

void main()
