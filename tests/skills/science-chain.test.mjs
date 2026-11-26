// 第一阶段科技链（TARGET-REFRESH §4）：造出科学机器 → 站到它旁边 → 做第一阶段配方
//
// 为什么要单独一个文件：
//   §4 的验收不是"白名单里有没有 rope"，而是**整条链能不能走通**：
//     ① build sciencemachine 能真的把 researchlab 放到地上（并且**必须有建筑实体**才算成功）
//     ② 放下去之前/之后，craft rope 的科技判定会跟着变（recipe_locked → 放行）
//     ③ 材料数字读的是原版 AllRecipes，不是我们抄的表
//   现有测试只验了"别名能解析"和"白名单一致"，没验这条链。
//
// 证据类型：
//   · UNIT        —— Node 侧 build 核对（必须有建筑实体，材料变少不算）
//   · INTEGRATION —— fengari 里跑真实 crafting.lua 的 build_by_ctx + guard 的 craft 分支
//                    （假实体，**不是真机**；真机验收见 docs/TARGET-REFRESH.md）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ACTION_SPECS, validateArgs } from '../../lib/dispatcher.js'
import { TOOLS } from '../../lib/tools.js'
import { BUILDABLE_RECIPES } from '../../lib/actions/specs/crafting.js'
import { MOD, loadTargets } from '../helpers/target-harness.mjs'

const craftingLua = readFileSync(join(MOD, 'scripts', 'whale', 'actions', 'crafting.lua'), 'utf8')
const craftrulesLua = readFileSync(join(MOD, 'scripts', 'whale', 'craftrules.lua'), 'utf8')

// ─────────────────────────── Node 侧（UNIT）───────────────────────────

test('SM-1：build 白名单含 sciencemachine，工具 enum 也含它', () => {
  const spec = ACTION_SPECS.build
  assert.ok(spec, '要有 build 规格')
  const tool = TOOLS.find((t) => t.name === 'build')
  assert.ok(tool, '工具表要有 build')
  assert.ok(tool.inputSchema.properties.recipe.enum.includes('sciencemachine'),
    `build 的 enum 要能选 sciencemachine，实际 ${tool.inputSchema.properties.recipe.enum}`)
  assert.equal(validateArgs(spec, { recipe: 'sciencemachine' }).ok, true)
  assert.equal(validateArgs(spec, { recipe: 'researchlab' }).ok, true, '原生名也要收（别名等价）')
  for (const bad of ['goldenaxe', 'transistor', 'marble']) {
    assert.equal(validateArgs(spec, { recipe: bad }).ok, false, `${bad} 不该能 build`)
  }
})

test('SM-2：建造成功**必须有建筑实体** —— 科学机器也一样，材料变少不算', () => {
  const spec = ACTION_SPECS.build
  // 材料被扣（4 木板 + 4 石头 + 1 金块），但附近没出现 researchlab
  const before = {
    nearby: { buckets: { structures: [] } },
    player: { inventory: { items: [
      { prefab: 'boards', count: 4 }, { prefab: 'rocks', count: 4 }, { prefab: 'goldnugget', count: 1 },
    ] } },
  }
  const afterNoBuilding = { nearby: { buckets: { structures: [] } }, player: { inventory: { items: [] } } }
  const bad = spec.verify(before, afterNoBuilding, { recipe: 'sciencemachine' })
  assert.equal(bad.ok, false, '材料没了但机器没出现 → 不能算成功')
  assert.equal(bad.reason, 'build_not_found')

  // 真的出现了 researchlab（别名）→ 才算成功
  const afterOk = {
    nearby: { buckets: { structures: [{ ref: '#1', prefab: 'researchlab', distance: 1, position: { x: 1, z: 1 } }] } },
    player: { inventory: { items: [] } },
  }
  const ok = spec.verify(before, afterOk, { recipe: 'sciencemachine' })
  assert.equal(ok.ok, true)
  assert.equal(ok.made, 1)
  assert.equal(ok.product, 'sciencemachine')
})

test('SM-3：build 的别名链在 Lua 侧也是同一套（sciencemachine → researchlab）', () => {
  // crafting.lua 的 BUILD_ALLOWED 与 RECIPE_ALIASES 必须都覆盖 sciencemachine
  assert.match(craftingLua, /sciencemachine\s*=\s*true/, 'build 实现的白名单要有 sciencemachine')
  assert.match(craftingLua, /RECIPE_ALIASES\[name\]/, '放置时要用别名算"期望的建筑 prefab"')
  // core.lua 的别名表是唯一来源
  const core = readFileSync(join(MOD, 'scripts', 'whale', 'actions', 'core.lua'), 'utf8')
  assert.match(core, /sciencemachine\s*=\s*"researchlab"/, 'core.lua 的别名表要 sciencemachine → researchlab')
  // 材料数字必须走原版 AllRecipes（researchlab = 1 金块 + 4 木 + 4 石）
  assert.match(craftrulesLua, /GLOBAL\.AllRecipes/, '材料要读原版配方表')
})

// ─────────────────────────── Lua 侧（INTEGRATION）───────────────────────────

test('SM-4（INTEGRATION）：build sciencemachine 真的把 researchlab 放到地上才算 done', async () => {
  const env = await loadTargets({})
  env.buildNearby()
  // 让假 builder 记录 MakeRecipe，并在"放下"之后把建筑加进世界（模拟原生 BUILD 动作完成）
  env.run(`
    MADE = {}
    local placed = false
    PLAYER.components.builder.CanBuild = function() return true end
    PLAYER.components.builder.MakeRecipe = function(self, recipe, pt, rot, skin)
      MADE[#MADE + 1] = { name = recipe and recipe.name or "?", x = pt and pt.x or nil, z = pt and pt.z or nil }
      -- 原生：排队之后由 BUILD 动作把实体放到地上
      if not placed then
        placed = true
        WORLD[#WORLD + 1] = mkent({ prefab = "researchlab", guid = 501,
                                    x = pt and pt.x or 0, z = pt and pt.z or 0 })
      end
      return true
    end
  `)
  env.run(`
    Whale.actions.Start("build", { recipe = "sciencemachine" }, "c-build-sm", { survival_build = true, build_recipe = "sciencemachine" })
    for i = 1, 30 do
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
    WORLDN = #WORLD
  `)
  // 回执由 bridge.Report 记下来（harness 覆盖了它）
  const rep = env.report()
  assert.match(String(rep.text), /把 sciencemachine 放下了/, `build 应该报"放下了"，实际 ${JSON.stringify(rep)}`)
  assert.equal(env.get('WORLDN'), '1', '世界里的建筑数应该 +1')
  env.run('OUT = tostring(MADE[1] and MADE[1].name or "nil")')
  const madeName = env.get('OUT')
  assert.equal(madeName, 'researchlab', `MakeRecipe 应该拿到原生配方 researchlab（别名解析），实际 ${madeName}`)
})

test('SM-12（INTEGRATION）：从零材料到科学机器 —— 砍树拿 log、挖矿拿 rocks/gold，再 build 成功', async () => {
  // 这是用户要的完整链：背包空 → 砍 1 棵树（log 4）+ 挖 1 块金矿（rocks/goldnugget）→ build sciencemachine。
  // 验的是"材料真的够、build 真的放下 researchlab"，而不是各段单独能跑。
  const env = await loadTargets({})
  env.run(`
    -- 一棵要砍 2 下的树 + 一块要挖 2 下的金矿（rock2 = gold_vein）
    TREE = (function()
      local e = mkent({ prefab = "evergreen", guid = 601, x = 1, z = 0, work = "CHOP" })
      local left = 2
      local action = { id = "CHOP" }
      local w = {}
      function w.hit() left = left - 1; if left <= 0 then action = { id = "DIG" } end end
      setmetatable(w, { __index = function(_, k)
        if k == "workleft" then return left end
        if k == "action" then return action end
        return nil end })
      e.components.workable = w
      return e
    end)()
    ROCK = (function()
      local e = mkent({ prefab = "rock2", guid = 611, x = 1, z = 1, work = "MINE" })
      local left = 2
      local action = { id = "MINE" }
      local w = {}
      function w.hit() left = left - 1; if left <= 0 then e.valid = false end end
      setmetatable(w, { __index = function(_, k)
        if k == "workleft" then return left end
        if k == "action" then return action end
        return nil end })
      e.components.workable = w
      return e
    end)()
    WORLD = { TREE, ROCK }
    -- 斧头 + 镐都在背包里
    AXE = mkent({ prefab = "axe", guid = 700, x = 0, z = 0, pickup = true })
    AXE.components.finiteuses = { GetUses = function() return 100 end }
    AXE.components.tool = { CanDoAction = function(_, act) return act ~= nil and act.id == "CHOP" end }
    PICK = mkent({ prefab = "pickaxe", guid = 701, x = 0, z = 0, pickup = true })
    PICK.components.finiteuses = { GetUses = function() return 100 end }
    PICK.components.tool = { CanDoAction = function(_, act) return act ~= nil and act.id == "MINE" end }
    ITEMS = { AXE, PICK }
    PLAYER.components.inventory.GetEquippedItem = function() return AXE end
    PLAYER.components.inventory.Equip = function() end
    PLAYER.components.playercontroller = { remote_controls = {} }
    -- 砍/挖掉出来的产物直接"进背包"（模拟 PICKUP 成功）
    INV = {}
    local real_pa = PLAYER.components.locomotor.PushAction
    PLAYER.components.locomotor.PushAction = function(self, ba, run)
      if ba ~= nil and ba.action ~= nil then
        if ba.action.id == "CHOP" and TREE.components.workable.workleft ~= nil then
          TREE.components.workable.hit()
          if TREE.components.workable.action.id == "DIG" then
            -- 树倒：掉 4 个 log
            for i = 1, 4 do WORLD[#WORLD + 1] = mkent({ prefab = "log", guid = 950 + i, x = 1, z = 0, pickup = true }) end
          end
        elseif ba.action.id == "MINE" and ROCK.valid then
          ROCK.components.workable.hit()
          if not ROCK.valid then
            for i = 1, 4 do WORLD[#WORLD + 1] = mkent({ prefab = "rocks", guid = 960 + i, x = 1, z = 1, pickup = true }) end
            WORLD[#WORLD + 1] = mkent({ prefab = "goldnugget", guid = 970, x = 1, z = 1, pickup = true })
          end
        elseif ba.action.id == "PICKUP" and ba.target ~= nil then
          INV[ba.target.prefab] = (INV[ba.target.prefab] or 0) + 1
          ba.target.limbo = true
          for i = #WORLD, 1, -1 do if WORLD[i] == ba.target then table.remove(WORLD, i) end end
        end
      end
      return real_pa(self, ba, run)
    end
  `)
  env.buildNearby()
  // ① 砍树
  env.run(`
    Whale.actions.Start("chop", { target_kind = "tree" }, "c-1", { target = TREE })
    for i = 1, 40 do
      NOW = NOW + 0.2
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
    LOGS = INV["log"] or 0
  `)
  // ② 挖金矿
  env.run(`
    Whale.actions.Start("mine", { target_kind = "gold_vein" }, "c-2", { target = ROCK })
    for i = 1, 40 do
      NOW = NOW + 0.2
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
    OUT = tostring(LOGS) .. "|" .. tostring(INV["rocks"] or 0) .. "|" .. tostring(INV["goldnugget"] or 0)
  `)
  const [logs, rocks, gold] = env.get('OUT').split('|').map(Number)
  assert.ok(logs >= 4, `砍完树应该拿到 ≥4 log，实际 ${logs}`)
  assert.ok(rocks >= 4, `挖完金矿应该拿到 ≥4 rocks，实际 ${rocks}`)
  assert.ok(gold >= 1, `挖完金矿应该拿到 ≥1 goldnugget，实际 ${gold}`)
  // ③ 材料齐了 → build 应该能过材料检查（这里只验"不再报 ingredients_missing"）
  env.run(`
    PLAYER.components.builder.CanBuild = function() return true end
    PLAYER.components.builder.MakeRecipe = function() return true end
    Whale.actions.Start("build", { recipe = "sciencemachine" }, "c-3", { survival_build = true, build_recipe = "sciencemachine" })
    for i = 1, 10 do
      NOW = NOW + 0.2
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
  `)
  const rep = env.report()
  assert.doesNotMatch(String(rep.text), /ingredients_missing/,
    `材料齐了就不该报缺料，实际 ${rep.text}`)
})

test('SM-13（INTEGRATION）：真机形态 —— 机器造好了、人站在旁边，craft rope 必须放行', async () => {
  // 真机踩到（2026-11-16）：`build sciencemachine` 成功、probe 确认 researchlab 就在 0.7 格，
  // 但 `craft rope` 仍报 recipe_locked —— 因为 guard 当时用 `KnowsRecipe`，
  // 它不认"站在科学机器旁边"的临时科技（要靠 UpdateTempTechBonuses 刷新，
  // 而那个刷新由玩家 controller 驱动，服务端 actor 上经常还没刷到）。
  // 同一角色用 `lookup rope`（走 `CanBuild`）却显示"现在就能做" —— 自相矛盾。
  const items = [
    `(function() local it = { prefab = "cutgrass", components = { stackable = { StackSize = function() return 3 end } } } it.IsValid = function() return true end return it end)()`,
  ]
  // ① 游戏说能造（CanBuild = true，模拟"站在机器旁 + 材料够"）→ 必须放行
  const ok = await loadTargets({ items, knowsRecipe: true })
  ok.buildNearby()
  ok.setCmd(ok.cmd({ action: 'craft', args: { recipe: 'rope' }, snapshot_id: null, target_ref: null }))
  const out = ok.validate()
  assert.equal(out.split('|')[0], 'true', `站在机器旁应该能造 rope，实际 ${out}`)

  // ② 游戏说不能造、而且身边**没有** prototyper → 才报 recipe_locked
  const locked = await loadTargets({ items, knowsRecipe: false })
  locked.buildNearby()
  locked.setCmd(locked.cmd({ action: 'craft', args: { recipe: 'rope' }, snapshot_id: null, target_ref: null }))
  const lockedOut = locked.validate()
  assert.equal(lockedOut.split('|')[0], 'false', `实际 ${lockedOut}`)
  assert.equal(lockedOut.split('|')[1], 'recipe_locked', `实际原因 ${lockedOut}`)
})

test('SM-14：craft 的判定顺序 —— 材料先报（精确），科技后报（不互相顶替）', () => {
  // 真机踩过：缺 1 个燧石却报"科技没解锁"。
  // 原因是用 CanBuild 判科技，而 CanBuild 也含材料 → 材料不足被误报成 recipe_locked。
  // 所以 guard 里必须**先** MissingIngredients、**后**判科技。
  const guard = readFileSync(join(MOD, 'scripts', 'whale', 'guard.lua'), 'utf8')
  const craftBlock = guard.slice(guard.indexOf('if action == "craft" then'))
  const missingIdx = craftBlock.indexOf('cr.MissingIngredients(actor, recipe)')
  const knowIdx = craftBlock.indexOf('cr.CanCraftNow(actor, recipe)')
  assert.ok(missingIdx > 0, '要调 MissingIngredients')
  assert.ok(knowIdx > 0, '科技判定要调 cr.CanCraftNow（允许多打一层 -- 注释描述）')
  assert.ok(missingIdx < knowIdx, '材料判定必须在科技判定之前（否则缺料会被误报成 recipe_locked）')
  // 兜底：CanCraftNow 说 false 时要看身边有没有 prototyper，有就不拦
  assert.match(craftBlock, /HasNearbyPrototyper/, '要有"身边有没有科学机器"的兜底')
})

test('SM-15（INTEGRATION）：真机形态 —— KnowsRecipe 说不认识、CanBuild 说能做，执行层必须放行', async () => {
  // 真机（2026-11-17）：guard 放行之后，**执行层** actions/crafting.lua 又用
  // `builder:KnowsRecipe` 拦了一次，回执是「recipe_locked: 还不会做 rope（需要先解锁）」。
  // KnowsRecipe 不算"站在科学机器旁边"的临时科技，CanBuild 才算 —— 所以两边都必须用 CanBuild。
  const items = [
    `(function() local it = { prefab = "cutgrass", components = { stackable = { StackSize = function() return 3 end } } } it.IsValid = function() return true end return it end)()`,
  ]
  const env = await loadTargets({ items, knowsRecipe: false, canBuild: true })
  env.buildNearby()
  env.run(`
    MADE = {}
    PLAYER.components.builder.MakeRecipe = function(self, recipe, pt, rot, skin)
      MADE[#MADE + 1] = recipe and recipe.name or "?"
      BUFFERED = { action = { id = "BUILD" } }
      return true
    end
    PLAYER.components.builder.HasIngredients = function() return true end
    Whale.actions.Start("craft", { recipe = "rope" }, "c-rope", { survival_craft = true, recipe = "rope" })
    BUFFERED = nil
    for i = 1, 6 do
      Whale.actions.Tick()
      BUFFERED = nil
      if Whale.actions.Current() == nil then break end
    end
    OUT = table.concat(MADE, ",")
  `)
  const rep = env.report()
  const made = env.get('OUT')
  assert.doesNotMatch(String(rep.text), /recipe_locked/,
    `CanBuild 说能做就不该再报 recipe_locked，实际 ${rep.text}`)
  assert.match(made, /rope/, `应该真的走到 MakeRecipe，实际调用 ${made || '(无)'}`)
})

test('SM-16：科技判定只允许有一处 —— guard 与执行层都必须调 craftrules.CanCraftNow', () => {
  // 真机这个 bug 犯了两次：先修 guard，执行层又拦。根因就是"两处各写一份判定"。
  // 这条测试盯死：谁都不许再自己写 KnowsRecipe 的科技判定。
  const guard = readFileSync(join(MOD, 'scripts', 'whale', 'guard.lua'), 'utf8')
  const crafting = readFileSync(join(MOD, 'scripts', 'whale', 'actions', 'crafting.lua'), 'utf8')
  const rules = readFileSync(join(MOD, 'scripts', 'whale', 'craftrules.lua'), 'utf8')

  assert.match(rules, /function C\.CanCraftNow/, 'craftrules 必须提供统一的 CanCraftNow')
  assert.match(rules, /function C\.HasNearbyPrototyper/, 'craftrules 必须提供 prototyper 兜底查询')
  assert.match(rules, /builder:CanBuild/, 'CanCraftNow 内部要用原版 CanBuild（认临时科技）')

  assert.match(guard, /cr\.CanCraftNow/, 'guard 必须调 CanCraftNow')
  assert.match(crafting, /rules\.CanCraftNow/, '执行层也必须调 CanCraftNow')

  // 不许再有"自己写一套科技门"。规则：
  //   ① guard / 动作层都不许直接调 CanBuild 做门禁（那要走 CanCraftNow）
  //   ② KnowsRecipe **只允许显式带第二参 true**（= 忽略临时科技，用于"永久解锁了吗"这类展示）；
  //      默认调用会把"站在科学机器旁"混进"已解锁"，正是真机上误判的根源。
  const stripComments = (src) => src.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  const guardCode = stripComments(guard)
  const craftingCode = stripComments(crafting)
  assert.doesNotMatch(guardCode, /builder:CanBuild/, 'guard 不该自己调 CanBuild（走 CanCraftNow）')
  assert.doesNotMatch(guardCode, /builder:KnowsRecipe/, 'guard 不该自己调 KnowsRecipe')
  for (const [who, code] of [['guard', guardCode], ['crafting', craftingCode]]) {
    const calls = code.match(/builder:KnowsRecipe\([^)]*\)/g) ?? []
    for (const c of calls) {
      assert.match(c, /,\s*true\)$/, `${who} 里的 ${c} 必须显式传第二参 true（忽略临时科技）`)
    }
  }
})

test('SM-5（INTEGRATION）：不会造（远离科学机器）→ recipe_locked；游戏说会造 → 放行', async () => {
  const items = [
    // rope = cutgrass 3
    `(function() local it = { prefab = "cutgrass", components = { stackable = { StackSize = function() return 3 end } } } it.IsValid = function() return true end return it end)()`,
  ]
  // ① 游戏说"不会做"（模拟不在科学机器旁边）
  const locked = await loadTargets({ items, knowsRecipe: false })
  locked.buildNearby()
  locked.setCmd(locked.cmd({ action: 'craft', args: { recipe: 'rope' }, snapshot_id: null, target_ref: null }))
  const lockedOut = locked.validate()
  assert.equal(lockedOut.split('|')[0], 'false', `实际 ${lockedOut}`)
  assert.equal(lockedOut.split('|')[1], 'recipe_locked', `实际原因 ${lockedOut}`)
  assert.match(lockedOut.split('|')[3], /sciencemachine|科学机器/, '要告诉模型先建科学机器')

  // ② 游戏说"会做"（模拟站在科学机器旁边）→ 材料够就应该放行
  const ok = await loadTargets({ items, knowsRecipe: true })
  ok.buildNearby()
  ok.setCmd(ok.cmd({ action: 'craft', args: { recipe: 'rope' }, snapshot_id: null, target_ref: null }))
  const okOut = ok.validate()
  assert.equal(okOut.split('|')[0], 'true', `站在机器旁边应该能造 rope，实际 ${okOut}`)
})

test('SM-6（INTEGRATION）：五个第一阶段配方的材料数字都来自原版 AllRecipes（不是兜底表）', async () => {
  // 假环境里 AllRecipes 只声明了 torch/axe/rope/armorwood；其余走兜底表。
  // 这里验：**原生表里有 rope 时，数字用原生的**（3 草），改了兜底表也不会影响。
  const env = await loadTargets({ items: [] })
  env.buildNearby()
  env.run('OUT = table.concat((function() local t = {} for k, v in pairs(Whale.craftrules.NeededIngredients("rope")) do t[#t+1] = k .. "=" .. v end table.sort(t) return t end)(), ",")')
  assert.equal(env.get('OUT'), 'cutgrass=3', 'rope 应该是原版的 cutgrass×3')
  env.run('OUT = table.concat((function() local t = {} for k, v in pairs(Whale.craftrules.NeededIngredients("armorwood")) do t[#t+1] = k .. "=" .. v end table.sort(t) return t end)(), ",")')
  assert.equal(env.get('OUT'), 'log=8,rope=2', 'armorwood 应该是原版的 log×8 + rope×2')
})

test('SM-8：prefab 名允许数字 —— 石头真名就是 rock1 / rock2（真机 probe 踩过 bad_format）', () => {
  // 真机证据：probe {"prefab":"rock1"} → bad_format:prefab。
  // 原因是两边正则都只写了 [a-z_]，而游戏里带数字的 prefab 一大把。
  const info = readFileSync(join('lib', 'actions', 'specs', 'info.js'), 'utf8')
  const gather = readFileSync(join('lib', 'actions', 'specs', 'gathering.js'), 'utf8')
  const movement = readFileSync(join('lib', 'actions', 'specs', 'movement.js'), 'utf8')
  for (const [name, text] of [['info.js', info], ['gathering.js', gather], ['movement.js', movement]]) {
    assert.doesNotMatch(text, /'\^\[a-z_\]\{1,32\}\$'/, `${name} 的 prefab 正则不该再挡数字`)
  }
  assert.match(info, /prefab: \{ type: 'string', pattern: '\^\[a-z0-9_\]\{1,32\}\$'/, 'probe 的 prefab 要允许数字')

  // 真的能通过校验
  assert.equal(validateArgs(ACTION_SPECS.probe, { prefab: 'rock1' }).ok, true, 'rock1 必须能 probe')
  assert.equal(validateArgs(ACTION_SPECS.probe, { prefab: 'rock2' }).ok, true, 'rock2 必须能 probe')
  assert.equal(validateArgs(ACTION_SPECS.probe, { prefab: 'rock_ice' }).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.seek, { prefab: 'rock1' }).ok, true, 'seek 也要能找 rock1')
  assert.equal(validateArgs(ACTION_SPECS.gather_area, { prefab: 'berrybush2' }).ok, true, 'berrybush2 要能采')
  // 但仍然不许奇怪字符（没有放宽安全）
  for (const bad of ['Rock1', 'rock 1', 'rock-1', 'rock1; rm -rf /', '']) {
    assert.equal(validateArgs(ACTION_SPECS.probe, { prefab: bad }).ok, false, `${JSON.stringify(bad)} 不该通过`)
  }
})

test('SM-10：科学机器的材料是**原木 log**，不是木板 boards —— 说明书不能写错', () => {
  // 原版 recipes.lua: Recipe2("researchlab", {goldnugget 1, log 4, rocks 4}, TECH.NONE)
  // 之前 Lua 注释和工具定义的说明都写成"4 木板"，模型照这个去准备会做一堆 boards，
  // 而 boards 本身要 TECH.SCIENCE_ONE（得先有机器）—— 死循环。
  // 工具定义已从 tools.js 抽到 lib/actions/tool-defs.js（纯搬移）。
  const tools = readFileSync(join('lib', 'actions', 'tool-defs.js'), 'utf8')
  // build 在 cook 之后，所以要从 build 起始位置切到下一个工具定义
  const start = tools.indexOf("name: 'build'")
  assert.ok(start > 0, '找不到 build 工具定义')
  const rest = tools.slice(start + 10)
  const nextTool = rest.indexOf("name: '")
  const buildDesc = rest.slice(0, nextTool > 0 ? nextTool : rest.length)
  assert.match(buildDesc, /4 log/, 'build 说明里科学机器要写 log 4')
  assert.match(buildDesc, /4 rocks/, '要写 rocks 4')
  assert.match(buildDesc, /1 goldnugget/, '要写 goldnugget 1')
  assert.doesNotMatch(buildDesc, /4 木板/, '不能写"4 木板"（那是错的，会误导模型）')

  const craftingLua = readFileSync(join(MOD, 'scripts', 'whale', 'actions', 'crafting.lua'), 'utf8')
  const smLine = craftingLua.split('\n').filter((l) => l.includes('sciencemachine = true'))[0]
  assert.match(smLine, /log 4/, `Lua 注释也要写 log 4，实际 ${smLine}`)
  assert.doesNotMatch(smLine, /4 木板/, 'Lua 注释不能写"4 木板"')

  // 兜底表/原生表读出来的材料也必须是 log（不是 boards）
  const spec = ACTION_SPECS.build
  assert.ok(spec, 'build 规格存在')
  assert.ok(BUILDABLE_RECIPES.includes('sciencemachine'), 'sciencemachine 在 build 白名单里')
})

test('SM-11：build 的工具 enum 与 BUILDABLE_RECIPES 同源（不许各写一份）', () => {
  const tool = TOOLS.find((t) => t.name === 'build')
  assert.deepEqual(tool.inputSchema.properties.recipe.enum, BUILDABLE_RECIPES,
    'build 的 enum 必须直接引用 BUILDABLE_RECIPES')
  assert.deepEqual(ACTION_SPECS.build.args.recipe.enum, BUILDABLE_RECIPES)
})

test('SM-9：Lua 侧同样允许数字（否则 Node 放行、Lua 拒，模型会看到莫名其妙的 bad_format）', () => {
  const guard = readFileSync(join(MOD, 'scripts', 'whale', 'guard_specs.lua'), 'utf8')
  assert.match(guard, /prefab = \{ type = "string", pattern = "\^\[a-z0-9_\]\+\$"/, 'Lua 的 prefab 也要允许数字')
  // target_kind 是我们自己的固定枚举，保持严格（不许数字）
  const kindRules = guard.match(/target_kind = \{ type = "string", pattern = "([^"]+)"/g) ?? []
  assert.ok(kindRules.length >= 5, `应该有 5 条 target_kind 规则，实际 ${kindRules.length}`)
  for (const rule of kindRules) {
    assert.match(rule, /\^\[a-z_\]\+\$/, `target_kind 不该允许数字：${rule}`)
  }
})

test('SM-7（INTEGRATION）：build 缺料必须说清"差什么、差几个"，不是一句"材料不够"', async () => {
  const env = await loadTargets({ items: [] })
  env.buildNearby()
  env.run(`
    MADE_CALLS = 0
    PLAYER.components.builder.CanBuild = function() return false end
    PLAYER.components.builder.HasIngredients = function() return false end
    PLAYER.components.builder.MakeRecipe = function() MADE_CALLS = MADE_CALLS + 1; return true end
    Whale.actions.Start("build", { recipe = "sciencemachine" }, "c-build-no", { survival_build = true, build_recipe = "sciencemachine" })
    for i = 1, 10 do
      Whale.actions.Tick()
      if Whale.actions.Current() == nil then break end
    end
  `)
  const rep = env.report()
  const text = String(rep.text)
  assert.match(text, /ingredients_missing/, `缺料应该报 ingredients_missing，实际 ${text}`)
  // 真机踩到：只回"材料不够"，模型不知道差什么 → 反复盲试。
  // sciencemachine = goldnugget 1 + log 4 + rocks 4，必须逐个报出来。
  assert.match(text, /goldnugget \d+\/1/, `要报出还差几个金块，实际 ${text}`)
  assert.match(text, /log \d+\/4/, `要报出还差几根木头，实际 ${text}`)
  assert.match(text, /rocks \d+\/4/, `要报出还差几块石头，实际 ${text}`)
  assert.doesNotMatch(text, /材料不够$/, '不能只说"材料不够"就完事')
  assert.equal(env.get('MADE_CALLS'), '0', '材料不够时**一次 MakeRecipe 都不该调**')
})

