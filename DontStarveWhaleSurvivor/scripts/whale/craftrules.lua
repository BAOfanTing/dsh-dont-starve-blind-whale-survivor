-- 制作白名单（SURVIVAL-01 / craft）+ 配方查询（SURVIVAL-02.1）
--
-- 只放行 3 个有直接生存价值的基础工具。三者都是 TECH.NONE（不需要科学机器）。
-- **不放行** campfire / firepit（建筑系统，不在本阶段范围；reflex 的 make_fire 走独立旧路径）。
--
-- ★ SURVIVAL-02.1：材料需求现在**优先从游戏原生 Recipe 读取**（GLOBAL.AllRecipes）。
--   下面 RECIPES 里的数字只是"读不到原生配方时的兜底"，且只用一份（全项目唯一来源）。
--   依据（本机 scripts.zip scripts/recipes.lua 实测，构建 762172）：
--     Recipe2("axe",     {Ingredient("twigs",1), Ingredient("flint",1)},                     TECH.NONE)
--     Recipe2("pickaxe", {Ingredient("twigs",2), Ingredient("flint",2)},                     TECH.NONE)
--     Recipe2("torch",   {Ingredient("cutgrass",2), Ingredient("twigs",2)},                  TECH.NONE)
--     Recipe2("campfire",{Ingredient("cutgrass",3), Ingredient("log",2)},                    TECH.NONE, {placer=...})
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local tostring = tostring
local type = type
local pairs = pairs

local C = {}

--- 白名单配方 → 兜底材料表（读不到原生配方时才用；正常路径走 C.Ingredients）
---
--- ★ TARGET-REFRESH：科技阶段与配方名**必须和 Node 侧 lib/actions/specs/crafting.js 完全一致**
--- （有 tests/recipe-parity.test.mjs 盯着）。数字全部核对自本机 scripts.zip 的 recipes.lua：
---   rope       cutgrass×3                                          TECH.SCIENCE_ONE
---   boards     log×4                                              TECH.SCIENCE_ONE
---   backpack   cutgrass×4 + twigs×4                                TECH.SCIENCE_ONE
---   spear      twigs×2 + rope×1 + flint×1                          TECH.SCIENCE_ONE
---   armorwood  log×8 + rope×2                                     TECH.SCIENCE_ONE
---   cutstone   rocks×3                                             TECH.SCIENCE_ONE（帐篷链：炼金引擎的材料）
---   transistor goldnugget×2 + cutstone×1                           TECH.SCIENCE_ONE（同上）
---   axe        twigs×1 + flint×1                                   TECH.NONE
---   pickaxe    twigs×2 + flint×2                                   TECH.NONE
---   torch      cutgrass×2 + twigs×2                                TECH.NONE
---   flowerhat  petals×12                                          TECH.NONE
--- 注意：SCIENCE_ONE 那七个**不是**"不需要科技"，而是要站在科学机器旁边才能做 ——
--- 这正是"第一阶段科技"的完整含义。科技条件由游戏自己判（builder:KnowsRecipe 会把
--- 附近的 prototyper 折算成临时科技加成），我们**不复制一套 TECH 表**去猜，免得和游戏更新漂移。
--- ★ TENT（2026-11-17）：cutstone / transistor 是**炼金引擎**（build researchlab2）的材料，
---   炼金引擎又是**帐篷**（build tent）的前置。两个建筑本身在 BUILD_ALLOWED 里，
---   帐篷的科技是 SCIENCE_TWO（要站在炼金引擎旁边），提示语由 C.TechHint 给。
C.RECIPES = {
    axe = { ingredients = { twigs = 1, flint = 1 }, label = "斧头", tech = "NONE" },
    pickaxe = { ingredients = { twigs = 2, flint = 2 }, label = "镐", tech = "NONE" },
    torch = { ingredients = { cutgrass = 2, twigs = 2 }, label = "火把", tech = "NONE" },
    flowerhat = { ingredients = { petals = 12 }, label = "花环", tech = "NONE" },
    -- ── 第一阶段科技（需要科学机器）──
    rope = { ingredients = { cutgrass = 3 }, label = "绳子", tech = "SCIENCE_ONE" },
    boards = { ingredients = { log = 4 }, label = "木板", tech = "SCIENCE_ONE" },
    backpack = { ingredients = { cutgrass = 4, twigs = 4 }, label = "背包", tech = "SCIENCE_ONE" },
    spear = { ingredients = { twigs = 2, rope = 1, flint = 1 }, label = "长矛", tech = "SCIENCE_ONE" },
    armorwood = { ingredients = { log = 8, rope = 2 }, label = "木甲", tech = "SCIENCE_ONE" },
    cutstone = { ingredients = { rocks = 3 }, label = "石砖", tech = "SCIENCE_ONE" },
    transistor = { ingredients = { goldnugget = 2, cutstone = 1 }, label = "电子元件", tech = "SCIENCE_ONE" },
}

--- 配方名 → 科技阶段（只有白名单里的名字有值；Node 侧有同一张表）
function C.TechOf(name)
    local def = C.RECIPES[tostring(name)]
    return def ~= nil and def.tech or nil
end

--- 是不是"要站在科学机器/炼金引擎旁边"的配方（第一阶段及更高）
function C.NeedsScience(name)
    local tech = C.TechOf(name)
    return tech == "SCIENCE_ONE" or tech == "SCIENCE_TWO"
end

--- "还不会做 X" 时给模型的一句可执行提示（按科技阶段分）
function C.TechHint(name)
    local key = tostring(name)
    local tech = C.TechOf(key)
    if tech == "SCIENCE_TWO" then
        return key .. " 要站在**炼金引擎**旁边才能做：先 craft boards/cutstone/transistor，"
            .. "再 build researchlab2（炼金引擎），站到它旁边"
    end
    if tech == "SCIENCE_ONE" then
        return key .. " 是第一阶段科技配方：先 build sciencemachine，站到它旁边再做"
    end
    return key .. " 还没解锁"
end

--- 角色现在**条件上**能不能造这个配方（科技/prototyper 层面，**不看材料**）。
---
--- ★ 真机 bug（2026-11-17）：这个判定原来在 guard 和 actions/crafting.lua **各写一遍**，
---   而且都用了 `builder:KnowsRecipe` —— 它**不算**"站在科学机器旁边"的临时科技
---   （`_tempbonus` 靠玩家 controller 的 UpdateTempTechBonuses 刷新，
---   服务端 actor 上经常还没刷到）。结果机器造好了、人站在 0.7 格内，
---   `craft rope` 仍报 recipe_locked；而同一个角色用 `lookup rope`
---   （走 builder:CanBuild）却显示"现在就能做" —— 自相矛盾。
---
--- 现在**只有这一处**判定，双方都调它：
---   ① `builder:CanBuild(name)` 是原版 UI 判"现在能不能造"的入口，
---      会算上永久解锁 + 临时科技（附近科学机器/远古站）+ 当前 prototyper。
---   ② 它不可用时退回 `KnowsRecipe`（至少能判永久解锁）。
--- 返回：true/false/nil（nil = 判不了，调用方**不要拦**，交给 MakeRecipe 定）， 以及原因。
function C.CanCraftNow(actor, name)
    local builder = actor ~= nil and actor.components ~= nil and actor.components.builder or nil
    if builder == nil then return false, "no_builder" end
    local key = tostring(name)
    local ok_c, can = pcall(function() return builder:CanBuild(key) end)
    if ok_c and can ~= nil then return can == true, nil end
    local all = GLOBAL.AllRecipes
    local recipe_obj = all ~= nil and all[key] or nil
    if recipe_obj ~= nil then
        local ok_k, k = pcall(function() return builder:KnowsRecipe(recipe_obj) end)
        if ok_k then return k == true, nil end
    end
    return nil, nil
end

--- 身边有没有 prototyper（科学机器 / 远古站…），用来给 CanCraftNow 的 false 做兜底。
--- 有些构建/时机下 `CanBuild` 会因为临时科技没刷新而误报 false，这时只要
--- 身边确实有机器就不该拦 —— 真造不出来 `MakeRecipe` 会自己失败（它才是权威）。
function C.HasNearbyPrototyper(actor, radius_tiles)
    if actor == nil then return false end
    local U = Whale ~= nil and Whale.util or nil
    if U == nil or U.find_nearest == nil then return false end
    local found = U.find_nearest(actor, radius_tiles or 8, nil, nil, function(e)
        if e == nil or not e:IsValid() then return false end
        return e.components ~= nil and e.components.prototyper ~= nil
    end)
    return found ~= nil
end

--- 配方名是否在白名单里
function C.IsAllowed(name)
    if name == nil then return false, "recipe_not_allowed" end
    local key = tostring(name)
    if C.RECIPES[key] == nil then return false, "recipe_not_allowed" end
    return true, nil
end

--- 白名单列表（给诊断/工具描述用）
function C.RecipeList()
    local out = {}
    for k in pairs(C.RECIPES) do out[#out + 1] = k end
    table.sort(out)
    return out
end

--- 配方标签（回执用）
function C.Label(name)
    local def = C.RECIPES[tostring(name)]
    return def ~= nil and def.label or tostring(name)
end

--- 这个 Ingredient 是不是"背包里的实物材料"（排除人物材料 health/sanity、科技材料）
local function is_item_ingredient(ing)
    if ing == nil or ing.type == nil then return false end
    local ci = GLOBAL.IsCharacterIngredient
    if type(ci) == "function" then
        local ok, res = pcall(ci, ing.type)
        if ok and res == true then return false end
    end
    local ti = GLOBAL.IsTechIngredient
    if type(ti) == "function" then
        local ok, res = pcall(ti, ing.type)
        if ok and res == true then return false end
    end
    return true
end

--- ★ 从游戏原生 Recipe 读材料需求：返回 { prefab = amount } 或 nil（读不到）。
--- 这是"材料需求"的**唯一真来源**；调用方不要自己再抄一份数字。
function C.Ingredients(recipeName)
    local name = recipeName ~= nil and tostring(recipeName) or nil
    if name == nil then return nil end
    local recipes = GLOBAL.AllRecipes
    if type(recipes) ~= "table" then return nil end
    local recipe = recipes[name]
    if recipe == nil then
        local lower = string.lower(name)
        for k, r in pairs(recipes) do
            if string.lower(tostring(k)) == lower then recipe = r break end
        end
    end
    if recipe == nil then return nil end
    local cost = {}
    local ok = pcall(function()
        for _, ing in pairs(recipe.ingredients or {}) do
            if is_item_ingredient(ing) then
                local t = tostring(ing.type)
                cost[t] = (cost[t] or 0) + (tonumber(ing.amount) or 1)
            end
        end
    end)
    if not ok then return nil end
    -- 空表 = 原生配方没有实物材料（不该发生）；当作读不到，让调用方走兜底
    local count = 0
    for _ in pairs(cost) do count = count + 1 end
    if count == 0 then return nil end
    return cost
end

--- 材料需求：原生优先，读不到才用兜底表（只此一处兜底）
function C.NeededIngredients(recipeName)
    local native = C.Ingredients(recipeName)
    if native ~= nil then return native end
    local def = C.RECIPES[tostring(recipeName)]
    if def == nil then return nil end
    local copy = {}
    for k, v in pairs(def.ingredients) do copy[k] = v end
    return copy
end

--- 背包里每种材料的数量（精确 prefab 匹配，不模糊）
function C.Counts(player)
    local out = {}
    local inv = player ~= nil and player.components ~= nil and player.components.inventory or nil
    if inv == nil then return out end
    pcall(function()
        inv:ForEachItem(function(item)
            if item == nil or not item:IsValid() then return end
            local p = tostring(item.prefab or "")
            local n = 1
            local st = item.components ~= nil and item.components.stackable or nil
            if st ~= nil then
                local ok, v = pcall(function() return st:StackSize() end)
                if ok and type(v) == "number" then n = v end
            end
            out[p] = (out[p] or 0) + n
        end)
    end)
    return out
end

--- 缺什么材料（返回 nil = 不缺；否则返回 "ingredients_missing: twigs 1/2, flint 0/1"）
--- 用**真实背包**统计，不信任模型给的数字。
function C.MissingIngredients(player, recipeName)
    local need = C.NeededIngredients(recipeName)
    if need == nil then return "recipe_not_allowed" end
    local inv = player ~= nil and player.components ~= nil and player.components.inventory or nil
    if inv == nil then return "no_inventory" end

    local counts = C.Counts(player)
    local missing = {}
    for prefab, amount in pairs(need) do
        local have = counts[prefab] or 0
        if have < amount then
            missing[#missing + 1] = string.format("%s %d/%d", prefab, have, amount)
        end
    end
    if #missing == 0 then return nil end
    table.sort(missing)
    return "ingredients_missing: " .. table.concat(missing, ", ")
end

--- 现在能不能做这个配方（只查材料，不查科技/状态；返回 true/false, 缺料说明）
function C.HasIngredients(player, recipeName)
    local missing = C.MissingIngredients(player, recipeName)
    if missing == nil then return true, nil end
    return false, missing
end

--- 做一个配方会不会把"留给火把的材料"吃掉。
--- reserve 是 { prefab = 数量 }（要保住的数量）；返回 true, prefab 表示会破坏。
function C.WouldBreakReserve(player, recipeName, reserve)
    if reserve == nil then return false, nil end
    local need = C.Ingredients(recipeName) or C.NeededIngredients(recipeName)
    if need == nil then return false, nil end
    local counts = C.Counts(player)
    for prefab, amount in pairs(need) do
        local keep = reserve[prefab] or 0
        local have = counts[prefab] or 0
        if have - amount < keep then return true, prefab end
    end
    return false, nil
end

Whale.craftrules = C
