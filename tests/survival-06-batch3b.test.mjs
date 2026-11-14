// SURVIVAL-06：第三批下半（build / recipes / lookup / probe）
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTION_SPECS, OPEN_ACTIONS, validateArgs } from '../lib/dispatcher.js'
import { TOOLS } from '../lib/tools.js'

const NEW = ['build', 'recipes', 'lookup', 'probe']

test('S6-1：4 个新动作都在白名单里，都有 riskLevel 与 verify', () => {
  for (const name of NEW) {
    assert.ok(OPEN_ACTIONS.includes(name), `${name} 应该在白名单里`)
    const spec = ACTION_SPECS[name]
    assert.ok(spec, `${name} 应该有规格`)
    assert.ok(['R1', 'R2'].includes(spec.riskLevel))
    assert.equal(typeof spec.verify, 'function', `${name} 必须有结果核对`)
  }
})

test('S6-2：build 的 recipe 必填且只能是小写字母', () => {
  const spec = ACTION_SPECS.build
  assert.equal(validateArgs(spec, {}).ok, false, 'build 要传 recipe')
  assert.equal(validateArgs(spec, { recipe: 'campfire' }).ok, true)
  assert.equal(validateArgs(spec, { recipe: 'Campfire' }).ok, false, '大写要拒')
  assert.equal(validateArgs(spec, { recipe: 'camp fire' }).ok, false, '空格要拒')
})

test('S6-3：build 的核对只认白名单里的五个建筑', () => {
  const spec = ACTION_SPECS.build
  const s = { nearby: { buckets: {} }, player: { inventory: { items: [] } } }
  const v = spec.verify(s, s, { recipe: 'evil_structure' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'recipe_not_allowed')
})

test('S6-4：build 核对 —— 附近多了这个建筑算成功', () => {
  const spec = ACTION_SPECS.build
  const before = { nearby: { buckets: { structures: [] } }, player: { inventory: { items: [] } } }
  const after = {
    nearby: { buckets: { structures: [{ ref: '#1', prefab: 'campfire', position: { x: 1, z: 1 } }] } },
    player: { inventory: { items: [] } },
  }
  const v = spec.verify(before, after, { recipe: 'campfire' })
  assert.equal(v.ok, true)
  assert.equal(v.made, 1)
  assert.equal(v.product, 'campfire')
})

test('S6-5：build 核对 —— 建筑还没进附近列表但材料被扣了，也算成功（弱证据）', () => {
  const spec = ACTION_SPECS.build
  const before = { nearby: { buckets: {} }, player: { inventory: { items: [{ prefab: 'cutgrass', count: 2 }, { prefab: 'twigs', count: 3 }] } } }
  const after = { nearby: { buckets: {} }, player: { inventory: { items: [] } } }
  const v = spec.verify(before, after, { recipe: 'campfire' })
  assert.equal(v.ok, true)
  assert.equal(v.how, 'materials_consumed')
})

test('S6-6：build 核对 —— 建筑没出现、材料也没扣 → 判失败', () => {
  const spec = ACTION_SPECS.build
  const same = { nearby: { buckets: {} }, player: { inventory: { items: [{ prefab: 'log', count: 2 }] } } }
  const v = spec.verify(same, same, { recipe: 'campfire' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'build_not_found')
})

test('S6-7：recipes / lookup / probe 是只读的（核对不判死）', () => {
  const s = {}
  assert.equal(ACTION_SPECS.recipes.verify(s, s, {}).ok, true)
  assert.equal(ACTION_SPECS.lookup.verify(s, s, { q: 'axe' }).ok, true)
  assert.equal(ACTION_SPECS.probe.verify(s, s, { prefab: 'flint' }).ok, true)
})

test('S6-8：lookup 的 q 必填；probe 的 prefab 必填且 radius 有上下限', () => {
  assert.equal(validateArgs(ACTION_SPECS.lookup, {}).ok, false)
  assert.equal(validateArgs(ACTION_SPECS.lookup, { q: 'axe' }).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.probe, {}).ok, false)
  assert.equal(validateArgs(ACTION_SPECS.probe, { prefab: 'flint' }).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.probe, { prefab: 'flint', radius: 41 }).ok, false)
  assert.equal(validateArgs(ACTION_SPECS.probe, { prefab: 'flint', radius: 3 }).ok, false)
})

test('S6-9：recipes 的 limit 有上限（防止一次列出几百条）', () => {
  const spec = ACTION_SPECS.recipes
  assert.equal(validateArgs(spec, {}).ok, true)
  assert.equal(validateArgs(spec, { limit: 30 }).ok, true)
  assert.equal(validateArgs(spec, { limit: 61 }).ok, false)
  assert.equal(validateArgs(spec, { limit: 0 }).ok, false)
})

test('S6-10：4 个工具的描述必须讲清用途', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]))
  assert.match(byName.build.description, /造一个建筑|建筑/, 'build 要说清是建造')
  assert.match(byName.build.description, /campfire/, 'build 要列出能造什么')
  assert.match(byName.recipes.description, /查配方|配方/, 'recipes 要说清查配方')
  assert.match(byName.lookup.description, /查游戏数据|查/, 'lookup 要说清查数据')
  assert.match(byName.probe.description, /探测|附近/, 'probe 要说清是探测')
  // build 的 enum 必须和 dispatcher 白名单一致
  assert.deepEqual(
    [...byName.build.inputSchema.properties.recipe.enum].sort(),
    ['campfire', 'chest', 'cookpot', 'firepit', 'sciencemachine'],
  )
})

test('S6-11：全部常用动作都开放后，工具表里不该出现"野生"动作名', () => {
  const names = new Set(TOOLS.map((t) => t.name))
  for (const bad of ['pick', 'act', 'heal', 'night_watch', 'store', 'take', 'go_to', 'make_fire', 'add_fuel']) {
    assert.ok(!names.has(bad), `${bad} 不该出现`)
  }
})
