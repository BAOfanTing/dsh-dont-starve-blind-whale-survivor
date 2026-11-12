// Phase 5 M2 · 真实游戏内移动验证
//
// 前置：游戏世界已运行、新版 mod 已加载、新版 Bridge 在 18788。
// 本脚本会**真的下发 move_to 让角色移动**，并观察坐标变化。
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
  return { status: r.status, json: (await r.json()) }
}
const get = async (path) => {
  const r = await fetch(BRIDGE + path, { headers: H })
  return { status: r.status, json: (await r.json()) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const state = async () => {
  const s = await get('/api/v1/state')
  const p = s.json.snapshot?.player
  return {
    alive: s.json.session?.alive, stale: s.json.stale, age: s.json.snapshot_age_ms,
    name: p?.name, hp: p?.health?.percent, hunger: p?.hunger?.percent,
    tile: p?.position ? `(${p.position.tile_x},${p.position.tile_z})` : null,
    world: p?.position ? `x=${p.position.x} z=${p.position.z}` : null,
    phase: s.json.snapshot?.world?.phase,
  }
}

console.log('=== ① 起始状态 ===')
const before = await state()
console.log(' ', JSON.stringify(before))
if (before.alive !== true || before.stale === true) { console.log('  ❌ 游戏数据不新鲜，终止'); process.exit(1) }

console.log('\n=== ② 申请控制权（Controller → 真实 Bridge）===')
const controller = createController({ bridge: { url: BRIDGE, token: TOKEN } })
const port = await controller.listen()
const C = `http://127.0.0.1:${port}`
const acq = await fetch(C + '/api/control/acquire', {
  method: 'POST', headers: H, body: JSON.stringify({ controller_id: 'M2_LIVE_C1', session_id: before.tile ?? 'S1' }),
})
const acqJson = await acq.json()
console.log(`  acquire: ok=${acqJson.ok} holder=${acqJson.lease?.controller_id}`)
await sleep(200)
const cs = await get('/api/v1/control/status')
console.log(`  Bridge: mode=${cs.json.control?.mode} holder=${cs.json.control?.holder} session=${cs.json.control?.session_id}`)

console.log('\n=== ③ 入队真实 move_to（目标 tile(81,12)，从起点往东 2 格）===')
const target = { x: 81, z: 12 }
const enq = await post('/api/v1/commands/enqueue', {
  type: 'move_to', controller_id: 'M2_LIVE_C1', session_id: before.tile ?? 'S1',
  params: { ...target, timeout: 30 },
})
console.log(`  enqueue HTTP ${enq.status} command_id=${enq.json.command?.id}`)
if (enq.status !== 200) { console.log('  ❌ 入队失败:', JSON.stringify(enq.json)); await controller.close(); process.exit(1) }
const cmdId = enq.json.command.id

console.log('\n=== ④ 跟踪命令回执与玩家坐标（每 2 秒，共 22 秒）===')
for (let i = 1; i <= 11; i += 1) {
  await sleep(2000)
  const all = await get('/api/v1/commands')
  const rec = (all.json.commands)?.find((c) => c.id === cmdId)
  const s = await state()
  console.log(`  t+${String(i * 2).padStart(2)}s  cmd=${rec?.status ?? '?'}  坐标=${s.tile}  ${s.world}  err=${rec?.error ?? '-'}`)
  if (rec?.status === 'SUCCEEDED' || rec?.status === 'FAILED') {
    console.log(`  result=${JSON.stringify(rec.result).slice(0, 400)}`)
    break
  }
}

console.log('\n=== ⑤ 最终状态对比 ===')
const after = await state()
console.log('  before:', JSON.stringify(before))
console.log('  after :', JSON.stringify(after))
console.log(`  坐标是否变化: ${before.tile !== after.tile || before.world !== after.world}`)

console.log('\n=== ⑥ 只读查询移动状态 ===')
const ms = await post('/api/v1/commands/enqueue', { type: 'get_movement_status', params: {} })
await sleep(4)
const all2 = await get('/api/v1/commands')
const msRec = (all2.json.commands)?.find((c) => c.id === ms.json.command?.id)
console.log(`  get_movement_status: ${msRec?.status} result=${JSON.stringify(msRec?.result).slice(0, 400)}`)

console.log('\n=== ⑦ 清理控制权 ===')
await fetch(C + '/api/control/release', { method: 'POST', headers: H, body: JSON.stringify({ controller_id: 'M2_LIVE_C1' }) })
const final = await get('/api/v1/control/status')
console.log(`  Bridge: mode=${final.json.control?.mode} holder=${final.json.control?.holder}`)

await controller.close()
console.log('\n=== 完成 ===')
