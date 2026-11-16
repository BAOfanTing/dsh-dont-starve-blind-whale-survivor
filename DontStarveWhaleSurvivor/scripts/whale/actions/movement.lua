-- 移动动作：move_to, go_to, seek, stop
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local Vector3 = GLOBAL.Vector3

local U = Whale.util

Whale = Whale or {}
Whale.actions = Whale.actions or {}
local A = Whale.actions
A.JOBS = A.JOBS or {}
local JOBS = A.JOBS

local walk_to = A.walk_to
local tile_away = A.tile_away
local find_by_name = A.find_by_name

JOBS.move_to = function(j, p)
    local tx = tonumber(j.args.x)
    local tz = tonumber(j.args.z)
    if tx == nil or tz == nil then
        return "fail", "move_to 要传格子坐标 x 和 z，比如 {\"x\":12,\"z\":45}"
    end
    if math.abs(tx) > 400 or math.abs(tz) > 400 then
        tx = math.floor(tx / U.TILE)
        tz = math.floor(tz / U.TILE)
        j.args.x, j.args.z = tx, tz
    end
    if j.step == "start" then
        walk_to(p, tx, tz)
        j.step = "walk"
        j.data.lastcheck = U.now()
        j.data.retry = 0
        local px, _, pz = U.pos(p)
        j.data.last_px = px
        j.data.last_pz = pz
    end
    local away = tile_away(p, tx, tz)
    if away <= 1.2 then
        return "done", string.format("走到了 (%d,%d) 附近（还差 %.1f 格）", tx, tz, away)
    end
    local timeout = tonumber(j.args.timeout) or 60
    if U.now() - j.t0 > timeout then
        return "fail", string.format("走不到 (%d,%d)：卡在 %.1f 格外（可能有东西挡着）", tx, tz, away)
    end
    if U.now() - j.data.lastcheck > 2 then
        j.data.lastcheck = U.now()
        local px, _, pz = U.pos(p)
        local moved = 0
        if px ~= nil and j.data.last_px ~= nil then
            local dx = px - j.data.last_px
            local dz = pz - j.data.last_pz
            moved = math.sqrt(dx * dx + dz * dz) / U.TILE
        end
        j.data.last_px = px
        j.data.last_pz = pz

        local loco = p.components.locomotor
        local moving = false
        if loco ~= nil then
            local ok_m, mv = pcall(function() return loco:WantsToMoveForward() end)
            if ok_m then moving = mv == true end
        end
        if (loco == nil or not moving) or (moved < 0.15) then
            j.data.retry = j.data.retry + 1
            local max_retry = (timeout <= 10) and 2 or 6
            if j.data.retry >= max_retry then
                return "fail", string.format("走不到 (%d,%d)：卡在 %.1f 格外（可能有东西挡着）", tx, tz, away)
            end
            walk_to(p, tx, tz)
        else
            j.data.retry = 0
        end
    end
    return "run"
end

JOBS.go_to = function(j, p)
    local want = j.args.target
    if want == nil or want == "" then
        return "fail", "go_to 要传 target（东西的名字，比如 berrybush、spider、cookpot；也可以用 tag:hostile）"
    end
    if j.step == "start" then
        local radius = tonumber(j.args.radius) or 30
        local list = find_by_name(p, radius, want)
        if #list == 0 then
            return "fail", string.format("附近 %d 格里没找到 %s", radius, tostring(want))
        end
        local ent = list[1].ent
        local x, _, z = U.pos(ent)
        local tx, tz = U.tile_of(x, z)
        j.data.name = U.pretty(ent)
        j.data.tx, j.data.tz = tx, tz
        walk_to(p, tx, tz)
        j.step = "walk"
        j.data.lastcheck = U.now()
    end
    local away = tile_away(p, j.data.tx, j.data.tz)
    if away <= 1.5 then
        return "done", string.format("走到 %s 旁边了 (%.1f 格)", j.data.name, away)
    end
    if U.now() - j.t0 > (tonumber(j.args.timeout) or 90) then
        return "fail", string.format("走不到 %s：卡在 %.1f 格外", j.data.name, away)
    end
    if U.now() - j.data.lastcheck > 2 then
        j.data.lastcheck = U.now()
        local loco = p.components.locomotor
        local moving = false
        if loco ~= nil then
            local ok_m, mv = pcall(function() return loco:WantsToMoveForward() end)
            if ok_m then moving = mv == true end
        end
        if loco == nil or not moving then
            walk_to(p, j.data.tx, j.data.tz)
        end
    end
    return "run"
end

JOBS.seek = function(j, p)
    local ctx = j.ctx or {}
    if ctx.survival_seek ~= true then
        return "fail", "seek 只能按白名单调用"
    end
    local TILE = 4
    if j.step == "start" then
        j.data.want = tostring(ctx.prefab or "")
        if j.data.want == "" then return "fail", "seek 要传 prefab" end
        j.data.max_tiles = math.max(4, tonumber(ctx.max_tiles) or 40)
        j.data.step_tiles = math.min(j.data.max_tiles, math.max(4, tonumber(ctx.step) or 10))
        j.data.look = math.max(8, tonumber(ctx.look) or 16)
        local px, _, pz = U.pos(p)
        if px == nil then return "fail", "读不到自己的位置" end
        j.data.origin = { px, pz }
        local dirs = {
            { 1, 0 }, { 0.7071, 0.7071 }, { 0, 1 }, { -0.7071, 0.7071 },
            { -1, 0 }, { -0.7071, -0.7071 }, { 0, -1 }, { 0.7071, -0.7071 },
        }
        j.data.plan = {}
        local rings = math.max(1, math.floor(j.data.max_tiles / j.data.step_tiles))
        for ring = 1, rings do
            for _, d in ipairs(dirs) do
                local wx = px + d[1] * ring * j.data.step_tiles * TILE
                local wz = pz + d[2] * ring * j.data.step_tiles * TILE
                local tx, tz = U.tile_of(wx, wz)
                local ok_water, water = pcall(function() return TheWorld.Map:IsOceanAtPoint(wx, 0, wz, false) end)
                if not (ok_water and water == true) then
                    j.data.plan[#j.data.plan + 1] = { wx, wz, tx, tz }
                end
            end
        end
        j.data.index = 0
        j.data.t0 = U.now()
        j.data.budget = math.max(10, (tonumber(ctx.budget_s) or 50) - 5)
        j.step = "look"
    end

    if j.step == "look" then
        local hits = {}
        local list = U.find_all(p, j.data.look, nil, nil, function(e)
            if e == nil or e == p or e.prefab == nil then return false end
            if tostring(e.prefab) ~= j.data.want then return false end
            return true
        end)
        for _, entry in ipairs(list or {}) do
            local e = entry.ent or entry
            if e ~= nil and e:IsValid() then
                local wx, wy, wz = e.Transform:GetWorldPosition()
                local tx, tz = U.tile_of(wx, wz)
                hits[#hits + 1] = { ent = e, tx = tx, tz = tz, dist = U.dist(p, e) }
            end
        end
        table.sort(hits, function(a, b) return (a.dist or 999) < (b.dist or 999) end)
        if #hits > 0 then
            local names = {}
            for i = 1, math.min(#hits, 5) do
                names[#names + 1] = string.format("%s(%d,%d)%.0f格",
                    U.pretty(hits[i].ent), hits[i].tx, hits[i].tz, (hits[i].dist or 0) / TILE)
            end
            return "done", string.format("找到了 %d 个 %s：%s。先用 move_to 走过去（或直接对它用动作）",
                #hits, j.data.want, table.concat(names, "、"))
        end
        j.data.index = j.data.index + 1
        if j.data.index > #j.data.plan or U.now() - j.data.t0 > (j.data.budget or 45) then
            local tx, tz = U.tile_of(j.data.origin[1], j.data.origin[2])
            return "fail", string.format("从 (%d,%d) 往外搜索 %g 格范围也没看到 %s（换个方向再 seek，或者改找别的）",
                tx, tz, j.data.max_tiles, j.data.want)
        end
        local target = j.data.plan[j.data.index]
        j.data.cur = target
        p.components.locomotor:GoToPoint(Vector3(target[1], 0, target[2]))
        j.data.walk_start = U.now()
        j.step = "walk"
        return "run"
    end

    if j.step == "walk" then
        local tgt = j.data.cur
        local px, _, pz = U.pos(p)
        if px == nil then return "fail", "读不到自己的位置" end
        local dx, dz = tgt[1] - px, tgt[2] - pz
        local far = math.sqrt(dx * dx + dz * dz)
        if far <= TILE * 1.5 then
            j.step = "look"
            return "run"
        end
        if U.now() - j.data.walk_start > 25 then
            j.step = "look"
            return "run"
        end
        return "run"
    end
    return "run"
end

JOBS.stop = function(j, p)
    local loco = p.components.locomotor
    if loco ~= nil then
        pcall(function()
            loco:Stop()
            loco:Clear()
        end)
    end
    return "done", "停下了"
end
