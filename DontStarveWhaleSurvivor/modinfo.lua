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
version = "0.14.3"

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
        name = "REFLEX",
        label = "自助保命反射（默认关）",
        hover = "默认关：让 AI 自己看状态决定调哪个接口。打开后模组会在血见底/天黑没光/火快灭/被贴脸时自己动手，并把做过的事写进 get_state；只在你没下令的空档触发。",
        options = {
            { description = "关（AI 自己决定）", data = false },
            { description = "开（模组兜底）", data = true },
        },
        default = false,
    },
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
    {
        name = "OBSERVER_INTERVAL",
        label = "观察器采样间隔",
        hover = "Phase 1 观察器多久往日志里打一条状态（秒）。只是打印，不扫实体，建议 2 秒。",
        options = {
            { description = "0.5 秒", data = 0.5 },
            { description = "1 秒", data = 1 },
            { description = "2 秒", data = 2 },
            { description = "5 秒", data = 5 },
        },
        default = 2,
    },
    {
        name = "OBSERVER_SCAN_RADIUS",
        label = "实体扫描半径",
        hover = "Phase 1 观察器扫描附近实体的半径（格）。越大越耗，建议 16。",
        options = {
            { description = "8 格", data = 8 },
            { description = "12 格", data = 12 },
            { description = "16 格", data = 16 },
            { description = "24 格", data = 24 },
            { description = "32 格", data = 32 },
        },
        default = 16,
    },
    {
        name = "OBSERVER_SCAN_SECONDS",
        label = "实体扫描间隔",
        hover = "多久扫一次实体（秒）。扫描不在每帧做，结果会缓存给状态输出。",
        options = {
            { description = "2 秒", data = 2 },
            { description = "4 秒", data = 4 },
            { description = "8 秒", data = 8 },
        },
    {
        name = "OBSERVER_NEARBY_MAX_TOTAL",
        label = "附近实体总上限",
        hover = "一次快照最多给 AI 看多少个附近实体（威胁/食物/资源/容器/建筑/生物/其它合计）。太少会漏掉东西，太多会涨 token。",
        options = {
            { description = "30 个", data = 30 },
            { description = "60 个（默认）", data = 60 },
            { description = "100 个", data = 100 },
            { description = "200 个", data = 200 },
        },
        default = 60,
    },
    {
        name = "OBSERVER_NEARBY_MAX_PER_BUCKET",
        label = "每类实体上限",
        hover = "每个分类（威胁/食物/资源/…）最多显示几个，避免一片浆果丛把别的都挤掉。",
        options = {
            { description = "6 个", data = 6 },
            { description = "12 个（默认）", data = 12 },
            { description = "20 个", data = 20 },
            { description = "50 个", data = 50 },
        },
        default = 12,
    },
        default = 4,
    },
}
