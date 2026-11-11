-- Blind Whale Survivor · Phase 2 · M2 通信探针
--
-- 目的：在**真实游戏进程**里验证 TheSim:QueryServer 到底能干什么。逐项验证：
--   A. API 是否存在；
--   B. GET 能否访问 127.0.0.1，回调能否拿到 状态码 + 响应体；
--   C. POST 能否把请求体送出去（不带 content-type）；
--   D. token 鉴权是否生效（无 token / 错 token → 401；对 token → 200）；
--   E. 大请求体如何处理（超限 → 413）；
--   F. 重复请求 / Bridge 重启后能否重连（每秒/每 10 秒重试）。
--
-- 结果同时打进游戏日志（`[BWS2]` 标记），所以**即使 HTTP 完全不通**，我们也能从日志里看到结论
-- —— 这就是任务书要求的「保留日志通道作为诊断/降级」。
--
-- 只读、只探测，不碰游戏状态。

local GLOBAL = GLOBAL
-- 饥荒的 mod 沙箱只给 pairs/ipairs/print/math/table/type/string/tostring/require/Class，
-- pcall / tonumber / next / os / io 都得从 GLOBAL 取（这一条是踩过的坑，见 docs/phase1/01）。
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

BWS2 = BWS2 or {}

local P = {}

local ran = false
local config = nil
local http = nil

local function truncate(text, limit)
    if text == nil then return nil end
    local value = tostring(text)
    if #value <= limit then return value end
    return string.sub(value, 1, limit) .. '…(' .. #value .. ' 字节)'
end

local function emit(record)
    record.at = GLOBAL.os ~= nil and GLOBAL.os.time ~= nil and GLOBAL.os.time() or nil
    local ok, text = pcall(BWS.json.encode, record)
    if ok then
        print('[BWS2] ' .. text)
    else
        print('[BWS2] {"step":"emit_failed"}')
    end
end

--- 一步验证：发请求 → 记结果 → 继续
local function step(name, opts, check, done)
    local startedAt = (GLOBAL.os ~= nil and GLOBAL.os.time ~= nil) and GLOBAL.os.time() or 0
    http.request(opts, function(result)
        local expected = check(result)
        emit({
            step = name,
            method = opts.method,
            path = opts.path,
            ok = result.ok == true,
            status = result.status,
            expected = expected.expect,
            pass = expected.pass,
            elapsed_ms = result.elapsed_ms,
            error = result.error,
            body_head = truncate(result.body, 180),
        })
        if done ~= nil then done(result, expected.pass) end
    end)
    return startedAt
end

local function runSequence()
    config = BWS2.config.get()
    http = BWS2.http
    local token = config.token

    -- A. API 是否存在
    local hasApi = GLOBAL.TheSim ~= nil and type(GLOBAL.TheSim.QueryServer) == 'function'
    emit({
        step = 'api_query_server',
        pass = hasApi,
        has_thesim = GLOBAL.TheSim ~= nil,
        type_of_queryserver = GLOBAL.TheSim ~= nil and type(GLOBAL.TheSim.QueryServer) or 'nil',
        base_url = config.baseUrl,
        token_configured = type(token) == 'string' and #token > 0,
        side = 'server',
        shard = (GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld:HasTag('cave')) and 'caves' or 'master',
    })
    if not hasApi then
        emit({ step = 'abort', pass = false, reason = 'TheSim:QueryServer 不可用，M2 需要走降级方案（unsafedata/日志通道）' })
        return
    end
    if type(token) ~= 'string' or #token == 0 then
        emit({ step = 'abort', pass = false, reason = '没有配置 token（先跑 node tools/write-bws-config.mjs）' })
        return
    end

    -- B/C/D/E 依次跑
    step('get_health', { method = 'GET', path = '/health' }, function(result)
        return { expect = 200, pass = result.ok == true and result.status == 200 }
    end)

    step('post_no_token', { method = 'POST', path = '/api/v1/heartbeat', body = { session_id = 'probe' } }, function(result)
        return { expect = 401, pass = result.status == 401 }
    end)

    step('post_bad_token', {
        method = 'POST',
        path = '/api/v1/probe',
        body = { token = 'definitely-wrong-token', echo = 'bad' },
    }, function(result)
        return { expect = 401, pass = result.status == 401 }
    end)

    step('post_probe', {
        method = 'POST',
        path = '/api/v1/probe',
        body = { token = token, echo = '大肥鱼 M2 探测', client = 'dst-mod', ts = GLOBAL.os.time() },
    }, function(result)
        local echoed = type(result.body) == 'string' and string.find(result.body, '大肥鱼 M2 探测', 1, true) ~= nil
        return { expect = 200, pass = result.ok == true and result.status == 200 and echoed }
    end)

    step('post_big_body', {
        method = 'POST',
        path = '/api/v1/probe',
        body = { token = token, pad = string.rep('x', 150 * 1024) },
    }, function(result)
        return { expect = 413, pass = result.status == 413 }
    end, function()
        -- 小结
        local stats = http.stats()
        emit({
            step = 'summary',
            pass = true,
            http = stats,
            base_url = config.baseUrl,
        })
        if config.probeRepeatSeconds ~= nil then
            P.startRepeat(config.probeRepeatSeconds, config.probeRepeatCount or 30)
        end
    end)
end

--- 之后的重复 GET：用来观察「Bridge 重启后能否重连」
function P.startRepeat(everySeconds, times)
    local remaining = times
    local function tick()
        if remaining <= 0 then return end
        remaining = remaining - 1
        http.get('/health', function(result)
            emit({
                step = 'repeat_health',
                ok = result.ok == true,
                status = result.status,
                elapsed_ms = result.elapsed_ms,
                error = result.error,
                remaining = remaining,
            })
        end)
        if GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld.DoTaskInTime ~= nil then
            GLOBAL.TheWorld:DoTaskInTime(everySeconds, tick)
        end
    end
    tick()
end

function P.start()
    if ran then return end
    ran = true
    -- 探针只是诊断工具：任何异常都不许把模组带崩（被判定 MOD ERROR 会被游戏禁用）
    local ok_wrap, err_wrap = pcall(function()
    config = BWS2.config.get()
    -- 等一小会儿再开始：让世界和 Bridge 都就绪
    local delay = tonumber(config.probeDelaySeconds) or 6
    emit({ step = 'probe_scheduled', delay_seconds = delay })
    if GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld.DoTaskInTime ~= nil then
        GLOBAL.TheWorld:DoTaskInTime(delay, function()
            local ok, err = pcall(runSequence)
            if not ok then emit({ step = 'probe_error', ok = false, error = tostring(err) }) end
        end)
    else
        runSequence()
    end
    end)
    if not ok_wrap then
        print('[BWS2] {"step":"probe_start_error","ok":false,"error":"' .. tostring(err_wrap) .. '"}')
    end
end

BWS2.probe = P
