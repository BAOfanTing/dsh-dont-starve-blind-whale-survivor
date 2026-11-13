-- 模组配置的唯一出口（把 modinfo 里那几项真正绑到行为上）
--
-- 以前 OBSERVER_INTERVAL / OBSERVER_SCAN_RADIUS / OBSERVER_SCAN_SECONDS 只有归档掉的
-- A 栈观察器在读，界面上看得见、改了一点用没有。M1.1 把这三项接到活的 B 栈观察器上：
--
--   INTERVAL            → state_interval   文件里状态多久重写一次（秒）
--   OBSERVER_INTERVAL   → observe_interval 快照多久重算一次（秒）；命中缓存就不重复生成
--   OBSERVER_SCAN_RADIUS→ scan_radius      附近实体扫描半径（格）
--   OBSERVER_SCAN_SECONDS → scan_seconds   附近实体扫描结果缓存多久（秒）
--
-- 每个值都会夹到安全区间；配置读不到/不是数字 → 用默认值，并把问题记进 problems（不静默）。
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local type = type

local C = {}

C.DEFAULTS = {
    state_interval = 1,
    observe_interval = 2,
    scan_radius = 16,
    -- OBSERVATION-01：默认从 4 降到 1。
    -- 实测扫描只要 1ms；而 4 秒缓存意味着模型最坏拿到"已经用掉 2 秒"的帧，
    -- 它思考要 3~5 秒 → 动作到达时必然 stale_snapshot（真机 8 次失败里 6 次是这个）。
    scan_seconds = 1,
    nearby_max_total = 60,
    nearby_max_per_bucket = 12,
    reflex = false,
    verbose = false,
}

--- 允许的区间（含端点）。夹取而不是报错：游戏里改配置不该让模组炸掉。
C.RANGES = {
    state_interval = { 0.5, 10 },
    observe_interval = { 0.5, 10 },
    scan_radius = { 4, 40 },
    scan_seconds = { 1, 60 },
    nearby_max_total = { 10, 200 },
    nearby_max_per_bucket = { 2, 50 },
}

C.values = {}
for k, v in pairs(C.DEFAULTS) do C.values[k] = v end

--- 把一个值夹到 range 里。返回 value, note（note 说明为什么被改/为什么不用）
function C.clamp(name, value)
    local default = C.DEFAULTS[name]
    local range = C.RANGES[name]
    if range == nil then
        -- 没有区间的（布尔项）只做类型检查
        if value == nil then return default, nil end
        if type(value) ~= type(default) then return default, name .. ": 类型不对，用默认值" end
        return value, nil
    end

    local n = tonumber(value)
    if n == nil or n ~= n then
        return default, name .. ": 不是数字，用默认值 " .. tostring(default)
    end
    if n < range[1] then return range[1], name .. ": " .. tostring(n) .. " 太小，夹到 " .. tostring(range[1]) end
    if n > range[2] then return range[2], name .. ": " .. tostring(n) .. " 太大，夹到 " .. tostring(range[2]) end
    return n, nil
end

--- 用 modconfig 的值建一份有效配置。
--- get(key) 返回原始值（读不到就返回 nil）。
function C.build(get)
    local values = {}
    local problems = {}
    for name, default in pairs(C.DEFAULTS) do
        local raw = nil
        if type(get) == "function" then
            local ok, value = pcall(get, name)
            if ok then raw = value end
        end
        local value, note = C.clamp(name, raw)
        values[name] = value
        if note ~= nil then problems[#problems + 1] = note end
        if raw == nil then values[name] = default end
    end
    C.values = values
    C.problems = problems
    return values, problems
end

--- 取一个生效值（没建过就用默认值；给单文件测试兜底）
function C.get(name)
    local value = C.values ~= nil and C.values[name] or nil
    if value == nil then return C.DEFAULTS[name] end
    return value
end

Whale = Whale or {}
Whale.config = C
