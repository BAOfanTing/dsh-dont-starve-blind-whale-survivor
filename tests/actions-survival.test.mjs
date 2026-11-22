// 生存动作规格与核对测试（包含 eat、equip、unequip、drop、fuel、wait 以及背包/手部 JSON 形状兼容）
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
import { inventoryItems, countInInventory, handItem } from '../lib/actions/state-query.js'

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
  assert.deepEqual(Object.keys(spec.args).sort(), ['snapshot_id', 'target_handle', 'target_ref'])
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

test('survival-4：craft 的 recipe 必填且只能填白名单里的配方', () => {
  const spec = ACTION_SPECS.craft
  assert.equal(validateArgs(spec, {}).ok, false, 'recipe 必填')
  for (const r of ['torch', 'axe', 'pickaxe', 'flowerhat', 'rope', 'boards', 'backpack', 'spear', 'armorwood']) {
    assert.equal(validateArgs(spec, { recipe: r }).ok, true, `${r} 应该合法`)
  }
  // TARGET-REFRESH：enum 现在锁死在白名单上（以前 schema 层放行、只在 verify 里拦）
  assert.equal(validateArgs(spec, { recipe: 'campfire' }).ok, false, 'campfire 归 build，不属于 craft')
  // verify 里也必须拒非白名单
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

  // 装备栏没变 → 失败。★ 真机 bug（2026-11-16）：以前 reason 叫 `hand_unchanged`，
  // 但"手没变"既可能是幂等成功（本来就拿着）也可能是真失败 —— 模型会误读。
  // 现在统一叫 `equip_failed`，并且把幂等成功单独判掉（见下一条）。
  const bad = spec.verify(before, before, { item: 'torch' })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'equip_failed')

  // 幂等：本来就已经拿着它 → 算成功（不算失败）
  const already = snap({ worn: { hands: 'torch' } })
  const idem = spec.verify(already, already, { item: 'torch' })
  assert.equal(idem.ok, true, '本来就拿着 torch 时 equip 应该成功（幂等）')

  // 之前拿着但被换掉了 → 失败，并说明原因
  const swapped = spec.verify(snap({ worn: { hands: 'torch' } }), snap({ worn: { hands: 'axe' } }), { item: 'torch' })
  assert.equal(swapped.ok, false)
  assert.equal(swapped.reason, 'equip_failed')
  assert.match(String(swapped.note || ''), /换掉/, '要说明是被换掉了')
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
  assert.deepEqual(byName.craft.inputSchema.properties.recipe.enum,
    ['axe', 'pickaxe', 'torch', 'flowerhat', 'rope', 'boards', 'backpack', 'spear', 'armorwood', 'cutstone', 'transistor'],
    'TARGET-REFRESH：craft 的 enum 必须和 Node/Lua 白名单逐条一致（TENT 多了 cutstone / transistor）')
  assert.deepEqual(byName.equip.inputSchema.properties.item.enum, ['torch', 'axe', 'pickaxe', 'lantern', 'minerhat', 'flowerhat', 'spear'])
})


// ─────────────────────────── 背包数据形状兼容 ───────────────────────────
// S9：背包 items 的两种 JSON 形状都必须能数对
//
// 真机 Cluster_1 #26 craft torch：
//   回执写着「做好了 火把（torch+1）（cutgrass-2，twigs-2）（背包：cutgrass-2，torch+1，twigs-2）」
//   —— Lua 侧自己的差异核对算出了 torch+1，Node 侧却判 craft_not_in_inventory。
// 根因：Lua 把空表序列化成 {}（对象），countInInventory 里 `!Array.isArray → return 0` 直接放弃。





const snapS9 = (items, equipment) => ({
  player: { inventory: { items }, ...(equipment ? { equipment } : {}) },
})

test('S9-1：inventoryItems 同时接受数组和对象', () => {
  assert.deepEqual(inventoryItems(snapS9([])), [])
  assert.deepEqual(inventoryItems(snapS9({})), [])
  assert.equal(inventoryItems(snapS9([{ prefab: 'log', count: 2 }])).length, 1)
  assert.equal(inventoryItems(snapS9({ a: { prefab: 'log', count: 2 } })).length, 1)
  // 异常输入不崩
  assert.deepEqual(inventoryItems(null), [])
  assert.deepEqual(inventoryItems(snapS9(null)), [])
  assert.deepEqual(inventoryItems(snapS9('oops')), [])
})

test('S9-2：craft 核对在"对象形状"的背包上也能认出成品（真机 bug 的复现）', () => {
  const spec = ACTION_SPECS.craft
  // ① 对象形状：做之前是 {}，做之后多了 torch
  const v1 = spec.verify(snapS9({}), snapS9({ t: { prefab: 'torch', count: 1 } }), { recipe: 'torch' })
  assert.equal(v1.ok, true, '对象形状的背包必须能数出 torch')
  assert.equal(v1.made, 1)

  // ② 数组形状（原来就支持，别改坏）
  const v2 = spec.verify(
    snapS9([{ prefab: 'cutgrass', count: 2 }]),
    snapS9([{ prefab: 'cutgrass', count: 2 }, { prefab: 'torch', count: 1 }]),
    { recipe: 'torch' },
  )
  assert.equal(v2.ok, true)
  assert.equal(v2.made, 1)
})

test('S9-3：修了形状也不许放松 —— 没做出来仍然判失败', () => {
  const spec = ACTION_SPECS.craft
  const same = snapS9({ c: { prefab: 'cutgrass', count: 2 } })
  const v = spec.verify(same, same, { recipe: 'torch' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'craft_not_in_inventory')
  // 材料被扣了、但成品没出现 → 也必须判失败（不能因为"有变化"就说成功）
  const v2 = spec.verify(snapS9({ c: { prefab: 'cutgrass', count: 2 } }), snapS9({}), { recipe: 'torch' })
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


// ─────────────────────────── 手部装备形状兼容 ───────────────────────────
// S10：装备栏两种 JSON 形状都必须能读（真机 craft torch 的第二个坑）
//
// 真机 Cluster_1 复测：
//   → 背包 cutgrass×1,twigs×8 | 手持 torch      ← 火把确实在手上
//   但回执仍说「没核对上（craft_not_in_inventory）」
// 实际形状（状态文件里同时存在）：
//   "slots": { "hands": { "prefab": "torch", ... } }                    ← 对象
//   "worn":  [ { "key": "hands", "item": { "prefab": "torch" } } ]      ← 数组
// 原来只读 worn.hands（在数组上取 key）→ 永远 null。





const snapS10 = (equipment, items = {}) => ({ player: { inventory: { items }, ...(equipment ? { equipment } : {}) } })

const REAL = {
  slots: { hands: { slot_key: 'hands', name: '火炬', percent: 87, prefab: 'torch', count: 1 } },
  worn: [{ item: { slot_key: 'hands', name: '火炬', prefab: 'torch', count: 1 }, key: 'hands', label: '手持' }],
}

test('S10-1：handItem 认得真机那种"slots 对象 + worn 数组"的形状', () => {
  assert.equal(handItem(snapS10(REAL)), 'torch', '真机形状必须读出 torch')
  // 只有一种形状也要认（不同版本可能只写一边）
  assert.equal(handItem(snapS10({ slots: { hands: { prefab: 'torch' } } })), 'torch')
  assert.equal(handItem(snapS10({ worn: [{ key: 'hands', item: { prefab: 'torch' } }] })), 'torch')
  assert.equal(handItem(snapS10({ worn: { hands: 'torch' } })), 'torch', '老的对象形状也要认')
  // 空 / 没有 / 异常
  assert.equal(handItem(snapS10({ slots: {}, worn: [] })), null)
  assert.equal(handItem(snapS10(null)), null)
  assert.equal(handItem(null), null)
  // 只认 hands，别把头/身的东西当手持
  assert.equal(handItem(snapS10({ slots: { head: { prefab: 'footballhat' } } })), null)
  assert.equal(handItem(snapS10({ worn: [{ key: 'head', item: { prefab: 'footballhat' } }] })), null)
})

test('S10-2：craft 在真机形状下能认出"做好了且自动装备"（bug 复现）', () => {
  const empty = snapS10({ slots: {}, worn: [] })
  const v = ACTION_SPECS.craft.verify(empty, snapS10(REAL), { recipe: 'torch' })
  assert.equal(v.ok, true, '做好了并拿在手上必须算成功')
  assert.equal(v.how, 'auto_equipped')
  assert.equal(v.hand, 'torch')
})

test('S10-3：craft 仍不许放松 —— 手上本来就有火把时再"做"不算成功', () => {
  // 做之前手上就是 torch、做之后还是 torch、背包也没多 → 判失败
  const v = ACTION_SPECS.craft.verify(snapS10(REAL), snapS10(REAL), { recipe: 'torch' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'craft_not_in_inventory')
})

test('S10-4：unequip 在真机形状下能认出"手上有东西 → 空了"', () => {
  const v = ACTION_SPECS.unequip.verify(snapS10(REAL), snapS10({ slots: {}, worn: [] }), { slot: 'hands' })
  assert.equal(v.ok, true)
  assert.equal(v.unequipped, 'torch')
  // 本来空手 → 不判死
  const v2 = ACTION_SPECS.unequip.verify(snapS10({ slots: {}, worn: [] }), snapS10({ slots: {}, worn: [] }), { slot: 'hands' })
  assert.equal(v2.ok, true)
  assert.equal(v2.how, 'was_empty')
})

test('S10-5：equip 在真机形状下能认出“已经拿在手里”（不能报 hand_unchanged）', () => {
  const before = snapS10({ slots: {}, worn: [] })
  const after = snapS10(REAL)
  const v = ACTION_SPECS.equip.verify(before, after, { item: 'torch' })
  assert.equal(v.ok, true, '真机形状必须读出手持 torch')
  assert.equal(v.hand, 'torch')
})

