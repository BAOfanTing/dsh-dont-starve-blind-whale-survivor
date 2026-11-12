// Phase 5 M4 · 工具使用真机验证（equip / chop / mine / pick up）
//
// 前置：游戏客户端在跑、世界未暂停（窗口最小化会暂停，先跑 node tools/unpause.mjs）。
// 会真的执行：equip_item → chop_tree（需确认）→ mine_rock（需确认）→ pick_up_item。
// 每一步都核对 verify（实际获得数量 / 手上装备），拿不到就如实报，不编造。
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
const waitCmd = async (id, seconds = 40) => {
  for (let i = 0; i < seconds * 2; i += 1) {
    const r = await cmdStatus(id)
    if (r && !['QUEUED', 'DELIVERED', 'EXECUTING'].includes(r.status)) return r
    await sleep(500)
  }
  return await cmdStatus(id)
}
const inventory = async () => {
  const e = await post('/api/v1/commands/enqueue', { type: 'get_state', params: { include_nearby: false } })
  const rec = await waitCmd(e.json.command?.id, 12)
  const items = rec?.result?.inventory?.items ?? []
  return items.map((it) => `${it.prefab}×${it.count ?? 1}`)
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
if (!ready) { console.log('  ❌ 游戏没连上（客户端是否在跑？窗口是否最小化？）'); process.exit(1) }
const s0 = await get('/api/v1/state')
console.log(`  就绪: ${s0.json.snapshot.player.name} 位置=(${s0.json.snapshot.player.position.tile_x},${s0.json.snapshot.player.position.tile_z})`)

console.log('\n=== ② 授权控制权 ===')
const sync = await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: 'M4_LIVE_C1', session_id: 'S1',
  lease_expires_at: Date.now() + 180000, emergency_stop: false, reason: 'M4 真机验证',
})
console.log(`  sync HTTP ${sync.status} holder=${sync.json.control?.holder}`)
console.log(`  采集前背包: ${JSON.stringify(await inventory()).slice(0, 300)}`)

console.log('\n=== ③ equip_item：装备斧头（若背包没有会如实失败）===')
const eq = await post('/api/v1/commands/enqueue', {
  type: 'equip_item', controller_id: 'M4_LIVE_C1', session_id: 'S1', params: { item: 'axe' },
})
const eqRec = await waitCmd(eq.json.command?.id, 20)
console.log(`  ${eqRec?.status} text=${eqRec?.result?.text ?? '-'} verify=${JSON.stringify(eqRec?.result?.verify ?? null)}`)
console.log(`  error=${eqRec?.error ?? '-'}`)

console.log('\n=== ④ chop_tree 未确认 → 应被拒（程序层）===')
const noConfirm = await post('/api/v1/commands/enqueue', {
  type: 'chop_tree', controller_id: 'M4_LIVE_C1', session_id: 'S1', params: { count: 1 },
})
const ncRec = await waitCmd(noConfirm.json.command?.id, 15)
console.log(`  ${ncRec?.status} error=${ncRec?.error ?? '-'}`)
console.log(`  → 是否正确拒绝: ${String(ncRec?.error ?? '').includes('confirmation_required')}`)

console.log('\n=== ⑤ chop_tree 确认后真实砍树 ===')
const chop = await post('/api/v1/commands/enqueue', {
  type: 'chop_tree', controller_id: 'M4_LIVE_C1', session_id: 'S1',
  params: { count: 1, radius: 12, confirmed: true },
})
console.log(`  enqueue HTTP ${chop.status} id=${chop.json.command?.id}`)
const chopRec = await waitCmd(chop.json.command?.id, 60)
console.log(`  ${chopRec?.status} text=${chopRec?.result?.text ?? '-'}`)
console.log(`  verify=${JSON.stringify(chopRec?.result?.verify ?? null)}`)
console.log(`  error=${chopRec?.error ?? '-'}`)
console.log(`  砍后背包: ${JSON.stringify(await inventory()).slice(0, 300)}`)

console.log('\n=== ⑥ mine_rock 确认后真实采矿 ===')
const mine = await post('/api/v1/commands/enqueue', {
  type: 'mine_rock', controller_id: 'M4_LIVE_C1', session_id: 'S1',
  params: { count: 1, radius: 12, confirmed: true },
})
const mineRec = await waitCmd(mine.json.command?.id, 60)
console.log(`  ${mineRec?.status} text=${mineRec?.result?.text ?? '-'}`)
console.log(`  verify=${JSON.stringify(mineRec?.result?.verify ?? null)}`)
console.log(`  error=${mineRec?.error ?? '-'}`)

console.log('\n=== ⑦ pick_up_item：捡地上的东西 ===')
const pick = await post('/api/v1/commands/enqueue', {
  type: 'pick_up_item', controller_id: 'M4_LIVE_C1', session_id: 'S1',
  params: { item: 'twigs', count: 1, radius: 12 },
})
const pickRec = await waitCmd(pick.json.command?.id, 40)
console.log(`  ${pickRec?.status} text=${pickRec?.result?.text ?? '-'}`)
console.log(`  verify=${JSON.stringify(pickRec?.result?.verify ?? null)}`)
console.log(`  error=${pickRec?.error ?? '-'}`)

console.log('\n=== ⑧ 白名单越权（应被拒）===')
for (const [type, params] of [
  ['equip_item', { item: 'spear' }],
  ['chop_tree', { target: 'rock1', confirmed: true }],
  ['mine_rock', { target: 'evergreen', confirmed: true }],
  ['pick_up_item', { item: 'goldnugget' }],
]) {
  const r = await post('/api/v1/commands/enqueue', {
    type, controller_id: 'M4_LIVE_C1', session_id: 'S1', params,
  })
  const rec = await waitCmd(r.json.command?.id, 12)
  console.log(`  ${type} ${JSON.stringify(params)} → ${rec?.status} ${rec?.error ?? ''}`)
}

console.log('\n=== ⑨ 清理控制权 ===')
await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: null, session_id: null, lease_expires_at: null,
  emergency_stop: false, reason: 'M4 收尾',
})
const c = await get('/api/v1/control/status')
console.log(`  mode=${c.json.control?.mode} holder=${c.json.control?.holder}`)
console.log('\n=== 完成 ===')
