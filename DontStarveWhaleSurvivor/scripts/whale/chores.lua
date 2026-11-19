-- 生活家务宏（Chores：日常生存、采备料、添柴、搜食、采花等）
--
-- 架构设计原则（对标 Sei 的 reflexes.lua + chores.lua）：
-- 1. 严格职责分离：
--    - Reflex（反射）：只处理“3 秒内必死”的保命事件（天黑举火把、挨打/残血撤退、饿死前啃一口现成食物）。
--    - Chores（家务宏）：负责日常囤料、添柴、搜食、采花、收纳等生活事务。
-- 2. 受控执行，绝不偷跑抢占：
--    - 家务宏绝不挂在 Reflex 帧循环里自作主张（见缝插针抢占是角色停顿、漫游乱跑、actor_busy 的罪魁祸首）。
--    - 家务宏提供 Whale.chores 内部函数供游戏内测试与受控循环调用；其注册的 Action 属于内部作业（Internal Jobs），
--      不向 Node 端 ACTION_SPECS / LLM 工具表暴露，外部统一走原子动作与层级技能。
-- 3. 权威一致性：
--    - 所有外部命令必须通过 Node Dispatcher 下发并接受 Guard 校验，Chores 内部逻辑不破坏租约与双重闸门。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall or pcall
local tonumber = GLOBAL.tonumber or tonumber

local A = Whale.actions
local U = Whale.util

local C = {}
Whale = Whale or {}
Whale.chores = C

local RESERVE_TORCHES = 2   -- 平时备好两把火把的材料
local SEEK_MAX_TILES = 22   -- 家务移动单步上限

-- ─────────────────────────── 辅助查找函数 ───────────────────────────

local function exact_ready(p, prefab, radius)
    return U.find_nearest(p, radius, { "pickable" }, nil, function(e)
        if e.prefab ~= prefab then return false end
        local pick = e.components ~= nil and e.components.pickable or nil
        return pick ~= nil and pick:CanBePicked()
    end)
end

local function ready_ground_material(p, wanted, radius)
    return U.find_nearest(p, radius, nil, { "INLIMBO", "fire" }, function(e)
        if e.components == nil or e.components.inventoryitem == nil then return false end
        return wanted[e.prefab] == true
    end)
end

local function ready_ground_food(p, radius)
    local rules = Whale ~= nil and Whale.eatrules or nil
    return U.find_nearest(p, radius, nil, { "INLIMBO", "fire" }, function(e)
        if e.components == nil or e.components.inventoryitem == nil then return false end
        local ed = e.components.edible
        if ed == nil then return false end
        if rules ~= nil and not rules.IsSafeToEat(e) then return false end
        return true
    end)
end

local function ready_food_plant(p, radius)
    local rules = Whale ~= nil and Whale.eatrules or nil
    return U.find_nearest(p, radius, nil, nil, function(e)
        if e.components == nil then return false end
        if e.components.crop ~= nil and e.components.crop:IsReadyForHarvest() then return true end
        if e.components.harvestable ~= nil and e.components.harvestable:CanBeHarvested() then return true end
        if e.components.pickable ~= nil and e.components.pickable:CanBePicked() then
            local prod = e.components.pickable.product
            if prod ~= nil then
                if rules ~= nil and type(rules.IsAllowedPrefab) == "function" then
                    return rules.IsAllowedPrefab(prod)
                elseif rules ~= nil and type(rules.IsSafePrefab) == "function" then
                    return rules.IsSafePrefab(prod)
                else
                    return true
                end
            end
        end
        return false
    end)
end

local function push_pick(p, ent)
    if ent == nil or p == nil then return false end
    local act = GLOBAL.BufferedAction(p, ent, GLOBAL.ACTIONS.PICK)
    pcall(function() p.components.locomotor:PushAction(act, true) end)
    return true
end

local function push_harvest(p, ent)
    if ent == nil or p == nil then return false end
    local act = GLOBAL.BufferedAction(p, ent, GLOBAL.ACTIONS.PICK)
    pcall(function() p.components.locomotor:PushAction(act, true) end)
    return true
end

local function push_pickup(p, ent)
    if ent == nil or p == nil then return false end
    local act = GLOBAL.BufferedAction(p, ent, GLOBAL.ACTIONS.PICKUP)
    pcall(function() p.components.locomotor:PushAction(act, true) end)
    return true
end

local function say(p, text)
    pcall(function()
        if p ~= nil and p.components ~= nil and p.components.talker ~= nil then
            p.components.talker:Say(text, 2)
        end
    end)
end

-- ─────────────────────────── 家务宏 1：备齐火把材料 ───────────────────────────

--- 检查背包材料，不够时按优先级拾取地上现成物、采摘周围资源、或安全靠近远处资源
function C.stock_light_materials(p, max_tiles)
    p = p or U.player()
    if p == nil then return false, "no_player" end

    local cr = Whale ~= nil and Whale.craftrules or nil
    local cost = cr ~= nil and cr.NeededIngredients("torch") or { cutgrass = 2, twigs = 2 }
    local counts = cr ~= nil and cr.Counts(p) or {}

    local candidates = {}
    local wanted = {}
    for prefab, need in pairs(cost) do
        local want = need * RESERVE_TORCHES
        if (counts[prefab] or 0) < want then
            wanted[prefab] = true
            local source = nil
            if prefab == "cutgrass" then source = "grass"
            elseif prefab == "twigs" then source = "sapling" end
            if source ~= nil then
                candidates[#candidates + 1] = { prefab = prefab, source = source, want = want }
            end
        end
    end

    if #candidates == 0 then
        return true, "reserve_ok"
    end

    table.sort(candidates, function(a, b) return a.prefab < b.prefab end)

    -- 1. 优先捡地上现成的材料（12 格内）
    local ground = ready_ground_material(p, wanted, 12)
    if ground ~= nil and push_pickup(p, ground) then
        say(p, "捡起地上现成的火把材料：" .. tostring(ground.prefab))
        return true, "pickup_ground"
    end

    -- 2. 采摘 16 格内成熟的草丛或树苗
    for _, c in ipairs(candidates) do
        local target = exact_ready(p, c.source, 16)
        if target ~= nil then
            if push_pick(p, target) then
                say(p, c.source == "grass" and "采草储备火把材料" or "采树枝储备火把材料")
                return true, "pick_" .. c.source
            end
        end
    end

    -- 3. 若近处没有，但在白天且安全时，有界移动靠近（<= 22 格）
    local limit_tiles = max_tiles or SEEK_MAX_TILES
    local px, _, pz = U.pos(p)
    if px ~= nil then
        for _, c in ipairs(candidates) do
            local target = exact_ready(p, c.source, 28)
            if target ~= nil then
                local tx, _, tz = U.pos(target)
                if tx ~= nil then
                    local dx, dz = tx - px, tz - pz
                    local tiles = math.sqrt(dx * dx + dz * dz) / U.TILE
                    if tiles > 16 and tiles <= limit_tiles then
                        local gx, gz = U.tile_of(tx, tz)
                        local started = A.Start("move_to", { x = gx, z = gz, timeout = 8 }, "chore")
                        if started then
                            say(p, "走过去采" .. (c.source == "grass" and "草" or "树枝"))
                            return true, "move_to_" .. c.source
                        end
                    end
                end
            end
        end
    end

    return false, "no_nearby_materials"
end

-- ─────────────────────────── 家务宏 2：火堆添柴 ───────────────────────────

function C.fuel_fire(p, max_dist)
    p = p or U.player()
    if p == nil then return false, "no_player" end

    local fire = U.find_nearest(p, max_dist or 12, { "fire" }, nil, function(e)
        local fueled = e.components ~= nil and e.components.fueled or nil
        if fueled == nil or fueled:IsEmpty() then return false end
        local percent = fueled:GetPercent()
        return percent ~= nil and percent < 0.25
    end)
    if fire == nil then return false, "no_low_fire" end

    local started = A.Start("add_fuel", {}, "chore")
    if started then
        say(p, "给火堆添点柴")
        return true, "adding_fuel"
    end
    return false, "fuel_action_failed"
end

-- ─────────────────────────── 家务宏 3：搜寻采集食物 ───────────────────────────

function C.forage_food(p)
    p = p or U.player()
    if p == nil then return false, "no_player" end

    -- 优先采成熟植物
    local plant = ready_food_plant(p, 16)
    if plant ~= nil and push_harvest(p, plant) then
        say(p, "采收食物：" .. (U.pretty(plant) or "食物"))
        return true, "harvest_plant"
    end

    -- 其次拾取地上食物
    local food = ready_ground_food(p, 14)
    if food ~= nil and push_pickup(p, food) then
        say(p, "捡起地上食物：" .. tostring(food.prefab))
        return true, "pickup_food"
    end

    return false, "no_food_nearby"
end

-- ─────────────────────────── 家务宏 4：采花补理智 ───────────────────────────

function C.pick_flowers(p)
    p = p or U.player()
    if p == nil then return false, "no_player" end

    local flower = exact_ready(p, "flower", 16)
    if flower ~= nil and push_pick(p, flower) then
        say(p, "采朵花调节心情")
        return true, "picked_flower"
    end
    return false, "no_flowers_nearby"
end

-- ─────────────────────────── 家务宏 5：白天收纳火把 ───────────────────────────

function C.stow_light(p)
    p = p or U.player()
    if p == nil then return false, "no_player" end

    local rules = Whale ~= nil and Whale.equiprules or nil
    local hand = rules ~= nil and rules.HandItem(p) or nil
    if hand == nil then return true, "hand_already_empty" end

    local hand_name = tostring(hand.prefab or "")
    local LIGHTS = { torch = true, lantern = true, minerhat = true }
    if not LIGHTS[hand_name] then return false, "not_a_portable_light" end

    local started = A.Start("unequip", { slot = "hands" }, "chore", { survival_unequip = true, slot = "hands" })
    if started then
        say(p, "白天把火把收回背包省燃料")
        return true, "stowing_light"
    end
    return false, "unequip_failed"
end

-- ─────────────────────────── 注册为 Whale Actions (Internal Chore Jobs) ───────────────────────────
-- 说明：此处注册的宏动作属于 Lua 内部保留家务（Internal Jobs），不进入 Node 端 ACTION_SPECS 与 LLM 工具表。
-- 外部控制由原子动作与 SkillExecutor 接管，避免双重调度通道。

A.register("stock_light_materials", function(j, p)
    local ok, reason = C.stock_light_materials(p, j.args ~= nil and j.args.max_tiles or nil)
    if ok then
        return "done", "家务完成：" .. tostring(reason)
    else
        return "failed", "家务未成：" .. tostring(reason)
    end
end)
A.register("chore_stock_light", function(j, p)
    local ok, reason = C.stock_light_materials(p, j.args ~= nil and j.args.max_tiles or nil)
    return ok and "done" or "failed", tostring(reason)
end)

A.register("chore_fuel", function(j, p)
    local ok, reason = C.fuel_fire(p, j.args ~= nil and j.args.radius or nil)
    return ok and "done" or "failed", tostring(reason)
end)

A.register("chore_forage", function(j, p)
    local ok, reason = C.forage_food(p)
    return ok and "done" or "failed", tostring(reason)
end)

A.register("chore_pick_flowers", function(j, p)
    local ok, reason = C.pick_flowers(p)
    return ok and "done" or "failed", tostring(reason)
end)

A.register("chore_stow_light", function(j, p)
    local ok, reason = C.stow_light(p)
    return ok and "done" or "failed", tostring(reason)
end)

return C
