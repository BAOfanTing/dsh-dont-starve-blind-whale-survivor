// Precise verification: how many trees actually fall with chop(count=N)?
// Use precise entity snapshot before/after + bag diff.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKEN = readFileSync(join(HERE, '..', '..', '.runtime', 'token.txt'), 'utf8').trim()
const B = 'http://127.0.0.1:18788'
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
const CID = 'PRECISE'
const post = async (p, b) => {
  const r = await fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })
  return { status: r.status, json: await r.json().catch(() => null) }
}
const get = async (p) => ({ json: await (await fetch(B + p, { headers: H })).json().catch(() => null) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run(type, params, seconds = 180) {
  const e = await post('/api/v1/commands/enqueue', { type, controller_id: CID, session_id: 'S1', params })
  if (!e.json?.command?.id) return { status: `ENQ_${e.status}`, error: e.json?.error?.message }
  const id = e.json.command.id
  const t0 = Date.now()
  for (let i = 0; i < seconds * 5; i += 1) {
    await sleep(200)
    const all = await get('/api/v1/commands')
    const rec = (all.json?.commands ?? []).find((c) => c.id === id)
    if (rec && !['QUEUED', 'DELIVERED', 'EXECUTING'].includes(rec.status)) {
      rec._elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      return rec
    }
  }
  return { status: 'TIMEOUT', _elapsed: ((Date.now() - t0) / 1000).toFixed(1) }
}

/** 精确快照：按 prefab 统计，且区分"可砍树"和"树桩" */
async function precise() {
  const s = (await get('/api/v1/state')).json
  const ents = Array.isArray(s?.snapshot?.nearby?.entities) ? s.snapshot.nearby.entities : []
  const g = {}
  for (const e of ents) g[e.prefab] = (g[e.prefab] ?? 0) + 1
  const items = Array.isArray(s?.snapshot?.inventory?.items) ? s.snapshot.inventory.items : []
  const bag = {}
  for (const i of items) bag[i.prefab] = (bag[i.prefab] ?? 0) + (i.count ?? 1)
  return { g, bag, tile: `${s?.snapshot?.player?.position?.tile_x},${s?.snapshot?.player?.position?.tile_z}` }
}

await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: CID, session_id: 'S1',
  lease_expires_at: Date.now() + 900000, emergency_stop: false, reason: 'precise count test',
})

const b0 = await precise()
console.log(`=== before === tile=${b0.tile}`)
console.log(`  实体: ${JSON.stringify(b0.g)}`)
console.log(`  背包: ${JSON.stringify(b0.bag)}`)

// 只砍 1 棵，验证是否真的只砍 1 棵
console.log('\n=== chop_tree(count=3) —— 该砍倒 3 棵 ===')
const r = await run('chop_tree', { count: 3, radius: 30, confirmed: true }, 300)
console.log(`  ${r?.status} (${r?._elapsed}s) text=${r?.result?.text}`)
console.log(`  verify=${JSON.stringify(r?.result?.verify)}`)

await sleep(2500)
const b1 = await precise()
console.log(`\n=== after === tile=${b1.tile}`)
console.log(`  实体: ${JSON.stringify(b1.g)}`)
console.log(`  背包: ${JSON.stringify(b1.bag)}`)

// 逐 prefab 对比
console.log('\n=== 变化 ===')
const keys = new Set([...Object.keys(b0.g), ...Object.keys(b1.g)])
for (const k of [...keys].sort()) {
  const a = b0.g[k] ?? 0
  const b = b1.g[k] ?? 0
  if (a !== b) console.log(`  ${k}: ${a} → ${b} (${b - a > 0 ? '+' : ''}${b - a})`)
}
const bagKeys = new Set([...Object.keys(b0.bag), ...Object.keys(b1.bag)])
for (const k of [...bagKeys].sort()) {
  const a = b0.bag[k] ?? 0
  const b = b1.bag[k] ?? 0
  if (a !== b) console.log(`  背包 ${k}: ${a} → ${b} (${b - a > 0 ? '+' : ''}${b - a})`)
}

await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: null, session_id: null, lease_expires_at: null,
  emergency_stop: false, reason: 'done',
})
