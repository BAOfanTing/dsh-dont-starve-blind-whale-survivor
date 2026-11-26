-- 拾取候选判定的**唯一来源**（观察侧 nearby 与执行侧 guard 共用）。
--
-- 为什么要有这个文件：
--   观察侧（nearby 的 pickupables 桶）和执行侧（guard 的 pickup 校验）如果各写一套
--   "看起来差不多"的规则，就会出现"Observer 说 #1 可拾取，pickup 却回 prefab_not_allowed"
--   这种观察-执行不一致。所以两边共用这里。
--
-- 只做什么：
--   判断一个实体**是不是拾取候选**（类型 / 组件 / 地面状态）。
-- 不做什么（这些属于"执行资格"，只能在真正执行时判，绝不能进观察结果）：
--   · 距离限制（远处的东西也值得让 AI 看见，好让它先 move_to 过去）
--   · Control Lease / 控制权 / 世代
--   · 角色能不能行动（活着、非 ghost、非忙碌）
--   · 背包能不能装得下
--   · 命令是否过期 / 是否重复
--
-- 依据（本机 scripts.zip 实测；可用 `node tools/api-lookup.mjs <符号>` 现场复核，速查见 docs/game-api.md）：
--   ACTIONS.PICKUP.fn 要求 target.components.inventoryitem 存在且 canbepickedup、
--   目标不在 limbo、不是正在燃烧/飞行的投掷物；入包走 inventory:GiveItem。
--   白名单只放行"本构建里已核实是普通地面物品"的 prefab。

local GLOBAL = GLOBAL
local P = {}

-- 沙箱约定：pcall/tostring 这类全局在模组沙箱里可能被收走，
-- 统一从 GLOBAL 上取（和 nearby/guard/actions 的做法一致）。
local pcall = GLOBAL.pcall
local tostring = tostring
local type = type

P.SCHEMA = "bws.pickuprules/1"

--- 唯一的拾取白名单。guard 直接引用这张表（不再自己维护一份）。
--- 依据：twigs / cutgrass / flint 在本构建里都有 AddComponent("inventoryitem")，
--- 掉在地上可以被原生 ACTIONS.PICKUP 捡起。
--- 注意：石头物品的真名是 inv_rocks（不是 rocks —— rocks.lua 是巨石的脚本），未核实前不放行。
P.PREFABS = {
    twigs = true,
    cutgrass = true,
    flint = true,
    -- 砍树/挖矿的掉落物（与 target_kind 对齐）
    log = true,
    --   这些都是原生 AddComponent("inventoryitem") 的普通地面物品，捡起来完全安全。
    log = true,
    rocks = true,
    goldnugget = true,
    nitre = true,
    charcoal = true,
    -- 松果/桦栗果：砍树会掉，留着能种树（不进白名单的话永远捡不起来）
    pinecone = true,
    acorn = true,
    petals = true,
    -- 阿比盖尔之花（关键角色物品，青蛙击落后可通过既有 pickup 通道回收）。
    --   花是普通地面物品（inventoryitem + canbepickedup），必须允许用既有 pickup 捡回来；
    --   同时 guard 会禁止 AI 主动丢弃/当燃料烧掉它（见 guard.lua）。
    abigail_flower = true,
    -- 地上的食物：与 eatrules 基础食物与熟食完全对齐，掉在地上都可以被原生 ACTIONS.PICKUP 捡起
    carrot = true,
    berries = true,
    berries_juicy = true,
    corn = true,
    pumpkin = true,
    eggplant = true,
    red_cap = true,
    blue_cap = true,
    green_cap = true,
    honey = true,
    meat = true,
    smallmeat = true,
    froglegs = true,
    fish = true,
    meat_cooked = true,
    smallmeat_cooked = true,
    froglegs_cooked = true,
    fish_cooked = true,
    berries_cooked = true,
    berries_juicy_cooked = true,
    carrot_cooked = true,
    corn_cooked = true,
    pumpkin_cooked = true,
    eggplant_cooked = true,
    acorn_cooked = true,
    green_cap_cooked = true,
    blue_cap_cooked = true,
    meatballs = true,
    meatstew = true,
    butterflymuffin = true,
    dragonpie = true,
    frogglebunwich = true,
    perogies = true,
    fishsticks = true,
    ratatouille = true,
    fruitmedley = true,
    honeyham = true,
    baconeggs = true,
    turkeydinner = true,
}

local function comp(ent, name)
    if ent == nil or ent.components == nil then return nil end
    return ent.components[name]
end

--- 调用实体方法并吞掉异常（目标失效/被销毁时不允许把观察整条链带崩）
local function safe_call(fn, default)
    local ok, value = pcall(fn)
    if not ok then return default end
    return value
end

--- 是否「拾取候选」。
--- 只看类型、组件和"在地面上"这件事；不含任何执行期条件（见文件头说明）。
--- 返回：(true, nil) 或 (false, reason)
--- reason 沿用执行器已有的名字，保证观察侧与执行侧语义一致。
function P.IsCandidate(ent, actor)
    if ent == nil then return false, "entity_gone" end
    -- 玩家自己永远不是拾取候选
    if actor ~= nil and ent == actor then return false, "is_actor" end

    if safe_call(function() return ent:IsValid() end, false) ~= true then
        return false, "entity_gone"
    end

    -- 1) 类型必须在白名单里（绝不靠"名字像物品"或"有 inventoryitem"猜）
    local prefab = ent.prefab
    if prefab == nil or P.PREFABS[tostring(prefab)] ~= true then
        return false, "prefab_not_allowed"
    end

    -- 2) 不能已经在 limbo 里（进容器/背包的实体会进 limbo）
    if safe_call(function() return ent:IsInLimbo() end, false) == true then
        return false, "in_limbo"
    end

    -- 3) 必须有 inventoryitem 组件
    local item = comp(ent, "inventoryitem")
    if item == nil then return false, "target_not_pickable" end

    -- 4) 原生 canbepickedup 必须为 true（读不到一律当"不能捡"，失败要安全）
    if safe_call(function() return item.canbepickedup end, nil) ~= true then
        return false, "target_not_pickable"
    end

    -- 5) 不能已经被别人拿着 / 在别人的库存里
    local owner = safe_call(function() return item.owner end, nil)
    if owner ~= nil then return false, "target_not_pickable" end

    return true, nil
end

--- 便于测试/诊断：白名单里有哪些 prefab（排序后）
function P.PrefabList()
    local out = {}
    for prefab in pairs(P.PREFABS) do out[#out + 1] = prefab end
    table.sort(out)
    return out
end

Whale.pickuprules = P
