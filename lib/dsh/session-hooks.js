// DSH 会话事件钩子：工具识别、消息提取、思考超时暂停、会话日志订阅与坏格式自动续玩。

import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { ACTION_NAMES, MACRO_NAMES } from '../tools.js'
import { SessionLog } from '../session-log.js'
import { currentConfig } from './config.js'
import { GATEWAY_TOOL } from './gateway.js'
import { MCP_SERVER_NAME, PRESET_ID } from './preset.js'

const MAX_THINKING_PAUSE_MS = 180_000
const BROKEN_TOOL_CALL = /｜DSML｜|<｜tool▁call/

export const AUTO_CONTINUE_TEXT =
  '（自动续玩）你上一条回复的工具调用格式坏了，没有执行。不用解释，直接接着玩：拿不准就 get_state 看一眼再行动。'

/** 判断工具名是否属于本插件提供的饥荒工具。 */
export function isDstTool(toolName) {
  if (typeof toolName !== 'string') return false
  if (toolName === GATEWAY_TOOL) return true
  if (toolName.startsWith(`mcp__${MCP_SERVER_NAME}__`)) return true
  if (ACTION_NAMES.has(toolName) || MACRO_NAMES.has(toolName) || toolName === 'get_state' || toolName === 'get_guide' || toolName === 'advance_task' || toolName === 'run_skill' || toolName === 'update_notes' || toolName === 'stop') return true
  return false
}

/** 从 DSH assistant/message 事件中提取思考过程、正文与工具调用。 */
export function extractDshMessage(message) {
  if (!message) return null
  let thought = message.reasoning_content || message.reasoningContent || message.thought || null
  let content = ''
  const toolCalls = []

  const rawContent = message.content
  if (typeof rawContent === 'string') {
    content = rawContent
  } else if (Array.isArray(rawContent)) {
    const textParts = []
    const thoughtParts = []
    for (const part of rawContent) {
      if (!part) continue
      if (part.type === 'text' && typeof part.text === 'string') {
        textParts.push(part.text)
      } else if (part.type === 'thinking' || part.type === 'think' || part.type === 'reasoning') {
        thoughtParts.push(part.thinking || part.think || part.reasoning || part.text || '')
      } else if (part.type === 'tool-call' || part.type === 'tool_use' || part.type === 'tool_call') {
        toolCalls.push({
          name: part.name || part.toolName || part.tool_name,
          args: part.arguments || part.args,
        })
      }
    }
    if (thoughtParts.length > 0) {
      const joined = thoughtParts.filter(Boolean).join('\n').trim()
      if (joined) thought = thought ? thought + '\n' + joined : joined
    }
    content = textParts.join('').trim()
  }

  // 提取正文中的 <think>...</think> 标签（DeepSeek / Qwen 等模型）
  if (typeof content === 'string' && content.includes('<think>')) {
    const m = content.match(/<think>([\s\S]*?)(?:<\/think>|$)/)
    if (m) {
      const extracted = m[1].trim()
      thought = thought ? thought + '\n' + extracted : extracted
      content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/, '').trim()
    }
  }

  // 兼容 OpenAI 格式的 message.tool_calls
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const fn = call.function || call
      let args = fn.arguments ?? fn.args
      if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { args = {} }
      }
      toolCalls.push({ name: fn.name, args })
    }
  }

  return {
    thought: thought ? thought.trim() : null,
    content: content ? content.trim() : null,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
  }
}

/**
 * 判断此刻是否应该因「AI 思考超时」而请求暂停游戏。
 * 必须同时满足：开启 freezeTime、无工具在执行、无待消费命令，且思考已超过 idleSeconds（且未超过安全看门狗上限）。
 */
export function shouldPauseOnThinking({
  freezeTime = true,
  idleSeconds = 5,
  inFlight = 0,
  pendingCommands = 0,
  f8Running = false,
  f8Thinking = false,
  f8ThinkingMs = 0,
  dshThinkingSince = 0,
  now = Date.now(),
} = {}) {
  if (freezeTime !== true) return false
  if (Number(inFlight) > 0 || Number(pendingCommands) > 0) return false
  const thresholdMs = Math.max(1, Number(idleSeconds ?? 5) || 5) * 1000
  if (f8Running && f8Thinking && Number(f8ThinkingMs) >= thresholdMs && Number(f8ThinkingMs) <= MAX_THINKING_PAUSE_MS) {
    return true
  }
  if (Number(dshThinkingSince) > 0) {
    const elapsed = now - Number(dshThinkingSince)
    if (elapsed >= thresholdMs && elapsed <= MAX_THINKING_PAUSE_MS) return true
  }
  return false
}

/** 注册思考超时自动暂停与恢复的会话事件监听。 */
export function setupThinkingPause(ctx, config, { bridge, runner, dshThinkingSessions, getInFlight, setPause }) {
  const evaluatePause = () => {
    try {
      const c = currentConfig(config)
      const st = runner.status()
      let earliestDshThinking = 0
      for (const s of dshThinkingSessions.values()) {
        if (s.playing && s.inTurn && s.toolCallsInFlight === 0 && s.thinkingSince > 0) {
          if (earliestDshThinking === 0 || s.thinkingSince < earliestDshThinking) {
            earliestDshThinking = s.thinkingSince
          }
        }
      }
      const want = shouldPauseOnThinking({
        freezeTime: c.freezeTime === true,
        idleSeconds: c.idleSeconds,
        inFlight: getInFlight(),
        pendingCommands: bridge.pendingHttpCommands?.length ?? 0,
        f8Running: st.running === true,
        f8Thinking: st.isThinking === true,
        f8ThinkingMs: st.thinkingMs ?? 0,
        dshThinkingSince: earliestDshThinking,
      })
      setPause(want)
    } catch {}
  }

  ctx.effect(() => {
    setPause(false)
    const timer = setInterval(evaluatePause, 500)
    let off = null
    if (typeof ctx.on === 'function') {
      const stateOf = (id) => {
        let s = dshThinkingSessions.get(id)
        if (!s) dshThinkingSessions.set(id, (s = { playing: false, inTurn: false, toolCallsInFlight: 0, thinkingSince: 0 }))
        return s
      }
      off = ctx.on('session/event', (session, event) => {
        const id = session?.id
        if (!id || !event) return
        const s = stateOf(id)
        if (session?.presetId === PRESET_ID || session?.definition?.id === PRESET_ID) s.playing = true
        switch (event.type) {
          case 'turn/start':
            s.inTurn = true
            s.toolCallsInFlight = 0
            s.thinkingSince = s.playing ? Date.now() : 0
            evaluatePause()
            return
          case 'tool/call':
            if (isDstTool(event.data?.name)) s.playing = true
            s.toolCallsInFlight++
            s.thinkingSince = 0
            evaluatePause()
            return
          case 'tool/result':
            s.toolCallsInFlight = Math.max(0, s.toolCallsInFlight - 1)
            if (s.playing && s.inTurn && s.toolCallsInFlight === 0) s.thinkingSince = Date.now()
            evaluatePause()
            return
          case 'assistant/message': {
            const parsed = extractDshMessage(event.data?.message)
            if (parsed?.toolCalls?.some((call) => isDstTool(call.name))) s.playing = true
            return
          }
          case 'turn/end':
            s.inTurn = false
            s.toolCallsInFlight = 0
            s.thinkingSince = 0
            evaluatePause()
            return
        }
      })
    }
    return () => {
      clearInterval(timer)
      try { off?.() } catch {}
      for (const s of dshThinkingSessions.values()) {
        s.thinkingSince = 0
        s.toolCallsInFlight = 0
      }
      setPause(false)
    }
  })

  return evaluatePause
}

/** 启动内置会话日志（覆盖写）并订阅 DSH 会话思考/调用事件。 */
export function setupSessionLog(ctx, config, log, { baseDir, bridge, getSessionLog, setSessionLog, setCurrentDshStep }) {
  ctx.effect(() => {
    const c = currentConfig(config)
    if (c.sessionLogEnabled === false) return
    const configured = String(c.sessionLogDir || '').trim()
    const outDir = configured
      ? (isAbsolute(configured) ? configured : resolve(baseDir, configured))
      : join(baseDir, 'latestLogs')
    const instance = new SessionLog({
      outDir,
      bridge,
      log,
      intervalMs: 500,
      stateEveryMs: 5000,
      envEveryMs: 1000,
      sourceEveryMs: 5000,
      explicit: c.bridgeDir ? { bridgeDir: c.bridgeDir } : {},
    })
    try {
      instance.start()
      log('info', `会话日志已开启（覆盖写）：${outDir}`)
    } catch (error) {
      log('warn', '会话日志启动失败：' + String(error?.message ?? error))
      return
    }
    setSessionLog(instance)

    const seenSessions = new Set()
    const dshSessions = new Map()
    const getDshState = (id) => {
      let s = dshSessions.get(id)
      if (!s) dshSessions.set(id, (s = { step: 0, isDst: false, pendingThought: null, turnLogged: false, lastMsgSig: '' }))
      return s
    }

    let off = null
    if (typeof ctx.on === 'function') {
      off = ctx.on('session/event', (session, event) => {
        const id = session?.id
        if (!id || !event) return
        const sess = getDshState(id)
        if (session?.presetId === PRESET_ID || session?.definition?.id === PRESET_ID) {
          sess.isDst = true
        }

        switch (event.type) {
          case 'turn/start': {
            sess.pendingThought = null
            sess.turnLogged = false
            sess.lastMsgSig = ''
            if (sess.isDst) {
              sess.step += 1
              setCurrentDshStep(sess.step)
              instance.recordAiTurn({
                step: sess.step,
                observeReason: 'dsh_turn',
              })
            }
            break
          }

          case 'assistant/message': {
            const parsed = extractDshMessage(event.data?.message)
            if (!parsed) break

            const callsDst = parsed.toolCalls?.some((call) => isDstTool(call.name))
            if (callsDst) {
              sess.isDst = true
              if (!seenSessions.has(id)) {
                seenSessions.add(id)
                setCurrentDshStep(null)
                try { instance.reset(`新会话 ${id}`) } catch {}
              }
            }

            const model = event.data?.message?.model || event.data?.model || session?.model || 'dsh-model'
            const usage = event.data?.message?.usage || event.data?.usage
            const tokens = usage?.total_tokens ?? (usage ? ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)) : null)
            const sig = `${parsed.thought || ''}|${parsed.content || ''}|${parsed.toolCalls?.length || 0}`
            if (sig && sig === sess.lastMsgSig) break
            sess.lastMsgSig = sig

            const thoughtData = {
              step: sess.step || 1,
              thought: parsed.thought,
              content: parsed.content,
              model,
              tokens,
              toolCalls: parsed.toolCalls,
            }

            if (sess.isDst) {
              if (sess.step === 0) sess.step = 1
              thoughtData.step = sess.step
              setCurrentDshStep(sess.step)
              sess.turnLogged = true
              instance.recordAiThought(thoughtData)
            } else {
              sess.pendingThought = thoughtData
            }
            break
          }

          case 'tool/call': {
            const toolName = event.data?.name
            if (isDstTool(toolName)) {
              sess.isDst = true
              if (!seenSessions.has(id)) {
                seenSessions.add(id)
                setCurrentDshStep(null)
                try { instance.reset(`新会话 ${id}`) } catch {}
              }
              if (sess.step === 0) sess.step = 1
              setCurrentDshStep(sess.step)

              if (sess.pendingThought && !sess.turnLogged) {
                sess.turnLogged = true
                sess.pendingThought.step = sess.step
                instance.recordAiThought(sess.pendingThought)
                sess.pendingThought = null
              }
            }
            break
          }

          case 'tool/result': {
            sess.turnLogged = false
            break
          }

          case 'turn/end': {
            sess.pendingThought = null
            break
          }
        }
      })
    }

    return () => {
      try { typeof off === 'function' ? off() : off?.dispose?.() } catch {}
      instance.stop()
      if (getSessionLog() === instance) setSessionLog(null)
    }
  })
}

/** 当模型输出坏掉的工具调用文本导致回合结束时，自动发送续玩提示。 */
export function registerAutoContinue(ctx, config, log, pluginName) {
  if (typeof ctx.on !== 'function') return
  const sessions = new Map()
  const stateOf = (id) => {
    let state = sessions.get(id)
    if (!state) sessions.set(id, (state = { playing: false, broken: false, streak: 0, calls: new Set() }))
    return state
  }
  const timers = new Set()

  const continueLater = (sessionId, attempt = 0) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      const agent = ctx.get?.('agents')?.get?.(sessionId)
      if (!agent) return
      if (agent.status !== 'idle') {
        if (attempt < 20) continueLater(sessionId, attempt + 1)
        return
      }
      if (agent.inbox?.nextTurn?.length) return
      try {
        agent.followup(Object.freeze({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: AUTO_CONTINUE_TEXT }],
          source: { kind: pluginName, form: 'notice', summary: '模型回复坏了，自动接着玩' },
        }))
        log('info', `会话 ${sessionId} 的模型回复坏了，已自动发“接着玩”`)
      } catch (error) {
        log('warn', `自动续玩失败：${error?.message ?? error}`)
      }
    }, 1500)
    timers.add(timer)
  }

  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      const id = session?.id
      if (!id || !event) return
      const state = stateOf(id)
      switch (event.type) {
        case 'turn/start':
          state.playing = false
          state.broken = false
          state.calls.clear()
          return
        case 'tool/call':
          if (isDstTool(event.data?.name)) {
            state.playing = true
            state.calls.add(event.data.callId)
          }
          return
        case 'tool/result': {
          const message = event.data?.message
          if (message && !message.isError && state.calls.has(message.toolCallId)) state.streak = 0
          return
        }
        case 'assistant/message': {
          const raw = event.data?.message?.content
          const text = typeof raw === 'string'
            ? raw
            : (Array.isArray(raw) ? raw.filter((part) => part && part.type === 'text').map((part) => part.text).join('') : '')
          const hasToolCall = Array.isArray(raw) && raw.some((part) => part && part.type === 'tool-call')
          state.broken = !hasToolCall && BROKEN_TOOL_CALL.test(text)
          return
        }
        case 'turn/end':
          if (!state.playing || !state.broken || event.data?.reason?.kind !== 'completed') return
          state.broken = false
          if (!currentConfig(config).autoContinue) return
          if (state.streak >= Number(currentConfig(config).autoContinueMax)) {
            log('warn', `会话 ${id} 连续 ${state.streak} 次自动续玩都没有成功的游戏动作，不再自动续玩`)
            return
          }
          state.streak++
          continueLater(id)
          return
      }
    })
    return () => {
      off?.()
      timers.forEach(clearTimeout)
      timers.clear()
    }
  })
}
