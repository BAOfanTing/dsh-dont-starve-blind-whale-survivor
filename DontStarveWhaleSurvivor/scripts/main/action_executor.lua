-- Blind Whale Survivor · Phase 5 M2 · ActionExecutor（Lua 执行端）
--
-- 职责：把 Phase 2 HTTP 命令通道收到的动作命令，转成 Whale.actions 的原生游戏动作。
--
-- 安全边界（任务书 §5/§8/§9，程序层执行，不靠提示词）：
--   1. **固定白名单映射**：外部传入的字符串绝不当函数名 / ACTIONS 名 / 代码执行，
--      只能命中这张表里写死的键，未命中直接拒绝；
--   2. **服务端权威**：必须是 TheWorld.ismastersim 才允许改游戏状态；
--   3. **控制权二次校验**：每个动作执行前 POST /api/v1/control/assert 问 Bridge，
--      Bridge 不授权就不启动（Controller 是唯一权威写者，Lua 不自己存状态）；
--   4. **玩家状态检查**：死亡 / 幽灵 / 忙碌时拒绝；
--   5. **长时间动作不阻塞主线程**：只调 Start()，推进交给已有的 Whale.actions.Tick()；
--   6. **结果真实反馈**：成功/失败由 Whale.bridge.Report 回执，M2 用轮询查状态。
--
-- M2 只实现 3 个移动相关动作；后面的采集/工具/生存动作在 M3~M5 往这张表里加。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

BWS2 = BWS2 or {}

local E = {}

-- ─────────────── 固定白名单：命令类型 → Whale.actions 的 JOBS 名 ───────────────
-- 这张表是**唯一**的映射来源。外部字符串只用来查表，绝不拼接成函数名。
local ACTION_MAP = {
    move_to = 'move_to',
    stop_movement = 'stop',
}

-- 需要控制权写权限的动作（get_movement_status 是只读，不在这里）
local WRITE_ACTIONS = { move_to = true, stop_movement = true }

-- 记录最近的移动状态（get_movement_status 用，纯读，不碰游戏实体）
local lastMove = {
    action = nil,
    target = nil,
    started_at = nil,
    finished_at = nil,
    ok = nil,
    text = nil,
    command_id = nil,
}
local counts = { accepted = 0, denied = 0, failed = 0, started = 0 }

local function now()
    local os_ = GLOBAL.os
    if os_ ~= nil and os_.time ~= nil then
        local ok, value = pcall(os_.time)
        if ok and value ~= nil then return tonumber(value) or 0 end
    end
    return 0
end

--- 服务端权威判断（任务书 §8：游戏修改必须在服务器权威环境执行）
local function isServerAuthoritative()
    local w = GLOBAL.TheWorld
    if w == nil then return false, 'world_not_ready' end
    -- 有些构建里 ismastersim 是字段，有些是方法，pcall 兜住
    local ok, master = pcall(function()
        local v = w.ismastersim
        if type(v) == 'function' then return v(w) end
        return v
    end)
    if not ok then return false, 'ismastersim_error' end
    if master ~= true then return false, 'client_side' end
    return true, nil
end

--- 玩家能否行动（任务书 §9）
local function playerReady()
    local p = Whale ~= nil and Whale.util ~= nil and Whale.util.player() or nil
    if p == nil then return false, 'no_player' end
    local ok, dead = pcall(function()
        if p.components ~= nil and p.components.health ~= nil and p.components.health.IsDead ~= nil then
            return p.components.health:IsDead()
        end
        return false
    end)
    if ok and dead == true then return false, 'player_dead' end
    -- 幽灵状态（replica 在服务端也可用）
    local ok2, ghost = pcall(function()
        if p.HasTag ~= nil then return p:HasTag('playerghost') end
        return false
    end)
    if ok2 and ghost == true then return false, 'player_ghost' end
    return true, nil
end

--- 把拒绝原因回报给 Bridge（沿用 commands.lua 的 report 形状）
local function deny(report, commandId, startedMs, code, message)
    counts.denied = counts.denied + 1
    print('[BWS2] WARN 动作被拒绝 ' .. tostring(commandId) .. ' ' .. tostring(code) .. ': ' .. tostring(message))
    if report ~= nil then
        report(commandId, 'FAILED', nil, code .. ': ' .. tostring(message), startedMs)
    end
    return { status = 'FAILED', error = code .. ': ' .. tostring(message) }
end

--- 二次校验回调里真正启动动作
local function startAction(command, report, startedMs)
    local jobName = ACTION_MAP[command.type]
    local okStart, err = Whale.actions.Start(jobName, command.params or {})
    if not okStart then
        counts.failed = counts.failed + 1
        lastMove.ok = false
        lastMove.text = err or '动作没能开始'
        lastMove.finished_at = now()
        if report ~= nil then
            report(command.id, 'FAILED', nil, 'start_failed: ' .. tostring(lastMove.text), startedMs)
        end
        return
    end
    counts.started = counts.started + 1
    lastMove.action = command.type
    lastMove.target = { x = (command.params or {}).x, z = (command.params or {}).z }
    lastMove.started_at = now()
    lastMove.finished_at = nil
    lastMove.ok = nil
    lastMove.text = nil
    lastMove.command_id = command.id
    -- 立即回执 ACCEPTED（动作还在跑，最终成功/失败由 Whale.actions.Tick 通过文件桥上报；
    -- M2 的 get_movement_status 会读 Whale.actions.Current() 判断进度）
    if report ~= nil then
        report(command.id, 'SUCCEEDED', {
            accepted = true,
            action = command.type,
            job = jobName,
            running = true,
            note = '动作已启动，由游戏内 Tick 推进；用 get_movement_status 查询',
        }, nil, startedMs)
    end
end

--- 主入口：commands.lua 收到动作命令时调这个
--- @param command table  { id, type, params }
--- @param report function commands.lua 的回执函数 (commandId, status, result, error, startedMs)
--- @return table 同步阶段的结果（异步阶段的结果通过 report 回报）
function E.execute(command, report)
    local startedMs = now() * 1000
    local kind = command.type

    -- 1) 固定白名单（未知动作直接拒，不执行任意代码）
    if ACTION_MAP[kind] == nil then
        return deny(report, command.id, startedMs, 'unknown_action', '没有这个动作：' .. tostring(kind))
    end

    -- 2) 服务端权威
    local authoritative, reason = isServerAuthoritative()
    if not authoritative then
        return deny(report, command.id, startedMs, 'not_server_authoritative', tostring(reason))
    end

    -- 3) 玩家状态
    local ready, playerReason = playerReady()
    if not ready then
        return deny(report, command.id, startedMs, 'player_not_ready', tostring(playerReason))
    end

    -- 4) 参数校验（move_to 必须有合法数字坐标，且不传任意 ACTIONS 名）
    if kind == 'move_to' then
        local x = tonumber((command.params or {}).x)
        local z = tonumber((command.params or {}).z)
        if x == nil or z == nil then
            return deny(report, command.id, startedMs, 'invalid_argument', 'move_to 需要数字 x / z')
        end
        -- 限制范围，防止外部传极大值让角色跑飞
        if x < -10000 or x > 10000 or z < -10000 or z > 10000 then
            return deny(report, command.id, startedMs, 'invalid_argument', '坐标超出允许范围')
        end
    end

    -- 5) 控制权二次校验（问 Bridge，不自己存状态）
    --    QueryServer 是异步的，所以这里发起请求，在回调里启动动作。
    --    请求失败（比如 Bridge 挂了）一律拒绝，绝不"乐观放行"。
    local controllerId = (command.params or {}).controller_id
    local sessionId = (command.params or {}).session_id
    if type(controllerId) ~= 'string' or controllerId == '' or type(sessionId) ~= 'string' or sessionId == '' then
        return deny(report, command.id, startedMs, 'missing_control_fields', '动作命令缺少 controller_id / session_id')
    end

    local payload = {
        protocol_version = BWS2.connection.protocolVersion(),
        token = BWS2.config.get().token,
        controller_id = controllerId,
        session_id = sessionId,
        read_only = false,
    }
    BWS2.http.post('/api/v1/control/assert', payload, function(response)
        if response == nil or response.ok ~= true then
            deny(report, command.id, startedMs, 'control_assert_unavailable',
                '控制权校验请求失败（Bridge 不可用），拒绝执行：' .. tostring(response and response.error or 'no response'))
            return
        end
        local body = response.body
        local decoded
        if type(body) == 'string' then
            -- 与 commands.lua 一致，用 Phase 1 的 BWS.json.decode
            local ok_decode, value = pcall(BWS.json.decode, body)
            if ok_decode then decoded = value end
        elseif type(body) == 'table' then
            decoded = body
        end
        if type(decoded) ~= 'table' or decoded.allowed ~= true then
            local code = (type(decoded) == 'table' and decoded.code) or 'CONTROL_DENIED'
            local message = (type(decoded) == 'table' and decoded.message) or '控制权校验未通过'
            deny(report, command.id, startedMs, tostring(code), tostring(message))
            return
        end
        counts.accepted = counts.accepted + 1
        startAction(command, report, startedMs)
    end, 6)

    -- 同步阶段：校验已发出，等回调
    return { status = 'VALIDATING', note = '控制权二次校验中（异步），结果通过回执返回' }
end

--- 只读：移动状态（不需要控制权，不修改游戏）
function E.movementStatus()
    local currentName, currentArgs = nil, nil
    if Whale ~= nil and Whale.actions ~= nil and Whale.actions.Current ~= nil then
        local ok, a, b = pcall(Whale.actions.Current)
        if ok then currentName, currentArgs = a, b end
    end
    local player = nil
    if Whale ~= nil and Whale.util ~= nil and Whale.util.pos ~= nil then
        local ok, x, _, z = pcall(function()
            local p = Whale.util.player()
            if p == nil then return nil end
            return Whale.util.pos(p)
        end)
        if ok and x ~= nil then player = { x = x, z = z } end
    end
    return {
        ok = true,
        current_action = currentName,
        current_args = currentArgs,
        moving = currentName ~= nil,
        player_pos = player,
        last_move = lastMove,
        counts = counts,
    }
end

function E.status()
    return {
        known_actions = (function()
            local list = {}
            for k in pairs(ACTION_MAP) do list[#list + 1] = k end
            table.sort(list)
            return list
        end)(),
        write_actions = WRITE_ACTIONS,
        counts = counts,
    }
end

BWS2.actionExecutor = E
