-- 大肥鱼饿不死 Blind Whale Survivor
-- 让 AI 不用画面、只看文字就能玩《饥荒联机版》：模组把游戏翻译成文字，把文字指令做成动作。
-- 真正的“大脑”在游戏外面（DSH 插件带的 MCP 服务器），模组只负责看和做，通过本地文件桥收发。

name = "大肥鱼饿不死 (Blind Whale Survivor)"
description = [[
把《饥荒联机版》的画面翻译成纯文字，交给外面的 AI（DSH 插件 / 任何 MCP 客户端），
再把它发来的指令变成游戏里的真实动作（走过去、采集、砍树、挖矿、打怪、吃、做、点火、睡觉）。
不需要截图，也不需要视觉模型。只在本地主机（自己开的世界）里生效。
]]
author = "大肥鱼（参考 dsh-stardew-blind-whale-farmer 做的饥荒版）"
version = "0.1.1"

api_version = 10
dst_compatible = true
dont_starve_compatible = false
reign_of_giants_compatible = false

-- 只用在本地世界：客户端不需要装，服务器（也就是你自己的电脑）装就行
all_clients_require_mod = false
client_only_mod = false

server_filter_tags = { "blind whale", "text", "ai" }

icon_atlas = ""
icon = ""

configuration_options = {
    {
        name = "VERBOSE",
        label = "调试日志",
        hover = "把桥的收发过程打印到游戏日志里（server_log.txt），排查问题用。",
        options = {
            { description = "关", data = false },
            { description = "开", data = true },
        },
        default = false,
    },
    {
        name = "INTERVAL",
        label = "刷新间隔",
        hover = "多久重写一次文字状态（秒）。越小 AI 看到的越新，文件读写也越多。",
        options = {
            { description = "0.5 秒", data = 0.5 },
            { description = "1 秒", data = 1 },
            { description = "2 秒", data = 2 },
        },
        default = 1,
    },
}
