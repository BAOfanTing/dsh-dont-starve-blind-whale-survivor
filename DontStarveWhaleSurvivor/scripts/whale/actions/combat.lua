-- 战斗动作：attack, kill
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall or pcall
local tonumber = GLOBAL.tonumber or tonumber
local tostring = tostring or (GLOBAL and GLOBAL.tostring)

local ACTIONS = GLOBAL.ACTIONS
local BufferedAction = GLOBAL.BufferedAction
local EQUIPSLOTS = GLOBAL.EQUIPSLOTS

local U = Whale.util

Whale = Whale or {}
Whale.actions = Whale.actions or {}
local A = Whale.actions
A.JOBS = A.JOBS or {}
local JOBS = A.JOBS

local busy = A.busy
local push = A.push
local best_weapon = A.best_weapon
local best_food = A.best_food
local equip_if_needed = A.equip_if_needed
local find_by_name = A.find_by_name
local nearest_hostile = A.nearest_hostile

-- ── 自动换武器时要避开"把光换没了" ──
-- ★ 我自己踩到的坑（2026-11-17，真机）：给 attack_by_ref 补上自动换武器后，
--   夜里手里举着火把去杀蜘蛛 —— 一换长矛就陷入黑暗，保命反射立刻以 dark_no_light 中断任务，
--   回执变成"失败：dark_no_light"。所以：**天黑且手上是能用的光源时，不换武器**（宁可空手打）。
local LIGHT_HAND_PREFABS = { torch = true, lantern = true }

--- 手上是不是"还能用的手持光源"（火把/提灯，且没烧完）。是就返回它，否则 nil。
local function hand_useful_light(p)
    local inv = p ~= nil and p.components ~= nil and p.components.inventory or nil
    if inv == nil then return nil end
    local hand = nil
    pcall(function() hand = inv:GetEquippedItem(EQUIPSLOTS.HANDS) end)
    if hand == nil then return nil end
    local is_light = LIGHT_HAND_PREFABS[tostring(hand.prefab or "")] == true
    if not is_light then
        pcall(function()
            if hand.components ~= nil and hand.components.lightsource ~= nil then is_light = true end
        end)
    end
    if not is_light then return nil end
    local usable = true
    pcall(function()
        local fueled = hand.components ~= nil and hand.components.fueled or nil
        if fueled ~= nil and fueled:IsEmpty() == true then usable = false end
    end)
    if not usable then return nil end
    return hand
end

--- 现在是不是待在黑暗里（引擎判据优先）。
local function in_darkness(p)
    local native = Whale ~= nil and Whale.native or nil
    if native ~= nil and native.IsLit ~= nil then
        local ok, lit = pcall(native.IsLit, p)
        if ok and lit ~= nil then return lit ~= true end
    end
    local lit = false
    pcall(function() lit = p:IsInLight() end)
    return lit ~= true
end

--- 攻击（attack = 打几下；kill = 打到死或超时）
---
--- ★ NATIVE-REUSE：玩家挥砍**不能**用 combat:TryAttack()。
---   `Combat:TryAttack`（components/combat.lua:829）只 PushEvent("doattack")，
---   这个事件在专用服务器上只会触发 SGwilson 的攻击动画，**但不会发 RPC**。
---   客户端看起来是"挥了空刀，怪没掉血、甚至没进入仇恨"。
---   原版客户端攻击（playercontroller.lua:DoAttackButton）走的是 BufferedAction(p, target, ACTIONS.ATTACK, weapon)。
---   这里统一走 native.AttackAction，把武器选取、攻击距离、BufferedAction 组装全交给原版。
---
--- ★ 挥砍次数按**引擎记录的真实出手**算（combat.lastdoattacktime，combat.lua:1231），
---   不是数我们推了几次 BufferedAction —— 推了没挥出去也算一次的话，回执会撒谎。
local function attack_by_ref(j, p, target, mode)
    if target == nil or not target:IsValid() then
        if j.data ~= nil and (j.data.swings or 0) > 0 then
            return "done", string.format("打倒了 %s", j.data.label or "目标")
        end
        return "fail", "entity_gone: 目标已经不存在了"
    end
    local health = target.components ~= nil and target.components.health or nil
    if health == nil then return "fail", "target_not_attackable: 这个东西打不了" end

    local native = Whale ~= nil and Whale.native or nil

    if j.step == "start" then
        j.data.target = target
        j.data.label = U.pretty(target)
        j.data.mode = mode
        j.data.swings = 0
        j.data.want = mode == "kill" and 999 or (tonumber(j.ctx and j.ctx.times) or 1)
        j.data.phase_start = U.now()
        -- ★ 真机 bug（session 8fab0944）：老的 legacy_attack 会 equip_if_needed(p, best_weapon(p))，
        --   新的 attack_by_ref 漏了这一步。白天反射把火把收回背包后人是空手，
        --   于是 attack/kill 直接空手挥拳（温蒂空手 7.5 伤害），打蜘蛛等于送死。
        --   进战斗前先换出背包里伤害最高的武器（没有武器就空手，不报错）。
        --   ★ 但天黑、手上举着能用的光源时**不换** —— 换了就黑，会被查理咬死/被反射打断。
        if equip_if_needed ~= nil and best_weapon ~= nil then
            local w = best_weapon(p)
            if w ~= nil and not (in_darkness(p) and hand_useful_light(p) ~= nil) then
                pcall(equip_if_needed, p, w)
            end
        end
        -- 进战斗前记下"上一次真的出手"的时刻，之后用它判断这一刀有没有挥出去
        j.data.last_swing = native ~= nil and native.LastAttackTime(p) or nil
        j.step = "acting"
    end

    if j.step == "acting" then
        -- 先看引擎有没有真的出手（即使目标已死也要先结算这一刀）
        if native ~= nil then
            local last = native.LastAttackTime(p)
            if last ~= nil and (j.data.last_swing == nil or last > j.data.last_swing) then
                j.data.last_swing = last
                j.data.swings = (j.data.swings or 0) + 1
            end
        end

        local dead = false
        pcall(function() dead = health:IsDead() end)
        if dead or not target:IsValid() then
            return "done", string.format("打倒了 %s（%d 下）", j.data.label or "目标", j.data.swings or 0)
        end
        if (j.data.swings or 0) >= j.data.want then
            return "done", string.format("打了 %s %d 下（还没倒）", j.data.label or "目标", j.data.swings)
        end
        -- 自己的血太低就别硬打（保命优先，和 reflex 一个原则）
        local hp = p.components ~= nil and p.components.health or nil
        local pct = 1
        if hp ~= nil then pcall(function() pct = hp:GetPercent() end) end
        if pct ~= nil and pct < 0.25 then
            return "fail", "low_health: 自己血不多了，先退（继续打会死）"
        end
        if U.now() - j.data.phase_start > 180 then
            return "fail", "attack_failed: 打了很久没结果"
        end
        -- 引擎自己的攻击冷却（玩家 min_attack_period = TUNING.WILSON_ATTACK_PERIOD = 0.4s）
        -- 没冷却完就别推 —— 推了也会被 SGwilson 的 attack 状态直接丢掉（SGwilson.lua:10791）。
        if native ~= nil and not native.CanSwing(p) then
            return "run"
        end
        if busy(p) then return "run" end

        -- ★ 真机 bug（session 8fab0944）：指令到达时目标可能已经跑远（蜘蛛会游荡/逃跑）。
        --   ACTIONS.ATTACK 的 BufferedAction 确实会寻路，但如果目标在 20 格开外，
        --   SGwilson 会先跑很久，`attack` 的 180 秒预算和模型的耐心都不够。
        --   这里先自己走过去，进入 2 格再挥砍；走近用 walk_to（和 move_to 同一条移动链路）。
        local gap = U.dist(p, target)
        if gap ~= nil and gap > 2 * U.TILE and A.walk_to ~= nil then
            local tx, tz = nil, nil
            local ox, _, oz = U.pos(target)
            if ox ~= nil then tx, tz = U.tile_of(ox, oz) end
            if tx ~= nil and tz ~= nil then
                local jt = j.data.chase_at or 0
                -- 每 0.5 秒补一次"要去哪"，和 move_to 的做法一致（客户端先停也能跟上）
                if U.now() - jt >= 0.5 then
                    j.data.chase_at = U.now()
                    pcall(A.walk_to, p, tx, tz, true)
                end
                return "run"
            end
        end

        local ba, why
        if native ~= nil then
            ba, why = native.AttackAction(p, target)
        else
            ba = BufferedAction(p, target, ACTIONS.ATTACK, nil)
        end
        if ba == nil then
            return "fail", "attack_failed: " .. tostring(why or "no_action")
        end
        push(p, ba)
        return "run"
    end
    return "run"
end

local function legacy_attack(j, p)
    if j.step == "start" then
        local target = nil
        if j.args.target ~= nil and j.args.target ~= "" then
            local list = find_by_name(p, tonumber(j.args.radius) or 20, j.args.target)
            target = list[1] ~= nil and list[1].ent or nil
            if target == nil then return "fail", "附近没找到 " .. tostring(j.args.target) end
        else
            target = nearest_hostile(p, tonumber(j.args.slice) or 12)
            if target == nil then return "fail", "附近没有敌人" end
        end
        j.data.target = target
        j.data.name = U.pretty(target)
        j.data.hits = 0
        j.data.max_hits = tonumber(j.args.count) or 30
        j.data.next_hit = 0
        j.step = "fight"
    end
    local target = j.data.target
    if target == nil or not target:IsValid() then
        return "done", string.format("%s 已经解决了（打了 %d 下）", j.data.name, j.data.hits)
    end
    local health = target.components.health
    if health ~= nil and health:IsDead() then
        return "done", string.format("%s 打死了（%d 下）", j.data.name, j.data.hits)
    end
    local my_health = p.components.health
    if my_health ~= nil and my_health:GetPercent() ~= nil and my_health:GetPercent() < 0.3 then
        local food = best_food(p)
        if food ~= nil then
            push(p, BufferedAction(p, nil, ACTIONS.EAT, food))
            j.data.next_hit = U.now() + 2
            return "run"
        end
        return "fail", "血太少了，打不过就先跑"
    end
    if j.data.hits >= j.data.max_hits then
        return "done", string.format("已经打了 %d 下，%s 还没死", j.data.hits, j.data.name)
    end
    if busy(p) then
        if U.now() - j.t0 > 180 then return "fail", "打不动了" end
        return "run"
    end
    if U.now() < (j.data.next_hit or 0) then return "run" end
    equip_if_needed(p, best_weapon(p))
    push(p, BufferedAction(p, target, ACTIONS.ATTACK, nil))
    j.data.hits = j.data.hits + 1
    j.data.next_hit = U.now() + 0.5
    return "run"
end

JOBS.attack = function(j, p)
    local ctx = j.ctx or {}
    if ctx.target ~= nil then
        return attack_by_ref(j, p, ctx.target, "attack")
    end
    return legacy_attack(j, p)
end

JOBS.kill = function(j, p)
    local ctx = j.ctx or {}
    if ctx.target ~= nil then
        return attack_by_ref(j, p, ctx.target, "kill")
    end
    return legacy_attack(j, p)
end

JOBS.fight_spider = function(j, p)
    local B = Whale ~= nil and Whale.battle or nil
    if B ~= nil and B.StepJob ~= nil then
        return B.StepJob(j, p)
    end
    return "fail", "battle_subsystem_unavailable"
end

return A
