// SURVIVAL-02：gather_area（范围采集）+ seek（走出去找）
//
// 这两个动作是为了**减少模型调用次数**（借鉴 DontStarveAI 的 harvest_area / seek）。
// 测试重点：
//   · 白名单：prefab 只能给白名单里的；不给 prefab 就只采白名单内的
//   · 参数边界：radius/limit/step/max_tiles 的上下限
//   · 结果核对：gather_area 必须看到产物进背包；seek 只核对位置
//   · 安全：都不接受 GUID / 坐标 / 任意 prefab
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
  // SURVIVAL-05：container_*/give/cook 已开放，只查仍未开放的
  for (const bad of ['build', 'recipes', 'lookup', 'probe', 'sleep']) {
    assert.ok(!names.has(bad), `${bad} 不该出现在工具表里`)
  }
})
