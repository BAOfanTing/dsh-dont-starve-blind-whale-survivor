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

-- Phase 5 M2/M3/M4/M6：固定白名单，绝不执行任意外部字符串
local ALLOWED = { ping = true, echo = true, get_state = true, refresh_state = true,
    move_to = true, stop_movement = true, get_movement_status = true,
    gather_resource = true, move_to_target = true, probe_game_actions = true,
    equip_item = true, chop_tree = true, mine_rock = true, pick_up_item = true,
    eat_item = true, craft_item = true, build_structure = true, build_campfire = true,
    start_task = true, stop_task = true, get_task_status = true,
    -- Phase 6 M4：战斗 / 撤退 / 规避 / 中止 + 战斗状态查询 + 战后治疗
    start_combat = true, retreat_from_combat = true, evade_threat = true,
    abort_combat = true, get_combat_status = true, probe_combat_api = true,
    heal_self = true }
-- 走独立执行器（action_executor）的命令：这些是**原子游戏动作**，需要控制权二次校验 + 异步回执。
-- Phase 5 M6：start_task / stop_task **不在这里** —— 它们是任务链命令，由本文件自己处理
-- （任务链内部会自己去调原子动作，不需要 action_executor 的 assert 流程）。
-- 真机踩到：把它们放进来会被转给 action_executor，那里没有同名动作 → unknown_action。
-- Phase 6 M4：战斗类命令也走 action_executor（复用它的白名单/服务端权威/控制权 assert），
-- 到了里面再转交 BWS2.combat（战斗有自己的 0.1 秒 tick 和状态机）。
local ACTION_COMMANDS = { move_to = true, stop_movement = true,
    gather_resource = true, move_to_target = true,
    equip_item = true, chop_tree = true, mine_rock = true, pick_up_item = true,
    eat_item = true, craft_item = true, build_structure = true, build_campfire = true,
    start_combat = true, retreat_from_combat = true, evade_threat = true, abort_combat = true,
    heal_self = true }

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
    elseif kind == 'get_combat_status' then
        -- Phase 6 M4：只读，返回战斗执行器状态（状态机、目标、命中数、装备、API 探测）
        if BWS2.combat == nil then
            return 'FAILED', nil, 'combat_executor_not_loaded'
        end
        local ok, status = pcall(BWS2.combat.status)
        if not ok then return 'FAILED', nil, 'combat_status_error: ' .. tostring(status) end
        return 'SUCCEEDED', status, nil
    elseif kind == 'probe_combat_api' then
        -- Phase 6 M4：只读，探测当前构建的战斗 API 是否可用（任务书要求逐项验证）
        if BWS2.combat == nil then
            return 'FAILED', nil, 'combat_executor_not_loaded'
        end
        local ok, api = pcall(BWS2.combat.ProbeApi)
        if not ok then return 'FAILED', nil, 'combat_probe_error: ' .. tostring(api) end
        return 'SUCCEEDED', { ok = true, api = api }, nil
    elseif kind == 'get_task_status' then
        -- Phase 5 M6：只读，返回任务链当前进度
        if BWS2.tasks == nil then
            return 'FAILED', nil, 'task_runner_not_loaded'
        end
        local ok, summary = pcall(BWS2.tasks.Summary)
        if not ok then return 'FAILED', nil, 'task_status_error: ' .. tostring(summary) end
        return 'SUCCEEDED', summary, nil
    elseif kind == 'start_task' then
        -- Phase 5 M6：启动固定任务模板（只认 TASKS 白名单里的名字）
        if BWS2.tasks == nil then
            return 'FAILED', nil, 'task_runner_not_loaded'
        end
        local task = (command.params or {}).task
        if type(task) ~= 'string' or task == '' then
            return 'FAILED', nil, 'invalid_argument: start_task 需要 task 名字（字符串）'
        end
        local ok, err = BWS2.tasks.Start(task)
        if not ok then
            return 'FAILED', nil, tostring(err)
        end
        local ok2, summary = pcall(BWS2.tasks.Summary)
        return 'SUCCEEDED', ok2 and summary or { running = true, task = task }, nil
    elseif kind == 'stop_task' then
        -- Phase 5 M6：中止任务（会清理动作与按键状态）
        if BWS2.tasks == nil then
            return 'FAILED', nil, 'task_runner_not_loaded'
        end
        local ok, err = BWS2.tasks.Stop('命令要求停止')
        if not ok then
            return 'FAILED', nil, tostring(err)
        end
        return 'SUCCEEDED', { running = false, stopped = true }, nil
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
            'get_movement_status', 'gather_resource', 'move_to_target', 'probe_game_actions',
            'equip_item', 'chop_tree', 'mine_rock', 'pick_up_item',
            'eat_item', 'craft_item', 'build_structure', 'build_campfire',
            'start_task', 'stop_task', 'get_task_status',
            'start_combat', 'retreat_from_combat', 'evade_threat', 'abort_combat',
            'get_combat_status', 'probe_combat_api' },
        action_executor = BWS2.actionExecutor ~= nil and BWS2.actionExecutor.status() or nil,
        combat = BWS2.combat ~= nil and BWS2.combat.status() ~= nil and 'loaded' or 'missing',
    }
end

BWS2.commands = C
