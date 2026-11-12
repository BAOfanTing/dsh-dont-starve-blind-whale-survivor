// Phase 5 M5 · 进食/制作/营火真机验证
//
// 前置：游戏客户端在跑、世界未暂停（暂停时 DoPeriodicTask 全停，命令不会被 poll）。
// 会真的执行：craft_item(axe) → equip_item(axe) → chop_tree → craft_item(torch) →
//             build_campfire → eat_item。每步核对 verify，拿不到就如实报。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKEN = readFileSync(join(HERE, '..', '..', '.runtime', 'token.txt'), 'utf8').trim()
const BRIDGE = 'http://127.0.0.1:18788'
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
const post = async (p, b) => {
  const r = await fetch(BRIDGE + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })
  return { status: r.status, json: await r.json() }
}
const get = async (p) => {
  const r = await fetch(BRIDGE + p, { headers: H })
  return { status: r.status, json: await r.json() }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cmdStatus = async (id) => ((await get('/api/v1/commands')).json.commands ?? []).find((c) => c.id === id)
const waitCmd = async (id, seconds = 50) => {
  for (let i = 0; i < seconds * 2; i += 1) {
    const r = await cmdStatus(id)
    if (r && !['QUEUED', 'DELIVERED', 'EXECUTING'].includes(r.status)) return r
    await sleep(500)
  }
  return await cmdStatus(id)
}
const enqueue = async (type, params) => {
  const r = await post('/api/v1/commands/enqueue', {
    type, controller_id: 'M5_LIVE_C1', session_id: 'S1', params,
  })
  return { status: r.status, id: r.json.command?.id, error: r.json.error }
}
const show = (label, rec) => {
  const v = rec?.result?.verify
  console.log(`  ${label}: ${rec?.status ?? '?'} | text=${rec?.result?.text ?? '-'} | verify=${JSON.stringify(v ?? null)} | err=${rec?.error ?? '-'}`)
  return rec
}
const inventory = async () => {
  const e = await enqueue('get_state', { include_nearby: false })
  const rec = await waitCmd(e.id, 12)
  return (rec?.result?.inventory?.items ?? []).map((i) => `${i.prefab}×${i.count ?? 1}`)
}

console.log('=== ① 等游戏连上（最多 60 秒）===')
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
if (!ready) { console.log('  ❌ 游戏没连上'); process.exit(1) }
const s0 = await get('/api/v1/state')
const p0 = s0.json.snapshot.player
console.log(`  就绪: ${p0.name} 生命=${p0.health.percent}% 饥饿=${p0.hunger.percent}% 位置=(${p0.position.tile_x},${p0.position.tile_z})`)

console.log('\n=== ② 授权控制权 ===')
await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: 'M5_LIVE_C1', session_id: 'S1',
  lease_expires_at: Date.now() + 300000, emergency_stop: false, reason: 'M5 真机验证',
})
console.log(`  背包: ${JSON.stringify(await inventory()).slice(0, 200)}`)

console.log('\n=== ③ craft_item(axe) 未确认 → 应被拒 ===')
const noConfirm = await enqueue('craft_item', { recipe: 'axe', count: 1 })
show('未确认', await waitCmd(noConfirm.id, 15))

console.log('\n=== ④ craft_item(axe) 确认后真实制作 ===')
const craftAxe = await enqueue('craft_item', { recipe: 'axe', count: 1, confirmed: true })
console.log(`  enqueue HTTP ${craftAxe.status} id=${craftAxe.id}`)
show('做斧头', await waitCmd(craftAxe.id, 60))
console.log(`  背包: ${JSON.stringify(await inventory()).slice(0, 250)}`)

console.log('\n=== ⑤ equip_item(axe) 装备 ===')
const eq = await enqueue('equip_item', { item: 'axe' })
show('装备斧头', await waitCmd(eq.id, 25))

console.log('\n=== ⑥ chop_tree 砍树（现在有斧头了，应能拿到木头）===')
const chop = await enqueue('chop_tree', { count: 1, radius: 12, confirmed: true })
show('砍树', await waitCmd(chop.id, 90))
console.log(`  背包: ${JSON.stringify(await inventory()).slice(0, 250)}`)

console.log('\n=== ⑦ craft_item(torch) 做火把 ===')
const torch = await enqueue('craft_item', { recipe: 'torch', count: 1, confirmed: true })
show('做火把', await waitCmd(torch.id, 60))

console.log('\n=== ⑧ build_campfire 建营火（自动找空地）===')
const fire = await enqueue('build_campfire', { confirmed: true })
show('建营火', await waitCmd(fire.id, 90))

console.log('\n=== ⑨ eat_item 进食（不指定，让游戏挑）===')
const eat = await enqueue('eat_item', { confirmed: true })
show('进食', await waitCmd(eat.id, 40))

console.log('\n=== ⑩ 白名单越权（应被拒）===')
for (const [type, params] of [
  ['craft_item', { recipe: 'goldnugget', confirmed: true }],
  ['eat_item', { item: 'goldnugget', confirmed: true }],
  ['build_structure', { recipe: 'wall_stone', confirmed: true }],
]) {
  const r = await enqueue(type, params)
  const rec = await waitCmd(r.id, 15)
  console.log(`  ${type} ${JSON.stringify(params)} → ${rec?.status} ${rec?.error ?? ''}`)
}

console.log('\n=== ⑪ 清理控制权 ===')
await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: null, session_id: null, lease_expires_at: null,
  emergency_stop: false, reason: 'M5 收尾',
})
const c = await get('/api/v1/control/status')
console.log(`  mode=${c.json.control?.mode} holder=${c.json.control?.holder}`)
console.log('\n=== 完成 ===')
