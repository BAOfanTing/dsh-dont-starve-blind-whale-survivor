// SURVIVAL-04：第二批 5 个动作（unequip / say / fuel / use / inspect）
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTION_SPECS, OPEN_ACTIONS, validateArgs } from '../../lib/dispatcher.js'
import { TOOLS } from '../../lib/tools.js'

const NEW = ['unequip', 'say', 'fuel', 'use', 'inspect']

test('5 个新动作都在白名单里，都有 riskLevel 与 verify', () => {
  for (const name of NEW) {
    assert.ok(OPEN_ACTIONS.includes(name), `${name} 应该在白名单里`)
    const spec = ACTION_SPECS[name]
    assert.ok(spec, `${name} 应该有规格`)
    assert.ok(['R1', 'R2'].includes(spec.riskLevel))
    assert.equal(typeof spec.verify, 'function', `${name} 必须有结果核对`)
  }
})

test('fuel / use / inspect 都要 #N + snapshot_id', () => {
  for (const name of ['fuel', 'use', 'inspect']) {
    const spec = ACTION_SPECS[name]
    assert.equal(spec.requiresSnapshot, true, `${name} 必须校验快照`)
    assert.ok(spec.args.target_ref && spec.args.snapshot_id, `${name} 要有 target_ref 与 snapshot_id`)
    assert.equal(validateArgs(spec, { target_ref: '#3', snapshot_id: 'r1-n2' }).ok, true)
    assert.equal(validateArgs(spec, { target_ref: '#3' }).ok, false, `${name} 缺 snapshot_id 要拒`)
    assert.equal(validateArgs(spec, { target_ref: 'firepit', snapshot_id: 'r1-n2' }).ok, false, `${name} 不许按 prefab`)
  }
})

test('use 的 action 只允许大写枚举（防止传任意 ACTIONS）', () => {
  const spec = ACTION_SPECS.use
  assert.equal(validateArgs(spec, { target_ref: '#1', snapshot_id: 'r1-n2' }).ok, true, '不填 action 合法（自动挑）')
  assert.equal(validateArgs(spec, { target_ref: '#1', snapshot_id: 'r1-n2', action: 'OPEN' }).ok, true)
  assert.equal(validateArgs(spec, { target_ref: '#1', snapshot_id: 'r1-n2', action: 'open' }).ok, false, '小写要拒')
  assert.equal(validateArgs(spec, { target_ref: '#1', snapshot_id: 'r1-n2', action: 'DELETE_WORLD' }).ok, true, 'schema 层只查格式，白名单在 Lua 里')
})

test('unequip 的 slot 只能是字母；say 的 text 必填且限长', () => {
  assert.equal(validateArgs(ACTION_SPECS.unequip, {}).ok, true, '不填 slot 默认 hands')
  assert.equal(validateArgs(ACTION_SPECS.unequip, { slot: 'hands' }).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.unequip, { slot: 'HANDS' }).ok, false, '大写要拒')
  assert.equal(validateArgs(ACTION_SPECS.say, {}).ok, false, 'say 要传 text')
  assert.equal(validateArgs(ACTION_SPECS.say, { text: '你好' }).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.say, { text: 'x'.repeat(121) }).ok, false, '太长要拒')
})

// ── 核对 ──

const snap = (over = {}) => ({
  player: {
    inventory: {
      items: Object.entries(over.inv ?? {}).map(([prefab, count]) => ({ prefab, count })),
      used: 0,
      slots: 15,
    },
    equipment: { worn: over.worn ?? {} },
  },
  nearby: { buckets: { structures: over.structures ?? [] } },
})

test('unequip 核对 —— 手里从有变空算成功', () => {
  const spec = ACTION_SPECS.unequip
  const before = snap({ worn: { hands: 'torch' } })
  const after = snap({ worn: {} })
  const v = spec.verify(before, after, { slot: 'hands' })
  assert.equal(v.ok, true)
  assert.equal(v.unequipped, 'torch')
})

test('unequip 核对 —— 本来就没拿东西也算成功（不判死）', () => {
  const spec = ACTION_SPECS.unequip
  const s = snap({ worn: {} })
  const v = spec.verify(s, s, { slot: 'hands' })
  assert.equal(v.ok, true)
  assert.equal(v.how, 'was_empty')
})

test('fuel 核对 —— 指定燃料时看该物品减少', () => {
  const spec = ACTION_SPECS.fuel
  const before = snap({ inv: { log: 5 } })
  const after = snap({ inv: { log: 4 } })
  const v = spec.verify(before, after, { item: 'log' })
  assert.equal(v.ok, true)
  assert.equal(v.used, 1)
  assert.equal(v.prefab, 'log')
})

test('fuel 核对 —— 没指定燃料时任一种燃料减少都算成功', () => {
  const spec = ACTION_SPECS.fuel
  const before = snap({ inv: { cutgrass: 3, twigs: 2 } })
  const after = snap({ inv: { cutgrass: 1, twigs: 2 } })
  const v = spec.verify(before, after, {})
  assert.equal(v.ok, true)
  assert.equal(v.prefab, 'cutgrass')
  assert.equal(v.used, 2)
})

test('S4-9：fuel 核对 —— 燃料没少要判失败（不能因为"加了"就说成功）', () => {
  const spec = ACTION_SPECS.fuel
  const same = snap({ inv: { log: 5 } })
  const v = spec.verify(same, same, { item: 'log' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'fuel_not_consumed')
})

test('say / inspect 不改世界，核对不判死', () => {
  const s = snap({})
  assert.equal(ACTION_SPECS.say.verify(s, s, { text: 'hi' }).ok, true)
  assert.equal(ACTION_SPECS.inspect.verify(s, s, { target_ref: '#1' }).ok, true)
})

test('use 核对 —— 背包多了东西算成功', () => {
  const spec = ACTION_SPECS.use
  const chest = { ref: '#1', prefab: 'chest', position: { x: 3, z: 3 } }
  const before = snap({ structures: [chest], inv: {} })
  const after = snap({ structures: [chest], inv: { log: 2 } })
  const v = spec.verify(before, after, { target_ref: '#1' })
  assert.equal(v.ok, true)
  assert.equal(v.gained, 2)
})

test('S4-12：use 核对 —— 什么都没变也算"交互已发出"（打开箱子不改背包是正常的）', () => {
  const spec = ACTION_SPECS.use
  const chest = { ref: '#1', prefab: 'chest', position: { x: 3, z: 3 } }
  const s = snap({ structures: [chest] })
  const v = spec.verify(s, s, { target_ref: '#1' })
  assert.equal(v.ok, true)
  assert.equal(v.how, 'interaction_sent')
})

test('5 个工具的描述必须讲清用途与引用方式', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]))
  assert.match(byName.unequip.description, /脱/, 'unequip 要说清是脱装备')
  assert.match(byName.say.description, /说/, 'say 要说清是说话')
  assert.match(byName.fuel.description, /添柴|加柴/, 'fuel 要说清是加柴')
  assert.match(byName.fuel.description, /#N/, 'fuel 要说明用 #N')
  assert.match(byName.use.description, /交互|OPEN/, 'use 要说明是通用交互')
  assert.match(byName.inspect.description, /查看/, 'inspect 要说清是查看')
  assert.match(byName.inspect.description, /只读/, 'inspect 要说明是只读的')
})

test('仍然没有开放 build / cook / 存箱子（本批没扩）', () => {
  const names = new Set(TOOLS.map((t) => t.name))
  for (const bad of ['pick', 'act', 'heal', 'night_watch', 'store']) {
    assert.ok(!names.has(bad), `${bad} 不该出现（本批没开放）`)
  }
})
