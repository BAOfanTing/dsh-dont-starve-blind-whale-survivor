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
-- 阿比盖尔"防御/跟随"能覆盖的距离（世界单位）。
-- ★ 依据 .runtime/dst-scripts/scripts/prefabs/abigail.lua:97-105,125-158：
--   原版 DefensiveRetarget 只在 `inst:GetDistanceSqToInst(player) < ABIGAIL_DEFENSIVE_MAX_FOLLOW^2`
--   时接战（tuning.lua:4822 = 5 世界单位 ≈ 1.25 格），且目标必须距**玩家**小于
--   ABIGAIL_COMBAT_TARGET_DISTANCE(=15 世界单位 ≈ 3.75 格)。
--   跟随时会有滞后 / 被怪挤开，所以"可协助"判定留 2 倍容差（超过 2 倍基本接不上战）。
local ASSIST_FOLLOW = (type(TUNING.ABIGAIL_DEFENSIVE_MAX_FOLLOW) == "number"
    and TUNING.ABIGAIL_DEFENSIVE_MAX_FOLLOW > 0) and TUNING.ABIGAIL_DEFENSIVE_MAX_FOLLOW or 5
local ASSIST_MAX_DIST = ASSIST_FOLLOW * 2

--- 阿比盖尔状态。字段：present/alive/valid/distance/health_percent/current_target/
--- is_following/is_attacking/is_busy/can_assist/can_summon/has_flower/bond_level/unknown。无法可靠读取时 unknown=true。
function C.GetCompanionState(player)
    local st = {}
    for k, v in pairs(C.EMPTY_COMPANION) do st[k] = v end
    if player == nil or player.components == nil then return st end

    local gb = player.components.ghostlybond
    if gb == nil then return st end          -- 非伴生角色：保持 unknown（不假定有阿比盖尔）

    st.unknown = false

    -- 检查是否持有花朵及契约等级
    local inv = player.components.inventory
    local flower = nil
    if inv ~= nil and inv.FindItem ~= nil then
        flower = inv:FindItem(function(item) return item and item.prefab == "abigail_flower" end)
    end
    st.has_flower = (flower ~= nil)
    st.bond_level = (gb.bondlevel ~= nil) and gb.bondlevel or 1

    local is_summoned = true
    if gb.notsummoned == true or gb.summoned == false then
        is_summoned = false
    end
    local ghost = gb.ghost

    if ghost == nil or not is_summoned then
        st.present = false
        st.alive = false
        st.valid = false
        st.can_assist = false
        st.can_summon = (st.has_flower == true and (gb.notsummoned == true or gb.summoned ~= true))
        return st
    end

    local okv, valid = pcall(function() return ghost:IsValid() end)
    local inlimbo = false
    pcall(function() inlimbo = ghost:HasTag("INLIMBO") == true end)
    st.valid = (okv == true and valid == true) and not inlimbo
    if not st.valid then
        st.present = false
        st.alive = false
        st.can_assist = false
        st.can_summon = (st.has_flower == true and (gb.notsummoned == true or gb.summoned ~= true))
        return st
    end

    st.present = true
    st.guid = ghost.GUID
    local h = ghost.components ~= nil and ghost.components.health or nil
    if h ~= nil then
        local okd, dead = pcall(function() return h:IsDead() end)
        st.alive = (okd == true and dead == false)
        st.health_percent = C.util_comp_percent(h)
    else
        st.alive = true
        st.health_percent = 1.0
    end

    st.distance = world_dist(player, ghost)
    st.distance_tiles = (st.distance ~= nil) and (st.distance / 4) or nil
    st.defensive_range = ASSIST_MAX_DIST

    local c = ghost.components ~= nil and ghost.components.combat or nil
    if c ~= nil then
        local tgt = c.target
        st.is_attacking = (tgt ~= nil)
        st.current_target = (tgt ~= nil) and tostring(tgt.prefab or "target") or nil
        st.target_guid = (tgt ~= nil) and tgt.GUID or nil
    end

    st.is_following = (st.alive and st.valid)
    st.is_busy = st.is_attacking
    -- 阿比盖尔即使在战斗中也能协助（正在帮玩家输出/拉怪），只要存活、有效且在跟随范围内
    st.can_assist = (st.alive and st.valid) and (st.distance == nil or st.distance <= ASSIST_MAX_DIST)
    st.can_summon = false
    return st
end

--- 地上是否有一朵"没人拿着"的阿比盖尔之花（掉落回收用；与其他码头共用同一套判据）。
--- 返回 flower_ent 或 nil。
function C.FindDroppedFlower(player, radius_tiles)
    if player == nil or GLOBAL.TheSim == nil then return nil end
    local okp, px, _py, pz = pcall(function() return player.Transform:GetWorldPosition() end)
    if not okp or px == nil then return nil end
    local r = (radius_tiles or 16) * 4
    local ok, ents = pcall(function()
        return GLOBAL.TheSim:FindEntities(px, 0, pz, r, { "abigail_flower" })
    end)
    if not ok or ents == nil then return nil end
    local best, best_d = nil, nil
    for i = 1, #ents do
        local e = ents[i]
        if e ~= nil and e ~= player then
            local valid = false
            pcall(function() valid = e:IsValid() == true end)
            local c = e.components
            local owned = true
            if c ~= nil and c.inventoryitem ~= nil then
                pcall(function() owned = c.inventoryitem.owner ~= nil end)
            end
            local limbo = false
            pcall(function() limbo = e:HasTag("INLIMBO") == true end)
            if valid and not owned and not limbo then
                local d = world_dist(player, e)
                if d ~= nil and (best_d == nil or d < best_d) then best, best_d = e, d end
            end
        end
    end
    return best, best_d
end

C.ABIGAIL_ASSIST_MAX_DIST = ASSIST_MAX_DIST
C.ABIGAIL_ASSIST_FOLLOW = ASSIST_FOLLOW
