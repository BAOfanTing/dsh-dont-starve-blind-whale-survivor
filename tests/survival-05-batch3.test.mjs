// SURVIVAL-05：第三批上半（container_take / container_put / give / cook）
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTION_SPECS, OPEN_ACTIONS, validateArgs } from '../lib/dispatcher.js'
import { TOOLS } from '../lib/tools.js'

const NEW = ['container_take', 'container_put', 'give', 'cook']

test('S5-1：4 个新动作都在白名单里，都有 riskLevel 与 verify', () => {
  for (const name of NEW) {
    assert.ok(OPEN_ACTIONS.includes(name), `${name} 应该在白名单里`)
    const spec = ACTION_SPECS[name]
    assert.ok(spec, `${name} 应该有规格`)
    assert.ok(['R1', 'R2'].includes(spec.riskLevel))
    assert.equal(typeof spec.verify, 'function', `${name} 必须有结果核对`)
    assert.equal(spec.requiresSnapshot, true, `${name} 必须校验快照`)
  }
})

test('S5-2：4 个都要 #N + snapshot_id（拒绝 prefab / GUID / 坐标）', () => {
  for (const name of NEW) {
    const spec = ACTION_SPECS[name]
    assert.ok(spec.args.target_ref && spec.args.snapshot_id, `${name} 要有 target_ref 与 snapshot_id`)
    const base = { target_ref: '#3', snapshot_id: 'r1-n2' }
    if (name === 'container_put' || name === 'give') base.item = 'log'
    assert.equal(validateArgs(spec, base).ok, true, `${name} 合法参数应该通过`)
    assert.equal(validateArgs(spec, { target_ref: '#3' }).ok, false, `${name} 缺 snapshot_id 要拒`)
    assert.equal(validateArgs(spec, { ...base, target_ref: 'chest' }).ok, false, `${name} 不许按 prefab`)
    assert.equal(validateArgs(spec, { ...base, guid: 'x' }).ok, false, `${name} 不许传 GUID`)
  }
})

test('S5-3：container_put / give 必须传 item；container_take 可以不传', () => {
  assert.equal(validateArgs(ACTION_SPECS.container_put, { target_ref: '#1', snapshot_id: 's' }).ok, false, 'container_put 缺 item 要拒')
  assert.equal(validateArgs(ACTION_SPECS.give, { target_ref: '#1', snapshot_id: 's' }).ok, false, 'give 缺 item 要拒')
  assert.equal(validateArgs(ACTION_SPECS.container_take, { target_ref: '#1', snapshot_id: 's' }).ok, true, 'container_take 可以不指定 item')
  assert.equal(validateArgs(ACTION_SPECS.container_take, { target_ref: '#1', snapshot_id: 's', count: 5 }).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.container_take, { target_ref: '#1', snapshot_id: 's', count: 41 }).ok, false, 'count 太大要拒')
})

// ── 核对 ──

const snap = (over = {}) => ({
  player: {
    inventory: {
      items: Object.entries(over.inv ?? {}).map(([prefab, count]) => ({ prefab, count })),
      used: 0,
      slots: 15,
    },
  },
  nearby: { buckets: { structures: over.structures ?? [] } },
})

test('S5-4：container_take 核对 —— 指定物品时看它增加', () => {
  const spec = ACTION_SPECS.container_take
  const before = snap({ inv: { log: 1 } })
  const after = snap({ inv: { log: 4 } })
  const v = spec.verify(before, after, { item: 'log' })
  assert.equal(v.ok, true)
  assert.equal(v.gained, 3)
  assert.equal(v.product, 'log')
})

test('S5-5：container_take 核对 —— 没指定物品时任一种增加都算成功', () => {
  const spec = ACTION_SPECS.container_take
  const before = snap({ inv: { log: 1 } })
  const after = snap({ inv: { log: 1, flint: 2 } })
  const v = spec.verify(before, after, {})
  assert.equal(v.ok, true)
  assert.equal(v.product, 'flint')
})

test('S5-6：container_take 核对 —— 什么都没拿到要判失败', () => {
  const spec = ACTION_SPECS.container_take
  const same = snap({ inv: { log: 1 } })
  const v = spec.verify(same, same, { item: 'log' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'inventory_unchanged')
})

test('S5-7：container_put 核对 —— 背包里该物品减少算成功', () => {
  const spec = ACTION_SPECS.container_put
  const before = snap({ inv: { log: 5 } })
  const after = snap({ inv: { log: 3 } })
  const v = spec.verify(before, after, { item: 'log' })
  assert.equal(v.ok, true)
  assert.equal(v.used, 2)
})

test('S5-8：give 核对 —— 背包里该物品减少算成功；没减少判失败', () => {
  const spec = ACTION_SPECS.give
  const before = snap({ inv: { meat: 3 } })
  const after = snap({ inv: { meat: 2 } })
  assert.equal(spec.verify(before, after, { item: 'meat' }).ok, true)
  const same = spec.verify(before, before, { item: 'meat' })
  assert.equal(same.ok, false)
  assert.equal(same.reason, 'inventory_unchanged')
})

test('S5-9：cook 核对 —— 背包有任何变化就算成功（放材料少 / 拿成品多）', () => {
  const spec = ACTION_SPECS.cook
  // 放材料：meat 少了
  const b1 = snap({ inv: { meat: 4 } })
  const a1 = snap({ inv: { meat: 1 } })
  const v1 = spec.verify(b1, a1, {})
  assert.equal(v1.ok, true)
  assert.equal(v1.product, 'meat')
  assert.equal(v1.gained, -3, '放材料是负数（消耗）')
  // 拿成品：多了个 meatballs
  const b2 = snap({ inv: {} })
  const a2 = snap({ inv: { meatballs: 1 } })
  const v2 = spec.verify(b2, a2, {})
  assert.equal(v2.ok, true)
  assert.equal(v2.product, 'meatballs')
  assert.equal(v2.gained, 1)
})

test('S5-10：cook 核对 —— 背包没变要判失败', () => {
  const spec = ACTION_SPECS.cook
  const same = snap({ inv: { meat: 2 } })
  const v = spec.verify(same, same, {})
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'inventory_unchanged')
})

test('S5-11：4 个工具的描述必须讲清用途与引用方式', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]))
  assert.match(byName.container_take.description, /箱子|冰箱/, 'container_take 要说清是拿容器')
  assert.match(byName.container_take.description, /#N/, 'container_take 要说明用 #N')
  assert.match(byName.container_put.description, /放进/, 'container_put 要说清是放进容器')
  assert.match(byName.give.description, /给/, 'give 要说清是给东西')
  assert.match(byName.cook.description, /锅/, 'cook 要说清是锅')
  assert.match(byName.cook.description, /40 秒|等/, 'cook 要提醒要等')
})

test('S5-12：仍然没有开放 build / recipes / lookup / probe', () => {
  const names = new Set(TOOLS.map((t) => t.name))
  for (const bad of ['pick', 'act', 'heal', 'night_watch', 'store']) {
    assert.ok(!names.has(bad), `${bad} 不该出现（本批没开放）`)
  }
})
