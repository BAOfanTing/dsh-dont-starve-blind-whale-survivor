-- 装备白名单（SURVIVAL-01 / equip）：只能装备背包里、白名单内的手持/身上物品
--
-- 为什么需要白名单：`inventory:Equip(item)` 对**任何** inventoryitem 都能调，
-- 包括食物、材料、甚至任务物品。模型如果能随便 equip，就会出现"把浆果拿在手里"
-- 这种荒谬状态，还会挤掉手里真正有用的工具。
--
-- 仅放行基础工具和便携光源：torch / axe / pickaxe / lantern / minerhat。
-- 依据（本机 scripts.zip）：三者都有 inventoryitem + 对应的 equippable/tool 行为，
--   torch 走 ACTIONS.EQUIP（equippable），axe/pickaxe 是工具（tool，走 ACTIONS.EQUIP 也一样能拿在手里）。
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
-- 模组环境里没有裸 EQUIPSLOTS：不走 GLOBAL 会在 pcall 里报错，HandItem 永远返回 nil
local EQUIPSLOTS = GLOBAL.EQUIPSLOTS
local tostring = tostring
local type = type

local Q = {}

--- 允许装备的 prefab（值 = 中文名）
Q.ITEMS = {
    torch = "火把",
    lantern = "提灯",
    minerhat = "矿工帽",
    flowerhat = "花环",
    axe = "斧头",
    pickaxe = "镐",
    spear = "长矛",
}

--- 根据 prefab 或物品实体识别装备槽位（HEAD / BODY / HANDS）
function Q.SlotFor(prefab_or_item)
    if type(prefab_or_item) == "table" and prefab_or_item.components ~= nil and prefab_or_item.components.equippable ~= nil then
        local slot = prefab_or_item.components.equippable.equipslot
        if slot ~= nil then return slot end
    end
    local name = type(prefab_or_item) == "table" and prefab_or_item.prefab or tostring(prefab_or_item or "")
    if name == "minerhat" or name == "flowerhat" then
        return EQUIPSLOTS ~= nil and EQUIPSLOTS.HEAD or "head"
    elseif name == "armorwood" or name == "backpack" then
        return EQUIPSLOTS ~= nil and EQUIPSLOTS.BODY or "body"
    end
    return EQUIPSLOTS ~= nil and EQUIPSLOTS.HANDS or "hands"
end

--- prefab 是否允许装备
function Q.IsAllowedPrefab(prefab)
    if prefab == nil then return false, "item_not_equippable" end
    if Q.ITEMS[tostring(prefab)] == nil then return false, "item_not_equippable" end
    return true, nil
end

--- 背包物品实体是否可装备（白名单 + 真实组件 + 角色兼容）
function Q.IsEquippable(item, player)
    if item == nil or type(item) ~= "table" then return false, "item_missing" end
    local ok_p, why_p = Q.IsAllowedPrefab(item.prefab)
    if not ok_p then return false, why_p end
    local inv_item = item.components ~= nil and item.components.inventoryitem or nil
    if inv_item == nil then return false, "item_not_equippable" end
    local eq = item.components ~= nil and item.components.equippable or nil
    if eq ~= nil and eq.CanBeEquippedBy ~= nil and player ~= nil then
        local ok_can, can = pcall(function() return eq:CanBeEquippedBy(player) end)
        if ok_can and can == false then return false, "item_not_equippable" end
    end
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

function Q.EquippedItem(player, prefab)
    if player == nil or player.components == nil then return nil end
    local inv = player.components.inventory
    if inv == nil then return nil end
    local slot = Q.SlotFor(prefab)
    return inv:GetEquippedItem(slot)
end

function Q.HandItem(player)
    return Q.EquippedItem(player, nil)
end

--- 白名单列表
function Q.ItemList()
    local out = {}
    for k in pairs(Q.ITEMS) do out[#out + 1] = k end
    table.sort(out)
    return out
end

Whale.equiprules = Q
