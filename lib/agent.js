// 内置 AI：不经过 DSH 会话，插件自己调模型、自己调工具，在游戏里按 F8 就能让它玩。
//
// OBSERVATION-01 之后的循环（**不再每轮无条件观察**）：
//   启动读一次完整状态 → 模型决策 → 执行工具 → 把**已核对的结果**交回模型
//   → 模型接着决策（复用刚确认的结果）→ 只有必要时才刷新状态
//
// 为什么改：真机 40 次调用里 24 次是 get_state —— 模型每做一个动作就把整个世界重看一遍，
// 而动作结果其实已经核对过（背包 +1 / 饥饿 +9 / 成品进包）。这些数据足够继续决策。
//
// 仍然保留的安全底线（一条都没放宽）：
//   · #N 引用只在对应的 Nearby snapshot_id 内有效，stale_snapshot 必须重新观察
//   · unknown / unverified 一律当作"结果不确定"，下一轮强制刷新
//   · 状态过旧、危险状态、阶段变化（黄昏/夜晚）都会触发刷新
//   · 游戏暂停时立即停下等（不空转）
//
// M1.1：状态只从 readSnapshot() 拿（和 MCP 完全同一个函数），
// 「新鲜度/过期」也统一由 lib/state/snapshot.js 的 STALE_MS 判定，这里不再自己算阈值。
import { readSnapshot } from './tools.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 观察策略（OBSERVATION-01）──
// 这些是 **Agent 内部** 的观察节流参数，不是让模型额外调工具。
/** 状态超过这个年龄就刷新（饥荒 1 天≈8 分钟，8 秒足够看出阶段/血量的明显变化） */
const OBSERVE_MAX_AGE_MS = 10_000
/** 连续改了这么多次状态就强制刷新（避免长期只靠动作结果推断） */
const OBSERVE_MAX_MUTATIONS = 3
/** 没有工具调用时的退避：600ms 起，翻倍到上限，避免"相同观察反复请求模型" */
const IDLE_MIN_MS = 600
const IDLE_MAX_MS = 8_000
/** 连续多少次"没有工具调用"就停下（不烧 token 空转） */
const IDLE_GIVE_UP = 6

/** 判断一次工具结果是不是"不确定"，需要下一轮重新观察 */
function isUncertainText(text) {
  const s = String(text ?? '')
  return /结果未知|没核对上|unverified|unknown|result_timeout|stale_snapshot|game_paused|game_not_ready|控制权不在手上|control_denied/.test(s)
}

/**
 * 判断一次工具结果是不是**失败/被拒**（同批后续动作必须停）。
 * OBSERVATION-01：同一份模型响应里的多个动作是"模型还没看到前一个结果"时一起生成的，
 * 前一个失败就说明前提不成立，后面的动作大概率也是错的 —— 不能盲目执行。
 */
function isFailureText(text) {
  const s = String(text ?? '')
  if (isUncertainText(s)) return true
  return /^失败|拒绝|^未执行|actor_busy|actor_is_ghost|actor_dead|actor_invalid|ingredients_missing|not_in_inventory|not_ready|already_harvested|target_busy|out_of_range|prefab_not_allowed|recipe_not_allowed|item_not_equippable|food_not_allowed|no_food|not_hungry|entity_gone|in_limbo|missing_component/.test(s)
}

/** 这个工具会不会改变世界状态（用来计"连续改了几次"） */
function isMutatingTool(name) {
  return !['get_state', 'get_guide', 'update_notes'].includes(String(name ?? ''))
}

function safeJson(text) {
  if (text === undefined || text === null || text === '') return {}
  if (typeof text === 'object') return text
  try {
    return JSON.parse(String(text))
  } catch {
    return {}
  }
}

/** 只保留最近若干条消息，system 永远留着（省 token，也避免上下文爆掉）。 */
function trimMessages(messages, keep = 28) {
  while (messages.length > keep + 1) {
    messages.splice(1, 2)
  }
}

function cut(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? value.slice(0, limit) + '…' : value
}

export class AiRunner {
  #running = false
  #controller = null
  // OBSERVATION-01：观察统计（内部自动观察 / 模型主动 get_state 分开计）
  #stats = { autoObserve: 0, modelGetState: 0, reusedSample: 0, reasons: [] }
  #lastToolWasModelGetState = false
  #step = 0
  #action = ''
  #result = ''
  #error = ''

  constructor({ log = () => {}, bridge, settings, instructions, callTool, toolList, onStatus = () => {}, chatFn = null }) {
    this.log = log
    this.bridge = bridge
    this.settings = settings
    this.instructions = instructions
    this.callTool = callTool
    this.toolList = toolList
    this.onStatus = onStatus
    // 可注入的模型调用（只在测试里用；生产不传，走下面的 #chat）
    this.chatFn = typeof chatFn === 'function' ? chatFn : null
  }

  get running() {
    return this.#running
  }

  status() {
    return {
      running: this.#running,
      step: this.#step,
      action: this.#action,
      result: this.#result,
      error: this.#error,
    }
  }

  #publish() {
    try {
      this.onStatus(this.status())
    } catch {}
  }

  start() {
    if (this.#running) return false
    this.#running = true
    this.#step = 0
    this.#action = ''
    this.#result = ''
    this.#error = ''
    this.log('info', '内置 AI 开始玩（游戏里按 F8 或 F8/F7 可以停）')
    this.#publish()
    this.#loop()
      .catch((error) => {
        this.#error = '内置 AI 出错：' + String(error?.message ?? error)
        this.log('warn', this.#error)
      })
      .finally(() => {
        this.#running = false
        this.#action = ''
        this.#publish()
      })
    return true
  }

  stop(reason) {
    if (!this.#running) return false
    this.#running = false
    try {
      this.#controller?.abort()
    } catch {}
    this.#result = reason ?? '停下了'
    this.#action = ''
    this.log('info', '内置 AI 停下：' + this.#result)
    this.#publish()
    return true
  }

  async #loop() {
    const messages = [{ role: 'system', content: this.instructions() }]
    // ── 观察状态（OBSERVATION-01）──
    let lastObservedAt = 0        // 上一次把状态交给模型的时间
    let mutationsSinceObserve = 0 // 自上次观察以来改了几次世界
    let idleStreak = 0            // 连续"没有工具调用"的次数
    let needFreshObserve = true   // 首次必须观察
    let observeReason = '首次观察'
    this.#stats = { autoObserve: 0, modelGetState: 0, reusedSample: 0, reasons: [] }

    while (this.#running) {
      const config = this.settings()
      if (!config.apiKey) {
        this.#error = '没配 API Key：在插件设置里填 DeepSeek Key，或者设环境变量 DEEPSEEK_API_KEY'
        this.#publish()
        await sleep(4000)
        continue
      }

      // 游戏没在跑（暂停/退出）：不观察、不请求模型，等着
      const snapshot = readSnapshot({ bridge: this.bridge })
      if (!snapshot || snapshot.stale) {
        this.#error = snapshot?.actor
          ? '游戏暂停了（引擎不跑 tick）。切回游戏窗口解除暂停就会继续'
          : '等游戏（要开着游戏、读档进世界；模组要启用）'
        this.#action = ''
        this.#publish()
        needFreshObserve = true
        observeReason = '状态过期/暂停'
        await sleep(2000)
        continue
      }
      this.#error = ''

      // ── 是否需要在请求模型前刷新观察 ──
      const ageMs = Date.now() - lastObservedAt
      if (!needFreshObserve) {
        if (ageMs > OBSERVE_MAX_AGE_MS) { needFreshObserve = true; observeReason = `状态已 ${Math.round(ageMs / 1000)} 秒没刷新` }
        else if (mutationsSinceObserve >= OBSERVE_MAX_MUTATIONS) { needFreshObserve = true; observeReason = `连续改了 ${mutationsSinceObserve} 次状态` }
      }

      const step = ++this.#step
      if (needFreshObserve) {
        this.#action = '看状态'
        this.#publish()
        let observation
        try {
          observation = await this.callTool('get_state', {})
        } catch (error) {
          observation = '看状态失败：' + String(error?.message ?? error)
        }
        if (!this.#running) return
        // 模型自己调 get_state 的那次不算"内部自动观察"
        if (!this.#lastToolWasModelGetState) {
          this.#stats.autoObserve++
          this.#stats.reasons.push(observeReason)
        }
        messages.push({ role: 'user', content: `[第 ${step} 步 · ${observeReason}]\n${observation}` })
        trimMessages(messages)
        lastObservedAt = Date.now()
        mutationsSinceObserve = 0
        needFreshObserve = false
      } else {
        // 不刷新：只用一条轻提示，把"上一步的已确认结果"当作上下文继续
        messages.push({ role: 'user', content: `[第 ${step} 步] 继续（状态刚看过 ${Math.round(ageMs / 1000)} 秒，用上面已核对的结果决策；需要新信息再自己调 get_state）` })
        trimMessages(messages)
      }

      this.#action = '想下一步'
      this.#publish()
      let reply
      try {
        reply = await (this.chatFn ? this.chatFn(config, messages) : this.#chat(config, messages))
      } catch (error) {
        if (!this.#running) return
        this.#error = '模型调用失败：' + String(error?.message ?? error)
        this.log('warn', this.#error)
        this.#publish()
        await sleep(3000)
        continue
      }
      if (!this.#running) return

      if (reply.content) this.#result = cut(reply.content, 80)

      // ── 没有工具调用：退避，不要用相同观察反复请求 ──
      if (reply.toolCalls.length === 0) {
        messages.push({ role: 'assistant', content: reply.content || '(想了想)' })
        this.#publish()
        idleStreak++
        if (idleStreak >= IDLE_GIVE_UP) {
          this.#error = `连续 ${idleStreak} 次没有动作，先停下（避免空转烧 token）`
          this.#publish()
          this.stop('连续没有动作')
          return
        }
        // ★ 没有动作时**不要**每轮都重新观察 —— 没有新信息，重复观察只是浪费。
        //   只在状态确实过旧时才刷新；否则等一会儿，用同一份上下文再问一次。
        const wait = Math.min(IDLE_MAX_MS, IDLE_MIN_MS * 2 ** (idleStreak - 1))
        if (Date.now() - lastObservedAt > OBSERVE_MAX_AGE_MS) {
          needFreshObserve = true
          observeReason = `模型没有动作，状态已 ${Math.round((Date.now() - lastObservedAt) / 1000)} 秒没刷新`
        }
        await sleep(wait)
        continue
      }
      idleStreak = 0

      messages.push({ role: 'assistant', content: reply.content || '', tool_calls: reply.rawToolCalls })

      // ── 按顺序执行工具调用；遇到失败/不确定就停掉后面的 ──
      let aborted = null
      for (let i = 0; i < reply.toolCalls.length; i++) {
        const call = reply.toolCalls[i]
        if (!this.#running) return
        if (aborted !== null) {
          // 没执行的调用也要如实告诉模型，绝不能伪装成成功
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `未执行：因为前面的 ${aborted} 而停止（不是成功，也不是失败；需要的话请重新决策）`,
          })
          continue
        }

        this.#action = call.name + (Object.keys(call.args ?? {}).length > 0 ? ' ' + cut(JSON.stringify(call.args), 40) : '')
        this.#publish()
        let text
        try {
          text = await this.callTool(call.name, call.args)
        } catch (error) {
          text = '失败：' + String(error?.message ?? error)
        }
        if (!this.#running) return
        this.#result = cut(text, 80)
        this.#publish()

        const name = String(call.name ?? '')
        if (name === 'get_state') {
          this.#stats.modelGetState++
          this.#lastToolWasModelGetState = true
          // 模型自己看过状态了：重置观察窗口，下一轮不用再补
          lastObservedAt = Date.now()
          mutationsSinceObserve = 0
          needFreshObserve = false
        } else {
          this.#lastToolWasModelGetState = false
          if (isMutatingTool(name)) mutationsSinceObserve++
        }
        if (isFailureText(text)) {
          // 失败或结果不确定 → 停掉同批后续动作；下一轮必须重新观察
          needFreshObserve = true
          observeReason = `上一步失败/不确定（${name}）`
          aborted = `${name} 失败或结果不确定`
        }

        messages.push({ role: 'tool', tool_call_id: call.id, content: String(text).slice(0, 4000) })
      }
    }
  }

  /** 观察统计（OBSERVATION-01：内自动观察 / 模型主动 get_state 分开计） */
  observeStats() {
    return { ...(this.#stats ?? { autoObserve: 0, modelGetState: 0, reusedSample: 0, reasons: [] }) }
  }

  async #chat(config, messages) {
    const controller = new AbortController()
    this.#controller = controller
    const timer = setTimeout(() => controller.abort(), 180000)
    try {
      const base = String(config.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages,
          tools: this.toolList().map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
          })),
          tool_choice: 'auto',
          temperature: 0.2,
          max_tokens: Number(config.maxTokens) || 1024,
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`HTTP ${response.status} ${body.slice(0, 300)}`)
      }
      const data = await response.json()
      const message = data?.choices?.[0]?.message ?? {}
      const toolCalls = (message.tool_calls ?? []).map((call) => ({
        id: call.id ?? `call_${Math.random().toString(36).slice(2)}`,
        name: call.function?.name,
        args: safeJson(call.function?.arguments),
      }))
      return { content: message.content ?? '', toolCalls, rawToolCalls: message.tool_calls }
    } finally {
      clearTimeout(timer)
      this.#controller = null
    }
  }
}
