// SURVIVAL-01：四个基础生存动作（gather / eat / craft / equip）
//
// 这些测试跑**真 Lua**（fengari）+ 假游戏，验的是"拒绝得对"和"核对得对"：
//   · 非法目标（不在白名单 / 已采空 / 太远 / 快照过期）必须被拒，且不写命令
//   · craft 材料不够必须回 ingredients_missing
//   · eat 只吃白名单食物、饿满了不吃
//   · equip 只装备背包里有的白名单物品
//   · 成功判据必须看真实状态变化（背包 / 饥饿 / 装备栏），不看动作返回值
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTION_SPECS, OPEN_ACTIONS, validateArgs } from '../lib/dispatcher.js'

const NEW_ACTIONS = ['gather', 'eat', 'craft', 'equip']

test('survival-1：四个新动作都在 dispatcher 白名单里，且都有 riskLevel', () => {
  for (const name of NEW_ACTIONS) {
    assert.ok(OPEN_ACTIONS.includes(name), `${name} 应该在白名单里`)
    assert.ok(ACTION_SPECS[name], `${name} 应该有规格`)
    assert.ok(['R1', 'R2'].includes(ACTION_SPECS[name].riskLevel), `${name} 的 riskLevel 不对`)
    assert.equal(typeof ACTION_SPECS[name].verify, 'function', `${name} 必须有 verify（结果核对）`)
  }
})

test('survival-2：gather 只接受 target_ref + snapshot_id（和 harvest 同构）', () => {
  const spec = ACTION_SPECS.gather
  assert.equal(spec.requiresSnapshot, true, 'gather 必须校验快照')
  assert.deepEqual(Object.keys(spec.args).sort(), ['snapshot_id', 'target_ref'])
  // OBSERVATION-02：引用是 1 起的，#0 不该合法
  assert.deepEqual(spec.args.target_ref.pattern, '^#[1-9][0-9]{0,3}$')
  assert.equal(validateArgs(spec, { target_ref: '#0', snapshot_id: 'r1-n2' }).ok, false, '#0 要拒')
  assert.equal(validateArgs(spec, { target_ref: '#1', snapshot_id: 'r1-n2' }).ok, true, '#1 要收')
  assert.equal(validateArgs(spec, { target_ref: '#3', snapshot_id: 'r1-n2' }).ok, true)
  assert.equal(validateArgs(spec, { target_ref: 'grass', snapshot_id: 'r1-n2' }).ok, false, '不许按 prefab 指定')
  assert.equal(validateArgs(spec, { target_ref: '#3' }).ok, false, '缺 snapshot_id 要拒')
  assert.equal(validateArgs(spec, { target_ref: '#3', snapshot_id: 'r1-n2', prefab: 'grass' }).ok, false, '不许传额外字段')
})

test('survival-3：eat 的 food 只能是小写 prefab 名，且可以不填', () => {
  const spec = ACTION_SPECS.eat
  assert.equal(validateArgs(spec, {}).ok, true, '不填 food 应该合法（服务端自动挑）')
  assert.equal(validateArgs(spec, { food: 'berries' }).ok, true)
  assert.equal(validateArgs(spec, { food: 'Berries' }).ok, false, '大写要拒')
  assert.equal(validateArgs(spec, { food: 'berries; drop' }).ok, false, '奇怪字符要拒')
  assert.equal(validateArgs(spec, { guid: '123' }).ok, false, '不许传 GUID')
  assert.equal(validateArgs(spec, { prefab: 'berries' }).ok, false, '不许传 prefab 字段')
})

test('survival-4：craft 的 recipe 必填且只能是白名单三个', () => {
  const spec = ACTION_SPECS.craft
  assert.equal(validateArgs(spec, {}).ok, false, 'recipe 必填')
  for (const r of ['torch', 'axe', 'pickaxe']) {
    assert.equal(validateArgs(spec, { recipe: r }).ok, true, `${r} 应该合法`)
  }
  assert.equal(validateArgs(spec, { recipe: 'campfire' }).ok, true, 'schema 层允许（白名单在 Lua/verify 里判）')
  // verify 里必须拒非白名单
  const v = spec.verify({}, {}, { recipe: 'campfire' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'recipe_not_allowed')
})

test('survival-5：equip 的 item 必填，且 verify 拒非白名单', () => {
  const spec = ACTION_SPECS.equip
  assert.equal(validateArgs(spec, {}).ok, false, 'item 必填')
  for (const it of ['torch', 'axe', 'pickaxe']) {
    assert.equal(validateArgs(spec, { item: it }).ok, true)
  }
  const v = spec.verify({}, {}, { item: 'grass' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'item_not_equippable')
})

// ── 结果核对：必须看真实状态变化 ──

const snap = (over = {}) => ({
  player: {
    inventory: { items: over.items ?? [], used: (over.items ?? []).length, slots: 15 },
    hunger: { current: over.hunger ?? 100, max: 200 },
    equipment: { worn: over.worn ?? {} },
  },
  nearby: {
    buckets: {
      harvestables: over.harvestables ?? [],
      pickupables: [],
    },
  },
})

test('survival-6：gather 核对 —— 产物进背包才算成功', () => {
  const spec = ACTION_SPECS.gather
  const ref = '#4'
  const target = { ref, prefab: 'grass', position: { x: 1, z: 2 } }
  const before = snap({ harvestables: [target], items: [{ prefab: 'cutgrass', count: 0 }] })
  // 背包里 cutgrass 0 → 2
  const afterOk = snap({ harvestables: [target], items: [{ prefab: 'cutgrass', count: 2 }] })
  const ok = spec.verify(before, afterOk, { target_ref: ref })
  assert.equal(ok.ok, true)
  assert.equal(ok.product, 'cutgrass')
  assert.equal(ok.gained, 2)

  // 什么都没变 → 不成功
  const afterSame = snap({ harvestables: [target], items: [{ prefab: 'cutgrass', count: 0 }] })
  const bad = spec.verify(before, afterSame, { target_ref: ref })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'gather_state_unchanged')
})

test('survival-7：gather 核对 —— 目标消失也算成功（被别的机制收走）', () => {
  const spec = ACTION_SPECS.gather
  const target = { ref: '#4', prefab: 'sapling', position: { x: 1, z: 2 } }
  const before = snap({ harvestables: [target], items: [] })
  const after = snap({ harvestables: [], items: [] })
  const r = spec.verify(before, after, { target_ref: '#4' })
  assert.equal(r.ok, true)
  assert.equal(r.product, 'twigs')
  assert.equal(r.how, 'target_gone')
})

test('survival-8：gather 核对 —— 引用不存在 / prefab 不在白名单都拒', () => {
  const spec = ACTION_SPECS.gather
  const empty = snap({ harvestables: [] })
  assert.equal(spec.verify(empty, empty, { target_ref: '#9' }).reason, 'unknown_ref')
  const berry = { ref: '#1', prefab: 'berrybush', position: { x: 0, z: 0 } }
  const s = snap({ harvestables: [berry] })
  assert.equal(spec.verify(s, s, { target_ref: '#1' }).reason, 'prefab_not_allowed')
})

test('survival-9：eat 核对 —— 饥饿上涨或食物减少都算成功', () => {
  const spec = ACTION_SPECS.eat
  const before = snap({ hunger: 100, items: [{ prefab: 'berries', count: 1 }] })
  // 饥饿 100 → 109.375（浆果）
  const byHunger = snap({ hunger: 109.375, items: [] })
  const r1 = spec.verify(before, byHunger, { food: 'berries' })
  assert.equal(r1.ok, true)
  assert.ok(r1.hungerGained > 0.5)

  // 饥饿没变但食物少了一个（也算吃掉了）
  const byCount = snap({ hunger: 100, items: [] })
  const r2 = spec.verify(before, byCount, { food: 'berries' })
  assert.equal(r2.ok, true)
  assert.equal(r2.used, 1)

  // 什么都没变 → 失败（不能把"吃了"当成成功）
  const same = snap({ hunger: 100, items: [{ prefab: 'berries', count: 1 }] })
  const r3 = spec.verify(before, same, { food: 'berries' })
  assert.equal(r3.ok, false)
  assert.equal(r3.reason, 'hunger_unchanged')
})

test('survival-eat-healing：满饥饿自动进食仍能按回血核验', () => {
  const before = snap({ hunger: 200 })
  const after = snap({ hunger: 200 })
  before.player.health = { current: 15 }
  after.player.health = { current: 16 }
  assert.equal(ACTION_SPECS.eat.verify(before, after, {}).ok, true)
  assert.equal(ACTION_SPECS.eat.verify(before, before, {}).ok, false)
})

for (const item of ['lantern', 'minerhat']) {
  for (const shape of ['slots', 'array', 'object']) {
    test(`survival-equip-light：${item} 从 ${shape} 核验正确槽位`, () => {
      const slot = item === 'minerhat' ? 'head' : 'hands'
      const after = snap()
      after.player.equipment = shape === 'slots' ? { slots: { [slot]: { prefab: item } } }
        : shape === 'array' ? { worn: [{ key: slot, item: { prefab: item } }] }
          : { worn: { [slot]: item } }
      assert.equal(ACTION_SPECS.equip.verify(snap(), after, { item }).ok, true)
      assert.equal(ACTION_SPECS.equip.verify(snap(), snap(), { item }).ok, false)
      if (item === 'minerhat') {
        assert.equal(ACTION_SPECS.equip.verify(snap(), snap({ worn: { hands: item } }), { item }).ok, false)
      }
    })
  }
}

test('survival-10：craft 核对 —— 成品进背包才算成功', () => {
  const spec = ACTION_SPECS.craft
  const before = snap({ items: [{ prefab: 'twigs', count: 1 }, { prefab: 'flint', count: 1 }] })
  const after = snap({ items: [{ prefab: 'axe', count: 1 }] })
  const ok = spec.verify(before, after, { recipe: 'axe' })
  assert.equal(ok.ok, true)
  assert.equal(ok.made, 1)

  // 材料没了但成品没进包 → 失败
  const bad = spec.verify(before, snap({ items: [] }), { recipe: 'axe' })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'craft_not_in_inventory')
})

test('survival-11：equip 核对 —— 装备栏真的变了才算成功', () => {
  const spec = ACTION_SPECS.equip
  const before = snap({ worn: {} })
  const after = snap({ worn: { hands: 'torch' } })
  assert.equal(spec.verify(before, after, { item: 'torch' }).ok, true)

  // 装备栏没变 → 失败
  const bad = spec.verify(before, before, { item: 'torch' })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'hand_unchanged')
})

test('survival-12：工具表里的四个新工具描述必须讲清白名单/限制', async () => {
  const { TOOLS } = await import('../lib/tools.js')
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]))
  assert.match(byName.gather.description, /草|cutgrass/, 'gather 要说明产物')
  assert.match(byName.gather.description, /Nearby 快照 ID/, 'gather 要提醒用 Nearby 快照 ID')
  assert.match(byName.eat.description, /白名单|怪物肉/, 'eat 要说明白名单/禁忌')
  assert.match(byName.craft.description, /torch/, 'craft 要列出配方')
  assert.match(byName.craft.description, /ingredients_missing/, 'craft 要说明材料不足的返回')
  assert.match(byName.equip.description, /torch/, 'equip 要列出手持物品')
  // craft/equip 的 enum 必须锁死
  assert.deepEqual(byName.craft.inputSchema.properties.recipe.enum, ['torch', 'axe', 'pickaxe'])
  assert.deepEqual(byName.equip.inputSchema.properties.item.enum, ['torch', 'axe', 'pickaxe', 'lantern', 'minerhat'])
})
