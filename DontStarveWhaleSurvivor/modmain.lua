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
    version = (type(version) == "string" and version) or "0.41.3",
    -- 源码构建标识（随状态与 server_log 输出，用于核对游戏实际加载的源码版本）。
    build = "0.41.3",
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
        lease = "whale_lease.json",            -- Node -> Lua 权威租约（持久化通道名）
        io_lease = "whale_io_lease.json",      -- Node -> Lua 权威租约（io 通道名）
        lease_ack = "whale_lease_ack.json",    -- Lua -> Node 换手确认
        io_lease_ack = "whale_io_lease_ack.json",
        pause = "whale_pause.json",            -- 外面 -> 客户端：要不要暂停世界
        io_pause = "whale_io_pause.json",
        http = "whale_http.json",              -- 外面 -> 模组：Localhost HTTP 通道配置
        io_http = "whale_io_http.json",
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
Whale.reflex_on = modconfig("REFLEX", true) and true or false
-- 运行期强制关开关（测试用；开启时屏蔽 reflex，见 reflex.lua）
Whale.reflex_force_off = false

modimport("scripts/whale/json.lua")
modimport("scripts/whale/util.lua")
-- 拾取候选判定的唯一来源。必须在 nearby / guard 之前加载（观察侧与执行侧共用）。
modimport("scripts/whale/pickuprules.lua")
-- 收获候选判定的唯一来源（必须在 nearby / guard 之前加载）。
modimport("scripts/whale/harvestrules.lua")
modimport("scripts/whale/gatherrules.lua")
modimport("scripts/whale/eatrules.lua")
-- 实时目标选择的唯一真来源（固定枚举 target_kind + 最近目标 + 稳定句柄）。
-- 必须在 nearby / guard 之前加载：观察侧（渲染句柄）与执行侧（解析目标）共用。
modimport("scripts/whale/targetrules.lua")
modimport("scripts/whale/craftrules.lua")
modimport("scripts/whale/equiprules.lua")
-- 配置出口：把 modinfo 配置夹取到安全区间作为唯一生效值
modimport("scripts/whale/config.lua")
-- 观察对象唯一入口（Actor Provider）
modimport("scripts/whale/actor.lua")

-- 角色 Profile（所有角色共用 Reflex/Survival/Battle/Actions；Profile 只提供差异化规则）。
-- 必须在 nearby/guard/battle/reflex 之前加载（它们会读 Whale.character）。
modimport("scripts/whale/character/base-profile.lua")
modimport("scripts/whale/character/profiles/wendy.lua")
modimport("scripts/whale/character/profile-registry.lua")
modimport("scripts/whale/character/companion.lua")

-- 把 modinfo 的配置真正绑到行为上（值会夹取；读不到就用默认值并记进 problems）
if Whale.config ~= nil and Whale.config.build ~= nil then
    Whale.config.build(function(key)
        if key == "state_interval" then return modconfig("INTERVAL", 1) end
        if key == "observe_interval" then return modconfig("OBSERVER_INTERVAL", 2) end
        if key == "scan_radius" then return modconfig("OBSERVER_SCAN_RADIUS", 32) end
        if key == "scan_seconds" then return modconfig("OBSERVER_SCAN_SECONDS", 1) end
        if key == "nearby_max_total" then return modconfig("OBSERVER_NEARBY_MAX_TOTAL", 60) end
        if key == "nearby_max_per_bucket" then return modconfig("OBSERVER_NEARBY_MAX_PER_BUCKET", 12) end
        if key == "reflex" then return modconfig("REFLEX", true) end
        if key == "verbose" then return modconfig("VERBOSE", false) end
        return nil
    end)
    Whale.interval = Whale.config.get("state_interval")
end

modimport("scripts/whale/nearby.lua")
-- 白名单规格数据（guard 的第二道闸，必须先于 guard 加载）
modimport("scripts/whale/guard_specs.lua")
-- 动作安全底座（Lua 侧最终授权者）
modimport("scripts/whale/guard.lua")
modimport("scripts/whale/observe.lua")
-- 原版能力薄封装（真实照明 / 原版 RunAway 几何 / 玩家 ATTACK 动作）
-- 必须在 actions 与 reflex 之前加载：两者均直接依赖它。
modimport("scripts/whale/native.lua")
modimport("scripts/whale/actions.lua")
-- 独立战斗子系统（战术风筝、打二撤一、保命协同）
modimport("scripts/whale/battle.lua")
-- 宏（任务级接口）：采集到够数 / 砍到够木头 / 锅做饭 / 守夜（依赖动作模块，放它之后）
modimport("scripts/whale/macros.lua")
-- 保命反射层（极简高危保命）：仅限 3 秒必死危险（天黑无光即时点火、被怪贴脸反向走位、饥饿见底且背包有现成食物啃一口）
modimport("scripts/whale/reflex.lua")
modimport("scripts/whale/bridge.lua")
modimport("scripts/whale/hud.lua")

-- 启动时输出源码构建标识，配合状态文件里的 build 字段校验运行代码版本。
pcall(function()
    print(string.format("[BUILD] %s version=%s build=%s",
        tostring(Whale.name or "?"), tostring(Whale.version or "?"), tostring(Whale.build or "?")))
end)

-- 游戏里的小窗：挂在玩家的 HUD 上（只有客户端有）
-- AddClassPostConstruct 的 self 是 PlayerHud 屏幕本身，owner 是玩家实体。
-- HUD 必须挂到屏幕上（self），挂到玩家实体上画不出来。
AddClassPostConstruct("screens/playerhud", function(self, owner)
    if Whale ~= nil and Whale.hud ~= nil then
        pcall(Whale.hud.Attach, self, owner or self.owner)
    end
end)

-- 每进入一次世界（读档 / 新建）启动一次
AddGamePostInit(function()
    Whale.bridge.boot()
end)

AddPlayerPostInit(function(inst)
    Whale.bridge.boot()
    Whale.bridge.on_player(inst)
    -- 兜底：模组加载/热重载可能晚于 PlayerHud 创建。这里是客户端才有的 FrontEnd，
    -- 服务端进程不该反复找 HUD（它没有显示树）。找到就挂，找不到最多试 60 秒。
    if GLOBAL.TheFrontEnd ~= nil then
        local tries = 0
        local function try_attach()
            if Whale.hud == nil or Whale.hud.AttachFromPlayer == nil then return end
            if Whale.hud.AttachFromPlayer(inst) then return end
            tries = tries + 1
            if tries < 60 and inst:IsValid() then
                pcall(function() inst:DoTaskInTime(1, try_attach) end)
            end
        end
        pcall(function() inst:DoTaskInTime(0, try_attach) end)
    end
end)

-- 玩家睡觉醒来、死亡、被传送到别的世界时，别让上一件事继续卡着
AddPlayerPostInit(function(inst)
    inst:ListenForEvent("death", function()
        if Whale.actions then Whale.actions.Abort("你死了") end
    end)
end)
