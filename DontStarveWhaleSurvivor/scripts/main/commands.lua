-- Blind Whale Survivor · Phase 2 · CommandReceiver + CommandExecutor（M4）
--
-- 轮询：每 ~1 秒 POST /api/v1/commands/poll
--   请求：{ protocol_version, token, session_id, shard, last_acknowledged_id }
--   响应：{ success, command: {id, type, params, status, ...} | null, pending_count }
-- 回执：POST /api/v1/commands/result
--   { protocol_version, token, session_id, command_id, status, result, error, execution_time }
--
-- 本阶段**只允许四个测试命令**（任务书明确禁止移动/攻击/采集/制作）：
--   ping          → { message = "Pong from DST" }
--   echo          → 原样返回传入的 params
--   get_state     → 当前真实游戏状态（参数 include_nearby = true 时带附近实体）
--   refresh_state → 立刻重新采集一次，返回采集到的 tick/时间
--
-- 幂等：执行过的 command_id 记在 executed 表里，重投同一条不会再执行第二次。

BWS2 = BWS2 or {}

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

local C = {}

-- Phase 5 M2/M3：固定白名单，绝不执行任意外部字符串
local ALLOWED = { ping = true, echo = true, get_state = true, refresh_state = true,
    move_to = true, stop_movement = true, get_movement_status = true,
    gather_resource = true, move_to_target = true, probe_game_actions = true }
local ACTION_COMMANDS = { move_to = true, stop_movement = true,
    gather_resource = true, move_to_target = true }

local polling = false
local nextPollAt = 0
local lastAcknowledgedId = nil
local executed = {}          -- command_id → true（去重）
local executedOrder = {}     -- 用于裁剪
local counts = { polls = 0, poll_fail = 0, received = 0, duplicated = 0, succeeded = 0, failed = 0, unsupported = 0 }
local lastCommand = nil
local lastError = nil
local lastPollAt = nil
local lastPollStatus = nil

local function now()
    local os_ = GLOBAL.os
    if os_ ~= nil and os_.time ~= nil then
        local ok, value = pcall(os_.time)
        if ok and value ~= nil then return tonumber(value) or 0 end
    end
    return 0
end

--- 毫秒（算 execution_time 用）
local function now_ms()
    if GLOBAL.TheSim ~= nil and GLOBAL.TheSim.GetRealTime ~= nil then
        local ok, value = pcall(function() return GLOBAL.TheSim:GetRealTime() end)
        if ok and value ~= nil then return tonumber(value) or 0 end
    end
    return now() * 1000
end

local function shardName()
    if GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld.HasTag ~= nil then
        local ok, isCave = pcall(function() return GLOBAL.TheWorld:HasTag('cave') end)
        if ok and isCave then return 'caves' end
    end
    return 'master'
end

local function mainPlayer()
    local players = GLOBAL.AllPlayers
    if players == nil then return nil end
    for _, player in pairs(players) do
        if player ~= nil then
            local ok, valid = pcall(function() return player:IsValid() end)
            if ok and valid then return player end
        end
    end
    return nil
end

--- 采一份当前状态（get_state / refresh_state 用）
local function collectState(includeNearby)
    local player = mainPlayer()
    if player == nil then return nil, 'no_player' end

    local sections = {}
    local function safe(key, module, ...)
        if module == nil or module.Observe == nil then return end
        local ok, value = pcall(module.Observe, ...)
        if ok and value ~= nil then sections[key] = value end
    end

    safe('player', BWS.player_observer, player, 'server')
    safe('inventory', BWS.inventory_observer, player)
    safe('world', BWS.world_observer)

    local nearby = nil
    if includeNearby then
        local ok, value = pcall(BWS.entity_observer.Observe, player, { radius_tiles = 12 })
        if ok then nearby = value end
    end

    local meta = {
        schema_version = '1',
        tick = math.floor(now_ms() / 1000),
        interval = 0,
        errors = 0,
        player_count = 1,
        observer_version = '0.3.0',
        side = 'server',
        shard = shardName(),
        session = BWS2.connection.session(),
        t = now(),
        rt = now_ms() / 1000,
        sim_tick = (GLOBAL.TheSim ~= nil and GLOBAL.TheSim.GetTick ~= nil) and math.floor(now_ms() / 16.6) or 0,
        source = 'command',
    }

    local ok, record = pcall(BWS.serializer.GameState, meta, sections)
    if not ok or type(record) ~= 'table' then return nil, 'serialize_failed' end
    if nearby ~= nil then record.nearby = nearby end
    return record
end

--- 具体执行哪个命令（严格白名单）
local function execute(command)
    local kind = command.type
    if not ALLOWED[kind] then
        return 'FAILED', nil, 'unsupported_command: ' .. tostring(kind)
    end
    local params = type(command.params) == 'table' and command.params or {}

    if kind == 'ping' then
        return 'SUCCEEDED', { message = 'Pong from DST' }, nil
    elseif kind == 'echo' then
        return 'SUCCEEDED', { echo = params, received_keys = (function()
            local keys = {}
            for key in pairs(params) do keys[#keys + 1] = tostring(key) end
            return keys
        end)() }, nil
    elseif kind == 'get_state' then
        local record, err = collectState(params.include_nearby == true)
        if record == nil then return 'FAILED', nil, err or 'state_unavailable' end
        return 'SUCCEEDED', record, nil
    elseif kind == 'refresh_state' then
        local record, err = collectState(true)
        if record == nil then return 'FAILED', nil, err or 'state_unavailable' end
        return 'SUCCEEDED', {
            refreshed = true,
            tick = record.tick,
            collected_at = record.timestamp,
            player_tile = record.player ~= nil and record.player.position or nil,
            nearby_returned = record.nearby ~= nil and record.nearby.returned or 0,
        }, nil
    elseif kind == 'get_movement_status' then
        -- Phase 5 M2：只读，直接读执行器状态
        if BWS2.actionExecutor == nil then
            return 'FAILED', nil, 'action_executor_not_loaded'
        end
        local ok, status = pcall(BWS2.actionExecutor.movementStatus)
        if not ok then return 'FAILED', nil, 'movement_status_error: ' .. tostring(status) end
        return 'SUCCEEDED', status, nil
    elseif kind == 'probe_game_actions' then
        -- Phase 5 M3：只读探测当前游戏构建里 ACTIONS / 组件是否可用。
        -- 任务书要求「所有 API 必须通过当前游戏构建版本实际验证」，
        -- 不把外部字符串当动作名执行，只查固定名单里的键是否存在。
        if BWS2.actionExecutor == nil then
            return 'FAILED', nil, 'action_executor_not_loaded'
        end
        local ok, result = pcall(BWS2.actionExecutor.probeGameActions)
        if not ok then return 'FAILED', nil, 'probe_actions_error: ' .. tostring(result) end
        return 'SUCCEEDED', result, nil
    end
    return 'FAILED', nil, 'unsupported_command: ' .. tostring(kind)
end

--- 回执给 Bridge
local function report(commandId, status, result, error, startedMs)
    local payload = {
        protocol_version = BWS2.connection.protocolVersion(),
        token = BWS2.config.get().token,
        session_id = BWS2.connection.session(),
        command_id = commandId,
        status = status,
        result = result,
        error = error,
        execution_time = math.max(0, (now_ms() - startedMs) / 1000),
    }
    BWS2.http.post('/api/v1/commands/result', payload, function(response)
        lastPollStatus = response.status
        if response.ok then
            lastAcknowledgedId = commandId
            if status == 'SUCCEEDED' then counts.succeeded = counts.succeeded + 1 else counts.failed = counts.failed + 1 end
        else
            lastError = response.error
            print('[BWS2] WARN 命令回执失败 ' .. tostring(commandId) .. ' status=' .. tostring(response.status))
        end
    end, 6)
end

--- 执行一条命令（带去重）
local function handle(command)
    if type(command) ~= 'table' or type(command.id) ~= 'string' then return end
    counts.received = counts.received + 1
    lastCommand = { id = command.id, type = command.type }

    if executed[command.id] then
        counts.duplicated = counts.duplicated + 1
        print('[BWS2] INFO 命令重投，跳过执行：' .. tostring(command.id))
        -- 动作还在执行中时**不能**回 SUCCEEDED：那会把 EXECUTING 提前判成终态，
        -- 之后动作真正完成的回执就被 Bridge 当 duplicate 丢掉了。
        local stillRunning = false
        if BWS2.actionExecutor ~= nil and BWS2.actionExecutor.status ~= nil then
            local ok_s, s = pcall(BWS2.actionExecutor.status)
            if ok_s and type(s) == 'table' and s.pending_command_id == command.id then
                stillRunning = true
            end
        end
        if stillRunning then
            print('[BWS2] INFO 动作仍在执行，重投不覆盖终态：' .. tostring(command.id))
            return
        end
        -- 仍然回一次执（幂等），让 Bridge 能把状态收尾
        report(command.id, 'SUCCEEDED', { duplicate = true, skipped = true }, nil, now_ms())
        return
    end

    executed[command.id] = true
    executedOrder[#executedOrder + 1] = command.id
    if #executedOrder > 200 then
        local oldest = table.remove(executedOrder, 1)
        executed[oldest] = nil
    end

    local startedMs = now_ms()

    -- Phase 5 M2：会改游戏状态的动作走独立执行器（异步：控制权二次校验 → 启动原生动作）。
    -- 回执由执行器独占（它要等 assert 回调），这里不再自己 report，避免重复回执。
    if ACTION_COMMANDS[command.type] then
        if BWS2.actionExecutor == nil then
            report(command.id, 'FAILED', nil, 'action_executor_not_loaded', startedMs)
            return
        end
        local ok, outcome = pcall(BWS2.actionExecutor.execute, command, report)
        if not ok then
            report(command.id, 'FAILED', nil, 'action_executor_error: ' .. tostring(outcome), startedMs)
        end
        return
    end

    local ok, status, result, error = pcall(execute, command)
    if not ok then
        report(command.id, 'FAILED', nil, 'executor_error: ' .. tostring(status), startedMs)
        return
    end
    if not ALLOWED[command.type] then counts.unsupported = counts.unsupported + 1 end
    report(command.id, status, result, error, startedMs)
end

--- 轮询一次（由 net.lua 的 1 秒任务驱动，带单飞与退避）
function C.poll(force)
    if polling then return end
    local config = BWS2.config.get()
    local at = now()
    if force ~= true and at < nextPollAt then return end
    if not BWS2.connection.isServerSide() then return end
    if type(config.token) ~= 'string' or #config.token == 0 then return end

    polling = true
    counts.polls = counts.polls + 1
    lastPollAt = at

    BWS2.http.post('/api/v1/commands/poll', {
        protocol_version = BWS2.connection.protocolVersion(),
        token = config.token,
        session_id = BWS2.connection.session(),
        shard = shardName(),
        last_acknowledged_id = lastAcknowledgedId,
    }, function(response)
        polling = false
        lastPollStatus = response.status
        if not response.ok then
            counts.poll_fail = counts.poll_fail + 1
            lastError = response.error
            -- 失败后退避：至少 2 秒、并随连接退避倍数放大（2s → 4s → 8s …），别每秒猛敲
            local retry = (tonumber(config.pollSeconds) or 1) * 2 * BWS2.connection.backoffFactor()
            nextPollAt = now() + math.max(2, retry)
            BWS2.connection.onFailure('poll', response.error)
            if (counts.poll_fail % 10) == 1 then
                print('[BWS2] WARN 命令轮询失败 status=' .. tostring(response.status) .. ' error=' .. tostring(response.error))
            end
            return
        end
        BWS2.connection.onSuccess('poll')
        nextPollAt = now() + (tonumber(config.pollSeconds) or 1)

        if type(response.body) ~= 'string' then return end
        local ok_decode, decoded = pcall(BWS.json.decode, response.body)
        if not ok_decode or type(decoded) ~= 'table' then return end
        if decoded.command ~= nil then
            print('[BWS2] INFO 收到命令 ' .. tostring(decoded.command.type) .. ' id=' .. tostring(decoded.command.id))
            handle(decoded.command)
        end
    end, 6)
end

function C.status()
    return {
        polls = counts.polls,
        poll_fail = counts.poll_fail,
        received = counts.received,
        duplicated = counts.duplicated,
        succeeded = counts.succeeded,
        failed = counts.failed,
        unsupported = counts.unsupported,
        polling = polling,
        last_poll_at = lastPollAt,
        last_poll_status = lastPollStatus,
        last_acknowledged_id = lastAcknowledgedId,
        last_command = lastCommand,
        last_error = lastError,
        allowed = { 'ping', 'echo', 'get_state', 'refresh_state', 'move_to', 'stop_movement',
            'get_movement_status', 'gather_resource', 'move_to_target', 'probe_game_actions' },
        action_executor = BWS2.actionExecutor ~= nil and BWS2.actionExecutor.status() or nil,
    }
end

BWS2.commands = C
