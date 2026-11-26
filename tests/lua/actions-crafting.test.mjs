// 制作与建造动作规格与核对测试（包含 craft、build、cook、recipes、lookup、probe）
// SURVIVAL-05：第三批上半（container_take / container_put / give / cook）
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTION_SPECS, OPEN_ACTIONS, validateArgs } from '../../lib/dispatcher.js'
import { TOOLS } from '../../lib/tools.js'
import { BUILDABLE_RECIPES } from '../../lib/actions/specs/crafting.js'

const NEW = ['container_take', 'container_put', 'give', 'cook']

test('4 个新动作都在白名单里，都有 riskLevel 与 verify', () => {
  for (const name of NEW) {
    assert.ok(OPEN_ACTIONS.includes(name), `${name} 应该在白名单里`)
    const spec = ACTION_SPECS[name]
    assert.ok(spec, `${name} 应该有规格`)
    assert.ok(['R1', 'R2'].includes(spec.riskLevel))
    assert.equal(typeof spec.verify, 'function', `${name} 必须有结果核对`)
    assert.equal(spec.requiresSnapshot, true, `${name} 必须校验快照`)
  }
})

test('4 个都要 #N + snapshot_id（拒绝 prefab / GUID / 坐标）', () => {
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

test('container_put / give 必须传 item；container_take 可以不传', () => {
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

test('container_take 核对 —— 指定物品时看它增加', () => {
  const spec = ACTION_SPECS.container_take
  const before = snap({ inv: { log: 1 } })
  const after = snap({ inv: { log: 4 } })
  const v = spec.verify(before, after, { item: 'log' })
  assert.equal(v.ok, true)
  assert.equal(v.gained, 3)
  assert.equal(v.product, 'log')
})

test('container_take 核对 —— 没指定物品时任一种增加都算成功', () => {
  const spec = ACTION_SPECS.container_take
  const before = snap({ inv: { log: 1 } })
  const after = snap({ inv: { log: 1, flint: 2 } })
  const v = spec.verify(before, after, {})
  assert.equal(v.ok, true)
  assert.equal(v.product, 'flint')
})

test('container_take 核对 —— 什么都没拿到要判失败', () => {
  const spec = ACTION_SPECS.container_take
  const same = snap({ inv: { log: 1 } })
  const v = spec.verify(same, same, { item: 'log' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'inventory_unchanged')
})

test('container_put 核对 —— 背包里该物品减少算成功', () => {
  const spec = ACTION_SPECS.container_put
  const before = snap({ inv: { log: 5 } })
  const after = snap({ inv: { log: 3 } })
  const v = spec.verify(before, after, { item: 'log' })
  assert.equal(v.ok, true)
  assert.equal(v.used, 2)
})

test('give 核对 —— 背包里该物品减少算成功；没减少判失败', () => {
  const spec = ACTION_SPECS.give
  const before = snap({ inv: { meat: 3 } })
  const after = snap({ inv: { meat: 2 } })
  assert.equal(spec.verify(before, after, { item: 'meat' }).ok, true)
  const same = spec.verify(before, before, { item: 'meat' })
  assert.equal(same.ok, false)
  assert.equal(same.reason, 'inventory_unchanged')
})

test('cook 核对 —— 背包有任何变化就算成功（放材料少 / 拿成品多）', () => {
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

test('cook 核对 —— 背包没变要判失败', () => {
  const spec = ACTION_SPECS.cook
  const same = snap({ inv: { meat: 2 } })
  const v = spec.verify(same, same, {})
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'inventory_unchanged')
})

test('4 个工具的描述必须讲清用途与引用方式', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]))
  assert.match(byName.container_take.description, /箱子|冰箱/, 'container_take 要说清是拿容器')
  assert.match(byName.container_take.description, /#N/, 'container_take 要说明用 #N')
  assert.match(byName.container_put.description, /放进/, 'container_put 要说清是放进容器')
  assert.match(byName.give.description, /给/, 'give 要说清是给东西')
  assert.match(byName.cook.description, /锅/, 'cook 要说清是锅')
  assert.match(byName.cook.description, /40 秒|等/, 'cook 要提醒要等')
})

test('仍然没有开放 build / recipes / lookup / probe', () => {
  const names = new Set(TOOLS.map((t) => t.name))
  for (const bad of ['pick', 'act', 'heal', 'night_watch', 'store']) {
    assert.ok(!names.has(bad), `${bad} 不该出现（本批没开放）`)
  }
})


// ─────────────────────────── 高级建造与配方查询 ───────────────────────────
// SURVIVAL-06：第三批下半（build / recipes / lookup / probe）






const NEW_S6 = ['build', 'recipes', 'lookup', 'probe']

test('4 个新动作都在白名单里，都有 riskLevel 与 verify', () => {
  for (const name of NEW_S6) {
    assert.ok(OPEN_ACTIONS.includes(name), `${name} 应该在白名单里`)
    const spec = ACTION_SPECS[name]
    assert.ok(spec, `${name} 应该有规格`)
    assert.ok(['R1', 'R2'].includes(spec.riskLevel))
    assert.equal(typeof spec.verify, 'function', `${name} 必须有结果核对`)
  }
})

test('build 的 recipe 必填且只能是小写字母', () => {
  const spec = ACTION_SPECS.build
  assert.equal(validateArgs(spec, {}).ok, false, 'build 要传 recipe')
  assert.equal(validateArgs(spec, { recipe: 'campfire' }).ok, true)
  assert.equal(validateArgs(spec, { recipe: 'Campfire' }).ok, false, '大写要拒')
  assert.equal(validateArgs(spec, { recipe: 'camp fire' }).ok, false, '空格要拒')
})

test('build 的核对只认白名单里的五个建筑', () => {
  const spec = ACTION_SPECS.build
  const s = { nearby: { buckets: {} }, player: { inventory: { items: [] } } }
  const v = spec.verify(s, s, { recipe: 'evil_structure' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'recipe_not_allowed')
})

test('build 核对 —— 附近多了这个建筑算成功', () => {
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

test('S6-4b：build 核对 —— 别名转换（chest 对应 treasurechest，sciencemachine 对应 researchlab）', () => {
  const spec = ACTION_SPECS.build
  const before = { nearby: { buckets: { structures: [] } }, player: { inventory: { items: [] } } }
  const afterChest = {
    nearby: { buckets: { structures: [{ ref: '#1', prefab: 'treasurechest', position: { x: 1, z: 1 } }] } },
    player: { inventory: { items: [] } },
  }
  const vChest = spec.verify(before, afterChest, { recipe: 'chest' })
  assert.equal(vChest.ok, true)
  assert.equal(vChest.product, 'chest')

  const afterSm = {
    nearby: { buckets: { structures: [{ ref: '#1', prefab: 'researchlab', position: { x: 1, z: 1 } }] } },
    player: { inventory: { items: [] } },
  }
  const vSm = spec.verify(before, afterSm, { recipe: 'sciencemachine' })
  assert.equal(vSm.ok, true)
  assert.equal(vSm.product, 'sciencemachine')
})

test('build 核对 —— 建筑没进附近列表、只有材料被扣 → **不算成功**', () => {
  // 任务书明确禁止："不允许仅因背包材料减少就认为建造成功"。
  // 材料可能被别的动作吃掉、建造可能中途失败、产物也可能放下后立刻被拆 —— 所以只认建筑实体。
  const spec = ACTION_SPECS.build
  const before = { nearby: { buckets: {} }, player: { inventory: { items: [{ prefab: 'cutgrass', count: 2 }, { prefab: 'twigs', count: 3 }] } } }
  const after = { nearby: { buckets: {} }, player: { inventory: { items: [] } } }
  const v = spec.verify(before, after, { recipe: 'campfire' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'build_not_found')
})

test('build 核对 —— 建筑没出现、材料也没扣 → 判失败', () => {
  const spec = ACTION_SPECS.build
  const same = { nearby: { buckets: {} }, player: { inventory: { items: [{ prefab: 'log', count: 2 }] } } }
  const v = spec.verify(same, same, { recipe: 'campfire' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'build_not_found')
})

test('recipes / lookup / probe 是只读的（核对不判死）', () => {
  const s = {}
  assert.equal(ACTION_SPECS.recipes.verify(s, s, {}).ok, true)
  assert.equal(ACTION_SPECS.lookup.verify(s, s, { q: 'axe' }).ok, true)
  assert.equal(ACTION_SPECS.probe.verify(s, s, { prefab: 'flint' }).ok, true)
})

test('lookup 的 q 必填；probe 的 prefab 必填且 radius 有上下限', () => {
  assert.equal(validateArgs(ACTION_SPECS.lookup, {}).ok, false)
  assert.equal(validateArgs(ACTION_SPECS.lookup, { q: 'axe' }).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.probe, {}).ok, false)
  assert.equal(validateArgs(ACTION_SPECS.probe, { prefab: 'flint' }).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.probe, { prefab: 'flint', radius: 41 }).ok, false)
  assert.equal(validateArgs(ACTION_SPECS.probe, { prefab: 'flint', radius: 3 }).ok, false)
})

test('recipes 的 limit 有上限（防止一次列出几百条）', () => {
  const spec = ACTION_SPECS.recipes
  assert.equal(validateArgs(spec, {}).ok, true)
  assert.equal(validateArgs(spec, { limit: 30 }).ok, true)
  assert.equal(validateArgs(spec, { limit: 61 }).ok, false)
  assert.equal(validateArgs(spec, { limit: 0 }).ok, false)
})

test('4 个工具的描述必须讲清用途', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]))
  assert.match(byName.build.description, /造一个建筑|建筑/, 'build 要说清是建造')
  assert.match(byName.build.description, /campfire/, 'build 要列出能造什么')
  assert.match(byName.recipes.description, /查配方|配方/, 'recipes 要说清查配方')
  assert.match(byName.lookup.description, /查游戏数据|查/, 'lookup 要说清查数据')
  assert.match(byName.probe.description, /探测|附近/, 'probe 要说清是探测')
  // build 的 enum 必须和 dispatcher 白名单**同源**（TARGET-REFRESH：直接引用 BUILDABLE_RECIPES，
  // 不再手抄一份 —— 以前抄的 5 项漏了 researchlab，模型填原生名会被 schema 拒）
  assert.deepEqual(
    [...byName.build.inputSchema.properties.recipe.enum].sort(),
    [...BUILDABLE_RECIPES].sort(),
  )
  assert.ok(BUILDABLE_RECIPES.includes('sciencemachine'), '科学机器必须能造')
})

test('S6-11：全部常用动作都开放后，工具表里不该出现"野生"动作名', () => {
  const names = new Set(TOOLS.map((t) => t.name))
  for (const bad of ['pick', 'act', 'heal', 'night_watch', 'store', 'take', 'go_to', 'make_fire', 'add_fuel']) {
    assert.ok(!names.has(bad), `${bad} 不该出现`)
  }
})

