// Phase 5 M2 · 真实新版 Bridge 上的跨层控制权验证
//
// 连的是用户环境里实际跑着的 127.0.0.1:18788（M2 新版），不是临时端口。
// 验证：Controller → 真实 Bridge 落盘 → Lua assert 二次校验 → MCP 工具可读。
// 不启动游戏世界，不下发任何游戏动作。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createController } from '../dist/src/controllerApi.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKEN = readFileSync(join(HERE, '..', '..', '.runtime', 'token.txt'), 'utf8').trim()
const BRIDGE = 'http://127.0.0.1:18788'
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
const post = async (path, body) => {
  const r = await fetch(BRIDGE + path, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}) })
  return { status: r.status, json: await r.json() }
}
const get = async (path) => {
  const r = await fetch(BRIDGE + path, { headers: H })
  return { status: r.status, json: await r.json() }
}

console.log('=== ① 真实 Bridge 版本与初始控制权 ===')
const health = await get('/api/v1/control/status')
console.log(`  HTTP ${health.status}  mode=${health.json.control?.mode} holder=${health.json.control?.holder} persisted=${health.json.control?.persisted}`)
if (health.status !== 200) { console.log('  ❌ 不是 M2 新版 Bridge'); process.exit(1) }

console.log('\n=== ② 启动 Controller（连真实 Bridge）===')
const controller = createController({ bridge: { url: BRIDGE, token: TOKEN } })
const port = await controller.listen()
const C = `http://127.0.0.1:${port}`
console.log(`  Controller: ${C}`)
await new Promise((r) => setTimeout(r, 100))

console.log('\n=== ③ 申请控制权 → 真实 Bridge ===')
const acq = await fetch(C + '/api/control/acquire', {
  method: 'POST', headers: H, body: JSON.stringify({ controller_id: 'REAL_TEST_C1', session_id: 'S1' }),
})
const acqJson = await acq.json()
console.log(`  acquire: ok=${acqJson.ok} holder=${acqJson.lease?.controller_id}`)
await new Promise((r) => setTimeout(r, 100))
const b1 = await get('/api/v1/control/status')
console.log(`  Bridge: holder=${b1.json.control?.holder} session=${b1.json.control?.session_id} lease_expires_at=${b1.json.control?.lease_expires_at}`)

console.log('\n=== ④ Lua 执行端二次校验（真实 Bridge 判定）===')
const allow = await post('/api/v1/control/assert', { controller_id: 'REAL_TEST_C1', session_id: 'S1' })
const deny = await post('/api/v1/control/assert', { controller_id: 'OTHER', session_id: 'S1' })
const readonly = await post('/api/v1/control/assert', { controller_id: 'nobody', session_id: 'S1', read_only: true })
console.log(`  C1     : allowed=${allow.json.allowed} code=${allow.json.code}`)
console.log(`  OTHER  : allowed=${deny.json.allowed} code=${deny.json.code}`)
console.log(`  只读   : allowed=${readonly.json.allowed} code=${readonly.json.code}`)

console.log('\n=== ⑤ 动作命令入队（真实 Bridge 校验）===')
const okCmd = await post('/api/v1/commands/enqueue', {
  type: 'move_to', controller_id: 'REAL_TEST_C1', session_id: 'S1', params: { x: 12, z: 45 },
})
const badCmd = await post('/api/v1/commands/enqueue', {
  type: 'move_to', controller_id: 'OTHER', session_id: 'S1', params: { x: 1, z: 2 },
})
console.log(`  move_to(C1)   : HTTP ${okCmd.status} type=${okCmd.json.command?.type}`)
console.log(`  move_to(OTHER): HTTP ${badCmd.status} ${badCmd.json.error?.message}`)

console.log('\n=== ⑥ 紧急停止跨层 ===')
const stop = await fetch(C + '/api/control/emergency-stop', {
  method: 'POST', headers: H, body: JSON.stringify({ reason: '真实 Bridge 验证' }),
})
const stopJson = await stop.json()
await new Promise((r) => setTimeout(r, 100))
const b2 = await get('/api/v1/control/status')
const after = await post('/api/v1/commands/enqueue', {
  type: 'move_to', controller_id: 'REAL_TEST_C1', session_id: 'S1', params: { x: 1, z: 2 },
})
console.log(`  Controller.mode=${stopJson.status?.mode}`)
console.log(`  Bridge.mode=${b2.json.control?.mode} emergency=${b2.json.control?.emergency_stop}`)
console.log(`  停止后入队: HTTP ${after.status} ${after.json.error?.message}`)

console.log('\n=== ⑦ 清理：清除紧急停止，恢复 SUPERVISED ===')
const clear = await fetch(C + '/api/control/clear-emergency', { method: 'POST', headers: H, body: '{}' })
const clearJson = await clear.json()
await new Promise((r) => setTimeout(r, 100))
const b3 = await get('/api/v1/control/status')
console.log(`  清除后 Bridge.mode=${b3.json.control?.mode} holder=${b3.json.control?.holder}`)

const h = await (await fetch(C + '/health')).json()
console.log(`\n=== ⑧ Controller 同步统计 ===`)
console.log(`  sync_count=${h.bridge_sync?.sync_count} last_error=${h.bridge_sync?.last_error}`)

await controller.close()
console.log('\n=== 完成：全程未下发任何真实游戏动作 ===')
