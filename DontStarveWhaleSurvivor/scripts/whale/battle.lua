-- 独立战斗子系统（Combat System / Battle Director）
--
-- 架构设计原则：
-- 1. 战术决策模块：独立管理战斗过程、战术风筝（普通蜘蛛打二撤一）、掉落物安全拾取。
-- 2. 状态机规范：IDLE -> PREPARE -> APPROACH -> LURE -> WAIT_ATTACK -> ATTACK -> RETREAT -> RESET -> VERIFY -> LOOT -> FINISH / EMERGENCY / ABORT。
-- 3. 复用原版机制：复用 actions 底座、native.AttackAction、locomotor 与控制锁，绝不开辟第二套独立角色动作控制器。
-- 4. 战术与保命协同：与 reflex.lua 深度协同，单怪受控交战时合理抑制 P0 flee；残血（<25%）或多怪围攻时立即由保命反射或紧急状态接管。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall or pcall
local tonumber = GLOBAL.tonumber or tonumber
local tostring = tostring or (GLOBAL and GLOBAL.tostring)

local ACTIONS = GLOBAL.ACTIONS
local BufferedAction = GLOBAL.BufferedAction
local EQUIPSLOTS = GLOBAL.EQUIPSLOTS

local U = Whale.util
local A = Whale.actions
local N = Whale.native

local B = {}
Whale = Whale or {}
Whale.battle = B

-- ─────────────── 状态枚举 ───────────────
local STATES = {
    IDLE = "IDLE",
    PREPARE = "PREPARE",
    APPROACH = "APPROACH",
    LURE = "LURE",
    WAIT_ATTACK = "WAIT_ATTACK",
    ATTACK = "ATTACK",
    RETREAT = "RETREAT",
    RESET = "RESET",
    VERIFY = "VERIFY",
    LOOT = "LOOT",
    FINISH = "FINISH",
    EMERGENCY = "EMERGENCY",
    ABORT = "ABORT",
}
B.STATES = STATES

local VALID_TRANSITIONS = {
    IDLE = { PREPARE = true },
    PREPARE = { APPROACH = true, LURE = true, WAIT_ATTACK = true, ABORT = true, EMERGENCY = true },
    APPROACH = { LURE = true, WAIT_ATTACK = true, RETREAT = true, ABORT = true, EMERGENCY = true },
    LURE = { WAIT_ATTACK = true, APPROACH = true, RETREAT = true, ABORT = true, EMERGENCY = true },
    WAIT_ATTACK = { ATTACK = true, RETREAT = true, APPROACH = true, ABORT = true, EMERGENCY = true, VERIFY = true },
    ATTACK = { RETREAT = true, VERIFY = true, WAIT_ATTACK = true, ABORT = true, EMERGENCY = true },
    RETREAT = { RESET = true, WAIT_ATTACK = true, ABORT = true, EMERGENCY = true },
    RESET = { WAIT_ATTACK = true, APPROACH = true, VERIFY = true, ABORT = true, EMERGENCY = true },
    VERIFY = { LOOT = true, FINISH = true, WAIT_ATTACK = true, ABORT = true },
    LOOT = { FINISH = true, ABORT = true, EMERGENCY = true },
    FINISH = { IDLE = true },
    EMERGENCY = { IDLE = true },
    ABORT = { IDLE = true },
}
B.TRANSITIONS = VALID_TRANSITIONS

-- ─────────────── 敌人战术策略表 ───────────────
local STRATEGIES = {
    spider = {
        name = "spider",
        display_name = "普通蜘蛛",
        swings_per_cycle = 2,       -- 打二
        retreat_distance = 3.0,     -- 撤一（约 3 格，避开蜘蛛 2 格攻击范围）
        retreat_duration = 0.8,     -- 后撤保持时间（秒）
        reset_duration = 0.4,       -- 观察等待时间
        can_kite = true,
        supported = true,
    },
    spider_warrior = {
        name = "spider_warrior",
        display_name = "蜘蛛战士",
        can_kite = false,
        supported = false,
        reason = "spider_warrior_has_leap_attack",
    },
}
B.STRATEGIES = STRATEGIES

-- Boss 黑名单（硬拦，绝不自动战斗）
local BOSS_PREFABS = {
    deerclops = true, bearger = true, dragonfly = true, beequeen = true,
    antlion = true, moose = true, klaus = true, malbatross = true,
    toadstool = true, spiderqueen = true, stalker = true, crabking = true,
}
B.BOSS_PREFABS = BOSS_PREFABS

-- 拾取掉落物白名单（按优先级排序）
local LOOT_PRIORITIES = {
    silk = 1,           -- 优先拾取蜘蛛丝
    spidergland = 2,    -- 其次蜘蛛腺体
    monstermeat = 3,    -- 最后怪物肉
}

-- ─────────────── 运行时会话 ───────────────
local session = nil

-- ─────────────── 统一日志 ───────────────
local function blog(tag, fields)
    local parts = { "[BATTLE] " .. tostring(tag) }
    if fields ~= nil then
        local keys = {}
        for k in pairs(fields) do keys[#keys + 1] = k end
        table.sort(keys)
        for _, k in ipairs(keys) do
            parts[#parts + 1] = string.format("%s=%s", tostring(k), tostring(fields[k]))
        end
    end
    local line = table.concat(parts, " ")
    pcall(function() print(line) end)
    return line
end
B.Log = blog

-- P1-6：走路 RPC 节流——APPROACH/LURE/RETREAT/LOOT 每 0.2s tick 都无条件 walk_to 会反复触发 GoToPoint/walkto RPC。
local WALK_THROTTLE_S = 0.5
local function walk_throttled(p, tx, tz)
    local now = U.now()
    if session ~= nil then
        if session._last_walk_at ~= nil and (now - session._last_walk_at) < WALK_THROTTLE_S then return end
        session._last_walk_at = now
    end
    pcall(function() A.walk_to(p, tx, tz, true) end)
end

-- ─────────────── 小工具函数 ───────────────
local function get_health_percent(inst)
    if inst == nil or inst.components == nil or inst.components.health == nil then return nil end
    local h = inst.components.health
    local ok, pct = pcall(function() return h:GetPercent() end)
    if ok and type(pct) == "number" then return pct end
    local cur = h.currenthealth or h.current
    local max = h.maxhealth or h.max
    if type(cur) == "number" and type(max) == "number" and max > 0 then
        return cur / max
    end
    return nil
end

local function get_health_current(inst)
    if inst == nil or inst.components == nil or inst.components.health == nil then return nil end
    local h = inst.components.health
    local cur = h.currenthealth or h.current
    if type(cur) == "number" then return cur end
    return nil
end

local function is_alive(inst)
    if inst == nil or not inst:IsValid() then return false end
    if inst.components ~= nil and inst.components.health ~= nil then
        local ok, dead = pcall(function() return inst.components.health:IsDead() end)
        if ok and dead then return false end
    end
    return true
end

local function current_weapon_name(p)
    if p == nil or p.components == nil or p.components.inventory == nil then return "none" end
    local item = nil
    pcall(function() item = p.components.inventory:GetEquippedItem(EQUIPSLOTS.HANDS) end)
    return (item ~= nil and item.prefab) or "unarmed"
end

local function current_armor_name(p)
    if p == nil or p.components == nil or p.components.inventory == nil then return "none" end
    local body, head = nil, nil
    pcall(function()
        body = p.components.inventory:GetEquippedItem(EQUIPSLOTS.BODY)
        head = p.components.inventory:GetEquippedItem(EQUIPSLOTS.HEAD)
    end)
    local parts = {}
    if body ~= nil and body.prefab ~= nil then parts[#parts + 1] = body.prefab end
    if head ~= nil and head.prefab ~= nil then parts[#parts + 1] = head.prefab end
    if #parts == 0 then return "none" end
    return table.concat(parts, "+")
end

local function count_attackers_targeting(p, radius_tiles)
    if p == nil then return 0 end
    local count = 0
    local list = U.find_all(p, radius_tiles or 8, nil, nil, function(e)
        if e == nil or e == p or not is_alive(e) then return false end
        local c = e.components ~= nil and e.components.combat or nil
        if c ~= nil and c.target == p then return true end
        return false
    end)
    return #list
end

-- ─────────────── 状态迁移 ───────────────
local function transition(next_state, reason)
    if session == nil then return false end
    local cur = session.state or STATES.IDLE
    local allowed = VALID_TRANSITIONS[cur]
    if allowed == nil or allowed[next_state] ~= true then
        blog("ABORT", { reason = "illegal_transition", from = cur, to = next_state })
        return false
    end
    session.state = next_state
    session.state_entered_at = U.now()
    session.last_reason = reason
    blog(next_state, {
        from = cur,
        reason = reason or "flow",
        target = session.target_prefab or "none",
        hp = string.format("%.2f", session.player_current_hp or 1.0),
    })
    return true
end
B.Transition = transition

-- ─────────────── 战斗会话管理 ───────────────
function B.InCombat()
    if session == nil then return false end
    local s = session.state
    return s ~= STATES.IDLE and s ~= STATES.FINISH and s ~= STATES.ABORT and s ~= STATES.EMERGENCY
end

function B.GetSession()
    return session
end

function B.GetState()
    return session ~= nil and session.state or STATES.IDLE
end

function B.GetTarget()
    return session ~= nil and session.target or nil
end

function B.Cleanup()
    if session ~= nil then
        session = nil
    end
end

function B.Abort(reason)
    if session ~= nil then
        blog("ABORT", {
            reason = reason or "manual_abort",
            target = session.target_prefab or "none",
            total_swings = session.total_swings or 0,
            retreats = session.retreat_count or 0,
        })
        session.state = STATES.ABORT
        B.Cleanup()
        return true
    end
    return false
end

-- ─────────────── 保命反射协同接口 ───────────────
--- 供 reflex.lua 判定是否应当抑制普通单怪被攻击逃跑
function B.ShouldSuppressReflex(p, attacker)
    if session == nil or not B.InCombat() then return false end
    local target = session.target
    if target == nil or not is_alive(target) then return false end

    -- 攻击者必须是当前锁定的目标
    local is_same_target = false
    if attacker == target then
        is_same_target = true
    elseif attacker ~= nil and target ~= nil and attacker.GUID ~= nil and attacker.GUID == target.GUID then
        is_same_target = true
    end
    if not is_same_target then
        return false
    end

    local hp = get_health_percent(p)
    -- 硬规则1：生命值过低（< 25%），不可抑制保命反射，必须紧急接管
    if hp ~= nil and hp < 0.25 then
        blog("REFLEX_EMERGENCY_OVERRIDE", {
            reason = "critical_health",
            hp = string.format("%.2f", hp),
            target = session.target_prefab or "none",
        })
        session.reflex_intervened = "critical_health"
        return false
    end

    -- 硬规则2：遭到多只敌人围攻（> 1 只敌对生物把玩家设为目标），不可抑制保命反射
    local num_attackers = count_attackers_targeting(p, 8)
    if num_attackers > 1 then
        blog("REFLEX_EMERGENCY_OVERRIDE", {
            reason = "outnumbered",
            count = num_attackers,
            target = session.target_prefab or "none",
        })
        session.reflex_intervened = "outnumbered"
        return false
    end

    -- 正常受控单怪交战：抑制保命反射的 P0 flee，让战斗系统自主执行风筝
    session.reflex_suppressed_count = (session.reflex_suppressed_count or 0) + 1
    blog("REFLEX_SUPPRESSED", {
        target = session.target_prefab or "none",
        guid = session.target_guid or 0,
        hp = hp ~= nil and string.format("%.2f", hp) or "unknown",
    })
    return true
end

-- ─────────────── 目标查找（就近寻找单只普通蜘蛛）───────────────
local function find_best_spider_target(p, radius_tiles)
    local r = radius_tiles or 16
    local list = U.find_all(p, r, nil, nil, function(e)
        if e == nil or e == p or not is_alive(e) then return false end
        if e.prefab == "spider" then return true end
        return false
    end)
    if #list == 0 then return nil, "no_spider_nearby" end
    -- 按距离升序，选择最近的单只蜘蛛
    table.sort(list, function(a, b) return a.d < b.d end)
    return list[1].ent, nil
end

-- ─────────────── 掉落物搜索 ───────────────
local function find_loot_items(p, radius_tiles)
    local r = radius_tiles or 8
    local items = {}
    local list = U.find_all(p, r, nil, nil, function(e)
        if e == nil or not e:IsValid() then return false end
        local c = e.components
        if c == nil or c.inventoryitem == nil then return false end
        local ok, held = pcall(function() return c.inventoryitem.owner ~= nil end)
        if ok and held then return false end
        return LOOT_PRIORITIES[e.prefab] ~= nil
    end)
    -- 按优先级排序，若同类按距离排序
    table.sort(list, function(a, b)
        local pa = LOOT_PRIORITIES[a.ent.prefab] or 99
        local pb = LOOT_PRIORITIES[b.ent.prefab] or 99
        if pa ~= pb then return pa < pb end
        return a.d < b.d
    end)
    for _, row in ipairs(list) do
        -- 检查该掉落物周围 4 格内是否有活着的敌对威胁
        local hostile_near = false
        local threats = U.find_all(row.ent, 4, nil, nil, function(foe)
            if foe ~= nil and foe ~= p and is_alive(foe) then
                if foe:HasTag("hostile") or foe:HasTag("monster") then return true end
            end
            return false
        end)
        if #threats > 0 then hostile_near = true end
        if not hostile_near then
            items[#items + 1] = row.ent
        end
    end
    return items
end

-- ─────────────── 核心执行逻辑：StepJob ───────────────
function B.StepJob(j, p)
    if p == nil or not is_alive(p) then
        B.Abort("player_dead")
        return "fail", "player_died: 角色已死亡或不可控制"
    end

    local native = Whale.native
    local now = U.now()

    -- 首次启动：初始化会话
    if j.step == "start" or session == nil then
        -- R8.2：角色战斗策略。温蒂（requires_companion_for_hunt）必须阿比盖尔可协助才主动狩猎；
        -- 阿比盖尔不在/死亡/无法协助时降低主动战斗意愿，不白送。非温蒂 base 不受影响。
        local _prof = (Whale ~= nil and Whale.character ~= nil and Whale.character.Resolve ~= nil) and Whale.character.Resolve(p) or nil
        if _prof ~= nil and _prof.GetCombatPolicy ~= nil then
            local _okp, _cp = pcall(function() return _prof.GetCombatPolicy(p) end)
            if _okp and _cp ~= nil and _cp.requires_companion_for_hunt == true then
                local _okc, _comp = pcall(function() return Whale.character.GetCompanionState(p) end)
                if not (_okc and _comp ~= nil and _comp.can_assist == true) then
                    return "fail", "companion_not_ready: 阿比盖尔不在场/无法协助，暂不主动狩猎（先召唤或评估风险）"
                end
            end
        end
        local target = j.ctx ~= nil and j.ctx.target or nil
        if target == nil and j.args ~= nil and j.args.target ~= nil then
            target = j.args.target
        end
        if target == nil then
            local found, why = find_best_spider_target(p, tonumber(j.args and j.args.radius) or 16)
            if found == nil then
                return "fail", "no_spider_nearby: 附近没有可交战的蜘蛛"
            end
            target = found
        end

        local prefab = tostring(target.prefab or "")
        if BOSS_PREFABS[prefab] then
            blog("ABORT", { reason = "boss_forbidden", target = prefab })
            return "fail", "boss_forbidden: Boss 不允许自动交战"
        end

        local strategy = STRATEGIES[prefab]
        if strategy == nil or not strategy.supported then
            local reason = (strategy and strategy.reason) or "unsupported_enemy_strategy"
            blog("ABORT", { reason = reason, target = prefab })
            return "fail", "unsupported_enemy: 目标 " .. prefab .. " 不支持自动战斗策略（" .. tostring(reason) .. "）"
        end

        session = {
            state = STATES.PREPARE,
            target = target,
            target_guid = target.GUID,
            target_prefab = prefab,
            target_label = U.pretty(target),
            strategy = strategy,
            player_initial_hp = get_health_percent(p),
            player_current_hp = get_health_percent(p),
            target_initial_hp = get_health_current(target),
            target_current_hp = get_health_current(target),
            swings_in_cycle = 0,
            total_swings = 0,
            retreat_count = 0,
            last_swing_time = native ~= nil and native.LastAttackTime(p) or 0,
            started_at = now,
            state_entered_at = now,
            weapon = current_weapon_name(p),
            armor = current_armor_name(p),
            loot_queue = nil,
            loot_index = 1,
            reflex_suppressed_count = 0,
            reflex_intervened = nil,
        }

        blog("START", {
            target = session.target_prefab,
            guid = session.target_guid,
            player_hp = string.format("%.2f", session.player_initial_hp or 1.0),
            target_hp = tostring(session.target_initial_hp or "unknown"),
            weapon = session.weapon,
            armor = session.armor,
        })
        blog("PREPARE", { target = session.target_prefab })
        blog("TARGET_LOCK", { target = session.target_prefab, guid = session.target_guid })

        j.step = "fighting"
    end

    -- 刷新监控数据
    session.player_current_hp = get_health_percent(p)
    if session.target ~= nil and session.target:IsValid() then
        session.target_current_hp = get_health_current(session.target)
    end
    session.weapon = current_weapon_name(p)
    session.armor = current_armor_name(p)

    -- ── 全局监控守卫 ──
    -- 1. 残血守卫
    if session.player_current_hp ~= nil and session.player_current_hp < 0.25 then
        transition(STATES.EMERGENCY, "critical_health")
        blog("EMERGENCY", { reason = "critical_health", hp = string.format("%.2f", session.player_current_hp) })
        B.Cleanup()
        return "fail", "low_health: 自身血量过低（<25%），中止战斗并脱离"
    end

    -- 2. 多怪围攻守卫
    local threat_count = count_attackers_targeting(p, 8)
    if threat_count > 1 then
        transition(STATES.EMERGENCY, "outnumbered")
        blog("EMERGENCY", { reason = "outnumbered", count = threat_count })
        B.Cleanup()
        return "fail", "outnumbered: 遭到多只敌人围攻，紧急中止战斗"
    end

    -- 3. 黑暗环境守卫
    if native ~= nil and native.IsLit ~= nil then
        local ok, is_lit = pcall(native.IsLit, p)
        if ok and is_lit == false then
            transition(STATES.EMERGENCY, "darkness")
            blog("EMERGENCY", { reason = "darkness" })
            B.Cleanup()
            return "fail", "dark_no_light: 陷入黑暗，保命优先"
        end
    end

    local st = session.state
    local target = session.target

    -- ── 状态机调度 ──

    -- [PREPARE] 检查武器防具与环境
    if st == STATES.PREPARE then
        -- 尝试自动装备最佳武器（如果当前空手且背包有武器）
        local hand_now = (A.hand_prefab ~= nil) and A.hand_prefab(p) or nil
        local LIGHT_HAND = { torch = true, lantern = true, minerhat = true }
        if not (hand_now ~= nil and LIGHT_HAND[hand_now]) then
            if A.best_weapon ~= nil and A.equip_if_needed ~= nil then
                local bw = A.best_weapon(p)
                if bw ~= nil then
                    pcall(A.equip_if_needed, p, bw)
                    session.weapon = current_weapon_name(p)
                end
            end
        end
        transition(STATES.APPROACH, "prepared")
        return "run"
    end

    -- [APPROACH] 靠近目标或判定引诱
    if st == STATES.APPROACH then
        if target == nil or not target:IsValid() or not is_alive(target) then
            transition(STATES.VERIFY, "target_gone_in_approach")
            return "run"
        end
        local d = U.dist(p, target)
        if d == nil then
            B.Abort("lost_target_pos")
            return "fail", "lost_target_position"
        end

        -- 判定是否在蜘蛛网或巢穴附近（4格内有蜘蛛巢）
        local near_dens = U.find_all(target, 4, nil, nil, function(e)
            return e ~= nil and e.prefab == "spiderden" and is_alive(e)
        end)
        if #near_dens > 0 then
            transition(STATES.LURE, "near_spiderden")
            return "run"
        end

        -- 若距离大于攻击可触达范围（2.2 格），接近目标
        if d > 2.2 * U.TILE then
            local ox, _, oz = U.pos(target)
            if ox ~= nil then
                local tx, tz = U.tile_of(ox, oz)
                walk_throttled(p, tx, tz)
            end
            return "run"
        end

        -- 已经接近目标，停步并准备迎击
        pcall(A.stop_actions, p)
        transition(STATES.WAIT_ATTACK, "in_attack_range")
        return "run"
    end

    -- [LURE] 引诱蜘蛛离开蛛网/巢穴
    if st == STATES.LURE then
        if target == nil or not target:IsValid() or not is_alive(target) then
            transition(STATES.VERIFY, "target_gone_in_lure")
            return "run"
        end
        -- 朝背离蜘蛛巢/目标的方向撤出 4 格开阔地
        local px, py, pz = U.pos(p)
        local tx, ty, tz = U.pos(target)
        if px ~= nil and tx ~= nil then
            local dx, dz = px - tx, pz - tz
            local len = math.sqrt(dx * dx + dz * dz)
            if len < 0.01 then dx, dz, len = 1, 0, 1 end
            local dest_x = px + (dx / len) * 3 * U.TILE
            local dest_z = pz + (dz / len) * 3 * U.TILE
            local dtx, dtz = U.tile_of(dest_x, dest_z)
            walk_throttled(p, dtx, dtz)
        end
        -- 引诱等待 1 秒后重新进入交战
        if now - session.state_entered_at >= 1.0 then
            pcall(A.stop_actions, p)
            transition(STATES.WAIT_ATTACK, "lure_complete")
        end
        return "run"
    end

    -- [WAIT_ATTACK] 观察攻击窗口
    if st == STATES.WAIT_ATTACK then
        if target == nil or not target:IsValid() or not is_alive(target) then
            transition(STATES.VERIFY, "target_dead_or_gone")
            return "run"
        end

        local d = U.dist(p, target)
        if d ~= nil and d > 3.5 * U.TILE then
            -- 目标跑远了，重新接近
            transition(STATES.APPROACH, "target_wandered_far")
            return "run"
        end

        -- 观察蜘蛛动作：若蜘蛛正在出招，等待或保持间距
        local spider_attacking = false
        if target.sg ~= nil and target.sg.HasStateTag ~= nil then
            local ok_att, is_att = pcall(function() return target.sg:HasStateTag("attack") end)
            spider_attacking = ok_att and is_att == true
        end

        if spider_attacking and d ~= nil and d <= 2.0 * U.TILE then
            -- 稍微让开，等待蜘蛛扑空
            return "run"
        end

        -- 玩家自身攻击冷却就绪时，进入攻击阶段
        local can_swing = true
        if native ~= nil and native.CanSwing ~= nil then
            can_swing = native.CanSwing(p)
        end

        if can_swing then
            session.swings_in_cycle = 0
            session.last_swing_time = native ~= nil and native.LastAttackTime(p) or 0
            transition(STATES.ATTACK, "attack_window_open")
        end
        return "run"
    end

    -- [ATTACK] 执行攻击（策略：普通蜘蛛连续攻击两次）
    if st == STATES.ATTACK then
        if target == nil or not target:IsValid() or not is_alive(target) then
            transition(STATES.VERIFY, "target_down")
            return "run"
        end

        -- 核对真实挥砍是否发生（引擎 lastdoattacktime 推进）
        if native ~= nil and native.LastAttackTime ~= nil then
            local last_t = native.LastAttackTime(p)
            if last_t ~= nil and (session.last_swing_time == nil or last_t > session.last_swing_time) then
                session.last_swing_time = last_t
                session.swings_in_cycle = (session.swings_in_cycle or 0) + 1
                session.total_swings = (session.total_swings or 0) + 1
                blog("HIT_CONFIRMED", {
                    hits = session.swings_in_cycle,
                    total = session.total_swings,
                    target = session.target_prefab,
                })
            end
        end

        -- 目标死亡直接进入结算
        if not is_alive(target) then
            transition(STATES.VERIFY, "target_killed")
            return "run"
        end

        -- 打满 2 次，立刻进入后撤阶段（打二撤一）
        local max_swings = session.strategy.swings_per_cycle or 2
        if (session.swings_in_cycle or 0) >= max_swings then
            pcall(A.stop_actions, p)
            transition(STATES.RETREAT, "hit_two_complete")
            return "run"
        end

        -- 冷却与动作下发
        local can_swing = true
        if native ~= nil and native.CanSwing ~= nil then can_swing = native.CanSwing(p) end
        if can_swing and not A.busy(p) then
            local ba = nil
            if native ~= nil and native.AttackAction ~= nil then
                ba = native.AttackAction(p, target)
            else
                ba = BufferedAction(p, target, ACTIONS.ATTACK, nil)
            end
            if ba ~= nil then
                A.push(p, ba)
            end
        end
        return "run"
    end

    -- [RETREAT] 按策略后撤（短距离后撤约 3 格）
    if st == STATES.RETREAT then
        if target == nil or not target:IsValid() or not is_alive(target) then
            transition(STATES.VERIFY, "target_dead_during_retreat")
            return "run"
        end

        local dist_tiles = session.strategy.retreat_distance or 3.0
        local retreat_dur = session.strategy.retreat_duration or 0.8

        -- 计算背离蜘蛛的逃跑落点
        local px, py, pz = U.pos(p)
        local angle = nil
        if native ~= nil and native.FleeAngle ~= nil then
            angle = native.FleeAngle(p, target, dist_tiles)
        end
        if angle == nil and px ~= nil then
            local tx, _, tz = U.pos(target)
            if tx ~= nil then
                local dx, dz = px - tx, pz - tz
                angle = math.deg(math.atan2(-dz, dx))
            end
        end

        local rx, rz = nil, nil
        if native ~= nil and native.PointFromAngle ~= nil and angle ~= nil then
            rx, rz = native.PointFromAngle(p, angle, dist_tiles * U.TILE)
        elseif px ~= nil and angle ~= nil then
            local rad = math.rad(angle)
            rx = px + dist_tiles * U.TILE * math.cos(rad)
            rz = pz - dist_tiles * U.TILE * math.sin(rad)
        end

        if rx ~= nil and rz ~= nil then
            local rtx, rtz = U.tile_of(rx, rz)
            walk_throttled(p, rtx, rtz)
        end

        -- 判定后撤是否完成：距离拉开到安全线，或后撤时间到达
        local cur_d = U.dist(p, target)
        local elapsed = now - session.state_entered_at
        if (cur_d ~= nil and cur_d >= 2.5 * U.TILE) or elapsed >= retreat_dur then
            session.retreat_count = (session.retreat_count or 0) + 1
            pcall(A.stop_actions, p)
            transition(STATES.RESET, "retreat_reached")
        end
        return "run"
    end

    -- [RESET] 停步重置观察
    if st == STATES.RESET then
        if target == nil or not target:IsValid() or not is_alive(target) then
            transition(STATES.VERIFY, "target_dead_in_reset")
            return "run"
        end

        local reset_dur = session.strategy.reset_duration or 0.4
        if now - session.state_entered_at >= reset_dur then
            transition(STATES.WAIT_ATTACK, "reset_complete")
        end
        return "run"
    end

    -- [VERIFY] 核实目标状态
    if st == STATES.VERIFY then
        if target == nil or not is_alive(target) then
            blog("TARGET_DEAD", {
                target = session.target_prefab,
                guid = session.target_guid,
                total_swings = session.total_swings,
                retreats = session.retreat_count,
            })
            transition(STATES.LOOT, "target_confirmed_dead")
            return "run"
        end
        -- 目标未死，继续战斗
        transition(STATES.WAIT_ATTACK, "target_still_alive")
        return "run"
    end

    -- [LOOT] 安全拾取战利品
    if st == STATES.LOOT then
        if session.loot_queue == nil then
            session.loot_queue = find_loot_items(p, 8)
            session.loot_index = 1
            blog("LOOT", { found = #session.loot_queue })
        end

        -- P1-6：先结算上一次拾取是否真的完成（被中断/背包满不能直接跳过漏捡）
        if session.loot_pending ~= nil then
            local lp = session.loot_pending
            local still = (lp.item ~= nil and lp.item:IsValid())
            local picked = (not still)
                or (lp.item ~= nil and lp.item.IsInLimbo ~= nil and lp.item:IsInLimbo())
                or (lp.item ~= nil and lp.item.components ~= nil and lp.item.components.inventoryitem ~= nil
                    and lp.item.components.inventoryitem.owner == p)
            if picked or (now - lp.at > 3) then
                session.loot_index = (lp.idx or 0) + 1
                session.loot_pending = nil
            else
                return "run"
            end
        end
        local queue = session.loot_queue
        local idx = session.loot_index or 1

        if idx > #queue then
            transition(STATES.FINISH, "loot_complete")
            return "run"
        end

        local item = queue[idx]
        if item == nil or not item:IsValid() then
            session.loot_index = idx + 1
            return "run"
        end

        -- 拾取中
        if not A.busy(p) then
            local d = U.dist(p, item)
            if d ~= nil and d > 1.5 * U.TILE then
                local ix, _, iz = U.pos(item)
                if ix ~= nil then
                    local itx, itz = U.tile_of(ix, iz)
                    walk_throttled(p, itx, itz)
                end
            else
                local ba = BufferedAction(p, item, ACTIONS.PICKUP, nil)
                A.push(p, ba)
                -- P1-6：不立即 ++，记 pending，下一 tick 核对是否真的被捡走
                session.loot_pending = { idx = idx, item = item, at = now }
            end
        end
        return "run"
    end

    -- [FINISH] 结算与清理
    if st == STATES.FINISH then
        local msg = string.format("打倒了 %s（挥砍 %d 次，后撤 %d 次）",
            session.target_label or "目标", session.total_swings or 0, session.retreat_count or 0)
        blog("FINISH", {
            target = session.target_prefab,
            total_swings = session.total_swings,
            retreats = session.retreat_count,
            result = "success",
        })
        B.Cleanup()
        return "done", msg
    end

    -- [EMERGENCY]
    if st == STATES.EMERGENCY then
        local reason = session.last_reason or "danger"
        B.Cleanup()
        return "fail", "emergency: " .. reason
    end

    -- [ABORT]
    if st == STATES.ABORT then
        local reason = session.last_reason or "aborted"
        B.Cleanup()
        return "fail", "aborted: " .. reason
    end

    return "run"
end

return B
