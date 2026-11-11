-- 本地文件桥：模组和外面的 DSH 插件靠几个 json 文件说话
--
-- 通道有两条，同时用（外面挑最新的那条）：
--   1) 持久化字符串：TheSim:SetPersistentString / GetPersistentString
--      服务端写进存档目录（<Klei>/DoNotStarveTogether/<存档>/Cluster_N/<分片>/save 之类）
--   2) 直接写文件：io.open 写游戏进程的工作目录（一般是游戏目录下的 bin64）
-- 两条都失败就什么也不做，不会影响游戏本身。
local GLOBAL = GLOBAL
local U = Whale.util
local B = {}

local FILES = Whale ~= nil and Whale.files or {}

local TICK = 0.2      -- 动作推进
local READ_CMD = 0.3  -- 读指令
local WRITE_STATE = 1 -- 写状态（会被设置覆盖）

local seq = 0
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
    local p = U.player()
    local text, data = Whale.observe.Build(p)
    seq = seq + 1
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
        if state.text == last_state_text and not force then
            return nil
        end
        last_state_text = state.text
        last_state_at = os.time()
        return Whale.json.encode(state)
    end)
    if not ok or payload == nil then return end
    write_both(FILES.state, FILES.io_state, payload)
end

-- ─────────────────── 结果 ───────────────────

function B.Report(ok, text, cmd_id)
    local id = cmd_id or last_cmd_id
    pending_result = Whale.json.encode({
        v = 1,
        id = id,
        ok = ok and true or false,
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
    local ok, cmd = pcall(Whale.json.decode, json_text)
    if not ok or type(cmd) ~= "table" then
        log("收到看不懂的指令")
        return
    end
    local id = cmd.id ~= nil and tostring(cmd.id) or nil
    if id == nil or id == last_cmd_id then return end
    last_cmd_id = id
    local action = tostring(cmd.action or "")
    log("收到指令 " .. id .. "：" .. action)
    if action == "" then
        B.Report(false, "指令里没有 action", id)
        return
    end
    local started, err = Whale.actions.Start(action, type(cmd.args) == "table" and cmd.args or {})
    if not started then
        B.Report(false, err or "动作没能开始", id)
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
    local ok, data = pcall(Whale.json.decode, text)
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

local function server_tick()
    local ok, err = pcall(function()
        poll_settings()
        poll_command()
        Whale.actions.Tick()
        B.WriteState(false)
    end)
    if not ok then
        U.log("主循环出错：" .. tostring(err))
    end
end

function B.start_server(world)
    B.WriteState(true)
    world:DoPeriodicTask(TICK, server_tick)
    print("[大肥鱼饿不死] 文件桥已启动（服务端）：写 " .. tostring(FILES.state))
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
                    local fine, info = pcall(Whale.json.decode, data)
                    if fine and type(info) == "table" and info.pause ~= nil then
                        local want = info.pause and true or false
                        if want ~= paused_by_us then client_set_paused(want) end
                    end
                end
            end)
            return
        end
        local fine, info = pcall(Whale.json.decode, text)
        if fine and type(info) == "table" and info.pause ~= nil then
            local want = info.pause and true or false
            if want ~= paused_by_us then client_set_paused(want) end
        end
    end)
    if not ok then U.log("客户端循环出错：" .. tostring(err)) end
end

function B.start_client(world)
    world:DoPeriodicTask(0.5, client_tick)
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
