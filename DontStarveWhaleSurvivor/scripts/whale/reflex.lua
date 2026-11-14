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
-- ── SURVIVAL-02.1 重做（见 docs/STATUS.md）────────────────────────────────
-- 旧版三个真问题（都在真机日志里对得上）：
--   1) 白天 reflex_stock_light 采够材料后 -> return false，**永远不做火把**；
--   2) 只有黄昏/夜里 reflex_light 才做火把，白天不提前准备；
--   3) 除"黑暗/被贴脸"外，全部逻辑都被 `if Whale.job ~= nil then return end` 挡住，
--      采集/寻路时饥饿、生命、理智处理被整体跳过。
-- 现在改成规则判定的 P0/P1/P2/P3 优先级 + 走 A.Abort 的安全抢占 + 防抖 + 诊断日志。
--
-- 重要事实（这局真实死亡统计，见 docs/STATUS.md §死亡分析）：
--   世界设置 darkness=nonlethal —— 黑暗本身杀不死人（grue 伤害停在下限 20% 血）；
--   真正打死它的是**理智崩溃后刷出来的暗影怪（爬行恐惧/恐怖尖喙）** 和 青蛙群。
--   所以"火把/光源"依然关键（夜里没光 = 理智暴跌 = 暗影怪），但理智本身也要盯。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

local U = Whale.util
local A = Whale.actions
local R = {}

--- 反射自己发起的动作，用固定 id，别跟外面正在等的指令抢结果
local REFLEX_ID = "reflex"

-- ── 优先级（数值越小越优先）───────────────────────────────────────────────
local P0, P1, P2, P3 = 0, 1, 2, 3

-- 便携光源：手上/背包里有、且还有耐久/燃料才算数
local LIGHT_PREFABS = { torch = true, lantern = true, minerhat = true }
-- 已放置的永久光源：有时仍保留 inventoryitem 组件（真机快照里出现过），不能因此当"背包里的东西"排除
local PERMANENT_LIGHTS = {
    pumpkin_lantern = true,
    mushroom_light = true,
    mushroom_light2 = true,
    nightlight = true,
    wall_light = true,
}

-- ── 阈值（用角色真实上限的百分比，不写死绝对饥饿值）────────────────────────
local EAT_EMERGENCY = 0.35     -- 饥饿 < 35%：P1 紧急进食
local HEAL_EMERGENCY = 0.35    -- 生命 < 35%：P1 回血
local FORAGE_AHEAD = 0.45      -- 没有安全食物且饥饿 < 45%：提前去采
local SANITY_LOW = 0.35        -- 理智 < 35%：P3 采花（暗影怪前兆）

local last = {}          -- 上一次真的开始做的时间（防抖）
local recent = {}        -- 最近做过的事（给 get_state 看）
local last_said = {}     -- 同一条话不重复刷屏
local last_log = {}      -- 诊断日志限频
local fail_until = {}    -- 失败退避（材料不足/目标不存在时别每秒重试）
local inflight = nil     -- 当前在跑的反射意图 { key, job, priority }
local pending = nil      -- 已发起、待核对的意图 { kind, ... }
local COOLDOWN = {
    heal = 8,
    eat = 5,
    light = 6,
    fuel = 6,
    flee = 10,
    forage = 6,
    sanity = 8,
    stock = 3,
    craft_light = 4,
    temperature = 10,
}

-- ─────────────────────────── 基础小工具 ───────────────────────────

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

local function current_phase()
    local world = GLOBAL.TheWorld
    local state = world ~= nil and world.state or nil
    return state ~= nil and state.phase or nil
end

local function cooldown_ok(key)
    local now = U.now()
    if fail_until[key] ~= nil and now < fail_until[key] then return false end
    local previous = last[key]
    if previous ~= nil and now - previous < (COOLDOWN[key] or 10) then return false end
    return true
end

local function mark(key)
    last[key] = U.now()
end

local function mark_fail(key, seconds)
    fail_until[key] = U.now() + (seconds or 6)
end

local DIAG_GAP = 20         -- 同一个诊断 section 至少隔 20 秒才再打一条
local DIAG_GAP_SAME = 45    -- 内容完全没变时隔得更久

--- 诊断日志：**按 section 限频**（不看文本，防止两种文本交替绕过限频）。
--- 只进 server_log，不塞进 get_state 的"最近做过的事"里 —— 那条通道只放真正做过的动作，
--- 否则模型每轮看到的提示会被诊断刷满（真机实测踩到）。
local function diag(section, lines)
    local now = U.now()
    lines = lines or {}
    local joined = table.concat(lines, " ")
    local prev = last_log[section]
    if prev ~= nil then
        local gap = (prev.text == joined) and DIAG_GAP_SAME or DIAG_GAP
        if now - prev.at < gap then return end
    end
    last_log[section] = { at = now, text = joined }
    local out = "[Reflex] " .. section .. ":"
    for _, line in ipairs(lines) do out = out .. "\n  " .. tostring(line) end
    pcall(function() print(out) end)
end

local function say(p, key, text)
    if p == nil then return end
    local now = U.now()
    local previous = last_said[key]
    if previous ~= nil and now - previous < 20 then return end
    last_said[key] = now
    recent[#recent + 1] = { t = now, text = text }
    while #recent > 8 do table.remove(recent, 1) end
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

--- 反射到底开没开（模组默认开，但**旧存档的 modoverrides 里可能被设成 false**）
function R.Enabled()
    if Whale.reflex_force_off == true then return false, "force_off" end
    if Whale.reflex_on == false then return false, "config_disabled" end
    if Whale.reflex_on == nil then return false, "config_missing" end
    return true, "config_enabled"
end

-- ─────────────────────────── 光源判断 ───────────────────────────

--- 手上有"还能用"的便携光源（有耐久就看耐久，烧光的不算）
--- 光源物品还有没有燃料/耐久：torch 用 fueled，工具用 finiteuses。
--- 两者都读不到时按可用处理（不因为拿不到字段就误判成"没光"）。
local function item_usable(item)
    if item == nil then return false end
    local comps = item.components or {}
    local fueled = comps.fueled
    if fueled ~= nil then
        local ok, empty = pcall(function() return fueled:IsEmpty() end)
        if ok and empty == true then return false end
        local ok_p, pct = pcall(function() return fueled:GetPercent() end)
        if ok_p and type(pct) == "number" and pct <= 0 then return false end
    end
    local uses = comps.finiteuses
    if uses ~= nil then
        local ok, cur = pcall(function() return uses:GetUses() end)
        if ok and type(cur) == "number" and cur <= 0 then return false end
    end
    return true
end

local function hand_light(p)
    local inv = p ~= nil and p.components ~= nil and p.components.inventory or nil
    if inv == nil then return nil end
    local hands = nil
    pcall(function() hands = inv:GetEquippedItem(GLOBAL.EQUIPSLOTS.HANDS) end)
    if hands == nil then return nil end
    if not LIGHT_PREFABS[tostring(hands.prefab or "")] then return nil end
    if not item_usable(hands) then return nil end
    return hands
end

--- 背包里"还能用"的便携光源
local function inventory_light(p)
    local inv = p ~= nil and p.components ~= nil and p.components.inventory or nil
    if inv == nil then return nil end
    local found = nil
    pcall(function()
        inv:ForEachItem(function(item)
            if found ~= nil or item == nil or not item:IsValid() then return end
            if not LIGHT_PREFABS[tostring(item.prefab or "")] then return end
            if item_usable(item) then found = item end
        end)
    end)
    return found
end

--- 附近点着的固定光源（营火/火坑/南瓜灯…）
local function nearby_light(p)
    return U.find_nearest(p, 8, { "light" }, nil, function(e)
        if e == nil or e == p or e:HasTag("player") then return false end
        local permanent = PERMANENT_LIGHTS[tostring(e.prefab or "")] == true
        if not permanent and e.components ~= nil and e.components.inventoryitem ~= nil then
            return false
        end
        local fueled = e.components ~= nil and e.components.fueled or nil
        return fueled == nil or not fueled:IsEmpty()
    end)
end

--- 眼下是否被照亮（手上有效光源 或 附近点着的固定光源）。注意：背包里有一把火把不算"现在有光"。
local function has_light(p)
    if hand_light(p) ~= nil then return true end
    return nearby_light(p) ~= nil
end

--- 综合光源状态：一个表，供决策与诊断共用
local function light_report(p)
    local cr = Whale ~= nil and Whale.craftrules or nil
    local cost = cr ~= nil and cr.NeededIngredients("torch") or nil
    local counts = cr ~= nil and cr.Counts(p) or {}
    local can_craft = cost ~= nil
    local missing = {}
    if cost ~= nil then
        for prefab, need in pairs(cost) do
            local have = counts[prefab] or 0
            if have < need then
                can_craft = false
                missing[#missing + 1] = string.format("%s %d/%d", prefab, have, need)
            end
        end
    end
    table.sort(missing)
    local hand = hand_light(p)
    local inbag = inventory_light(p)
    local near = nearby_light(p)
    return {
        phase = current_phase(),
        hand = hand,
        in_bag = inbag,
        near = near,
        has_usable = (hand ~= nil) or (near ~= nil),
        portable = (hand ~= nil) or (inbag ~= nil),
        can_craft = can_craft,
        missing = missing,
    }
end

local function bool_str(v) return v and "true" or "false" end

local function log_light_check(rep)
    diag("light_check", {
        "has_usable_light=" .. bool_str(rep.has_usable),
        "portable=" .. bool_str(rep.portable),
        "time_of_day=" .. tostring(rep.phase),
    })
    if not rep.portable then
        diag("light_materials", {
            "ready=" .. bool_str(rep.can_craft),
            "missing=" .. (#rep.missing > 0 and table.concat(rep.missing, ", ") or "none"),
        })
    end
end

-- ─────────────────────────── 原生小动作（不建 Whale.job）───────────────────────────

local function exact_ready(p, prefab, radius)
    return U.find_nearest(p, radius or 10, nil, nil, function(e)
        if e == nil or e.prefab ~= prefab then return false end
        if e:HasTag("barren") then return false end
        local pickable = e.components ~= nil and e.components.pickable or nil
        if pickable == nil then return false end
        local ok, can = pcall(function() return pickable:CanBePicked() end)
        return ok and can == true
    end)
end

local function push_pick(p, ent)
    if p == nil or ent == nil then return false end
    local ok_busy, buffered = pcall(function() return p:GetBufferedAction() end)
    if ok_busy and buffered ~= nil then return false end
    local ok_ba, ba = pcall(function() return GLOBAL.BufferedAction(p, ent, GLOBAL.ACTIONS.PICK, nil) end)
    if not ok_ba or ba == nil then return false end
    return pcall(function() A.push(p, ba) end)
end

local function push_harvest(p, ent)
    if p == nil or ent == nil then return false end
    local ok_busy, buffered = pcall(function() return p:GetBufferedAction() end)
    if ok_busy and buffered ~= nil then return false end
    local ok_ba, ba = pcall(function() return GLOBAL.BufferedAction(p, ent, GLOBAL.ACTIONS.HARVEST, nil) end)
    if not ok_ba or ba == nil then return false end
    return pcall(function() A.push(p, ba) end)
end

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

local function ready_ground_food(p, radius)
    local rules = Whale ~= nil and Whale.pickuprules or nil
    local eat = Whale ~= nil and Whale.eatrules or nil
    if rules == nil or eat == nil then return nil end
    return U.find_nearest(p, radius, nil, nil, function(e)
        if not rules.IsCandidate(e, p) then return false end
        local edible = e.components ~= nil and e.components.edible or nil
        if edible == nil then return false end
        return eat.IsAllowedPrefab(tostring(e.prefab or "")) == true
    end)
end

-- ─────────────────────────── 威胁判断 ───────────────────────────

local function nearest_hostile(p, radius_tiles)
    local limit = radius_tiles * U.TILE
    return U.find_nearest(p, radius_tiles, { "hostile" }, nil, function(e)
        local h = e ~= nil and e.components ~= nil and e.components.health or nil
        if h == nil or h:IsDead() then return false end
        return U.dist(p, e) <= limit
    end)
end

local function combat_targeting(foe, p)
    local c = foe ~= nil and foe.components ~= nil and foe.components.combat or nil
    if c == nil then return false end
    local ok, target = pcall(function() return c.target end)
    return ok and target == p
end

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

--- 残血 + 敌人已经贴脸：允许抢占模型正在跑的任务。
function R.CriticalDanger(p)
    local attacker = nearest_hostile(p, 3)
    if attacker ~= nil and combat_targeting(attacker, p) then return true end
    local hp = health_percent(p)
    if hp == nil or hp >= 0.35 then return false end
    if nearest_hostile(p, 2.5) ~= nil then return true end
    return hp < 0.2 and nearest_hostile(p, 5) ~= nil
end

-- ─────────────────────────── 具体反射动作 ───────────────────────────

--- 撤退（P0）
local function reflex_flee(p)
    local hp = health_percent(p)
    local sanity = sanity_percent(p)
    local danger_low_hp = hp ~= nil and hp < 0.5
    local danger_shadow = sanity ~= nil and sanity < 0.25
    local radius = danger_low_hp and 4 or 5
    local foe = nearest_hostile(p, radius)
    local attacked = foe ~= nil and combat_targeting(foe, p)
    if not danger_low_hp and not danger_shadow and not attacked then return false end
    if foe == nil then return false end

    local fx, _, fz = U.pos(foe)
    local px, _, pz = U.pos(p)
    if fx == nil or px == nil then return false end
    local dx, dz = px - fx, pz - fz
    local len = math.sqrt(dx * dx + dz * dz)
    if len < 0.01 then dx, dz, len = 1, 0, 1 end

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
        local why = danger_shadow and "暗影怪贴上来了，先撤"
            or (danger_low_hp and "血不多了，先撤到安全的地方" or "有怪在打我，先撤")
        say(p, "flee", why)
        return true
    end
    return false
end

--- 做一把火把（用原生 craft 路径 + craftrules 精确核对材料）—— 白天也做。
local function craft_torch(p)
    local cr = Whale ~= nil and Whale.craftrules or nil
    if cr == nil then return false end
    local ok_ing, missing = cr.HasIngredients(p, "torch")
    if not ok_ing then
        diag("craft_torch", { "started=false", "reason=" .. tostring(missing) })
        mark_fail("craft_light", 6)
        return false
    end
    local started = A.Start("craft", { recipe = "torch", count = 1 }, REFLEX_ID,
        { survival_craft = true, recipe = "torch" })
    if started then
        pending = { kind = "craft_torch", t0 = U.now() }
        say(p, "craft_light", "先把火把做出来，别等天黑")
        diag("craft_torch", { "started=true" })
        return true
    end
    return false
end

--- 天黑没光（P0）：举火把 → 做火把 → 生营火
local function reflex_light(p)
    if has_light(p) then return false end

    local bag = inventory_light(p)
    if bag ~= nil then
        local started = A.Start("equip", { item = "torch" }, REFLEX_ID)
        if started then say(p, "light", "天黑了，先把火把举起来") end
        return started
    end

    if craft_torch(p) then return true end

    if A.count_item(p, "log") >= 2 and A.count_item(p, "cutgrass") >= 3 then
        local started = A.Start("make_fire", {}, REFLEX_ID)
        if started then say(p, "light", "材料不够做火把，先生一堆营火") end
        return started
    end

    diag("light_check", { "has_usable_light=false", "action=none", "reason=no_light_materials" })
    mark_fail("light", 6)
    return false
end

--- 吃（安全白名单）
local function reflex_eat(p)
    local rules = Whale ~= nil and Whale.eatrules or nil
    local inv = p ~= nil and p.components ~= nil and p.components.inventory or nil
    if rules == nil or inv == nil then return false end
    local item = rules.PickBest(inv)
    if item == nil then return false end
    local hungry = hunger_percent(p)
    if hungry ~= nil and hungry > 0.98 then return false end  -- 吃饱了，别浪费食物
    local started = A.Start("eat", {}, REFLEX_ID, { survival_eat = true })
    if started then
        pending = { kind = "eat", hunger_before = hungry, t0 = U.now() }
        say(p, "eat", "饿了/血少了，先吃点安全的东西")
        return true
    end
    return false
end

--- 回血（有治疗物品优先生药，否则靠吃）
local function reflex_heal(p)
    local healer = find_healer_prefab(p)
    if healer ~= nil then
        local started = A.Start("heal", { item = healer }, REFLEX_ID)
        if started then
            pending = { kind = "heal", hp_before = health_percent(p), t0 = U.now() }
            say(p, "heal", "血不多了，先上药")
            return true
        end
        return false
    end
    return reflex_eat(p)
end

--- 白天补火把材料（P2）：**在缺的材料里，挑一个附近真能采到的**。
--- 真机踩到：只盯第一个缺的（cutgrass）时，附近没草就一直空转，
--- 而树苗明明在 1.7 格也不去采，2 分半钟背包还是空的。
local function reflex_stock_light(p, rep)
    if rep == nil then rep = light_report(p) end
    if rep.portable then return false end          -- 已经有能带走的光源
    if rep.can_craft then return false end          -- 材料够 → 交给 P1 的 craft，不再采
    if not cooldown_ok("stock") then return false end

    local cr = Whale ~= nil and Whale.craftrules or nil
    local cost = cr ~= nil and cr.NeededIngredients("torch") or nil
    if cost == nil then return false end
    local counts = cr.Counts(p)

    local candidates = {}
    for prefab, need in pairs(cost) do
        if (counts[prefab] or 0) < need then
            local source = nil
            if prefab == "cutgrass" then source = "grass"
            elseif prefab == "twigs" then source = "sapling" end
            if source ~= nil then
                candidates[#candidates + 1] = { prefab = prefab, source = source }
            end
        end
    end
    table.sort(candidates, function(a, b) return a.prefab < b.prefab end)

    for _, c in ipairs(candidates) do
        -- 用附近观察半径（16 格）找，但不走出安全区（不 move_to）
        local target = exact_ready(p, c.source, 16)
        if target ~= nil then
            if push_pick(p, target) then
                mark("stock")
                say(p, "stock", c.source == "grass" and "先采点草，凑火把材料" or "先采点树枝，凑火把材料")
                return true
            end
            return false
        end
    end

    diag("light_materials", { "nearby=none", "missing=" .. table.concat(rep.missing or {}, ", ") })
    mark_fail("stock", 5)
    return false
end

--- 没安全食物时去采浆果/捡地上的吃的（P2）
local function reflex_forage(p)
    local hp = health_percent(p)
    local hunger = hunger_percent(p)
    local need_food = (hunger ~= nil and hunger < FORAGE_AHEAD) or (hp ~= nil and hp < 0.5)
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
    mark_fail("forage", 4)
    return false
end

--- 火快灭了（P2）
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

--- 理智太低（P3）：白天/有光时采花
local function reflex_sanity(p)
    local sanity = sanity_percent(p)
    if sanity == nil or sanity >= SANITY_LOW then return false end
    if not cooldown_ok("sanity") then return false end
    local phase = current_phase()
    if (phase == "dusk" or phase == "night") and not has_light(p) then return false end
    local flower = exact_ready(p, "flower", 10)
    if flower ~= nil and push_pick(p, flower) then
        mark("sanity")
        say(p, "sanity", "理智太低了，先补一点")
        return true
    end
    return false
end

--- 温度异常（P1，只做安全的"靠近/远离火"）
local function temperature_need(p)
    local comp = p ~= nil and p.components ~= nil and p.components.temperature or nil
    if comp == nil then return nil end
    local ok, t = pcall(function() return comp:GetCurrent() end)
    if not ok or type(t) ~= "number" then return nil end
    local cold = t < 5
    local hot = t > 65
    if not cold and not hot then return nil end
    return {
        reason = cold and "temperature_cold" or "temperature_hot",
        run = function(p2)
            local fire = U.find_nearest(p2, 20, { "fire" }, nil, function(e)
                local fueled = e.components ~= nil and e.components.fueled or nil
                return fueled == nil or not fueled:IsEmpty()
            end)
            if fire == nil then
                diag("temperature", { "too_" .. (cold and "cold" or "hot") .. "=true", "fire=none" })
                mark_fail("temperature", 10)
                return false
            end
            local fx, _, fz = U.pos(fire)
            local px, _, pz = U.pos(p2)
            if fx == nil or px == nil then return false end
            local tx, tz
            if cold then
                tx, tz = U.tile_of(fx, fz)
            else
                local dx, dz = px - fx, pz - fz
                local len = math.sqrt(dx * dx + dz * dz)
                if len < 0.01 then dx, dz, len = 1, 0, 1 end
                tx, tz = U.tile_of(px + dx / len * 6 * U.TILE, pz + dz / len * 6 * U.TILE)
            end
            local started = A.Start("move_to", { x = tx, z = tz, timeout = 8 }, REFLEX_ID)
            if started then
                say(p2, "temperature", cold and "太冷了，先去火边暖和一下" or "太热了，先离火远一点")
            end
            return started
        end,
    }
end

-- ─────────────────────────── 优先级与安全抢占 ───────────────────────────

--- 当前任务的优先级（模型任务一律 P3；反射任务看自己标的等级）
local function job_priority(job)
    if job == nil then return nil end
    if job.cmd_id == REFLEX_ID then return job.reflex_priority or P1 end
    return P3
end

--- 通过 A.Abort（唯一正式取消路径）中断当前任务；确认旧任务已停、且没有遗留 buffered action。
--- 绝不直接清 Whale.job，也绝不在旧动作没清干净时启动第二个动作。
local function interrupt_current(reason)
    local job = Whale.job
    if job == nil then return true end
    local old_name = tostring(job.name)
    local ok = pcall(function() A.Abort(reason) end)
    local cleared = (Whale.job == nil)
    local p = U.player()
    local buffered = false
    if p ~= nil then
        local ok_b, ba = pcall(function() return p:GetBufferedAction() end)
        if ok_b then buffered = (ba ~= nil) end
    end
    diag("protection", {
        "current_job=" .. old_name,
        "interrupt=true",
        "reason=" .. tostring(reason),
        "job_cleared=" .. bool_str(cleared),
        "buffered_action=" .. bool_str(buffered),
        "ok=" .. bool_str(ok),
    })
    return cleared and not buffered
end

--- 尝试执行一个反射动作：防抖 → 冷却 → 抢占判断 → 中断 → 执行
local function try_action(p, key, priority, reason, fn)
    -- 同一意图已经在跑：不重复建任务
    if inflight ~= nil and inflight.key == key and Whale.job == inflight.job then
        return false
    end
    if not cooldown_ok(key) then return false end

    local job = Whale.job
    if job ~= nil then
        if priority > P1 then
            diag("skipped", { "reason=job_running", "intent=" .. key, "current_job=" .. tostring(job.name) })
            return false
        end
        local cur = job_priority(job) or P3
        if priority >= cur then
            diag("skipped", { "reason=lower_or_equal_priority", "intent=" .. key,
                              "current_job=" .. tostring(job.name) })
            return false
        end
        if not interrupt_current(reason) then
            diag("skipped", { "reason=interrupt_failed", "intent=" .. key })
            return false
        end
    end

    local started = fn()
    if started then
        mark(key)
        local j = Whale.job
        if j ~= nil and j.cmd_id == REFLEX_ID then
            j.reflex_key = key
            j.reflex_priority = priority
            inflight = { key = key, job = j, priority = priority }
        end
        return true
    end
    return false
end

-- ─────────────────────────── 状态同步 / 结果核对 ───────────────────────────

local function sync_inflight()
    local job = Whale.job
    if job == nil or job.cmd_id ~= REFLEX_ID then
        inflight = nil
        return
    end
    if inflight == nil or inflight.job ~= job then
        inflight = { key = job.reflex_key or "unknown", job = job, priority = job.reflex_priority or P1 }
    end
end

--- 反射发起的任务结束后，用**真实状态**核对结果（不许把失败说成成功）
local function confirm_pending(p)
    if pending == nil then return end
    local job = Whale.job
    if job ~= nil and job.cmd_id == REFLEX_ID then return end   -- 还在跑

    if pending.kind == "craft_torch" then
        local cr = Whale ~= nil and Whale.craftrules or nil
        local have = cr ~= nil and (cr.Counts(p)["torch"] or 0) or 0
        local hand = hand_light(p)
        local ok = (have > 0) or (hand ~= nil)
        diag("craft_torch", {
            "started=true",
            "result=" .. (ok and "succeeded" or "failed"),
            "inventory_confirmed=" .. bool_str(have > 0),
            "in_hand=" .. bool_str(hand ~= nil),
        })
        if not ok then mark_fail("craft_light", 8) end
    elseif pending.kind == "eat" then
        local now = hunger_percent(p)
        local delta = (now ~= nil and pending.hunger_before ~= nil) and (now - pending.hunger_before) or nil
        diag("eat", {
            "result=" .. ((delta ~= nil and delta > 0.005) and "succeeded" or "unconfirmed"),
            "hunger_delta=" .. (delta ~= nil and string.format("%.1f", delta) or "?"),
        })
    elseif pending.kind == "heal" then
        local now = health_percent(p)
        local delta = (now ~= nil and pending.hp_before ~= nil) and (now - pending.hp_before) or nil
        diag("heal", { "result=" .. ((delta ~= nil and delta > 0.001) and "succeeded" or "unconfirmed") })
    end
    pending = nil
end

local function reset_state(reason)
    inflight = nil
    pending = nil
    last = {}
    fail_until = {}
    last_log = {}
    diag("reset", { "reason=" .. tostring(reason) })
end

--- 给 get_state / 诊断用：当前最高优先级需求（只判规则，不执行）
function R.Priority(p)
    if p == nil then return P3, "no_player" end
    local phase = current_phase()
    local hp = health_percent(p)
    local hunger = hunger_percent(p)
    local sanity = sanity_percent(p)
    local rep = light_report(p)

    local attacker = nearest_hostile(p, 3)
    if attacker ~= nil and combat_targeting(attacker, p) then return P0, "under_attack" end
    if hp ~= nil and hp < 0.25 and nearest_hostile(p, 2.5) ~= nil then return P0, "critical_health" end
    if (phase == "dusk" or phase == "night") and not rep.has_usable then return P0, "dark_no_light" end

    if phase ~= "dusk" and phase ~= "night" and not rep.portable then
        if rep.can_craft then return P1, "light_preparation" end
        return P2, "light_materials"
    end
    if hunger ~= nil and hunger < EAT_EMERGENCY then return P1, "hunger_emergency" end
    if hp ~= nil and hp < HEAL_EMERGENCY then return P1, "health_low" end

    local temp = temperature_need(p)
    if temp ~= nil then return P1, temp.reason end
    if sanity ~= nil and sanity < SANITY_LOW then return P3, "sanity_low" end
    return P3, "idle"
end

-- ─────────────────────────── 主循环（每 0.2 秒调一次，内部 1 秒节流）───────────────────────────

local function run(p)
    local phase = current_phase()
    local rep = light_report(p)
    log_light_check(rep)

    local hp = health_percent(p)
    local hunger = hunger_percent(p)
    local sanity = sanity_percent(p)

    local prio, why = R.Priority(p)
    if prio <= P1 then
        diag("priority", { "priority=P" .. tostring(prio), "reason=" .. tostring(why) })
    end

    -- ── P0：立即保命（可抢占任何任务）
    local attacker = nearest_hostile(p, 3)
    if attacker ~= nil and combat_targeting(attacker, p) then
        if try_action(p, "flee", P0, "under_attack", function() return reflex_flee(p) end) then return end
    end
    if hp ~= nil and hp < 0.25 and nearest_hostile(p, 2.5) ~= nil then
        if try_action(p, "flee", P0, "critical_health", function() return reflex_flee(p) end) then return end
    end
    if (phase == "dusk" or phase == "night") and not rep.has_usable then
        if try_action(p, "light", P0, "dark_no_light", function() return reflex_light(p) end) then return end
    end

    -- ── P1：高优先生存需求（可在安全时中断普通采集/探索）
    if phase ~= "dusk" and phase ~= "night" and (not rep.portable) and rep.can_craft then
        if try_action(p, "craft_light", P1, "light_preparation", function() return craft_torch(p) end) then return end
    end
    if hunger ~= nil and hunger < EAT_EMERGENCY then
        if try_action(p, "eat", P1, "hunger_emergency", function() return reflex_eat(p) end) then return end
    end
    if hp ~= nil and hp < HEAL_EMERGENCY then
        if try_action(p, "heal", P1, "health_low", function() return reflex_heal(p) end) then return end
    end
    local temp = temperature_need(p)
    if temp ~= nil then
        if try_action(p, "temperature", P1, temp.reason, temp.run) then return end
    end

    -- ── P2/P3：只在没有任务时做（不抢模型任务）
    if Whale.job ~= nil then return end
    if phase ~= "dusk" and phase ~= "night" and (not rep.portable) and (not rep.can_craft) then
        if reflex_stock_light(p, rep) then return end
    end
    if reflex_forage(p) then return end
    if reflex_fuel(p) then return end
    if sanity ~= nil and sanity < SANITY_LOW then reflex_sanity(p) end
end

local tick = 0
function R.Tick()
    local enabled, why = R.Enabled()
    if not enabled then
        tick = tick + 1
        if tick % 5 == 0 then diag("enabled", { "enabled=false", "reason=" .. tostring(why) }) end
        return
    end
    tick = tick + 1
    if tick % 5 ~= 0 then return end       -- ≈1 秒一次

    local p = U.player()
    if p == nil then
        reset_state("no_player")
        return
    end
    local hp_comp = p.components ~= nil and p.components.health or nil
    if hp_comp == nil then return end
    local dead, ghost, valid = false, false, true
    pcall(function() dead = hp_comp:IsDead() end)
    pcall(function() ghost = p:HasTag("playerghost") end)
    pcall(function() valid = p:IsValid() end)
    if dead or ghost or not valid then
        reset_state(dead and "dead" or (ghost and "ghost" or "invalid_actor"))
        return
    end

    sync_inflight()
    confirm_pending(p)

    local ok, err = pcall(function() run(p) end)
    if not ok then
        Whale.last_reflex_error = tostring(err)
        diag("error", { tostring(err) })
        U.log("保命反射出错：" .. tostring(err))
    end
end

function R.Status()
    local out = {}
    for k, v in pairs(last) do out[k] = v end
    local enabled, why = R.Enabled()
    out.enabled = enabled
    out.enabled_reason = why
    if inflight ~= nil then out.intent = inflight.key end
    return out
end

--- 结构化诊断（给 get_state / 排查用）
function R.Diagnose()
    local p = U.player()
    local enabled, why = R.Enabled()
    local out = { enabled = enabled, enabled_reason = why }
    if p == nil or p.components == nil or p.components.health == nil then
        out.actor = "none"
        return out
    end
    local rep = light_report(p)
    local prio, reason = R.Priority(p)
    out.phase = rep.phase
    out.priority = "P" .. tostring(prio)
    out.priority_reason = reason
    out.has_usable_light = rep.has_usable
    out.portable_light = rep.portable
    out.can_craft_torch = rep.can_craft
    out.light_missing = rep.missing
    out.job = Whale.job ~= nil and tostring(Whale.job.name) or nil
    out.health = health_percent(p)
    out.hunger = hunger_percent(p)
    out.sanity = sanity_percent(p)
    return out
end

Whale = Whale or {}
Whale.reflex = R
