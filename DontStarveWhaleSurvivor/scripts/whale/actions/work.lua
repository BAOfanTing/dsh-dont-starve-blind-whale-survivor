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
        -- until_gone=true 时持续作业至目标消失；until_gone=false 时 count 表示挥砍次数。
        j.data.until_gone = j.args.until_gone == true
        j.data.max_hits = tonumber(j.args.max_hits) or 30
        j.data.cur_hits = 0          -- 当前目标已经干了几下
        -- 使用 counted 标记确保每个目标只计一次，避免 busy 与 done 分支重复计数。
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
        -- until_gone 模式：优先继续作业同一个有效目标，避免来回切换目标。
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
                -- 3 秒还没动起来：可能是工具不对或够不着，拉黑当前目标并换下一个重试（最多 3 次）。
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
            -- 开启 hold_control 后引擎在状态机内部连砍，需每次 tick 检查目标是否已倒并及时松手。
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
                    -- 引擎连砍期间人物保持 busy，因此以 pushed_target 或 cur_hits > 0 作为有效挥砍依据，防止换目标时误计砍倒数。
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
        -- 兜底总次数上限，确保异常场景下循环可终止
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
    -- loot 必须在实体失效检查之前处理，否则岩石碎裂后 IsValid()==false 会跳过拾取阶段。
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
        -- 启动前先校验距离（>2.5 格直接返回 out_of_range 并附带目标坐标）
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
        -- 进入 acting 阶段后再按需开启 hold_control（避免起步寻路期间与推进逻辑冲突）。
        j.step = "acting"
        return "run"
    end

    if j.step == "acting" then
        local alive = target:IsValid()
        -- 先判目标有没有倒，再判忙不忙（开启 hold_control 后人物持续 busy，不能阻塞完成判定）。
        local done_now = work_done(target, def.action) or not alive
        if done_now then
            -- 目标倒了：立刻松手，别一路砍到下一棵
            hold_control(p, false)
            j.data.hold_on = false
            j.data.done_at = j.data.done_at or U.now()
            -- 目标倒地/碎裂后进入 loot 步骤拾取掉落物（如木头、石头、燧石）
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
        -- 尚未动起来时先区分"距离不够"与"工具不对"，不以 hits <= 1 作为判断（重推会递增 hits）。
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
        -- 仅在“手空下来（not busy）”且“曾见过引擎忙（ever_busy）”之后才补推，
        -- 避免起手阶段或寻路期间触发 loco:PushAction -> Clear() 取消刚排队的动作；
        -- 若首次 push 被静默丢弃，保留 2.5 秒兜底重推。
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
