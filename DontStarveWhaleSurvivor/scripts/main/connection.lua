-- Blind Whale Survivor · Phase 2 · ConnectionManager（M3）
--
-- 管三件事：
--   1. session_id：一次游戏会话一个（进世界时生成），Bridge 用它区分"谁在推数据"；
--   2. 连接状态机：offline → connecting → online，失败多了进 degraded（用退避降频）；
--   3. 计数与最后错误，供 /bridge/status 与日志用。
--
-- 不自己起定时器（定时器统一在 net.lua，避免重复创建周期任务）。

BWS2 = BWS2 or {}

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

local C = {}

local state = 'offline'
local sessionId = nil
local startedAt = nil
local counters = { heartbeat_ok = 0, heartbeat_fail = 0, telemetry_ok = 0, telemetry_fail = 0 }
local consecutiveFailures = 0
local lastSuccessAt = nil
local lastFailureAt = nil
local lastError = nil
local transitions = 0

local PROTOCOL_VERSION = '1.0'
local MAX_BACKOFF_SHIFT = 3 -- 最多退避到 8 倍间隔

local function now()
    local os_ = GLOBAL.os
    if os_ ~= nil and os_.time ~= nil then
        local ok, value = pcall(os_.time)
        if ok and value ~= nil then return tonumber(value) or 0 end
    end
    return 0
end

local function log(level, message)
    print('[BWS2] ' .. level .. ' connection ' .. message)
end

local function setState(next)
    if state == next then return end
    local previous = state
    state = next
    transitions = transitions + 1
    log('INFO', previous .. ' → ' .. next)
end

--- 会话 ID：优先用游戏的 session identifier（每个分片不同），再带启动时间戳
function C.ensureSession()
    if sessionId ~= nil then return sessionId end
    local base = 'dst'
    if GLOBAL.TheNet ~= nil and GLOBAL.TheNet.GetSessionIdentifier ~= nil then
        local ok, value = pcall(function() return GLOBAL.TheNet:GetSessionIdentifier() end)
        if ok and value ~= nil then base = tostring(value) end
    end
    local shard = 'master'
    if GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld.HasTag ~= nil then
        local ok_cave, cave = pcall(function() return GLOBAL.TheWorld:HasTag('cave') end)
        if ok_cave and cave then shard = 'caves' end
    end
    startedAt = now()
    sessionId = base .. '-' .. shard .. '-' .. tostring(startedAt)
    log('INFO', 'session_id = ' .. sessionId)
    return sessionId
end

function C.session()
    return C.ensureSession()
end

function C.protocolVersion()
    return PROTOCOL_VERSION
end

function C.onSuccess(kind)
    counters[kind .. '_ok'] = (counters[kind .. '_ok'] or 0) + 1
    consecutiveFailures = 0
    lastSuccessAt = now()
    setState('online')
end

function C.onFailure(kind, error)
    counters[kind .. '_fail'] = (counters[kind .. '_fail'] or 0) + 1
    consecutiveFailures = consecutiveFailures + 1
    lastFailureAt = now()
    lastError = tostring(error or 'unknown')
    if consecutiveFailures >= 2 then setState('degraded') end
end

--- 退避倍数：连续失败 0~1 次 1 倍，2 次 2 倍，3 次 4 倍，4 次以上 8 倍（封顶）
function C.backoffFactor()
    local shift = consecutiveFailures - 1
    if shift <= 0 then return 1 end
    if shift > MAX_BACKOFF_SHIFT then shift = MAX_BACKOFF_SHIFT end
    return 2 ^ shift
end

--- 只有主世界/洞穴的**服务端**才有权威状态；客户端那一半不该往 Bridge 推 telemetry
function C.isServerSide()
    if GLOBAL.TheWorld == nil then return false end
    return GLOBAL.TheWorld.ismastersim == true
end

function C.isOnline()
    return state == 'online'
end

function C.status()
    return {
        session_id = sessionId,
        state = state,
        protocol_version = PROTOCOL_VERSION,
        started_at = startedAt,
        last_success_at = lastSuccessAt,
        last_failure_at = lastFailureAt,
        consecutive_failures = consecutiveFailures,
        backoff_factor = C.backoffFactor(),
        transitions = transitions,
        last_error = lastError,
        counters = {
            heartbeat_ok = counters.heartbeat_ok,
            heartbeat_fail = counters.heartbeat_fail,
            telemetry_ok = counters.telemetry_ok,
            telemetry_fail = counters.telemetry_fail,
        },
    }
end

BWS2.connection = C
