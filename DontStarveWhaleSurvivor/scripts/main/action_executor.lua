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
    -- Phase 5 M3：基础资源采集（复用已有 pick / go_to，不重写动作状态机）
    gather_resource = 'pick',
    move_to_target = 'go_to',
}

-- 需要控制权写权限的动作（get_movement_status / probe_game_actions 是只读）
local WRITE_ACTIONS = { move_to = true, stop_movement = true,
    gather_resource = true, move_to_target = true }

-- Phase 5 M3：资源类型 → 游戏内实体名白名单。
-- 只映射到「可采摘实体」（pickable / harvestable），走 ACTIONS.PICK / HARVEST。
-- 地面物品（flint/logs/rocks 掉落物）与需工具资源（tree/rock）不在 M3 范围，
-- 绝不让外部传任意 prefab 名直接被当作目标。
local GATHER_TARGETS = {
    -- 真机验证(2026-11-12)：find_by_name 按 prefab/显示名子串匹配；'twigs' 匹配不到
    -- twiggytree（那是 tree，走 CHOP 不是 PICK）。真正可采的树枝来源是 sapling（树苗，pickable）。
    -- 地图里若只有 twiggytree 没有 sapling，游戏会如实回报「附近没有能采的东西」。
    twigs = 'sapling',
    grass = 'grass',           -- 草
    berries = 'berrybush',     -- 浆果丛
}
local GATHER_MAX_COUNT = 10
local GATHER_MAX_RADIUS = 20

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

-- Phase 5 M2 修复：动作最终成败回执。
-- 之前启动成功就回 SUCCEEDED，Bridge 命令直接终态，之后 Whale.actions.Tick 的 done/fail
-- 只写文件桥，HTTP 侧永远不知道结果 → 破坏 NEEDS_RECONCILIATION 语义。
-- 现在：启动时回 EXECUTING（Bridge 状态机已支持中间态），完成时用同一 command_id 补发终态。
local pending = nil   -- { command_id, report, startedMs, action }
local lastReportFn = nil  -- 保存 commands.lua 的 report 函数供完成回调复用
local completionCounts = { succeeded = 0, failed = 0, reconciled = 0 }

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
--- 把外部命令参数规范化成固定 job 的参数。
--- **绝不透传任意字符串**：资源名只从 GATHER_TARGETS 查表，数值做范围夹取。
--- @return table args, string|nil err
local function buildJobArgs(command)
    local p = command.params or {}
    if command.type == 'move_to' then
        return { x = p.x, z = p.z, timeout = p.timeout }, nil
    elseif command.type == 'stop_movement' then
        return {}, nil
    elseif command.type == 'move_to_target' then
        -- go_to 的 target 也走同一张资源白名单（M3 只允许走向已知可采资源）
        local name = GATHER_TARGETS[p.resource]
        if name == nil then
            return nil, 'unknown_target: 只支持 twigs/grass/berries'
        end
        local radius = tonumber(p.radius) or 12
        if radius < 2 then radius = 2 end
        if radius > GATHER_MAX_RADIUS then radius = GATHER_MAX_RADIUS end
        return { target = name, radius = radius }, nil
    elseif command.type == 'gather_resource' then
        local name = GATHER_TARGETS[p.resource]
        if name == nil then
            return nil, 'unknown_resource: 只支持 twigs/grass/berries（flint/logs/rocks 与需工具资源不在 M3）'
        end
        local count = tonumber(p.count) or 1
        if count < 1 then count = 1 end
        if count > GATHER_MAX_COUNT then count = GATHER_MAX_COUNT end
        local radius = tonumber(p.radius) or 12
        if radius < 2 then radius = 2 end
        if radius > GATHER_MAX_RADIUS then radius = GATHER_MAX_RADIUS end
        return { target = name, count = count, radius = radius }, nil
    end
    return nil, 'unknown_action'
end

local function startAction(command, report, startedMs)
    local jobName = ACTION_MAP[command.type]
    local jobArgs, argErr = buildJobArgs(command)
    if jobArgs == nil then
        counts.failed = counts.failed + 1
        if report ~= nil then
            report(command.id, 'FAILED', nil, tostring(argErr), startedMs)
        end
        return
    end
    local okStart, err = Whale.actions.Start(jobName, jobArgs)
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
    lastMove.target = jobArgs
    lastMove.started_at = now()
    lastMove.finished_at = nil
    lastMove.ok = nil
    lastMove.text = nil
    lastMove.command_id = command.id

    -- 回 EXECUTING（中间态），不是终态。Bridge 的 CommandQueue.settle 已支持 EXECUTING，
    -- 之后会用同一个 command_id 补发 SUCCEEDED / FAILED。
    -- 记录 pending，供 pollCompletion 在动作结束时补发终态。
    pending = {
        command_id = command.id,
        report = report,
        startedMs = startedMs,
        action = command.type,
        job = jobName,
        args = jobArgs,
    }
    lastReportFn = report
    if report ~= nil then
        report(command.id, 'EXECUTING', {
            accepted = true,
            action = command.type,
            job = jobName,
            args = jobArgs,
            running = true,
            note = '动作执行中；完成后由 action_executor 补发终态回执',
        }, nil, startedMs)
    end
end

--- Whale.bridge.Report 的 hook：动作 done/fail 时拿到真实结果与文本。
--- 只缓存，结算由 pollCompletion 在确认 Whale.actions.Current() 已变 nil 后执行，
--- 避免"被新指令打断"的 Report 被误当成上一个动作的成功。
local lastActionOutcome = nil  -- { ok, text, at }

function E.onActionReport(ok, text, _cmdId)
    lastActionOutcome = { ok = ok and true or false, text = tostring(text or ""), at = now() }
end

--- 把 pending 动作结算成终态回执（用同一个 command_id）
local function settle(status, result, errorText)
    if pending == nil then return false end
    local p = pending
    pending = nil
    local reportFn = p.report or lastReportFn
    if reportFn ~= nil then
        reportFn(p.command_id, status, result, errorText, p.startedMs)
    end
    lastMove.ok = status == 'SUCCEEDED'
    lastMove.finished_at = now()
    lastMove.text = errorText or (type(result) == 'table' and result.text) or nil
    if status == 'SUCCEEDED' then
        completionCounts.succeeded = completionCounts.succeeded + 1
    else
        completionCounts.failed = completionCounts.failed + 1
    end
    return true
end

--- 周期驱动（由 observer Tick / net.keepAlive 调用）：检测动作是否结束并补发终态。
--- 断线导致无法确认时进 NEEDS_RECONCILIATION（不盲目重放）。
function E.pollCompletion()
    if pending == nil then return end

    local current = nil
    if Whale ~= nil and Whale.actions ~= nil and Whale.actions.Current ~= nil then
        local ok, name = pcall(Whale.actions.Current)
        if ok then current = name end
    end

    if current ~= nil then
        -- 动作还在跑：检查是否超时（长动作不能无限等）
        local timeout = 120
        if now() - (lastMove.started_at or 0) > timeout then
            pcall(function()
                local player = Whale.util.player()
                if player ~= nil then
                    if player.components ~= nil and player.components.locomotor ~= nil then
                        player.components.locomotor:Stop()
                    end
                    player:ClearBufferedAction()
                end
            end)
            settle('FAILED', { action = pending.action, timed_out = true },
                'action_timeout: 超过 ' .. tostring(timeout) .. ' 秒未完成，已停止')
        end
        return
    end

    -- Current() 变 nil：动作已结束（done / fail / 被中断）。
    -- 优先用 Whale.bridge.Report 的真实结果；拿不到就按"无法确认"处理，绝不假装成功。
    local outcome = lastActionOutcome
    lastActionOutcome = nil
    local args = pending.args
    if outcome ~= nil and outcome.at >= (lastMove.started_at or 0) then
        local text = outcome.text
        local interrupted = string.find(text, '打断了', 1, true) ~= nil
        if interrupted then
            settle('FAILED', { action = pending.action, args = args, interrupted = true }, text)
        elseif outcome.ok then
            -- 真实完成文本来自 Whale.actions（例如「采了 2 次」），原样带回，不编造数量
            settle('SUCCEEDED', { action = pending.action, job = pending.job, args = args,
                text = text, completed = true }, nil)
        else
            settle('FAILED', { action = pending.action, job = pending.job, args = args, text = text }, text)
        end
    else
        -- 完成信号丢了（游戏断线 / 分片重载）→ 结果未知，禁止盲目重放
        completionCounts.reconciled = completionCounts.reconciled + 1
        settle('FAILED', { action = pending.action, args = args, unknown_completion = true },
            'unknown_completion: 动作结束但结果无法确认，需人工核对（NEEDS_RECONCILIATION）')
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

    -- 4) 参数校验：数值范围 + **资源/目标名白名单**（绝不透传任意字符串给游戏）
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
    elseif kind == 'gather_resource' or kind == 'move_to_target' then
        local resource = (command.params or {}).resource
        if type(resource) ~= 'string' or GATHER_TARGETS[resource] == nil then
            return deny(report, command.id, startedMs, 'invalid_argument',
                'resource 必须是 twigs/grass/berries 之一（只允许固定白名单，不接受任意 prefab 名）')
        end
    end

    -- 5) 提前用 buildJobArgs 校验一遍（避免等控制权 assert 回调后才报参数错）
    local earlyArgs, earlyErr = buildJobArgs(command)
    if earlyArgs == nil then
        return deny(report, command.id, startedMs, 'invalid_argument', tostring(earlyErr))
    end

    -- 6) 控制权二次校验（问 Bridge，不自己存状态）
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

--- Phase 5 M3：只读探测当前游戏构建里 ACTIONS / 组件是否可用。
--- 任务书要求「所有 API 必须通过当前游戏构建版本实际验证」，
--- 所以 pick_up_item 不能凭空写 ACTIONS.PICKUP，先探测再决定。
--- 只查固定名单里的键是否存在，绝不把外部字符串当动作名执行。
function E.probeGameActions()
    local result = { ok = true, actions = {}, components = {}, jobs = {} }
    local keys = { 'PICK', 'HARVEST', 'CHOP', 'MINE', 'DIG', 'PICKUP', 'GIVE', 'EAT', 'BUILD' }
    local A = GLOBAL.ACTIONS
    for _, key in ipairs(keys) do
        local ok, present = pcall(function() return A ~= nil and A[key] ~= nil end)
        result.actions[key] = (ok and present == true) or false
    end
    -- 已知组件是否存在（决定地面物品拾取能否走原生路径）
    local ckeys = { 'inventoryitem', 'pickable', 'workable', 'harvestable' }
    for _, key in ipairs(ckeys) do
        -- 组件是否注册在实体上要在运行时看，这里只报告"能否安全读取"
        result.components[key] = 'runtime_only'
    end
    -- Whale.actions 里已登记的 JOBS（固定白名单可读）
    if Whale ~= nil and Whale.actions ~= nil and Whale.actions.Known ~= nil then
        local ok, list = pcall(Whale.actions.Known)
        if ok and type(list) == 'table' then result.jobs = list end
    end
    -- M3 可用资源白名单
    result.gather_targets = (function()
        local list = {}
        for k in pairs(GATHER_TARGETS) do list[#list + 1] = k end
        table.sort(list)
        return list
    end)()
    result.pickup_supported = result.actions.PICKUP == true
    result.note = 'PICKUP 是否可用以真实游戏返回为准；为 false 时 M3 不实现 pick_up_item'
    return result
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
        completion = completionCounts,
        pending_command_id = pending ~= nil and pending.command_id or nil,
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
        completion = completionCounts,
        pending_command_id = pending ~= nil and pending.command_id or nil,
    }
end

BWS2.actionExecutor = E
