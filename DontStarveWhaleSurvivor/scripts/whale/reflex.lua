-- 保命反射层（服务端，每秒跑一次）
--
-- 为什么需要它：AI 是"一步一步想"的，它想下一步的这 5~15 秒里，游戏照常在走。
-- 天黑、火烧完、血见底、猎犬贴脸，这些都不等人。模型再聪明也赶不上；
-- 而且 100 天里死一次基本就结束（除非有复活石/护符）。
--
-- 所以这里放几条**不需要思考**的反射：只在"已经要出人命"的时候动手，而且
-- **有任务在跑时一律不插手**（免得把玩家的正经活搞乱）：
--   1. 血 < 25% → 吃药/吃东西（回血手段优先）
--   2. 入夜（dusk/night）没有光源 → 举火把（有就举，没有就做一把）
--   3. 站在火堆边且燃料 < 15% → 添柴（木头/树枝/草）
--   4. 血 < 35% 且敌人贴脸 → 往反方向退一段（打不过就别打）
--
-- 每件事做完都会往游戏聊天里说一句（say），人类玩家看得见，也方便复盘。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

local U = Whale.util
local A = Whale.actions
local R = {}

--- 反射自己发起的动作，用固定 id，别跟外面正在等的指令抢结果
local REFLEX_ID = "reflex"

local last = {}          -- 上一次触发的时间（防抖）
local recent = {}        -- 最近做过的事（给 get_state 看）
local REFLEX_ID = "reflex"
local COOLDOWN = {
    heal = 8,
    light = 6,
    fuel = 6,
    flee = 12,
}

local function cooldown_ok(key)
    local now = U.now()
    local previous = last[key]
    if previous ~= nil and now - previous < (COOLDOWN[key] or 10) then return false end
    last[key] = now
    return true
end

local function say(p, text)
    if p == nil then return end
    -- 透明化：反射层做过的事要能被 AI 看到（写进 get_state），
    -- 不然模型会看到"状态自己变了"却不知道为什么，容易误判。
    recent[#recent + 1] = { t = U.now(), text = text }
    if #recent > 5 then table.remove(recent, 1) end
    pcall(function()
        if p.components.talker ~= nil then p.components.talker:Say(text, 3) end
    end)
end

--- 最近 60 秒内反射层自己做过的事（observe 会读）
function R.Recent()
    local out = {}
    local now = U.now()
    for _, item in ipairs(recent) do
        if now - item.t <= 60 then out[#out + 1] = item.text end
    end
    return out
end

local function has_light(p)
    local inv = p.components.inventory
    if inv == nil then return false end
    local hands = inv:GetEquippedItem(GLOBAL.EQUIPSLOTS.HANDS)
    if hands ~= nil and (hands:HasTag("light") or hands.prefab == "torch" or hands.prefab == "lantern") then
        return true
    end
    local fire = U.find_nearest(p, 8, { "fire" }, nil, function(e)
        local fueled = e.components ~= nil and e.components.fueled or nil
        return fueled == nil or not fueled:IsEmpty()
    end)
    return fire ~= nil
end

--- 1) 快见底了：吃药 / 吃东西（heal 动作自己会挑：治疗类优先，其次吃的）
local function reflex_heal(p)
    local hp = p.components.health
    if hp == nil or hp:IsDead() then return end
    if (hp:GetPercent() or 1) > 0.25 then return end
    if not cooldown_ok("heal") then return end
    -- heal 动作会自己挑"治疗类 → 吃的"，挑不到会直接失败，不会瞎吃
    if A.Start("heal", {}, REFLEX_ID) then say(p, "血不多了，先回一口") end
end

--- 2) 入夜没光：举火把（没有就做一把）
local function reflex_light(p)
    local world = GLOBAL.TheWorld
    local state = world ~= nil and world.state or nil
    local phase = state ~= nil and state.phase or nil
    if phase ~= "dusk" and phase ~= "night" then return end
    if has_light(p) then return end
    if not cooldown_ok("light") then return end

    local inv = p.components.inventory
    if inv == nil then return end
    local torch = U.find_item(p, "torch")
    if torch ~= nil then
        pcall(function() inv:Equip(torch) end)
        say(p, "天黑了，先把火把举起来")
        return
    end
    -- 做不了就安静放弃（材料不够时 Start 会直接返回 false）
    local started = A.Start("craft", { recipe = "torch", count = 1 }, REFLEX_ID)
    if started then say(p, "没火了，先做把火把") end
end

--- 3) 火快灭了：添柴
local function reflex_fuel(p)
    local fire = U.find_nearest(p, 8, { "fire" }, nil, function(e)
        local fueled = e.components ~= nil and e.components.fueled or nil
        if fueled == nil or fueled:IsEmpty() then return false end
        local percent = fueled:GetPercent()
        return percent ~= nil and percent < 0.15
    end)
    if fire == nil then return end
    if not cooldown_ok("fuel") then return end
    local started = A.Start("add_fuel", {}, REFLEX_ID)
    if started then say(p, "火快灭了，添点柴") end
end

--- 4) 血少又被贴脸：往反方向退
local function reflex_flee(p)
    local hp = p.components.health
    if hp == nil or hp:IsDead() then return end
    if (hp:GetPercent() or 1) > 0.35 then return end
    local foe = U.find_nearest(p, 4, { "hostile" }, nil, function(e)
        local h = e.components ~= nil and e.components.health or nil
        return h ~= nil and not h:IsDead()
    end)
    if foe == nil then return end
    if not cooldown_ok("flee") then return end

    local fx, _, fz = U.pos(foe)
    local px, _, pz = U.pos(p)
    if fx == nil or px == nil then return end
    local dx, dz = px - fx, pz - fz
    local len = math.sqrt(dx * dx + dz * dz)
    if len < 0.01 then dx, dz, len = 1, 0, 1 end
    local dist = 10
    local tx, tz = U.tile_of(px + dx / len * dist * U.TILE, pz + dz / len * dist * U.TILE)
    if A.Start("move_to", { x = tx, z = tz, timeout = 8 }, REFLEX_ID) then
        say(p, "血不多了，先撤")
    end
end

--- 服务端每 0.2 秒调一次；内部按 1 秒节流
local tick = 0
function R.Tick()
    -- SURVIVAL-01：除了模组配置（Whale.reflex_on），还支持运行期强制关。
    -- 真机踩到：reflex 会在"没任务"的空档自己 craft torch / heal，把模型辛苦采的材料吃掉，
    -- 导致模型 craft 时永远差材料。做真实 LLM 实验时必须能把它彻底关掉。
    if Whale.reflex_force_off == true then return end
    if Whale.reflex_on == false then return end   -- 模组配置里关掉了
    tick = tick + 1
    if tick % 5 ~= 0 then return end       -- ≈1 秒一次
    if Whale.job ~= nil then return end     -- 有正经任务在跑：一律不插手

    local p = U.player()
    if p == nil then return end
    local hp = p.components.health
    if hp ~= nil and hp:IsDead() then return end

    -- 顺序有讲究：先保命，再保光，再保火，最后才是撤
    local ok, err = pcall(function()
        reflex_heal(p)
        if Whale.job ~= nil then return end
        reflex_light(p)
        if Whale.job ~= nil then return end
        reflex_fuel(p)
        if Whale.job ~= nil then return end
        reflex_flee(p)
    end)
    if not ok then U.log("保命反射出错：" .. tostring(err)) end
end

function R.Status()
    local out = {}
    for k, v in pairs(last) do out[k] = v end
    return out
end

Whale = Whale or {}
Whale.reflex = R
