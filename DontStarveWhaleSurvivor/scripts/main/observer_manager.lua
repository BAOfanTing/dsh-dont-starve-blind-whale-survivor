-- Blind Whale Survivor · Phase 1 · 观察器管理器
--
-- 职责：找到要观察的玩家 → 调三个观察器（player / inventory / world）→ 拼成一条结构化日志。
-- 本阶段**只读**：不操作角色、不改游戏状态、不寻路、不打怪、不调 AI。
--
-- 日志协议（Bridge 按这个解析）：
--   每行形如：  [00:12:34]: [BWS] {"schema_version":"1","type":"state",...}
--   `[BWS] ` 之后是**单行、完整**的 JSON，一行一条，不跨行。
--
-- 两种行：
--   boot   世界就绪时一条：证明模组加载成功 + 跑在哪端/哪个分片/采样间隔
--   state  每 OBSERVER_INTERVAL 秒一条：session / player / inventory / world / observer 五个部分
--
-- 沙箱：mod 环境没有 pcall / tonumber / next / os / io，全部从 GLOBAL 取。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

BWS = BWS or {}

BWS.phase = 1
BWS.observer_version = "0.2.1"
BWS.schema_version = "1"
BWS.tag = "[BWS]"
BWS.modname = BWS.modname or (modname ~= nil and tostring(modname) or "BlindWhaleSurvivor")

local DEFAULT_INTERVAL = 2
-- 游戏日志每行大约 3.9K 字符就会被截断（实测：3913~3921 字符的行全部断在半截）。
-- 所以**一条记录一个预算**，超了就裁剪，绝不指望日志能装下任意长的 JSON。
local MAX_RECORD_CHARS = 3500
local MIN_INTERVAL = 0.5
local MAX_INTERVAL = 30

local O = {
    started = false,
    nearby = nil,             -- 最近一次实体扫描结果（缓存）
    scan_ticks = 1,           -- 每多少个 state 周期扫一次
    last_scan_tick = -1000,   -- 上次扫描发生在哪个周期
    radius_tiles = 16,
    side = "unknown",
    shard = "unknown",
    interval = DEFAULT_INTERVAL,
    loop_count = 0,
    error_count = 0,
    last_error = nil,
}

-- ───────────────────────── 小工具 ─────────────────────────

--- 读 modinfo 里的 configuration_options（这个函数在 mod 环境上，不在 GLOBAL 上）
local function modconfig(key, default)
    local getter = env ~= nil and env.GetModConfigData or nil
    if getter == nil then return default end
    local ok, value = pcall(getter, key)
    if ok and value ~= nil then return value end
    return default
end

local function clamp_radius(value)
    local n = tonumber(value) or 16
    if n < 2 then return 2 end
    if n > 40 then return 40 end
    return n
end

local function clamp_interval(value)
    local n = tonumber(value) or DEFAULT_INTERVAL
    if n < MIN_INTERVAL then return MIN_INTERVAL end
    if n > MAX_INTERVAL then return MAX_INTERVAL end
    return n
end

--- 一次 log 输出：编码/打印出错只记账，绝不冒到游戏里。
--- encode_ok 可以在超预算时收缩 payload（返回新的 payload）。
local function emit(payload, shrink)
    local ok, err = pcall(function()
        local text = BWS.json.encode(payload)
        if #text > MAX_RECORD_CHARS and shrink ~= nil then
            payload = shrink(payload, MAX_RECORD_CHARS)
            text = BWS.json.encode(payload)
        end
        if #text > MAX_RECORD_CHARS then
            -- 还超：丢掉可选字段，标出来，最差情况只留一个告警
            payload.entities = nil
            payload.trimmed = true
            payload.oversize = true
            text = BWS.json.encode(payload)
        end
        if #text > MAX_RECORD_CHARS then
            O.error_count = O.error_count + 1
            O.last_error = "emit: record too long (" .. #text .. ")"
            return
        end
        print(BWS.tag .. " " .. text)
    end)
    if not ok then
        O.error_count = O.error_count + 1
        O.last_error = "emit: " .. tostring(err)
        pcall(print, BWS.tag .. ' {"schema_version":"1","type":"error","stage":"encode"}')
    end
end

--- nearby 记录裁剪：按预算保留前面的实体（已经按距离排好序）
local function shrink_nearby(payload, budget)
    local entities = payload.entities or {}
    local head = BWS.json.encode({ schema_version = payload.schema_version, type = payload.type,
        session = payload.session, shard = payload.shard, tick = payload.tick, radius_tiles = payload.radius_tiles,
        scanned = payload.scanned, counts = payload.counts, scanned_at_tick = payload.scanned_at_tick })
    local kept = {}
    local size = #head + 120 -- 给尾部的 returned/trimmed 等字段留余量
    for i = 1, #entities do
        local one = BWS.json.encode(entities[i])
        if size + #one + 1 > budget then break end
        kept[#kept + 1] = entities[i]
        size = size + #one + 1
    end
    payload.entities = kept
    payload.returned = #kept
    payload.trimmed = (#kept < #entities)
    return payload
end

--- 每条日志的公共字段
local function base(kind)
    local payload = {
        schema_version = BWS.schema_version,
        type = kind,
        phase = BWS.phase,
        observer_version = BWS.observer_version,
        side = O.side,
        shard = O.shard,
    }
    local os_ = GLOBAL.os
    if os_ ~= nil and os_.time ~= nil then
        local ok, value = pcall(os_.time)
        if ok and value ~= nil then payload.t = value end
    end
    -- 真实时间（秒）与模拟 tick：
    -- 注意 TheSim 上**没有** GetTime()（写过就一直是 nil），可用的是 GetRealTime()（毫秒）和 GetTick()（帧计数）。
    if GLOBAL.TheSim ~= nil then
        local ok_real, ms = pcall(function() return GLOBAL.TheSim:GetRealTime() end)
        if ok_real and ms ~= nil then payload.rt = BWS.json.round(ms / 1000, 2) end
        local ok_tick, tick = pcall(function() return GLOBAL.TheSim:GetTick() end)
        if ok_tick and tick ~= nil then payload.sim_tick = BWS.json.number(tick, nil) end
    end
    if GLOBAL.TheNet ~= nil then
        local ok, value = pcall(function() return GLOBAL.TheNet:GetSessionIdentifier() end)
        if ok and value ~= nil then payload.session = tostring(value) end
    end
    return payload
end

--- 实体扫描：按周期做，不在每个 state 里做（原则 8：不在主线程里做耗时的事）
--- 结果缓存进 O.nearby，state 里只带缓存（并标明是第几个周期扫的）
local function maybe_scan(player_entity)
    if BWS.entity_observer == nil then return end
    if player_entity == nil then return end
    if O.loop_count - O.last_scan_tick < O.scan_ticks then return end
    O.last_scan_tick = O.loop_count

    local ok, nearby, reason = pcall(function()
        return BWS.entity_observer.Observe(player_entity, { radius_tiles = O.radius_tiles })
    end)
    if not ok then
        O.error_count = O.error_count + 1
        O.last_error = "nearby: " .. tostring(nearby)
        return
    end
    if nearby == nil then
        O.last_error = "nearby: " .. tostring(reason or "unavailable")
        return
    end
    nearby.scanned_at_tick = O.loop_count
    O.nearby = nearby
end

--- 服务端第一个有效玩家（单人游戏就一个；多人时先取第一个，后面再扩展）
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

-- ───────────────────────── 拼一条 state ─────────────────────────

--- 安全调用一个观察器：返回 (值, 错误原因)
--- module 为 nil（对应模块没加载）时只降级成 "xxx_unavailable"，不算错误、不污染 errors。
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

local function build_state(player_entity)
    local payload = base("state")
    local problems = {}

    -- 玩家（客户端侧不观察：components 不权威）
    if O.side ~= "server" then
        problems.player = "client_side"
    elseif player_entity == nil then
        problems.player = "no_player"
    end

    if player_entity ~= nil then
        maybe_scan(player_entity)
        local player, player_err = safe_observe("player", BWS.player_observer, function()
            return BWS.player_observer.Observe(player_entity, O.side)
        end)
        if player ~= nil then payload.player = player else problems.player = player_err end

        local inventory, inventory_err = safe_observe("inventory", BWS.inventory_observer, function()
            return BWS.inventory_observer.Observe(player_entity)
        end)
        if inventory ~= nil then payload.inventory = inventory else problems.inventory = inventory_err end
    end

    local world, world_err = safe_observe("world", BWS.world_observer, function()
        return BWS.world_observer.Observe()
    end)
    if world ~= nil then payload.world = world else problems.world = world_err end

    -- 观察器自身的状态：出错原因放这里，别污染数据部分
    local observer = {
        interval = O.interval,
        tick = O.loop_count,
        errors = O.error_count,
    }
    if O.last_error ~= nil then observer.last_error = O.last_error end
    observer.players = { count = count_players() }
    if problems.player ~= nil or problems.inventory ~= nil or problems.world ~= nil then
        observer.problems = problems
    end
    payload.observer = observer
    return payload
end

-- ───────────────────────── 对外 ─────────────────────────

function O.Tick()
    O.loop_count = O.loop_count + 1
    local ok, err = pcall(function()
        local player_entity = nil
        if O.side == "server" then player_entity = first_player() end
        emit(build_state(player_entity))
        -- 附近实体单独一条记录（日志每行有长度上限，塞一条里会被截断）
        if O.nearby ~= nil then
            -- 复制一份再发：绝不能改动缓存（上面 shrink 会裁剪 entities）
            local nearby = base("nearby")
            nearby.tick = O.loop_count
            nearby.radius_tiles = O.nearby.radius_tiles
            nearby.scanned = O.nearby.scanned
            nearby.returned = O.nearby.returned
            nearby.truncated = O.nearby.truncated
            nearby.counts = O.nearby.counts
            nearby.scanned_at_tick = O.nearby.scanned_at_tick
            local entities = {}
            for i, entry in ipairs(O.nearby.entities or {}) do
                entities[i] = entry
            end
            nearby.entities = entities
            emit(nearby, shrink_nearby)
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
    O.radius_tiles = clamp_radius(modconfig("OBSERVER_SCAN_RADIUS", 16))
    local scan_seconds = tonumber(modconfig("OBSERVER_SCAN_SECONDS", 4)) or 4
    if scan_seconds < O.interval then scan_seconds = O.interval end
    O.scan_ticks = math.max(1, math.floor(scan_seconds / O.interval + 0.5))
    O.side = world.ismastersim and "server" or "client"
    local ok_cave, is_cave = pcall(function() return world:HasTag("cave") end)
    O.shard = (ok_cave and is_cave) and "caves" or "master"

    local payload = base("boot")
    payload.mod = BWS.modname
    payload.ismastersim = world.ismastersim and true or false
    payload.interval = O.interval
    payload.players = { count = count_players() }
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
