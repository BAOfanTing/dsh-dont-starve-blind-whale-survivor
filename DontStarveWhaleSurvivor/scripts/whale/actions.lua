-- 执行 AI 发来的动作
-- 每个动作是一个小的状态机：找目标 -> 推给游戏的动作系统（和玩家自己点鼠标走的是同一条路）-> 等它做完。
-- 这样体力消耗、动画、掉落、被怪打断都跟手动玩一致，不需要作弊改数据。
local GLOBAL = GLOBAL
-- 饥荒的模组沙箱只给了 pairs/ipairs/print/math/table/type/string/tostring/require/Class，
-- pcall / tonumber / error / os / io 这些得从 GLOBAL（就是 _G）里拿，直接用会报 nil（0.1.0 就是这么崩的）。
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local error = GLOBAL.error
local os = GLOBAL.os or { time = function() return 0 end }
local io = GLOBAL.io

local U = Whale.util
local A = {}

local ACTIONS = GLOBAL.ACTIONS
local EQUIPSLOTS = GLOBAL.EQUIPSLOTS
local Vector3 = GLOBAL.Vector3
local BufferedAction = GLOBAL.BufferedAction

-- 动作 id -> 中文说法（出错时告诉模型“附近没有能砍的东西”）
local WORK_NAMES = {
    CHOP = "砍",
    MINE = "挖矿",
    DIG = "铲",
    HAMMER = "拆",
}

local JOBS = {}
local job = nil

-- ─────────────────────────── 基础 ───────────────────────────

-- 让"那个玩家自己的客户端"也走一遍（详见下面 client_walk 的注释）。
-- 先在这里声明，是因为 push() 也要用它：动作自己让引擎走到目标旁边的那段路，
-- 同样是服务端单方面移动，客户端不自己走就只能平移。
local client_walk
local client_stop

local function busy(p)
    if p == nil then return false end
    if p:GetBufferedAction() ~= nil then return true end
    if p.sg ~= nil and not p.sg:HasStateTag("idle") then return true end
    return false
end
A.busy = busy

--- 让引擎走过去（动作、追击、采集都要走这一步）
local function push(p, ba)
    if p == nil or ba == nil then return false end
    local loco = p.components.locomotor
    if loco ~= nil then
        loco:PushAction(ba, true)
    else
        p:PushBufferedAction(ba)
    end
    -- 注意：这里**故意不通知客户端走路**。
    -- 真机（2026-11-12 晚）试过"动作也通知客户端走"，结果客户端和服务端各有一份移动意图，
    -- 客户端把人拖到树上了，服务端这边 `busy` 却一直是 false → chop 报"推不动"。
    -- 动作接近目标那一段的动画改由客户端自己补（hud.lua 的 WatchServerMove：
    -- 发现"位置在变但自己没在走"就播 run_loop，纯视觉，不参与移动）。
    return true
end

local function tile_away(p, tx, tz)
    local px, _, pz = U.pos(p)
    if px == nil then return math.huge end
    local x, z = U.tile_center(tx, tz)
    local dx, dz = px - x, pz - z
    return math.sqrt(dx * dx + dz * dz) / U.TILE
end

--- 走到某格中心。
--- 真机反馈（2026-11-12）：人物是"平移"没有跑步动画 —— 因为第 3 个参数 run 传了 false。
--- 解包 locomotor.lua 确认签名：GoToPoint(pt, bufferedaction, run, overridedest)，
--- run 会写进 self.wantstorun，并决定 RunForward() 还是 WalkForward()。
--- 正常玩按方向键是跑，所以这里默认跑（run=true），距离很近时再走，避免冲过头。
---
--- 真机反馈 2（2026-11-12 晚）：**还是平移**。查了 game scripts 才明白：
--- DST 里人物的走路动画是在**客户端**由它自己的 locomotor 预测出来的
--- （player_classified 里根本没有 ismoving/isrunning 这类同步字段），
--- 服务端 GoToPoint 只改物理位置 → 客户端只能看到位移，没人播动画。
--- 所以服务端走一遍的同时，还要用 mod RPC 通知"那个玩家的客户端"自己也走一遍，
--- 动画、脚步声、朝向就都对了（客户端那边 `ThePlayer.sg` 自己会进 run 状态）。
local MODNAME = type(modname) == "string" and modname or "DontStarveWhaleSurvivor"

local function env_fn(name)
    if env ~= nil and env[name] ~= nil then return env[name] end
    local fn = GLOBAL[name]
    if fn ~= nil then return fn end
    return nil
end

--- 让玩家自己的客户端去走（拿不到客户端就当无事发生）
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
A.client_walk = client_walk
A.client_stop = client_stop
A.MODNAME = MODNAME

local function equip_if_needed(p, item)
    local inv = p.components.inventory
    if inv == nil or item == nil then return end
    if inv:GetEquippedItem(EQUIPSLOTS.HANDS) == item then return end
    pcall(function() inv:Equip(item) end)
end

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

--- Phase 5 M5 修复：模拟"按住动作键"（空格 / F）。
---
--- 解包 SGwilson.lua 的 chop 状态（第 5110~5128 行）发现官方连砍机制：
---   TimeEvent(14 * FRAMES, function(inst)
---       if playercontroller:IsAnyOfControlsPressed(CONTROL_ACTION) then
---           inst:ClearBufferedAction()
---           inst:PushBufferedAction(inst.sg.statemem.action)   -- 引擎自己重推同一个动作
---       end
---   end)
--- 而 playercontroller.lua 的 IsAnyOfControlsPressed 在**专用服务器上（handler == nil）**
--- 读的是 self.remote_controls[control] —— 这正是远程客户端"按键状态"的同步通道。
--- 所以只要往 remote_controls 里塞一个 CONTROL_ACTION，引擎就会自己在状态机里连砍，
--- 不需要我们在外部每 0.2 秒轮询重推（那才是"砍两下顿一下"的根源）。
local function hold_control(p, want)
    local pc = p ~= nil and p.components ~= nil and p.components.playercontroller or nil
    if pc == nil then return false end
    local control = GLOBAL.CONTROL_ACTION
    if control == nil then return false end
    local ok = pcall(function()
        pc.remote_controls = pc.remote_controls or {}
        if want then
            pc.remote_controls[control] = true
        else
            pc.remote_controls[control] = nil
        end
    end)
    return ok
end
A.hold_control = hold_control

--- 背包里最该吃的：先看能补多少饥饿，再看新鲜度
--- 真机 bug（2026-11-12 两次）：原来 score 允许负分物品胜出，把「树枝」当食物吃了。
--- 第一次修只加了 hunger > 0，但真机仍选了树枝 → 说明 twigs 的 hungervalue 是 0 或正数，
--- 光看数值不够。现在加**绝对不吃的黑名单**（树枝/草/石头这类材料），
--- 并把阈值提高到"至少能补 3 点饥饿"才算食物。
local NOT_FOOD = {
    twigs = true, cutgrass = true, grass = true, log = true, rocks = true,
    flint = true, nitre = true, goldnugget = true, charcoal = true,
    silk = true, pigskin = true, honeycomb = true, beefalowool = true,
}
local MIN_FOOD_HUNGER = 3   -- 补饥饿低于这个值的不算"值得吃"

local function best_food(p)
    local inv = p.components.inventory
    if inv == nil then return nil end
    local best, best_score = nil, 0   -- 必须 > 0 才算"能吃"
    inv:ForEachItem(function(item)
        local edible = item.components.edible
        if edible ~= nil then
            local prefab = item.prefab
            if NOT_FOOD[prefab] then
                -- 明确不是食物（材料类），跳过
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

--- 按名字找附近的东西：先比 prefab，再比中文名，最后比 tag（"tag:xxx"）
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
    -- 真机反馈（2026-11-12）：砍 evergreen_sparse 要 20 下、30 秒，手动砍普通树只要 10 秒。
    -- 差别在**目标选得不对**，不是挥斧速度。所以这里按「性价比」挑目标：
    --   分数 = 距离 + workleft 权重，优先「近且好砍」的（普通 evergreen 只要 5~6 下）。
    -- 同时给"同 prefab 里 workleft 更低"的加分，避免老是挑到稀疏变种。
    local best, best_score = nil, math.huge
    local list = U.find_all(p, radius, nil, nil, function(e)
        local w = e.components ~= nil and e.components.workable or nil
        return w ~= nil and w.action ~= nil and w.action.id == action_id
    end)
    for _, entry in ipairs(list) do
        -- skip：推不动过的目标（普通斧头砍不动臃肿常青树），别再挑它
        local skipped = false
        if skip ~= nil and skip[entry.ent] == true then skipped = true end
        if not skipped then
            local w = entry.ent.components.workable
            local left = 0
            local ok_l, l = pcall(function() return w.workleft end)
            if ok_l and tonumber(l) ~= nil then left = tonumber(l) end
            if left > 0 then
                -- 距离每格算 1 分；每 10 点 workleft 折 1 分（砍得快的优先）
                local score = entry.d + left / 10
                if score < best_score then
                    best, best_score = entry.ent, score
                end
            end
        end
    end
    if best ~= nil then return best end
    -- 兜底：连 workleft 都读不到时，退回"最近的"
    local ent = U.find_nearest(p, radius, nil, nil, function(e)
        local w = e.components ~= nil and e.components.workable or nil
        return w ~= nil and w.action ~= nil and w.action.id == action_id
    end)
    return ent
end

local function nearest_hostile(p, radius)
    local ent = U.find_nearest(p, radius, { "hostile" }, nil, function(e)
        local h = e.components ~= nil and e.components.health or nil
        return h ~= nil and not h:IsDead()
    end)
    return ent
end

-- ─────────────────────────── 动作 ───────────────────────────

JOBS.move_to = function(j, p)
    local tx = tonumber(j.args.x)
    local tz = tonumber(j.args.z)
    if tx == nil or tz == nil then
        return "fail", "move_to 要传格子坐标 x 和 z，比如 {\"x\":12,\"z\":45}"
    end
    -- 真机踩到（2026-11-12）：上层传了**世界坐标**（比如 210），被当成格子坐标 210 →
    -- 目标跑到世界坐标 842，距离 319 格，永远走不到。
    -- 这里加一层兜底：如果 |x| 或 |z| 明显超出世界格子范围（DST 世界最大约 ±400 格），
    -- 就当成世界坐标，折算回格子坐标（世界 / 4）。
    if math.abs(tx) > 400 or math.abs(tz) > 400 then
        tx = math.floor(tx / U.TILE)
        tz = math.floor(tz / U.TILE)
        j.args.x, j.args.z = tx, tz
    end
    if j.step == "start" then
        walk_to(p, tx, tz)
        j.step = "walk"
        j.data.lastcheck = U.now()
        j.data.retry = 0
    end
    local away = tile_away(p, tx, tz)
    if away <= 1.2 then
        return "done", string.format("走到了 (%d,%d) 附近（还差 %.1f 格）", tx, tz, away)
    end
    local timeout = tonumber(j.args.timeout) or 60
    if U.now() - j.t0 > timeout then
        return "fail", string.format("走不到 (%d,%d)：卡在 %.1f 格外（可能有东西挡着）", tx, tz, away)
    end
    if U.now() - j.data.lastcheck > 2 then
        j.data.lastcheck = U.now()
        local loco = p.components.locomotor
        -- 真机 bug（2026-11-12）：loco:IsMoving() 不存在（locomotor.lua 里没有这个方法），
        -- 直接调用抛错把整个动作打成 FAILED。正确 API 是 WantsToMoveForward()。
        local moving = false
        if loco ~= nil then
            local ok_m, mv = pcall(function() return loco:WantsToMoveForward() end)
            if ok_m then moving = mv == true end
        end
        if loco == nil or not moving then
            j.data.retry = j.data.retry + 1
            if j.data.retry > 8 then
                return "fail", string.format("被挡死了，站在 %.1f 格外过不去", away)
            end
            walk_to(p, tx, tz)
        end
    end
    return "run"
end

JOBS.go_to = function(j, p)
    local want = j.args.target
    if want == nil or want == "" then
        return "fail", "go_to 要传 target（东西的名字，比如 berrybush、spider、cookpot；也可以用 tag:hostile）"
    end
    if j.step == "start" then
        local radius = tonumber(j.args.radius) or 30
        local list = find_by_name(p, radius, want)
        if #list == 0 then
            return "fail", string.format("附近 %d 格里没找到 %s", radius, tostring(want))
        end
        local ent = list[1].ent
        local x, _, z = U.pos(ent)
        local tx, tz = U.tile_of(x, z)
        j.data.name = U.pretty(ent)
        j.data.tx, j.data.tz = tx, tz
        walk_to(p, tx, tz)
        j.step = "walk"
        j.data.lastcheck = U.now()
    end
    local away = tile_away(p, j.data.tx, j.data.tz)
    if away <= 1.5 then
        return "done", string.format("走到 %s 旁边了 (%.1f 格)", j.data.name, away)
    end
    if U.now() - j.t0 > (tonumber(j.args.timeout) or 90) then
        return "fail", string.format("走不到 %s：卡在 %.1f 格外", j.data.name, away)
    end
    if U.now() - j.data.lastcheck > 2 then
        j.data.lastcheck = U.now()
        local loco = p.components.locomotor
        -- 同上：IsMoving 不存在，用 WantsToMoveForward（pcall 保护）
        local moving = false
        if loco ~= nil then
            local ok_m, mv = pcall(function() return loco:WantsToMoveForward() end)
            if ok_m then moving = mv == true end
        end
        if loco == nil or not moving then
            walk_to(p, j.data.tx, j.data.tz)
        end
    end
    return "run"
end

local function job_work(j, p, action_id)
    if j.step == "start" then
        j.data.count = tonumber(j.args.count) or 1
        j.data.done_count = 0        -- 干了多少下
        j.data.done_targets = 0      -- 干倒/干空了几个目标
        j.data.radius = tonumber(j.args.radius) or 20
        -- Phase 5 M5：until_gone = 一直干到当前目标消失（砍倒一棵树要 4~5 下，
        -- 只砍 1 下树不倒、不掉东西 —— 真机踩到过：chop count=1 返回"干了 1 次"但没拿到木头）
        -- 语义：count = 要干倒几个目标；until_gone=false 时 count 才表示"干几下"。
        j.data.until_gone = j.args.until_gone == true
        j.data.max_hits = tonumber(j.args.max_hits) or 30
        j.data.cur_hits = 0          -- 当前目标已经干了几下
        -- 真机 bug（2026-11-12）：done_targets 在 busy 分支和 done_count 分支**都会累加**，
        -- 同一棵树被算两次 → chop(count=3) 砍 1~2 棵就报"干倒了 3 个目标"但没真砍够。
        -- 加 counted 标记，确保每个目标只计一次。
        j.data.counted = false
        j.step = "next"
    end
    if j.step == "next" then
        if not j.data.until_gone and j.data.done_count >= j.data.count then
            hold_control(p, false)
            return "done", string.format("连着干了 %d 次", j.data.done_count)
        end
        if j.data.until_gone and j.data.done_targets >= j.data.count then
            hold_control(p, false)
            return "done", string.format("干倒了 %d 个目标（共 %d 下）", j.data.done_targets, math.max(1, j.data.done_count or 0))
        end
        if j.data.done_count >= j.data.max_hits then
            hold_control(p, false)
            return "done", string.format("干了 %d 下就停了（可能工具不对或目标太硬）", j.data.done_count)
        end
        -- until_gone 模式：优先继续砍同一个目标，避免每次都重新找"最近的"导致来回换树
        -- （真机踩到：60 秒砍 30 下没砍倒一棵 —— 每下都在换树）
        local target = nil
        if j.data.until_gone and j.data.target ~= nil and j.data.target:IsValid() then
            local w = j.data.target.components ~= nil and j.data.target.components.workable or nil
            local ok_w, left = pcall(function() return w ~= nil and w.workleft or 0 end)
            if ok_w and left ~= nil and left > 0 then
                target = j.data.target
            end
        end
        if target == nil then
            target = find_workable(p, j.data.radius, action_id, j.args.target, j.data.skip)
        end
        if target == nil then
            if j.data.done_count > 0 then
                -- until_gone 模式：目标消失 = 上一个目标被干倒了
                if j.data.until_gone then
                    j.data.done_targets = j.data.done_targets + 1
                    if j.data.done_targets >= j.data.count then
                        hold_control(p, false)
                        return "done", string.format("干倒了 %d 个目标（共 %d 下）", j.data.done_targets, math.max(1, j.data.done_count or 0))
                    end
                end
                hold_control(p, false)
                return "done", string.format("干了 %d 次，附近没有能再%s的了", j.data.done_count, WORK_NAMES[action_id])
            end
            hold_control(p, false)
            return "fail", string.format("附近 %d 格里没有能%s的东西", j.data.radius, WORK_NAMES[action_id])
        end
        local action = ACTIONS[action_id]
        if action == nil then return "fail", "这个版本没有这个动作：" .. action_id end
        local item = best_tool(p, action)
        if item ~= nil then equip_if_needed(p, item) end
        local ba = BufferedAction(p, target, action, item)
        j.data.target = target
        j.data.pushed_target = target     -- 给"砍倒计数"留证据（引擎连砍时 cur_hits 不涨）
        j.data.counted = false              -- 新目标，重置计数标记
        j.data.ba = ba                      -- 保存，连砍时复用（不重建，避免打断状态机）
        j.data.last_name = U.pretty(target)
        j.data.phase_start = U.now()
        j.data.phase_wait = false
        push(p, ba)
        -- 关键：把"按住动作键"置上，引擎的 chop 状态机会在动画第 14 帧
        -- 自己 PushBufferedAction 同一个动作 → 真正连续的连砍（官方机制）
        if j.data.until_gone then hold_control(p, true) end
        j.step = "acting"
        return "run"
    end
    if j.step == "acting" then
        -- 先等它真正开始，再等它结束
        if not j.data.phase_wait then
            if busy(p) then j.data.phase_wait = true end
            if U.now() - j.data.phase_start > 3 and not j.data.phase_wait then
                -- 3 秒还没动起来：可能是工具不对（比如普通斧头砍不动"臃肿常青树"），
                -- 或者够不着。真机反馈（2026-11-12）：这种情况直接 FAILED 太脆，
                -- 应该把这棵树拉黑、换下一棵重试（最多换 3 次）。
                local target = j.data.target
                local w = target ~= nil and target:IsValid() and target.components.workable or nil
                if w ~= nil and w.workleft ~= nil and w.workleft > 0 then
                    j.data.skip = j.data.skip or {}
                    if target ~= nil then j.data.skip[target] = true end
                    j.data.skip_count = (j.data.skip_count or 0) + 1
                    if j.data.skip_count >= 3 then
                        hold_control(p, false)
                        -- 报错要能定位：说清目标是谁（中文名 + prefab）、手里拿的是什么工具。
                        -- 真机上"推不动 多枝树：可能需要更好的工具"这种话查不出原因。
                        local hands = nil
                        local inv = p.components.inventory
                        if inv ~= nil then hands = inv:GetEquippedItem(EQUIPSLOTS.HANDS) end
                        return "fail", string.format("推不动 %s（prefab=%s）：手里是 %s，可能工具不对或者够不着",
                            U.pretty(target), tostring(target ~= nil and target.prefab or "?"),
                            hands ~= nil and U.describe_item(hands) or "空手")
                    end
                    -- 换目标重试：回到 next 重新挑（跳过已拉黑的）
                    j.data.target = nil
                    j.data.ba = nil
                    j.step = "next"
                    j.data.phase_wait = false
                    return "run"
                end
            end
            return "run"
        end
        if busy(p) then
            if U.now() - j.data.phase_start > 120 then
                hold_control(p, false)
                return "fail", "这个活儿做不完（可能工具不对或者够不着）"
            end
            -- 整个任务的兜底：引擎"按住动作键"连砍时，单次动作永远不会结束，
            -- 上面的 120 秒（按单次 push 计时）永远不触发 → 必须有一个按任务总时长的出口。
            if j.data.until_gone and U.now() - j.t0 > (tonumber(j.args.timeout) or 240) then
                hold_control(p, false)
                return "fail", string.format("超时了：干了 %d 下、干倒 %d 个目标（要 %d 个），先看看周围还有没有能干的",
                    j.data.done_count, j.data.done_targets or 0, j.data.count)
            end
            -- 真机验证（2026-11-12）：hold_control 一开，引擎就在状态机内部自己连砍，
            -- 效果是"按住空格"——实测 push 1 次就砍倒了 6 棵树（完全连续、无顿挫）。
            -- 但**必须及时松手**，否则会一路砍下去。这里每次 tick 检查当前目标是否已被砍倒：
            -- 砍倒的树会变树桩（workable.action 从 CHOP 变成 DIG/MINE）。
            if j.data.until_gone and j.data.target ~= nil then
                local t = j.data.target
                local w = t:IsValid() and t.components ~= nil and t.components.workable or nil
                local done_this = false
                if w == nil or not t:IsValid() then
                    done_this = true
                else
                    local ok_a, act = pcall(function() return w.action end)
                    local ok_l, left = pcall(function() return w.workleft end)
                    if ok_a and act ~= nil and act.id ~= action_id then done_this = true end
                    if ok_l and tonumber(left) ~= nil and tonumber(left) <= 0 then done_this = true end
                end
                if done_this then
                    -- 目标倒了：立刻松手，避免继续砍下一棵
                    hold_control(p, false)
                    -- 真机 bug（2026-11-12 真机验证）：done_this 只看"目标无效/动作变了"，
                    -- 但如果这一斧根本没挥出去（cur_hits == 0），那是换目标而不是砍倒，
                    -- 不能计数 —— 否则 chop(count=3) 会报"砍倒 3 个"实际只倒 1 棵。
                    --
                    -- 真机 bug 2（2026-11-12 二次真机）：一旦引擎"按住动作键"连砍真的生效
                    -- （hold_control 打开后引擎自己在状态机里重推），人物**一直是 busy**，
                    -- 走不到下面 +1 的分支 → cur_hits 永远是 0 → 一棵都被判成"没挥过"→
                    -- done_targets 永远不涨 → count=1 也会一路砍下去（实测 2 分钟砍了 16 棵）。
                    -- 所以改用"这个目标我真的推过动作"作为证据。
                    local actually_chopped = j.data.pushed_target == t or (j.data.cur_hits or 0) > 0
                    if actually_chopped and not j.data.counted then
                        j.data.counted = true
                        j.data.done_targets = (j.data.done_targets or 0) + 1
                    end
                    if actually_chopped then
                        j.data.done_count = math.max(j.data.done_count, 1)
                    end
                    if j.data.done_targets >= j.data.count then
                        return "done", string.format("干倒了 %d 个目标（连续砍，共 %d 下）",
                            j.data.done_targets, math.max(1, j.data.done_count or 0))
                    end
                    -- 还要继续砍下一棵：清掉目标回 next 重新挑
                    j.data.target = nil
                    j.data.ba = nil
                    j.data.counted = false
                    j.data.phase_wait = false
                    j.step = "next"
                    return "run"
                end
            end
            return "run"
        end
        j.data.done_count = j.data.done_count + 1
        j.data.cur_hits = (j.data.cur_hits or 0) + 1
        -- 兜底出口：这个循环必须能停（真机踩到：一直在 acting 里连砍，永远不结束，
        -- 直到 action_executor 120 秒超时）
        if j.data.done_count >= j.data.max_hits then
            hold_control(p, false)
            return "done", string.format("干了 %d 下就停了（目标可能太硬）", j.data.done_count)
        end
        if j.data.until_gone and j.data.target ~= nil and j.data.target:IsValid() then
            local w = j.data.target.components ~= nil and j.data.target.components.workable or nil
            -- 目标还算"能继续砍"的条件：有 workable、动作还是同一个、还有剩余工作量
            -- （砍倒的树会变成树桩，workable.action 变成 DIG/MINE，据此判定已砍倒）
            local same_action = false
            local left = 0
            if w ~= nil then
                local ok_a, act = pcall(function() return w.action end)
                local ok_l, l = pcall(function() return w.workleft end)
                if ok_a and act ~= nil and act.id == action_id then same_action = true end
                if ok_l and tonumber(l) ~= nil then left = tonumber(l) end
            end
            if same_action and left > 0 then
                -- 还有剩余工作量：**复用同一个 BufferedAction** 再砍一下。
                -- 解包 playercontroller.lua 确认：官方"按住 F 连砍"是
                --   lastheldaction.options.no_predict_fastforward = true
                --   playercontroller:DoAction(lastheldaction)   ← 复用，不重建
                -- 重建 BufferedAction 会打断 sg 状态机，表现就是"砍一下顿一下"。
                local action = ACTIONS[action_id]
                if action ~= nil then
                    local item = best_tool(p, action)
                    if item ~= nil then equip_if_needed(p, item) end
                    local ba = j.data.ba
                    if ba == nil then
                        ba = BufferedAction(p, j.data.target, action, item)
                        j.data.ba = ba
                    else
                        ba.doable = nil      -- 允许重放（上一次已 done）
                    end
                    pcall(function() ba.options.no_predict_fastforward = true end)
                    push(p, ba)
                    j.data.phase_start = U.now()
                    j.data.phase_wait = false
                    return "run"
                end
            end
            -- 目标砍倒了（或变成树桩）：只有真的挥过斧头才算
            if (j.data.cur_hits or 0) > 0 and not j.data.counted then
                j.data.counted = true
                j.data.done_targets = (j.data.done_targets or 0) + 1
            end
            j.data.cur_hits = 0
            if j.data.done_targets >= j.data.count then
                hold_control(p, false)
                return "done", string.format("干倒了 %d 个目标（共 %d 下）", j.data.done_targets, math.max(1, j.data.done_count or 0))
            end
        end
        j.step = "next"
        return "run"
    end
    return "run"
end

JOBS.chop = function(j, p) return job_work(j, p, "CHOP") end
JOBS.mine = function(j, p) return job_work(j, p, "MINE") end
JOBS.hammer = function(j, p) return job_work(j, p, "HAMMER") end
JOBS.dig = function(j, p) return job_work(j, p, "DIG") end

JOBS.pick = function(j, p)
    if j.step == "start" then
        j.data.count = tonumber(j.args.count) or 1
        j.data.done_count = 0
        j.data.radius = tonumber(j.args.radius) or 12
        j.step = "next"
    end
    if j.step == "next" then
        if j.data.done_count >= j.data.count then
            return "done", string.format("采了 %d 次", j.data.done_count)
        end
        local target = nil
        local action = nil
        local list = U.find_all(p, j.data.radius, nil, nil, function(e)
            -- Pickable 组件没有 CanBePicked 方法：能不能采看标签（barren = 采空了还没长回来）
            if e:HasTag("pickable") and not e:HasTag("barren") then return true end
            local c = e.components
            if c ~= nil and c.harvestable ~= nil then
                local ok, can = pcall(function() return c.harvestable:CanBeHarvested() end)
                if ok and can == true then return true end
            end
            return false
        end)
        if j.args.target ~= nil then
            local by_name = find_by_name(p, j.data.radius, j.args.target)
            list = by_name
        end
        for _, entry in ipairs(list) do
            local ent = entry.ent
            local c = ent.components
            if ent:HasTag("pickable") then
                target, action = ent, ACTIONS.PICK
                break
            elseif c ~= nil and c.harvestable ~= nil then
                target, action = ent, ACTIONS.HARVEST
                break
            end
        end
        if target == nil then
            if j.data.done_count > 0 then
                return "done", string.format("采了 %d 次，附近没有能采的了", j.data.done_count)
            end
            return "fail", string.format("附近 %d 格里没有能采的东西", j.data.radius)
        end
        j.data.name = U.pretty(target)
        push(p, BufferedAction(p, target, action, nil))
        j.data.phase_start = U.now()
        j.data.phase_wait = false
        j.step = "acting"
        return "run"
    end
    if j.step == "acting" then
        if not j.data.phase_wait then
            if busy(p) then j.data.phase_wait = true end
            if U.now() - j.data.phase_start > 30 then
                return "fail", string.format("%s 采不了（可能没了或者够不着）", j.data.name)
            end
            return "run"
        end
        if busy(p) then
            if U.now() - j.data.phase_start > 60 then
                return "fail", "采不动了"
            end
            return "run"
        end
        j.data.done_count = j.data.done_count + 1
        j.step = "next"
        return "run"
    end
    return "run"
end

-- 捡起地上的东西（Phase 5 M3 补遗 / M4 开放：真机确认 ACTIONS.PICKUP 存在后才加的）
--- 背包/物品计数（pickup 与动作收尾都要用；必须定义在调用者之前）
local function snapshot_counts(p)
    local out = {}
    local inv = p ~= nil and p.components.inventory or nil
    if inv == nil then return out end
    inv:ForEachItem(function(item)
        local key = item.prefab or "?"
        out[key] = (out[key] or 0) + U.count(item)
    end)
    return out
end

--- M2.1：按 #N 引用拾取**已解析好的**实体。
--- 与 JOBS.pickup 的区别：绝不按 prefab 搜目标，也不通知客户端走路/不触发寻路。
--- 成功判据只看真实状态：目标进了玩家背包（parent/owner），或目标被原生堆叠合并且背包该 prefab 总数增加。
--- 依据：scripts.zip/scripts/actions.lua 的 ACTIONS.PICKUP.fn → inventory:GiveItem(target, nil, pos)；
--- 注意 GiveItem 失败时会把物品丢回地面，而 PICKUP.fn 仍然 return true，所以不能只看"动作没报错"。
local function pickup_by_ref(j, p, target)
    if target == nil or not target:IsValid() then
        return "fail", "entity_gone: 目标已经不存在了"
    end
    if target:IsInLimbo() then
        return "fail", "in_limbo: 目标进入了 limbo"
    end
    local inv = p.components.inventory
    if inv == nil then return "fail", "missing_component:inventory" end

    if j.step == "start" then
        j.data.target = target
        j.data.prefab = tostring(target.prefab or "?")
        j.data.before = snapshot_counts(p)
        j.data.phase_start = U.now()
        push(p, BufferedAction(p, target, ACTIONS.PICKUP, nil))
        j.step = "acting"
        return "run"
    end

    if j.step == "acting" then
        local t = j.data.target
        local alive = t ~= nil and t:IsValid()
        local owned = false
        if alive then
            local okp, parent = pcall(function() return t:GetParent() end)
            if okp and parent == p then owned = true end
            local oki, owner = pcall(function()
                return t.components.inventoryitem ~= nil and t.components.inventoryitem.owner or nil
            end)
            if oki and owner == p then owned = true end
        end
        if owned then
            return "done", string.format("捡起了 %s", U.pretty(t))
        end
        local after = snapshot_counts(p)
        local gained = (after[j.data.prefab] or 0) - (j.data.before[j.data.prefab] or 0)
        if not alive and gained > 0 then
            return "done", string.format("捡起了 %s（合并进已有的那一堆）", j.data.prefab)
        end
        if U.now() - j.data.phase_start > 6 then
            if not alive then
                return "fail", "result_unverified: 目标消失了，但背包里没见到对应物品"
            end
            return "fail", "pickup_failed: 目标还在地上（够不着，或背包满了）"
        end
        return "run"
    end
    return "run"
end

JOBS.pickup = function(j, p)
    -- M2.1：带 ctx.target 时走"按 #N 引用拾取"的新路径（不搜 prefab、不乱走）；
    -- 老调用方（args.item）仍然走下面的原逻辑，语义不变。
    local ctx = j.ctx or {}
    if ctx.target ~= nil then
        return pickup_by_ref(j, p, ctx.target)
    end
    if j.step == "start" then
        j.data.count = tonumber(j.args.count) or 1
        j.data.done_count = 0
        j.data.radius = tonumber(j.args.radius) or 12
        j.data.want = string.lower(tostring(j.args.item or ""))
        j.step = "next"
    end
    if j.step == "next" then
        if j.data.done_count >= j.data.count then
            return "done", string.format("捡了 %d 个", j.data.done_count)
        end
        -- 掉落物 = 有 inventoryitem 组件且 owner 为 nil（entity_observer 里同一判据）
        local list = U.find_all(p, j.data.radius, nil, nil, function(e)
            local c = e.components
            if c == nil or c.inventoryitem == nil then return false end
            local ok, held = pcall(function() return c.inventoryitem.owner ~= nil end)
            if ok and held then return false end
            if j.data.want == "" then return true end
            local prefab = string.lower(e.prefab or "")
            return string.find(prefab, j.data.want, 1, true) ~= nil
        end)
        local target = list[1] ~= nil and list[1].ent or nil
        if target == nil then
            if j.data.done_count > 0 then
                return "done", string.format("捡了 %d 个，附近没有能捡的了", j.data.done_count)
            end
            return "fail", string.format("附近 %d 格里没有能捡的 %s", j.data.radius,
                j.data.want ~= "" and j.data.want or "东西")
        end
        j.data.name = U.pretty(target)
        push(p, BufferedAction(p, target, ACTIONS.PICKUP, nil))
        j.data.phase_start = U.now()
        j.data.phase_wait = false
        j.step = "acting"
        return "run"
    end
    if j.step == "acting" then
        if not j.data.phase_wait then
            if busy(p) then j.data.phase_wait = true end
            if U.now() - j.data.phase_start > 30 then
                return "fail", string.format("%s 捡不了（可能没了或者够不着）", j.data.name)
            end
            return "run"
        end
        if busy(p) then
            if U.now() - j.data.phase_start > 60 then
                return "fail", "捡不动了"
            end
            return "run"
        end
        j.data.done_count = j.data.done_count + 1
        j.step = "next"
        return "run"
    end
    return "run"
end

JOBS.attack = function(j, p)
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

JOBS.eat = function(j, p)
    local item = nil
    if j.args.item ~= nil and j.args.item ~= "" then
        item = U.find_item(p, j.args.item)
        if item == nil then return "fail", "背包里没有 " .. tostring(j.args.item) end
    else
        item = best_food(p)
        if item == nil then return "fail", "背包里没有能吃的东西" end
    end
    if item.components.edible == nil then
        return "fail", U.pretty(item) .. " 不能吃"
    end
    if busy(p) then
        if U.now() - j.t0 > 20 then return "fail", "手上正忙着，没吃上" end
        return "run"
    end
    if j.step == "start" then
        j.data.name = U.describe_item(item)
        j.data.hunger_before = p.components.hunger ~= nil and p.components.hunger.current or nil
        push(p, BufferedAction(p, nil, ACTIONS.EAT, item))
        j.step = "acting"
        j.data.phase_start = U.now()
        return "run"
    end
    if busy(p) and U.now() - j.data.phase_start < 20 then return "run" end
    local hunger = p.components.hunger ~= nil and p.components.hunger.current or nil
    local delta = (hunger ~= nil and j.data.hunger_before ~= nil) and (hunger - j.data.hunger_before) or nil
    if delta ~= nil and delta > 0.5 then
        return "done", string.format("吃了 %s，饥饿 +%d", j.data.name, math.floor(delta))
    end
    return "done", "吃了 " .. j.data.name
end

JOBS.cook = function(j, p)
    if j.step == "start" then
        local cooker = U.find_nearest(p, tonumber(j.args.radius) or 12, { "cooker" }, nil, function(e)
            local fuel = e.components ~= nil and e.components.fueled or nil
            return fuel == nil or not fuel:IsEmpty()
        end)
        if cooker == nil then
            return "fail", "附近没有烧着的东西（营火/火坑），先在旁边生个火"
        end
        local ingredient = nil
        if j.args.item ~= nil and j.args.item ~= "" then
            ingredient = U.find_item(p, j.args.item)
        else
            local inv = p.components.inventory
            if inv ~= nil then
                inv:ForEachItem(function(item)
                    if ingredient == nil and item.components.cookable ~= nil then ingredient = item end
                end)
            end
        end
        if ingredient == nil then
            return "fail", "背包里没有能烤/煮的东西"
        end
        if busy(p) then
            if U.now() - j.t0 > 20 then return "fail", "忙着，没烤上" end
            return "run"
        end
        j.data.name = U.pretty(ingredient)
        j.data.cooker = cooker
        push(p, BufferedAction(p, cooker, ACTIONS.COOK, ingredient))
        j.data.phase_start = U.now()
        j.step = "acting"
        return "run"
    end
    if busy(p) and U.now() - j.data.phase_start < 20 then return "run" end
    return "done", string.format("把 %s 放到火上烤了（烤好的东西在火堆旁边/背包里，记得吃掉）", j.data.name)
end

local function recipe_of(name)
    if name == nil then return nil end
    local key = tostring(name)
    local recipes = GLOBAL.AllRecipes or {}
    local recipe = recipes[key]
    if recipe ~= nil then return recipe, key end
    local lower = string.lower(key)
    for k, r in pairs(recipes) do
        if string.lower(k) == lower then return r, k end
    end
    return nil, nil
end

local function missing_ingredients(p, recipe)
    local builder = p.components.builder
    if builder == nil then return "你没有制作组件" end
    local ok, has = pcall(function() return builder:HasIngredients(recipe) end)
    if ok and has then return nil end
    return "材料不够"
end

--- 这块地能不能放下这个东西
local function can_deploy(recipe, x, z)
    local world = GLOBAL.TheWorld
    if world == nil or world.Map == nil then return false end
    local ok, res = pcall(function() return world.Map:CanDeployRecipeAtPoint(Vector3(x, 0, z), recipe, 0) end)
    return ok and res == true
end

--- 没给坐标时，从脚下往外找一个放得下的格子
local function find_spot(p, recipe)
    local px, _, pz = U.pos(p)
    if px == nil then return nil end
    local bx, bz = U.tile_of(px, pz)
    local around = {
        { 0, 0 }, { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 },
        { 1, 1 }, { -1, -1 }, { 1, -1 }, { -1, 1 },
        { 2, 0 }, { -2, 0 }, { 0, 2 }, { 0, -2 },
    }
    for _, d in ipairs(around) do
        local x, z = U.tile_center(bx + d[1], bz + d[2])
        if can_deploy(recipe, x, z) then return bx + d[1], bz + d[2] end
    end
    return nil
end

JOBS.craft = function(j, p)
    if j.step == "start" then
        local recipe, key = recipe_of(j.args.recipe or j.args.name)
        if recipe == nil then
            return "fail", "没有这个配方：" .. tostring(j.args.recipe) .. "（用游戏里的配方名，比如 torch、axe、spear、campfire）"
        end
        local builder = p.components.builder
        if builder == nil then return "fail", "你现在不能制作东西" end
        local ok, knows = pcall(function() return builder:KnowsRecipe(recipe) end)
        if ok and knows == false then
            return "fail", string.format("%s 还不会做（要先做科学机器/靠近它解锁）", key)
        end
        local missing = missing_ingredients(p, recipe)
        if missing ~= nil then
            return "fail", string.format("%s %s", key, missing)
        end
        j.data.recipe, j.data.key = recipe, key
        j.data.placeable = recipe.placer ~= nil
        j.data.count = tonumber(j.args.count) or 1
        j.data.done_count = 0
        j.step = "acting"
    end

    -- 要摆到地上的东西（建筑、火堆）一律走摆放逻辑，那里会挑一块放得下的地
    if j.data.placeable then
        return job_build(j, p)
    end

    if j.data.pending then
        if busy(p) then
            if U.now() - j.t0 > 120 then return "fail", "做东西卡住了" end
            return "run"
        end
        j.data.pending = nil
    end
    if j.data.done_count >= j.data.count then
        return "done", string.format("做了 %d 个 %s", j.data.done_count, j.data.key)
    end
    if busy(p) then
        if U.now() - j.t0 > 180 then return "fail", "手上一直忙着，没做出东西" end
        return "run"
    end
    local builder = p.components.builder
    -- 注意：MakeRecipeFromMenu / MakeRecipeAtPoint 是客户端菜单用的，服务端调用会因为
    -- “背包没被打开”直接 return（什么也不做），所以这里必须用 MakeRecipe。
    local ok, started = pcall(function() return builder:MakeRecipe(j.data.recipe, nil, nil, nil) end)
    if not ok then return "fail", "制作出错：" .. tostring(started) end
    if started ~= true then
        return "fail", string.format("%s 没做出来（材料或状态不允许）", j.data.key)
    end
    j.data.pending = true
    j.data.done_count = j.data.done_count + 1
    return "run"
end

function job_build(j, p)
    if j.step == "start" then
        local recipe, key = recipe_of(j.args.recipe or j.args.name)
        if recipe == nil then
            return "fail", "没有这个配方：" .. tostring(j.args.recipe)
        end
        if recipe.placer == nil then
            return "fail", tostring(key) .. " 不是要摆出来的东西，用 craft 就行"
        end
        local builder = p.components.builder
        if builder == nil then return "fail", "你现在不能建造" end
        local ok, knows = pcall(function() return builder:KnowsRecipe(recipe) end)
        if ok and knows == false then
            return "fail", string.format("%s 还不会做（要先解锁）", key)
        end
        local missing = missing_ingredients(p, recipe)
        if missing ~= nil then
            return "fail", string.format("%s %s", key, missing)
        end
        local tx = tonumber(j.args.x)
        local tz = tonumber(j.args.z)
        if tx == nil or tz == nil then
            local fx, fz = find_spot(p, recipe)
            if fx == nil then
                return "fail", "附近找不到能放下 " .. key .. " 的地方（被东西占了？）"
            end
            tx, tz = fx, fz
        end
        j.data.recipe, j.data.key = recipe, key
        j.data.tx, j.data.tz = tx, tz
        j.step = "goto"
    end
    if j.step == "goto" then
        local away = tile_away(p, j.data.tx, j.data.tz)
        if away > 2.5 then
            walk_to(p, j.data.tx, j.data.tz)
            if U.now() - j.t0 > 120 then return "fail", "走不到要摆的位置" end
            return "run"
        end
        j.step = "place"
        return "run"
    end
    if j.step == "place" then
        if busy(p) then
            if U.now() - j.t0 > 180 then return "fail", "摆东西卡住了" end
            return "run"
        end
        local x, z = U.tile_center(j.data.tx, j.data.tz)
        if not can_deploy(j.data.recipe, x, z) then
            return "fail", string.format("(%d,%d) 这块地放不下 %s", j.data.tx, j.data.tz, j.data.key)
        end
        local builder = p.components.builder
        local ok, started = pcall(function()
            return builder:MakeRecipe(j.data.recipe, Vector3(x, 0, z), 0, nil)
        end)
        if not ok or started ~= true then
            return "fail", "摆放没成功（材料不够？）"
        end
        j.step = "acting"
        j.data.phase_start = U.now()
        return "run"
    end
    if busy(p) and U.now() - j.data.phase_start < 60 then return "run" end
    return "done", string.format("在 (%d,%d) 摆了 %s", j.data.tx, j.data.tz, j.data.key)
end
JOBS.build = job_build

JOBS.make_fire = function(j, p)
    j.args = j.args or {}
    if j.args.recipe == nil then j.args.recipe = "campfire" end
    local status, text = job_build(j, p)
    if status == "done" then
        local fire = U.find_nearest(p, 4, nil, nil, function(e) return e:HasTag("fire") end)
        if fire == nil then return "fail", "摆了但火没生起来（位置不合适？）" end
        return "done", text .. "，火已经生起来了"
    end
    return status, text
end
JOBS.equip = function(j, p)
    local want = j.args.item
    if want == nil or want == "" then return "fail", "equip 要传 item（要拿在手里的东西）" end
    local item = U.find_item(p, want)
    if item == nil then return "fail", "背包里没有 " .. tostring(want) end
    local inv = p.components.inventory
    if inv == nil then return "fail", "没有背包" end
    local ok, err = pcall(function() inv:Equip(item) end)
    if not ok then return "fail", "装备不上：" .. tostring(err) end
    return "done", "把 " .. U.describe_item(item) .. " 拿在手里了"
end

JOBS.drop = function(j, p)
    local want = j.args.item
    if want == nil or want == "" then return "fail", "drop 要传 item" end
    local item = U.find_item(p, want)
    if item == nil then return "fail", "背包里没有 " .. tostring(want) end
    local inv = p.components.inventory
    if inv == nil then return "fail", "没有背包" end
    local count = tonumber(j.args.count)
    local ok, err = pcall(function()
        if count ~= nil and count < U.count(item) and item.components.stackable ~= nil then
            inv:DropItem(item) -- 简单起见整摞丢掉
        else
            inv:DropItem(item)
        end
    end)
    if not ok then return "fail", "丢不出去：" .. tostring(err) end
    return "done", "丢掉了 " .. U.pretty(item) .. (count ~= nil and ("×" .. count) or "")
end

JOBS.sleep = function(j, p)
    if j.step == "start" then
        -- 优先用背包里的睡袋 / 帐篷
        local bag = nil
        local inv = p.components.inventory
        if inv ~= nil then
            inv:ForEachItem(function(item)
                if bag == nil and item.components.sleepingbag ~= nil then bag = item end
            end)
        end
        local target = nil
        if bag == nil then
            target = U.find_nearest(p, tonumber(j.args.radius) or 20, nil, nil, function(e)
                return e.components ~= nil and e.components.sleepingbag ~= nil
            end)
        end
        if bag == nil and target == nil then
            return "fail", "附近没有帐篷/睡袋（饥荒里没有“睡到天亮”这种通用办法：要有帐篷、睡袋或者床）"
        end
        if busy(p) then
            if U.now() - j.t0 > 30 then return "fail", "忙着，没睡成" end
            return "run"
        end
        j.data.name = bag ~= nil and U.pretty(bag) or U.pretty(target)
        push(p, BufferedAction(p, target, ACTIONS.SLEEPIN, bag))
        j.data.phase_start = U.now()
        j.data.slept = false
        j.step = "acting"
        return "run"
    end
    local sleeping = p.sg ~= nil and p.sg:HasStateTag("sleeping")
    if sleeping then
        j.data.slept = true
        -- 睡觉可能要好几分钟，别超时
        if U.now() - j.data.phase_start > 900 then return "fail", "睡了太久还没醒" end
        return "run"
    end
    if j.data.slept then
        return "done", "醒了（用 " .. j.data.name .. " 睡的）"
    end
    if U.now() - j.data.phase_start > 15 then
        return "fail", "没睡上（" .. j.data.name .. " 可能要两个人/晚上/耐久）"
    end
    return "run"
end

JOBS.say = function(j, p)
    local text = j.args.text
    if text == nil or text == "" then return "fail", "say 要传 text" end
    text = tostring(text)
    pcall(function() GLOBAL.TheNet:Announce(text) end)
    if p.components.talker ~= nil then
        pcall(function() p.components.talker:Say(text, 3) end)
    end
    return "done", "说了：" .. text
end

JOBS.wait = function(j, p)
    local seconds = tonumber(j.args.seconds) or 3
    if j.step == "start" then
        j.step = "acting"
        j.data.until_time = U.now() + seconds
    end
    if U.now() >= j.data.until_time then
        return "done", string.format("等了 %.0f 秒", seconds)
    end
    return "run"
end

-- ─────────────────── Phase M1：续火 / 回血 ───────────────────
-- 这两件事是"活过第 10 天"的底线：火灭了查理来打，血见底了没处回。

--- 背包里最适合当柴烧的东西（优先燃料值高的，尽量不烧吃的）
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

JOBS.add_fuel = function(j, p)
    if j.step == "start" then
        local fire = U.find_nearest(p, tonumber(j.args.radius) or 12, { "fire" }, nil, function(e)
            local fueled = e.components ~= nil and e.components.fueled or nil
            return fueled ~= nil and not fueled:IsEmpty()
        end)
        if fire == nil then
            return "fail", "附近没有烧着的火堆（营火/火坑）—— 火灭了要先重新生火"
        end
        local fuel = best_fuel(p, j.args.item)
        if fuel == nil then
            return "fail", j.args.item ~= nil and ("背包里没有 " .. tostring(j.args.item))
                or "背包里没有能烧的东西（木头/树枝/草/木炭）"
        end
        if busy(p) then
            if U.now() - j.t0 > 20 then return "fail", "手上忙着，没添上柴" end
            return "run"
        end
        local fueled = fire.components.fueled
        local before = fueled ~= nil and fueled:GetPercent() or nil
        j.data.name = U.pretty(fuel)
        j.data.fire = fire
        j.data.before = before
        push(p, BufferedAction(p, fire, ACTIONS.ADDFUEL, fuel))
        j.data.phase_start = U.now()
        j.step = "acting"
        return "run"
    end
    if busy(p) and U.now() - j.data.phase_start < 20 then return "run" end
    local fueled = j.data.fire ~= nil and j.data.fire:IsValid() and j.data.fire.components.fueled or nil
    local after = fueled ~= nil and fueled:GetPercent() or nil
    if after ~= nil and j.data.before ~= nil then
        return "done", string.format("往火里添了 %s，燃料 %d%% → %d%%",
            j.data.name, math.floor(j.data.before * 100), math.floor(after * 100))
    end
    return "done", "添了 " .. j.data.name .. "（火盆可能已经灭了）"
end

JOBS.heal = function(j, p)
    if j.step == "start" then
        local hp = p.components.health
        if hp == nil then return "fail", "现在没有生命数据" end
        if hp:IsDead() then return "fail", "已经死了，吃东西救不回来" end

        local item = nil
        if j.args.item ~= nil and j.args.item ~= "" then
            item = U.find_item(p, j.args.item)
            if item == nil then return "fail", "背包里没有 " .. tostring(j.args.item) end
        else
            -- 优先治疗类（药膏/蜘蛛腺体/蜂蜜药膏），没有就吃东西回血
            local inv = p.components.inventory
            if inv ~= nil then
                inv:ForEachItem(function(it)
                    if item == nil and it.components.healer ~= nil then item = it end
                end)
            end
            if item == nil then item = best_food(p) end
            if item == nil then return "fail", "背包里没有能回血的东西（治疗药膏/蜘蛛腺体/吃的）" end
        end
        if busy(p) then
            if U.now() - j.t0 > 20 then return "fail", "手上忙着，没吃上药" end
            return "run"
        end
        j.data.item = item
        j.data.name = U.pretty(item)
        j.data.before = hp.currenthealth
        if item.components.healer ~= nil then
            push(p, BufferedAction(p, p, ACTIONS.HEAL, item))
        else
            push(p, BufferedAction(p, nil, ACTIONS.EAT, item))
        end
        j.data.phase_start = U.now()
        j.step = "acting"
        return "run"
    end
    if busy(p) and U.now() - j.data.phase_start < 20 then return "run" end
    local hp = p.components.health
    local now = hp ~= nil and hp.currenthealth or nil
    if now ~= nil and j.data.before ~= nil and now - j.data.before > 0.5 then
        return "done", string.format("用了 %s，生命 %d → %d", j.data.name,
            math.floor(j.data.before), math.floor(now))
    end
    return "done", "用了 " .. j.data.name .. "（血量没明显变化）"
end

-- ─────────────────── M1.5：把接口尽量交还给 AI ───────────────────
-- 设计原则（玩家定的方向）：**接口全暴露，AI 看状态自己决定调哪个**。
-- 所以这里不是"多写几个专用动作"，而是：
--   act            —— 泛化派发：游戏 ACTIONS 表里的任意动作，指定 target/item/坐标就能做
--   list_actions   —— 列出当前版本游戏真正有的动作名（模型不用猜）
--   list_recipes   —— 列出"现在能做什么/缺什么"（不用猜配方名）
--   store / take   —— 容器存取（背包只有 15 格，这是硬需求）
--   harvest        —— 锅/晾肉架出锅（现在料放进去拿不出来）

--- 找到附近符合条件的容器（箱子/冰箱/背包这类）
local function find_container(p, radius, want)
    return U.find_nearest(p, radius or 10, nil, nil, function(e)
        local c = e.components ~= nil and e.components.container or nil
        if c == nil or e:HasTag("burnt") then return false end
        if want ~= nil and want ~= "" then
            local prefab = string.lower(tostring(e.prefab or ""))
            if string.find(prefab, string.lower(want), 1, true) == nil then return false end
        end
        return true
    end)
end

JOBS.act = function(j, p)
    if j.step == "start" then
        local want = string.upper(tostring(j.args.action or ""))
        local action = GLOBAL.ACTIONS[want]
        if action == nil then
            local near = {}
            for k in pairs(GLOBAL.ACTIONS) do
                if type(k) == "string" and (want == "" or string.find(k, want, 1, true) ~= nil) then
                    near[#near + 1] = k
                end
            end
            table.sort(near)
            return "fail", string.format("游戏里没有叫 %s 的动作。相近的：%s（用 list_actions 看全部）",
                tostring(j.args.action), #near > 0 and table.concat(near, "、", 1, math.min(#near, 12)) or "（没有相近的）")
        end

        local target, pos = nil, nil
        if j.args.x ~= nil and j.args.z ~= nil then
            local cx, cz = U.tile_center(tonumber(j.args.x), tonumber(j.args.z))
            pos = Vector3(cx, 0, cz)
        elseif j.args.target ~= nil and j.args.target ~= "" then
            local list = find_by_name(p, tonumber(j.args.radius) or 20, j.args.target)
            if #list == 0 then return "fail", string.format("附近没有 %s", tostring(j.args.target)) end
            target = list[1].ent
        end

        local item = nil
        if j.args.item ~= nil and j.args.item ~= "" then
            item = U.find_item(p, j.args.item)
            if item == nil then return "fail", "背包里没有 " .. tostring(j.args.item) end
        end

        if busy(p) then
            if U.now() - j.t0 > 20 then return "fail", "手上还忙着，这个动作没开始" end
            return "run"
        end

        j.data.label = want
        j.data.target_name = target ~= nil and U.pretty(target) or nil
        push(p, BufferedAction(p, target, action, item, pos))
        j.data.phase_start = U.now()
        j.step = "acting"
        return "run"
    end

    if busy(p) then
        if U.now() - j.data.phase_start > 60 then return "fail", "这个动作做了 60 秒还没结束" end
        return "run"
    end
    local where = j.data.target_name ~= nil and ("（" .. j.data.target_name .. "）") or ""
    return "done", "做了 " .. tostring(j.data.label) .. where
end

JOBS.list_actions = function(j, p)
    local want = j.args ~= nil and string.upper(tostring(j.args.filter or "")) or ""
    local names = {}
    for k, v in pairs(GLOBAL.ACTIONS) do
        if type(k) == "string" and v ~= nil and (want == "" or string.find(k, want, 1, true) ~= nil) then
            names[#names + 1] = k
        end
    end
    table.sort(names)
    if #names == 0 then
        return "done", "没有匹配 «" .. tostring(j.args.filter) .. "» 的动作"
    end
    return "done", string.format("游戏里有 %d 个动作：\n%s\n（做的时候用 act {\"action\":\"名字\", \"target\":\"东西名或坐标\", \"item\":\"背包里的东西\"}）",
        #names, table.concat(names, " "))
end

JOBS.list_recipes = function(j, p)
    local builder = p.components.builder
    if builder == nil then return "fail", "现在不能制作东西" end
    local only_craftable = j.args.craftable_only == true
    local limit = tonumber(j.args.limit) or 40
    local craftable, known = {}, 0
    for name, recipe in pairs(GLOBAL.AllRecipes or {}) do
        if type(name) == "string" and recipe ~= nil then
            local ok, knows = pcall(function() return builder:KnowsRecipe(recipe) end)
            if ok and knows then
                known = known + 1
                local ok2, has = pcall(function() return builder:HasIngredients(recipe) end)
                local can = ok2 and has == true
                if can then
                    local parts = {}
                    for _, ing in ipairs(recipe.ingredients or {}) do
                        parts[#parts + 1] = string.format("%s×%d", tostring(ing.type), tonumber(ing.amount) or 1)
                    end
                    craftable[#craftable + 1] = string.format("%s（%s）", name, table.concat(parts, " "))
                end
            end
        end
    end
    table.sort(craftable)
    if only_craftable then
        if #craftable == 0 then return "done", "现在材料不够，什么都做不了" end
        return "done", string.format("现在材料够、能做的（共 %d 个）：\n%s", #craftable,
            table.concat(craftable, "\n", 1, math.min(#craftable, limit)))
    end
    local head = string.format("你已解锁 %d 个配方，其中现在材料就够的有 %d 个：", known, #craftable)
    return "done", head .. "\n" .. (#craftable > 0 and table.concat(craftable, "\n", 1, math.min(#craftable, limit)) or "（暂无）")
end

JOBS.store = function(j, p)
    local item = U.find_item(p, j.args.item)
    if item == nil then return "fail", "背包里没有 " .. tostring(j.args.item or "?") end
    local chest = find_container(p, tonumber(j.args.radius) or 10, j.args.container)
    if chest == nil then return "fail", "附近没有箱子/冰箱这类容器" end
    local container = chest.components.container
    local ok = pcall(function()
        if item.components.inventoryitem ~= nil then
            item.components.inventoryitem:RemoveFromOwner()
        end
        container:GiveItem(item, nil, p:GetPosition())
    end)
    if not ok then return "fail", "放不进 " .. U.pretty(chest) end
    return "done", string.format("把 %s 放进 %s 了", U.pretty(item), U.pretty(chest))
end

JOBS.take = function(j, p)
    local chest = find_container(p, tonumber(j.args.radius) or 10, j.args.container)
    if chest == nil then return "fail", "附近没有箱子/冰箱这类容器" end
    local container = chest.components.container
    local want = j.args.item
    local found = nil
    local slots = 0
    pcall(function() slots = container:GetNumSlots() end)
    for slot = 1, math.max(slots, 1) do
        local it = container:GetItemInSlot(slot)
        if it ~= nil then
            if want == nil or want == "" then
                found = it
                break
            end
            local prefab = string.lower(tostring(it.prefab or ""))
            if string.find(prefab, string.lower(tostring(want)), 1, true) ~= nil then
                found = it
                break
            end
        end
    end
    if found == nil then
        return "fail", string.format("%s 里没有 %s", U.pretty(chest), want ~= nil and tostring(want) or "东西")
    end
    local name = U.pretty(found)
    pcall(function()
        container:RemoveItem(found, true)
        p.components.inventory:GiveItem(found, nil, p:GetPosition())
    end)
    return "done", string.format("从 %s 里拿出 %s", U.pretty(chest), name)
end

--- 出锅 / 收割：锅（stewer）煮熟了要拿出来，晾肉架靠 harvestable
JOBS.harvest = function(j, p)
    local want = j.args.target
    local thing = U.find_nearest(p, tonumber(j.args.radius) or 12, nil, nil, function(e)
        if want ~= nil and want ~= "" then
            local prefab = string.lower(tostring(e.prefab or ""))
            if string.find(prefab, string.lower(tostring(want)), 1, true) == nil then return false end
        end
        if e.components ~= nil and e.components.stewer ~= nil then return true end
        if e.components ~= nil and e.components.harvestable ~= nil then
            local ok, can = pcall(function() return e.components.harvestable:CanBeHarvested() end)
            return ok and can == true
        end
        return false
    end)
    if thing == nil then return "fail", "附近没有能出锅/收割的东西（锅熟了？晾肉架干了？）" end

    local stewer = thing.components.stewer
    if stewer ~= nil then
        local done_ok, is_done = pcall(function() return stewer:IsDone() end)
        local cooking = false
        pcall(function() cooking = stewer:IsCooking() end)
        if done_ok and not is_done then
            if cooking then
                local left = 0
                pcall(function() left = stewer:GetTimeToCook() end)
                return "fail", string.format("%s 还在煮，大概还要 %d 秒", U.pretty(thing), math.floor(left or 0))
            end
            return "fail", U.pretty(thing) .. " 是空的，先往里放食材（用 act {\"action\":\"COOK\", \"target\":\"cookpot\", \"item\":\"…\"}）"
        end
        local ok2 = pcall(function() stewer:Harvest() end)
        if not ok2 then return "fail", "出锅失败（可能锅被烧了）" end
        return "done", "从 " .. U.pretty(thing) .. " 里把做好的菜拿出来了"
    end

    if busy(p) then
        if U.now() - j.t0 > 20 then return "fail", "手不空，没收割成" end
        return "run"
    end
    push(p, BufferedAction(p, thing, ACTIONS.HARVEST, nil))
    j.data.phase_start = U.now()
    return "done", "收割了 " .. U.pretty(thing)
end

JOBS.stop = function(j, p)
    if p ~= nil then
        client_stop(p)
        pcall(function()
            if p.components.locomotor ~= nil then p.components.locomotor:Stop() end
            p:ClearBufferedAction()
        end)
    end
    return "done", "停下了"
end

-- ─────────────────────────── 对外 ───────────────────────────

--- 给宏（macros.lua）用：注册动作、推进子动作、数背包
function A.register(name, fn)
    JOBS[name] = fn
end

A.find_by_name = find_by_name
A.push = push
A.best_tool = best_tool
A.best_food = best_food
A.best_fuel = best_fuel
A.find_container = find_container
A.recipe_of = recipe_of

--- 背包里某样东西有几个（prefab 模糊匹配）
function A.count_item(p, prefab)
    if p == nil or prefab == nil then return 0 end
    local inv = p.components.inventory
    if inv == nil then return 0 end
    local want = string.lower(tostring(prefab))
    local total = 0
    inv:ForEachItem(function(item)
        local name = string.lower(tostring(item.prefab or ""))
        if string.find(name, want, 1, true) ~= nil then
            total = total + U.count(item)
        end
    end)
    return total
end

--- 同步推进一个子动作，直到它结束（宏在上面套循环）
--- m 是一个"伪 job"表：{ sub = nil } 由调用方持有
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

-- ── 结果校验：背包净变化 ──
-- 只回"干了 N 下"没有用：模型不知道到底拿到了什么，就会开始编造（phase5 的 M7 就是被这条坑到的）。
-- 每个动作开始前拍一张背包快照，成功结束时把差值附在后面："（背包：log+4）"。

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

function A.Start(name, args, cmd_id, ctx)
    local fn = JOBS[name]
    if fn == nil then
        local known = {}
        for k in pairs(JOBS) do known[#known + 1] = k end
        table.sort(known)
        return false, "没有这个动作：" .. tostring(name) .. "（能用的：" .. table.concat(known, "、") .. "）"
    end
    local p = U.player()
    if p == nil then return false, "现在没有玩家（游戏可能还在读档）" end
    if job ~= nil then
        -- 旧动作还在跑：先停掉，把上一个的结果交代清楚，别让外面一直等。
        -- 真机 bug（2026-11-12）：这里原来用的是 last_cmd_id —— 而 last_cmd_id 已经是"新指令"的 id，
        -- 于是新指令立刻收到一句"被新指令打断了（上一件事没做完）"当成自己的结果，
        -- 真正做完的结果反而没人等（实测：pickup 报失败、但木头确实进了背包）。
        local prev_id = job.cmd_id
        pcall(function()
            if p.components.locomotor ~= nil then p.components.locomotor:Stop() end
            p:ClearBufferedAction()
        end)
        Whale.bridge.Report(false, "被新指令打断了（上一件事没做完）", prev_id)
    end
    job = {
        name = name,
        args = args or {},
        cmd_id = cmd_id,
        step = "start",
        data = {},
        -- M2.1：pickup 这类"目标已由 guard 解析好"的动作，通过 ctx 传真实实体，
        -- 不允许执行函数自己按 prefab 去搜目标。
        ctx = ctx or {},
        t0 = U.now(),
    }
    -- 动作开始前拍背包快照（结束时用来算净变化）
    job.data.inv_before = snapshot_counts(p)
    Whale.job = job
    return true, nil
end

function A.Abort(reason)
    if job ~= nil and Whale.actions ~= nil then
        local p = U.player()
        if p ~= nil then
            pcall(function()
                if p.components.locomotor ~= nil then p.components.locomotor:Stop() end
                p:ClearBufferedAction()
            end)
        end
        Whale.bridge.Report(false, tostring(reason or "被打断了"), job.cmd_id)
        client_stop(U.player())
        job = nil
        Whale.job = nil
    end
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

--- 客户端走路心跳：人物在走的时候，隔一会儿把"现在要去哪"再告诉客户端一次。
--- 客户端的路径可能和服务端不完全一样（先到、绕开、或者被预测打断），
--- 一旦客户端先停下，而服务端还在走，画面又变回滑行 —— 重发一次就同步了。
local walk_rpc_tick = 0
function A.refresh_client_walk(force)
    -- 只对"纯走路"的任务补发：动作（砍/挖/捡/打）让引擎走过去的那一段**不能**发，
    -- 否则客户端和服务端各有一份移动意图，会互相拽（真机踩到 chop 报"推不动"）。
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
    -- server_tick 是 0.2 秒一次，每 5 次≈1 秒重发一次
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

Whale = Whale or {}
Whale.actions = A
