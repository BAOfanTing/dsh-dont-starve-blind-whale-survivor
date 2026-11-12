-- Blind Whale Survivor · Phase 6 M1 · Threat Observer（威胁与环境观察器）
--
-- 只读。两个出口：
--   T.Observe(player, opts)      附近敌对生物 + 每个敌人的战斗状态（谁在追我、谁正在抬手攻击）
--   T.ObserveEnvironment(player) 环境危险输入（黑夜有没有光、火堆、体温、潮湿、下雨、季节）
--
-- 为什么单开一个模块而不是塞进 entity_observer：
--   entity_observer 只回答"附近有什么"，Phase 6 要知道"它对我有没有威胁、它现在能不能打我"。
--   后者必须读 combat 组件的实时状态，扫描间隔也不同（威胁要比静态资源扫得更勤）。
--
-- API 依据（全部 pcall 包住，任何一条在某个构建上不存在都只是少一个字段，不会让观察器崩）：
--   TheSim:FindEntities(x, y, z, radius, musthavetags, canthavetags, musthaveoneoftags)  findclosest.lua
--   ent.components.health:GetPercent() / IsDead()                    health.lua
--   ent.components.combat.target                                     combat.lua（正在追谁）
--   ent.components.combat:CanAttack(target) / GetAttackRange()       combat.lua
--   ent.components.combat.attackperiod / defaultdamage（字段）        combat.lua
--   ent.sg:HasStateTag("attack")                                     stategraph（正在出手）
--   ent.components.sleeper:IsAsleep()                                sleeper.lua
--   ent.Light:IsEnabled()                                            引擎层光照（判断"附近有没有光"）
--   TheWorld.state.isday/isdusk/isnight/season/temperature/israining/wetness/issnowing  worldstate.lua
--   player.components.temperature:GetCurrent() / moisture:GetMoisturePercent()          temperature.lua / moisture.lua
--
-- 重要：**这里只报事实，不下结论**。威胁评分（0~100）在 TypeScript 侧（survival/threat.ts）算，
-- 因为评分要可配置、可单测、能被审计；Lua 端只负责"看到什么"。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

BWS = BWS or {}

local T = {}

local TILE = 4
local DEFAULT_RADIUS = 16
local MAX_RADIUS = 20
local DEFAULT_MAX_LIST = 24
local MAX_LIST = 40

-- 出界 / 纯特效 / 不可交互的东西不参与威胁统计
local CANT_TAGS = { "INLIMBO", "FX", "DECOR", "NOCLICK" }

-- Phase 6 第一批 Boss（只用于"标记"，不用于任何自动决策）
-- 名字与 TypeScript 侧 survival/profiles.ts 的 BOSS_PROFILES 必须一致（tests/phase6-lua.test.mjs 盯着）
local BOSS_PREFABS = {
    deerclops = true,
    bearger = true,
    dragonfly = true,
    beequeen = true,
    antlion = true,
    moose = true,
    klaus = true,
    malbatross = true,
    toadstool = true,
    spiderqueen = true,
    stalker = true,
    crabking = true,
}

local function clamp(value, min, max, fallback)
    local n = tonumber(value)
    if n == nil then return fallback end
    if n < min then return min end
    if n > max then return max end
    return n
end

local function round(value, digits)
    if value == nil then return nil end
    return BWS.json.round(value, digits or 1)
end

local function display_name(prefab)
    if prefab == nil then return nil end
    local strings = GLOBAL.STRINGS
    local key = string.upper(prefab)
    if strings ~= nil and strings.NAMES ~= nil and strings.NAMES[key] ~= nil then
        return strings.NAMES[key]
    end
    return nil
end

local function has_tag(ent, tag)
    if ent == nil or ent.HasTag == nil then return false end
    local ok, value = pcall(function() return ent:HasTag(tag) end)
    return (ok and value == true)
end

--- 这个实体是不是"会打人的生物"（威胁候选）。
--- 保守判定：必须有 combat + health，并且带 hostile 或 monster 标签。
--- 中立动物（beefalo/pigman/rabbit 之类）不算威胁 —— 它们只有被打才会还手。
local function is_threat_candidate(ent)
    if ent == nil then return false end
    local components = ent.components or {}
    if components.combat == nil or components.health == nil then return false end
    if has_tag(ent, "hostile") or has_tag(ent, "monster") then return true end
    return false
end

--- 该敌人的战斗状态（全部按"取不到就省略"处理）
local function combat_state(ent, player)
    local state = {}
    local combat = ent.components ~= nil and ent.components.combat or nil

    -- 正在追谁：combat.target 是当前攻击目标实体
    if combat ~= nil then
        local ok_target, target = pcall(function() return combat.target end)
        if ok_target then
            state.has_target = target ~= nil
            state.targeting_player = (target ~= nil and target == player)
        end
        -- 攻击距离：不同生物不一样（猎犬 2 / 触手 3.5 / 蜘蛛 2 …），必须读真实值
        local ok_range, range = pcall(function() return combat:GetAttackRange() end)
        if ok_range and tonumber(range) ~= nil then state.attack_range = round(range, 2) end
        -- 出手周期（秒）：决定 Kiting 的"打完后退多久"
        local ok_period, period = pcall(function() return combat.attackperiod end)
        if ok_period and tonumber(period) ~= nil then state.attack_period = round(period, 2) end
        -- 基础伤害（字段名在多数生物上是 defaultdamage）
        local ok_damage, damage = pcall(function() return combat.defaultdamage end)
        if ok_damage and tonumber(damage) ~= nil then state.attack_damage = round(damage, 1) end
        -- 现在能不能打到我（受冷却/距离/目标状态影响）
        if player ~= nil then
            local ok_can, can = pcall(function() return combat:CanAttack(player) end)
            if ok_can then state.can_attack_player = can == true end
        end
    end

    -- 正在抬手/出手：状态机带 attack 标签
    if ent.sg ~= nil and ent.sg.HasStateTag ~= nil then
        local ok_attacking, attacking = pcall(function() return ent.sg:HasStateTag("attack") end)
        if ok_attacking then state.attacking = attacking == true end
    end

    -- 睡着了就不算威胁（但如实报出来，别假装没有敌人）
    if ent.components ~= nil and ent.components.sleeper ~= nil then
        local ok_sleep, asleep = pcall(function() return ent.components.sleeper:IsAsleep() end)
        if ok_sleep then state.sleeping = asleep == true end
    end

    return state
end

--- 扫描附近威胁。
--- @return table|nil threats, string|nil reason
function T.Observe(player, opts)
    if player == nil then return nil, "no_player" end
    local ok_valid, valid = pcall(function() return player:IsValid() end)
    if not ok_valid or not valid then return nil, "player_invalid" end
    if GLOBAL.TheSim == nil then return nil, "no_sim" end
    if player.Transform == nil then return nil, "no_transform" end

    local options = opts or {}
    local radius = clamp(options.radius_tiles, 2, MAX_RADIUS, DEFAULT_RADIUS)
    local max_list = clamp(options.max_list, 1, MAX_LIST, DEFAULT_MAX_LIST)

    local ok_pos, x, _y, z = pcall(function() return player.Transform:GetWorldPosition() end)
    if not ok_pos or x == nil then return nil, "no_position" end

    local ok_find, found = pcall(function()
        return GLOBAL.TheSim:FindEntities(x, _y or 0, z, radius * TILE, nil, CANT_TAGS, { "hostile", "monster" })
    end)
    if not ok_find or found == nil then return nil, "find_entities_failed" end

    local list = {}
    local scanned = 0
    local hostile_count = 0
    local chasing = 0
    local attacking = 0
    local boss_count = 0
    local nearest = nil

    for _, ent in ipairs(found) do
        scanned = scanned + 1
        if ent ~= nil and ent ~= player then
            local ok_ent, ent_valid = pcall(function() return ent:IsValid() end)
            if ok_ent and ent_valid and is_threat_candidate(ent) then
                local ex, ez = nil, nil
                if ent.Transform ~= nil then
                    local ok_e, px, _py, pz = pcall(function() return ent.Transform:GetWorldPosition() end)
                    if ok_e then ex, ez = px, pz end
                end
                if ex ~= nil then
                    hostile_count = hostile_count + 1
                    local dx, dz = ex - x, ez - z
                    local distance = math.sqrt(dx * dx + dz * dz) / TILE
                    if nearest == nil or distance < nearest then nearest = round(distance, 1) end

                    local state = combat_state(ent, player)
                    local is_boss = BOSS_PREFABS[ent.prefab] == true or has_tag(ent, "epic")
                    if is_boss then boss_count = boss_count + 1 end
                    if state.targeting_player == true then chasing = chasing + 1 end
                    if state.attacking == true then attacking = attacking + 1 end

                    if #list < max_list then
                        local entry = {
                            prefab = ent.prefab,
                            name = display_name(ent.prefab),
                            distance = round(distance, 1),
                            tile_x = math.floor(ex / TILE),
                            tile_z = math.floor(ez / TILE),
                            is_boss = is_boss,
                        }
                        local health = ent.components ~= nil and ent.components.health or nil
                        if health ~= nil then
                            local ok_hp, percent = pcall(function() return health:GetPercent() end)
                            if ok_hp and percent ~= nil then entry.hp = round(percent * 100, 0) end
                            local ok_dead, dead = pcall(function() return health:IsDead() end)
                            if ok_dead then entry.is_dead = dead == true end
                        end
                        -- 战斗状态平铺（上层要按字段判断，不做嵌套解析）
                        for key, value in pairs(state) do entry[key] = value end
                        list[#list + 1] = entry
                    end
                end
            end
        end
    end

    -- 按距离升序（最危险的通常最近）
    table.sort(list, function(a, b)
        return (a.distance or 99999) < (b.distance or 99999)
    end)

    return {
        radius_tiles = radius,
        scanned = scanned,
        hostile_count = hostile_count,
        returned = #list,
        truncated = hostile_count > #list,
        chasing_count = chasing,
        attacking_count = attacking,
        boss_count = boss_count,
        nearest_distance = nearest,
        threats = list,
    }
end

--- 数一下附近"亮着的光源"（营火/火把/灯笼/发光生物都靠引擎的 Light 组件）
local function count_lights(player, radius)
    local count = 0
    local fires = {}
    if player == nil or player.Transform == nil or GLOBAL.TheSim == nil then return 0, fires end
    local ok_pos, x, y, z = pcall(function() return player.Transform:GetWorldPosition() end)
    if not ok_pos or x == nil then return 0, fires end
    local ok_find, found = pcall(function()
        return GLOBAL.TheSim:FindEntities(x, y or 0, z, radius * TILE, nil, CANT_TAGS)
    end)
    if not ok_find or found == nil then return 0, fires end
    for _, ent in ipairs(found) do
        local ok_ent, ent_valid = pcall(function() return ent:IsValid() end)
        if ok_ent and ent_valid then
            local light = ent.Light
            if light ~= nil then
                local ok_on, on = pcall(function() return light:IsEnabled() end)
                if ok_on and on == true then count = count + 1 end
            end
            if has_tag(ent, "fire") and #fires < 3 then
                local fuel = nil
                if ent.components ~= nil and ent.components.fueled ~= nil then
                    local ok_f, percent = pcall(function() return ent.components.fueled:GetPercent() end)
                    if ok_f and percent ~= nil then fuel = round(percent * 100, 0) end
                end
                fires[#fires + 1] = { prefab = ent.prefab, fuel_percent = fuel }
            end
        end
    end
    return count, fires
end

--- 环境危险输入（Escape Planner / Season Manager 的原料）。
--- 只报读数，不判断"该不该跑"——那是 TypeScript 决策层的事。
function T.ObserveEnvironment(player)
    local world = GLOBAL.TheWorld
    if world == nil then return nil, "no_world" end
    local state = world.state or {}

    local env = {}

    -- 一天中的阶段
    env.is_day = state.isday and true or false
    env.is_dusk = state.isdusk and true or false
    env.is_night = state.isnight and true or false
    env.phase = state.phase

    -- 季节与剩余天数（读游戏真实 worldstate，**不写死日期**）
    env.season = state.season
    if state.remainingdaysinseason ~= nil then
        env.remaining_days_in_season = round(state.remainingdaysinseason, 0)
    end
    if state.elapseddaysinseason ~= nil then
        env.elapsed_days_in_season = round(state.elapseddaysinseason, 0)
    end
    if state.cycles ~= nil then env.day = (tonumber(state.cycles) or 0) + 1 end

    -- 天气
    if state.temperature ~= nil then env.world_temperature = round(state.temperature, 1) end
    env.is_raining = state.israining and true or false
    env.is_snowing = state.issnowing and true or false
    if state.wetness ~= nil then env.wetness = round(state.wetness, 2) end
    if state.issnowcovered ~= nil then env.is_snow_covered = state.issnowcovered and true or false end

    -- 玩家身上的读数
    if player ~= nil and player.components ~= nil then
        local components = player.components
        if components.temperature ~= nil then
            local ok_t, value = pcall(function() return components.temperature:GetCurrent() end)
            if ok_t and value ~= nil then env.player_temperature = round(value, 1) end
        end
        if components.moisture ~= nil then
            local ok_m, percent = pcall(function() return components.moisture:GetMoisturePercent() end)
            if ok_m and percent ~= nil then env.player_wetness_percent = round(percent * 100, 1) end
        end
        if components.health ~= nil then
            local ok_h, percent = pcall(function() return components.health:GetPercent() end)
            if ok_h and percent ~= nil then env.health_percent = round(percent * 100, 1) end
        end
    end

    -- 光源与火堆（黑夜没光 = 致命）
    local lights, fires = count_lights(player, 8)
    env.light_sources_within_8 = lights
    env.in_light = lights > 0
    if #fires > 0 then env.nearby_fires = fires end

    return env
end

BWS.threat_observer = T
