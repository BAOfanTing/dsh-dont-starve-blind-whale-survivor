-- 生存基础动作：eat, equip, unequip, drop, fuel, add_fuel, make_fire, wait, heal, sleep
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall or pcall
local tonumber = GLOBAL.tonumber or tonumber
local tostring = tostring or (GLOBAL and GLOBAL.tostring)

local ACTIONS = GLOBAL.ACTIONS
local EQUIPSLOTS = GLOBAL.EQUIPSLOTS
local BufferedAction = GLOBAL.BufferedAction

local U = Whale.util

Whale = Whale or {}
Whale.actions = Whale.actions or {}
local A = Whale.actions
A.JOBS = A.JOBS or {}
local JOBS = A.JOBS

local busy = A.busy
local push = A.push
local best_food = A.best_food
local best_fuel = A.best_fuel
local snapshot_counts = A.snapshot_counts

--- 丢掉背包里的东西（新路径：核对背包真的少了；旧路径保持不变）
local function drop_by_ref(j, p, item_name)
    if j.step == "start" then
        local want = item_name
        if want == nil or want == "" then return "fail", "drop 要传 item" end
        local item = U.find_item(p, want)
        if item == nil then return "fail", "not_in_inventory: 背包里没有 " .. tostring(want) end
        local inv = p.components ~= nil and p.components.inventory or nil
        if inv == nil then return "fail", "no_inventory" end
        j.data.prefab = tostring(item.prefab)
        j.data.before = snapshot_counts(p)
        local ok, err = pcall(function() inv:DropItem(item) end)
        if not ok then return "fail", "drop_failed: " .. tostring(err) end
        j.step = "acting"
        j.data.phase_start = U.now()
        return "run"
    end
    if j.step == "acting" then
        local after = snapshot_counts(p)
        local lost = (j.data.before[j.data.prefab] or 0) - (after[j.data.prefab] or 0)
        if lost > 0 then
            return "done", string.format("丢掉了 %s×%d", j.data.prefab, lost)
        end
        if U.now() - j.data.phase_start > 5 then
            return "fail", "drop_failed: 背包里数量没变"
        end
        return "run"
    end
    return "run"
end

--- 脱下手上的/身上的装备（新路径：核对装备栏真的空了）
local function unequip_by_slot(j, p, slot_name)
    local SLOTS = { HANDS = "HANDS", BODY = "BODY", HEAD = "HEAD", BACK = "BACK", BACKPACK = "BACK" }
    local key = SLOTS[string.upper(tostring(slot_name or "hands"))]
    if key == nil then return "fail", "bad_slot: 不认识这个位置（hands/body/head/back）" end
    local slot = EQUIPSLOTS[key]
    local inv = p.components ~= nil and p.components.inventory or nil
    if slot == nil or inv == nil then return "fail", "no_inventory" end
    if j.step == "start" then
        local before = nil
        pcall(function() before = inv:GetEquippedItem(slot) end)
        if before == nil then
            return "done", string.format("%s 上本来就没东西", key)
        end
        j.data.prefab = tostring(before.prefab)
        j.data.slot = slot
        -- ★ 真机 bug（0.35.0）：DST 的 Inventory:Unequip(slot) 只把物品从 equipslots 摘掉
        --   并 **return item**，不会自动放回 itemslots。原版 player_common.lua 也是
        --   `local item = inv:Unequip(...)` 然后自己 GiveItem / 存起来。
        --   我们以前直接丢掉返回值 → 火把被摘下后没进背包，DST 把它丢到地上/销毁。
        --   于是"白天把火把收起来省燃料"变成"火把凭空消失"，夜里 portable=false 直接黑死。
        local ok, item = pcall(function() return inv:Unequip(slot) end)
        if not ok then return "fail", "unequip_failed: " .. tostring(item) end
        if item ~= nil and item:IsValid() then
            -- 装备栏已摘掉，但物品必须显式回到背包。
            -- ★ 别调 GetNextAvailableSlot()：原生签名是 GetNextAvailableSlot(item)，
            --   无参调用会抛错被 pcall 吞掉，实测导致误报 unequip_no_space、火把丢失。
            --   GiveItem(item) 不带 slot 时内部自己会找空位并返回 slot/true。
            local ok_give, res = pcall(function() return inv:GiveItem(item) end)
            local given = ok_give and res ~= nil and res ~= false
            if not given then
                -- 兜底：塞进 activeitem（ForEachItem 也会遍历到），总比让物品消失好
                pcall(function() inv:SetActiveItem(item) end)
            end
        end
        j.step = "acting"
        j.data.phase_start = U.now()
        return "run"
    end
    if j.step == "acting" then
        local now = nil
        pcall(function() now = inv:GetEquippedItem(slot) end)
        if now == nil then
            -- 必须核对物品真的进了背包（ForEachItem 会同时遍历 itemslots / equipslots / activeitem）
            local in_bag = false
            pcall(function()
                inv:ForEachItem(function(it)
                    if it ~= nil and tostring(it.prefab or "") == j.data.prefab then in_bag = true end
                end)
            end)
            if not in_bag then
                return "fail", string.format("unequip_failed: %s 没在背包里", j.data.prefab)
            end
            return "done", string.format("把 %s 放回背包了", j.data.prefab)
        end
        if U.now() - j.data.phase_start > 5 then
            return "fail", "unequip_failed: 装备栏没变化"
        end
        return "run"
    end
    return "run"
end

JOBS.unequip = function(j, p)
    local ctx = j.ctx or {}
    if ctx.survival_unequip == true then
        return unequip_by_slot(j, p, ctx.slot)
    end
    -- 旧路径（如果以后有人用 args.slot）
    return unequip_by_slot(j, p, j.args.slot or "hands")
end

JOBS.drop = function(j, p)
    local ctx = j.ctx or {}
    if ctx.survival_drop == true then return drop_by_ref(j, p, ctx.item) end
    local want = j.args.item
    if want == nil or want == "" then return "fail", "drop 要传 item" end
    local item = U.find_item(p, want)
    if item == nil then return "fail", "背包里没有 " .. tostring(want) end
    local inv = p.components.inventory
    if inv == nil then return "fail", "没有背包" end
    local count = tonumber(j.args.count)
    local ok, err = pcall(function()
        if count ~= nil and count < U.count(item) and item.components.stackable ~= nil then
            inv:DropItem(item) -- 简单起见整摞丢掉
        else
            inv:DropItem(item)
        end
    end)
    if not ok then return "fail", "丢不出去：" .. tostring(err) end
    return "done", "丢掉了 " .. U.pretty(item) .. (count ~= nil and ("×" .. count) or "")
end

JOBS.eat = function(j, p)
    local ctx = j.ctx or {}
    -- 新路径：白名单 + 服务端挑目标（ctx.food = 模型指定的 prefab，可为 nil = 自动挑）
    if ctx.survival_eat == true then
        local rules = Whale ~= nil and Whale.eatrules or nil
        if rules == nil then return "fail", "eat_rules_missing" end
        local inv = p.components ~= nil and p.components.inventory or nil
        if inv == nil then return "fail", "no_inventory: 角色没有背包" end

        if j.step == "start" then
            local item = nil
            if ctx.food ~= nil and ctx.food ~= "" then
                local ok_p, why_p = rules.IsAllowedPrefab(tostring(ctx.food))
                if not ok_p then return "fail", (why_p or "food_not_allowed") .. ": " .. tostring(ctx.food) .. " 不在可吃白名单里" end
                inv:ForEachItem(function(it)
                    if item ~= nil then return end
                    if it ~= nil and it:IsValid() and tostring(it.prefab) == tostring(ctx.food) then
                        if rules.IsEdible(it) then item = it end
                    end
                end)
                if item == nil then return "fail", "not_in_inventory: 背包里没有可吃的 " .. tostring(ctx.food) end
            else
                local hunger = p.components.hunger
                item = rules.PickBest(inv, hunger ~= nil and hunger:GetPercent() >= 0.99)
                if item == nil then return "fail", "no_food: 背包里没有可吃的东西" end
            end
            j.data.prefab = tostring(item.prefab)
            j.data.label = rules.FOODS[item.prefab] or tostring(item.prefab)
            j.data.hunger_before = p.components.hunger ~= nil and p.components.hunger.current or nil
            j.data.before = snapshot_counts(p)
            j.data.phase_start = U.now()
            push(p, BufferedAction(p, nil, ACTIONS.EAT, item))
            j.step = "acting"
            return "run"
        end

        if busy(p) and U.now() - j.data.phase_start < 20 then return "run" end
        local hunger = p.components.hunger ~= nil and p.components.hunger.current or nil
        local delta = (hunger ~= nil and j.data.hunger_before ~= nil) and (hunger - j.data.hunger_before) or nil
        local after = snapshot_counts(p)
        local eaten = (j.data.before[j.data.prefab] or 0) - (after[j.data.prefab] or 0)

        if (delta ~= nil and delta > 0.5) or eaten > 0 then
            local bits = {}
            if delta ~= nil and delta > 0.5 then bits[#bits + 1] = string.format("饥饿 +%d", math.floor(delta)) end
            if eaten > 0 then bits[#bits + 1] = string.format("%s -%d", j.data.prefab, eaten) end
            return "done", string.format("吃了 %s（%s）", j.data.label, table.concat(bits, "，"))
        end
        if U.now() - j.data.phase_start > 20 then
            return "fail", "eat_failed: 吃了但饥饿和背包都没变化"
        end
        return "run"
    end

    -- ── 以下为 SURVIVAL-01 之前的旧路径（reflex 用），语义保持不变 ──
    local item = nil
    if j.args.item ~= nil and j.args.item ~= "" then
        item = U.find_item(p, j.args.item)
        if item == nil then return "fail", "背包里没有 " .. tostring(j.args.item) end
    else
        item = best_food(p)
        if item == nil then return "fail", "背包里没有能吃的东西" end
    end
    if item.components.edible == nil then
        return "fail", U.pretty(item) .. " 不能吃"
    end
    if busy(p) then
        if U.now() - j.t0 > 20 then return "fail", "手上正忙着，没吃上" end
        return "run"
    end
    if j.step == "start" then
        j.data.name = U.describe_item(item)
        j.data.hunger_before = p.components.hunger ~= nil and p.components.hunger.current or nil
        push(p, BufferedAction(p, nil, ACTIONS.EAT, item))
        j.step = "acting"
        j.data.phase_start = U.now()
        return "run"
    end
    if busy(p) and U.now() - j.data.phase_start < 20 then return "run" end
    local hunger = p.components.hunger ~= nil and p.components.hunger.current or nil
    local delta = (hunger ~= nil and j.data.hunger_before ~= nil) and (hunger - j.data.hunger_before) or nil
    if delta ~= nil and delta > 0.5 then
        return "done", string.format("吃了 %s，饥饿 +%d", j.data.name, math.floor(delta))
    end
    return "done", "吃了 " .. j.data.name
end

JOBS.equip = function(j, p)
    local ctx = j.ctx or {}
    if ctx.survival_equip == true then
        local rules = Whale ~= nil and Whale.equiprules or nil
        if rules == nil then return "fail", "equip_rules_missing" end
        local name = tostring(ctx.item or "")
        local ok_p, why_p = rules.IsAllowedPrefab(name)
        if not ok_p then return "fail", (why_p or "item_not_equippable") .. ": " .. name .. "（只开放 " .. table.concat(rules.ItemList(), "/") .. "）" end

        local inv = p.components ~= nil and p.components.inventory or nil
        if inv == nil then return "fail", "no_inventory: 角色没有背包" end

        local item = rules.FindInInventory(inv, name)
        if item == nil then return "fail", "not_in_inventory: 背包里没有 " .. name end
        local ok_e, why_e = rules.IsEquippable(item)
        if not ok_e then return "fail", (why_e or "item_not_equippable") end

        if j.step == "start" then
            j.data.name = name
            j.data.label = rules.ITEMS[name] or name
            j.data.hand_before = rules.EquippedItem(p, name)
            j.data.phase_start = U.now()
            local ok_eq, err = pcall(function() inv:Equip(item) end)
            if not ok_eq then return "fail", "equip_failed: " .. tostring(err) end
            j.step = "acting"
            return "run"
        end

        local hand = rules.EquippedItem(p, name)
        if hand ~= nil and tostring(hand.prefab) == name then
            local prev = j.data.hand_before
            local prev_name = prev ~= nil and tostring(prev.prefab) or nil
            if prev_name ~= nil and prev_name ~= name then
                return "done", string.format("换上了 %s（原来的 %s 收回背包）", j.data.label, prev_name)
            end
            return "done", string.format(name == "minerhat" and "戴上了：%s" or "拿在手里了：%s", j.data.label)
        end
        if U.now() - j.data.phase_start > 10 then
            return "fail", "equip_failed: 装备栏没有变化"
        end
        return "run"
    end

    -- ── 旧路径（reflex 用），语义不变 ──
    local want = j.args.item
    if want == nil or want == "" then return "fail", "equip 要传 item（要拿在手里的东西）" end
    local item = U.find_item(p, want)
    if item == nil then return "fail", "背包里没有 " .. tostring(want) end
    local inv = p.components.inventory
    if inv == nil then return "fail", "没有背包" end
    local ok, err = pcall(function() inv:Equip(item) end)
    if not ok then return "fail", "装备不上：" .. tostring(err) end
    return "done", "把 " .. U.describe_item(item) .. " 拿在手里了"
end

--- 给火堆加燃料（需要 #N 引用指向火堆；燃料从背包挑，或指定白名单）
JOBS.fuel = function(j, p)
    local ctx = j.ctx or {}
    local target = ctx.target
    if target == nil then return "fail", "fuel 只能按 #N 引用调用" end
    if not target:IsValid() then return "fail", "entity_gone: 火堆已经没了" end
    local fueled = target.components ~= nil and target.components.fueled or nil
    if fueled == nil then return "fail", "target_not_fuelable: 这个东西不能加柴" end

    if j.step == "start" then
        -- 选燃料：指定了就用指定的，否则自动挑最好的
        local want = ctx.fuel_item
        local item = nil
        if want ~= nil and want ~= "" then
            item = U.find_item(p, want)
            if item == nil then return "fail", "not_in_inventory: 背包里没有 " .. tostring(want) end
        else
            item = best_fuel(p, nil)
            if item == nil then return "fail", "no_fuel: 背包里没有能烧的东西（木头、草、树枝都行）" end
        end
        j.data.fuel = item
        j.data.fuel_prefab = tostring(item.prefab)
        j.data.before = snapshot_counts(p)
        j.data.phase_start = U.now()
        push(p, BufferedAction(p, target, ACTIONS.ADDFUEL, item))
        j.step = "acting"
        return "run"
    end

    if j.step == "acting" then
        local still = j.data.fuel ~= nil and j.data.fuel:IsValid()
        local after = snapshot_counts(p)
        local used = (j.data.before[j.data.fuel_prefab] or 0) - (after[j.data.fuel_prefab] or 0)
        if (not still) or used > 0 then
            return "done", string.format("添了柴：%s×%d", j.data.fuel_prefab, math.max(used, 1))
        end
        if U.now() - j.data.phase_start > 20 then
            return "fail", "fuel_failed: 燃料没消耗（可能这团火已经灭了）"
        end
        return "run"
    end
    return "run"
end

JOBS.add_fuel = function(j, p)
    if j.step == "start" then
        local fire = U.find_nearest(p, tonumber(j.args.radius) or 12, { "fire" }, nil, function(e)
            local fueled = e.components ~= nil and e.components.fueled or nil
            return fueled ~= nil and not fueled:IsEmpty()
        end)
        if fire == nil then
            return "fail", "附近没有烧着的火堆（营火/火坑）—— 火灭了要先重新生火"
        end
        local fuel = best_fuel(p, j.args.item)
        if fuel == nil then
            return "fail", j.args.item ~= nil and ("背包里没有 " .. tostring(j.args.item))
                or "背包里没有能烧的东西（木头/树枝/草/木炭）"
        end
        if busy(p) then
            if U.now() - j.t0 > 20 then return "fail", "手上忙着，没添上柴" end
            return "run"
        end
        local fueled = fire.components.fueled
        local before = fueled ~= nil and fueled:GetPercent() or nil
        j.data.name = U.pretty(fuel)
        j.data.fire = fire
        j.data.before = before
        push(p, BufferedAction(p, fire, ACTIONS.ADDFUEL, fuel))
        j.data.phase_start = U.now()
        j.step = "acting"
        return "run"
    end
    if busy(p) and U.now() - j.data.phase_start < 20 then return "run" end
    local fueled = j.data.fire ~= nil and j.data.fire:IsValid() and j.data.fire.components.fueled or nil
    local after = fueled ~= nil and fueled:GetPercent() or nil
    if after ~= nil and j.data.before ~= nil then
        return "done", string.format("往火里添了 %s，燃料 %d%% → %d%%",
            j.data.name, math.floor(j.data.before * 100), math.floor(after * 100))
    end
    return "done", "添了 " .. j.data.name .. "（火盆可能已经灭了）"
end

JOBS.make_fire = function(j, p)
    -- 复用同一 j 的状态机直接 build（campfire/firepit 都是 placer 建筑，build 才正确；
    -- 不要再退回 JOBS.craft —— 对 placer 建筑 craft 会立刻转发回 job_build，造成重复尝试）。
    if j.data == nil then j.data = {} end
    if j.args.recipe == nil then j.args.recipe = "campfire" end
    return JOBS.build(j, p)
end

JOBS.wait = function(j, p)
    local seconds = tonumber(j.args.seconds) or 3
    local health = p.components ~= nil and p.components.health or nil
    if j.step == "start" then
        j.step = "acting"
        j.data.until_time = U.now() + seconds
        j.data.hp_start = health ~= nil and health.currenthealth or nil
    end
    local dark = Whale.reflex ~= nil and Whale.reflex.DarkNoLight ~= nil and Whale.reflex.DarkNoLight(p) or nil
    if dark ~= nil then
        if dark.in_bag then
            return "fail", "dark_no_light: 天黑了身边没光，查理会打你、理智狂掉。马上 equip " .. dark.item
        end
        return "fail", "dark_no_light: 天黑了身边没光，查理会打你。马上 craft torch（2草+2树枝）或 craft campfire"
    end
    local hp_now = health ~= nil and health.currenthealth or nil
    if j.data.hp_start ~= nil and hp_now ~= nil and hp_now < j.data.hp_start - 0.5 then
        return "fail", string.format("took_damage: 等的时候掉血了（%.0f→%.0f），别再干等，先 get_state 看谁在打你", j.data.hp_start, hp_now)
    end
    if U.now() >= j.data.until_time then
        return "done", string.format("等了 %.0f 秒", seconds)
    end
    return "run"
end

JOBS.heal = function(j, p)
    if j.step == "start" then
        local hp = p.components.health
        if hp == nil then return "fail", "现在没有生命数据" end
        if hp:IsDead() then return "fail", "已经死了，吃东西救不回来" end

        local item = nil
        if j.args.item ~= nil and j.args.item ~= "" then
            item = U.find_item(p, j.args.item)
            if item == nil then return "fail", "背包里没有 " .. tostring(j.args.item) end
        else
            -- 优先治疗类（药膏/蜘蛛腺体/蜂蜜药膏），没有就吃东西回血
            local inv = p.components.inventory
            if inv ~= nil then
                inv:ForEachItem(function(it)
                    if item == nil and it.components.healer ~= nil then item = it end
                end)
            end
            if item == nil then item = best_food(p) end
            if item == nil then return "fail", "背包里没有能回血的东西（治疗药膏/蜘蛛腺体/吃的）" end
        end
        if busy(p) then
            if U.now() - j.t0 > 20 then return "fail", "手上忙着，没吃上药" end
            return "run"
        end
        j.data.item = item
        j.data.name = U.pretty(item)
        j.data.before = hp.currenthealth
        if item.components.healer ~= nil then
            push(p, BufferedAction(p, p, ACTIONS.HEAL, item))
        else
            push(p, BufferedAction(p, nil, ACTIONS.EAT, item))
        end
        j.data.phase_start = U.now()
        j.step = "acting"
        return "run"
    end
    if busy(p) and U.now() - j.data.phase_start < 20 then return "run" end
    local hp = p.components.health
    local now = hp ~= nil and hp.currenthealth or nil
    if now ~= nil and j.data.before ~= nil and now - j.data.before > 0.5 then
        return "done", string.format("用了 %s，生命 %d → %d", j.data.name,
            math.floor(j.data.before), math.floor(now))
    end
    return "done", "用了 " .. j.data.name .. "（血量没明显变化）"
end

JOBS.sleep = function(j, p)
    if j.step == "start" then
        -- 优先用背包里的睡袋 / 帐篷
        local bag = nil
        local inv = p.components.inventory
        if inv ~= nil then
            inv:ForEachItem(function(item)
                if bag == nil and item.components.sleepingbag ~= nil then bag = item end
            end)
        end
        local target = nil
        if bag == nil then
            target = U.find_nearest(p, tonumber(j.args.radius) or 20, nil, nil, function(e)
                return e.components ~= nil and e.components.sleepingbag ~= nil
            end)
        end
        if bag == nil and target == nil then
            return "fail", "no_sleepingbag: 附近没有帐篷/睡袋（饥荒里没有\"睡到天亮\"这种通用办法：要有帐篷、睡袋或者床）"
        end
        if busy(p) then
            if U.now() - j.t0 > 30 then return "fail", "忙着，没睡成" end
            return "run"
        end
        j.data.name = bag ~= nil and U.pretty(bag) or U.pretty(target)
        push(p, BufferedAction(p, target, ACTIONS.SLEEPIN, bag))
        j.data.phase_start = U.now()
        j.data.slept = false
        j.step = "acting"
        return "run"
    end
    local sleeping = p.sg ~= nil and p.sg:HasStateTag("sleeping")
    if sleeping then
        j.data.slept = true
        -- 睡觉可能要好几分钟，别超时
        if U.now() - j.data.phase_start > 900 then return "fail", "睡了太久还没醒" end
        return "run"
    end
    if j.data.slept then
        return "done", "醒了（用 " .. j.data.name .. " 睡的）"
    end
    if U.now() - j.data.phase_start > 15 then
        return "fail", "没睡上（" .. j.data.name .. " 可能要两个人/晚上/耐久）"
    end
    return "run"
end

return A
