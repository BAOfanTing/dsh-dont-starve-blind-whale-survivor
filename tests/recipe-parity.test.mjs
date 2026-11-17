// TARGET-REFRESH §4：科技配方白名单一致性 + 建造证据
//
// 真机证据：`craft rope` 被 recipe_not_allowed 拒绝。审计发现 Node 与 Lua 的白名单**本来就是一致的**
// （rope 两边都没有），缺的是"第一阶段科技"那几个配方。所以本文件盯两件事：
//   1) rope / boards / backpack / spear / armorwood 在 **Node 和 Lua 两边同时**开放，且逐条一致；
//   2) 建造成功**不能**只看"背包材料变少"（任务书明确禁止）。
//
// 证据类型：UNIT（解析 Lua 源码 + Node 规格；不跑游戏）+ INTEGRATION（fengari 跑 guard 的 craft 分支）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ACTION_SPECS, validateArgs } from '../lib/dispatcher.js'
import { TOOLS } from '../lib/tools.js'
import { RECIPE_WHITELIST, CRAFTABLE_RECIPES } from '../lib/actions/specs/crafting.js'
import { MOD, loadTargets } from './target-harness.mjs'

const craftrules = readFileSync(join(MOD, 'scripts', 'whale', 'craftrules.lua'), 'utf8')
const guardLua = readFileSync(join(MOD, 'scripts', 'whale', 'guard.lua'), 'utf8')
const craftingLua = readFileSync(join(MOD, 'scripts', 'whale', 'actions', 'crafting.lua'), 'utf8')

/** 解析 Lua C.RECIPES = { name = { ingredients = {...}, label = "...", tech = "..." }, ... } */
function parseLuaRecipes(text) {
  const block = text.match(/C\.RECIPES = \{([\s\S]*?)\n\}/)
  assert.ok(block, '解析不到 craftrules.lua 的 C.RECIPES')
  const out = {}
  // 逐条抓 "name = { ... }"（到下一个顶层条目为止）
  const entries = block[1].split(/\n\s{4}([a-z_]+) = \{/)
  for (let i = 1; i < entries.length; i += 2) {
    const name = entries[i]
    const body = entries[i + 1]
    const label = body.match(/label = "([^"]*)"/)?.[1] ?? null
    const tech = body.match(/tech = "([A-Z_]+)"/)?.[1] ?? null
    const ingredients = {}
    const ingBlock = body.match(/ingredients = \{([^}]*)\}/)
    if (ingBlock) {
      for (const m of ingBlock[1].matchAll(/([a-z_0-9]+)\s*=\s*(\d+)/g)) ingredients[m[1]] = Number(m[2])
    }
    out[name] = { label, tech, ingredients }
  }
  return out
}

const THE_FIVE = ['rope', 'boards', 'backpack', 'spear', 'armorwood']
const THE_FOUR = ['axe', 'pickaxe', 'torch', 'flowerhat']
/** TENT（2026-11-17）：炼金引擎的材料，也是第一阶段科技 */
const THE_TWO = ['cutstone', 'transistor']
const SCIENCE_ONE = [...THE_FIVE, ...THE_TWO]

test('RP-1：第一阶段科技配方在 Node 与 Lua **两边同时**开放', () => {
  const lua = parseLuaRecipes(craftrules)
  for (const name of SCIENCE_ONE) {
    assert.ok(RECIPE_WHITELIST[name], `Node 白名单缺少 ${name}`)
    assert.ok(lua[name], `Lua 白名单缺少 ${name}`)
  }
  for (const name of THE_FOUR) {
    assert.ok(RECIPE_WHITELIST[name], `Node 白名单缺少 ${name}`)
    assert.ok(lua[name], `Lua 白名单缺少 ${name}`)
  }
  // 不能"顺手"多开别的配方
  assert.deepEqual(Object.keys(RECIPE_WHITELIST).sort(), [...THE_FOUR, ...SCIENCE_ONE].sort())
  assert.deepEqual(Object.keys(lua).sort(), [...THE_FOUR, ...SCIENCE_ONE].sort())
})

test('RP-2：配方名/中文名/科技阶段/兜底材料逐条一致（两边不能各抄一套数字）', () => {
  const lua = parseLuaRecipes(craftrules)
  for (const [name, def] of Object.entries(RECIPE_WHITELIST)) {
    const other = lua[name]
    assert.ok(other, `Lua 缺少 ${name}`)
    assert.equal(other.label, def.label, `${name} 的中文名两边不一致`)
    assert.equal(other.tech, def.tech, `${name} 的科技阶段两边不一致`)
    assert.deepEqual(other.ingredients, def.ingredients, `${name} 的兜底材料两边不一致`)
  }
  // 科技阶段必须和原版 recipes.lua 对得上（SCIENCE_ONE vs NONE）
  for (const name of SCIENCE_ONE) assert.equal(RECIPE_WHITELIST[name].tech, 'SCIENCE_ONE', `${name} 需要科学机器`)
  for (const name of THE_FOUR) assert.equal(RECIPE_WHITELIST[name].tech, 'NONE', `${name} 不需要科技`)
})

test('RP-3：craft 工具/规格的 enum 就是这张白名单（模型照 enum 填就一定在两边都合法）', () => {
  const spec = ACTION_SPECS.craft
  assert.deepEqual(spec.args.recipe.enum, CRAFTABLE_RECIPES)
  const tool = TOOLS.find((t) => t.name === 'craft')
  assert.deepEqual(tool.inputSchema.properties.recipe.enum, CRAFTABLE_RECIPES)
  for (const r of CRAFTABLE_RECIPES) assert.equal(validateArgs(spec, { recipe: r }).ok, true, `${r} 应该合法`)
  for (const bad of ['campfire', 'sciencemachine', 'goldenaxe', 'marble', 'ROPE']) {
    assert.equal(validateArgs(spec, { recipe: bad }).ok, false, `${bad} 不在 craft 白名单里，必须拒`)
  }
})

test('RP-4：材料需求优先读原版 AllRecipes（两边都不自己抄数字）', () => {
  // Lua：C.Ingredients 走 GLOBAL.AllRecipes，读不到才用兜底表
  assert.match(craftrules, /GLOBAL\.AllRecipes/, 'Lua 必须优先读原版配方表')
  assert.match(craftrules, /function C\.NeededIngredients/, 'C.NeededIngredients 是材料需求的唯一出口')
  assert.match(craftrules, /local native = C\.Ingredients/, '原生优先')
  // 消耗上报也不能再用 C.RECIPES[name].ingredients（那是兜底表）
  assert.match(craftingLua, /rules\.NeededIngredients/, 'craft 的消耗上报要走同一份来源')
})

test('RP-5：科技条件交给游戏自己判（KnowsRecipe 会把"附近有科学机器"折算进来）', () => {
  // ★ 修正（2026-11-17 真机）：原来这里断言用 `KnowsRecipe` —— **错了**。
  //   KnowsRecipe 不算"站在科学机器旁边"的临时科技（_tempbonus 靠玩家 controller 刷新），
  //   真机上机器造好了也判"还不会做"。现在统一走 craftrules.CanCraftNow（内部用 CanBuild）。
  assert.match(guardLua, /CanCraftNow/, 'guard 必须问游戏"现在能不能做"（走 CanCraftNow）')
  assert.match(guardLua, /recipe_locked/, '做不了要给明确原因')
  assert.match(guardLua, /sciencemachine/, '第一阶段配方要提示"先建科学机器"')
  // 我们**不**自己复制一套 TECH 表（会和游戏更新漂移）
  assert.doesNotMatch(guardLua, /TECH\.SCIENCE_ONE/, 'Lua 侧不该自己写 TECH 常量表')
  // 判定的实现只允许在 craftrules 一处
  const craftrulesLua = readFileSync(join(MOD, 'scripts', 'whale', 'craftrules.lua'), 'utf8')
  assert.match(craftrulesLua, /builder:CanBuild/, 'CanCraftNow 内部要用原版 CanBuild（认临时科技）')
  assert.match(craftrulesLua, /GLOBAL\.AllRecipes/, '兜底要拿真实 recipe 对象去问 KnowsRecipe')
})

test('RP-6：建造成功必须有建筑实体证据 —— 删掉"材料变少就算成功"那条弱证据', () => {
  const spec = ACTION_SPECS.build
  const before = { nearby: { buckets: {} }, player: { inventory: { items: [{ prefab: 'cutgrass', count: 2 }, { prefab: 'twigs', count: 3 }] } } }
  const after = { nearby: { buckets: {} }, player: { inventory: { items: [] } } }
  const v = spec.verify(before, after, { recipe: 'campfire' })
  assert.equal(v.ok, false, '材料被扣掉不等于建造成功')
  assert.equal(v.reason, 'build_not_found')
  assert.notEqual(v.how, 'materials_consumed')

  // 建筑真的出现在附近 → 才算成功
  const withFire = {
    nearby: { buckets: { structures: [{ ref: '#1', prefab: 'campfire', distance: 1 }] } },
    player: { inventory: { items: [{ prefab: 'cutgrass', count: 0 }] } },
  }
  const ok = spec.verify(before, withFire, { recipe: 'campfire' })
  assert.equal(ok.ok, true)
  assert.equal(ok.made, 1)

  // 源码层面也不能再有"返回这条弱证据"的分支（注释里可以提它，但代码里不许有）
  const craftingJs = readFileSync(join('lib', 'actions', 'specs', 'crafting.js'), 'utf8')
  assert.doesNotMatch(craftingJs, /ok:\s*true[^}]*materials_consumed/, '弱证据分支必须彻底删掉')
  assert.doesNotMatch(craftingJs, /how:\s*'materials_consumed'/, '不能有任何路径返回 materials_consumed')
})

// ─────────────────────────── INTEGRATION（fengari 跑 guard 的 craft 分支）───────────────────────────

test('RP-7（INTEGRATION）：rope 现在能通过 guard（前提是游戏说"会做"且材料够）', async () => {
  const env = await loadTargets({ items: [`(function() local it = { prefab = "cutgrass", components = { stackable = { StackSize = function() return 3 end } } } it.IsValid = function() return true end return it end)()`] })
  env.buildNearby()
  env.setCmd(env.cmd({ action: 'craft', args: { recipe: 'rope' }, snapshot_id: null, target_ref: null }))
  const out = env.validate()
  assert.equal(out.split('|')[0], 'true', `材料够、会做 → 应该放行，实际 ${out}`)
})

test('RP-8（INTEGRATION）：不会做（远离科学机器）→ recipe_locked，并提示先建科学机器', async () => {
  const env = await loadTargets({ items: [`(function() local it = { prefab = "cutgrass", components = { stackable = { StackSize = function() return 3 end } } } it.IsValid = function() return true end return it end)()`], knowsRecipe: false })
  env.buildNearby()
  env.setCmd(env.cmd({ action: 'craft', args: { recipe: 'rope' }, snapshot_id: null, target_ref: null }))
  const out = env.validate()
  assert.equal(out.split('|')[0], 'false', `实际 ${out}`)
  assert.equal(out.split('|')[1], 'recipe_locked', `实际原因 ${out}`)
  assert.match(out.split('|')[3], /sciencemachine|科学机器/, '要告诉模型下一步怎么做')
})

test('RP-9（INTEGRATION）：材料不够 → ingredients_missing，且说的是原版配方表里的数字', async () => {
  const env = await loadTargets({ items: [] })
  env.buildNearby()
  env.setCmd(env.cmd({ action: 'craft', args: { recipe: 'armorwood' }, snapshot_id: null, target_ref: null }))
  const out = env.validate()
  assert.equal(out.split('|')[0], 'false', `实际 ${out}`)
  assert.match(out.split('|')[1], /ingredients_missing/, `实际原因 ${out}`)
  // armorwood = log×8 + rope×2（原版 recipes.lua）
  assert.match(out.split('|')[1], /log 0\/8/, `要报出还差几个，实际 ${out}`)
  assert.match(out.split('|')[1], /rope 0\/2/, `要报出还差几个，实际 ${out}`)
})

test('RP-10（INTEGRATION）：不在白名单的配方（campfire）→ recipe_not_allowed', async () => {
  const env = await loadTargets({ items: [] })
  env.buildNearby()
  env.setCmd(env.cmd({ action: 'craft', args: { recipe: 'campfire' }, snapshot_id: null, target_ref: null }))
  const out = env.validate()
  assert.equal(out.split('|')[0], 'false')
  assert.equal(out.split('|')[1], 'recipe_not_allowed')
})
