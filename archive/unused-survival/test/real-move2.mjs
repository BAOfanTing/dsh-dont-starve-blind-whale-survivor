// Phase 5 M2 · 真实游戏内移动验证（第二组：远距离 + 越权拒绝 + stop）
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pos = async () => {
  const s = await get('/api/v1/state')
  const p = s.json.snapshot?.player
  return { tile: `(${p?.position?.tile_x},${p?.position?.tile_z})`, x: p?.position?.x, z: p?.position?.z, stale: s.json.stale }
}
const cmdStatus = async (id) => {
  const all = await get('/api/v1/commands')
  return (all.json.commands ?? []).find((c) => c.id === id)
}
const movementStatus = async () => {
  const e = await post('/api/v1/commands/enqueue', { type: 'get_movement_status', params: {} })
  for (let i = 0; i < 8; i += 1) {
    await sleep(1000)
    const r = await cmdStatus(e.json.command?.id)
    if (r && r.status !== 'QUEUED' && r.status !== 'DELIVERED') return r?.result
  }
  return null
}

console.log('=== ① 起始位置 ===')
const p0 = await pos()
console.log(' ', JSON.stringify(p0))

console.log('\n=== ② 越权动作：无控制权时入队 move_to（Bridge 层应 403）===')
const denied = await post('/api/v1/commands/enqueue', {
  type: 'move_to', controller_id: 'UNAUTHORIZED', session_id: 'S1', params: { x: 90, z: 12 },
})
console.log(`  HTTP ${denied.status} ${denied.json.error?.message ?? ''}`)

console.log('\n=== ③ 申请控制权并移动到更远目标 tile(85,12) ===')
const controller = createController({ bridge: { url: BRIDGE, token: TOKEN } })
const port = await controller.listen()
const C = `http://127.0.0.1:${port}`
const acq = await fetch(C + '/api/control/acquire', {
  method: 'POST', headers: H, body: JSON.stringify({ controller_id: 'M2_LIVE_C2', session_id: 'S1' }),
})
console.log(`  acquire ok=${(await acq.json()).ok}`)
await sleep(200)

const enq = await post('/api/v1/commands/enqueue', {
  type: 'move_to', controller_id: 'M2_LIVE_C2', session_id: 'S1',
  params: { x: 85, z: 12, timeout: 30 },
})
console.log(`  enqueue HTTP ${enq.status} id=${enq.json.command?.id}`)
const cmdId = enq.json.command?.id

console.log('\n=== ④ 每 2 秒跟踪坐标（最多 26 秒）===')
const samples = []
for (let i = 1; i <= 13; i += 1) {
  await sleep(2000)
  const p = await pos()
  const r = await cmdStatus(cmdId)
  samples.push(p.tile)
  console.log(`  t+${String(i * 2).padStart(2)}s  坐标=${p.tile}  x=${p.x}  cmd=${r?.status ?? '?'}`)
  if (p.tile === '(85,12)' || r?.status === 'FAILED') break
}
const p1 = await pos()
console.log(`\n  起点 ${p0.tile} → 终点 ${p1.tile}   坐标变化: ${p0.x !== p1.x || p0.z !== p1.z}`)

console.log('\n=== ⑤ movementStatus 最终态 ===')
const ms = await movementStatus()
console.log(' ', JSON.stringify(ms))

console.log('\n=== ⑥ stop_movement（真实执行）===')
const stop = await post('/api/v1/commands/enqueue', {
  type: 'stop_movement', controller_id: 'M2_LIVE_C2', session_id: 'S1', params: {},
})
await sleep(4)
const stopRec = await cmdStatus(stop.json.command?.id)
console.log(`  ${stopRec?.status} result=${JSON.stringify(stopRec?.result).slice(0, 250)}`)

console.log('\n=== ⑦ 紧急停止后动作被拒 ===')
await fetch(C + '/api/control/emergency-stop', { method: 'POST', headers: H, body: JSON.stringify({ reason: 'M2 真实验证收尾' }) })
await sleep(200)
const afterStop = await post('/api/v1/commands/enqueue', {
  type: 'move_to', controller_id: 'M2_LIVE_C2', session_id: 'S1', params: { x: 90, z: 12 },
})
console.log(`  HTTP ${afterStop.status} ${afterStop.json.error?.message ?? ''}`)
await fetch(C + '/api/control/clear-emergency', { method: 'POST', headers: H, body: '{}' })
await fetch(C + '/api/control/release', { method: 'POST', headers: H, body: JSON.stringify({ controller_id: 'M2_LIVE_C2' }) })
await sleep(200)
const cs = await get('/api/v1/control/status')
console.log(`  清理后: mode=${cs.json.control?.mode} holder=${cs.json.control?.holder}`)

await controller.close()
console.log('\n=== 完成 ===')
