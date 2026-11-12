-- Blind Whale Survivor · Phase 1 · 状态序列化（里程碑 6）
--
-- 职责：把观察器拿到的数据**统一**成一套结构，再按「日志单行长度上限」切成可传输的记录。
--
-- 为什么不是一个 JSON：
--   饥荒日志每行约 3.9K 字符就被截断（实机实测：3913~3921 字符的行全部断在半截）。
--   所以线上（wire）分成两条记录：
--     type="state"   session / player / inventory / world / observer（不含实体）
--     type="nearby"  nearby 段（含实体列表，超预算时按距离裁剪）
--   两条用同一个 `tick` 配对，Bridge 合并成一份完整的 GameState 再对外服务。
--   合并后的规范结构写在 schema/state.schema.json 的 $defs.GameState 里。
--
-- 契约（schema_version = 1）：
--   每条记录都带：schema_version / type / phase / observer_version / side / shard / session / t / rt / sim_tick
--   可选（取不到就不出现）：last_error / problems 等
--
-- 沙箱：mod 环境没有 pcall / tonumber / next，从 GLOBAL 取。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

BWS = BWS or {}

local S = {}

S.SCHEMA_VERSION = "1"
S.PHASE = 1

-- 单条日志记录的安全预算（实测截断点在 3900 左右，留足余量）
S.MAX_RECORD_CHARS = 3500

--- 公共头部字段（每条记录都有）
function S.header(meta, record_type)
    local header = {
        schema_version = S.SCHEMA_VERSION,
        type = record_type,
        phase = S.PHASE,
        observer_version = meta.observer_version,
        side = meta.side,
        shard = meta.shard,
        session = meta.session,
        t = meta.t,
        rt = meta.rt,
        sim_tick = meta.sim_tick,
    }
    if meta.last_error ~= nil then header.last_error = meta.last_error end
    return header
end

--- type="boot" 记录：模组加载成功 + 跑在哪端/哪个分片/采样间隔
function S.Boot(meta, info)
    local record = S.header(meta, "boot")
    record.mod = info.mod
    record.ismastersim = info.ismastersim and true or false
    record.interval = info.interval
    record.players = { count = info.player_count }
    return record
end

--- type="state" 记录：不含实体（实体走 nearby 记录）
function S.State(meta, sections)
    local record = S.header(meta, "state")
    record.tick = meta.tick
    if sections ~= nil then
        if sections.player ~= nil then record.player = sections.player end
        if sections.inventory ~= nil then record.inventory = sections.inventory end
        if sections.world ~= nil then record.world = sections.world end
    end
    local observer = {
        interval = meta.interval,
        tick = meta.tick,
        errors = meta.errors,
        players = { count = meta.player_count },
    }
    if meta.problems ~= nil then observer.problems = meta.problems end
    record.observer = observer
    return record
end

--- type="nearby" 记录：实体列表单独一条，避免把 state 撑爆
function S.Nearby(meta, nearby)
    local record = S.header(meta, "nearby")
    record.tick = meta.tick
    record.radius_tiles = nearby.radius_tiles
    record.scanned = nearby.scanned
    record.returned = nearby.returned
    record.truncated = nearby.truncated
    record.scanned_at_tick = nearby.scanned_at_tick
    record.counts = nearby.counts
    local entities = {}
    for i, entry in ipairs(nearby.entities or {}) do
        entities[i] = entry
    end
    record.entities = entities
    return record
end

--- 合并后的规范结构（Bridge 对外服务的就是这个形状；测试里也用它做契约校验）
function S.GameState(meta, sections)
    local state = {
        schema_version = S.SCHEMA_VERSION,
        timestamp = { unix = meta.t, real_s = meta.rt, sim_tick = meta.sim_tick },
        session = meta.session,
        side = meta.side,
        shard = meta.shard,
        tick = meta.tick,
    }
    if sections.player ~= nil then state.player = sections.player end
    if sections.inventory ~= nil then state.inventory = sections.inventory end
    if sections.world ~= nil then state.world = sections.world end
    if sections.nearby ~= nil then state.nearby = sections.nearby end
    -- Phase 6 M1：威胁 / 环境（只走 telemetry 大包，不进日志单行记录）
    if sections.threats ~= nil then state.threats = sections.threats end
    if sections.environment ~= nil then state.environment = sections.environment end
    local observer = {
        interval = meta.interval,
        errors = meta.errors,
        version = meta.observer_version,
        players = { count = meta.player_count },
    }
    if meta.problems ~= nil then observer.problems = meta.problems end
    if meta.last_error ~= nil then observer.last_error = meta.last_error end
    state.observer = observer
    return state
end

-- ─────────────────── 长度预算 ───────────────────

--- 编码。返回 文本 或 nil, 原因
function S.encode(record)
    local ok, text = pcall(BWS.json.encode, record)
    if not ok then return nil, "encode_failed" end
    return text
end

--- 按预算裁剪 nearby 记录：保留**前面的**实体（调用方已按距离排序），标 trimmed / returned
function S.shrink_nearby(record, budget)
    local entities = record.entities or {}
    -- 先算出除实体之外的大致占用，剩下的给实体
    local shell = {}
    for key, value in pairs(record) do
        if key ~= "entities" then shell[key] = value end
    end
    local shell_text = S.encode(shell) or ""
    local size = #shell_text + 160 -- 尾部和分隔符余量
    local kept = {}
    for i = 1, #entities do
        local one = S.encode(entities[i]) or ""
        if size + #one + 1 > budget then break end
        kept[#kept + 1] = entities[i]
        size = size + #one + 1
    end
    if #kept == 0 then
        -- 一条都放不下：干脆不发 entities（schema 允许缺失），别写出空对象让人误会
        record.entities = nil
    else
        record.entities = kept
    end
    record.returned = #kept
    record.trimmed = (#kept < #entities) or (record.trimmed == true)
    if record.entities == nil then record.oversize = true end
    return record
end

--- 打到日志里。超预算时先裁剪（有 shrink 的话），再不行丢字段，仍不行就不打。
--- 返回 true / false, 原因
function S.Emit(record, shrink)
    local text, err = S.encode(record)
    if text == nil then return false, err or "encode_failed" end

    if #text > S.MAX_RECORD_CHARS and shrink ~= nil then
        local ok_shrink, shrunk = pcall(shrink, record, S.MAX_RECORD_CHARS)
        if ok_shrink and shrunk ~= nil then
            text = S.encode(shrunk) or text
            record = shrunk
        end
    end
    if #text > S.MAX_RECORD_CHARS then
        record.entities = nil
        record.trimmed = true
        record.oversize = true
        text = S.encode(record) or text
    end
    if #text > S.MAX_RECORD_CHARS then
        return false, "record_too_long:" .. tostring(#text)
    end

    local ok_print, print_err = pcall(function()
        print(BWS.tag .. " " .. text)
    end)
    if not ok_print then return false, "print_failed:" .. tostring(print_err) end
    return true
end

BWS.serializer = S
