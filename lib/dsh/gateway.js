// DSH 单入口工具（dst）：将本机 MCP 服务器包装成一个按需展开的网关工具。

import { currentConfig, loadHostModule } from './config.js'

/** 入口工具的名字。 */
export const GATEWAY_TOOL = 'dst'

const dshTools = await loadHostModule('@deepseek-ai/dsh-tools')
const defineTool = dshTools?.defineTool ?? ((definition) => definition)

/** 发一条 JSON-RPC 给自己的 MCP 服务器（和预设里的客户端走同一个地址）。 */
export async function mcpCall(port, method, params, signal) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal,
  })
  const body = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? parseSseResult(await res.text())
    : await res.json()
  if (body.error) throw new Error(body.error.message ?? `MCP 错误 ${body.error.code}`)
  return body.result
}

/** 从 SSE 文本里取出 JSON-RPC 回复（忽略 ": keep-alive" 注释行）。 */
export function parseSseResult(text) {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
    if (!data) continue
    const message = JSON.parse(data)
    if ('result' in message || 'error' in message) return message
  }
  throw new Error('游戏的回复里没有结果（连接可能中途断了）')
}

/** action="help" 的内容：规则 + 动作列表（主攻略去掉，要看用 get_guide）。 */
export function helpText(instructions, tools) {
  let rules = instructions ?? ''
  const guideStart = rules.indexOf('## 游戏常识')
  const extra = rules.indexOf('## 通过 MCP 玩的额外说明')
  if (guideStart >= 0 && extra > guideStart) rules = rules.slice(0, guideStart) + rules.slice(extra)
  const lines = tools.map((tool) => {
    const props = tool.inputSchema?.properties ?? {}
    const required = new Set(tool.inputSchema?.required ?? [])
    const params = Object.keys(props).map((key) => (required.has(key) ? key : key + '?')).join(', ')
    const summary = String(tool.description ?? '').split(/[。.\n]/)[0]
    return `- ${tool.name}(${params})：${summary}`
  })
  return [
    `# 用 ${GATEWAY_TOOL} 工具玩《饥荒联机版》`,
    `下面说的每个“工具”，都通过 ${GATEWAY_TOOL} 工具调用：action 填动作名，args 填参数对象，例如 {"action":"move_to","args":{"x":64,"z":15}}。参数后面带 ? 的可以不填。`,
    '',
    rules.trim(),
    '',
    `## 全部动作（${tools.length} 个；不确定参数时先按名字和说明猜，失败信息会说哪里不对）`,
    ...lines,
  ].join('\n')
}

export function setupGateway(ctx, config, log, { everyMs = 5000 } = {}) {
  const tool = defineTool({
    name: GATEWAY_TOOL,
    description:
      '玩《饥荒联机版》（游戏要开着、装了大肥鱼饿不死模组）。第一次用先调 action="help"，会告诉你操作规则和可用动作。'
      + 'Assisted（默认）=用户目标驱动、Manual=单次指令，这两种模式保留完整原子动作，可用 move_to/harvest_nearest/craft/build/attack 等连续推进；'
      + 'Autopilot=持续自主（模型只用 advance_task 推进任务看板，原子动作由系统内部安全执行，不直接暴露给模型）。'
      + '查询状态调 action="get_state"，查攻略调 action="get_guide"，停止调 action="stop"。',
    parameters: {
      action: { type: 'string', required: true, description: '动作名：help、get_state、get_guide，或 help 列出的当前模式可用动作' },
      args: { type: 'object', additionalProperties: true, description: '动作的参数对象；没有参数就不填' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      // 实时读当前配置（端口/超时可热更新）
      const cc = currentConfig(config)
      const liveTimeoutMs = Number(cc.actionTimeoutMinutes ?? 5) * 60 * 1000
      const action = String(args?.action ?? '').trim()
      const signal = exec?.signal ? AbortSignal.any([exec.signal, AbortSignal.timeout(liveTimeoutMs)]) : AbortSignal.timeout(liveTimeoutMs)
      try {
        if (!action || action === 'help') {
          const init = await mcpCall(cc.port, 'initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'dsh-dst-gateway', version: '1' },
          }, signal)
          const list = await mcpCall(cc.port, 'tools/list', {}, signal)
          return helpText(init?.instructions, list?.tools ?? [])
        }
        const result = await mcpCall(cc.port, 'tools/call', { name: action, arguments: args?.args ?? {} }, signal)
        const text = (result?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
        return text || '（游戏没有返回内容）'
      } catch (error) {
        if (signal.aborted && !exec?.signal?.aborted) return `失败：等了 ${cc.actionTimeoutMinutes} 分钟还没做完，已放弃等待。先 action="get_state" 看看现在的情况`
        const reason = error?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(String(error?.message))
          ? '连不上插件里的 MCP 服务器：确认 DSH 里这个插件装着、端口没被占'
          : String(error?.message ?? error)
        return '失败：' + reason
      }
    },
  })
  ctx.effect(() => {
    let off = null
    let warned = false
    let disposed = false
    const tick = () => {
      if (disposed) return
      let tools
      try {
        tools = ctx.get?.('tools')
      } catch {}
      if (!tools?.register) {
        if (!warned) {
          warned = true
          log('warn', '这个版本的 DSH 没有工具注册服务，没有添加 dst 入口工具')
        }
        return
      }
      const enabled = currentConfig(config).gatewayEnabled === true
      if (enabled && !off) {
        try {
          off = tools.register(tool)
          log('info', '已在所有会话里添加 dst 入口工具')
        } catch (error) {
          log('warn', '添加 dst 入口工具失败：' + (error?.message ?? error))
        }
      } else if (!enabled && off) {
        const remove = off
        off = null
        try {
          typeof remove === 'function' ? remove() : remove?.dispose?.()
        } catch {}
        log('info', '已撤掉 dst 入口工具')
      }
    }
    tick()
    const timer = setInterval(tick, everyMs)
    return () => {
      disposed = true
      clearInterval(timer)
      const remove = off
      off = null
      try {
        typeof remove === 'function' ? remove() : remove?.dispose?.()
      } catch {}
    }
  })
}
