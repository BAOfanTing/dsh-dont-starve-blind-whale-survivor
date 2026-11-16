-- 原版能力薄封装（NATIVE-REUSE）
--
-- 目的：**不再自己实现饥荒已经有的东西**。这里只封装三件原版已经有的事：
--   1) 真实照明：引擎的光强读数 + 光源几何半径，而不是我们自己猜"附近有没有火"；
--   2) 逃跑方向：直接调原版 `RunAway:GetRunAngle`（behaviours/runaway.lua:33），
--      把它的绕障/偏转算法原样用上，而不是直线后退；
--   3) 玩家挥砍：按 SGwilson 的真实实现封装成 `ACTIONS.ATTACK` 的 BufferedAction。
--
-- 所有被引用的原版 API 都在本机 scripts.zip（构建 762172）里逐条核对过，
-- 注释里标了文件名和行号。核对不上的（例如 `lightsource` 标签）一律**不依赖**。
--
-- ★ 这个文件**不建立任何新的动作通道**：它只产出 BufferedAction 和坐标，
--   真正的执行仍然由 actions.lua 的 JOBS 状态机 + A.push 完成，
--   仍然受 Control Lease / Lua Guard / Dispatcher 那套链路约束。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

local U = Whale.util
local N = {}

local function try(fn, default)
    if type(fn) ~= "function" then return default end
    local ok, value = pcall(fn)
    if ok then return value end
    return default
end

-- ─────────────────────────── 一、真实照明 ───────────────────────────

--- 引擎在这一点上的光照强度。
--- 依据：entityscript.lua:2103 `TheSim:GetLightAtPoint(x, y, z, lightThresh)`
---（原版 IsInLight 内部就是这么算的）；服务端二进制里也有 GetLightAtPoint 这个符号。
function N.LightValue(ent)
    if ent == nil then return nil end
    local x, y, z = U.pos(ent)
    if x == nil then return nil end
    local ok, value = pcall(function() return GLOBAL.TheSim:GetLightAtPoint(x, y, z, 0) end)
    if ok and type(value) == "number" then return value end
    return nil
end

--- 我到底在不在光里。
---
--- 优先用 `inst:IsInLight()` —— 玩家身上这是**权威**的：
---   entityscript.lua:2095 `EntityScript:IsInLight()` 走 `self.LightWatcher:IsInLight()`，
---   而 player_common.lua:2446-2448 给玩家设了 LightThresh .075 / DarkThresh .05。
--- 拿不到时退回引擎光强 + 双阈值滞回（避免在阈值上抖动）。
local LIT_ENTER = 0.2
local LIT_STAY = 0.1
local lit_cache = {}

function N.IsLit(ent)
    if ent == nil then return false end
    local ok, lit = pcall(function() return ent:IsInLight() end)
    if ok and lit ~= nil then return lit == true end

    local value = N.LightValue(ent)
    if value == nil then return false end
    local key = tostring(ent.GUID or ent)
    local prev = lit_cache[key]
    local stay = prev ~= nil and prev.lit == true
    local now = value >= (stay and LIT_STAY or LIT_ENTER)
    lit_cache[key] = { lit = now }
    return now
end

--- 附近**真的在发光**的光源（营火/火坑/南瓜灯/提灯…），按几何半径判定。
---
--- 为什么不照抄原版 `FindLight`（behaviours/findlight.lua:46）：它按 `lightsource` 标签找，
--- 而在构建 762172 解包出的 4109 个 Lua 文件里，这个标签**只有人读、没有人写**
---（findlight / pigbrain / hermitcrabbrain / crop / farm_plants / flower / uiclock 全是查询；
--- 火焰的光在 `firefx_light` 子实体上，那个子实体只带 `FX` 标签）。
--- 所以拿 `lightsource` 当安全判据会永远找不到火堆。
--- 这里改成原版 pigbrain.lua:157 的**后半段**做法：按 `Light:GetCalculatedRadius()` 判半径，
--- 这个值由引擎给，可信。
function N.FindLitSource(ent, radius_tiles)
    if ent == nil then return nil end
    local limit = (radius_tiles or 12) * U.TILE
    local best, best_d = nil, nil
    local list = U.find_all(ent, radius_tiles or 12, nil, nil, function(e)
        if e == nil or e == ent then return false end
        if e.Light == nil then return false end
        if try(function() return e.Light:IsEnabled() end, false) ~= true then return false end
        local r = try(function() return e.Light:GetCalculatedRadius() end, nil)
        if type(r) ~= "number" or r <= 0 then return false end
        local fueled = e.components ~= nil and e.components.fueled or nil
        if fueled ~= nil and try(function() return fueled:IsEmpty() end, false) == true then
            return false
        end
        local d = U.dist(ent, e)
        return d <= limit and d <= r
    end)
    for _, row in ipairs(list) do
        if best_d == nil or row.d < best_d then best, best_d = row.ent, row.d end
    end
    return best, best_d
end

--- 综合照明状态（决策与诊断共用一份，避免两处各算一套）
function N.LightState(ent)
    local src, d = N.FindLitSource(ent, 12)
    return {
        lit = N.IsLit(ent),
        value = N.LightValue(ent),
        source = src,
        source_distance = d,
        source_radius = src ~= nil and try(function() return src.Light:GetCalculatedRadius() end, nil) or nil,
    }
end

-- ─────────────────────────── 二、逃跑方向（复用原版 RunAway）───────────────────────────

--- 缓存一个原版 RunAway 节点，只用来调它的**纯几何方法** `GetRunAngle`。
---
--- 为什么这样复用而不是把节点塞进 tick：
---   · 原版 `RunAway:Visit()` 会直接 `locomotor:RunInDirection(angle)` 自己驱动移动
---     （runaway.lua:169），那等于在 reflex 里开第二条动作通道，会绕过
---     Control Lease / Lua Guard / 单任务约束 —— 明确不允许。
---   · 但 `GetRunAngle`（runaway.lua:33-94）是**无副作用**的几何计算：
---     算"背离威胁的角度"，再用原版 `FindWalkableOffset`（simutil.lua:330）
---     做 8 方向绕障偏转（被挡就换角度，最多 8 次，都挡不住就直线跑）。
---     我们自己那版是**直线后退**，这正是真机里"撤离没甩脱、被蜘蛛围死"的原因。
---   · RunAway 的构造函数（runaway.lua:4-27）只存参数，不注册事件、不碰 locomotor，
---     所以造一个只用来算角度的实例是安全的。
local runaway_cache = {}

local function runaway_node(ent, see_dist, safe_dist)
    local key = tostring(ent.GUID or ent)
    local cached = runaway_cache[key]
    if cached ~= nil and (cached.inst == nil or try(function() return cached.inst:IsValid() end, false) == true) then
        return cached
    end

    -- 先看全局：`RunAway` 在 behaviours/runaway.lua 顶层是全局赋值（`RunAway = Class(...)`），
    -- 只要游戏里任何 brain 加载过它就已经在了（原版 pigbrain / mermbrain 等都 require 它）。
    -- 注意：DST 的 Class 返回的是带 __call 元表的 table，不能只判 function。
    -- 没有才自己 require —— 这样即使 require 在某些沙箱里不可用，也不影响复用。
    local klass = GLOBAL.RunAway
    if type(klass) ~= "table" and type(klass) ~= "function" then
        local ok, loaded = pcall(function()
            require("behaviours/runaway")
            return GLOBAL.RunAway or RunAway
        end)
        if ok and (type(loaded) == "table" or type(loaded) == "function") then klass = loaded end
    end
    if klass == nil then return nil end

    local ok, node = pcall(function()
        return klass(
            ent,
            { tags = { "hostile" }, notags = { "NOCLICK", "INLIMBO", "structure", "FX" } },
            see_dist,
            safe_dist,
            nil,        -- shouldrunfn：由调用方自己决定要不要跑
            false,      -- runhome：玩家没有 homeseeker
            false,      -- fix_overhang
            false,      -- walk_instead：逃跑用跑
            nil         -- safe_point_fn
        )
    end)
    if not ok or node == nil then return nil end
    runaway_cache[key] = node
    return node
end

--- 从威胁身边往哪跑（角度，度）。
--- 返回 nil 表示原版节点用不了（缺 FindWalkableOffset 之类），调用方自己退回直线。
function N.FleeAngle(ent, foe, safe_dist_tiles)
    if ent == nil or foe == nil then return nil end
    local node = runaway_node(ent, 8 * U.TILE, (safe_dist_tiles or 9) * U.TILE)
    if node == nil then return nil end
    local Vector3 = GLOBAL.Vector3 or GLOBAL.Point
    if Vector3 == nil then return nil end
    local px, py, pz = U.pos(ent)
    local fx, fy, fz = U.pos(foe)
    if px == nil or fx == nil then return nil end
    local ok, angle = pcall(function()
        return node:GetRunAngle(Vector3(px, py or 0, pz), Vector3(fx, fy or 0, fz), nil)
    end)
    if not ok or type(angle) ~= "number" then return nil end
    return angle
end

--- 把"往哪跑的角度"换成世界坐标点。
--- 角度→偏移的约定照抄原版 `FindValidPositionByFan`（simutil.lua:322）：
---   offset = Vector3(radius * cos(a), 0, -radius * sin(a))
--- 同时利用原版 FindWalkableOffset 寻路与 TheWorld.Map 验证可通行性，
--- 避免逃跑落点直接扎进大海、悬崖或障碍物导致角色在海边原地挨打。
function N.PointFromAngle(ent, angle_deg, distance)
    if ent == nil or angle_deg == nil then return nil end
    local px, py, pz = U.pos(ent)
    if px == nil then return nil end
    local d = distance or 6 * U.TILE
    local DEGREES = GLOBAL.DEGREES or (math.pi / 180)
    local a = angle_deg * DEGREES

    -- 1) 优先利用原版 FindWalkableOffset：
    --    结合 TheWorld.Map:IsAboveGroundAtPoint 和 Pathfinder:IsClear 确保目标点在陆地上且可达
    local FindWalkableOffset = GLOBAL.FindWalkableOffset
    local Vector3 = GLOBAL.Vector3 or GLOBAL.Point
    local map = GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld.Map or nil

    if FindWalkableOffset ~= nil and Vector3 ~= nil then
        for _, radius in ipairs({ d, d * 0.75, d * 0.5 }) do
            local ok, offset = pcall(function()
                return FindWalkableOffset(Vector3(px, py or 0, pz), a, radius, 12, true, false)
            end)
            if ok and offset ~= nil then
                local cand_x = px + offset.x
                local cand_z = pz + offset.z
                if map == nil or try(function() return map:IsPassableAtPoint(cand_x, 0, cand_z) end, true) then
                    return cand_x, cand_z
                end
            end
        end
    end

    -- 2) 如果没有 FindWalkableOffset，但有 TheWorld.Map，做扇扫可通行性检查
    if map ~= nil and map.IsPassableAtPoint ~= nil then
        for _, fan in ipairs({ 0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2 }) do
            local ang = a + fan
            local cand_x = px + d * math.cos(ang)
            local cand_z = pz - d * math.sin(ang)
            local ok, passable = pcall(function() return map:IsPassableAtPoint(cand_x, 0, cand_z) end)
            if ok and passable then
                return cand_x, cand_z
            end
        end
    end

    -- 3) 纯几何兜底（测试桩或环境缺失时与原版 fan 约定一致）
    return px + d * math.cos(a), pz - d * math.sin(a)
end

-- ─────────────────────────── 三、玩家攻击 ───────────────────────────

--- 造一个"玩家挥一刀"的 BufferedAction。
---
--- ★ 这里是最容易踩错的一处，源码依据：
---   · `Combat:TryAttack`（components/combat.lua:829）**只做一件事**：
---     `self.inst:PushEvent("doattack", {target = target})`。
---   · `SGwilson.lua` 里**没有** `doattack` 的事件处理器（全文件只有
---     `ActionHandler(ACTIONS.ATTACK, ...)`，SGwilson.lua:1382）；`doattack` 的通用处理器
---     `CommonHandlers.OnAttack()`（commonstates.lua:361）只注册在 SGpig / SGplayer_hosted
---     那类非玩家 stategraph 上。
---   · 所以对**玩家**来说，光调 `combat:TryAttack()` 不会挥砍，必须走
---     `BufferedAction(doer, target, ACTIONS.ATTACK)` → `locomotor:PushAction`
---     → SGwilson 的 attack 状态 → `PerformBufferedAction()`（entityscript.lua:1679）
---     → `ACTIONS.ATTACK.fn` → `combat:DoAttack(act.target)`（actions.lua:1961-1982）。
---   这也是 Sei 模组在 companion.lua:71-83 用真机测量记录下来的同一个坑。
function N.AttackAction(ent, target)
    if ent == nil or target == nil then return nil, "no_target" end
    if try(function() return target:IsValid() end, false) ~= true then return nil, "entity_gone" end
    if target.components == nil or target.components.health == nil then
        return nil, "target_not_attackable"
    end
    local BufferedAction = GLOBAL.BufferedAction
    local ACTIONS = GLOBAL.ACTIONS
    if BufferedAction == nil or ACTIONS == nil or ACTIONS.ATTACK == nil then
        return nil, "attack_action_unavailable"
    end
    local ok, ba = pcall(function() return BufferedAction(ent, target, ACTIONS.ATTACK, nil) end)
    if not ok or ba == nil then return nil, "bufferedaction_failed" end
    return ba
end

--- 现在能不能真的挥出下一刀。
--- 冷却由 combat 管：玩家的 min_attack_period = TUNING.WILSON_ATTACK_PERIOD = 0.4s
---（tuning.lua:43 / 119），`Combat:InCooldown` 在 combat.lua:128。
function N.CanSwing(ent)
    local combat = ent ~= nil and ent.components ~= nil and ent.components.combat or nil
    if combat == nil then return true end
    local cooling = try(function() return combat:InCooldown() end, nil)
    if cooling == nil then return true end
    return cooling ~= true
end

--- "我上一次**真的**打出去是什么时候" —— 用来核对挥砍有没有发生，
--- 而不是数我们推了几次 BufferedAction（推了被状态机丢掉也算一次的话，回执会撒谎）。
--- 依据：components/combat.lua:1231 `self.lastdoattacktime = GetTime()`（DoAttack 末尾）。
function N.LastAttackTime(ent)
    local combat = ent ~= nil and ent.components ~= nil and ent.components.combat or nil
    if combat == nil then return nil end
    local t = combat.lastdoattacktime
    if type(t) == "number" then return t end
    return nil
end

Whale = Whale or {}
Whale.native = N
