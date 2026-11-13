// M2.2.2 / P1：Nearby 快照 ID 的可见性
//
// 背景（AGENT-01 真机抓到）：get_state 文本第一行是「状态快照序列号 s1650」，
// 而 pickup/harvest 要的是 nearby 的扫描 id（r…-n365）。文本里从来只出现前者，
// 于是真实模型照抄 s1650 → 必然 stale_snapshot。
//
// 这些测试从**真实构造的 snapshot 对象**出发检查最终输出，不靠硬编码整段文本。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeState, renderFallbackText, nearbyLines, toJsonPayload } from '../lib/state/snapshot.js'
import { TOOLS } from '../lib/tools.js'

const SEQ_ID = 's1650'
const NEARBY_ID = 'r1794565044-5047-n365'

/** 造一份真实形状的状态文件（observer 给状态序列号，nearby 给自己的扫描 id） */
function makeState({ nearbyId = NEARBY_ID, nearbyStatus = 'ok', withItems = true } = {}) {
  return {
    ok: true,
    status: 'ok',
    seq: 1650,
    mod: '0.17.2',
    data: {
      schema: 'bws.state/1',
      identity: { session_id: 'S1', shard_id: '1' },
      observer: {
        snapshot_id: SEQ_ID, sequence: 1650, status: 'ok',
        timestamp: 1, sampled_at: 1, sample_age_ms: 0,
      },
      actor: {
        valid: true, actor_id: 'player:X', actor_type: 'player', prefab: 'wolfgang',
        name: '沃尔夫冈', alive: true, is_ghost: false,
        tile_x: -22, tile_z: 32, x: -88, y: 0, z: 128,
      },
      player: {
        inventory: { used: 0, items: {}, slots: 15, is_full: false },
        health: { current: 150, max: 200, percent: 75 },
        hunger: { current: 100, max: 200, percent: 50 },
        sanity: { current: 120, max: 200, percent: 60 },
      },
      world: { day: 3, phase: 'day', phase_name: '白天', season_name: '秋季', status: 'ok', world_temperature: 22 },
      nearby: {
        status: nearbyStatus,
        snapshot_id: nearbyStatus === 'error' ? undefined : nearbyId,
        radius: 16,
        max_total: 60,
        max_per_bucket: 12,
        total_found: withItems ? 3 : 0,
        total_returned: withItems ? 3 : 0,
        truncated: false,
        scan: { reused: false, age_ms: 0 },
        buckets: withItems
          ? {
              threats: [],
              pickupables: [{ ref: '#1', prefab: 'flint', label: '燧石', position: { x: -20, z: 30 }, distance: 2.1, item_kind: 'resources' }],
              harvestables: [{ ref: '#2', prefab: 'berrybush', label: '浆果丛', position: { x: -19, z: 31 }, distance: 3.4, harvest_ready: true, is_harvestable: true }],
              food: [],
              resources: [],
              containers: [],
              structures: [],
              creatures: [],
              other: [],
            }
          : {},
        delta: { status: 'ok', added: [], removed: [], changed: [] },
      },
    },
  }
}

const render = (state) => {
  const snap = normalizeState(state, { ageMs: 0 })
  // 走产品真实路径：有 Lua 文本就用 Lua 的，没有才用 Node 兜底。
  // 这里没有 text，所以走 renderFallbackText（Node 兜底渲染）。
  return { snap, text: snap.text || renderFallbackText(snap) }
}

test('P1-1：get_state 文本里必须出现真实的 nearby.snapshot_id', () => {
  const { snap, text } = render(makeState())
  assert.equal(snap.nearby?.snapshot_id, NEARBY_ID, '归一化后应保留 nearby 的扫描 id')
  assert.ok(text.includes(NEARBY_ID), `文本里没出现 nearby.snapshot_id：\n${text}`)
})

test('P1-2：状态序列号和 Nearby 快照 ID 的标签必须明确不同', () => {
  const { text } = render(makeState())
  assert.ok(text.includes('状态快照序列号'), '应该有「状态快照序列号」这个标签')
  assert.ok(text.includes(SEQ_ID), '应该出现状态序列号本身')
  assert.ok(text.includes('Nearby 快照 ID'), '应该有「Nearby 快照 ID」这个标签')
  // 两个标签不能是同一个说法
  assert.notEqual(text.indexOf('状态快照序列号'), text.indexOf('Nearby 快照 ID'))
})

test('P1-3：#N 目标与 nearby.snapshot_id 属于同一份快照（引用行紧跟在 id 之后）', () => {
  const { snap, text } = render(makeState())
  const refs = [...(snap.nearby?.buckets?.pickupables ?? []), ...(snap.nearby?.buckets?.harvestables ?? [])].map((i) => i.ref)
  assert.deepEqual(refs.sort(), ['#1', '#2'])
  for (const ref of refs) assert.ok(text.includes(ref), `文本里应该有 ${ref}`)
  // 「以上 #N 引用属于 Nearby 快照 ID」这行必须同时点出 id，且出现在桶之后
  const marker = text.indexOf('以上 #N 引用属于 Nearby 快照 ID')
  assert.ok(marker > 0, '应该有一行说明这些 #N 属于哪份快照')
  assert.ok(text.slice(marker).includes(NEARBY_ID), '说明行里必须带 id')
  assert.ok(marker > text.indexOf('#1 '), '说明行要在引用之后')
})

test('P1-4：目标更新（新扫描）后输出新的 id，旧 id 不再出现', () => {
  const old = render(makeState({ nearbyId: 'r1-0001-n5' }))
  assert.ok(old.text.includes('r1-0001-n5'))
  const fresh = render(makeState({ nearbyId: 'r1-0001-n6' }))
  assert.ok(fresh.text.includes('r1-0001-n6'), '应该出现新 id')
  assert.ok(!fresh.text.includes('r1-0001-n5'), '不该残留旧 id')
})

test('P1-5：Nearby 不可用（error）时不输出任何历史 id', () => {
  const { text } = render(makeState({ nearbyStatus: 'error', withItems: false }))
  assert.ok(/暂时读不到/.test(text), '应该明确说读不到')
  assert.ok(!text.includes(NEARBY_ID), 'error 时绝不能回显历史 id')
  assert.ok(!/Nearby 快照 ID/.test(text), 'error 时不该出现 Nearby 快照 ID 标签')
})

test('P1-6：pickup 的 snapshot_id 说明必须点明"不是状态序列号"', () => {
  const tool = TOOLS.find((t) => t.name === 'pickup')
  assert.ok(tool, '缺 pickup 工具')
  const desc = String(tool.inputSchema?.properties?.snapshot_id?.description ?? '')
  assert.ok(desc.includes('Nearby 快照 ID'), '要说明填的是 Nearby 快照 ID')
  assert.ok(desc.includes('状态快照序列号'), '要提醒别填状态快照序列号')
  assert.ok(/stale_snapshot/.test(desc), '要说明填错的后果')
  assert.deepEqual(tool.inputSchema.required, ['target_ref', 'snapshot_id'], '必填项不变')
})

test('P1-7：harvest 的 snapshot_id 说明必须点明"不是状态序列号"', () => {
  const tool = TOOLS.find((t) => t.name === 'harvest')
  assert.ok(tool, '缺 harvest 工具')
  const desc = String(tool.inputSchema?.properties?.snapshot_id?.description ?? '')
  assert.ok(desc.includes('Nearby 快照 ID'), '要说明填的是 Nearby 快照 ID')
  assert.ok(desc.includes('状态快照序列号'), '要提醒别填状态快照序列号')
  assert.ok(/stale_snapshot/.test(desc), '要说明填错的后果')
  assert.deepEqual(tool.inputSchema.required, ['target_ref', 'snapshot_id'], '必填项不变')
})

test('P1-8：旧的状态序列号不能被当成 nearby.snapshot_id（JSON 里两个字段分开）', () => {
  const { snap } = render(makeState())
  const payload = toJsonPayload(snap)
  assert.equal(payload.snapshot_id, SEQ_ID, '顶层 snapshot_id 仍是状态序列号')
  assert.equal(payload.nearby?.snapshot_id, NEARBY_ID, 'nearby.snapshot_id 是扫描 id')
  assert.notEqual(payload.snapshot_id, payload.nearby?.snapshot_id, '两个 id 必须不同')
})

test('P1-9：nearbyLines 在无 id 时不伪造 id（防御）', () => {
  const lines = nearbyLines({
    status: 'ok', radius: 16, total_found: 1, total_returned: 1, truncated: false,
    buckets: { pickupables: [{ ref: '#1', prefab: 'flint', label: '燧石', position: { x: 0, z: 0 }, distance: 1 }] },
  })
  const joined = lines.join('\n')
  assert.ok(!/Nearby 快照 ID/.test(joined), '没有 id 就不该编一个出来')
  assert.ok(joined.includes('#1'), '但引用要照常显示')
})
