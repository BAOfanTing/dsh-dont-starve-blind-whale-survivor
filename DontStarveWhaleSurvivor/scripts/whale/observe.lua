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

--- 作业动作的中文说法（渲染附近实体时用）
local WORK_LABELS = { CHOP = "砍", MINE = "挖矿", DIG = "铲", HAMMER = "拆" }

--- 数字渲染：整数不带小数（13），非整数保留 1 位（12.5）
local function fmt_num(value)
    if value == nil then return "?" end
    local n = tonumber(value)
    if n == nil then return "?" end
    if math.abs(n - math.floor(n + 0.5)) < 0.05 then return string.format("%d", math.floor(n + 0.5)) end
    return string.format("%.1f", n)
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

    -- P0-5：必须把背在身上的背包（Overflow Container）里的物品也统计进来，
    -- 否则背包格物品在 get_state 隐身、Node verify 看不到新增→误判 unverified、is_full 误报。
    local overflow = nil
    if inv.GetOverflowContainer ~= nil then pcall(function() overflow = inv:GetOverflowContainer() end) end
    if overflow ~= nil then
        local o_slots = 0
        pcall(function() o_slots = overflow:GetNumSlots() or 0 end)
        if type(o_slots) == "number" and o_slots > 0 then
            slots = slots + o_slots
            for slot = 1, o_slots do
                local item = nil
                pcall(function() item = overflow:GetItemInSlot(slot) end)
                local block = item_block(item, slot)
                if block ~= nil then block.in_container = true; used[#used + 1] = block end
            end
        end
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

    -- P1：空列表也要序列化成 []（json.arr 打数组标记），否则 Node 到处写对象/数组兜底
    local jarr = Whale ~= nil and Whale.json ~= nil and Whale.json.arr or nil
    if jarr ~= nil then pcall(function() jarr(used); jarr(equips) end) end
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
    local ok_light, in_light = pcall(function() return p:IsInLight() end)
    if ok_light and type(in_light) == "boolean" then
        block.in_light = in_light
    else
        unavailable[#unavailable + 1] = "player.in_light"
    end

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

-- ─────────────────────────── Nearby（M1.4：结构化，实现搬到 nearby.lua）───────────────────────────

--- 附近实体这里只做"取数据"：扫描/分类/上限/引用/delta 全在 Whale.nearby 里。
--- 这里只负责把配置和身份传进去，拿回一份可直接序列化的结构。
local function nearby_block(actor, info, now, unavailable, identity, force_rescan)
    local provider = Whale ~= nil and Whale.nearby or nil
    if provider == nil or provider.Observe == nil then
        unavailable[#unavailable + 1] = "nearby"
        return { status = "error", radius = cfg("scan_radius", 32), scan_seconds = cfg("scan_seconds", 1),
                 buckets = {}, error = "nearby_module_missing",
                 delta = { status = "reset", added = {}, removed = {}, changed = {} } }
    end

    local ok, result = pcall(provider.Observe, actor, info, now, {
        radius = cfg("scan_radius", 32),
        scan_seconds = cfg("scan_seconds", 1),
        max_total = cfg("nearby_max_total", 60),
        max_per_bucket = cfg("nearby_max_per_bucket", 12),
        identity = identity,
        force = force_rescan == true,
    })
    if not ok or result == nil then
        unavailable[#unavailable + 1] = "nearby"
        return { status = "error", radius = cfg("scan_radius", 32), scan_seconds = cfg("scan_seconds", 1),
                 buckets = {}, error = "nearby_failed: " .. tostring(result),
                 delta = { status = "reset", added = {}, removed = {}, changed = {} } }
    end
    return result
end


-- ─────────────────────────── 告警（只报事实）───────────────────────────

--- 把一条反射上报的"紧急需求"翻成人话，直接告诉模型该干什么。
--- 原则：只说事实 + 下一步方向，不替模型做决定（规划仍然是 Node 的事）。
local function need_text(need)
    local kind = tostring(need.kind or "?")
    local missing = need.missing
    local detail = ""
    if type(missing) == "table" and #missing > 0 then
        detail = "（缺：" .. table.concat(missing, "、") .. "）"
    elseif type(missing) == "string" and missing ~= "" then
        detail = "（缺：" .. missing .. "）"
    end
    if kind == "light" then
        return "⚠ 保命反射做不出光源、天已经黑了" .. detail
            .. "：它只在附近采料，不会走远。你要么找火源/材料，要么先躲到有光的地方"
    elseif kind == "light_materials" then
        return "保命反射缺火把材料" .. detail
            .. "：16 格内没有能采的，它不会走远。你去 seek 找草/树苗，或者改走「木头+石头垒火坑」"
    elseif kind == "food" then
        return "保命反射附近找不到吃的（12 格内没有成熟浆果/地上食物）：它补不上，你得去找食物"
    end
    return "保命反射上报：" .. kind .. " " .. tostring(need.reason or "")
end

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
        local eqslots = player.equipment ~= nil and player.equipment.slots or nil
        local hands = eqslots and eqslots.hands or nil
        local head = eqslots and eqslots.head or nil
        local LIGHTSET = { torch = true, lantern = true, minerhat = true }
        -- P1：矿工帽戴在 head 槽，之前只查 hands 会误报“天黑没光”
        local lit = (hands ~= nil and hands.prefab ~= nil and LIGHTSET[hands.prefab] == true)
            or (head ~= nil and head.prefab ~= nil and LIGHTSET[head.prefab] == true)
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
    if reflex ~= nil and reflex.Enabled ~= nil then
        -- 关键：模组默认开 ≠ 存档里真的开。旧存档的 modoverrides.lua 可能把它设成 false，
        -- 这时模型必须知道"没有保命兜底"，不能以为危险会被自动处理。
        local ok_e, enabled, why = pcall(reflex.Enabled)
        if ok_e and enabled == false then
            tips[#tips + 1] = "⚠ 保命反射被关掉了（REFLEX=" .. tostring(why)
                .. "）：危险时不会自动吃东西/做火把/后撤，全靠你自己，务必提前准备"
        end
    end
    if reflex ~= nil and reflex.Recent ~= nil then
        local ok, recent = pcall(reflex.Recent)
        if ok and type(recent) == "table" then
            for _, text in ipairs(recent) do
                tips[#tips + 1] = "我自己刚干的（保命反射）：" .. tostring(text)
            end
        end
    end
    -- ★ 反射解决不了的事，明确交给模型（不是"它会自己搞定"，而是"你必须管"）。
    --   背景：真机两轮都死在"反射只在 16 格内采集、缺料补不上，同时又每 6 秒打断模型"。
    --   现在它补不上就上报，模型才知道该去找资源 / 换路线，而不是干等。
    if reflex ~= nil and reflex.Needs ~= nil then
        local ok_n, needs = pcall(reflex.Needs)
        if ok_n and type(needs) == "table" then
            for _, need in ipairs(needs) do
                tips[#tips + 1] = need_text(need)
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
    -- M2.2.2：这里的 snapshot_id 是**状态快照序列号**（s123），不是 nearby 的扫描 id（r…-n123）。
    -- 两者含义不同，模型调 pickup/harvest 时要用的是**后者**，所以标签必须写清楚，不能混称"快照"。
    local head = "# 状态快照序列号 " .. tostring(obs.snapshot_id or "?")
    local world_bits = {}
    if world.day ~= nil then world_bits[#world_bits + 1] = "第" .. num(world.day) .. "天" end
    if world.phase_name ~= nil then world_bits[#world_bits + 1] = world.phase_name end
    if world.season_name ~= nil then world_bits[#world_bits + 1] = world.season_name end
    if world.world_temperature ~= nil then world_bits[#world_bits + 1] = num(world.world_temperature) .. "°" end
    if #world_bits > 0 then head = head .. " · " .. table.concat(world_bits, " · ") end
    head = head .. " · 状态 " .. tostring(obs.status or "?")
    lines[#lines + 1] = head

    -- TARGET-REFRESH：世界标识（长期笔记按它分开存，换世界不会把旧基地坐标带过来）
    local ident = data.identity or {}
    if ident.world_key ~= nil and ident.world_key ~= "unknown" then
        lines[#lines + 1] = "世界标识：" .. tostring(ident.world_key)
            .. "（来源 " .. tostring(ident.world_key_source or "?") .. "）"
    end

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

    -- R8.2：角色 / 阿比盖尔 / 战斗策略（来自真实状态；未知就明确 unknown）
    if data.character ~= nil then
        local c = data.character
        lines[#lines + 1] = "角色：" .. tostring(c.display_name or c.id or "?") .. "（profile " .. tostring(c.id or "?") .. "，prefab " .. tostring(c.prefab or "?") .. "）"
    end
    if data.companion ~= nil and (data.companion.present == true or (data.character ~= nil and data.character.id == "wendy")) then
        local m = data.companion
        if m.unknown == true then
            lines[#lines + 1] = "阿比盖尔：状态未知（读不到 ghostlybond）"
        elseif m.present ~= true then
            lines[#lines + 1] = "阿比盖尔：不在场（满足条件可用 abigail_flower 召唤，注意别重复召唤）"
        else
            local bits = { m.alive == true and "存活" or "已死亡" }
            if m.health_percent ~= nil then bits[#bits + 1] = string.format("血量%d%%", math.floor(m.health_percent * 100)) end
            if m.distance ~= nil then bits[#bits + 1] = string.format("距%.1f格", m.distance / 4) end
            bits[#bits + 1] = (m.can_assist == true) and "可协助战斗" or "暂不能协助"
            lines[#lines + 1] = "阿比盖尔：" .. table.concat(bits, "，")
        end
    end
    if data.combat ~= nil then
        local cb = data.combat
        lines[#lines + 1] = "战斗策略：" .. tostring(cb.preferred_strategy or "generic")
            .. ((cb.active_target ~= nil) and ("，目标 " .. tostring(cb.active_target)) or "，当前无目标")
    end
    if data.character ~= nil and data.character.id == "wendy" then
        lines[#lines + 1] = "【温蒂要点】优先让阿比盖尔进攻，别把温蒂当普通近战硬砍（本体伤害×0.75）；阿比盖尔不在/死亡时降低主动战斗意愿；第一阶段只安全猎普通蜘蛛，蜘蛛战士/女王/未知高威胁先评估或避开；生存与交火风险永远高于主动战斗。"
    end

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
    if nearby ~= nil then
        local head = "附近（" .. tostring(nearby.radius) .. " 格内"
        -- M2.2.2：nearby 的扫描 id 必须出现在文本里 —— 模型调 pickup/harvest 要填的就是它。
        -- 只在该快照可用时打印；error/缺失时绝不回显历史 id（见下面的分支）。
        local nearby_sid = nil
        if nearby.status ~= "error" and nearby.snapshot_id ~= nil and nearby.snapshot_id ~= "" then
            nearby_sid = tostring(nearby.snapshot_id)
            head = head .. "，Nearby 快照 ID：" .. nearby_sid
        end
        local scan = nearby.scan or {}
        if scan.reused then
            head = head .. "，沿用 " .. tostring(math.floor((scan.age_ms or 0) / 100) / 10) .. " 秒前的扫描"
        end
        -- OBSERVATION-01：告诉模型这一帧还剩多久有效。
        -- 真机踩到：快照 2 秒一刷、模型思考 3~5 秒，于是"刚 get_state 拿到的 id"下一次调用就 stale_snapshot。
        -- 与其让模型盲目重试，不如把有效期写出来，让它知道"要赶紧用，或者干脆先别取 id"。
        if scan.scan_seconds ~= nil and scan.age_ms ~= nil then
            local left = tonumber(scan.scan_seconds) - tonumber(scan.age_ms) / 1000
            if left ~= nil then
                if left < 0 then left = 0 end
                head = head .. "，这一帧大约还剩 " .. tostring(math.floor(left * 10) / 10) .. " 秒有效"
            end
        end
        if nearby.truncated then
            head = head .. "，只显示 " .. tostring(nearby.total_returned) .. "/" .. tostring(nearby.total_found) .. " 个"
        end
        head = head .. "）："

        if nearby.status == "error" then
            lines[#lines + 1] = "附近：暂时读不到（扫描出错：" .. tostring(nearby.error or "?") .. "）"
        elseif nearby.status == "empty" or nearby.total_returned == 0 then
            lines[#lines + 1] = head .. "没什么值得注意的"
        else
            lines[#lines + 1] = head
            local defs = (Whale.nearby ~= nil and Whale.nearby.BUCKETS) or {}
            for _, def in ipairs(defs) do
                local bucket = nearby.buckets ~= nil and nearby.buckets[def.key] or nil
                if bucket ~= nil and #bucket > 0 then
                    -- M2.2：桶满了就明说，别让模型以为"可拾取物一共只有这些"
                    local bucket_full = nearby.max_per_bucket ~= nil and #bucket >= nearby.max_per_bucket
                    local parts = {}
                    for _, item in ipairs(bucket) do
                        local text = tostring(item.ref) .. " " .. tostring(item.label or item.prefab or "?")
                        local pos = item.position or {}
                        text = text .. "(" .. fmt_num(pos.x) .. "," .. fmt_num(pos.z) .. ")"
                        text = text .. " 距" .. fmt_num(item.distance)
                        if item.health ~= nil then
                            text = text .. " " .. tostring(item.health) .. "/" .. tostring(item.max_health or "?") .. "血"
                        end
                        if item.stack_size ~= nil and item.stack_size > 1 then text = text .. " ×" .. tostring(item.stack_size) end
                        if item.work_action ~= nil then text = text .. " 可" .. tostring(WORK_LABELS[item.work_action] or item.work_action) end
                        if item.harvest_ready == false then
                            -- P0-7：优先看真实成熟度；已采空/未成熟的植株绝不能显示成"可采/可收"
                            text = text .. " 未成熟（现在不能采）"
                        elseif item.is_harvestable == true then
                            if item.use_action == "gather" then
                                text = text .. " 可采(gather)"
                            else
                                text = text .. " 可收(harvest)"
                            end
                        end
                        -- TARGET-REFRESH：稳定句柄。它跨扫描有效（#N 只在这一帧有效），
                        -- 目标没了就作废；模型可以直接把它填进 target_handle。
                        if item.handle ~= nil then text = text .. " 句柄" .. tostring(item.handle) end
                        if item.fuel_percent ~= nil then text = text .. " 燃料 " .. tostring(item.fuel_percent) .. "%" end
                        if item.targeting_you then text = text .. " 正在追你" end
                        parts[#parts + 1] = text
                    end
                    local suffix = bucket_full and "（本桶已满，可能还有没列出的）" or ""
                    lines[#lines + 1] = "  " .. def.label .. "：" .. table.concat(parts, "；") .. suffix
                end
            end
            -- M2.2.2：把"这些 #N 属于哪一份 nearby 快照"写在引用旁边，避免模型拿状态序列号去填
            if nearby_sid ~= nil then
                lines[#lines + 1] = "  ↑ 以上 #N 引用属于 Nearby 快照 ID：" .. nearby_sid
                    .. "；调 pickup/harvest 时 snapshot_id 必须填这个（不要填上面的状态快照序列号）"
                -- TARGET-REFRESH：给出**不会过期**的两条替代路，省掉模型"猜编号"的整类错误
                lines[#lines + 1] = "  ↑ 不想管快照号时：只说类别（pickup_nearest / pickup_food / "
                    .. "harvest_nearest / chop_nearest / mine_nearest + target_kind），服务端会实时找目标；"
                    .. "要指定上面某一个具体目标时，用它的 句柄h… （跨帧有效）或 #N + Nearby 快照 ID"
            end
        end

        local delta = nearby.delta
        if delta ~= nil and delta.status == "ok"
            and ((delta.added_count or 0) + (delta.removed_count or 0) + (delta.changed_count or 0)) > 0 then
            local bits = {}
            for _, item in ipairs(delta.added or {}) do
                bits[#bits + 1] = "新出现 " .. tostring(item.ref) .. " " .. tostring(item.label or item.prefab)
            end
            if (delta.removed_count or 0) > 0 then
                local names = {}
                for _, item in ipairs(delta.removed or {}) do
                    names[#names + 1] = tostring(item.label or item.prefab)
                end
                bits[#bits + 1] = "消失 " .. tostring(delta.removed_count) .. " 个（" .. table.concat(names, "、") .. "）"
            end
            for _, item in ipairs(delta.changed or {}) do
                local fields = item.fields or {}
                local what = {}
                if fields.health ~= nil then
                    what[#what + 1] = "生命 " .. tostring(fields.health.from) .. "→" .. tostring(fields.health.to)
                end
                if fields.distance ~= nil then what[#what + 1] = "距离变化" end
                if fields.stack_size ~= nil then what[#what + 1] = "数量变化" end
                if fields.is_harvestable ~= nil then what[#what + 1] = "可采集状态变了" end
                if fields.work_action ~= nil then what[#what + 1] = "可作业状态变了" end
                if fields.category ~= nil then what[#what + 1] = "分类变了" end
                bits[#bits + 1] = "变化 " .. tostring(item.ref) .. " " .. tostring(item.label or item.prefab)
                    .. ("" .. (#what > 0 and ("（" .. table.concat(what, "、") .. "）") or ""))
            end
            lines[#lines + 1] = "  变化：" .. table.concat(bits, "；")
        end
    end

    local unavailable = obs.unavailable_fields or {}
    if #unavailable > 0 then
        lines[#lines + 1] = "读不到的字段：" .. table.concat(unavailable, "、")
    end

    return table.concat(lines, "\n")
end

-- ─────────────────────────── 组装 ───────────────────────────

local sample_cache = { at = nil, actor_guid = nil, data = nil }

--- TARGET-REFRESH：长期记忆必须绑定"哪个世界（存档 + 分片）"。
--- 真机证据：换了存档之后笔记里还留着旧基地 (21,-81)，而角色其实在 (-21,-5)。
--- 优先用 cluster_id（真正的存档标识，跨读档稳定）；读不到才退回 session_id
--- （每次读档都会变 —— 会牺牲跨读档的记忆连续性，但**绝不会把两个世界的坐标混在一起**，
--- 失败要安全）。world_key_source 如实标注用的是哪一个，不编造。
local function world_key_of(identity)
    if identity == nil then return "unknown", "none" end
    local shard = tostring(identity.shard_id or "?")
    local cluster = identity.cluster_id
    if type(cluster) == "string" and cluster ~= "" then
        return "cluster:" .. cluster .. "/shard:" .. shard, "cluster_id"
    end
    local session = identity.session_id
    if type(session) == "string" and session ~= "" then
        return "session:" .. session .. "/shard:" .. shard, "session_id"
    end
    return "unknown", "none"
end
O.world_key_of = world_key_of

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

    local wk, wk_source = world_key_of(identity)
    local data = {
        schema = O.SCHEMA,
        identity = {
            session_id = identity.session_id,
            cluster_id = identity.cluster_id,
            cluster_id_source = identity.cluster_id_source,
            shard_id = identity.shard_id,
            -- TARGET-REFRESH：长期笔记按这个键分开存，换世界不会串坐标
            world_key = wk,
            world_key_source = wk_source,
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
        data.nearby = nearby_block(actor, info, now, unavailable, data.identity, opts.force)
        -- R8.2：角色 Profile + 阿比盖尔伴生 + 战斗策略（来自真实组件；读不到就保持 null/unknown，不伪造）
        if Whale ~= nil and Whale.character ~= nil then
            local okc, prof = pcall(function() return Whale.character.Resolve(actor) end)
            if okc and prof ~= nil then
                data.character = { id = prof.id, prefab = tostring(actor.prefab or ""), display_name = prof.display_name }
                local okcomp, comp = pcall(function() return Whale.character.GetCompanionState(actor) end)
                if okcomp and type(comp) == "table" then data.companion = comp end
                local okcp, cp = pcall(function() return prof.GetCombatPolicy(actor) end)
                if okcp and type(cp) == "table" then
                    data.combat = { preferred_strategy = cp.preferred_strategy, requires_companion_for_hunt = cp.requires_companion_for_hunt }
                    local bt = Whale ~= nil and Whale.battle or nil
                    if bt ~= nil and bt.GetTarget ~= nil then
                        local okay, tgt = pcall(function() return bt.GetTarget() end)
                        if okay and tgt ~= nil then data.combat.active_target = tostring(tgt.prefab or "target") end
                    end
                end
            end
        end
        data.warnings = warnings(actor, data.player, data.world)
        local reflex = Whale ~= nil and Whale.reflex or nil
        if reflex ~= nil and reflex.DangerZones ~= nil then
            local ok_dz, dzs = pcall(reflex.DangerZones)
            if ok_dz and type(dzs) == "table" then
                data.danger_zones = dzs
            end
        end
        if reflex ~= nil and reflex.Status ~= nil then
            local ok_st, st = pcall(reflex.Status)
            if ok_st and type(st) == "table" then
                data.reflex = {
                    active = st.intent ~= nil or (Whale.job ~= nil and Whale.job.cmd_id == "reflex"),
                    intent = st.intent,
                    enabled = st.enabled,
                }
            end
        end
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

