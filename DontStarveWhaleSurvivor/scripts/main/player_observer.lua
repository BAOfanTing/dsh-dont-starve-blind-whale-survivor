-- Blind Whale Survivor · Phase 1 · 玩家观察器（里程碑 3）
--
-- 只读服务端权威数据。调用方传进来的必须是**服务端**的玩家实体（AllPlayers 里的那个），
-- 客户端实体上这些 components 不完整，所以本模块会先验证实体与组件是否可用。
--
-- 字段来源（全部在 762172 源码里确认过）：
--   position        ent.Transform:GetWorldPosition()            entityscript.lua
--   health          inst.components.health.currenthealth/maxhealth/GetPercent()  health.lua:477,546
--   hunger          inst.components.hunger.current/max/GetPercent()              hunger.lua:94
--   sanity          inst.components.sanity.current/max/GetPercent()              sanity.lua:288
--   temperature     inst.components.temperature:GetCurrent()                     temperature.lua:108
--   moisture        inst.components.moisture:GetMoisture()/GetMoisturePercent()   moisture.lua:167,171
--   userid          inst.userid（player_common.lua:1010 里由 Network:GetUserID() 赋的）
--   prefab / GUID   ent.prefab / ent.GUID
--
-- 沙箱：mod 环境没有 pcall / tonumber，全部从 GLOBAL 取。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

BWS = BWS or {}

local P = {}

local TILE = 4 -- 饥荒一格 = 4 个世界单位（只用于把坐标换算成格子，不改原始值）

--- 组件百分比：有 GetPercent 就用它，否则按 current/max 算，再不行返回 nil
local function percent_of(component, current, max)
    if component ~= nil and component.GetPercent ~= nil then
        local ok, value = pcall(function() return component:GetPercent() end)
        if ok and value ~= nil then return BWS.json.round(value * 100, 1) end
    end
    if current ~= nil and max ~= nil and max > 0 then
        return BWS.json.round(current / max * 100, 1)
    end
    return nil
end

--- 一条属性：数值优先取当前/最大，百分比兜底
local function stat_block(component)
    if component == nil then return nil end
    local block = {}
    if component.current ~= nil then block.current = BWS.json.round(component.current, 1) end
    if component.max ~= nil then block.max = BWS.json.round(component.max, 1) end
    block.percent = percent_of(component, component.current, component.max)
    if block.current == nil and block.max == nil and block.percent == nil then return nil end
    return block
end

--- 生命值字段名不一样（currenthealth / maxhealth）
local function health_block(component)
    if component == nil then return nil end
    local block = {
        current = BWS.json.round(component.currenthealth, 1),
        max = BWS.json.round(component.maxhealth, 1),
        percent = percent_of(component, component.currenthealth, component.maxhealth),
    }
    local ok, dead = pcall(function() return component:IsDead() end)
    if ok and dead ~= nil then block.dead = dead and true or false end
    return block
end

--- 展示名：优先用游戏里的角色中文名
local function display_name(prefab)
    if prefab == nil then return nil end
    local strings = GLOBAL.STRINGS
    local key = string.upper(prefab)
    if strings ~= nil and strings.CHARACTER_NAMES ~= nil and strings.CHARACTER_NAMES[key] ~= nil then
        return strings.CHARACTER_NAMES[key]
    end
    if strings ~= nil and strings.NAMES ~= nil and strings.NAMES[key] ~= nil then
        return strings.NAMES[key]
    end
    return nil
end

--- 观察一个玩家实体。失败时返回 nil, 原因（调用方把它写进 observer.last_error）
function P.Observe(player, side)
    if player == nil then return nil, "no_player" end

    local ok_valid, valid = pcall(function() return player:IsValid() end)
    if not ok_valid or not valid then return nil, "player_invalid" end
    -- 客户端实体上的 components 不权威：本地明确要求服务端实体
    if side ~= nil and side ~= "server" then return nil, "not_server_side" end

    local x, y, z
    if player.Transform ~= nil then
        local ok_pos, px, py, pz = pcall(function() return player.Transform:GetWorldPosition() end)
        if ok_pos then x, y, z = px, py, pz end
    end

    local components = player.components or {}
    local ok_ghost, ghost = pcall(function() return player:HasTag("playerghost") end)
    local result = {
        valid = true,
        prefab = player.prefab,
        name = display_name(player.prefab),
        guid = player.GUID,
        userid = player.userid,
        is_ghost = (ok_ghost and ghost) and true or false,
    }

    if x ~= nil and z ~= nil then
        result.position = {
            x = BWS.json.round(x, 2),
            y = BWS.json.round(y or 0, 2),
            z = BWS.json.round(z, 2),
            tile_x = math.floor(x / TILE),
            tile_z = math.floor(z / TILE),
        }
    end

    result.health = health_block(components.health)
    result.hunger = stat_block(components.hunger)
    result.sanity = stat_block(components.sanity)

    if components.temperature ~= nil then
        local ok_temp, value = pcall(function() return components.temperature:GetCurrent() end)
        if ok_temp and value ~= nil then
            result.temperature = { current = BWS.json.round(value, 1) }
        end
    end

    if components.moisture ~= nil then
        local moisture = {}
        local ok_value, value = pcall(function() return components.moisture:GetMoisture() end)
        if ok_value and value ~= nil then moisture.value = BWS.json.round(value, 1) end
        local ok_percent, percent = pcall(function() return components.moisture:GetMoisturePercent() end)
        if ok_percent and percent ~= nil then moisture.percent = BWS.json.round(percent * 100, 1) end
        if moisture.value ~= nil or moisture.percent ~= nil then result.moisture = moisture end
    end

    return result
end

BWS.player_observer = P
