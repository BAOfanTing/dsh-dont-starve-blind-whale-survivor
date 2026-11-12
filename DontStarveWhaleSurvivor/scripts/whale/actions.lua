-- 执行 AI 发来的动作
-- 每个动作是一个小的状态机：找目标 -> 推给游戏的动作系统（和玩家自己点鼠标走的是同一条路）-> 等它做完。
-- 这样体力消耗、动画、掉落、被怪打断都跟手动玩一致，不需要作弊改数据。
local GLOBAL = GLOBAL
-- 饥荒的模组沙箱只给了 pairs/ipairs/print/math/table/type/string/tostring/require/Class，
-- pcall / tonumber / error / os / io 这些得从 GLOBAL（就是 _G）里拿，直接用会报 nil（0.1.0 就是这么崩的）。
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local error = GLOBAL.error
local os = GLOBAL.os or { time = function() return 0 end }
local io = GLOBAL.io

local U = Whale.util
local A = {}

local ACTIONS = GLOBAL.ACTIONS
local EQUIPSLOTS = GLOBAL.EQUIPSLOTS
local Vector3 = GLOBAL.Vector3
local BufferedAction = GLOBAL.BufferedAction

-- 动作 id -> 中文说法（出错时告诉模型“附近没有能砍的东西”）
local WORK_NAMES = {
    CHOP = "砍",
    MINE = "挖矿",
    DIG = "铲",
    HAMMER = "拆",
}

local JOBS = {}
local job = nil

-- ─────────────────────────── 基础 ───────────────────────────

local function busy(p)
    if p == nil then return false end
    if p:GetBufferedAction() ~= nil then return true end
    if p.sg ~= nil and not p.sg:HasStateTag("idle") then return true end
    return false
end
A.busy = busy

local function push(p, ba)
    if p == nil or ba == nil then return false end
    local loco = p.components.locomotor
    if loco ~= nil then
        loco:PushAction(ba, true)
    else
        p:PushBufferedAction(ba)
    end
    return true
end

local function tile_away(p, tx, tz)
    local px, _, pz = U.pos(p)
    if px == nil then return math.huge end
    local x, z = U.tile_center(tx, tz)
    local dx, dz = px - x, pz - z
    return math.sqrt(dx * dx + dz * dz) / U.TILE
end

local function walk_to(p, tx, tz)
    local x, z = U.tile_center(tx, tz)
    local loco = p.components.locomotor
    if loco == nil then return false end
    loco:GoToPoint(Vector3(x, 0, z), nil, false)
    return true
end
A.walk_to = walk_to

local function equip_if_needed(p, item)
    local inv = p.components.inventory
    if inv == nil or item == nil then return end
    if inv:GetEquippedItem(EQUIPSLOTS.HANDS) == item then return end
    pcall(function() inv:Equip(item) end)
end

local function best_tool(p, action)
    local inv = p.components.inventory
    if inv == nil then return nil end
    local best, best_score = nil, -1
    inv:ForEachItem(function(item)
        local tool = item.components.tool
        if tool ~= nil then
            local ok, can = pcall(function() return tool:CanDoAction(action) end)
            if ok and can then
                local uses = item.components.finiteuses
                local score = uses ~= nil and uses:GetUses() or 1000
                if score > best_score then
                    best, best_score = item, score
                end
            end
        end
    end)
    return best
end

local function best_weapon(p)
    local inv = p.components.inventory
    if inv == nil then return nil end
    local best, best_damage = nil, -1
    inv:ForEachItem(function(item)
        local weapon = item.components.weapon
        if weapon ~= nil and weapon.damage ~= nil and weapon.damage > best_damage then
            best, best_damage = item, weapon.damage
        end
    end)
    return best
end

--- 背包里最该吃的：先看能补多少饥饿，再看新鲜度
local function best_food(p)
    local inv = p.components.inventory
    if inv == nil then return nil end
    local best, best_score = nil, -1
    inv:ForEachItem(function(item)
        local edible = item.components.edible
        if edible ~= nil then
            local hunger = edible.hungervalue or 0
            local health = edible.healthvalue or 0
            local perish = item.components.perishable
            local freshness = perish ~= nil and perish:GetPercent() or 1
            local score = (hunger + health * 0.5) * (0.3 + 0.7 * freshness)
            if score > best_score then
                best, best_score = item, score
            end
        end
    end)
    return best
end

--- 按名字找附近的东西：先比 prefab，再比中文名，最后比 tag（"tag:xxx"）
local function find_by_name(p, radius, want)
    local needle = string.lower(tostring(want))
    local tag = nil
    if string.sub(needle, 1, 4) == "tag:" then
        tag = string.sub(needle, 5)
        needle = nil
    end
    local filter
    if tag ~= nil then
        filter = function(e) return e:HasTag(tag) end
    elseif needle ~= nil then
        filter = function(e)
            local prefab = string.lower(e.prefab or "")
            if prefab == needle or string.find(prefab, needle, 1, true) ~= nil then return true end
            local name = string.lower(U.pretty(e))
            return string.find(name, needle, 1, true) ~= nil
        end
    end
    return U.find_all(p, radius, nil, nil, filter)
end

local function find_workable(p, radius, action_id, want)
    if want ~= nil and want ~= "" then
        local list = find_by_name(p, radius, want)
        for _, entry in ipairs(list) do
            local w = entry.ent.components ~= nil and entry.ent.components.workable or nil
            if w ~= nil and w.action ~= nil and w.action.id == action_id then
                return entry.ent
            end
        end
    end
    local ent = U.find_nearest(p, radius, nil, nil, function(e)
        local w = e.components ~= nil and e.components.workable or nil
        return w ~= nil and w.action ~= nil and w.action.id == action_id
    end)
    return ent
end

local function nearest_hostile(p, radius)
    local ent = U.find_nearest(p, radius, { "hostile" }, nil, function(e)
        local h = e.components ~= nil and e.components.health or nil
        return h ~= nil and not h:IsDead()
    end)
    return ent
end

-- ─────────────────────────── 动作 ───────────────────────────

JOBS.move_to = function(j, p)
    local tx = tonumber(j.args.x)
    local tz = tonumber(j.args.z)
    if tx == nil or tz == nil then
        return "fail", "move_to 要传格子坐标 x 和 z，比如 {\"x\":12,\"z\":45}"
    end
    if j.step == "start" then
        walk_to(p, tx, tz)
        j.step = "walk"
        j.data.lastcheck = U.now()
        j.data.retry = 0
    end
    local away = tile_away(p, tx, tz)
    if away <= 1.2 then
        return "done", string.format("走到了 (%d,%d) 附近（还差 %.1f 格）", tx, tz, away)
    end
    local timeout = tonumber(j.args.timeout) or 60
    if U.now() - j.t0 > timeout then
        return "fail", string.format("走不到 (%d,%d)：卡在 %.1f 格外（可能有东西挡着）", tx, tz, away)
    end
    if U.now() - j.data.lastcheck > 2 then
        j.data.lastcheck = U.now()
        local loco = p.components.locomotor
        if loco == nil or not loco:IsMoving() then
            j.data.retry = j.data.retry + 1
            if j.data.retry > 8 then
                return "fail", string.format("被挡死了，站在 %.1f 格外过不去", away)
            end
            walk_to(p, tx, tz)
        end
    end
    return "run"
end

JOBS.go_to = function(j, p)
    local want = j.args.target
    if want == nil or want == "" then
        return "fail", "go_to 要传 target（东西的名字，比如 berrybush、spider、cookpot；也可以用 tag:hostile）"
    end
    if j.step == "start" then
        local radius = tonumber(j.args.radius) or 30
        local list = find_by_name(p, radius, want)
        if #list == 0 then
            return "fail", string.format("附近 %d 格里没找到 %s", radius, tostring(want))
        end
        local ent = list[1].ent
        local x, _, z = U.pos(ent)
        local tx, tz = U.tile_of(x, z)
        j.data.name = U.pretty(ent)
        j.data.tx, j.data.tz = tx, tz
        walk_to(p, tx, tz)
        j.step = "walk"
        j.data.lastcheck = U.now()
    end
    local away = tile_away(p, j.data.tx, j.data.tz)
    if away <= 1.5 then
        return "done", string.format("走到 %s 旁边了 (%.1f 格)", j.data.name, away)
    end
    if U.now() - j.t0 > (tonumber(j.args.timeout) or 90) then
        return "fail", string.format("走不到 %s：卡在 %.1f 格外", j.data.name, away)
    end
    if U.now() - j.data.lastcheck > 2 then
        j.data.lastcheck = U.now()
        local loco = p.components.locomotor
        if loco == nil or not loco:IsMoving() then
            walk_to(p, j.data.tx, j.data.tz)
        end
    end
    return "run"
end

local function job_work(j, p, action_id)
    if j.step == "start" then
        j.data.count = tonumber(j.args.count) or 1
        j.data.done_count = 0
        j.data.radius = tonumber(j.args.radius) or 20
        j.step = "next"
    end
    if j.step == "next" then
        if j.data.done_count >= j.data.count then
            return "done", string.format("连着干了 %d 次", j.data.done_count)
        end
        local target = find_workable(p, j.data.radius, action_id, j.args.target)
        if target == nil then
            if j.data.done_count > 0 then
                return "done", string.format("干了 %d 次，附近没有能再%s的了", j.data.done_count, WORK_NAMES[action_id])
            end
            return "fail", string.format("附近 %d 格里没有能%s的东西", j.data.radius, WORK_NAMES[action_id])
        end
        local action = ACTIONS[action_id]
        if action == nil then return "fail", "这个版本没有这个动作：" .. action_id end
        local item = best_tool(p, action)
        if item ~= nil then equip_if_needed(p, item) end
        local ba = BufferedAction(p, target, action, item)
        j.data.target = target
        j.data.phase_start = U.now()
        j.data.phase_wait = false
        push(p, ba)
        j.step = "acting"
        return "run"
    end
    if j.step == "acting" then
        -- 先等它真正开始，再等它结束
        if not j.data.phase_wait then
            if busy(p) then j.data.phase_wait = true end
            if U.now() - j.data.phase_start > 3 and not j.data.phase_wait then
                -- 3 秒还没动起来，多半是没工具/够不着
                local target = j.data.target
                local w = target ~= nil and target:IsValid() and target.components.workable or nil
                if w ~= nil and w.workleft ~= nil and w.workleft > 0 then
                    return "fail", string.format("推不动 %s：可能需要工具，或者离得太远", U.pretty(target))
                end
            end
            return "run"
        end
        if busy(p) then
            if U.now() - j.data.phase_start > 120 then
                return "fail", "这个活儿做不完（可能工具不对或者够不着）"
            end
            return "run"
        end
        j.data.done_count = j.data.done_count + 1
        j.step = "next"
        return "run"
    end
    return "run"
end

JOBS.chop = function(j, p) return job_work(j, p, "CHOP") end
JOBS.mine = function(j, p) return job_work(j, p, "MINE") end
JOBS.hammer = function(j, p) return job_work(j, p, "HAMMER") end
JOBS.dig = function(j, p) return job_work(j, p, "DIG") end

JOBS.pick = function(j, p)
    if j.step == "start" then
        j.data.count = tonumber(j.args.count) or 1
        j.data.done_count = 0
        j.data.radius = tonumber(j.args.radius) or 12
        j.step = "next"
    end
    if j.step == "next" then
        if j.data.done_count >= j.data.count then
            return "done", string.format("采了 %d 次", j.data.done_count)
        end
        local target = nil
        local action = nil
        local list = U.find_all(p, j.data.radius, nil, nil, function(e)
            -- Pickable 组件没有 CanBePicked 方法：能不能采看标签（barren = 采空了还没长回来）
            if e:HasTag("pickable") and not e:HasTag("barren") then return true end
            local c = e.components
            if c ~= nil and c.harvestable ~= nil then
                local ok, can = pcall(function() return c.harvestable:CanBeHarvested() end)
                if ok and can == true then return true end
            end
            return false
        end)
        if j.args.target ~= nil then
            local by_name = find_by_name(p, j.data.radius, j.args.target)
            list = by_name
        end
        for _, entry in ipairs(list) do
            local ent = entry.ent
            local c = ent.components
            if ent:HasTag("pickable") then
                target, action = ent, ACTIONS.PICK
                break
            elseif c ~= nil and c.harvestable ~= nil then
                target, action = ent, ACTIONS.HARVEST
                break
            end
        end
        if target == nil then
            if j.data.done_count > 0 then
                return "done", string.format("采了 %d 次，附近没有能采的了", j.data.done_count)
            end
            return "fail", string.format("附近 %d 格里没有能采的东西", j.data.radius)
        end
        j.data.name = U.pretty(target)
        push(p, BufferedAction(p, target, action, nil))
        j.data.phase_start = U.now()
        j.data.phase_wait = false
        j.step = "acting"
        return "run"
    end
    if j.step == "acting" then
        if not j.data.phase_wait then
            if busy(p) then j.data.phase_wait = true end
            if U.now() - j.data.phase_start > 30 then
                return "fail", string.format("%s 采不了（可能没了或者够不着）", j.data.name)
            end
            return "run"
        end
        if busy(p) then
            if U.now() - j.data.phase_start > 60 then
                return "fail", "采不动了"
            end
            return "run"
        end
        j.data.done_count = j.data.done_count + 1
        j.step = "next"
        return "run"
    end
    return "run"
end

-- 捡起地上的东西（Phase 5 M3 补遗 / M4 开放：真机确认 ACTIONS.PICKUP 存在后才加的）
JOBS.pickup = function(j, p)
    if j.step == "start" then
        j.data.count = tonumber(j.args.count) or 1
        j.data.done_count = 0
        j.data.radius = tonumber(j.args.radius) or 12
        j.data.want = string.lower(tostring(j.args.item or ""))
        j.step = "next"
    end
    if j.step == "next" then
        if j.data.done_count >= j.data.count then
            return "done", string.format("捡了 %d 个", j.data.done_count)
        end
        -- 掉落物 = 有 inventoryitem 组件且 owner 为 nil（entity_observer 里同一判据）
        local list = U.find_all(p, j.data.radius, nil, nil, function(e)
            local c = e.components
            if c == nil or c.inventoryitem == nil then return false end
            local ok, held = pcall(function() return c.inventoryitem.owner ~= nil end)
            if ok and held then return false end
            if j.data.want == "" then return true end
            local prefab = string.lower(e.prefab or "")
            return string.find(prefab, j.data.want, 1, true) ~= nil
        end)
        local target = list[1] ~= nil and list[1].ent or nil
        if target == nil then
            if j.data.done_count > 0 then
                return "done", string.format("捡了 %d 个，附近没有能捡的了", j.data.done_count)
            end
            return "fail", string.format("附近 %d 格里没有能捡的 %s", j.data.radius,
                j.data.want ~= "" and j.data.want or "东西")
        end
        j.data.name = U.pretty(target)
        push(p, BufferedAction(p, target, ACTIONS.PICKUP, nil))
        j.data.phase_start = U.now()
        j.data.phase_wait = false
        j.step = "acting"
        return "run"
    end
    if j.step == "acting" then
        if not j.data.phase_wait then
            if busy(p) then j.data.phase_wait = true end
            if U.now() - j.data.phase_start > 30 then
                return "fail", string.format("%s 捡不了（可能没了或者够不着）", j.data.name)
            end
            return "run"
        end
        if busy(p) then
            if U.now() - j.data.phase_start > 60 then
                return "fail", "捡不动了"
            end
            return "run"
        end
        j.data.done_count = j.data.done_count + 1
        j.step = "next"
        return "run"
    end
    return "run"
end

JOBS.attack = function(j, p)
    if j.step == "start" then
        local target = nil
        if j.args.target ~= nil and j.args.target ~= "" then
            local list = find_by_name(p, tonumber(j.args.radius) or 20, j.args.target)
            target = list[1] ~= nil and list[1].ent or nil
            if target == nil then return "fail", "附近没找到 " .. tostring(j.args.target) end
        else
            target = nearest_hostile(p, tonumber(j.args.slice) or 12)
            if target == nil then return "fail", "附近没有敌人" end
        end
        j.data.target = target
        j.data.name = U.pretty(target)
        j.data.hits = 0
        j.data.max_hits = tonumber(j.args.count) or 30
        j.data.next_hit = 0
        j.step = "fight"
    end
    local target = j.data.target
    if target == nil or not target:IsValid() then
        return "done", string.format("%s 已经解决了（打了 %d 下）", j.data.name, j.data.hits)
    end
    local health = target.components.health
    if health ~= nil and health:IsDead() then
        return "done", string.format("%s 打死了（%d 下）", j.data.name, j.data.hits)
    end
    local my_health = p.components.health
    if my_health ~= nil and my_health:GetPercent() ~= nil and my_health:GetPercent() < 0.3 then
        local food = best_food(p)
        if food ~= nil then
            push(p, BufferedAction(p, nil, ACTIONS.EAT, food))
            j.data.next_hit = U.now() + 2
            return "run"
        end
        return "fail", "血太少了，打不过就先跑"
    end
    if j.data.hits >= j.data.max_hits then
        return "done", string.format("已经打了 %d 下，%s 还没死", j.data.hits, j.data.name)
    end
    if busy(p) then
        if U.now() - j.t0 > 180 then return "fail", "打不动了" end
        return "run"
    end
    if U.now() < (j.data.next_hit or 0) then return "run" end
    equip_if_needed(p, best_weapon(p))
    push(p, BufferedAction(p, target, ACTIONS.ATTACK, nil))
    j.data.hits = j.data.hits + 1
    j.data.next_hit = U.now() + 0.5
    return "run"
end

JOBS.eat = function(j, p)
    local item = nil
    if j.args.item ~= nil and j.args.item ~= "" then
        item = U.find_item(p, j.args.item)
        if item == nil then return "fail", "背包里没有 " .. tostring(j.args.item) end
    else
        item = best_food(p)
        if item == nil then return "fail", "背包里没有能吃的东西" end
    end
    if item.components.edible == nil then
        return "fail", U.pretty(item) .. " 不能吃"
    end
    if busy(p) then
        if U.now() - j.t0 > 20 then return "fail", "手上正忙着，没吃上" end
        return "run"
    end
    if j.step == "start" then
        j.data.name = U.describe_item(item)
        j.data.hunger_before = p.components.hunger ~= nil and p.components.hunger.current or nil
        push(p, BufferedAction(p, nil, ACTIONS.EAT, item))
        j.step = "acting"
        j.data.phase_start = U.now()
        return "run"
    end
    if busy(p) and U.now() - j.data.phase_start < 20 then return "run" end
    local hunger = p.components.hunger ~= nil and p.components.hunger.current or nil
    local delta = (hunger ~= nil and j.data.hunger_before ~= nil) and (hunger - j.data.hunger_before) or nil
    if delta ~= nil and delta > 0.5 then
        return "done", string.format("吃了 %s，饥饿 +%d", j.data.name, math.floor(delta))
    end
    return "done", "吃了 " .. j.data.name
end

JOBS.cook = function(j, p)
    if j.step == "start" then
        local cooker = U.find_nearest(p, tonumber(j.args.radius) or 12, { "cooker" }, nil, function(e)
            local fuel = e.components ~= nil and e.components.fueled or nil
            return fuel == nil or not fuel:IsEmpty()
        end)
        if cooker == nil then
            return "fail", "附近没有烧着的东西（营火/火坑），先在旁边生个火"
        end
        local ingredient = nil
        if j.args.item ~= nil and j.args.item ~= "" then
            ingredient = U.find_item(p, j.args.item)
        else
            local inv = p.components.inventory
            if inv ~= nil then
                inv:ForEachItem(function(item)
                    if ingredient == nil and item.components.cookable ~= nil then ingredient = item end
                end)
            end
        end
        if ingredient == nil then
            return "fail", "背包里没有能烤/煮的东西"
        end
        if busy(p) then
            if U.now() - j.t0 > 20 then return "fail", "忙着，没烤上" end
            return "run"
        end
        j.data.name = U.pretty(ingredient)
        j.data.cooker = cooker
        push(p, BufferedAction(p, cooker, ACTIONS.COOK, ingredient))
        j.data.phase_start = U.now()
        j.step = "acting"
        return "run"
    end
    if busy(p) and U.now() - j.data.phase_start < 20 then return "run" end
    return "done", string.format("把 %s 放到火上烤了（烤好的东西在火堆旁边/背包里，记得吃掉）", j.data.name)
end

local function recipe_of(name)
    if name == nil then return nil end
    local key = tostring(name)
    local recipes = GLOBAL.AllRecipes or {}
    local recipe = recipes[key]
    if recipe ~= nil then return recipe, key end
    local lower = string.lower(key)
    for k, r in pairs(recipes) do
        if string.lower(k) == lower then return r, k end
    end
    return nil, nil
end

local function missing_ingredients(p, recipe)
    local builder = p.components.builder
    if builder == nil then return "你没有制作组件" end
    local ok, has = pcall(function() return builder:HasIngredients(recipe) end)
    if ok and has then return nil end
    return "材料不够"
end

--- 这块地能不能放下这个东西
local function can_deploy(recipe, x, z)
    local world = GLOBAL.TheWorld
    if world == nil or world.Map == nil then return false end
    local ok, res = pcall(function() return world.Map:CanDeployRecipeAtPoint(Vector3(x, 0, z), recipe, 0) end)
    return ok and res == true
end

--- 没给坐标时，从脚下往外找一个放得下的格子
local function find_spot(p, recipe)
    local px, _, pz = U.pos(p)
    if px == nil then return nil end
    local bx, bz = U.tile_of(px, pz)
    local around = {
        { 0, 0 }, { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 },
        { 1, 1 }, { -1, -1 }, { 1, -1 }, { -1, 1 },
        { 2, 0 }, { -2, 0 }, { 0, 2 }, { 0, -2 },
    }
    for _, d in ipairs(around) do
        local x, z = U.tile_center(bx + d[1], bz + d[2])
        if can_deploy(recipe, x, z) then return bx + d[1], bz + d[2] end
    end
    return nil
end

JOBS.craft = function(j, p)
    if j.step == "start" then
        local recipe, key = recipe_of(j.args.recipe or j.args.name)
        if recipe == nil then
            return "fail", "没有这个配方：" .. tostring(j.args.recipe) .. "（用游戏里的配方名，比如 torch、axe、spear、campfire）"
        end
        local builder = p.components.builder
        if builder == nil then return "fail", "你现在不能制作东西" end
        local ok, knows = pcall(function() return builder:KnowsRecipe(recipe) end)
        if ok and knows == false then
            return "fail", string.format("%s 还不会做（要先做科学机器/靠近它解锁）", key)
        end
        local missing = missing_ingredients(p, recipe)
        if missing ~= nil then
            return "fail", string.format("%s %s", key, missing)
        end
        j.data.recipe, j.data.key = recipe, key
        j.data.placeable = recipe.placer ~= nil
        j.data.count = tonumber(j.args.count) or 1
        j.data.done_count = 0
        j.step = "acting"
    end

    -- 要摆到地上的东西（建筑、火堆）一律走摆放逻辑，那里会挑一块放得下的地
    if j.data.placeable then
        return job_build(j, p)
    end

    if j.data.pending then
        if busy(p) then
            if U.now() - j.t0 > 120 then return "fail", "做东西卡住了" end
            return "run"
        end
        j.data.pending = nil
    end
    if j.data.done_count >= j.data.count then
        return "done", string.format("做了 %d 个 %s", j.data.done_count, j.data.key)
    end
    if busy(p) then
        if U.now() - j.t0 > 180 then return "fail", "手上一直忙着，没做出东西" end
        return "run"
    end
    local builder = p.components.builder
    -- 注意：MakeRecipeFromMenu / MakeRecipeAtPoint 是客户端菜单用的，服务端调用会因为
    -- “背包没被打开”直接 return（什么也不做），所以这里必须用 MakeRecipe。
    local ok, started = pcall(function() return builder:MakeRecipe(j.data.recipe, nil, nil, nil) end)
    if not ok then return "fail", "制作出错：" .. tostring(started) end
    if started ~= true then
        return "fail", string.format("%s 没做出来（材料或状态不允许）", j.data.key)
    end
    j.data.pending = true
    j.data.done_count = j.data.done_count + 1
    return "run"
end

function job_build(j, p)
    if j.step == "start" then
        local recipe, key = recipe_of(j.args.recipe or j.args.name)
        if recipe == nil then
            return "fail", "没有这个配方：" .. tostring(j.args.recipe)
        end
        if recipe.placer == nil then
            return "fail", tostring(key) .. " 不是要摆出来的东西，用 craft 就行"
        end
        local builder = p.components.builder
        if builder == nil then return "fail", "你现在不能建造" end
        local ok, knows = pcall(function() return builder:KnowsRecipe(recipe) end)
        if ok and knows == false then
            return "fail", string.format("%s 还不会做（要先解锁）", key)
        end
        local missing = missing_ingredients(p, recipe)
        if missing ~= nil then
            return "fail", string.format("%s %s", key, missing)
        end
        local tx = tonumber(j.args.x)
        local tz = tonumber(j.args.z)
        if tx == nil or tz == nil then
            local fx, fz = find_spot(p, recipe)
            if fx == nil then
                return "fail", "附近找不到能放下 " .. key .. " 的地方（被东西占了？）"
            end
            tx, tz = fx, fz
        end
        j.data.recipe, j.data.key = recipe, key
        j.data.tx, j.data.tz = tx, tz
        j.step = "goto"
    end
    if j.step == "goto" then
        local away = tile_away(p, j.data.tx, j.data.tz)
        if away > 2.5 then
            walk_to(p, j.data.tx, j.data.tz)
            if U.now() - j.t0 > 120 then return "fail", "走不到要摆的位置" end
            return "run"
        end
        j.step = "place"
        return "run"
    end
    if j.step == "place" then
        if busy(p) then
            if U.now() - j.t0 > 180 then return "fail", "摆东西卡住了" end
            return "run"
        end
        local x, z = U.tile_center(j.data.tx, j.data.tz)
        if not can_deploy(j.data.recipe, x, z) then
            return "fail", string.format("(%d,%d) 这块地放不下 %s", j.data.tx, j.data.tz, j.data.key)
        end
        local builder = p.components.builder
        local ok, started = pcall(function()
            return builder:MakeRecipe(j.data.recipe, Vector3(x, 0, z), 0, nil)
        end)
        if not ok or started ~= true then
            return "fail", "摆放没成功（材料不够？）"
        end
        j.step = "acting"
        j.data.phase_start = U.now()
        return "run"
    end
    if busy(p) and U.now() - j.data.phase_start < 60 then return "run" end
    return "done", string.format("在 (%d,%d) 摆了 %s", j.data.tx, j.data.tz, j.data.key)
end
JOBS.build = job_build

JOBS.make_fire = function(j, p)
    j.args = j.args or {}
    if j.args.recipe == nil then j.args.recipe = "campfire" end
    local status, text = job_build(j, p)
    if status == "done" then
        local fire = U.find_nearest(p, 4, nil, nil, function(e) return e:HasTag("fire") end)
        if fire == nil then return "fail", "摆了但火没生起来（位置不合适？）" end
        return "done", text .. "，火已经生起来了"
    end
    return status, text
end
JOBS.equip = function(j, p)
    local want = j.args.item
    if want == nil or want == "" then return "fail", "equip 要传 item（要拿在手里的东西）" end
    local item = U.find_item(p, want)
    if item == nil then return "fail", "背包里没有 " .. tostring(want) end
    local inv = p.components.inventory
    if inv == nil then return "fail", "没有背包" end
    local ok, err = pcall(function() inv:Equip(item) end)
    if not ok then return "fail", "装备不上：" .. tostring(err) end
    return "done", "把 " .. U.describe_item(item) .. " 拿在手里了"
end

JOBS.drop = function(j, p)
    local want = j.args.item
    if want == nil or want == "" then return "fail", "drop 要传 item" end
    local item = U.find_item(p, want)
    if item == nil then return "fail", "背包里没有 " .. tostring(want) end
    local inv = p.components.inventory
    if inv == nil then return "fail", "没有背包" end
    local count = tonumber(j.args.count)
    local ok, err = pcall(function()
        if count ~= nil and count < U.count(item) and item.components.stackable ~= nil then
            inv:DropItem(item) -- 简单起见整摞丢掉
        else
            inv:DropItem(item)
        end
    end)
    if not ok then return "fail", "丢不出去：" .. tostring(err) end
    return "done", "丢掉了 " .. U.pretty(item) .. (count ~= nil and ("×" .. count) or "")
end

JOBS.sleep = function(j, p)
    if j.step == "start" then
        -- 优先用背包里的睡袋 / 帐篷
        local bag = nil
        local inv = p.components.inventory
        if inv ~= nil then
            inv:ForEachItem(function(item)
                if bag == nil and item.components.sleepingbag ~= nil then bag = item end
            end)
        end
        local target = nil
        if bag == nil then
            target = U.find_nearest(p, tonumber(j.args.radius) or 20, nil, nil, function(e)
                return e.components ~= nil and e.components.sleepingbag ~= nil
            end)
        end
        if bag == nil and target == nil then
            return "fail", "附近没有帐篷/睡袋（饥荒里没有“睡到天亮”这种通用办法：要有帐篷、睡袋或者床）"
        end
        if busy(p) then
            if U.now() - j.t0 > 30 then return "fail", "忙着，没睡成" end
            return "run"
        end
        j.data.name = bag ~= nil and U.pretty(bag) or U.pretty(target)
        push(p, BufferedAction(p, target, ACTIONS.SLEEPIN, bag))
        j.data.phase_start = U.now()
        j.data.slept = false
        j.step = "acting"
        return "run"
    end
    local sleeping = p.sg ~= nil and p.sg:HasStateTag("sleeping")
    if sleeping then
        j.data.slept = true
        -- 睡觉可能要好几分钟，别超时
        if U.now() - j.data.phase_start > 900 then return "fail", "睡了太久还没醒" end
        return "run"
    end
    if j.data.slept then
        return "done", "醒了（用 " .. j.data.name .. " 睡的）"
    end
    if U.now() - j.data.phase_start > 15 then
        return "fail", "没睡上（" .. j.data.name .. " 可能要两个人/晚上/耐久）"
    end
    return "run"
end

JOBS.say = function(j, p)
    local text = j.args.text
    if text == nil or text == "" then return "fail", "say 要传 text" end
    text = tostring(text)
    pcall(function() GLOBAL.TheNet:Announce(text) end)
    if p.components.talker ~= nil then
        pcall(function() p.components.talker:Say(text, 3) end)
    end
    return "done", "说了：" .. text
end

JOBS.wait = function(j, p)
    local seconds = tonumber(j.args.seconds) or 3
    if j.step == "start" then
        j.step = "acting"
        j.data.until_time = U.now() + seconds
    end
    if U.now() >= j.data.until_time then
        return "done", string.format("等了 %.0f 秒", seconds)
    end
    return "run"
end

JOBS.stop = function(j, p)
    if p ~= nil then
        pcall(function()
            if p.components.locomotor ~= nil then p.components.locomotor:Stop() end
            p:ClearBufferedAction()
        end)
    end
    return "done", "停下了"
end

-- ─────────────────────────── 对外 ───────────────────────────

function A.Start(name, args)
    local fn = JOBS[name]
    if fn == nil then
        local known = {}
        for k in pairs(JOBS) do known[#known + 1] = k end
        table.sort(known)
        return false, "没有这个动作：" .. tostring(name) .. "（能用的：" .. table.concat(known, "、") .. "）"
    end
    local p = U.player()
    if p == nil then return false, "现在没有玩家（游戏可能还在读档）" end
    if job ~= nil then
        -- 旧动作还在跑：先停掉，把上一个的结果交代清楚，别让外面一直等
        pcall(function()
            if p.components.locomotor ~= nil then p.components.locomotor:Stop() end
            p:ClearBufferedAction()
        end)
        Whale.bridge.Report(false, "被新指令打断了（上一件事没做完）")
    end
    job = {
        name = name,
        args = args or {},
        step = "start",
        data = {},
        t0 = U.now(),
    }
    Whale.job = job
    return true, nil
end

function A.Abort(reason)
    if job ~= nil and Whale.actions ~= nil then
        local p = U.player()
        if p ~= nil then
            pcall(function()
                if p.components.locomotor ~= nil then p.components.locomotor:Stop() end
                p:ClearBufferedAction()
            end)
        end
        Whale.bridge.Report(false, tostring(reason or "被打断了"))
        job = nil
        Whale.job = nil
    end
end

function A.Tick()
    local j = job
    if j == nil then return end
    local p = U.player()
    if p == nil then
        Whale.bridge.Report(false, "玩家不见了（可能退出游戏了）")
        job = nil
        Whale.job = nil
        return
    end
    local fn = JOBS[j.name]
    local ok, status, text = pcall(fn, j, p)
    if not ok then
        Whale.util.log("动作 " .. tostring(j.name) .. " 出错：" .. tostring(status))
        Whale.bridge.Report(false, "动作出错：" .. tostring(status))
        job = nil
        Whale.job = nil
        return
    end
    if status == "done" then
        Whale.bridge.Report(true, text or "好了")
        job = nil
        Whale.job = nil
    elseif status == "fail" then
        Whale.bridge.Report(false, text or "做不了")
        job = nil
        Whale.job = nil
    end
end

function A.Current()
    if job == nil then return nil end
    return job.name, job.args
end

function A.Known()
    local list = {}
    for k in pairs(JOBS) do list[#list + 1] = k end
    table.sort(list)
    return list
end

Whale = Whale or {}
Whale.actions = A
