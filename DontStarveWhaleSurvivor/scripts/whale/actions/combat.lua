-- 战斗动作：attack, kill
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall or pcall
local tonumber = GLOBAL.tonumber or tonumber
local tostring = tostring or (GLOBAL and GLOBAL.tostring)

local ACTIONS = GLOBAL.ACTIONS
local BufferedAction = GLOBAL.BufferedAction

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

return A
