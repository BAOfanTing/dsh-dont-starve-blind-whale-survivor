-- 唯一观察对象入口（Actor Provider）
--
-- 只回答一个问题：**现在该观察哪个实体？**
--
-- 为什么要有这一层：以前到处直接读 `ThePlayer` / `GLOBAL.AllPlayers`（actions、observe、reflex、
-- bridge 各写一份挑人逻辑），于是「观察谁」这件事有 4 份实现、4 个口径。M1.1 起只有这里能回答，
-- 别的模块一律 `Whale.actor.get_actor()`。
--
-- 为什么现在还是"玩家角色"：M0 的结论是先用已经真机验证过的玩家角色，把闭环跑通；
-- 无主幸存者（SpawnPrefab("wilson")）要做成同一个接口的另一种实现（M2 的 spike），
-- 到时候只改这个文件里的 pick_actor()，观察器/动作/工具都不用动。
--
-- 身份字段的边界（必须写清楚，不然以后一定有人拿它当主键）：
--   · actor_id：有 userid 的玩家 → "player:<userid>"（跨会话稳定）；
--     没有 userid 的实体（将来那种无主身体）→ "entity:<prefab>:<GUID>"，并标 actor_id_kind="transient"
--     —— **GUID 只是这一次运行内的编号，不能当长期角色 ID**。
--   · session_id：TheNet:GetSessionIdentifier()，每次读档/新建世界都会变，用来区分"哪一次进世界"。
--   · cluster_id：TheNet:GetClusterID()（存在才取；取不到就显式标 unavailable，不编）。
--   · shard_id：TheShard:GetShardId()，Master / Caves 靠它区分。
local GLOBAL = GLOBAL
-- 饥荒的模组沙箱只给了 pairs/ipairs/print/math/table/type/string/tostring/require/Class，
-- pcall / tonumber / error / os / io 这些得从 GLOBAL（就是 _G）里拿，直接用会报 nil（0.1.0 就是这么崩的）。
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local type = type

local ACT = {}

--- 观察这个实体至少需要什么组件（缺了就不算"可用的观察对象"）
ACT.REQUIRED_COMPONENTS = { "health", "inventory" }
--- 有更好、没有就记进 unavailable_fields 的组件
ACT.OPTIONAL_COMPONENTS = { "hunger", "sanity", "temperature", "moisture" }

local identity_cache = nil
local identity_at = 0
local IDENTITY_TTL = 60

local function safe(fn, ...)
    local ok, value = pcall(fn, ...)
    if ok then return value end
    return nil
end

-- ─────────────────────────── 身份 ───────────────────────────

local function read_identity()
    local net = GLOBAL.TheNet
    local shard = GLOBAL.TheShard

    local session_id = net ~= nil and safe(function() return net:GetSessionIdentifier() end) or nil
    local shard_id = shard ~= nil and safe(function() return shard:GetShardId() end) or nil

    -- 集群 ID 在部分构建里没有；有就用，没有就明确标 unavailable（不拿 session 冒充）
    local cluster_id = nil
    local cluster_id_source = "unavailable"
    if net ~= nil and type(net.GetClusterID) == "function" then
        cluster_id = safe(function() return net:GetClusterID() end)
        if type(cluster_id) == "string" and cluster_id ~= "" then
            cluster_id_source = "the_net"
        else
            cluster_id = nil
        end
    end

    if type(session_id) ~= "string" or session_id == "" then session_id = nil end
    if type(shard_id) ~= "string" or shard_id == "" then shard_id = nil end

    return {
        session_id = session_id,
        cluster_id = cluster_id,
        cluster_id_source = cluster_id_source,
        shard_id = shard_id,
    }
end

--- 世界/会话身份（带 60 秒缓存：这些值在一次分片运行里不会变）
function ACT.get_identity(now)
    local t = tonumber(now) or 0
    if identity_cache == nil or (t - identity_at) >= IDENTITY_TTL then
        identity_cache = read_identity()
        identity_at = t
    end
    return identity_cache
end

-- ─────────────────────────── 挑人 ───────────────────────────

--- 在一个实体上检查组件是否齐
function ACT.missing_components(actor)
    local missing = {}
    if actor == nil or actor.components == nil then
        for _, name in ipairs(ACT.REQUIRED_COMPONENTS) do missing[#missing + 1] = name end
        return missing
    end
    for _, name in ipairs(ACT.REQUIRED_COMPONENTS) do
        if actor.components[name] == nil then missing[#missing + 1] = name end
    end
    return missing
end

--- 实体是否还能用来观察（死的也算"有效"：我们要把死了这件事告诉 AI）
function ACT.is_valid(actor)
    if actor == nil then return false, "missing" end
    if not actor:IsValid() then return false, "invalid" end
    if actor:HasTag("INLIMBO") then return false, "in_limbo" end
    if actor.Transform == nil then return false, "no_transform" end
    return true, nil
end

local function pick_actor()
    local players = GLOBAL.AllPlayers
    if players == nil then return nil, "world_not_ready" end

    local best = nil
    local fallback = nil
    for _, p in pairs(players) do
        local ok = ACT.is_valid(p)
        if ok then
            fallback = fallback or p
            -- 优先：真玩家（有 player 标签）且不是灵魂状态
            if p:HasTag("player") and not p:HasTag("playerghost") then
                if best == nil then
                    best = p
                elseif (p.userid or "") ~= "" and (best.userid or "") == "" then
                    -- 两个"活人"时，优先有 userid 的那个（房主/真客户端）
                    best = p
                end
            end
        end
    end

    if best ~= nil then return best, nil end
    if fallback ~= nil then return fallback, nil end
    return nil, "no_player"
end

--- 当前观察对象。返回 (actor, err)；没有就是 (nil, "reason")
function ACT.get_actor()
    local actor, why = pick_actor()
    if actor == nil then return nil, why or "no_actor" end
    return actor, nil
end

-- ─────────────────────────── 描述 ───────────────────────────

local function actor_id_of(actor)
    local userid = actor.userid
    if type(userid) == "string" and userid ~= "" then
        return "player:" .. userid, "stable"
    end
    local guid = actor.GUID
    local prefab = tostring(actor.prefab or "?")
    if guid ~= nil then
        return "entity:" .. prefab .. ":" .. tostring(guid), "transient"
    end
    return "entity:" .. prefab, "transient"
end

local function name_of(actor)
    local names = GLOBAL.STRINGS and GLOBAL.STRINGS.NAMES
    local key = actor.prefab and string.upper(actor.prefab) or nil
    if names ~= nil and key ~= nil and names[key] ~= nil then return names[key] end
    if type(actor.name) == "string" and actor.name ~= "" then return actor.name end
    return actor.prefab or "?"
end

--- 观察对象的完整描述（失败返回 nil, reason）
function ACT.get_actor_info(actor)
    local valid = ACT.is_valid(actor)
    if not valid then
        local _, why = ACT.is_valid(actor)
        return nil, why or "invalid"
    end

    local health = actor.components.health
    local is_ghost = actor:HasTag("playerghost") and true or false
    local alive = true
    if health ~= nil then
        local ok, dead = pcall(function() return health:IsDead() end)
        if ok then alive = not dead end
    end

    local x, y, z = nil, nil, nil
    local okp, px, py, pz = pcall(function() return actor.Transform:GetWorldPosition() end)
    if okp then x, y, z = px, py, pz end

    local actor_id, kind = actor_id_of(actor)
    local info = {
        actor_id = actor_id,
        actor_id_kind = kind,
        actor_type = is_ghost and "player_ghost" or (actor:HasTag("player") and "player" or "creature"),
        prefab = actor.prefab,
        name = name_of(actor),
        valid = true,
        alive = alive,
        is_ghost = is_ghost,
        missing_components = ACT.missing_components(actor),
        guid = actor.GUID,
        x = x,
        y = y,
        z = z,
    }
    if x ~= nil then
        info.tile_x = math.floor(x / 4)
        info.tile_z = math.floor(z / 4)
    end
    return info, nil
end

--- 测试用：清掉身份缓存
function ACT.reset()
    identity_cache = nil
    identity_at = 0
end

Whale = Whale or {}
Whale.actor = ACT
