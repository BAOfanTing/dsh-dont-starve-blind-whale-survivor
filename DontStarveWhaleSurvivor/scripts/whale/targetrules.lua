-- TARGET-REFRESH：实时目标选择的**唯一真来源**（固定枚举 + 候选判定 + 最近目标 + 稳定句柄）
--
-- 为什么要有这个文件：
--   真机日志（session.txt，Mod 0.38.4）里 94 次工具调用有 23 次 pickup stale_snapshot、
--   3 次 chop、2 次 harvest。原因不是模型乱填，而是 **#N 只在当前扫描帧内有效**，
--   而模型一轮思考要 30~60 秒 —— 它拿到引用时那一帧早就换了。
--   放宽 stale_snapshot 校验会带来"操作错目标"，所以正确做法是：
--   **让模型描述"要哪一类东西"，由 Lua 在授权那一刻用当前世界状态重新找目标。**
--
-- 本文件只做四件事：
--   1) T.KINDS：Node 与 Lua 共同定义的**固定枚举**（不许模型传 prefab / GUID / Lua 表达式）
--   2) T.Matches(kind, ent, actor)：这个实体是不是这一类目标（观察侧与执行侧共用）
--   3) T.FindNearest(kind, actor, radius)：按距离找最近的、**当前真的可操作**的候选
--   4) 稳定句柄（handle）：不暴露 GUID，跨扫描保持稳定，目标没了立刻失效
--
-- 依据（本机 .runtime/dst-scripts 实测）：
--   · rocks.lua:65-85   战利品表：rock1 → rocks/nitre/flint（无金）；rock2 → rocks/goldnugget/flint
--                       ⇒ gold_vein 恰好就是 rock2，不是"看起来像"猜出来的
--   · rocks.lua:294     baserock 统一 workable:SetWorkAction(ACTIONS.MINE)
--   · evergreens.lua:989-1002  常青树/多枝树的 prefab 名（含 *_stump，但树桩是 ACTIONS.DIG，
--                               所以"必须 workable.action == CHOP"这条会把树桩自然排除）
--   · harvestrules.IsReady 才是"现在能不能采"；未成熟**不算**目标（不是报错）
--
-- 安全边界：本文件不执行任何动作、不写命令、不碰租约。它只回答"哪个实体算哪一类目标"。
-- 真正的执行仍然由 guard 授权 + actions.lua 的 BufferedAction → push() 走原链路。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local tostring = tostring
local type = type
local pairs = pairs
local ipairs = ipairs
local table = table
local string = string
local math = math

local U = Whale.util

local T = {}
T.SCHEMA = "bws.targetrules/1"

-- 句柄一定是这种形状；模型自己编一个也必须先过这一关（查不到就是 unknown_handle）
-- 注意：Lua 模式**不支持 {n,m} 量词**（{1,8} 会被当成字面量），所以用 + 配下面的长度检查。
T.HANDLE_PATTERN = "^h[0-9a-z]+$"
T.HANDLE_MAX_LEN = 10

--- 默认搜索半径（格）。模型可以给 radius 覆盖（上限见 MAX_RADIUS）。
T.DEFAULT_RADIUS = 16
T.MAX_RADIUS = 40

--- 每个动作自己的"够得着"上限（格）。和 guard / actions 里**同一套数字**，
--- 不许这边给一套、那边判一套 —— 否则"找到了却永远被判 out_of_range"。
T.REACH_TILES = {
    pickup = 2.5,   -- = G.PICKUP_MAX_TILES
    food = 2.5,
    harvest = 4,    -- harvestrules.InNativeRange 兜底值（物理半径 + 4 世界单位）；实际另有精算
    -- ★ 砍树/挖矿：原生 CHOP/MINE 的 `arrivedist` 允许引擎自己走最后一小步，
    --   所以"够得着"不等于"贴脸"。1.6 太紧：真机里玩家站在矿旁边 1.8 格就被拒，
    --   而且角色稍微一动（被推开/自己走）就错过。2.5 格是原生动作能自己补上的范围。
    work = 2.5,
}

-- ─────────────────────────── 固定枚举 ───────────────────────────

--- 动作类型：pickup（捡）/ food（捡来吃）/ chop / mine / harvest（采植株）
T.KIND_ACTION = {
    -- 地面材料（pickup_nearest）
    flint = "pickup",
    twigs = "pickup",
    cutgrass = "pickup",
    log = "pickup",
    rocks = "pickup",
    goldnugget = "pickup",
    charcoal = "pickup",
    petals = "pickup",
    -- 地面食物（pickup_food）
    safe_ground_food = "food",
    carrot = "food",
    berries = "food",
    berries_juicy = "food",
    pumpkin = "food",
    corn = "food",
    eggplant = "food",
    honey = "food",
    meat = "food",
    smallmeat = "food",
    froglegs = "food",
    fish = "food",
    -- 砍树（chop_nearest）
    tree = "chop",
    -- 挖矿（mine_nearest）
    ordinary_rock = "mine",
    gold_vein = "mine",
    -- 采成熟食物植株（harvest_nearest）
    ripe_food_plant = "harvest",
    berrybush = "harvest",
    juicy_berrybush = "harvest",
    carrot_plant = "harvest",
    mushroom = "harvest",
}

--- 每个 kind 的 prefab 白名单。pickup/food 类就是"那个 prefab 本身"。
--- 显式列出，绝不用"名字里带 xxx"来猜（除了下面单独说明的树的前缀表）。
T.KIND_PREFABS = {
    flint = { flint = true },
    twigs = { twigs = true },
    cutgrass = { cutgrass = true },
    log = { log = true },
    rocks = { rocks = true },
    goldnugget = { goldnugget = true },
    charcoal = { charcoal = true },
    petals = { petals = true },
    carrot = { carrot = true },
    berries = { berries = true },
    berries_juicy = { berries_juicy = true },
    pumpkin = { pumpkin = true },
    corn = { corn = true },
    eggplant = { eggplant = true },
    honey = { honey = true },
    meat = { meat = true },
    smallmeat = { smallmeat = true },
    froglegs = { froglegs = true },
    fish = { fish = true },
    ordinary_rock = {
        rock1 = true,
        rock_flintless = true,
        rock_flintless_med = true,
        rock_flintless_low = true,
    },
    gold_vein = { rock2 = true },
    berrybush = { berrybush = true, berrybush2 = true },
    juicy_berrybush = { berrybush_juicy = true },
    carrot_plant = { carrot_planted = true },
    mushroom = { red_mushroom = true, green_mushroom = true, blue_mushroom = true },
}

--- 树的 prefab **前缀**白名单（evergreens.lua 的树名是拼出来的，逐条列会和游戏更新漂移）。
--- 前缀之外还**必须**满足 workable.action == CHOP —— 树桩（DIG）会被自动排除。
T.TREE_PREFIXES = {
    "evergreen",
    "twiggy",
    "deciduoustree",
    "marsh_tree",
    "mushtree",
    "livingtree",
    "marbletree",
    "winter_tree",
    "moontree",
    "palmconetree",
    "driftwood",
}

--- "任意成熟食物植株"的并集（Node 侧 kindPrefabs('ripe_food_plant') 必须和它一致）
T.RIPE_FOOD_PLANT_PREFABS = {
    berrybush = true,
    berrybush2 = true,
    berrybush_juicy = true,
    carrot_planted = true,
    red_mushroom = true,
    green_mushroom = true,
    blue_mushroom = true,
}

--- 地面安全食物 = eatrules.AUTO_SAFE（**不含生蘑菇**）。
--- 自动进食不能为了 +12.5 饥饿把角色送进"掉 50 理智"的状态。
--- 手动 eat 仍然可以指定蘑菇（那是另一条路，走 eatrules.FOODS）。
local function auto_safe_food_prefabs()
    local eat = Whale ~= nil and Whale.eatrules or nil
    if eat == nil or eat.AUTO_SAFE == nil then return {} end
    return eat.AUTO_SAFE
end

--- 找树时按前缀匹配（其余 kind 一律精确匹配 T.KIND_PREFABS）
function T.PrefabAllowed(kind, prefab)
    if type(prefab) ~= "string" then return false end
    if kind == "tree" then
        for i = 1, #T.TREE_PREFIXES do
            if string.sub(prefab, 1, #T.TREE_PREFIXES[i]) == T.TREE_PREFIXES[i] then return true end
        end
        return false
    end
    -- 两个"并集"类别：它们的白名单是从别处派生的，不在 T.KIND_PREFABS 里各抄一份
    if kind == "ripe_food_plant" then return T.RIPE_FOOD_PLANT_PREFABS[prefab] == true end
    if kind == "safe_ground_food" then return auto_safe_food_prefabs()[prefab] == true end
    local set = T.KIND_PREFABS[kind]
    if set == nil then return false end
    return set[prefab] == true
end

function T.IsKind(name)
    return type(name) == "string" and T.KIND_ACTION[name] ~= nil
end

function T.KindList()
    local out = {}
    for k in pairs(T.KIND_ACTION) do out[#out + 1] = k end
    table.sort(out)
    return out
end

--- 给回执/诊断用：这些 kind 现在都合法（Node 侧同一份枚举，有 parity 测试盯着）
function T.ActionOf(kind)
    return T.KIND_ACTION[kind]
end

-- ─────────────────────────── 候选判定 ───────────────────────────

local function comp(ent, name)
    if ent == nil or ent.components == nil then return nil end
    return ent.components[name]
end

local function safe_call(fn, default)
    local ok, value = pcall(fn)
    if not ok then return default end
    return value
end

--- 实体是不是这一类目标。
--- 返回 (true, nil) 或 (false, reason)。reason 沿用执行器已有的名字。
function T.Matches(kind, ent, actor)
    local action = T.KIND_ACTION[kind]
    if action == nil then return false, "target_kind_not_allowed" end
    if ent == nil then return false, "entity_gone" end
    if actor ~= nil and ent == actor then return false, "is_actor" end
    if safe_call(function() return ent:IsValid() end, false) ~= true then return false, "entity_gone" end
    if safe_call(function() return ent:IsInLimbo() end, false) == true then return false, "in_limbo" end

    local prefab = tostring(ent.prefab or "")
    if not T.PrefabAllowed(kind, prefab) then return false, "prefab_not_allowed" end

    if action == "pickup" or action == "food" then
        -- ★ 与观察侧（nearby 的 pickupables 桶）**共用同一份规则**
        local rules = Whale ~= nil and Whale.pickuprules or nil
        if rules == nil then return false, "pickup_rules_missing" end
        local ok, why = rules.IsCandidate(ent, actor)
        if not ok then return false, why or "target_not_pickable" end
        if action == "food" then
            if comp(ent, "edible") == nil then return false, "target_not_edible" end
            if kind == "safe_ground_food" then
                if auto_safe_food_prefabs()[prefab] ~= true then return false, "food_not_allowed" end
            end
        end
        return true, nil
    end

    if action == "chop" or action == "mine" then
        local w = comp(ent, "workable")
        if w == nil then return false, "target_not_workable" end
        local want = (action == "chop") and "CHOP" or "MINE"
        local ok_a, act = pcall(function() return w.action end)
        if not ok_a or act == nil or tostring(act.id) ~= want then return false, "wrong_work_action" end
        local ok_l, left = pcall(function() return w.workleft end)
        if ok_l and type(left) == "number" and left <= 0 then return false, "already_worked" end
        return true, nil
    end

    if action == "harvest" then
        local hr = Whale ~= nil and Whale.harvestrules or nil
        if hr == nil then return false, "harvest_rules_missing" end
        local ok_c, why_c = hr.IsCandidate(ent, actor)
        if not ok_c then return false, why_c or "target_not_harvestable" end
        -- ★ 未成熟**不是错误**，只是"这一类里现在没有它" —— 由 FindNearest 跳过，
        --   所以这里返回 not_ready，调用方按"不合格"处理。
        local ok_r, why_r = hr.IsReady(ent)
        if not ok_r then return false, why_r or "not_ready" end
        return true, nil
    end

    return false, "target_kind_not_allowed"
end

-- ─────────────────────────── 最近目标 ───────────────────────────

--- 距离上限（格）：
---   · pickup/food 用 2.5（和 guard 的 PICKUP_MAX_TILES 同源）
---   · chop/mine 用 6
---   · harvest 单独走 harvestrules 的原生 PickRangeCheck（物理半径 + 4 世界单位），见 FindNearest
local function reach_tiles(kind)
    local action = T.KIND_ACTION[kind]
    if action == "pickup" or action == "food" then return T.REACH_TILES.pickup end
    if action == "harvest" then return T.REACH_TILES.harvest end
    return T.REACH_TILES.work
end

--- 在半径内找最近的、**当前可操作**的该类目标。
--- 返回：
---   命中           → ent, nil, { distance = 格数, reachable = true }
---   找到但够不着   → nil, "out_of_range", { distance, nearest = {prefab,x,z,label} }   ← 让模型知道该往哪走
---   一类都没有     → nil, "no_target", { searched = n, rejected = m }
function T.FindNearest(kind, actor, radius)
    if not T.IsKind(kind) then return nil, "target_kind_not_allowed", nil end
    if actor == nil then return nil, "no_actor", nil end
    local r = tonumber(radius) or T.DEFAULT_RADIUS
    if r < 2 then r = 2 end
    if r > T.MAX_RADIUS then r = T.MAX_RADIUS end

    local x, y, z = U.pos(actor)
    if x == nil then return nil, "no_position", nil end

    local ok, ents = pcall(function()
        return GLOBAL.TheSim:FindEntities(x, y, z, r * U.TILE, nil, { "INLIMBO" }, nil)
    end)
    if not ok or ents == nil then return nil, "scan_failed", nil end

    local hr = Whale ~= nil and Whale.harvestrules or nil
    local best, best_tiles, best_dist = nil, nil, nil
    local nearest_any = nil  -- 即使够不着也记下来，好让模型先 move_to
    local searched, rejected = 0, 0

    for i = 1, #ents do
        local e = ents[i]
        if e ~= nil and e ~= actor and safe_call(function() return e:IsValid() end, false) == true then
            searched = searched + 1
            local okm = T.Matches(kind, e, actor)
            if okm then
                local d = U.dist(actor, e)
                if d ~= nil then
                    local tiles = d / U.TILE
                    if nearest_any == nil or tiles < nearest_any.tiles then
                        nearest_any = { tiles = tiles, ent = e }
                    end
                    local limit = nil
                    if T.KIND_ACTION[kind] == "harvest" and hr ~= nil and hr.InNativeRange ~= nil then
                        -- pcall(hr.InNativeRange, actor, e) → true, ok, limit(世界单位), dist
                        local ok_c, r_ok, r_limit = pcall(hr.InNativeRange, actor, e)
                        if ok_c and r_ok == true and type(r_limit) == "number" then
                            limit = r_limit / U.TILE
                        else
                            -- 距离判定失败：按兜底值走，别把"算不出来"当"够得着"
                            limit = T.REACH_TILES.harvest
                        end
                    else
                        limit = reach_tiles(kind)
                    end
                    if limit == nil or tiles <= limit then
                        if best_tiles == nil or tiles < best_tiles then
                            best, best_tiles, best_dist = e, tiles, d
                        end
                    end
                end
            else
                rejected = rejected + 1
            end
        end
    end

    if best ~= nil then
        return best, nil, { distance = best_tiles, reachable = true }
    end
    if nearest_any ~= nil then
        local nx, _, nz = U.pos(nearest_any.ent)
        local tx, tz = U.tile_of(nx, nz)
        return nil, "out_of_range", {
            distance = nearest_any.tiles,
            nearest = {
                prefab = tostring(nearest_any.ent.prefab or "?"),
                label = U.pretty(nearest_any.ent),
                x = tx, z = tz,
            },
        }
    end
    return nil, "no_target", { searched = searched, rejected = rejected }
end

--- 给回执用的一句话（说明"附近到底有没有、多远"）
function T.ExplainMiss(kind, why, detail)
    local action = T.KIND_ACTION[kind] or "?"
    if why == "out_of_range" and detail ~= nil and detail.nearest ~= nil then
        return string.format("最近的一处 %s（%s）在 %s 格外 (%s,%s)：先 move_to 过去再试",
            kind, tostring(detail.nearest.label or detail.nearest.prefab),
            tostring(math.floor((detail.distance or 0) * 10 + 0.5) / 10),
            tostring(detail.nearest.x), tostring(detail.nearest.z))
    end
    if why == "no_target" then
        return string.format("附近没有可%s的 %s（扫到 %d 个实体，%d 个类型不符）",
            action == "chop" and "砍" or action == "mine" and "挖" or action == "harvest" and "采" or "捡",
            kind, tonumber(detail ~= nil and detail.searched or 0) or 0,
            tonumber(detail ~= nil and detail.rejected or 0) or 0)
    end
    return nil
end

-- ─────────────────────────── 稳定句柄（方案 B）───────────────────────────
--
-- 要求（任务书 §1 方案 B）：
--   · 目标在多次附近扫描中仍然有效时，句柄保持稳定
--   · 目标消失 / 被采集 / 被其他玩家拾取时，句柄失效
--   · 句柄绑定当前游戏会话和角色
--   · 句柄不能由模型自行生成
--   · Lua 执行前必须重新检查真实实体
--   · 句柄过期时拒绝执行，绝不自动替换成其他对象
--
-- 实现要点：
--   · 句柄值 = "h" + base36(单调序号)。**不含 GUID**，也不含坐标/世界信息。
--   · 键 = prefab|tile_x|tile_z（量化到格子）。位置与 prefab 都没变 → 同一个句柄。
--   · 序号在**进程内单调递增且不重置**，所以换世界/重进游戏后旧句柄值不会"复活"。
--   · 注册表额外记录 epoch（runtime_id|session_id|actor_id）；换了就不认。

local handles = {}        -- handle -> { key, ent, seen }
local handle_by_key = {}  -- key -> handle
local handle_seq = 0
local handle_epoch = nil
local scan_mark = 0
-- 墓碑：句柄一旦失效就记下"为什么失效"，这样模型拿到的是**准确原因**
-- （target_gone / target_taken / in_limbo），而不是含糊的 unknown_handle。
-- 有界（环形）保存，避免越攒越多。换会话/换世界时连同 handles 一起清空 ——
-- 那时"这是上一次运行里的句柄"才应该报 unknown_handle。
local expired = {}
local expired_order = {}
local EXPIRED_MAX = 128

local function base36(n)
    local digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    local v = math.floor(tonumber(n) or 0)
    if v <= 0 then return "0" end
    local out = {}
    while v > 0 do
        local d = v % 36
        out[#out + 1] = string.sub(digits, d + 1, d + 1)
        v = math.floor(v / 36)
    end
    local rev = {}
    for i = #out, 1, -1 do rev[#rev + 1] = out[i] end
    return table.concat(rev)
end

local function entity_key(ent)
    if ent == nil then return nil end
    local prefab = ent.prefab
    if prefab == nil then return nil end
    local x, _, z = U.pos(ent)
    if x == nil then return nil end
    local tx, tz = U.tile_of(x, z)
    return tostring(prefab) .. "|" .. tostring(tx) .. "|" .. tostring(tz)
end

--- 句柄为什么失效（墓碑上用；要具体，不能一律 unknown_handle）
local function expiry_reason(ent)
    if ent == nil then return "target_gone" end
    if safe_call(function() return ent:IsValid() end, false) ~= true then return "target_gone" end
    if safe_call(function() return ent:IsInLimbo() end, false) == true then return "in_limbo" end
    local item = comp(ent, "inventoryitem")
    if item ~= nil and safe_call(function() return item.owner end, nil) ~= nil then return "target_taken" end
    return "target_gone"
end

local function drop_handle(h, reason)
    local rec = handles[h]
    if rec ~= nil then handle_by_key[rec.key] = nil end
    handles[h] = nil
    if expired[h] == nil then expired_order[#expired_order + 1] = h end
    expired[h] = reason or "target_gone"
    -- 有界：超了就把最早的墓碑丢掉（丢掉的会退回 unknown_handle，仍然安全）
    while #expired_order > EXPIRED_MAX do
        local old = table.remove(expired_order, 1)
        expired[old] = nil
    end
end

--- 绑定当前会话。epoch 变了就整个清空（旧句柄必须查不到）。
function T.BindSession(runtime_id, session_id, actor_id)
    local epoch = table.concat({
        tostring(runtime_id or "?"), tostring(session_id or "?"), tostring(actor_id or "?"),
    }, "|")
    if handle_epoch ~= epoch then
        handle_epoch = epoch
        handles = {}
        handle_by_key = {}
        -- 换会话/换世界：墓碑也一起清掉 —— 这时"上一次运行的句柄"应该报 unknown_handle
        expired = {}
        expired_order = {}
        -- 注意：handle_seq **不**重置 —— 同一进程里旧句柄值绝不复用。
    end
    return epoch
end

function T.SessionBound()
    return handle_epoch ~= nil
end

--- 一个实体"值不值得给句柄"：只要它可能是某类目标就发。
--- 用 T.MatchesAny 而不是列出所有 kind —— 免得新增 kind 忘了在这里登记。
-- 按"需要什么组件"把类别分三组，避免对每个实体把 26 个类别全试一遍
--（真机半径 16 格有 200 来个实体，26×200 次 Matches 每个还要 pcall 好几下，没必要）。
local KIND_BY_FAMILY = nil
local function kinds_by_family()
    if KIND_BY_FAMILY == nil then
        local fam = { item = {}, work = {}, pick = {} }
        local list = T.KindList()
        for i = 1, #list do
            local kind = list[i]
            local a = T.KIND_ACTION[kind]
            if a == "pickup" or a == "food" then
                fam.item[#fam.item + 1] = kind
            elseif a == "chop" or a == "mine" then
                fam.work[#fam.work + 1] = kind
            else
                fam.pick[#fam.pick + 1] = kind
            end
        end
        KIND_BY_FAMILY = fam
    end
    return KIND_BY_FAMILY
end

--- 句柄的发放条件比"现在能不能动作"宽一档：
--- 未成熟 / 已采空 / 卡住 / 已挖空 的实体**仍然发句柄**（它还在世界里，只是这一会儿不能动）。
--- 这样"句柄"表达的是"这个目标还在不在"，而"现在能不能动"始终由 guard 用 T.Matches 现判 ——
--- 两件事分开，才不会出现"目标明明还在，模型却只能靠猜 #N 重来"。
local HANDLE_TOLERANT_REASONS = {
    not_ready = true,
    already_harvested = true,
    target_busy = true,
    already_worked = true,
}

local function any_of(kinds, ent, actor)
    for i = 1, #kinds do
        local ok, why = T.Matches(kinds[i], ent, actor)
        if ok then return true end
        if HANDLE_TOLERANT_REASONS[why] == true then return true end
    end
    return false
end

function T.MatchesAny(ent, actor)
    if ent == nil then return false end
    local fam = kinds_by_family()
    if comp(ent, "inventoryitem") ~= nil and any_of(fam.item, ent, actor) then return true end
    if comp(ent, "workable") ~= nil and any_of(fam.work, ent, actor) then return true end
    if comp(ent, "pickable") ~= nil and any_of(fam.pick, ent, actor) then return true end
    return false
end

--- 句柄也要覆盖 **gather 类目标**（草丛 / 树苗 / 花）。
---
--- 为什么：`gather` 也是接受 `target_handle` 的那 16 个动作之一。如果只给 harvest 类发句柄，
--- 模型就会遇到"工具说明说能用句柄、实际永远拿不到句柄"—— 这正是本仓库最忌讳的说明书漂移。
--- 它们没有对应的 target_kind（gather 和 harvest 是两条不同的执行链，不硬塞进同一个枚举），
--- 所以单独判一次候选资格即可；**成熟度仍然由 guard 用 gatherrules.IsReady 现判**。
function T.IsGatherable(ent, actor)
    local gr = Whale ~= nil and Whale.gatherrules or nil
    if gr == nil or gr.IsCandidate == nil then return false end
    local ok = gr.IsCandidate(ent, actor)
    return ok == true
end

--- 这个实体值不值得发句柄（= 任何一类目标 + gather 类目标）
function T.WorthHandle(ent, actor)
    if ent == nil then return false end
    if T.MatchesAny(ent, actor) then return true end
    return T.IsGatherable(ent, actor)
end

--- 每帧扫描后调用：给这一帧看到的可操作实体续期/分配句柄，并清掉这帧没看到的。
--- list = nearby 的完整扫描条目数组（{ block = ..., ent = ... }），截断前的那一份。
function T.NoteScan(list, actor)
    scan_mark = scan_mark + 1
    local mark = scan_mark
    if type(list) == "table" then
        for i = 1, #list do
            local entry = list[i]
            local ent = entry ~= nil and entry.ent or nil
            if ent ~= nil and T.WorthHandle(ent, actor) then
                local key = entity_key(ent)
                if key ~= nil then
                    local h = handle_by_key[key]
                    if h == nil then
                        handle_seq = handle_seq + 1
                        h = "h" .. base36(handle_seq)
                        handle_by_key[key] = h
                        handles[h] = { key = key, ent = ent, seen = mark }
                    else
                        local rec = handles[h]
                        if rec == nil then
                            handles[h] = { key = key, ent = ent, seen = mark }
                        else
                            rec.ent = ent
                            rec.seen = mark
                        end
                    end
                    if entry.block ~= nil then entry.block.handle = h end
                end
            end
        end
    end
    -- ★ 这一帧**没看到**就失效（不留容差）。
    --   为什么不留"一帧容差"：可操作实体（inventoryitem / pickable / workable）在 nearby 的
    --   `interesting()` 判据下是**稳定**的，不会今天有趣明天没趣；所以"这一帧没扫到"就等于
    --   "它已经不在附近了"。留容差会让模型拿一个已经消失的句柄继续操作 —— 方向性的错误，
    --   而"句柄提前失效"最多让模型重新 get_state 一次。失败要安全。
    local dead = {}
    for h, rec in pairs(handles) do
        if rec.seen < mark then dead[#dead + 1] = h end
    end
    for i = 1, #dead do
        local h = dead[i]
        local rec = handles[h]
        drop_handle(h, rec ~= nil and expiry_reason(rec.ent) or "target_gone")
    end
end

--- 句柄 → 真实实体。**执行前必须调用**，且绝不做任何"替代搜索"。
function T.ResolveHandle(handle)
    if type(handle) ~= "string" or handle == "" then return nil, "bad_handle" end
    -- 长度和 Node 侧的正则 ^h[0-9a-z]{1,8}$ 对齐：最少 "h1"（2 字符），最多 9 字符
    if #handle < 2 or #handle > 9 then return nil, "bad_handle" end
    if string.match(handle, T.HANDLE_PATTERN) == nil then return nil, "bad_handle" end
    local rec = handles[handle]
    if rec == nil then
        -- 已经失效过的句柄：给出**具体原因**（target_gone / target_taken / in_limbo），
        -- 而不是含糊的 unknown_handle。绝不做任何"替代搜索"。
        local why = expired[handle]
        if why ~= nil then return nil, why end
        return nil, "unknown_handle"
    end
    local ent = rec.ent
    if ent == nil or safe_call(function() return ent:IsValid() end, false) ~= true then
        drop_handle(handle, "target_gone")
        return nil, "target_gone"
    end
    if safe_call(function() return ent:IsInLimbo() end, false) == true then
        drop_handle(handle, "in_limbo")
        return nil, "in_limbo"
    end
    -- 被人捡走了：句柄立刻作废（不换成"地上另一个同类"）
    local item = comp(ent, "inventoryitem")
    if item ~= nil and safe_call(function() return item.owner end, nil) ~= nil then
        drop_handle(handle, "target_taken")
        return nil, "target_taken"
    end
    return ent, nil
end

--- 诊断/测试用
function T.HandleCount()
    local n = 0
    for _ in pairs(handles) do n = n + 1 end
    return n
end

function T.ResetHandles()
    handles = {}
    handle_by_key = {}
    expired = {}
    expired_order = {}
    handle_epoch = nil
    scan_mark = 0
    -- handle_seq 故意不重置
end

Whale = Whale or {}
Whale.targetrules = T
