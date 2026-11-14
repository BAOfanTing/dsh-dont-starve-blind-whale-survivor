// S9：背包 items 的两种 JSON 形状都必须能数对
//
// 真机 Cluster_1 #26 craft torch：
//   回执写着「做好了 火把（torch+1）（cutgrass-2，twigs-2）（背包：cutgrass-2，torch+1，twigs-2）」
//   —— Lua 侧自己的差异核对算出了 torch+1，Node 侧却判 craft_not_in_inventory。
// 根因：Lua 把空表序列化成 {}（对象），countInInventory 里 `!Array.isArray → return 0` 直接放弃。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTION_SPECS, inventoryItems } from '../lib/dispatcher.js'

const snap = (items, equipment) => ({
  player: { inventory: { items }, ...(equipment ? { equipment } : {}) },
})

test('S9-1：inventoryItems 同时接受数组和对象', () => {
  assert.deepEqual(inventoryItems(snap([])), [])
  assert.deepEqual(inventoryItems(snap({})), [])
  assert.equal(inventoryItems(snap([{ prefab: 'log', count: 2 }])).length, 1)
  assert.equal(inventoryItems(snap({ a: { prefab: 'log', count: 2 } })).length, 1)
  // 异常输入不崩
  assert.deepEqual(inventoryItems(null), [])
  assert.deepEqual(inventoryItems(snap(null)), [])
  assert.deepEqual(inventoryItems(snap('oops')), [])
})

test('S9-2：craft 核对在"对象形状"的背包上也能认出成品（真机 bug 的复现）', () => {
  const spec = ACTION_SPECS.craft
  // ① 对象形状：做之前是 {}，做之后多了 torch
  const v1 = spec.verify(snap({}), snap({ t: { prefab: 'torch', count: 1 } }), { recipe: 'torch' })
  assert.equal(v1.ok, true, '对象形状的背包必须能数出 torch')
  assert.equal(v1.made, 1)

  // ② 数组形状（原来就支持，别改坏）
  const v2 = spec.verify(
    snap([{ prefab: 'cutgrass', count: 2 }]),
    snap([{ prefab: 'cutgrass', count: 2 }, { prefab: 'torch', count: 1 }]),
    { recipe: 'torch' },
  )
  assert.equal(v2.ok, true)
  assert.equal(v2.made, 1)
})

test('S9-3：修了形状也不许放松 —— 没做出来仍然判失败', () => {
  const spec = ACTION_SPECS.craft
  const same = snap({ c: { prefab: 'cutgrass', count: 2 } })
  const v = spec.verify(same, same, { recipe: 'torch' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'craft_not_in_inventory')
  // 材料被扣了、但成品没出现 → 也必须判失败（不能因为"有变化"就说成功）
  const v2 = spec.verify(snap({ c: { prefab: 'cutgrass', count: 2 } }), snap({}), { recipe: 'torch' })
  assert.equal(v2.ok, false, '材料没了、成品也没有，不能算成功')
})

test('S9-4：其它依赖背包数量的核对也要吃两种形状（gather/pickup/fuel/drop）', () => {
  const flint = { ref: '#1', prefab: 'flint', position: { x: 5, z: 5 } }
  const withTree = (items) => ({
    player: { inventory: { items } },
    nearby: { buckets: { resources: [], pickupables: [flint] } },
  })

  // gather_area：对象形状下数出产物
  const ga = ACTION_SPECS.gather_area
  const v1 = ga.verify(withTree({}), withTree({ a: { prefab: 'cutgrass', count: 3 } }))
  assert.equal(v1.ok, true, '对象形状也要能认出产物')
  assert.equal(v1.gained, 3)

  // pickup：对象形状
  const pk = ACTION_SPECS.pickup
  const v2 = pk.verify(withTree({}), withTree({ b: { prefab: 'flint', count: 1 } }), { target_ref: '#1' })
  assert.equal(v2.ok, true, 'pickup 也要吃对象形状')

  // drop：对象形状下数量减少
  const dr = ACTION_SPECS.drop
  const v3 = dr.verify(withTree({ x: { prefab: 'twigs', count: 5 } }), withTree({ x: { prefab: 'twigs', count: 4 } }), { item: 'twigs' })
  assert.equal(v3.ok, true)
  assert.equal(v3.used, 1)
})
