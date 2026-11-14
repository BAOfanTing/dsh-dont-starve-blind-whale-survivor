-- 采集白名单（SURVIVAL-01 / gather）：草与树苗
--
-- 依据（本机 scripts.zip 实测，见 docs/STATUS.md §4.5）：
--   · 草丛 grass：components/pickable，SetUp("cutgrass", ...)，原生动作 ACTIONS.PICK
--   · 树苗 sapling：components/pickable，SetUp("twigs", ...)，原生动作 ACTIONS.PICK
--   · 两者都用 pickable:CanBePicked() 判"现在能不能采"（采空后 canbepicked=false，
--     标签 barren 只是显示用；**不能拿标签当成熟判据**，M2.3 真机踩过这个坑）
--
-- 观察侧（nearby.lua 的 harvestables 分类）与执行侧（guard.lua / actions.lua）**共用这一份**，
-- 避免"观察说能采、执行说不行"。
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tostring = tostring
local type = type

local H = {}

--- 允许采集的 prefab → 产物 prefab
H.PREFABS = {
    grass = "cutgrass",
    sapling = "twigs",
    -- 花：采下来是花瓣，采集本身回 5 点理智（前期最便宜、最安全的补理智手段）。
    flower = "petals",
}

--- 产物 prefab → 中文（回执用）
H.PRODUCT_LABELS = {
    cutgrass = "草",
    twigs = "树枝",
    petals = "花瓣",
}

--- 这个实体是不是允许采集的对象（只看类型，不看成熟度）
--- @return boolean, string|nil
function H.IsCandidate(ent, actor)
    if ent == nil or type(ent) ~= "table" then return false, "target_missing" end
    if ent.prefab == nil then return false, "target_not_gatherable" end
    local product = H.PREFABS[ent.prefab]
    if product == nil then return false, "prefab_not_allowed" end
    if ent.components == nil or ent.components.pickable == nil then
        return false, "target_not_gatherable"
    end
    return true, nil
end

--- 现在能不能采（原生判据）。
--- @return boolean, string|nil  why 取值：already_harvested / not_ready / target_busy
function H.IsReady(ent)
    local pickable = ent ~= nil and ent.components ~= nil and ent.components.pickable or nil
    if pickable == nil then return false, "target_not_gatherable" end

    -- 被踩住/被占用的不采（和 harvest 的 target_busy 一致）
    local ok_stuck, stuck = pcall(function() return pickable:IsStuck() end)
    if ok_stuck and stuck == true then return false, "target_busy" end

    -- 次数用尽：采空了还没长回来（原生 cycles_left == 0）
    local ok_barren, barren = pcall(function() return pickable:IsBarren() end)
    if ok_barren and barren == true then return false, "already_harvested" end

    -- 能不能交互（被烧/被围住等）
    local ok_interact, can_interact = pcall(function() return pickable.caninteractwith ~= false end)
    if ok_interact and can_interact ~= true then return false, "target_not_gatherable" end

    -- ★ 最终判据：原生 CanBePicked()
    local ok, can = pcall(function() return pickable:CanBePicked() end)
    if not ok then return false, "target_not_gatherable" end
    if can ~= true then return false, "not_ready" end
    return true, nil
end

--- 采集的产物 prefab（背包核对用）
function H.ProductOf(ent)
    if ent == nil or ent.prefab == nil then return nil end
    return H.PREFABS[ent.prefab]
end

--- 原生采集距离（格）：草丛/树苗都是小障碍，物理半径 0.1 + 4 世界单位 ≈ 1.03 格
--- 与 harvestrules 保持同一口径（原生 PickRangeCheck 就是 target_physics_radius + 4）
H.NATIVE_RANGE_BASE = 4
H.FALLBACK_RANGE = 4

--- 是否在原生允许的距离内
function H.InNativeRange(actor, ent)
    if actor == nil or ent == nil then return false end
    local ok_a, ax, _, az = pcall(function() return actor.Transform:GetWorldPosition() end)
    local ok_b, ex, _, ez = pcall(function() return ent.Transform:GetWorldPosition() end)
    if not ok_a or not ok_b then return false end
    local radius = 0
    local ok_r, r = pcall(function() return ent:GetPhysicsRadius(0) end)
    if ok_r and type(r) == "number" then radius = r end
    local limit = radius + H.NATIVE_RANGE_BASE
    local dx, dz = ax - ex, az - ez
    return (dx * dx + dz * dz) <= (limit * limit)
end

--- 白名单 prefab 列表（给观察侧/诊断用）
function H.PrefabList()
    local out = {}
    for k in pairs(H.PREFABS) do out[#out + 1] = k end
    table.sort(out)
    return out
end

Whale.gatherrules = H
