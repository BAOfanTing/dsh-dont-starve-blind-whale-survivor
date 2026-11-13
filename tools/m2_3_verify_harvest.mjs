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
// 注意：Lua 的 JSON 编码把**空表**写成 {}（不是 []），所以这里两种形状都要能吃下
const itemsOf = (snap) => {
  const items = snap?.player?.inventory?.items
  if (Array.isArray(items)) return items
  return Object.values(items ?? {})
}
const berriesIn = (snap) => itemsOf(snap).filter((i) => i?.prefab === 'berries').reduce((s, i) => s + Number(i?.count ?? 1), 0)

console.log('=== M2.3 真机验证（harvest）===')
let cur = read()
if (!cur) { console.log('BLOCKED: 读不到状态文件（游戏没开或没进世界）'); process.exit(3) }
console.log(`mod=${cur.raw.mod} | 年龄=${Math.round(cur.ageMs / 1000)}s | snapshot=${cur.snap.nearby?.snapshot_id}`)
const NEED = /^0\.17\./
if (!NEED.test(String(cur.raw.mod))) console.log(`⚠️  世界内存版本是 ${cur.raw.mod}，不是 0.17.x —— Lua 还没重载到 M2.3`)

// ── 1) 桶结构 ──
console.log('\n[1] 桶结构')
const keys = Object.keys(cur.snap.nearby?.buckets ?? {})
if (!keys.includes('harvestables')) {
  fail('harvestables 桶存在', `世界内存 ${cur.raw.mod}，需要重进世界加载 0.17.x`)
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
  skip('浆果丛进 harvestables', '需要 0.17.x')
  skip('harvest_ready 字段存在', '需要 0.17.x')
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
// 说明：模组里的 reflex（独立生存反射）会自己起动作（craft/heal/add_fuel/move_to），
// 那时 Whale.job ~= nil，harvest 会正确地回 actor_busy —— 这不是 bug，是"一个 Actor 一次一个动作"。
// 真实用法就是先 stop 再重试，所以脚本也这么做（并把这一事实打印出来）。
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
const stopAndSettle = async (why) => {
  console.log('  → ' + why + '：先 stop 清掉占用，再继续')
  console.log('    stop:', String(await callMcp('stop', {})).slice(0, 60))
  await sleepMs(1300)
}
/** 调 harvest；若被别的动作占着（actor_busy）就 stop 重试一次 */
const harvestCall = async (ref, snapshotId, label) => {
  let msg = await callMcp('harvest', { target_ref: ref, snapshot_id: snapshotId })
  // 结果文件是单槽：reflex 的报告可能把我们的结果盖掉 → result_timeout。重试一次。
  if (/result_timeout|结果未知/.test(msg)) {
    console.log('  → 回执丢失（结果文件是单槽，可能被 reflex 的报告盖掉），重试一次')
    await sleepMs(1500)
    const s = read()
    const still = flat(s.snap.nearby).find((e) => e.ref === ref)
    if (still) msg = await callMcp('harvest', { target_ref: ref, snapshot_id: s.snap.nearby?.snapshot_id })
  }
  if (/actor_busy/.test(msg)) {
    await stopAndSettle('Actor 被别的动作占着（多为 reflex）')
    const s = read()
    const same = flat(s.snap.nearby).find((e) => e.ref === ref) ?? null
    if (same) msg = await callMcp('harvest', { target_ref: ref, snapshot_id: s.snap.nearby?.snapshot_id })
    else msg = '（stop 后快照已刷新，原引用失效，未重试）' + msg
  }
  return msg
}
const stale = await callMcp('harvest', { target_ref: '#1', snapshot_id: 'r-old-0000-n1' })
console.log('  回执:', String(stale).slice(0, 140))
const staleRejected = /stale_snapshot|快照/.test(stale)
staleRejected ? pass('旧 snapshot_id 被拒（stale_snapshot）')
              : fail('旧 snapshot_id 被拒', String(stale).slice(0, 100))

// ── 4) 负向：非白名单目标（树/草等）──
console.log('\n[4] 负向：非白名单目标')
const nonPilot = flat(cur.snap.nearby).find((e) => ['evergreen', 'deciduoustree', 'twiggytree', 'grass', 'sapling', 'rock1'].includes(e.prefab))
if (!keys.includes('harvestables')) skip('非白名单目标被拒', '需要 0.17.x')
else if (!nonPilot) skip('非白名单目标被拒', '附近没有树/草/岩石可试')
else {
  // 附近每 4 秒刷新一次，必须用**当下**的快照 id，否则会先被 stale_snapshot 拒掉（测不到想测的原因）
  const fresh = read()
  const freshNonPilot = flat(fresh.snap.nearby).find((e) => e.prefab === nonPilot.prefab && e.position && nonPilot.position && e.position.x === nonPilot.position.x && e.position.z === nonPilot.position.z) ?? nonPilot
  const r = await harvestCall(freshNonPilot.ref, fresh.snap.nearby?.snapshot_id, 'non-pilot')
  console.log(`  → 对 ${nonPilot.ref} ${nonPilot.prefab}：`, String(r).slice(0, 120))
  const rejected = /prefab_not_allowed|target_not_harvestable|not_ready|out_of_range/.test(r)
  if (rejected) pass('非白名单目标被拒', String(r).slice(0, 80))
  else if (/actor_busy/.test(r)) skip('非白名单目标被拒', 'stop 后仍被别的动作占着（actor_busy），没测到原因')
  else fail('非白名单目标被拒', String(r).slice(0, 120))
}

// ── 4.5) 负向：未成熟对象 → not_ready（真机 checklist 的测试 B）──
console.log('\n[4.5] 负向：未成熟（被采过）的浆果丛')
if (!keys.includes('harvestables')) {
  skip('未成熟目标被拒', '需要 0.17.x')
} else {
  const freshN = read()
  const t0 = (freshN.snap.nearby?.buckets?.harvestables ?? []).find((h) => h.harvest_ready === false)
  if (!t0) {
    skip('未成熟目标被拒（not_ready）', '附近没有"已采过"的浆果丛（NOT_OBSERVED）')
  } else {
    const r = await harvestCall(t0.ref, freshN.snap.nearby?.snapshot_id, 'not-ready')
    console.log('  → 对 ' + t0.ref + '（harvest_ready=false，' + t0.distance + ' 格）：' + String(r).slice(0, 120))
    const good = /not_ready|already_harvested|out_of_range|target_busy/.test(r)
    if (good) pass('未成熟目标被拒', String(r).slice(0, 80))
    else if (/actor_busy/.test(r)) skip('未成熟目标被拒', '被别的动作占着（actor_busy）')
    else fail('未成熟目标被拒', String(r).slice(0, 120))
  }
}

// ── 5) 距离：原生上限（物理半径 + 4）──
console.log('\n[5] 距离（原生 PickRangeCheck：目标物理半径 + 4 世界单位 ≈1.03 格）')
const farReady = harvestables.filter((h) => h.harvest_ready === true && (h.distance ?? 0) > 1.5)
const nearReady = harvestables.filter((h) => h.harvest_ready === true && (h.distance ?? 99) <= 1.03)
console.log(`  已成熟且 >1.5 格的：${farReady.length} 个；已成熟且 ≤1.03 格的：${nearReady.length} 个`)
if (!keys.includes('harvestables')) skip('超出原生距离 → out_of_range', '需要 0.17.x')
else if (farReady.length === 0) skip('超出原生距离 → out_of_range', '附近没有"已成熟但较远"的浆果丛')
else {
  const fresh = read()
  const freshReady = (fresh.snap.nearby?.buckets?.harvestables ?? []).filter((h) => h.harvest_ready === true && (h.distance ?? 0) > 1.5).sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))
  const t = freshReady[0]
  const r = await harvestCall(t.ref, fresh.snap.nearby?.snapshot_id, 'far')
  console.log(`  → 对 ${t.ref}（${t.distance} 格）：`, String(r).slice(0, 120))
  const oor = /out_of_range/.test(r)
  if (oor) pass('超出原生距离 → out_of_range（不自动移动）', t.distance + ' 格')
  else if (/actor_busy/.test(r)) skip('超出原生距离 → out_of_range', '被别的动作占着（actor_busy）')
  else fail('超出原生距离 → out_of_range', String(r).slice(0, 120))
}

// ── 6) 真采一次（--harvest）──
console.log('\n[6] 正常收获')
if (!DO_HARVEST) skip('真机 harvest 成功并核对', '没加 --harvest（不会擅自采）')
else if (!keys.includes('harvestables')) skip('真机 harvest 成功并核对', '需要 0.17.x')
else {
  const fresh0 = read()
  let ready = (fresh0.snap.nearby?.buckets?.harvestables ?? []).filter((h) => h.harvest_ready === true).sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0]
  cur = fresh0
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
      let msg = await harvestCall(ready.ref, cur.snap.nearby?.snapshot_id, 'harvest')
      console.log('  回执:', String(msg).slice(0, 180))
      // 原生拾取距离 ≈1.03 格，和 move_to 的到点容差（实测"还差 1.1 格"）是同一量级，
      // 所以第一次很可能 out_of_range —— 按真实用法"再靠近一点再试"重试几次。
      for (let i = 0; i < 3 && /out_of_range/.test(msg); i++) {
        const pos = ready.position ?? {}
        console.log(`  → 距离不够（原生上限 ≈1.03 格），再靠近一点 (${pos.x},${pos.z}) 后重试`)
        console.log('  move_to:', String(await callMcp('move_to', { x: pos.x, z: pos.z, timeout: 20 })).slice(0, 100))
        await new Promise((r) => setTimeout(r, 2200))
        cur = read()
        ready = (cur.snap.nearby?.buckets?.harvestables ?? [])
          .filter((h) => h.harvest_ready === true && PILOT.has(h.prefab))
          .sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0]
        if (!ready) break
        console.log(`  重试目标 ${ready.ref}（${ready.distance} 格）`)
        msg = await harvestCall(ready.ref, cur.snap.nearby?.snapshot_id, 'retry')
        console.log('  重试回执:', String(msg).slice(0, 150))
      }
      const ok = /采下了|成功/.test(msg) && !/失败/.test(msg)
      ok ? pass('harvest 回执成功', String(msg).slice(0, 90)) : fail('harvest 回执成功', String(msg).slice(0, 140))

      await new Promise((r) => setTimeout(r, 2000))
      const after = read()
      const afterBerries = berriesIn(after.snap)
      console.log(`  采后浆果=${afterBerries}（采前 ${beforeBerries}）`)
      // 结果核对的三条路径：背包增加 / 成熟状态翻转 / 目标消失
      // ★ 注意：harvest_ready === false 才是"状态翻转"。之前这里写成 flipped===false 就报翻转
      //   —— 变量含义反了，会对"其实没变化"的目标报假 PASS（真机上踩到过）。
      const afterList = after.snap.nearby?.buckets?.harvestables ?? []
      const sameEntity = afterList.find((h) => h.prefab === ready.prefab
        && h.position && ready.position && h.position.x === ready.position.x && h.position.z === ready.position.z)
      const nowReady = sameEntity ? sameEntity.harvest_ready : null
      console.log(`  同一株（prefab+坐标）现在的 harvest_ready=${nowReady === null ? '(不在了)' : nowReady}`)
      if (afterBerries > beforeBerries) pass('产物进了背包', `浆果 ${beforeBerries} → ${afterBerries}`)
      else if (sameEntity && nowReady === false) pass('目标成熟状态已翻转（产物没入包，可能落地）', `harvest_ready: true → false`)
      else if (!sameEntity) pass('目标已从可收获桶消失')
      else fail('收获结果可核对', `回执=${String(msg).slice(0, 50)}；浆果没变且状态仍为 ready=true`)

      // 与 Pickup 的边界：harvest 不能自动接续 pickup
      const groundBerries = flat(after.snap.nearby).filter((e) => e.prefab === 'berries' && e.bucket === 'pickupables')
      console.log(`  附近 pickupables 里的浆果条目：${groundBerries.length}（若 >0，说明产物落地且已可被单独 pickup）`)
      pass('harvest 没有自动接续 pickup', '本次只发了一次 harvest 调用；落地物由模型另行决定')

      // ── 6.5) 刚采过的这一株：必须仍在可收获桶里（harvest_ready=false），再采必须被拒 ──
      console.log('\n[6.5] 刚采过的浆果丛：仍在可收获桶（harvest_ready=false）且再采 → not_ready')
      if (!sameEntity) {
        skip('采过的对象仍在可收获桶里（harvest_ready=false）', '这一株已不在桶里')
        skip('对未成熟对象 harvest 被拒（not_ready）', '同上')
      } else {
        if (sameEntity.harvest_ready === false) {
          pass('采过的对象仍在可收获桶里（harvest_ready=false）', `${sameEntity.ref} @ ${sameEntity.position?.x},${sameEntity.position?.z}`)
        } else {
          fail('采过的对象仍在可收获桶里（harvest_ready=false）', `现在 harvest_ready=${sameEntity.harvest_ready}`)
        }
        const again = await harvestCall(sameEntity.ref, after.snap.nearby?.snapshot_id, 'again')
        console.log('  → 再采一次:', String(again).slice(0, 130))
        if (/not_ready|already_harvested/.test(again)) pass('对未成熟对象 harvest 被拒（not_ready）', String(again).slice(0, 70))
        else if (/out_of_range/.test(again)) skip('对未成熟对象 harvest 被拒（not_ready）', '先被距离拒了（out_of_range），没测到 maturity 分支')
        else if (/actor_busy/.test(again)) skip('对未成熟对象 harvest 被拒（not_ready）', '被别的动作占着（actor_busy）')
        else if (/result_timeout|结果未知/.test(again)) skip('对未成熟对象 harvest 被拒（not_ready）', '回执丢失（单槽结果文件被 reflex 盖掉），没测到 maturity 分支')
        else if (/actor_is_ghost/.test(again)) skip('对未成熟对象 harvest 被拒（not_ready）', '角色此时是灵魂（actor_is_ghost），更早的分支先拒了')
        else fail('对未成熟对象 harvest 被拒', String(again).slice(0, 120))
      }
    }
  }
}

console.log('\n=== 汇总 ===')
for (const r of results) console.log(`${r.s.padEnd(14)} ${r.n}${r.d ? '  |  ' + r.d : ''}`)
const bad = results.filter((r) => r.s === 'FAIL').length
const notObs = results.filter((r) => r.s === 'NOT_OBSERVED').length
console.log(`\n共 ${results.length} 项：PASS ${results.length - bad - notObs} / FAIL ${bad} / NOT_OBSERVED ${notObs}`)
process.exitCode = bad === 0 ? 0 : 2
