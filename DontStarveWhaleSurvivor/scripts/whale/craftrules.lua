-- 制作白名单（SURVIVAL-01 / craft）：只放行 3 个有直接生存价值的基础工具
--
-- 依据（本机 scripts.zip 的 scripts/recipes.lua 实测，构建 762172）：
--   Recipe2("axe",     {Ingredient("twigs",1), Ingredient("flint",1)},                       TECH.NONE)
--   Recipe2("pickaxe", {Ingredient("twigs",2), Ingredient("flint",2)},                       TECH.NONE)
--   Recipe2("torch",   {Ingredient("cutgrass",2), Ingredient("twigs",2)},                    TECH.NONE)
--
-- 三者都是 TECH.NONE（不需要科学机器），正好是"开局就能做"的东西。
-- **不放行** campfire / firepit（建筑系统，本阶段明确不做）。
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tostring = tostring
local type = type

local C = {}

--- 白名单配方 → 材料表（**照抄** recipes.lua，不在这里另算）
--- 注意：这里的材料表只用于"提前告诉模型缺什么"；真正扣材料由游戏原生 builder 负责。
C.RECIPES = {
    axe = { ingredients = { twigs = 1, flint = 1 }, label = "斧头" },
    pickaxe = { ingredients = { twigs = 2, flint = 2 }, label = "镐" },
    torch = { ingredients = { cutgrass = 2, twigs = 2 }, label = "火把" },
}

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

--- 缺什么材料（返回 nil = 不缺；否则返回 "ingredients_missing: twigs 1/2, flint 0/1"）
--- 用**真实背包**统计，不信任模型给的数字。
function C.MissingIngredients(player, recipeName)
    local def = C.RECIPES[recipeName]
    if def == nil then return "recipe_not_allowed" end
    local inv = player ~= nil and player.components ~= nil and player.components.inventory or nil
    if inv == nil then return "no_inventory" end

    -- 先统计背包里每种 prefab 的数量
    local counts = {}
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
            counts[p] = (counts[p] or 0) + n
        end)
    end)

    local missing = {}
    for prefab, need in pairs(def.ingredients) do
        local have = counts[prefab] or 0
        if have < need then
            missing[#missing + 1] = string.format("%s %d/%d", prefab, have, need)
        end
    end
    if #missing == 0 then return nil end
    table.sort(missing)
    return "ingredients_missing: " .. table.concat(missing, ", ")
end

--- 背包里每种材料的数量（回执用）
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

Whale.craftrules = C
