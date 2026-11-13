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
local tostring = tostring
local type = type

local E = {}

--- 允许吃的 prefab（值 = 中文名，回执用）
E.FOODS = {
    berries = "浆果",
    carrot = "胡萝卜",
    corn = "玉米",
    pumpkin = "南瓜",
    eggplant = "茄子",
    red_cap = "红蘑菇",
    blue_cap = "蓝蘑菇",
    green_cap = "绿蘑菇",
    honey = "蜂蜜",
    meat = "肉",
    smallmeat = "小肉",
    froglegs = "蛙腿",
    fish = "鱼",
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

--- 从背包里挑一个**最该吃**的（饥饿越低越优先吃补得多的；这里简单按白名单顺序 + 新鲜度）
--- 注意：这是服务端选择逻辑，模型只能给"要吃哪一类"或干脆不给（自动挑）。
function E.PickBest(inventory)
    if inventory == nil then return nil end
    local best, best_score = nil, nil
    local ok = pcall(function()
        inventory:ForEachItem(function(item)
            if item == nil or not item:IsValid() then return end
            local can, _ = E.IsEdible(item)
            if not can then return end
            -- 分数：优先新鲜度高的，其次按白名单里定义的顺序（越靠前越基础）
            local freshness = 1
            local stackable = item.components ~= nil and item.components.perishable or nil
            if stackable ~= nil then
                local ok_f, pct = pcall(function() return stackable:GetPercent() end)
                if ok_f and type(pct) == "number" then freshness = pct end
            end
            local hunger = 0
            local edible = item.components ~= nil and item.components.edible or nil
            if edible ~= nil then
                local ok_h, h = pcall(function() return edible.hungervalue end)
                if ok_h and type(h) == "number" then hunger = h end
            end
            local score = freshness * 10 + hunger
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

Whale.eatrules = E
