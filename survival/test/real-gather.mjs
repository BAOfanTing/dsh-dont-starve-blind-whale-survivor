// Phase 5 M3 · 基础资源采集真机验证
//
// 前置：游戏世界运行且**未暂停**（暂停时 DST 不触发 DoPeriodicTask，命令不会被 poll）。
// 会真的执行：probe_game_actions（只读）+ gather_resource（真实采集）。
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
const cmdStatus = async (id) => {
  const all = await get('/api/v1/commands')
  return (all.json.commands ?? []).find((c) => c.id === id)
}
const waitCmd = async (id, seconds = 30) => {
  for (let i = 0; i < seconds * 2; i += 1) {
    const r = await cmdStatus(id)
    if (r && !['QUEUED', 'DELIVERED', 'EXECUTING'].includes(r.status)) return r
    await sleep(500)
  }
  return await cmdStatus(id)
}

console.log('=== ① 等游戏会话连上（最多 60 秒）===')
let ready = false
for (let i = 0; i < 30; i += 1) {
  try {
    const s = await get('/api/v1/state')
    const b = await get('/api/v1/bridge/status')
    if (i % 5 === 0) console.log(`  t+${i * 2}s alive=${s.json.session?.alive} connected=${b.json.bridge?.connected} stale=${s.json.stale}`)
    if (s.json.session?.alive === true && s.json.stale === false && b.json.bridge?.connected === true) { ready = true; break }
  } catch {}
  await sleep(2000)
}
if (!ready) { console.log('  ❌ 游戏没连上（是否又暂停了？），终止'); process.exit(1) }
const s0 = await get('/api/v1/state')
const p0 = s0.json.snapshot.player
console.log(`  就绪: ${p0.name} 位置=(${p0.position.tile_x},${p0.position.tile_z}) 第${s0.json.snapshot.world.day}天 ${s0.json.snapshot.world.phase}`)
console.log(`  附近: ${s0.json.snapshot.nearby?.returned ?? '?'} 个实体`)

console.log('\n=== ② probe_game_actions（只读：探测当前构建的 ACTIONS）===')
const probe = await post('/api/v1/commands/enqueue', { type: 'probe_game_actions', params: {}, shard: 'master' })
console.log(`  enqueue HTTP ${probe.status} id=${probe.json.command?.id}`)
const probeRec = await waitCmd(probe.json.command?.id, 15)
console.log(`  ${probeRec?.status} result=${JSON.stringify(probeRec?.result).slice(0, 600)}`)
console.log(`  → ACTIONS.PICKUP 可用: ${probeRec?.result?.actions?.PICKUP}`)

console.log('\n=== ③ 授权控制权 ===')
const lease = Date.now() + 120000
const sync = await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: 'M3_LIVE_C1', session_id: 'S1',
  lease_expires_at: lease, emergency_stop: false, reason: 'M3 真机采集验证',
})
console.log(`  sync HTTP ${sync.status} holder=${sync.json.control?.holder}`)

console.log('\n=== ④ 采集前背包（只读）===')
const inv0 = await post('/api/v1/commands/enqueue', { type: 'get_state', params: { include_nearby: false } })
const inv0Rec = await waitCmd(inv0.json.command?.id, 10)
console.log(`  get_state: ${inv0Rec?.status}`)

console.log('\n=== ⑤ gather_resource：采 1 次树枝 ===')
const enq = await post('/api/v1/commands/enqueue', {
  type: 'gather_resource', controller_id: 'M3_LIVE_C1', session_id: 'S1',
  params: { resource: 'twigs', count: 1, radius: 12 },
})
console.log(`  enqueue HTTP ${enq.status} id=${enq.json.command?.id}`)
if (enq.status !== 200) { console.log('  入队失败:', JSON.stringify(enq.json)); process.exit(2) }
const id = enq.json.command?.id
await sleep(3000)
const mid = await cmdStatus(id)
console.log(`  t+3s 状态=${mid?.status}`)
const final = await waitCmd(id, 40)
console.log(`  终态=${final?.status}`)
console.log(`  result=${JSON.stringify(final?.result).slice(0, 500)}`)
console.log(`  error=${final?.error ?? '-'}`)

console.log('\n=== ⑥ 越权采集应被拒（无控制权的 controller）===')
const denied = await post('/api/v1/commands/enqueue', {
  type: 'gather_resource', controller_id: 'NOBODY', session_id: 'S1', params: { resource: 'twigs' },
})
console.log(`  HTTP ${denied.status} ${denied.json.error?.message ?? ''}`)

console.log('\n=== ⑦ 非法资源名应被 Lua 端拒绝（不执行任意 prefab）===')
const bad = await post('/api/v1/commands/enqueue', {
  type: 'gather_resource', controller_id: 'M3_LIVE_C1', session_id: 'S1',
  params: { resource: 'deerclops', count: 1 },
})
const badRec = await waitCmd(bad.json.command?.id, 15)
console.log(`  ${badRec?.status} ${badRec?.error ?? ''}`)

console.log('\n=== ⑧ 清理控制权 ===')
await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: null, session_id: null, lease_expires_at: null,
  emergency_stop: false, reason: 'M3 收尾',
})
const c = await get('/api/v1/control/status')
console.log(`  mode=${c.json.control?.mode} holder=${c.json.control?.holder}`)
console.log('\n=== 完成 ===')
