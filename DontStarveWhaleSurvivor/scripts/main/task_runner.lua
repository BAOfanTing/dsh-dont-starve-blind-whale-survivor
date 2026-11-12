-- Blind Whale Survivor · Phase 5 · M6 · 任务链引擎
--
-- 职责：把已有的原子动作（Whale.actions 的 JOBS）串成**固定的多步骤任务**。
--
-- 设计原则（任务书 §8 多步骤任务）：
--   1. **固定模板白名单**：外部只能请求 TASKS 表里的任务名，绝不接受任意脚本/表达式。
--   2. **每步带前置检查**：材料不够/没工具/附近没目标 → 该步跳过或整任务失败，不硬干。
--   3. **失败可重试**：单步失败按 retry 次数重试，超过就跳过（除非该步是必需的）。
--   4. **中断可清理**：任何异常退出都松开 remote_controls、停止移动、清空缓冲动作。
--   5. **进度可查**：status() 暴露当前任务、第几步、已完成步、失败原因。
--
-- 沙箱：mod 环境没有 pcall/tonumber/next/os，全部从 GLOBAL 取。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

BWS2 = BWS2 or {}

local T = {}

-- ─────────────────────────── 工具函数 ───────────────────────────

local function now()
    local os_ = GLOBAL.os
    if os_ ~= nil and os_.time ~= nil then
        local ok, v = pcall(os_.time)
        if ok and v ~= nil then return tonumber(v) or 0 end
    end
    return 0
end

--- 安全取玩家（和 action_executor 保持同一套判据）
local function player()
    if Whale ~= nil and Whale.util ~= nil and Whale.util.player ~= nil then
        local ok, p = pcall(Whale.util.player)
        if ok then return p end
    end
    return nil
end

--- 数背包里某 prefab 的数量（用官方 StackSize，和 action_executor 一致）
local function count_prefab(p, prefab)
    if p == nil or p.components == nil or p.components.inventory == nil then return 0 end
    local total = 0
    pcall(function()
        p.components.inventory:ForEachItem(function(item)
            if item ~= nil and item.prefab == prefab then
                local st = item.components ~= nil and item.components.stackable or nil
                local n = 1
                if st ~= nil then
                    local ok, v = pcall(function() return st:StackSize() end)
                    if ok and tonumber(v) ~= nil then n = tonumber(v) end
                end
                total = total + n
            end
        end)
    end)
    return total
end

--- 附近有没有某类实体（按 prefab 子串匹配）
local function nearby_has(p, prefab_pattern, radius)
    if p == nil or Whale == nil or Whale.util == nil or Whale.util.find_all == nil then return false end
    local list = {}
    local ok = pcall(function()
        list = Whale.util.find_all(p, radius or 20, nil, nil, function(e)
            local pf = string.lower(e.prefab or "")
            return string.find(pf, string.lower(prefab_pattern), 1, true) ~= nil
        end)
    end)
    return ok and list ~= nil and #list > 0
end

--- 手上装备的 prefab
local function equipped(p)
    if p == nil or p.components == nil or p.components.inventory == nil then return nil end
    local slots = GLOBAL.EQUIPSLOTS
    if slots == nil or slots.HANDS == nil then return nil end
    local ok, item = pcall(function() return p.components.inventory:GetEquippedItem(slots.HANDS) end)
    if ok and item ~= nil then return item.prefab end
    return nil
end

--- 松开"按住动作键"（清理用，避免任务结束后人物还在连砍）
local function release_controls(p)
    if p == nil then return end
    if Whale ~= nil and Whale.actions ~= nil and Whale.actions.hold_control ~= nil then
        pcall(Whale.actions.hold_control, p, false)
    end
    local loco = p.components ~= nil and p.components.locomotor or nil
    if loco ~= nil then
        pcall(function() loco:Stop() end)
        pcall(function() loco:Clear() end)
    end
    pcall(function() p:ClearBufferedAction() end)
end

-- ─────────────────────────── 任务模板 ───────────────────────────
--
-- 每个任务是 { name, desc, steps = { {job=, args=, need=, retry=, optional=, timeout= } } }
--   need(p)   → true 表示前置条件满足，false 则跳过该步（optional）或整任务失败
--   retry     → 失败重试次数（默认 1）
--   optional  → 该步失败是否允许跳过（默认 false = 必需）
--   timeout   → 该步超时秒数（默认 120）

local TASKS = {}

--- 生存包：确保有火、有食物、有工具
TASKS.survive_night = {
    name = 'survive_night',
    desc = '过夜准备：够草 → 够木头 → 建营火 → 有吃的就吃',
    steps = {
        {
            job = 'pick', args = { target = 'grass', count = 3, radius = 20 },
            need = function(p) return nearby_has(p, 'grass', 20) end,
            retry = 1, optional = true, timeout = 90,
            why = '采 3 个草（营火材料）',
        },
        {
            job = 'chop', args = { count = 1, radius = 20, until_gone = true },
            need = function(p) return nearby_has(p, 'tree', 20) end,
            retry = 1, optional = true, timeout = 180,
            why = '砍 1 棵树（拿木头）',
        },
        {
            job = 'pickup', args = { item = 'log', count = 3, radius = 20 },
            need = function(p) return nearby_has(p, 'log', 20) end,
            retry = 1, optional = true, timeout = 90,
            why = '捡起掉落的木头',
        },
        {
            job = 'make_fire', args = { recipe = 'campfire' },
            need = function(p) return count_prefab(p, 'cutgrass') >= 3 and count_prefab(p, 'log') >= 2 end,
            retry = 1, optional = false, timeout = 180,
            why = '建营火（需 3 草 + 2 木）',
        },
        {
            job = 'eat', args = {},
            need = function(p) return (p.components ~= nil and p.components.hunger ~= nil
                and p.components.hunger:GetPercent() < 0.5) end,
            retry = 0, optional = true, timeout = 60,
            why = '饿了就吃（best_food 只挑正收益食物）',
        },
    },
}

--- 攒木头：做斧头 → 砍 N 棵 → 捡木头
TASKS.stock_logs = {
    name = 'stock_logs',
    desc = '攒木头：没斧头就先做 → 砍 N 棵 → 捡起掉落',
    steps = {
        {
            job = 'pick', args = { target = 'sapling', count = 2, radius = 20 },
            need = function(p) return count_prefab(p, 'twigs') < 1 and nearby_has(p, 'sapling', 20) end,
            retry = 1, optional = true, timeout = 90,
            why = '采树枝（做斧头用）',
        },
        {
            job = 'pickup', args = { item = 'flint', count = 2, radius = 20 },
            need = function(p) return count_prefab(p, 'flint') < 1 and nearby_has(p, 'flint', 20) end,
            retry = 1, optional = true, timeout = 90,
            why = '捡燧石（做斧头用）',
        },
        {
            job = 'craft', args = { recipe = 'axe', count = 1 },
            need = function(p)
                local has = count_prefab(p, 'axe') > 0 or equipped(p) == 'axe'
                return not has and count_prefab(p, 'twigs') >= 1 and count_prefab(p, 'flint') >= 1
            end,
            retry = 1, optional = true, timeout = 60,
            why = '做斧头（1 树枝 + 1 燧石）',
        },
        {
            job = 'chop', args = { count = 3, radius = 25, until_gone = true },
            need = function(p) return nearby_has(p, 'tree', 25) end,
            retry = 1, optional = false, timeout = 300,
            why = '砍 3 棵树',
        },
        {
            job = 'pickup', args = { item = 'log', count = 8, radius = 25 },
            need = function(p) return nearby_has(p, 'log', 25) end,
            retry = 1, optional = true, timeout = 120,
            why = '把木头捡起来',
        },
    },
}

--- 工具包：斧头 + 镐 + 火把
TASKS.toolkit = {
    name = 'toolkit',
    desc = '备齐基础工具：斧头 / 镐 / 火把',
    steps = {
        {
            job = 'pick', args = { target = 'sapling', count = 3, radius = 20 },
            need = function(p) return nearby_has(p, 'sapling', 20) end,
            retry = 1, optional = true, timeout = 90,
            why = '采树枝',
        },
        {
            job = 'pickup', args = { item = 'flint', count = 3, radius = 20 },
            need = function(p) return nearby_has(p, 'flint', 20) end,
            retry = 1, optional = true, timeout = 90,
            why = '捡燧石',
        },
        {
            job = 'pick', args = { target = 'grass', count = 2, radius = 20 },
            need = function(p) return nearby_has(p, 'grass', 20) end,
            retry = 1, optional = true, timeout = 90,
            why = '采草（火把材料）',
        },
        {
            job = 'craft', args = { recipe = 'axe', count = 1 },
            need = function(p)
                return count_prefab(p, 'axe') == 0 and count_prefab(p, 'twigs') >= 1 and count_prefab(p, 'flint') >= 1
            end,
            retry = 1, optional = true, timeout = 60, why = '做斧头',
        },
        {
            job = 'craft', args = { recipe = 'pickaxe', count = 1 },
            need = function(p)
                return count_prefab(p, 'pickaxe') == 0 and count_prefab(p, 'twigs') >= 2 and count_prefab(p, 'flint') >= 2
            end,
            retry = 1, optional = true, timeout = 60, why = '做镐',
        },
        {
            job = 'craft', args = { recipe = 'torch', count = 1 },
            need = function(p)
                return count_prefab(p, 'torch') == 0 and count_prefab(p, 'twigs') >= 2 and count_prefab(p, 'cutgrass') >= 2
            end,
            retry = 1, optional = true, timeout = 60, why = '做火把',
        },
    },
}

--- 采集包：按白名单资源各采一些
TASKS.forage = {
    name = 'forage',
    desc = '附近能采的都采一遍（草/树枝/浆果）',
    steps = {
        {
            job = 'pick', args = { target = 'grass', count = 3, radius = 25 },
            need = function(p) return nearby_has(p, 'grass', 25) end,
            retry = 1, optional = true, timeout = 90, why = '采草',
        },
        {
            job = 'pick', args = { target = 'sapling', count = 3, radius = 25 },
            need = function(p) return nearby_has(p, 'sapling', 25) end,
            retry = 1, optional = true, timeout = 90, why = '采树枝',
        },
        {
            job = 'pick', args = { target = 'berrybush', count = 3, radius = 25 },
            need = function(p) return nearby_has(p, 'berry', 25) end,
            retry = 1, optional = true, timeout = 90, why = '采浆果',
        },
    },
}

T.TASKS = TASKS

-- ─────────────────────────── 运行时状态 ───────────────────────────

local run = nil   -- { name, step_index, started_at, steps_done, steps_skipped, last_error, retries }
-- 真机发现（2026-11-12）：任务跑完后 run 被清空，进度信息就丢了，
-- 上层只能看到 running=false，不知道刚才那个任务做了几步、跳了几步、有没有失败。
-- 所以保留一份最后一次任务的总结（只留纯数据，不含函数）。
local last_run = nil

local function task_status()
    if run == nil then
        local out = { running = false }
        if last_run ~= nil then
            out.last = last_run
        end
        return out
    end
    local tpl = TASKS[run.name]
    local total = tpl ~= nil and #tpl.steps or 0
    return {
        running = true,
        task = run.name,
        desc = tpl ~= nil and tpl.desc or nil,
        step_index = run.step_index,
        step_total = total,
        current_why = tpl ~= nil and tpl.steps[run.step_index] ~= nil and tpl.steps[run.step_index].why or nil,
        steps_done = run.steps_done,
        steps_skipped = run.steps_skipped,
        last_error = run.last_error,
        retries = run.retries,
        elapsed_s = now() - (run.started_at or now()),
    }
end

T.status = task_status

--- 开始一个任务（只接受 TASKS 白名单里的名字）
function T.Start(name)
    if name == nil or type(name) ~= 'string' then
        return false, 'task 名字必须是字符串'
    end
    local tpl = TASKS[name]
    if tpl == nil then
        local known = {}
        for k in pairs(TASKS) do known[#known + 1] = k end
        table.sort(known)
        return false, '没有这个任务：' .. tostring(name) .. '（能用的：' .. table.concat(known, '、') .. '）'
    end
    if run ~= nil then
        return false, '已有任务在跑：' .. tostring(run.name) .. '（先 stop_task）'
    end
    local p = player()
    if p == nil then return false, '找不到玩家' end
    -- 原子动作也不能同时在跑，否则会互相打断
    if Whale ~= nil and Whale.actions ~= nil and Whale.actions.Current ~= nil then
        local ok, cur = pcall(Whale.actions.Current)
        if ok and cur ~= nil then
            return false, '已有动作在跑：' .. tostring(cur) .. '（先 stop）'
        end
    end
    last_run = nil   -- 新任务开始，清掉上一次的总结
    run = {
        name = name,
        step_index = 1,
        started_at = now(),
        steps_done = 0,
        steps_skipped = 0,
        last_error = nil,
        retries = 0,
        step_started_at = now(),
    }
    print('[BWS2] 任务开始：' .. name .. '（' .. #tpl.steps .. ' 步）')
    return true, nil
end

--- 中止当前任务（会清理动作与按键状态）
function T.Stop(reason)
    if run == nil then return false, '当前没有任务在跑' end
    local p = player()
    release_controls(p)
    if Whale ~= nil and Whale.actions ~= nil and Whale.actions.Stop ~= nil then
        pcall(Whale.actions.Stop)
    end
    local name = run.name
    run = nil
    print('[BWS2] 任务中止：' .. name .. '（' .. tostring(reason or '手动') .. '）')
    return true, nil
end

--- 推进任务（由 observer Tick 周期调用，一次只推进一步的状态检查）
--- @return string|nil 完成时的结束文本
function T.Tick()
    if run == nil then return nil end
    local tpl = TASKS[run.name]
    if tpl == nil then
        run = nil
        return nil
    end
    local p = player()
    if p == nil then
        release_controls(nil)
        run = nil
        return '玩家不见了，任务中止'
    end

    local step = tpl.steps[run.step_index]
    if step == nil then
        -- 全部步骤走完
        local text = string.format('任务 %s 完成：做了 %d 步，跳过 %d 步',
            run.name, run.steps_done, run.steps_skipped)
        print('[BWS2] ' .. text)
        release_controls(p)
        last_run = {
            task = run.name, ok = true, text = text,
            steps_done = run.steps_done, steps_skipped = run.steps_skipped,
            elapsed_s = now() - (run.started_at or now()),
        }
        run = nil
        return text
    end

    -- 当前步骤是否还在跑原子动作
    local current_job = nil
    if Whale ~= nil and Whale.actions ~= nil and Whale.actions.Current ~= nil then
        local ok, cur = pcall(Whale.actions.Current)
        if ok then current_job = cur end
    end

    if current_job ~= nil then
        -- 动作在跑：只检查超时
        local limit = step.timeout or 120
        if now() - (run.step_started_at or now()) > limit then
            run.last_error = string.format('第 %d 步超时（%s，>%d 秒）', run.step_index, tostring(step.why), limit)
            print('[BWS2] ' .. run.last_error)
            release_controls(p)
            if Whale.actions.Stop ~= nil then pcall(Whale.actions.Stop) end
            run.step_index = run.step_index + 1
            run.step_started_at = now()
        end
        return nil
    end

    -- 动作已结束（或还没开始）：决定下一步
    -- 上一轮是否刚完成一个动作？如果是，检查结果
    if run.awaiting_result then
        run.awaiting_result = nil
        local outcome = run.last_outcome
        run.last_outcome = nil
        if outcome == nil or outcome.ok ~= true then
            local reason = outcome ~= nil and outcome.text or '动作失败（无回执）'
            run.last_error = string.format('第 %d 步失败：%s（%s）', run.step_index, tostring(step.why), tostring(reason))
            print('[BWS2] ' .. run.last_error)
            local tries = (run.step_retries or 0) + 1
            local max_tries = (step.retry or 1) + 1
            if tries < max_tries then
                run.step_retries = tries
                run.retries = (run.retries or 0) + 1
                run.step_started_at = now()
                return nil   -- 重试同一一步
            end
            run.step_retries = 0
            if step.optional == true then
                run.steps_skipped = run.steps_skipped + 1
                run.step_index = run.step_index + 1
                run.step_started_at = now()
                return nil
            end
            -- 必需步骤失败 → 整个任务失败
            local text = string.format('任务 %s 失败：%s', run.name, tostring(run.last_error))
            print('[BWS2] ' .. text)
            release_controls(p)
            last_run = {
                task = run.name, ok = false, text = text, error = run.last_error,
                steps_done = run.steps_done, steps_skipped = run.steps_skipped,
                elapsed_s = now() - (run.started_at or now()),
            }
            run = nil
            return text
        end
        -- 这一步成功
        run.steps_done = run.steps_done + 1
        run.step_retries = 0
        run.step_index = run.step_index + 1
        run.step_started_at = now()
        return nil
    end

    -- 前置条件检查
    local ok_need, need_ok = true, true
    if step.need ~= nil then
        ok_need, need_ok = pcall(step.need, p)
        if not ok_need then need_ok = false end
    end
    if not need_ok then
        if step.optional == true then
            run.steps_skipped = run.steps_skipped + 1
            print(string.format('[BWS2] 跳过第 %d 步（%s）：前置条件不满足', run.step_index, tostring(step.why)))
            run.step_index = run.step_index + 1
            run.step_started_at = now()
            return nil
        end
        local text = string.format('任务 %s 失败：第 %d 步（%s）前置条件不满足',
            run.name, run.step_index, tostring(step.why))
        print('[BWS2] ' .. text)
        release_controls(p)
        last_run = {
            task = run.name, ok = false, text = text, error = text,
            steps_done = run.steps_done, steps_skipped = run.steps_skipped,
            elapsed_s = now() - (run.started_at or now()),
        }
        run = nil
        return text
    end

    -- 启动这一步的原子动作
    local started, err = false, nil
    if Whale ~= nil and Whale.actions ~= nil and Whale.actions.Start ~= nil then
        started, err = Whale.actions.Start(step.job, step.args or {})
    else
        err = 'Whale.actions 不可用'
    end
    if not started then
        run.last_error = string.format('第 %d 步启动失败：%s（%s）', run.step_index, tostring(step.why), tostring(err))
        print('[BWS2] ' .. run.last_error)
        local tries = (run.step_retries or 0) + 1
        if tries < ((step.retry or 1) + 1) then
            run.step_retries = tries
            run.retries = (run.retries or 0) + 1
            run.step_started_at = now()
            return nil
        end
        run.step_retries = 0
        if step.optional == true then
            run.steps_skipped = run.steps_skipped + 1
            run.step_index = run.step_index + 1
            run.step_started_at = now()
            return nil
        end
        local text = string.format('任务 %s 失败：%s', run.name, tostring(run.last_error))
        release_controls(p)
        run = nil
        return text
    end
    run.awaiting_result = true
    run.step_started_at = now()
    print(string.format('[BWS2] 第 %d 步开始：%s → %s', run.step_index, tostring(step.why), tostring(step.job)))
    return nil
end

--- 原子动作结束时由 bridge.Report 回调进来，把结果交给任务链
function T.OnActionResult(ok, text)
    if run == nil then return end
    run.last_outcome = { ok = ok == true, text = text, at = now() }
end

T.OnActionResult = T.OnActionResult

--- 供命令层查询的概要（不含函数，纯数据）
function T.Summary()
    local s = task_status()
    local names = {}
    for k in pairs(TASKS) do names[#names + 1] = k end
    table.sort(names)
    s.known_tasks = names
    return s
end

BWS2.tasks = T
