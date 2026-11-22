-- 交互动作：use, container_take, container_put, give, inspect, say, store, take, act, list_actions
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall or pcall
local tonumber = GLOBAL.tonumber or tonumber
local tostring = tostring or (GLOBAL and GLOBAL.tostring)

local ACTIONS = GLOBAL.ACTIONS
local Vector3 = GLOBAL.Vector3
local BufferedAction = GLOBAL.BufferedAction

local U = Whale.util

Whale = Whale or {}
Whale.actions = Whale.actions or {}
local A = Whale.actions
A.JOBS = A.JOBS or {}
local JOBS = A.JOBS

local busy = A.busy
local push = A.push
local find_container = A.find_container
local find_by_name = A.find_by_name
local snapshot_counts = A.snapshot_counts

--- 通用交互：对目标尝试这几个动作之一
--- 只允许这几个（不给模型任意 ACTIONS 名字）
---
--- ⚠️ 这份名单**必须是游戏 ACTIONS 表里真实存在的**。
--- 真机核对（docs/reference/动作表.md，由 tools/dump-reference.mjs 从游戏本体导出）：
---   ✅ ACTIVATE / ACTIVATE_CONTAINER / READ / PICKUP / PICK / OPEN_CRAFTING / CLOSESPELLBOOK
---   ❌ OPEN / CLOSE / USE / TAKEITEM —— **游戏里没有这几个动作**
--- 旧实现的白名单里写了 OPEN/USE/TAKEITEM/CLOSE，照抄会得到"动作不存在"，已修正。
local USE_ALLOWED = {
    "ACTIVATE",           -- 通用激活（科学机器、帐篷、天体探测仪…）
    "ACTIVATE_CONTAINER", -- 打开容器（箱子、冰箱、背包）
    "RUMMAGE",            -- 翻找容器
    "TAKEITEM",           -- 从容器里取出
    "READ",               -- 读书
    "PICKUP",             -- 捡起
    "OPEN_CRAFTING",      -- 打开制作台
}
A.USE_ALLOWED = USE_ALLOWED

JOBS.use = function(j, p)
    local ctx = j.ctx or {}
    local target = ctx.target
    if target == nil then return "fail", "use 只能按 #N 引用调用" end
    if not target:IsValid() then return "fail", "entity_gone: 目标已经没了" end

    if j.step == "start" then
        local want = ctx.use_action
        local chosen = nil
        if want ~= nil and want ~= "" then
            local up = string.upper(tostring(want))
            local allowed = false
            for _, a in ipairs(USE_ALLOWED) do if a == up then allowed = true break end end
            if not allowed then
                return "fail", "action_not_allowed: 只支持 " .. table.concat(USE_ALLOWED, "/")
            end
            if ACTIONS[up] == nil then return "fail", "action_unavailable: 这个版本里没有 " .. up end
            chosen = up
        else
            for _, a in ipairs(USE_ALLOWED) do
                if ACTIONS[a] ~= nil then chosen = a break end
            end
        end
        if chosen == nil then return "fail", "action_unavailable: 这个目标没有能用的动作" end
        j.data.action_id = chosen
        j.data.label = U.pretty(target)
        j.data.phase_start = U.now()
        j.data.before = snapshot_counts(p)
        push(p, BufferedAction(p, target, ACTIONS[chosen], nil))
        j.step = "acting"
        return "run"
    end

    if j.step == "acting" then
        local after = snapshot_counts(p)
        -- 交互成功的判据：背包变了 / 目标消失 / 超时前游戏没报错
        local changed = false
        for prefab, n in pairs(after) do
            if n > (j.data.before[prefab] or 0) then changed = true break end
        end
        if changed then
            return "done", string.format("%s 了 %s", j.data.action_id, j.data.label)
        end
        if not target:IsValid() then
            return "done", string.format("%s 了 %s（目标消失了）", j.data.action_id, j.data.label)
        end
        if U.now() - j.data.phase_start > 8 then
            return "done", string.format("对 %s 用了 %s（没有可见变化）", j.data.label, j.data.action_id)
        end
        return "run"
    end
    return "run"
end

--- 查看一个目标的详细信息（只读，不改世界）
JOBS.inspect = function(j, p)
    local ctx = j.ctx or {}
    local target = ctx.target
    if target == nil or not target:IsValid() then return "fail", "entity_gone: 目标已经没了" end
    local lines = { string.format("%s（%s）", U.pretty(target), tostring(target.prefab)) }
    local x, _, z = U.pos(target)
    if x ~= nil then
        lines[#lines + 1] = string.format("位置 (%.1f, %.1f)，离你 %.1f 格", x, z, (U.dist(p, target) or 0) / 4)
    end
    local comps = target.components or {}
    if comps.health ~= nil then
        local cur = U.try(function() return comps.health.currenthealth end) or 0
        local max = U.try(function() return comps.health.maxhealth end) or 0
        lines[#lines + 1] = string.format("生命 %d/%d", cur, max)
    end
    if comps.edible ~= nil then
        lines[#lines + 1] = string.format("能吃：饥饿 +%d", math.floor(tonumber(comps.edible.hungervalue or 0)))
    end
    if comps.workable ~= nil then
        local left = U.try(function() return comps.workable.workleft end)
        if left ~= nil then lines[#lines + 1] = string.format("还要干 %d 下", left) end
    end
    if comps.pickable ~= nil then
        local can = U.try(function() return comps.pickable:CanBePicked() end)
        lines[#lines + 1] = can == true and "现在能采" or "现在不能采"
    end
    if comps.fueled ~= nil then
        local pct = U.try(function() return comps.fueled:GetPercent() end)
        if pct ~= nil then lines[#lines + 1] = string.format("燃料 %d%%", math.floor(pct * 100)) end
    end
    return "done", table.concat(lines, "；")
end

--- 在游戏里说一句话（人类玩家看得到）
JOBS.say = function(j, p)
    local ctx = j.ctx or {}
    local text = tostring(ctx.text or j.args.text or "")
    if text == "" then return "fail", "say 要传 text" end
    if j.step == "start" then
        pcall(function() GLOBAL.TheNet:Announce(text) end)
        local talker = p.components ~= nil and p.components.talker or nil
        if talker ~= nil then
            pcall(function() talker:Say(text, 3) end)
        end
        return "done", "说了：" .. text
    end
    return "done", "说了"
end

--- 从容器里拿东西 / 往容器里放东西（共用一套逻辑）
local function container_by_ref(j, p, box, take, item_name, count)
    if box == nil or not box:IsValid() then return "fail", "entity_gone: 容器已经没了" end
    local container = box.components ~= nil and box.components.container or nil
    if container == nil then return "fail", "target_not_container: 这个东西不是容器" end
    local inv = p.components ~= nil and p.components.inventory or nil
    if inv == nil then return "fail", "no_inventory" end

    if j.step == "start" then
        j.data.label = U.pretty(box)
        j.data.before = snapshot_counts(p)
        j.data.phase_start = U.now()
        if take then
            -- 从容器里拿：按名字找，没指定就拿第一个
            local entries = {}
            pcall(function()
                local items = container:GetItems()
                for _, item in ipairs(items or {}) do
                    if item ~= nil and item:IsValid() then
                        entries[#entries + 1] = {
                            item = item,
                            prefab = tostring(item.prefab),
                            count = U.count(item),
                        }
                    end
                end
            end)
            if #entries == 0 then return "fail", "container_empty: 箱子是空的" end
            local picked = nil
            if item_name ~= nil and item_name ~= "" then
                for _, e in ipairs(entries) do
                    if e.prefab == tostring(item_name) then picked = e break end
                end
                if picked == nil then
                    return "fail", "not_in_container: 箱子里没有 " .. tostring(item_name)
                end
            else
                picked = entries[1]
            end
            j.data.prefab = picked.prefab
            local want = math.min(tonumber(count) or picked.count, picked.count)
            j.data.want = want
            local ok = pcall(function()
                -- P1-2：按 count 拆分，别无论传几都整组拿走（wholestack=true）。
                if want < picked.count and picked.item.components ~= nil and picked.item.components.stackable ~= nil then
                    local take = picked.item.components.stackable:Get(want)
                    if take ~= nil then inv:GiveItem(take, nil, p:GetPosition()) end
                else
                    container:RemoveItem(picked.item, true)
                    inv:GiveItem(picked.item, nil, p:GetPosition())
                end
            end)
            if not ok then return "fail", "container_take_failed" end
            j.step = "acting"
            return "run"
        end
        -- 往容器里放
        if item_name == nil or item_name == "" then return "fail", "container_put 需要 item" end
        local item = U.find_item(p, item_name)
        if item == nil then return "fail", "not_in_inventory: 背包里没有 " .. tostring(item_name) end
        j.data.prefab = tostring(item.prefab)
        local ok = pcall(function()
            -- P1-2：放进容器前先从玩家背包移除，避免归属异常/双持有。
            local ii = item.components ~= nil and item.components.inventoryitem or nil
            if ii ~= nil and ii.RemoveFromOwner ~= nil then ii:RemoveFromOwner() end
            container:GiveItem(item, nil, p:GetPosition())
        end)
        if not ok then return "fail", "container_put_failed" end
        j.step = "acting"
        return "run"
    end

    if j.step == "acting" then
        local after = snapshot_counts(p)
        local before = j.data.before[j.data.prefab] or 0
        local now = after[j.data.prefab] or 0
        local delta = now - before
        if take and delta > 0 then
            return "done", string.format("从 %s 拿出了 %s×%d", j.data.label, j.data.prefab, delta)
        end
        if (not take) and delta < 0 then
            return "done", string.format("把 %s×%d 放进了 %s", j.data.prefab, -delta, j.data.label)
        end
        if U.now() - j.data.phase_start > 8 then
            return "fail", string.format("%s_failed: 背包里 %s 的数量没变", take and "container_take" or "container_put", j.data.prefab)
        end
        return "run"
    end
    return "run"
end

JOBS.container_take = function(j, p)
    local ctx = j.ctx or {}
    if ctx.target == nil then return "fail", "container_take 只能按 #N 引用调用" end
    return container_by_ref(j, p, ctx.target, true, ctx.item, ctx.count)
end

JOBS.container_put = function(j, p)
    local ctx = j.ctx or {}
    if ctx.target == nil then return "fail", "container_put 只能按 #N 引用调用" end
    return container_by_ref(j, p, ctx.target, false, ctx.item, ctx.count)
end

--- 把背包里的东西给某个目标（猪人、鸟、队友…）
JOBS.give = function(j, p)
    local ctx = j.ctx or {}
    local target = ctx.target
    if target == nil then return "fail", "give 只能按 #N 引用调用" end
    if not target:IsValid() then return "fail", "entity_gone: 目标已经没了" end

    if j.step == "start" then
        local want = ctx.item
        if want == nil or want == "" then return "fail", "give 需要 item" end
        local item = U.find_item(p, want)
        if item == nil then return "fail", "not_in_inventory: 背包里没有 " .. tostring(want) end
        j.data.prefab = tostring(item.prefab)
        j.data.label = U.pretty(target)
        j.data.before = snapshot_counts(p)
        j.data.phase_start = U.now()
        push(p, BufferedAction(p, target, ACTIONS.GIVE, item))
        j.step = "acting"
        return "run"
    end

    if j.step == "acting" then
        local after = snapshot_counts(p)
        local used = (j.data.before[j.data.prefab] or 0) - (after[j.data.prefab] or 0)
        if used > 0 then
            return "done", string.format("把 %s×%d 给了 %s", j.data.prefab, used, j.data.label)
        end
        if U.now() - j.data.phase_start > 10 then
            return "fail", "give_failed: 东西还在背包里（它可能不要这个）"
        end
        return "run"
    end
    return "run"
end

JOBS.store = function(j, p)
    local item = U.find_item(p, j.args.item)
    if item == nil then return "fail", "背包里没有 " .. tostring(j.args.item or "?") end
    local chest = find_container(p, tonumber(j.args.radius) or 10, j.args.container)
    if chest == nil then return "fail", "附近没有箱子/冰箱这类容器" end
    local container = chest.components.container
    local ok = pcall(function()
        if item.components.inventoryitem ~= nil then
            item.components.inventoryitem:RemoveFromOwner()
        end
        container:GiveItem(item, nil, p:GetPosition())
    end)
    if not ok then return "fail", "放不进 " .. U.pretty(chest) end
    return "done", string.format("把 %s 放进 %s 了", U.pretty(item), U.pretty(chest))
end

JOBS.take = function(j, p)
    local chest = find_container(p, tonumber(j.args.radius) or 10, j.args.container)
    if chest == nil then return "fail", "附近没有箱子/冰箱这类容器" end
    local container = chest.components.container
    local want = j.args.item
    local found = nil
    local slots = 0
    pcall(function() slots = container:GetNumSlots() end)
    for slot = 1, math.max(slots, 1) do
        local it = container:GetItemInSlot(slot)
        if it ~= nil then
            if want == nil or want == "" then
                found = it
                break
            end
            local prefab = string.lower(tostring(it.prefab or ""))
            if string.find(prefab, string.lower(tostring(want)), 1, true) ~= nil then
                found = it
                break
            end
        end
    end
    if found == nil then
        return "fail", string.format("%s 里没有 %s", U.pretty(chest), want ~= nil and tostring(want) or "东西")
    end
    local name = U.pretty(found)
    pcall(function()
        container:RemoveItem(found, true)
        p.components.inventory:GiveItem(found, nil, p:GetPosition())
    end)
    return "done", string.format("从 %s 里拿出 %s", U.pretty(chest), name)
end

JOBS.act = function(j, p)
    if j.step == "start" then
        local want = string.upper(tostring(j.args.action or ""))
        local action = GLOBAL.ACTIONS[want]
        if action == nil then
            local near = {}
            for k in pairs(GLOBAL.ACTIONS) do
                if type(k) == "string" and (want == "" or string.find(k, want, 1, true) ~= nil) then
                    near[#near + 1] = k
                end
            end
            table.sort(near)
            return "fail", string.format("游戏里没有叫 %s 的动作。相近的：%s（用 list_actions 看全部）",
                tostring(j.args.action), #near > 0 and table.concat(near, "、", 1, math.min(#near, 12)) or "（没有相近的）")
        end

        local target, pos = nil, nil
        if j.args.x ~= nil and j.args.z ~= nil then
            local cx, cz = U.tile_center(tonumber(j.args.x), tonumber(j.args.z))
            pos = Vector3(cx, 0, cz)
        elseif j.args.target ~= nil and j.args.target ~= "" then
            local list = find_by_name(p, tonumber(j.args.radius) or 20, j.args.target)
            if #list == 0 then return "fail", string.format("附近没有 %s", tostring(j.args.target)) end
            target = list[1].ent
        end

        local item = nil
        if j.args.item ~= nil and j.args.item ~= "" then
            item = U.find_item(p, j.args.item)
            if item == nil then return "fail", "背包里没有 " .. tostring(j.args.item) end
        end

        if busy(p) then
            if U.now() - j.t0 > 20 then return "fail", "手上还忙着，这个动作没开始" end
            return "run"
        end

        j.data.label = want
        j.data.target_name = target ~= nil and U.pretty(target) or nil
        push(p, BufferedAction(p, target, action, item, pos))
        j.data.phase_start = U.now()
        j.step = "acting"
        return "run"
    end

    if busy(p) then
        if U.now() - j.data.phase_start > 60 then return "fail", "这个动作做了 60 秒还没结束" end
        return "run"
    end
    local where = j.data.target_name ~= nil and ("（" .. j.data.target_name .. "）") or ""
    return "done", "做了 " .. tostring(j.data.label) .. where
end

JOBS.list_actions = function(j, p)
    local want = j.args ~= nil and string.upper(tostring(j.args.filter or "")) or ""
    local names = {}
    for k, v in pairs(GLOBAL.ACTIONS) do
        if type(k) == "string" and v ~= nil and (want == "" or string.find(k, want, 1, true) ~= nil) then
            names[#names + 1] = k
        end
    end
    table.sort(names)
    if #names == 0 then
        return "done", "没有匹配 «" .. tostring(j.args.filter) .. "» 的动作"
    end
    return "done", string.format("游戏里有 %d 个动作：\n%s\n（做的时候用 act {\"action\":\"名字\", \"target\":\"东西名或坐标\", \"item\":\"背包里的东西\"}）",
        #names, table.concat(names, " "))
end

return A
