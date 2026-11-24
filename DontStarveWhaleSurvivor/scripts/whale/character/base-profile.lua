-- 角色 Profile 基类（R8.2）
-- 所有角色共用同一套 Reflex / Survival Brain / Battle / Actions / Dispatcher / Lease / Guard。
-- Profile 只提供**差异化规则**，不建立第二套生存或动作系统。
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall or pcall
local type = type
Whale = Whale or {}
local C = Whale.character or {}
Whale.character = C

local function comp_percent(comp)
    if comp == nil then return nil end
    local ok, p = pcall(function() return comp:GetPercent() end)
    if ok and type(p) == "number" then return p end
    local cur = comp.current or comp.currenthealth
    local max = comp.max or comp.maxhealth
    if type(cur) == "number" and type(max) == "number" and max > 0 then return cur / max end
    return nil
end
C.util_comp_percent = comp_percent

-- 未知/无伴生时的统一空状态（避免各处伪造默认值，字段用 unknown 标记）
C.EMPTY_COMPANION = {
    present = false, alive = false, valid = false,
    distance = nil, health_percent = nil, current_target = nil,
    is_following = false, is_attacking = false, is_busy = false,
    can_assist = false, can_summon = false, has_flower = false, bond_level = 1,
    unknown = true,
}

local base = {}
base.id = "base"
base.prefab = nil
base.display_name = "通用角色"
base.survival = { sanity_warn = 0.55, sanity_critical = 0.25 }
base.combat = {
    preferred_strategy = "generic",
    allow_spider_hunt = true,
    requires_companion_for_hunt = false,
    avoid_melee = false,
}
base.companion = { kind = "none" }

function base.GetSanityPolicy(_player)
    return { warn = base.survival.sanity_warn, critical = base.survival.sanity_critical, drain_mult = 1.0, note = "通用角色" }
end
function base.GetCombatPolicy(_player)
    return {
        preferred_strategy = base.combat.preferred_strategy,
        allow_spider_hunt = base.combat.allow_spider_hunt,
        requires_companion_for_hunt = base.combat.requires_companion_for_hunt,
        avoid_melee = base.combat.avoid_melee,
    }
end
function base.GetCompanionState(_player)
    local t = {}
    for k, v in pairs(C.EMPTY_COMPANION) do t[k] = v end
    return t
end
C.base = base
