// M2.1 真机验证：pickup 全链路（走真实 MCP HTTP 入口）
//
// 1) get_state 找白名单候选（twigs/cutgrass/flint）
// 2) 太远就先用 move_to 靠近（pickup 自己不会走路）
// 3) 用**新快照**的 #N + snapshot_id 调 pickup
// 4) 复查背包该 prefab 数量是否真的 +1
// 5) 负向：对树调 pickup → 期望 prefab_not_allowed（零副作用）
// 6) 负向：用旧 snapshot_id → 期望 stale_snapshot
const MCP = 'http://127.0.0.1:18090/mcp'
const WHITELIST = new Set(['twigs', 'cutgrass', 'flint'])

async function rpc(method, params) {
  const r = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const text = await r.text()
  const raw = text.includes('data:') ? text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('') : text
  return JSON.parse(raw)
}
async function call(name, args) {
  const b = await rpc('tools/call', { name, arguments: args })
  const text = (b.result?.content ?? []).map((c) => c.text).join('\n')
  if (b.error) return { text: JSON.stringify(b.error), error: true }
  return { text }
}
async function state() {
  const { text } = await call('get_state', { format: 'json' })
  try { return JSON.parse(text) } catch { return null }
}
function items(snap) {
  const out = []
  for (const [k, list] of Object.entries(snap?.nearby?.buckets ?? {})) {
    for (const it of list ?? []) out.push({ bucket: k, ...it })
  }
  return out
}
function invCount(snap, prefab) {
  const list = snap?.player?.inventory?.items
  if (!Array.isArray(list)) return 0
  return list.filter((i) => i.prefab === prefab).reduce((s, i) => s + Number(i.count ?? 1), 0)
}
const results = []
const ok = (n, d) => { results.push({ n, pass: true, d }); console.log(`  ✅ ${n}${d ? ' — ' + d : ''}`) }
const bad = (n, d) => { results.push({ n, pass: false, d }); console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`) }

console.log('=== 1) 读当前快照 ===')
let snap = await state()
if (!snap) { console.log('BLOCKED: get_state 读不到'); process.exit(3) }
console.log('mod:', snap.mod ?? '(?)', '| snapshot:', snap.nearby?.snapshot_id, '| 位置:', snap.actor?.tile_x, snap.actor?.tile_z, '| ghost:', snap.actor?.is_ghost)
if (snap.actor?.is_ghost === true || snap.actor?.actor_type === 'player_ghost') { console.log('BLOCKED: 角色是灵魂'); process.exit(3) }

const all = items(snap)
console.log('附近条目:', all.length, '| 白名单候选:', JSON.stringify(all.filter((i) => WHITELIST.has(i.prefab)).map((i) => ({ ref: i.ref, prefab: i.prefab, d: i.distance }))))
let target = all.filter((i) => WHITELIST.has(i.prefab)).sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0] ?? null

// 2) 没有候选 / 太远 → 先靠近
if (!target || (target.distance ?? 99) > 2.5) {
  if (!target) {
    console.log('附近没有白名单物品，先找最近的可拾取目标失败 → 需要玩家站在树枝/割草/燧石旁')
    process.exit(3)
  }
  const pos = target.position ?? {}
  console.log(`=== 2) 目标 ${target.ref} ${target.prefab} 在 ${target.distance} 格，先用 move_to 靠近 (${pos.x},${pos.z}) ===`)
  const mv = await call('move_to', { x: pos.x, z: pos.z, timeout: 20 })
  console.log('  move_to:', String(mv.text).slice(0, 120))
  await new Promise((r) => setTimeout(r, 2500))
  snap = await state()
  if (!snap) { console.log('BLOCKED: 移动后读不到状态'); process.exit(3) }
  const near = items(snap).filter((i) => WHITELIST.has(i.prefab)).sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0] ?? null
  console.log('  移动后最近候选:', near ? `${near.ref} ${near.prefab} ${near.distance} 格` : '(没有)')
  target = near
}

if (!target) { console.log('BLOCKED: 靠近后仍没有白名单目标'); process.exit(3) }

// 3) 正式 pickup
console.log(`=== 3) pickup ${target.ref} (${target.prefab}, ${target.distance} 格) @ snapshot ${snap.nearby?.snapshot_id} ===`)
const beforeCount = invCount(snap, target.prefab)
const beforeSnapId = snap.nearby?.snapshot_id
const pick = await call('pickup', { target_ref: target.ref, snapshot_id: beforeSnapId })
console.log('  pickup 回执:', String(pick.text).slice(0, 200))

await new Promise((r) => setTimeout(r, 1500))
const after = await state()
const afterCount = invCount(after, target.prefab)
console.log(`  背包 ${target.prefab}: ${beforeCount} → ${afterCount}`)

const succeeded = /^成功|捡起/.test(String(pick.text)) && !/失败/.test(String(pick.text))
if (succeeded) ok('pickup 返回成功', String(pick.text).slice(0, 80))
else bad('pickup 返回成功', String(pick.text).slice(0, 120))
if (afterCount > beforeCount) ok('背包里该物品真的增加了', `${beforeCount} → ${afterCount}`)
else bad('背包里该物品真的增加了', `${beforeCount} → ${afterCount}`)
if (succeeded === (afterCount > beforeCount)) ok('回执与真实状态一致（没有谎报）')
else bad('回执与真实状态一致', `回执成功=${succeeded} 背包增加=${afterCount > beforeCount}`)

// 5) 负向：树
const tree = items(after).find((i) => ['evergreen', 'deciduoustree', 'twiggytree'].includes(i.prefab))
if (tree) {
  console.log(`=== 4) 负向：对 ${tree.ref} ${tree.prefab}（树）调 pickup ===`)
  const r = await call('pickup', { target_ref: tree.ref, snapshot_id: after.nearby?.snapshot_id })
  console.log('  回执:', String(r.text).slice(0, 160))
  if (/prefab_not_allowed|target_not_pickable|out_of_range/.test(String(r.text))) ok('树被正确拒绝', String(r.text).slice(0, 80))
  else bad('树被正确拒绝', String(r.text).slice(0, 120))
} else {
  console.log('  ℹ 附近没有树，跳过负向用例')
}

// 6) 负向：旧快照
console.log('=== 5) 负向：旧 snapshot_id ===')
const stale = await call('pickup', { target_ref: '#1', snapshot_id: 'r-old-0000-n1' })
console.log('  回执:', String(stale.text).slice(0, 160))
if (/stale_snapshot|快照/.test(String(stale.text))) ok('旧快照被拒（stale_snapshot）')
else bad('旧快照被拒', String(stale.text).slice(0, 120))

// 7) 复查角色/背包没被负向用例影响
const finalSnap = await state()
console.log('=== 6) 收尾状态 ===')
console.log('  位置:', finalSnap?.actor?.tile_x, finalSnap?.actor?.tile_z, '| 背包:', JSON.stringify((finalSnap?.player?.inventory?.items ?? []).map((i) => `${i.prefab}x${i.count}`)))

console.log('\n=== 汇总 ===')
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? '  |  ' + r.d : ''}`)
const failed = results.filter((r) => !r.pass).length
console.log(`\n共 ${results.length} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 2)
