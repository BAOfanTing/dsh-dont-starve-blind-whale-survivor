-- 本地文件桥：模组和外面的 DSH 插件靠几个 json 文件说话
--
-- 通道有两条，同时用（外面挑最新的那条）：
--   1) 持久化字符串：TheSim:SetPersistentString / GetPersistentString
--      服务端写进存档目录（<Klei>/DoNotStarveTogether/<存档>/Cluster_N/<分片>/save 之类）
--   2) 直接写文件：io.open 写游戏进程的工作目录（一般是游戏目录下的 bin64）
-- 两条都失败就什么也不做，不会影响游戏本身。
local GLOBAL = GLOBAL
-- 饥荒的模组沙箱只给了 pairs/ipairs/print/math/table/type/string/tostring/require/Class，
-- pcall / tonumber / error / os / io 这些得从 GLOBAL（就是 _G）里拿，直接用会报 nil（0.1.0 就是这么崩的）。
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local error = GLOBAL.error
local os = GLOBAL.os or { time = function() return 0 end }
local io = GLOBAL.io

local U = Whale.util
local B = {}

local FILES = Whale ~= nil and Whale.files or {}

local TICK = 0.2      -- 动作推进
local READ_CMD = 0.3  -- 读指令（保留：io 通道优先，读不到再走持久化字符串）
--- 状态写盘间隔：M1.1 起由 modinfo 的 INTERVAL 决定（config.lua 兜底 1 秒），
--- 运行中还能被 whale_settings.json 的 interval 覆盖（插件侧热改）。
local WRITE_STATE = 1
do
    local c = Whale ~= nil and Whale.config or nil
    if c ~= nil and c.get ~= nil then
        local ok, value = pcall(c.get, "state_interval")
        if ok and tonumber(value) ~= nil then WRITE_STATE = math.max(0.2, tonumber(value)) end
    end
end

local seq = 0
local tick_count = 0
local last_cmd_id = nil
local reading = false
local last_state_text = nil
local last_state_at = 0
local next_cmd_at = 0
local next_settings_at = 0
local next_state_at = 0
local settings = { pause = false }
local pending_result = nil
local booted = false
local pc_ok = nil

local function log(msg)
    if Whale.verbose then print("[大肥鱼] " .. tostring(msg)) end
end

-- ─────────────────── io 通道 ───────────────────

local function io_write(name, text)
    if io == nil or io.open == nil then return false end
    local ok, file = pcall(io.open, name, "w")
    if not ok or file == nil then return false end
    local wrote = pcall(function()
        file:write(text)
        file:close()
    end)
    return wrote
end

local function io_read(name)
    if io == nil or io.open == nil then return nil end
    local ok, file = pcall(io.open, name, "r")
    if not ok or file == nil then return nil end
    local content = nil
    pcall(function()
        content = file:read("*a")
        file:close()
    end)
    return content
end

-- ─────────────────── 持久化字符串通道 ───────────────────

local function ps_write(name, text)
    local ok = pcall(function()
        GLOBAL.TheSim:SetPersistentString(name, text, false)
    end)
    return ok
end

local function ps_read(name, cb)
    local ok = pcall(function()
        GLOBAL.TheSim:GetPersistentString(name, function(success, data)
            cb(success and data or nil)
        end)
    end)
    if not ok then cb(nil) end
end

-- 两条通道都写
local function write_both(name, io_name, text)
    ps_write(name, text)
    return io_write(io_name, text)
end

-- ─────────────────── 状态 ───────────────────

local function build_state()
    local now = U.now()
    local provider = Whale ~= nil and Whale.actor or nil
    local actor, why = nil, nil
    if provider ~= nil and provider.get_actor ~= nil then
        local ok, got, reason = pcall(provider.get_actor)
        if ok then actor, why = got, reason else why = tostring(got) end
    else
        actor = U.player()
    end

    seq = seq + 1
    -- M1.1：观察器只从 Actor Provider 拿实体；文本与结构化数据同源（data → text）
    local text, data
    local ok_build, err = pcall(function()
        text, data = Whale.observe.BuildSample(actor, { seq = seq, now = now })
    end)
    if not ok_build or data == nil then
        data = {
            schema = "bws.state/1",
            ready = false,
            observer = {
                snapshot_id = "s" .. tostring(seq),
                sequence = seq,
                timestamp = now,
                status = "error",
                errors = { "观察器出错：" .. tostring(err) },
                unavailable_fields = {},
            },
        }
        text = "# 快照 s" .. tostring(seq) .. " · 状态 error\n观察器出错：" .. tostring(err)
    end
    if actor == nil and why ~= nil and data.observer ~= nil then
        data.observer.status = data.observer.status or "no_actor"
        local errs = data.observer.errors or {}
        errs[#errs + 1] = "没有观察对象：" .. tostring(why)
        data.observer.errors = errs
    end

    -- 诊断用：外面看这几个数字就知道模组是活着、还是找不到玩家
    data.players = U.count_players()
    data.tick = tick_count
    data.mastersim = true
    return {
        v = 1,
        seq = seq,
        t = os.time(),
        mod = Whale.version,
        ready = data.ready == true,
        text = text,
        data = data,
    }
end

function B.WriteState(force)
    local now = U.now()
    if not force and now < next_state_at then return end
    next_state_at = now + WRITE_STATE
    local ok, payload = pcall(function()
        local state = build_state()
        last_state_text = state.text
        last_state_at = os.time()
        return Whale.json.encode(state)
    end)
    if not ok or payload == nil then return end
    write_both(FILES.state, FILES.io_state, payload)
end

-- ─────────────────── 结果 ───────────────────

function B.Report(ok, text, cmd_id, reason)
    local id = cmd_id or last_cmd_id
    -- M1.0：A 栈（scripts/main）已归档，这里原来有两个转发钩子
    -- （动作执行器的 onActionReport、任务链的 OnActionResult，都挂在 A 栈的全局表上）。
    -- 现在结果只写一份给外面的 Node，不再有第二条链路需要它。
    pending_result = Whale.json.encode({
        v = 1,
        id = id,
        ok = ok and true or false,
        reason = reason,
        text = tostring(text or ""),
        t = os.time(),
    })
    if FILES.result ~= nil then
        write_both(FILES.result, FILES.io_result, pending_result)
    end
    -- 动作一完成就立刻刷新状态，AI 下一步看到的是最新情况
    B.WriteState(true)
    log("结果 " .. tostring(id) .. " " .. tostring(ok) .. "：" .. tostring(text))
end

-- ─────────────────── 指令 ───────────────────

local function handle_command(json_text)
    local ok, cmd = pcall(Whale.json.decode, U.strip_header(json_text))
    if not ok or type(cmd) ~= "table" then
        log("收到看不懂的指令")
        return
    end
    local id = cmd.id ~= nil and tostring(cmd.id) or nil
    if id == nil then return end
    last_cmd_id = id
    local action = tostring(cmd.action or "")
    log("收到指令 " .. id .. "：" .. action)
    if action == "" then
        B.Report(false, "指令里没有 action", id, "missing_action")
        return
    end

    -- M2.0：Lua 是最终授权者。协议/过期/白名单/租约世代/角色/参数/组件 全在这里校验。
    local guard = Whale.guard
    if guard == nil or guard.validate == nil then
        B.Report(false, "安全校验层缺失，拒绝执行", id, "guard_missing")
        return
    end
    local ok_cmd, reason = guard.validate(cmd)
    if not ok_cmd then
        log("拒绝指令 " .. id .. "：" .. tostring(reason))
        B.Report(false, "拒绝：" .. tostring(reason), id, tostring(reason))
        return
    end
    guard.accept(cmd)

    local started, err = Whale.actions.Start(action, type(cmd.args) == "table" and cmd.args or {}, id)
    if not started then
        B.Report(false, err or "动作没能开始", id, "action_start_failed")
    end
end

local function poll_command()
    if reading then return end
    reading = true
    local saved = nil
    local function done(text)
        reading = false
        if text ~= nil and text ~= "" then handle_command(text) end
    end
    -- io 通道优先（快），读不到再走持久化字符串
    local text = io_read(FILES.io_cmd)
    if text ~= nil and text ~= "" then
        saved = text
    end
    if saved ~= nil then
        done(saved)
        return
    end
    ps_read(FILES.cmd, function(data)
        done(data)
    end)
end

-- ─────────────────── 设置 ───────────────────

local function apply_settings(text)
    local ok, data = pcall(Whale.json.decode, U.strip_header(text))
    if not ok or type(data) ~= "table" then return end
    if data.pause ~= nil then settings.pause = data.pause and true or false end
    if data.verbose ~= nil then Whale.verbose = data.verbose and true or false end
    if data.interval ~= nil then
        local interval = tonumber(data.interval)
        if interval ~= nil then WRITE_STATE = math.max(0.2, interval) end
    end
end

local function poll_settings()
    local now = U.now()
    if now < next_settings_at then return end
    next_settings_at = now + 2
    local text = io_read(FILES.io_settings)
    if text ~= nil and text ~= "" then
        apply_settings(text)
        return
    end
    ps_read(FILES.settings, function(data)
        if data ~= nil and data ~= "" then apply_settings(data) end
    end)
end

-- ─────────────────── 服务端主循环 ───────────────────

local last_error_at = 0

-- Phase 5 M4：三路互守用（文件桥 server_tick ↔ 观察器 Tick ↔ net tick）
local server_tick_task = nil
local server_last_tick_at = 0
local server_rebuilds = 0
--- server_tick 超过这么多秒没跑，就认为它停摆了
local SERVER_KEEPALIVE_GAP = 5

--- 真实时钟（os.time）。不用 U.now()：它依赖 TheSim:GetTime，某些构建里拿不到会恒为 0。
local function bridge_now()
    local os_ = GLOBAL.os
    if os_ ~= nil and os_.time ~= nil then
        local ok, v = pcall(os_.time)
        if ok and v ~= nil then return tonumber(v) or 0 end
    end
    return 0
end

--- 每一步单独保护：哪一步出错就打出来（10 秒最多一条），别让一个错误把整条桥搞哑
local function step(what, fn)
    local ok, err = pcall(fn)
    if ok then return end
    local now = U.now()
    if now - last_error_at > 10 then
        last_error_at = now
        print("[大肥鱼饿不死] " .. what .. " 出错：" .. tostring(err))
    end
end

local function server_tick()
    tick_count = tick_count + 1
    server_last_tick_at = bridge_now()
    step("读设置", poll_settings)
    step("读指令", poll_command)
    step("跑动作", function() Whale.actions.Tick() end)
    -- 保命反射：只在没有任务在跑的时候动手（血见底/入夜没光/火要灭/被贴脸）
    step("保命反射", function()
        if Whale.reflex ~= nil then Whale.reflex.Tick() end
    end)
    -- 人物在走的时候顺手把"要去哪"再告诉客户端一次（否则客户端先停下就变回滑行）
    step("同步客户端走路", function()
        if Whale.actions.refresh_client_walk ~= nil then Whale.actions.refresh_client_walk(false) end
    end)
    step("写状态", function() B.WriteState(false) end)
end

function B.start_server(world)
    B.WriteState(true)
    server_tick_task = world:DoPeriodicTask(TICK, server_tick)
    server_last_tick_at = bridge_now()
    print("[大肥鱼饿不死] 文件桥已启动（服务端）：写 " .. tostring(FILES.state))
end

--- Phase 5 M4：文件桥 server_tick 停摆自愈（由观察器 Tick 反向驱动）。
--- 不信任任务对象"看着有效"，只看时间戳是否还在走。
function B.KeepAlive()
    local world = GLOBAL.TheWorld
    if world == nil then return end
    local ok_m, master = pcall(function() return world.ismastersim end)
    if not ok_m or master ~= true then return end
    local at = bridge_now()
    if server_last_tick_at > 0 and at - server_last_tick_at < SERVER_KEEPALIVE_GAP then return end
    if server_tick_task ~= nil then
        pcall(function() server_tick_task:Cancel() end)
        server_tick_task = nil
    end
    local ok = pcall(function() server_tick_task = world:DoPeriodicTask(TICK, server_tick) end)
    if ok then
        server_rebuilds = server_rebuilds + 1
        server_last_tick_at = at
        print("[大肥鱼饿不死] server_tick 停摆过，已重建（第 " .. server_rebuilds .. " 次）")
    end
end

-- ─────────────────── 客户端：AI 思考时暂停世界 ───────────────────
-- 客户端单独一小段：它读外面写的“要不要暂停”，然后调 SetServerPaused。
-- 只有自己开的世界（房主）才有权限，失败就安静放弃。

local paused_by_us = false

local function client_set_paused(want)
    if GLOBAL.SetServerPaused == nil then
        if pc_ok == nil then
            pc_ok = false
            print("[大肥鱼饿不死] 这个版本没有 SetServerPaused，AI 思考时不会暂停世界")
        end
        return
    end
    local ok = pcall(function() GLOBAL.SetServerPaused(want) end)
    if ok then
        paused_by_us = want
    elseif pc_ok == nil then
        pc_ok = false
        print("[大肥鱼饿不死] 暂停世界失败（可能不是房主），AI 思考时不会暂停")
    end
end

local function client_tick()
    local ok, err = pcall(function()
        local text = io_read(FILES.io_pause)
        if text == nil or text == "" then
            ps_read(FILES.pause, function(data)
                if data ~= nil and data ~= "" then
                    local fine, info = pcall(Whale.json.decode, U.strip_header(data))
                    if fine and type(info) == "table" and info.pause ~= nil then
                        local want = info.pause and true or false
                        if want ~= paused_by_us then client_set_paused(want) end
                    end
                end
            end)
            return
        end
        local fine, info = pcall(Whale.json.decode, U.strip_header(text))
        if fine and type(info) == "table" and info.pause ~= nil then
            local want = info.pause and true or false
            if want ~= paused_by_us then client_set_paused(want) end
        end
    end)
    if not ok then U.log("客户端循环出错：" .. tostring(err)) end
end

function B.start_client(world)
    world:DoPeriodicTask(0.5, client_tick)
    -- 客户端的快捷键：F8 让内置 AI 开始/停下，F7 让它停手
    if Whale.hud ~= nil and Whale.hud.BindKeys ~= nil then
        Whale.hud.BindKeys()
    end
    U.log("文件桥已启动（客户端）")
end

-- ─────────────────── 启动 ───────────────────

function B.boot()
    if booted then return end
    local world = GLOBAL.TheWorld
    if world == nil then return end
    booted = true
    if world.ismastersim then
        B.start_server(world)
    else
        B.start_client(world)
    end
end

function B.on_player(player)
    if player == nil then return end
    Whale.last_player = player
end

Whale = Whale or {}
Whale.bridge = B
