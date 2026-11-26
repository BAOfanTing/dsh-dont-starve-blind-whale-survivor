-- 温蒂 Wendy Profile
-- 真实机制依据（.runtime/dst-scripts）：
--   prefabs/wendy.lua：MakePlayerCharacter("wendy")；WENDY_HEALTH/HUNGER/SANITY=wilson 150/150/200；
--     sanity.night_drain_mult 与 neg_aura_mult = TUNING.WENDY_SANITY_MULT(0.75)；combat.damagemultiplier=WENDY_DAMAGE_MULT(0.75)。
--   abigail.lua / abigail_flower.lua：阿比盖尔由玩家 components.ghostlybond.ghost 绑定，prefab "abigail"，
--     等级 1/2/3 血量 150/300/600；abigail_flower 召唤/召回。
local C = Whale.character
C.profiles = C.profiles or {}

local w = {}
w.id = "wendy"
w.prefab = "wendy"
w.display_name = "温蒂"
w.survival = { sanity_warn = 0.50, sanity_critical = 0.25, sanity_drain_mult = 0.75 }
w.combat = {
    preferred_strategy = "abigail_assisted",   -- 优先用阿比盖尔打
    damage_mult = 0.75,                        -- 温蒂本体攻击×0.75，别当普通近战硬砍
    allow_spider_hunt = true,                  -- 第一阶段：允许安全猎普通蜘蛛
    requires_companion_for_hunt = true,        -- 但必须阿比盖尔可协助才主动狩猎
    avoid_melee = true,
}
w.companion = { kind = "abigail", prefab = "abigail" }

function w.GetSanityPolicy(_player)
    -- 温蒂理智流失×0.75：阈值可略低（0.50）；理智尚可(>=warn)时不要无事采花；
    -- 需要维护时优先附近安全花朵、有限距离，不无条件远距离漫游。
    return { warn = 0.50, critical = 0.25, drain_mult = 0.75, allow_flower_pick = true,
             note = "温蒂理智流失×0.75：阈值略低；理智尚可时别乱采花；需要时只就近安全采花" }
end
function w.ShouldSummonCompanion(player)
    local st = C.GetCompanionState(player)
    return st.can_summon == true and st.has_flower == true and not st.present
end

function w.GetCombatPolicy(player)
    return {
        preferred_strategy = "abigail_assisted",
        allow_spider_hunt = true,
        requires_companion_for_hunt = true,
        avoid_melee = true,
        damage_mult = 0.75,
        should_summon = w.ShouldSummonCompanion(player),
    }
end

C.profiles.wendy = w
return w
