// M2 测试：Bridge Client（缓存 / 并发合并 / 过期判定 / 错误分类 / 命令封装）
//
// 用**真实的 HTTP 假 Bridge**（node:http），不是 mock 函数 —— 这样超时、状态码、JSON 解析都是真跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { BridgeClient } from '../src/bridge/client.js'
import { loadConfig } from '../src/config.js'
import { ToolError } from '../src/schemas/errors.js'
import { createLogger } from '../src/utils/logger.js'

interface FakeBridge {
  server: Server
  base: string
  hits: string[]
  close: () => Promise<void>
  setHandler: (handler: (req: { path: string; query: URLSearchParams }, res: (status: number, body: unknown) => void) => void) => void
}

async function startFakeBridge(): Promise<FakeBridge> {
  const hits: string[] = []
  let handler: (req: { path: string; query: URLSearchParams }, res: (status: number, body: unknown) => void) => void = (
    _req,
    res,
  ) => res(200, { success: true })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    hits.push(url.pathname + (url.searchParams.has('shard') ? `?shard=${url.searchParams.get('shard')}` : ''))
    handler({ path: url.pathname, query: url.searchParams }, (status, body) => {
      const text = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    setHandler: (next) => {
      handler = next
    },
  }
}

function makeClient(base: string, options: { cacheTtlMs?: number; now?: () => number } = {}) {
  const config = { ...loadConfig({ BWS_BRIDGE_URL: base, BWS_TOKEN: 'test-token' }), bridgeUrl: base, token: 'test-token' }
  const logger = createLogger({ sink: () => {} })
  return new BridgeClient(config, logger, options)
}

function snapshotBody(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    protocol_version: '1.0',
    server_time: 1000,
    session: {
      session_id: 'S1',
      shard: 'master',
      game_version: 'release',
      alive: true,
      reconnects: 0,
      heartbeats: 10,
      acknowledged_sequence: 42,
      duplicates: 0,
      gaps: 0,
      player_status: { present: true },
    },
    snapshot: { tick: 42, player: { prefab: 'wilson' } },
    snapshot_at: 900,
    snapshot_age_ms: 100,
    stale: false,
    stale_reason: null,
    stale_after_ms: 15000,
    other_sessions: 1,
    ...overrides,
  }
}

test('readSnapshot：正常读取 + 缓存命中（缓存期内不重复打 Bridge）', async () => {
  const bridge = await startFakeBridge()
  try {
    bridge.setHandler((_req, res) => res(200, snapshotBody()))
    const client = makeClient(bridge.base, { cacheTtlMs: 1000, now: () => 1000 })

    const first = await client.readSnapshot()
    assert.equal(first.fromCache, false)
    assert.equal(first.stale, false)
    assert.equal(first.game.session.session_id, 'S1')
    assert.equal((first.game.snapshot as { tick: number }).tick, 42)
    assert.equal(bridge.hits.length, 1)

    const second = await client.readSnapshot()
    assert.equal(second.fromCache, true, '缓存期内应命中缓存')
    assert.equal(bridge.hits.length, 1, '不该重复打 Bridge')

    await client.readSnapshot({ force: true })
    assert.equal(bridge.hits.length, 2, 'force 应绕过缓存')
  } finally {
    await bridge.close()
  }
})

test('readSnapshot：并发调用只打一次 Bridge（inFlight 合并）', async () => {
  const bridge = await startFakeBridge()
  try {
    bridge.setHandler((_req, res) => {
      // 稍微延迟，制造真正的并发窗口
      setTimeout(() => res(200, snapshotBody()), 60)
    })
    const client = makeClient(bridge.base, { cacheTtlMs: 0 })
    const results = await Promise.all([client.readSnapshot(), client.readSnapshot(), client.readSnapshot()])
    assert.equal(bridge.hits.length, 1, '三次并发只应打一次，实际 ' + bridge.hits.length)
    assert.equal(results.length, 3)
    assert.equal(results[0]?.game.session.session_id, 'S1')
  } finally {
    await bridge.close()
  }
})

test('readSnapshot：Bridge 说 stale 时如实透出（不抛错，交给工具层描述）', async () => {
  const bridge = await startFakeBridge()
  try {
    bridge.setHandler((_req, res) =>
      res(200, snapshotBody({ stale: true, stale_reason: 'heartbeat_timeout', session: { ...snapshotBody().session, alive: false } })),
    )
    const client = makeClient(bridge.base)
    const read = await client.readSnapshot()
    assert.equal(read.stale, true)
    assert.equal(read.staleReason, 'heartbeat_timeout')
    assert.equal(read.game.session.alive, false)
  } finally {
    await bridge.close()
  }
})

test('readFreshSnapshot：过期就抛 STATE_STALE', async () => {
  const bridge = await startFakeBridge()
  try {
    bridge.setHandler((_req, res) =>
      res(200, snapshotBody({ stale: true, stale_reason: 'snapshot_too_old', snapshot_age_ms: 60000 })),
    )
    const client = makeClient(bridge.base)
    await assert.rejects(
      () => client.readFreshSnapshot(),
      (error: unknown) => {
        assert.ok(error instanceof ToolError)
        assert.equal(error.payload.code, 'STATE_STALE')
        assert.match(error.payload.message, /过期/)
        return true
      },
    )
  } finally {
    await bridge.close()
  }
})

test('错误分类：503 → GAME_DISCONNECTED，401 → SESSION_INVALID，500 → INTERNAL_ERROR', async () => {
  const bridge = await startFakeBridge()
  try {
    const client = makeClient(bridge.base)

    bridge.setHandler((_req, res) => res(503, { success: false, error: { code: 'no_session', message: '还没有任何游戏会话' } }))
    await assert.rejects(
      () => client.readSnapshot({ force: true }),
      (error: unknown) => {
        assert.equal((error as ToolError).payload.code, 'GAME_DISCONNECTED')
        return true
      },
    )

    bridge.setHandler((_req, res) => res(401, { success: false, error: { code: 'unauthorized' } }))
    await assert.rejects(
      () => client.readSnapshot({ force: true }),
      (error: unknown) => {
        assert.equal((error as ToolError).payload.code, 'SESSION_INVALID')
        return true
      },
    )

    bridge.setHandler((_req, res) => res(500, { success: false }))
    await assert.rejects(
      () => client.readSnapshot({ force: true }),
      (error: unknown) => {
        assert.equal((error as ToolError).payload.code, 'INTERNAL_ERROR')
        return true
      },
    )
  } finally {
    await bridge.close()
  }
})

test('错误分类：Bridge 连不上 → BRIDGE_UNAVAILABLE；返回非 JSON → INTERNAL_ERROR', async () => {
  // 先起再关，拿到一个确定没人监听的端口
  const dead = await startFakeBridge()
  const deadBase = dead.base
  await dead.close()
  const client = makeClient(deadBase)
  await assert.rejects(
    () => client.readSnapshot({ force: true }),
    (error: unknown) => {
      assert.equal((error as ToolError).payload.code, 'BRIDGE_UNAVAILABLE')
      return true
    },
  )

  const bridge = await startFakeBridge()
  try {
    const server = bridge.server
    server.removeAllListeners('request')
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('this is not json')
    })
    const client2 = makeClient(bridge.base)
    await assert.rejects(
      () => client2.readSnapshot({ force: true }),
      (error: unknown) => {
        assert.equal((error as ToolError).payload.code, 'INTERNAL_ERROR')
        return true
      },
    )
  } finally {
    await bridge.close()
  }
})

test('超时：Bridge 不响应 → TOOL_TIMEOUT', async () => {
  const bridge = await startFakeBridge()
  try {
    bridge.setHandler(() => {
      // 永不响应
    })
    const config = { ...loadConfig({ BWS_TOKEN: 'test-token' }), bridgeUrl: bridge.base, token: 'test-token', toolTimeoutMs: 120 }
    const client = new BridgeClient(config, createLogger({ sink: () => {} }))
    await assert.rejects(
      () => client.readSnapshot({ force: true }),
      (error: unknown) => {
        assert.equal((error as ToolError).payload.code, 'TOOL_TIMEOUT')
        return true
      },
    )
  } finally {
    await bridge.close()
  }
})

test('命令封装：enqueue + 轮询到终态', async () => {
  const bridge = await startFakeBridge()
  try {
    let polls = 0
    bridge.setHandler((req, res) => {
      if (req.path === '/api/v1/commands/enqueue') {
        res(200, { success: true, command: { id: 'cmd_1', type: 'ping', status: 'QUEUED' } })
        return
      }
      if (req.path === '/api/v1/commands') {
        polls += 1
        // 前两次 QUEUED，第三次成功
        const status = polls >= 3 ? 'SUCCEEDED' : 'QUEUED'
        res(200, { success: true, commands: [{ id: 'cmd_1', type: 'ping', status, result: { message: 'Pong from DST' } }] })
        return
      }
      res(404, { success: false })
    })
    const client = makeClient(bridge.base)
    const result = await client.runCommand('ping', {}, { timeoutMs: 3000, pollMs: 20 })
    assert.equal(result.status, 'SUCCEEDED')
    assert.deepEqual(result.result, { message: 'Pong from DST' })
    assert.equal(polls, 3)
  } finally {
    await bridge.close()
  }
})

test('命令封装：一直不完成 → TOOL_TIMEOUT', async () => {
  const bridge = await startFakeBridge()
  try {
    bridge.setHandler((req, res) => {
      if (req.path === '/api/v1/commands/enqueue') {
        res(200, { success: true, command: { id: 'cmd_2', type: 'ping', status: 'QUEUED' } })
        return
      }
      res(200, { success: true, commands: [{ id: 'cmd_2', status: 'QUEUED' }] })
    })
    const client = makeClient(bridge.base)
    await assert.rejects(
      () => client.runCommand('ping', {}, { timeoutMs: 150, pollMs: 20 }),
      (error: unknown) => {
        assert.equal((error as ToolError).payload.code, 'TOOL_TIMEOUT')
        return true
      },
    )
  } finally {
    await bridge.close()
  }
})

test('命令查询：不存在的 id → INVALID_ARGUMENT', async () => {
  const bridge = await startFakeBridge()
  try {
    bridge.setHandler((_req, res) => res(200, { success: true, commands: [] }))
    const client = makeClient(bridge.base)
    await assert.rejects(
      () => client.getCommand('cmd_nope'),
      (error: unknown) => {
        assert.equal((error as ToolError).payload.code, 'INVALID_ARGUMENT')
        return true
      },
    )
  } finally {
    await bridge.close()
  }
})

test('分片参数：带 shard 时请求会带上 ?shard=，且不写缓存', async () => {
  const bridge = await startFakeBridge()
  try {
    bridge.setHandler((_req, res) => res(200, snapshotBody({ other_sessions: 0 })))
    const client = makeClient(bridge.base, { cacheTtlMs: 10000 })
    await client.readSnapshot({ shard: 'caves' })
    assert.deepEqual(bridge.hits, ['/api/v1/state?shard=caves'])
    await client.readSnapshot({ shard: 'caves' })
    assert.equal(bridge.hits.length, 2, '带 shard 的读取不走缓存')
  } finally {
    await bridge.close()
  }
})
