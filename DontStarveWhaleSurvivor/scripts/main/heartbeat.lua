-- Blind Whale Survivor · Phase 2 · HeartbeatManager（M3）
--
-- 心跳：每 ~3 秒 POST /api/v1/heartbeat
--   请求：{ protocol_version, token, session_id, timestamp, player_status, game_version }
--   响应：{ success, server_time, server_status, request_id }
--
-- 心跳只做两件事：证明"游戏端还活着" + 带上最小玩家状态（血/饿/理智百分比、位置、是否死亡）。
-- 详细状态走 telemetry（telemetry.lua），避免心跳包变大。

BWS2 = BWS2 or {}

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

local H = {}

local sent = 0
local lastSentAt = nil
local lastResponse = nil
local lastStatus = nil
local lastError = nil

local function now()
    local os_ = GLOBAL.os
    if os_ ~= nil and os_.time ~= nil then
        local ok, value = pcall(os_.time)
        if ok and value ~= nil then return tonumber(value) or 0 end
    end
    return 0
end

--- 游戏版本：能拿到就带上，拿不到写 'unknown'（不猜）
local function gameVersion()
    for _, name in ipairs({ 'GetBuildID', 'GetVersion', 'GetBuild' }) do
        local fn = GLOBAL[name]
        if type(fn) == 'function' then
            local ok, value = pcall(fn)
            if ok and value ~= nil then return tostring(value) end
        end
    end
    if GLOBAL.TheSim ~= nil then
        local ok, value = pcall(function() return GLOBAL.TheSim:GetBuildID() end)
        if ok and value ~= nil then return tostring(value) end
    end
    return 'unknown'
end

local function playerStatus(player)
    if player == nil or not player:IsValid() then
        return { present = false }
    end
    local components = player.components or {}
    local status = { present = true, prefab = player.prefab }
    if components.health ~= nil then
        local ok, value = pcall(function() return components.health:GetPercent() end)
        if ok and value ~= nil then status.health_percent = BWS.json.round(value * 100, 1) end
        local ok_dead, dead = pcall(function() return components.health:IsDead() end)
        if ok_dead and dead ~= nil then status.dead = dead and true or false end
    end
    if components.hunger ~= nil then
        local ok, value = pcall(function() return components.hunger:GetPercent() end)
        if ok and value ~= nil then status.hunger_percent = BWS.json.round(value * 100, 1) end
    end
    if components.sanity ~= nil then
        local ok, value = pcall(function() return components.sanity:GetPercent() end)
        if ok and value ~= nil then status.sanity_percent = BWS.json.round(value * 100, 1) end
    end
    if player.Transform ~= nil then
        local ok, x, _y, z = pcall(function() return player.Transform:GetWorldPosition() end)
        if ok and x ~= nil then
            status.tile_x = math.floor(x / 4)
            status.tile_z = math.floor(z / 4)
        end
    end
    return status
end

function H.build(player)
    local config = BWS2.config.get()
    return {
        protocol_version = BWS2.connection.protocolVersion(),
        token = config.token,
        session_id = BWS2.connection.session(),
        timestamp = now(),
        player_status = playerStatus(player),
        game_version = gameVersion(),
    }
end

--- 发一次心跳。cb(result) 里 result 是 http_client 的统一形状。
function H.send(player, cb)
    local payload = H.build(player)
    sent = sent + 1
    lastSentAt = now()
    BWS2.http.post('/api/v1/heartbeat', payload, function(result)
        lastResponse = result
        lastStatus = result.status
        if result.ok then
            BWS2.connection.onSuccess('heartbeat')
        else
            lastError = result.error
            BWS2.connection.onFailure('heartbeat', result.error)
            print('[BWS2] WARN heartbeat failed: ' .. tostring(result.error or 'unknown') .. ' status=' .. tostring(result.status))
        end
        if cb ~= nil then pcall(cb, result) end
    end, 5)
end

function H.stats()
    return {
        sent = sent,
        last_sent_at = lastSentAt,
        last_status = lastStatus,
        last_error = lastError,
        last_body_head = lastResponse ~= nil and type(lastResponse.body) == 'string' and string.sub(lastResponse.body, 1, 160) or nil,
    }
end

BWS2.heartbeat = H
