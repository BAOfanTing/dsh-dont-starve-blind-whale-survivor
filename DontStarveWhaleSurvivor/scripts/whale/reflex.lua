-- 保命反射层（服务端极简保命层）
--
-- 架构设计原则（对标 Sei 的 reflexes.lua + chores.lua）：
-- 1. 严格职责边界：
--    Reflex 仅处理“3 秒内必死”的保命事件，绝不是第二套自主行动规划器！
--    - 绝对黑暗且无光源：零延迟装备/点燃火把（不自主寻路找材料）。
--    - 遭受攻击或残血濒死：瞬发反向脱离与脱战规避。
--    - 饥饿见底且背包有现成食物：瞬发啃一口保命。
-- 2. 剥离生活逻辑：
--    日常囤料、添柴、搜食、采花全部剥离至 chores.lua（家务宏），
--    完全由主 Plan 在空闲安全期调度，绝不在 Reflex 帧循环里见缝插针偷跑抢占！

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall or pcall
local tonumber = GLOBAL.tonumber or tonumber

local U = Whale.util
local A = Whale.actions
local R = {}
Whale = Whale or {}
Whale.reflex = R

--- 反射发起的动作固定标识
local REFLEX_ID = "reflex"

-- ── 优先级（数值越小越优先）───────────────────────────────────────────────
local P0, P1, P2, P3 = 0, 1, 2, 3

-- 便携光源：手上/背包里有且还有耐久/燃料才算数
local LIGHT_PREFABS = { torch = true, lantern = true, minerhat = true }
-- 已放置的永久光源
local PERMANENT_LIGHTS = {
    pumpkin_lantern = true,
    mushroom_light = true,
    mushroom_light2 = true,
    nightlight = true,
    wall_light = true,
}

-- ── 阈值 ──────────────────────────────────────────────────────────────────
-- ── R8.1 集中配置：本地生存大脑的阈值/频率唯一硬编码处（改这里，不散落） ──
local CFG = {
    every = 5,                 -- Reflex 每 N 个 0.2s tick 跑一次（≈1s）
    fuel_night_min = 0.35,     -- 夜间火源燃料比例低于此值 → P1 添柴
    fuel_day_min = 0.20,       -- 白天低于此值 → P2 空闲补充
    fuel_radius = 12,
    food_prevent = 0.50,       -- 饥饿低于此值 → 空闲预防性进食（P2）
    food_critical = 0.30,      -- 严重饥饿 → P1
    heal_emergency = 0.35,     -- 生命低于此值 → P1 回血
    sanity_maint = 0.55,       -- 理智低于此值 → 维护（P2，空闲且近处有花）
    sanity_flower_radius = 8,
    temp_cold_act = 5, temp_cold_ok = 8,   -- 过冷动作/恢复阈值（滞回）
    temp_hot_act = 65, temp_hot_ok = 60,   -- 过热动作/恢复阈值（滞回）
}
local EAT_CRITICAL = CFG.food_critical
local EAT_NOTIFY = CFG.food_prevent
local HEAL_EMERGENCY = CFG.heal_emergency
local SANITY_LOW = CFG.sanity_maint
-- P1：按角色 Profile 取理智阈值（温蒂 GetSanityPolicy().warn=0.50），未知角色回退 SANITY_LOW
local function sanity_threshold(p)
    local ch = Whale ~= nil and Whale.character or nil
    if ch ~= nil and ch.Resolve ~= nil then
        local ok, prof = pcall(function() return ch.Resolve(p) end)
        if ok and prof ~= nil and prof.GetSanityPolicy ~= nil then
            local ok2, pol = pcall(function() return prof.GetSanityPolicy(p) end)
            if ok2 and pol ~= nil and type(pol.warn) == "number" then return pol.warn end
        end
    end
    return SANITY_LOW
end

local last = {}          -- 上一次执行时间（防抖）
local recent = {}        -- 最近做过的事
local last_said = {}     -- 说话限频
local last_log = {}      -- 诊断日志限频
local fail_until = {}    -- 失败退避
local inflight = nil     -- 当前在跑的反射意图
local pending = nil      -- 已发起、待核对的意图
local is_dead = false    -- 角色死亡状态记忆
local failed_flee_targets = {} -- 失败/不可达的逃生目标点冷却
local temp_state = nil        -- 温度滞回状态："cold"/"hot"/nil
local danger_zones = {}  -- 短期危险区域记忆

--- ★ 火把燃料账（与游戏原生数值保持一致）：
---   seg_time=30, dusk_segs=4, night_segs=2 → dusk 120s + night 60s
---   TORCH_FUEL = night_time*1.25 = 60*1.25 = 75 秒/把
---   真正需要光的只有 night 60 秒（grue 只在完全黑暗时攻击，not inst:IsInLight()）
local DUSK_SECONDS = 120      -- 黄昏 120 秒（仍有自然光）
local NIGHT_SECONDS = 60      -- 真正黑暗只有 60 秒
local TORCH_SECONDS = 75      -- 一把火把能烧 75 秒
local TORCHES_PER_NIGHT = 1   -- 入夜才点，一把 75s 就够 60s 黑夜
local RESERVE_TORCHES = 2     -- 平时至少备 2 把的材料

local COOLDOWN = {
    heal = 8,
    eat = 5,
    light = 6,
    flee = 3,           -- 逃跑防抖 3 秒，防止被怪连续攻击时长期站桩
    craft_light = 4,
    stow_light = 5,     -- 白天收纳火把防抖
    temperature = 10,
    -- R8.5：伴生维护（主动召唤 / 掉落花朵回收）
    companion_summon = 20,
    companion_flower = 5,
}

-- ─────────────────────────── 基础小工具 ───────────────────────────

local function percent_of(comp)
    if comp == nil then return nil end
    local ok, p = pcall(function() return comp:GetPercent() end)
    if ok and type(p) == "number" then return p end
    local cur = comp.current or comp.currenthealth
    local max = comp.max or comp.maxhealth
    if type(cur) == "number" and type(max) == "number" and max > 0 then
        return cur / max
    end
    return nil
end

local function health_percent(p)
    return p ~= nil and p.components ~= nil and percent_of(p.components.health) or nil
end

local function hunger_percent(p)
    return p ~= nil and p.components ~= nil and percent_of(p.components.hunger) or nil
end

local function sanity_percent(p)
    return p ~= nil and p.components ~= nil and percent_of(p.components.sanity) or nil
end

local function current_phase()
    local w = GLOBAL.TheWorld
    if w ~= nil and w.state ~= nil and w.state.phase ~= nil then
        return tostring(w.state.phase)
    end
    return "day"
end

local function cooldown_ok(key)
    local now = U.now()
    if fail_until[key] ~= nil and now < fail_until[key] then return false end
    local cd = COOLDOWN[key] or 5
    local prev = last[key]
    if prev == nil then return true end
    return (now - prev) >= cd
end

local function mark(key)
    last[key] = U.now()
    fail_until[key] = nil
end

local function mark_fail(key, seconds)
    local now = U.now()
    last[key] = now
    fail_until[key] = now + (seconds or 5)
    pcall(function() print(string.format("[Reflex][COOLDOWN] key=%s cooldown=%ds", tostring(key), seconds or 5)) end)
end

local DIAG_GAP = 20
local DIAG_GAP_SAME = 45

local function diag(section, lines)
    local now = U.now()
    lines = lines or {}
    local joined = table.concat(lines, " ")
    local prev = last_log[section]
    if prev ~= nil then
        local gap = (prev.text == joined) and DIAG_GAP_SAME or DIAG_GAP
        if now - prev.at < gap then return end
    end
    last_log[section] = { at = now, text = joined }
    local out = "[Reflex] " .. section .. ":"
    for _, line in ipairs(lines) do out = out .. "\n  " .. tostring(line) end
    pcall(function() print(out) end)
end

local function say(p, key, text)
    if p == nil then return end
    local now = U.now()
    local previous = last_said[key]
    if previous ~= nil and now - previous < 20 then return end
    last_said[key] = now
    recent[#recent + 1] = { t = now, text = text }
    while #recent > 8 do table.remove(recent, 1) end
    pcall(function()
        if p.components.talker ~= nil then p.components.talker:Say(text, 3) end
    end)
end

function R.Recent()
    local out = {}
    local now = U.now()
    for _, item in ipairs(recent) do
        if now - item.t <= 60 then out[#out + 1] = item.text end
    end
    return out
end

local pending_needs = {}

local function report_need(kind, reason, detail)
    local now = U.now()
    local prev = pending_needs[kind]
    if prev ~= nil and prev.reason == reason and (now - prev.at < 30) then
        return
    end
    local rec = { kind = kind, reason = reason, detail = detail, at = now }
    -- P1：把 detail 的字段（missing/radius 等）提到顶层，observe.need_text 才读得到（缺料明细否则永远空）
    if type(detail) == "table" then
        for k, v in pairs(detail) do if rec[k] == nil then rec[k] = v end end
    end
    pending_needs[kind] = rec
    pcall(function()
        print(string.format("[Reflex][EVENT] 生存需求上报: kind=%s reason=%s", tostring(kind), tostring(reason)))
    end)
end

local function clear_need(kind)
    pending_needs[kind] = nil
end

function R.Needs()
    local out = {}
    local now = U.now()
    for k, v in pairs(pending_needs) do
        if now - v.at < 60 then
            out[#out + 1] = { kind = v.kind, reason = v.reason, detail = v.detail, missing = v.missing }
        else
            pending_needs[k] = nil
        end
    end
    return out
end

local function add_danger_zone(x, z, radius, source, duration)
    local now = U.now()
    duration = duration or 45
    danger_zones[#danger_zones + 1] = {
        x = x,
        z = z,
        radius = radius or 8,
        source = tostring(source or "unknown"),
        expiry = now + duration,
        at = now,
    }
    while #danger_zones > 5 do table.remove(danger_zones, 1) end
end

function R.DangerZones()
    local out = {}
    local now = U.now()
    local alive = {}
    for _, dz in ipairs(danger_zones) do
        if now < dz.expiry then
            alive[#alive + 1] = dz
            out[#out + 1] = { x = dz.x, z = dz.z, radius = dz.radius, source = dz.source }
        end
    end
    danger_zones = alive
    return out
end

function R.Enabled()
    if Whale.reflex_force_off == true then
        return false, "forced_off"
    end
    local cfg = Whale.config
    if cfg ~= nil and cfg.get ~= nil and cfg.get("reflex") == false then
        return false, "config_disabled"
    end
    if Whale.reflex_on == false then
        return false, "config_disabled"
    end
    return true, "config_enabled"
end

-- ─────────────────────────── 光源判定 ───────────────────────────

local function item_usable(item)
    if item == nil then return false end
    local fue = item.components ~= nil and item.components.fueled or nil
    if fue ~= nil then
        local empty = false
        pcall(function() empty = fue:IsEmpty() end)
        if empty then return false end
        local percent = nil
        pcall(function() percent = fue:GetPercent() end)
        if percent ~= nil and percent <= 0 then return false end
    end
    local fin = item.components ~= nil and item.components.finiteuses or nil
    if fin ~= nil then
        local uses = nil
        pcall(function() uses = fin:GetUses() end)
        if uses ~= nil and uses <= 0 then return false end
    end
    return true
end

local function hand_light(p)
    local rules = Whale ~= nil and Whale.equiprules or nil
    local hand = rules ~= nil and rules.HandItem(p) or nil
    if hand ~= nil and LIGHT_PREFABS[hand.prefab] and item_usable(hand) then
        return hand
    end
    return nil
end

local function equipped_head_light(p)
    local inv = p ~= nil and p.components ~= nil and p.components.inventory or nil
    local head_slot = GLOBAL.EQUIPSLOTS and GLOBAL.EQUIPSLOTS.HEAD
    if inv == nil or head_slot == nil or inv.GetEquippedItem == nil then return nil end
    local head = nil
    pcall(function() head = inv:GetEquippedItem(head_slot) end)
    if head ~= nil and LIGHT_PREFABS[head.prefab] and item_usable(head) then return head end
    return nil
end

local function inventory_light(p)
    local inv = p ~= nil and p.components ~= nil and p.components.inventory or nil
    if inv == nil then return nil end
    local function usable(item)
        if item == nil then return nil end
        if not (LIGHT_PREFABS[item.prefab] and item_usable(item)) then return nil end
        local in_limbo = false
        if item.HasTag ~= nil then
            local ok, tag = pcall(function() return item:HasTag("INLIMBO") end)
            if ok and tag then in_limbo = true end
        end
        if not in_limbo or (item.components ~= nil and item.components.inventoryitem ~= nil) then return item end
        return nil
    end
    local items = inv.itemslots or inv._items or {}
    for _, item in pairs(items) do local got = usable(item); if got ~= nil then return got end end
    -- P1：背包容器(Overflow Container)里的火把/提灯也要能搜到
    local overflow = nil
    if inv.GetOverflowContainer ~= nil then pcall(function() overflow = inv:GetOverflowContainer() end) end
    if overflow ~= nil then
        local o_slots = 0
        pcall(function() o_slots = overflow:GetNumSlots() or 0 end)
        for slot = 1, o_slots do
            local it = nil
            pcall(function() it = overflow:GetItemInSlot(slot) end)
            local got = usable(it)
            if got ~= nil then return got end
        end
    end
    return nil
end

local function nearby_light(p)
    return U.find_nearest(p, 16, nil, nil, function(e)
        if e == nil or e == p then return false end
        if e.HasTag ~= nil then
            local ok, limbo = pcall(function() return e:HasTag("INLIMBO") end)
            if ok and limbo then return false end
        end
        local is_fire = false
        if e.HasTag ~= nil then
            local ok, fire = pcall(function() return e:HasTag("fire") end)
            if ok and fire and e.components ~= nil and e.components.fueled ~= nil then
                is_fire = true
            end
        end
        local prefab = tostring(e.prefab or "")
        local permanent = PERMANENT_LIGHTS[prefab] == true
        if not is_fire and not permanent then return false end

        -- 增加有效发光半径判定，防止把远处的南瓜灯/火堆误判为身边有光
        local r = 0
        if e.Light ~= nil then
            local ok, radius = pcall(function() return e.Light:GetCalculatedRadius() end)
            if ok and type(radius) == "number" then r = radius end
        end
        if r <= 0 then return false end
        if U.dist(p, e) > r then return false end

        if is_fire then
            local fueled = e.components ~= nil and e.components.fueled or nil
            if fueled ~= nil then
                local ok, empty = pcall(function() return fueled:IsEmpty() end)
                if ok and empty then return false end
            end
        end
        return true
    end)
end

local function has_light(p)
    if p == nil then return false end
    if p.IsInLight ~= nil then
        local ok, lit = pcall(function() return p:IsInLight() end)
        if ok and type(lit) == "boolean" then return lit end
    end
    local native = Whale ~= nil and Whale.native or nil
    if native ~= nil and native.IsLit ~= nil then
        return native.IsLit(p) == true
    end
    local phase = current_phase()
    if phase ~= "night" then return true end
    if hand_light(p) ~= nil then return true end
    return nearby_light(p) ~= nil
end

local function light_report(p)
    local phase = current_phase()
    local hand = hand_light(p)
    local bag = inventory_light(p)
    local near = nearby_light(p)
    local head = equipped_head_light(p)
    local native_light = has_light(p)

    local cr = Whale ~= nil and Whale.craftrules or nil
    local can_craft = false
    local missing = nil
    if cr ~= nil then
        local ok, miss = cr.HasIngredients(p, "torch")
        can_craft = (ok == true)
        missing = miss
    end

    local counts = cr ~= nil and cr.Counts(p) or {}
    local grass_ok = (counts["cutgrass"] or 0) >= (2 * RESERVE_TORCHES)
    local twigs_ok = (counts["twigs"] or 0) >= (2 * RESERVE_TORCHES)
    local reserve_ok = grass_ok and twigs_ok

    -- P0-2：以引擎权威光照(native_light=p:IsInLight)为准；附近有火但引擎判定不在光里，不算"有光"。
    -- P0-2/NR-25：has_usable 完全以引擎权威光照(native_light=p:IsInLight)为准；
    -- 手持火把但引擎判定没被照亮时也必须算“无光”（否则夜里举着照不到的火把还以为安全）。
    local has_usable = native_light == true
    return {
        phase = phase,
        hand = hand,
        bag = bag,
        near = near,
        has_usable = has_usable,
        can_craft = can_craft,
        missing = missing,
        reserve_ok = reserve_ok,
        portable = (hand ~= nil) or (head ~= nil) or (bag ~= nil),
    }
end

local function bool_str(v) return v and "true" or "false" end

local function log_light_check(rep)
    diag("light_check", {
        "has_usable_light=" .. bool_str(rep.has_usable),
        "portable=" .. bool_str(rep.portable),
        "time_of_day=" .. tostring(rep.phase),
    })
    if rep.missing ~= nil then
        local missing_str = ""
        if type(rep.missing) == "table" and #rep.missing > 0 then
            missing_str = table.concat(rep.missing, ", ")
        elseif type(rep.missing) == "string" and rep.missing ~= "" then
            missing_str = rep.missing
        end
        if missing_str ~= "" then
            diag("light_materials", {
                "ready=" .. bool_str(rep.can_craft),
                "missing=" .. missing_str,
            })
        end
    end
end

-- ─────────────────────────── 威胁判断 ───────────────────────────

local function nearest_hostile(p, radius_tiles)
    local limit = radius_tiles * U.TILE
    return U.find_nearest(p, radius_tiles, { "hostile" }, nil, function(e)
        local h = e ~= nil and e.components ~= nil and e.components.health or nil
        if h == nil or h:IsDead() then return false end
        return U.dist(p, e) <= limit
    end)
end

local function combat_targeting(foe, p)
    if foe == nil or p == nil then return false end
    local c = foe.components ~= nil and foe.components.combat or nil
    if c == nil then return false end
    local ok, t = pcall(function() return c.target end)
    return ok and t == p
end

local function find_attacker(p, radius_tiles)
    local limit = radius_tiles * U.TILE
    return U.find_nearest(p, radius_tiles, nil, nil, function(e)
        if e == nil or e == p then return false end
        local h = e.components ~= nil and e.components.health or nil
        if h ~= nil and h:IsDead() then return false end
        if U.dist(p, e) > limit then return false end
        return combat_targeting(e, p)
    end)
end

local function active_threat(p, radius_tiles)
    local limit = radius_tiles * U.TILE
    return U.find_nearest(p, radius_tiles, { "hostile" }, nil, function(e)
        if e == nil or e == p then return false end
        if e:HasTag("structure") or e:HasTag("INLIMBO") then return false end
        local h = e ~= nil and e.components ~= nil and e.components.health or nil
        if h == nil or h:IsDead() then return false end
        return U.dist(p, e) <= limit
    end)
end

local function find_healer_prefab(p)
    local inv = p ~= nil and p.components ~= nil and p.components.inventory or nil
    if inv == nil then return nil end
    local HEALERS = { "spidergland", "healingsalve", "bandage" }
    for _, name in ipairs(HEALERS) do
        local item = inv:FindItem(function(i) return i ~= nil and i.prefab == name end)
        if item ~= nil then return name end
    end
    return nil
end

function R.CriticalDanger(p)
    if p == nil then return false end
    local foe = find_attacker(p, 6) or active_threat(p, 4) or nearest_hostile(p, 4)
    if foe ~= nil and combat_targeting(foe, p) then return true end
    local hp = health_percent(p)
    if hp ~= nil and hp < 0.25 and (foe ~= nil or active_threat(p, 3) ~= nil) then return true end
    return false
end

function R.DarkNoLight(p)
    if p == nil then return nil end
    local phase = current_phase()
    if phase ~= "night" then return nil end
    if has_light(p) then return nil end
    local bag = inventory_light(p)
    if bag ~= nil then
        return {
            in_bag = true,
            item = bag.prefab,
        }
    end
    return {
        in_bag = false,
    }
end

-- ─────────────────────────── 紧急避险与逃跑 ───────────────────────────

local function safe_atan2(y, x)
    if math.atan2 ~= nil then return math.atan2(y, x) end
    if math.atan ~= nil then return math.atan(y, x) end
    return 0
end

local function evaluate_flee_target(p, foe, threats)
    local px, _, pz = U.pos(p)
    if px == nil then return nil end
    local fx, _, fz = U.pos(foe)
    if fx == nil then fx, fz = px, pz end

    local tfx, tfz = U.tile_of(fx, fz)
    add_danger_zone(tfx, tfz, 10, foe.prefab or "threat", 60)

    local now = U.now()
    local all_threat_pos = {}
    if threats ~= nil then
        for _, t in ipairs(threats) do
            local tx, _, tz = U.pos(t)
            if tx ~= nil then all_threat_pos[#all_threat_pos + 1] = { x = tx, z = tz } end
        end
    end
    if #all_threat_pos == 0 then
        all_threat_pos[1] = { x = fx, z = fz }
    end

    -- 优先判断附近是否有安全的常驻火坑/光源
    local base = U.find_nearest(p, 40, nil, nil, function(e)
        if e == nil or e == p or e:HasTag("player") then return false end
        local prefab = tostring(e.prefab or "")
        local permanent = PERMANENT_LIGHTS[prefab] == true
        local is_fire = e:HasTag("fire") and e.components ~= nil and e.components.fueled ~= nil
        if not permanent and not is_fire then return false end
        local fueled = e.components ~= nil and e.components.fueled or nil
        if fueled ~= nil then
            local ok_empty, empty = pcall(function() return fueled:IsEmpty() end)
            if ok_empty and empty then return false end
        end
        return U.dist(e, foe) > U.dist(p, foe) + 2 * U.TILE
    end)

    if base ~= nil and U.dist(p, base) > 3 * U.TILE then
        local bx, _, bz = U.pos(base)
        local btx, btz = U.tile_of(bx, bz)
        local key = btx .. "_" .. btz
        if failed_flee_targets[key] == nil or now > failed_flee_targets[key] then
            return btx, btz, key
        end
    end

    local native = Whale ~= nil and Whale.native or nil
    local base_angle = nil
    if native ~= nil and native.FleeAngle ~= nil then
        local a = native.FleeAngle(p, foe, 9)
        -- P0-1：FleeAngle 返回的是【角度(0~360)】，必须转成弧度再参与 cos/sin
        if type(a) == "number" then base_angle = a * (GLOBAL.DEGREES or (math.pi / 180)) end
    end
    if base_angle == nil then
        local dx, dz = px - fx, pz - fz
        base_angle = safe_atan2(-dz, dx)
    end

    local candidate_angles = {
        base_angle,
        base_angle + math.pi / 4,
        base_angle - math.pi / 4,
        base_angle + math.pi / 2,
        base_angle - math.pi / 2,
        base_angle + 3 * math.pi / 4,
        base_angle - 3 * math.pi / 4,
        base_angle + math.pi,
    }

    local best_target = nil
    local best_score = -math.huge

    for _, ang in ipairs(candidate_angles) do
        local dist = 6 * U.TILE
        local cand_wx = px + math.cos(ang) * dist
        local cand_wz = pz - math.sin(ang) * dist
        local ctx, ctz = U.tile_of(cand_wx, cand_wz)
        local key = ctx .. "_" .. ctz

        if failed_flee_targets[key] == nil or now > failed_flee_targets[key] then
            local walkable = true
            if GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld.Map ~= nil then
                local ok_w, is_walk = pcall(function()
                    return GLOBAL.TheWorld.Map:IsPassableAtPoint(cand_wx, 0, cand_wz)
                end)
                if ok_w and is_walk == false then walkable = false end
            end

            if walkable then
                local min_threat_dist = math.huge
                for _, tpos in ipairs(all_threat_pos) do
                    local d = math.sqrt((cand_wx - tpos.x)^2 + (cand_wz - tpos.z)^2)
                    if d < min_threat_dist then min_threat_dist = d end
                end

                local in_danger_zone = false
                for _, dz in ipairs(danger_zones) do
                    if now < dz.expiry then
                        local dz_dist = math.sqrt((ctx - dz.x)^2 + (ctz - dz.z)^2)
                        if dz_dist <= dz.radius then in_danger_zone = true break end
                    end
                end

                local score = min_threat_dist
                if in_danger_zone then score = score - 20 * U.TILE end

                if score > best_score then
                    best_score = score
                    best_target = { x = ctx, z = ctz, key = key }
                end
            end
        end
    end

    if best_target ~= nil then
        return best_target.x, best_target.z, best_target.key
    end

    local dx, dz = px - fx, pz - fz
    local len = math.sqrt(dx * dx + dz * dz)
    if len < 0.01 then dx, dz, len = 1, 0, 1 end
    local ctx, ctz = U.tile_of(px + (dx / len) * 4 * U.TILE, pz + (dz / len) * 4 * U.TILE)
    return ctx, ctz, ctx .. "_" .. ctz
end

local function reflex_flee(p)
    local hp = health_percent(p)
    local sanity = sanity_percent(p)
    local danger_low_hp = hp ~= nil and hp < 0.5
    local danger_shadow = sanity ~= nil and sanity < 0.25
    local radius = danger_low_hp and 4 or 5

    local attacker = find_attacker(p, 8)
    local foe = attacker or active_threat(p, radius) or nearest_hostile(p, radius)
    local attacked = foe ~= nil and combat_targeting(foe, p)
    if not danger_low_hp and not danger_shadow and not attacked then return false end
    if foe == nil then return false end

    local px, _, pz = U.pos(p)
    if px == nil then return false end

    local cur = U.dist(p, foe)
    local threats = {}
    if attacker ~= nil then threats[#threats + 1] = attacker end
    local near_f = active_threat(p, 8)
    if near_f ~= nil and near_f ~= attacker then threats[#threats + 1] = near_f end

    local tx, tz, key = evaluate_flee_target(p, foe, threats)
    if tx == nil then return false end

    local started = A.Start("move_to", { x = tx, z = tz, timeout = 6 }, REFLEX_ID)
    if started then
        pending = {
            kind = "flee",
            threat_guid = foe.GUID,
            dist_before = cur,
            hp_before = hp,
            target_key = key,
            t0 = U.now(),
        }
        local why = danger_shadow and "暗影怪贴上来了，先撤"
            or (danger_low_hp and "血不多了，先撤到安全的地方" or "有怪在打我，先撤")
        say(p, "flee", why)
        diag("flee", { "started=true", "target=" .. tostring(key), "dist=" .. string.format("%.1f", cur) })
        return true
    end
    return false
end

-- ─────────────────────────── 紧急照明 ───────────────────────────

local function craft_torch(p)
    local cr = Whale ~= nil and Whale.craftrules or nil
    if cr == nil then return false end
    local ok_ing, missing = cr.HasIngredients(p, "torch")
    if not ok_ing then
        diag("craft_torch", { "started=false", "reason=" .. tostring(missing) })
        mark_fail("craft_light", 6)
        return false
    end
    local started = A.Start("craft", { recipe = "torch", count = 1 }, REFLEX_ID,
        { survival_craft = true, recipe = "torch" })
    if started then
        pending = { kind = "craft_torch", t0 = U.now(), phase = current_phase() }
        say(p, "craft_light", "先把火把做出来，别等天黑")
        diag("craft_torch", { "started=true", "phase=" .. tostring(current_phase()) })
        return true
    end
    return false
end

local function reflex_stow_light(p, rep)
    if Whale.job ~= nil then return false end
    if rep == nil then rep = light_report(p) end
    local phase = rep.phase
    if phase == "night" then return false end
    if rep.hand == nil then return false end
    local hand_name = tostring(rep.hand.prefab or "")
    if not LIGHT_PREFABS[hand_name] then return false end
    if not cooldown_ok("stow_light") then return false end
    local foe = active_threat(p, 6)
    if foe ~= nil then return false end

    local started = A.Start("unequip", { slot = "hands" }, REFLEX_ID,
        { survival_unequip = true, slot = "hands" })
    if started then
        mark("stow_light")
        pending = { kind = "stow_light", t0 = U.now() }
        say(p, "stow_light", "天还亮着，先把火把收起来省燃料")
        diag("stow_light", {
            "phase=" .. tostring(phase),
            "hand_seconds=" .. (rep.hand_seconds ~= nil and string.format("%.0f", rep.hand_seconds) or "?"),
        })
        return true
    end
    return false
end

local function firepit_ready(p)
    local cr = Whale ~= nil and Whale.craftrules or nil
    if cr == nil then return false end
    local ok = cr.HasIngredients(p, "firepit")
    return ok == true
end

local function light_action_available(p)
    if has_light(p) then return false end
    if inventory_light(p) ~= nil then return true end
    local cr = Whale ~= nil and Whale.craftrules or nil
    if cr ~= nil and cr.HasIngredients(p, "torch") then return true end
    if firepit_ready(p) then return true end
    if A.count_item(p, "log") >= 2 and A.count_item(p, "cutgrass") >= 3 then return true end
    return false
end

local function reflex_light(p)
    if has_light(p) then
        clear_need("light")
        return false
    end

    -- 1. 背包里有现成的可用光源：装备它
    local bag = inventory_light(p)
    if bag ~= nil then
        local started = A.Start("equip", { item = bag.prefab }, REFLEX_ID)
        if started then
            pending = { kind = "equip_light", t0 = U.now(), target_prefab = bag.prefab }
            say(p, "light", "天黑了，先装备 " .. U.pretty(bag))
            clear_need("light")
        end
        return started
    end

    -- 2. 原地制作火把
    if craft_torch(p) then
        clear_need("light")
        return true
    end

    -- 3. 没草时的火坑兜底
    if firepit_ready(p) then
        local started = A.Start("build", { recipe = "firepit" }, REFLEX_ID, { survival_build = true, build_recipe = "firepit" })
        if started then
            say(p, "light", "没草做不了火把，先垒个火坑（不用草）")
            diag("light_build", { "recipe=firepit", "reason=no_cutgrass" })
            clear_need("light")
        end
        return started
    end

    -- 4. 营火兜底
    if A.count_item(p, "log") >= 2 and A.count_item(p, "cutgrass") >= 3 then
        local started = A.Start("make_fire", {}, REFLEX_ID)
        if started then
            say(p, "light", "材料不够做火把，先生一堆营火")
            clear_need("light")
        end
        return started
    end

    diag("light_check", { "has_usable_light=false", "action=none", "reason=no_light_materials" })
    report_need("light", "dark_and_cannot_make_light", { radius = 16 })
    mark_fail("light", 6)
    return false
end

-- ─────────────────────────── 紧急进食与治疗 ───────────────────────────

local function food_available(p, healing_only)
    local rules = Whale ~= nil and Whale.eatrules or nil
    local inv = p ~= nil and p.components ~= nil and p.components.inventory or nil
    if rules == nil or inv == nil then return false end
    return rules.PickBest(inv, healing_only) ~= nil
end

local function heal_available(p)
    if find_attacker(p, 6) ~= nil or active_threat(p, 4) ~= nil then
        return find_healer_prefab(p) ~= nil
    end
    if find_healer_prefab(p) ~= nil then return true end
    return food_available(p, true)
end

local function reflex_eat(p, healing_only)
    local rules = Whale ~= nil and Whale.eatrules or nil
    local inv = p ~= nil and p.components ~= nil and p.components.inventory or nil
    if rules == nil or inv == nil then return false end
    local item = rules.PickBest(inv, healing_only)
    if item == nil then return false end
    local hungry = hunger_percent(p)
    if not healing_only and hungry ~= nil and hungry >= 0.99 then return false end
    local started = A.Start("eat", {}, REFLEX_ID, { survival_eat = true, food = item.prefab })
    if started then
        pending = { kind = healing_only and "heal" or "eat", hunger_before = hungry,
                    hp_before = health_percent(p), t0 = U.now() }
        say(p, "eat", "饿了/血少了，先吃点安全的东西")
        clear_need("food")
        return true
    end
    return false
end

local function reflex_heal(p)
    local healer = find_healer_prefab(p)
    if healer ~= nil then
        local started = A.Start("heal", { item = healer }, REFLEX_ID)
        if started then
            pending = { kind = "heal", hp_before = health_percent(p), t0 = U.now() }
            say(p, "heal", "血不多了，先上药")
            return true
        end
        return false
    end
    if find_attacker(p, 6) ~= nil or active_threat(p, 4) ~= nil then
        return false
    end
    return reflex_eat(p, true)
end

--- 理智监测与上报（绝不擅自在 Reflex 帧循环里跑去采花，避免见缝插针抢占）
local function reflex_sanity(p)
    local sanity = sanity_percent(p)
    if sanity == nil or sanity >= sanity_threshold(p) then return false end
    report_need("sanity", "sanity_low", { sanity = sanity })
    return false
end

--- 温度异常：过冷→找**点燃的**热源靠近；过热→**绝不向火堆移动**（只上报，不做危险猜测）。
local function temperature_reading(p)
    local comp = p ~= nil and p.components ~= nil and p.components.temperature or nil
    if comp == nil then return nil end
    local ok, t = pcall(function() return comp:GetCurrent() end)
    if not ok or type(t) ~= "number" then return nil end
    return t
end
local function lit_fire_near(p, radius)
    return U.find_nearest(p, radius or 20, { "fire" }, nil, function(e)
        local fueled = e.components ~= nil and e.components.fueled or nil
        return fueled ~= nil and not fueled:IsEmpty()
    end)
end
local function temperature_need(p)
    local t = temperature_reading(p)
    if t == nil then return nil end
    -- P1：过冷滞回——在 cold_act..cold_ok(5~8℃) 维持"靠火"动作，避免阈值附近反复抖
    if t < CFG.temp_cold_act or (temp_state == "cold" and t < CFG.temp_cold_ok) then
        temp_state = "cold"
        local fire = lit_fire_near(p, 20)
        if fire == nil then
            diag("temperature", { "too_cold=true", "fire=none" })
            return { reason = "temperature_cold", can_run = false, report = "too_cold_no_fire" }
        end
        return {
            reason = "temperature_cold", can_run = true,
            run = function()
                local fx, _, fz = U.pos(fire)
                if fx == nil then return false end
                local tx, tz = U.tile_of(fx, fz)
                local started = A.Start("move_to", { x = tx, z = tz, timeout = 10 }, REFLEX_ID)
                if started then mark("temperature"); say(p, "temperature", "太冷了，先靠火堆暖暖"); return true end
                return false
            end,
        }
    end
    -- P1：过热滞回——在 hot_ok..hot_act(60~65℃) 维持避险；绝不靠近火堆，只上报
    if t > CFG.temp_hot_act or (temp_state == "hot" and t > CFG.temp_hot_ok) then
        temp_state = "hot"
        diag("temperature", { "too_hot=true", "fire_move=forbidden" })
        return { reason = "temperature_hot", can_run = false, report = "too_hot_report_only", hot = true }
    end
    if temp_state == "cold" and t >= CFG.temp_cold_ok then temp_state = nil end
    if temp_state == "hot" and t <= CFG.temp_hot_ok then temp_state = nil end
    return nil
end

-- ─────────────────────────── 动作调度与状态核对 ───────────────────────────

local function job_priority(job)
    if job == nil then return P3 end
    if job.reflex_priority ~= nil then return job.reflex_priority end
    if job.cmd_id == REFLEX_ID then return P1 end
    -- R8.5：防御/召唤交接也是"保命级"任务，不允许被 P2 日常维护抢走
    if job.cmd_id == "defense" then return P1 end
    return P2
end

local function interrupt_current(reason)
    local job = Whale.job
    if job == nil then return true end
    local old_name = tostring(job.name)
    local ok = pcall(function() A.Abort(reason) end)
    local cleared = (Whale.job == nil)
    local p = U.player()
    local buffered = false
    if p ~= nil then
        if p.GetBufferedAction ~= nil then
            local ok_b, ba = pcall(function() return p:GetBufferedAction() end)
            if ok_b and ba ~= nil then buffered = true end
        end
        local loco = p.components ~= nil and p.components.locomotor or nil
        if loco ~= nil and loco.bufferedaction ~= nil then
            buffered = true
        end
    end
    diag("protection", {
        "current_job=" .. old_name,
        "interrupt=true",
        "reason=" .. tostring(reason),
        "job_cleared=" .. bool_str(cleared),
        "buffered_action=" .. bool_str(buffered),
        "ok=" .. bool_str(ok),
    })
    pcall(function()
        print(string.format("[Reflex][PREEMPT] 抢占任务: old_job=%s reason=%s cleared=%s", old_name, tostring(reason), bool_str(cleared)))
    end)
    return cleared and not buffered
end

local function try_action(p, key, priority, reason, fn, canRun)
    if inflight ~= nil and inflight.key == key and Whale.job == inflight.job then
        return false
    end
    if not cooldown_ok(key) then
        if key == "flee" and (reason == "under_attack" or reason == "critical_health") and Whale.job == nil then
            local now = U.now()
            if last[key] ~= nil and now - last[key] < 1 then return false end
        else
            return false
        end
    end
    if canRun ~= nil and not canRun() then
        diag("skipped", { "reason=action_not_available", "intent=" .. key })
        return false
    end

    local job = Whale.job
    if job ~= nil then
        if priority > P1 then
            diag("skipped", { "reason=job_running", "intent=" .. key, "current_job=" .. tostring(job.name) })
            return false
        end
        local cur = job_priority(job) or P3
        if priority >= cur then
            diag("skipped", { "reason=lower_or_equal_priority", "intent=" .. key,
                              "current_job=" .. tostring(job.name) })
            return false
        end
        if not interrupt_current(reason) then
            diag("skipped", { "reason=interrupt_failed", "intent=" .. key })
            return false
        end
    end

    local started = fn()
    if started then
        mark(key)
        local j = Whale.job
        if j ~= nil and j.cmd_id == REFLEX_ID then
            j.reflex_key = key
            j.reflex_priority = priority
            inflight = { key = key, job = j, priority = priority }
        end
        pcall(function()
            print(string.format("[Reflex][ACTION] 动作已启动: key=%s priority=P%d reason=%s", tostring(key), priority, tostring(reason)))
        end)
        return true
    end
    return false
end

local function sync_inflight()
    local job = Whale.job
    if job == nil or job.cmd_id ~= REFLEX_ID then
        inflight = nil
        return
    end
    if inflight == nil or inflight.job ~= job then
        inflight = { key = job.reflex_key or "unknown", job = job, priority = job.reflex_priority or P1 }
    end
end

local companion_state
local companion_log

local function confirm_pending(p)
    if pending == nil then return end
    local job = Whale.job
    if job ~= nil and job.cmd_id == REFLEX_ID then return end

    if pending.kind == "craft_torch" then
        local cr = Whale ~= nil and Whale.craftrules or nil
        local have = cr ~= nil and (cr.Counts(p)["torch"] or 0) or 0
        local hand = hand_light(p)
        local ok = (have > 0) or (hand ~= nil)
        diag("craft_torch_result", {
            "started=true",
            "result=" .. (ok and "succeeded" or "failed"),
            "inventory_confirmed=" .. bool_str(have > 0),
            "in_hand=" .. bool_str(hand ~= nil),
            "phase=" .. tostring(current_phase()),
        })
        if not ok then
            mark_fail("craft_light", 8)
        elseif pending.phase ~= "night" and hand ~= nil then
            last["stow_light"] = nil
            fail_until["stow_light"] = nil
            diag("stow_light", { "scheduled=true", "reason=crafted_before_night" })
        end
    elseif pending.kind == "eat" then
        local now = hunger_percent(p)
        local delta = (now ~= nil and pending.hunger_before ~= nil) and (now - pending.hunger_before) or nil
        local ok = (delta ~= nil and delta > 0.005) or (now ~= nil and pending.hunger_before ~= nil and now > pending.hunger_before + 0.02)
        diag("eat", {
            "result=" .. (ok and "succeeded" or "unconfirmed"),
            "hunger_delta=" .. (delta ~= nil and string.format("%.1f", delta) or "?"),
        })
        if ok then
            mark_fail("eat", 15)
            clear_need("food")
        end
    elseif pending.kind == "heal" then
        local now = health_percent(p)
        local delta = (now ~= nil and pending.hp_before ~= nil) and (now - pending.hp_before) or nil
        diag("heal", { "result=" .. ((delta ~= nil and delta > 0.001) and "succeeded" or "unconfirmed") })
    elseif pending.kind == "flee" then
        local threat = nil
        if pending.threat_guid ~= nil then
            threat = U.find_nearest(p, 16, nil, nil, function(e)
                return e ~= nil and e.GUID == pending.threat_guid
            end)
        end
        local dist_now = threat ~= nil and U.dist(p, threat) or 999
        local ok = (pending.dist_before ~= nil and dist_now >= pending.dist_before + 1.5 * U.TILE) or (threat == nil)
        diag("flee_result", {
            "result=" .. (ok and "succeeded" or "failed"),
            "dist=" .. string.format("%.1f", dist_now),
            "threat_escaped=" .. bool_str(ok),
        })
        if ok then
            mark("flee")
        else
            if pending.target_key ~= nil then
                failed_flee_targets[pending.target_key] = U.now() + 15
            end
            mark_fail("flee", 2)
        end
    elseif pending.kind == "equip_light" then
        local rules = Whale ~= nil and Whale.equiprules or nil
        local hand = rules ~= nil and rules.HandItem(p) or nil
        local ok = (hand ~= nil and tostring(hand.prefab) == pending.target_prefab)
        diag("equip_light_result", {
            "result=" .. (ok and "succeeded" or "failed"),
            "in_hand=" .. bool_str(ok),
        })
        if not ok then
            mark_fail("light", 4)
        end
    elseif pending.kind == "stow_light" then
        local rules = Whale ~= nil and Whale.equiprules or nil
        local hand = rules ~= nil and rules.HandItem(p) or nil
        local ok = (hand == nil)
        diag("stow_light_result", {
            "result=" .. (ok and "succeeded" or "failed"),
            "hand_empty=" .. bool_str(ok),
        })
    elseif pending.kind == "fuel" then
        local fire = pending.fire
        local fueled = (fire ~= nil and fire:IsValid() and fire.components ~= nil) and fire.components.fueled or nil
        local after = fueled ~= nil and fueled:GetPercent() or nil
        local ok = (after ~= nil and pending.fuel_before ~= nil and after > pending.fuel_before + 0.01)
        diag("fuel_result", {
            "result=" .. (ok and "succeeded" or "unconfirmed"),
            "before=" .. (pending.fuel_before ~= nil and string.format("%.2f", pending.fuel_before) or "?"),
            "after=" .. (after ~= nil and string.format("%.2f", after) or "?"),
        })
        if not ok then mark_fail("fuel", 6) end   -- 燃料未更新：冷却 6s，禁止连续重复加
    elseif pending.kind == "sanity" then
        local now = sanity_percent(p)
        local ok = (now ~= nil and pending.san_before ~= nil and now > pending.san_before + 0.005)
        diag("sanity_result", { "result=" .. (ok and "succeeded" or "unconfirmed") })
        mark_fail("sanity_pick", ok and 1 or 8)   -- 成功短冷却；未确认长冷却，避免重复
    elseif pending.kind == "companion_summon" then
        -- R8.5：召唤结果必须用真实 ghostlybond 状态核对，不看"自称成功"
        local comp = companion_state(p)
        local ok = comp ~= nil and comp.present == true and comp.alive == true
        diag("companion_summon_result", {
            "result=" .. (ok and "succeeded" or "failed"),
            "present=" .. bool_str(comp ~= nil and comp.present == true),
            "alive=" .. bool_str(comp ~= nil and comp.alive == true),
        })
        if ok then
            mark("companion_summon")
            companion_log("SUMMON_SUCCEEDED", "present=true")
        else
            mark_fail("companion_summon", 20)
            companion_log("SUMMON_FAILED", "present=false")
        end
    elseif pending.kind == "companion_flower" then
        local comp = companion_state(p)
        local ok = comp ~= nil and comp.has_flower == true
        diag("companion_flower_result", { "result=" .. (ok and "recovered" or "failed") })
        if ok then
            mark("companion_flower")
            companion_log("FLOWER_RECOVERED", "has_flower=true")
        else
            mark_fail("companion_flower", 8)
        end
    end
    pending = nil
end

local function reset_state(reason)
    inflight = nil
    pending = nil
    last = {}
    fail_until = {}
    temp_state = nil
    diag("reset", { "reason=" .. tostring(reason) })
    pcall(function() print("[Reflex][RESET] 状态已重置: reason=" .. tostring(reason)) end)
end

local function is_critical_hunger(p, hunger)
    if hunger == nil then return false end
    local limit = (p ~= nil and p.prefab == "wolfgang") and 0.40 or 0.30
    if hunger > limit then return false end
    return true
end

-- ─────────── R8.5：伴生维护（主动召唤 / 掉落花朵回收）───────────
--
-- 背景（真机）：温蒂背包里有阿比盖尔之花，但**一直没召唤**；青蛙追击时 flowers
-- 被原版 frog:onhitother → thief:StealItem 击落到地上 (25,-58)，角色从此长时间没有伴生。
-- 这里做两件事（都只在"完全空闲且确实安全"时执行，P2）：
--   1) 花朵掉在地上 → 用既有 pickup 动作捡回来（FLOWER_DROPPED / FLOWER_RECOVERED）；
--   2) 有花、没召唤、周围没敌人 → 提前召唤（不等被咬）。

local COMPANION_FLOWER_RADIUS = 16
local COMPANION_LOG_GAP = 20

--- 伴生状态（唯一来源仍是 character/companion.lua）
companion_state = function(p)
    local ch = Whale ~= nil and Whale.character or nil
    if ch == nil or ch.GetCompanionState == nil then return nil end
    local ok, st = pcall(function() return ch.GetCompanionState(p) end)
    if ok and type(st) == "table" then return st end
    return nil
end

local companion_log_at = {}

companion_log = function(tag, text)
    local now = U.now()
    local prev = companion_log_at[tag]
    if prev ~= nil and (now - prev) < COMPANION_LOG_GAP then return end
    companion_log_at[tag] = now
    pcall(function() print("[COMPANION] " .. tostring(tag) .. " " .. tostring(text or "")) end)
end

--- 地上是否有"没人拿着"的阿比盖尔之花
local function find_dropped_flower(p, radius)
    return U.find_nearest(p, radius or COMPANION_FLOWER_RADIUS, nil, nil, function(e)
        if e == nil or e == p then return false end
        if tostring(e.prefab or "") ~= "abigail_flower" then return false end
        local c = e.components
        if c == nil or c.inventoryitem == nil then return false end
        local ok, owned = pcall(function() return c.inventoryitem.owner ~= nil end)
        if ok and owned then return false end
        local okv, valid = pcall(function() return e:IsValid() end)
        if okv and valid == false then return false end
        return true
    end)
end

--- P2：只在没有任务、没有敌人贴脸时，做"捡花 / 提前召唤"。
local function maintain_companion(p)
    if A == nil or Whale.job ~= nil then return false end
    local comp = companion_state(p)
    if comp == nil or comp.unknown == true then return false end

    -- 有敌人贴脸/附近有活怪：什么都不做（交给 P0/P1）
    if find_attacker(p, 6) ~= nil then return false end
    if active_threat(p, 8) ~= nil then return false end

    -- 1) 花朵掉在地上且没在场 → 先用既有 pickup 动作捡回来（回收优先于召唤）
    if comp.present ~= true and comp.has_flower ~= true then
        local flower = find_dropped_flower(p, COMPANION_FLOWER_RADIUS)
        if flower ~= nil then
            companion_log("FLOWER_DROPPED", string.format(
                "prefab=abigail_flower dist=%.1f have_flower=%s present=%s",
                (U.dist(p, flower) or 0) / U.TILE, tostring(comp.has_flower), tostring(comp.present)))
            if cooldown_ok("companion_flower") then
                local started = A.Start("pickup", { radius = COMPANION_FLOWER_RADIUS }, REFLEX_ID,
                    { target = flower })
                if started then
                    mark("companion_flower")
                    pending = { kind = "companion_flower", t0 = U.now() }
                    diag("companion_flower", { "started=true", "reason=flower_dropped" })
                    return true
                end
            end
        end
    end

    -- 2) 有花、没召唤、安全 → 提前召唤（不等被咬）
    if comp.can_summon == true and comp.has_flower == true and comp.present ~= true then
        if not cooldown_ok("companion_summon") then return false end
        local started = A.Start("summon_companion", {}, REFLEX_ID, { proactive = true })
        if started then
            mark("companion_summon")
            pending = { kind = "companion_summon", t0 = U.now() }
            companion_log("SUMMON_STARTED", "reason=proactive")
            diag("companion_summon", { "started=true", "reason=proactive" })
            return true
        end
    end
    return false
end


local function has_fuel_item(p)
    if A == nil or A.count_item == nil then return false end
    local ok, v = pcall(function()
        return (A.count_item(p, "log") + A.count_item(p, "twigs") + A.count_item(p, "cutgrass")
            + A.count_item(p, "charcoal") + A.count_item(p, "pinecone")) > 0
    end)
    return ok and v == true
end

local function maintain_fuel(p, phase)
    if A == nil then return false end
    local fire = U.find_nearest(p, CFG.fuel_radius, { "fire" }, nil, function(e)
        local fueled = e.components ~= nil and e.components.fueled or nil
        if fueled == nil then return false end
        -- P1：排除已熄灭的火（JOBS.add_fuel 不给灭的火添柴，否则每 6 秒空失败）
        local ok_empty, empty = pcall(function() return fueled:IsEmpty() end)
        return not (ok_empty and empty == true)
    end)
    if fire == nil then return false end
    local fueled = fire.components ~= nil and fire.components.fueled or nil
    if fueled == nil then return false end
    local okp, pct = pcall(function() return fueled:GetPercent() end)
    if not okp or type(pct) ~= "number" then return false end
    local night = (phase == "night")
    local threshold = night and CFG.fuel_night_min or CFG.fuel_day_min
    if pct >= threshold then return false end
    if not has_fuel_item(p) then
        report_need("fuel", "no_fuel_item", { pct = pct })
        return false
    end
    local prio = night and P1 or P2
    return try_action(p, "fuel", prio, night and "fuel_night_low" or "fuel_day_low", function()
        local started = A.Start("add_fuel", { radius = CFG.fuel_radius }, REFLEX_ID, {})
        if started then pending = { kind = "fuel", fire = fire, fuel_before = pct } end
        return started
    end)
end

local function maintain_food(p)
    if A == nil then return false end
    local hunger = hunger_percent(p)
    if hunger == nil or hunger >= CFG.food_prevent then return false end
    if is_critical_hunger(p, hunger) then return false end   -- 严重饥饿由 P1 分支处理
    if not food_available(p) then return false end
    return try_action(p, "eat", P2, "food_preventive", function() return reflex_eat(p) end,
                      function() return food_available(p) end)
end

local function maintain_sanity(p)
    if A == nil then return false end
    local sanity = sanity_percent(p)
    if sanity == nil or sanity >= sanity_threshold(p) then clear_need("sanity"); return false end
    report_need("sanity", "sanity_low", { sanity = sanity })
    if Whale.job ~= nil then return false end   -- 只在完全空闲时维护
    local flower = U.find_nearest(p, CFG.sanity_flower_radius, nil, nil, function(e)
        return e ~= nil and tostring(e.prefab) == "flower"
    end)
    if flower == nil then
        report_need("sanity", "sanity_no_flower", { radius = CFG.sanity_flower_radius })
        return false
    end
    local san_before = sanity
    return try_action(p, "sanity_pick", P2, "sanity_maintenance", function()
        local started = A.Start("gather", { target = flower }, REFLEX_ID, { target = flower })
        if started then pending = { kind = "sanity", san_before = san_before } end
        return started
    end)
end

function R.Priority(p)
    if p == nil then return P3, "no_player" end
    local phase = current_phase()
    local hp = health_percent(p)
    local hunger = hunger_percent(p)
    local sanity = sanity_percent(p)
    local rep = light_report(p)

    local attacker = find_attacker(p, 4) or nearest_hostile(p, 3)
    if attacker ~= nil and combat_targeting(attacker, p) then return P0, "under_attack" end
    if hp ~= nil and hp < 0.25 and (active_threat(p, 2.5) ~= nil or nearest_hostile(p, 2.5) ~= nil) then return P0, "critical_health" end
    if phase == "night" and not rep.has_usable then return P0, "dark_no_light" end

    if phase ~= "night" and not rep.portable then
        if rep.can_craft then return P1, "light_preparation" end
        return P2, "light_materials"
    end
    if is_critical_hunger(p, hunger) then return P1, "hunger_emergency" end
    if hp ~= nil and hp < HEAL_EMERGENCY then return P1, "health_low" end

    local temp = temperature_need(p)
    if temp ~= nil then return P1, temp.reason end
    if sanity ~= nil and sanity < sanity_threshold(p) then return P3, "sanity_low" end
    return P3, "idle"
end

-- ─────────────────────────── 主循环 ───────────────────────────

local function run(p)
    local phase = current_phase()
    local rep = light_report(p)
    log_light_check(rep)

    local hp = health_percent(p)
    local hunger = hunger_percent(p)
    local sanity = sanity_percent(p)

    local prio, why = R.Priority(p)
    if prio <= P1 then
        diag("priority", { "priority=P" .. tostring(prio), "reason=" .. tostring(why) })
    end

    -- ── P0：立即保命（可抢占任何任务）
    -- 1. 受到敌对攻击规避
    local attacker = find_attacker(p, 4) or nearest_hostile(p, 3)
    
    -- 检查是否正在进行自主战斗
    local B = Whale ~= nil and Whale.battle or nil
    local in_battle = (B ~= nil and B.InCombat())
    local suppress_flee = false
    if in_battle and attacker ~= nil then
        suppress_flee = B.ShouldSuppressReflex(p, attacker)
    end

    local in_combat_job = Whale ~= nil and Whale.job ~= nil
        and (Whale.job.name == "attack" or Whale.job.name == "kill")
        and Whale.job.cmd_id ~= REFLEX_ID

    local job_target = nil
    if in_combat_job then
        job_target = Whale.job.ctx ~= nil and Whale.job.ctx.target or nil
    end
    local engaging_target = false
    if job_target ~= nil and combat_targeting(job_target, p) then engaging_target = true end
    local fighting_back = in_combat_job
        and (job_target == nil or job_target == attacker or engaging_target)
    local hp_safe = hp ~= nil and hp >= 0.50

    if attacker ~= nil and combat_targeting(attacker, p) then
        -- ★ R8.5：受控防御接线。
        --   旧实现只对野狗(hound/icehound/firehound)调 B.StartDefense，普通蜘蛛/蜘蛛战士/青蛙
        --   一律走 flee —— 真机上就是"青蛙靠近 → flee 反复启动 → 生命 150→130 → advance_task
        --   一直被 reflex_active 阻断"。现在：任何"战术表里有策略"的敌人，都先尝试受控防御；
        --   StartDefense 内部再判残血 / 是否有伴生 / 是否正在召唤 / 优先级，绝不硬接。
        local strategy_supported = false
        if B ~= nil and B.STRATEGIES ~= nil then
            local strat = B.STRATEGIES[attacker.prefab]
            strategy_supported = (strat ~= nil and strat.supported == true)
        end
        if strategy_supported and not suppress_flee and (hp == nil or hp >= 0.25) then
            local defense_state = nil
            if B.StartDefense ~= nil then
                defense_state = B.StartDefense(p, attacker)
            end
            if defense_state == "engaged" or defense_state == "summoning" then
                suppress_flee = true
                -- 召唤交接必须有界：拖太久或快死了立刻回退逃跑（绝不永久禁用 flee）。
                if defense_state == "summoning" then
                    local ds = (B.DefenseStatus ~= nil) and B.DefenseStatus() or nil
                    local elapsed = (ds ~= nil and ds.summon_started_at ~= nil)
                        and (U.now() - ds.summon_started_at) or 0
                    local too_long = elapsed > 8
                    local too_hurt = hp ~= nil and hp < 0.35
                    if too_long or too_hurt then
                        if B.AbortDefense ~= nil then
                            B.AbortDefense(too_hurt and "critical_health" or "summon_timeout")
                        end
                        suppress_flee = false
                    end
                end
            end
        end

        if not suppress_flee and not (fighting_back and hp_safe) then
            if try_action(p, "flee", P0, "under_attack", function() return reflex_flee(p) end) then return end
        end
    end

    -- 2. 残血濒死规避
    if hp ~= nil and hp < 0.25 and (active_threat(p, 2.5) ~= nil or nearest_hostile(p, 2.5) ~= nil) then
        if try_action(p, "flee", P0, "critical_health", function() return reflex_flee(p) end) then return end
    end

    -- 3. 绝对黑暗且无光源：零延迟点火/装备火把（绝不漫游寻路）
    if phase == "night" and not rep.has_usable then
        if not light_action_available(p) then
            report_need("light", "dark_and_cannot_make_light", { radius = 16 })
        elseif try_action(p, "light", P0, "dark_no_light",
                      function() return reflex_light(p) end,
                      function() return light_action_available(p) end) then return end
    end

    -- ── P1：高优先生存需求
    -- 白天在没有任务时，若完全没火把且材料充足，原地做一把火把备用（有任务绝对不打断）
    -- 若材料不足，只上报需求给主 Plan，绝不自行漫游寻路
    if phase ~= "night" and (not rep.portable) then
        if rep.can_craft and Whale.job == nil then
            if try_action(p, "craft_light", P1, "light_preparation", function() return craft_torch(p) end) then return end
        elseif not rep.can_craft then
            report_need("light_materials", "missing_ingredients", { missing = rep.missing })
        end
    end

    -- 普通饥饿通知（30% ~ 50%）：只上报需求给 Plan，绝不申请紧急抢占
    if hunger ~= nil and hunger < EAT_NOTIFY and not is_critical_hunger(p, hunger) then
        local cur_hunger = p.components ~= nil and p.components.hunger ~= nil and p.components.hunger.current or nil
        local max_hunger = p.components ~= nil and p.components.hunger ~= nil and p.components.hunger.max or nil
        report_need("food", "hunger_low", {
            hunger = hunger,
            current = cur_hunger,
            max = max_hunger,
            reason = "normal_hunger_notify_plan",
        })
    end

    -- 真正紧急进食（<= 30% 且背包有现成安全食物）
    if is_critical_hunger(p, hunger) then
        if not food_available(p) then
            report_need("food", "hungry_without_food", {
                radius = 12,
                missing = "safe_food",
            })
        elseif try_action(p, "eat", P1, "hunger_emergency",
                      function() return reflex_eat(p) end,
                      function() return food_available(p) end) then return end
    end

    -- 真正紧急回血
    if hp ~= nil and hp < HEAL_EMERGENCY then
        if try_action(p, "heal", P1, "health_low",
                      function() return reflex_heal(p) end,
                      function() return heal_available(p) end) then return end
    end

    -- 温度异常（过冷靠近热源；过热只上报、绝不向火堆移动）
    local temp = temperature_need(p)
    if temp ~= nil and temp.report ~= nil then report_need("temperature", temp.report, {}) end
    if temp ~= nil and temp.can_run == true then
        if try_action(p, "temperature", P1, temp.reason, temp.run) then return end
    end

    -- 理智异常监测报警
    if sanity ~= nil and sanity < sanity_threshold(p) then
        reflex_sanity(p)
    end

    -- 只有在完全没有任务时（Whale.job == nil）：
    -- 白天手持火把且无活怪贴脸时收回火把进背包（明确安全收益：防止白天手持烧光 75s 燃料致使入夜无光）
    -- 绝不改变 spear / axe / pickaxe 等非光源装备，也不打断任何主任务
    if Whale.job == nil then
        if reflex_stow_light(p, rep) then return end
    end

    -- ── R8.1：日常生存维护（燃料/进食/理智）。夜间低燃料=P1 可抢占；其余 P2 仅空闲执行。
    if phase == "night" then
        if maintain_fuel(p, phase) then return end
    end
    if Whale.job == nil then
        if maintain_fuel(p, phase) then return end
        if maintain_food(p) then return end
        -- R8.5：伴生维护（捡回掉落的花 / 提前召唤）
        if maintain_companion(p) then return end
        if maintain_sanity(p) then return end
    end

    -- ★ 其余 P3 家务（采草、砍树等）仍交给模型/Plan，不在 Reflex 帧循环里做。
end

local tick = 0
function R.Tick()
    local enabled, why = R.Enabled()
    if not enabled then
        tick = tick + 1
        if tick % (CFG.every or 5) == 0 then diag("enabled", { "enabled=false", "reason=" .. tostring(why) }) end
        return
    end
    tick = tick + 1
    if tick % (CFG.every or 5) ~= 0 then return end       -- ≈1 秒一次（集中配置）

    local p = U.player()
    if p == nil then
        if not is_dead then
            is_dead = true
            reset_state("no_player")
        end
        return
    end
    local hp_comp = p.components ~= nil and p.components.health or nil
    if hp_comp == nil then return end
    local dead, ghost, valid = false, false, true
    pcall(function() dead = hp_comp:IsDead() end)
    pcall(function() ghost = p:HasTag("playerghost") end)
    pcall(function() valid = p:IsValid() end)
    if dead or ghost or not valid then
        if not is_dead then
            is_dead = true
            reset_state(dead and "dead" or (ghost and "ghost" or "invalid_actor"))
        end
        return
    else
        if is_dead then
            is_dead = false
            reset_state("revived")
        end
    end

    sync_inflight()
    -- P0-4：confirm_pending 出错不能把 pending 永久卡住（否则每 tick 都在这儿抛错、保命反射停摆）
    local ok_cp, err_cp = pcall(confirm_pending, p)
    if not ok_cp then
        pending = nil
        pcall(function() diag("error", { "confirm_pending=" .. tostring(err_cp) }) end)
    end

    local ok, err = pcall(function() run(p) end)
    if not ok then
        Whale.last_reflex_error = tostring(err)
        diag("error", { tostring(err) })
        U.log("保命反射出错：" .. tostring(err))
    end
end

function R.Status()
    local out = {}
    for k, v in pairs(last) do out[k] = v end
    local enabled, why = R.Enabled()
    out.enabled = enabled
    out.enabled_reason = why
    if inflight ~= nil then out.intent = inflight.key end
    return out
end

function R.Diagnose()
    local out = {}
    local enabled, why = R.Enabled()
    out.enabled = enabled
    out.enabled_reason = why
    local p = U.player()
    if p == nil then
        out.status = "no_player"
        return out
    end
    local rep = light_report(p)
    out.phase = rep.phase
    local prio, reason = R.Priority(p)
    out.priority = "P" .. tostring(prio)
    out.priority_reason = reason
    out.has_usable_light = rep.has_usable
    out.portable_light = rep.portable
    out.can_craft_torch = rep.can_craft
    out.missing_materials = rep.missing
    out.reserve_ok = rep.reserve_ok
    if rep.hand ~= nil then
        out.hand_item = rep.hand.prefab
    end
    if rep.bag ~= nil then
        out.bag_item = rep.bag.prefab
    end
    out.recent_actions = R.Recent()
    local pending_needs_list = R.Needs()
    if #pending_needs_list > 0 then
        out.pending_needs = pending_needs_list
    end
    return out
end

return R
