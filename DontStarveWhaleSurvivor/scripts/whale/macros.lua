-- 宏（任务级接口）：一条指令干完一段活
--
-- 为什么要有这一层（参考星露谷那版的思路）：
--   饥荒是**实时**的（一整天 8 分钟，100 天 ≈ 13 小时），模型每步思考 5~15 秒。
--   如果每条指令只做"采一个浆果"，100 天要几千次调用，永远走不完。
--   星露谷版给模型的是 water_crops / care_animals / explore_mine 这种**任务级**工具：
--   模型只说"去浇地/照顾动物"，循环、寻路、找目标全在模组里。
--   这里照抄这个思路，但只做"纯机械"的活 —— 判断（要不要做、先做哪个）仍然全归模型。
--
-- 每个宏都是"一步一步推进"的状态机，内部复用 actions.lua 已有的原子动作，
-- 所以耐久、掉落、被打断、背包净变化那些保证照样生效。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

local A = Whale.actions
local U = Whale.util

local M = {}

--- 资源 → 采下来会变成什么（用来判断"够不够数"）
local PRODUCT = {
    berrybush = "berries",
    berrybush2 = "berries",
    berrybush_juicy = "berries_juicy",
    grass = "cutgrass",
    sapling = "twigs",
    reeds = "cutreeds",
    carrot_planted = "carrot",
    mushroom = "red_cap",
    flower = "petals",
    succulent = "succulent_picked",
}

local function product_of(resource)
    if resource == nil then return nil end
    local key = string.lower(tostring(resource))
    if PRODUCT[key] ~= nil then return PRODUCT[key] end
    for prefix, product in pairs(PRODUCT) do
        if string.find(key, prefix, 1, true) ~= nil then return product end
    end
    return nil
end

local function say(p, text)
    pcall(function()
        if p ~= nil and p.components ~= nil and p.components.talker ~= nil then
            p.components.talker:Say(text, 2)
        end
    end)
end

-- ─────────────────────────── 采集到够数 ───────────────────────────

--- gather {resource="grass", count=6, radius=25}
--- 反复"走到最近的 → 采"，直到背包里那种产物到够数 / 附近没得采 / 超时。
-- SURVIVAL-01：原名 "gather" 与新增的原子动作重名，宏改名（它本来就不对模型暴露）
A.register("gather_macro", function(j, p)
    if j.step == "start" then
        j.data.resource = j.args.resource or j.args.what
        if j.data.resource == nil or j.data.resource == "" then
            return "fail", "gather 要传 resource，比如 grass、sapling、berrybush、flower"
        end
        j.data.product = product_of(j.data.resource)
        j.data.want = tonumber(j.args.count) or 5
        j.data.radius = tonumber(j.args.radius) or 25
        j.data.base = j.data.product ~= nil and A.count_item(p, j.data.product) or 0
        j.data.rounds = 0
        j.data.missed = 0
        j.step = "loop"
        j.data.sub = nil
    end

    -- 够数了就收工
    if j.data.product ~= nil then
        local have = A.count_item(p, j.data.product)
        local gained = have - j.data.base
        if gained >= j.data.want then
            return "done", string.format("采够了：%s 多了 %d 个（背包里现在 %d 个）", j.data.product, gained, have)
        end
    elseif j.data.rounds >= j.data.want then
        return "done", string.format("采了 %d 次（不知道产物叫什么，按次数算的）", j.data.rounds)
    end

    if j.data.rounds > 60 then return "fail", "采了 60 次还没够，附近资源可能不够了" end
    if U.now() - j.t0 > (tonumber(j.args.timeout) or 240) then
        local have = j.data.product ~= nil and A.count_item(p, j.data.product) or 0
        return "fail", string.format("超时了：只采到 %s %d 个", tostring(j.data.product or "?"), have - j.data.base)
    end
    if A.busy(p) then return "run" end

    local status, text = A.run_sub(j.data, "pick", {
        target = j.data.resource, count = 1, radius = j.data.radius,
    })
    if status == "done" then
        j.data.rounds = j.data.rounds + 1
        j.data.missed = 0
        return "run"
    elseif status == "fail" then
        j.data.missed = j.data.missed + 1
        if j.data.missed >= 2 then
            local have = j.data.product ~= nil and A.count_item(p, j.data.product) or 0
            return "fail", string.format("附近没有更多 %s 了（%s，已采 %d 个）：%s",
                tostring(j.data.resource), tostring(j.data.product or "?"), have - j.data.base, tostring(text))
        end
        return "run"
    end
    return "run"
end)

-- ─────────────────────────── 砍到够木头 ───────────────────────────

--- chop_until {logs=20, radius=25}
A.register("chop_until", function(j, p)
    if j.step == "start" then
        j.data.want = tonumber(j.args.logs or j.args.count) or 10
        j.data.radius = tonumber(j.args.radius) or 25
        j.data.product = j.args.product or "log"
        j.data.base = A.count_item(p, j.data.product)
        j.data.trees = 0
        j.step = "loop"
        j.data.sub = nil
        j.data.phase = "pickup"
    end

    local have = A.count_item(p, j.data.product)
    local gained = have - j.data.base
    if gained >= j.data.want then
        return "done", string.format("木头够了：砍倒 %d 棵树，%s 多了 %d（背包里 %d）",
            j.data.trees, j.data.product, gained, have)
    end
    if j.data.trees >= (tonumber(j.args.max_trees) or 30) then
        return "fail", string.format("砍了 %d 棵树只拿到 %d 个 %s，先看看工具/附近", j.data.trees, gained, j.data.product)
    end
    if U.now() - j.t0 > (tonumber(j.args.timeout) or 300) then
        return "fail", string.format("超时：砍了 %d 棵，%s 只有 %d 个", j.data.trees, j.data.product, gained)
    end
    if A.busy(p) then return "run" end

    -- 先捡地上的木头（砍下来的不会自己进背包），捡不到就忽略
    -- P1：pickup / chop 分阶段（不要共用 sub 互相截胡），并正确接住 run_sub 的第二个返回值 text
    if j.data.phase == nil then j.data.phase = "pickup" end
    if j.data.phase == "pickup" then
        local status, text = A.run_sub(j.data, "pickup", { item = j.data.product, count = 3, radius = j.data.radius })
        if status == "done" or status == "fail" then j.data.phase = "chop"; j.data.sub = nil; return "run" end
        return "run"
    end
    local status, text = A.run_sub(j.data, "chop", { count = 1, radius = j.data.radius, until_gone = true })
    if status == "done" then
        j.data.trees = j.data.trees + 1
        j.data.phase = "pickup"; j.data.sub = nil
        return "run"
    elseif status == "fail" then
        return "fail", "砍不动：" .. tostring(text)
    end
    return "run"
end)

-- ─────────────────────────── 锅：放料 → 等熟 → 出锅 ───────────────────────────

--- cook_meal {pots=1, radius=12}
A.register("cook_meal", function(j, p)
    if j.step == "start" then
        j.data.radius = tonumber(j.args.radius) or 12
        j.data.filled = 0
        j.data.sub = nil
        j.step = "loop"
    end
    if U.now() - j.t0 > (tonumber(j.args.timeout) or 300) then return "fail", "做饭超时了" end
    if A.busy(p) then return "run" end

    local pot = U.find_nearest(p, j.data.radius, nil, nil, function(e)
        return e.components ~= nil and e.components.stewer ~= nil
    end)
    if pot == nil then return "fail", "附近没有锅（cookpot）" end
    local stewer = pot.components.stewer

    local done_ok, is_done = pcall(function() return stewer:IsDone() end)
    if done_ok and is_done then
        local ok2 = pcall(function() stewer:Harvest() end)
        if not ok2 then return "fail", "出锅失败（锅可能被烧了）" end
        return "done", "做好了一锅菜，已经拿出来放背包了"
    end

    local cooking = false
    pcall(function() cooking = stewer:IsCooking() end)
    if cooking then return "run" end          -- 在煮：安静等（外层 0.2 秒推进一次）

    -- 锅是空的：往里放食材，最多 4 样（多了浪费）
    if j.data.filled >= 4 then return "run" end
    local item = nil
    local inv = p.components.inventory
    if inv ~= nil then
        inv:ForEachItem(function(it)
            if item == nil and it.components.cookable ~= nil then item = it end
        end)
    end
    if item == nil then
        if j.data.filled > 0 then return "run" end
        return "fail", "背包里没有能煮的食材"
    end
    -- P1：烹饪锅应 container:GiveItem + stewer:StartCooking；ACTIONS.COOK 是营火烤食材用的，锅不接受
    local container = pot.components ~= nil and pot.components.container or nil
    local unit = item
    local st = item.components ~= nil and item.components.stackable or nil
    if st ~= nil and st.StackSize ~= nil and st:StackSize() > 1 then unit = st:Get(1) end
    if unit.components ~= nil and unit.components.inventoryitem ~= nil and unit.components.inventoryitem.RemoveFromOwner ~= nil then
        unit.components.inventoryitem:RemoveFromOwner()
    end
    if container ~= nil then pcall(function() container:GiveItem(unit, nil, pot:GetPosition()) end) end
    if stewer ~= nil then pcall(function() stewer:StartCooking(p) end) end
    j.data.filled = j.data.filled + 1
    return "run"
end)

-- ─────────────────────────── 守夜：保证有光，熬到天亮 ───────────────────────────

--- night_watch {max_seconds=600}
--- 只在黄昏/夜晚用。做的事：没光就举火把/生火，火烧弱就添柴，然后等到天亮。
A.register("night_watch", function(j, p)
    if j.step == "start" then
        j.data.max = tonumber(j.args.max_seconds) or 600
        j.data.fired = false
        j.data.sub = nil
        j.step = "loop"
    end
    local world = GLOBAL.TheWorld
    local state = world ~= nil and world.state or nil
    local phase = state ~= nil and state.phase or nil
    if phase ~= "dusk" and phase ~= "night" then
        return "done", "天亮了，可以干别的了"
    end
    if U.now() - j.t0 > j.data.max then
        return "fail", string.format("守了 %d 秒还没天亮，先看看状态", math.floor(U.now() - j.t0))
    end
    if A.busy(p) then return "run" end

    -- 有没有光
    local inv = p.components.inventory
    local hands = inv ~= nil and inv:GetEquippedItem(GLOBAL.EQUIPSLOTS.HANDS) or nil
    local lit = hands ~= nil and (hands:HasTag("light") or hands.prefab == "torch" or hands.prefab == "lantern")
    local fire = U.find_nearest(p, 8, { "fire" }, nil, function(e)
        local fueled = e.components ~= nil and e.components.fueled or nil
        return fueled == nil or not fueled:IsEmpty()
    end)

    if not lit and fire == nil then
        local torch = A.count_item(p, "torch") > 0 and U.find_item(p, "torch") or nil
        if torch ~= nil then
            pcall(function() inv:Equip(torch) end)
            say(p, "天亮前先举着火把")
            return "run"
        end
        -- 没火把也没火：先做火把，做不了就生营火
        local status = A.run_sub(j.data, "craft", { recipe = "torch", count = 1 })
        if status == "done" then say(p, "做了个火把"); return "run" end
        if not j.data.fired then
            j.data.fired = true
            local status2 = A.run_sub(j.data, "make_fire", {})
            if status2 == "done" then say(p, "先生一堆火") end
            return "run"
        end
        return "fail", "天黑又没有光源，也做不出火把/火堆（材料不够）"
    end

    -- 火快灭了就添柴
    if fire ~= nil then
        local fueled = fire.components.fueled
        local percent = fueled ~= nil and fueled:GetPercent() or nil
        if percent ~= nil and percent < 0.2 then
            local status = A.run_sub(j.data, "add_fuel", { radius = 10 })
            if status == "done" then say(p, "给火添点柴") end
            return "run"
        end
    end
    return "run"    -- 有光有柴，安静等天亮
end)

Whale = Whale or {}
Whale.macros = M
