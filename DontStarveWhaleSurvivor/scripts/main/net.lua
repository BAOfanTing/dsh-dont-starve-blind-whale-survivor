-- Blind Whale Survivor · Phase 2 · 网络调度（M3）
--
-- 只有**一个**周期任务（1 秒），负责：
--   · 到点发心跳（间隔按连接退避倍数放大）；
--   · 有 pending 的 telemetry 就补发（正常由观察器 submit 触发）；
--   · 断开/恢复时只打一条状态变化日志，不刷屏。
--
-- 为什么统一在这里起定时器：任务书要求「不能让同一个周期任务重复创建」。
-- 所以 start() 有 started 守卫，且进世界只会调用一次。

BWS2 = BWS2 or {}

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

local N = {}

local started = false
local tickTask = nil
local lastHeartbeatAt = 0
local ticks = 0
local lastReportedState = nil

local function now()
    local os_ = GLOBAL.os
    if os_ ~= nil and os_.time ~= nil then
        local ok, value = pcall(os_.time)
        if ok and value ~= nil then return tonumber(value) or 0 end
    end
    return 0
end

local function player()
    local players = GLOBAL.AllPlayers
    if players == nil then return nil end
    for _, p in pairs(players) do
        if p ~= nil then
            local ok, valid = pcall(function() return p:IsValid() end)
            if ok and valid then return p end
        end
    end
    return nil
end

local function tickBody()
    ticks = ticks + 1
    local config = BWS2.config.get()
    local connection = BWS2.connection

    -- 1) 心跳（按退避倍数放大间隔）
    local interval = (tonumber(config.heartbeatSeconds) or 3) * connection.backoffFactor()
    if now() - lastHeartbeatAt >= interval then
        lastHeartbeatAt = now()
        BWS2.heartbeat.send(player())
    end

    -- 2) telemetry 有积压就补发（正常路径是观察器 submit 直接触发）
    BWS2.telemetry.flushIfPending()

    -- 2.5) 命令轮询（自己带单飞与退避，这里只是每秒问一次“到点没”）
    BWS2.commands.poll(false)

    -- 3) 状态变化时才打日志（避免刷屏）
    local status = connection.status()
    if status.state ~= lastReportedState then
        lastReportedState = status.state
        print('[BWS2] INFO net state=' .. tostring(status.state)
            .. ' backoff=' .. tostring(status.backoff_factor)
            .. ' session=' .. tostring(status.session_id))
    end
end

--- 周期任务里绝不能裸抛错误：实测一次未捕获的错误会穿过 scheduler/update 直接崩掉分片进程
--- （客户端表现为"专用服务器无法启动/提前终止"）。所以整个 tick 都包在 pcall 里。
local function tick()
    local ok, err = pcall(tickBody)
    if not ok then
        print('[BWS2] ERROR net tick 出错（已隔离）：' .. tostring(err))
    end
end

function N.start()
    -- 换存档 / 世界重载会清掉旧的 DoPeriodicTask，但 started 守卫仍是 true，
    -- 结果周期任务永久消失、心跳停摆（实测踩过：日志只有一条 offline → online 就再没动静）。
    -- 所以用「任务对象是否还有效」判断，而不是只看 started。
    if started and tickTask ~= nil then
        local ok_alive, alive = pcall(function() return tickTask:IsValid() end)
        if not ok_alive or alive ~= false then
            return false -- 拿不到 IsValid 时保守认为还活着，避免重复建任务
        end
        print('[BWS2] WARN net 周期任务已失效（世界重载过？），重新创建')
        tickTask = nil
        started = false
    end
    started = true

    local config = BWS2.config.get()
    if type(config.token) ~= 'string' or #config.token == 0 then
        print('[BWS2] WARN net 未启动：没有配置 token（先跑 node tools/write-bws-config.mjs）')
        started = false
        return false
    end
    if GLOBAL.TheWorld == nil or GLOBAL.TheWorld.DoPeriodicTask == nil then
        print('[BWS2] WARN net 未启动：世界还没就绪')
        started = false
        return false
    end

    BWS2.connection.ensureSession()
    print('[BWS2] INFO net 启动：heartbeat ' .. tostring(config.heartbeatSeconds) .. 's / telemetry '
        .. tostring(config.stateSeconds) .. 's（由观察器驱动）/ 统一 1s 调度')

    local ok, err = pcall(function()
        tickTask = GLOBAL.TheWorld:DoPeriodicTask(1, tick)
    end)
    if not ok then
        print('[BWS2] ERROR net 定时器创建失败：' .. tostring(err))
        started = false
        return false
    end
    -- 立刻发一次心跳，让 Bridge 尽快知道"游戏连上了"
    lastHeartbeatAt = 0
    return true
end

function N.stop()
    if tickTask ~= nil then
        pcall(function() tickTask:Cancel() end)
        tickTask = nil
    end
    started = false
end

function N.status()
    local status = BWS2.connection.status()
    status.ticks = ticks
    status.started = started
    status.heartbeat = BWS2.heartbeat.stats()
    status.telemetry = BWS2.telemetry.status()
    status.http = BWS2.http.stats()
    return status
end

BWS2.net = N
