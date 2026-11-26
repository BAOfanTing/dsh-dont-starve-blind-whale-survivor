// TARGET-REFRESH §3：食物救援链
//
// 真机证据（session.txt）：
//   · 07:57:51 / 08:01:26 Reflex 把胡萝卜吃掉；模型凭**上轮记忆**继续 eat carrot →
//     收到一句光秃秃的 not_in_inventory，不知道该改什么，反复猜了十几次。
//   · 模型把地上植株 green_mushroom 当成可食物品（物品名其实是 green_cap）→ food_not_allowed。
//   · 背包只有生蘑菇时自动进食 no_food（生蘑菇不在 AUTO_SAFE）。
//   · 附近其实出现过南瓜和多汁浆果，但没有工具去找它们。
//
// 证据类型：
//   · UNIT        —— Node 侧规格 / 核对（不碰 Lua）
//   · INTEGRATION —— fengari 沙箱里跑真实 eatrules/guard/targetrules（假实体，**不是真机**）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ACTION_SPECS } from '../../lib/dispatcher.js'
import { MOD, ents, itemLua, loadTargets } from '../helpers/target-harness.mjs'

// ─────────────────────────── Node 侧（UNIT）───────────────────────────

test('RES-1：eat 的核对只认"真实变化"—— 饥饿上涨 / 该食物变少 / 回血', () => {
  const spec = ACTION_SPECS.eat
  const snap = ({ hunger = 100, items = [] } = {}) => ({
    player: { hunger: { current: hunger, max: 200 }, health: { current: 100, max: 200 }, inventory: { items } },
  })
  // ① 饥饿上涨
  const up = spec.verify(snap({ hunger: 100, items: [{ prefab: 'carrot', count: 1 }] }),
    snap({ hunger: 112, items: [] }), { food: 'carrot' })
  assert.equal(up.ok, true)
  assert.ok(up.hungerGained > 0)
  assert.equal(up.used, 1, '要能看出到底吃掉了几份')
  // ② 饥饿没涨、食物也没少 → 不报成功
  const flat = spec.verify(snap({ hunger: 100, items: [{ prefab: 'carrot', count: 1 }] }),
    snap({ hunger: 100, items: [{ prefab: 'carrot', count: 1 }] }), { food: 'carrot' })
  assert.equal(flat.ok, false)
  assert.equal(flat.reason, 'hunger_unchanged')
  // ③ 回血也算（熟肉那类）
  const heal = spec.verify(snap({ hunger: 200, items: [{ prefab: 'meat_cooked', count: 1 }] }),
    snap({ hunger: 200, items: [] }), { food: 'meat_cooked' })
  assert.equal(heal.ok, true)
})

test('RES-2：eat 回执里的"没核对上"不能被当成成功（Node 侧状态分类）', () => {
  assert.equal(typeof ACTION_SPECS.eat.verify, 'function')
  // eat 不需要 snapshot：它只认背包里的东西，模型不该被逼着先取 #N
  assert.notEqual(ACTION_SPECS.eat.requiresSnapshot, true)
})

test('RES-3：bridge 会把 Lua 给的"可操作说明"（detail.hint）拼进回执文本', () => {
  const bridge = readFileSync(join(MOD, 'scripts', 'whale', 'bridge.lua'), 'utf8')
  assert.match(bridge, /detail\.hint/, 'bridge 的拒绝路径必须把 hint 带给模型')
  assert.match(bridge, /拒绝：/, 'reason 代码不能变（状态分类/去重靠它）')
  // hint 只加在文本里，reason 原样传出去
  assert.match(bridge, /B\.Report\(false, text, id, tostring\(reason\)\)/)
})

// ─────────────────────────── Lua 侧（INTEGRATION）───────────────────────────

test('RES-4（INTEGRATION）：Reflex 吃掉胡萝卜之后，eat(carrot) 用**当前真实背包**判断', async () => {
  // 背包里已经没有胡萝卜了（被 Reflex 吃了），只剩蘑菇
  const env = await loadTargets({
    items: [itemLua('red_cap', { count: 2, edible: true }), itemLua('green_cap', { count: 3, edible: true })],
  })
  env.buildNearby()
  env.setCmd(env.cmd({ action: 'eat', args: { food: 'carrot' }, snapshot_id: null, target_ref: null }))
  const out = env.validate()
  const [ok, why, , hint] = out.split('|')
  assert.equal(ok, 'false', `背包里没有胡萝卜时必须拒，实际 ${out}`)
  assert.equal(why, 'not_in_inventory')
  // ★ 关键：回执要说清"现在真正能吃的"和正确 prefab 名 —— 模型照着就能改主意
  assert.match(hint, /red_cap/, `hint 要列出真实可吃的东西，实际 ${hint}`)
  assert.match(hint, /green_cap/, `hint 要列出真实可吃的东西，实际 ${hint}`)
  assert.match(hint, /现在没有|不要相信/, `hint 要提醒"别信上一轮的背包"，实际 ${hint}`)
})

test('RES-5（INTEGRATION）：把地上植株名当食物名 → 指路到正确的物品名', async () => {
  const env = await loadTargets({ items: [itemLua('green_cap', { count: 2, edible: true })] })
  env.buildNearby()
  for (const [wrong, right] of [['green_mushroom', 'green_cap'], ['blue_mushroom', 'blue_cap'], ['red_mushroom', 'red_cap']]) {
    env.setCmd(env.cmd({ action: 'eat', args: { food: wrong }, snapshot_id: null, target_ref: null }))
    const out = env.validate()
    assert.equal(out.split('|')[1], 'food_not_allowed', `${wrong} 不是可食物品名，实际 ${out}`)
    assert.match(out.split('|')[3], new RegExp(right), `要指路到 ${right}，实际 ${out}`)
  }
})

test('RES-6（INTEGRATION）：背包只有生蘑菇时，自动进食按安全规则返回 no_food', async () => {
  const env = await loadTargets({
    items: [itemLua('green_cap', { count: 6, edible: true }), itemLua('red_cap', { count: 2, edible: true })],
  })
  env.buildNearby()
  env.setCmd(env.cmd({ action: 'eat', args: {}, snapshot_id: null, target_ref: null }))
  const out = env.validate()
  assert.equal(out.split('|')[0], 'false', `生蘑菇不该被自动吃掉，实际 ${out}`)
  assert.equal(out.split('|')[1], 'no_food', `实际 ${out}`)
  const hint = out.split('|')[3]
  assert.match(hint, /green_cap|red_cap/, 'hint 要说清背包里到底有什么')
  assert.match(hint, /cook|烤/, 'hint 要给出下一步（先烤熟）')
  assert.match(hint, /pickup_food|harvest_nearest/, 'hint 要提到去外面找安全食物')
})

test('RES-7（INTEGRATION）：背包里有安全食物时自动进食放行（不因为"有生蘑菇"而误判）', async () => {
  const env = await loadTargets({
    items: [
      itemLua('green_cap', { count: 6, edible: true }),
      itemLua('carrot', { count: 1, edible: true, hunger: 12.5 }),
    ],
  })
  env.buildNearby()
  env.setCmd(env.cmd({ action: 'eat', args: {}, snapshot_id: null, target_ref: null }))
  const out = env.validate()
  assert.equal(out.split('|')[0], 'true', `有胡萝卜应该放行，实际 ${out}`)
})

test('RES-8（INTEGRATION）：地面上出现南瓜 / 多汁浆果时，pickup_food 能实时找到', async () => {
  // 南瓜 1.5 格、多汁浆果 2 格（都在"手边 2.5 格"之内）→ 默认 safe_ground_food 应该挑更近的南瓜
  const env = await loadTargets({
    entities: [ents.pumpkin({ x: 6, z: 0 }), ents.berriesJuicy({ x: 8, z: 0 })],
  })
  env.buildNearby()
  env.setCmd(env.cmd({ action: 'pickup_food', args: {}, snapshot_id: null, target_ref: null }))
  let out = env.validate()
  assert.equal(out.split('|')[0], 'true', `pickup_food 应该能找到地面食物，实际 ${out}`)
  assert.equal(out.split('|')[4], 'pumpkin', '默认应该挑更近的南瓜')

  // 指定只捡多汁浆果 → 就算南瓜更近也必须挑对类别
  env.setCmd(env.cmd({ action: 'pickup_food', args: { target_kind: 'berries_juicy' }, snapshot_id: null, target_ref: null }))
  out = env.validate()
  assert.equal(out.split('|')[0], 'true', `指定多汁浆果应该放行，实际 ${out}`)
  assert.equal(out.split('|')[4], 'berries_juicy')

  // 够不着的要明说（先 move_to），而不是假装没有
  const far = await loadTargets({ entities: [ents.pumpkin({ x: 40, z: 0 })] })
  far.buildNearby()
  far.setCmd(far.cmd({ action: 'pickup_food', args: {}, snapshot_id: null, target_ref: null }))
  const farOut = far.validate()
  assert.equal(farOut.split('|')[1], 'out_of_range')
  assert.match(farOut.split('|')[3], /move_to/)

  // 生蘑菇**不在** safe_ground_food 里（吃了掉理智）
  const onlyMushroom = await loadTargets({ entities: [ents.redCap({ x: 4, z: 0 })] })
  onlyMushroom.buildNearby()
  onlyMushroom.setCmd(onlyMushroom.cmd({ action: 'pickup_food', args: {}, snapshot_id: null, target_ref: null }))
  const mushroomOut = onlyMushroom.validate()
  assert.equal(mushroomOut.split('|')[0], 'false', `生蘑菇不该被自动拾取，实际 ${mushroomOut}`)
  assert.equal(mushroomOut.split('|')[1], 'no_target')
})

test('RES-9（INTEGRATION）：harvest_nearest 跳过未成熟的植株，只采成熟的', async () => {
  // 未成熟的浆果丛更近（0.5 格），成熟的蘑菇在 0.75 格 → 必须采成熟的那一株
  const env = await loadTargets({
    entities: [
      ents.berrybush({ ready: false, x: 2, z: 0 }),
      ents.greenMushroom({ ready: true, x: 3, z: 0 }),
    ],
  })
  env.buildNearby()
  env.setCmd(env.cmd({ action: 'harvest_nearest', args: { target_kind: 'ripe_food_plant' }, snapshot_id: null, target_ref: null }))
  const out = env.validate()
  assert.equal(out.split('|')[0], 'true', `应该找到成熟的那一株，实际 ${out}`)
  assert.equal(out.split('|')[4], 'green_mushroom', '未成熟的浆果丛必须被跳过')

  // 附近全是未成熟 → no_target（不是报错、"未成熟"不是可采目标）
  const unripe = await loadTargets({ entities: [ents.berrybush({ ready: false, x: 2, z: 0 })] })
  unripe.buildNearby()
  unripe.setCmd(unripe.cmd({ action: 'harvest_nearest', args: { target_kind: 'ripe_food_plant' }, snapshot_id: null, target_ref: null }))
  assert.equal(unripe.validate().split('|')[1], 'no_target')
})

test('RES-10（INTEGRATION）：成熟的浆果丛能被采；**同一株未成熟时绝不能采**（#N 路径也拦）', async () => {
  // 成熟：#N + snapshot_id 放行
  const ripe = await loadTargets({ entities: [ents.berrybushJuicy({ ready: true, x: 2, z: 0 })] })
  const snapId = ripe.buildNearby()
  ripe.setCmd(ripe.cmd({ action: 'harvest', args: { target_ref: '#1', snapshot_id: snapId } }))
  assert.equal(ripe.validate().split('|')[0], 'true', '成熟的多汁浆果丛应该能采')

  // 未成熟：同一株，#N 也能看见（观察侧要显示"未成熟"），但执行必须拒
  const unripe = await loadTargets({ entities: [ents.berrybushJuicy({ ready: false, x: 2, z: 0 })] })
  const snapId2 = unripe.buildNearby()
  unripe.run('OUT2 = ""\n'
    + 'for k, list in pairs(BUCKETS) do for _, it in ipairs(list) do '
    + 'if it.prefab == "berrybush_juicy" then OUT2 = tostring(it.harvest_ready) end end end')
  assert.equal(unripe.get('OUT2'), 'false', '未成熟要如实标成 harvest_ready=false（模型看得见）')
  unripe.setCmd(unripe.cmd({ action: 'harvest', args: { target_ref: '#1', snapshot_id: snapId2 } }))
  const out = unripe.validate()
  assert.equal(out.split('|')[0], 'false', `未成熟不该被采，实际 ${out}`)
  assert.equal(out.split('|')[1], 'not_ready', `实际原因 ${out}`)
})

test('RES-11（INTEGRATION）：食物种类不只看 berrybush —— 地上的胡萝卜/蘑菇植株都算', async () => {
  const env = await loadTargets({ entities: [ents.carrotPlanted({ ready: true, x: 2, z: 0 })] })
  env.buildNearby()
  env.setCmd(env.cmd({ action: 'harvest_nearest', args: { target_kind: 'carrot_plant' }, snapshot_id: null, target_ref: null }))
  let out = env.validate()
  assert.equal(out.split('|')[0], 'true', `地里的成熟胡萝卜应该能采，实际 ${out}`)
  assert.equal(out.split('|')[4], 'carrot_planted')

  const mush = await loadTargets({ entities: [ents.greenMushroom({ ready: true, x: 2, z: 0 })] })
  mush.buildNearby()
  mush.setCmd(mush.cmd({ action: 'harvest_nearest', args: { target_kind: 'mushroom' }, snapshot_id: null, target_ref: null }))
  out = mush.validate()
  assert.equal(out.split('|')[0], 'true', `成熟蘑菇植株应该能采，实际 ${out}`)
  assert.equal(out.split('|')[4], 'green_mushroom')
})

test('RES-12（INTEGRATION）：背包里只有"能吃但不许吃"的东西时，回执要把它们和原因一起列出来', async () => {
  // 真机里模型反复猜名字的一大原因：回执只说"没有白名单食物"，它看不见背包里到底有什么。
  const env = await loadTargets({
    items: [
      itemLua('monstermeat', { count: 2, edible: true }),
      itemLua('rot', { count: 1, edible: true }),
    ],
  })
  env.buildNearby()
  env.setCmd(env.cmd({ action: 'eat', args: {}, snapshot_id: null, target_ref: null }))
  const out = env.validate()
  assert.equal(out.split('|')[0], 'false', `实际 ${out}`)
  assert.equal(out.split('|')[1], 'no_food')
  const hint = out.split('|')[3]
  assert.match(hint, /monstermeat×2/, `要说清背包里有什么，实际 ${hint}`)
  assert.match(hint, /rot×1/, `要说清背包里有什么，实际 ${hint}`)
  assert.match(hint, /不在可吃白名单|掉理智/, `要说清为什么不能吃，实际 ${hint}`)
  // 但**绝不能**因此把它们放行
  env.setCmd(env.cmd({ action: 'eat', args: { food: 'monstermeat' }, snapshot_id: null, target_ref: null }))
  const forced = env.validate()
  assert.equal(forced.split('|')[0], 'false', '怪物肉永远不能吃')
  assert.equal(forced.split('|')[1], 'food_not_allowed')
})
