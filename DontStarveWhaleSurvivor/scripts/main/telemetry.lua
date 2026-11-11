-- Blind Whale Survivor · Phase 2 · TelemetrySender（M3）
--
-- 状态推送：观察器每采一次样就 submit 一次，这里负责发出去：
--   POST /api/v1/telemetry
--   请求：{ protocol_version, token, session_id, sequence, timestamp, data }
--   响应：{ success, acknowledged_sequence, server_time, duplicate, request_id }
--
-- 可靠性要点：
--   · **同一时刻只允许一个 telemetry 在飞**，飞的时候再来新样本就覆盖 pending（不是排队，避免堆积）；
--   · sequence 只在**成功**后 +1；失败则保持同一个 sequence 重试 —— Bridge 端用 sequence 做幂等，
--     重复的 sequence 不会重复入库；
--   · 大包处理：先按 maxPayloadBytes 判断，超了先削 nearby.entities，再超就整段丢掉 nearby。

BWS2 = BWS2 or {}

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

local T = {}

local sequence = 1
local ackedSequence = 0
local inFlight = false
local pending = nil          -- 最近一份待发数据
local sent = 0
local okCount = 0
local failCount = 0
local dropped = 0
local trimmed = 0
local lastSentAt = nil
local lastAckAt = nil
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

--- 把 payload 编码一次看大小（编码失败按“太大”处理，交给后面降级）
local function encodedSize(payload)
    local ok, text = pcall(BWS.json.encode, payload)
    if not ok then return math.huge end
    return #text
end

--- 按配置的 payload 上限逐步降级
local function shrink(payload, maxBytes)
    if encodedSize(payload) <= maxBytes then return payload end

    local data = payload.data
    local nearby = type(data) == 'table' and data.nearby or nil
    if nearby ~= nil and type(nearby.entities) == 'table' and #nearby.entities > 0 then
        -- 先砍一半实体
        local keep = math.floor(#nearby.entities / 2)
        local kept = {}
        for i = 1, keep do kept[i] = nearby.entities[i] end
        nearby.entities = kept
        nearby.returned = keep
        nearby.trimmed = true
        trimmed = trimmed + 1
        if encodedSize(payload) <= maxBytes then return payload end
    end
    if type(data) == 'table' then
        data.nearby = nil -- 还超就把 nearby 整段丢掉，至少把玩家/世界状态送到
        trimmed = trimmed + 1
    end
    return payload
end

local function send()
    if inFlight or pending == nil then return end
    local config = BWS2.config.get()
    if type(config.token) ~= 'string' or #config.token == 0 then return end

    local payload = pending
    payload.sequence = sequence
    payload.session_id = BWS2.connection.session()
    payload.protocol_version = BWS2.connection.protocolVersion()
    payload.timestamp = now()
    payload = shrink(payload, tonumber(config.maxPayloadBytes) or 64 * 1024)

    pending = nil
    inFlight = true
    sent = sent + 1
    lastSentAt = now()

    BWS2.http.post('/api/v1/telemetry', payload, function(result)
        inFlight = false
        lastStatus = result.status
        if result.ok then
            okCount = okCount + 1
            sequence = sequence + 1
            lastAckAt = now()
            local ack = nil
            if type(result.body) == 'string' then
                -- HTTP 响应是纯 JSON（不带 KLEI 头，那是持久化字符串通道才有的东西）
                local ok_decode, decoded = pcall(BWS.json.decode, result.body)
                if ok_decode and type(decoded) == 'table' then
                    ack = tonumber(decoded.acknowledged_sequence)
                    if decoded.duplicate == true then ackedSequence = ack or ackedSequence end
                end
            end
            if ack ~= nil then ackedSequence = ack end
            BWS2.connection.onSuccess('telemetry')
        else
            failCount = failCount + 1
            lastError = result.error
            -- 失败：保留同一份数据、同一个 sequence 重试（Bridge 端幂等）
            if pending == nil then pending = payload end
            BWS2.connection.onFailure('telemetry', result.error)
        end
    end, 6)
end

--- 观察器每采一次样调用一次。meta/sections 来自 observer_manager，nearby 是最近一次扫描结果。
function T.submit(meta, sections, nearby)
    local serializer = BWS.serializer
    local ok, gameState = pcall(serializer.GameState, meta, sections)
    if not ok or type(gameState) ~= 'table' then
        dropped = dropped + 1
        print('[BWS2] WARN telemetry 构造失败：' .. tostring(gameState))
        return
    end
    gameState.nearby = nearby
    if pending ~= nil then dropped = dropped + 1 end -- 上一份还没发出去就被覆盖
    pending = {
        data = gameState,
    }
    send()
end

function T.flushIfPending()
    send()
end

function T.status()
    return {
        sequence = sequence,
        acknowledged_sequence = ackedSequence,
        in_flight = inFlight,
        has_pending = pending ~= nil,
        sent = sent,
        ok = okCount,
        failed = failCount,
        dropped = dropped,
        trimmed = trimmed,
        last_sent_at = lastSentAt,
        last_ack_at = lastAckAt,
        last_status = lastStatus,
        last_error = lastError,
    }
end

BWS2.telemetry = T
