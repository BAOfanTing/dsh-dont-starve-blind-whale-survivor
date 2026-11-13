-- M2.3：收获候选判定的**唯一来源**（观察侧 nearby 的 harvestables 桶 与 执行侧 guard 共用）。
--
-- 与 pickuprules 同样的理由：观察和执行各写一套规则，就会出现
-- "Observer 说可以收获、执行器却回 prefab_not_allowed" 的不一致。
--
-- 只做什么：
--   判断实体**是不是本阶段批准的收获对象**（IsCandidate），以及**现在成不成熟**（IsReady）。
-- 不做什么（这些属于"执行资格"，只能在真正执行时判）：
--   · Control Lease / 控制权 / 世代
--   · 角色能不能行动（活着、非 ghost、非忙碌）
--   · 背包容量
--   · 命令过期/重复
--   · 实际收获
--
-- 依据（本机 scripts.zip 实测，见 docs/M2_3_harvest_api_audit.md）：
--   · 成熟浆果丛走的是原生 ACTIONS.PICK（不是 ACTIONS.HARVEST —— 那是 crop/harvestable 那类）；
--   · componentactions.lua 的原生资格：HasTag("pickable") 且不带 fire/intense；
--   · ACTIONS.PICK.fn → components.pickable:Pick(doer)；
--   · 成熟判据：pickable:CanBePicked()（= canbepicked），并排除 stuck / barren / 不可交互；
--   · 原生距离：PickRangeCheck = distsq(x,z) <= (GetPhysicsRadius(0) + 4 + extrarange)^2，
--     服务端**不**校验 ⇒ 必须我们自己照抄这个公式限制。

local GLOBAL = GLOBAL
local H = {}

-- 沙箱约定：这些全局在模组沙箱里可能被收走，统一从 GLOBAL 取（与 nearby/guard/actions 一致）
local pcall = GLOBAL.pcall
local tostring = tostring
local type = type
local ipairs = ipairs

H.SCHEMA = "bws.harvestrules/1"

--- 本阶段批准的唯一试点类型：普通浆果丛。
--- berrybush 与 berrybush2 共用同一个 normal_postinit（SetUp("berries", ...)，未设 droppicked），
--- 语义完全一致，只是动画 bank 不同，所以按"同一种目标类型"一起放行。
--- 明确不放行：berrybush_juicy（droppicked + jostlepick，产物落地、距离规则不同）、
--- grass/sapling/reeds/carrot_planted/mushroom（另外的动作语义或 remove_when_picked）、
--- 农田 crop、harvestable 设施、树/岩石/冰/建筑/生物。
H.PREFABS = {
    berrybush = true,
    berrybush2 = true,
}

--- 每个试点对象的产物 prefab（来自 prefab 脚本的 pickable:SetUp(product, ...)）。
--- 仅用于结果核对，不用于"按 prefab 搜目标"。
H.PRODUCT = {
    berrybush = "berries",
    berrybush2 = "berries",
}

--- 原生 PickRangeCheck 里的固定加数（scripts/actions.lua:18）。
H.NATIVE_RANGE_BASE = 4

--- 读不到物理半径时的兜底距离（世界单位）。原生是 半径 + 4，兜底取 4（≈1 格，保守）。
H.FALLBACK_RANGE = 4

local function comp(ent, name)
    if ent == nil or ent.components == nil then return nil end
    return ent.components[name]
end

local function safe_call(fn, default)
    local ok, value = pcall(fn)
    if not ok then return default end
    return value
end

local function has_tag(ent, tag)
    if ent == nil then return false end
    return safe_call(function() return ent:HasTag(tag) end, false) == true
end

--- 是否「收获候选」：只看类型 / 组件 / 世界状态。
--- 不含成熟度（那是 IsReady）、不含距离、不含权限。
--- 返回：(true, nil) 或 (false, reason)
function H.IsCandidate(ent, actor)
    if ent == nil then return false, "entity_gone" end
    if actor ~= nil and ent == actor then return false, "is_actor" end

    if safe_call(function() return ent:IsValid() end, false) ~= true then
        return false, "entity_gone"
    end
    if safe_call(function() return ent:IsInLimbo() end, false) == true then
        return false, "in_limbo"
    end

    -- 1) 类型必须在白名单里（绝不靠"名字像植物"或"有 pickable 组件"猜）
    local prefab = ent.prefab
    if prefab == nil or H.PREFABS[tostring(prefab)] ~= true then
        return false, "prefab_not_allowed"
    end

    -- 2) 复刻 componentactions 的原生资格：必须有 pickable 标签，且不是着火/炽热
    if not has_tag(ent, "pickable") then return false, "target_not_harvestable" end
    if has_tag(ent, "fire") or has_tag(ent, "intense") then
        return false, "target_not_harvestable"
    end

    -- 3) 必须有 pickable 组件（ACTIONS.PICK.fn 就是调它的 Pick）
    if comp(ent, "pickable") == nil then return false, "target_not_harvestable" end

    return true, nil
end

--- 是否「现在就成熟、可以采」。
--- 只在已经是候选的前提下有意义；返回 (true, nil) 或 (false, reason)。
function H.IsReady(ent)
    local ok, why = H.IsCandidate(ent)
    if not ok then return false, why end

    local pickable = comp(ent, "pickable")
    if pickable == nil then return false, "target_not_harvestable" end

    -- 卡住的（原生 Pick 会拒绝并回 "STUCK"）
    if safe_call(function() return pickable:IsStuck() end, false) == true then
        return false, "target_busy"
    end
    -- 采摘次数用尽
    if safe_call(function() return pickable:IsBarren() end, false) == true then
        return false, "already_harvested"
    end
    -- 可交互
    if safe_call(function() return pickable.caninteractwith end, true) ~= true then
        return false, "target_not_harvestable"
    end
    -- ★ 原生成熟判据
    if safe_call(function() return pickable:CanBePicked() end, false) ~= true then
        return false, "not_ready"
    end
    return true, nil
end

--- 观察用：把可安全读到的收获状态读出来（组件字段不存在就不写，绝不伪造）。
function H.ReadState(ent)
    local pickable = comp(ent, "pickable")
    if pickable == nil then return nil end
    local out = {}
    local can = safe_call(function() return pickable.canbepicked end, nil)
    if type(can) == "boolean" then out.can_be_picked = can end
    local stuck = safe_call(function() return pickable:IsStuck() end, nil)
    if type(stuck) == "boolean" then out.is_stuck = stuck end
    local cycles = safe_call(function() return pickable.cycles_left end, nil)
    if type(cycles) == "number" then out.cycles_left = cycles end
    local product = safe_call(function() return pickable.product end, nil)
    if type(product) == "string" then out.product = product end
    return out
end

--- 产物 prefab（只读白名单表；读不到就 nil，不猜）
function H.ProductOf(ent)
    if ent == nil or ent.prefab == nil then return nil end
    return H.PRODUCT[tostring(ent.prefab)] or nil
end

--- 原生距离上限（世界单位）：GetPhysicsRadius(0) + 4。
--- 本试点对象没有 jostlepick，所以 extrarange = 0（和 PickRangeCheck 一致）。
function H.NativeRangeLimit(ent)
    if ent == nil then return H.FALLBACK_RANGE end
    local r = safe_call(function() return ent:GetPhysicsRadius(0) end, nil)
    if type(r) ~= "number" then return H.FALLBACK_RANGE end
    return r + H.NATIVE_RANGE_BASE
end

--- 取实体的 x/z 世界坐标（取不到返回 nil）
local function world_xz(ent)
    if ent == nil or ent.Transform == nil then return nil end
    local ok, x, z = pcall(function()
        local px, _, pz = ent.Transform:GetWorldPosition()
        return px, pz
    end)
    if not ok or x == nil or z == nil then return nil end
    return x, z
end

--- 是否在原生允许的距离内。**完全照抄 PickRangeCheck 的算法**：
---   只比 x/z 的平方距离，与 (物理半径 + 4)^2 比较。
--- 返回：(ok, limit, dist)
function H.InNativeRange(actor, ent)
    local limit = H.NativeRangeLimit(ent)
    local ax, az = world_xz(actor)
    local tx, tz = world_xz(ent)
    if ax == nil or tx == nil then return false, limit, nil end
    local dx, dz = ax - tx, az - tz
    local dist = math.sqrt(dx * dx + dz * dz)
    return dist <= limit, limit, dist
end

--- 便于测试/诊断
function H.PrefabList()
    local out = {}
    for prefab in pairs(H.PREFABS) do out[#out + 1] = prefab end
    table.sort(out)
    return out
end

Whale.harvestrules = H
