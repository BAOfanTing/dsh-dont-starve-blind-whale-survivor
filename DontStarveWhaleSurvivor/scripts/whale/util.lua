-- 小工具：找实体、算距离、读背包、起名字
local GLOBAL = GLOBAL
-- 饥荒的模组沙箱只给了 pairs/ipairs/print/math/table/type/string/tostring/require/Class，
-- pcall / tonumber / error / os / io 这些得从 GLOBAL（就是 _G）里拿，直接用会报 nil（0.1.0 就是这么崩的）。
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local error = GLOBAL.error
local os = GLOBAL.os or { time = function() return 0 end }
local io = GLOBAL.io

local U = {}

U.TILE = 4 -- 饥荒一格是 4 个世界单位

function U.world()
    return GLOBAL.TheWorld
end

--- 游戏内时间（秒）。服务器暂停时不会走，用来做超时判断刚好。
function U.now()
    local ok, t = pcall(function() return GLOBAL.TheSim:GetTime() end)
    return ok and t or 0
end

function U.pos(ent)
    if ent == nil or not ent:IsValid() or ent.Transform == nil then return nil end
    local x, y, z = ent.Transform:GetWorldPosition()
    return x, y, z
end

--- 世界坐标 -> 格子坐标（给 AI 看的都是格子）
function U.tile_of(x, z)
    return math.floor(x / U.TILE), math.floor(z / U.TILE)
end

function U.tile_center(tx, tz)
    return tx * U.TILE + U.TILE / 2, tz * U.TILE + U.TILE / 2
end

function U.dist(a, b)
    if a == nil or b == nil then return math.huge end
    local ax, _, az = U.pos(a)
    local bx, _, bz = U.pos(b)
    if ax == nil or bx == nil then return math.huge end
    local dx, dz = ax - bx, az - bz
    return math.sqrt(dx * dx + dz * dz)
end

function U.tile_dist(a, b)
    return U.dist(a, b) / U.TILE
end

--- 现在操作的玩家。房主优先，其次第一个活人。
function U.player()
    local players = GLOBAL.AllPlayers
    if players == nil then return nil end
    local best = nil
    for _, p in pairs(players) do
        if p ~= nil and p:IsValid() and not p:HasTag("playerghost") then
            if best == nil then
                best = p
            elseif p:HasTag("player") and not best:HasTag("player") then
                best = p
            end
        end
    end
    if best == nil then
        -- 死了也算：至少能看到状态并告诉 AI
        for _, p in pairs(players) do
            if p ~= nil and p:IsValid() then best = p end
        end
    end
    return best
end

--- 附近所有符合条件的实体，按距离从近到远
function U.find_all(p, radius_tiles, musttags, mustoneoftags, filter)
    local list = {}
    if p == nil then return list end
    local x, y, z = U.pos(p)
    if x == nil then return list end
    local ok, ents = pcall(function()
        return GLOBAL.TheSim:FindEntities(x, y, z, radius_tiles * U.TILE, musttags, { "INLIMBO" }, mustoneoftags)
    end)
    if not ok or ents == nil then return list end
    for _, e in ipairs(ents) do
        if e ~= p and e:IsValid() and not e:HasTag("INLIMBO") then
            if filter == nil or filter(e) then
                list[#list + 1] = { ent = e, d = U.dist(p, e) }
            end
        end
    end
    table.sort(list, function(a, b) return a.d < b.d end)
    return list
end

function U.find_nearest(p, radius_tiles, musttags, mustoneoftags, filter)
    local list = U.find_all(p, radius_tiles, musttags, mustoneoftags, filter)
    if #list == 0 then return nil end
    return list[1].ent, list[1].d / U.TILE
end

--- 实体的中文名
function U.pretty(ent)
    if ent == nil then return "?" end
    local prefab = ent.prefab
    local names = GLOBAL.STRINGS and GLOBAL.STRINGS.NAMES
    local key = prefab and string.upper(prefab) or nil
    if names ~= nil and key ~= nil and names[key] ~= nil then
        return names[key]
    end
    if type(ent.name) == "string" and ent.name ~= "" and prefab ~= ent.name then
        return ent.name
    end
    return prefab or "?"
end

--- 格子里有什么东西用得上（给文字地图用）
function U.has_tag(ent, tag)
    return ent ~= nil and ent:IsValid() and ent:HasTag(tag)
end

--- 背包里所有物品（服务端权威）
function U.items(p)
    local list = {}
    if p == nil or p.components.inventory == nil then return list end
    local inv = p.components.inventory
    local ok, slots = pcall(function() return inv:GetNumSlots() end)
    if not ok or slots == nil then slots = 15 end
    for slot = 1, slots do
        local item = inv:GetItemInSlot(slot)
        if item ~= nil then
            list[#list + 1] = { item = item, slot = slot }
        end
    end
    return list
end

function U.count(item)
    if item == nil then return 0 end
    if item.components.stackable ~= nil then
        return item.components.stackable:StackSize()
    end
    return 1
end

--- 耐久 / 新鲜度百分比（有就返回 0~100，没有返回 nil）
function U.percent(item)
    if item == nil then return nil end
    if item.components.finiteuses ~= nil then
        local cur, max = item.components.finiteuses:GetUses(), item.components.finiteuses.total
        if max and max > 0 then return math.floor(cur / max * 100) end
    end
    if item.components.perishable ~= nil then
        return math.floor(item.components.perishable:GetPercent() * 100)
    end
    if item.components.fueled ~= nil then
        return math.floor(item.components.fueled:GetPercent() * 100)
    end
    if item.components.armor ~= nil then
        return math.floor(item.components.armor:GetPercent() * 100)
    end
    return nil
end

function U.describe_item(item)
    local text = U.pretty(item)
    local n = U.count(item)
    if n > 1 then text = text .. " ×" .. n end
    local pct = U.percent(item)
    if pct ~= nil then text = text .. "(" .. pct .. "%)" end
    return text
end

--- 某个 tag 里最“能吃”的东西
function U.is_food(item)
    return item ~= nil and item.components.edible ~= nil and item.components.edible.foodtype ~= nil
end

--- 背包里找物品：prefab 名或中文名都行
function U.find_item(p, want)
    if want == nil or want == "" then return nil end
    local needle = string.lower(tostring(want))
    local inv = p ~= nil and p.components.inventory or nil
    if inv == nil then return nil end
    local found = nil
    inv:ForEachItem(function(item)
        if found == nil and item ~= nil then
            local prefab = string.lower(item.prefab or "")
            local name = string.lower(U.pretty(item))
            if prefab == needle or name == needle or string.find(name, needle, 1, true) ~= nil then
                found = item
            end
        end
    end)
    return found
end

function U.log(msg)
    if Whale ~= nil and Whale.verbose then
        print("[大肥鱼] " .. tostring(msg))
    end
end

Whale = Whale or {}
Whale.util = U
