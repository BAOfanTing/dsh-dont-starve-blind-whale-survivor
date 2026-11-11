-- Blind Whale Survivor · Phase 1 · 附近实体扫描（里程碑 5）
--
-- 只读。一次调用 = 一次 TheSim:FindEntities + 一遍遍历，**不在 OnUpdate 里做**，
-- 由 observer_manager 按 SCAN 间隔调用并缓存结果。
--
-- API 依据（762172 源码）：
--   TheSim:FindEntities(x, y, z, radius, musthavetags, canthavetags, musthaveoneoftags)   findclosest.lua:83
--   ent:IsValid() / ent:HasTag() / ent.Transform:GetWorldPosition()                      entityscript.lua
--   ent.components.workable.action.id  → "CHOP" / "MINE" / "DIG" / "HAMMER"              components/workable.lua:7,33
--   ent.components.health:GetPercent() / IsDead()                                        health.lua:477,546
--   ent.components.inventoryitem.owner（掉落物 = owner 为 nil）                           inventoryitem.lua
--   中文名 STRINGS.NAMES[string.upper(prefab)]                                            strings.lua
--   标签：player / hostile / monster / animal / structure / pickable / barren / tree / boulder
--        （用 HasTag("xxx") 在源码里统计过，都是真实存在的标签）
--
-- 参数都有上限，避免一次扫描把日志打爆：
--   radius_tiles  默认 16，夹在 2~40
--   max_entities  默认 40，夹在 1~200
--   per_category  默认 10，夹在 1~50

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

BWS = BWS or {}

local E = {}

local TILE = 4 -- 世界单位/格
local DEFAULT_RADIUS = 16
local MAX_RADIUS = 40
local DEFAULT_MAX_ENTITIES = 40
local DEFAULT_PER_CATEGORY = 10
local MAX_PER_CATEGORY = 50

-- 不允许出现在结果里的标签：出界、纯特效、已经进背包的东西
local CANT_TAGS = { "INLIMBO", "FX" }

local WORKABLE_CATEGORY = {
    CHOP = "tree",
    MINE = "rock",
    DIG = "diggable",
    HAMMER = "damageable",
}

local function clamp(value, min, max, fallback)
    local n = tonumber(value)
    if n == nil then return fallback end
    if n < min then return min end
    if n > max then return max end
    return n
end

local function display_name(prefab)
    if prefab == nil then return nil end
    local strings = GLOBAL.STRINGS
    local key = string.upper(prefab)
    if strings ~= nil and strings.NAMES ~= nil and strings.NAMES[key] ~= nil then
        return strings.NAMES[key]
    end
    return nil
end

--- 给一个实体归类。返回 类别 或 nil（不关心的东西）
--- 顺序有意义：先判断“它是什么人/什么东西”，再判断“它能被怎样利用”。
function E.Classify(ent)
    if ent == nil then return nil end

    -- 玩家
    local ok_tag, is_player = pcall(function() return ent:HasTag("player") end)
    if ok_tag and is_player then return "player" end

    local components = ent.components or {}

    -- 战斗单位：有血 + 敌对标签优先
    local ok_hostile, hostile = pcall(function() return ent:HasTag("hostile") end)
    if ok_hostile and hostile and components.health ~= nil then return "hostile" end

    local ok_struct, is_structure = pcall(function() return ent:HasTag("structure") end)
    if components.combat ~= nil and components.health ~= nil and not (ok_struct and is_structure) then return "creature" end
    local ok_monster, monster = pcall(function() return ent:HasTag("monster") end)
    if ok_monster and monster and components.health ~= nil then return "creature" end
    local ok_animal, animal = pcall(function() return ent:HasTag("animal") end)
    if ok_animal and animal and components.health ~= nil then return "creature" end

    -- 能采的优先（草/浆果丛/蘑菇同时也能用铲子挖，但玩家第一反应是“采”）
    local ok_pick, pickable = pcall(function() return ent:HasTag("pickable") end)
    local ok_barren, barren = pcall(function() return ent:HasTag("barren") end)
    if ok_pick and pickable and not (ok_barren and barren) then return "harvestable" end
    if components.harvestable ~= nil then return "harvestable" end

    -- 能用工工具处理的：树 / 矿 / 可铲 / 可拆
    if components.workable ~= nil and components.workable.action ~= nil then
        local id = components.workable.action.id
        local category = WORKABLE_CATEGORY[id]
        if category ~= nil then return category end
    end

    -- 地上的掉落物
    if components.inventoryitem ~= nil and components.inventoryitem.owner == nil then return "item" end

    -- 建筑
    local ok_structure, structure = pcall(function() return ent:HasTag("structure") end)
    if ok_structure and structure then return "structure" end

    return nil
end

--- 扫描附近实体。
--- 返回 { radius_tiles, scanned, returned, truncated, counts, entities = {...} } 或 nil, 原因
function E.Observe(player, opts)
    if player == nil then return nil, "no_player" end
    local ok_valid, valid = pcall(function() return player:IsValid() end)
    if not ok_valid or not valid then return nil, "player_invalid" end
    if GLOBAL.TheSim == nil then return nil, "no_sim" end
    if player.Transform == nil then return nil, "no_transform" end

    local options = opts or {}
    local radius = clamp(options.radius_tiles, 2, MAX_RADIUS, DEFAULT_RADIUS)
    local max_entities = clamp(options.max_entities, 1, 200, DEFAULT_MAX_ENTITIES)
    local per_category = clamp(options.per_category, 1, MAX_PER_CATEGORY, DEFAULT_PER_CATEGORY)

    local ok_pos, x, y, z = pcall(function() return player.Transform:GetWorldPosition() end)
    if not ok_pos or x == nil then return nil, "no_position" end

    local ok_find, found = pcall(function()
        return GLOBAL.TheSim:FindEntities(x, y, z, radius * TILE, nil, CANT_TAGS, nil)
    end)
    if not ok_find or found == nil then return nil, "find_entities_failed" end

    local entities = {}
    local counts = {}
    local scanned = 0
    local truncated = false

    for _, ent in ipairs(found) do
        scanned = scanned + 1
        if ent ~= nil and ent ~= player then
            local ok_ent, is_valid = pcall(function() return ent:IsValid() end)
            if ok_ent and is_valid then
                local category = E.Classify(ent)
                if category ~= nil then
                    local count = counts[category] or 0
                    if count < per_category and #entities < max_entities then
                        local ex, ez = nil, nil
                        if ent.Transform ~= nil then
                            local ok_e, px, _py, pz = pcall(function() return ent.Transform:GetWorldPosition() end)
                            if ok_e then ex, ez = px, pz end
                        end
                        if ex ~= nil then
                            local dx, dz = ex - x, ez - z
                            local distance = math.sqrt(dx * dx + dz * dz) / TILE
                            local entry = {
                                prefab = ent.prefab,
                                name = display_name(ent.prefab),
                                category = category,
                                tile_x = math.floor(ex / TILE),
                                tile_z = math.floor(ez / TILE),
                                distance = BWS.json.round(distance, 1),
                            }
                            if category == "hostile" or category == "creature" then
                                local health = ent.components ~= nil and ent.components.health or nil
                                if health ~= nil then
                                    entry.hp = BWS.json.round(health:GetPercent() * 100, 0)
                                end
                            elseif category == "tree" or category == "rock" or category == "diggable" or category == "damageable" then
                                local workable = ent.components ~= nil and ent.components.workable or nil
                                if workable ~= nil and workable.workleft ~= nil then
                                    entry.work_left = BWS.json.round(workable.workleft, 0)
                                end
                            end
                            entities[#entities + 1] = entry
                            counts[category] = count + 1
                        end
                    else
                        truncated = true
                    end
                end
            end
        end
    end

    return {
        radius_tiles = radius,
        scanned = scanned,
        returned = #entities,
        truncated = truncated,
        counts = counts,
        entities = entities,
    }
end

BWS.entity_observer = E
