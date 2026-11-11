// M4 测试：命令队列（状态机 / 幂等 / 过期 / 会话丢失）+ 三个接口
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { CommandQueue } from '../src/commands.js'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { createBridgeServer } from '../src/server.js'
import { SessionManager } from '../src/session.js'
import { BridgeState } from '../src/state.js'

const TOKEN = 'm4-token-0123456789abcdef'

function postJson(base: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const url = new URL(path, base)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: {} },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} })
        })
      },
    )
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

async function startHarness() {
  const config = loadConfig({ env: {}, port: 0, token: TOKEN, writeTokenFile: false })
  const logger = createLogger({ secrets: [config.token], sink: () => {} })
  const state = new BridgeState()
  const sessions = new SessionManager()
  const commands = new CommandQueue()
  const handle = createBridgeServer({ config, logger, state, sessions, commands })
  const port = await handle.listen(0)
  return { base: `http://127.0.0.1:${port}`, sessions, commands, close: () => handle.close() }
}

test('CommandQueue：只允许白名单里的四个测试命令', () => {
  const queue = new CommandQueue()
  queue.enqueue('ping')
  assert.throws(() => queue.enqueue('move_to'), /unsupported_command_type/)
  assert.throws(() => queue.enqueue('chop'), /unsupported_command_type/)
})

test('CommandQueue：poll 投递 → result 结算；重复回执只算一次', () => {
  const queue = new CommandQueue()
  const command = queue.enqueue('ping')

  const first = queue.poll('S1', 'master')
  assert.equal(first.command?.id, command.id)
  assert.equal(first.command?.status, 'DELIVERED')
  assert.equal(first.command?.deliveries, 1)

  const second = queue.poll('S1', 'master')
  assert.equal(second.command, null, '没有新命令了')

  const settled = queue.settle('S1', {
    commandId: command.id,
    status: 'SUCCEEDED',
    result: { message: 'Pong from DST' },
    executionTime: 0.002,
  })
  assert.equal(settled.ok, true)
  assert.equal(settled.duplicate, false)
  assert.equal(settled.command?.status, 'SUCCEEDED')

  const again = queue.settle('S1', { commandId: command.id, status: 'SUCCEEDED', result: { x: 1 } })
  assert.equal(again.duplicate, true, '第二次回执必须判重复')
  assert.deepEqual(again.command?.result, { message: 'Pong from DST' }, '重复回执不能覆盖结果')
})

test('CommandQueue：投递超时会重投同一条命令（同 id，游戏端按 id 去重）', () => {
  let clock = 1000
  const queue = new CommandQueue({ redeliverAfterMs: 5000, now: () => clock })
  const command = queue.enqueue('echo')

  assert.equal(queue.poll('S1', 'master').command?.id, command.id)
  clock += 3000
  assert.equal(queue.poll('S1', 'master').command, null, '还没到重投时间')

  clock += 3000
  const again = queue.poll('S1', 'master')
  assert.equal(again.command?.id, command.id, '超时后重投同一条')
  assert.equal(again.command?.deliveries, 2)
})

test('CommandQueue：QUEUED 过期 → EXPIRED，不会再被投递', () => {
  let clock = 1000
  const queue = new CommandQueue({ ttlMs: 5000, now: () => clock })
  const command = queue.enqueue('ping')
  clock += 6000
  assert.equal(queue.poll('S1', 'master').command, null)
  assert.equal(queue.get(command.id)?.status, 'EXPIRED')
})

test('CommandQueue：会话丢失 → FAILED(unknown_completion)，绝不重放', () => {
  const queue = new CommandQueue()
  const command = queue.enqueue('get_state')
  queue.poll('S1', 'master')

  const reaped = queue.reapSession('S1')
  assert.equal(reaped, 1)
  const record = queue.get(command.id)
  assert.equal(record?.status, 'FAILED')
  assert.equal(record?.error, 'unknown_completion')
  assert.equal(record?.note, 'session_lost')

  // 换了会话也不会再拿到这条
  assert.equal(queue.poll('S2', 'master').command, null)
})

test('CommandQueue：会话丢失后收到迟到结果 → 接受并标 late', () => {
  const queue = new CommandQueue()
  const command = queue.enqueue('ping')
  queue.poll('S1', 'master')
  queue.reapSession('S1')

  const late = queue.settle('S1', { commandId: command.id, status: 'SUCCEEDED', result: { message: 'Pong from DST' } })
  assert.equal(late.ok, true)
  assert.equal(late.command?.status, 'SUCCEEDED')
  assert.equal(late.command?.late, true)
})

test('CommandQueue：会话不匹配 / 未知命令 / 状态非法 都会被拒', () => {
  const queue = new CommandQueue()
  const command = queue.enqueue('ping')
  queue.poll('S1', 'master')

  assert.equal(queue.settle('S2', { commandId: command.id, status: 'SUCCEEDED' }).reason, 'session_mismatch')
  assert.equal(queue.settle('S1', { commandId: 'cmd_nope', status: 'SUCCEEDED' }).reason, 'unknown_command')
  assert.equal(queue.settle('S1', { commandId: command.id, status: 'QUEUED' as never }).reason, 'invalid_status')
})

test('CommandQueue：队列上限 + 结果过大时截断', () => {
  const queue = new CommandQueue({ maxQueue: 2, maxResultBytes: 200 })
  queue.enqueue('ping')
  queue.enqueue('ping')
  assert.throws(() => queue.enqueue('ping'), /queue_full/)

  const big = new CommandQueue({ maxResultBytes: 200 })
  const command = big.enqueue('get_state')
  big.poll('S1', 'master')
  big.settle('S1', { commandId: command.id, status: 'SUCCEEDED', result: { pad: 'x'.repeat(2000) } })
  const record = big.get(command.id)
  assert.equal(record?.note, 'result_truncated')
  assert.deepEqual(record?.result, { truncated: true, original_bytes: (record?.result as { original_bytes: number }).original_bytes })
})

test('HTTP：完整链路 enqueue → poll → result', async () => {
  const h = await startHarness()
  try {
    // 先心跳，让会话存在（result 要求 session 已心跳过）
    const hb = await postJson(h.base, '/api/v1/heartbeat', {
      token: TOKEN,
      session_id: 'S1',
      timestamp: 1794410000,
      shard: 'master',
    })
    assert.equal(hb.status, 200)

    const enq = await postJson(h.base, '/api/v1/commands/enqueue', { token: TOKEN, type: 'ping' })
    assert.equal(enq.status, 200, JSON.stringify(enq.json))
    const commandId = enq.json.command.id

    const poll = await postJson(h.base, '/api/v1/commands/poll', { token: TOKEN, session_id: 'S1', last_acknowledged_id: null })
    assert.equal(poll.status, 200)
    assert.equal(poll.json.command.id, commandId)
    assert.equal(poll.json.command.type, 'ping')
    assert.equal(poll.json.command.status, 'DELIVERED')

    const empty = await postJson(h.base, '/api/v1/commands/poll', { token: TOKEN, session_id: 'S1', last_acknowledged_id: commandId })
    assert.equal(empty.json.command, null)

    const res = await postJson(h.base, '/api/v1/commands/result', {
      token: TOKEN,
      session_id: 'S1',
      command_id: commandId,
      status: 'SUCCEEDED',
      result: { message: 'Pong from DST' },
      error: null,
      execution_time: 0.001,
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.status, 'SUCCEEDED')
    assert.equal(res.json.duplicate, false)

    const dup = await postJson(h.base, '/api/v1/commands/result', {
      token: TOKEN,
      session_id: 'S1',
      command_id: commandId,
      status: 'SUCCEEDED',
      result: { message: 'ignored' },
    })
    assert.equal(dup.json.duplicate, true)

    const list = await fetch(`${h.base}/api/v1/commands?token=${TOKEN}`)
    const listed = (await list.json()) as Record<string, any>
    assert.equal(listed.stats.SUCCEEDED, 1)
    assert.equal(listed.commands[0].result.message, 'Pong from DST')
  } finally {
    await h.close()
  }
})

test('HTTP：enqueue 拒绝白名单外的类型；result 对未知命令 404；无 token 401', async () => {
  const h = await startHarness()
  try {
    const hb = await postJson(h.base, '/api/v1/heartbeat', { token: TOKEN, session_id: 'S1', timestamp: 1 })
    assert.equal(hb.status, 200)

    const badType = await postJson(h.base, '/api/v1/commands/enqueue', { token: TOKEN, type: 'attack' })
    assert.equal(badType.status, 400)
    assert.match(String(badType.json.error.message), /ping/)

    const unknown = await postJson(h.base, '/api/v1/commands/result', {
      token: TOKEN,
      session_id: 'S1',
      command_id: 'cmd_nope',
      status: 'SUCCEEDED',
    })
    assert.equal(unknown.status, 404)

    const noToken = await postJson(h.base, '/api/v1/commands/poll', { session_id: 'S1' })
    assert.equal(noToken.status, 401)
  } finally {
    await h.close()
  }
})

test('HTTP：会话死了之后 poll 会把它的命令判 unknown_completion', async () => {
  let clock = 1000
  const config = loadConfig({ env: {}, port: 0, token: TOKEN, writeTokenFile: false })
  const logger = createLogger({ secrets: [config.token], sink: () => {} })
  const state = new BridgeState()
  const sessions = new SessionManager({ heartbeatTimeoutMs: 10000, now: () => clock })
  const commands = new CommandQueue()
  const handle = createBridgeServer({ config, logger, state, sessions, commands })
  const port = await handle.listen(0)
  const base = `http://127.0.0.1:${port}`
  try {
    await postJson(base, '/api/v1/heartbeat', { token: TOKEN, session_id: 'S1', timestamp: 1, shard: 'master' })
    const enq = await postJson(base, '/api/v1/commands/enqueue', { token: TOKEN, type: 'get_state' })
    const commandId = enq.json.command.id
    await postJson(base, '/api/v1/commands/poll', { token: TOKEN, session_id: 'S1' })

    // 会话心跳超时（模拟游戏重启）
    clock += 20000
    await postJson(base, '/api/v1/commands/poll', { token: TOKEN, session_id: 'S2' })
    const record = commands.get(commandId)
    assert.equal(record?.status, 'FAILED')
    assert.equal(record?.error, 'unknown_completion')
  } finally {
    await handle.close()
  }
})
