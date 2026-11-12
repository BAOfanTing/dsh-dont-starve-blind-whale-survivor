-- 把游戏状态翻译成「给 AI 看的结构化数据 + 中文文本」
--
-- 原则（M1.1）：
--   1. 只有一份数据：先建 data（结构化），文本由 O.Render(data) 从 data 生成。
--      绝不单独拼一段"可能和 JSON 不一致"的文字。
--   2. 所有字段都来自真实游戏 API；取不到就记进 data.observer.unavailable_fields，
--      不填 0、不猜、不编。
--   3. 观察对象一律从 Whale.actor 拿（唯一入口），这里不自己去抓玩家实体。
--   4. 贵的东西要缓存：背包只遍历一次；附近实体按 OBSERVER_SCAN_SECONDS 缓存。
local GLOBAL = GLOBAL
-- 饥荒的模组沙箱只给了 pairs/ipairs/print/math/table/type/string/tostring/require/Class，
-- pcall / tonumber / error / os / io 这些得从 GLOBAL（就是 _G）里拿，直接用会报 nil（0.1.0 就是这么崩的）。
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local error = GLOBAL.error
local os = GLOBAL.os or { time = function() return 0 end }
local io = GLOBAL.io

local U = Whale.util
local O = {}

O.SCHEMA = "bws.state/1"

local ACTIONS = GLOBAL.ACTIONS
local EQUIPSLOTS = GLOBAL.EQUIPSLOTS

local PHASE_NAMES = { day = "白天", dusk = "黄昏", night = "夜晚" }
local SEASON_NAMES = { autumn = "秋季", winter = "冬季", spring = "春季", summer = "夏季" }

-- ─────────────────────────── 小工具 ───────────────────────────

--- 读配置（config.lua 可能没加载：单文件测试时会这样，给默认值）
local function cfg(name, default)
    local c = Whale ~= nil and Whale.config or nil
    if c == nil or c.get == nil then return default end
    local ok, value = pcall(c.get, name)
    if not ok or type(value) ~= "number" then return default end
    return value
end

local function num(v)
    if v == nil then return "?" end
    return string.format("%d", math.floor(v))
end

local function pct(a, b)
    if a == nil or b == nil or b <= 0 then return nil end
    return math.floor(a / b * 100)
end

local function stat_block(comp, cur_field, max_field)
    if comp == nil then return nil end
    local cur = comp[cur_field]
    local max = comp[max_field]
    if cur == nil or max == nil then return nil end
    return { current = cur, max = max, percent = pct(cur, max) }
end

local function round1(v)
    if v == nil then return nil end
    return math.floor(v * 10 + 0.5) / 10
end

local function item_block(item, slot)
    if item == nil then return nil end
    local block = {
        prefab = item.prefab,
        name = U.pretty(item),
        count = U.count(item),
    }
    local percent = U.percent(item)
    if percent ~= nil then block.percent = percent end
    if slot ~= nil then block.slot = slot end
    if U.is_food(item) then block.food = true end
    return block
end

-- ─────────────────────────── 观察对象 ───────────────────────────

-- ─────────────────────────── Player ───────────────────────────

--- 背包 + 装备只遍历一次（同时产出 inventory 和 equipment）
local function inventory_block(p, unavailable)
    local inv = p ~= nil and p.components ~= nil and p.components.inventory or nil
    if inv == nil then
        unavailable[#unavailable + 1] = "player.inventory"
        return nil, nil
    end

    local used = {}
    local slots = 15
    local ok_slots, n = pcall(function() return inv:GetNumSlots() end)
    if ok_slots and type(n) == "number" and n > 0 then slots = n end

    for slot = 1, slots do
        local item = inv:GetItemInSlot(slot)
        local block = item_block(item, slot)
        if block ~= nil then used[#used + 1] = block end
    end

    local equipment = {}
    local equips = {}
    local slot_names = {
        { key = "hands", label = "手持", slot = EQUIPSLOTS and EQUIPSLOTS.HANDS },
        { key = "head", label = "头", slot = EQUIPSLOTS and EQUIPSLOTS.HEAD },
        { key = "body", label = "身", slot = EQUIPSLOTS and EQUIPSLOTS.BODY },
    }
    for _, def in ipairs(slot_names) do
        local item = nil
        if def.slot ~= nil then
            local ok, got = pcall(function() return inv:GetEquippedItem(def.slot) end)
            if ok then item = got end
        end
        local block = item_block(item, nil)
        equipment[def.key] = block
        if block ~= nil then
            block.slot_key = def.key
            equips[#equips + 1] = { key = def.key, label = def.label, item = block }
        end
    end

    local inventory = {
        slots = slots,
        used = #used,
        is_full = #used >= slots,
        items = used,
    }
    return inventory, { slots = equipment, worn = equips }
end

local function player_block(actor, info, unavailable)
    local p = actor
    local block = {}
    local comps = p.components or {}

    block.health = stat_block(comps.health, "currenthealth", "maxhealth")
    block.hunger = stat_block(comps.hunger, "current", "max")
    block.sanity = stat_block(comps.sanity, "current", "max")

    if block.health == nil then unavailable[#unavailable + 1] = "player.health" end
    if block.hunger == nil then unavailable[#unavailable + 1] = "player.hunger" end
    if block.sanity == nil then unavailable[#unavailable + 1] = "player.sanity" end

    if comps.temperature ~= nil then
        local ok, value = pcall(function() return comps.temperature:GetCurrent() end)
        if ok and value ~= nil then block.temperature = { value = value } end
    end
    if block.temperature == nil then unavailable[#unavailable + 1] = "player.temperature" end

    if comps.moisture ~= nil then
        local ok, value = pcall(function() return comps.moisture:GetMoisture() end)
        if ok and value ~= nil then block.wetness = { value = value } end
    end
    if block.wetness == nil then unavailable[#unavailable + 1] = "player.wetness" end

    local inventory, equipment = inventory_block(p, unavailable)
    block.inventory = inventory
    block.equipment = equipment

    return block
end

-- ─────────────────────────── World ───────────────────────────

local function world_block(p, unavailable)
    local world = GLOBAL.TheWorld
    local state = world ~= nil and world.state or nil
    local block = { status = "ok" }
    local weather = {}

    if state == nil then
        block.status = "unavailable"
        unavailable[#unavailable + 1] = "world"
        return block
    end

    if state.cycles ~= nil then block.day = state.cycles + 1 end
    if block.day == nil then unavailable[#unavailable + 1] = "world.day" end

    if state.season ~= nil then
        block.season = state.season
        block.season_name = SEASON_NAMES[state.season]
    end
    if block.season == nil then unavailable[#unavailable + 1] = "world.season" end

    if state.phase ~= nil then
        block.phase = state.phase
        block.phase_name = PHASE_NAMES[state.phase]
    end
    if block.phase == nil then unavailable[#unavailable + 1] = "world.phase" end

    if state.temperature ~= nil then block.world_temperature = state.temperature end
    if block.world_temperature == nil then unavailable[#unavailable + 1] = "world.world_temperature" end

    if state.israining ~= nil then weather.is_raining = state.israining end
    if state.issnowing ~= nil then weather.is_snowing = state.issnowing end
    if state.isfullmoon ~= nil then weather.is_full_moon = state.isfullmoon end
    if state.iswinter ~= nil then weather.is_winter = state.iswinter end
    block.weather = weather
    if weather.is_raining == nil and weather.is_snowing == nil then
        unavailable[#unavailable + 1] = "world.weather"
    end

    local ok_tag, is_cave = pcall(function() return world:HasTag("cave") end)
    block.is_cave = ok_tag and is_cave == true or false

    -- 世界配置里能读到的季节信息（读不到就明说，不编）
    local meta = nil
    local ok_meta, got = pcall(function() return world.meta end)
    if ok_meta then meta = got end
    if meta ~= nil and meta.clock ~= nil and type(meta.clock) == "table" then
        block.world_configuration = {
            length_of_day = meta.clock.length_of_day,
            length_of_dusk = meta.clock.length_of_dusk,
            length_of_night = meta.clock.length_of_night,
            total_day_time = meta.clock.total_day_time,
            seasons = meta.clock.seasons,
        }
    else
        block.world_configuration = nil
        unavailable[#unavailable + 1] = "world.world_configuration"
    end

    return block
end

-- ─────────────────────────── Nearby（沿用现有扫描，M1.4 才重写）───────────────────────────

local scan_cache = { at = nil, actor_id = nil, radius = nil, buckets = nil }

local function workable_is(ent, action)
    local w = ent.components ~= nil and ent.components.workable or nil
    if w == nil or w.action == nil then return false end
    return action ~= nil and w.action.id == action
end

local function entry_block(ent, dist, actor)
    local x, _, z = U.pos(ent)
    local block = {
        prefab = ent.prefab,
        name = U.pretty(ent),
        dist = round1(dist),
    }
    if x ~= nil then
        local tx, tz = U.tile_of(x, z)
        block.tile_x = tx
        block.tile_z = tz
    end
    return block
end

local function collect_buckets(actor, radius)
    local groups = {}
    local shown = {}

    local function add(kind, label, list, limit, extra)
        if list == nil or #list == 0 then return end
        local kept = {}
        for _, entry in ipairs(list) do
            if not shown[entry.ent] then
                shown[entry.ent] = true
                kept[#kept + 1] = entry
            end
        end
        if #kept == 0 then return end
        local items = {}
        for i = 1, math.min(#kept, limit or 6) do
            local block = entry_block(kept[i].ent, kept[i].d / U.TILE, actor)
            local more = extra ~= nil and extra(kept[i].ent) or nil
            if more ~= nil then
                for k, v in pairs(more) do block[k] = v end
            end
            items[#items + 1] = block
        end
        groups[#groups + 1] = {
            kind = kind,
            label = label,
            total = #kept,
            shown = #items,
            truncated = #kept > #items,
            items = items,
        }
    end

    local pickables = U.find_all(actor, radius, nil, nil, function(e)
        if e:HasTag("pickable") and not e:HasTag("barren") then return true end
        if e.components ~= nil and e.components.harvestable ~= nil then
            local ok, can = pcall(function() return e.components.harvestable:CanBeHarvested() end)
            return ok and can == true
        end
        return false
    end)
    add("pickable", "可采", pickables, 6)

    local ground = U.find_all(actor, radius, nil, nil, function(e)
        local item = e.components ~= nil and e.components.inventoryitem or nil
        if item == nil or item.owner ~= nil then return false end
        if e:HasTag("bird") or e:HasTag("structure") or e:HasTag("cooker") then return false end
        local c = e.components
        if c ~= nil and (c.stewer ~= nil or c.cookpot ~= nil) then return false end
        return true
    end)
    add("ground", "可捡", ground, 6, function(e)
        local n = U.count(e)
        return n > 1 and { count = n } or nil
    end)

    add("chop", "可砍", U.find_all(actor, radius, nil, nil, function(e) return workable_is(e, "CHOP") end), 5)
    add("mine", "可挖矿", U.find_all(actor, radius, nil, nil, function(e) return workable_is(e, "MINE") end), 5)
    add("dig", "可铲", U.find_all(actor, radius, nil, nil, function(e) return workable_is(e, "DIG") end), 3)
    add("hammer", "可拆", U.find_all(actor, radius, nil, nil, function(e) return workable_is(e, "HAMMER") end), 3)

    local monsters = U.find_all(actor, radius, { "hostile" }, nil, function(e)
        local h = e.components ~= nil and e.components.health or nil
        return h ~= nil and not h:IsDead()
    end)
    add("hostile", "敌人", monsters, 6, function(e)
        local h = e.components.health
        local targeting = false
        local combat = e.components.combat
        if combat ~= nil and combat.target ~= nil then targeting = combat.target == actor end
        return {
            hp = math.floor(h.currenthealth),
            hp_max = math.floor(h.maxhealth),
            targeting_actor = targeting,
        }
    end)

    local fires = U.find_all(actor, radius, nil, nil, function(e)
        return e.components ~= nil and e.components.fueled ~= nil and e:HasTag("fire")
    end)
    add("fire", "火堆", fires, 3, function(e)
        local fuel = e.components.fueled
        local percent = fuel ~= nil and fuel.GetPercent ~= nil and fuel:GetPercent() or nil
        if percent == nil then return nil end
        return { fuel_percent = math.floor(percent * 100) }
    end)

    add("structure", "建筑", U.find_all(actor, radius, { "structure" }, nil, function() return true end), 5)
    add("ally", "队友", U.find_all(actor, radius + 20, { "player" }, nil, function(e) return e ~= actor end), 4)

    return groups
end

local function nearby_block(actor, info, now, unavailable)
    local radius = cfg("scan_radius", 16)
    local seconds = cfg("scan_seconds", 4)

    local cached = scan_cache
    local fresh = cached.buckets ~= nil
        and cached.actor_id == info.actor_id
        and cached.radius == radius
        and cached.at ~= nil
        and (now - cached.at) < seconds

    if fresh then
        return {
            status = "legacy",
            radius = radius,
            scan_seconds = seconds,
            scanned_at = cached.at,
            cached = true,
            buckets = cached.buckets,
        }
    end

    local ok, buckets = pcall(collect_buckets, actor, radius)
    if not ok or buckets == nil then
        unavailable[#unavailable + 1] = "nearby"
        return { status = "error", radius = radius, scan_seconds = seconds }
    end
    scan_cache = { at = now, actor_id = info.actor_id, radius = radius, buckets = buckets }
    return {
        status = "legacy",
        radius = radius,
        scan_seconds = seconds,
        scanned_at = now,
        cached = false,
        buckets = buckets,
    }
end

-- ─────────────────────────── 告警（只报事实）───────────────────────────

local function warnings(p, player, world)
    local tips = {}
    local health = player.health
    if health ~= nil and health.percent ~= nil then
        if health.current <= 0 then
            tips[#tips + 1] = "你已经死了"
        elseif health.percent < 35 then
            tips[#tips + 1] = "血只剩 " .. health.percent .. "%，快吃东西或跑"
        end
    end
    if player.hunger ~= nil and player.hunger.percent ~= nil and player.hunger.percent < 25 then
        tips[#tips + 1] = "快饿死了（" .. player.hunger.percent .. "%），先找吃的"
    end
    if player.sanity ~= nil and player.sanity.percent ~= nil and player.sanity.percent < 20 then
        tips[#tips + 1] = "理智很低，会出现暗影怪"
    end

    local phase = world.phase
    if phase == "dusk" or phase == "night" then
        local hands = player.equipment ~= nil and player.equipment.slots ~= nil and player.equipment.slots.hands or nil
        local lit = hands ~= nil and hands.prefab ~= nil
            and (hands.prefab == "torch" or hands.prefab == "lantern" or hands.prefab == "minerhat")
        local fire = U.find_nearest(p, 8, { "fire" }, nil, function(e)
            local fueled = e.components ~= nil and e.components.fueled or nil
            return fueled == nil or not fueled:IsEmpty()
        end)
        if not lit and fire == nil then
            tips[#tips + 1] = (phase == "night") and "天黑了又没有光源，查理会来打你" or "快天黑了，先准备火把或火堆"
        end
    end

    local temp = player.temperature
    if temp ~= nil and temp.value ~= nil then
        if temp.value < 5 then tips[#tips + 1] = "太冷了（" .. num(temp.value) .. "°），会掉血" end
        if temp.value > 65 then tips[#tips + 1] = "太热了（" .. num(temp.value) .. "°），会中暑" end
    end

    -- 反射层自己做过的事（M1.1 接上；以前 R.Recent() 写了但没人读）
    local reflex = Whale ~= nil and Whale.reflex or nil
    if reflex ~= nil and reflex.Recent ~= nil then
        local ok, recent = pcall(reflex.Recent)
        if ok and type(recent) == "table" then
            for _, text in ipairs(recent) do
                tips[#tips + 1] = "我自己刚干的（保命反射）：" .. tostring(text)
            end
        end
    end

    return tips
end

-- ─────────────────────────── 文本渲染（唯一来源：data）───────────────────────────

local function render_item(item)
    local text = item.name or item.prefab or "?"
    if item.count ~= nil and item.count > 1 then text = text .. " ×" .. item.count end
    if item.percent ~= nil then text = text .. "(" .. item.percent .. "%)" end
    return text
end

function O.Render(data)
    local lines = {}
    local obs = data.observer or {}
    local actor = data.actor
    local player = data.player or {}
    local world = data.world or {}

    -- 头：快照号 + 世界 + 状态（状态不是 ok 时第一行就说清楚）
    local head = "# 快照 " .. tostring(obs.snapshot_id or "?")
    local world_bits = {}
    if world.day ~= nil then world_bits[#world_bits + 1] = "第" .. num(world.day) .. "天" end
    if world.phase_name ~= nil then world_bits[#world_bits + 1] = world.phase_name end
    if world.season_name ~= nil then world_bits[#world_bits + 1] = world.season_name end
    if world.world_temperature ~= nil then world_bits[#world_bits + 1] = num(world.world_temperature) .. "°" end
    if #world_bits > 0 then head = head .. " · " .. table.concat(world_bits, " · ") end
    head = head .. " · 状态 " .. tostring(obs.status or "?")
    lines[#lines + 1] = head

    if actor == nil then
        lines[#lines + 1] = "现在没有可观察的角色（" .. tostring(obs.status) .. "）。"
        local errs = obs.errors or {}
        for _, e in ipairs(errs) do lines[#lines + 1] = "  - " .. tostring(e) end
        return table.concat(lines, "\n")
    end

    -- 角色 + 三围
    local pieces = { tostring(actor.name or actor.prefab or "?") }
    if player.health ~= nil then
        pieces[#pieces + 1] = "生命 " .. num(player.health.current) .. "/" .. num(player.health.max)
    end
    if player.hunger ~= nil then
        pieces[#pieces + 1] = "饥饿 " .. num(player.hunger.current) .. "/" .. num(player.hunger.max)
    end
    if player.sanity ~= nil then
        pieces[#pieces + 1] = "理智 " .. num(player.sanity.current) .. "/" .. num(player.sanity.max)
    end
    lines[#lines + 1] = "你：" .. table.concat(pieces, "  ")

    if actor.tile_x ~= nil and actor.tile_z ~= nil then
        lines[#lines + 1] = "位置：(" .. actor.tile_x .. "," .. actor.tile_z .. ")"
    else
        lines[#lines + 1] = "位置：读不到（角色可能不在世界里）"
    end

    local worn = {}
    local eq = player.equipment
    if eq ~= nil and eq.slots ~= nil then
        worn[#worn + 1] = "手持：" .. (eq.slots.hands ~= nil and render_item(eq.slots.hands) or "空手")
        if eq.slots.head ~= nil then worn[#worn + 1] = "头：" .. render_item(eq.slots.head) end
        if eq.slots.body ~= nil then worn[#worn + 1] = "身：" .. render_item(eq.slots.body) end
    end
    local body = {}
    if player.temperature ~= nil and player.temperature.value ~= nil then
        body[#body + 1] = string.format("体温 %.0f°", player.temperature.value)
    end
    if player.wetness ~= nil and player.wetness.value ~= nil and player.wetness.value > 0 then
        body[#body + 1] = string.format("潮湿 %d%%", math.floor(player.wetness.value))
    end
    local wear_line = {}
    for _, text in ipairs(worn) do wear_line[#wear_line + 1] = text end
    for _, text in ipairs(body) do wear_line[#wear_line + 1] = text end
    if #wear_line > 0 then lines[#lines + 1] = table.concat(wear_line, "  ") end

    local inv = player.inventory
    if inv ~= nil then
        local names = {}
        for _, item in ipairs(inv.items or {}) do names[#names + 1] = render_item(item) end
        table.sort(names)
        lines[#lines + 1] = "背包（" .. tostring(inv.used) .. "/" .. tostring(inv.slots) .. " 格）："
            .. (#names > 0 and table.concat(names, "、") or "空")
    end

    local tips = data.warnings or {}
    if #tips > 0 then
        lines[#lines + 1] = "注意："
        for _, tip in ipairs(tips) do lines[#lines + 1] = "  - " .. tostring(tip) end
    end

    local nearby = data.nearby
    if nearby ~= nil and nearby.buckets ~= nil and #nearby.buckets > 0 then
        lines[#lines + 1] = "附近（" .. tostring(nearby.radius) .. " 格内）："
        for _, bucket in ipairs(nearby.buckets) do
            local parts = {}
            for _, item in ipairs(bucket.items or {}) do
                local text = (item.name or item.prefab or "?") .. "(" .. tostring(item.tile_x) .. "," .. tostring(item.tile_z) .. ")"
                    .. " 距" .. tostring(item.dist)
                if item.count ~= nil and item.count > 1 then text = text .. " ×" .. item.count end
                if item.hp ~= nil then text = text .. " " .. tostring(item.hp) .. "/" .. tostring(item.hp_max) .. "血" end
                if item.targeting_actor then text = text .. " 正在追你" end
                if item.fuel_percent ~= nil then text = text .. " 燃料 " .. tostring(item.fuel_percent) .. "%" end
                parts[#parts + 1] = text
            end
            local tail = bucket.truncated and ("（还有 " .. tostring(bucket.total - bucket.shown) .. " 个）") or ""
            lines[#lines + 1] = "  " .. bucket.label .. "：" .. table.concat(parts, "；") .. tail
        end
    elseif nearby ~= nil and nearby.status ~= "ok" then
        lines[#lines + 1] = "附近：暂时读不到（" .. tostring(nearby.status) .. "）"
    end

    local unavailable = obs.unavailable_fields or {}
    if #unavailable > 0 then
        lines[#lines + 1] = "读不到的字段：" .. table.concat(unavailable, "、")
    end

    return table.concat(lines, "\n")
end

-- ─────────────────────────── 组装 ───────────────────────────

local sample_cache = { at = nil, actor_guid = nil, data = nil }

--- 采样一次（真正读游戏）。opts = { seq, now }
function O.BuildData(actor, opts)
    opts = opts or {}
    local now = tonumber(opts.now) or U.now()
    local unavailable = {}
    local errors = {}

    local identity = { session_id = nil, cluster_id = nil, cluster_id_source = "unavailable", shard_id = nil }
    local provider = Whale ~= nil and Whale.actor or nil
    if provider ~= nil and provider.get_identity ~= nil then
        local ok, got = pcall(provider.get_identity, now)
        if ok and type(got) == "table" then identity = got end
    end

    local status = "ok"
    local info = nil

    if actor == nil then
        status = "no_actor"
        errors[#errors + 1] = "没有可观察的角色（世界可能还在读档，或者玩家不在这个分片）"
    elseif provider ~= nil and provider.get_actor_info ~= nil then
        local ok, got, why = pcall(provider.get_actor_info, actor)
        if ok and got ~= nil then
            info = got
        else
            status = (ok and why) or "actor_invalid"
            errors[#errors + 1] = "观察对象不可用：" .. tostring(status)
        end
    else
        -- 没有 Actor Provider（单文件测试）：退化成最朴素的读法
        local ok, valid = pcall(function() return actor:IsValid() end)
        if not ok or not valid then
            status = "actor_invalid"
        else
            info = {
                actor_id = "entity:" .. tostring(actor.prefab or "?"),
                actor_id_kind = "transient",
                actor_type = "player",
                prefab = actor.prefab,
                name = U.pretty(actor),
                valid = true,
                alive = true,
                is_ghost = false,
                missing_components = {},
                guid = actor.GUID,
            }
            local x, _, z = U.pos(actor)
            if x ~= nil then
                info.x, info.z = x, z
                info.tile_x, info.tile_z = U.tile_of(x, z)
            end
        end
    end

    if status ~= "ok" then info = nil end

    local data = {
        schema = O.SCHEMA,
        identity = {
            session_id = identity.session_id,
            cluster_id = identity.cluster_id,
            cluster_id_source = identity.cluster_id_source,
            shard_id = identity.shard_id,
        },
        actor = info,
        player = nil,
        world = nil,
        nearby = nil,
        warnings = {},
        -- 兼容老字段（Node 侧/老版本插件还在用）
        ready = status == "ok",
        dead = false,
    }

    if info ~= nil then
        data.player = player_block(actor, info, unavailable)
        data.world = world_block(actor, unavailable)
        data.nearby = nearby_block(actor, info, now, unavailable)
        data.warnings = warnings(actor, data.player, data.world)
        data.dead = not info.alive
        data.x, data.z = info.tile_x, info.tile_z
        data.day = data.world ~= nil and data.world.day or nil
        data.phase = data.world ~= nil and data.world.phase or nil
        if info.missing_components ~= nil then
            for _, comp in ipairs(info.missing_components) do
                unavailable[#unavailable + 1] = "actor.component." .. tostring(comp)
            end
        end
    else
        data.world = world_block(nil, unavailable)
        if data.world ~= nil and data.world.status == "ok" then
            data.day = data.world.day
            data.phase = data.world.phase
        end
    end

    data.observer = {
        snapshot_id = "s" .. tostring(opts.seq or 0),
        sequence = tonumber(opts.seq) or 0,
        timestamp = now,
        sampled_at = now,
        sample_age_ms = 0,
        reused = false,
        status = status,
        errors = errors,
        unavailable_fields = unavailable,
        schema = O.SCHEMA,
    }

    return data
end

--- 建快照 + 渲染文本（不缓存；测试和老调用用它）
function O.Build(actor, opts)
    local data = O.BuildData(actor, opts)
    return O.Render(data), data
end

--- 给文件桥用：按 OBSERVER_INTERVAL 采样，未到期就复用上一次的采样结果。
--- 复用时会更新 snapshot_id / sequence（写入序号），但保留 sampled_at 说明"数据是什么时候采的"。
function O.BuildSample(actor, opts)
    opts = opts or {}
    local now = tonumber(opts.now) or U.now()
    local interval = cfg("observe_interval", 2)
    local guid = actor ~= nil and tostring(actor.GUID) or "nil"

    local due = sample_cache.data == nil
        or sample_cache.actor_guid ~= guid
        or sample_cache.at == nil
        or (now - sample_cache.at) >= interval

    local data
    if due then
        data = O.BuildData(actor, opts)
        sample_cache.at = now
        sample_cache.actor_guid = guid
        sample_cache.data = data
    else
        data = sample_cache.data
    end

    local seq = tonumber(opts.seq) or 0
    local observer = data.observer or {}
    observer.snapshot_id = "s" .. tostring(seq)
    observer.sequence = seq
    observer.timestamp = now
    observer.reused = not due
    if observer.sampled_at ~= nil then
        observer.sample_age_ms = math.floor((now - observer.sampled_at) * 1000)
    end
    data.observer = observer

    return O.Render(data), data
end

function O.Short(actor)
    if actor == nil then return "没有可观察的角色" end
    local info = nil
    if Whale ~= nil and Whale.actor ~= nil and Whale.actor.get_actor_info ~= nil then
        local ok, got = pcall(Whale.actor.get_actor_info, actor)
        if ok then info = got end
    end
    if info == nil then return U.pretty(actor) end
    local pos = (info.tile_x ~= nil) and ("(" .. info.tile_x .. "," .. info.tile_z .. ")") or "(?)"
    local hp = "?"
    if actor.components ~= nil and actor.components.health ~= nil then
        hp = tostring(math.floor(actor.components.health.currenthealth or 0))
    end
    return string.format("%s %s 血%s", tostring(info.name or info.prefab or "?"), pos, hp)
end

Whale = Whale or {}
Whale.observe = O

