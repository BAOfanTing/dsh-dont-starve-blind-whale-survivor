-- 附近实体：结构化观察（M1.4）
--
-- 职责（只做观察，不做任何动作）：
--   1. 扫一次附近实体（TheSim:FindEntities），按「能对它做什么」分类成桶
--   2. 给每个实体分配短引用 #1..#N（绑在**扫描快照**上，不是永久 ID）
--   3. 数量上限（总量 + 单桶）+ 确定性排序 + 截断标记
--   4. 相邻两次成功扫描之间的 delta（新增 / 消失 / 变化）
--   5. 扫描结果按 OBSERVER_SCAN_SECONDS 缓存；缓存命中时**引用和 delta 原样复用**
--
-- 边界：
--   · 引用 #N 只在同一个 nearby.snapshot_id 内有效；解析靠 Lua 内部的 refs 表，
--     **不把 GUID 发给模型**（GUID 只用于 Lua 内部跨扫描匹配同一个实体）。
--   · 只比较「相邻两次成功扫描」；Session / Shard 变了、上次扫描失败 → 重建 baseline。
--   · 不认识的实体不进任何桶（避免 fx/装饰把预算吃光），除非它确实有观察价值。
local GLOBAL = GLOBAL
-- 饥荒的模组沙箱只给了 pairs/ipairs/print/math/table/type/string/tostring/require/Class，
-- pcall / tonumber / error / os / io 这些得从 GLOBAL（就是 _G）里拿，直接用会报 nil（0.1.0 就是这么崩的）。
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local type = type
local os = GLOBAL.os or { time = function() return 0 end }

local U = Whale.util
local N = {}

--- 运行实例号：模块每加载一次就换一个（= 一次"运行实例"：游戏启动 / 重新进世界）。
--- 为什么需要它：scan_seq 每次运行都从 1 开始，如果 snapshot_id 只有 "n1"，游戏重启后
--- 新实例也会产出 "n1"；Node/M2 拿着上一次运行的 (#1, n1) 来解析，就会命中**另一个实体**。
--- Session 不可靠：真机测过两次重启 session_id 没变。所以必须有"这是哪一次运行"的标识。
local RUNTIME_ID = (function()
    local stamp = 0
    if os ~= nil and os.time ~= nil then
        local ok, value = pcall(os.time)
        if ok and tonumber(value) ~= nil then stamp = tonumber(value) end
    end
    local salt = 0
    if math ~= nil and math.random ~= nil then
        local ok, value = pcall(math.random, 1000, 9999)
        if ok and tonumber(value) ~= nil then salt = tonumber(value) end
    end
    return string.format("r%d-%04d", stamp, salt)
end)()

function N.runtime_id()
    return RUNTIME_ID
end

N.SCHEMA = "bws.nearby/1"

--- 桶顺序 = 展示优先级（同时也是给 #N 编号的顺序，必须确定、可复现）
N.BUCKETS = {
    { key = "threats", label = "威胁" },
    -- M2.2：可行动目标（当前 = 拾取候选）单独成桶。
    -- 放在 threats 之后、food/resources 之前：既不会被植物挤掉，也不会把威胁挤掉。
    { key = "pickupables", label = "可拾取物" },
    -- M2.3：可收获对象（本阶段 = 成熟浆果丛）单独成桶。
    -- 理由：浆果丛原本落在 food 桶，真机上 food 已经 12/12 满过（会被挤掉），
    -- 而且旧 Schema 根本没有"现在成不成熟"的字段 —— 模型看不出能不能采。
    { key = "harvestables", label = "可收获" },
    { key = "food", label = "食物" },
    { key = "resources", label = "资源" },
    { key = "containers", label = "容器" },
    { key = "structures", label = "建筑" },
    { key = "creatures", label = "生物" },
    { key = "other", label = "其它" },
}

local BUCKET_ORDER = {}
for i, bucket in ipairs(N.BUCKETS) do BUCKET_ORDER[bucket.key] = i end

--- 空表也要序列化成 [] 的地方用它（详见 json.lua 的 J.ARRAY 说明）
local function arr(tbl)
    local json = Whale ~= nil and Whale.json or nil
    if json ~= nil and json.arr ~= nil then return json.arr(tbl) end
    return tbl
end

-- ─────────────────────────── 分类依据（全部来自真实 tag/组件）───────────────────────────

--- 采下来是「能吃的东西」的源头（用来判断可采物属于 food 还是 resources）
local FOOD_SOURCES = {
    berrybush = true, berrybush2 = true, berrybush_juicy = true,
    carrot_planted = true, carrot = true,
    mushroom = true, red_mushroom = true, green_mushroom = true, blue_mushroom = true,
    corn = true, pumpkin = true, eggplant = true, watermelon = true, pomegranate = true,
    dragonfruit = true, durian = true, lichen = true, stonefruit = true,
}

--- 玩家真正能当食物用的 foodtype（**白名单**：不确定就当"不是食物"，失败要安全）。
--- 依据本机 scripts/constants.lua 的 FOODTYPE 全表（19 种）+ scripts/components/edible.lua：
---   · edible 组件默认 foodtype = GENERIC（edible.lua:24），所以真食物不会"读不到类型"；
---   · 排除的是给动物/特殊生物用的类型（游戏注释已说明）：
---     ELEMENTAL(燧石/石头/金块) NITRE(硝石) GEARS(齿轮) WOOD(木头) ROUGHAGE(树枝/草)
---     SEEDS(种子) RAW(需烹饪) BURNT(给 lavae) LUNAR_SHARDS/CORPSE/MIASMA(裂隙生物)
---     BERRY(注释：只是给小鸟的 hack，浆果本体是 VEGGIE)
--- 真机 bug（M2.1 发现）：flint 带 edible 且 foodtype=ELEMENTAL，旧逻辑只排除 3 项 → 被判成 food。
local FOODTYPE = GLOBAL.FOODTYPE
local PLAYER_FOOD_TYPES = {}
-- 防御：某些构建/测试环境可能没有 FOODTYPE（或只有部分键），缺了就当"不是这类食物"
if FOODTYPE ~= nil then
    for _, key in ipairs({ "GENERIC", "MEAT", "VEGGIE", "HORRIBLE", "INSECT", "GOODIES", "MONSTER" }) do
        if FOODTYPE[key] ~= nil then PLAYER_FOOD_TYPES[FOODTYPE[key]] = true end
    end
end

local function is_real_food(edible)
    if edible == nil then return false end
    local foodtype = edible.foodtype
    -- 读不到类型：不当食物（旧逻辑在这里默认 true，等于"有 edible 就算食物"）
    if foodtype == nil then return false end
    return PLAYER_FOOD_TYPES[foodtype] == true
end

local function has_tag(ent, tag)
    return ent ~= nil and ent:HasTag(tag)
end

local function comp(ent, name)
    return ent ~= nil and ent.components ~= nil and ent.components[name] or nil
end

local function health_of(ent)
    local h = comp(ent, "health")
    if h == nil then return nil end
    local ok, cur = pcall(function() return h.currenthealth end)
    if not ok or cur == nil then return nil end
    local ok2, max = pcall(function() return h.maxhealth end)
    if not ok2 then max = nil end
    local ok3, dead = pcall(function() return h:IsDead() end)
    return cur, max, (ok3 and dead) or false
end

local function work_action_of(ent)
    local w = comp(ent, "workable")
    if w == nil or w.action == nil then return nil end
    return w.action.id
end

local NEAR_ZONE_RADIUS = 16

-- 远景雷达只保留的关键实体/稀缺资源/地标/威胁（白名单）
local RADAR_KEY_PREFABS = {
    -- 矿石与地下产物
    rock1 = true, rock2 = true, rock_flintless = true, rock_flintless_med = true, rock_flintless_low = true,
    rock_petrified_tree = true, rock_petrified_tree_med = true, rock_petrified_tree_low = true,
    nitre = true, marblepillar = true, marbletree = true,
    -- 地面稀缺/高价值材料
    flint = true, goldnugget = true, gears = true, marble = true, redgem = true, bluegem = true, houndstooth = true,
    -- 食物/成熟植株
    carrot = true, carrot_planted = true,
    -- 蜂巢/蜂箱/关键巢穴
    beehive = true, wasphive = true, beebox = true,
    spiderden = true, spiderden_2 = true, spiderden_3 = true,
    tallbirdnest = true, houndmound = true,
    -- 发条怪与关键机械
    knight = true, bishop = true, rook = true,
    knight_nightmare = true, bishop_nightmare = true, rook_nightmare = true,
    -- 关键生物房/建筑
    pighouse = true, rabbithouse = true, mermhouse = true,
}

--- 远景雷达区（16~32格）分层过滤：只看关键地标与稀缺资源，防 Token 爆炸
local function interesting_radar(ent, actor)
    if ent == nil or not ent:IsValid() then return false end
    local prefab = ent.prefab and string.lower(tostring(ent.prefab)) or ""

    -- 1. 显式过滤远景杂物：小鸟、蝴蝶、地皮碎片
    if has_tag(ent, "bird") or prefab == "crow" or prefab == "robin" or prefab == "robin_winter" or prefab == "canary" or prefab == "seagull" then
        return false
    end
    if prefab == "butterfly" or string.find(prefab, "turf_", 1, true) ~= nil then
        return false
    end

    -- 2. 矿石（普通岩石、金矿脉、硝石矿等）：可开采的矿物
    local w = work_action_of(ent)
    if w == "MINE" then return true end

    -- 3. 显式白名单内的关键 prefab（发条怪、蜂巢、猪人房、高价值矿物/材料等）
    if RADAR_KEY_PREFABS[prefab] then return true end

    -- 4. 关键建筑/地标/工作台
    if has_tag(ent, "structure") or comp(ent, "prototyper") ~= nil then
        return true
    end

    -- 5. 成熟食物（成熟浆果丛、胡萝卜等食物源）
    local item = comp(ent, "inventoryitem")
    local edible = comp(ent, "edible")
    local h = comp(ent, "health")
    local ground_item = item ~= nil and item.owner == nil and h == nil
    if ground_item and is_real_food(edible) then
        return true
    end
    if FOOD_SOURCES[prefab] then
        if (has_tag(ent, "pickable") and not has_tag(ent, "barren")) or comp(ent, "pickable") ~= nil then
            return true
        end
        local hr = comp(ent, "harvestable")
        if hr ~= nil and hr.CanBeHarvested ~= nil then
            local ok, ready = pcall(function() return hr:CanBeHarvested() end)
            if ok and ready then return true end
        end
    end

    -- 6. 危险威胁与关键首领（仇恨锁定我们，或者发条/首领级怪物）
    local combat = comp(ent, "combat")
    if combat ~= nil and combat.target ~= nil and combat.target == actor then
        return true
    end
    if has_tag(ent, "epic") or has_tag(ent, "chess") or has_tag(ent, "hound") then
        return true
    end

    -- 远距离普通的树木（CHOP）、普通草丛树苗花朵、地面的树枝草叶等一律过滤
    return false
end

N.InterestingRadar = interesting_radar
N.NEAR_ZONE_RADIUS = NEAR_ZONE_RADIUS

--- 判断这个实体值不值得进 nearby（不认识的 fx/装饰一律不进）
local function interesting(ent)
    if comp(ent, "health") ~= nil then return true end
    if comp(ent, "workable") ~= nil then return true end
    if comp(ent, "harvestable") ~= nil then return true end
    -- M2.3：可收获植物（浆果丛等）。注意 pickable **标签**只在"现在能采"时才存在，
    -- 所以这里看组件，否则被采过的植株会从观察里消失。
    if comp(ent, "pickable") ~= nil then return true end
    -- SURVIVAL-01：白名单里的采集对象一定算"值得看"
    local gr0 = Whale ~= nil and Whale.gatherrules or nil
    if gr0 ~= nil and gr0.IsCandidate(ent, nil) then return true end
    if comp(ent, "inventoryitem") ~= nil then return true end
    if comp(ent, "container") ~= nil then return true end
    if comp(ent, "fueled") ~= nil then return true end
    if comp(ent, "prototyper") ~= nil then return true end
    if comp(ent, "combat") ~= nil then return true end
    if has_tag(ent, "structure") or has_tag(ent, "pickable") or has_tag(ent, "hostile") then return true end
    return false
end

--- 分类：一个实体只会得到一个 category（优先级从上到下）
local function classify_base(ent, actor)
    if ent == nil then return nil end

    local h = comp(ent, "health")
    local _, _, dead = health_of(ent)
    local combat = comp(ent, "combat")

    -- 1) 威胁：hostile 标签；或者正在打我们（有些怪没有 hostile 标签但有 combat.target）
    if h ~= nil and not dead then
        if has_tag(ent, "hostile") then return "threats" end
        if combat ~= nil and combat.target ~= nil and combat.target == actor then return "threats" end
    end

    local item = comp(ent, "inventoryitem")
    local edible = comp(ent, "edible")
    local pickable = has_tag(ent, "pickable") and not has_tag(ent, "barren")
    local harvestable = comp(ent, "harvestable") ~= nil
    local work = work_action_of(ent)

    -- 地上物品：**必须没有 health**。红雀/南瓜灯这类"带 inventoryitem 的生物/设施"不算掉落物
    -- （真机踩到：红雀因为带 inventoryitem 被归到 resources；南瓜灯也是）
    local ground_item = item ~= nil and item.owner == nil and h == nil

    -- 2) 食物：地上真能吃的，或采下来就是吃的（树枝/种子/齿轮这种"能吃但不算食物"的不算）
    if ground_item and is_real_food(edible) then return "food" end
    if pickable or harvestable then
        local prefab = string.lower(tostring(ent.prefab or ""))
        if FOOD_SOURCES[prefab] then return "food" end
        for source in pairs(FOOD_SOURCES) do
            if string.find(prefab, source, 1, true) ~= nil then return "food" end
        end
    end

    -- 3) 资源：能砍/挖/铲/拆的，能采的非食物，地上的材料/工具/燃料
    if work ~= nil then return "resources" end
    if pickable or harvestable then return "resources" end
    if ground_item then return "resources" end

    -- 4) 容器（箱子、冰箱、锅这类带 container 的）
    if comp(ent, "container") ~= nil then return "containers" end

    -- 5) 建筑 / 工作站 / 火堆 / 光源（南瓜灯这类摆出来的照明设施）
    if has_tag(ent, "structure") then return "structures" end
    if comp(ent, "prototyper") ~= nil then return "structures" end
    if comp(ent, "fueled") ~= nil and has_tag(ent, "fire") then return "structures" end
    if has_tag(ent, "light") and not has_tag(ent, "player") then return "structures" end

    -- 6) 生物：有血但不是敌对（猪人、兔子、牛、红雀……）
    if h ~= nil then return "creatures" end
    if has_tag(ent, "animal") or has_tag(ent, "monster") then return "creatures" end

    -- 7) 兜底
    return "other"
end

--- M2.2：在七类之上加一层"可行动目标"分流。
--- 返回 (category, item_kind)：
---   · category 永远是**单一**桶名 —— 一个实体在一个快照里只能出现在一个桶里；
---   · item_kind 只在 pickupables 时有值，表示它原本的语义类别（food / resources / …），
---     这样"可拾取"不会丢掉"它是什么东西"的信息。
--- 威胁优先：能打我们的东西绝不能被"可拾取物"挤掉。
--- 候选判定与 pickup 执行器共用 Whale.pickuprules（观察-执行一致）。
function N.Classify(ent, actor)
    local base = classify_base(ent, actor)
    if base == nil then return nil end
    if base == "threats" then return "threats" end
    local rules = Whale ~= nil and Whale.pickuprules or nil
    if rules ~= nil and rules.IsCandidate(ent, actor) then
        return "pickupables", base
    end
    -- M2.3：可收获对象（与 pickup 一样：只看候选资格，不看成熟度和距离）
    local hr = Whale ~= nil and Whale.harvestrules or nil
    if hr ~= nil and hr.IsCandidate(ent, actor) then
        return "harvestables", base
    end
    -- SURVIVAL-01：草丛/树苗也放进同一个"可收获"桶（执行侧按 prefab 分流到 gather）
    local gr = Whale ~= nil and Whale.gatherrules or nil
    if gr ~= nil and gr.IsCandidate(ent, actor) then
        return "harvestables", base
    end
    return base
end

-- ─────────────────────────── 实体 → 紧凑字段 ───────────────────────────

--- 高精度计时（毫秒）。用于 measure 单次扫描耗时。
--- 优先级：
---   1) os.clock()  —— CPU 时间，亚毫秒精度（测"这段函数花了多久"最合适）
---   2) TheSim:GetRealTime() —— 引擎真实时间，单位**毫秒**（见 docs/reference/mainfunctions.lua:608/612，原版源码参考副本）
---   两个都拿不到就返回 nil（调用方写 null，不伪装成 0）
--- 返回：(毫秒 | nil, 来源字符串)
local function clock_ms()
    if os ~= nil and os.clock ~= nil then
        local ok, value = pcall(os.clock)
        if ok and tonumber(value) ~= nil then
            return tonumber(value) * 1000, "os.clock"
        end
    end
    local sim = GLOBAL.TheSim
    if sim ~= nil and sim.GetRealTime ~= nil then
        local ok, value = pcall(function() return sim:GetRealTime() end)
        if ok and tonumber(value) ~= nil then
            local ms = tonumber(value)
            if ms == ms then return ms, "realtime" end
        end
    end
    return nil, "none"
end

--- 毫秒差 → 保留 1 位小数（亚毫秒的扫描不再被取整成 0）
local function duration_of(started_ms, finished_ms)
    if started_ms == nil or finished_ms == nil then return nil end
    local delta = finished_ms - started_ms
    if delta ~= delta or delta < 0 then return nil end
    return math.floor(delta * 10 + 0.5) / 10
end

local function round1(value)
    if value == nil then return nil end
    return math.floor(value * 10 + 0.5) / 10
end

local function describe(ent, actor, category, item_kind)
    local x, _, z = U.pos(ent)
    if x == nil then return nil end
    local dist = U.dist(actor, ent) / U.TILE
    -- 格子索引（floor，和"你：位置 (12,45)"同一口径）；距离单独保留 1 位小数
    local tx, tz = U.tile_of(x, z)

    local block = {
        ref = nil, -- 截断/排序之后再分配
        prefab = ent.prefab,
        category = category,
        label = U.pretty(ent),
        distance = round1(dist),
        position = { x = round1(tx), z = round1(tz) },
    }
    -- M2.2：可拾取物保留它原本的语义类别（不是所有桶都有这个字段）
    if item_kind ~= nil then block.item_kind = item_kind end

    -- M2.3 / SURVIVAL-01：可收获对象写出"现在成不成熟"和"该用哪个动作"（原生 CanBePicked 等），绝不造百分比
    if category == "harvestables" then
        block.is_harvestable = true
        local hr = Whale ~= nil and Whale.harvestrules or nil
        local gr = Whale ~= nil and Whale.gatherrules or nil
        -- 先看它属于哪一类（浆果丛 → harvest；草/树苗 → gather）
        local is_gather = (gr ~= nil) and gr.IsCandidate(ent, actor) or false
        local rules = is_gather and gr or hr
        if is_gather then
            block.gatherable = true
            block.use_action = "gather"
        else
            block.use_action = "harvest"
        end
        if rules ~= nil then
            local ready = rules.IsReady(ent)
            block.harvest_ready = (ready == true)
            -- 产物：浆果丛有 ReadState；草/树苗用 ProductOf
            local product = nil
            if is_gather then
                product = rules.ProductOf(ent)
            else
                local st = rules.ReadState(ent)
                if st ~= nil then
                    if st.cycles_left ~= nil then block.cycles_left = st.cycles_left end
                    if st.product ~= nil then product = st.product end
                    if st.is_stuck == true then block.is_stuck = true end
                end
            end
            if product ~= nil then block.product = product end
        end
    end

    if category == "threats" or category == "creatures" then
        local cur, max, dead = health_of(ent)
        if cur ~= nil then
            block.is_alive = not dead
            block.health = math.floor(cur)
            if max ~= nil then block.max_health = math.floor(max) end
        end
        local c = comp(ent, "combat")
        if c ~= nil then
            local ok, target = pcall(function() return c.target end)
            if ok and target ~= nil and target == actor then block.targeting_you = true end
        end
    end

    local work = work_action_of(ent)
    if work ~= nil then
        block.is_workable = true
        block.work_action = work
    end
    if comp(ent, "harvestable") ~= nil then
        local ok, can = pcall(function() return comp(ent, "harvestable"):CanBeHarvested() end)
        block.is_harvestable = (ok and can == true)
    end

    local item = comp(ent, "inventoryitem")
    local health_comp = comp(ent, "health")
    if item ~= nil and item.owner == nil and health_comp == nil then
        block.stack_size = U.count(ent)
        if is_real_food(comp(ent, "edible")) then block.edible = true end
    end

    local container = comp(ent, "container")
    if container ~= nil and container.IsOpen ~= nil then
        local ok, open = pcall(function() return container:IsOpen() end)
        if ok and open ~= nil then block.is_open = open == true end
    end

    if comp(ent, "fueled") ~= nil and has_tag(ent, "fire") then
        local fueled = comp(ent, "fueled")
        local ok, percent = pcall(function() return fueled:GetPercent() end)
        if ok and percent ~= nil then block.fuel_percent = math.floor(percent * 100) end
    end

    return block
end

-- ─────────────────────────── 扫描 ───────────────────────────

--- 扫一遍，返回 { entities = { {block, ent} ... }, found = n } 或 nil, err
local function scan(actor, radius, near_radius)
    near_radius = near_radius or NEAR_ZONE_RADIUS
    local x, y, z = U.pos(actor)
    if x == nil then return nil, "no_position" end
    local ok, ents = pcall(function()
        return GLOBAL.TheSim:FindEntities(x, y, z, radius * U.TILE, nil, { "INLIMBO" }, nil)
    end)
    if not ok or ents == nil then return nil, "find_entities_failed" end

    local out = {}
    for _, ent in ipairs(ents) do
        if ent ~= nil and ent ~= actor and ent:IsValid() and not ent:HasTag("INLIMBO") then
            local dist = U.dist(actor, ent) / U.TILE
            local ok_candidate = false
            if (radius ~= nil and radius <= near_radius) or dist <= near_radius then
                ok_candidate = interesting(ent)
            else
                ok_candidate = interesting_radar(ent, actor)
            end
            if ok_candidate then
                local category, item_kind = N.Classify(ent, actor)
                if category ~= nil then
                    local block = describe(ent, actor, category, item_kind)
                    if block ~= nil then
                        out[#out + 1] = { block = block, ent = ent, guid = ent.GUID }
                    end
                end
            end
        end
    end
    return { entities = out, found = #out }
end

-- ─────────────────────────── 上限 / 排序 / 编号 ───────────────────────────

local function sort_entities(list)
    table.sort(list, function(a, b)
        local ca = a.block.category
        local cb = b.block.category
        if ca ~= cb then return (BUCKET_ORDER[ca] or 99) < (BUCKET_ORDER[cb] or 99) end
        local da = a.block.distance or math.huge
        local db = b.block.distance or math.huge
        if da ~= db then return da < db end
        local pa = tostring(a.block.prefab or "")
        local pb = tostring(b.block.prefab or "")
        if pa ~= pb then return pa < pb end
        -- 最后用 GUID 保证完全确定（只是内部稳定排序，不发给模型）
        return (a.guid or 0) < (b.guid or 0)
    end)
end

-- ─────────────────────────── Delta ───────────────────────────

local function baseline_key(identity)
    local session = identity ~= nil and identity.session_id or "?"
    local shard = identity ~= nil and identity.shard_id or "?"
    return tostring(session) .. "|" .. tostring(shard)
end

local prev = { key = nil, by_guid = nil } -- 上一次成功扫描的基线

--- 把一个扫描条目压成"跨扫描可比较的视图"（不含实体对象，避免长期持有）
--- ref == nil 表示：这次扫描到了、但**没有**进 kept（没有可操作引用）
local function entry_view(entry)
    local b = entry.block
    return {
        guid = entry.guid,
        ref = b.ref,
        category = b.category,
        prefab = b.prefab,
        label = b.label,
        distance = b.distance,
        health = b.health,
        stack_size = b.stack_size,
        is_harvestable = b.is_harvestable,
        harvest_ready = b.harvest_ready,
        work_action = b.work_action,
    }
end

--- Delta 语义（0.13.3 修）：
---   · 基线 = **完整扫描候选集合**（截断前），不是返回集合
---     → 被容量限制挤出的实体不会被误报成 removed
---   · added 只报"这次进了 kept（有 #N）且上次完整扫描里没有"的实体
---   · removed 只报"上次完整扫描有、这次完整扫描也没有"的实体（真实缺席）
---   · changed 只报"两次完整扫描都有、且这次进了 kept（有 #N）"的实体
---
--- @param full     本次完整扫描的条目数组（已排序；kept 的条目带 ref）
--- @param kept_set { [guid] = true } 本次真正返回的实体
--- @param key      session|shard
local function compute_delta(full, kept_set, key)
    local current = {}
    local order = {}
    for _, entry in ipairs(full) do
        if entry.guid ~= nil then
            current[entry.guid] = entry_view(entry)
            order[#order + 1] = entry.guid
        end
    end

    if prev.by_guid == nil or prev.key ~= key then
        prev = { key = key, by_guid = current }
        return { status = "baseline", added_count = 0, removed_count = 0, changed_count = 0,
                 added = {}, removed = {}, changed = {} }
    end

    local added, removed, changed = {}, {}, {}
    for _, guid in ipairs(order) do
        local now = current[guid]
        local before = prev.by_guid[guid]
        if before == nil then
            -- 新进完整扫描的实体：只有这次也进了 kept 才算 added（否则没有引用，报了也没法操作）
            if now.ref ~= nil then added[#added + 1] = now end
        elseif now.ref ~= nil then
            -- 两次都在完整扫描里：只有这次能操作才报变化
            local fields = {}
            if before.category ~= now.category then
                fields.category = { from = before.category, to = now.category }
            end
            if before.health ~= nil and now.health ~= nil and math.abs(now.health - before.health) >= 1 then
                fields.health = { from = before.health, to = now.health }
            end
            if before.distance ~= nil and now.distance ~= nil and math.abs(now.distance - before.distance) >= 1.0 then
                fields.distance = { from = before.distance, to = now.distance }
            end
            if (before.stack_size or 0) ~= (now.stack_size or 0) then
                fields.stack_size = { from = before.stack_size, to = now.stack_size }
            end
            if before.is_harvestable ~= nil and now.is_harvestable ~= nil
                and before.is_harvestable ~= now.is_harvestable then
                fields.is_harvestable = { from = before.is_harvestable, to = now.is_harvestable }
            end
            if before.harvest_ready ~= nil and now.harvest_ready ~= nil
                and before.harvest_ready ~= now.harvest_ready then
                fields.harvest_ready = { from = before.harvest_ready, to = now.harvest_ready }
            end
            if before.work_action ~= nil and now.work_action ~= nil
                and before.work_action ~= now.work_action then
                fields.work_action = { from = before.work_action, to = now.work_action }
            end
            local field_count = 0
            for _ in pairs(fields) do field_count = field_count + 1 end
            if field_count > 0 then changed[#changed + 1] = { entry = now, fields = fields } end
        end
        -- 两次都在、但这次没进 kept → 什么都不报（它只是被截断了，不是变化）
        if kept_set[guid] == nil and now.ref ~= nil then
            -- 理论上不会发生（kept 的 ref 一定非空），留着是为了防御
            now.ref = nil
        end
    end

    -- 真实缺席：上次完整扫描有、这次完整扫描也没有
    for guid, before in pairs(prev.by_guid) do
        if current[guid] == nil then removed[#removed + 1] = before end
    end

    prev = { key = key, by_guid = current }

    table.sort(removed, function(a, b) return (a.distance or 0) < (b.distance or 0) end)
    table.sort(changed, function(a, b) return (a.entry.distance or 0) < (b.entry.distance or 0) end)

    return {
        status = "ok",
        added_count = #added,
        removed_count = #removed,
        changed_count = #changed,
        added = added,
        removed = removed,
        changed = changed,
    }
end

--- 把 delta 变成可以直接序列化的紧凑结构
--- @param delta      compute_delta 的结果
--- @param not_returned 本次"扫到了但没进 kept"的条目（没有 ref，不能当可操作目标）
local function delta_out(delta, not_returned)
    local out = {
        status = delta.status,
        added_count = delta.added_count,
        removed_count = delta.removed_count,
        changed_count = delta.changed_count,
        added = arr({}),
        removed = arr({}),
        changed = arr({}),
        not_returned_count = #(not_returned or {}),
        not_returned = arr({}),
    }
    for _, item in ipairs(delta.added) do
        out.added[#out.added + 1] = {
            ref = item.ref,
            prefab = item.prefab,
            label = item.label,
            category = item.category,
        }
    end
    for _, item in ipairs(delta.removed) do
        -- previous_ref 是**上次扫描**的编号，不能当现在的引用用；上次没返回就没有这个字段
        local view = {
            prefab = item.prefab,
            label = item.label,
            category = item.category,
        }
        if item.ref ~= nil then view.previous_ref = item.ref end
        out.removed[#out.removed + 1] = view
    end
    for _, item in ipairs(delta.changed) do
        out.changed[#out.changed + 1] = {
            ref = item.entry.ref,
            prefab = item.entry.prefab,
            label = item.entry.label,
            category = item.entry.category,
            fields = item.fields,
        }
    end
    -- 只带前 12 条明细，数量用 not_returned_count 表达（避免 JSON 膨胀）
    for i = 1, math.min(#(not_returned or {}), 12) do
        local entry = not_returned[i]
        out.not_returned[#out.not_returned + 1] = {
            prefab = entry.block.prefab,
            category = entry.block.category,
            distance = entry.block.distance,
        }
    end
    return out
end

-- ─────────────────────────── 缓存 + 对外接口 ───────────────────────────

local cache = { key = nil, at = nil, result = nil } -- 上次成功的扫描结果（含 refs/delta）
local scan_seq = 0
local refs = {} -- refs[snapshot_id] = { ["#1"] = entity, ... }

local function new_key(actor, info, opts, identity)
    local guid = actor ~= nil and tostring(actor.GUID) or "nil"
    return table.concat({
        guid,
        tostring(opts.radius), tostring(opts.max_total), tostring(opts.max_per_bucket),
        baseline_key(identity),
        tostring(info ~= nil and info.actor_id or "?"),
    }, "|")
end

-- ═══ 编号复用（OBSERVATION-02）═══
-- 为什么需要：scan_seq 每次重扫就 +1。把 scan_seconds 降到 1 秒后，**每秒都换新编号**，
-- 而真实模型从读到 snapshot_id 到发出动作要 3~5 秒 —— 于是必然 stale_snapshot。
-- 真机会话证据（session-403656e9，15 步里 5 次 stale_snapshot，只有 1 次动作成功）：
--   n11 → n15 → n16 → n20 → n27 → n29 → n43 → n45，模型每次拿到的都是过期编号。
--
-- 修法：**内容没变就复用同一个编号**。引用是否有效应该取决于"东西还在不在"，
-- 而不是"我们扫了几次"。这样模型手里的 #N 在东西没变时一直有效。
-- 注意：这**没有放宽** stale_snapshot —— 内容一变（实体增删、位置变化）就立刻换新编号，
-- 旧编号照样失效。
local last_fingerprint = nil
local last_snapshot_id = nil

-- 会自己乱跑的桶（普通生物、杂物）不把位置放进指纹：
-- 真机里一只红雀每 2 秒换个地方，snapshot_id 就跟着换，模型手里的 #N 全部作废
-- （8 次动作 6 次 stale_snapshot）。这些桶本来也不是"按 #N 去采/捡"的目标；
-- 真正要操作的桶（可拾取/可采/资源/食物/容器/建筑）仍然把位置算进去，
-- 所以"东西挪了 → 换新编号"这条安全边界没有放宽。
local MOBILE_CATEGORIES = { creatures = true, threats = true, other = true }

local function fingerprint_of(list)
    local parts = {}
    for i = 1, #list do
        local entry = list[i]
        local e = entry.ent
        if e ~= nil then
            local category = entry.block ~= nil and entry.block.category or nil
            if MOBILE_CATEGORIES[category] then
                -- 只记"它还在不在"；移动不算内容变化。
                parts[#parts + 1] = string.format("%s@*", tostring(e.GUID))
            else
                local x, _, z = e.Transform:GetWorldPosition()
                parts[#parts + 1] = string.format("%s@%d,%d", tostring(e.GUID), math.floor(x / 4), math.floor(z / 4))
            end
        end
    end
    table.sort(parts)
    return table.concat(parts, ";")
end

local function build(actor, info, now, opts, identity)
    local started_ms, timer_source = clock_ms()

    local scanned, err = scan(actor, opts.radius, opts.near_radius)
    if scanned == nil then
        scan_seq = scan_seq + 1
        local snapshot_id = RUNTIME_ID .. "-n" .. tostring(scan_seq)
        prev = { key = nil, by_guid = nil } -- 失败 → 下次重建基线
        return {
            status = "error",
            schema = N.SCHEMA,
            snapshot_id = snapshot_id,
            radius = opts.radius,
            scan_seconds = opts.scan_seconds,
            cached = false,
            max_total = opts.max_total,
            max_per_bucket = opts.max_per_bucket,
            total_found = 0,
            total_returned = 0,
            truncated = false,
            error = err or "scan_failed",
            scan = { reused = false, timestamp = now, age_ms = 0,
                     duration_ms = nil, duration_source = "unavailable",
                     scan_seconds = opts.scan_seconds },
            buckets = { threats = arr({}), pickupables = arr({}), harvestables = arr({}), food = arr({}), resources = arr({}), containers = arr({}), structures = arr({}), creatures = arr({}), other = arr({}) }, -- 出错时为空数组（P1.5）
            delta = { status = "reset", added_count = 0, removed_count = 0, changed_count = 0,
                      added = arr({}), removed = arr({}), changed = arr({}) },
        }
    end

    local list = scanned.entities
    sort_entities(list)

    -- ★ TARGET-REFRESH：给这一帧的"可操作"实体续期/分配稳定句柄（不暴露 GUID）。
    --   句柄注册表在 Whale.targetrules；这里只负责告诉它"这一帧看到它们了"。
    --   必须在截断之前用**完整扫描列表**，否则被 60 条上限挤掉的实体会莫名失效。
    --   句柄与 #N 并存：#N 仍是"当前观察里的展示编号"，句柄才是"跨帧稳定的引用"。
    pcall(function()
        local tr = Whale ~= nil and Whale.targetrules or nil
        if tr ~= nil then
            tr.BindSession(RUNTIME_ID, identity ~= nil and identity.session_id or nil,
                info ~= nil and info.actor_id or nil)
            tr.NoteScan(list, actor)
        end
    end)

    -- ★ 内容指纹没变就复用上一个编号（详见上面 last_fingerprint 的说明）。
    --   这样模型手里的 #N 在"东西没变"时一直有效，不会因为扫了几次就作废。
    local fp = fingerprint_of(list)
    local snapshot_id
    if fp == last_fingerprint and last_snapshot_id ~= nil then
        snapshot_id = last_snapshot_id   -- 复用：编号不变，refs 也继续有效
    else
        scan_seq = scan_seq + 1
        snapshot_id = RUNTIME_ID .. "-n" .. tostring(scan_seq)
        last_fingerprint = fp
        last_snapshot_id = snapshot_id
    end

    -- 上限：先按桶截断，再按总量截断（顺序确定）
    local buckets = {}
    for _, def in ipairs(N.BUCKETS) do buckets[def.key] = arr({}) end
    local per_bucket = {}
    local total = 0
    local kept = {}

    for _, entry in ipairs(list) do
        local category = entry.block.category
        local count = per_bucket[category] or 0
        if count < opts.max_per_bucket and total < opts.max_total then
            per_bucket[category] = count + 1
            total = total + 1
            kept[#kept + 1] = entry
        end
    end

    -- #N 在截断/排序之后分配；顺序就是 kept 的顺序（= 桶优先级 + 距离）
    local ref_map = {}
    for index, entry in ipairs(kept) do
        entry.block.ref = "#" .. tostring(index)
        ref_map[entry.block.ref] = entry.ent
        buckets[entry.block.category][#buckets[entry.block.category] + 1] = entry.block
    end
    -- 只保留**当前**扫描的引用表：旧快照的 #N 必须失效（否则 M2 会拿过期引用去操作），
    -- 顺手也避免 refs 越攒越多。
    refs = { [snapshot_id] = ref_map }

    -- Delta 基线用**完整扫描候选集合**（list），返回集合（kept）只决定"能不能操作"
    local kept_set = {}
    for _, entry in ipairs(kept) do
        if entry.guid ~= nil then kept_set[entry.guid] = true end
    end
    local not_returned = {}
    for _, entry in ipairs(list) do
        -- 没有 GUID 的实体（只有假游戏里会出现）不进 delta 逻辑，避免 nil 索引
        if entry.guid ~= nil and kept_set[entry.guid] == nil then
            not_returned[#not_returned + 1] = entry
        end
    end
    local delta = compute_delta(list, kept_set, baseline_key(identity))

    -- 计时：拿不到可信耗时就写 null（不伪装成 0ms）
    local finished_ms, finished_source = clock_ms()
    -- 两次必须用同一个时钟源，否则差值没有意义
    local duration_ms = (finished_source == timer_source) and duration_of(started_ms, finished_ms) or nil
    local duration_source = duration_ms ~= nil and timer_source or "unavailable"

    return {
        status = (#kept > 0) and "ok" or "empty",
        schema = N.SCHEMA,
        runtime_id = RUNTIME_ID,
        snapshot_id = snapshot_id,
        radius = opts.radius,
        scan_seconds = opts.scan_seconds,
        cached = false,
        max_total = opts.max_total,
        max_per_bucket = opts.max_per_bucket,
        total_found = scanned.found,
        total_returned = #kept,
        truncated = #kept < scanned.found,
        scan = {
            reused = false,
            timestamp = now,
            age_ms = 0,
            duration_ms = duration_ms,
            duration_source = duration_source,
            scan_seconds = opts.scan_seconds,
        },
        buckets = buckets,
        delta = delta_out(delta, not_returned),
    }
end

--- 对外：拿一份 nearby 数据（自动缓存）。
--- opts = { radius, scan_seconds, max_total, max_per_bucket, identity }
function N.Observe(actor, info, now, opts)
    opts = opts or {}
    local radius = tonumber(opts.radius) or 16
    local scan_seconds = tonumber(opts.scan_seconds) or 4
    local max_total = tonumber(opts.max_total) or 60
    local max_per_bucket = tonumber(opts.max_per_bucket) or 12
    local identity = opts.identity or {}

    local key = new_key(actor, info, {
        radius = radius, max_total = max_total, max_per_bucket = max_per_bucket,
    }, identity)

    -- OBSERVATION-01：get_state 可以要求**强制重扫**（opts.force）。
    -- 为什么需要：快照默认缓存 scan_seconds（4 秒），而真实模型从读到 id 到发出动作要 3~5 秒，
    -- 于是"刚拿到的 #N + snapshot_id"经常在动作到达时已经过期（真机 8 次失败里 6 次是 stale_snapshot）。
    -- 强制重扫不改变任何校验规则：只是让模型手里那份 id 从"生成那一刻"开始计时。
    local fresh = opts.force ~= true
        and cache.result ~= nil
        and cache.key == key
        and cache.at ~= nil
        and (now - cache.at) < scan_seconds

    if fresh then
        -- 缓存命中：**不重新扫描、不重新编号、不重新算 delta**
        local cached = cache.result
        return {
            status = cached.status,
            schema = cached.schema,
            runtime_id = RUNTIME_ID,
            snapshot_id = cached.snapshot_id,   -- 同一个扫描快照号：引用仍然有效
            radius = cached.radius,
            scan_seconds = cached.scan_seconds,
            cached = true,
            max_total = cached.max_total,
            max_per_bucket = cached.max_per_bucket,
            total_found = cached.total_found,
            total_returned = cached.total_returned,
            truncated = cached.truncated,
            scan = {
                reused = true,
                timestamp = cached.scan.timestamp,
                age_ms = math.floor((now - cached.scan.timestamp) * 1000),
                duration_ms = cached.scan.duration_ms,
                duration_source = cached.scan.duration_source,
                scan_seconds = cached.scan_seconds,
            },
            buckets = cached.buckets,
            delta = cached.delta,
        }
    end

    local result = build(actor, info, now, {
        radius = radius, scan_seconds = scan_seconds,
        max_total = max_total, max_per_bucket = max_per_bucket,
    }, identity)

    cache = { key = key, at = now, result = result }
    return result
end

--- 把 #N 解析回实体（给 M2 的动作执行器用；现在只做"能不能解析"的基础设施）
--- @return entity|nil, reason
function N.Resolve(snapshot_id, ref)
    -- 先挡掉"上一次运行"的快照：重启/重进世界后 scan_seq 会从头开始，编号会撞，
    -- 不挡的话旧 #N 会解析成新实例里的另一个实体（M2 的动作安全前提）。
    if type(snapshot_id) ~= "string" or string.sub(snapshot_id, 1, #RUNTIME_ID + 1) ~= (RUNTIME_ID .. "-") then
        return nil, "stale_snapshot"
    end
    local map = refs[snapshot_id]
    if map == nil then return nil, "stale_snapshot" end
    local ent = map[ref]
    if ent == nil then return nil, "unknown_ref" end
    local ok, valid = pcall(function() return ent:IsValid() end)
    if not ok or not valid then return nil, "entity_gone" end
    if ent:HasTag("INLIMBO") then return nil, "in_limbo" end
    return ent, nil
end

--- TARGET-REFRESH：把稳定句柄解析回实体。
--- 与 #N 的区别：#N 绑定"某一帧扫描"，句柄绑定"这个东西还在不在"。
--- 实现放在 Whale.targetrules（它才持有句柄注册表）；这里只是给 guard 一个统一入口。
--- 句柄过期一律返回原因，**绝不自动替换成别的对象**。
function N.ResolveHandle(handle)
    local tr = Whale ~= nil and Whale.targetrules or nil
    if tr == nil or tr.ResolveHandle == nil then return nil, "targetrules_missing" end
    return tr.ResolveHandle(handle)
end

--- 按 (snapshot_id, ref) 反查这个目标的分类/距离/预制体名（给动作前置校验用）
--- 只读当前快照；找不到就返回 nil（调用方按 target_not_compatible 处理）
function N.DescribeRef(snapshot_id, ref)
    if type(snapshot_id) ~= "string" or type(ref) ~= "string" then return nil end
    if cache.result == nil or cache.result.snapshot_id ~= snapshot_id then return nil end
    local buckets = cache.result.buckets
    if buckets == nil then return nil end
    for _, def in ipairs(N.BUCKETS) do
        for _, item in ipairs(buckets[def.key] or {}) do
            if item.ref == ref then
                return {
                    ref = ref,
                    prefab = item.prefab,
                    label = item.label,
                    category = item.category,
                    distance = item.distance,
                    snapshot_id = snapshot_id,
                }
            end
        end
    end
    return nil
end

--- 当前还留着哪些扫描快照（诊断用；只保留最近几份，避免越积越多）
function N.Snapshots()
    local list = {}
    for id in pairs(refs) do list[#list + 1] = id end
    table.sort(list)
    return list
end

--- 测试用：清空缓存与基线
function N.Reset()
    cache = { key = nil, at = nil, result = nil }
    prev = { key = nil, by_guid = nil }
    refs = {}
    scan_seq = 0
    -- P1：重置时也要清指纹缓存，否则可能错误复用上一次的编号
    last_fingerprint = nil
    last_snapshot_id = nil
end

Whale = Whale or {}
Whale.nearby = N
