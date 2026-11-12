-- Blind Whale Survivor · Phase 6 M4 · Combat Executor（战斗执行器 / Kiting 控制器）
--
-- 高频动作在 Lua 里跑（0.1 秒一个 tick），LLM 只负责"打不打、打谁、什么时候撤"。
-- 这里只做一件事：把上游批准的一次战斗，用游戏原生的攻击/移动动作打完。
--
-- ── 安全边界（全部在程序层，不依赖提示词）────────────────────────────────
--   1. 固定白名单：只有 AUTONOMOUS_ENEMIES 里的 prefab 允许自动交战，其余一律拒绝；
--      Boss 永远不在白名单里（BOSS_PREFABS 单独一张表，硬拦，连传参都没用）。
--   2. start_combat 必须带 confirmed=true（第一版 = SUPERVISED_COMBAT，人工确认）。
--   3. 控制权二次校验仍在 action_executor 里做（这里被它调用，不重复实现）。
--   4. 单一执行者：战斗进行中，原子动作被 action_executor 拒绝；战斗也拒绝第二个 start_combat。
--   5. 随时可中断：abort_combat / 紧急停止 / 玩家死亡 / 手工接管都会立刻停手。
--
-- ── 只能用游戏原生动作 ────────────────────────────────────────────────────
--   攻击：player.components.combat:TryAttack(target)（首选，走游戏的攻击条件检查）
--         —— 不可用时退回 BufferedAction(player, target, ACTIONS.ATTACK, nil)
--   移动：player.components.locomotor:GoToPoint(...)（和玩家点鼠标同一条路）
--   **绝不使用 ForceAttack**，不用任何绕过常规攻击条件的接口。
--
-- ── 与真实构建的 API 对齐 ─────────────────────────────────────────────────
--   combat:TryAttack / combat:CanAttack / combat:GetAttackRange / ACTIONS.ATTACK /
--   locomotor:GoToPoint 都在 C.ProbeApi() 里逐项探测；拿不到的项会在 status 里报 false，
--   并且启动战斗时会因为缺少可用攻击路径而直接拒绝（不硬上）。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

BWS2 = BWS2 or {}

local C = {}

local TILE = 4
local TICK_INTERVAL = 0.1     -- 战斗 tick（秒）
local TICK_STALE_GAP = 1.5    -- 超过这么久没 tick，就认为周期任务停了（由观察器补跑）

-- ─────────────── 状态机（任务书 §5）───────────────
local STATES = {
    IDLE = true,
    ASSESSING = true,
    PREPARING = true,
    ENGAGING = true,
    EVADING = true,
    RETREATING = true,
    RECOVERING = true,
    COMPLETE = true,
    ABORTED = true,
}

local TRANSITIONS = {
    IDLE = { ASSESSING = true },
    ASSESSING = { PREPARING = true, EVADING = true, RETREATING = true, ABORTED = true, COMPLETE = true },
    PREPARING = { ENGAGING = true, RETREATING = true, ABORTED = true },
    ENGAGING = { EVADING = true, RETREATING = true, RECOVERING = true, COMPLETE = true, ABORTED = true },
    EVADING = { RETREATING = true, RECOVERING = true, COMPLETE = true, ABORTED = true },
    RETREATING = { RECOVERING = true, COMPLETE = true, ABORTED = true },
    RECOVERING = { COMPLETE = true, ABORTED = true },
    COMPLETE = { IDLE = true },
    ABORTED = { IDLE = true },
}

-- ─────────────── 敌人白名单（唯一允许自动交战的第一批普通敌人）───────────────
-- 与 TypeScript 侧 survival/profiles.ts 的 auto_engage_allowed=true 名单必须一致，
-- tests/phase6-lua.test.mjs 会逐项比对（防止两边漂移）。
local AUTONOMOUS_ENEMIES = {
    hound = true,
    spider = true,
    spider_warrior = true,
    mosquito = true,
    killerbee = true,
    frog = true,
    merm = true,
}

-- 永不自动交战：Boss 只能人工监督（SPECIAL_ENEMIES 里的也不在自动名单，交给上层策略）
local BOSS_PREFABS = {
    deerclops = true,
    bearger = true,
    dragonfly = true,
    beequeen = true,
    antlion = true,
    moose = true,
    klaus = true,
    malbatross = true,
    toadstool = true,
    spiderqueen = true,
    stalker = true,
    crabking = true,
}

-- 每类敌人的 Kiting 参数（秒/格）。读不到敌人真实攻击周期时用这张表兜底。
local KITE_PROFILES = {
    hound = { attack_range = 2.0, backoff = 0.55, dodge = 0.35 },
    spider = { attack_range = 2.0, backoff = 0.45, dodge = 0.30 },
    spider_warrior = { attack_range = 2.0, backoff = 0.50, dodge = 0.30 },
    mosquito = { attack_range = 2.0, backoff = 0.40, dodge = 0.25 },
    killerbee = { attack_range = 2.0, backoff = 0.40, dodge = 0.25 },
    frog = { attack_range = 2.0, backoff = 0.50, dodge = 0.30 },
    merm = { attack_range = 2.0, backoff = 0.60, dodge = 0.35 },
    DEFAULT = { attack_range = 2.0, backoff = 0.60, dodge = 0.40 },
}

local DEFAULT_RADIUS = 12
local MAX_RADIUS = 20
local DEFAULT_MAX_DURATION = 45
local MIN_MAX_DURATION = 5
local MAX_MAX_DURATION = 180
local DEFAULT_RETREAT_HP = 30
local DEFAULT_KITE_DISTANCE = 3.0

-- ─────────────── 运行时状态 ───────────────
local state = "IDLE"
local ctx = nil          -- 当前战斗上下文（含 report / command_id）
local loopTask = nil
local lastTickAt = 0
local transitions = {}   -- 最近的状态迁移审计（最多 40 条）
local counts = { started = 0, completed = 0, aborted = 0, denied = 0, kills = 0 }

local function now()
    local sim = GLOBAL.TheSim
    if sim ~= nil and sim.GetRealTime ~= nil then
        local ok, ms = pcall(function() return sim:GetRealTime() end)
        if ok and tonumber(ms) ~= nil then return (tonumber(ms) or 0) / 1000 end
    end
    local os_ = GLOBAL.os
    if os_ ~= nil and os_.time ~= nil then
        local ok, value = pcall(os_.time)
        if ok and tonumber(value) ~= nil then return tonumber(value) or 0 end
    end
    return 0
end

local function clamp(value, min, max, fallback)
    local n = tonumber(value)
    if n == nil then return fallback end
    if n < min then return min end
    if n > max then return max end
    return n
end

local function round(value, digits)
    if value == nil then return nil end
    local mult = 10 ^ (digits or 1)
    return math.floor(value * mult + 0.5) / mult
end

local function player()
    if Whale ~= nil and Whale.util ~= nil and Whale.util.player ~= nil then
        local ok, p = pcall(Whale.util.player)
        if ok then return p end
    end
    return nil
end

local function world_pos(ent)
    if ent == nil or ent.Transform == nil then return nil end
    local ok, x, y, z = pcall(function() return ent.Transform:GetWorldPosition() end)
    if ok and x ~= nil then return x, y, z end
    return nil
end

local function distance_tiles(a, b)
    local ax, _ay, az = world_pos(a)
    local bx, _by, bz = world_pos(b)
    if ax == nil or bx == nil then return nil end
    local dx, dz = ax - bx, az - bz
    return math.sqrt(dx * dx + dz * dz) / TILE
end

local function is_valid(ent)
    if ent == nil then return false end
    local ok, valid = pcall(function() return ent:IsValid() end)
    return ok and valid == true
end

local function health_percent(ent)
    if ent == nil or ent.components == nil or ent.components.health == nil then return nil end
    local ok, percent = pcall(function() return ent.components.health:GetPercent() end)
    if ok and tonumber(percent) ~= nil then return (tonumber(percent) or 0) * 100 end
    return nil
end

local function is_dead(ent)
    if ent == nil or ent.components == nil or ent.components.health == nil then return false end
    local ok, dead = pcall(function() return ent.components.health:IsDead() end)
    return ok and dead == true
end

local function has_tag(ent, tag)
    if ent == nil or ent.HasTag == nil then return false end
    local ok, value = pcall(function() return ent:HasTag(tag) end)
    return ok and value == true
end

-- ─────────────── 状态迁移 ───────────────

local function transition(next_state, why)
    if not STATES[next_state] then return false, "unknown_state" end
    if next_state == state then return true end
    local allowed = TRANSITIONS[state]
    if allowed == nil or allowed[next_state] ~= true then
        return false, "illegal_transition: " .. tostring(state) .. " -> " .. tostring(next_state)
    end
    transitions[#transitions + 1] = {
        from = state, to = next_state, at = round(now(), 2), why = why,
    }
    if #transitions > 40 then table.remove(transitions, 1) end
    state = next_state
    return true
end

-- ─────────────── 动作封装（只用游戏原生路径）───────────────

local function stop_movement(p)
    if p == nil then return end
    pcall(function()
        if p.components ~= nil and p.components.locomotor ~= nil then
            p.components.locomotor:Stop()
        end
        if p.ClearBufferedAction ~= nil then p:ClearBufferedAction() end
    end)
end

--- 走一段路：GoToPoint(pt, bufferedaction, run, overridedest)
--- 真机（Phase 5 M5）确认签名；run=true 才会跑起来。
local function goto_point(p, wx, wz)
    if p == nil or p.components == nil or p.components.locomotor == nil then return false end
    local Vector3 = GLOBAL.Vector3
    if Vector3 == nil then return false end
    local ok = pcall(function()
        p.components.locomotor:GoToPoint(Vector3(wx, 0, wz), nil, true)
    end)
    return ok
end

--- 朝/背离某个点移动，distance_tiles 为在目标点旁保持的距离
local function move_relative(p, target, keep_distance, away)
    local px, _py, pz = world_pos(p)
    local tx, _ty, tz = world_pos(target)
    if px == nil or tx == nil then return false end
    local dx, dz = px - tx, pz - tz
    local d = math.sqrt(dx * dx + dz * dz)
    if d < 0.01 then dx, dz, d = 1, 0, 1 end
    local nx, nz = dx / d, dz / d
    local wx, wz
    if away then
        wx, wz = px + nx * keep_distance * TILE, pz + nz * keep_distance * TILE
    else
        -- 站在目标点旁 keep_distance 格的位置上
        wx, wz = tx + nx * keep_distance * TILE, tz + nz * keep_distance * TILE
    end
    return goto_point(p, wx, wz)
end

--- 攻击一次：优先 combat:TryAttack（走游戏自己的攻击条件检查），否则退回 BufferedAction。
local function attack_once(p, target)
    if p == nil or target == nil then return false, "no_target" end
    local combat = p.components ~= nil and p.components.combat or nil
    if combat ~= nil and combat.TryAttack ~= nil then
        local ok, did = pcall(function() return combat:TryAttack(target) end)
        if ok and did == true then return true, "try_attack" end
        if ok then return false, "try_attack_refused" end
        -- TryAttack 抛错：不要当成功，交给上层判断
        return false, "try_attack_error"
    end
    local ACTIONS = GLOBAL.ACTIONS
    local BufferedAction = GLOBAL.BufferedAction
    if ACTIONS == nil or ACTIONS.ATTACK == nil or BufferedAction == nil then
        return false, "attack_api_unavailable"
    end
    local ok_push = pcall(function()
        local ba = BufferedAction(p, target, ACTIONS.ATTACK, nil)
        if p.components ~= nil and p.components.locomotor ~= nil then
            p.components.locomotor:PushAction(ba, true)
        else
            p:PushBufferedAction(ba)
        end
    end)
    if ok_push then return true, "buffered_action" end
    return false, "push_failed"
end

--- 能不能打（读游戏自己的判定；拿不到就当"可以试一次"，由 TryAttack 兜底）
local function can_attack(p, target)
    local combat = p ~= nil and p.components ~= nil and p.components.combat or nil
    if combat == nil or combat.CanAttack == nil then return nil end
    local ok, value = pcall(function() return combat:CanAttack(target) end)
    if ok then return value == true end
    return nil
end

--- 玩家自身的攻击距离（受当前武器影响）
local function player_attack_range(p, fallback)
    local combat = p ~= nil and p.components ~= nil and p.components.combat or nil
    if combat ~= nil and combat.GetAttackRange ~= nil then
        local ok, range = pcall(function() return combat:GetAttackRange() end)
        if ok and tonumber(range) ~= nil then return tonumber(range) end
    end
    return fallback or 2.0
end

-- ─────────────── 装备监控 ───────────────

local function equipped_of(slot_name)
    local p = player()
    if p == nil or p.components == nil or p.components.inventory == nil then return nil end
    local slots = GLOBAL.EQUIPSLOTS
    if slots == nil or slots[slot_name] == nil then return nil end
    local ok, item = pcall(function() return p.components.inventory:GetEquippedItem(slots[slot_name]) end)
    if not ok or item == nil then return nil end
    local entry = { prefab = item.prefab }
    if item.components ~= nil then
        if item.components.armor ~= nil then
            local ok_a, percent = pcall(function() return item.components.armor:GetPercent() end)
            if ok_a and percent ~= nil then entry.armor_percent = round(percent * 100, 0) end
        end
        if item.components.finiteuses ~= nil then
            local ok_u, uses = pcall(function() return item.components.finiteuses:GetUses() end)
            if ok_u and uses ~= nil then entry.uses_left = round(uses, 0) end
        end
    end
    return entry
end

local function equipment_snapshot()
    return {
        hands = equipped_of("HANDS"),
        body = equipped_of("BODY"),
        head = equipped_of("HEAD"),
    }
end

-- ─────────────── 目标选择 ───────────────

--- 找最近的可自动交战目标。白名单外的敌人一律不选（保守避战）。
local function find_target(p, want_prefab, radius)
    if GLOBAL.TheSim == nil then return nil, "no_sim" end
    local px, py, pz = world_pos(p)
    if px == nil then return nil, "no_position" end
    local ok_find, found = pcall(function()
        return GLOBAL.TheSim:FindEntities(px, py or 0, pz, radius * TILE, nil,
            { "INLIMBO", "FX", "DECOR", "NOCLICK" }, { "hostile", "monster" })
    end)
    if not ok_find or found == nil then return nil, "find_entities_failed" end
    local best, best_dist = nil, nil
    for _, ent in ipairs(found) do
        if is_valid(ent) and ent ~= p and not is_dead(ent) then
            local prefab = ent.prefab
            local allowed = (want_prefab ~= nil and want_prefab ~= "") and (prefab == want_prefab) or true
            if allowed and AUTONOMOUS_ENEMIES[prefab] == true then
                local d = distance_tiles(p, ent)
                if d ~= nil and (best_dist == nil or d < best_dist) then best, best_dist = ent, d end
            end
        end
    end
    if best == nil then return nil, "no_engageable_target" end
    return best, nil, best_dist
end

-- ─────────────── 结果回执 ───────────────

local function result_payload(extra)
    local payload = {
        combat_state = state,
        target = ctx ~= nil and ctx.target_prefab or nil,
        hits = ctx ~= nil and ctx.hits or 0,
        damage_taken = ctx ~= nil and ctx.damage_taken or 0,
        duration_s = ctx ~= nil and round(now() - ctx.started_at, 1) or 0,
        transitions = transitions,
    }
    if extra ~= nil then
        for k, v in pairs(extra) do payload[k] = v end
    end
    return payload
end

local function report_terminal(status, extra, err)
    if ctx == nil or ctx.report == nil then return end
    local report = ctx.report
    local command_id = ctx.command_id
    local startedMs = ctx.startedMs
    report(command_id, status, result_payload(extra), err, startedMs)
end

local function finish(final_state, extra, err, status)
    local ok = transition(final_state, "finish")
    if not ok then state = final_state end
    stop_movement(player())
    report_terminal(status or (final_state == "COMPLETE" and "SUCCEEDED" or "FAILED"), extra, err)
    if ctx ~= nil then
        if (status or (final_state == "COMPLETE" and "SUCCEEDED" or "FAILED")) == "SUCCEEDED" then
            counts.completed = counts.completed + 1
        else
            counts.aborted = counts.aborted + 1
        end
        ctx.finished_at = now()
        ctx.final_state = final_state
    end
    -- 保留上下文供 get_combat_status 查询，但清掉 report（避免重复回执）
    if ctx ~= nil then ctx.report = nil end
    state = final_state
end

-- ─────────────── 主 tick ───────────────

--- 战斗期间的"控制权/紧急停止"在线复核（每 2 秒一次，异步，不阻塞 tick）。
--- 为什么战斗要额外查：控制权 assert 只在命令**开始**时做了一次，
--- 而战斗可能持续几十秒 —— 中途人工接管、紧急停止、lease 过期都必须立刻停手。
local controlCheckInFlight = false
local function check_control_async()
    if ctx == nil or controlCheckInFlight then return end
    local controllerId = ctx.controller_id
    local sessionId = ctx.session_id
    if type(controllerId) ~= "string" or controllerId == "" then return end
    if BWS2.http == nil or BWS2.config == nil then return end
    controlCheckInFlight = true
    local payload = {
        protocol_version = BWS2.connection.protocolVersion(),
        token = BWS2.config.get().token,
        controller_id = controllerId,
        session_id = sessionId,
        read_only = false,
    }
    local ok_post = pcall(function()
        BWS2.http.post("/api/v1/control/assert", payload, function(response)
            controlCheckInFlight = false
            if ctx == nil then return end
            local body = response ~= nil and response.body or nil
            local decoded = nil
            if type(body) == "string" then
                local ok_decode, value = pcall(BWS.json.decode, body)
                if ok_decode then decoded = value end
            elseif type(body) == "table" then
                decoded = body
            end
            if decoded ~= nil and decoded.allowed ~= true then
                local code = tostring(decoded.code or "CONTROL_DENIED")
                -- 紧急停止 / 人工接管 / lease 过期：一律立刻停手
                local p = player()
                if p ~= nil then stop_movement(p) end
                finish("ABORTED", { reason = "control_revoked", code = code },
                    "control_revoked: " .. code .. "（" .. tostring(decoded.message or "") .. "）", "FAILED")
            end
        end, 4)
    end)
    if not ok_post then controlCheckInFlight = false end
end

local function tick_body()
    lastTickAt = now()
    if ctx == nil then return end
    if state == "IDLE" or state == "COMPLETE" or state == "ABORTED" then return end

    -- 每 2 秒复核一次控制权（紧急停止优先级最高）
    if ctx.next_control_check == nil or now() >= ctx.next_control_check then
        ctx.next_control_check = now() + 2.0
        check_control_async()
    end

    local p = player()
    if p == nil then return end

    local hp = health_percent(p)
    ctx.min_hp = ctx.min_hp or hp
    if hp ~= nil and ctx.min_hp ~= nil and hp < ctx.min_hp then ctx.min_hp = hp end
    if ctx.hp_start == nil then ctx.hp_start = hp end
    local elapsed = now() - ctx.started_at

    -- ① 全局中断条件：死了 / 超时 / 敌人没了
    local dead = is_dead(p) or has_tag(p, "playerghost")
    if dead then
        finish("ABORTED", { reason = "player_died" }, "player_died: 角色已死亡，战斗中止", "FAILED")
        return
    end
    if elapsed > ctx.max_duration then
        finish("COMPLETE", { reason = "timeout", hp_percent = hp }, nil, "SUCCEEDED")
        return
    end

    -- ② 每个 tick 都复核血量，低于阈值立刻脱离（不靠上层提醒）
    if hp ~= nil and hp <= ctx.retreat_hp and state ~= "RETREATING" then
        transition("RETREATING", "hp_below_threshold")
        ctx.retreat_until = now() + ctx.retreat_seconds
    end

    -- ③ 装备监控（每秒一次就够）
    if ctx.next_equip_check == nil or now() >= ctx.next_equip_check then
        ctx.next_equip_check = now() + 1.0
        local equipment = equipment_snapshot()
        ctx.equipment = equipment
        local warnings = {}
        if equipment.hands == nil then warnings[#warnings + 1] = "no_weapon" end
        if equipment.body ~= nil and equipment.body.armor_percent ~= nil
            and equipment.body.armor_percent <= 5 then warnings[#warnings + 1] = "body_armor_broken" end
        if equipment.head ~= nil and equipment.head.armor_percent ~= nil
            and equipment.head.armor_percent <= 5 then warnings[#warnings + 1] = "head_armor_broken" end
        ctx.equipment_warnings = warnings
    end

    if state == "ASSESSING" then
        -- 重新确认目标还在
        if not is_valid(ctx.target) or is_dead(ctx.target) then
            finish("COMPLETE", { reason = "target_gone", hp_percent = hp }, nil, "SUCCEEDED")
            return
        end
        transition("PREPARING", "assess_ok")
    end

    if state == "PREPARING" then
        -- 面向目标、记下起始装备，然后进入交战
        ctx.attack_range = player_attack_range(p, ctx.profile.attack_range)
        ctx.hp_start = ctx.hp_start or hp
        transition("ENGAGING", "prepared")
    end

    if state == "ENGAGING" then
        local target = ctx.target
        if not is_valid(target) or is_dead(target) then
            if is_dead(target) then counts.kills = counts.kills + 1 end
            finish("COMPLETE", {
                reason = "target_dead", kills = counts.kills, hp_percent = hp,
                damage_taken = (ctx.hp_start ~= nil and hp ~= nil) and round(ctx.hp_start - hp, 1) or nil,
            }, nil, "SUCCEEDED")
            return
        end

        local d = distance_tiles(p, target)
        if d == nil then
            finish("ABORTED", { reason = "lost_position" }, "lost_target_position", "FAILED")
            return
        end
        ctx.last_distance = round(d, 2)

        local range = ctx.attack_range or 2.0
        local t = now()

        -- 目标正在出手且我在它攻击圈里 → 先让开（这是 Kiting 的核心）
        local target_attacking = false
        if target.sg ~= nil and target.sg.HasStateTag ~= nil then
            local ok_attacking, attacking = pcall(function() return target.sg:HasStateTag("attack") end)
            target_attacking = ok_attacking and attacking == true
        end

        if target_attacking and d <= range + 0.6 and t >= (ctx.backoff_until or 0) then
            ctx.dodges = (ctx.dodges or 0) + 1
            move_relative(p, target, ctx.kite_distance, true)
            ctx.backoff_until = t + ctx.profile.dodge
            return
        end

        -- 打完一刀后的后退窗口：保持距离，等攻击冷却
        if t < (ctx.backoff_until or 0) then
            move_relative(p, target, ctx.kite_distance, true)
            return
        end

        if d > range * 0.9 then
            -- 够不着：走到攻击距离边上
            move_relative(p, target, range * 0.75, false)
            return
        end

        local allowed = can_attack(p, target)
        if allowed == false then
            -- 冷却没好：保持距离等他出手
            move_relative(p, target, ctx.kite_distance, true)
            return
        end

        local ok_attack, how = attack_once(p, target)
        if ok_attack then
            ctx.hits = ctx.hits + 1
            ctx.last_attack_api = how
            ctx.backoff_until = t + ctx.profile.backoff
        else
            ctx.last_attack_error = how
            if how == "attack_api_unavailable" then
                finish("ABORTED", { reason = "no_attack_api" }, "attack_api_unavailable", "FAILED")
                return
            end
            -- 打不出去就先退一步再说，别站着挨打
            move_relative(p, target, ctx.kite_distance, true)
            ctx.backoff_until = t + ctx.profile.backoff
        end
        return
    end

    if state == "RETREATING" then
        -- 背对威胁跑，直到超过安全距离或者到点
        local source = ctx.target
        if is_valid(source) then
            move_relative(p, source, 6, true)
        else
            local px, _py, pz = world_pos(p)
            if px ~= nil then goto_point(p, px + 6 * TILE, pz) end
        end
        local d = is_valid(source) and distance_tiles(p, source) or nil
        if (d ~= nil and d >= 8) or now() > (ctx.retreat_until or 0) then
            transition("RECOVERING", "escaped")
            ctx.recovered_at = now()
        end
        return
    end

    if state == "EVADING" then
        local source = ctx.target
        if is_valid(source) then
            move_relative(p, source, 6, true)
        end
        local d = is_valid(source) and distance_tiles(p, source) or nil
        if (d ~= nil and d >= ctx.evade_distance) or now() > ctx.evade_until then
            transition("RECOVERING", "evade_done")
        end
        return
    end

    if state == "RECOVERING" then
        -- 恢复阶段只做检查与报告，不自动进食（进食要走人工确认的 eat_item）
        local hp_now = health_percent(p)
        finish("COMPLETE", {
            reason = "recovered",
            hp_percent = hp_now,
            hp_lost = (ctx.hp_start ~= nil and hp_now ~= nil) and round(ctx.hp_start - hp_now, 1) or nil,
            min_hp = ctx.min_hp,
            needs_healing = (hp_now ~= nil and hp_now < 60) or false,
        }, nil, "SUCCEEDED")
        return
    end
end

--- 周期任务（战斗期间才存在）
local function ensure_loop()
    if loopTask ~= nil then return true end
    local world = GLOBAL.TheWorld
    if world == nil or world.DoPeriodicTask == nil then return false end
    local ok, task = pcall(function()
        return world:DoPeriodicTask(TICK_INTERVAL, function()
            local ok_tick, err = pcall(tick_body)
            if not ok_tick then
                print("[BWS2] WARN 战斗 tick 出错：" .. tostring(err))
            end
        end)
    end)
    if ok then loopTask = task end
    return ok and loopTask ~= nil
end

local function stop_loop()
    if loopTask ~= nil then
        pcall(function() loopTask:Cancel() end)
        loopTask = nil
    end
end

--- 观察器 tick 补跑（周期任务失效时兜底，和 net.keepAlive 同一套思路）
function C.Drive()
    local at = now()
    if ctx == nil then return end
    if state == "IDLE" or state == "COMPLETE" or state == "ABORTED" then return end
    if at - lastTickAt >= TICK_STALE_GAP then
        local ok, err = pcall(tick_body)
        if not ok then print("[BWS2] WARN 战斗补跑 tick 出错：" .. tostring(err)) end
    end
    ensure_loop()
end

-- ─────────────── 对外：API 探测 ───────────────

--- 探测当前构建里战斗相关 API 是否存在（任务书要求：不能凭空假设）
function C.ProbeApi()
    local p = player()
    local api = {}
    local combat = p ~= nil and p.components ~= nil and p.components.combat or nil
    api.player_combat = combat ~= nil
    api.try_attack = (combat ~= nil and combat.TryAttack ~= nil) or false
    api.can_attack = (combat ~= nil and combat.CanAttack ~= nil) or false
    api.get_attack_range = (combat ~= nil and combat.GetAttackRange ~= nil) or false
    api.actions_attack = (GLOBAL.ACTIONS ~= nil and GLOBAL.ACTIONS.ATTACK ~= nil) or false
    api.buffered_action = GLOBAL.BufferedAction ~= nil
    api.locomotor_goto = (p ~= nil and p.components ~= nil and p.components.locomotor ~= nil
        and p.components.locomotor.GoToPoint ~= nil) or false
    api.player_attack_range = round(player_attack_range(p, 2.0), 2)
    api.note = "TryAttack 是首选路径；两者都不可用时战斗会被拒绝（不会 ForceAttack）"
    return api
end

-- ─────────────── 对外：状态 ───────────────

function C.status()
    local p = player()
    local hp = health_percent(p)
    return {
        ok = true,
        state = state,
        active = (state == "ASSESSING" or state == "PREPARING" or state == "ENGAGING"
            or state == "EVADING" or state == "RETREATING" or state == "RECOVERING"),
        target = ctx ~= nil and ctx.target_prefab or nil,
        target_hp = ctx ~= nil and is_valid(ctx.target) and round(health_percent(ctx.target), 0) or nil,
        target_distance = ctx ~= nil and ctx.last_distance or nil,
        hits = ctx ~= nil and ctx.hits or 0,
        dodges = ctx ~= nil and ctx.dodges or 0,
        hp_percent = round(hp, 1),
        hp_start = ctx ~= nil and round(ctx.hp_start, 1) or nil,
        min_hp = ctx ~= nil and round(ctx.min_hp, 1) or nil,
        equipment = ctx ~= nil and ctx.equipment or equipment_snapshot(),
        equipment_warnings = ctx ~= nil and ctx.equipment_warnings or nil,
        attack_range = ctx ~= nil and round(ctx.attack_range, 2) or nil,
        last_attack_api = ctx ~= nil and ctx.last_attack_api or nil,
        last_attack_error = ctx ~= nil and ctx.last_attack_error or nil,
        duration_s = ctx ~= nil and round(now() - ctx.started_at, 1) or 0,
        transitions = transitions,
        counts = counts,
        api = C.ProbeApi(),
    }
end

function C.is_active()
    return state == "ASSESSING" or state == "PREPARING" or state == "ENGAGING"
        or state == "EVADING" or state == "RETREATING" or state == "RECOVERING"
end

-- ─────────────── 对外：启动 / 撤退 / 规避 / 中止 ───────────────

--- 战斗/规避属于高优先级事件：先把低优先级的普通任务链停掉（任务书 §7：允许中断采集与探索）
local function interrupt_low_priority()
    if BWS2.tasks ~= nil and BWS2.tasks.Stop ~= nil then
        local ok, err = pcall(BWS2.tasks.Stop, '战斗中断')
        if ok and err == true then
            print('[BWS2] INFO 战斗打断普通任务')
        end
    end
end

local function begin(command, report, startedMs, mode, want_state)
    if state == "ASSESSING" or state == "PREPARING" or state == "ENGAGING"
        or state == "EVADING" or state == "RETREATING" or state == "RECOVERING" then
        counts.denied = counts.denied + 1
        return false, "combat_already_running: 已有战斗在执行（同一时间只允许一个战斗执行器）"
    end

    local p = player()
    if p == nil then return false, "no_player" end
    local params = command.params or {}
    interrupt_low_priority()

    -- 先把上一场战斗的终态清成 IDLE，保证迁移合法
    state = "IDLE"

    local radius = clamp(params.radius, 2, MAX_RADIUS, DEFAULT_RADIUS)
    local target_prefab = params.target_prefab
    if target_prefab ~= nil and target_prefab ~= "" and type(target_prefab) ~= "string" then
        return false, "invalid_target: target_prefab 必须是字符串"
    end
    if type(target_prefab) == "string" and target_prefab ~= "" then
        if BOSS_PREFABS[target_prefab] == true then
            return false, "boss_requires_supervised_combat: Boss 不允许自动交战（必须人工监督）"
        end
        if AUTONOMOUS_ENEMIES[target_prefab] ~= true then
            return false, "unverified_enemy: 该生物没有经过验证的战斗档案，按保守策略拒绝自动交战"
        end
    end

    local target, err, _d = find_target(p, target_prefab, radius)
    if target == nil then return false, tostring(err or "no_target") end
    if BOSS_PREFABS[target.prefab] == true then
        return false, "boss_requires_supervised_combat: 目标是 Boss，需要人工监督"
    end

    local profile = KITE_PROFILES[target.prefab] or KITE_PROFILES.DEFAULT
    transitions = {}
    ctx = {
        command_id = command.id,
        report = report,
        startedMs = startedMs,
        controller_id = params.controller_id,
        session_id = params.session_id,
        target = target,
        target_prefab = target.prefab,
        profile = profile,
        mode = mode,
        started_at = now(),
        hp_start = health_percent(p),
        hits = 0,
        dodges = 0,
        damage_taken = 0,
        max_duration = clamp(params.max_duration_s, MIN_MAX_DURATION, MAX_MAX_DURATION, DEFAULT_MAX_DURATION),
        retreat_hp = clamp(params.retreat_hp_percent, 10, 80, DEFAULT_RETREAT_HP),
        kite_distance = clamp(params.kite_distance, 1.5, 6.0, DEFAULT_KITE_DISTANCE),
        retreat_seconds = 6,
        evading = false,
    }
    counts.started = counts.started + 1
    state = "IDLE"
    local ok_t, terr = transition(want_state or "ASSESSING", "command")
    if not ok_t then
        ctx = nil
        return false, tostring(terr)
    end
    ensure_loop()
    lastTickAt = now()
    return true, nil
end

--- commands.lua / action_executor 调这里（控制权已校验过）
function C.executeCommand(command, report, startedMs)
    local kind = command.type
    local params = command.params or {}

    -- 战斗/规避/撤退都属于高优先级：先把普通任务链停掉
    if kind ~= "abort_combat" then interrupt_low_priority() end

    local function fail(code, message)
        counts.denied = counts.denied + 1
        if report ~= nil then report(command.id, "FAILED", nil, code .. ": " .. message, startedMs) end
        return { status = "FAILED", error = code .. ": " .. message }
    end

    if kind == "start_combat" then
        -- 第一版 = 人工监督战斗：必须显式 confirmed=true
        if params.confirmed ~= true then
            return fail("confirmation_required", "start_combat 需要人工确认：参数必须显式带 confirmed=true")
        end
    end

    if kind == "abort_combat" then
        if ctx ~= nil and C.is_active() then
            local p = player()
            if p ~= nil then stop_movement(p) end
            finish("ABORTED", { reason = "abort_command" }, "aborted: 收到中止命令", "FAILED")
        else
            state = "IDLE"
            if report ~= nil then
                report(command.id, "SUCCEEDED", { combat_state = "IDLE", aborted = false, note = "当前没有进行中的战斗" }, nil, startedMs)
            end
        end
        return { status = "SUCCEEDED" }
    end

    if kind == "retreat_from_combat" then
        if ctx == nil or not C.is_active() then
            -- 没有战斗也要能撤：退化成一次"背离最近威胁的移动"
            local p = player()
            if p == nil then return fail("no_player", "找不到玩家") end
            local target = find_target(p, nil, clamp(params.radius, 2, MAX_RADIUS, DEFAULT_RADIUS))
            if target == nil then
                if report ~= nil then
                    report(command.id, "SUCCEEDED", { combat_state = state, retreated = false, note = "附近没有需要躲避的敌人" }, nil, startedMs)
                end
                return { status = "SUCCEEDED" }
            end
            transitions = {}
            ctx = {
                command_id = command.id, report = report, startedMs = startedMs,
                controller_id = params.controller_id, session_id = params.session_id,
                target = target, target_prefab = target.prefab, profile = KITE_PROFILES.DEFAULT,
                started_at = now(), hp_start = health_percent(p), hits = 0, dodges = 0,
                max_duration = clamp(params.max_duration_s, MIN_MAX_DURATION, MAX_MAX_DURATION, 30),
                retreat_hp = 100, kite_distance = DEFAULT_KITE_DISTANCE, retreat_seconds = 8,
            }
            state = "IDLE"
            transition("RETREATING", "retreat_command")
            ctx.retreat_until = now() + ctx.retreat_seconds
            ensure_loop()
            lastTickAt = now()
            if report ~= nil then
                report(command.id, "EXECUTING", { accepted = true, action = kind, combat_state = state, running = true }, nil, startedMs)
            end
            return { status = "EXECUTING" }
        end
        local p = player()
        if p ~= nil then stop_movement(p) end
        if transition("RETREATING", "retreat_command") then
            ctx.retreat_until = now() + 8
            if report ~= nil then
                report(command.id, "EXECUTING", { accepted = true, action = kind, combat_state = state, running = true }, nil, startedMs)
            end
            return { status = "EXECUTING" }
        end
        return fail("illegal_transition", "当前状态 " .. tostring(state) .. " 不能撤退")
    end

    if kind == "evade_threat" then
        local p = player()
        if p == nil then return fail("no_player", "找不到玩家") end
        if C.is_active() then
            return fail("combat_already_running", "战斗进行中：先 abort_combat 再规避")
        end
        local radius = clamp(params.radius, 2, MAX_RADIUS, DEFAULT_RADIUS)
        local source = find_target(p, params.target_prefab, radius)        if source == nil then
            if report ~= nil then
                report(command.id, "SUCCEEDED", { combat_state = "IDLE", evaded = false, note = "附近没有需要规避的敌人" }, nil, startedMs)
            end
            return { status = "SUCCEEDED" }
        end
        transitions = {}
        ctx = {
            command_id = command.id, report = report, startedMs = startedMs,
            controller_id = params.controller_id, session_id = params.session_id,
            target = source, target_prefab = source.prefab, profile = KITE_PROFILES.DEFAULT,
            started_at = now(), hp_start = health_percent(p), hits = 0, dodges = 0,
            max_duration = clamp(params.max_duration_s, MIN_MAX_DURATION, MAX_MAX_DURATION, 20),
            retreat_hp = 100, kite_distance = DEFAULT_KITE_DISTANCE, retreat_seconds = 10,
            evade_distance = clamp(params.distance, 4, 30, 10),
        }
        state = "IDLE"
        ctx.evade_until = now() + ctx.max_duration
        transition("EVADING", "evade_command")
        ensure_loop()
        lastTickAt = now()
        if report ~= nil then
            report(command.id, "EXECUTING", { accepted = true, action = kind, combat_state = state, running = true }, nil, startedMs)
        end
        return { status = "EXECUTING" }
    end

    if kind == "start_combat" then
        local ok, err = begin(command, report, startedMs, "kite", "ASSESSING")
        if not ok then return fail("combat_rejected", tostring(err)) end
        if report ~= nil then
            report(command.id, "EXECUTING", {
                accepted = true, action = kind, combat_state = state,
                target = ctx.target_prefab, running = true,
                note = "SUPERVISED_COMBAT：以人工确认启动；血量低于 " .. tostring(ctx.retreat_hp) .. "% 会自动脱离",
            }, nil, startedMs)
        end
        return { status = "EXECUTING" }
    end

    return fail("unknown_action", "不认识的战斗命令：" .. tostring(kind))
end

--- 紧急停止 / 外部强制中止（不回报给 Bridge，由调用方负责）
function C.ForceStop(reason)
    local p = player()
    if p ~= nil then stop_movement(p) end
    if ctx ~= nil and C.is_active() then
        ctx.report = nil
        state = "IDLE"
        transitions = {}
        counts.aborted = counts.aborted + 1
    else
        state = "IDLE"
    end
    stop_loop()
    return true, reason
end

BWS2.combat = C
