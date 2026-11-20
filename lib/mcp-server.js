// 本机 MCP 服务器（Streamable HTTP）
//
// 为什么在 DSH 这边而不是游戏里：饥荒的 Lua 模组不能监听端口，
// 所以「MCP 服务器」只能跑在外面（DSH 进程里），它再通过文件桥跟游戏说话。
//
// 顺便提供插件要用的两个接口：
//   GET/POST /settings  插件把设置推过来（模组会读设置文件，所以改了马上生效）
//   GET /status         一眼看现在的状态（连没连上游戏、哪个目录）

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const PROTOCOL_VERSION = '2025-06-18'
const HEARTBEAT_MS = 15000

function cors(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type, accept, mcp-session-id, mcp-protocol-version')
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('access-control-expose-headers', 'mcp-session-id')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 8 * 1024 * 1024) {
        reject(new Error('请求太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  cors(res)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/**
 * @param {object} options
 * @param {(level: string, message: string) => void} options.log
 * @param {object} options.bridge      GameBridge
 * @param {() => object} options.settings 现在的设置
 * @param {(result: string) => void} options.onToolCall 记日志用（可选）
 * @param {(name: string, args: object, extra: object) => Promise<string>} options.executeTool
 * @param {() => Array<object>} options.toolList
 * @param {() => string} options.instructions
 */
export function createMcpServer({ log = () => {}, bridge, settings, executeTool, toolList, instructions }) {
  const sessions = new Set()
  const sseClients = new Set()
  let server = null
  let port = 0

  function notifyListChanged() {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
      params: {},
    })
    for (const client of sseClients) {
      try {
        client.write(`event: message\ndata: ${payload}\n\n`)
      } catch {}
    }
  }

  const settingsRevision = () => {
    const text = JSON.stringify(settings())
    let hash = 0
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) | 0
    }
    return (hash >>> 0).toString(16)
  }

  async function handleRpc(message, res, extra) {
    const { id, method, params } = message ?? {}
    const respond = (result) => ({
      jsonrpc: '2.0',
      id,
      result,
    })
    const fail = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } })

    if (method === 'initialize') {
      const sessionId = randomUUID()
      sessions.add(sessionId)
      res.setHeader('mcp-session-id', sessionId)
      return respond({
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'dst-whale-bridge', version: '0.1.0' },
        instructions: instructions(),
      })
    }
    if (method === 'ping') return respond({})
    if (method === 'tools/list') return respond({ tools: toolList() })
    if (method === 'resources/list') return respond({ resources: [] })
    if (method === 'prompts/list') return respond({ prompts: [] })
    if (method === 'tools/call') {
      const name = params?.name
      const args = params?.arguments ?? {}
      try {
        const text = await executeTool(name, args, extra)
        return respond({ content: [{ type: 'text', text: String(text) }] })
      } catch (error) {
        return respond({
          content: [{ type: 'text', text: '失败：' + String(error?.message ?? error) }],
          isError: true,
        })
      }
    }
    return fail(-32601, `没有这个方法：${method}`)
  }

  async function handleMcpPost(req, res) {
    let body
    try {
      body = await readBody(req)
    } catch (error) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: String(error) } })
      return
    }
    let message
    try {
      message = JSON.parse(body)
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: '不是合法的 JSON' } })
      return
    }
    const batch = Array.isArray(message) ? message : [message]
    const requests = batch.filter((m) => m && typeof m === 'object' && m.method && m.id !== undefined)
    const notifications = batch.filter((m) => m && typeof m === 'object' && m.method && m.id === undefined)

    for (const note of notifications) {
      if (note.method === 'notifications/initialized') {
        const session = req.headers['mcp-session-id']
        if (session) sessions.add(String(session))
      }
    }

    if (requests.length === 0) {
      cors(res)
      res.writeHead(202).end()
      return
    }

    const isToolCall = requests.some((m) => m.method === 'tools/call')
    const extra = { signal: null }

    if (isToolCall) {
      // 动作可能很久（睡觉要好几分钟）：用 SSE 回，中间发心跳，客户端就不会超时断开
      cors(res)
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      const timer = setInterval(() => {
        try {
          res.write(': keep-alive\n\n')
        } catch {}
      }, HEARTBEAT_MS)
      const abort = () => extra.signal?.abort?.()
      res.on('close', () => {
        clearInterval(timer)
        abort()
      })
      try {
        for (const request of requests) {
          const payload = await handleRpc(request, res, extra)
          res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
        }
      } catch (error) {
        log('warn', '处理工具调用时出错：' + String(error?.message ?? error))
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: requests[0]?.id ?? null, error: { code: -32603, message: String(error?.message ?? error) } })}\n\n`)
      } finally {
        clearInterval(timer)
        res.end()
      }
      return
    }

    const payloads = []
    for (const request of requests) {
      payloads.push(await handleRpc(request, res, extra))
    }
    if (Array.isArray(message)) sendJson(res, 200, payloads)
    else sendJson(res, 200, payloads[0])
  }

  async function handleSettings(req, res) {
    if (req.method === 'GET') {
      sendJson(res, 200, { revision: settingsRevision(), settings: settings() })
      return
    }
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 400, { error: '不是合法的 JSON' })
      return
    }
    const next = body?.settings ?? body
    if (typeof next !== 'object' || next === null) {
      sendJson(res, 400, { error: '没有 settings' })
      return
    }
    onSettings?.(next)
    const pushed = bridge.pushSettings({ ...next, revision: settingsRevision() })
    notifyListChanged()
    sendJson(res, 200, {
      ok: true,
      revision: settingsRevision(),
      message: pushed > 0 ? `设置已推送到游戏（${pushed} 个目录）` : '设置记下了，但还没找到游戏的文件桥（游戏没开？）',
    })
  }

  let onSettings = null
  const setSettingsHandler = (fn) => {
    onSettings = fn
  }

  function handleStatus(_req, res) {
    const status = bridge.status()
    const lines = [
      '# 大肥鱼饿不死（饥荒）插件状态',
      `- MCP 地址：http://127.0.0.1:${port}/mcp`,
      `- 游戏：${status.connected ? '连着' : '没连上'}`,
      status.dir ? `- 桥目录：${status.dir}（${status.channel}）` : '- 桥目录：还没找到',
      status.mod ? `- 模组版本：${status.mod}` : null,
      status.reason ? `- 原因：${status.reason}` : null,
      `- 找到的候选目录：${(status.dirs ?? []).length} 个`,
      ...(status.dirs ?? []).slice(0, 8).map((d) => `  - ${d}`),
      `- 设置版本：${settingsRevision()}`,
    ].filter(Boolean)
    cors(res)
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(lines.join('\n') + '\n')
  }

  const instance = {
    get port() {
      return port
    },
    get url() {
      return `http://127.0.0.1:${port}/mcp`
    },
    setSettingsHandler,
    settingsRevision,
    notifyListChanged,
    async start(wantPort = 18080) {
      server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        try {
          if (req.method === 'OPTIONS') {
            cors(res)
            res.writeHead(204).end()
            return
          }
          if (url.pathname === '/mcp' && req.method === 'POST') return await handleMcpPost(req, res)
          if (url.pathname === '/mcp' && req.method === 'GET') {
            // MCP SSE 通道：支持主动推送通知（如 tools/list_changed）
            cors(res)
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
            res.write(': connected\n\n')
            sseClients.add(res)
            const timer = setInterval(() => {
              try {
                res.write(': keep-alive\n\n')
              } catch {}
            }, HEARTBEAT_MS)
            res.on('close', () => {
              sseClients.delete(res)
              clearInterval(timer)
            })
            return
          }
          if (url.pathname === '/mcp' && req.method === 'DELETE') {
            cors(res)
            res.writeHead(200).end()
            return
          }
          if (url.pathname === '/settings') return await handleSettings(req, res)
          if (url.pathname === '/status') return handleStatus(req, res)
          if (url.pathname === '/') {
            cors(res)
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(`大肥鱼饿不死 MCP 服务器：POST ${instance.url}\n状态：/status\n设置：/settings\n`)
            return
          }
          sendJson(res, 404, { error: '没有这个地址' })
        } catch (error) {
          log('warn', 'HTTP 处理出错：' + String(error?.stack ?? error))
          try {
            sendJson(res, 500, { error: String(error?.message ?? error) })
          } catch {}
        }
      })
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server?.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server?.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(wantPort, '127.0.0.1')
      })
      port = server.address().port
      log('info', `MCP 服务器已启动：${instance.url}`)
      return instance
    },
    async stop() {
      if (!server) return
      const closing = server
      server = null
      try {
        // 长连接（SSE）会一直占着，先掐掉，否则 close 永远等不到
        closing.closeAllConnections?.()
      } catch {}
      await new Promise((resolve) => closing.close(() => resolve()))
      port = 0
    },
  }

  return instance
}
