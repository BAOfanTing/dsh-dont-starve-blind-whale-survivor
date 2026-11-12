// Phase 5 · Survival Controller HTTP 门面
//
// M1：dry-run / 控制权 / 执行记录。
// M2：接 Bridge 控制权同步（跨层一致性）+ 移动动作。
// 不下发任何游戏动作到 Lua —— Lua 通过 Phase 2 HTTP 命令通道自己来取。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { ActionRegistry } from './actionRegistry.js'
import { ControlManager } from './controlManager.js'
import { BridgeControlSync } from './bridgeSync.js'
import { parseActionCommand } from './protocol.js'

export interface ControllerHandle {
  server: Server
  control: ControlManager
  registry: ActionRegistry
  sync: BridgeControlSync | null
  listen(): Promise<number>
  close(): Promise<void>
}

export interface ControllerOptions {
  host?: string
  port?: number
  /** 配了就启用 Controller → Bridge 控制权同步 */
  bridge?: { url: string; token: string }
  /** 测试用：注入假 fetch */
  fetchImpl?: typeof fetch
}

export function createController(options: ControllerOptions = {}): ControllerHandle {
  const control = new ControlManager()
  const registry = new ActionRegistry(control, { forceDryRun: true })
  const sync = options.bridge === undefined
    ? null
    : new BridgeControlSync({ bridgeUrl: options.bridge.url, token: options.bridge.token, ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) })
  // 每次控制权变更推给 Bridge；失败只记在 sync.status() 里，不阻塞控制逻辑
  if (sync !== null) {
    control.setOnStatusChange((status) => {
      void sync.push(status, status.last_change?.reason ?? '状态变更')
    })
    // 启动时把初始 SUPERVISED 状态也推一次
    void sync.push(control.getControlStatus(), 'Controller 启动同步')
  }
  let requests = 0
  let rejected = 0

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  const server = createServer((req, res) => {
    void (async () => {
      requests += 1
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      const method = (req.method ?? 'GET').toUpperCase()

      if (path === '/health' && method === 'GET') {
        send(res, 200, {
          ok: true, service: 'blind-whale-survivor-controller', version: '0.5.0-m2',
          mode: control.getControlStatus().mode, dry_run_only: true,
          bridge_sync: sync === null ? null : sync.status(),
          actions: registry.stats(), requests, rejected,
        })
        return
      }

      if (path === '/api/control/status' && method === 'GET') {
        send(res, 200, { ok: true, ...control.getControlStatus(), actions: registry.stats() })
        return
      }

      if (path === '/api/control/acquire' && method === 'POST') {
        const raw = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        try {
          const lease = control.acquireControl({
            controller_id: String(raw.controller_id ?? ''),
            session_id: String(raw.session_id ?? ''),
            ...(typeof raw.mode === 'string' ? { mode: raw.mode as never } : {}),
          }, { human: raw.human === true })
          send(res, 200, { ok: true, lease })
        } catch (e) {
          rejected += 1
          send(res, 409, { ok: false, error: { code: (e as Error).name, message: (e as Error).message } })
        }
        return
      }

      if (path === '/api/control/release' && method === 'POST') {
        const raw = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        try {
          const ok = control.releaseControl(String(raw.controller_id ?? ''), { human: raw.human === true })
          send(res, 200, { ok })
        } catch (e) {
          rejected += 1
          send(res, 409, { ok: false, error: { message: (e as Error).message } })
        }
        return
      }

      if (path === '/api/control/emergency-stop' && method === 'POST') {
        const raw = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        const cancelled = registry.emergencyCancelAll()
        const status = control.emergencyStop(String(raw.reason ?? 'HTTP 紧急停止'))
        send(res, 200, { ok: true, cancelled, status })
        return
      }

      if (path === '/api/control/clear-emergency' && method === 'POST') {
        send(res, 200, { ok: true, status: control.clearEmergencyStop() })
        return
      }

      if (path === '/api/actions/submit' && method === 'POST') {
        const text = await readBody(req)
        let raw: unknown
        try { raw = JSON.parse(text.length > 0 ? text : '{}') } catch {
          rejected += 1
          send(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: '请求体不是合法 JSON' } })
          return
        }
        const parsed = parseActionCommand(raw, Date.now())
        if (!parsed.ok) {
          rejected += 1
          send(res, 400, { ok: false, error: { code: parsed.code, message: parsed.message } })
          return
        }
        const result = registry.submit(parsed.value)
        if (!result.ok) rejected += 1
        send(res, result.ok ? 200 : 409, result)
        return
      }

      if (path.startsWith('/api/actions/') && method === 'GET') {
        const id = path.slice('/api/actions/'.length)
        const record = registry.get(id)
        send(res, record === null ? 404 : 200, record === null ? { ok: false, error: { message: '没有这个动作' } } : { ok: true, record })
        return
      }

      if (path === '/api/actions' && method === 'GET') {
        send(res, 200, { ok: true, records: registry.list({ limit: 100 }), stats: registry.stats() })
        return
      }

      if (path === '/api/actions/dry-run' && method === 'POST') {
        const raw = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        const result = registry.dryRun(String(raw.action_id ?? ''), String(raw.controller_id ?? ''))
        send(res, result.ok ? 200 : 409, result)
        return
      }

      if (path === '/api/actions/confirm' && method === 'POST') {
        const raw = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        const result = registry.confirm(String(raw.action_id ?? ''), String(raw.controller_id ?? ''))
        send(res, result.ok ? 200 : 409, result)
        return
      }

      if (path === '/api/actions/cancel' && method === 'POST') {
        const raw = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        const result = registry.cancel(String(raw.action_id ?? ''), String(raw.controller_id ?? ''), { human: raw.human === true })
        send(res, result.ok ? 200 : 409, result)
        return
      }

      if (path === '/api/actions/timeout-sweep' && method === 'POST') {
        send(res, 200, { ok: true, swept: registry.sweepTimeouts() })
        return
      }

      if (path === '/api/actions/reconcile' && method === 'POST') {
        const raw = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        send(res, 200, registry.reconcile(String(raw.action_id ?? '')))
        return
      }

      send(res, 404, {
        ok: false,
        error: { code: 'NOT_FOUND', message: `没有这个接口：${method} ${path}` },
        endpoints: [
          'GET  /health', 'GET  /api/control/status', 'POST /api/control/acquire', 'POST /api/control/release',
          'POST /api/control/emergency-stop', 'POST /api/control/clear-emergency',
          'POST /api/actions/submit', 'GET  /api/actions', 'GET  /api/actions/:id',
          'POST /api/actions/dry-run', 'POST /api/actions/confirm', 'POST /api/actions/cancel',
          'POST /api/actions/timeout-sweep', 'POST /api/actions/reconcile',
        ],
      })
    })().catch((e: unknown) => {
      rejected += 1
      if (!res.headersSent) send(res, 500, { ok: false, error: { message: String((e as Error)?.message ?? e) } })
    })
  })

  return {
    server,
    control,
    registry,
    sync,
    listen: () => new Promise<number>((resolve, reject) => {
      const onError = (e: Error) => { server.removeListener('listening', onListening); reject(e) }
      const onListening = () => {
        server.removeListener('error', onError)
        const a = server.address()
        resolve(typeof a === 'object' && a ? a.port : (options.port ?? 0))
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1')
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
