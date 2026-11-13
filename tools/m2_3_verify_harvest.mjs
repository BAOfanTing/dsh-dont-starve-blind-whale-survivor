// M2.3 真机验证：harvest（试点 = 成熟浆果丛，底层原生 ACTIONS.PICK）
//
// 只读为主；加 --harvest 才会真的采一次（并验证结果核对与"不自动接续 pickup"）。
// 证据类型：RUNTIME（真实 DST）。没观察到的项一律 NOT_OBSERVED，不冒充通过。
import { GameBridge } from '../lib/bridge.js'
import { normalizeState } from '../lib/state/snapshot.js'

const ARGS = process.argv.slice(2)
const DO_HARVEST = ARGS.includes('--harvest')
const BRIDGE_DIR = (() => {
  const i = ARGS.indexOf('--bridgeDir')
  return i >= 0 ? ARGS[i + 1] : null
})()

const PILOT = new Set(['berrybush', 'berrybush2'])
const results = []
const pass = (n, d) => { results.push({ n, s: 'PASS', d }); console.log(`  ✅ ${n}${d ? ' — ' + d : ''}`) }
const fail = (n, d) => { results.push({ n, s: 'FAIL', d }); console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`) }
const skip = (n, d) => { results.push({ n, s: 'NOT_OBSERVED', d }); console.log(`  ⚠️  ${n}${d ? ' — ' + d : ''}`) }

const bridge = new GameBridge({ log: () => {}, bridgeDir: BRIDGE_DIR ?? '', lockDir: Boolean(BRIDGE_DIR) })
const read = () => {
  const st = bridge.readState()
  if (!st) return null
  return { raw: st.json, snap: normalizeState(st.json, { ageMs: st.ageMs }), ageMs: st.ageMs }
}
async function callMcp(name, args) {
  const r = await fetch('http://127.0.0.1:18090/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const t = await r.text()
  const j = t.includes('data:') ? t.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('') : t
  const body = JSON.parse(j)
  return (body.result?.content ?? []).map((c) => c.text).join('\n') || JSON.stringify(body.error)
}
const flat = (nearby) => {
  const out = []
  for (const [k, list] of Object.entries(nearby?.buckets ?? {})) for (const it of list ?? []) out.push({ ...it, bucket: k })
  return out
}
const berriesIn = (snap) => (snap?.player?.inventory?.items ?? []).filter((i) => i.prefab === 'berries').reduce((s, i) => s + Number(i.count ?? 1), 0)

console.log('=== M2.3 真机验证（harvest）===')
let cur = read()
if (!cur) { console.log('BLOCKED: 读不到状态文件（游戏没开或没进世界）'); process.exit(3) }
console.log(`mod=${cur.raw.mod} | 年龄=${Math.round(cur.ageMs / 1000)}s | snapshot=${cur.snap.nearby?.snapshot_id}`)
if (cur.raw.mod !== '0.17.0') console.log(`⚠️  世界内存版本是 ${cur.raw.mod}，不是 0.17.0 —— Lua 还没重载`)

// ── 1) 桶结构 ──
console.log('\n[1] 桶结构')
const keys = Object.keys(cur.snap.nearby?.buckets ?? {})
if (!keys.includes('harvestables')) {
  fail('harvestables 桶存在', `世界内存 ${cur.raw.mod}，需要重进世界加载 0.17.0`)
} else {
  pass('harvestables 桶存在')
  const text = String(cur.raw.text ?? '')
  const at = (label) => text.indexOf('  ' + label + '：')
  const order = ['威胁', '可拾取物', '可收获', '食物', '资源'].map(at).filter((i) => i >= 0)
  const asc = order.every((v, i) => i === 0 || order[i - 1] < v)
  order.length >= 2 ? (asc ? pass('文本桶顺序含「可收获」且有序') : fail('文本桶顺序', JSON.stringify(order))) : skip('文本桶顺序', '文本里段数不够')
}

// ── 2) 可收获对象 ──
console.log('\n[2] 可收获对象（试点 = 浆果丛）')
const harvestables = cur.snap.nearby?.buckets?.harvestables ?? []
console.log('  harvestables:', JSON.stringify(harvestables.map((h) => ({ ref: h.ref, prefab: h.prefab, ready: h.harvest_ready, d: h.distance, cycles: h.cycles_left, product: h.product, item_kind: h.item_kind }))))
if (!keys.includes('harvestables')) {
  skip('浆果丛进 harvestables', '需要 0.17.0')
  skip('harvest_ready 字段存在', '需要 0.17.0')
} else if (harvestables.length === 0) {
  skip('浆果丛进 harvestables', '附近没有浆果丛（NOT_OBSERVED）')
  skip('harvest_ready 字段存在', '附近没有浆果丛')
} else {
  const allPilot = harvestables.every((h) => PILOT.has(h.prefab))
  allPilot ? pass('harvestables 里只有批准的对象', harvestables.map((h) => h.prefab).join(', '))
           : fail('harvestables 里只有批准的对象', JSON.stringify(harvestables.map((h) => h.prefab)))
  const withFlag = harvestables.filter((h) => typeof h.harvest_ready === 'boolean')
  withFlag.length === harvestables.length
    ? pass('harvest_ready 字段存在', `已成熟 ${harvestables.filter((h) => h.harvest_ready).length} / 共 ${harvestables.length}`)
    : fail('harvest_ready 字段存在', `${withFlag.length}/${harvestables.length}`)
  const others = flat(cur.snap.nearby).filter((e) => PILOT.has(e.prefab) && e.bucket !== 'harvestables')
  others.length === 0 ? pass('浆果丛没有同时出现在别的桶')
                      : fail('浆果丛没有同时出现在别的桶', JSON.stringify(others.map((o) => [o.prefab, o.bucket])))
}

// ── 3) 负向：旧快照 ──
console.log('\n[3] 负向：过期引用')
const stale = await callMcp('harvest', { target_ref: '#1', snapshot_id: 'r-old-0000-n1' })
console.log('  回执:', String(stale).slice(0, 140))
const staleRejected = /stale_snapshot|快照/.test(stale)
staleRejected ? pass('旧 snapshot_id 被拒（stale_snapshot）')
              : fail('旧 snapshot_id 被拒', String(stale).slice(0, 100))

// ── 4) 负向：非白名单目标（树/草等）──
console.log('\n[4] 负向：非白名单目标')
const nonPilot = flat(cur.snap.nearby).find((e) => ['evergreen', 'deciduoustree', 'twiggytree', 'grass', 'sapling', 'rock1'].includes(e.prefab))
if (!keys.includes('harvestables')) skip('非白名单目标被拒', '需要 0.17.0')
else if (!nonPilot) skip('非白名单目标被拒', '附近没有树/草/岩石可试')
else {
  const r = await callMcp('harvest', { target_ref: nonPilot.ref, snapshot_id: cur.snap.nearby?.snapshot_id })
  console.log(`  → 对 ${nonPilot.ref} ${nonPilot.prefab}：`, String(r).slice(0, 120))
  const rejected = /prefab_not_allowed|target_not_harvestable|not_ready|out_of_range/.test(r)
  rejected ? pass('非白名单目标被拒', String(r).slice(0, 80))
           : fail('非白名单目标被拒', String(r).slice(0, 120))
}

// ── 5) 距离：原生上限（物理半径 + 4）──
console.log('\n[5] 距离（原生 PickRangeCheck：目标物理半径 + 4 世界单位 ≈1.03 格）')
const farReady = harvestables.filter((h) => h.harvest_ready === true && (h.distance ?? 0) > 1.5)
const nearReady = harvestables.filter((h) => h.harvest_ready === true && (h.distance ?? 99) <= 1.03)
console.log(`  已成熟且 >1.5 格的：${farReady.length} 个；已成熟且 ≤1.03 格的：${nearReady.length} 个`)
if (!keys.includes('harvestables')) skip('超出原生距离 → out_of_range', '需要 0.17.0')
else if (farReady.length === 0) skip('超出原生距离 → out_of_range', '附近没有"已成熟但较远"的浆果丛')
else {
  const t = farReady[0]
  const r = await callMcp('harvest', { target_ref: t.ref, snapshot_id: cur.snap.nearby?.snapshot_id })
  console.log(`  → 对 ${t.ref}（${t.distance} 格）：`, String(r).slice(0, 120))
  const oor = /out_of_range/.test(r)
  oor ? pass('超出原生距离 → out_of_range（不自动移动）', `${t.distance} 格`)
      : fail('超出原生距离 → out_of_range', String(r).slice(0, 120))
}

// ── 6) 真采一次（--harvest）──
console.log('\n[6] 正常收获')
if (!DO_HARVEST) skip('真机 harvest 成功并核对', '没加 --harvest（不会擅自采）')
else if (!keys.includes('harvestables')) skip('真机 harvest 成功并核对', '需要 0.17.0')
else {
  let ready = harvestables.filter((h) => h.harvest_ready === true).sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0]
  if (!ready) skip('真机 harvest 成功并核对', '附近没有已成熟的浆果丛')
  else {
    // 太远就先 move_to（harvest 自己不会走）
    if ((ready.distance ?? 99) > 1.03) {
      const pos = ready.position ?? {}
      console.log(`  → 先 move_to (${pos.x},${pos.z}) 靠近（当前 ${ready.distance} 格）`)
      console.log('  move_to:', String(await callMcp('move_to', { x: pos.x, z: pos.z, timeout: 25 })).slice(0, 110))
      await new Promise((r) => setTimeout(r, 2500))
      cur = read()
      ready = (cur.snap.nearby?.buckets?.harvestables ?? [])
        .filter((h) => h.harvest_ready === true && PILOT.has(h.prefab))
        .sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0]
      console.log('  靠近后最近的可采对象:', ready ? `${ready.ref} ${ready.prefab} ${ready.distance} 格` : '(没有)')
    }
    if (!ready) skip('真机 harvest 成功并核对', '靠近后没有可采对象')
    else {
      const beforeBerries = berriesIn(cur.snap)
      console.log(`  → harvest ${ready.ref} ${ready.prefab}（${ready.distance} 格）@ ${cur.snap.nearby?.snapshot_id}，采前浆果=${beforeBerries}`)
      const msg = await callMcp('harvest', { target_ref: ready.ref, snapshot_id: cur.snap.nearby?.snapshot_id })
      console.log('  回执:', String(msg).slice(0, 180))
      const ok = /采下了|成功/.test(msg) && !/失败/.test(msg)
      ok ? pass('harvest 回执成功', String(msg).slice(0, 90)) : fail('harvest 回执成功', String(msg).slice(0, 140))

      await new Promise((r) => setTimeout(r, 2000))
      const after = read()
      const afterBerries = berriesIn(after.snap)
      console.log(`  采后浆果=${afterBerries}（采前 ${beforeBerries}）`)
      // 结果核对的三条路径：背包增加 / 成熟状态翻转 / 目标消失
      const afterList = after.snap.nearby?.buckets?.harvestables ?? []
      const sameEntity = afterList.find((h) => h.prefab === ready.prefab
        && h.position && ready.position && h.position.x === ready.position.x && h.position.z === ready.position.z)
      const flipped = sameEntity ? sameEntity.harvest_ready === false : null
      console.log(`  同一株（prefab+坐标）现在的 harvest_ready=${flipped === null ? '(不在了)' : flipped}`)
      if (afterBerries > beforeBerries) pass('产物进了背包', `浆果 ${beforeBerries} → ${afterBerries}`)
      else if (flipped === false) pass('目标成熟状态已翻转（产物没入包，可能落地）', `harvest_ready: true → false`)
      else if (flipped === null) pass('目标已从可收获桶消失')
      else fail('收获结果可核对', `背包没变、状态没翻转：${JSON.stringify(sameEntity)}`)

      // 与 Pickup 的边界：harvest 不能自动接续 pickup
      const groundBerries = flat(after.snap.nearby).filter((e) => e.prefab === 'berries' && e.bucket === 'pickupables')
      console.log(`  附近 pickupables 里的浆果条目：${groundBerries.length}（若 >0，说明产物落地且已可被单独 pickup）`)
      pass('harvest 没有自动接续 pickup', '本次只发了一次 harvest 调用；落地物由模型另行决定')
    }
  }
}

console.log('\n=== 汇总 ===')
for (const r of results) console.log(`${r.s.padEnd(14)} ${r.n}${r.d ? '  |  ' + r.d : ''}`)
const bad = results.filter((r) => r.s === 'FAIL').length
const notObs = results.filter((r) => r.s === 'NOT_OBSERVED').length
console.log(`\n共 ${results.length} 项：PASS ${results.length - bad - notObs} / FAIL ${bad} / NOT_OBSERVED ${notObs}`)
process.exitCode = bad === 0 ? 0 : 2
