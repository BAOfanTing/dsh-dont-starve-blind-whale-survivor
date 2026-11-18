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

  // 模拟 Node 端响应，捎带一条带有效租约的 wait 动作，以及 settings 设置对象（验证 apply_settings 不再为 nil）
  const cmdObj = harness.cmd({ id: 'cmd_999', action: 'wait', args: { seconds: 1 }, protocol_version: 1 })
  const responseJson = JSON.stringify({
    ok: true,
    commands: [cmdObj],
    settings: { pause: false, interval: 2, verbose: true },
  })
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

test('GameBridge: 双分片（Master 与 Caves）状态优先级竞争与指令防截胡', async () => {
  const dir = tempDir('whale-dualshard-bridge-')
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true, enableHttp: true })
  await new Promise((resolve) => setTimeout(resolve, 50))

  const postExchange = (data) => new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${bridge.httpPort}/v1/exchange?t=${bridge.httpToken}`, { method: 'POST' }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
    })
    req.end(JSON.stringify(data))
  })

  const masterState = {
    ready: true,
    text: '威尔逊正在地面（地上主分片）',
    data: {
      players: 1,
      identity: { shard_id: '1', session_id: 'sess_master' },
    },
  }

  const cavesInactiveState = {
    ready: false,
    text: '洞穴分片（暂无玩家进入）',
    data: {
      players: 0,
      identity: { shard_id: '886797363', session_id: 'sess_caves' },
    },
  }

  // 1. 地上 Master 分片先上报状态
  const repMaster1 = await postExchange({ state: masterState })
  assert.equal(repMaster1.ok, true)
  assert.equal(bridge.readState()?.json.text, '威尔逊正在地面（地上主分片）')

  // 2. 洞穴 Caves 分片（0 玩家）随后也向同一个 HTTP 端口上报
  const repCaves1 = await postExchange({ state: cavesInactiveState })
  assert.equal(repCaves1.ok, true)

  // 关键断言：空闲的洞穴分片不得覆盖 Master 的活跃状态！
  assert.equal(bridge.readState()?.json.text, '威尔逊正在地面（地上主分片）')

  // 3. 此时外部下发一个动作
  let callDone = false
  const callPromise = bridge.call('chop_nearest', { target_kind: 'tree' }, { timeoutMs: 3000 }).then((res) => {
    callDone = true
    return res
  })

  // 4. 洞穴分片空闲轮询，尝试交换
  const repCaves2 = await postExchange({ state: cavesInactiveState })
  // 关键断言：空闲洞穴分片绝对不能截胡地上分片的指令！
  assert.equal(repCaves2.commands.length, 0, '0 玩家的洞穴分片不能领走指令')

  // 5. 地上 Master 分片心跳拉取指令
  const repMaster2 = await postExchange({ state: masterState })
  assert.equal(repMaster2.commands.length, 1, '活跃的地上分片成功认领指令')
  const cmd = repMaster2.commands[0]
  assert.equal(cmd.action, 'chop_nearest')

  // 6. Master 分片执行完成并上报结果
  await postExchange({
    state: masterState,
    result: { id: cmd.id, ok: true, text: '砍伐成功' },
  })
  const res = await callPromise
  assert.equal(callDone, true)
  assert.equal(res.ok, true)
  assert.equal(res.text, '砍伐成功')

  // 7. 模拟分片切换：玩家进入洞穴（下洞）
  // Master 玩家离开，变为 0 人
  const masterLeavingState = {
    ready: false,
    text: '地上分片（玩家已离开）',
    data: {
      players: 0,
      identity: { shard_id: '1', session_id: 'sess_master' },
    },
  }
  await postExchange({ state: masterLeavingState })

  // 洞穴分片加载完成，玩家在洞穴中活跃！
  const cavesActiveState = {
    ready: true,
    text: '威尔逊正在地下洞穴',
    data: {
      players: 1,
      identity: { shard_id: '886797363', session_id: 'sess_caves' },
    },
  }

  // 外部下发洞穴中的动作
  let cavesCallDone = false
  const cavesCallPromise = bridge.call('mine_nearest', { target_kind: 'rock' }, { timeoutMs: 3000 }).then((res) => {
    cavesCallDone = true
    return res
  })

  // 洞穴分片上报活跃状态
  const repCaves3 = await postExchange({ state: cavesActiveState })
  // 状态应无缝切换为洞穴
  assert.equal(bridge.readState()?.json.text, '威尔逊正在地下洞穴')
  // 洞穴分片认领指令
  assert.equal(repCaves3.commands.length, 1)
  assert.equal(repCaves3.commands[0].action, 'mine_nearest')

  // 此时地上分片（0人）即便轮询，也不会干扰洞穴
  const repMaster3 = await postExchange({ state: masterLeavingState })
  assert.equal(repMaster3.commands.length, 0)
  assert.equal(bridge.readState()?.json.text, '威尔逊正在地下洞穴')

  // 洞穴分片完成指令
  await postExchange({
    state: cavesActiveState,
    result: { id: repCaves3.commands[0].id, ok: true, text: '采矿成功' },
  })
  const cavesRes = await cavesCallPromise
  assert.equal(cavesCallDone, true)
  assert.equal(cavesRes.ok, true)

  bridge.close()
})

test('Lua: 无玩家时降低 HTTP 轮询频率（防洞穴空闲分片频繁轮询）', async () => {
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
        -- 模拟立即完成回调
        cb('{"ok":true,"commands":[]}', true, 200)
      end
    `,
  })

  harness.run(luaIoFiles({
    'whale_io_http.json': { port: 18788, token: 'sec_tok_888' },
    'whale_io_lease.json': testAuthority(),
  }))

  // 启动服务
  harness.run(`
    Whale.bridge.boot()
  `)

  // 模拟洞穴分片：0 玩家
  harness.run(`
    GLOBAL.AllPlayers = {}
    QUERY_SERVER_CALLS = {}
    -- 连续跑 5 次 server_tick
    for i = 1, 5 do
      SERVER_TICK()
    end
    CALLS_COUNT = #QUERY_SERVER_CALLS
  `)

  // 5 次 tick 中，无玩家时只能触发 1 次握手，其余 4 次被 5 秒限频阻断
  const callsCount = Number(harness.get('CALLS_COUNT'))
  assert.equal(callsCount, 1, '无玩家时不得每次 server_tick 都发起 HTTP 轮询')
})
