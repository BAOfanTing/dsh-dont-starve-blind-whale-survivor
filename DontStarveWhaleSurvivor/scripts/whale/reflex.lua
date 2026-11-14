-- 保命反射层（服务端，每秒跑一次）
--
-- 为什么需要它：AI 是"一步一步想"的，它想下一步的这 5~15 秒里，游戏照常在走。
-- 天黑、火烧完、血见底、猎犬贴脸，这些都不等人。模型再聪明也赶不上；
-- 而且前期死一次基本就结束（除非有复活石/护符）。
--
-- 借鉴 dayz-ai-survivor 的 survival.py：不调模型、每 tick 最多起一个动作、
-- 用真实状态核对结果、失败后冷却而不是反复重试。区别是这里跑在 Lua 服务端，
-- 动作直接走原生 BufferedAction，没有文件桥延迟。
--
-- 只在"没有任务在跑"的时候动手；优先级：
--   1. 血/饿见底 → 吃（治疗类优先）
--   2. 入夜没光 → 举火把 / 做火把 / 生营火
--   3. 敌人贴脸 → 往反方向退
--   4. 火要灭 → 添柴
--   5. 理智太低 → 采花（白天/有光时）
--   6. 白天没火把材料 → 先采 2 草 + 2 树枝（别等黄昏）
--
-- 失败不刷屏：每种反射有自己的冷却，只有真的"开始做了"才在聊天里说一句。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

local U = Whale.util
local A = Whale.actions
local R = {}

--- 反射自己发起的动作，用固定 id，别跟外面正在等的指令抢结果
local REFLEX_ID = "reflex"

local last = {}          -- 上一次真的开始做的时间（防抖）
local recent = {}        -- 最近做过的事（给 get_state 看）
local last_said = {}     -- 同一条话不重复刷屏
local COOLDOWN = {
    heal = 8,
    eat = 5,
    light = 6,
    fuel = 6,
    flee = 10,
    forage = 6,
    sanity = 8,
    stock = 3,
}

local function cooldown_ok(key)
    local now = U.now()
    local previous = last[key]
    if previous ~= nil and now - previous < (COOLDOWN[key] or 10) then return false end
    return true
end

local function mark(key)
    last[key] = U.now()
end

local function say(p, key, text)
    if p == nil then return end
    local now = U.now()
    local previous = last_said[key]
    if previous ~= nil and now - previous < 20 then return end
    last_said[key] = now
    -- 透明化：反射层做过的事要能被 AI 看到（写进 get_state），
    -- 不然模型会看到"状态自己变了"却不知道为什么，容易误判。
    recent[#recent + 1] = { t = now, text = text }
    while #recent > 5 do table.remove(recent, 1) end
    pcall(function()
        if p.components.talker ~= nil then p.components.talker:Say(text, 3) end
    end)
end

--- 最近 60 秒内反射层自己做过的事（observe 会读）
function R.Recent()
    local out = {}
    local now = U.now()
    for _, item in ipairs(recent) do
        if now - item.t <= 60 then out[#out + 1] = item.text end
    end
    return out
end

local function percent_of(comp)
    if comp == nil then return nil end
    local ok, value = pcall(function() return comp:GetPercent() end)
    if ok and type(value) == "number" then return value end
    return nil
end

local function health_percent(p)
    return percent_of(p ~= nil and p.components ~= nil and p.components.health or nil)
end

local function hunger_percent(p)
    return percent_of(p ~= nil and p.components ~= nil and p.components.hunger or nil)
end

local function sanity_percent(p)
    return percent_of(p ~= nil and p.components ~= nil and p.components.sanity or nil)
end

--- 背包里第一个治疗物品的 prefab（药膏/腺体等）。
--- 反射层只把它交给 heal 动作，不自己决定吃哪个食物。
local function find_healer_prefab(p)
    local inv = p ~= nil and p.components ~= nil and p.components.inventory or nil
    if inv == nil then return nil end
    local prefab = nil
    pcall(function()
        inv:ForEachItem(function(item)
            if prefab ~= nil or item == nil or not item:IsValid() then return end
            if item.components ~= nil and item.components.healer ~= nil then
                prefab = tostring(item.prefab or "")
            end
        end)
    end)
    if prefab == "" then return nil end
    return prefab
end

-- 已放置的永久光源有时仍保留 inventoryitem 组件（真机快照里出现过）。
-- 这些 prefab 本身是设施，不能因为还带 inventoryitem 就被当成"背包里的东西"排除。
local PERMANENT_LIGHTS = {
    pumpkin_lantern = true,
    mushroom_light = true,
    mushroom_light2 = true,
    nightlight = true,
    wall_light = true,
}

local function has_light(p)
    local inv = p.components.inventory
    if inv == nil then return false end
    local hands = inv:GetEquippedItem(GLOBAL.EQUIPSLOTS.HANDS)
    if hands ~= nil and (hands:HasTag("light") or hands.prefab == "torch"
            or hands.prefab == "lantern" or hands.prefab == "minerhat") then
        return true
    end
    -- 不只找火：南瓜灯/蘑菇灯/夜灯这类永久光源也要算。
    -- 有 fueled 的（营火/火坑）必须还有燃料；没有 fueled 的照明设施按已点亮算。
    local light = U.find_nearest(p, 8, { "light" }, nil, function(e)
        if e == nil or e == p or e:HasTag("player") then return false end
        local permanent = PERMANENT_LIGHTS[tostring(e.prefab or "")] == true
        if not permanent and e.components ~= nil and e.components.inventoryitem ~= nil then
            return false
        end
        local fueled = e.components ~= nil and e.components.fueled or nil
        return fueled == nil or not fueled:IsEmpty()
    end)
    return light ~= nil
end

local function exact_ready(p, prefab, radius)
    local found = U.find_nearest(p, radius or 10, nil, nil, function(e)
        if e == nil or e.prefab ~= prefab then return false end
        if e:HasTag("barren") then return false end
        local pickable = e.components ~= nil and e.components.pickable or nil
        if pickable == nil then return false end
        local ok, can = pcall(function() return pickable:CanBePicked() end)
        return ok and can == true
    end)
    return found
end

--- 反射层的"采一个"直接推原生动作，不创建 Whale.job。
--- 这样不会让模型刚发来的命令撞上 actor_busy；引擎忙的时候我们自己让开。
local function push_pick(p, ent)
    if p == nil or ent == nil then return false end
    local ok_busy, buffered = pcall(function() return p:GetBufferedAction() end)
    if ok_busy and buffered ~= nil then return false end
    local ok_ba, ba = pcall(function() return GLOBAL.BufferedAction(p, ent, GLOBAL.ACTIONS.PICK, nil) end)
    if not ok_ba or ba == nil then return false end
    local ok_push = pcall(function() A.push(p, ba) end)
    return ok_push
end

--- 采成熟浆果丛（原生 HARVEST 动作）。和 push_pick 一样不创建 Whale.job。
local function push_harvest(p, ent)
    if p == nil or ent == nil then return false end
    local ok_busy, buffered = pcall(function() return p:GetBufferedAction() end)
    if ok_busy and buffered ~= nil then return false end
    local ok_ba, ba = pcall(function() return GLOBAL.BufferedAction(p, ent, GLOBAL.ACTIONS.HARVEST, nil) end)
    if not ok_ba or ba == nil then return false end
    return pcall(function() A.push(p, ba) end)
end

local function ready_berry(p, radius)
    return U.find_nearest(p, radius or 12, nil, nil, function(e)
        if e == nil then return false end
        local prefab = tostring(e.prefab or "")
        if prefab ~= "berrybush" and prefab ~= "berrybush2" and prefab ~= "berrybush_juicy" then
            return false
        end
        if e:HasTag("barren") then return false end
        local pickable = e.components ~= nil and e.components.pickable or nil
        if pickable == nil then return false end
        local ok, can = pcall(function() return pickable:CanBePicked() end)
        return ok and can == true
    end)
end

--- 1) 快见底/饿坏了：吃药或吃东西（heal 自己会挑：治疗类优先，其次吃的）
local function reflex_heal(p)
    local hp = health_percent(p)
    local hunger = hunger_percent(p)
    -- 40% 就开始吃，给模型思考和动作留出时间；等到 25% 常常已经来不及。
    local need_heal = hp ~= nil and hp < 0.45
    local need_eat = hunger ~= nil and hunger < 0.35
    if not need_heal and not need_eat then return false end

    local key = need_heal and "heal" or "eat"
    if not cooldown_ok(key) then return false end

    local started = false
    local healer = need_heal and find_healer_prefab(p) or nil
    if healer ~= nil then
        started = A.Start("heal", { item = healer }, REFLEX_ID)
    else
        -- 不填食物的 eat 会走旧 best_food 路径，可能挑到怪物肉或生红/绿蘑菇。
        -- survival_eat 强制使用 eatrules 的安全白名单。
        started = A.Start("eat", {}, REFLEX_ID, { survival_eat = true })
    end
    if started then
        mark(key)
        say(p, key, need_heal and healer ~= nil and "血不多了，先上药" or "饿了/血少了，先吃点安全的东西")
        return true
    end
    return false
end

--- 2) 入夜没光：举火把 / 做火把 / 生营火
local function reflex_light(p)
    local world = GLOBAL.TheWorld
    local state = world ~= nil and world.state or nil
    local phase = state ~= nil and state.phase or nil
    if phase ~= "dusk" and phase ~= "night" then return false end
    if has_light(p) then return false end
    if not cooldown_ok("light") then return false end

    local inv = p.components.inventory
    if inv == nil then return false end

    local torch = U.find_item(p, "torch")
    if torch ~= nil then
        pcall(function() inv:Equip(torch) end)
        mark("light")
        say(p, "light", "天黑了，先把火把举起来")
        return true
    end

    -- 有材料就做火把（空手做会直接装备到手上）。
    if A.count_item(p, "cutgrass") >= 2 and A.count_item(p, "twigs") >= 2 then
        -- 走 SURVIVAL-01 的 craft 路径：做之前用 craftrules 精确核对材料，
        -- 避免旧路径在材料不够时先把材料扣掉。
        local started = A.Start("craft", { recipe = "torch", count = 1 }, REFLEX_ID,
            { survival_craft = true, recipe = "torch" })
        if started then
            mark("light")
            say(p, "light", "没火了，先做把火把")
            return true
        end
    end

    -- 没火把材料：有木头+草就先生营火，至少别在黑暗里挨打。
    if A.count_item(p, "log") >= 2 and A.count_item(p, "cutgrass") >= 3 then
        local started = A.Start("make_fire", {}, REFLEX_ID)
        if started then
            mark("light")
            say(p, "light", "材料不够做火把，先生一堆营火")
            return true
        end
    end
    return false
end

--- 3) 敌人贴脸：血少、或者理智低到刷暗影怪时，先拉开
local function reflex_flee(p)
    local hp = health_percent(p)
    local sanity = sanity_percent(p)
    -- 和计划层对齐：半血以下就不硬拼；理智见底时暗影怪贴脸也必须先撤。
    local danger_low_hp = hp ~= nil and hp < 0.5
    local danger_shadow = sanity ~= nil and sanity < 0.25
    if not danger_low_hp and not danger_shadow then return false end

    local radius = danger_low_hp and 4 or 5
    local foe = U.find_nearest(p, radius, { "hostile" }, nil, function(e)
        local h = e.components ~= nil and e.components.health or nil
        return h ~= nil and not h:IsDead()
    end)
    if foe == nil then return false end
    if not cooldown_ok("flee") then return false end

    local fx, _, fz = U.pos(foe)
    local px, _, pz = U.pos(p)
    if fx == nil or px == nil then return false end
    local dx, dz = px - fx, pz - fz
    local len = math.sqrt(dx * dx + dz * dz)
    if len < 0.01 then dx, dz, len = 1, 0, 1 end
    local dist = 10
    local tx, tz = U.tile_of(px + dx / len * dist * U.TILE, pz + dz / len * dist * U.TILE)
    local started = A.Start("move_to", { x = tx, z = tz, timeout = 8 }, REFLEX_ID)
    if started then
        mark("flee")
        say(p, "flee", danger_shadow and "暗影怪贴上来了，先撤" or "血不多了，先撤")
        return true
    end
    return false
end

--- 3.5) 饿了但背包里没有安全食物：先采最近的成熟浆果丛。
--- 这条只在没有可吃食物时触发，避免抢模型正在做的存粮计划。
local function reflex_forage(p)
    local hunger = hunger_percent(p)
    if hunger == nil or hunger >= 0.35 then return false end

    local rules = Whale ~= nil and Whale.eatrules or nil
    local inv = p ~= nil and p.components ~= nil and p.components.inventory or nil
    if rules ~= nil and inv ~= nil and rules.PickBest(inv) ~= nil then return false end
    if not cooldown_ok("forage") then return false end

    local bush = ready_berry(p, 12)
    if bush == nil then return false end
    if push_harvest(p, bush) then
        mark("forage")
        say(p, "forage", "没吃的了，先采最近的浆果")
        return true
    end
    return false
end

--- 4) 火快灭了：添柴
local function reflex_fuel(p)
    local fire = U.find_nearest(p, 8, { "fire" }, nil, function(e)
        local fueled = e.components ~= nil and e.components.fueled or nil
        if fueled == nil or fueled:IsEmpty() then return false end
        local percent = fueled:GetPercent()
        return percent ~= nil and percent < 0.15
    end)
    if fire == nil then return false end
    if not cooldown_ok("fuel") then return false end
    local started = A.Start("add_fuel", {}, REFLEX_ID)
    if started then
        mark("fuel")
        say(p, "fuel", "火快灭了，添点柴")
        return true
    end
    return false
end

--- 5) 理智太低：白天/有光时采花（每朵 +5 理智）。
--- 不用生绿蘑菇兜底：生绿蘑菇会掉理智，反而把人推向暗影怪。
local function reflex_sanity(p)
    local sanity = sanity_percent(p)
    if sanity == nil or sanity >= 0.35 then return false end
    if not cooldown_ok("sanity") then return false end

    -- 黑暗里掉理智最快；先让 reflex_light 处理光。
    local world = GLOBAL.TheWorld
    local phase = world ~= nil and world.state ~= nil and world.state.phase or nil
    if (phase == "dusk" or phase == "night") and not has_light(p) then return false end

    -- 只采普通花；恶花（flower_evil）会掉理智，绝不能碰。
    local flower = exact_ready(p, "flower", 10)
    local started = flower ~= nil and push_pick(p, flower) or false
    if started then
        mark("sanity")
        say(p, "sanity", "理智太低了，先补一点")
        return true
    end
    return false
end

--- 6) 白天提前备火把材料：2 草 + 2 树枝。
---    只在白天、没光、没火把、材料不够、附近真的有目标时做，每次只采一个。
local function reflex_stock_light(p)
    local world = GLOBAL.TheWorld
    local phase = world ~= nil and world.state ~= nil and world.state.phase or nil
    if phase == "dusk" or phase == "night" then return false end
    -- 有固定光源也要备一把能带走的火把；只有背包里已经有火把才停。
    if A.count_item(p, "torch") > 0 then return false end
    if not cooldown_ok("stock") then return false end

    local grass = A.count_item(p, "cutgrass")
    local twigs = A.count_item(p, "twigs")
    if grass >= 2 and twigs >= 2 then return false end

    local want = grass < 2 and "grass" or "sapling"
    local target = exact_ready(p, want, 10)
    if target == nil then return false end
    local started = push_pick(p, target)
    if started then
        mark("stock")
        say(p, "stock", want == "grass" and "白天先把做火把的草备好" or "白天先把做火把的树枝备好")
        return true
    end
    return false
end

--- 服务端每 0.2 秒调一次；内部按 1 秒节流
local tick = 0
function R.Tick()
    if Whale.reflex_force_off == true then return end
    if Whale.reflex_on == false then return end   -- 模组配置里关掉了
    tick = tick + 1
    if tick % 5 ~= 0 then return end       -- ≈1 秒一次
    if Whale.job ~= nil then return end     -- 有正经任务在跑：一律不插手

    local p = U.player()
    if p == nil then return end
    local hp = p.components.health
    if hp ~= nil and hp:IsDead() then return end

    -- 顺序有讲究：先保命（吃/回血），再保光，再脱战，再保火，最后才是长期补给。
    local ok, err = pcall(function()
        if reflex_heal(p) then return end
        if Whale.job ~= nil then return end
        if reflex_light(p) then return end
        if Whale.job ~= nil then return end
        if reflex_flee(p) then return end
        if Whale.job ~= nil then return end
        if reflex_fuel(p) then return end
        if Whale.job ~= nil then return end
        if reflex_forage(p) then return end
        if Whale.job ~= nil then return end
        if reflex_sanity(p) then return end
        if Whale.job ~= nil then return end
        reflex_stock_light(p)
    end)
    if not ok then U.log("保命反射出错：" .. tostring(err)) end
end

function R.Status()
    local out = {}
    for k, v in pairs(last) do out[k] = v end
    return out
end

Whale = Whale or {}
Whale.reflex = R
