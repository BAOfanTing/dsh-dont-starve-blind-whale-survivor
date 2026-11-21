-- 阿比盖尔伴生状态（R8.2）——统一由这里识别，reflex/battle 不得各自重复查找。
-- 依据：wendy 玩家 components.ghostlybond.ghost（prefab "abigail"），等级决定血量。
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall or pcall
local type = type
Whale = Whale or {}
local C = Whale.character

local function world_dist(a, b)
    if a == nil or b == nil or a.Transform == nil or b.Transform == nil then return nil end
    local ok1, ax, _ay, az = pcall(function() return a.Transform:GetWorldPosition() end)
    local ok2, bx, _by, bz = pcall(function() return b.Transform:GetWorldPosition() end)
    if not ok1 or not ok2 or ax == nil or bx == nil then return nil end
    local dx, dz = ax - bx, az - bz
    return math.sqrt(dx * dx + dz * dz)
end

local TUNING = GLOBAL.TUNING or {}
-- 阿比盖尔"防御/跟随"能覆盖的距离（世界单位）；有 TUNING 用真实值，否则保守 20 格
local ASSIST_MAX_DIST = (type(TUNING.ABIGAIL_DEFENSIVE_MAX_FOLLOW) == "number"
    and TUNING.ABIGAIL_DEFENSIVE_MAX_FOLLOW * 4) or (20 * 4)

--- 阿比盖尔状态。字段：present/alive/valid/distance/health_percent/current_target/
--- is_following/is_attacking/is_busy/can_assist/unknown。无法可靠读取时 unknown=true。
function C.GetCompanionState(player)
    local st = {}
    for k, v in pairs(C.EMPTY_COMPANION) do st[k] = v end
    if player == nil or player.components == nil then return st end

    local gb = player.components.ghostlybond
    if gb == nil then return st end          -- 非伴生角色：保持 unknown（不假定有阿比盖尔）

    st.unknown = false
    local ghost = gb.ghost
    if ghost == nil then st.present = false; return st end

    st.present = true
    local okv, valid = pcall(function() return ghost:IsValid() end)
    local inlimbo = false
    pcall(function() inlimbo = ghost:HasTag("INLIMBO") == true end)
    st.valid = (okv == true and valid == true) and not inlimbo

    local h = ghost.components ~= nil and ghost.components.health or nil
    if h ~= nil then
        local okd, dead = pcall(function() return h:IsDead() end)
        st.alive = (okd == true and dead == false)
        st.health_percent = C.util_comp_percent(h)
    end

    st.distance = world_dist(player, ghost)

    local c = ghost.components ~= nil and ghost.components.combat or nil
    if c ~= nil then
        local tgt = c.target
        st.is_attacking = (tgt ~= nil)
        st.current_target = (tgt ~= nil) and tostring(tgt.prefab or "target") or nil
    end

    st.is_following = (st.alive and st.valid)
    st.is_busy = st.is_attacking
    st.can_assist = (st.alive and st.valid) and (st.distance == nil or st.distance <= ASSIST_MAX_DIST)
    return st
end

C.ABIGAIL_ASSIST_MAX_DIST = ASSIST_MAX_DIST
