-- Blind Whale Survivor · Phase 1 · 观察器管理器
--
-- 职责：找到要观察的玩家 → 调观察器（player / inventory / world / entity）→ 交给序列化器输出。
-- 本阶段**只读**：不操作角色、不改游戏状态、不寻路、不打怪、不调 AI。
--
-- 输出（序列化细节见 scripts/main/state_serializer.lua，契约见 schema/state.schema.json）：
--   type="boot"    世界就绪时一条
--   type="state"   每 OBSERVER_INTERVAL 秒一条：session / player / inventory / world / observer
--   type="nearby"  每 OBSERVER_SCAN_SECONDS 扫一次，单独一条（日志单行有长度上限，不能塞进 state）
--
-- 沙箱：mod 环境没有 pcall / tonumber / next / os / io，全部从 GLOBAL 取。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

BWS = BWS or {}

BWS.phase = 1
BWS.observer_version = "0.3.0"
BWS.schema_version = "1"
BWS.tag = "[BWS]"
BWS.modname = BWS.modname or (modname ~= nil and tostring(modname) or "BlindWhaleSurvivor")

local DEFAULT_INTERVAL = 2
local MIN_INTERVAL = 0.5
local MAX_INTERVAL = 30
local DEFAULT_RADIUS = 16
local MAX_RADIUS = 40

local O = {
    started = false,
    side = "unknown",
    shard = "unknown",
    interval = DEFAULT_INTERVAL,
    loop_count = 0,
    error_count = 0,
    last_error = nil,
    nearby = nil,             -- 最近一次实体扫描结果（缓存）
    scan_ticks = 1,           -- 每多少个 state 周期扫一次
    last_scan_tick = -1000,
    radius_tiles = DEFAULT_RADIUS,
    problems = nil,
}

-- ───────────────────────── 小工具 ─────────────────────────

local function modconfig(key, default)
    local getter = env ~= nil and env.GetModConfigData or nil
    if getter == nil then return default end
    local ok, value = pcall(getter, key)
    if ok and value ~= nil then return value end
    return default
end

local function clamp(value, min, max, fallback)
    local n = tonumber(value)
    if n == nil then return fallback end
    if n < min then return min end
    if n > max then return max end
    return n
end

local function clamp_interval(value)
    return clamp(value, MIN_INTERVAL, MAX_INTERVAL, DEFAULT_INTERVAL)
end

local function clamp_radius(value)
    return clamp(value, 2, MAX_RADIUS, DEFAULT_RADIUS)
end

--- 输出一条记录（长度预算、裁剪、打印都在序列化器里）
local function emit(record, shrink)
    if BWS.serializer == nil then return end
    local ok, err = BWS.serializer.Emit(record, shrink)
    if not ok then
        O.error_count = O.error_count + 1
        O.last_error = tostring(err)
    end
end

--- 服务端第一个有效玩家（单人游戏就一个；多人时先取第一个）
local function first_player()
    local players = GLOBAL.AllPlayers
    if players == nil then return nil end
    local found = nil
    for _, player in pairs(players) do
        if player ~= nil then
            local ok, valid = pcall(function() return player:IsValid() end)
            if ok and valid then
                found = player
                break
            end
        end
    end
    return found
end

local function count_players()
    local players = GLOBAL.AllPlayers
    if players == nil then return -1 end
    local n = 0
    for _, player in pairs(players) do
        if player ~= nil then n = n + 1 end
    end
    return n
end

--- 公共元信息（含时间戳、会话、分片）；每条记录都会带
local function meta()
    local record_meta = {
        observer_version = BWS.observer_version,
        side = O.side,
        shard = O.shard,
        tick = O.loop_count,
        interval = O.interval,
        errors = O.error_count,
        player_count = count_players(),
        problems = O.problems,
        last_error = O.last_error,
    }
    local os_ = GLOBAL.os
    if os_ ~= nil and os_.time ~= nil then
        local ok, value = pcall(os_.time)
        if ok and value ~= nil then record_meta.t = value end
    end
    if GLOBAL.TheSim ~= nil then
        -- 真实时间（秒）：TheSim 上没有 GetTime()，只有 GetRealTime()（毫秒）
        local ok_real, ms = pcall(function() return GLOBAL.TheSim:GetRealTime() end)
        if ok_real and ms ~= nil then record_meta.rt = BWS.json.round(ms / 1000, 2) end
        local ok_tick, tick = pcall(function() return GLOBAL.TheSim:GetTick() end)
        if ok_tick and tick ~= nil then record_meta.sim_tick = BWS.json.number(tick, nil) end
    end
    if GLOBAL.TheNet ~= nil then
        local ok, value = pcall(function() return GLOBAL.TheNet:GetSessionIdentifier() end)
        if ok and value ~= nil then record_meta.session = tostring(value) end
    end
    return record_meta
end

-- ───────────────────────── 各段 ─────────────────────────

--- 安全调用一个观察器：模块缺失只降级成 xxx_unavailable，不算错误
local function safe_observe(name, module, fn)
    if module == nil then return nil, name .. "_unavailable" end
    local ok, value, reason = pcall(fn)
    if not ok then
        O.error_count = O.error_count + 1
        O.last_error = name .. ": " .. tostring(value)
        return nil, "error"
    end
    if value == nil then return nil, reason or "unavailable" end
    return value, nil
end

--- 实体扫描：按周期做（不在每个 state 里做），结果缓存进 O.nearby
local function maybe_scan(player_entity)
    if BWS.entity_observer == nil then return end
    if player_entity == nil then return end
    if O.loop_count - O.last_scan_tick < O.scan_ticks then return end
    O.last_scan_tick = O.loop_count
    local nearby = safe_observe("nearby", BWS.entity_observer, function()
        return BWS.entity_observer.Observe(player_entity, { radius_tiles = O.radius_tiles })
    end)
    if nearby ~= nil then
        nearby.scanned_at_tick = O.loop_count
        O.nearby = nearby
    end
end

--- 收集这次要输出的各段
local function collect(player_entity)
    local sections = {}
    local problems = nil
    local function note(key, value)
        problems = problems or {}
        problems[key] = value
    end

    if O.side ~= "server" then
        note("player", "client_side")
    elseif player_entity == nil then
        note("player", "no_player")
    else
        maybe_scan(player_entity)
        local player, player_err = safe_observe("player", BWS.player_observer, function()
            return BWS.player_observer.Observe(player_entity, O.side)
        end)
        if player ~= nil then sections.player = player else note("player", player_err) end

        local inventory, inventory_err = safe_observe("inventory", BWS.inventory_observer, function()
            return BWS.inventory_observer.Observe(player_entity)
        end)
        if inventory ~= nil then sections.inventory = inventory else note("inventory", inventory_err) end
    end

    local world, world_err = safe_observe("world", BWS.world_observer, function()
        return BWS.world_observer.Observe()
    end)
    if world ~= nil then sections.world = world else note("world", world_err) end

    O.problems = problems
    return sections
end

-- ───────────────────────── 对外 ─────────────────────────

function O.Tick()
    O.loop_count = O.loop_count + 1
    local ok, err = pcall(function()
        local player_entity = nil
        if O.side == "server" then player_entity = first_player() end
        local sections = collect(player_entity)

        local record_meta = meta()
        emit(BWS.serializer.State(record_meta, sections))

        if O.nearby ~= nil then
            -- 用同一份 meta（tick 相同），Bridge 按 tick 把两条记录配起来
            emit(BWS.serializer.Nearby(record_meta, O.nearby), BWS.serializer.shrink_nearby)
        end
    end)
    if not ok then
        O.error_count = O.error_count + 1
        O.last_error = "tick: " .. tostring(err)
    end
end

--- 启动观察器。世界还没就绪时返回 false（调用方之后可以再试）。
function O.Start()
    if O.started then return true end
    local world = GLOBAL.TheWorld
    if world == nil then return false end

    O.started = true
    O.interval = clamp_interval(modconfig("OBSERVER_INTERVAL", DEFAULT_INTERVAL))
    O.radius_tiles = clamp_radius(modconfig("OBSERVER_SCAN_RADIUS", DEFAULT_RADIUS))
    local scan_seconds = tonumber(modconfig("OBSERVER_SCAN_SECONDS", 4)) or 4
    if scan_seconds < O.interval then scan_seconds = O.interval end
    O.scan_ticks = math.max(1, math.floor(scan_seconds / O.interval + 0.5))
    O.side = world.ismastersim and "server" or "client"
    local ok_cave, is_cave = pcall(function() return world:HasTag("cave") end)
    O.shard = (ok_cave and is_cave) and "caves" or "master"

    emit(BWS.serializer.Boot(meta(), {
        mod = BWS.modname,
        ismastersim = world.ismastersim,
        interval = O.interval,
        player_count = count_players(),
    }))

    world:DoPeriodicTask(O.interval, O.Tick)
    return true
end

function O.Status()
    return {
        started = O.started,
        side = O.side,
        shard = O.shard,
        interval = O.interval,
        scan_ticks = O.scan_ticks,
        radius_tiles = O.radius_tiles,
        loops = O.loop_count,
        errors = O.error_count,
    }
end

BWS.observer = O
