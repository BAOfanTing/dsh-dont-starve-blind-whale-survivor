// S10：装备栏两种 JSON 形状都必须能读（真机 craft torch 的第二个坑）
//
// 真机 Cluster_1 复测：
//   → 背包 cutgrass×1,twigs×8 | 手持 torch      ← 火把确实在手上
//   但回执仍说「没核对上（craft_not_in_inventory）」
// 实际形状（状态文件里同时存在）：
//   "slots": { "hands": { "prefab": "torch", ... } }                    ← 对象
//   "worn":  [ { "key": "hands", "item": { "prefab": "torch" } } ]      ← 数组
// 原来只读 worn.hands（在数组上取 key）→ 永远 null。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTION_SPECS, handItem } from '../lib/dispatcher.js'

const snap = (equipment, items = {}) => ({ player: { inventory: { items }, ...(equipment ? { equipment } : {}) } })

const REAL = {
  slots: { hands: { slot_key: 'hands', name: '火炬', percent: 87, prefab: 'torch', count: 1 } },
  worn: [{ item: { slot_key: 'hands', name: '火炬', prefab: 'torch', count: 1 }, key: 'hands', label: '手持' }],
}

test('S10-1：handItem 认得真机那种"slots 对象 + worn 数组"的形状', () => {
  assert.equal(handItem(snap(REAL)), 'torch', '真机形状必须读出 torch')
  // 只有一种形状也要认（不同版本可能只写一边）
  assert.equal(handItem(snap({ slots: { hands: { prefab: 'torch' } } })), 'torch')
  assert.equal(handItem(snap({ worn: [{ key: 'hands', item: { prefab: 'torch' } }] })), 'torch')
  assert.equal(handItem(snap({ worn: { hands: 'torch' } })), 'torch', '老的对象形状也要认')
  // 空 / 没有 / 异常
  assert.equal(handItem(snap({ slots: {}, worn: [] })), null)
  assert.equal(handItem(snap(null)), null)
  assert.equal(handItem(null), null)
  // 只认 hands，别把头/身的东西当手持
  assert.equal(handItem(snap({ slots: { head: { prefab: 'footballhat' } } })), null)
  assert.equal(handItem(snap({ worn: [{ key: 'head', item: { prefab: 'footballhat' } }] })), null)
})

test('S10-2：craft 在真机形状下能认出"做好了且自动装备"（bug 复现）', () => {
  const empty = snap({ slots: {}, worn: [] })
  const v = ACTION_SPECS.craft.verify(empty, snap(REAL), { recipe: 'torch' })
  assert.equal(v.ok, true, '做好了并拿在手上必须算成功')
  assert.equal(v.how, 'auto_equipped')
  assert.equal(v.hand, 'torch')
})

test('S10-3：craft 仍不许放松 —— 手上本来就有火把时再"做"不算成功', () => {
  // 做之前手上就是 torch、做之后还是 torch、背包也没多 → 判失败
  const v = ACTION_SPECS.craft.verify(snap(REAL), snap(REAL), { recipe: 'torch' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'craft_not_in_inventory')
})

test('S10-4：unequip 在真机形状下能认出"手上有东西 → 空了"', () => {
  const v = ACTION_SPECS.unequip.verify(snap(REAL), snap({ slots: {}, worn: [] }), { slot: 'hands' })
  assert.equal(v.ok, true)
  assert.equal(v.unequipped, 'torch')
  // 本来空手 → 不判死
  const v2 = ACTION_SPECS.unequip.verify(snap({ slots: {}, worn: [] }), snap({ slots: {}, worn: [] }), { slot: 'hands' })
  assert.equal(v2.ok, true)
  assert.equal(v2.how, 'was_empty')
})

test('S10-5：equip 在真机形状下能认出“已经拿在手里”（不能报 hand_unchanged）', () => {
  const before = snap({ slots: {}, worn: [] })
  const after = snap(REAL)
  const v = ACTION_SPECS.equip.verify(before, after, { item: 'torch' })
  assert.equal(v.ok, true, '真机形状必须读出手持 torch')
  assert.equal(v.hand, 'torch')
})
