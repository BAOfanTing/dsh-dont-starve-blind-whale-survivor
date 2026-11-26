// dsh-dont-starve-blind-whale-survivor：在 DSH 里让 AI 玩《饥荒联机版》
//
// 职责：组装桥接层、控制权租约、停止协调器、规划器、MCP 服务、内置 AI 与 DSH 宿主适配。

import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installMod } from './mod-install.js'
import { GameBridge } from './bridge.js'
import { createMcpServer } from './mcp-server.js'
import { ACTION_NAMES, MACRO_NAMES, executeTool, readSnapshot } from './tools.js'
import { AiRunner } from './agent.js'
import { LeaseManager, defaultLeaseFile, envFingerprintOf } from './control.js'
import { createNotesStore } from './notes-store.js'
import { createPlanner } from './planner/planner-core.js'
import { createDispatcher } from './dispatcher.js'
import { WorldRuntimeManager } from './planner/world-runtime-manager.js'
import { StopCoordinator } from './control/stop-coordinator.js'

import {
  BUNDLED_GUIDES,
  Config,
  GUIDE_TOPICS,
  RULES,
  buildInstructions,
  currentConfig,
  guidesOf,
  modSettingsOf,
  toolsForExecutionMode,
  z,
} from './dsh/config.js'
import {
  MCP_SERVER_NAME,
  PRESET_ID,
  mcpClientRow,
  resolveBasePreset,
  setupPreset,
} from './dsh/preset.js'
import {
  GATEWAY_TOOL,
  helpText,
  mcpCall,
  parseSseResult,
  setupGateway,
} from './dsh/gateway.js'
import {
  AUTO_CONTINUE_TEXT,
  extractDshMessage,
  isDstTool,
  registerAutoContinue,
  setupSessionLog,
  setupThinkingPause,
  shouldPauseOnThinking,
} from './dsh/session-hooks.js'

export const name = 'dsh-dont-starve-blind-whale-survivor'

export {
  AUTO_CONTINUE_TEXT,
  BUNDLED_GUIDES,
  Config,
  GATEWAY_TOOL,
  GUIDE_TOPICS,
  MCP_SERVER_NAME,
  PRESET_ID,
  RULES,
  buildInstructions,
  currentConfig,
  extractDshMessage,
  guidesOf,
  helpText,
  isDstTool,
  mcpCall,
  mcpClientRow,
  parseSseResult,
  resolveBasePreset,
  setupGateway,
  setupPreset,
  shouldPauseOnThinking,
  toolsForExecutionMode,
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const notesStore = createNotesStore()
const readNotes = (worldKey) => notesStore.read(worldKey).content
const writeNotes = (text, worldKey) => notesStore.write(text, worldKey)
const planner = createPlanner()

export function apply(ctx, config) {
  const log = (level, msg) => {
    try {
      ctx.logger?.(level, `[${name}] ${msg}`)
    } catch {}
  }
  if (!z) log('warn', '找不到 @deepseek-ai/schemastery，插件页的配置卡片读不到设置；插件按默认设置工作')

  const bridge = new GameBridge({ log, pollMs: 150 })
  let lastSettingsHash = ''
  let inFlight = 0
  let paused = false

  /** 仅在 AI 思考超时且无动作执行时允许暂停；思考结束、动作开始、stop 或退出时立即解冻。 */
  const setPause = (want) => {
    if (paused === want) return
    paused = want
    bridge.setPause(want)
  }

  const dshThinkingSessions = new Map()
  let evaluatePause = () => {}
  const clearDshThinking = () => {
    for (const sess of dshThinkingSessions.values()) {
      sess.thinkingSince = 0
      sess.toolCallsInFlight = 0
    }
  }

  const INSTANCES = {
    f8_agent: randomUUID(),
    mcp_client: randomUUID(),
    manual_test: randomUUID(),
    system: randomUUID(),
  }
  const control = new LeaseManager({
    file: defaultLeaseFile(ROOT),
    authorityDirs: () => (bridge.leaseDirs ? bridge.leaseDirs() : []),
    log,
  })
  bridge.getAuthority = () => control?.readAuthority?.() ?? null

  let sharedPlan = null
  let sessionLog = null
  let currentDshStep = null

  const logBlockedTool = (toolName, args, owner, reason, text, step = null) => {
    const seq = sessionLog?.beginTool({ tool: toolName, args, by: owner, step })
    sessionLog?.endTool({ seq, tool: toolName, by: owner, ok: false, status: 'rejected', reason, ms: 0, text, step })
  }

  const leaseEnv = () => envFingerprintOf(readSnapshot({ bridge }))

  const runTool = async (toolName, args, { internal = false, owner = 'system', ownerInstanceId, withOutcome = false, step = null, signal = null } = {}) => {
    if (!internal && runner.running && (ACTION_NAMES.has(toolName) || toolName === 'advance_task' || toolName === 'run_skill') && toolName !== 'stop') {
      const blocked = '内置 AI 正在自己玩（游戏里按 F8 停掉它），停掉以后再用 DSH 玩'
      logBlockedTool(toolName, args, owner, 'f8_agent_running', blocked)
      return blocked
    }
    const seq = sessionLog?.beginTool({ tool: toolName, args, by: owner, internal, step }) ?? null
    const startedAt = Date.now()
    inFlight++

    // 动作执行前确保世界解冻，以免服务端无法 tick
    evaluatePause()
    void leaseEnv()
    try {
      const c = currentConfig(config)
      const toolCtx = {
        bridge,
        control,
        owner,
        ownerInstanceId: ownerInstanceId ?? INSTANCES[owner] ?? INSTANCES.system,
        notes: { read: readNotes, write: writeNotes },
        guides: guidesOf(config),
        extraInstructions: c.extraInstructions,
        actionTimeoutMs: Number(c.actionTimeoutMinutes) * 60 * 1000,
        signal,
        planner,
        stopCoordinator,
        log,
        executionMode: c.executionMode ?? 'assisted',
        lastPlan: sharedPlan,
        setPlan: (plan) => { sharedPlan = plan },
      }
      const text = await executeTool(toolName, args, toolCtx)
      const outcome = toolCtx.lastOutcome ?? null
      sessionLog?.endTool({
        seq,
        step,
        tool: toolName,
        by: owner,
        ms: Date.now() - startedAt,
        status: outcome?.status ?? null,
        reason: outcome?.reason ?? null,
        ok: outcome ? outcome.status === 'succeeded' : !/^失败[:：]|^Autopilot 模式下不允许/.test(String(text ?? '')),
        text,
      })
      if (!withOutcome) return text
      return { text, outcome }
    } catch (error) {
      sessionLog?.endTool({
        seq, step, tool: toolName, by: owner,
        ok: false, status: 'threw', reason: String(error?.message ?? error),
        ms: Date.now() - startedAt,
        text: '抛错：' + String(error?.stack ?? error),
      })
      throw error
    } finally {
      inFlight--
      evaluatePause()
    }
  }

  const runner = new AiRunner({
    log,
    bridge,
    sessionLog: () => sessionLog,
    settings: () => {
      const c = currentConfig(config)
      return {
        apiKey: String(c.apiKey || process.env.SENSENOVA_API_KEY || process.env.DEEPSEEK_API_KEY || ''),
        baseUrl: c.baseUrl,
        model: c.model,
        maxTokens: c.aiMaxTokens,
      }
    },
    instructions: () => buildInstructions(guidesOf(config), currentConfig(config).executionMode ?? 'assisted'),
    toolList: () => toolsForExecutionMode(config),
    callTool: async (toolName, args, extra = {}) => {
      if (ACTION_NAMES.has(toolName) || MACRO_NAMES.has(toolName) || toolName === 'advance_task' || toolName === 'run_skill') {
        const acq = await control.acquireWithWait('f8_agent', leaseEnv(), {
          ownerInstanceId: INSTANCES.f8_agent,
          readAck: () => (bridge.readLeaseAck ? bridge.readLeaseAck() : null),
          isGameAlive: () => { const s = readSnapshot({ bridge }); return !(s && s.stale) },
        })
        if (acq.waitedMs > 0) log('info', `控制权交接等待 ${acq.waitedMs}ms（${acq.attempts} 次尝试）`)
        if (!acq.ok) {
          const denied = `失败：控制权不在手上（${acq.reason}）（control_denied）`
          logBlockedTool(toolName, args, 'f8_agent', acq.reason ?? 'control_denied', denied)
          return denied
        }
      }
      return runTool(toolName, args, {
        internal: true,
        owner: 'f8_agent',
        ownerInstanceId: INSTANCES.f8_agent,
        withOutcome: true,
        step: extra?.step ?? null,
      })
    },
    onStatus: () => { evaluatePause(); publishHud() },
    onSelfStop: (reason) => { setPause(false); try { stopCoordinator.requestStop({ source: 'agent_idle', reason }) } catch {} },
  })

  const stopDispatcher = createDispatcher({
    bridge,
    control,
    readSnapshot: (c) => readSnapshot(c),
    log,
    readLeaseAck: () => (bridge.readLeaseAck ? bridge.readLeaseAck() : null),
  })
  const getActiveRuntime = () => {
    try {
      const snap = readSnapshot({ bridge })
      if (!snap) return null
      const worldKey = snap.identity ? snap.identity.worldKey : null
      return WorldRuntimeManager.getOrCreate({
        worldKey,
        store: planner.store,
        dispatcher: stopDispatcher,
        readSnapshot: () => readSnapshot({ bridge }),
        guardBuild: (recipe, sn) => (planner && typeof planner.guardBuild === 'function' ? planner.guardBuild(recipe, sn) : null),
        readAuthority: () => (control.readAuthority ? control.readAuthority() : null),
        log: (level, msg) => { try { log(level, msg) } catch {} },
      })
    } catch { return null }
  }
  const stopCoordinator = new StopCoordinator({
    control,
    getRuntime: getActiveRuntime,
    getAgent: () => runner,
    readAuthority: () => (control.readAuthority ? control.readAuthority() : null),
    runtimeStop: (opts) => {
      const rt = getActiveRuntime()
      if (!rt || typeof rt.stop !== 'function') return Promise.resolve({ status: 'succeeded', lock_released: true, command_id: null, detail: 'no_runtime' })
      return rt.stop(opts)
    },
    releaseLease: async ({ holder }) => {
      if (holder && holder.owner) control.release(holder.owner, { ownerInstanceId: holder.ownerInstanceId })
    },
    isLockReleased: () => { const rt = getActiveRuntime(); return !rt || !rt.currentLockOwner },
    log: (level, msg) => { try { log(level, msg) } catch {} },
  })

  // 租约续租心跳：多步复合技能/任务推进期间定期续租，防止 TTL 到期导致后续动作被拒
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        if (!runner.running && inFlight <= 0) return
        const snap = readSnapshot({ bridge })
        if (!snap || snap.stale) return
        const auth = control.readAuthority ? control.readAuthority() : null
        if (!auth || auth.status !== 'active') return
        const owner = auth.owner_type
        const wantInst = owner === 'f8_agent' ? INSTANCES.f8_agent : (owner === 'mcp_client' ? INSTANCES.mcp_client : null)
        if (!wantInst || auth.owner_instance_id !== wantInst) return
        const acq = control.acquire(owner, leaseEnv(), { ownerInstanceId: wantInst })
        if (!acq.ok) log('warn', `${owner} 租约续租失败：${acq.reason}`)
      } catch {}
    }, 8000)
    return () => clearInterval(timer)
  })

  const publishHud = () => {
    try {
      const c = currentConfig(config)
      const status = runner.status()
      const game = bridge.status()
      const clip = (text, n = 26) => {
        const s = String(text ?? '').replace(/\s+/g, ' ').trim()
        return s.length > n ? s.slice(0, n) + '…' : s
      }
      const lines = []
      if (!game.connected) lines.push('游戏没连上（模组没装好 / 还没进世界）')
      if (status.error) lines.push(clip(status.error, 34))
      if (status.running) {
        lines.push(status.action ? `正在做：${clip(status.action, 22)}` : '思考中…')
      } else {
        const hasKey = Boolean(c.apiKey || process.env.SENSENOVA_API_KEY || process.env.DEEPSEEK_API_KEY)
        lines.push(hasKey ? 'F8 让它自己玩' : '没配 API Key（插件设置里填）')
      }
      if (status.result && !status.running) lines.push(`上次：${clip(status.result)}`)
      else if (status.result) lines.push(`结果：${clip(status.result)}`)
      lines.push('F8 开始/停止 · F7 显隐')
      bridge.writeHud({ v: 1, ai: status.running, step: status.step, lines })
    } catch {}
  }

  const server = createMcpServer({
    log,
    bridge,
    settings: () => {
      const c = currentConfig(config)
      return {
        port: c.port,
        gameDir: c.gameDir,
        actionTimeoutMinutes: c.actionTimeoutMinutes,
        freezeTime: c.freezeTime,
        idleSeconds: c.idleSeconds,
        extraInstructions: c.extraInstructions,
        executionMode: c.executionMode,
      }
    },
    toolList: () => toolsForExecutionMode(config),
    instructions: () => buildInstructions(guidesOf(config), currentConfig(config).executionMode ?? 'assisted'),
    executeTool: async (toolName, args, extra = null) => {
      // 只读与笔记工具不抢控制权租约，以免打断正在运行的 F8
      const READONLY_TOOLS = new Set(['get_state', 'get_guide', 'update_notes', 'help'])
      if (READONLY_TOOLS.has(toolName)) {
        return await runTool(toolName, args, { owner: 'mcp_client', ownerInstanceId: INSTANCES.mcp_client, step: currentDshStep, signal: extra?.signal ?? null })
      }
      if (toolName === 'stop') {
        clearDshThinking()
        setPause(false)
        const r = await stopCoordinator.requestStop({ source: 'mcp_stop', requester: 'mcp_client', reason: 'DSH stop' })
        return r.ok
          ? `已停止（${r.status}）：${r.detail}`
          : `停止未确认（${r.status}）：${r.detail}${r.quarantined ? '【隔离中，禁止新任务】' : ''}`
      }
      if (!stopCoordinator.canAcceptNewWork()) {
        const blocked = '系统处于停止协调隔离态（旧执行链尚未安全退出），禁止启动新动作，请先调用 stop 确认退出'
        logBlockedTool(toolName, args, 'mcp_client', 'stop_quarantined', blocked)
        return blocked
      }
      const acq = await control.acquireWithWait('mcp_client', leaseEnv(), {
        ownerInstanceId: INSTANCES.mcp_client,
        readAck: () => (bridge.readLeaseAck ? bridge.readLeaseAck() : null),
        isGameAlive: () => { const s = readSnapshot({ bridge }); return !(s && s.stale) },
      })
      if (acq.waitedMs > 0) log('info', `控制权交接等待 ${acq.waitedMs}ms（${acq.attempts} 次尝试）`)
      if (!acq.ok) {
        const blocked = `控制权获取失败（${acq.reason}）：当前控制权被其它入口占用或正在换手中，请稍候或先调用 stop`
        log('warn', `MCP ${toolName} 未拿到控制权：${acq.reason}`)
        logBlockedTool(toolName, args, 'mcp_client', `lease_${acq.reason}`, blocked)
        return blocked
      }
      stopCoordinator.reset()
      try {
        return await runTool(toolName, args, {
          owner: 'mcp_client',
          ownerInstanceId: INSTANCES.mcp_client,
          step: currentDshStep,
          signal: extra?.signal ?? null,
        })
      } finally {
        if (acq.ok && !acq.handover) control.release('mcp_client', { ownerInstanceId: INSTANCES.mcp_client })
      }
    },
  })

  server.setSettingsHandler((next) => {
    log('info', '收到外部设置：' + createHash('sha256').update(JSON.stringify(next)).digest('hex').slice(0, 8))
  })

  // 启动 MCP 服务器（端口占用时重试）
  ctx.effect(() => {
    let disposed = false
    let tries = 0
    const attempt = async () => {
      if (disposed) return
      const port = Number(currentConfig(config).port)
      try {
        await server.start(port)
      } catch (error) {
        if (error?.code === 'EADDRINUSE') {
          if (++tries <= 20) {
            log('warn', `端口 ${port} 被占了，10 秒后再试（可能另一个 DSH 已经在跑）`)
            setTimeout(attempt, 10000)
          } else {
            log('error', `端口 ${port} 一直被占用，AI 连不上游戏；改一下插件设置里的端口`)
          }
          return
        }
        log('error', 'MCP 服务器起不来：' + String(error?.message ?? error))
      }
    }
    attempt()
    return () => {
      disposed = true
      server.stop().catch(() => {})
    }
  })

  // 把设置推给游戏
  ctx.effect(() => {
    const sync = () => {
      const settings = modSettingsOf(config)
      const hash = createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0, 16)
      const game = currentConfig(config)
      const wanted = { ...settings, gameDir: game.gameDir, bridgeDir: game.bridgeDir }
      if (hash === lastSettingsHash) return
      lastSettingsHash = hash
      try {
        bridge.gameDir = game.gameDir
        bridge.bridgeDir = game.bridgeDir
        const wrote = bridge.pushSettings(wanted)
        if (wrote > 0) log('info', `设置已推送到游戏（${wrote} 个目录）`)
      } catch (error) {
        log('warn', '推设置失败：' + String(error?.message ?? error))
      }
    }
    sync()
    const timer = setInterval(sync, 15000)
    return () => clearInterval(timer)
  })

  evaluatePause = setupThinkingPause(ctx, config, {
    bridge,
    runner,
    dshThinkingSessions,
    getInFlight: () => inFlight,
    setPause,
  })

  // 游戏快捷键：F8 启动/停止内置 AI，stop 开关触发统一停止协调
  ctx.effect(() => {
    let lastKey = ''
    const timer = setInterval(() => {
      let toggle
      try {
        toggle = bridge.readToggle()
      } catch {
        return
      }
      if (!toggle) return
      const key = `${toggle.ai === true}|${toggle.stop === true}|${toggle.ts ?? ''}`
      if (key === lastKey) return
      lastKey = key
      if (toggle.stop === true) {
        stopCoordinator.requestStop({ source: 'game_stop_switch', requester: 'manual_test', reason: '收到停止开关' })
          .then((r) => {
            if (r.ok) {
              const takeover = control.acquire('manual_test', leaseEnv(), { ownerInstanceId: INSTANCES.manual_test })
              if (takeover.ok) log('info', `已人工接管（generation=${takeover.lease.generation}）`)
            } else {
              log('warn', `停止未确认（${r.status}），暂不交接控制权`)
            }
          })
          .catch((e) => log('warn', '停止协调失败：' + String(e?.message ?? e)))
      }
      if (toggle.ai === true && !runner.running) {
        if (!stopCoordinator.canAcceptNewWork()) {
          log('warn', 'F8 启动被拒：停止协调器处于隔离/停止中')
        } else {
          const acq = control.acquire('f8_agent', leaseEnv(), { ownerInstanceId: INSTANCES.f8_agent })
          if (acq.ok) {
            if (acq.handover) control.completeHandover(bridge.readLeaseAck ? bridge.readLeaseAck() : null)
            stopCoordinator.reset()
            runner.start()
          } else log('warn', `F8 没拿到控制权（${acq.reason}）`)
        }
      } else if (toggle.ai === false && runner.running) {
        stopCoordinator.requestStop({ source: 'f8_toggle', reason: '按 F8 停下了' })
          .catch((e) => log('warn', 'F8 停止协调失败：' + String(e?.message ?? e)))
      }
      publishHud()
    }, 500)
    return () => clearInterval(timer)
  })

  // 往游戏小窗推状态并在卸载时协调停止
  ctx.effect(() => {
    publishHud()
    const timer = setInterval(publishHud, 1000)
    return () => {
      clearInterval(timer)
      try {
        stopCoordinator.requestStop({ source: 'plugin_unload', reason: 'DSH 插件停掉了' }).catch(() => {})
        bridge.writeHud({ v: 1, ai: false, lines: ['大肥鱼：DSH 插件关掉了'] })
      } catch {}
    }
  })

  // 自动安装/更新饥荒模组
  let lastInstall = ''
  const install = () => {
    const c = currentConfig(config)
    if (!c.autoInstallMod) return
    let result
    try {
      result = installMod({ gameDir: c.gameDir })
    } catch (error) {
      result = { state: 'error', message: String(error?.message ?? error) }
    }
    if (result.message === lastInstall) return
    lastInstall = result.message
    log(result.state === 'installed' || result.state === 'current' ? 'info' : 'warn', result.message)
  }
  ctx.effect(() => {
    install()
    const timer = setInterval(install, 60 * 1000)
    return () => clearInterval(timer)
  })

  setupSessionLog(ctx, config, log, {
    baseDir: ROOT,
    bridge,
    getSessionLog: () => sessionLog,
    setSessionLog: (inst) => { sessionLog = inst },
    setCurrentDshStep: (step) => { currentDshStep = step },
  })
  setupPreset(ctx, config, log)
  setupGateway(ctx, config, log)
  registerAutoContinue(ctx, config, log, name)
}
