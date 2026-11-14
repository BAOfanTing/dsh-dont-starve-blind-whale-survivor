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
-- 默认只在"没有任务在跑"的时候动手；但有两条会**抢占**模型的任务：
--   · 入夜没光：查理不会等模型想完，先点火
--   · 正在被怪打 / 残血 + 敌人贴脸：先撤，别把最后 50 血交给一个 gather_area
-- 其余优先级：
--   1. 敌人贴脸（血少/理智低）→ 往反方向 / 往最近的营地、永久光源退
--   2. 血/饿见底 → 吃（治疗类优先；包里没有安全食物就不启动注定失败的 eat）
--   3. 入夜没光 → 举火把 / 做火把 / 生营火
--   4. 火要灭 → 添柴
--   5. 饿/血低且没有安全食物 → 采浆果、捡地上的胡萝卜/浆果
--   6. 理智太低 → 采花（白天/有光时）
--   7. 白天没火把材料 → 先采 2 草 + 2 树枝（别等黄昏）
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

--- 最近的活着的敌对生物（radius 单位是"格"，U.find_nearest 会自己乘 4）
local function nearest_hostile(p, radius_tiles)
    -- 引擎的 FindEntities 本来就会按 radius 过滤；这里再核对一次距离，
    -- 是为了不让"附近列表没过滤干净"的环境（测试桩/特殊脚本）把远处的怪算成贴脸。
    local limit = radius_tiles * U.TILE
    return U.find_nearest(p, radius_tiles, { "hostile" }, nil, function(e)
        local h = e ~= nil and e.components ~= nil and e.components.health or nil
        if h == nil or h:IsDead() then return false end
        return U.dist(p, e) <= limit
    end)
end

--- 这只怪是不是正在打我（combat.target 指向我）。
--- 有些怪没有 hostile 标签，但 combat.target 这个信号最直接。
local function combat_targeting(foe, p)
    local c = foe ~= nil and foe.components ~= nil and foe.components.combat or nil
    if c == nil then return false end
    local ok, target = pcall(function() return c.target end)
    return ok and target == p
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

--- 捡地上的食物（胡萝卜/浆果）。白名单仍是 Whale.pickuprules 的唯一来源。
local function push_pickup(p, ent)
    if p == nil or ent == nil then return false end
    local ok_busy, buffered = pcall(function() return p:GetBufferedAction() end)
    if ok_busy and buffered ~= nil then return false end
    local ok_ba, ba = pcall(function() return GLOBAL.BufferedAction(p, ent, GLOBAL.ACTIONS.PICKUP, nil) end)
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

--- 地上能捡、能吃、且在 pickuprules 白名单里的东西（胡萝卜/浆果）。
local function ready_ground_food(p, radius)
    local rules = Whale ~= nil and Whale.pickuprules or nil
    local eat = Whale ~= nil and Whale.eatrules or nil
    if rules == nil or eat == nil then return nil end
    return U.find_nearest(p, radius, nil, nil, function(e)
        local ok_candidate = rules.IsCandidate(e, p)
        if not ok_candidate then return false end
        local edible = e.components ~= nil and e.components.edible or nil
        if edible == nil then return false end
        local ok_food = eat.IsAllowedPrefab(tostring(e.prefab or ""))
        return ok_food == true
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

    local healer = need_heal and find_healer_prefab(p) or nil
    -- ★ 真机 bug：包里没有安全食物时，旧的 eat 会先启动、再失败，然后还要吃 5 秒冷却，
    --   结果"该去采浆果"的那几秒被白白烧掉。没有安全食物就交给 reflex_forage。
    local rules = Whale ~= nil and Whale.eatrules or nil
    local inv = p ~= nil and p.components ~= nil and p.components.inventory or nil
    local safe_food = rules ~= nil and inv ~= nil and rules.PickBest(inv) ~= nil
    if healer == nil and not safe_food then return false end

    local started = false
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

    local radius = danger_low_hp and 4 or 5
    local foe = nearest_hostile(p, radius)
    local attacked = foe ~= nil and combat_targeting(foe, p)
    if not danger_low_hp and not danger_shadow and not attacked then return false end
    if foe == nil then return false end
    if not cooldown_ok("flee") then return false end

    local fx, _, fz = U.pos(foe)
    local px, _, pz = U.pos(p)
    if fx == nil or px == nil then return false end
    local dx, dz = px - fx, pz - fz
    local len = math.sqrt(dx * dx + dz * dz)
    if len < 0.01 then dx, dz, len = 1, 0, 1 end

    -- 优先往"比现在更远离威胁"的营地/永久光源撤；没有就往反方向跑远一点。
    -- 旧的 2.5 格只够退出攻击圈，青蛙两步又追上来 —— 真机就是这样被反复耗死的。
    local cur = U.dist(p, foe)
    local base = U.find_nearest(p, 40, nil, nil, function(e)
        if e == nil or e == p or e:HasTag("player") then return false end
        local prefab = tostring(e.prefab or "")
        local permanent = PERMANENT_LIGHTS[prefab] == true
        local is_fire = e:HasTag("fire") and e.components ~= nil and e.components.fueled ~= nil
        if not permanent and not is_fire then return false end
        local fueled = e.components ~= nil and e.components.fueled or nil
        if fueled ~= nil then
            local ok_empty, empty = pcall(function() return fueled:IsEmpty() end)
            if ok_empty and empty then return false end
        end
        return U.dist(e, foe) > cur + 2 * U.TILE
    end)

    local tx, tz
    if base ~= nil and U.dist(p, base) > 3 * U.TILE then
        local bx, _, bz = U.pos(base)
        tx, tz = U.tile_of(bx, bz)
    else
        local dist = 5 * U.TILE
        tx, tz = U.tile_of(px + dx / len * dist, pz + dz / len * dist)
    end
    local started = A.Start("move_to", { x = tx, z = tz, timeout = 8 }, REFLEX_ID)
    if started then
        mark("flee")
        local why = danger_shadow and "暗影怪贴上来了，先撤"
            or (danger_low_hp and "血不多了，先撤到安全的地方" or "有怪在打我，先撤")
        say(p, "flee", why)
        return true
    end
    return false
end

--- 3.5) 饿了/血低但背包里没有安全食物：先采成熟浆果，或捡地上的胡萝卜/浆果。
--- 这条只在没有可吃食物时触发，避免抢模型正在做的存粮计划。
local function reflex_forage(p)
    local hp = health_percent(p)
    local hunger = hunger_percent(p)
    local need_food = (hunger ~= nil and hunger < 0.35) or (hp ~= nil and hp < 0.5)
    if not need_food then return false end

    local rules = Whale ~= nil and Whale.eatrules or nil
    local inv = p ~= nil and p.components ~= nil and p.components.inventory or nil
    if rules ~= nil and inv ~= nil and rules.PickBest(inv) ~= nil then return false end
    if not cooldown_ok("forage") then return false end

    local bush = ready_berry(p, 12)
    if bush ~= nil and push_harvest(p, bush) then
        mark("forage")
        say(p, "forage", "没吃的了，先采最近的浆果")
        return true
    end
    local food = ready_ground_food(p, 8)
    if food ~= nil and push_pickup(p, food) then
        mark("forage")
        say(p, "forage", "先把地上的吃的捡起来")
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

--- 残血 + 敌人已经贴脸：允许抢占模型正在跑的任务。
--- 阈值刻意比普通 flee 更严（残血 2.5 格；20% 以下 5 格），
--- 避免远处一只蜘蛛就让 AI 一直逃跑、什么也做不成。
function R.CriticalDanger(p)
    -- 正在被怪打：不管血多少，先停下手里的事脱离（采集中被青蛙咬就是这个场景）。
    local attacker = nearest_hostile(p, 3)
    if attacker ~= nil and combat_targeting(attacker, p) then return true end

    local hp = health_percent(p)
    if hp == nil or hp >= 0.35 then return false end
    if nearest_hostile(p, 2.5) ~= nil then return true end
    return hp < 0.2 and nearest_hostile(p, 5) ~= nil
end

--- 服务端每 0.2 秒调一次；内部按 1 秒节流
local tick = 0
function R.Tick()
    if Whale.reflex_force_off == true then return end
    if Whale.reflex_on == false then return end   -- 模组配置里关掉了
    tick = tick + 1
    if tick % 5 ~= 0 then return end       -- ≈1 秒一次

    local p = U.player()
    if p == nil then return end
    local hp = p.components.health
    if hp ~= nil and hp:IsDead() then return end

    -- 顺序有讲究：先处理"等不了"的两件事（黑暗、贴脸残血），再谈模型任务；
    -- 没任务时才做吃/回血/保火/补给。
    local ok, err = pcall(function()
        local world = GLOBAL.TheWorld
        local phase = world ~= nil and world.state ~= nil and world.state.phase or nil
        -- 天黑没光：查理不会等模型想完，直接抢占（做火把/生营火）。
        if (phase == "dusk" or phase == "night") and not has_light(p) then
            if reflex_light(p) then return end
        end
        -- 残血被贴脸：也抢占，先撤。旧版在模型跑 gather_area 时完全不设防，真机就是这样被青蛙打死的。
        if R.CriticalDanger(p) then
            if reflex_flee(p) then return end
        end

        if Whale.job ~= nil then return end     -- 有正经任务在跑：不抢

        -- 普通优先级：先脱战，再吃/回血，再保光，再保火，最后才是长期补给。
        if reflex_flee(p) then return end
        if Whale.job ~= nil then return end
        if reflex_heal(p) then return end
        if Whale.job ~= nil then return end
        if reflex_light(p) then return end
        if Whale.job ~= nil then return end
        if reflex_fuel(p) then return end
        if Whale.job ~= nil then return end
        if reflex_forage(p) then return end
        if Whale.job ~= nil then return end
        if reflex_sanity(p) then return end
        if Whale.job ~= nil then return end
        reflex_stock_light(p)
    end)
    if not ok then
        -- 留着给 get_state/诊断看：反射层出错不能让模型以为"什么都没发生"。
        Whale.last_reflex_error = tostring(err)
        U.log("保命反射出错：" .. tostring(err))
    end
end

function R.Status()
    local out = {}
    for k, v in pairs(last) do out[k] = v end
    return out
end

Whale = Whale or {}
Whale.reflex = R
