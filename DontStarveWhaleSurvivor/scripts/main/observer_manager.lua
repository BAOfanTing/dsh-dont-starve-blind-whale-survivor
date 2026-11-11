-- Blind Whale Survivor · Phase 1 · 观察器管理器（里程碑 2：加载检测 + 日志输出）
--
-- 本阶段的边界：**只读**。不操作角色、不改游戏状态、不寻路、不打怪、不调 AI。
--
-- 做法：
--   1. boot()：世界就绪后打一条 type="boot" 的日志，证明模组加载成功、跑在哪一端；
--   2. DoPeriodicTask(interval)：按固定周期打一条 type="heartbeat"，带最小可用信息
--      （有没有玩家、第几天、昼夜、季节）——既是保活，也是给 Bridge 做解析的最小样本；
--   3. 全部包在 pcall 里：观察器出问题只能少打日志，不能影响游戏。
--
-- 日志协议（Bridge 按这个解析）：
--   每行形如：  [00:12:34]: [BWS] {"schema_version":"1","type":"boot",...}
--   `[BWS] ` 之后是**单行、完整**的 JSON，一行一条，不跨行。
--
-- 沙箱：mod 环境没有 pcall / tonumber，全部从 GLOBAL 取。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

BWS = BWS or {}

BWS.phase = 1
BWS.observer_version = "0.1.0"
BWS.schema_version = "1"
BWS.tag = "[BWS]"
-- mod 文件夹名（mod 环境里给了 modname；没有就退回默认值）
BWS.modname = BWS.modname or (modname ~= nil and tostring(modname) or "BlindWhaleSurvivor")

local DEFAULT_INTERVAL = 2
local MIN_INTERVAL = 0.5
local MAX_INTERVAL = 30

local O = {
    started = false,
    side = "unknown",
    shard = "unknown",
    interval = DEFAULT_INTERVAL,
    loop_count = 0,
    error_count = 0,
    last_error = nil,
}

-- ───────────────────────── 小工具 ─────────────────────────

--- 读 modinfo 里的 configuration_options（这是 mod 环境上的函数，不在 GLOBAL 上）
local function modconfig(key, default)
    local getter = env ~= nil and env.GetModConfigData or nil
    if getter == nil then return default end
    local ok, value = pcall(getter, key)
    if ok and value ~= nil then return value end
    return default
end

local function clamp_interval(value)
    local n = tonumber(value) or DEFAULT_INTERVAL
    if n < MIN_INTERVAL then return MIN_INTERVAL end
    if n > MAX_INTERVAL then return MAX_INTERVAL end
    return n
end

--- 一次 log 输出。任何编码/拼接错误都在这里吞掉，绝不让它冒到游戏里。
local function emit(payload)
    local ok, err = pcall(function()
        print(BWS.tag .. " " .. BWS.json.encode(payload))
    end)
    if not ok then
        O.error_count = O.error_count + 1
        O.last_error = tostring(err)
        pcall(print, BWS.tag .. ' {"schema_version":"1","type":"error","stage":"encode"}')
    end
end

--- 每条日志的公共字段（字段来源都在 docs/phase1/02 里逐条对应到游戏 API）
local function base(kind)
    local payload = {
        schema_version = BWS.schema_version,
        type = kind,
        phase = BWS.phase,
        observer_version = BWS.observer_version,
        side = O.side,
        shard = O.shard,
        t = nil,  -- 先占位，下面按可用性填
    }
    -- 真实时间（unix 秒）：GLOBAL.os 在引擎的 _G 上；取不到就不写这个字段
    local os_ = GLOBAL.os
    if os_ ~= nil and os_.time ~= nil then
        local ok, value = pcall(os_.time)
        if ok and value ~= nil then payload.t = value end
    end
    -- 游戏内经过的秒数（服务器暂停时不走）
    if GLOBAL.TheSim ~= nil then
        local ok, value = pcall(function() return GLOBAL.TheSim:GetTime() end)
        if ok and value ~= nil then payload.gt = BWS.json.round(value, 2) end
    end
    -- 会话标识：TheNet:GetSessionIdentifier()（quagmire_recipebook.lua 等都在用）
    if GLOBAL.TheNet ~= nil then
        local ok, value = pcall(function() return GLOBAL.TheNet:GetSessionIdentifier() end)
        if ok and value ~= nil then payload.session = tostring(value) end
    end
    return payload
end

--- 服务端视角的玩家统计（只数数，不做扫描）
local function player_stats()
    local players = GLOBAL.AllPlayers
    if players == nil then
        return { available = false, count = -1, valid = false, prefab = nil }
    end
    local count = 0
    local first_valid = nil
    for _, player in pairs(players) do
        if player ~= nil then
            count = count + 1
            if first_valid == nil and player:IsValid() then
                first_valid = player
            end
        end
    end
    return {
        available = true,
        count = count,
        valid = first_valid ~= nil,
        prefab = first_valid ~= nil and first_valid.prefab or nil,
    }
end

-- ───────────────────────── 对外 ─────────────────────────

--- 世界状态（里程碑 4 会扩展；这里只用最基础的几个字段证明读得到）
local function peek_world()
    local world = GLOBAL.TheWorld
    if world == nil or world.state == nil then return nil end
    local state = world.state
    return {
        day = BWS.json.number(state.cycles, nil),
        phase = state.phase,
        season = state.season,
        temperature = BWS.json.round(state.temperature, 1),
    }
end

function O.Tick()
    O.loop_count = O.loop_count + 1
    local ok, err = pcall(function()
        local payload = base("heartbeat")
        local players = player_stats()
        payload.tick = O.loop_count
        payload.interval = O.interval
        payload.players = players
        payload.world = peek_world()
        payload.errors = O.error_count
        if O.last_error ~= nil then payload.last_error = O.last_error end
        emit(payload)
    end)
    if not ok then
        O.error_count = O.error_count + 1
        O.last_error = tostring(err)
    end
end

--- 启动观察器。世界还没就绪时返回 false，调用方之后可以再试。
function O.Start()
    if O.started then return true end
    local world = GLOBAL.TheWorld
    if world == nil then return false end

    O.started = true
    O.interval = clamp_interval(modconfig("OBSERVER_INTERVAL", DEFAULT_INTERVAL))
    O.side = world.ismastersim and "server" or "client"
    -- Master / Caves 分片：世界带 cave 标签的就是洞穴
    local ok, is_cave = pcall(function() return world:HasTag("cave") end)
    O.shard = (ok and is_cave) and "caves" or "master"

    local payload = base("boot")
    payload.mod = BWS.modname or "BlindWhaleSurvivor"
    payload.ismastersim = world.ismastersim and true or false
    payload.interval = O.interval
    payload.players = player_stats()
    payload.world = peek_world()
    emit(payload)

    world:DoPeriodicTask(O.interval, O.Tick)
    return true
end

function O.Status()
    return {
        started = O.started,
        side = O.side,
        shard = O.shard,
        interval = O.interval,
        loops = O.loop_count,
        errors = O.error_count,
    }
end

BWS.observer = O
