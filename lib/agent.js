// 内置 AI：不经过 DSH 会话，插件自己调模型、自己调工具，在游戏里按 F8 就能让它玩。
//
// 循环很简单（和星露谷那版一个思路）：
//   看状态（get_state） → 让模型决定调哪个工具 → 执行 → 把结果告诉模型 → 再看状态……
// 游戏是实时的，所以每一步只做一件小事，工具执行完立刻继续，不在原地空想。

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  #step = 0
  #action = ''
  #result = ''
  #error = ''

  constructor({ log = () => {}, bridge, settings, instructions, callTool, toolList, onStatus = () => {} }) {
    this.log = log
    this.bridge = bridge
    this.settings = settings
    this.instructions = instructions
    this.callTool = callTool
    this.toolList = toolList
    this.onStatus = onStatus
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
    while (this.#running) {
      const config = this.settings()
      if (!config.apiKey) {
        this.#error = '没配 API Key：在插件设置里填 DeepSeek Key，或者设环境变量 DEEPSEEK_API_KEY'
        this.#publish()
        await sleep(4000)
        continue
      }
      const state = this.bridge.readState()
      // 用 ageMs（读状态时算好的），别再拿 mtimeMs 现算：字段对不上会得到 NaN，
      // 判断永远不成立，游戏退出世界以后内置 AI 还会照着旧状态一直发动作。
      const stateAge = state ? (Number.isFinite(state.ageMs) ? state.ageMs : Date.now() - Number(state.mtimeMs ?? 0)) : Infinity
      if (!state || stateAge > 15000) {
        this.#error = '等游戏（要开着游戏、读档进世界；模组要启用）'
        this.#action = ''
        this.#publish()
        await sleep(2000)
        continue
      }
      this.#error = ''
      const step = ++this.#step
      this.#action = '看状态'
      this.#publish()

      let observation
      try {
        observation = await this.callTool('get_state', {})
      } catch (error) {
        observation = '看状态失败：' + String(error?.message ?? error)
      }
      if (!this.#running) return
      messages.push({ role: 'user', content: `[第 ${step} 步]\n${observation}` })
      trimMessages(messages)

      this.#action = '想下一步'
      this.#publish()
      let reply
      try {
        reply = await this.#chat(config, messages)
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
      if (reply.toolCalls.length === 0) {
        messages.push({ role: 'assistant', content: reply.content || '(想了想)' })
        this.#publish()
        await sleep(600)
        continue
      }

      messages.push({ role: 'assistant', content: reply.content || '', tool_calls: reply.rawToolCalls })
      for (const call of reply.toolCalls) {
        if (!this.#running) return
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
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(text).slice(0, 4000) })
      }
    }
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
