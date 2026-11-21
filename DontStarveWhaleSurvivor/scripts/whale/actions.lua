-- Whale Actions 入口与子模块装配器
-- 将原先 3500 行 actions.lua 拆解为 7 个领域子模块：
--   core.lua        -- JOBS 注册表、Locomotion 与客户端同步、工具/食物/燃料选择器、公共状态机转移
--   movement.lua    -- move_to, go_to, seek, stop
--   gathering.lua   -- pickup, harvest, gather, gather_area（采集/收割）
--   work.lua        -- chop, mine, dig, hammer, pick（连续工作链 + 掉落物收集）
--   combat.lua      -- attack, kill
--   survival.lua    -- eat, equip, unequip, drop, fuel, add_fuel, make_fire, wait, heal, sleep
--   crafting.lua    -- craft, build, cook, recipes, lookup, probe, list_recipes
--   interaction.lua -- use, container_take, container_put, give, inspect, say, store, take, act, list_actions

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall or pcall
local tonumber = GLOBAL.tonumber or tonumber

local function _import(file)
    if modimport ~= nil then
        modimport(file)
    end
end

_import("scripts/whale/actions/core.lua")
_import("scripts/whale/actions/movement.lua")
_import("scripts/whale/actions/gathering.lua")
_import("scripts/whale/actions/work.lua")
_import("scripts/whale/actions/combat.lua")
_import("scripts/whale/actions/survival.lua")
_import("scripts/whale/actions/crafting.lua")
_import("scripts/whale/actions/interaction.lua")

Whale = Whale or {}
local A = Whale.actions or {}
local JOBS = A.JOBS or {}

-- 注册所有 JOBS 为 atomic 动作
A.atomic_jobs = {}
for k in pairs(JOBS) do
    A.atomic_jobs[k] = true
end

Whale.actions = A
return A
