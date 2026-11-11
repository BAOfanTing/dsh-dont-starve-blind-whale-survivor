-- Blind Whale Survivor · Phase 1 · 世界观察器（里程碑 4）
--
-- 只读 TheWorld.state。字段名逐条来自 762172 的 components/worldstate.lua 里 self.data.* 的实际字段：
--   cycles elapseddaysinseason remainingdaysinseason seasonprogress time timeinphase
--   phase isday isdusk isnight season isautumn iswinter isspring issummer
--   temperature israining precipitation precipitationrate wetness iswet
--   issnowing snowlevel issnowcovered isacidraining
--   moonphase isfullmoon isnewmoon iswaxingmoon
--   cavephase iscaveday iscavedusk iscavenight cavemoonphase
--
-- 约定：
--   * 只写**取得到**的字段（nil 直接省略），所以地面/洞穴共用一个结构；
--   * 布尔值即使 false 也会写出来（false ≠ nil，消费方可以放心读）；
--   * day 用 cycles + 1（游戏里第 1 天 cycles = 0），同时保留原始 cycles。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local next = GLOBAL.next -- 沙箱里没有 next，也要从 GLOBAL 拿

BWS = BWS or {}

local W = {}

--- 只写非 nil 字段
local function put(target, key, value)
    if value ~= nil then target[key] = value end
end

local function bool_or_nil(value)
    if value == nil then return nil end
    return value and true or false
end

function W.Observe()
    local world = GLOBAL.TheWorld
    if world == nil then return nil, "no_world" end
    local state = world.state
    if state == nil then return nil, "no_world_state" end

    local ok_cave, is_cave = pcall(function() return world:HasTag("cave") end)

    local result = {
        prefab = world.prefab,
        shard = (ok_cave and is_cave) and "caves" or "master",
    }

    -- 天数：cycles 从 0 开始，玩家看到的第几天 = cycles + 1
    local cycles = BWS.json.number(state.cycles, nil)
    if cycles ~= nil then
        result.cycles = cycles
        result.day = cycles + 1
    end

    put(result, "phase", state.phase)
    put(result, "is_day", bool_or_nil(state.isday))
    put(result, "is_dusk", bool_or_nil(state.isdusk))
    put(result, "is_night", bool_or_nil(state.isnight))

    put(result, "season", state.season)
    put(result, "is_autumn", bool_or_nil(state.isautumn))
    put(result, "is_winter", bool_or_nil(state.iswinter))
    put(result, "is_spring", bool_or_nil(state.isspring))
    put(result, "is_summer", bool_or_nil(state.issummer))
    put(result, "elapsed_days_in_season", BWS.json.round(state.elapseddaysinseason, 0))
    put(result, "remaining_days_in_season", BWS.json.round(state.remainingdaysinseason, 0))
    put(result, "season_progress", BWS.json.round(state.seasonprogress, 3))

    put(result, "temperature", BWS.json.round(state.temperature, 1))

    -- 一天里的时间进度（0~1）：给后面的“要不要睡觉/天黑了没”判断用
    local time_block = {}
    put(time_block, "of_day", BWS.json.round(state.time, 3))
    put(time_block, "in_phase", BWS.json.round(state.timeinphase, 3))
    if next(time_block) ~= nil then result.time = time_block end

    local weather = {}
    put(weather, "is_raining", bool_or_nil(state.israining))
    put(weather, "precipitation", BWS.json.round(state.precipitation, 2))
    put(weather, "precipitation_rate", BWS.json.round(state.precipitationrate, 2))
    put(weather, "wetness", BWS.json.round(state.wetness, 2))
    put(weather, "is_wet", bool_or_nil(state.iswet))
    put(weather, "is_snowing", bool_or_nil(state.issnowing))
    put(weather, "snow_level", BWS.json.round(state.snowlevel, 2))
    put(weather, "is_snow_covered", bool_or_nil(state.issnowcovered))
    put(weather, "is_acid_raining", bool_or_nil(state.isacidraining))
    if next(weather) ~= nil then result.weather = weather end

    local moon = {}
    put(moon, "phase", state.moonphase)
    put(moon, "is_full_moon", bool_or_nil(state.isfullmoon))
    put(moon, "is_new_moon", bool_or_nil(state.isnewmoon))
    put(moon, "is_waxing_moon", bool_or_nil(state.iswaxingmoon))
    if next(moon) ~= nil then result.moon = moon end

    -- 洞穴分片额外字段（在 Master 分片上全是 nil，会被 put 自动跳过）
    local cave = {}
    put(cave, "phase", state.cavephase)
    put(cave, "is_day", bool_or_nil(state.iscaveday))
    put(cave, "is_dusk", bool_or_nil(state.iscavedusk))
    put(cave, "is_night", bool_or_nil(state.iscavenight))
    put(cave, "moon_phase", state.cavemoonphase)
    if next(cave) ~= nil then result.cave = cave end

    return result
end

BWS.world_observer = W
