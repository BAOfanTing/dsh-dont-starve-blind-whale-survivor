// Phase 5 M2 · 世界重启后「一连上就立刻跑」的真实动作验证
//
// 背景：Phase 2 net.lua 的 DoPeriodicTask 长时间运行后会失效（心跳=0 / poll 停），
//       所以本脚本在检测到会话 alive 后立刻把所有命令一次性打完，减少窗口期。
//
// 会真的执行：get_movement_status（只读冒烟）、move_to、stop_movement、越权拒绝、紧急停止。
// 需要先在 Bridge 侧授权控制权（脚本自己做），跑完自动清理。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  return { alive: s.json.session?.alive, stale: s.json.stale, tile: `(${p?.position?.tile_x},${p?.position?.tile_z})`, x: p?.position?.x, z: p?.position?.z }
}
const cmdStatus = async (id) => {
  const all = await get('/api/v1/commands')
  return (all.json.commands ?? []).find((c) => c.id === id)
}
/** 等命令出终态（最多 N 秒） */
const waitCmd = async (id, seconds = 12) => {
  for (let i = 0; i < seconds * 2; i += 1) {
    const r = await cmdStatus(id)
    if (r && !['QUEUED', 'DELIVERED', 'EXECUTING'].includes(r.status)) return r
    await sleep(500)
  }
  return await cmdStatus(id)
}

console.log('=== 等待游戏会话连上（最多 90 秒）===')
let ready = null
for (let i = 0; i < 45; i += 1) {
  try {
    const s = await get('/api/v1/state')
    const st = await get('/api/v1/bridge/status')
    const alive = s.json.session?.alive === true && s.json.stale === false
    const polling = st.json.bridge?.connected === true
    if (i % 5 === 0) console.log(`  t+${i * 2}s alive=${alive} connected=${polling} stale=${s.json.stale}`)
    if (alive && polling) { ready = await pos(); break }
  } catch {}
  await sleep(2000)
}
if (ready === null) { console.log('  ❌ 超时，游戏没连上，终止'); process.exit(1) }
console.log('  就绪:', JSON.stringify(ready))

console.log('\n=== ① 冒烟：只读 get_movement_status（证明新版 mod 加载）===')
const smoke = await post('/api/v1/commands/enqueue', { type: 'get_movement_status', params: {} })
const smokeRec = await waitCmd(smoke.json.command?.id)
console.log(`  ${smokeRec?.status} result=${JSON.stringify(smokeRec?.result).slice(0, 250)}`)

console.log('\n=== ② 越权动作（无控制权，应 403）===')
const denied = await post('/api/v1/commands/enqueue', {
  type: 'move_to', controller_id: 'NOBODY', session_id: 'S1', params: { x: 90, z: 12 },
})
console.log(`  HTTP ${denied.status} ${denied.json.error?.message ?? ''}`)

console.log('\n=== ③ 授权控制权（直接同步到 Bridge，最快）===')
const lease = Date.now() + 120000
const sync = await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: 'M2_QUICK_C1', session_id: 'S1',
  lease_expires_at: lease, emergency_stop: false, reason: '世界重启后快速验证',
})
console.log(`  sync HTTP ${sync.status} holder=${sync.json.control?.holder}`)
const assertC1 = await post('/api/v1/control/assert', { controller_id: 'M2_QUICK_C1', session_id: 'S1' })
console.log(`  Lua assert C1: allowed=${assertC1.json.allowed} code=${assertC1.json.code}`)

console.log('\n=== ④ 真实 move_to（目标 = 当前 tile + 3 格 x）===')
const p0 = await pos()
const targetX = Math.round(p0.x / 4) + 3
const targetZ = Math.round(p0.z / 4)
console.log(`  起点 ${p0.tile} x=${p0.x} → 目标 (${targetX},${targetZ})`)
const enq = await post('/api/v1/commands/enqueue', {
  type: 'move_to', controller_id: 'M2_QUICK_C1', session_id: 'S1',
  params: { x: targetX, z: targetZ, timeout: 25 },
})
console.log(`  enqueue HTTP ${enq.status} id=${enq.json.command?.id}`)
const moveRec = await waitCmd(enq.json.command?.id, 10)
console.log(`  cmd=${moveRec?.status} result=${JSON.stringify(moveRec?.result).slice(0, 250)}`)

console.log('\n=== ⑤ 跟踪坐标（最多 16 秒）===')
for (let i = 1; i <= 8; i += 1) {
  await sleep(2000)
  const p = await pos()
  console.log(`  t+${i * 2}s  ${p.tile}  x=${p.x}`)
  if (p.tile === `(${targetX},${targetZ})`) break
}
const p1 = await pos()
console.log(`  位移: ${p0.tile} → ${p1.tile}  变化=${p0.x !== p1.x || p0.z !== p1.z}`)

console.log('\n=== ⑥ movementStatus 终态 ===')
const ms = await post('/api/v1/commands/enqueue', { type: 'get_movement_status', params: {} })
const msRec = await waitCmd(ms.json.command?.id)
console.log(`  ${JSON.stringify(msRec?.result).slice(0, 400)}`)

console.log('\n=== ⑦ stop_movement（上次因 caves 取走失败，这次应落 master）===')
const stop = await post('/api/v1/commands/enqueue', {
  type: 'stop_movement', controller_id: 'M2_QUICK_C1', session_id: 'S1', params: {},
})
const stopRec = await waitCmd(stop.json.command?.id)
console.log(`  ${stopRec?.status} result=${JSON.stringify(stopRec?.result).slice(0, 250)} err=${stopRec?.error ?? '-'}`)

console.log('\n=== ⑧ 紧急停止 → 动作被拒 → 清理 ===')
await post('/api/v1/control/sync', {
  mode: 'EMERGENCY_STOP', holder: null, session_id: null, lease_expires_at: null,
  emergency_stop: true, reason: '快速验证收尾',
})
const blocked = await post('/api/v1/commands/enqueue', {
  type: 'move_to', controller_id: 'M2_QUICK_C1', session_id: 'S1', params: { x: 1, z: 1 },
})
console.log(`  紧急停止后入队: HTTP ${blocked.status} ${blocked.json.error?.message ?? ''}`)
await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: null, session_id: null, lease_expires_at: null,
  emergency_stop: false, reason: '清理回初始状态',
})
const final = await get('/api/v1/control/status')
console.log(`  最终: mode=${final.json.control?.mode} holder=${final.json.control?.holder} emergency=${final.json.control?.emergency_stop}`)

console.log('\n=== 完成 ===')
