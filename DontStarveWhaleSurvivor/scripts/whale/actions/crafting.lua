-- 制作与建筑动作：craft, build, cook, recipes, lookup, probe, list_recipes
local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall or pcall
local tonumber = GLOBAL.tonumber or tonumber
local tostring = tostring or (GLOBAL and GLOBAL.tostring)

local ACTIONS = GLOBAL.ACTIONS
local Vector3 = GLOBAL.Vector3
local BufferedAction = GLOBAL.BufferedAction

local U = Whale.util

Whale = Whale or {}
Whale.actions = Whale.actions or {}
local A = Whale.actions
A.JOBS = A.JOBS or {}
local JOBS = A.JOBS

local busy = A.busy
local push = A.push
local tile_away = A.tile_away
local walk_to = A.walk_to
local recipe_of = A.recipe_of
local missing_ingredients = A.missing_ingredients
local hand_prefab = A.hand_prefab
local snapshot_counts = A.snapshot_counts
-- 科技判定**只走这里**（craftrules.CanCraftNow），不要在动作里自己调 builder:KnowsRecipe：
-- 那个 API 不算"站在科学机器旁边"的临时科技，真机上机器造好了也判"还不会做"。
local craftrules = Whale.craftrules

local RECIPE_ALIASES = {
    chest = "treasurechest",
    treasurechest = "treasurechest",
    sciencemachine = "researchlab",
    researchlab = "researchlab",
    -- TENT（2026-11-17）：炼金引擎 / 帐篷
    alchemyengine = "researchlab2",
    researchlab2 = "researchlab2",
    tent = "tent",
}

--- 这块地能不能放下这个东西
local function can_deploy(recipe, x, z)
    local world = GLOBAL.TheWorld
    if world == nil or world.Map == nil then return false end
    local ok, res = pcall(function() return world.Map:CanDeployRecipeAtPoint(Vector3(x, 0, z), recipe, 0) end)
    return ok and res == true
end

--- 没给坐标时，从脚下往外找一个放得下的格子
local function find_spot(p, recipe)
    local px, _, pz = U.pos(p)
    if px == nil then return nil end
    local bx, bz = U.tile_of(px, pz)
    local around = {
        { 0, 0 }, { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 },
        { 1, 1 }, { -1, -1 }, { 1, -1 }, { -1, 1 },
        { 2, 0 }, { -2, 0 }, { 0, 2 }, { 0, -2 },
    }
    for _, d in ipairs(around) do
        local x, z = U.tile_center(bx + d[1], bz + d[2])
        if can_deploy(recipe, x, z) then return bx + d[1], bz + d[2] end
    end
    return nil
end

local function job_build(j, p)
    if j.step == "start" then
        local recipe, key = recipe_of(j.args.recipe or j.args.name)
        if recipe == nil then
            return "fail", "没有这个配方：" .. tostring(j.args.recipe)
        end
        if recipe.placer == nil then
            return "fail", tostring(key) .. " 不是要摆出来的东西，用 craft 就行"
        end
        local builder = p.components.builder
        if builder == nil then return "fail", "你现在不能建造" end
        -- 科技判定统一走 craftrules（内部用原版 CanBuild，会算上"站在科学机器旁边"的临时科技）
        local knows0 = craftrules ~= nil and craftrules.CanCraftNow ~= nil and craftrules.CanCraftNow(p, key) or nil
        if knows0 == false
            and not (craftrules ~= nil and craftrules.HasNearbyPrototyper ~= nil
                and craftrules.HasNearbyPrototyper(p, 8)) then
            return "fail", string.format("%s 还不会做（要先解锁）",
                craftrules ~= nil and craftrules.TechHint ~= nil and craftrules.TechHint(key) or key)
        end
        local missing = missing_ingredients(p, recipe)
        if missing ~= nil then
            return "fail", string.format("%s %s", key, missing)
        end
        local tx = tonumber(j.args.x)
        local tz = tonumber(j.args.z)
        if tx == nil or tz == nil then
            local fx, fz = find_spot(p, recipe)
            if fx == nil then
                return "fail", "附近找不到能放下 " .. key .. " 的地方（被东西占了？）"
            end
            tx, tz = fx, fz
        end
        j.data.recipe, j.data.key = recipe, key
        j.data.tx, j.data.tz = tx, tz
        j.step = "goto"
    end
    if j.step == "goto" then
        local away = tile_away(p, j.data.tx, j.data.tz)
        if away > 2.5 then
            walk_to(p, j.data.tx, j.data.tz)
            if U.now() - j.t0 > 120 then return "fail", "走不到要摆的位置" end
            return "run"
        end
        j.step = "place"
        return "run"
    end
    if j.step == "place" then
        if busy(p) then
            if U.now() - j.t0 > 180 then return "fail", "摆东西卡住了" end
            return "run"
        end
        local x, z = U.tile_center(j.data.tx, j.data.tz)
        if not can_deploy(j.data.recipe, x, z) then
            return "fail", string.format("(%d,%d) 这块地放不下 %s", j.data.tx, j.data.tz, j.data.key)
        end
        local builder = p.components.builder
        local ok, started = pcall(function()
            return builder:MakeRecipe(j.data.recipe, Vector3(x, 0, z), 0, nil)
        end)
        if not ok or started ~= true then
            return "fail", "摆放没成功（材料不够？）"
        end
        j.step = "acting"
        j.data.phase_start = U.now()
        return "run"
    end
    if busy(p) and U.now() - j.data.phase_start < 60 then return "run" end
    return "done", string.format("在 (%d,%d) 摆了 %s", j.data.tx, j.data.tz, j.data.key)
end

--- 能放到地上的建筑白名单（和 craftrules 一样：必须以游戏脚本里的真实配方为准）
local BUILD_ALLOWED = {
    campfire = true,      -- 营火：2 草 + 3 树枝，TECH.NONE
    firepit = true,       -- 石头火坑：2 石头 + 12 木头，TECH.NONE
    chest = true,         -- 箱子：3 木板，TECH.NONE（原生配方名 treasurechest）
    treasurechest = true,
    cookpot = true,       -- 锅：3 木炭 + 6 树枝 + 6 石头，TECH.SCIENCE_ONE
    sciencemachine = true,-- 科学机器：**log 4** + rocks 4 + goldnugget 1，TECH.NONE（原生配方名 researchlab）
                          -- 注意是原木 log，不是木板 boards（boards 要 TECH.SCIENCE_ONE，得先有机器）
    researchlab = true,
    -- ── TENT（2026-11-17）：帐篷链 ──
    -- 炼金引擎（原生配方名 researchlab2）：boards 4 + cutstone 2 + transistor 2，TECH.SCIENCE_ONE
    --   boards/cutstone/transistor 都要站在科学机器旁边做（craft 白名单里有）
    alchemyengine = true,
    researchlab2 = true,
    -- 帐篷（原生配方名 tent）：silk 6 + twigs 4 + rope 3，TECH.SCIENCE_TWO
    --   要站在炼金引擎旁边才能摆；摆好后用 sleep 睡觉
    tent = true,
}

--- 放在地上：选点 → MakeRecipe → 用"附近同 prefab 数量变多"确认
local function build_by_ctx(j, p)
    local ctx = j.ctx or {}
    local name = tostring(ctx.build_recipe or "")
    if name == "" then return "fail", "build 需要 recipe" end
    if BUILD_ALLOWED[name] ~= true then
        return "fail", "recipe_not_allowed: 只能建 " .. "campfire/firepit/chest/cookpot/sciencemachine/researchlab2/tent"
    end
    local builder = p.components ~= nil and p.components.builder or nil
    if builder == nil then return "fail", "no_builder: 这个角色不能制作" end

    local expected_prefab = RECIPE_ALIASES[name] or name
    -- 附近这个 prefab 现在有几个（用来判断"我真的放下去了一个"）
    local function count_near(x, z)
        if x == nil then return 0 end
        local n = 0
        local list = U.find_all(p, 12, nil, nil, function(e)
            return e ~= nil and e.prefab == expected_prefab
        end)
        for _, entry in ipairs(list or {}) do
            local e = entry.ent or entry
            if e ~= nil and e:IsValid() then n = n + 1 end
        end
        return n
    end

    if j.step == "start" then
        local recipe = recipe_of(name)
        if recipe == nil then return "fail", "unknown_recipe: 游戏里没有 " .. name end
        if recipe.placer == nil then return "fail", "not_placeable: " .. name .. " 不是能放到地上的建筑" end
        j.data.recipe = recipe
        j.data.name = name
        j.data.before_count = count_near(1, 1)
        j.data.phase_start = U.now()
        j.data.tried = 0
        j.step = "place"
        return "run"
    end

    if j.step == "place" then
        -- ① 已经排上队：等建筑真的出现在地上
        if j.data.pending then
            if count_near(1, 1) > j.data.before_count then
                return "done", string.format("把 %s 放下了", name)
            end
            if U.now() - (j.data.pushed_at or U.now()) > 8 then
                j.data.pending = false
                j.data.spot = nil   -- 这个点放不下，换点再试
            else
                return "run"
            end
        end

        -- ② 材料 / 科技
        local can = U.try(function() return builder:CanBuild(j.data.recipe.name) end)
        if not can then
            -- ★ TARGET-REFRESH：缺料要说清"差什么、差几个"。
            --   以前这里只回一句"材料不够"，模型不知道还差 goldnugget 1 还是 rocks 4，
            --   只能反复盲试（真机 `build sciencemachine` 就是这么卡住的）。
            --   材料数字优先读原版 AllRecipes（craftrules.MissingIngredients 内部就是这条路径）。
            local cr = Whale ~= nil and Whale.craftrules or nil
            local detailed = nil
            if cr ~= nil and cr.MissingIngredients ~= nil then
                -- ★ 注意用**原生配方名**（expected_prefab）：craftrules 的表键是 researchlab，
                --   传 sciencemachine 会查不到配方、反而退化成"材料不够"。
                detailed = cr.MissingIngredients(p, expected_prefab)
                if detailed == nil and expected_prefab ~= name then
                    detailed = cr.MissingIngredients(p, name)
                end
            end
            if detailed ~= nil and string.sub(detailed, 1, 19) == "ingredients_missing" then
                return "fail", detailed
            end
            local missing = missing_ingredients(p, j.data.recipe)
            if missing ~= nil then return "fail", "ingredients_missing: " .. tostring(missing) end
            return "fail", "cannot_build: 造不了 " .. name .. "（科技不够？）"
        end

        -- ③ 选点：脚边 9 个候选里第一个放得下的
        if j.data.spot == nil then
            local px, _, pz = U.pos(p)
            if px == nil then return "fail", "no_position" end
            if j.data.spots == nil then
                -- P2：落点离角色太近会被自身碰撞半径挡住；改用更大间距，并先用 can_deploy 预检，
                -- 避免每个坏点都要空等一次放置失败（8 秒）。
                local offsets = {
                    { 0, 6 }, { 6, 0 }, { -6, 0 }, { 0, -6 },
                    { 4.5, 4.5 }, { -4.5, 4.5 }, { 4.5, -4.5 }, { -4.5, -4.5 },
                    { 0, 10 }, { 10, 0 }, { -10, 0 }, { 0, -10 },
                }
                j.data.spots = {}
                for _, o in ipairs(offsets) do
                    local sx, sz = px + o[1], pz + o[2]
                    if can_deploy(j.data.recipe, sx, sz) then
                        j.data.spots[#j.data.spots + 1] = { sx, sz }
                    end
                end
                if #j.data.spots == 0 then j.data.spots[1] = { px, pz } end
            end
            j.data.tried = (j.data.tried or 0) + 1
            if j.data.tried > #j.data.spots then
                return "fail", "no_space: 附近没有能放下 " .. name .. " 的空地"
            end
            j.data.spot = j.data.spots[j.data.tried]
        end

        -- ④ 排队（放下要走 BUILD 动作，等它演完；由 ① 确认）
        j.data.before_count = count_near(1, 1)
        local called, queued = pcall(function()
            return builder:MakeRecipe(j.data.recipe, Vector3(j.data.spot[1], 0, j.data.spot[2]), 0, nil)
        end)
        if called ~= true or queued ~= true then
            j.data.spot = nil
            return "run"
        end
        j.data.pending = true
        j.data.pushed_at = U.now()
        return "run"
    end
    return "run"
end

-- 分流：带 ctx.survival_build 走新路径；否则走旧实现（reflex 用）
JOBS.build = function(j, p)
    local ctx = j.ctx or {}
    if ctx.survival_build == true then return build_by_ctx(j, p) end
    j.data.placeable = true
    return job_build(j, p)
end

JOBS.craft = function(j, p)
    local ctx = j.ctx or {}
    if ctx.survival_craft == true then
        local rules = Whale ~= nil and Whale.craftrules or nil
        if rules == nil then return "fail", "craft_rules_missing" end
        local name = tostring(ctx.recipe or "")
        local ok_r, why_r = rules.IsAllowed(name)
        if not ok_r then return "fail", (why_r or "recipe_not_allowed") .. ": " .. name .. "（只开放 " .. table.concat(rules.RecipeList(), "/") .. "）" end

        local builder = p.components ~= nil and p.components.builder or nil
        if builder == nil then return "fail", "no_builder: 角色现在不能制作东西" end

        if j.step == "start" then
            local recipe = recipe_of(name)
            if recipe == nil then return "fail", "recipe_unknown: 游戏里没有这个配方" end
            -- ★ 真机 bug（2026-11-17）：这里原来用 `builder:KnowsRecipe(recipe)` —— 它
            --   **不算**"站在科学机器旁边"的临时科技（`_tempbonus` 靠玩家 controller 刷新，
            --   服务端 actor 上经常还没刷到）。真机表现：机器造好了、人站在 0.7 格内，
            --   guard 已放行，执行层却在这里又拦一次，回执是
            --   「recipe_locked: 还不会做 rope（需要先解锁）」。
            --   现在科技判定**只在 craftrules.CanCraftNow 一处**，guard 与这里同源。
            local knows = rules.CanCraftNow ~= nil and rules.CanCraftNow(p, name) or nil
            if knows == false then
                -- 身边真有 prototyper 就不拦，交给下面 MakeRecipe 定（它才是权威）
                if rules.HasNearbyPrototyper == nil or not rules.HasNearbyPrototyper(p, 8) then
                    return "fail", "recipe_locked: 还不会做 " .. name .. "（"
                        .. (rules.TechHint ~= nil and rules.TechHint(name) or "需要先解锁") .. "）"
                end
            end
            local missing = rules.MissingIngredients(p, name)
            if missing ~= nil then
                return "fail", missing
            end
            j.data.name = name
            j.data.label = (rules.RECIPES[name] ~= nil and rules.RECIPES[name].label) or name
            j.data.before = snapshot_counts(p)
            -- ★ 真机 bug：空手做 torch 时，原生 DoBuild 会**直接装备**而不是放进背包。
            --   只比较背包数量会把"做成功且已拿在手里"误判成"成品没进背包"，
            --   模型因此以为材料被扣、成品消失，转头去做别的，天黑前没光。
            j.data.hand_before = hand_prefab(p)
            j.data.phase_start = U.now()
            -- ★ 不能用 BufferedAction：它的签名是 (doer, target, action, invobject, pos, recipe, ...)，
            --   第 4 个参数是 invobject，构造时会读 invobject.replica —— 把 recipe 传进去会崩
            --   （真机实测：bufferedaction.lua:8 attempt to index field 'replica'）。
            --   服务端制作走 builder:MakeRecipe（和旧路径一致，也是玩家点制作栏的底层调用）。
            local ok_mk, started = pcall(function() return builder:MakeRecipe(recipe, nil, nil, nil) end)
            if not ok_mk then
                return "fail", "craft_failed: " .. tostring(started)
            end
            if started ~= true then
                return "fail", "craft_failed: 游戏拒绝了这次制作（材料或状态不允许）"
            end
            j.step = "acting"
            return "run"
        end

        if busy(p) and U.now() - j.data.phase_start < 20 then return "run" end
        local after = snapshot_counts(p)
        local made = (after[j.data.name] or 0) - (j.data.before[j.data.name] or 0)
        local hand_after = hand_prefab(p)
        local auto_equipped = hand_after == j.data.name and j.data.hand_before ~= j.data.name
        if made > 0 or auto_equipped then
            -- 顺便报告材料消耗
            local used = {}
            -- ★ TARGET-REFRESH：材料表优先读原版 AllRecipes（和 guard 的 MissingIngredients
            -- 同一份来源），读不到才退回兜底表 —— 不在这里再抄一份数字。
            local need = (rules.NeededIngredients ~= nil and rules.NeededIngredients(j.data.name))
                or (rules.RECIPES[j.data.name] ~= nil and rules.RECIPES[j.data.name].ingredients) or {}
            for prefab in pairs(need) do
                local spent = (j.data.before[prefab] or 0) - (after[prefab] or 0)
                if spent > 0 then used[#used + 1] = string.format("%s-%d", prefab, spent) end
            end
            table.sort(used)
            local tail = #used > 0 and ("（" .. table.concat(used, "，") .. "）") or ""
            -- 有的构建里 ForEachItem 会把装备槽也算进背包总数（真机/沙箱都出现过），
            -- 于是"自动装备"同时满足 made > 0。此时必须优先说清"在手上"，
            -- 否则模型仍会以为成品进了背包，转头又 equip 一次或继续找。
            if auto_equipped then
                return "done", string.format("做好了 %s，已自动拿在手里（%s）%s",
                    j.data.label, j.data.name, tail)
            end
            return "done", string.format("做好了 %s（%s+%d）%s", j.data.label, j.data.name, made, tail)
        end
        if U.now() - j.data.phase_start > 20 then
            return "fail", "craft_failed: 材料没消耗、成品没进背包"
        end
        return "run"
    end

    -- ── 旧路径（reflex / macros 用），语义不变 ──
    if j.step == "start" then
        local recipe, key = recipe_of(j.args.recipe or j.args.name)
        if recipe == nil then
            return "fail", "没有这个配方：" .. tostring(j.args.recipe) .. "（用游戏里的配方名，比如 torch、axe、spear、campfire）"
        end
        local builder = p.components.builder
        if builder == nil then return "fail", "你现在不能制作东西" end
        -- 科技判定统一走 craftrules（旧路径 reflex/macros 也一样，别再自己调 KnowsRecipe）
        local knows0 = craftrules ~= nil and craftrules.CanCraftNow ~= nil and craftrules.CanCraftNow(p, key) or nil
        if knows0 == false
            and not (craftrules ~= nil and craftrules.HasNearbyPrototyper ~= nil
                and craftrules.HasNearbyPrototyper(p, 8)) then
            return "fail", string.format("%s 还不会做（要先做科学机器/靠近它解锁）", key)
        end
        local missing = missing_ingredients(p, recipe)
        if missing ~= nil then
            return "fail", string.format("%s %s", key, missing)
        end
        j.data.recipe, j.data.key = recipe, key
        j.data.placeable = recipe.placer ~= nil
        j.data.count = tonumber(j.args.count) or 1
        j.data.done_count = 0
        j.step = "acting"
    end
    if j.data.placeable then
        return job_build(j, p)
    end
    if j.data.pending then
        if busy(p) then
            if U.now() - j.t0 > 120 then return "fail", "做东西卡住了" end
            return "run"
        end
        j.data.pending = nil
    end
    if j.data.done_count >= j.data.count then
        return "done", string.format("做了 %d 个 %s", j.data.done_count, j.data.key)
    end
    if busy(p) then
        if U.now() - j.t0 > 180 then return "fail", "手上一直忙着，没做出东西" end
        return "run"
    end
    local builder = p.components.builder
    -- 注意：MakeRecipeFromMenu / MakeRecipeAtPoint 是客户端菜单用的，服务端调用会因为
    -- "背包没被打开"直接 return（什么也不做），所以这里必须用 MakeRecipe。
    local ok, started = pcall(function() return builder:MakeRecipe(j.data.recipe, nil, nil, nil) end)
    if not ok then return "fail", "制作出错：" .. tostring(started) end
    if started ~= true then
        return "fail", string.format("%s 没做出来（材料或状态不允许）", j.data.key)
    end
    j.data.pending = true
    j.data.done_count = j.data.done_count + 1
    return "run"
end

local function campfire_cook(j, p)
    if j.step == "start" then
        local cooker = U.find_nearest(p, tonumber(j.args.radius) or 12, { "cooker" }, nil, function(e)
            local fuel = e.components ~= nil and e.components.fueled or nil
            return fuel == nil or not fuel:IsEmpty()
        end)
        if cooker == nil then
            return "fail", "附近没有烧着的东西（营火/火坑），先在旁边生个火"
        end
        local ingredient = nil
        if j.args.item ~= nil and j.args.item ~= "" then
            ingredient = U.find_item(p, j.args.item)
        else
            local inv = p.components.inventory
            if inv ~= nil then
                inv:ForEachItem(function(item)
                    if ingredient == nil and item.components.cookable ~= nil then ingredient = item end
                end)
            end
        end
        if ingredient == nil then
            return "fail", "背包里没有能烤/煮的东西"
        end
        if busy(p) then
            if U.now() - j.t0 > 20 then return "fail", "忙着，没烤上" end
            return "run"
        end
        j.data.name = U.pretty(ingredient)
        j.data.cooker = cooker
        push(p, BufferedAction(p, cooker, ACTIONS.COOK, ingredient))
        j.data.phase_start = U.now()
        j.step = "acting"
        return "run"
    end
    if busy(p) and U.now() - j.data.phase_start < 20 then return "run" end
    return "done", string.format("把 %s 放到火上烤了（烤好的东西在火堆旁边/背包里，记得吃掉）", j.data.name)
end

--- 锅：放材料进去开始煮；已经煮好就拿出来
JOBS.cook = function(j, p)
    local ctx = j.ctx or {}
    local pot = ctx.target
    if pot == nil then
        if j.args ~= nil and (j.args.item ~= nil or j.args.radius ~= nil) then
            return campfire_cook(j, p)
        end
        return "fail", "cook 只能按 #N 引用调用"
    end
    if not pot:IsValid() then return "fail", "entity_gone: 锅已经没了" end
    local stewer = pot.components ~= nil and pot.components.stewer or nil
    local container = pot.components ~= nil and pot.components.container or nil
    if stewer == nil and container == nil then
        return "fail", "target_not_cookpot: 那不是锅（cookpot 要先在科学机器旁造出来）"
    end

    if j.step == "start" then
        j.data.label = U.pretty(pot)
        j.data.before = snapshot_counts(p)
        j.data.phase_start = U.now()
        -- ① 已经煮好 → 拿出来
        if stewer ~= nil then
            local done = false
            pcall(function() done = stewer:IsDone() end)
            if done then
                local ok = pcall(function() stewer:Harvest(p) end)
                if not ok then return "fail", "cook_harvest_failed" end
                j.data.action = "harvest"
                j.step = "acting"
                return "run"
            end
            local cooking = false
            pcall(function() cooking = stewer:IsCooking() end)
            if cooking then
                local left = 0
                pcall(function() left = stewer:GetTimeToCook() or 0 end)
                return "done", string.format("锅里已经在煮了（还有 %d 秒），等一会儿再来拿", math.floor(left))
            end
        end
        -- ② 没在煮 → 放材料
        local want = ctx.cook_items
        local list = {}
        if want ~= nil and tostring(want) ~= "" then
            for name in string.gmatch(tostring(want), "[^,%s]+") do
                local item = U.find_item(p, name)
                if item ~= nil then list[#list + 1] = item end
                if #list >= 4 then break end
            end
        else
            -- 自动挑：带 cookable 的肉/菜
            local inv = p.components ~= nil and p.components.inventory or nil
            if inv ~= nil then
                pcall(function()
                    inv:ForEachItem(function(item)
                        if #list >= 4 then return end
                        if item == nil or not item:IsValid() then return end
                        local cookable = item.components ~= nil and item.components.cookable or nil
                        if cookable == nil then return end
                        local meat = item:HasTag("meat")
                        local veggie = item:HasTag("veggie")
                        if meat or veggie then list[#list + 1] = item end
                    end)
                end)
            end
        end
        if #list == 0 then return "fail", "no_ingredients: 背包里没有能下锅的材料" end
        local added = 0
        for _, item in ipairs(list) do
            if item:IsValid() and container ~= nil then
                local ok = pcall(function() container:GiveItem(item, nil, pot:GetPosition()) end)
                if ok then added = added + 1 end
            end
        end
        if added == 0 then return "fail", "cook_put_failed: 材料放不进锅里（锅满了？）" end
        if stewer ~= nil then pcall(function() stewer:StartCooking(p) end) end
        j.data.added = added
        j.data.action = "put"
        j.step = "acting"
        return "run"
    end

    if j.step == "acting" then
        local after = snapshot_counts(p)
        if j.data.action == "put" then
            -- 放材料：背包里这些东西应该少了
            local lost = 0
            for prefab, n in pairs(j.data.before) do
                local d = n - (after[prefab] or 0)
                if d > 0 then lost = lost + d end
            end
            if lost > 0 then
                return "done", string.format("往锅里放了 %d 样材料，开始煮了（等 40 秒左右再来拿）", j.data.added)
            end
            if U.now() - j.data.phase_start > 10 then
                return "fail", "cook_put_failed: 材料没进锅"
            end
            return "run"
        end
        -- 拿成品：背包里应该多了东西
        local gained = 0
        for prefab, n in pairs(after) do
            local d = n - (j.data.before[prefab] or 0)
            if d > 0 then gained = gained + d end
        end
        if gained > 0 then return "done", "锅里的东西做好了，已经拿出来" end
        if U.now() - j.data.phase_start > 10 then
            return "fail", "cook_harvest_failed: 没拿到东西"
        end
        return "run"
    end
    return "run"
end

--- 材料清单文案：把配方的材料 + 玩家现有数量一起写出来
--- 返回 (ingredients_text, missing_text)
local function recipe_cost_text(recipe, counts)
    local ings, missing = {}, {}
    for _, ing in ipairs(recipe.ingredients or {}) do
        -- ing.type 正常是字符串；有些配方用表表示"任选一种"，跳过（不猜）
        if type(ing.type) == "string" then
            local need = tonumber(ing.amount) or 1
            local have = counts[ing.type] or 0
            ings[#ings + 1] = string.format("%s×%d", ing.type, need)
            if have < need then
                missing[#missing + 1] = string.format("%s %d/%d", ing.type, have, need)
            end
        end
    end
    return table.concat(ings, " + "), table.concat(missing, "，")
end

--- 查配方（只读）：能做哪些、还差什么材料
JOBS.recipes = function(j, p)
    local ctx = j.ctx or {}
    local want = ctx.recipe_filter
    local builder = p.components ~= nil and p.components.builder or nil
    if builder == nil then return "fail", "no_builder: 这个角色不能制作" end
    -- 游戏全局走 GLOBAL（不是 U.g —— 那个函数不存在，真机一调就崩）
    local all = GLOBAL.AllRecipes or {}
    local counts = (Whale.craftrules ~= nil and Whale.craftrules.Counts ~= nil)
        and Whale.craftrules.Counts(p) or {}
    local names = {}
    for name in pairs(all) do names[#names + 1] = tostring(name) end
    table.sort(names)

    local lines = {}
    local shown, can_count = 0, 0
    local limit = math.min(tonumber(ctx.limit) or 30, 60)
    for _, name in ipairs(names) do
        local recipe = all[name]
        if recipe ~= nil and (want == nil or want == "" or string.find(name, tostring(want), 1, true) ~= nil) then
            -- can  = 现在能不能做（CanBuild，含"站在科学机器旁边"的临时科技）
            -- knows = **永久**解锁了吗（KnowsRecipe 第二参 true = 忽略临时科技）
            local can = U.try(function() return builder:CanBuild(name) end) == true
            local knows = U.try(function() return builder:KnowsRecipe(name, true) end) == true
            local cost, missing = recipe_cost_text(recipe, counts)
            local status
            if can then
                status = "能做（" .. cost .. "）"
                can_count = can_count + 1
            elseif knows then
                status = "差材料：" .. (missing ~= "" and missing or "（算不出来）") .. "；需要 " .. cost
            else
                status = "科技没解锁；需要 " .. cost
            end
            lines[#lines + 1] = name .. "：" .. status
            shown = shown + 1
            if shown >= limit then break end
        end
    end
    if #lines == 0 then
        return "done", want ~= nil and ("没有匹配「" .. tostring(want) .. "」的配方") or "查不到配方"
    end
    return "done", string.format("配方 %d 个（其中 %d 个现在就能做）：\n%s",
        #lines, can_count, table.concat(lines, "\n"))
end

--- 查游戏数据（只读）：某个 prefab 是什么、怎么做、能干什么
JOBS.lookup = function(j, p)
    local ctx = j.ctx or {}
    local q = tostring(ctx.lookup_query or "")
    if q == "" then return "fail", "lookup 需要 q" end
    local lines = {}
    local counts = (Whale.craftrules ~= nil and Whale.craftrules.Counts ~= nil)
        and Whale.craftrules.Counts(p) or {}
    local builder = p.components ~= nil and p.components.builder or nil

    -- ① 当作配方查：材料 + 现在够不够 + 能不能造
    local recipe = recipe_of(q)
    if recipe ~= nil then
        local cost, missing = recipe_cost_text(recipe, counts)
        lines[#lines + 1] = string.format("配方 %s：%s", q, cost ~= "" and cost or "（无材料）")
        if builder ~= nil then
            local can = U.try(function() return builder:CanBuild(q) end) == true
            if can then
                lines[#lines + 1] = "  现在就能做"
            else
                lines[#lines + 1] = "  还差：" .. (missing ~= "" and missing or "科技没解锁")
            end
        end
        if recipe.placer ~= nil then lines[#lines + 1] = "  这是建筑，能放到地上（build）" end
    end
    -- ② 背包里有几个
    local have = counts[q]
    if have ~= nil then lines[#lines + 1] = string.format("你背包里有 %s×%d", q, have) end
    -- ③ 是不是游戏里存在的 prefab（不问就说没有，别硬凑）
    if GLOBAL.Prefabs ~= nil and GLOBAL.Prefabs[q] ~= nil then
        lines[#lines + 1] = string.format("游戏里存在这个 prefab：%s", q)
    end
    if #lines == 0 then
        return "done", string.format("没查到 %s（用英文 prefab 名试试，比如 axe / log / cookpot）", q)
    end
    return "done", table.concat(lines, "\n")
end

--- 探测附近某个 prefab（只读）：不靠 get_state，直接看这一带有没有
JOBS.probe = function(j, p)
    local ctx = j.ctx or {}
    local want = tostring(ctx.probe_prefab or "")
    if want == "" then return "fail", "probe 需要 prefab" end
    local radius = math.min(tonumber(ctx.probe_radius) or 16, 40)
    local hits = {}
    local list = U.find_all(p, radius, nil, nil, function(e)
        return e ~= nil and e.prefab ~= nil and tostring(e.prefab) == want
    end)
    for _, entry in ipairs(list or {}) do
        local e = entry.ent or entry
        if e ~= nil and e:IsValid() then
            local ex, _, ez = U.pos(e)
            local tx, tz = U.tile_of(ex, ez)
            hits[#hits + 1] = { tx = tx, tz = tz, dist = U.dist(p, e) }
        end
    end
    table.sort(hits, function(a, b) return (a.dist or 999) < (b.dist or 999) end)
    if #hits == 0 then
        return "done", string.format("%d 格内没有 %s", radius, want)
    end
    local parts = {}
    for i = 1, math.min(#hits, 8) do
        parts[#parts + 1] = string.format("(%d,%d)%.0f格", hits[i].tx, hits[i].tz, (hits[i].dist or 0) / 4)
    end
    return "done", string.format("%d 格内有 %d 个 %s：%s", radius, #hits, want, table.concat(parts, "、"))
end

JOBS.list_recipes = function(j, p)
    local builder = p.components.builder
    if builder == nil then return "fail", "现在不能制作东西" end
    local only_craftable = j.args.craftable_only == true
    local limit = tonumber(j.args.limit) or 40
    local craftable, known = {}, 0
    for name, recipe in pairs(GLOBAL.AllRecipes or {}) do
        if type(name) == "string" and recipe ~= nil then
            -- 只看永久解锁（第二参 true 忽略临时科技），别让"站在机器旁"影响"已解锁"统计
            local ok, knows = pcall(function() return builder:KnowsRecipe(recipe, true) end)
            if ok and knows then
                known = known + 1
                local ok2, has = pcall(function() return builder:HasIngredients(recipe) end)
                local can = ok2 and has == true
                if can then
                    local parts = {}
                    for _, ing in ipairs(recipe.ingredients or {}) do
                        parts[#parts + 1] = string.format("%s×%d", tostring(ing.type), tonumber(ing.amount) or 1)
                    end
                    craftable[#craftable + 1] = string.format("%s（%s）", name, table.concat(parts, " "))
                end
            end
        end
    end
    table.sort(craftable)
    if only_craftable then
        if #craftable == 0 then return "done", "现在材料不够，什么都做不了" end
        return "done", string.format("现在材料够、能做的（共 %d 个）：\n%s", #craftable,
            table.concat(craftable, "\n", 1, math.min(#craftable, limit)))
    end
    local head = string.format("你已解锁 %d 个配方，其中现在材料就够的有 %d 个：", known, #craftable)
    return "done", head .. "\n" .. (#craftable > 0 and table.concat(craftable, "\n", 1, math.min(#craftable, limit)) or "（暂无）")
end

return A
