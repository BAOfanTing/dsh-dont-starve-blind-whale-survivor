import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { HttpServer } from '../lib/http-server.js'
import { GameBridge } from '../lib/bridge.js'
import { tempDir } from './helpers.mjs'

test('HTTP Bridge 极速通道高负载与压力测试', async () => {
  const dir = tempDir('whale-stress-bridge-')
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true, enableHttp: true })

  // 等待 HTTP 服务绑定端口
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(bridge.httpPort > 0)

  const postExchange = (data) => new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${bridge.httpPort}/v1/exchange?t=${bridge.httpToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.end(JSON.stringify(data))
  })

  const baseState = {
    ready: true,
    text: '威尔逊正在压力测试',
    data: { players: 1, health: 100, sanity: 200 },
  }

  // 1. 模拟连续 50 次超高频 Tick 上报 (模拟 50Hz 极致负载，相当于每 20ms 一次)
  const count = 50
  const startTime = Date.now()
  let ackedCount = 0

  for (let i = 0; i < count; i++) {
    const reply = await postExchange({
      state: { ...baseState, seq: i },
      ack: { cmd_id: `cmd_${i - 1}` },
    })
    if (reply.ok) ackedCount++
  }

  const duration = Date.now() - startTime
  const avgLatency = duration / count

  console.log(`[压力测试结果] 50次往返总耗时: ${duration}ms, 平均单次延迟: ${avgLatency.toFixed(2)}ms`)
  assert.equal(ackedCount, count, '所有高频心跳包必须均正常返回 200 OK')
  assert.ok(avgLatency < 25, `单次往返延迟应极其轻量（当前: ${avgLatency}ms）`)

  // 2. 并发执行多个动作调用并在 exchange 中顺带派发和完成
  const callPromises = []
  for (let i = 0; i < 5; i++) {
    callPromises.push(
      bridge.call(`stress_action_${i}`, { index: i }, { timeoutMs: 2000 })
    )
  }

  // 模拟下一帧，Node 一次性把队列里的指令返回给模拟的客户端
  const stepReply = await postExchange({ state: baseState })
  assert.equal(stepReply.commands.length, 5, '积压的 5 个指令必须一次性下发')

  // 模拟游戏端立即完成并按序回传执行结果
  for (const cmd of stepReply.commands) {
    await postExchange({
      state: baseState,
      result: { id: cmd.id, ok: true, text: `完成 ${cmd.action}` },
    })
  }

  const results = await Promise.all(callPromises)
  for (let i = 0; i < 5; i++) {
    assert.equal(results[i].ok, true)
    assert.equal(results[i].text, `完成 stress_action_${i}`)
  }

  bridge.close()
})
