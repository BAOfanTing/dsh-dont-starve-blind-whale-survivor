// SURVIVAL-03：批量开放的 8 个动作（chop / mine / dig / hammer / attack / kill / wait / drop）
//
// 这些是从另一个实现搬来的能力，但**目标引用沿用 #N + snapshot_id**（不引入它的 id 体系）。
// 测试重点：
//   · 都要求 #N + snapshot_id（不接受 GUID / prefab / 坐标）
//   · 结果核对看真实变化（产物进包 / 目标消失 / 血量下降 / 背包减少）
//   · wait 不改世界，核对不判死
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTION_SPECS, OPEN_ACTIONS, validateArgs } from '../lib/dispatcher.js'
import { TOOLS } from '../lib/tools.js'

const NEW = ['chop', 'mine', 'dig', 'hammer', 'attack', 'kill', 'wait', 'drop']

test('S3-1：8 个新动作都在白名单里，都有 riskLevel 与 verify', () => {
  for (const name of NEW) {
    assert.ok(OPEN_ACTIONS.includes(name), `${name} 应该在白名单里`)
    const spec = ACTION_SPECS[name]
    assert.ok(spec, `${name} 应该有规格`)
    assert.ok(['R1', 'R2'].includes(spec.riskLevel), `${name} 的 riskLevel 不对`)
    assert.equal(typeof spec.verify, 'function', `${name} 必须有结果核对`)
  }
})

test('S3-2：workable 类（chop/mine/dig/hammer）都要 #N + snapshot_id', () => {
  for (const name of ['chop', 'mine', 'dig', 'hammer']) {
    const spec = ACTION_SPECS[name]
    assert.equal(spec.requiresSnapshot, true, `${name} 必须校验快照`)
    assert.deepEqual(Object.keys(spec.args).sort(), ['snapshot_id', 'target_ref'])
    assert.equal(validateArgs(spec, { target_ref: '#3', snapshot_id: 'r1-n2' }).ok, true)
    assert.equal(validateArgs(spec, { target_ref: 'evergreen', snapshot_id: 'r1-n2' }).ok, false, `${name} 不许按 prefab`)
    assert.equal(validateArgs(spec, { target_ref: '#3' }).ok, false, `${name} 缺 snapshot_id 要拒`)
    assert.equal(validateArgs(spec, { target_ref: '#3', snapshot_id: 'r1-n2', guid: 'x' }).ok, false, `${name} 不许传 GUID`)
  }
})

test('S3-3：attack/kill 也要 #N + snapshot_id；attack 可以指定次数', () => {
  for (const name of ['attack', 'kill']) {
    const spec = ACTION_SPECS[name]
    assert.equal(spec.requiresSnapshot, true)
    assert.ok(spec.args.target_ref && spec.args.snapshot_id)
    assert.equal(validateArgs(spec, { target_ref: '#2', snapshot_id: 'r1-n2' }).ok, true)
  }
  assert.equal(validateArgs(ACTION_SPECS.attack, { target_ref: '#2', snapshot_id: 'r1-n2', times: 3 }).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.attack, { target_ref: '#2', snapshot_id: 'r1-n2', times: 0 }).ok, false)
  assert.equal(validateArgs(ACTION_SPECS.attack, { target_ref: '#2', snapshot_id: 'r1-n2', times: 51 }).ok, false)
})

test('S3-4：wait 的 seconds 有上下限；drop 必须传 item', () => {
  assert.equal(validateArgs(ACTION_SPECS.wait, {}).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.wait, { seconds: 5 }).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.wait, { seconds: 0 }).ok, false)
  assert.equal(validateArgs(ACTION_SPECS.wait, { seconds: 31 }).ok, false)
  assert.equal(validateArgs(ACTION_SPECS.drop, {}).ok, false, 'drop 要传 item')
  assert.equal(validateArgs(ACTION_SPECS.drop, { item: 'twigs' }).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.drop, { item: 'Twigs' }).ok, false)
})

// ── 结果核对 ──

const snap = (over = {}) => ({
  player: {
    inventory: {
      items: Object.entries(over.inv ?? {}).map(([prefab, count]) => ({ prefab, count })),
      used: 0,
      slots: 15,
    },
  },
  nearby: { buckets: { resources: over.items ?? [], creatures: over.creatures ?? [] } },
})

test('S3-5：chop 核对 —— 木头进背包算成功', () => {
  const spec = ACTION_SPECS.chop
  const tree = { ref: '#1', prefab: 'evergreen', position: { x: 5, z: 5 } }
  const before = snap({ items: [tree], inv: { log: 0 } })
  const after = snap({ items: [tree], inv: { log: 3 } })
  const v = spec.verify(before, after, { target_ref: '#1' })
  assert.equal(v.ok, true)
  assert.equal(v.product, 'log')
  assert.equal(v.gained, 3)
})

test('S3-6：chop 核对 —— 树没了也算成功（倒下变树桩）', () => {
  const spec = ACTION_SPECS.chop
  const tree = { ref: '#1', prefab: 'evergreen', position: { x: 5, z: 5 } }
  const before = snap({ items: [tree], inv: {} })
  const after = snap({ items: [], inv: {} })
  const v = spec.verify(before, after, { target_ref: '#1' })
  assert.equal(v.ok, true)
  assert.equal(v.how, 'target_gone')
})

test('S3-7：chop 核对 —— 树还在、木头也没多 → 判失败', () => {
  const spec = ACTION_SPECS.chop
  const tree = { ref: '#1', prefab: 'evergreen', position: { x: 5, z: 5 } }
  const same = snap({ items: [tree], inv: { log: 0 } })
  const v = spec.verify(same, same, { target_ref: '#1' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'work_state_unchanged')
})

test('S3-8：mine 核对 —— 石头/燧石/金块任一出就算成功', () => {
  const spec = ACTION_SPECS.mine
  const rock = { ref: '#2', prefab: 'rock1', position: { x: 6, z: 6 } }
  const before = snap({ items: [rock], inv: { rocks: 0, flint: 0 } })
  const after = snap({ items: [rock], inv: { rocks: 0, flint: 2 } })
  const v = spec.verify(before, after, { target_ref: '#2' })
  assert.equal(v.ok, true)
  assert.equal(v.product, 'flint')
})

test('S3-9：attack 核对 —— 血量下降算成功', () => {
  const spec = ACTION_SPECS.attack
  const spider = { ref: '#3', prefab: 'spider', position: { x: 7, z: 7 }, health: 100 }
  const before = snap({ creatures: [spider] })
  const after = snap({ creatures: [{ ...spider, health: 75 }] })
  const v = spec.verify(before, after, { target_ref: '#3' })
  assert.equal(v.ok, true)
  assert.equal(v.hpFrom, 100)
  assert.equal(v.hpTo, 75)
})

test('S3-10：attack 核对 —— 目标消失（打死了）也算成功', () => {
  const spec = ACTION_SPECS.attack
  const spider = { ref: '#3', prefab: 'spider', position: { x: 7, z: 7 }, health: 100 }
  const before = snap({ creatures: [spider] })
  const after = snap({ creatures: [] })
  const v = spec.verify(before, after, { target_ref: '#3' })
  assert.equal(v.ok, true)
  assert.equal(v.how, 'target_gone')
})

test('S3-11：attack 核对 —— 血没变 → 判失败（不能因为"打了"就说成功）', () => {
  const spec = ACTION_SPECS.attack
  const spider = { ref: '#3', prefab: 'spider', position: { x: 7, z: 7 }, health: 100 }
  const same = snap({ creatures: [spider] })
  const v = spec.verify(same, same, { target_ref: '#3' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'target_hp_unchanged')
})

test('S3-12：drop 核对 —— 背包里该物品减少算成功', () => {
  const spec = ACTION_SPECS.drop
  const before = snap({ inv: { twigs: 5 } })
  const after = snap({ inv: { twigs: 4 } })
  const v = spec.verify(before, after, { item: 'twigs' })
  assert.equal(v.ok, true)
  assert.equal(v.used, 1)
  // 没减少 → 失败
  const same = spec.verify(before, before, { item: 'twigs' })
  assert.equal(same.ok, false)
})

test('S3-13：wait 核对 —— 不改世界也算成功（游戏确认执行即可）', () => {
  const spec = ACTION_SPECS.wait
  const s = snap({})
  assert.equal(spec.verify(s, s, {}).ok, true)
})

test('S3-14：8 个新工具的描述必须讲清"要 #N + 快照 ID"或用途', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]))
  for (const name of ['chop', 'mine', 'dig', 'hammer', 'attack', 'kill']) {
    assert.match(byName[name].description, /#N/, `${name} 要说明用 #N 引用`)
    assert.match(byName[name].description, /快照 ID|snapshot/, `${name} 要提醒带快照 ID`)
    assert.ok(byName[name].inputSchema.required.includes('snapshot_id'), `${name} 的 snapshot_id 必填`)
  }
  assert.match(byName.wait.description, /等/, 'wait 要说明用途')
  assert.match(byName.drop.description, /丢/, 'drop 要说明用途')
})

test('S3-15：仍然没有开放建造/烹饪/存箱（避免顺手扩太多）', () => {
  const names = new Set(TOOLS.map((t) => t.name))
  // SURVIVAL-06：只查这些从来不存在/不该有的
  for (const bad of ['pick', 'act', 'heal', 'night_watch', 'store']) {
    assert.ok(!names.has(bad), `${bad} 不该出现（本批没开放）`)
  }
})
