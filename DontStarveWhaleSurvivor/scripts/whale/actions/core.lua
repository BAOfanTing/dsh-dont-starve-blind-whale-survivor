-- 动作核心底座：公共状态机、走路与客户端同步、工具/食物/燃料选择、背包差值与生命周期
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local error = GLOBAL.error
local os = GLOBAL.os or { time = function() return 0 end }
local io = GLOBAL.io

local U = Whale.util

Whale = Whale or {}
Whale.actions = Whale.actions or {}
local A = Whale.actions
A.JOBS = A.JOBS or {}
local JOBS = A.JOBS
local job = nil

local ACTIONS = GLOBAL.ACTIONS
local EQUIPSLOTS = GLOBAL.EQUIPSLOTS
local Vector3 = GLOBAL.Vector3
local BufferedAction = GLOBAL.BufferedAction

local WORK_NAMES = {
    CHOP = "砍",
    MINE = "挖矿",
    DIG = "铲",
    HAMMER = "拆",
}
A.WORK_NAMES = WORK_NAMES

--- R8.5：防御通道的 cmd_id。
--- 为什么需要独立 id：防御由 Reflex 发起、但**不是** P0 逃命；它必须能和 Reflex flee
--- 做"受控交接"，又不能占用模型指令的结果槽（见 bridge.Report）。用 "defense" 单独标识，
--- 抢占矩阵里单独放行，结果写本地文件而不是 whale_result.json。
A.DEFENSE_ID = "defense"

--- R8.5：Reflex 动作的"意图键"（flee/heal/light/eat/fuel/...）。
--- try_action 会在启动后写 job.reflex_key；这里做一层兜底推断，避免旧 job 没有该字段时
--- 把 heal/light 误判成 flee（那会放开不该放开的接管）。
local function reflex_intent(j)
    if j == nil then return nil end
    if j.reflex_key ~= nil then return j.reflex_key end
    if j.name == "move_to" and j.ctx ~= nil and j.ctx.flee == true then return "flee" end
    if j.name == "move_to" then return "flee" end   -- reflex 的 move_to 只有逃跑/取暖两种；取暖走 temperature 键
    if j.name == "heal" then return "heal" end
    if j.name == "eat" then return "eat" end
    if j.name == "equip" or j.name == "unequip" then return "light" end
    if j.name == "craft" then return "craft_light" end
    if j.name == "build" then return "light" end
    if j.name == "make_fire" or j.name == "add_fuel" then return "light" end
    return nil
end
A.reflex_intent = reflex_intent

local function health_percent_of(p)
    if p == nil or p.components == nil or p.components.health == nil then return nil end
    local ok, pct = pcall(function() return p.components.health:GetPercent() end)
    if ok and type(pct) == "number" then return pct end
    local h = p.components.health
    local cur = h.currenthealth or h.current
    local max = h.maxhealth or h.max
    if type(cur) == "number" and type(max) == "number" and max > 0 then return cur / max end
    return nil
end

--- R8.5 抢占矩阵（唯一判定处，禁止各处散落"改 cmd_id 绕过"）。
---
--- 期望行为：
---   Reflex flee  → Wendy defense handoff : 允许受控交接（仅逃跑时；黑暗中/濒死时不交）
---   Reflex heal  → Wendy defense         : 生命仍在紧急线以下 → 保留回血；否则重新评估后允许
---   Reflex light → Wendy defense         : 黑暗无光 P0 优先，绝不交
---   普通采集     → Wendy defense         : 允许防御抢占
---   正在 summon_companion → 再次 summon  : 拒绝重复
---   正在 defense  → 同一目标 defense     : 保持原任务（拒绝重复启动）
---   其余非 defense 指令 → Reflex 动作     : 一律不可打断（保留历史 P0 保护）
---
--- @return ok(boolean), reason(string|nil), detail(table|nil)
local function may_preempt(cur, new_id, args, new_name)
    if cur == nil then return true, nil end

    if new_id == A.DEFENSE_ID then
        -- 同一场防御不重复启动（交由 battle 自己的会话保持逻辑处理）
        if cur.cmd_id == A.DEFENSE_ID then return false, "defense_in_progress" end
        -- 召唤进行中：绝不打断（否则永远召不出来）
        if cur.name == "summon_companion" then return false, "summon_in_progress" end

        if cur.cmd_id == "reflex" then
            local intent = reflex_intent(cur)
            -- 黑暗/照明保命优先：不许交给防御
            if intent == "light" or intent == "craft_light" then
                return false, "light_priority"
            end
            -- 回血优先：生命仍在紧急线以下时先回血
            if intent == "heal" or intent == "eat" then
                local hp = health_percent_of(U.player())
                if hp == nil or hp < 0.35 then return false, "heal_priority" end
                return true, "reflex_reassessed"
            end
            -- 逃跑：允许受控交接（真正的安全前提由 battle.StartDefense 再校验一次）
            if intent == "flee" then return true, "flee_handoff" end
            return false, "reflex_priority"
        end
        -- 普通任务（模型/计划/技能）：允许防御抢占
        return true, "preempt_ordinary"
    end

    -- 非防御指令：Reflex 与正在进行的伴生防御不被普通动作打断（stop 显式中止除外）
    if cur.cmd_id == "reflex" then
        return false, "reflex_active: 正在保命抢占中，请勿打断 Reflex"
    end
    if cur.cmd_id == A.DEFENSE_ID and new_name ~= "stop" then
        return false, "defense_active: 正在进行伴生防御，请稍候或先 stop"
    end
    return true, nil
end
A.may_preempt = may_preempt

local MODNAME = type(modname) == "string" and modname or "DontStarveWhaleSurvivor"
A.MODNAME = MODNAME

local client_walk
local client_stop
local hold_control

local function busy(p)
    if p == nil then return false end
    if p:GetBufferedAction() ~= nil then return true end
    if p.sg ~= nil and not p.sg:HasStateTag("idle") then return true end
    return false
end
A.busy = busy

local function stop_actions(p)
    if p == nil then return end
    local loco = p.components ~= nil and p.components.locomotor or nil
    if loco ~= nil then
        pcall(function()
            loco:Stop()
            loco:Clear()
        end)
    end
    if p.ClearBufferedAction ~= nil then
        pcall(function() p:ClearBufferedAction() end)
    end
    if hold_control ~= nil then
        pcall(hold_control, p, false)
    end
    if client_stop ~= nil then
        pcall(client_stop, p)
    end
end
A.stop_actions = stop_actions

local function push(p, ba)
    if p == nil or ba == nil then return false end
    local loco = p.components.locomotor
    if loco ~= nil then
        loco:PushAction(ba, true)
    else
        p:PushBufferedAction(ba)
    end
    return true
end
A.push = push

local function tile_away(p, tx, tz)
    local px, _, pz = U.pos(p)
    if px == nil then return math.huge end
    local x, z = U.tile_center(tx, tz)
    local dx, dz = px - x, pz - z
    return math.sqrt(dx * dx + dz * dz) / U.TILE
end
A.tile_away = tile_away

local function env_fn(name)
    if env ~= nil and env[name] ~= nil then return env[name] end
    local fn = GLOBAL[name]
    if fn ~= nil then return fn end
    return nil
end
A.env_fn = env_fn

client_walk = function(p, x, z, run)
    if p == nil or p.userid == nil then return false end
    local ok = pcall(function()
        local getrpc = env_fn("GetClientModRPC")
        local send = env_fn("SendModRPCToClient")
        if getrpc == nil or send == nil then return end
        send(getrpc(MODNAME, "walkto"), p.userid, x, z, run and 1 or 0)
    end)
    return ok
end
A.client_walk = client_walk

client_stop = function(p)
    if p == nil or p.userid == nil then return false end
    local ok = pcall(function()
        local getrpc = env_fn("GetClientModRPC")
        local send = env_fn("SendModRPCToClient")
        if getrpc == nil or send == nil then return end
        send(getrpc(MODNAME, "walkstop"), p.userid)
    end)
    return ok
end
A.client_stop = client_stop

local function walk_to(p, tx, tz, run)
    local x, z = U.tile_center(tx, tz)
    local loco = p.components.locomotor
    if loco == nil then return false end
    if run == nil then run = true end
    loco:GoToPoint(Vector3(x, 0, z), nil, run)
    client_walk(p, x, z, run)
    return true
end
A.walk_to = walk_to
A.safe_atan2 = U.safe_atan2
A.is_passable = U.is_passable
A.line_passable = U.line_passable
A.find_coastline_detour = U.find_coastline_detour

local function equip_if_needed(p, item)
    local inv = p.components.inventory
    if inv == nil or item == nil then return end
    if inv:GetEquippedItem(EQUIPSLOTS.HANDS) == item then return end
    pcall(function() inv:Equip(item) end)
end
A.equip_if_needed = equip_if_needed

local function best_tool(p, action)
    local inv = p.components.inventory
    if inv == nil then return nil end
    local best, best_score = nil, -1
    inv:ForEachItem(function(item)
        local tool = item.components.tool
        if tool ~= nil then
            local ok, can = pcall(function() return tool:CanDoAction(action) end)
            if ok and can then
                local uses = item.components.finiteuses
                local score = uses ~= nil and uses:GetUses() or 1000
                if score > best_score then
                    best, best_score = item, score
                end
            end
        end
    end)
    return best
end
A.best_tool = best_tool

local function best_weapon(p)
    local inv = p.components.inventory
    if inv == nil then return nil end
    local best, best_damage = nil, -1
    inv:ForEachItem(function(item)
        local weapon = item.components.weapon
        if weapon ~= nil and weapon.damage ~= nil and weapon.damage > best_damage then
            best, best_damage = item, weapon.damage
        end
    end)
    return best
end
A.best_weapon = best_weapon

--- 模拟"按住动作键"（官方连砍机制：引擎在状态机里自己重推同一个动作）。
---
--- ★ 真机 bug（2026-11-17，用户："砍树/砸矿都是走到附近，然后停几秒再开始"）：
---   这里原来写的是**布尔** `true`，但 `playercontroller.remote_controls` 的值是
---   **倒计时数字**，引擎自己只用 `0`（按住）和 `nil`（松开）：
---       playercontroller.lua:872  if self.remote_controls[CTRL] == nil then ... = 0 end
---       playercontroller.lua:897  self.remote_controls[CTRL] = not isreleased and 0 or nil
---   而 `PlayerController:CooldownRemoteController(dt)` 会对每个值做算术：
---       playercontroller.lua:537  self.remote_controls[k] = math.max(v - dt, 0)
---   它在 playercontroller.lua:3097 被调用时**只要角色空闲或移动中就会传真实 dt** ——
---   `true - dt` 直接抛 "attempt to perform arithmetic on a boolean value"，
---   把这个每帧的控制器收尾循环打断，角色就杵在原地（表现就是"停几秒再开始"）。
---   所以这里必须写数字 `0`，不能写 `true`。
hold_control = function(p, want)
    local pc = p ~= nil and p.components ~= nil and p.components.playercontroller or nil
    if pc == nil then return false end
    local control = GLOBAL.CONTROL_ACTION
    if control == nil then return false end
    local ok = pcall(function()
        pc.remote_controls = pc.remote_controls or {}
        if want then
            pc.remote_controls[control] = 0      -- 数字！引擎要对它做 math.max(v - dt, 0)
        else
            pc.remote_controls[control] = nil    -- 松开：和 OnRemoteStopControl 一致
        end
    end)
    return ok
end
A.hold_control = hold_control

local NOT_FOOD = {
    twigs = true, cutgrass = true, grass = true, log = true, rocks = true,
    flint = true, nitre = true, goldnugget = true, charcoal = true,
    silk = true, pigskin = true, honeycomb = true, beefalowool = true,
}
local MIN_FOOD_HUNGER = 3

local function best_food(p)
    local inv = p.components.inventory
    if inv == nil then return nil end
    local best, best_score = nil, 0
    inv:ForEachItem(function(item)
        local edible = item.components.edible
        if edible ~= nil then
            local prefab = item.prefab
            if NOT_FOOD[prefab] then
                -- skip materials
            else
                local hunger = tonumber(edible.hungervalue) or 0
                local health = tonumber(edible.healthvalue) or 0
                if hunger >= MIN_FOOD_HUNGER then
                    local perish = item.components.perishable
                    local freshness = perish ~= nil and perish:GetPercent() or 1
                    local score = (hunger + health * 0.5) * (0.3 + 0.7 * freshness)
                    if score > best_score then
                        best, best_score = item, score
                    end
                end
            end
        end
    end)
    return best
end
A.best_food = best_food

local function best_fuel(p, want)
    local inv = p.components.inventory
    if inv == nil then return nil end
    if want ~= nil and want ~= "" then return U.find_item(p, want) end
    local best, best_score = nil, -1
    inv:ForEachItem(function(item)
        local fuel = item.components.fuel
        if fuel ~= nil then
            local score = tonumber(fuel.fuelvalue) or 1
            if item.components.edible ~= nil then score = score * 0.2 end
            if score > best_score then
                best, best_score = item, score
            end
        end
    end)
    return best
end
A.best_fuel = best_fuel

local function find_by_name(p, radius, want)
    local needle = string.lower(tostring(want))
    local tag = nil
    if string.sub(needle, 1, 4) == "tag:" then
        tag = string.sub(needle, 5)
        needle = nil
    end
    local filter
    if tag ~= nil then
        filter = function(e) return e:HasTag(tag) end
    elseif needle ~= nil then
        filter = function(e)
            local prefab = string.lower(e.prefab or "")
            if prefab == needle or string.find(prefab, needle, 1, true) ~= nil then return true end
            local name = string.lower(U.pretty(e))
            return string.find(name, needle, 1, true) ~= nil
        end
    end
    return U.find_all(p, radius, nil, nil, filter)
end
A.find_by_name = find_by_name

local function find_workable(p, radius, action_id, want, skip)
    if want ~= nil and want ~= "" then
        local list = find_by_name(p, radius, want)
        for _, entry in ipairs(list) do
            local w = entry.ent.components ~= nil and entry.ent.components.workable or nil
            if w ~= nil and w.action ~= nil and w.action.id == action_id then
                return entry.ent
            end
        end
    end
    local best, best_score = nil, math.huge
    local list = U.find_all(p, radius, nil, nil, function(e)
        local w = e.components ~= nil and e.components.workable or nil
        return w ~= nil and w.action ~= nil and w.action.id == action_id
    end)
    for _, entry in ipairs(list) do
        local skipped = false
        if skip ~= nil and skip[entry.ent] == true then skipped = true end
        if not skipped then
            local w = entry.ent.components.workable
            local left = 0
            local ok_l, l = pcall(function() return w.workleft end)
            if ok_l and tonumber(l) ~= nil then left = tonumber(l) end
            if left > 0 then
                local score = entry.d + left / 10
                if score < best_score then
                    best, best_score = entry.ent, score
                end
            end
        end
    end
    if best ~= nil then return best end
    local ent = U.find_nearest(p, radius, nil, nil, function(e)
        local w = e.components ~= nil and e.components.workable or nil
        return w ~= nil and w.action ~= nil and w.action.id == action_id
    end)
    return ent
end
A.find_workable = find_workable

local function nearest_hostile(p, radius)
    local ent = U.find_nearest(p, radius, { "hostile" }, nil, function(e)
        local h = e.components ~= nil and e.components.health or nil
        return h ~= nil and not h:IsDead()
    end)
    return ent
end
A.nearest_hostile = nearest_hostile

local function being_attacked(p, radius)
    local foe = nearest_hostile(p, radius or 3)
    if foe == nil then return false end
    local c = foe.components ~= nil and foe.components.combat or nil
    local ok, target = pcall(function() return c ~= nil and c.target or nil end)
    return ok and target == p
end
A.being_attacked = being_attacked

local function find_container(p, radius, want)
    if want ~= nil and want ~= "" then
        local list = find_by_name(p, radius, want)
        for _, entry in ipairs(list) do
            if entry.ent.components ~= nil and entry.ent.components.container ~= nil then
                return entry.ent
            end
        end
        return nil
    end
    local ent = U.find_nearest(p, radius, nil, nil, function(e)
        return e.components ~= nil and e.components.container ~= nil
    end)
    return ent
end
A.find_container = find_container

local RECIPE_ALIASES = {
    chest = "treasurechest",
    treasurechest = "treasurechest",
    sciencemachine = "researchlab",
    researchlab = "researchlab",
    -- TENT（2026-11-17）：炼金引擎（原生名 researchlab2）+ 帐篷
    alchemyengine = "researchlab2",
    researchlab2 = "researchlab2",
    tent = "tent",
}
A.RECIPE_ALIASES = RECIPE_ALIASES

local function recipe_of(name)
    if name == nil then return nil, nil end
    local key = tostring(name)
    local lower = string.lower(key)
    if RECIPE_ALIASES[lower] ~= nil then
        lower = RECIPE_ALIASES[lower]
        key = lower
    end
    local recipes = GLOBAL.AllRecipes or {}
    local recipe = recipes[key]
    if recipe ~= nil then return recipe, key end
    for k, r in pairs(recipes) do
        if string.lower(k) == lower then return r, k end
    end
    return nil, nil
end
A.recipe_of = recipe_of

local function missing_ingredients(p, recipe)
    local builder = p.components ~= nil and p.components.builder or nil
    if builder == nil then return "你没有制作组件" end
    local ok, has = pcall(function() return builder:HasIngredients(recipe) end)
    if ok and has then return nil end
    return "材料不够"
end
A.missing_ingredients = missing_ingredients

local function snapshot_counts(p)
    local inv = p ~= nil and p.components ~= nil and p.components.inventory or nil
    if inv == nil then return {} end
    local counts = {}
    inv:ForEachItem(function(item)
        local prefab = item ~= nil and item.prefab or nil
        if prefab ~= nil then
            local n = U.count(item)
            counts[prefab] = (counts[prefab] or 0) + n
        end
    end)
    return counts
end
A.snapshot_counts = snapshot_counts

local function hand_prefab(p)
    local inv = p ~= nil and p.components ~= nil and p.components.inventory or nil
    if inv == nil then return nil end
    local hand = inv:GetEquippedItem(EQUIPSLOTS.HANDS)
    return hand ~= nil and hand.prefab or nil
end
A.hand_prefab = hand_prefab

local function count_diff(before, after)
    if before == nil or after == nil then return nil end
    local parts = {}
    for k, v in pairs(after) do
        local d = v - (before[k] or 0)
        if d > 0 then parts[#parts + 1] = string.format("%s+%d", k, d) end
    end
    for k, v in pairs(before) do
        local d = (after[k] or 0) - v
        if d < 0 then parts[#parts + 1] = string.format("%s%d", k, d) end
    end
    table.sort(parts)
    if #parts == 0 then return nil end
    return table.concat(parts, "，")
end
A.count_diff = count_diff

function A.register(name, fn)
    if A.atomic_jobs ~= nil and A.atomic_jobs[name] == true and JOBS[name] ~= nil then
        if Whale ~= nil and Whale.util ~= nil and Whale.util.log ~= nil then
            Whale.util.log("宏 " .. tostring(name) .. " 与原子动作重名，已忽略（保留原子动作）")
        end
        return false
    end
    JOBS[name] = fn
    return true
end

function A.count_item(p, prefab)
    if p == nil or prefab == nil then return 0 end
    local inv = p.components.inventory
    if inv == nil then return 0 end
    local want = string.lower(tostring(prefab))
    local total = 0
    inv:ForEachItem(function(item)
        local name = string.lower(tostring(item.prefab or ""))
        if name == want then   -- P1：精确匹配，避免 count_item("log") 把 livinglog 也算进去
            total = total + U.count(item)
        end
    end)
    return total
end

function A.run_sub(m, name, args)
    local p = U.player()
    if p == nil then return "fail", "现在没有玩家" end
    if m.sub == nil then
        m.sub = { name = name, args = args or {}, step = "start", data = {}, t0 = U.now() }
    end
    local fn = JOBS[m.sub.name]
    if fn == nil then
        m.sub = nil
        return "fail", "没有这个子动作：" .. tostring(name)
    end
    local ok, status, text = pcall(fn, m.sub, p)
    if not ok then
        m.sub = nil
        return "fail", "子动作出错：" .. tostring(status)
    end
    if status == "run" or status == nil then return "run", nil end
    m.sub = nil
    return status, text
end

local INSTANT_NON_INTRUSIVE = {
    inspect = true,
    recipes = true,
    lookup = true,
    probe = true,
}

function A.Start(name, args, cmd_id, ctx)
    -- R8.1：租约换手冻结期间，禁止任何 reflex 通道启动新动作（防止其它路径绕过冻结）
    if cmd_id == "reflex" and Whale ~= nil and Whale.bridge ~= nil
        and Whale.bridge.LocalActionsFrozen ~= nil and Whale.bridge.LocalActionsFrozen() then
        return false, "local_action_frozen"
    end
    local fn = JOBS[name]
    if fn == nil then
        local known = {}
        for k in pairs(JOBS) do known[#known + 1] = k end
        table.sort(known)
        return false, "没有这个动作：" .. tostring(name) .. "（能用的：" .. table.concat(known, "、") .. "）"
    end
    local p = U.player()
    if p == nil then return false, "现在没有玩家（游戏可能还在读档）" end
    -- 只读信息查询与聊天播报：单次同步完成，不打断当前正在执行的移动/工作/防御/Reflex 任务
    if INSTANT_NON_INTRUSIVE[name] == true then
        local temp_job = {
            name = name,
            args = args or {},
            cmd_id = cmd_id,
            step = "start",
            data = {},
            ctx = ctx or {},
            t0 = U.now(),
        }
        local ok_run, status, text = pcall(fn, temp_job, p)
        if not ok_run then
            if Whale.bridge ~= nil and Whale.bridge.Report ~= nil then
                Whale.bridge.Report(false, "动作异常：" .. tostring(status), cmd_id)
            end
            return true, nil
        end
        if Whale.bridge ~= nil and Whale.bridge.Report ~= nil then
            Whale.bridge.Report(status == "done", text or "", cmd_id)
        end
        return true, nil
    end
    if job ~= nil then
        -- ★ R8.5：抢占矩阵（唯一判定处）。以前这里是"reflex 一律不许被打断"，
        --   导致 Reflex flee 正在跑时，伴生防御永远接不上（真机：青蛙追击 →
        --   flee 反复启动 → advance_task 一直被 reflex_active 阻断）。
        --   现在只对"防御交接"按明确矩阵放行，其余保护一条没放宽。
        local ok_pre, why_pre = may_preempt(job, cmd_id, args, name)
        if not ok_pre then
            return false, why_pre or "job_running"
        end
        if why_pre ~= nil and why_pre ~= "preempt_ordinary" then
            pcall(function()
                print(string.format("[ACTIONS][PREEMPT] %s(%s) -> %s reason=%s",
                    tostring(job.name), tostring(job.cmd_id), tostring(name), tostring(why_pre)))
            end)
        end
        local prev_id = job.cmd_id
        pcall(function()
            stop_actions(p)
        end)
        Whale.bridge.Report(false, "被新指令打断了（上一件事没做完）", prev_id)
        -- ★ 明确清空旧 job：确认旧任务已清理后，才允许新任务开始（绝不允许两个 job 并存）。
        job = nil
        Whale.job = nil
    end
    job = {
        name = name,
        args = args or {},
        cmd_id = cmd_id,
        step = "start",
        data = {},
        ctx = ctx or {},
        t0 = U.now(),
        budget_s = ctx ~= nil and tonumber(ctx.budget_s) or nil,
    }
    job.data.inv_before = snapshot_counts(p)
    Whale.job = job
    return true, nil
end

function A.Abort(reason)
    if job == nil then return false end
    if Whale.actions ~= nil then
        local p = U.player()
        if p ~= nil then
            pcall(function()
                stop_actions(p)
            end)
        end
        Whale.bridge.Report(false, tostring(reason or "被打断了"), job.cmd_id)
        client_stop(U.player())
        job = nil
        Whale.job = nil
        return true
    end
    return false
end

function A.Tick()
    local j = job
    if j == nil then return end
    local p = U.player()
    if p == nil then
        Whale.bridge.Report(false, "玩家不见了（可能退出游戏了）", j.cmd_id)
        job = nil
        Whale.job = nil
        return
    end
    local fn = JOBS[j.name]
    local ok, status, text = pcall(fn, j, p)
    local budget = tonumber(j.budget_s) or 45
    if ok and status == "run" and j.t0 ~= nil then
        if (U.now() - j.t0) > budget then
            status = "fail"
            -- ★ R8.5 真机发现：战斗 job 被预算判失败时，battle 的会话不会被 StepJob 收尾，
            --   于是 B.InCombat()/active_target 会永久悬挂（日志里 REFLEX_SUPPRESSED 一直刷、没有 FINISH）。
            --   这里显式让 battle 自己收尾（Abort 内部会 Cleanup + 打 DEFENSE_ABORT 日志）。
            if j.name == "fight_spider" and Whale ~= nil and Whale.battle ~= nil
                and Whale.battle.Abort ~= nil then
                pcall(function() Whale.battle.Abort("budget_exceeded") end)
            end
            text = string.format("budget_exceeded: 这一步用了 %d 秒还没完（上限 %d 秒），先停下。已经做了一部分，用 get_state 看现在的真实状态再决定下一步",
                math.floor(U.now() - j.t0), math.floor(budget))
        end
    end
    if not ok or status == "fail"
        or ((j.name == "gather_area" or j.name == "seek") and status == "done") then
        pcall(stop_actions, p)
    end
    if not ok then
        Whale.util.log("动作 " .. tostring(j.name) .. " 出错：" .. tostring(status))
        client_stop(p)
        Whale.bridge.Report(false, "动作出错：" .. tostring(status), j.cmd_id)
        job = nil
        Whale.job = nil
        return
    end
    if status == "done" then
        client_stop(p)
        local change = count_diff(j.data.inv_before, snapshot_counts(p))
        local done_text = text or "好了"
        if change ~= nil then done_text = done_text .. "（背包：" .. change .. "）" end
        Whale.bridge.Report(true, done_text, j.cmd_id)
        job = nil
        Whale.job = nil
    elseif status == "fail" then
        client_stop(p)
        Whale.bridge.Report(false, text or "做不了", j.cmd_id)
        job = nil
        Whale.job = nil
    end
end

function A.Current()
    if job == nil then return nil end
    return job.name, job.args
end

local walk_rpc_tick = 0
function A.refresh_client_walk(force)
    local j = job
    if j == nil or (j.name ~= "move_to" and j.name ~= "go_to") then
        walk_rpc_tick = 0
        return false
    end
    local p = U.player()
    if p == nil then return false end
    local loco = p.components.locomotor
    if loco == nil then return false end
    local moving = false
    local ok_m, mv = pcall(function() return loco:WantsToMoveForward() end)
    if ok_m then moving = mv == true end
    if not moving then
        walk_rpc_tick = 0
        return false
    end
    walk_rpc_tick = walk_rpc_tick + 1
    if not force and (walk_rpc_tick % 5) ~= 0 then return false end
    local x, z = nil, nil
    local dest = nil
    pcall(function() dest = loco.dest end)
    if dest ~= nil then
        local ok_p, px, _, pz = pcall(function() return dest:GetPoint() end)
        if ok_p and px ~= nil then x, z = px, pz end
    end
    if x == nil then return false end
    local run = true
    local ok_r, wants = pcall(function() return loco:WantsToRun() end)
    if ok_r and wants ~= nil then run = wants == true end
    return client_walk(p, x, z, run)
end

function A.Known()
    local list = {}
    for k in pairs(JOBS) do list[#list + 1] = k end
    table.sort(list)
    return list
end

return A
