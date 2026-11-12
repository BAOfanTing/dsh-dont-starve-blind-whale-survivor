// M5 campfire acceptance: gather grass+wood, build campfire, verify fire_found
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKEN = readFileSync(join(HERE, '..', '..', '.runtime', 'token.txt'), 'utf8').trim()
const B = 'http://127.0.0.1:18788'
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
const CID = 'FIRE2'
const post = async (p, b) => {
  const r = await fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })
  return { status: r.status, json: await r.json().catch(() => null) }
}
const get = async (p) => ({ json: await (await fetch(B + p, { headers: H })).json().catch(() => null) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run(type, params, seconds = 120) {
  const e = await post('/api/v1/commands/enqueue', { type, controller_id: CID, session_id: 'S1', params })
  if (!e.json?.command?.id) return { status: `ENQ_${e.status}`, error: e.json?.error?.message }
  const id = e.json.command.id
  const t0 = Date.now()
  for (let i = 0; i < seconds * 5; i += 1) {
    await sleep(200)
    const all = await get('/api/v1/commands')
    const rec = (all.json?.commands ?? []).find((c) => c.id === id)
    if (rec && !['QUEUED', 'DELIVERED', 'EXECUTING'].includes(rec.status)) {
      rec._elapsed = ((Date.now() - t0) / 1000).toFixed(1); return rec
    }
  }
  return { status: 'TIMEOUT' }
}
const show = (l, r) => {
  const v = r?.result?.verify
  console.log(`  ${l}: ${r?.status} (${r?._elapsed}s) | ${r?.result?.text ?? '-'}`)
  if (v) console.log(`      verify=${JSON.stringify(v)}`)
  if (r?.error) console.log(`      err=${r.error}`)
  return r
}
async function snap() {
  const s = (await get('/api/v1/state')).json
  const ents = Array.isArray(s?.snapshot?.nearby?.entities) ? s.snapshot.nearby.entities : []
  const g = {}
  for (const e of ents) g[e.prefab] = (g[e.prefab] ?? 0) + 1
  return {
    items: (Array.isArray(s?.snapshot?.inventory?.items) ? s.snapshot.inventory.items : []).map((i) => `${i.prefab}x${i.count ?? 1}`),
    near: g,
    tile: `${s?.snapshot?.player?.position?.tile_x},${s?.snapshot?.player?.position?.tile_z}`,
    hunger: s?.snapshot?.player?.hunger?.percent,
    hp: s?.snapshot?.player?.health?.percent,
  }
}

await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: CID, session_id: 'S1',
  lease_expires_at: Date.now() + 900000, emergency_stop: false, reason: 'campfire acceptance',
})

let s = await snap()
console.log(`=== start === tile=${s.tile} hp=${s.hp}% hunger=${s.hunger}%`)
console.log(`  bag=${JSON.stringify(s.items)}`)
console.log(`  near=${JSON.stringify(s.near)}`)

// 1. gather grass (need 2 for campfire)
const grassNow = Number((s.items.find((i) => i.startsWith('cutgrass')) ?? 'x0').split('x')[1] ?? 0)
if (grassNow < 2 && (s.near.grass ?? 0) > 0) {
  console.log('\n=== 采草 x2 ===')
  show('gather grass', await run('gather_resource', { resource: 'grass', count: 2, radius: 20 }, 90))
  s = await snap(); console.log(`  bag=${JSON.stringify(s.items)}`)
}

// 2. need wood: chop a tree (need axe first)
s = await snap()
const hasAxe = s.items.some((i) => i.startsWith('axe'))
const hasLog = Number((s.items.find((i) => i.startsWith('log')) ?? 'x0').split('x')[1] ?? 0)
if (hasLog < 2) {
  if (!hasAxe) {
    console.log('\n=== 做斧头（需 1 树枝 + 1 燧石）===')
    if (!s.items.some((i) => i.startsWith('twigs')) && (s.near.sapling ?? 0) > 0) {
      show('twigs', await run('gather_resource', { resource: 'twigs', count: 2, radius: 20 }, 90))
    }
    if (!s.items.some((i) => i.startsWith('flint'))) {
      show('flint', await run('pick_up_item', { item: 'flint', count: 2, radius: 20 }, 60))
    }
    show('craft axe', await run('craft_item', { recipe: 'axe', count: 1, confirmed: true }, 60))
    s = await snap(); console.log(`  bag=${JSON.stringify(s.items)}`)
  }
  if ((s.near.evergreen ?? 0) + (s.near.deciduoustree ?? 0) > 0) {
    console.log('\n=== 砍树拿木头 ===')
    show('chop', await run('chop_tree', { count: 1, radius: 20, confirmed: true }, 180))
    await sleep(1500)
    show('pick log', await run('pick_up_item', { item: 'log', count: 3, radius: 20 }, 90))
    s = await snap(); console.log(`  bag=${JSON.stringify(s.items)}`)
  }
}

// 3. build campfire (THE core test)
console.log('\n=== 建营火（核心：verify.fire_found）===')
const fire = await run('build_campfire', { confirmed: true }, 180)
show('campfire', fire)
await sleep(2000)
s = await snap()
console.log(`  bag=${JSON.stringify(s.items)}`)
console.log(`  附近营火: ${(s.near.campfire ?? 0) + (s.near.firepit ?? 0)}`)
console.log(`  → fire_found 核验: ${fire?.result?.verify?.fire_found}`)

await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: null, session_id: null, lease_expires_at: null,
  emergency_stop: false, reason: 'done',
})
console.log('=== 完成 ===')
