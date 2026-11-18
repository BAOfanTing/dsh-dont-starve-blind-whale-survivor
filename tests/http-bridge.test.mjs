import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { HttpServer } from '../lib/http-server.js'
import { GameBridge } from '../lib/bridge.js'
import { tempDir, luaIoFiles } from './helpers.mjs'
import { loadTargets, testAuthority } from './target-harness.mjs'

test('HttpServer: 基础握手与鉴权', async () => {
  const token = 'test-token-123'
  const server = new HttpServer(0, token)
  const port = await server.listen()

  // 1. 无 token 应该 401
  const resUnauthorized = await new Promise((resolve) => {
    http.request(`http://127.0.0.1:${port}/v1/exchange`, { method: 'POST' }, (res) => {
      resolve(res.statusCode)
    }).end('{}')
  })
  assert.equal(resUnauthorized, 401)

  // 2. 带正确 token（Query 参数）应该 200
  let receivedPayload = null
  server.on('exchange', (payload, reply) => {
    receivedPayload = payload
    reply({ ok: true, echo: 'hello' })
  })

  const resOk = await new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${port}/v1/exchange?t=${token}`, { method: 'POST' }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        })
      })
    })
    req.end(JSON.stringify({ state: { ready: true, players: 1 } }))
  })

  assert.equal(resOk.status, 200)
  assert.equal(resOk.body.ok, true)
  assert.equal(resOk.body.echo, 'hello')
  assert.equal(receivedPayload.state.ready, true)

  await server.close()
})

test('GameBridge: HTTP 极速通信往返与快速响应解析', async () => {
  const dir = tempDir('whale-http-bridge-')
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true, enableHttp: true })

  // 等待 HTTP 服务绑定端口
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(bridge.httpPort > 0, 'HTTP 服务端口必须大于 0')

  // 1. 模拟游戏端首次向 Node 上报观察帧
  const postExchange = (data) => new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${bridge.httpPort}/v1/exchange?t=${bridge.httpToken}`, { method: 'POST' }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
    })
    req.end(JSON.stringify(data))
  })

  const mockState = {
    ready: true,
    text: '威尔逊正在营地',
    data: { players: 1, health: 100, sanity: 200 },
  }

  const reply1 = await postExchange({ state: mockState })
  assert.equal(reply1.ok, true)
  assert.deepEqual(reply1.commands, [])

  // 2. 检查 GameBridge 状态：应立即内存化，且 channel 为 http
  const state = bridge.readState()
  assert.ok(state)
  assert.equal(state.channel, 'http')
  assert.equal(state.json.ready, true)
  assert.match(state.json.text, /威尔逊正在营地/)

  const status = bridge.status()
  assert.equal(status.connected, true)
  assert.equal(status.channel, 'http')

  // 3. 异步下发动作 call()，验证下一次 exchange 顺带指令，并在返回 result 时超低延迟 resolve
  let callResolved = false
  let callResult = null

  const callPromise = bridge.call('chop_nearest', { target_kind: 'tree' }, { timeoutMs: 5000 }).then((res) => {
    callResolved = true
    callResult = res
    return res
  })

  // 模拟下一帧游戏 tick（10ms 后），游戏端心跳 exchange 拉取指令
  await new Promise((r) => setTimeout(r, 10))
  const reply2 = await postExchange({ state: mockState })
  assert.equal(reply2.commands.length, 1)
  assert.equal(reply2.commands[0].action, 'chop_nearest')
  const cmdId = reply2.commands[0].id

  // 模拟动作做完，游戏回传结果
  const reply3 = await postExchange({
    state: mockState,
    result: { id: cmdId, ok: true, text: '砍倒了一棵常青树' },
  })
  assert.equal(reply3.result_acked, true)

  // 验证 callPromise 立即被完成，且拿到准确结果
  const finalRes = await callPromise
  assert.equal(callResolved, true)
  assert.equal(finalRes.ok, true)
  assert.equal(finalRes.text, '砍倒了一棵常青树')

  bridge.close()
})

test('Lua: TheSim:QueryServer 握手与全双工 exchange 回调', async () => {
  let queryServerCalls = []
  const harness = await loadTargets({
    preload: `
      GLOBAL.TheWorld.ismastersim = true
      GLOBAL.TheWorld.DoPeriodicTask = function(self, interval, fn)
        SERVER_TICK = fn
        return { Cancel = function() end }
      end
      QUERY_SERVER_CALLS = {}
      GLOBAL.TheSim.QueryServer = function(self, url, cb, method, body)
        QUERY_SERVER_CALLS[#QUERY_SERVER_CALLS + 1] = {
          url = url,
          method = method,
          body = body,
        }
        QUERY_CB = cb
      end
    `,
  })

  // 提供 HTTP 配置文件
  harness.run(luaIoFiles({
    'whale_io_http.json': { port: 18788, token: 'sec_tok_888' },
    'whale_io_lease.json': testAuthority(),
  }))

  // 触发启动并跑一次 server_tick
  harness.run(`
    Whale.bridge.boot()
    SERVER_TICK()
  `)

  // 验证 Lua 成功发起了 QueryServer 访问
  harness.run(`
    TOTAL_CALLS = #QUERY_SERVER_CALLS
    LAST_URL = TOTAL_CALLS > 0 and QUERY_SERVER_CALLS[TOTAL_CALLS].url or ""
    LAST_METHOD = TOTAL_CALLS > 0 and QUERY_SERVER_CALLS[TOTAL_CALLS].method or ""
    LAST_BODY = TOTAL_CALLS > 0 and QUERY_SERVER_CALLS[TOTAL_CALLS].body or ""
  `)

  const totalCalls = Number(harness.get('TOTAL_CALLS'))
  assert.ok(totalCalls > 0, 'Lua 必须调用 TheSim:QueryServer 发起握手')
  assert.equal(harness.get('LAST_URL'), 'http://127.0.0.1:18788/v1/exchange?t=sec_tok_888')
  assert.equal(harness.get('LAST_METHOD'), 'POST')

  const bodyJson = JSON.parse(harness.get('LAST_BODY'))
  assert.equal(bodyJson.token, 'sec_tok_888')
  assert.ok(bodyJson.state != null, '发送的数据包必须包含 state 观察快照')

  // 模拟 Node 端响应，捎带一条带有效租约的 wait 动作
  const cmdObj = harness.cmd({ id: 'cmd_999', action: 'wait', args: { seconds: 1 }, protocol_version: 1 })
  const responseJson = JSON.stringify({ ok: true, commands: [cmdObj] })
  harness.run(`
    local response_json = [==[${responseJson}]==]
    QUERY_CB(response_json, true, 200)
  `)

  // 验证指令被处理
  harness.run(`
    Whale.actions.Tick()
    ACKED_JOB = (Whale.job ~= nil and Whale.job.name) or "none"
    print("DEBUG: ACKED_JOB =", ACKED_JOB)
  `)
  assert.equal(harness.get('ACKED_JOB'), 'wait')
})
