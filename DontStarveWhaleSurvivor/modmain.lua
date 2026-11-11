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
    version = "0.1.0",
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

modimport("scripts/whale/json.lua")
modimport("scripts/whale/util.lua")
modimport("scripts/whale/observe.lua")
modimport("scripts/whale/actions.lua")
modimport("scripts/whale/bridge.lua")
modimport("scripts/whale/hud.lua")

-- ─────────── Phase 1（Blind Whale Survivor）：只读观察器，日志输出 ───────────
-- 和上面那套（文件桥 + 动作 + HUD）互不影响：这一层只 print JSON 到日志，由 TypeScript Bridge 读。
modimport("scripts/main/json_encoder.lua")
modimport("scripts/main/player_observer.lua")
modimport("scripts/main/inventory_observer.lua")
modimport("scripts/main/world_observer.lua")
modimport("scripts/main/entity_observer.lua")
modimport("scripts/main/state_serializer.lua")
modimport("scripts/main/observer_manager.lua")

-- ─────────── Phase 2：HTTP 通信（M2 只做能力验证，不执行任何游戏动作）───────────
-- bws_config.lua 由 node tools/write-bws-config.mjs 生成（含 token，不进仓库）；缺失就跳过
pcall(modimport, "bws_config.lua")
modimport("scripts/main/config.lua")
modimport("scripts/main/http_client.lua")
modimport("scripts/main/connection.lua")
modimport("scripts/main/heartbeat.lua")
modimport("scripts/main/telemetry.lua")
modimport("scripts/main/net.lua")
modimport("scripts/main/probe.lua")

-- 游戏里的小窗：挂在玩家的 HUD 上（只有客户端有）
AddClassPostConstruct("screens/playerhud", function(self, owner)
    if Whale ~= nil and Whale.hud ~= nil then
        Whale.hud.Attach(owner)
    end
end)

-- 每进入一次世界（读档 / 新建）启动一次
AddGamePostInit(function()
    Whale.bridge.boot()
    if BWS ~= nil and BWS.observer ~= nil then BWS.observer.Start() end
    -- Phase 2 M2：只有服务端 + 配置里开了 probe 才跑通信探针
    if BWS2 ~= nil and BWS2.probe ~= nil and GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld.ismastersim then
        local ok_cfg, cfg = pcall(BWS2.config.get)
        if ok_cfg and type(cfg) == "table" then
            -- M3：心跳 + 状态推送（正式通道）
            if BWS2.net ~= nil then
                pcall(BWS2.net.start)
            end
            -- M2：通信探针（诊断用，可在 bws_config.lua 里关掉）
            if cfg.probe and BWS2.probe ~= nil then
                BWS2.probe.start()
            end
        end
    end
end)

AddPlayerPostInit(function(inst)
    Whale.bridge.boot()
    Whale.bridge.on_player(inst)
    -- 世界可能比玩家晚就绪，这里再试一次（Start 自己是幂等的）
    if BWS ~= nil and BWS.observer ~= nil then BWS.observer.Start() end
end)

-- 玩家睡觉醒来、死亡、被传送到别的世界时，别让上一件事继续卡着
AddPlayerPostInit(function(inst)
    inst:ListenForEvent("death", function()
        if Whale.actions then Whale.actions.Abort("你死了") end
    end)
end)
