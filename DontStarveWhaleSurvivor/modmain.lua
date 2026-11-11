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

local function modconfig(key, default)
    local ok, value = pcall(GLOBAL.GetModConfigData, key, nil)
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
