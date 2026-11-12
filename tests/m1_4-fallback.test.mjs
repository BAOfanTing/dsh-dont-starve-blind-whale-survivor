// M1.4 收尾：Node fallback 文本对 nearby 的渲染（新旧结构都要能读）
//
// 背景：Lua 原生 text 缺失/被截断时，Node 的 renderFallbackText 以前完全不输出 nearby。
// 0.13.4 起补上；仍然只读快照、不重新扫描、不重新编号、不重算 Delta。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeState,
  nearbyLines,
  renderFallbackText,
  toJsonPayload,
  STATE_SCHEMA,
} from '../lib/state/snapshot.js'

const baseData = () => ({
  schema: STATE_SCHEMA,
  identity: { session_id: 'sess', cluster_id: null, cluster_id_source: 'unavailable', shard_id: '1' },
  actor: {
    actor_id: 'player:KU_x', actor_id_kind: 'stable', actor_type: 'player', prefab: 'warly',
    name: '沃利', valid: true, alive: true, is_ghost: false, missing_components: [], tile_x: 0, tile_z: 0,
  },
  player: { inventory: { slots: 15, used: 0, items: [] } },
  world: { day: 1 },
  warnings: [],
  observer: { snapshot_id: 's1', sequence: 1, timestamp: 1, sampled_at: 1, sample_age_ms: 0,
              reused: false, status: 'ok', errors: [], unavailable_fields: [] },
})

const snapOf = (nearby, { text = '' } = {}) =>
  normalizeState(
    { v: 1, seq: 1, t: 1, mod: '0.13.4', ready: true, text, data: { ...baseData(), nearby } },
    { ageMs: 100 },
  )

const newNearby = (over = {}) => ({
  status: 'ok',
  schema: 'bws.nearby/1',
  runtime_id: 'r1-0001',
  snapshot_id: 'r1-0001-n5',
  radius: 16,
  scan_seconds: 4,
  max_total: 60,
  max_per_bucket: 12,
  total_found: 157,
  total_returned: 3,
  truncated: true,
  scan: { reused: false, timestamp: 1, age_ms: 0, duration_ms: 0.7, duration_source: 'os.clock' },
  buckets: {
    threats: [{ ref: '#1', prefab: 'frog', category: 'threats', label: '青蛙', distance: 1.2,
                position: { x: 1, z: 0 }, health: 25, max_health: 25 }],
    food: [],
    resources: [{ ref: '#2', prefab: 'evergreen', category: 'resources', label: '常青树', distance: 3.4,
                  position: { x: 3, z: 1 }, work_action: 'CHOP' }],
    containers: [],
    structures: [{ ref: '#3', prefab: 'pumpkin_lantern', category: 'structures', label: '南瓜灯', distance: 2 }],
    creatures: [],
    other: [],
  },
  delta: {
    status: 'ok', added_count: 1, removed_count: 1, changed_count: 1,
    added: [{ ref: '#2', prefab: 'evergreen', label: '常青树', category: 'resources' }],
    removed: [{ previous_ref: '#9', prefab: 'twiggytree', label: '多枝树', category: 'resources' }],
    changed: [{ ref: '#1', prefab: 'frog', label: '青蛙', category: 'threats',
                fields: { health: { from: 30, to: 25 } } }],
    not_returned_count: 154,
    not_returned: [{ prefab: 'grass', category: 'resources', distance: 9.1 }],
  },
  ...over,
})

test('fallback-1 新版对象结构：状态/半径/总数/截断/桶/#N/Delta/未列出 都要有', () => {
  const text = renderFallbackText(snapOf(newNearby()))
  assert.match(text, /附近（16 格内，只显示 3\/157 个）：/)
  assert.match(text, /威胁：#1 青蛙/)
  assert.match(text, /资源：#2 常青树 .*可CHOP/)
  assert.match(text, /建筑：#3 南瓜灯/)
  assert.match(text, /变化：新出现 #2 常青树；消失 1 个（多枝树）；变化 #1 青蛙/)
  assert.match(text, /未列出 154 个/)
})

test('fallback-2 旧版数组结构（M1.1）：也能渲染，且不伪造 #N', () => {
  const legacyNearby = {
    status: 'legacy',
    radius: 12,
    scan_seconds: 4,
    buckets: [
      { kind: 'hostile', label: '敌人', total: 1, shown: 1, truncated: false,
        items: [{ prefab: 'spider', name: '蜘蛛', tile_x: 2, tile_z: 3, dist: 2.5 }] },
    ],
  }
  const text = renderFallbackText(snapOf(legacyNearby))
  assert.match(text, /附近（12 格内）：/)
  assert.match(text, /敌人：蜘蛛 \(2,3\) 距2\.5/)
  assert.doesNotMatch(text, /#1/, '老结构没有引用，不能凭空造 #N')
})

test('fallback-3 empty：说"没什么值得注意的"，不能说"读不到"', () => {
  const text = renderFallbackText(snapOf(newNearby({
    status: 'empty', total_found: 0, total_returned: 0, truncated: false,
    buckets: { threats: [], food: [], resources: [], containers: [], structures: [], creatures: [], other: [] },
    delta: { status: 'baseline', added_count: 0, removed_count: 0, changed_count: 0, added: [], removed: [], changed: [] },
  })))
  assert.match(text, /没什么值得注意的/)
  assert.doesNotMatch(text, /读不到/)
})

test('fallback-4 error：明确说读不到 + 原因', () => {
  const text = renderFallbackText(snapOf(newNearby({
    status: 'error', error: 'find_entities_failed', buckets: {}, total_found: 0, total_returned: 0, truncated: false,
  })))
  assert.match(text, /暂时读不到（扫描出错：find_entities_failed）/)
})

test('fallback-5 缺失 nearby：不输出附近段（也不报错）', () => {
  const snapshot = snapOf(undefined)
  assert.equal(snapshot.nearby, null)
  const text = renderFallbackText(snapshot)
  assert.doesNotMatch(text, /附近/)
  assert.ok(text.includes('沃利'), '其它内容照常')
})

test('fallback-6 桶内容带 #N 且与 JSON 一致；previous_ref 不当当前引用', () => {
  const snapshot = snapOf(newNearby())
  const payload = toJsonPayload(snapshot)
  const refsInJson = Object.values(payload.nearby.buckets).flat().map((x) => x.ref)
  const text = nearbyLines(snapshot.nearby).join('\n')
  for (const ref of refsInJson) assert.ok(text.includes(ref), `文本里应出现 ${ref}`)
  assert.match(text, /消失 1 个（多枝树）/, '消失项只用名字，不把 previous_ref 当当前引用')
  assert.doesNotMatch(text, /#9 /, 'previous_ref 不该作为可操作引用出现')
})

test('fallback-7 not_returned 不当作可操作目标', () => {
  const text = nearbyLines(newNearby()).join('\n')
  assert.match(text, /未列出 154 个/, '只报数量')
  assert.doesNotMatch(text, /草\s*#/, '未返回实体没有引用')
})

test('fallback-8 Node 不改 Delta、不重算：渲染内容与快照字段一一对应', () => {
  const nearby = newNearby()
  const snapshot = snapOf(nearby)
  const before = JSON.stringify(snapshot.nearby)
  nearbyLines(snapshot.nearby)
  assert.equal(JSON.stringify(snapshot.nearby), before, '渲染不能改动快照对象')
  assert.equal(snapshot.nearby.delta.removed_count, 1, 'Delta 原样保留')
})

test('fallback-9 Lua text 存在时优先用 Lua 的（fallback 不覆盖）', () => {
  const snapshot = snapOf(newNearby(), { text: '# 快照 s1 · Lua 自己渲染的文本' })
  const viaTool = snapshot.text
  assert.match(viaTool, /Lua 自己渲染/)
  const fallback = renderFallbackText(snapshot)
  assert.doesNotMatch(fallback, /Lua 自己渲染/, 'fallback 是另一条路径，不读 text 字段')
})

test('fallback-10 legacy 状态文件（无 schema）仍能读，不炸', () => {
  const snapshot = normalizeState(
    { v: 1, seq: 3, t: 1, mod: '0.10.0', ready: true, text: '# 旧格式\n你：沃利', data: {} },
    { ageMs: 99999 },
  )
  assert.equal(snapshot.schema, 'legacy')
  assert.equal(snapshot.stale, true)
  const text = renderFallbackText(snapshot)
  assert.ok(text.length > 0)
  assert.doesNotMatch(text, /附近/) // 老文件没有 nearby，不编
})
