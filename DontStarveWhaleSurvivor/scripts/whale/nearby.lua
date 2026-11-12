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

--- 这些 foodtype 虽然"能吃"，但不是 AI 该当食物用的（树枝、种子、齿轮…）
local FOODTYPE = GLOBAL.FOODTYPE
local NON_FOOD_TYPES = {}
if FOODTYPE ~= nil then
    NON_FOOD_TYPES[FOODTYPE.ROUGHAGE] = true -- 树枝/草：燃料和材料
    NON_FOOD_TYPES[FOODTYPE.SEEDS] = true    -- 种子：喂鸟/种地
    NON_FOOD_TYPES[FOODTYPE.GEARS] = true    -- 齿轮：修机械
end

local function is_real_food(edible)
    if edible == nil then return false end
    local foodtype = edible.foodtype
    if foodtype == nil then return true end
    if NON_FOOD_TYPES[foodtype] then return false end
    return true
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

--- 判断这个实体值不值得进 nearby（不认识的 fx/装饰一律不进）
local function interesting(ent)
    if comp(ent, "health") ~= nil then return true end
    if comp(ent, "workable") ~= nil then return true end
    if comp(ent, "harvestable") ~= nil then return true end
    if comp(ent, "inventoryitem") ~= nil then return true end
    if comp(ent, "container") ~= nil then return true end
    if comp(ent, "fueled") ~= nil then return true end
    if comp(ent, "prototyper") ~= nil then return true end
    if comp(ent, "combat") ~= nil then return true end
    if has_tag(ent, "structure") or has_tag(ent, "pickable") or has_tag(ent, "hostile") then return true end
    return false
end

--- 分类：一个实体只会得到一个 category（优先级从上到下）
function N.Classify(ent, actor)
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

-- ─────────────────────────── 实体 → 紧凑字段 ───────────────────────────

local function round1(value)
    if value == nil then return nil end
    return math.floor(value * 10 + 0.5) / 10
end

local function describe(ent, actor, category)
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
local function scan(actor, radius)
    local x, y, z = U.pos(actor)
    if x == nil then return nil, "no_position" end
    local ok, ents = pcall(function()
        return GLOBAL.TheSim:FindEntities(x, y, z, radius * U.TILE, nil, { "INLIMBO" }, nil)
    end)
    if not ok or ents == nil then return nil, "find_entities_failed" end

    local out = {}
    for _, ent in ipairs(ents) do
        if ent ~= nil and ent ~= actor and ent:IsValid() and not ent:HasTag("INLIMBO") then
            if interesting(ent) then
                local category = N.Classify(ent, actor)
                if category ~= nil then
                    local block = describe(ent, actor, category)
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

local function compute_delta(list, key)
    local current = {}
    for _, entry in ipairs(list) do
        if entry.guid ~= nil then current[entry.guid] = entry end
    end

    if prev.by_guid == nil or prev.key ~= key then
        prev = { key = key, by_guid = current }
        return { status = "baseline", added_count = 0, removed_count = 0, changed_count = 0,
                 added = {}, removed = {}, changed = {} }
    end

    local added, removed, changed = {}, {}, {}
    for guid, entry in pairs(current) do
        local before = prev.by_guid[guid]
        if before == nil then
            added[#added + 1] = entry
        else
            local fields = {}
            if before.block.category ~= entry.block.category then
                fields.category = { from = before.block.category, to = entry.block.category }
            end
            local dh = (entry.block.health or 0) - (before.block.health or 0)
            if entry.block.health ~= nil and before.block.health ~= nil and math.abs(dh) >= 1 then
                fields.health = { from = before.block.health, to = entry.block.health }
            end
            local dd = (entry.block.distance or 0) - (before.block.distance or 0)
            if math.abs(dd) >= 1.0 then
                fields.distance = { from = before.block.distance, to = entry.block.distance }
            end
            if (entry.block.stack_size or 0) ~= (before.block.stack_size or 0) then
                fields.stack_size = { from = before.block.stack_size, to = entry.block.stack_size }
            end
            if before.block.is_harvestable ~= nil and entry.block.is_harvestable ~= nil
                and before.block.is_harvestable ~= entry.block.is_harvestable then
                fields.is_harvestable = { from = before.block.is_harvestable, to = entry.block.is_harvestable }
            end
            if before.block.work_action ~= nil and entry.block.work_action ~= nil
                and before.block.work_action ~= entry.block.work_action then
                fields.work_action = { from = before.block.work_action, to = entry.block.work_action }
            end
            local field_count = 0
            for _ in pairs(fields) do field_count = field_count + 1 end
            if field_count > 0 then
                changed[#changed + 1] = { entry = entry, fields = fields }
            end
        end
    end
    for guid, before in pairs(prev.by_guid) do
        if current[guid] == nil then
            removed[#removed + 1] = before
        end
    end

    prev = { key = key, by_guid = current }

    -- 排序保证确定性：新增按当前顺序（已在 list 里排好）、消失/变化按 category+distance
    table.sort(removed, function(a, b)
        return (a.block.distance or 0) < (b.block.distance or 0)
    end)
    table.sort(changed, function(a, b)
        return (a.entry.block.distance or 0) < (b.entry.block.distance or 0)
    end)

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

--- 把 delta 变成可以直接序列化的紧凑结构（引用要用**当前**快照的 #N）
local function delta_out(delta)
    local out = {
        status = delta.status,
        added_count = delta.added_count,
        removed_count = delta.removed_count,
        changed_count = delta.changed_count,
        added = arr({}),
        removed = arr({}),
        changed = arr({}),
    }
    for _, entry in ipairs(delta.added) do
        out.added[#out.added + 1] = {
            ref = entry.block.ref,
            prefab = entry.block.prefab,
            label = entry.block.label,
            category = entry.block.category,
        }
    end
    for _, entry in ipairs(delta.removed) do
        -- previous_ref 是**旧快照**的编号，不能当现在的引用用
        out.removed[#out.removed + 1] = {
            previous_ref = entry.block.ref,
            prefab = entry.block.prefab,
            label = entry.block.label,
            category = entry.block.category,
        }
    end
    for _, item in ipairs(delta.changed) do
        out.changed[#out.changed + 1] = {
            ref = item.entry.block.ref,
            prefab = item.entry.block.prefab,
            label = item.entry.block.label,
            category = item.entry.block.category,
            fields = item.fields,
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

local function build(actor, info, now, opts, identity)
    scan_seq = scan_seq + 1
    local snapshot_id = RUNTIME_ID .. "-n" .. tostring(scan_seq)
    local started = U.now()

    local scanned, err = scan(actor, opts.radius)
    if scanned == nil then
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
            scan = { reused = false, timestamp = now, age_ms = 0, scan_seconds = opts.scan_seconds },
            buckets = { threats = {}, food = {}, resources = {}, containers = {}, structures = {}, creatures = {}, other = {} }, -- 出错时为空，读端按"没有数据"处理
            delta = { status = "reset", added_count = 0, removed_count = 0, changed_count = 0,
                      added = {}, removed = {}, changed = {} },
        }
    end

    local list = scanned.entities
    sort_entities(list)

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

    local delta = compute_delta(kept, baseline_key(identity))
    local duration_ms = math.floor((U.now() - started) * 1000)

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
        scan = { reused = false, timestamp = now, age_ms = 0, duration_ms = duration_ms, scan_seconds = opts.scan_seconds },
        buckets = buckets,
        delta = delta_out(delta),
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

    local fresh = cache.result ~= nil
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
end

Whale = Whale or {}
Whale.nearby = N
