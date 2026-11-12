// Phase 5 M6 · 任务链真机验证
//
// 前置：游戏客户端在跑、世界未暂停（窗口最小化会暂停 → 先跑 node tools/unpause.mjs）。
// 验证：get_task_status → start_task(forage) 逐步推进 → 中途查询 → stop_task → 越权拒绝 → 清理。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKEN = readFileSync(join(HERE, '..', '..', '.runtime', 'token.txt'), 'utf8').trim()
const B = 'http://127.0.0.1:18788'
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
const CID = 'M6_LIVE'
const post = async (p, b) => {
  const r = await fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })
  return { status: r.status, json: await r.json().catch(() => null) }
}
const get = async (p) => ({ json: await (await fetch(B + p, { headers: H })).json().catch(() => null) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run(type, params, seconds = 60) {
  const e = await post('/api/v1/commands/enqueue', { type, controller_id: CID, session_id: 'S1', params })
  if (e.status !== 200 || !e.json?.command?.id) {
    return { status: `ENQ_${e.status}`, error: e.json?.error?.message ?? 'enqueue failed' }
  }
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
const show = (l, r) => {
  console.log(`  ${l}: ${r?.status} (${r?._elapsed ?? '-'}s) | ${r?.result?.text ?? '-'}`)
  if (r?.result) console.log(`      result=${JSON.stringify(r.result).slice(0, 400)}`)
  if (r?.error) console.log(`      err=${r.error}`)
  return r
}

console.log('=== ① 等会话连上（最多 60 秒）===')
let ready = false
for (let i = 0; i < 30; i += 1) {
  try {
    const s = await get('/api/v1/state')
    const b = await get('/api/v1/bridge/status')
    if (i % 5 === 0) console.log(`  t+${i * 2}s alive=${s.json?.session?.alive} connected=${b.json?.bridge?.connected}`)
    if (s.json?.session?.alive === true && s.json?.stale === false && b.json?.bridge?.connected === true) { ready = true; break }
  } catch {}
  await sleep(2000)
}
if (!ready) { console.log('  ❌ 游戏没连上（客户端在跑吗？窗口最小化了吗？）'); process.exit(1) }
const s0 = (await get('/api/v1/state')).json
const p0 = s0.snapshot.player
console.log(`  就绪: ${p0.name} hp=${p0.health.percent}% hunger=${p0.hunger.percent}% 位置=(${p0.position.tile_x},${p0.position.tile_z})`)

console.log('\n=== ② 授权控制权 ===')
const sync = await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: CID, session_id: 'S1',
  lease_expires_at: Date.now() + 900000, emergency_stop: false, reason: 'M6 task test',
})
console.log(`  sync ${sync.status} holder=${sync.json?.control?.holder}`)

console.log('\n=== ③ get_task_status（初始应为 running=false + 4 个任务）===')
const st0 = await run('get_task_status', {}, 20)
show('status', st0)

console.log('\n=== ④ 越权：start_task("rm_rf") 应被拒 ===')
show('bad task', await run('start_task', { task: 'rm_rf' }, 20))

console.log('\n=== ⑤ start_task(forage) 启动 ===')
const start = await run('start_task', { task: 'forage' }, 30)
show('start forage', start)

console.log('\n=== ⑥ 观察任务推进（每 3 秒查一次，最多 60 秒）===')
for (let i = 1; i <= 20; i += 1) {
  await sleep(3000)
  const st = await run('get_task_status', {}, 15)
  const r = st?.result ?? {}
  console.log(`  t+${i * 3}s running=${r.running} task=${r.task ?? '-'} step=${r.step_index ?? '-'}/${r.step_total ?? '-'} done=${r.steps_done ?? '-'} skipped=${r.steps_skipped ?? '-'} why=${r.current_why ?? '-'}`)
  if (r.running !== true) { console.log(`  → 任务结束：${JSON.stringify(r).slice(0, 300)}`); break }
}

console.log('\n=== ⑦ 再启动一个任务然后 stop_task ===')
const start2 = await run('start_task', { task: 'stock_logs' }, 30)
show('start stock_logs', start2)
await sleep(3000)
const stop = await run('stop_task', {}, 30)
show('stop', stop)

console.log('\n=== ⑧ 确认已停止 + 人物状态 ===')
const stEnd = await run('get_task_status', {}, 20)
show('status end', stEnd)
const sEnd = (await get('/api/v1/state')).json
const pEnd = sEnd.snapshot.player
console.log(`  hp=${pEnd.health.percent}% hunger=${pEnd.hunger.percent}% 位置=(${pEnd.position.tile_x},${pEnd.position.tile_z})`)
console.log(`  背包: ${JSON.stringify((Array.isArray(sEnd.snapshot.inventory.items) ? sEnd.snapshot.inventory.items : []).map((i) => `${i.prefab}x${i.count ?? 1}`))}`)

console.log('\n=== ⑨ 清理控制权 ===')
await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: null, session_id: null, lease_expires_at: null,
  emergency_stop: false, reason: 'M6 done',
})
const c = await get('/api/v1/control/status')
console.log(`  mode=${c.json?.control?.mode} holder=${c.json?.control?.holder}`)
console.log('\n=== 完成 ===')
