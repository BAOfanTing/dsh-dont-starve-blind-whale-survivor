-- 进食白名单（SURVIVAL-01 / eat）：只能吃背包里、有 edible 组件的白名单食物
--
-- 为什么还要白名单：edible 组件在**很多**东西上（包括怪物肉、腐烂物、甚至某些特殊物品）。
-- 如果只判"有没有 edible"，等于把"吃什么"完全交给模型，而吃错东西（怪物肉掉理智、
-- 腐烂物掉血）在早期是致命的。所以只放行几种**基础、安全、可预期**的食物。
--
-- 依据（本机 scripts.zip 实测）：edible 组件默认 foodtype = GENERIC；
--   浆果 berries：foodtype VEGGIE，hunger 9.375，perishtime 有；烤浆果 cooked berries 更好
--   胡萝卜 carrot：foodtype VEGGIE
--   烤过的（*_cooked）一律比生的补得多
-- 这里只放行"生的基础素食"，把"要不要烤"留给以后（本阶段不做烹饪）。
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local tostring = tostring
local type = type

local E = {}

--- 允许手动吃的 prefab（值 = 中文名，回执用）
---
--- 注意：这里放行不等于"自动挑食物时也会吃"。生蘑菇的代价见 AUTO_SAFE：
---   生红蘑菇 -20 血、生绿蘑菇 -50 理智、生蓝蘑菇 -15 理智。
--- 保命反射/自动 eat 不能为了 +12.5 饥饿把角色送进更危险的状态。
E.FOODS = {
    berries = "浆果",
    berries_juicy = "多汁浆果",
    carrot = "胡萝卜",
    corn = "玉米",
    pumpkin = "南瓜",
    eggplant = "茄子",
    red_cap = "红蘑菇",
    blue_cap = "蓝蘑菇",
    green_cap = "绿蘑菇",
    green_cap_cooked = "烤绿蘑菇",
    blue_cap_cooked = "烤蓝蘑菇",
    honey = "蜂蜜",
    meat = "肉",
    smallmeat = "小肉",
    froglegs = "蛙腿",
    fish = "鱼",
    -- 熟食：AI 会用 cook 烤肉/烤菜，烤过的基础食物更安全、回血更多。
    -- 没有这些条目时，烤完反而"不在白名单里"，等于白烤。
    meat_cooked = "熟肉",
    smallmeat_cooked = "熟小肉",
    froglegs_cooked = "熟蛙腿",
    fish_cooked = "熟鱼",
    berries_cooked = "烤浆果",
    berries_juicy_cooked = "烤多汁浆果",
    carrot_cooked = "烤胡萝卜",
    corn_cooked = "烤玉米",
    pumpkin_cooked = "烤南瓜",
    eggplant_cooked = "烤茄子",
    acorn_cooked = "烤桦栗果",
    petals = "花瓣",
}

--- 自动挑食物时的保守白名单（不包含任何生蘑菇）。
--- 手动 eat 仍可指定 E.FOODS 里的蘑菇；蘑菇应该先烤再吃。
E.AUTO_SAFE = {
    berries = true,
    berries_juicy = true,
    carrot = true,
    corn = true,
    pumpkin = true,
    eggplant = true,
    honey = true,
    meat = true,
    smallmeat = true,
    froglegs = true,
    fish = true,
    meat_cooked = true,
    smallmeat_cooked = true,
    froglegs_cooked = true,
    fish_cooked = true,
    berries_cooked = true,
    berries_juicy_cooked = true,
    carrot_cooked = true,
    corn_cooked = true,
    pumpkin_cooked = true,
    eggplant_cooked = true,
    acorn_cooked = true,
    green_cap_cooked = true,
    blue_cap_cooked = true,
    petals = true,
}

--- 明确**不**放行的（写在这里是为了让后来者知道这是刻意的，不是漏了）
E.DENIED = {
    monstermeat = "怪物肉（掉理智和血）",
    spoiled_food = "腐烂物",
    rot = "腐烂物",
    red_cap_cooked = "（烤过的留给以后）",
}

--- 这个 prefab 能不能吃
function E.IsAllowedPrefab(prefab)
    if prefab == nil then return false, "not_food" end
    if E.DENIED[prefab] ~= nil then return false, "food_not_allowed" end
    if E.FOODS[prefab] == nil then return false, "food_not_allowed" end
    return true, nil
end

--- 背包里这个物品实体能不能吃（白名单 + 真实组件）
function E.IsEdible(item)
    if item == nil or type(item) ~= "table" then return false, "item_missing" end
    local prefab = tostring(item.prefab or "")
    local ok_p, why_p = E.IsAllowedPrefab(prefab)
    if not ok_p then return false, why_p end
    if item.components == nil or item.components.edible == nil then return false, "not_edible" end
    return true, nil
end

function E.CanHeal(item)
    local edible = item ~= nil and item.components ~= nil and item.components.edible or nil
    return edible ~= nil and type(edible.healthvalue) == "number" and edible.healthvalue > 0
end

--- 从背包里挑一个**最该吃**的（饥饿越低越优先吃补得多的；这里简单按白名单顺序 + 新鲜度）
--- 注意：这是服务端选择逻辑，模型只能给"要吃哪一类"或干脆不给（自动挑）。
function E.PickBest(inventory, healing_only)
    if inventory == nil then return nil end
    local best, best_score = nil, nil
    local ok = pcall(function()
        inventory:ForEachItem(function(item)
            if item == nil or not item:IsValid() then return end
            local can, _ = E.IsEdible(item)
            if not can then return end
            if E.AUTO_SAFE[item.prefab] ~= true then return end
            if healing_only and not E.CanHeal(item) then return end

            local hunger = 0
            local health = 0
            local edible = item.components ~= nil and item.components.edible or nil
            if edible ~= nil then
                local ok_h, h = pcall(function() return edible.hungervalue end)
                if ok_h and type(h) == "number" then hunger = h end
                local ok_hp, hv = pcall(function() return edible.healthvalue end)
                if ok_hp and type(hv) == "number" then health = hv end
            end

            -- 花瓣等不恢复饥饿的物品，在非回血场景下严禁作为饥饿恢复食物
            if not healing_only and hunger <= 0 then return end

            -- 分数：优先新鲜度高的，其次按白名单里定义的顺序（越靠前越基础）
            local freshness = 1
            local stackable = item.components ~= nil and item.components.perishable or nil
            if stackable ~= nil then
                local ok_f, pct = pcall(function() return stackable:GetPercent() end)
                if ok_f and type(pct) == "number" then freshness = pct end
            end
            -- 残血时优先吃回血的（熟肉 +20 血，浆果 0）：回血值加权，但别盖过新鲜度/饥饿。
            local score = freshness * 10 + hunger + math.max(0, health) * 4
            if best_score == nil or score > best_score then best, best_score = item, score end
        end)
    end)
    if not ok then return nil end
    return best
end

--- 背包里所有可吃的东西（给诊断/回执用）
function E.ListEdible(inventory)
    local out = {}
    if inventory == nil then return out end
    pcall(function()
        inventory:ForEachItem(function(item)
            if item == nil or not item:IsValid() then return end
            local can = E.IsEdible(item)
            if can then
                out[#out + 1] = { prefab = tostring(item.prefab), label = E.FOODS[item.prefab] or tostring(item.prefab) }
            end
        end)
    end)
    return out
end

-- ─────────────────────────── TARGET-REFRESH：失败时把"真实背包"回给模型 ───────────────────────────
--
-- 真机证据（session.txt）：Reflex 在 07:57:51 / 08:01:26 把胡萝卜吃掉，模型凭**上轮记忆**继续
-- eat carrot，收到一句光秃秃的 `not_in_inventory`，不知道该改什么，于是反复猜了十几次。
-- 需求：eat 失败时必须返回**当前真实可食用物品及其正确 prefab 名**。

--- 地上植株 prefab → 采下来的**物品** prefab。
--- 模型最容易在这里搞混：背包里显示"绿蘑菇"时物品名是 green_cap，
--- 而它传的 green_mushroom 是**地上那株植物**（harvestrules 的表）。
E.PLANT_TO_ITEM = {
    red_mushroom = "red_cap",
    green_mushroom = "green_cap",
    blue_mushroom = "blue_cap",
    berrybush = "berries",
    berrybush2 = "berries",
    berrybush_juicy = "berries_juicy",
    carrot_planted = "carrot",
}

--- 把模型给的（可能是错的）名字映射到白名单里的正确 prefab；映射不出来返回 nil。
--- 只做"指路"，不改变放行规则 —— 映射出来的名字仍然要过 IsAllowedPrefab。
function E.SuggestPrefab(name)
    if name == nil then return nil end
    local key = tostring(name)
    if key == "" then return nil end
    if E.FOODS[key] ~= nil then return key end
    local lower = string.lower(key)
    if E.FOODS[lower] ~= nil then return lower end
    local mapped = E.PLANT_TO_ITEM[lower]
    if mapped ~= nil and E.FOODS[mapped] ~= nil then return mapped end
    if E.FOODS[lower .. "_cooked"] ~= nil then return lower .. "_cooked" end
    return nil
end

--- 一个物品占几格（读不到就按 1；绝不因为读不到就当成 0）
local function stack_count(item)
    local st = item ~= nil and item.components ~= nil and item.components.stackable or nil
    if st == nil then return 1 end
    local ok, v = pcall(function() return st:StackSize() end)
    if ok and type(v) == "number" and v > 0 then return v end
    return 1
end

--- 背包里"有 edible 但不在白名单"的（怪物肉、腐烂物、种子……）。
--- 为什么要说这些：真机里模型反复猜名字，很大一部分原因是回执只说"没有白名单食物"，
--- 它看不见背包里到底有什么，就继续瞎试。把"有什么、为什么不能吃"一起说出来，它才会改主意。
local NOT_AUTO_EAT_NOTE = "不能自动吃"

function E.ListDeniedEdibles(inventory, limit)
    local out, counts, order = {}, {}, {}
    if inventory == nil then return out end
    local max = tonumber(limit) or 5
    pcall(function()
        inventory:ForEachItem(function(item)
            if item == nil or not item:IsValid() then return end
            if item.components == nil or item.components.edible == nil then return end
            local prefab = tostring(item.prefab or "")
            if E.FOODS[prefab] ~= nil then return end
            if counts[prefab] == nil then
                counts[prefab] = 0
                order[#order + 1] = prefab
            end
            counts[prefab] = counts[prefab] + stack_count(item)
        end)
    end)
    table.sort(order)
    for i = 1, #order do
        if #out >= max then break end
        local prefab = order[i]
        local why = E.DENIED[prefab] or NOT_AUTO_EAT_NOTE
        out[#out + 1] = string.format("%s×%d（%s）", prefab, counts[prefab], why)
    end
    return out
end

--- 背包里**真正**能吃的东西（带数量），拼成一句给模型看的话。
--- 这是"当前真实值"，不是模型记忆里的值。
function E.DiagnoseHint(inventory)
    if inventory == nil then return "读不到背包" end
    local counts, order = {}, {}
    pcall(function()
        inventory:ForEachItem(function(item)
            if item == nil or not item:IsValid() then return end
            local can = E.IsEdible(item)
            if not can then return end
            local prefab = tostring(item.prefab)
            if counts[prefab] == nil then
                counts[prefab] = 0
                order[#order + 1] = prefab
            end
            local n = stack_count(item)
            counts[prefab] = counts[prefab] + n
        end)
    end)

    -- 顺带把"有但吃不了"的也列出来（同样只在失败回执里用，不参与任何放行判断）
    local denied = E.ListDeniedEdibles(inventory, 5)
    local denied_text = #denied > 0 and ("；另外背包里有（都不在可吃白名单）：" .. table.concat(denied, "、")) or ""

    if #order == 0 then
        return "背包里现在没有白名单食物（生蘑菇要先用 cook 烤，或者去捡地上的安全食物）" .. denied_text
    end
    table.sort(order)
    local parts = {}
    for _, prefab in ipairs(order) do
        local safe = E.AUTO_SAFE[prefab] == true
        parts[#parts + 1] = string.format("%s×%d（%s%s）", prefab, counts[prefab],
            E.FOODS[prefab] or prefab, safe and "，可自动吃" or "，需手动指定")
    end
    return "背包里现在真正能吃的：" .. table.concat(parts, "、") .. denied_text
end

Whale.eatrules = E
