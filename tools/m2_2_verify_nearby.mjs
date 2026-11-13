// M2.2 真机验证：pickupables 桶 / 食物分类修复 / 优先级 / 引用 / Delta / Pickup 回归
//
// 只读为主；加 --pickup 才会真的执行一次拾取（回归 M2.1 闭环）。
// 证据类型：RUNTIME（真实 DST）。任何一项没观察到就报 NOT_OBSERVED，不冒充通过。
import { GameBridge } from '../lib/bridge.js'
import { normalizeState } from '../lib/state/snapshot.js'

const ARGS = process.argv.slice(2)
const DO_PICKUP = ARGS.includes('--pickup')
const BRIDGE_DIR = (() => {
  const i = ARGS.indexOf('--bridgeDir')
  return i >= 0 ? ARGS[i + 1] : null
})()

const WHITELIST = new Set(['twigs', 'cutgrass', 'flint'])
const results = []
const pass = (n, d) => { results.push({ n, s: 'PASS', d }); console.log(`  ✅ ${n}${d ? ' — ' + d : ''}`) }
const fail = (n, d) => { results.push({ n, s: 'FAIL', d }); console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`) }
const skip = (n, d) => { results.push({ n, s: 'NOT_OBSERVED', d }); console.log(`  ⚠️  ${n}${d ? ' — ' + d : ''}`) }

const bridge = new GameBridge({ log: () => {} })
function read() {
  let st
  if (BRIDGE_DIR) {
    const prev = process.env.BWS_BRIDGE_DIR
    process.env.BWS_BRIDGE_DIR = BRIDGE_DIR
    try { st = bridge.readState() } finally { if (prev === undefined) delete process.env.BWS_BRIDGE_DIR; else process.env.BWS_BRIDGE_DIR = prev }
  } else {
    st = bridge.readState()
  }
  if (!st) return null
  return { raw: st.json, snap: normalizeState(st.json, { ageMs: st.ageMs }), ageMs: st.ageMs }
}

const flat = (nearby) => {
  const out = []
  for (const [k, list] of Object.entries(nearby?.buckets ?? {})) for (const it of list ?? []) out.push({ ...it, bucket: k })
  return out
}
const bucketOf = (nearby, prefab) => flat(nearby).filter((e) => e.prefab === prefab).map((e) => e.bucket)

console.log('=== M2.2 真机验证 ===')
const first = read()
if (!first) { console.log('BLOCKED: 读不到状态文件（游戏没开或还没进世界）'); process.exit(3) }
const { raw, snap } = first
const nearby = snap.nearby ?? {}
console.log(`mod=${raw.mod} | 年龄=${Math.round(first.ageMs / 1000)}s | snapshot=${nearby.snapshot_id}`)
if (raw.mod !== '0.16.0') {
  console.log(`⚠️  世界内存版本是 ${raw.mod}，不是 0.16.0 —— Lua 还没重载，pickupables 不会出现`)
}

// ── 1) 桶结构 ──
console.log('\n[1] 桶结构')
const keys = Object.keys(nearby.buckets ?? {})
console.log('  桶:', keys.join(', '))
if (!keys.includes('pickupables')) {
  fail('pickupables 桶存在', `世界内存 ${raw.mod}，需要重进世界加载 0.16.0`)
} else {
  pass('pickupables 桶存在')
  const expect = ['threats', 'pickupables', 'food', 'resources', 'containers', 'structures', 'creatures', 'other']
  const same = expect.every((k, i) => keys[i] === k)
  same ? pass('八桶顺序与设计一致', keys.join(' → ')) : fail('八桶顺序与设计一致', keys.join(' → '))
  const all = flat(nearby).map((e) => e.ref)
  new Set(all).size === all.length ? pass('ref 全局唯一', `${all.length} 个`) : fail('ref 全局唯一')
  const dupBucket = Object.entries(nearby.buckets).find(([, l]) => {
    const refs = (l ?? []).map((i) => i.ref)
    return new Set(refs).size !== refs.length
  })
  dupBucket ? fail('同一实体不重复跨桶', dupBucket[0]) : pass('同一实体不重复跨桶')
}

// ── 2) 白名单物品是否进了 pickupables ──
console.log('\n[2] 可拾取物可见性（M2.2 的核心目标）')
const picks = nearby.buckets?.pickupables ?? []
const seenWhitelist = [...new Set(flat(nearby).filter((e) => WHITELIST.has(e.prefab)).map((e) => e.prefab))]
console.log('  附近白名单物品:', seenWhitelist.join(', ') || '(没有)')
console.log('  pickupables:', JSON.stringify(picks.map((p) => ({ ref: p.ref, prefab: p.prefab, item_kind: p.item_kind, d: p.distance }))))
if (keys.includes('pickupables')) {
  if (seenWhitelist.length === 0) {
    skip('白名单物品进入 pickupables', '附近本来就没有树枝/割草/燧石，无法观察')
  } else {
    const allIn = seenWhitelist.every((p) => bucketOf(nearby, p).includes('pickupables'))
    allIn ? pass('附近的白名单物品都进了 pickupables', seenWhitelist.join(', '))
          : fail('附近的白名单物品都进了 pickupables', JSON.stringify(seenWhitelist.map((p) => [p, bucketOf(nearby, p)])))
    const wrong = seenWhitelist.filter((p) => bucketOf(nearby, p).some((b) => b !== 'pickupables'))
    wrong.length === 0 ? pass('白名单物品没有同时出现在别的桶', '')
                       : fail('白名单物品没有同时出现在别的桶', JSON.stringify(wrong))
    const withKind = picks.filter((p) => typeof p.item_kind === 'string')
    picks.length === 0 ? skip('item_kind 语义字段存在')
      : (withKind.length === picks.length ? pass('item_kind 语义字段存在', JSON.stringify([...new Set(picks.map((p) => p.item_kind))]))
                                          : fail('item_kind 语义字段存在', `${withKind.length}/${picks.length}`))
  }
}

// ── 3) flint 不再进 food ──
console.log('\n[3] 食物分类修复')
if (keys.includes('pickupables')) {
  const flintBuckets = bucketOf(nearby, 'flint')
  if (flintBuckets.length === 0) skip('flint 不在 food', '附近没有燧石，无法观察')
  else if (flintBuckets.includes('food')) fail('flint 不在 food', JSON.stringify(flintBuckets))
  else pass('flint 不在 food', 'flint 在 ' + JSON.stringify(flintBuckets))
  const foodPrefabs = (nearby.buckets?.food ?? []).map((f) => f.prefab)
  foodPrefabs.length === 0 ? skip('food 桶仍能识别真食物', '附近食物桶为空')
    : pass('food 桶仍能识别真食物', foodPrefabs.join(', '))
} else {
  skip('flint 不在 food', '需要 0.16.0')
}

// ── 4) 优先级：可拾取物是否被环境实体挤掉 ──
console.log('\n[4] 优先级 / 截断')
console.log(`  total_found=${nearby.total_found} total_returned=${nearby.total_returned} truncated=${nearby.truncated} not_returned=${nearby.delta?.not_returned_count}`)
console.log('  各桶数量:', JSON.stringify(Object.fromEntries(Object.entries(nearby.buckets ?? {}).map(([k, v]) => [k, (v ?? []).length]))))
if (keys.includes('pickupables') && picks.length > 0 && nearby.truncated === true) {
  pass('桶被截断时可拾取物仍然拿到了 #N', `pickupables=${picks.length}，全局只返回 ${nearby.total_returned}/${nearby.total_found}`)
} else if (keys.includes('pickupables') && picks.length > 0) {
  pass('可拾取物拿到了 #N', `pickupables=${picks.length}（本次没截断）`)
} else {
  skip('桶被截断时可拾取物仍然拿到了 #N', '要么没有可拾取物，要么没截断')
}
const maxPer = nearby.max_per_bucket ?? 12
const fullish = Object.entries(nearby.buckets ?? {}).filter(([, l]) => (l ?? []).length >= maxPer).map(([k]) => k)
if (fullish.length > 0) pass('单桶上限生效', `这些桶已达 ${maxPer}：${fullish.join(', ')}`)
else skip('单桶上限生效', '没有桶达到上限')

// ── 5) 性能 ──
console.log('\n[5] 性能（单次扫描口径）')
const scan = nearby.scan ?? {}
const jsonBytes = Buffer.byteLength(JSON.stringify(nearby), 'utf8')
console.log(`  scan.duration_ms=${scan.duration_ms} (${scan.duration_source}) | reused=${scan.reused} | nearby JSON=${jsonBytes} 字节`)
scan.duration_ms !== null && scan.duration_ms !== undefined
  ? pass('扫描耗时可用', `${scan.duration_ms}ms / ${scan.duration_source}`)
  : skip('扫描耗时可用', '这一帧没取到可信耗时')

// ── 6) Pickup 回归（可选，会真的执行） ──
console.log('\n[6] Pickup 回归')
if (!DO_PICKUP) {
  skip('pickup 仍能拾取 pickupables 里的目标', '没加 --pickup（不会擅自执行动作）')
} else if (picks.length === 0) {
  skip('pickup 仍能拾取 pickupables 里的目标', '没有可拾取物')
} else {
  const target = picks.slice().sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0]
  if ((target.distance ?? 99) > 2.5) {
    skip('pickup 仍能拾取 pickupables 里的目标', `最近的目标在 ${target.distance} 格，超出执行距离（先用 move_to）`)
  } else {
    console.log(`  → 对 ${target.ref} ${target.prefab}（${target.distance} 格）执行 pickup`)
    const r = await fetch('http://127.0.0.1:18090/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pickup', arguments: { target_ref: target.ref, snapshot_id: nearby.snapshot_id } } }),
    })
    const text = await r.text()
    const raw2 = text.includes('data:') ? text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('') : text
    const body = JSON.parse(raw2)
    const msg = (body.result?.content ?? []).map((c) => c.text).join('\n')
    console.log('  回执:', String(msg).slice(0, 160))
    /捡起了|成功/.test(msg) && !/失败/.test(msg)
      ? pass('pickup 仍能拾取 pickupables 里的目标', String(msg).slice(0, 80))
      : fail('pickup 仍能拾取 pickupables 里的目标', String(msg).slice(0, 120))
  }
}

console.log('\n=== 汇总 ===')
for (const r of results) console.log(`${r.s.padEnd(14)} ${r.n}${r.d ? '  |  ' + r.d : ''}`)
const bad = results.filter((r) => r.s === 'FAIL').length
const notObs = results.filter((r) => r.s === 'NOT_OBSERVED').length
console.log(`\n共 ${results.length} 项：PASS ${results.length - bad - notObs} / FAIL ${bad} / NOT_OBSERVED ${notObs}`)
process.exit(bad === 0 ? 0 : 2)
