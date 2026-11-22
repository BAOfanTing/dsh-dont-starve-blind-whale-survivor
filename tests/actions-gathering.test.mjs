// 采集与作业动作规格与核对测试（包含 gather_area、seek、chop、mine、dig、hammer）
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTION_SPECS, OPEN_ACTIONS, validateArgs } from '../lib/dispatcher.js'
import { TOOLS } from '../lib/tools.js'

test('S2-1：两个新动作都在白名单里，且有 riskLevel 与 verify', () => {
  for (const name of ['gather_area', 'seek']) {
    assert.ok(OPEN_ACTIONS.includes(name), `${name} 应该在白名单里`)
    const spec = ACTION_SPECS[name]
    assert.ok(spec, `${name} 应该有规格`)
    assert.ok(['R1', 'R2'].includes(spec.riskLevel))
    assert.equal(typeof spec.verify, 'function', `${name} 必须有结果核对`)
  }
})

test('S2-2：gather_area 参数边界（radius 2~40，limit 1~30 整数）', () => {
  const spec = ACTION_SPECS.gather_area
  assert.equal(validateArgs(spec, {}).ok, true, '全都不填应该合法（采附近所有能采的）')
  assert.equal(validateArgs(spec, { prefab: 'grass' }).ok, true)
  assert.equal(validateArgs(spec, { radius: 12, limit: 15 }).ok, true)
  assert.equal(validateArgs(spec, { radius: 1 }).ok, false, 'radius 太小要拒')
  assert.equal(validateArgs(spec, { radius: 41 }).ok, false, 'radius 太大要拒')
  assert.equal(validateArgs(spec, { limit: 0 }).ok, false)
  assert.equal(validateArgs(spec, { limit: 31 }).ok, false)
  assert.equal(validateArgs(spec, { limit: 1.5 }).ok, false, 'limit 必须是整数')
  assert.equal(validateArgs(spec, { prefab: 'Grass' }).ok, false, '大写要拒')
  assert.equal(validateArgs(spec, { guid: '123' }).ok, false, '不许传 GUID')
  assert.equal(validateArgs(spec, { x: 1, z: 2 }).ok, false, '不许传坐标')
})

test('S2-3：seek 参数边界（prefab 必填；step 4~30；max_tiles 4~80）', () => {
  const spec = ACTION_SPECS.seek
  assert.equal(validateArgs(spec, {}).ok, false, 'prefab 必填')
  assert.equal(validateArgs(spec, { prefab: 'flint' }).ok, true)
  assert.equal(validateArgs(spec, { prefab: 'flint', step: 10, max_tiles: 40, look: 16 }).ok, true)
  assert.equal(validateArgs(spec, { prefab: 'flint', step: 3 }).ok, false)
  assert.equal(validateArgs(spec, { prefab: 'flint', max_tiles: 81 }).ok, false)
  assert.equal(validateArgs(spec, { prefab: 'flint', look: 7 }).ok, false)
  assert.equal(validateArgs(spec, { prefab: 'flint', target_ref: '#1' }).ok, false, 'seek 不接受 #N 引用')
})

// ── 结果核对 ──

const snap = (over = {}) => ({
  actor: { tileX: over.x ?? 10, tileZ: over.z ?? 20 },
  player: {
    inventory: {
      items: Object.entries(over.inv ?? {}).map(([prefab, count]) => ({ prefab, count })),
      used: Object.keys(over.inv ?? {}).length,
      slots: 15,
    },
  },
})

test('S2-4：gather_area 核对 —— 任一产物增加就算成功（多产物也对）', () => {
  const spec = ACTION_SPECS.gather_area
  const before = snap({ inv: { cutgrass: 0, twigs: 0 } })
  const after = snap({ inv: { cutgrass: 4, twigs: 2 } })
  const v = spec.verify(before, after)
  assert.equal(v.ok, true)
  assert.equal(v.gained, 6)
  assert.deepEqual(v.products.map((p) => p.prefab).sort(), ['cutgrass', 'twigs'])
})

test('S2-5：gather_area 核对 —— 什么都没采到要判失败（不能因为"跑完了"就说成功）', () => {
  const spec = ACTION_SPECS.gather_area
  const same = snap({ inv: { cutgrass: 1 } })
  const v = spec.verify(same, same)
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'inventory_unchanged')
})

test('S2-6：seek 核对 —— 位置变了算成功，并带上现在在哪', () => {
  const spec = ACTION_SPECS.seek
  const before = snap({ x: 10, z: 20 })
  const after = snap({ x: 18, z: 26 })
  const v = spec.verify(before, after)
  assert.equal(v.ok, true)
  assert.deepEqual(v.pos, { x: 18, z: 26 })
  assert.deepEqual(v.from, { x: 10, z: 20 })
})

test('S2-7：seek 核对 —— 一步没走也判成功（找到的东西可能就在脚边）', () => {
  const spec = ACTION_SPECS.seek
  const same = snap({ x: 10, z: 20 })
  const v = spec.verify(same, same)
  assert.equal(v.ok, true)
  assert.equal(v.how, 'no_move_needed')
})

test('S2-8：两个新工具的描述必须讲清"省调用次数"和"不自动动手"', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]))
  assert.match(byName.gather_area.description, /一次采完/, 'gather_area 要说明一次采完')
  assert.match(byName.gather_area.description, /自己走过去/, '要说明它会走路')
  assert.match(byName.seek.description, /不会自动/, 'seek 要说明只报位置、不自动动手')
  assert.match(byName.seek.description, /找/, 'seek 要说明用途是找东西')
  assert.equal(byName.seek.inputSchema.required.includes('prefab'), true)
})

test('S2-9：白名单扩容后仍然没有泄漏旧动作（chop/mine/attack 依然不可见）', () => {
  const names = new Set(TOOLS.map((t) => t.name))
  for (const bad of ['pick', 'act', 'heal', 'night_watch', 'store']) {
    assert.ok(!names.has(bad), `${bad} 不该出现在工具表里`)
  }
})

// ── 作业类动作（chop / mine / dig / hammer） ──

const snapWork = (over = {}) => ({
  player: {
    inventory: {
      items: Object.entries(over.inv ?? {}).map(([prefab, count]) => ({ prefab, count })),
      used: 0,
      slots: 15,
    },
  },
  nearby: { buckets: { resources: over.items ?? [], creatures: over.creatures ?? [] } },
})

test('work-1：chop/mine/dig/hammer 都在白名单里，且都有 riskLevel 与 verify', () => {
  for (const name of ['chop', 'mine', 'dig', 'hammer']) {
    assert.ok(OPEN_ACTIONS.includes(name), `${name} 应该在白名单里`)
    const spec = ACTION_SPECS[name]
    assert.ok(spec, `${name} 应该有规格`)
    assert.ok(['R1', 'R2'].includes(spec.riskLevel), `${name} 的 riskLevel 不对`)
    assert.equal(typeof spec.verify, 'function', `${name} 必须有结果核对`)
  }
})

test('work-2：workable 类（chop/mine/dig/hammer）都要 #N + snapshot_id', () => {
  for (const name of ['chop', 'mine', 'dig', 'hammer']) {
    const spec = ACTION_SPECS[name]
    assert.equal(spec.requiresSnapshot, true, `${name} 必须校验快照`)
    assert.deepEqual(Object.keys(spec.args).sort(), ['snapshot_id', 'target_handle', 'target_ref'])
    assert.equal(validateArgs(spec, { target_ref: '#3', snapshot_id: 'r1-n2' }).ok, true)
    assert.equal(validateArgs(spec, { target_ref: 'evergreen', snapshot_id: 'r1-n2' }).ok, false, `${name} 不许按 prefab`)
    assert.equal(validateArgs(spec, { target_ref: '#3' }).ok, false, `${name} 缺 snapshot_id 要拒`)
    assert.equal(validateArgs(spec, { target_ref: '#3', snapshot_id: 'r1-n2', guid: 'x' }).ok, false, `${name} 不许传 GUID`)
  }
})

test('work-3：chop 核对 —— 木头进背包算成功', () => {
  const spec = ACTION_SPECS.chop
  const tree = { ref: '#1', prefab: 'evergreen', position: { x: 5, z: 5 } }
  const before = snapWork({ items: [tree], inv: { log: 0 } })
  const after = snapWork({ items: [tree], inv: { log: 3 } })
  const v = spec.verify(before, after, { target_ref: '#1' })
  assert.equal(v.ok, true)
  assert.equal(v.product, 'log')
  assert.equal(v.gained, 3)
})

test('work-4：chop 核对 —— 树没了也算成功（倒下变树桩）', () => {
  const spec = ACTION_SPECS.chop
  const tree = { ref: '#1', prefab: 'evergreen', position: { x: 5, z: 5 } }
  const before = snapWork({ items: [tree], inv: {} })
  const after = snapWork({ items: [], inv: {} })
  const v = spec.verify(before, after, { target_ref: '#1' })
  assert.equal(v.ok, true)
  assert.equal(v.how, 'target_gone')
})

test('work-5：chop 核对 —— 树还在、木头也没多 → 判失败', () => {
  const spec = ACTION_SPECS.chop
  const tree = { ref: '#1', prefab: 'evergreen', position: { x: 5, z: 5 } }
  const same = snapWork({ items: [tree], inv: { log: 0 } })
  const v = spec.verify(same, same, { target_ref: '#1' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'work_state_unchanged')
})

test('work-6：mine 核对 —— 石头/燧石/金块任一出就算成功', () => {
  const spec = ACTION_SPECS.mine
  const rock = { ref: '#2', prefab: 'rock1', position: { x: 6, z: 6 } }
  const before = snapWork({ items: [rock], inv: { rocks: 0, flint: 0 } })
  const after = snapWork({ items: [rock], inv: { rocks: 0, flint: 2 } })
  const v = spec.verify(before, after, { target_ref: '#2' })
  assert.equal(v.ok, true)
  assert.equal(v.product, 'flint')
})

test('work-7：作业工具的描述必须讲清"要 #N + 快照 ID"或用途', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]))
  for (const name of ['chop', 'mine', 'dig', 'hammer']) {
    assert.match(byName[name].description, /#N/, `${name} 要说明用 #N 引用`)
    assert.match(byName[name].description, /快照 ID|snapshot/, `${name} 要提醒带快照 ID`)
    assert.ok(!byName[name].inputSchema.required.includes('snapshot_id'), `${name} 的 snapshot_id 在 schema 不再必填（由 validateArgs 二选一强制）`)
  }
})
