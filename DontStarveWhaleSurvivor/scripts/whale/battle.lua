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
        swings_per_cycle = 1,       -- 蜘蛛战士硬直短、有跳扑，保守打一撤一
        retreat_distance = 4.0,     -- 拉开更大距离防跳跃扑击
        retreat_duration = 1.0,
        reset_duration = 0.5,
        can_kite = true,
        supported = true,
    },
    -- ★ R8.5：青蛙（依据 .runtime/dst-scripts）：
    --   prefabs/frog.lua：FROG_HEALTH=100、FROG_DAMAGE=10、FROG_ATTACK_PERIOD=1、runspeed=8；
    --     tags: hostile / animal / prey / smallcreature / frog；onhitother → thief:StealItem(目标)
    --     —— **命中会击落玩家背包里的一件物品**（这就是"阿比盖尔之花被击落"的原版机制）；
    --     OnAttacked → ShareTarget(30, 同tag "frog") —— 打一只会引来周围青蛙协同敌对。
    --   brains/frogbrain.lua：ChaseAndAttack(MAX_CHASE_TIME=8) → 追击不放弃，不能靠直线跑甩掉。
    --   ⇒ 策略要点：血薄（100）、攻速快（1s）、会击落物品、会成群。
    --     所以"打一撤一"、保持 3.5 格、并且优先让伴生生物承担输出（温蒂 avoid_melee）。
    frog = {
        name = "frog",
        display_name = "青蛙",
        swings_per_cycle = 1,       -- 攻速 1s，硬直短：只打一下就走
        retreat_distance = 3.5,     -- 每次出手后必须拉开，避免被连咬击落物品
        retreat_duration = 0.8,
        reset_duration = 0.5,
        can_kite = true,
        supported = true,
        drops_items = true,         -- 命中会击落背包物品（保护 key item 用）
        share_target = true,        -- 被打会喊周围青蛙一起上
        fragile = true,             -- 100 血，优先集火/快速击杀
    },
    hound = {
        name = "hound",
        display_name = "猎犬",
        swings_per_cycle = 2,       -- 猎犬咬完后摇约 2s，打二撤一
        retreat_distance = 4.0,     -- 避开猎犬扑咬
        retreat_duration = 0.8,
        reset_duration = 0.3,
        can_kite = true,
        supported = true,
        fast_chaser = true,        -- 移速极快(10)，不可无脑逃跑
    },
    icehound = {
        name = "icehound",
        display_name = "冰猎犬",
        swings_per_cycle = 1,       -- 保守打一，防冰冻
        retreat_distance = 4.5,
        retreat_duration = 1.0,
        reset_duration = 0.4,
        can_kite = true,
        supported = true,
        fast_chaser = true,
        on_death_effect = "freeze",
    },
    firehound = {
        name = "firehound",
        display_name = "火猎犬",
        swings_per_cycle = 1,       -- 保守打一
        retreat_distance = 5.0,     -- 死亡产生 3 团火焰，击杀后需拉开大距离
        retreat_duration = 1.2,
        reset_duration = 0.4,
        can_kite = true,
        supported = true,
        fast_chaser = true,
        on_death_effect = "fire_explosion",
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
    houndstooth = 1,    -- 狗牙优先
    redgem = 2,         -- 红宝石
    bluegem = 2,        -- 蓝宝石
    silk = 3,           -- 蜘蛛丝
    spidergland = 4,    -- 蜘蛛腺体
    monstermeat = 5,    -- 怪物肉
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

-- ★ R8.5 真机 bug：防御会话必须在**这里**前置声明。
--   之前 `local defense` 写在文件更靠下（战斗状态机附近），而 B.Cleanup() 定义在它之前，
--   Lua 的作用域规则让 Cleanup 里引用到的是**全局** defense（永远是 nil），
--   于是真机上会话结束后 `DefenseStatus()` 仍返回 "engaged"、Reflex 一直以为在防御而不敢逃跑。
local defense = nil
-- 停手中止后的冷却时间点（R8.5：防止"开战→停手→立刻再开战"的 8 秒死循环）
local defense_retry_at = 0

function B.Cleanup()
    if session ~= nil then
        session = nil
    end
    -- R8.5：战斗会话结束 = 这次防御已收尾；防御交接状态一并清掉，
    -- 让 reflex 下一次调度重新评估"要不要重新召唤/再来一场防御"。
    if defense ~= nil and defense.phase ~= "summoning" then
        defense = nil
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

-- ─────────────── 角色 / 伴生 / 防御会话（R8.5）───────────────
--
-- 红线：防御**不是**第二条战斗执行器。它只通过既有 A.Start 启动既有 JOBS
--      （summon_companion / fight_spider），由 A.Tick 推进；这里只保存"交接状态"，
--      供 reflex 判定要不要抑制 flee，以及决定是否回退撤退。

local DEFENSE_ID = (A ~= nil and A.DEFENSE_ID) or "defense"
B.DEFENSE_ID = DEFENSE_ID

local SUMMON_TIMEOUT_S = 8           -- 召唤交接最长容忍时间（超过就回退逃跑）
local SUMMON_RETRY_COOLDOWN_S = 20   -- 召唤失败后的退避，禁止无限重试
local GROUP_MAX_WITH_COMPANION = 3   -- 伴生健康时可同时纠缠的敌人数上限
local COMPANION_MIN_HEALTH = 0.40    -- 阿比盖尔低于此比例不再算"能扛"
-- ★ R8.5 真机发现（第 1 天青蛙战）：战斗 job 被 A.Tick 的预算判失败时，battle 会话不会收尾，
--   于是 B.InCombat()/active_target 永久悬挂、REFLEX_SUPPRESSED 每秒刷却没有 FINISH。
--   除了 core.A.Tick 里显式 Abort 之外，battle 自己也必须有硬上限，避免任何调用方忘了收尾。
local MAX_SESSION_S = 45             -- 单场战斗硬上限（秒）
local STALL_ABORT_S = 8              -- 伴生主战时连续无伤害多久判"停手"（阿比盖尔跑出防御范围）
local STALL_RETRY_S = 6              -- 停手中止后的冷却：这段时间不要马上又开一场（让 Reflex 先脱离）

-- 防御会话：{ phase="summoning"|"engaged"|"failed", target, target_guid, target_prefab,
--             started_at, summon_started_at, retry_at, reason }
-- 注意：`local defense` 已在文件上方（B.Cleanup 之前）前置声明，这里不能重复 local，
-- 否则会遮蔽出第二个变量、Cleanup 又清不到它（真机踩过）。

local function resolve_profile(p)
    local ch = Whale ~= nil and Whale.character or nil
    if ch == nil or ch.Resolve == nil then return nil end
    local ok, prof = pcall(function() return ch.Resolve(p) end)
    if ok and type(prof) == "table" then return prof end
    return nil
end

local function combat_policy_of(p, prof)
    prof = prof or resolve_profile(p)
    if prof == nil or prof.GetCombatPolicy == nil then return nil end
    local ok, pol = pcall(function() return prof.GetCombatPolicy(p) end)
    if ok and type(pol) == "table" then return pol end
    return nil
end

local function companion_of(p)
    local ch = Whale ~= nil and Whale.character or nil
    if ch == nil or ch.GetCompanionState == nil then return nil end
    local ok, st = pcall(function() return ch.GetCompanionState(p) end)
    if ok and type(st) == "table" then return st end
    return nil
end

local function is_wendy(p)
    local prof = resolve_profile(p)
    return prof ~= nil and prof.id == "wendy"
end

local function same_entity(a, b)
    if a == nil or b == nil then return false end
    if a == b then return true end
    return a.GUID ~= nil and b.GUID ~= nil and a.GUID == b.GUID
end

--- 伴生是否能"扛住当前群体"。区分"只是附近有敌人"和"真的在打温蒂"。
--- 返回 ok, why。allow 时不会放开硬上限：>3 只仍然强制撤退。
local function can_tolerate_group(p, attacker_count)
    if attacker_count <= 1 then return true, "single" end
    if attacker_count > GROUP_MAX_WITH_COMPANION then
        return false, "too_many_attackers"
    end
    local comp = companion_of(p)
    if comp == nil or comp.alive ~= true or comp.can_assist ~= true then
        return false, "no_companion_support"
    end
    local chp = comp.health_percent
    if chp ~= nil and chp < COMPANION_MIN_HEALTH then
        return false, "companion_low_health"
    end
    local hp = get_health_percent(p)
    if hp ~= nil and hp < 0.50 then
        return false, "player_low_health"
    end
    return true, "companion_supported"
end
B.CanTolerateGroup = can_tolerate_group

--- 防御会话快照（给 reflex / observe / 诊断用）
function B.DefenseStatus()
    if defense == nil then return nil end
    -- ★ 自愈：engaged 但没有对应的防御 job 在跑，说明交接已经结束/被抢走。
    --   这里必须主动清掉：否则上层会永远以为"还在防御"而不敢逃跑（真机踩过）。
    if defense.phase == "engaged" then
        local job = (Whale ~= nil) and Whale.job or nil
        if job == nil or job.cmd_id ~= DEFENSE_ID or job.name ~= "fight_spider" then
            defense = nil
            return nil
        end
    end
    return {
        phase = defense.phase or "unknown",
        target_prefab = defense.target_prefab,
        target_guid = defense.target_guid,
        started_at = defense.started_at,
        summon_started_at = defense.summon_started_at,
        reason = defense.reason,
    }
end

--- 主动结束防御交接（reflex 决定撤退时调用；会安全清掉 defense job）
function B.AbortDefense(reason)
    if defense == nil then return false end
    local job = Whale.job
    if job ~= nil and job.cmd_id == DEFENSE_ID then
        pcall(function() A.Abort(reason or "defense_abort") end)
    end
    blog("DEFENSE_ABORT", {
        reason = reason or "manual",
        target = defense.target_prefab or "none",
        phase = defense.phase or "unknown",
    })
    defense = nil
    return true
end

-- ─────────────── 保命反射协同接口 ───────────────
--- 供 reflex.lua 判定是否应当抑制普通单怪被攻击逃跑
function B.ShouldSuppressReflex(p, attacker)
    if session == nil or not B.InCombat() then return false end
    local target = session.target
    if target == nil or not is_alive(target) then return false end

    -- 攻击者必须是当前锁定的目标
    local is_same_target = same_entity(attacker, target)
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

    -- 硬规则2：群体围攻。
    -- ★ R8.5：旧规则是"num_attackers>1 直接紧急覆盖"，导致"三只青蛙在附近"
    --   永远进不了防御（真机：flee 反复启动、advance_task 一直被阻断）。
    --   现在：只有当敌人**真的把温蒂当目标**时才计数；伴生健康且可协助时允许受控群战，
    --   硬上限 3 只、且阿比盖尔/温蒂血量任何一项跌破安全线都立刻回退保命。
    local num_attackers = count_attackers_targeting(p, 8)
    if num_attackers > 1 then
        local allow, why = can_tolerate_group(p, num_attackers)
        if not allow then
            blog("REFLEX_EMERGENCY_OVERRIDE", {
                reason = "outnumbered:" .. tostring(why),
                count = num_attackers,
                target = session.target_prefab or "none",
            })
            session.reflex_intervened = "outnumbered"
            return false
        end
        blog("COMPANION_GROUP_ENGAGE", {
            count = num_attackers,
            reason = tostring(why),
            target = session.target_prefab or "none",
        })
    end

    -- 正常受控交战：抑制保命反射的 P0 flee，让战斗系统自主执行
    session.reflex_suppressed_count = (session.reflex_suppressed_count or 0) + 1
    blog("REFLEX_SUPPRESSED", {
        target = session.target_prefab or "none",
        guid = session.target_guid or 0,
        hp = hp ~= nil and string.format("%.2f", hp) or "unknown",
        companion_led = session.companion_led == true,
    })
    return true
end

--- 供 reflex.lua 组织受控防御（含 Wendy 的伴生召唤交接）。
---
--- 返回状态字符串（调用方据此决定是否抑制 flee）：
---   "engaged"    已接管为战术防御（战斗 job 已启动或本就在打同一目标）
---   "summoning"  已启动 summon_companion 交接（有花、阿比盖尔未到场）
---   "rejected"   不能接管 —— 调用方应回退到 Reflex 逃跑
---
--- ★ 绝不在这里自己 BufferedAction(CASTSUMMON)：召唤必须复用 actions/combat.lua 的
---   JOBS.summon_companion（它带契约检查/花朵检查/已召唤检查/summon_succeeded 核验）。
function B.StartDefense(p, attacker)
    if p == nil or attacker == nil or not is_alive(attacker) then return "rejected" end
    -- 停手中止后的冷却：这段时间先让 Reflex 脱离，不要马上又开一场（否则 8 秒一循环）
    if U.now() < (defense_retry_at or 0) then
        blog("DEFENSE_HANDOFF", {
            reason = "cooldown_after_stall",
            retry_in = string.format("%.1f", (defense_retry_at or 0) - U.now()),
        })
        return "rejected"
    end
    local prefab = tostring(attacker.prefab or "")
    local strategy = STRATEGIES[prefab]
    if strategy == nil or not strategy.supported then return "rejected" end
    if BOSS_PREFABS[prefab] then
        blog("DEFENSE_ABORT", { reason = "boss_forbidden", target = prefab })
        return "rejected"
    end

    -- 残血（<25%）不硬接，让保命反射接管逃生
    local hp = get_health_percent(p)
    if hp ~= nil and hp < 0.25 then return "rejected" end

    -- 已在受控交战中且目标就是该怪，保持交战并抑制 flee
    if session ~= nil and B.InCombat() and same_entity(session.target, attacker) then
        if defense ~= nil then defense.phase = "engaged" end
        return "engaged"
    end

    -- 已在"等召唤完成"的交接中：不重复启动（job 仍是 summon_companion 就继续保持）
    if defense ~= nil and defense.phase == "summoning" then
        local job = Whale.job
        if job ~= nil and job.name == "summon_companion" and job.cmd_id == DEFENSE_ID then
            blog("DEFENSE_CANDIDATE", { target = prefab, phase = "summoning", guid = attacker.GUID })
            return "summoning"
        end
        -- 召唤 job 已经结束：用真实状态判定成功/失败，绝不"没成功就再来一次"
        local comp0 = companion_of(p)
        if comp0 ~= nil and comp0.can_assist == true then
            defense = nil   -- 成功：交给下面的常规判定进入防御
        else
            local now0 = U.now()
            blog("DEFENSE_HANDOFF", {
                target = prefab, phase = "failed", reason = "summon_not_completed",
            })
            defense = {
                phase = "failed",
                started_at = now0,
                retry_at = now0 + SUMMON_RETRY_COOLDOWN_S,
                target_prefab = prefab,
                last_fail = "summon_not_completed",
            }
            return "rejected"
        end
    end

    -- 已有一场防御战斗在跑：保持原任务，不重复启动
    if defense ~= nil and defense.phase == "engaged" then
        local job = Whale.job
        if job ~= nil and job.cmd_id == DEFENSE_ID then
            return "engaged"
        end
        defense = nil
    end

    local prof = resolve_profile(p)
    local pol = combat_policy_of(p, prof)
    local wendy = (prof ~= nil and prof.id == "wendy")
        or (pol ~= nil and pol.preferred_strategy == "abigail_assisted")
    local comp = companion_of(p)

    if wendy then
        -- 伴生太虚（血量低于安全线）时，不再假装"她在扛" —— 立刻回退保命
        if comp ~= nil and comp.can_assist == true
            and comp.health_percent ~= nil and comp.health_percent < COMPANION_MIN_HEALTH then
            blog("DEFENSE_ABORT", {
                target = prefab, reason = "companion_low_health",
                companion_hp = comp.health_percent,
            })
            return "rejected"
        end
        if comp ~= nil and comp.can_assist == true then
            blog("DEFENSE_CANDIDATE", {
                target = prefab, guid = attacker.GUID, companion = "ready",
                companion_hp = comp.health_percent,
            })
        elseif comp ~= nil and comp.can_summon == true and comp.has_flower == true then
            -- 有花但没召唤：先走既有 summon_companion job（绝不自己 push CASTSUMMON）
            local now = U.now()
            if defense ~= nil and defense.retry_at ~= nil and now < defense.retry_at then
                blog("DEFENSE_HANDOFF", {
                    target = prefab, phase = "cooldown",
                    retry_in = string.format("%.0f", defense.retry_at - now),
                })
                return "rejected"
            end
            local ok, err = A.Start("summon_companion", {}, DEFENSE_ID, {
                defense_reason = "wendy_companion_defense",
                target_guid = attacker.GUID,
                budget_s = SUMMON_TIMEOUT_S + 4,
            })
            if ok then
                defense = {
                    phase = "summoning",
                    target = attacker,
                    target_guid = attacker.GUID,
                    target_prefab = prefab,
                    started_at = now,
                    summon_started_at = now,
                    reason = "wendy_companion_defense",
                }
                blog("DEFENSE_HANDOFF", {
                    target = prefab, guid = attacker.GUID, phase = "summoning",
                    job = "summon_companion", cmd_id = DEFENSE_ID,
                })
                blog("DEFENSE_SUMMON_COMPANION", {
                    attacker = prefab, guid = attacker.GUID,
                    job = "summon_companion", via = "actions",
                })
                return "summoning"
            end
            -- 启动失败（例如 Reflex 回血/照明优先级更高）：记录并回退逃跑
            blog("DEFENSE_HANDOFF", {
                target = prefab, phase = "rejected", reason = tostring(err),
            })
            defense = {
                phase = "failed",
                last_fail = tostring(err),
                started_at = now,
                retry_at = now + SUMMON_RETRY_COOLDOWN_S,
                target_prefab = prefab,
            }
            return "rejected"
        else
            -- 无花 / 不可召唤：绝不假装能召唤，回退安全撤退
            blog("DEFENSE_ABORT", {
                target = prefab,
                reason = "companion_unavailable",
                has_flower = comp ~= nil and comp.has_flower == true,
            })
            return "rejected"
        end
    end

    -- 通用角色，或伴生已可协助：启动/接管为战术防御任务
    local ok = A.Start("fight_spider", {}, DEFENSE_ID, {
        target = attacker,
        is_defense = true,
        budget_s = 60,
    })
    if ok then
        defense = defense or {}
        defense.phase = "engaged"
        defense.target = attacker
        defense.target_guid = attacker.GUID
        defense.target_prefab = prefab
        defense.started_at = defense.started_at or U.now()
        if defense.summon_started_at == nil then defense.summon_started_at = defense.started_at end
        defense.reason = "tactical_defense"
        blog("DEFENSE_ENGAGE", {
            attacker = prefab,
            guid = attacker.GUID,
            companion = comp ~= nil and comp.can_assist == true,
            companion_hp = comp ~= nil and comp.health_percent or nil,
        })
        return "engaged"
    end
    return "rejected"
end

-- ─────────────── 目标查找（寻找最近可战斗的敌对目标：蜘蛛/野狗）───────────────
local function find_best_spider_target(p, radius_tiles)
    local r = radius_tiles or 16
    local list = U.find_all(p, r, nil, nil, function(e)
        if e == nil or e == p or not is_alive(e) then return false end
        local strat = STRATEGIES[e.prefab]
        if strat ~= nil and strat.supported == true then return true end
        return false
    end)
    if #list == 0 then return nil, "no_combat_target_nearby" end
    -- 优先选正在把玩家当目标的敌人，其次按距离升序
    table.sort(list, function(a, b)
        local c_a = a.ent.components ~= nil and a.ent.components.combat or nil
        local c_b = b.ent.components ~= nil and b.ent.components.combat or nil
        local tgt_a = (c_a ~= nil and c_a.target == p) and 1 or 0
        local tgt_b = (c_b ~= nil and c_b.target == p) and 1 or 0
        if tgt_a ~= tgt_b then return tgt_a > tgt_b end
        return a.d < b.d
    end)
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

        -- 检查掉落物是否着火（如火狗死亡引燃）
        local burning = false
        pcall(function()
            if row.ent.components ~= nil and row.ent.components.burnable ~= nil then
                burning = row.ent.components.burnable:IsBurning()
            end
        end)

        if not hostile_near and not burning then
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
        local is_defense = (j.cmd_id == "defense" or (j.ctx and j.ctx.is_defense) or false)

        -- R8.2：角色战斗策略。温蒂（requires_companion_for_hunt）必须阿比盖尔可协助才主动狩猎；
        -- 但如果是被动防御（is_defense），不可拒战等死。
        local _prof = (Whale ~= nil and Whale.character ~= nil and Whale.character.Resolve ~= nil) and Whale.character.Resolve(p) or nil
        local _pol = nil
        if _prof ~= nil and _prof.GetCombatPolicy ~= nil then
            local _okp2, _p2 = pcall(function() return _prof.GetCombatPolicy(p) end)
            if _okp2 and type(_p2) == "table" then _pol = _p2 end
        end
        if not is_defense and _prof ~= nil and _prof.GetCombatPolicy ~= nil then
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
            -- ★ R8.5：温蒂 avoid_melee 必须真正落地。avoid_melee 来自 Profile/CombatPolicy，
            --   但只有"阿比盖尔真的可协助"时才切到伴生主战（否则仍然是原来的风筝打法）。
            avoid_melee = (_pol ~= nil and _pol.avoid_melee == true),
            companion_led = false,
            companion = nil,
            companion_hits = 0,
            last_seen_hp = nil,
            last_damage_at = now,
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

    -- ★ R8.5：每 tick 重新读伴生状态（阿比盖尔可能刚被召唤 / 刚死 / 刚走远）。
    --   日志限频：只在"关键状态变化"或每 5 秒打一次，绝不每帧刷屏。
    local _comp_now = companion_of(p)
    if _comp_now ~= nil then
        session.companion = _comp_now
        local _assist = (_comp_now.alive == true and _comp_now.can_assist == true)
        session.companion_led = (_assist and session.avoid_melee == true)
        local _sig = table.concat({
            tostring(_comp_now.current_target), tostring(_comp_now.is_attacking),
            tostring(_comp_now.alive), tostring(_comp_now.can_assist),
        }, "|")
        local _last = session._comp_sig
        local _at = session._comp_log_at or 0
        if _sig ~= _last or (now - _at) >= 5 then
            session._comp_sig = _sig
            session._comp_log_at = now
            blog("COMPANION_TARGET", {
                target = session.target_prefab,
                guid = session.target_guid,
                companion_hp = _comp_now.health_percent,
                companion_target = _comp_now.current_target or "none",
                companion_attacking = _comp_now.is_attacking == true,
                companion_distance = _comp_now.distance,
                companion_led = session.companion_led == true,
            })
        end
    else
        session.companion = nil
        session.companion_led = false
    end

    -- ── 全局监控守卫 ──
    -- 1. 残血守卫
    if session.player_current_hp ~= nil and session.player_current_hp < 0.25 then
        transition(STATES.EMERGENCY, "critical_health")
        blog("EMERGENCY", { reason = "critical_health", hp = string.format("%.2f", session.player_current_hp) })
        B.Cleanup()
        return "fail", "low_health: 自身血量过低（<25%），中止战斗并脱离"
    end

    -- 2. 多怪围攻守卫（R8.5：伴生健康时可受控群战，上限 3 只；否则立刻紧急中止）
    local threat_count = count_attackers_targeting(p, 8)
    if threat_count > 1 then
        local allow, why = can_tolerate_group(p, threat_count)
        if not allow then
            transition(STATES.EMERGENCY, "outnumbered")
            blog("EMERGENCY", { reason = "outnumbered:" .. tostring(why), count = threat_count })
            B.Cleanup()
            return "fail", "outnumbered: 遭到多只敌人围攻（" .. tostring(why) .. "），紧急中止战斗"
        end
        if (session._group_log_at or 0) == 0 or (now - (session._group_log_at or 0)) >= 5 then
            session._group_log_at = now
            blog("COMPANION_GROUP_ENGAGE", {
                count = threat_count, reason = tostring(why),
                target = session.target_prefab or "none",
            })
        end
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

    -- 4. 硬上限 / 伴生停手守卫（R8.5 真机发现：会话不能永久悬挂）
    --    · 单场战斗超过 MAX_SESSION_S：无论谁忘了收尾，都必须自己结束；
    --    · 伴生主战时连续 STALL_ABORT_S 没有造成任何伤害：说明阿比盖尔跑出了原版防御范围
    --      （真机：她跟随距离能到 6.5 世界单位 > ABIGAIL_DEFENSIVE_MAX_FOLLOW=5，于是停手），
    --      继续挂着只会让 Reflex 一直被抑制，必须回退让 Reflex 重新评估。
    if session.started_at ~= nil and (now - session.started_at) > MAX_SESSION_S then
        transition(STATES.EMERGENCY, "battle_timeout")
        blog("DEFENSE_ABORT", {
            reason = "battle_timeout",
            target = session.target_prefab or "none",
            elapsed = string.format("%.0f", now - session.started_at),
        })
        B.Cleanup()
        return "fail", "battle_timeout: 单场战斗超过 " .. tostring(MAX_SESSION_S) .. " 秒，先脱离再重新评估"
    end
    if session.companion_led then
        local last_activity = math.max(session.last_damage_at or 0, session.state_entered_at or 0)
        if (now - last_activity) > STALL_ABORT_S then
            transition(STATES.EMERGENCY, "companion_stalled")
            blog("DEFENSE_ABORT", {
                reason = "companion_stalled",
                target = session.target_prefab or "none",
                idle_s = string.format("%.0f", now - last_activity),
                companion_distance = session.companion ~= nil and session.companion.distance or nil,
            })
            -- 冷却：别让它下一秒又开一场（否则就是 8 秒一循环，Wendy 一直站着挨打）
            defense_retry_at = now + STALL_RETRY_S
            B.Cleanup()
            return "fail", "companion_stalled: 阿比盖尔已有一段时间没有输出（可能跑出了防御范围），先脱离让 Reflex 重新评估"
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

        -- ★ R8.5：伴生主战（温蒂 avoid_melee 的真正落地）。
        --   阿比盖尔可协助时：温蒂**绝不**调用自己的 ACTIONS.ATTACK；
        --   她只负责保持在"阿比盖尔防御范围"内，由阿比盖尔输出。
        if session.companion_led then
            local comp = session.companion
            if comp == nil or comp.alive ~= true or comp.can_assist ~= true then
                blog("DEFENSE_ABORT", { reason = "companion_unavailable", target = session.target_prefab })
                transition(STATES.EMERGENCY, "companion_unavailable")
                B.Cleanup()
                return "fail", "companion_unavailable: 阿比盖尔已无法协助，先脱离"
            end
            local chp = comp.health_percent
            if chp ~= nil and chp < 0.25 then
                blog("DEFENSE_ABORT", { reason = "companion_low_health", companion_hp = chp })
                transition(STATES.EMERGENCY, "companion_low_health")
                B.Cleanup()
                return "fail", "companion_low_health: 阿比盖尔血量过低，先脱离"
            end
            local php = get_health_percent(p)
            if php ~= nil and php < 0.35 then
                blog("DEFENSE_ABORT", { reason = "critical_health", hp = php })
                transition(STATES.EMERGENCY, "critical_health")
                B.Cleanup()
                return "fail", "low_health: 自身血量过低（<35%），中止伴生战斗并脱离"
            end

            -- 位置维持：阿比盖尔的 DefensiveRetarget（prefabs/abigail.lua）要求
            --   (a) 阿比盖尔距温蒂 < ABIGAIL_DEFENSIVE_MAX_FOLLOW
            --   (b) 目标距温蒂 < ABIGAIL_COMBAT_TARGET_DISTANCE(15 世界单位≈3.75 格)
            -- 所以温蒂要保持在约 2.2~3.2 格：太远阿比盖尔不会接战，太近会被青蛙咬掉背包物品。
            local d = U.dist(p, target)
            if d ~= nil then
                local tiles = d / U.TILE
                if tiles > 3.2 then
                    local ox, _, oz = U.pos(target)
                    if ox ~= nil then
                        local tx, tz = U.tile_of(ox, oz)
                        walk_throttled(p, tx, tz)
                    end
                elseif tiles < 2.2 then
                    local angle = nil
                    if native ~= nil and native.FleeAngle ~= nil then
                        angle = native.FleeAngle(p, target, 4)
                    end
                    local rx, rz = nil, nil
                    if native ~= nil and native.PointFromAngle ~= nil and angle ~= nil then
                        rx, rz = native.PointFromAngle(p, angle, 4 * U.TILE)
                    elseif angle ~= nil then
                        local px, _, pz = U.pos(p)
                        local rad = angle * (GLOBAL.DEGREES or (math.pi / 180))
                        rx = px + 4 * U.TILE * math.cos(rad)
                        rz = pz - 4 * U.TILE * math.sin(rad)
                    end
                    if rx ~= nil and rz ~= nil then
                        local rtx, rtz = U.tile_of(rx, rz)
                        walk_throttled(p, rtx, rtz)
                    end
                else
                    pcall(A.stop_actions, p)
                end
            end

            -- 证据：目标血量下降 = 阿比盖尔确实在输出。
            -- 不能只因"她在场"就宣称战斗有效 —— 必须有真实伤害证据。
            if session.last_seen_hp ~= nil and session.target_current_hp ~= nil
                and session.target_current_hp < session.last_seen_hp then
                session.companion_hits = (session.companion_hits or 0) + 1
                session.last_damage_at = now
                blog("COMPANION_TARGET", {
                    target = session.target_prefab,
                    guid = session.target_guid,
                    hp = session.target_current_hp,
                    hits = session.companion_hits,
                    companion_target = comp.current_target or "none",
                })
            end
            session.last_seen_hp = session.target_current_hp
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
            -- 火狗死亡自燃爆炸防范：向后撤离并等待火焰消散
            if session.strategy ~= nil and session.strategy.on_death_effect == "fire_explosion" then
                if session.fire_wait_start == nil then
                    session.fire_wait_start = now
                    local px, py, pz = U.pos(p)
                    local tx, ty, tz = U.pos(target)
                    if px ~= nil and tx ~= nil then
                        local dx, dz = px - tx, pz - tz
                        local len = math.sqrt(dx * dx + dz * dz)
                        if len < 0.01 then dx, dz, len = 1, 0, 1 end
                        local dest_x = px + (dx / len) * 4 * U.TILE
                        local dest_z = pz + (dz / len) * 4 * U.TILE
                        local dtx, dtz = U.tile_of(dest_x, dest_z)
                        walk_throttled(p, dtx, dtz)
                    end
                    return "run"
                end
                if now - session.fire_wait_start < 2.0 then
                    return "run"
                end
            end

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
        local msg
        if session.companion_led or (session.avoid_melee and (session.companion_hits or 0) > 0) then
            msg = string.format("阿比盖尔打倒了 %s（确认出手 %d 次，温蒂未近战）",
                session.target_label or "目标", session.companion_hits or 0)
        else
            msg = string.format("打倒了 %s（挥砍 %d 次，后撤 %d 次）",
                session.target_label or "目标", session.total_swings or 0, session.retreat_count or 0)
        end
        blog("FINISH", {
            target = session.target_prefab,
            total_swings = session.total_swings,
            retreats = session.retreat_count,
            companion_led = session.companion_led == true,
            companion_hits = session.companion_hits or 0,
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
