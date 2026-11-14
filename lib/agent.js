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
import { derivePlan, renderPlan } from './plan.js'

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

/**
 * 从快照里读背包（只读，不猜）。
 * 刷新观察时用它的结果**覆盖**已知背包 —— 记忆永远以真实快照为准。
 */
function inventoryOf(snapshot) {
  const items = snapshot?.player?.inventory?.items
  const list = Array.isArray(items) ? items : Object.values(items ?? {})
  const out = {}
  for (const it of list) {
    if (!it || !it.prefab) continue
    out[String(it.prefab)] = (out[String(it.prefab)] ?? 0) + Number(it.count ?? 1)
  }
  return out
}

/** 把背包渲染成一行短文本（给模型看，省 token） */
function inventoryLine(inv) {
  const keys = Object.keys(inv ?? {}).sort()
  if (keys.length === 0) return '空'
  return keys.map((k) => `${k}×${inv[k]}`).join('，')
}

/**
 * 用一次**已核对**的动作结果更新已知背包。
 *
 * 借鉴 E:\Cache\DontStarveAI-main 的 InventoryTracker 思路：只记增量、只信已核对的数据。
 * 没有核对数据就**原样返回**（宁可少记，也不许瞎猜）。
 *
 * 数据来自 dispatcher 返回的结构化 `verified`，不再解析 describe() 的中文回执 ——
 * 之前靠正则匹配「【已核对】cutgrass +1，吃掉 1 个」这种人类可读文本，
 * 改一个措辞或加一种变化就会静默失配，背包记忆悄悄变错。字段是契约，文本只是展示。
 *
 * 各动作规则（与 dispatcher 的 verify 一一对应）：
 *   · gather / pickup / harvest / container_take：产物 +gained
 *   · gather_area：products 里每个产物各自 +gained
 *   · craft：成品 +made；how==='auto_equipped' 时成品在**手上**不在背包里，所以不记
 *   · eat / fuel / drop / container_put / give / cook：消耗 -used
 *   · move_to / stop：不影响背包
 */
export function applyVerified(inv, tool, args, verified) {
  if (!verified) return inv
  const next = { ...inv }
  const add = (prefab, n) => {
    if (!prefab || !(n > 0)) return
    next[String(prefab)] = (next[String(prefab)] ?? 0) + n
  }
  const take = (prefab, n) => {
    if (!prefab || !(n > 0)) return
    const left = Math.max(0, (next[String(prefab)] ?? 0) - n)
    if (left === 0) delete next[String(prefab)]
    else next[String(prefab)] = left
  }
  const name = String(tool ?? '')

  // 多产物（gather_area）
  if (Array.isArray(verified.products)) {
    for (const g of verified.products) add(g?.prefab, Number(g?.gained ?? 0))
  }
  if (name === 'gather' || name === 'pickup' || name === 'harvest'
    || name === 'container_take' || name === 'gather_area') {
    add(verified.product, Number(verified.gained ?? 0))
  } else if (name === 'craft') {
    // 自动装备的成品不在背包里（真机踩过：torch 是 equippable，DoBuild 直接拿在手里）
    if (verified.how !== 'auto_equipped') add(args?.recipe, Number(verified.made ?? 0))
  } else if (name === 'eat' || name === 'fuel' || name === 'drop'
    || name === 'container_put' || name === 'give' || name === 'cook') {
    take(verified.foodPrefab ?? verified.prefab ?? args?.food ?? args?.item, Number(verified.used ?? 0))
  }
  return next
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
    this.log('info', '内置 AI 开始玩（游戏里再按一次 F8 可以停；F7 只开关小窗）')
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
    // OBSERVATION-01：已知背包（只由"已核对的动作结果"或"真实快照"更新，绝不瞎猜）
    let knownInventory = {}
    let knownInventoryFresh = false
    let observeReason = '首次观察'
    // 计划层：每轮从最新快照推导（纯函数，不调模型）；目标没变就只给一行，变了才展开。
    let lastPlan = null
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
      const previousPlan = lastPlan
      const plan = derivePlan(snapshot, previousPlan)
      lastPlan = plan
      // 目标切换时值得重看一次：新目标往往需要新的 #N 引用（比如"去采浆果"）。
      // 目标没变就继续复用已核对的结果 —— 这才是省掉每轮重新规划的关键。
      if (previousPlan && plan.changed && !needFreshObserve) {
        needFreshObserve = true
        observeReason = `计划变了：${plan.title}`
      }

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
        // 刷新观察时：已知背包以**真实快照**为准覆盖（记忆不能盖过事实）
        knownInventory = inventoryOf(readSnapshot({ bridge: this.bridge }))
        knownInventoryFresh = true
      } else {
        // 不刷新：把"已知背包"和"上一步的已核对结果"一起带上，模型不必为确认数字再观察
        const invLine = knownInventoryFresh ? `已知背包（来自已核对的结果）：${inventoryLine(knownInventory)}` : ''
        // 计划是省 token 的关键：目标没变就压成一行；变了才把完整计划（原因 + 下一步）展开。
        const planText = plan.changed ? renderPlan(plan) : renderPlan(plan, { compact: true })
        messages.push({
          role: 'user',
          content: `[第 ${step} 步] 继续（状态刚看过 ${Math.round(ageMs / 1000)} 秒，用上面已核对的结果决策；需要新信息再自己调 get_state）`
            + (planText ? `\n${planText.trim()}` : '')
            + (invLine ? `\n${invLine}` : ''),
        })
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
        let outcome = null
        try {
          const raw = await this.callTool(call.name, call.args)
          // callTool 可以返回字符串（测试/简单注入），也可以返回 { text, outcome }：
          // 后者带上 dispatcher 的结构化核对结果，用来精确维护背包记忆。
          if (raw !== null && typeof raw === 'object' && typeof raw.text === 'string') {
            text = raw.text
            outcome = raw.outcome ?? null
          } else {
            text = raw
          }
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
          // OBSERVATION-01：用**已核对**的回执更新"已知背包"，模型下一轮不必为确认数字再观察
          if (!isFailureText(text) && outcome?.verified) {
            knownInventory = applyVerified(knownInventory, name, call.args, outcome.verified)
            knownInventoryFresh = true
          }
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
