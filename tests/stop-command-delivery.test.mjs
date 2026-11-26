// stop-command-delivery.test.mjs
// Phase R.7.3: 验证取消命令及时从 pendingHttpCommands 清理，防止投递给 Lua 执行

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GameBridge } from '../lib/bridge.js'

/**
 * ★ 真机环境下的测试隔离（2026-11-25 修正）：
 *   这里原来写 `new GameBridge({ dirs: [tempDir] })` —— 但构造函数**没有** `dirs` 这个参数，
 *   它会被忽略，于是 bridge 照常去翻本机真实存档目录。结果：
 *     · 真实 `whale_result.json` 里残留的 `id` 恰好等于测试用的 `cmd-1`，
 *       `call()` 轮询时读到它并**正常 resolve**，`assert.rejects` 就报 "Missing expected rejection"；
 *     · 游戏开着时必红，关着时偶发绿，属于典型的测试污染。
 *   正确做法：`bridgeDir` + `lockDir: true` —— 只认这一个目录，绝不碰真实存档。
 */
function isolatedBridge() {
  const tempDir = mkdtempSync(join(tmpdir(), 'bws-bridge-'))
  const bridge = new GameBridge({ bridgeDir: tempDir, lockDir: true })
  bridge.httpConnected = true
  return bridge
}

test('STOP-DELIVERY-01: 下发前已 abort 的命令不会进入 pendingHttpCommands', async () => {
  const bridge = isolatedBridge()

  const controller = new AbortController()
  controller.abort()

  assert.equal(bridge.pendingHttpCommands.length, 0)
  await assert.rejects(
    async () => {
      await bridge.call('move_to', { x: 10, z: 10 }, { signal: controller.signal, timeoutMs: 500 })
    },
    { message: /取消/ }
  )

  assert.equal(bridge.pendingHttpCommands.length, 0, '已取消的命令严禁进入 pendingHttpCommands')
})

test('STOP-DELIVERY-02: 排队中的 HTTP 命令被 abort 时立即从 pendingHttpCommands 剔除，不投递给 Lua', async () => {
  const bridge = isolatedBridge()

  const controller = new AbortController()
  const commandId = 'cmd-test-abort-delivery-02'

  // 启动下发但不等待完成
  const callPromise = bridge.call(
    'move_to',
    { x: 15, z: 15 },
    { signal: controller.signal, timeoutMs: 5000, envelope: { command_id: commandId } }
  )

  // 验证指令已进入 HTTP 待发送队列
  assert.equal(bridge.pendingHttpCommands.length, 1)
  assert.equal(bridge.pendingHttpCommands[0].id, commandId)

  // 触发取消
  controller.abort()

  // 验证被取消后立即从 pendingHttpCommands 剔除
  assert.equal(bridge.pendingHttpCommands.length, 0, 'abort 后必须立即从待提取队列中剔除')

  // 验证 callPromise 拒绝抛出异常
  await assert.rejects(callPromise, { message: /取消/ })
})

test('STOP-DELIVERY-03: 正常命令与已取消命令混合时，仅清理已取消命令', async () => {
  const bridge = isolatedBridge()

  const controller1 = new AbortController()
  const controller2 = new AbortController()

  const p1 = bridge.call('move_to', { x: 1, z: 1 }, { signal: controller1.signal, timeoutMs: 5000, envelope: { command_id: 'cmd-1' } })
  const p2 = bridge.call('move_to', { x: 2, z: 2 }, { signal: controller2.signal, timeoutMs: 5000, envelope: { command_id: 'cmd-2' } })

  assert.equal(bridge.pendingHttpCommands.length, 2)

  // 只取消 cmd-1
  controller1.abort()

  assert.equal(bridge.pendingHttpCommands.length, 1)
  assert.equal(bridge.pendingHttpCommands[0].id, 'cmd-2')

  // 模拟 Lua 回执 cmd-2
  const resolveCmd2 = bridge.pendingHttpResults.get('cmd-2')
  assert.ok(resolveCmd2)
  resolveCmd2({ ok: true, text: 'done' })

  const res2 = await p2
  assert.equal(res2.ok, true)
  await assert.rejects(p1, { message: /取消/ })
})
