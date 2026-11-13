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

--- 每次动作前都重新读（不缓存）：文件不存在/损坏 → 拒绝一切动作
function G.read_authority()
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
}

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

    -- 组件
    local provider = Whale ~= nil and Whale.actor or nil
    local actor = nil
    if provider ~= nil and provider.get_actor ~= nil then
        local ok_get, got = pcall(provider.get_actor)
        if ok_get then actor = got end
    end
    local ok_comp, why_comp = actor_has_components(actor, spec.required_components)
    if not ok_comp then return false, why_comp, nil end

    -- 通过：记世代 + 记 id（注意：记 id 在真正接受时才做，见 accept）
    return true, nil, { action = action, spec = spec, actor = actor, status = status }
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
