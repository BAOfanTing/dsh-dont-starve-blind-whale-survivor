-- 角色 Profile 注册与解析（R8.2）
-- 依据当前玩家真实 prefab 自动识别；未识别用 base；角色切换/玩家实体变化时按 prefab 即时解析，阈值互不污染。
local GLOBAL = GLOBAL
local type = type
Whale = Whale or {}
local C = Whale.character
C.profiles = C.profiles or {}

-- prefab -> profile（默认只注册 Wendy；后续 Wolfgang/Wigfrid/Wilson 在此追加/或 Register）
local byPrefab = {}
if C.profiles.wendy ~= nil and C.profiles.wendy.prefab ~= nil then
    byPrefab[C.profiles.wendy.prefab] = C.profiles.wendy
end
C.byPrefab = byPrefab

--- 注册新角色 Profile（未来扩展用）
function C.Register(profile)
    if profile == nil or profile.id == nil then return false end
    C.profiles[profile.id] = profile
    if type(profile.prefab) == "string" and profile.prefab ~= "" then byPrefab[profile.prefab] = profile end
    return true
end

--- 解析当前玩家对应的 Profile。未识别一律返回 base，绝不崩。
function C.Resolve(player)
    if player == nil then return C.base end
    local prefab = player.prefab
    if type(prefab) == "string" and byPrefab[prefab] ~= nil then return byPrefab[prefab] end
    return C.base
end

-- ── 敌人分类（真实 prefab 名，来源 tuning.lua / prefabs/spider.lua）──
local SPIDER_COMMON = { spider = true }
local SPIDER_HARD = {
    spider_warrior = true, spider_healer = true, spider_hider = true,
    spider_moon = true, spider_water = true, spider_spitter = true,
}
local SPIDER_QUEEN = { spiderqueen = true }

--- 按真实 prefab 分类。返回 { kind, hunt_allowed, risk }
---   spider_common：普通蜘蛛（第一阶段可安全猎）
---   spider_warrior：蜘蛛战士/治疗/洞穴/月/水等 → 保守，不主动
---   spider_queen：蜘蛛女王 → 绝不主动
---   other/unknown：默认保守，不主动
function C.ClassifyEnemy(prefab)
    local p = tostring(prefab or "")
    if SPIDER_QUEEN[p] then return { kind = "spider_queen", hunt_allowed = false, risk = "extreme" } end
    if SPIDER_COMMON[p] then return { kind = "spider_common", hunt_allowed = true, risk = "low" } end
    if SPIDER_HARD[p] then return { kind = "spider_warrior", hunt_allowed = false, risk = "high" } end
    return { kind = "other", hunt_allowed = false, risk = "unknown" }
end
