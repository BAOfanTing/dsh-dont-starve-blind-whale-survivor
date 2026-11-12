// Phase 5 M2 端到端联调（临时端口，不动用户正在跑的 18788 Bridge）
//
// 起新版 Bridge + Controller，验证三层状态一致：
//   Controller(权威) → Bridge(持久化) → MCP get_control_status 工具
// 并验证：动作命令入队受控制权约束、紧急停止跨层生效、重复命令幂等。
//
// 注意：游戏未运行，所以**不下发任何真实游戏动作**，只验证控制面与命令通道。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridgeServer } from '../../game-bridge/dist/src/server.js'
import { ControlStateStore } from '../../game-bridge/dist/src/control.js'
import { CommandQueue } from '../../game-bridge/dist/src/commands.js'
import { SessionManager } from '../../game-bridge/dist/src/session.js'
import { BridgeState } from '../../game-bridge/dist/src/state.js'
import { createLogger } from '../../game-bridge/dist/src/logger.js'
import { loadConfig } from '../../game-bridge/dist/src/config.js'
import { createController } from '../dist/src/controllerApi.js'

const TOKEN = 'm2-e2e-token'
const tmp = mkdtempSync(join(tmpdir(), 'bws-m2-e2e-'))

const config = { ...loadConfig({ token: TOKEN, port: 0 }), token: TOKEN }
const control = new ControlStateStore({ path: join(tmp, 'control.json') })
const bridge = createBridgeServer({
  config,
  logger: createLogger({ secrets: [TOKEN], sink: () => {} }),
  state: new BridgeState(),
  sessions: new SessionManager(),
  commands: new CommandQueue(),
  control,
})
const bridgePort = await bridge.listen(0)
const bridgeUrl = `http://127.0.0.1:${bridgePort}`
console.log(`=== 起服务 ===`)
console.log(`  Bridge(新版): ${bridgeUrl}`)

const controller = createController({ bridge: { url: bridgeUrl, token: TOKEN } })
const controllerPort = await controller.listen()
const controllerUrl = `http://127.0.0.1:${controllerPort}`
console.log(`  Controller:   ${controllerUrl}`)

const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
const post = async (base, path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}) })
  return { status: r.status, json: await r.json() }
}
const get = async (base, path) => {
  const r = await fetch(base + path, { headers: H })
  return { status: r.status, json: await r.json() }
}

console.log(`\n=== ① 初始状态：Controller / Bridge 一致（SUPERVISED, 无 holder）===`)
await new Promise((r) => setTimeout(r, 50))
const c0 = await get(controllerUrl, '/api/control/status')
const b0 = await get(bridgeUrl, '/api/v1/control/status')
console.log(`  Controller.mode=${c0.json.mode} holder=${c0.json.holder}`)
console.log(`  Bridge.mode=${b0.json.control.mode} holder=${b0.json.control.holder} persisted=${b0.json.control.persisted}`)
console.log(`  一致: ${c0.json.mode === b0.json.control.mode && c0.json.holder === b0.json.control.holder}`)

console.log(`\n=== ② 申请控制权 → 三层同步 ===`)
const acq = await post(controllerUrl, '/api/control/acquire', { controller_id: 'C1', session_id: 'S1' })
console.log(`  acquire: ok=${acq.json.ok} holder=${acq.json.lease?.controller_id}`)
await new Promise((r) => setTimeout(r, 50))
const b1 = await get(bridgeUrl, '/api/v1/control/status')
console.log(`  Bridge: holder=${b1.json.control.holder} session=${b1.json.control.session_id} lease_expires_at=${b1.json.control.lease_expires_at}`)
const assertLua = await post(bridgeUrl, '/api/v1/control/assert', { controller_id: 'C1', session_id: 'S1', read_only: false })
const denyLua = await post(bridgeUrl, '/api/v1/control/assert', { controller_id: 'OTHER', session_id: 'S1', read_only: false })
console.log(`  Lua 二次校验 C1: allowed=${assertLua.json.allowed} code=${assertLua.json.code}`)
console.log(`  Lua 二次校验 OTHER: allowed=${denyLua.json.allowed} code=${denyLua.json.code}`)

console.log(`\n=== ③ 动作命令入队（有控制权 → 成功；无控制权 → 403）===`)
const okCmd = await post(bridgeUrl, '/api/v1/commands/enqueue', {
  type: 'move_to', controller_id: 'C1', session_id: 'S1', params: { x: 12, z: 45 },
})
console.log(`  move_to(C1): HTTP ${okCmd.status} type=${okCmd.json.command?.type} 带控制字段=${okCmd.json.command?.params?.controller_id === 'C1'}`)
const badCmd = await post(bridgeUrl, '/api/v1/commands/enqueue', {
  type: 'move_to', controller_id: 'OTHER', session_id: 'S1', params: { x: 1, z: 2 },
})
console.log(`  move_to(OTHER): HTTP ${badCmd.status} ${badCmd.json.error?.message}`)

console.log(`\n=== ④ 紧急停止跨层生效 ===`)
const stop = await post(controllerUrl, '/api/control/emergency-stop', { reason: 'M2 联调' })
await new Promise((r) => setTimeout(r, 50))
const b2 = await get(bridgeUrl, '/api/v1/control/status')
const afterStop = await post(bridgeUrl, '/api/v1/commands/enqueue', {
  type: 'move_to', controller_id: 'C1', session_id: 'S1', params: { x: 1, z: 2 },
})
const luaStopped = await post(bridgeUrl, '/api/v1/control/assert', { controller_id: 'C1', session_id: 'S1' })
console.log(`  Controller.mode=${stop.json.status.mode}`)
console.log(`  Bridge.mode=${b2.json.control.mode} emergency=${b2.json.control.emergency_stop}`)
console.log(`  停止后入队: HTTP ${afterStop.status} ${afterStop.json.error?.message}`)
console.log(`  停止后 Lua assert: code=${luaStopped.json.code}`)

console.log(`\n=== ⑤ Bridge 重启后控制状态从落盘恢复 ===`)
const bridge2 = createBridgeServer({
  config, logger: createLogger({ secrets: [TOKEN], sink: () => {} }),
  state: new BridgeState(), sessions: new SessionManager(), commands: new CommandQueue(),
  control: new ControlStateStore({ path: join(tmp, 'control.json') }),
})
const port2 = await bridge2.listen(0)
const b3 = await get(`http://127.0.0.1:${port2}`, '/api/v1/control/status')
console.log(`  重启后 Bridge.mode=${b3.json.control.mode} holder=${b3.json.control.holder}（应为 EMERGENCY_STOP / null）`)

console.log(`\n=== ⑥ Controller /health 显示同步统计 ===`)
const health = await get(controllerUrl, '/health')
console.log(`  sync_count=${health.json.bridge_sync?.sync_count} last_error=${health.json.bridge_sync?.last_error}`)

await controller.close()
await bridge.close()
await bridge2.close()
rmSync(tmp, { recursive: true, force: true })
console.log(`\n=== 完成：未连接游戏、未下发任何真实动作 ===`)
