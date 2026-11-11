-- Blind Whale Survivor · Phase 2 · HTTPClient（M2）
--
-- 用游戏的 TheSim:QueryServer 发请求（源码确认签名，762172）：
--     TheSim:QueryServer(url, callback, method, data)
--     callback(result_text, isSuccessful, resultCode)
--   · method: "GET" / "POST"
--   · data: POST 的请求体字符串（GET 传 nil）
--   · 不能设请求头 → 所以我们**只用请求体/查询串传 token**，且 Bridge 端不依赖 content-type。
--
-- 本模块负责：
--   · 串行队列（同一时刻最多一个请求，绝不并发打同一个服务）；
--   · 自己做超时（QueryServer 没有超时参数），超时后释放队列并记一次 timeout；
--   · 统一回调形状 { ok, status, body, error, elapsed_ms }；
--   · 不阻塞主线程：全部异步，回调里只做轻量解析。

local GLOBAL = GLOBAL
-- 饥荒的 mod 沙箱只给 pairs/ipairs/print/math/table/type/string/tostring/require/Class，
-- pcall / tonumber / next / os / io 都得从 GLOBAL 取（这一条是踩过的坑，见 docs/phase1/01）。
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

BWS2 = BWS2 or {}

local H = {}

local queue = {}
local inFlight = nil   -- { id, url, startedAt, deadline, cb, timer }
local nextId = 0
local stats = { sent = 0, ok = 0, failed = 0, timeout = 0, dropped = 0 }

local MAX_QUEUE = 8

local function now()
    local os_ = GLOBAL.os
    if os_ ~= nil and os_.time ~= nil then
        local ok, value = pcall(os_.time)
        if ok and value ~= nil then return value end
    end
    return 0
end

local function log(level, message, extra)
    local config = BWS2.config.get()
    if level ~= 'ERROR' or config.verbose then
        print('[BWS2] ' .. level .. ' ' .. tostring(message))
    end
end

--- 处理队列里的下一个请求
local function pump()
    if inFlight ~= nil then return end
    local job = table.remove(queue, 1)
    if job == nil then return end

    inFlight = job
    job.startedAt = now()
    stats.sent = stats.sent + 1

    local function finish(payload)
        if inFlight ~= job then return end
        if job.timer ~= nil then
            pcall(function() job.timer:Cancel() end)
            job.timer = nil
        end
        inFlight = nil
        payload.elapsed_ms = math.floor((now() - job.startedAt) * 1000)
        if payload.ok then stats.ok = stats.ok + 1 else stats.failed = stats.failed + 1 end
        local ok_cb, err = pcall(job.cb, payload)
        if not ok_cb then log('ERROR', '回调抛错：' .. tostring(err)) end
        pump()
    end

    -- 超时：QueryServer 不给我们超时，只能自己数
    if GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld.DoTaskInTime ~= nil then
        local handle = {}
        handle.task = GLOBAL.TheWorld:DoTaskInTime(job.timeoutSeconds, function()
            if inFlight ~= job then return end
            stats.timeout = stats.timeout + 1
            finish({ ok = false, status = nil, error = 'timeout', body = nil })
        end)
        job.timer = handle.task
    end

    local ok_call, err = pcall(function()
        GLOBAL.TheSim:QueryServer(job.url, function(result, isSuccessful, resultCode)
            finish({
                ok = isSuccessful == true,
                status = resultCode,
                body = result,
                error = (isSuccessful == true) and nil or ('http_' .. tostring(resultCode)),
            })
        end, job.method, job.body)
    end)
    if not ok_call then
        log('ERROR', 'QueryServer 调用失败：' .. tostring(err))
        finish({ ok = false, status = nil, error = 'query_server_unavailable', body = tostring(err) })
    end
end

--- 发一个请求（异步）。opts = { method, path, body(table), timeoutSeconds }
--- cb 收到 { ok, status, body, error, elapsed_ms }
function H.request(opts, cb)
    local config = BWS2.config.get()
    if #queue >= MAX_QUEUE then
        stats.dropped = stats.dropped + 1
        cb({ ok = false, status = nil, error = 'queue_full', body = nil, elapsed_ms = 0 })
        return
    end

    nextId = nextId + 1
    local method = tostring(opts.method or 'GET'):upper()
    local bodyText = nil
    if opts.body ~= nil then
        local ok_encode, text = pcall(BWS.json.encode, opts.body, 60)
        if not ok_encode then
            cb({ ok = false, status = nil, error = 'encode_failed', body = tostring(text), elapsed_ms = 0 })
            return
        end
        bodyText = text
    end

    queue[#queue + 1] = {
        id = nextId,
        method = method,
        url = config.baseUrl .. tostring(opts.path or '/'),
        body = bodyText,
        timeoutSeconds = tonumber(opts.timeoutSeconds) or config.httpTimeoutSeconds,
        cb = cb,
    }
    pump()
end

function H.get(path, cb, timeoutSeconds)
    H.request({ method = 'GET', path = path, timeoutSeconds = timeoutSeconds }, cb)
end

function H.post(path, body, cb, timeoutSeconds)
    H.request({ method = 'POST', path = path, body = body, timeoutSeconds = timeoutSeconds }, cb)
end

function H.stats()
    return {
        sent = stats.sent,
        ok = stats.ok,
        failed = stats.failed,
        timeout = stats.timeout,
        dropped = stats.dropped,
        queued = #queue,
        in_flight = inFlight ~= nil,
    }
end

BWS2.http = H
