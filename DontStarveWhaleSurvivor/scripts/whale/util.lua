-- 小工具：找实体、算距离、读背包、起名字
local GLOBAL = GLOBAL
-- 饥荒的模组沙箱只给了 pairs/ipairs/print/math/table/type/string/tostring/require/Class，
-- pcall / tonumber / error / os / io 这些得从 GLOBAL（就是 _G）里拿，直接用会报 nil（0.1.0 就是这么崩的）。
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local error = GLOBAL.error
local os = GLOBAL.os or { time = function() return 0 end }
local io = GLOBAL.io

local U = {}

U.TILE = 4 -- 饥荒一格是 4 个世界单位

--- 安全调用：出错就返回 default（默认 nil）。
--- 为什么需要它：模组沙箱里游戏 API 随时可能不存在（不同构建差异很大），
--- 直接调会让整个动作崩掉。真机教训：actions.lua 里有 9 处调 U.try，
--- 但这版 util 重写时漏了它 —— 于是 builder:CanBuild 那条路一走到就
--- "attempt to call a nil value (field 'try')"（recipes / lookup 都崩在这）。
function U.try(fn, default)
    if type(fn) ~= "function" then return default end
    local ok, value = pcall(fn)
    if ok then return value end
    return default
end

function U.world()
    return GLOBAL.TheWorld
end

--- 游戏内时间（秒，浮点，带毫秒精度）。
--- 真机 bug（2026-11-12）：原来用 TheSim:GetTime() —— 这个 API 在当前构建里**不存在**，
--- pcall 失败后恒返回 0。后果：所有超时判断（>120 秒）永不触发、所有冷却判断（>=0.2 秒）
--- 永不为真，导致「砍一下顿一下」的重放逻辑根本不生效，动作只能靠外层 120 秒兜底。
--- 现在按优先级取：TheSim:GetTime()（存在则用）→ TheSim:GetRealTime()/1000 → os.time()。
function U.now()
    local ok, t = pcall(function() return GLOBAL.GetTime() end)
    if ok and type(t) == "number" and t > 0 then return t end
    local ok1, t1 = pcall(function() return GLOBAL.TheSim:GetTime() end)
    if ok1 and type(t1) == "number" and t1 > 0 then return t1 end
    local ok2, ms = pcall(function() return GLOBAL.TheSim:GetRealTime() end)
    if ok2 and type(ms) == "number" and ms > 0 then return ms / 1000 end
    local ok3, s = pcall(function() return GLOBAL.os and GLOBAL.os.time() end)
    if ok3 and type(s) == "number" then return s end
    return 0
end

function U.pos(ent)
    if ent == nil or not ent:IsValid() or ent.Transform == nil then return nil end
    local x, y, z = ent.Transform:GetWorldPosition()
    return x, y, z
end

--- 世界坐标 -> 格子坐标（给 AI 看的都是格子）
function U.tile_of(x, z)
    return math.floor(x / U.TILE), math.floor(z / U.TILE)
end

function U.tile_center(tx, tz)
    return tx * U.TILE + U.TILE / 2, tz * U.TILE + U.TILE / 2
end

function U.dist(a, b)
    if a == nil or b == nil then return math.huge end
    local ax, _, az = U.pos(a)
    local bx, _, bz = U.pos(b)
    if ax == nil or bx == nil then return math.huge end
    local dx, dz = ax - bx, az - bz
    return math.sqrt(dx * dx + dz * dz)
end

function U.tile_dist(a, b)
    return U.dist(a, b) / U.TILE
end

--- 兼容 Lua 5.1 (math.atan2) 与 Lua 5.3 (math.atan)
function U.safe_atan2(y, x)
    if math.atan2 ~= nil then
        return math.atan2(y, x)
    elseif math.atan ~= nil then
        return math.atan(y, x)
    end
    return 0
end

--- 检查某世界坐标点是否为可行走陆地（排除海洋/虚空）
function U.is_passable(wx, wz)
    if wx == nil or wz == nil then return false end
    local world = GLOBAL.TheWorld
    if world == nil or world.Map == nil then
        return true -- 单测/无地图桩环境默认通过
    end
    local ok, passable = pcall(function()
        return world.Map:IsPassableAtPoint(wx, 0, wz, false, false)
    end)
    if not ok then return true end
    return passable == true
end

local function get_pt_coords(pt)
    if pt == nil then return nil, nil end
    if type(pt) == "table" then
        if pt.x ~= nil and pt.z ~= nil then return tonumber(pt.x), tonumber(pt.z) end
        if pt[1] ~= nil and pt[2] ~= nil then return tonumber(pt[1]), tonumber(pt[2]) end
    end
    if type(pt) == "table" or type(pt) == "userdata" then
        if pt.Transform ~= nil and pt.IsValid and pt:IsValid() then
            local x, _, z = pt.Transform:GetWorldPosition()
            return x, z
        end
    end
    return nil, nil
end

--- 连线探水函数：沿连线每 2 格（8 单位）采样一次 IsPassableAtPoint
--- 参数支持 (x1, z1, x2, z2) 或 (p1, p2) 对象/实体
function U.line_passable(p1, p2, ax_opt, az_opt)
    local x1, z1, x2, z2
    if type(p1) == "number" and type(p2) == "number" and type(ax_opt) == "number" and type(az_opt) == "number" then
        x1, z1, x2, z2 = p1, p2, ax_opt, az_opt
    else
        x1, z1 = get_pt_coords(p1)
        x2, z2 = get_pt_coords(p2)
    end
    if x1 == nil or z1 == nil or x2 == nil or z2 == nil then
        return false
    end

    if not U.is_passable(x1, z1) or not U.is_passable(x2, z2) then
        return false
    end

    local dx = x2 - x1
    local dz = z2 - z1
    local dist = math.sqrt(dx * dx + dz * dz)
    local step_dist = 2 * U.TILE -- 2 格 = 8 个世界单位

    if dist <= step_dist then
        local mx = x1 + dx * 0.5
        local mz = z1 + dz * 0.5
        return U.is_passable(mx, mz)
    end

    local steps = math.floor(dist / step_dist)
    for i = 1, steps do
        local t = (i * step_dist) / dist
        if t < 1.0 then
            local sx = x1 + dx * t
            local sz = z1 + dz * t
            if not U.is_passable(sx, sz) then
                return false
            end
        end
    end
    return true
end

--- 切线拐点试探（Coastline Detour）
--- 如果从当前点到目标点直线有水，以当前位置为中心，向左右两侧 45°、90° 方向探测陆地可行走点，
--- 找到一个既能站在陆地上、又能离最终目标更近（或直线直通终点）的中间拐点 Waypoint。
function U.find_coastline_detour(p1, p2, ax_opt, az_opt)
    local px, pz, tx, tz
    if type(p1) == "number" and type(p2) == "number" and type(ax_opt) == "number" and type(az_opt) == "number" then
        px, pz, tx, tz = p1, p2, ax_opt, az_opt
    else
        px, pz = get_pt_coords(p1)
        tx, tz = get_pt_coords(p2)
    end
    if px == nil or pz == nil or tx == nil or tz == nil then
        return nil
    end

    local dx = tx - px
    local dz = tz - pz
    local dist_target = math.sqrt(dx * dx + dz * dz)
    if dist_target < 0.5 then
        return nil
    end

    local theta = U.safe_atan2(dz, dx)
    -- 向左右两侧 45° 与 90° 探测
    local angle_offsets = { math.pi / 4, -math.pi / 4, math.pi / 2, -math.pi / 2 }
    -- 采样半径：4 格(16), 6 格(24), 3 格(12), 8 格(32)
    local probe_radii = { 16, 24, 12, 32 }

    local best = nil

    for _, dtheta in ipairs(angle_offsets) do
        local alpha = theta + dtheta
        for _, r in ipairs(probe_radii) do
            if r <= math.max(12, dist_target + 8) then
                local wx = px + r * math.cos(alpha)
                local wz = pz + r * math.sin(alpha)

                -- 1. 目标点本身必须在陆地上
                if U.is_passable(wx, wz) then
                    -- 2. 玩家到该拐点路径不能有水
                    if U.line_passable(px, pz, wx, wz) then
                        local d_to_tgt = math.sqrt((tx - wx) * (tx - wx) + (tz - wz) * (tz - wz))
                        local clear_to_tgt = U.line_passable(wx, wz, tx, tz)

                        local is_closer = d_to_tgt < (dist_target - 0.5)
                        local unlocks_path = clear_to_tgt and (d_to_tgt <= dist_target + 8.0)

                        if is_closer or unlocks_path then
                            -- 打分评估：能直通终点优先、离终点近优先、45°优先于90°、半径适中
                            local score = d_to_tgt
                                - (clear_to_tgt and 16 or 0)
                                + (math.abs(dtheta) > 1.0 and 2.0 or 0)
                                + (r * 0.05)

                            if best == nil or score < best.score then
                                local w_tx, w_tz = U.tile_of(wx, wz)
                                best = {
                                    wx = wx,
                                    wz = wz,
                                    tx = w_tx,
                                    tz = w_tz,
                                    dist_to_tgt = d_to_tgt,
                                    clear_to_tgt = clear_to_tgt,
                                    dtheta = dtheta,
                                    radius = r,
                                    score = score,
                                }
                            end
                        end
                    end
                end
            end
        end
    end

    return best
end

--- 现在操作的玩家。
--- M1.1 起这里只是**兼容层**：真正的"观察谁"由 Whale.actor（Actor Provider）决定，
--- 所有调用方（actions / observe / reflex / bridge）都通过它拿实体。
--- 只有在 actor.lua 没加载时（单文件测试）才退回下面这段旧的挑人逻辑。
function U.player()
    local provider = Whale ~= nil and Whale.actor or nil
    if provider ~= nil and provider.get_actor ~= nil then
        local ok, actor = pcall(provider.get_actor)
        if ok then return actor end
        return nil
    end

    local players = GLOBAL.AllPlayers
    if players == nil then return nil end
    local best = nil
    for _, p in pairs(players) do
        if p ~= nil and p:IsValid() and not p:HasTag("playerghost") then
            if best == nil then
                best = p
            elseif p:HasTag("player") and not best:HasTag("player") then
                best = p
            end
        end
    end
    if best == nil then
        -- 死了也算：至少能看到状态并告诉 AI
        for _, p in pairs(players) do
            if p ~= nil and p:IsValid() then best = p end
        end
    end
    return best
end

--- 附近所有符合条件的实体，按距离从近到远
function U.find_all(p, radius_tiles, musttags, mustoneoftags, filter)
    local list = {}
    if p == nil then return list end
    local x, y, z = U.pos(p)
    if x == nil then return list end
    local ok, ents = pcall(function()
        return GLOBAL.TheSim:FindEntities(x, y, z, radius_tiles * U.TILE, musttags, { "INLIMBO" }, mustoneoftags)
    end)
    if not ok or ents == nil then return list end
    for _, e in ipairs(ents) do
        if e ~= p and e:IsValid() and not e:HasTag("INLIMBO") then
            if filter == nil or filter(e) then
                list[#list + 1] = { ent = e, d = U.dist(p, e) }
            end
        end
    end
    table.sort(list, function(a, b) return a.d < b.d end)
    return list
end

function U.find_nearest(p, radius_tiles, musttags, mustoneoftags, filter)
    local list = U.find_all(p, radius_tiles, musttags, mustoneoftags, filter)
    if #list == 0 then return nil end
    return list[1].ent, list[1].d / U.TILE
end

--- 实体的中文名
function U.pretty(ent)
    if ent == nil then return "?" end
    local prefab = ent.prefab
    local names = GLOBAL.STRINGS and GLOBAL.STRINGS.NAMES
    local key = prefab and string.upper(prefab) or nil
    if names ~= nil and key ~= nil and names[key] ~= nil then
        return names[key]
    end
    if type(ent.name) == "string" and ent.name ~= "" and prefab ~= ent.name then
        return ent.name
    end
    return prefab or "?"
end

--- 格子里有什么东西用得上（给文字地图用）
function U.has_tag(ent, tag)
    return ent ~= nil and ent:IsValid() and ent:HasTag(tag)
end

--- 背包里所有物品（服务端权威）
function U.items(p)
    local list = {}
    if p == nil or p.components.inventory == nil then return list end
    local inv = p.components.inventory
    local ok, slots = pcall(function() return inv:GetNumSlots() end)
    if not ok or slots == nil then slots = 15 end
    for slot = 1, slots do
        local item = inv:GetItemInSlot(slot)
        if item ~= nil then
            list[#list + 1] = { item = item, slot = slot }
        end
    end
    return list
end

function U.count(item)
    if item == nil then return 0 end
    if item.components.stackable ~= nil then
        return item.components.stackable:StackSize()
    end
    return 1
end

--- 耐久 / 新鲜度百分比（有就返回 0~100，没有返回 nil）
function U.percent(item)
    if item == nil then return nil end
    if item.components.finiteuses ~= nil then
        local cur, max = item.components.finiteuses:GetUses(), item.components.finiteuses.total
        if max and max > 0 then return math.floor(cur / max * 100) end
    end
    if item.components.perishable ~= nil then
        return math.floor(item.components.perishable:GetPercent() * 100)
    end
    if item.components.fueled ~= nil then
        return math.floor(item.components.fueled:GetPercent() * 100)
    end
    if item.components.armor ~= nil then
        return math.floor(item.components.armor:GetPercent() * 100)
    end
    return nil
end

function U.describe_item(item)
    local text = U.pretty(item)
    local n = U.count(item)
    if n > 1 then text = text .. " ×" .. n end
    local pct = U.percent(item)
    if pct ~= nil then text = text .. "(" .. pct .. "%)" end
    return text
end

--- 某个 tag 里最“能吃”的东西
function U.is_food(item)
    return item ~= nil and item.components.edible ~= nil and item.components.edible.foodtype ~= nil
end

--- 背包里找物品：prefab 名或中文名都行
function U.find_item(p, want)
    if want == nil or want == "" then return nil end
    local needle = string.lower(tostring(want))
    local inv = p ~= nil and p.components.inventory or nil
    if inv == nil then return nil end
    local found = nil
    inv:ForEachItem(function(item)
        if found == nil and item ~= nil then
            local prefab = string.lower(item.prefab or "")
            local name = string.lower(U.pretty(item))
            if prefab == needle or name == needle or string.find(name, needle, 1, true) ~= nil then
                found = item
            end
        end
    end)
    return found
end

--- 服务端现在有几个玩家（诊断用）
function U.count_players()
    local players = GLOBAL.AllPlayers
    if players == nil then return -1 end
    local n = 0
    for _, p in pairs(players) do
        if p ~= nil then n = n + 1 end
    end
    return n
end

--- 饥荒的持久化字符串文件可能带一个 "KLEI     1 " 头，剥掉再当 JSON 解析
function U.strip_header(text)
    if type(text) ~= "string" then return text end
    return (string.gsub(text, "^KLEI%s+%d+%s*", "", 1))
end

function U.log(msg)
    if Whale ~= nil and Whale.verbose then
        print("[大肥鱼] " .. tostring(msg))
    end
end

--- 周期任务，不受世界暂停影响（SetServerPaused）
function U.DoStaticPeriodicTask(interval, fn)
    local w = U.world()
    if w ~= nil and w.DoStaticPeriodicTask ~= nil then
        return w:DoStaticPeriodicTask(interval, fn)
    end
    if GLOBAL.staticScheduler ~= nil and GLOBAL.staticScheduler.ExecutePeriodic ~= nil then
        local guid = (w ~= nil and w.GUID) or nil
        return GLOBAL.staticScheduler:ExecutePeriodic(interval, fn, nil, nil, guid, w)
    end
    if w ~= nil and w.DoPeriodicTask ~= nil then
        return w:DoPeriodicTask(interval, fn)
    end
    return nil
end

Whale = Whale or {}
Whale.util = U
