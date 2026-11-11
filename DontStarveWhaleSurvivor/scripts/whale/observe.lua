-- 把游戏状态翻译成给 AI 看的纯文字
-- 原则：只写模型能用来做决定的东西（在哪、有什么、能干什么、有什么危险），不写坐标细节以外的废话。
local GLOBAL = GLOBAL
local U = Whale.util
local O = {}

local ACTIONS = GLOBAL.ACTIONS
local EQUIPSLOTS = GLOBAL.EQUIPSLOTS

local PHASE_NAMES = { day = "白天", dusk = "黄昏", night = "夜晚" }
local SEASON_NAMES = { autumn = "秋季", winter = "冬季", spring = "春季", summer = "夏季" }

local function num(v)
    if v == nil then return "?" end
    return string.format("%d", math.floor(v))
end

local function pct(a, b)
    if a == nil or b == nil or b <= 0 then return nil end
    return math.floor(a / b * 100)
end

local function where(ent)
    local x, _, z = U.pos(ent)
    if x == nil then return "(?)" end
    local tx, tz = U.tile_of(x, z)
    return "(" .. tx .. "," .. tz .. ")"
end

local function name_of(ent)
    return U.pretty(ent)
end

-- ─────────────────────────── 玩家 ───────────────────────────

local function character_name(p)
    local names = GLOBAL.STRINGS and GLOBAL.STRINGS.CHARACTER_NAMES
    local key = p.prefab and string.upper(p.prefab)
    if names ~= nil and key ~= nil and names[key] ~= nil then return names[key] end
    return name_of(p)
end

local function stat_line(label, comp, current_field, max_field)
    if comp == nil then return nil end
    local cur = comp[current_field]
    local max = comp[max_field]
    if cur == nil or max == nil then return nil end
    return string.format("%s %s/%s", label, num(cur), num(max))
end

local function player_section(p)
    local lines = {}
    local pieces = { character_name(p) }
    for _, item in ipairs({
        stat_line("生命", p.components.health, "currenthealth", "maxhealth"),
        stat_line("饥饿", p.components.hunger, "current", "max"),
        stat_line("理智", p.components.sanity, "current", "max"),
    }) do
        if item ~= nil then pieces[#pieces + 1] = item end
    end
    lines[#lines + 1] = "你：" .. table.concat(pieces, "  ")

    local tx, tz = U.tile_of(U.pos(p))
    lines[#lines + 1] = "位置：(" .. tx .. "," .. tz .. ")"

    -- 手 / 身体 / 头
    local inv = p.components.inventory
    if inv ~= nil then
        local hands = inv:GetEquippedItem(EQUIPSLOTS.HANDS)
        local body = inv:GetEquippedItem(EQUIPSLOTS.BODY)
        local head = inv:GetEquippedItem(EQUIPSLOTS.HEAD)
        local worn = {}
        worn[#worn + 1] = "手持：" .. (hands ~= nil and U.describe_item(hands) or "空手")
        if head ~= nil then worn[#worn + 1] = "头：" .. U.describe_item(head) end
        if body ~= nil then worn[#worn + 1] = "身：" .. U.describe_item(body) end
        lines[#lines + 1] = table.concat(worn, "  ")

        -- 背包
        local slots = 0
        local items = {}
        local pcall_ok = pcall(function() slots = inv:GetNumSlots() end)
        if not pcall_ok then slots = 15 end
        for slot = 1, slots do
            local item = inv:GetItemInSlot(slot)
            if item ~= nil then items[#items + 1] = U.describe_item(item) end
        end
        table.sort(items)
        local capacity = slots
        lines[#lines + 1] = "背包（" .. #items .. "/" .. capacity .. " 格）："
            .. (#items > 0 and table.concat(items, "、") or "空")
    end

    -- 环境
    local temps = {}
    if p.components.temperature ~= nil then
        local t = p.components.temperature:GetCurrent()
        if t ~= nil then temps[#temps + 1] = string.format("体温 %.0f°", t) end
    end
    if p.components.moisture ~= nil then
        local wet = p.components.moisture:GetMoisture()
        if wet ~= nil and wet > 0 then temps[#temps + 1] = string.format("潮湿 %d%%", math.floor(wet / 100 * 100)) end
    end
    if p.components.beaverness ~= nil then
        temps[#temps + 1] = string.format("变身值 %d%%", math.floor((p.components.beaverness:GetPercent() or 0) * 100))
    end
    if #temps > 0 then lines[#lines + 1] = "身体：" .. table.concat(temps, "  ") end

    return lines
end

-- ─────────────────────────── 世界 ───────────────────────────

local function world_section(p)
    local world = GLOBAL.TheWorld
    local state = world ~= nil and world.state or nil
    local pieces = {}
    if state ~= nil then
        local day = state.cycles ~= nil and (state.cycles + 1) or nil
        if day ~= nil then pieces[#pieces + 1] = "第" .. num(day) .. "天" end
        local phase = PHASE_NAMES[state.phase or ""]
        if phase ~= nil then pieces[#pieces + 1] = phase end
        local season = SEASON_NAMES[state.season or ""]
        if season ~= nil then pieces[#pieces + 1] = season end
        if state.temperature ~= nil then
            pieces[#pieces + 1] = string.format("%.0f°", state.temperature)
        end
        if state.israining then pieces[#pieces + 1] = "在下雨" end
        if state.iswinter then pieces[#pieces + 1] = "寒冷" end
        if state.isfullmoon then pieces[#pieces + 1] = "满月" end
    end
    local lines = {}
    lines[#lines + 1] = "世界：" .. (pieces ~= nil and #pieces > 0 and table.concat(pieces, " · ") or "读取中")
    if GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld:HasTag("cave") then
        lines[#lines + 1] = "你在洞穴里（上面就是地面世界）"
    end
    return lines
end

-- ─────────────────────────── 周边 ───────────────────────────

local function workable_is(ent, action)
    local w = ent.components ~= nil and ent.components.workable or nil
    if w == nil then return false end
    if w.action == nil then return false end
    return action ~= nil and w.action.id == action
end

local function entries_filtered(list, limit, extra)
    local out = {}
    for i = 1, math.min(#list, limit or 6) do
        local e = list[i].ent
        local d = math.floor(list[i].d / U.TILE * 10 + 0.5) / 10
        local text = name_of(e) .. where(e) .. " 距" .. d
        if extra ~= nil then
            local more = extra(e)
            if more ~= nil then text = text .. " " .. more end
        end
        out[#out + 1] = text
    end
    return out
end

local function nearby_section(p, radius)
    local lines = {}
    local function add(label, list, limit, extra)
        if list ~= nil and #list > 0 then
            local text = entries_filtered(list, limit, extra)
            lines[#lines + 1] = "  " .. label .. "：" .. table.concat(text, "；")
                .. (#list > (limit or 6) and string.format("（还有 %d 个）", #list - (limit or 6)) or "")
        end
    end

    local pickables = U.find_all(p, radius, nil, nil, function(e)
        if e.components == nil then return false end
        if e.components.pickable ~= nil then
            return e.components.pickable:CanBePicked()
        end
        if e.components.harvestable ~= nil then
            return e.components.harvestable:CanBeHarvested()
        end
        return false
    end)
    add("可采", pickables, 6)

    local ground_items = U.find_all(p, radius, { "pickable" }, nil, function(e)
        if e.components == nil or e.components.inventoryitem == nil then return false end
        local owner = e.components.inventoryitem.owner
        return owner == nil
    end)
    add("可捡", ground_items, 6, function(e)
        local n = U.count(e)
        return n > 1 and ("×" .. n) or nil
    end)

    local trees = U.find_all(p, radius, nil, nil, function(e)
        return workable_is(e, "CHOP")
    end)
    add("可砍", trees, 5)

    local rocks = U.find_all(p, radius, nil, nil, function(e)
        return workable_is(e, "MINE")
    end)
    add("可挖矿", rocks, 5)

    local diggable = U.find_all(p, radius, nil, nil, function(e)
        return workable_is(e, "DIG")
    end)
    add("可铲", diggable, 3)

    local hammerable = U.find_all(p, radius, nil, nil, function(e)
        return workable_is(e, "HAMMER")
    end)
    add("可拆", hammerable, 3)

    local monsters = U.find_all(p, radius, { "hostile" }, nil, function(e)
        local h = e.components ~= nil and e.components.health or nil
        return h ~= nil and not h:IsDead()
    end)
    add("敌人", monsters, 6, function(e)
        local h = e.components.health
        return string.format("%d/%d血", math.floor(h.currenthealth), math.floor(h.maxhealth))
    end)

    local fires = U.find_all(p, radius, nil, nil, function(e)
        return e.components ~= nil and (e.components.fueled ~= nil and e:HasTag("fire"))
    end)
    add("火堆", fires, 3, function(e)
        local fuel = e.components.fueled
        local percent = fuel ~= nil and fuel.GetPercent ~= nil and fuel:GetPercent() or nil
        if percent == nil then return nil end
        return string.format("燃料 %d%%", math.floor(percent * 100))
    end)

    local structures = U.find_all(p, radius, { "structure" }, nil, function(e)
        return true
    end)
    add("建筑", structures, 5)

    local allies = U.find_all(p, radius + 20, { "player" }, nil, function(e)
        return e ~= p
    end)
    add("队友", allies, 4)

    if #lines == 0 then
        lines[#lines + 1] = "  周围没什么东西"
    end
    return lines
end

-- ─────────────────────────── 提醒 ───────────────────────────

local function warnings_section(p)
    local tips = {}
    local world = GLOBAL.TheWorld
    local state = world ~= nil and world.state or nil

    local health = p.components.health
    if health ~= nil then
        local percent = health:GetPercent()
        if health:IsDead() then
            tips[#tips + 1] = "你已经死了"
        elseif percent ~= nil and percent < 0.35 then
            tips[#tips + 1] = "血只剩 " .. math.floor(percent * 100) .. "%，快吃东西或跑"
        end
    end

    local hunger = p.components.hunger
    if hunger ~= nil then
        local percent = hunger:GetPercent()
        if percent ~= nil and percent < 0.25 then
            tips[#tips + 1] = "快饿死了（" .. math.floor(percent * 100) .. "%），先找吃的"
        end
    end

    local sanity = p.components.sanity
    if sanity ~= nil then
        local percent = sanity:GetPercent()
        if percent ~= nil and percent < 0.2 then
            tips[#tips + 1] = "理智很低，会出现暗影怪"
        end
    end

    if state ~= nil and (state.phase == "night" or state.phase == "dusk") then
        local inv = p.components.inventory
        local hands = inv ~= nil and inv:GetEquippedItem(EQUIPSLOTS.HANDS) or nil
        local lit = hands ~= nil and (hands:HasTag("light") or hands.prefab == "torch" or hands.prefab == "lantern" or hands.prefab == "minerhat")
        local fire = U.find_nearest(p, 8, nil, nil, function(e) return e:HasTag("fire") end)
        if not lit and fire == nil then
            tips[#tips + 1] = (state.phase == "night" and "天黑了又没有光源，查理会来打你" or "快天黑了，先准备火把或火堆")
        end
    end

    local temp = p.components.temperature
    if temp ~= nil then
        local t = temp:GetCurrent()
        if t ~= nil and t < 5 then tips[#tips + 1] = "太冷了（" .. string.format("%.0f", t) .. "°），会掉血" end
        if t ~= nil and t > 65 then tips[#tips + 1] = "太热了（" .. string.format("%.0f", t) .. "°），会中暑" end
    end

    if #tips == 0 then return {} end
    local lines = { "注意：" }
    for _, tip in ipairs(tips) do
        lines[#lines + 1] = "  - " .. tip
    end
    return lines
end

-- ─────────────────────────── 组装 ───────────────────────────

function O.Build(p)
    local lines = {}
    if p == nil then
        return "现在还没有玩家进入世界（游戏可能还在读档）。", { ready = false }
    end
    for _, line in ipairs(world_section(p)) do lines[#lines + 1] = line end
    for _, line in ipairs(player_section(p)) do lines[#lines + 1] = line end
    for _, line in ipairs(warnings_section(p)) do lines[#lines + 1] = line end
    lines[#lines + 1] = "附近（12 格内）："
    for _, line in ipairs(nearby_section(p, 12)) do lines[#lines + 1] = line end

    local x, _, z = U.pos(p)
    local tx, tz = U.tile_of(x, z)
    return table.concat(lines, "\n"), {
        ready = true,
        x = tx,
        z = tz,
        day = GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld.state.cycles or nil,
        phase = GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld.state.phase or nil,
        dead = p.components.health ~= nil and p.components.health:IsDead() or false,
    }
end

function O.Short(p)
    if p == nil then return "没有玩家" end
    local x, _, z = U.pos(p)
    local tx, tz = U.tile_of(x, z)
    local health = p.components.health
    return string.format("%s (%d,%d) 血%d", character_name(p), tx, tz, health ~= nil and math.floor(health.currenthealth) or -1)
end

Whale = Whale or {}
Whale.observe = O
