-- 大肥鱼饿不死：模组入口
--
-- 结构：
--   scripts/whale/json.lua     迷你 JSON 编解码（纯 Lua，自己写，不依赖游戏自带的 json.lua）
--   scripts/whale/util.lua     找实体、算距离、读背包这类小工具
--   scripts/whale/observe.lua  把游戏状态写成给 AI 看的文字
--   scripts/whale/actions.lua  执行 AI 发来的动作（走过去、砍树、打怪……）
--   scripts/whale/bridge.lua   本地文件桥：把状态写出去、把指令读进来，跑主循环
--
-- 服务端（开世界的那台电脑）跑“看”和“做”；客户端只做一件小事：AI 思考时把世界暂停掉，
-- 免得它一边想一边饿死（默认关闭，见插件里的“思考时暂停”）。

local GLOBAL = GLOBAL

Whale = {
    name = "大肥鱼饿不死",
    -- 版本号跟 modinfo.lua 走：状态文件里的 mod 字段要和模组列表里显示的一致，
    -- 否则排查问题时会看错版本（原来这里写死 0.1.0，modinfo 已经是 0.10.0，对不上）。
    -- 沙箱里读不到 modinfo 时退回下面的兜底值（tests/tool-parity.test.mjs 会盯住它别漂）。
    version = (type(version) == "string" and version) or "0.14.3",
    verbose = false,
    interval = 1,
    -- 文件桥用到的文件名。服务端和外面（DSH 插件）都认这套名字。
    files = {
        state = "whale_state.json",            -- 模组 -> 外面：文字状态（持久化字符串通道）
        io_state = "whale_io_state.json",      -- 模组 -> 外面：同一个状态（文件通道，备用）
        cmd = "whale_cmd.json",                -- 外面 -> 模组：指令（持久化字符串通道）
        io_cmd = "whale_io_cmd.json",          -- 外面 -> 模组：指令（文件通道，备用）
        result = "whale_result.json",          -- 模组 -> 外面：执行结果（持久化字符串通道）
        io_result = "whale_io_result.json",    -- 模组 -> 外面：执行结果（文件通道，备用）
        settings = "whale_settings.json",      -- 外面 -> 模组：设置
        io_settings = "whale_io_settings.json",
        lease = "whale_lease.json",            -- M2.0.2：Node -> Lua 权威租约（持久化通道名）
        io_lease = "whale_io_lease.json",      -- M2.0.2：Node -> Lua 权威租约（io 通道名）
        lease_ack = "whale_lease_ack.json",    -- M2.0.2：Lua -> Node 换手确认
        io_lease_ack = "whale_io_lease_ack.json",
        pause = "whale_pause.json",            -- 外面 -> 客户端：要不要暂停世界
        io_pause = "whale_io_pause.json",
    },
}

-- 沙箱里没有 pcall / tonumber，只能从 GLOBAL 拿（见 scripts/whale/json.lua 顶部的说明）
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

-- mod 环境里有 GetModConfigData（modutil 装的，会自动带上 modname），别的地方没有
local function modconfig(key, default)
    local getter = env ~= nil and env.GetModConfigData or nil
    if getter == nil then return default end
    local ok, value = pcall(getter, key)
    if ok and value ~= nil then return value end
    return default
end

Whale.verbose = modconfig("VERBOSE", false) and true or false
Whale.interval = tonumber(modconfig("INTERVAL", 1)) or 1
Whale.reflex_on = modconfig("REFLEX", false) and true or false

modimport("scripts/whale/json.lua")
modimport("scripts/whale/util.lua")
-- 配置出口：把 modinfo 那几项夹到安全区间，作为唯一生效值（M1.1）
modimport("scripts/whale/config.lua")
-- 观察对象唯一入口（Actor Provider）：谁来当"我"由它回答（M1.1）
modimport("scripts/whale/actor.lua")

-- 把 modinfo 的配置真正绑到行为上（值会夹取；读不到就用默认值并记进 problems）
if Whale.config ~= nil and Whale.config.build ~= nil then
    Whale.config.build(function(key)
        if key == "state_interval" then return modconfig("INTERVAL", 1) end
        if key == "observe_interval" then return modconfig("OBSERVER_INTERVAL", 2) end
        if key == "scan_radius" then return modconfig("OBSERVER_SCAN_RADIUS", 16) end
        if key == "scan_seconds" then return modconfig("OBSERVER_SCAN_SECONDS", 4) end
        if key == "nearby_max_total" then return modconfig("OBSERVER_NEARBY_MAX_TOTAL", 60) end
        if key == "nearby_max_per_bucket" then return modconfig("OBSERVER_NEARBY_MAX_PER_BUCKET", 12) end
        if key == "reflex" then return modconfig("REFLEX", false) end
        if key == "verbose" then return modconfig("VERBOSE", false) end
        return nil
    end)
    Whale.interval = Whale.config.get("state_interval")
end

modimport("scripts/whale/nearby.lua")
-- M2.0：动作安全底座（Lua 侧最终授权者）
modimport("scripts/whale/guard.lua")
modimport("scripts/whale/observe.lua")
modimport("scripts/whale/actions.lua")
-- 宏（任务级接口）：采集到够数 / 砍到够木头 / 锅做饭 / 守夜（依赖动作模块，放它之后）
modimport("scripts/whale/macros.lua")
-- 保命反射层（默认关）：血见底/入夜没光/火要灭/被贴脸时自己动手
modimport("scripts/whale/reflex.lua")
modimport("scripts/whale/bridge.lua")
modimport("scripts/whale/hud.lua")

-- ─────────── A 栈（Phase 1~6，已归档，M1.0）───────────
-- 这里原来还有 19 个 modimport：scripts/main/{json_encoder,player_observer,inventory_observer,
-- world_observer,entity_observer,threat_observer,state_serializer,observer_manager,config,
-- http_client,connection,heartbeat,telemetry,commands,action_executor,net,probe,task_runner,
-- combat_executor}.lua，外加生成文件 bws_config.lua。
--
-- 它们和上面的 whale 那套是**两条并行的产品线**：都有自己的观察器、自己的通信通道
-- （TheSim:QueryServer → 本地 HTTP）、自己的动作入口（BWS2.actionExecutor / combat / tasks），
-- 而且都能对同一个角色下发动作。M1.0 的收敛决定只留 B 栈，所以整条 A 栈的运行入口在这里断开。
--
-- 代码没有删，全部搬到 archive/phase-a/scripts/main/（连同 archive/phase-a/bridge/ 这个 Node 端）。
-- 想恢复某一段（比如 M4 的战斗 Kiting），从 archive 里搬回来再单独 modimport，别整条链一起起。
--
-- modimport("archive/phase-a/scripts/main/http_client.lua")   -- 例：只搬 HTTP 传输
-- modimport("archive/phase-a/scripts/main/combat_executor.lua") -- 例：只搬战斗执行器

-- 游戏里的小窗：挂在玩家的 HUD 上（只有客户端有）
AddClassPostConstruct("screens/playerhud", function(self, owner)
    if Whale ~= nil and Whale.hud ~= nil then
        Whale.hud.Attach(owner)
    end
end)

-- 每进入一次世界（读档 / 新建）启动一次
AddGamePostInit(function()
    Whale.bridge.boot()
end)

AddPlayerPostInit(function(inst)
    Whale.bridge.boot()
    Whale.bridge.on_player(inst)
end)

-- 玩家睡觉醒来、死亡、被传送到别的世界时，别让上一件事继续卡着
AddPlayerPostInit(function(inst)
    inst:ListenForEvent("death", function()
        if Whale.actions then Whale.actions.Abort("你死了") end
    end)
end)
