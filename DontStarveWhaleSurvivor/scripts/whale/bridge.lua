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
local last_cmd_id = nil

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
local pending_result_data = nil
local last_ack_data = nil
local http_cfg = { enabled = false, port = nil, token = nil, url = nil }
local http_last_ok = 0
local http_inflight = false
local http_next_exchange_at = 0
local booted = false
local pc_ok = nil
local client_set_paused = nil
local dispatch_command = nil
local send_http_exchange = nil
local check_http_config = nil
local apply_settings = nil

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
    local interval = WRITE_STATE
    -- 如果启用了 HTTP 且最近 2 秒有心跳响应，非强制时拉长写盘间隔（每 5 秒兜底一次），大幅减轻磁盘 I/O
    if not force and http_cfg.enabled and (now - http_last_ok < 2.0) then
        interval = math.max(WRITE_STATE, 5.0)
    end
    if not force and now < next_state_at then return end
    next_state_at = now + interval
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
    pending_result_data = {
        v = 1,
        id = id,
        ok = ok and true or false,
        reason = reason,
        text = tostring(text or ""),
        t = os.time(),
    }
    pending_result = Whale.json.encode(pending_result_data)
    if FILES.result ~= nil then
        write_both(FILES.result, FILES.io_result, pending_result)
    end
    -- 动作一完成就立刻刷新状态，AI 下一步看到的是最新情况
    B.WriteState(true)
    -- HTTP 优先通道：立即触发一次 exchange，2ms 内将执行结果送达 Node 运行时
    if http_cfg.enabled and send_http_exchange ~= nil then
        pcall(function() send_http_exchange(build_state()) end)
    end
    log("结果 " .. tostring(id) .. " " .. tostring(ok) .. "：" .. tostring(text))
end

-- ─────────────────── M2.0.2：换手确认 ───────────────────
--- Node LeaseManager 是权威租约的唯一写入者；Lua 只写这份"撤销确认"。
--- 看到 revoking 时：先用已有的 A.Abort 安全停掉旧动作，再写确认。
local last_ack_key = nil

function B.WriteLeaseAck(authority)
    if authority == nil then return false end
    -- 去重键必须带 epoch：新权威状态可能复用同一 generation（例如插件重启后从磁盘重建），
    -- 只按 generation 去重会残留旧 ack，导致换手永远拿不到有效确认。
    local ack_key = tostring(authority.authority_epoch or "") .. ":" .. tostring(authority.generation)
    if last_ack_key == ack_key then return true end
    pcall(function()
        if Whale ~= nil and Whale.actions ~= nil and Whale.actions.Abort ~= nil then
            Whale.actions.Abort("控制权换手：旧动作已安全停止")
        end
    end)
    local ack = {
        schema = "bws.control-lease-ack/1",
        authority_epoch = authority.authority_epoch,
        generation = authority.generation,
        lease_id = authority.lease_id,
        runtime_id = authority.runtime_id,
        acked_at = os.time() * 1000.0,
        job_cleared = (Whale == nil or Whale.job == nil),
    }
    last_ack_data = ack
    local ok, text = pcall(Whale.json.encode, ack)
    if not ok then return false end
    last_ack_key = ack_key
    if http_cfg.enabled and send_http_exchange ~= nil then
        pcall(function() send_http_exchange() end)
    end
    return write_both(FILES.lease_ack or "whale_lease_ack.json",
                      FILES.io_lease_ack or "whale_io_lease_ack.json", text)
end

--- 每 tick 通过**已验证的持久化字符串通道**读权威租约，缓存给同步的 guard.validate 用。
--- Node 写的是带 KLEI 头的普通文件，TheSim:GetPersistentString 能读到（命令通道就这么工作）。
local function poll_authority()
    local guard = Whale ~= nil and Whale.guard or nil
    if guard == nil or guard.parse_authority == nil then return end
    ps_read(FILES.lease or "whale_lease.json", function(text)
        if text == nil or text == "" then return end
        local a = guard.parse_authority(text)
        if a ~= nil then
            Whale.authority_cache = { data = a, at = os.time() }
        end
    end)
end

--- 每个 tick 主动看一眼权威租约：revoking → 停旧动作 + 写确认（不等旧命令到达才收敛）
local function poll_lease()
    local guard = Whale ~= nil and Whale.guard or nil
    if guard == nil or guard.parse_authority == nil then return end
    local cache = Whale ~= nil and Whale.authority_cache or nil
    if cache == nil or type(cache.data) ~= "table" then return end
    if cache.data.status == "revoking" then
        B.WriteLeaseAck(cache.data)
    end
end

-- ─────────────────── 指令分发 ───────────────────

dispatch_command = function(cmd)
    if type(cmd) ~= "table" then return end
    local id = cmd.id ~= nil and tostring(cmd.id) or nil
    if id == nil then return end
    -- 同一 id 只处理一次
    if id == last_cmd_id then return end
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
    local ok_cmd, reason, detail = guard.validate(cmd)
    if not ok_cmd then
        log("拒绝指令 " .. id .. "：" .. tostring(reason))
        -- TARGET-REFRESH：被拒时把可操作的说明一起回给模型（合法 target_kind 清单、
        -- 当前真实背包里能吃什么、最近的目标在多远……）。reason 代码一个字没变，
        -- 所以状态分类、去重、既有测试全都不受影响。
        local text = "拒绝：" .. tostring(reason)
        if type(detail) == "table" and detail.hint ~= nil then
            text = text .. "｜" .. tostring(detail.hint)
        end
        B.Report(false, text, id, tostring(reason))
        return
    end
    guard.accept(cmd)

    -- M2.1：guard 已把 #N 解析成真实实体（detail.target），这里只负责传下去
    local started, err = Whale.actions.Start(
        action,
        type(cmd.args) == "table" and cmd.args or {},
        id,
        {
            target = detail ~= nil and detail.target or nil,
            -- SURVIVAL-01：背包类动作由 guard 从**真实背包**解析，模型只给白名单名字
            survival_eat = detail ~= nil and detail.survival_eat or nil,
            survival_craft = detail ~= nil and detail.survival_craft or nil,
            survival_equip = detail ~= nil and detail.survival_equip or nil,
            recipe = detail ~= nil and detail.recipe or nil,
            item = detail ~= nil and detail.item or nil,
            food = detail ~= nil and detail.food or nil,
            -- SURVIVAL-02：范围采集 / 走出去找
            survival_area = (action == "gather_area") or nil,
            survival_seek = (action == "seek") or nil,
            prefab = cmd.args ~= nil and cmd.args.prefab or nil,
            radius = cmd.args ~= nil and cmd.args.radius or nil,
            limit = cmd.args ~= nil and cmd.args.limit or nil,
            step = cmd.args ~= nil and cmd.args.step or nil,
            max_tiles = cmd.args ~= nil and cmd.args.max_tiles or nil,
            look = cmd.args ~= nil and cmd.args.look or nil,
            -- SURVIVAL-03
            times = cmd.args ~= nil and cmd.args.times or nil,
            seconds = cmd.args ~= nil and cmd.args.seconds or nil,
            -- SURVIVAL-04
            survival_unequip = (action == "unequip") or nil,
            slot = cmd.args ~= nil and cmd.args.slot or nil,
            text = cmd.args ~= nil and cmd.args.text or nil,
            fuel_item = cmd.args ~= nil and cmd.args.item or nil,
            use_action = cmd.args ~= nil and cmd.args.action or nil,
            -- SURVIVAL-05
            count = cmd.args ~= nil and cmd.args.count or nil,
            -- 外层给的预算（秒）。顶层字段，不来自 args，模型改不了。
            budget_s = tonumber(cmd.budget_s) or nil,
            cook_items = cmd.args ~= nil and cmd.args.items or nil,
            -- SURVIVAL-06
            survival_build = (action == "build") or nil,
            -- TARGET-REFRESH：实时目标选择的类别（诊断/回执用；目标实体由 guard 解析好放在 target）
            target_kind = cmd.args ~= nil and cmd.args.target_kind or nil,
            -- TARGET-REFRESH：稳定句柄路径（有它就没走 snapshot_id）
            target_handle = cmd.args ~= nil and cmd.args.target_handle or nil,
            build_recipe = cmd.args ~= nil and cmd.args.recipe or nil,
            recipe_filter = cmd.args ~= nil and cmd.args.filter or nil,
            lookup_query = cmd.args ~= nil and cmd.args.q or nil,
            probe_prefab = cmd.args ~= nil and cmd.args.prefab or nil,
            probe_radius = cmd.args ~= nil and cmd.args.radius or nil,
            kiting = detail ~= nil and detail.kiting or nil,
        }
    )
    if not started then
        B.Report(false, err or "动作没能开始", id, "action_start_failed")
    end
end

local function handle_command(json_text)
    local ok, cmd = pcall(Whale.json.decode, U.strip_header(json_text))
    if not ok or type(cmd) ~= "table" then
        log("收到看不懂的指令")
        return
    end
    dispatch_command(cmd)
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

-- ─────────────────── Localhost HTTP 通道（TheSim:QueryServer） ───────────────────

check_http_config = function()
    if http_cfg.enabled then return true end
    local file_name = FILES.io_http or "whale_io_http.json"
    local text = io_read(file_name)
    if text ~= nil and text ~= "" then
        local ok, parsed = pcall(Whale.json.decode, U.strip_header(text))
        if ok and type(parsed) == "table" and parsed.port ~= nil then
            http_cfg.port = parsed.port
            http_cfg.token = parsed.token
            http_cfg.url = "http://127.0.0.1:" .. tostring(parsed.port) .. "/v1/exchange?t=" .. tostring(parsed.token or "")
            http_cfg.enabled = true
            return true
        end
    end
    ps_read(FILES.http or "whale_http.json", function(data)
        if data ~= nil and data ~= "" then
            local ok, parsed = pcall(Whale.json.decode, U.strip_header(data))
            if ok and type(parsed) == "table" and parsed.port ~= nil then
                http_cfg.port = parsed.port
                http_cfg.token = parsed.token
                http_cfg.url = "http://127.0.0.1:" .. tostring(parsed.port) .. "/v1/exchange?t=" .. tostring(parsed.token or "")
                http_cfg.enabled = true
            end
        end
    end)
    return http_cfg.enabled
end

-- ─────────────────── 设置 ───────────────────

apply_settings = function(input)
    local data = nil
    if type(input) == "table" then
        data = input
    elseif type(input) == "string" then
        local ok, parsed = pcall(Whale.json.decode, U.strip_header(input))
        if ok and type(parsed) == "table" then data = parsed end
    end
    if data == nil then return end
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

-- ─────────────────── HTTP 交换 ───────────────────

local HTTP_IDLE_POLL_INTERVAL = 5.0

send_http_exchange = function(immediate_state)
    if not http_cfg.enabled or http_cfg.url == nil then return false end
    if GLOBAL.TheSim == nil or GLOBAL.TheSim.QueryServer == nil then return false end
    if http_inflight then return false end

    local now = U.now()
    local players = U.count_players()
    local has_player = (players > 0)

    -- 无玩家时降低轮询频率至 5 秒一次，避免空闲分片（如洞穴）频繁刷 HTTP 甚至截胡指令
    if not has_player and pending_result_data == nil and last_ack_data == nil and immediate_state == nil then
        if now < http_next_exchange_at then
            return false
        end
    end
    if not has_player then
        http_next_exchange_at = now + HTTP_IDLE_POLL_INTERVAL
    end

    http_inflight = true
    local st = immediate_state or build_state()
    local shard_id = (st.data ~= nil and st.data.identity ~= nil and st.data.identity.shard_id) or nil
    local payload = {
        token = http_cfg.token,
        shard_id = shard_id,
        state = st,
        result = pending_result_data,
        ack = last_ack_data,
        t = os.time(),
    }
    local ok_enc, body = pcall(Whale.json.encode, payload)
    if not ok_enc or body == nil then
        http_inflight = false
        return false
    end

    GLOBAL.TheSim:QueryServer(http_cfg.url, function(result, ok, code)
        http_inflight = false
        if ok and code == 200 and result ~= nil and result ~= "" then
            http_last_ok = U.now()
            local fine, data = pcall(Whale.json.decode, result)
            if fine and type(data) == "table" then
                if data.result_acked and pending_result_data ~= nil then
                    pending_result_data = nil
                end
                if type(data.commands) == "table" and #data.commands > 0 then
                    for _, cmd in ipairs(data.commands) do
                        dispatch_command(cmd)
                    end
                end
                if type(data.settings) == "table" then
                    apply_settings(data.settings)
                end
                if data.pause ~= nil and client_set_paused ~= nil then
                    client_set_paused(data.pause == true)
                end
            end
            -- 全双工自驱动：如果刚收到了指令或状态有重大变化，主动链式调度下一次轮询，极速收敛指令执行流
            -- 但若没有活跃玩家，不进行链式自驱动
            if not http_inflight and (pending_result_data ~= nil or (has_player and type(data) == "table" and type(data.commands) == "table" and #data.commands > 0)) then
                send_http_exchange()
            end
        end
    end, "POST", body)
    return true
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
    step("HTTP交换", function()
        if check_http_config() then
            local now = U.now()
            local players = U.count_players()
            if players > 0 or pending_result_data ~= nil or last_ack_data ~= nil or now >= http_next_exchange_at then
                send_http_exchange()
            end
        end
    end)
    step("读设置", poll_settings)
    step("读权威租约", poll_authority)
    step("看权威租约", poll_lease)
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

client_set_paused = function(want)
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
    -- 客户端的快捷键：F8 让内置 AI 开始/停下，F7 只开关小窗
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
