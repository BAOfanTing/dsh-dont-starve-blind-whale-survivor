-- 工作/劳作执行链：chop / mine / dig / hammer / pick（连续工作 + 掉落物收集）。
-- 从 gathering.lua 抽出（纯搬移）；共享的 A.* 别名与 gather 侧一致，动作仍走唯一 dispatcher/guard。
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


local WORK_ACTIONS = {
    chop = { action = "CHOP", verb = "砍", tool = "axe", tool_cn = "斧头" },
    mine = { action = "MINE", verb = "挖", tool = "pickaxe", tool_cn = "镐子" },
    dig = { action = "DIG", verb = "铲", tool = "shovel", tool_cn = "铲子" },
    hammer = { action = "HAMMER", verb = "拆", tool = "hammer", tool_cn = "锤子" },
}

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
    -- 兜底：进 loot 前一定要松开"按住动作键"，否则人一直 busy，一件都捡不动。
    if j.data.hold_on then
        hold_control(p, false)
        j.data.hold_on = false
    end
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
            -- ★ 一定要松手：这条路径以前**没有** hold_control(p, false)，
            --   于是"按住动作键"会一直留着（岩石挖碎就是走这里），
            --   loot 阶段因为人一直 busy 而捡不动东西。
            if j.data.hold_on then
                hold_control(p, false)
                j.data.hold_on = false
            end
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
        j.data.hold_on = false
        -- ★ 引擎有没有**真的把动作跑起来过**。见 acting 段：起手阶段绝不能重推。
        j.data.ever_busy = false
        -- 【计时探针】引擎时间戳，用来区分"我们推得慢"还是"引擎起手慢"（verbose 才输出）
        j.data.t_push = U.now()
        j.data.wl0 = U.try(function() return target.components.workable.workleft end)
        j.data.log_busy = false
        j.data.log_hit = false
        -- ★ TARGET-REFRESH：这里原来只 push **一次**就干等 —— 树要 4~5 下才倒、石头要挖好几下，
        --   于是永远等不到 work_done，最后 120 秒超时。
        --
        -- ★★ 真机 bug（2026-11-17，用户："砍树/砸矿都是走到附近，然后停几秒再开始"）：
        --   "按住动作键"（hold_control）**不能在这里就开**。此刻人还在往目标走，
        --   一开引擎的"按住"逻辑就会和我们的动作抢，反而拖慢起手。
        --   改成"手空下来之后再开"（见 acting 段的 not busy(p) 判断）。
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
            j.data.hold_on = false
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
        -- ★★ 真机 bug（2026-11-17）：这段原来是**无条件**每 0.4 秒重推一次。
        --   而 `loco:PushAction` 第一件事是 `self:Clear()` —— 于是每次重推都会
        --   **把正在走的寻路、正在演的挥砍取消掉**，人杵在原地、砍得极慢
        --   （实测：装备好到第一次挥砍停了 ~2 秒，一棵桦栗树砍了 14 秒）。
        --   `job_work` 的重推是在"不忙"分支里的，搬过来时漏了这个门。
        --   为什么**只**需要 `not busy(p)` 这一道门（不需要再判距离）：
        --   · 走路时 sg 带 `moving` 标签、`GetBufferedAction()` 也非 nil → busy = true，
        --     所以"走路中绝不重推"已经由它保证，不会取消寻路；
        --   · 曾经额外加过 `tiles <= 2.0` 的门，但 start 允许到 2.5 格，
        --     2.0~2.5 格就成了**死区**：推一次之后再没人驱动（真机实测踩到）。
        --   "按住动作键"同样只在"手空下来"之后才开，避免它和寻路抢。
        -- ★★ 真机 bug（2026-11-17，用户："走到第一棵树前停了几秒，砍一下后会顿一下，
        --   后边才是连砍"）：起手阶段**绝不能重推**。
        --   从我们 `push` 到引擎真的把动作跑起来之间，`busy(p)` 仍然是 false，
        --   于是 0.4 秒后我们就重推一次 → `loco:PushAction` 的 `self:Clear()`
        --   把刚排上队的动作取消重排，反复几次才终于起来。这就是"起手停几秒"。
        --   一旦引擎跑起来（busy=true）重推就只在动作间隙补位，所以之后连砍是正常的。
        --
        --   所以：只有**见过引擎忙**（说明动作真的跑起来过）之后才允许重推；
        --   另留一个 2.5 秒兜底，万一第一次 push 被静默丢掉还能救一次。
        if busy(p) then
            j.data.ever_busy = true
            if not j.data.log_busy and j.data.t_push ~= nil then
                j.data.log_busy = true
                U.log(string.format("[timing] %s：push→引擎开始演 %.2fs", tostring(kind), U.now() - j.data.t_push))
            end
        end
        -- 第一次 workleft 下降 = 真的砍中了（不是"动画开始"，是"伤害落地"）
        if not j.data.log_hit and j.data.wl0 ~= nil and j.data.t_push ~= nil then
            local left_now = U.try(function() return target.components.workable.workleft end)
            if type(left_now) == "number" and left_now < j.data.wl0 then
                j.data.log_hit = true
                U.log(string.format("[timing] %s：push→第一次砍中(workleft %s→%s) %.2fs",
                    tostring(kind), tostring(j.data.wl0), tostring(left_now), U.now() - j.data.t_push))
            end
        end
        local now = U.now()
        local may_repush = j.data.ever_busy
            or (now - (j.data.pushed or now) > 2.5)
        if may_repush and not j.data.hold_on and not busy(p) then
            hold_control(p, true)
            j.data.hold_on = true
        end
        if may_repush and not busy(p) and (now - (j.data.last_push or 0) > 0.4) then
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

local function require_resolved(ctx, what)
    if ctx == nil or ctx.target == nil then
        return "fail", "no_resolved_target: " .. what .. " 必须由服务端实时选中目标（不要传 prefab）"
    end
    return nil, nil
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
