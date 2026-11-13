-- 装备白名单（SURVIVAL-01 / equip）：只能装备背包里、白名单内的手持/身上物品
--
-- 为什么需要白名单：`inventory:Equip(item)` 对**任何** inventoryitem 都能调，
-- 包括食物、材料、甚至任务物品。模型如果能随便 equip，就会出现"把浆果拿在手里"
-- 这种荒谬状态，还会挤掉手里真正有用的工具。
--
-- 本阶段只放行 3 个：torch / axe / pickaxe（正好是 craft 能做的那些）。
-- 依据（本机 scripts.zip）：三者都有 inventoryitem + 对应的 equippable/tool 行为，
--   torch 走 ACTIONS.EQUIP（equippable），axe/pickaxe 是工具（tool，走 ACTIONS.EQUIP 也一样能拿在手里）。
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tostring = tostring
local type = type

local Q = {}

--- 允许装备的 prefab（值 = 中文名）
Q.ITEMS = {
    torch = "火把",
    axe = "斧头",
    pickaxe = "镐",
}

--- prefab 是否允许装备
function Q.IsAllowedPrefab(prefab)
    if prefab == nil then return false, "item_not_equippable" end
    if Q.ITEMS[tostring(prefab)] == nil then return false, "item_not_equippable" end
    return true, nil
end

--- 背包物品实体是否可装备（白名单 + 真实组件）
function Q.IsEquippable(item)
    if item == nil or type(item) ~= "table" then return false, "item_missing" end
    local ok_p, why_p = Q.IsAllowedPrefab(item.prefab)
    if not ok_p then return false, why_p end
    local inv_item = item.components ~= nil and item.components.inventoryitem or nil
    if inv_item == nil then return false, "item_not_equippable" end
    return true, nil
end

--- 背包里有没有这个 prefab（返回实体）
function Q.FindInInventory(inventory, prefab)
    if inventory == nil or prefab == nil then return nil end
    local found = nil
    pcall(function()
        inventory:ForEachItem(function(item)
            if found ~= nil then return end
            if item ~= nil and item:IsValid() and tostring(item.prefab) == tostring(prefab) then
                found = item
            end
        end)
    end)
    return found
end

--- 当前手里拿着什么（回执/核对用）
function Q.HandItem(player)
    if player == nil or player.components == nil then return nil end
    local inv = player.components.inventory
    if inv == nil then return nil end
    local hand = nil
    pcall(function() hand = inv:GetEquippedItem(EQUIPSLOTS.HANDS) end)
    return hand
end

--- 白名单列表
function Q.ItemList()
    local out = {}
    for k in pairs(Q.ITEMS) do out[#out + 1] = k end
    table.sort(out)
    return out
end

Whale.equiprules = Q
