-- M2.0：动作安全底座（Lua 侧最终授权者）
--
-- 为什么要有它：Node 侧再严也只是"建议"——真正碰游戏 API 的是这里。
-- 所有从文件桥进来的动作，必须先过这一层，才允许交给 Whale.actions。
--
-- 它负责四件事：
--   1. 角色可控制性（观察可以用兜底实体，**执行绝对不行**）
--   2. 命令信封校验（protocol / command_id / 过期 / 白名单）
--   3. 租约与 generation fencing（旧世代命令一律拒绝）
--   4. 目标引用 #N 的严格解析（只认当前运行实例/会话/分片/角色的那份快照）
--
-- 设计原则：**宁可拒绝，不可执行**。拿不准就返回拒绝原因，绝不"找个像的替代"。
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local type = type

local os = GLOBAL.os or { time = function() return 0 end }
local io = GLOBAL.io
local U = Whale.util
local G = {}

G.LEASE_SCHEMA = "bws.control-lease/1"

--- M2.0.2：Lua 只读权威租约文件（Node LeaseManager 是唯一写入者）。
--- 两个文件名都试：io 通道（游戏工作目录）和持久化通道名；都带/不带 KLEI 头都能解析。
local function io_read(name)
    if io == nil or io.open == nil then return nil end
    local ok, file = pcall(io.open, name, "r")
    if not ok or file == nil then return nil end
    local content = nil
    pcall(function() content = file:read("*a"); file:close() end)
    return content
end

--- 解析一份权威租约文本；任何结构缺失都判不可用（fail-closed）
local function parse_authority(text)
    if type(text) ~= "string" or text == "" then return nil, "authority_unavailable" end
    local ok, data = pcall(Whale.json.decode, U.strip_header(text))
    if not ok or type(data) ~= "table" then return nil, "authority_corrupt" end
    if data.schema ~= G.LEASE_SCHEMA then return nil, "authority_schema_mismatch" end
    if type(data.authority_epoch) ~= "string" or data.authority_epoch == "" then return nil, "authority_corrupt" end
    if type(data.generation) ~= "number" or data.generation < 0 or data.generation ~= math.floor(data.generation) then
        return nil, "authority_corrupt"
    end
    if type(data.lease_id) ~= "string" or data.lease_id == "" then return nil, "authority_corrupt" end
    if type(data.owner_type) ~= "string" or data.owner_type == "" then return nil, "authority_corrupt" end
    if type(data.owner_instance_id) ~= "string" or data.owner_instance_id == "" then return nil, "authority_corrupt" end
    if type(data.expires_at) ~= "number" then return nil, "authority_corrupt" end
    if type(data.runtime_id) ~= "string" or type(data.session_id) ~= "string"
        or type(data.shard_id) ~= "string" or type(data.actor_id) ~= "string" then
        return nil, "authority_corrupt"
    end
    if data.status ~= "active" and data.status ~= "revoking" and data.status ~= "released" and data.status ~= "expired" then
        return nil, "authority_corrupt"
    end
    return data, nil
end

--- 暴露给 bridge.lua 的 poll_authority 用（同一个严格解析器，不给第二套标准）
G.parse_authority = parse_authority

--- 权威租约缓存由 bridge.lua 每个 tick 通过 TheSim:GetPersistentString 刷新。
--- 为什么不用 io.open：DST 模组沙箱里 GLOBAL.io == nil（真机已验证：Lua 从不写
--- whale_io_state.json / whale_io_result.json），只有持久化字符串通道是双向可用的。
--- 缓存必须"新鲜"：超过 5 秒没刷新就判不可用（fail-closed），绝不拿旧权威放行。
G.AUTHORITY_CACHE_MAX_AGE = 5

function cached_authority()
    local cache = Whale ~= nil and Whale.authority_cache or nil
    if cache == nil or type(cache.data) ~= "table" then return nil end
    local age = os.time() - (cache.at or 0)
    if age < 0 then age = 0 end
    if age > G.AUTHORITY_CACHE_MAX_AGE then return nil end
    return cache.data, nil
end

--- 每次动作前都重新读：优先 ps 缓存，其次 io（沙箱测试用）；都拿不到 → 拒绝一切动作
function G.read_authority()
    local from_cache = cached_authority()
    if from_cache ~= nil then return from_cache, nil end
    local files = Whale ~= nil and Whale.files or {}
    local names = { "whale_io_lease.json", "whale_lease.json" }
    if files.io_lease ~= nil then names[1] = files.io_lease end
    if files.lease ~= nil then names[2] = files.lease end
    local first_err = "authority_unavailable"
    for _, name in ipairs(names) do
        local text = io_read(name)
        if text ~= nil and text ~= "" then
            local a, err = parse_authority(text)
            if a ~= nil then return a, nil end
            first_err = err or first_err
        end
    end
    return nil, first_err
end

--- 墙钟毫秒（和 Node 的 Date.now() 同一坐标系；命令的 created_at / expires_at 都用它）
local function now_ms()
    local ok, value = pcall(os.time)
    if ok and tonumber(value) ~= nil then return tonumber(value) * 1000.0 end
    return 0
end

G.PROTOCOL_VERSION = 1

--- 诊断用：当前墙钟毫秒（和命令里的 created_at/expires_at 同一坐标系）
function G.clock_ms()
    return now_ms()
end

-- ─────────────────────────── 白名单（M2.0 只开 R1 的移动/停止）───────────────────────────

--- 每个动作：风险等级 + 参数规则 + 需要的组件
--- 规则里 key 就是允许出现的参数名（未知字段一律拒绝）
G.ACTIONS = {
    move_to = {
        risk = "R1",
        required_components = { "locomotor", "health" },
        args = {
            x = { type = "number", min = -2000, max = 2000, integer = true, required = true },
            z = { type = "number", min = -2000, max = 2000, integer = true, required = true },
            timeout = { type = "number", min = 2, max = 120 },
        },
    },
    stop = {
        risk = "R1",
        required_components = { "locomotor" },
        args = {},
    },
    -- M2.1：按 #N 引用拾取地面普通资源（不准传 prefab、不准传坐标）
    pickup = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            target_ref = { type = "string", pattern = "^#%d+$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
        },
    },
    -- M2.3：按 #N 收获**已成熟**的试点对象（本阶段只有普通浆果丛）。
    -- 底层原生动作是 ACTIONS.PICK（不是 ACTIONS.HARVEST —— 那是 crop/harvestable 那一类）。
    harvest = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            target_ref = { type = "string", pattern = "^#%d+$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
        },
    },
    -- ═══════════════ SURVIVAL-01：四个基础生存动作 ═══════════════
    -- gather：按 #N 采集草丛/树苗（白名单在 Whale.gatherrules）
    gather = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            target_ref = { type = "string", pattern = "^#%d+$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
        },
    },
    -- eat：吃背包里的白名单食物。food 可选（不填 = 服务端挑最该吃的）
    eat = {
        risk = "R1",
        required_components = { "health", "hunger", "inventory" },
        args = {
            food = { type = "string", pattern = "^[a-z_]+$", max_len = 32 },
        },
    },
    -- craft：只做白名单里的 3 个工具。recipe 必填且必须是白名单里的名字
    craft = {
        risk = "R2",
        required_components = { "builder", "inventory" },
        args = {
            recipe = { type = "string", pattern = "^[a-z_]+$", max_len = 32, required = true },
        },
    },
    -- equip：只装备白名单里的手持物品。item 必填
    equip = {
        risk = "R1",
        required_components = { "inventory" },
        args = {
            item = { type = "string", pattern = "^[a-z_]+$", max_len = 32, required = true },
        },
    },
    -- ═══════════ SURVIVAL-02 ═══════════
    -- gather_area：范围采集（白名单由 gatherrules/harvestrules 决定，模型只能给"只采哪种"+范围+上限）
    gather_area = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            prefab = { type = "string", pattern = "^[a-z_]+$", max_len = 32 },
            radius = { type = "number", min = 2, max = 40 },
            limit = { type = "number", min = 1, max = 30, integer = true },
        },
    },
    -- seek：走出去找东西。只**报位置**，不自动采（让模型决定下一步）
    seek = {
        risk = "R2",
        required_components = { "locomotor", "health" },
        args = {
            prefab = { type = "string", pattern = "^[a-z_]+$", max_len = 32, required = true },
            step = { type = "number", min = 4, max = 30 },
            max_tiles = { type = "number", min = 4, max = 80 },
            look = { type = "number", min = 8, max = 40 },
        },
    },
    -- ═══════════ SURVIVAL-03：批量开放的常用动作 ═══════════
    -- chop / mine / dig / hammer：对目标用 workable 动作（都要 #N 引用）
    chop = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            target_ref = { type = "string", pattern = "^#%d+$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
        },
    },
    mine = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            target_ref = { type = "string", pattern = "^#%d+$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
        },
    },
    dig = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            target_ref = { type = "string", pattern = "^#%d+$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
        },
    },
    hammer = {
        risk = "R2",
        required_components = { "locomotor", "health", "inventory" },
        args = {
            target_ref = { type = "string", pattern = "^#%d+$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
        },
    },
    -- attack / kill：对目标重复 ATTACK（kill 打到死）
    attack = {
        risk = "R2",
        required_components = { "locomotor", "health" },
        args = {
            target_ref = { type = "string", pattern = "^#%d+$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            times = { type = "number", min = 1, max = 50, integer = true },
        },
    },
    kill = {
        risk = "R2",
        required_components = { "locomotor", "health" },
        args = {
            target_ref = { type = "string", pattern = "^#%d+$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
        },
    },
    -- wait / drop
    wait = {
        risk = "R1",
        required_components = {},
        args = {
            seconds = { type = "number", min = 1, max = 30 },
        },
    },
    drop = {
        risk = "R1",
        required_components = { "inventory" },
        args = {
            item = { type = "string", pattern = "^[a-z_]+$", max_len = 32, required = true },
        },
    },
    -- ═══════════ SURVIVAL-04：第二批 ═══════════
    unequip = {
        risk = "R1",
        required_components = { "inventory" },
        args = {
            slot = { type = "string", pattern = "^[a-z_]+$", max_len = 16 },
        },
    },
    say = {
        risk = "R1",
        required_components = {},
        args = {
            text = { type = "string", max_len = 120, required = true },
        },
    },
    fuel = {
        risk = "R1",
        required_components = { "inventory" },
        args = {
            target_ref = { type = "string", pattern = "^#%d+$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            item = { type = "string", pattern = "^[a-z_]+$", max_len = 32 },
        },
    },
    use = {
        risk = "R2",
        required_components = { "locomotor" },
        args = {
            target_ref = { type = "string", pattern = "^#%d+$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            action = { type = "string", pattern = "^[A-Z_]+$", max_len = 16 },
        },
    },
    inspect = {
        risk = "R1",
        required_components = {},
        args = {
            target_ref = { type = "string", pattern = "^#%d+$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
        },
    },
    -- ═══════════ SURVIVAL-05：容器 / 给予 / 烹饪 ═══════════
    container_take = {
        risk = "R2",
        required_components = { "locomotor", "inventory" },
        args = {
            target_ref = { type = "string", pattern = "^#%d+$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            item = { type = "string", pattern = "^[a-z_]+$", max_len = 32 },
            count = { type = "number", min = 1, max = 40, integer = true },
        },
    },
    container_put = {
        risk = "R2",
        required_components = { "locomotor", "inventory" },
        args = {
            target_ref = { type = "string", pattern = "^#%d+$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            item = { type = "string", pattern = "^[a-z_]+$", max_len = 32, required = true },
        },
    },
    give = {
        risk = "R2",
        required_components = { "locomotor", "inventory" },
        args = {
            target_ref = { type = "string", pattern = "^#%d+$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            item = { type = "string", pattern = "^[a-z_]+$", max_len = 32, required = true },
        },
    },
    cook = {
        risk = "R2",
        required_components = { "locomotor", "inventory" },
        args = {
            target_ref = { type = "string", pattern = "^#%d+$", max_len = 8, required = true },
            snapshot_id = { type = "string", max_len = 64, required = true },
            items = { type = "string", max_len = 120 },
        },
    },
}

--- 拾取白名单：**唯一来源**在 Whale.pickuprules（M2.2 起观察侧与执行侧共用）。
--- 这里只是别名，方便诊断；pickuprules 缺失时是空表 —— 也就是什么都不放行（失败要安全）。
G.PICKUP_PREFABS = (Whale ~= nil and Whale.pickuprules ~= nil) and Whale.pickuprules.PREFABS or {}

--- M2.1 保守拾取距离（格）。DST 服务端 ACTIONS.PICKUP.fn 本身不校验距离，
--- 所以必须由我们限制，避免模型隔空捡 16 格外的物品。
G.PICKUP_MAX_TILES = 2.5

function G.is_action_allowed(name)
    return type(name) == "string" and G.ACTIONS[name] ~= nil
end

function G.actions_whitelist()
    local list = {}
    for name in pairs(G.ACTIONS) do list[#list + 1] = name end
    table.sort(list)
    return list
end

-- ─────────────────────────── 当前环境 ───────────────────────────

local function identity()
    local provider = Whale ~= nil and Whale.actor or nil
    if provider == nil or provider.get_identity == nil then return {} end
    local ok, got = pcall(provider.get_identity, U.now())
    if ok and type(got) == "table" then return got end
    return {}
end

local function runtime_id()
    local nearby = Whale ~= nil and Whale.nearby or nil
    if nearby ~= nil and nearby.runtime_id ~= nil then
        local ok, got = pcall(nearby.runtime_id)
        if ok then return got end
    end
    return nil
end

-- ─────────────────────────── 角色可控制性（严格版）───────────────────────────

--- 观察对象可能是"任意有效实体"（Actor Provider 的兜底），但执行必须严格：
--- 必须是真玩家、活着、不是灵魂、组件齐全、世界由本机权威模拟。
function G.actor_status()
    local provider = Whale ~= nil and Whale.actor or nil
    local status = {
        actor_id = nil, valid = false, is_player = false, alive = false, is_ghost = false,
        can_control = false, reason = nil,
    }

    if provider == nil or provider.get_actor == nil then
        status.reason = "actor_provider_missing"
        return status
    end

    local ok, actor, why = pcall(provider.get_actor)
    if not ok or actor == nil then
        status.reason = "no_actor_" .. tostring(why or "unknown")
        return status
    end

    local ok2, info = pcall(provider.get_actor_info, actor)
    if not ok2 or info == nil then
        status.reason = "actor_invalid"
        return status
    end

    status.actor_id = info.actor_id
    status.valid = info.valid == true
    status.is_player = info.actor_type == "player"
    status.alive = info.alive == true
    status.is_ghost = info.is_ghost == true

    if not status.valid then status.reason = "actor_invalid" return status end
    if status.is_ghost then status.reason = "actor_is_ghost" return status end
    if not status.is_player then status.reason = "actor_not_player" return status end
    if not status.alive then status.reason = "actor_dead" return status end

    -- 世界就绪 + 本机是权威模拟端（服务端）
    local world = GLOBAL.TheWorld
    if world == nil then status.reason = "world_not_ready" return status end
    local ok3, master = pcall(function() return world.ismastersim end)
    if not ok3 or master ~= true then status.reason = "not_authoritative" return status end

    status.can_control = true
    return status
end

local function actor_has_components(actor, names)
    if actor == nil or actor.components == nil then return false, "missing_component" end
    for _, name in ipairs(names or {}) do
        if actor.components[name] == nil then return false, "missing_component:" .. name end
    end
    return true, nil
end

-- ─────────────────────────── 参数校验 ───────────────────────────

local function check_value(rule, name, value)
    if value == nil then
        if rule.required then return false, "missing_arg:" .. name end
        return true, nil
    end
    if rule.type == "number" then
        if type(value) ~= "number" then return false, "bad_type:" .. name end
        if value ~= value then return false, "nan:" .. name end
        if value == math.huge or value == -math.huge then return false, "infinite:" .. name end
        if rule.integer and math.floor(value) ~= value then return false, "not_integer:" .. name end
        if rule.min ~= nil and value < rule.min then return false, "out_of_range:" .. name end
        if rule.max ~= nil and value > rule.max then return false, "out_of_range:" .. name end
    elseif rule.type == "string" then
        if type(value) ~= "string" then return false, "bad_type:" .. name end
        if value == "" then return false, "empty_string:" .. name end
        if rule.max_len ~= nil and #value > rule.max_len then return false, "too_long:" .. name end
        if rule.pattern ~= nil and string.match(value, rule.pattern) == nil then
            return false, "bad_format:" .. name
        end
    end
    return true, nil
end

local function validate_args(spec, args)
    if type(args) ~= "table" then return false, "bad_args" end
    -- 未知字段一律拒绝（防止模型塞别的参数进游戏）
    for key in pairs(args) do
        if spec.args[key] == nil then return false, "unknown_arg:" .. tostring(key) end
    end
    for name, rule in pairs(spec.args) do
        local ok, why = check_value(rule, name, args[name])
        if not ok then return false, why end
    end
    return true, nil
end

-- ─────────────────────────── 租约 / generation fencing ───────────────────────────

--- M2.0.2：Lua **不再**自行决定 generation。这里只保留诊断信息，绝不用于放行。
--- 权威 generation 只在 Node LeaseManager 的权威租约文件里。
local lease_state = { generation = 0, owner = nil, actor_id = nil, updated = 0 }

function G.lease_state()
    return lease_state
end

function G.reset()
    lease_state = { generation = 0, owner = nil, actor_id = nil, updated = 0 }
end

-- ─────────────────────────── 命令校验（对外唯一入口）───────────────────────────

-- 近期处理过的 command_id（环形，防重复执行；比原来的"只记最后一个"可靠）
local RECENT_MAX = 32
local recent_ids = {}
local recent_head = 0

local function seen_id(id)
    for i = 1, #recent_ids do
        if recent_ids[i] == id then return true end
    end
    return false
end

local function remember_id(id)
    recent_head = recent_head % RECENT_MAX + 1
    recent_ids[recent_head] = id
end

function G.forget_ids()
    recent_ids = {}
    recent_head = 0
end

--- 校验一条命令。
--- @return ok(boolean), reason_code(string|nil), detail(table|nil)
function G.validate(cmd)
    if type(cmd) ~= "table" then return false, "bad_command", nil end

    -- ★ M2.0.2：权威租约是唯一可信来源；读不到/损坏/不完整 → 一律 fail-closed
    local authority, why_auth = G.read_authority()
    if authority == nil then return false, why_auth or "authority_unavailable", nil end
    if authority.status == "revoking" then
        -- 观察换手：安全停掉旧动作并写确认（确认由 bridge.lua 提供，复用既有 A.Abort）
        pcall(function()
            if Whale ~= nil and Whale.bridge ~= nil and Whale.bridge.WriteLeaseAck ~= nil then
                Whale.bridge.WriteLeaseAck(authority)
            end
        end)
        return false, "authority_revoking", nil
    end
    if authority.status ~= "active" then return false, "stale_lease", nil end
    if authority.expires_at <= now_ms() then return false, "lease_expired", nil end

    local version = tonumber(cmd.protocol_version)
    if version ~= G.PROTOCOL_VERSION then return false, "bad_protocol", nil end

    local id = cmd.command_id ~= nil and tostring(cmd.command_id) or nil
    if id == nil or id == "" then return false, "missing_command_id", nil end
    if seen_id(id) then return false, "duplicate_command", nil end

    local action = cmd.action
    local spec = type(action) == "string" and G.ACTIONS[action] or nil
    if spec == nil then return false, "action_not_allowed", nil end

    -- 过期（墙钟毫秒；和 Node 的 Date.now() 对齐）
    local now = now_ms()
    local expires = tonumber(cmd.expires_at)
    if expires == nil then return false, "missing_expiry", nil end
    if expires <= now then return false, "command_expired", nil end

    -- 运行实例 / 会话 / 分片 / 角色
    local rt = runtime_id()
    if rt == nil then return false, "runtime_unknown", nil end
    if cmd.runtime_id ~= nil and tostring(cmd.runtime_id) ~= rt then
        return false, "runtime_mismatch", nil
    end

    local ident = identity()
    if cmd.session_id ~= nil and ident.session_id ~= nil
        and tostring(cmd.session_id) ~= tostring(ident.session_id) then
        return false, "session_mismatch", nil
    end
    if cmd.shard_id ~= nil and ident.shard_id ~= nil
        and tostring(cmd.shard_id) ~= tostring(ident.shard_id) then
        return false, "shard_mismatch", nil
    end

    -- 角色
    local status = G.actor_status()
    if not status.can_control then
        return false, status.reason or "actor_not_controllable", nil
    end
    if cmd.actor_id ~= nil and status.actor_id ~= nil
        and tostring(cmd.actor_id) ~= tostring(status.actor_id) then
        return false, "actor_mismatch", nil
    end

    -- ★ M2.0.2：所有身份字段都必须与**权威文件**精确相等；不信任命令自己声明的身份
    if tostring(cmd.authority_epoch or "") ~= authority.authority_epoch then
        return false, "authority_epoch_mismatch", nil
    end
    -- generation 先判：换手后旧命令必须明确报 stale_generation（而不是先撞 lease_id）
    if tostring(cmd.lease_generation or "") ~= tostring(authority.generation) then
        local gen = tonumber(cmd.lease_generation)
        if gen == nil then return false, "missing_generation", nil end
        if gen ~= math.floor(gen) then return false, "bad_generation", nil end
        if gen > authority.generation then return false, "future_generation", nil end
        return false, "stale_generation", nil
    end
    if tostring(cmd.lease_id or "") ~= authority.lease_id then return false, "stale_lease", nil end
    if tostring(cmd.owner_type or "") ~= authority.owner_type then return false, "wrong_owner", nil end
    if tostring(cmd.owner_instance_id or "") ~= authority.owner_instance_id then return false, "wrong_instance", nil end
    local lease_expires = tonumber(cmd.lease_expires_at)
    if lease_expires ~= nil and lease_expires <= now then return false, "lease_expired", nil end
    local created = tonumber(cmd.created_at)
    if created ~= nil and now > 0 and created > now + 300000 then return false, "clock_skew", nil end

    -- 参数
    local ok_args, why = validate_args(spec, type(cmd.args) == "table" and cmd.args or {})
    if not ok_args then return false, why, nil end

    local provider = Whale ~= nil and Whale.actor or nil
    local actor = nil
    if provider ~= nil and provider.get_actor ~= nil then
        local ok_get, got = pcall(provider.get_actor)
        if ok_get then actor = got end
    end

    -- ★ M2.1：pickup 必须把 #N 解析成**真实实体**（禁止 prefab 搜索），并做前置校验
    local target = nil
    if action == "pickup" then
        -- 一个 Actor 同时只允许一个动作（pickup 不做静默替换）
        if Whale.job ~= nil then return false, "actor_busy", nil end

        local snapshot_id = tostring(cmd.args.snapshot_id)
        local ref = tostring(cmd.args.target_ref)
        local ent, why_t = G.resolve_target(snapshot_id, ref, {})
        if ent == nil then return false, why_t or "unknown_ref", nil end

        -- ★ M2.2：候选判定与观察侧（nearby 的 pickupables 桶）**共用同一份规则**，
        --   避免"Observer 说能捡、执行器说不行"。这里只判候选资格；
        --   执行期条件（距离 / 背包容量 / 角色状态 / 租约）仍然在下面各自判。
        local rules = Whale ~= nil and Whale.pickuprules or nil
        if rules == nil then return false, "pickup_rules_missing", nil end
        local ok_cand, why_cand = rules.IsCandidate(ent, actor)
        if not ok_cand then return false, why_cand or "target_not_pickable", nil end

        -- 背包能否接收（用原生 Inventory:CanAcceptCount，别自己拼堆叠逻辑）
        local inv = actor ~= nil and actor.components ~= nil and actor.components.inventory or nil
        if inv == nil then return false, "missing_component:inventory", nil end
        local ok_acc, can = pcall(function() return inv:CanAcceptCount(ent, 1) end)
        if ok_acc and type(can) == "number" and can <= 0 then
            return false, "inventory_full", nil
        end

        -- 距离：只允许手边（不触发任何自动移动）
        local ax, _, az = U.pos(actor)
        local ex, _, ez = U.pos(ent)
        if ax == nil or ex == nil then return false, "target_not_pickable", nil end
        local dx, dz = ax - ex, az - ez
        local tiles = math.sqrt(dx * dx + dz * dz) / U.TILE
        if tiles > G.PICKUP_MAX_TILES then
            return false, "out_of_range", nil
        end
        target = ent
    end

    -- ★ M2.3：harvest 也要把 #N 解析成真实实体，并且**在授权的这一刻重新确认成熟度与距离**
    --   （观察结果可能已经过期：别人先采了、或者快照之后状态变了）
    if action == "harvest" then
        if Whale.job ~= nil then return false, "actor_busy", nil end

        local snapshot_id = tostring(cmd.args.snapshot_id)
        local ref = tostring(cmd.args.target_ref)
        local ent, why_t = G.resolve_target(snapshot_id, ref, {})
        if ent == nil then return false, why_t or "unknown_ref", nil end

        local hr = Whale ~= nil and Whale.harvestrules or nil
        if hr == nil then return false, "harvest_rules_missing", nil end

        -- 候选资格：与观察侧同一份规则（杜绝"观察说能采、执行说不行"）
        local ok_cand, why_cand = hr.IsCandidate(ent, actor)
        if not ok_cand then return false, why_cand or "target_not_harvestable", nil end

        -- ★ 成熟度必须在执行前重新判：Candidate != Ready
        local ok_ready, why_ready = hr.IsReady(ent)
        if not ok_ready then return false, why_ready or "not_ready", nil end

        -- ★ 距离照抄原生 PickRangeCheck：物理半径 + 4（世界单位）。服务端原生不校验，必须我们限。
        local in_range = hr.InNativeRange(actor, ent)
        if not in_range then return false, "out_of_range", nil end

        target = ent
    end

    -- ═══════════════ SURVIVAL-01 ═══════════════
    if action == "gather" then
        if Whale.job ~= nil then return false, "actor_busy", nil end

        local snapshot_id = tostring(cmd.args.snapshot_id)
        local ref = tostring(cmd.args.target_ref)
        local ent, why_t = G.resolve_target(snapshot_id, ref, {})
        if ent == nil then return false, why_t or "unknown_ref", nil end

        local gr = Whale ~= nil and Whale.gatherrules or nil
        if gr == nil then return false, "gather_rules_missing", nil end

        -- 候选资格：与观察侧同一份白名单（草丛/树苗）
        local ok_cand, why_cand = gr.IsCandidate(ent, actor)
        if not ok_cand then return false, why_cand or "target_not_gatherable", nil end

        -- ★ 授权那一刻重新判成熟度（采空的不许再采）
        local ok_ready, why_ready = gr.IsReady(ent)
        if not ok_ready then return false, why_ready or "not_ready", nil end

        -- ★ 距离照抄原生 PickRangeCheck
        if not gr.InNativeRange(actor, ent) then return false, "out_of_range", nil end

        target = ent
    end

    if action == "eat" then
        if Whale.job ~= nil then return false, "actor_busy", nil end
        local er = Whale ~= nil and Whale.eatrules or nil
        if er == nil then return false, "eat_rules_missing", nil end

        local inv = actor ~= nil and actor.components ~= nil and actor.components.inventory or nil
        if inv == nil then return false, "missing_component:inventory", nil end

        -- 模型可以指定"吃哪一类"，但必须是白名单里的
        local food = cmd.args.food
        if food ~= nil and food ~= "" then
            local ok_f, why_f = er.IsAllowedPrefab(tostring(food))
            if not ok_f then return false, why_f or "food_not_allowed", nil end
            -- 必须真的在背包里
            local found = false
            pcall(function()
                inv:ForEachItem(function(it)
                    if found then return end
                    if it ~= nil and it:IsValid() and tostring(it.prefab) == tostring(food) then found = true end
                end)
            end)
            if not found then return false, "not_in_inventory", nil end
        else
            -- 不指定就让服务端挑；挑不出来直接拒（不要空跑一次动作）
            if er.PickBest(inv) == nil then return false, "no_food", nil end
        end

        -- 饥饿满了就别吃（避免浪费食物，也避免"吃了没效果"被误报成功）
        local hunger = actor.components.hunger
        local ok_pct, pct = pcall(function() return hunger:GetPercent() end)
        if ok_pct and type(pct) == "number" and pct >= 0.99 then
            return false, "not_hungry", nil
        end
    end

    if action == "craft" then
        if Whale.job ~= nil then return false, "actor_busy", nil end
        local cr = Whale ~= nil and Whale.craftrules or nil
        if cr == nil then return false, "craft_rules_missing", nil end

        local recipe = tostring(cmd.args.recipe)
        local ok_r, why_r = cr.IsAllowed(recipe)
        if not ok_r then return false, why_r or "recipe_not_allowed", nil end

        local builder = actor ~= nil and actor.components ~= nil and actor.components.builder or nil
        if builder == nil then return false, "missing_component:builder", nil end

        -- 材料不够就明确回 ingredients_missing（不要下发一条注定失败的命令）
        local missing = cr.MissingIngredients(actor, recipe)
        if missing ~= nil then
            if string.sub(missing, 1, 19) == "ingredients_missing" then
                return false, missing, nil
            end
            return false, missing, nil
        end
    end

    if action == "equip" then
        if Whale.job ~= nil then return false, "actor_busy", nil end
        local qr = Whale ~= nil and Whale.equiprules or nil
        if qr == nil then return false, "equip_rules_missing", nil end

        local item = tostring(cmd.args.item)
        local ok_i, why_i = qr.IsAllowedPrefab(item)
        if not ok_i then return false, why_i or "item_not_equippable", nil end

        local inv = actor ~= nil and actor.components ~= nil and actor.components.inventory or nil
        if inv == nil then return false, "missing_component:inventory", nil end
        if qr.FindInInventory(inv, item) == nil then return false, "not_in_inventory", nil end
    end

    -- ═══════════ SURVIVAL-05：container_* / give / cook 都要 #N 引用 ═══════════
    if action == "container_take" or action == "container_put" or action == "give" or action == "cook" then
        if Whale.job ~= nil then return false, "actor_busy", nil end
        local snapshot_id = tostring(cmd.args.snapshot_id)
        local ref = tostring(cmd.args.target_ref)
        local ent, why_t = G.resolve_target(snapshot_id, ref, {})
        if ent == nil then return false, why_t or "unknown_ref", nil end
        if action == "container_take" or action == "container_put" then
            if ent.components == nil or ent.components.container == nil then
                return false, "target_not_container", nil
            end
        end
        if action == "cook" then
            local has_stewer = ent.components ~= nil and ent.components.stewer ~= nil
            local has_container = ent.components ~= nil and ent.components.container ~= nil
            if not has_stewer and not has_container then
                return false, "target_not_cookpot", nil
            end
        end
        local d = U.dist(actor, ent)
        if d ~= nil and d > 4 * 4 then return false, "out_of_range", nil end
        target = ent
    end

    -- ═══════════ SURVIVAL-04：fuel / use / inspect 都要 #N 引用 ═══════════
    if action == "fuel" or action == "use" or action == "inspect" then
        if action ~= "inspect" and Whale.job ~= nil then return false, "actor_busy", nil end
        local snapshot_id = tostring(cmd.args.snapshot_id)
        local ref = tostring(cmd.args.target_ref)
        local ent, why_t = G.resolve_target(snapshot_id, ref, {})
        if ent == nil then return false, why_t or "unknown_ref", nil end
        if action == "fuel" then
            if ent.components == nil or ent.components.fueled == nil then
                return false, "target_not_fuelable", nil
            end
        end
        -- 距离：交互类不要太远（4 格内比较稳，比 workable 的 6 格更保守）
        local d = U.dist(actor, ent)
        if d ~= nil and d > 4 * 4 then return false, "out_of_range", nil end
        target = ent
    end

    -- ═══════════ SURVIVAL-03：chop / mine / dig / hammer / attack / kill ═══════════
    if action == "chop" or action == "mine" or action == "dig" or action == "hammer" then
        if Whale.job ~= nil then return false, "actor_busy", nil end
        local snapshot_id = tostring(cmd.args.snapshot_id)
        local ref = tostring(cmd.args.target_ref)
        local ent, why_t = G.resolve_target(snapshot_id, ref, {})
        if ent == nil then return false, why_t or "unknown_ref", nil end
        if ent.components == nil or ent.components.workable == nil then
            return false, "target_not_workable", nil
        end
        -- 距离：workable 动作靠引擎自己走过去，但太远（>6 格）先拒绝，避免"隔着半张地图砍树"
        local d = U.dist(actor, ent)
        if d ~= nil and d > 6 * 4 then return false, "out_of_range", nil end
        target = ent
    end

    if action == "attack" or action == "kill" then
        if Whale.job ~= nil then return false, "actor_busy", nil end
        local snapshot_id = tostring(cmd.args.snapshot_id)
        local ref = tostring(cmd.args.target_ref)
        local ent, why_t = G.resolve_target(snapshot_id, ref, {})
        if ent == nil then return false, why_t or "unknown_ref", nil end
        if ent.components == nil or ent.components.health == nil then
            return false, "target_not_attackable", nil
        end
        local d = U.dist(actor, ent)
        if d ~= nil and d > 6 * 4 then return false, "out_of_range", nil end
        target = ent
    end

    -- ═══════════ SURVIVAL-02 ═══════════
    if action == "gather_area" then
        if Whale.job ~= nil then return false, "actor_busy", nil end
        local gr = Whale ~= nil and Whale.gatherrules or nil
        local hr = Whale ~= nil and Whale.harvestrules or nil
        if gr == nil and hr == nil then return false, "gather_rules_missing", nil end
        -- 指定了 prefab 就要求它**在某一侧的白名单里**（不许让模型自由指定）
        local want = cmd.args.prefab
        if want ~= nil and want ~= "" then
            local w = tostring(want)
            local ok_g = gr ~= nil and gr.PREFABS[w] ~= nil
            local ok_h = hr ~= nil and hr.PREFABS[w] ~= nil
            if not ok_g and not ok_h then return false, "prefab_not_allowed", nil end
        end
        -- 至少得有一个可采的目标，否则不下发注定失败的命令
        local found = U.find_all(actor, tonumber(cmd.args.radius) or 12, nil, nil, function(e)
            if e == nil or e == actor or e.prefab == nil then return false end
            if want ~= nil and want ~= "" and tostring(e.prefab) ~= tostring(want) then return false end
            local is_g = gr ~= nil and gr.IsCandidate(e, actor)
            local is_h = (not is_g) and hr ~= nil and hr.IsCandidate(e, actor)
            if not is_g and not is_h then return false end
            local rules = is_g and gr or hr
            local ready = rules.IsReady(e)
            return ready == true
        end)
        if found == nil or #found == 0 then return false, "no_targets_in_range", nil end
    end

    if action == "seek" then
        if Whale.job ~= nil then return false, "actor_busy", nil end
        -- seek 只是走路+看，不改世界；但要有 locomotor
        local loco = actor ~= nil and actor.components ~= nil and actor.components.locomotor or nil
        if loco == nil then return false, "missing_component:locomotor", nil end
    end

    -- 组件
    local ok_comp, why_comp = actor_has_components(actor, spec.required_components)
    if not ok_comp then return false, why_comp, nil end

    -- 通过：记世代 + 记 id（注意：记 id 在真正接受时才做，见 accept）
    return true, nil, {
        action = action, spec = spec, actor = actor, status = status, target = target,
        -- SURVIVAL-01：这四个动作走"白名单 + 服务端解析"的新路径
        survival_eat = (action == "eat") or nil,
        survival_craft = (action == "craft") or nil,
        survival_equip = (action == "equip") or nil,
        recipe = cmd ~= nil and cmd.args ~= nil and cmd.args.recipe or nil,
        item = cmd ~= nil and cmd.args ~= nil and cmd.args.item or nil,
        food = cmd ~= nil and cmd.args ~= nil and cmd.args.food or nil,
    }
end

--- 校验通过后调用：只记 command_id 去重 + 诊断信息。
--- ★ 绝不因为看见较大的数字就提升 generation（世代只由 Node LeaseManager 管理）
function G.accept(cmd)
    lease_state.owner = cmd.owner_type ~= nil and tostring(cmd.owner_type) or nil
    lease_state.actor_id = cmd.actor_id ~= nil and tostring(cmd.actor_id) or nil
    lease_state.updated = U.now()
    local id = cmd.command_id ~= nil and tostring(cmd.command_id) or nil
    if id ~= nil then remember_id(id) end
end

-- ─────────────────────────── 目标引用（给需要 #N 的动作用）───────────────────────────

--- 解析并校验一个 #N 目标（只认当前运行实例 / 会话 / 分片 / 角色 / 且类型匹配、距离可接受）
--- @param snapshot_id string 命令里携带的 nearby.snapshot_id
--- @param ref string 形如 "#3"
--- @param opts table|nil { category="resources", max_distance=20, actor=<entity> }
function G.resolve_target(snapshot_id, ref, opts)
    opts = opts or {}
    local nearby = Whale ~= nil and Whale.nearby or nil
    if nearby == nil or nearby.Resolve == nil then return nil, "nearby_unavailable" end
    if type(snapshot_id) ~= "string" or snapshot_id == "" then return nil, "missing_snapshot_id" end
    if type(ref) ~= "string" or string.sub(ref, 1, 1) ~= "#" then return nil, "bad_ref" end

    -- runtime 前缀 + 是否是当前扫描，N.Resolve 里已经校验（含 in_limbo / entity_gone）
    local ent, why = nearby.Resolve(snapshot_id, ref)
    if ent == nil then return nil, why or "unknown_ref" end

    -- 类型（分类）校验：从命令目标里拿不到分类，用当前快照的桶反查
    if opts.category ~= nil then
        local ok, info = pcall(nearby.DescribeRef, snapshot_id, ref)
        if not ok or info == nil then return nil, "target_not_compatible" end
        if info.category ~= opts.category then return nil, "wrong_category" end
        if opts.max_distance ~= nil and info.distance ~= nil and info.distance > opts.max_distance then
            return nil, "out_of_range"
        end
    end

    return ent, nil
end

Whale = Whale or {}
Whale.guard = G
