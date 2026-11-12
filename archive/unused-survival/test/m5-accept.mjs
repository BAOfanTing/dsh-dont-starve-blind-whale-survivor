// M5 formal acceptance: eat_item / craft_item / build_campfire real-machine verification
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKEN = readFileSync(join(HERE, '..', '..', '.runtime', 'token.txt'), 'utf8').trim()
const B = 'http://127.0.0.1:18788'
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
const CID = 'M5ACC'
const post = async (p, b) => {
  const r = await fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })
  return { status: r.status, json: await r.json().catch(() => null) }
}
const get = async (p) => ({ json: await (await fetch(B + p, { headers: H })).json().catch(() => null) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run(type, params, seconds = 90) {
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
  return { status: 'TIMEOUT', _elapsed: ((Date.now() - t0) / 1000).toFixed(1) }
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
  return {
    hp: s?.snapshot?.player?.health?.percent,
    hunger: s?.snapshot?.player?.hunger?.percent,
    hungerVal: s?.snapshot?.player?.hunger?.value,
    day: s?.snapshot?.world?.day, phase: s?.snapshot?.world?.phase,
    items: (Array.isArray(s?.snapshot?.inventory?.items) ? s.snapshot.inventory.items : []).map((i) => `${i.prefab}x${i.count ?? 1}`),
    hands: s?.snapshot?.inventory?.equipment?.hands?.prefab ?? null,
    alive: s?.session?.alive,
  }
}

// 清掉积压的旧命令，避免干扰判定
const oldCmds = (await get('/api/v1/commands')).json?.commands ?? []
const pending = oldCmds.filter((c) => ['QUEUED','DELIVERED','EXECUTING'].includes(c.status))
if (pending.length > 0) console.log(`  （队列里有 ${pending.length} 条未完成命令，忽略）`)

const sync = await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: CID, session_id: 'S1',
  lease_expires_at: Date.now() + 900000, emergency_stop: false, reason: 'M5 acceptance',
})
console.log(`=== 控制权: ${sync.status} holder=${sync.json?.control?.holder} ===`)

let s = await snap()
console.log(`=== 初始 === hp=${s.hp}% hunger=${s.hunger}% (${s.hungerVal}/200) day=${s.day} ${s.phase}`)
console.log(`  bag=${JSON.stringify(s.items)} hands=${s.hands}`)

// ── ① eat_item 未确认 → 应被拒（程序层强制）──────────────────
console.log('\n=== ① eat_item 不传 confirmed → 应被拒 ===')
show('eat(no confirm)', await run('eat_item', {}, 20))

// ── ② eat_item 白名单外食物 → 应被拒 ────────────────────────
console.log('\n=== ② eat_item 白名单外（goldnugget）→ 应被拒 ===')
show('eat(goldnugget)', await run('eat_item', { item: 'goldnugget', confirmed: true }, 20))

// ── ③ eat_item 真吃（best_food 修复：不该选树枝）────────────
console.log('\n=== ③ eat_item 确认后真吃（best_food 不该选树枝）===')
const before = await snap()
const eat = await run('eat_item', { confirmed: true }, 60)
show('eat', eat)
const after = await snap()
console.log(`  hunger: ${before.hungerVal} → ${after.hungerVal} (${before.hunger}% → ${after.hunger}%)`)
console.log(`  bag: ${JSON.stringify(before.items)} → ${JSON.stringify(after.items)}`)
const gained = (after.hungerVal ?? 0) - (before.hungerVal ?? 0)
console.log(`  → 饥饿变化: ${gained > 0 ? '+' : ''}${gained.toFixed(1)}  ${gained > 0.5 ? '✅ 真吃到' : '⚠️ 没吃到'}`)

// ── ④ craft_item 未确认 → 应被拒 ───────────────────────────
console.log('\n=== ④ craft_item 不传 confirmed → 应被拒 ===')
show('craft(no confirm)', await run('craft_item', { recipe: 'campfire' }, 20))

// ── ⑤ craft_item 白名单外配方 → 应被拒 ─────────────────────
console.log('\n=== ⑤ craft_item 白名单外（goldnugget）→ 应被拒 ===')
show('craft(goldnugget)', await run('craft_item', { recipe: 'goldnugget', confirmed: true }, 20))

// ── ⑥ 补材料：营火要 2 草 + 2 木 ───────────────────────────
s = await snap()
const hasGrass = (s.items.find((i) => i.startsWith('cutgrass')) ?? 'x0').split('x')[1] | 0
const hasLog = (s.items.find((i) => i.startsWith('log')) ?? 'x0').split('x')[1] | 0
console.log(`\n=== ⑥ 材料检查: cutgrass=${hasGrass} log=${hasLog}（营火需 2+2）===`)
if (hasGrass < 2) {
  show('gather grass', await run('gather_resource', { resource: 'grass', count: 2, radius: 20 }, 90))
}
if (hasLog < 2) {
  show('pick log', await run('pick_up_item', { item: 'log', count: 3, radius: 20 }, 60))
}

// ── ⑦ build_campfire 未确认 → 应被拒 ───────────────────────
console.log('\n=== ⑦ build_campfire 不传 confirmed → 应被拒 ===')
show('campfire(no confirm)', await run('build_campfire', {}, 20))

// ── ⑧ build_campfire 真建（核心验证：fire_found）───────────
console.log('\n=== ⑧ build_campfire 确认后真建 ===')
const fire = await run('build_campfire', { confirmed: true }, 150)
show('campfire', fire)

// ── ⑨ 白名单外建筑 → 应被拒 ────────────────────────────────
console.log('\n=== ⑨ build_structure 白名单外（wall_stone）→ 应被拒 ===')
show('build(wall_stone)', await run('build_structure', { recipe: 'wall_stone', confirmed: true }, 20))

// ── 汇总 ───────────────────────────────────────────────────
const fin = await snap()
console.log('\n=== 最终 ===')
console.log(`  hp=${fin.hp}% hunger=${fin.hunger}% (${fin.hungerVal}/200) day=${fin.day} ${fin.phase}`)
console.log(`  bag=${JSON.stringify(fin.items)} hands=${fin.hands}`)

await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: null, session_id: null, lease_expires_at: null,
  emergency_stop: false, reason: 'M5 acceptance done',
})
console.log('=== 完成 ===')
