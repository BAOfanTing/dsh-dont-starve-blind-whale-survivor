-- Blind Whale Survivor · Phase 1 · 背包观察器（里程碑 3）
--
-- 只读。只看**服务端**玩家的 components.inventory（客户端只有 replica，字段不全）。
--
-- 字段来源（762172 源码确认）：
--   inv:GetNumSlots()                  inventory.lua:588
--   inv:GetItemInSlot(slot)            inventory.lua:777
--   inv:GetEquippedItem(eslot)         inventory.lua:773
--   inv:IsFull()                       inventory.lua:791
--   item.components.stackable:StackSize()   stackable.lua:59
--   item.components.finiteuses:GetUses() / .total   finiteuses.lua:75（.total 是字段）
--   item.components.perishable:GetPercent()         perishable.lua:217
--   item.components.fueled:GetPercent()             fueled.lua:251
--   item.components.armor:GetPercent()              armor.lua
--   中文名：STRINGS.NAMES[string.upper(prefab)]
--
-- 数量上限：格子数由游戏决定（默认 15），这里再兜一层 max_slots，避免异常数据把日志打爆。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

BWS = BWS or {}

local I = {}

local MAX_SLOTS = 40 -- 兜底：正常 15 格，带上背包扩容类模组也不会爆

local function item_name(prefab)
    if prefab == nil then return nil end
    local strings = GLOBAL.STRINGS
    local key = string.upper(prefab)
    if strings ~= nil and strings.NAMES ~= nil and strings.NAMES[key] ~= nil then
        return strings.NAMES[key]
    end
    return nil
end

--- 把一个物品实体压成一条扁平描述（字段都来自真实组件，没有就省略）
function I.Describe(item)
    if item == nil then return nil end
    local ok_valid, valid = pcall(function() return item:IsValid() end)
    if not ok_valid or not valid then return nil end

    local entry = { prefab = item.prefab, name = item_name(item.prefab) }
    local components = item.components or {}

    local count = 1
    if components.stackable ~= nil then
        local ok_count, value = pcall(function() return components.stackable:StackSize() end)
        if ok_count and value ~= nil then count = value end
    end
    entry.count = count

    if components.finiteuses ~= nil then
        local ok_uses, uses = pcall(function() return components.finiteuses:GetUses() end)
        if ok_uses and uses ~= nil then entry.uses_left = BWS.json.round(uses, 1) end
        if components.finiteuses.total ~= nil then entry.uses_max = BWS.json.round(components.finiteuses.total, 1) end
    end

    if components.perishable ~= nil then
        local ok_percent, percent = pcall(function() return components.perishable:GetPercent() end)
        if ok_percent and percent ~= nil then entry.freshness = BWS.json.round(percent * 100, 1) end
    end

    if components.fueled ~= nil then
        local ok_percent, percent = pcall(function() return components.fueled:GetPercent() end)
        if ok_percent and percent ~= nil then entry.fuel = BWS.json.round(percent * 100, 1) end
    end

    if components.armor ~= nil then
        local ok_percent, percent = pcall(function() return components.armor:GetPercent() end)
        if ok_percent and percent ~= nil then entry.armor = BWS.json.round(percent * 100, 1) end
    end

    return entry
end

--- 观察背包 + 装备。返回 nil, 原因 表示拿不到。
function I.Observe(player)
    if player == nil then return nil, "no_player" end
    local ok_valid, valid = pcall(function() return player:IsValid() end)
    if not ok_valid or not valid then return nil, "player_invalid" end

    local inventory = (player.components or {}).inventory
    if inventory == nil then return nil, "no_inventory_component" end

    local slots = 15
    local ok_slots, value = pcall(function() return inventory:GetNumSlots() end)
    if ok_slots and value ~= nil then slots = tonumber(value) or 15 end
    if slots > MAX_SLOTS then slots = MAX_SLOTS end

    local items = {}
    local used = 0
    for slot = 1, slots do
        local item = nil
        local ok_item, found = pcall(function() return inventory:GetItemInSlot(slot) end)
        if ok_item then item = found end
        local entry = I.Describe(item)
        if entry ~= nil then
            entry.slot = slot
            items[#items + 1] = entry
            used = used + 1
        end
    end

    local result = {
        slots = slots,
        used = used,
        items = items,
    }

    local ok_full, full = pcall(function() return inventory:IsFull() end)
    if ok_full and full ~= nil then result.is_full = full and true or false end

    -- 装备栏：手 / 头 / 身（EQUIPSLOTS 由引擎提供）
    local equip_slots = GLOBAL.EQUIPSLOTS
    if equip_slots ~= nil then
        local equipment = {}
        local pairs_to_check = {
            { key = "hands", slot = equip_slots.HANDS },
            { key = "head", slot = equip_slots.HEAD },
            { key = "body", slot = equip_slots.BODY },
        }
        for _, pair in ipairs(pairs_to_check) do
            if pair.slot ~= nil then
                local equipped = nil
                local ok_equipped, found = pcall(function() return inventory:GetEquippedItem(pair.slot) end)
                if ok_equipped then equipped = found end
                local entry = I.Describe(equipped)
                if entry ~= nil then equipment[pair.key] = entry end
            end
        end
        result.equipment = equipment
    end

    return result
end

BWS.inventory_observer = I
