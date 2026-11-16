-- 采集与工作动作：pickup, harvest, gather, gather_area, chop, mine, dig, hammer, pick
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall or pcall
local tonumber = GLOBAL.tonumber or tonumber
local tostring = tostring or (GLOBAL and GLOBAL.tostring)

local ACTIONS = GLOBAL.ACTIONS
local EQUIPSLOTS = GLOBAL.EQUIPSLOTS
local Vector3 = GLOBAL.Vector3
local BufferedAction = GLOBAL.BufferedAction

local U = Whale.util

Whale = Whale or {}
Whale.actions = Whale.actions or {}
local A = Whale.actions
A.JOBS = A.JOBS or {}
local JOBS = A.JOBS

local busy = A.busy
local stop_actions = A.stop_actions
local push = A.push
local tile_away = A.tile_away
local walk_to = A.walk_to
local equip_if_needed = A.equip_if_needed
local best_tool = A.best_tool
local hold_control = A.hold_control
local find_workable = A.find_workable
local find_by_name = A.find_by_name
local being_attacked = A.being_attacked
local snapshot_counts = A.snapshot_counts
local WORK_NAMES = A.WORK_NAMES

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

--- 必须排在"已持有"判定**之后**，否则成功也会被误报成 in_limbo。
local function pickup_by_ref(j, p, target)
    local inv = p.components.inventory
    if inv == nil then return "fail", "missing_component:inventory" end

    --- 目标是否已经在玩家身上（背包/装备槽/容器都算）
    local function owned_by_player()
        if target == nil then return false end
        local okp, parent = pcall(function() return target:GetParent() end)
        if okp and parent == p then return true end
        local oki, owner = pcall(function()
            if target.components == nil or target.components.inventoryitem == nil then return nil end
            return target.components.inventoryitem.owner
        end)
        return oki and owner == p
    end

    if j.step == "start" then
        if target == nil or not target:IsValid() then
            return "fail", "entity_gone: 目标已经不存在了"
        end
        if target:IsInLimbo() then
            return "fail", "in_limbo: 目标进入了 limbo"
        end
        j.data.target = target
        j.data.prefab = tostring(target.prefab or "?")
        j.data.label = U.pretty(target)
        j.data.before = snapshot_counts(p)
        j.data.phase_start = U.now()
        push(p, BufferedAction(p, target, ACTIONS.PICKUP, nil))
        j.step = "acting"
        return "run"
    end

    if j.step == "acting" then
        -- ① 先看归属（捡起后物品会在 limbo 里，但 owner/parent 已经是玩家）
        if owned_by_player() then
            return "done", string.format("捡起了 %s", j.data.label or j.data.prefab)
        end
        -- ② 堆叠合并：目标被销毁 + 背包该 prefab 总量增加
        local alive = target ~= nil and target:IsValid()
        local after = snapshot_counts(p)
        local gained = (after[j.data.prefab] or 0) - (j.data.before[j.data.prefab] or 0)
        if not alive and gained > 0 then
            return "done", string.format("捡起了 %s（合并进已有的那一堆）", j.data.prefab)
        end
        if U.now() - j.data.phase_start > 6 then
            if not alive then
                return "fail", "result_unverified: 目标消失了，但背包里没见到对应物品"
            end
            if target:IsInLimbo() then
                return "fail", "in_limbo: 目标被别人收走了"
            end
            return "fail", "pickup_failed: 目标还在地上（够不着，或背包满了）"
        end
        return "run"
    end
    return "run"
end

--- M2.3：按 #N 引用收获**已解析好的**试点对象（本阶段 = 成熟浆果丛）。
--- 原生动作是 ACTIONS.PICK（依据：scripts/actions.lua:366 + componentactions 的 pickable 处理器）。
---
--- 成功判据（不只看 fn 返回值 —— 原生的 Pick 在成功时会把 canbepicked 翻成 false）：
---   ① 执行前 canbepicked == true 且执行后 == false ⇒ 真的采到了；
---   ② 产物可能直接进背包（普通浆果丛），也可能掉在地上（背包满时 GiveItem 会 DropItem），
---      所以回执必须区分"已入包"和"已收获但产物落地"。
local function harvest_by_ref(j, p, target)
    if target == nil or not target:IsValid() then
        return "fail", "entity_gone: 目标已经不存在了"
    end
    local pickable = target.components ~= nil and target.components.pickable or nil
    if pickable == nil then
        return "fail", "target_not_harvestable: 目标没有 pickable 组件"
    end

    if j.step == "start" then
        if target:IsInLimbo() then
            return "fail", "in_limbo: 目标进入了 limbo"
        end
        local ok_ready, ready = pcall(function() return pickable:CanBePicked() end)
        if not ok_ready or ready ~= true then
            return "fail", "not_ready: 目标当前不可采"
        end
        local rules = Whale ~= nil and Whale.harvestrules or nil
        j.data.target = target
        j.data.prefab = tostring(target.prefab or "?")
        j.data.label = U.pretty(target)
        j.data.product = rules ~= nil and rules.ProductOf(target) or nil
        j.data.before = snapshot_counts(p)
        j.data.phase_start = U.now()
        push(p, BufferedAction(p, target, ACTIONS.PICK, nil))
        j.step = "acting"
        return "run"
    end

    if j.step == "acting" then
        local alive = target:IsValid()
        local ok_can, can = pcall(function() return pickable:CanBePicked() end)
        local flipped = (ok_can and can == false)

        if flipped or not alive then
            local after = snapshot_counts(p)
            local product = j.data.product
            local gained = 0
            if product ~= nil then
                gained = (after[product] or 0) - (j.data.before[product] or 0)
            end
            if gained > 0 then
                return "done", string.format("采下了 %s（%s+%d）", j.data.label or j.data.prefab, product, gained)
            end
            -- 收获确实发生了，但产物没进背包：要么背包满被丢回地面，要么本来就会落地
            local where = product ~= nil and string.format("（%s 没进背包，应该掉在地上了）", product) or "（产物没进背包）"
            return "done", string.format("采下了 %s%s", j.data.label or j.data.prefab, where)
        end

        if U.now() - j.data.phase_start > 6 then
            return "fail", "harvest_failed: 目标状态没有变化（可能够不着，或已经不可采）"
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

local function gather_by_ref(j, p, target)
    if target == nil or not target:IsValid() then
        return "fail", "entity_gone: 目标已经不存在了"
    end
    local rules = Whale ~= nil and Whale.gatherrules or nil
    if rules == nil then return "fail", "gather_rules_missing" end

    local pickable = target.components ~= nil and target.components.pickable or nil
    if pickable == nil then
        return "fail", "target_not_gatherable: 目标没有 pickable 组件"
    end

    if j.step == "start" then
        if target:IsInLimbo() then return "fail", "in_limbo: 目标进入了 limbo" end
        -- ★ 授权那一刻重新判一次成熟度（Candidate != Ready）
        local ok_ready, why_ready = rules.IsReady(target)
        if not ok_ready then
            return "fail", (why_ready or "not_ready") .. ": 目标当前不能采"
        end
        j.data.target = target
        j.data.prefab = tostring(target.prefab or "?")
        j.data.label = U.pretty(target)
        j.data.product = rules.ProductOf(target)
        j.data.before = snapshot_counts(p)
        j.data.phase_start = U.now()
        push(p, BufferedAction(p, target, ACTIONS.PICK, nil))
        j.step = "acting"
        return "run"
    end

    if j.step == "acting" then
        local alive = target:IsValid()
        local ok_can, can = pcall(function() return pickable:CanBePicked() end)
        local flipped = (ok_can and can == false)

        if flipped or not alive then
            local after = snapshot_counts(p)
            local product = j.data.product
            local gained = 0
            if product ~= nil then
                gained = (after[product] or 0) - (j.data.before[product] or 0)
            end
            local label = rules.PRODUCT_LABELS[product] or product or "产物"
            if gained > 0 then
                return "done", string.format("采了 %s（%s+%d，%s）", j.data.label or j.data.prefab, product, gained, label)
            end
            return "done", string.format("采了 %s（%s 没进背包，可能掉在地上了）", j.data.label or j.data.prefab, product or "产物")
        end

        if U.now() - j.data.phase_start > 6 then
            return "fail", "gather_failed: 目标状态没有变化（可能够不着，或已经不可采）"
        end
        return "run"
    end
    return "run"
end

JOBS.gather = function(j, p)
    local ctx = j.ctx or {}
    if ctx.target ~= nil then return gather_by_ref(j, p, ctx.target) end
    return "fail", "gather 只能按 #N 引用调用（不支持按名字搜索）"
end

--- 在半径内找一类可采目标（按距离排序），只返回**白名单内**的
local function gather_candidates(p, radius_tiles, want_prefab)
    local gr = Whale ~= nil and Whale.gatherrules or nil
    local hr = Whale ~= nil and Whale.harvestrules or nil
    if gr == nil and hr == nil then return {} end
    local out = {}
    local seen = {}
    local list = U.find_all(p, radius_tiles, nil, nil, function(e)
        if e == nil or e == p then return false end
        if e.prefab == nil then return false end
        -- 草/树苗走 gatherrules；浆果丛走 harvestrules
        local is_gather = gr ~= nil and gr.IsCandidate(e, p)
        local is_harvest = (not is_gather) and hr ~= nil and hr.IsCandidate(e, p)
        if not is_gather and not is_harvest then return false end
        if want_prefab ~= nil and tostring(e.prefab) ~= want_prefab then return false end
        return true
    end)
    for _, entry in ipairs(list or {}) do
        local e = entry.ent or entry
        if e ~= nil and e:IsValid() and not seen[e] then
            seen[e] = true
            local rules = (gr ~= nil and gr.IsCandidate(e, p)) and gr or hr
            local ready, why = rules.IsReady(e)
            out[#out + 1] = {
                ent = e,
                ready = ready == true,
                why = why,
                dist = U.dist(p, e),
                product = rules.ProductOf and rules.ProductOf(e) or nil,
                use_gather = (rules == gr),
            }
        end
    end
    table.sort(out, function(a, b) return (a.dist or 999) < (b.dist or 999) end)
    return out
end

--- 采完/找完的收尾文案
local function area_summary(done, product_counts, failed)
    local bits = {}
    local keys = {}
    for k in pairs(product_counts or {}) do keys[#keys + 1] = k end
    table.sort(keys)
    for _, k in ipairs(keys) do bits[#bits + 1] = string.format("%s+%d", k, product_counts[k]) end
    local tail = #bits > 0 and ("（" .. table.concat(bits, "，") .. "）") or ""
    local fail_tail = (failed or 0) > 0 and string.format("，%d 个没采成", failed) or ""
    return string.format("采了 %d 个%s%s", done or 0, tail, fail_tail)
end

-- 到附近后交给原生 PushAction 按目标碰撞半径接近并采摘。
local APPROACH_TILES = 1.6
local APPROACH_UNITS = APPROACH_TILES * 4   -- 1 格 = 4 世界单位

local function gather_busy(p)
    if p:GetBufferedAction() ~= nil then return true end
    local loco = p.components.locomotor
    if loco ~= nil and loco.bufferedaction ~= nil then return true end
    -- 普通行走没有 idle 标签，但可以被原生 PICK 接管；真正忙碌的动作仍需等待。
    return p.sg ~= nil and not p.sg:HasStateTag("idle")
        and (p.sg:HasStateTag("busy") or not p.sg:HasStateTag("moving"))
end

--- 范围采集：一次采完半径内能采的（可选只采某一种）
JOBS.gather_area = function(j, p)
    local ctx = j.ctx or {}
    if ctx.survival_area ~= true then
        return "fail", "gather_area 只能按白名单调用"
    end
    if j.step == "start" then
        -- 默认范围/数量都收小：真机里"半径 12 + 30 个"会变成 5 分钟的原地采集，
        -- 期间被青蛙围住也不停。宁可多调几次，也别把一轮动作拖成一条命。
        j.data.radius = tonumber(ctx.radius) or 8
        j.data.limit = math.min(tonumber(ctx.limit) or 8, 30)   -- 硬上限，别让它无限跑
        j.data.want = ctx.prefab ~= nil and tostring(ctx.prefab) or nil
        j.data.done = {}
        j.data.count = 0
        j.data.failed = 0
        j.data.products = {}
        j.data.before = snapshot_counts(p)
        j.data.t0 = U.now()
        -- 内部预算：外层给多少就用多少（再留 5 秒自己收尾）。没给就保守取 45 秒。
        j.data.budget = math.max(10, (tonumber(ctx.budget_s) or 50) - 5)
        j.step = "next"
    end

    -- ★ 两个"立刻停"的出口必须放在所有 step 之前：
    --   · 时间到：旧版只在 next 检查，卡在 walking/acting 时会一直跑
    --   · 被怪打：采集中被青蛙咬，不能还站着把这一片采完
    if j.step ~= "start" then
        if U.now() - (j.data.t0 or U.now()) > (j.data.budget or 45) then
            local text = area_summary(j.data.count or 0, j.data.products, j.data.failed) .. "（时间到，先停）"
            if (j.data.count or 0) == 0 then return "fail", "gather_area_failed: " .. text end
            return "done", text
        end
        if j.data.attack_check == nil or U.now() - j.data.attack_check > 1 then
            j.data.attack_check = U.now()
            if being_attacked(p, 3) then
                return "fail", "有怪在打我，先停下：用 get_state 看敌人在哪，先 move_to 离开，别继续采"
            end
        end
    end

    if j.step == "next" then
        if j.data.count >= j.data.limit then
            return "done", area_summary(j.data.count, j.data.products, j.data.failed)
        end
        if U.now() - j.data.t0 > (j.data.budget or 45) then
            local text = area_summary(j.data.count, j.data.products, j.data.failed) .. "（时间到，先停）"
            if j.data.count == 0 then return "fail", "gather_area_failed: " .. text end
            return "done", text
        end
        -- 每次重新找最近的**还没试过**的（跳过失败的，避免死循环）
        local cands = gather_candidates(p, j.data.radius, j.data.want)
        local pick = nil
        for _, c in ipairs(cands) do
            if j.data.done[c.ent] == nil and c.ready then pick = c break end
        end
        if pick == nil then
            local left = 0
            for _, c in ipairs(cands) do if j.data.done[c.ent] == nil then left = left + 1 end end
            local tail = left > 0 and string.format("（还有 %d 个没成熟/够不着）", left) or ""
            local text = area_summary(j.data.count, j.data.products, j.data.failed) .. tail
            if j.data.count == 0 then
                -- 一个都没采到 → 明确的失败，而且**要把"下一步该怎么办"讲清楚**。
                -- 真机教训：附近浆果丛被采空后，模型只看到"采了 0 个"就反复换小半径重试，
                -- 表现成"采集不了浆果"。所以要告诉它：最近能采的多远、建议半径多大。
                local notes = {}
                for _, c in ipairs(cands) do
                    if c.why ~= nil and c.why ~= "" then notes[c.why] = (notes[c.why] or 0) + 1 end
                end
                local reasons = {}
                for why, n in pairs(notes) do reasons[#reasons + 1] = string.format("%s×%d", why, n) end
                table.sort(reasons)
                local why_text = #reasons > 0 and ("；原因：" .. table.concat(reasons, "，")) or ""

                -- 往更大一圈找"现在就能采"的（任何白名单种类），给出最近的那个和建议半径
                local look = math.min(40, math.max((j.data.radius or 8) * 2, (j.data.radius or 8) + 8))
                local wide = gather_candidates(p, look, j.data.want)
                local nearest, nearest_kind, want_ready = nil, nil, nil
                for _, c in ipairs(wide) do
                    if c.ready and j.data.done[c.ent] == nil then
                        if nearest == nil then
                            nearest = (c.dist or 0) / 4
                            nearest_kind = tostring(c.ent.prefab)
                        end
                        if j.data.want ~= nil and tostring(c.ent.prefab) == j.data.want then
                            want_ready = (c.dist or 0) / 4
                            break
                        end
                    end
                end
                local hint
                if j.data.want ~= nil and want_ready ~= nil then
                    hint = string.format("最近的 %s 在 %.1f 格，把 radius 调到 %d 再试",
                        j.data.want, want_ready, math.ceil(want_ready) + 2)
                elseif nearest ~= nil then
                    hint = string.format("范围内现在能采的是 %s（%.1f 格）——不挑种类的话把 radius 调到 %d；"
                        .. "只要 %s 就等它们长好，或者用 seek 出去找",
                        tostring(nearest_kind), nearest, math.ceil(nearest) + 2, tostring(j.data.want or "某一种"))
                elseif j.data.failed > 0 then
                    hint = "成熟目标走不到或采摘超时，已停止旧动作；用 get_state 检查位置和障碍，别只增大 radius 重试同一丛"
                else
                    hint = string.format("%d 格内现在没有能采的（都还没长好）——用 seek 出去找别的，或者等一会儿再来",
                        look)
                end
                return "fail", "gather_area_failed: " .. text .. why_text .. "。" .. hint
            end
            return "done", text
        end
        if gather_busy(p) then return "run" end
        local d = U.dist(p, pick.ent) or 99999
        if d > APPROACH_UNITS then
            local tx, ty, tz = pick.ent.Transform:GetWorldPosition()
            p.components.locomotor:GoToPoint(Vector3(tx, 0, tz))
            j.data.walking_to = pick.ent
            j.data.walk_start = U.now()
            j.data.walk_repush = U.now()
            j.step = "walking"
            return "run"
        end
        j.data.done[pick.ent] = true
        -- ★ 必须是**实体**，不是候选表 pick。
        --   真机 bug（Cluster_1）：写成 pick 之后，acting 阶段 cur:IsValid() 直接崩
        --   （"attempt to call method 'IsValid' (a nil value)"），而且只有"目标近、
        --   不走 walking 直接 acting"时才会踩到 —— 所以现象是"有的能采有的必崩"。
        j.data.current = pick.ent
        j.data.phase_start = U.now()
        j.data.pushes = 1
        push(p, BufferedAction(p, pick.ent, ACTIONS.PICK, nil))
        j.step = "acting"
        return "run"
    end

    if j.step == "walking" then
        local target = j.data.walking_to
        if target == nil or not target:IsValid() then
            stop_actions(p)
            j.step = "next"
            return "run"
        end
        local d = U.dist(p, target) or 99999
        -- ★ 超时判定必须放在 busy 早退**之前**。
        --   真机 bug：busy 恒为真时，每个 tick 都在下面那句 return run 掉头，
        --   永远走不到 12 秒超时 → 任务永不结束（真机那条 gather_area 排队 137 秒没回执）。
        if U.now() - j.data.walk_start > 12 then
            stop_actions(p)
            j.data.done[target] = true
            j.data.failed = j.data.failed + 1
            j.step = "next"
            return "run"
        end
        if gather_busy(p) then return "run" end
        if d <= APPROACH_UNITS then
            j.data.done[target] = true
            j.data.current = target
            j.data.phase_start = U.now()
            j.data.pushes = 1
            push(p, BufferedAction(p, target, ACTIONS.PICK, nil))
            j.step = "acting"
            return "run"
        end
        -- 每 0.6 秒重发一次目标点：GoToPoint 只下一次的话，被打断/走偏就再也不动了
        if U.now() - (j.data.walk_repush or 0) > 0.6 then
            local tx, ty, tz = target.Transform:GetWorldPosition()
            p.components.locomotor:GoToPoint(Vector3(tx, 0, tz))
            j.data.walk_repush = U.now()
        end
        return "run"
    end

    if j.step == "acting" then
        local cur = j.data.current
        -- 防御：current 必须是**实体**。真机踩过一次（把候选表塞进来 → 整个动作崩掉），
        -- 这里宁可跳过这个目标，也不让一条命令把模组打挂。
        if cur == nil or type(cur.IsValid) ~= "function" then
            j.step = "next"
            return "run"
        end
        local pickable = cur.components ~= nil and cur.components.pickable or nil
        local alive = cur:IsValid()
        local ok_can, can = pcall(function() return pickable ~= nil and pickable:CanBePicked() end)
        local flipped = (ok_can and can == false)
        if flipped or not alive then
            j.data.count = j.data.count + 1
            local after = snapshot_counts(p)
            local product = nil
            if cur ~= nil then
                local gr = Whale.gatherrules
                local hr = Whale.harvestrules
                product = (gr ~= nil and gr.ProductOf(cur)) or nil
                if product == nil and hr ~= nil and hr.ReadState ~= nil then
                    local st = hr.ReadState(cur)
                    product = st ~= nil and st.product or nil
                end
            end
            if product ~= nil then
                local gained = (after[product] or 0) - (j.data.before[product] or 0)
                if gained > 0 then
                    j.data.products[product] = (j.data.products[product] or 0) + gained
                    j.data.before[product] = after[product]
                end
            end
            j.step = "next"
            return "run"
        end
        -- 动作没在跑、东西却还能采 → 多半是刚才那下没推上去（离得远/被挡），重推几次
        local waited = U.now() - j.data.phase_start
        if not busy(p) and waited > 0.8 then
            if (j.data.pushes or 0) < 3 then
                j.data.pushes = (j.data.pushes or 0) + 1
                j.data.phase_start = U.now()
                push(p, BufferedAction(p, cur, ACTIONS.PICK, nil))
                return "run"
            end
            stop_actions(p)
            j.data.done[cur] = true
            j.data.failed = j.data.failed + 1
            j.step = "next"
            return "run"
        end
        if waited > 8 then
            stop_actions(p)
            j.data.done[cur] = true
            j.data.failed = j.data.failed + 1
            j.step = "next"
            return "run"
        end
        return "run"
    end
    return "run"
end

local WORK_ACTIONS = {
    chop = { action = "CHOP", verb = "砍", tool = "axe", tool_cn = "斧头" },
    mine = { action = "MINE", verb = "挖", tool = "pickaxe", tool_cn = "镐子" },
    dig = { action = "DIG", verb = "铲", tool = "shovel", tool_cn = "铲子" },
    hammer = { action = "HAMMER", verb = "拆", tool = "hammer", tool_cn = "锤子" },
}

--- 目标的 workable 是不是已经完成（挖碎/砍倒/拆掉）
---
--- ★ TARGET-REFRESH：这里必须**同时**看 workleft 和 workable.action。
---   真机踩到：树砍倒后 `workleft` 不一定变 0，而是**变成树桩** ——
---   `workable.action` 从 CHOP 变成 DIG。只看 workleft 会判"没砍完"，
---   于是树明明倒了、木头都掉在地上了，回执却报「推不动 常青树…」。
---   `job_work` 里一直是两个都看（见它的 done_this 判断），这里对齐。
local function work_done(ent, action_id)
    if ent == nil or not ent:IsValid() then return true end
    local workable = ent.components ~= nil and ent.components.workable or nil
    if workable == nil then return true end
    -- ① 动作换了（树 → 树桩：CHOP 变 DIG/MINE）就算干完了
    if action_id ~= nil then
        local ok_a, act = pcall(function() return workable.action end)
        if ok_a and act ~= nil and tostring(act.id) ~= tostring(action_id) then return true end
    end
    -- ② 剩余工作量归零
    local ok, left = pcall(function() return workable.workleft end)
    if ok and type(left) == "number" then return left <= 0 end
    return false
end

--- 干活之后"把脚边掉出来的产物捡起来"这一步（chop / mine 共用）。
---
--- 为什么单独抽出来：挖矿时岩石一碎实体就 `IsValid()=false`，
--- `work_by_ref` 开头那句"目标没了 → done"会**直接跳过捡东西** ——
--- 真机表现就是「挖了 岩石」但 rocks/flint/nitre 全躺在地上（用户看到的就是这个）。
--- 所以 loot 必须能在"目标已经失效"的情况下继续跑。
---
--- ★ 不要在这里加任何"等掉落动画"的延迟：`lootdropper:SpawnLootPrefab` 是
---   `SpawnPrefab(...)` **同步**生成，树倒那一刻产物就已经在地上了（查过 scripts.zip）。
---   这里唯一的等待来自引擎本身：一次只能演一个 PICKUP（`loco:PushAction` 会清掉上一个），
---   所以每 tick 推一个、捡到没有为止。
local function work_loot_step(j, p, def)
    local rules = Whale ~= nil and Whale.pickuprules or nil
    local picked_now = false
    if rules ~= nil then
        local list = U.find_all(p, 3, nil, nil, function(e)
            if e == nil or not e:IsValid() then return false end
            return rules.IsCandidate(e, p) == true
        end)
        for _, entry in ipairs(list or {}) do
            local e = entry.ent or entry
            if e ~= nil and e:IsValid() and not busy(p) then
                push(p, BufferedAction(p, e, ACTIONS.PICKUP, nil))
                j.data.looted[#j.data.looted + 1] = tostring(e.prefab or "?")
                picked_now = true
                j.data.loot_wait = U.now()
                break                       -- 一次捡一个（引擎限制），下一 tick 继续
            end
        end
    end
    -- 结算条件：这一 tick 没东西可捡了、而且人也不忙（手空了）→ 立刻收工。
    -- 时间上限只是兜底（背包满 / 够不着时别把一轮动作拖住）。
    local overtime = U.now() > (j.data.loot_until or 0)
    if not picked_now and (overtime or not busy(p)) then
        local after = snapshot_counts(p)
        local gained = {}
        for prefab, n in pairs(after) do
            local d = n - (j.data.before[prefab] or 0)
            if d > 0 then gained[#gained + 1] = string.format("%s+%d", prefab, d) end
        end
        table.sort(gained)
        local tail = #gained > 0 and ("（" .. table.concat(gained, "，") .. "）") or ""
        -- 捡到了就报数量；没捡到就明说"东西在地上"，别让模型以为已经到手
        local note = ""
        if #gained == 0 then
            note = "；产物掉在脚下但没进背包（背包满了？），可以 pickup_nearest 捡"
        end
        return "done", string.format("%s了 %s%s%s", def.verb, j.data.label or "目标", tail, note)
    end
    return "run"
end

--- 对实体干活（chop/mine/dig/hammer 共用）
local function work_by_ref(j, p, target, kind)
    local def = WORK_ACTIONS[kind]
    if def == nil then return "fail", "unknown_work_action" end
    -- ★ TARGET-REFRESH：**loot 必须先处理**。
    --   挖矿时岩石一碎实体就失效（IsValid()=false），如果先走下面那句"目标没了 → done"，
    --   就再也进不到捡东西那一步 —— 真机表现就是「挖了 岩石」但石头/燧石全躺在地上没捡。
    if j.step == "loot" then
        return work_loot_step(j, p, def)
    end
    if target == nil or not target:IsValid() then
        -- 已经动过手、目标却没了 = 被我们干掉了（岩石挖碎会消失，树倒变树桩）
        if j.data ~= nil and j.data.pushed ~= nil then
            -- 也别直接 done：先进 loot 把脚边掉的东西捡了（上面已处理 loot 步骤）
            if j.data.loot_until == nil then
                j.data.loot_until = U.now() + 3.5   -- 只是兜底上限（背包满/够不着时别拖住一轮动作）
                j.data.looted = {}
                j.step = "loot"
                return "run"
            end
            return "done", string.format("%s了 %s", def.verb, j.data.label or "目标")
        end
        return "fail", "entity_gone: 目标已经不存在了"
    end
    local workable = target.components ~= nil and target.components.workable or nil
    if workable == nil then
        return "fail", "target_not_workable: 这个东西不能" .. def.verb
    end
    local action = ACTIONS[def.action]
    if action == nil then return "fail", "这个版本里没有 " .. def.action end

    if j.step == "start" then
        if target:IsInLimbo() then return "fail", "in_limbo: 目标进入了 limbo" end
        -- ★ TARGET-REFRESH：先看距离，够不着就别推。
        --   真机踩到：桦栗树在 2 格外，push 之后引擎要先走过去，结果被当成"推不动/工具不对"。
        --   原生 CHOP/MINE 要贴到 ~1 格；这里放宽到 1.6 格（引擎会自己微调），
        --   超过就直接告诉模型"先 move_to 靠近"，省一次注定失败的动作。
        do
            local d0 = U.dist(p, target)
            local tiles0 = d0 ~= nil and (d0 / U.TILE) or nil
            if tiles0 ~= nil and tiles0 > 2.5 then
                local tx, tz = nil, nil
                local px, _, pz = U.pos(target)
                if px ~= nil then tx, tz = U.tile_of(px, pz) end
                return "fail", string.format("out_of_range: 目标 %s 在 %.1f 格外（%s）：先 move_to 靠近再%s",
                    U.pretty(target), tiles0,
                    tx ~= nil and string.format("%d,%d", tx, tz) or "?", def.verb)
            end
        end
        j.data.target = target
        j.data.kind = kind
        j.data.label = U.pretty(target)
        j.data.before = snapshot_counts(p)
        j.data.phase_start = U.now()
        -- 工具检查（没有就明确说，别推一条注定失败的动作）
        local tool = best_tool(p, action)
        if tool == nil then
            return "fail", string.format("no_tool: 背包里没有能%s的工具，先 craft %s", def.verb, def.tool)
        end
        -- 装备到手上（workable 动作要求手持对应工具）
        local inv = p.components ~= nil and p.components.inventory or nil
        if inv ~= nil then
            local hand = inv:GetEquippedItem(EQUIPSLOTS.HANDS)
            if hand ~= tool then pcall(function() inv:Equip(tool) end) end
        end
        local ba = BufferedAction(p, target, action, tool)
        if ba == nil then return "fail", "action_unavailable: 这个动作用不了" end
        -- 官方"按住 F"连砍时会给动作打这个标记
        pcall(function() ba.options.no_predict_fastforward = true end)
        push(p, ba)
        j.data.ba = ba
        j.data.tool = tool
        j.data.hits = 1
        j.data.pushed = U.now()
        j.data.last_push = j.data.pushed
        -- ★ TARGET-REFRESH：这里原来只 push **一次**就干等 —— 树要 4~5 下才倒、石头要挖好几下，
        --   于是永远等不到 work_done，最后 120 秒超时（真机 `chop_nearest` 就是这么失败的）。
        --   现在照 `job_work` 的老办法：把"按住动作键"置上，让引擎自己在状态机里重推同一个动作
        --   （官方"按住空格/F"连砍就是这条机制，实测 push 1 次能连砍到倒）。
        hold_control(p, true)
        j.step = "acting"
        return "run"
    end

    if j.step == "acting" then
        local alive = target:IsValid()
        -- ★ TARGET-REFRESH：**先判目标有没有倒，再判忙不忙**。
        --   顺序很关键：`hold_control` 一开，引擎在状态机内部自己连砍，人物**一直是 busy**，
        --   如果先走 busy 分支就永远回不到这里（job_work 在 2026-11-12 真机踩过同一个坑）。
        local done_now = work_done(target, def.action) or not alive
        if done_now then
            -- 目标倒了：立刻松手，别一路砍到下一棵
            hold_control(p, false)
            j.data.done_at = j.data.done_at or U.now()
            -- ★ TARGET-REFRESH：砍倒 ≠ 木头到手。原生会把 log/松果/石头**掉在脚下**，
            --   真机踩到：树砍倒了、木头就在 0.3 格外，但回执只说"砍了常青树"，
            --   模型以为东西已经进包了，于是没去捡（用户看到的就是"砍了但没捡木头"）。
            --   所以这里进一个 loot 步骤：把脚边这次掉出来的产物捡起来，再一起报账。
            if j.data.loot_until == nil then
                j.data.loot_until = U.now() + 3.5   -- 只是兜底上限（背包满/够不着时别拖住一轮动作）
                j.data.looted = {}
                j.step = "loot"
                return "run"
            end
        end
        if U.now() - j.data.phase_start > 120 then
            hold_control(p, false)
            return "fail", "work_failed: 干了 120 秒还没弄完（可能够不着或工具不对）"
        end
        -- 引擎连砍时单次动作永远不结束 → 必须有一个按**任务总时长**的出口，
        -- 否则上面那个 120 秒（按单次 push 计时）永远不会触发（job_work 踩过同一个坑）。
        if busy(p) and U.now() - (j.t0 or j.data.phase_start) > (tonumber(j.args.timeout) or 240) then
            hold_control(p, false)
            return "fail", string.format("%s了 %d 下还没倒（超时；工具太弱或够不着）", def.verb, j.data.hits or 0)
        end
        -- 还没真正动起来：先分清"够不着"和"工具不对"，别一律报"推不动"。
        -- 真机踩到：桦栗树在 2 格外，引擎要先走过去，3 秒不够 → 被误报成"推不动/工具不对"。
        -- 注意：这里**不能**用 `hits <= 1` 当条件 —— 兜底重推每 tick 都会加 hits，
        -- 距离不够时它也会一直重推，hits 早就 > 1 了（真机就是这么绕过诊断的）。
        if not busy(p) then
            local waited = U.now() - j.data.phase_start
            local d = U.dist(p, target)
            local tiles = d ~= nil and (d / U.TILE) or nil
            -- ① 距离明显不够（原生 CHOP 要贴到 ~1 格）：直接说清楚，让模型先靠近。
            if tiles ~= nil and tiles > 2.5 and waited > 1.5 then
                local tx, tz = nil, nil
                local px, _, pz = U.pos(target)
                if px ~= nil then tx, tz = U.tile_of(px, pz) end
                hold_control(p, false)
                return "fail", string.format("out_of_range: 目标 %s 在 %.1f 格外（%s）：先 move_to 靠近再%s",
                    j.data.label or "目标", tiles,
                    tx ~= nil and string.format("%d,%d", tx, tz) or "?",
                    def.verb)
            end
            -- ② 距离够了却一直没动起来（8 秒）→ 才判工具不对 / 被挡。
            if waited > 8 and (j.data.hits or 0) <= 2 then
                local hands = nil
                local inv2 = p.components ~= nil and p.components.inventory or nil
                if inv2 ~= nil then hands = inv2:GetEquippedItem(EQUIPSLOTS.HANDS) end
                hold_control(p, false)
                return "fail", string.format("推不动 %s（prefab=%s）：手里是 %s，可能工具不对或者够不着",
                    j.data.label or "目标", tostring(target ~= nil and target.prefab or "?"),
                    hands ~= nil and U.describe_item(hands) or "空手")
            end
        end
        -- ★ TARGET-REFRESH：连砍兜底（照 `job_work` 的节奏，它真机验证过）。
        --   真机踩到：`hold_control` 在这个构建里不足以让引擎自己连推，
        --   于是"推一次 → 站着不动 → 8 秒后报推不动"。job_work 的做法是**主动重推**。
        --   这里每 0.4 秒重推一次（复用同一个 ba，重建会打断 sg 状态机）。
        local now = U.now()
        if (now - (j.data.last_push or 0) > 0.4) then
            local ba = j.data.ba
            if ba ~= nil then
                -- 复用同一个动作：清掉上一次的收尾状态，允许重放
                ba.doable = nil
                pcall(function()
                    ba.options.no_predict_fastforward = true
                end)
                -- 工具可能被换掉（耐久耗尽），重推前再确认一次
                local act2 = ACTIONS[def.action]
                local tool2 = best_tool(p, act2)
                if tool2 ~= nil then
                    ba.invobject = tool2
                    equip_if_needed(p, tool2)
                end
                push(p, ba)
                j.data.last_push = now
                j.data.hits = (j.data.hits or 0) + 1
                j.data.pushed = now
                if j.data.hits > 40 then
                    hold_control(p, false)
                    return "fail", string.format("%s了 %d 下还没倒（工具太弱或够不着）", def.verb, j.data.hits)
                end
            end
        end
        return "run"
    end
    return "run"
end

-- 分流：带 ctx.target（guard 解析好的 #N）走新路径；否则走下面的旧实现（reflex 用）。
-- 和 pickup / harvest 完全同一个模式，避免把旧行为删掉。
local function work_dispatch(kind)
    return function(j, p)
        local ctx = j.ctx or {}
        if ctx.target ~= nil then return work_by_ref(j, p, ctx.target, kind) end
        return job_work(j, p, kind:upper())
    end
end
JOBS.chop = work_dispatch("chop")
JOBS.mine = work_dispatch("mine")
JOBS.dig = work_dispatch("dig")
JOBS.hammer = work_dispatch("hammer")
JOBS.pick = function(j, p) return job_work(j, p, "PICK") end

--- 出锅 / 收割：锅（stewer）煮熟了要拿出来，晾肉架靠 harvestable
JOBS.harvest = function(j, p)
    -- M2.3：带 ctx.target 时走"按 #N 收获"的新路径（只认 guard 解析出来的真实实体，
    -- 绝不按 prefab 搜替代目标，也不自动接续 pickup）；
    -- 老调用方（args.target，锅/晾肉架那套）仍然走下面的原逻辑，语义不变。
    local ctx = j.ctx or {}
    if ctx.target ~= nil then
        return harvest_by_ref(j, p, ctx.target)
    end
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

-- ═══════════════ TARGET-REFRESH：实时目标选择（复用上面原有的实现）═══════════════
--
-- 这五个动作**没有自己的执行逻辑**：目标由 guard 在授权那一刻用当前世界状态重新找到
-- （放在 ctx.target），这里只是把它交给已有的 pickup_by_ref / harvest_by_ref / work_by_ref。
-- 所以执行链、成功判据、超时、工具装备全部和 #N 那条路**一模一样**，
-- 不存在"第二套不受安全约束的执行通道"。
--
-- 关键：ctx.target == nil 时一律 fail，**绝不退回按 prefab 搜目标**
--（否则就等于绕过了 guard 的白名单与距离校验）。
local function require_resolved(ctx, what)
    if ctx == nil or ctx.target == nil then
        return "fail", "no_resolved_target: " .. what .. " 必须由服务端实时选中目标（不要传 prefab）"
    end
    return nil, nil
end

-- 捡最近的一类资源（flint / twigs / cutgrass / log / rocks / goldnugget / charcoal / petals）
JOBS.pickup_nearest = function(j, p)
    local ctx = j.ctx or {}
    local err, why = require_resolved(ctx, "pickup_nearest")
    if err ~= nil then return err, why end
    return pickup_by_ref(j, p, ctx.target)
end

-- 捡最近的地面白名单食物（carrot / berries / berries_juicy / pumpkin / …；生蘑菇不算）
JOBS.pickup_food = function(j, p)
    local ctx = j.ctx or {}
    local err, why = require_resolved(ctx, "pickup_food")
    if err ~= nil then return err, why end
    return pickup_by_ref(j, p, ctx.target)
end

-- 采最近**已成熟**的食物植株（未成熟的在 guard 里就被跳过了）
JOBS.harvest_nearest = function(j, p)
    local ctx = j.ctx or {}
    local err, why = require_resolved(ctx, "harvest_nearest")
    if err ~= nil then return err, why end
    return harvest_by_ref(j, p, ctx.target)
end

-- 砍最近的树
JOBS.chop_nearest = function(j, p)
    local ctx = j.ctx or {}
    local err, why = require_resolved(ctx, "chop_nearest")
    if err ~= nil then return err, why end
    return work_by_ref(j, p, ctx.target, "chop")
end

-- 挖最近的矿（ordinary_rock / gold_vein）
JOBS.mine_nearest = function(j, p)
    local ctx = j.ctx or {}
    local err, why = require_resolved(ctx, "mine_nearest")
    if err ~= nil then return err, why end
    return work_by_ref(j, p, ctx.target, "mine")
end

return A
