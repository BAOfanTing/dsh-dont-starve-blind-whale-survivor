// HTTP 接口（只读，只监听本机）
//
//   GET /health            进程/日志/记录统计（永远 200）
//   GET /api/game/status    连接状态：有没有在收记录、多久以前、会话/分片/重开次数
//   GET /api/game/state     合并后的完整快照
//   GET /api/game/player    仅 player 段
//   GET /api/game/inventory 仅 inventory 段
//   GET /api/game/world     仅 world 段
//   GET /api/game/nearby    仅 nearby 段
//
// 没有数据时返回 503 + JSON 说明原因（而不是 200 返回 null），调用方不用猜。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { BridgeConfig } from './config.js'
import type { LogTailer } from './logTailer.js'
import { StateStore } from './store.js'

export interface ServerDeps {
  config: BridgeConfig
  store: StateStore
  tailer: LogTailer
  version?: string
  startedAt?: number
  now?: () => number
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

export function createBridgeServer(deps: ServerDeps) {
  const now = deps.now ?? Date.now
  const startedAt = deps.startedAt ?? now()

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed', allow: ['GET'] })
      return
    }

    const files = deps.tailer.status()
    const status = deps.store.status()

    if (url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        version: deps.version ?? '0.1.0',
        uptime_s: Math.round((now() - startedAt) / 1000),
        logDir: deps.config.logDir,
        pollMs: deps.config.pollMs,
        files,
        records: status.counts,
        connected: status.connected,
        lastRecordAgoMs: status.lastRecordAgoMs,
      })
      return
    }

    if (url.pathname === '/api/game/status') {
      sendJson(res, 200, {
        ...status,
        hasSnapshot: status.hasSnapshot,
        logDir: deps.config.logDir,
        files: files.map((f) => ({
          name: f.name,
          missing: f.missing,
          lines: f.lines,
          records: f.records,
          parseFails: f.parseFails,
          rotations: f.rotations,
          pendingBytes: f.pendingBytes,
        })),
      })
      return
    }

    const snapshot = deps.store.state()
    const notReady = {
      ok: false,
      error: 'no_snapshot_yet',
      reason: status.reason ?? '还没收到状态记录',
      status,
    }

    if (url.pathname === '/api/game/state') {
      if (!snapshot) {
        sendJson(res, 503, notReady)
        return
      }
      sendJson(res, 200, { ok: true, state: snapshot })
      return
    }

    const sections: Record<string, keyof NonNullable<typeof snapshot>> = {
      '/api/game/player': 'player',
      '/api/game/inventory': 'inventory',
      '/api/game/world': 'world',
      '/api/game/nearby': 'nearby',
    }
    const section = sections[url.pathname]
    if (section) {
      const value = snapshot ? snapshot[section] : undefined
      if (value === undefined) {
        sendJson(res, 503, { ...notReady, section })
        return
      }
      sendJson(res, 200, { ok: true, tick: snapshot?.tick, [section]: value })
      return
    }

    sendJson(res, 404, {
      ok: false,
      error: 'not_found',
      endpoints: ['/health', '/api/game/status', '/api/game/state', '/api/game/player', '/api/game/inventory', '/api/game/world', '/api/game/nearby'],
    })
  })
}
