# 大肥鱼饿不死（Blind Whale Survivor）

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）里，让 AI **不靠画面**玩《饥荒联机版》（Don't Starve Together）：模组把游戏翻成文字，模型靠文字做决定、靠工具动手。

这是一个 DSH 插件，自带饥荒 Lua 模组、本机 MCP 服务器和文件桥。也可以不接 DSH，直接在游戏里按 F8 让内置 AI 自己玩。

---

## 现在能做什么

**模型能用的 31 个动作 + 3 个本地工具**（清单由 `ACTION_SPECS` 自动生成，不会和代码脱节）：

| 用途 | 工具 |
|---|---|
| 看 | `get_state`、`get_guide`、`update_notes`、`recipes`、`lookup`、`probe`、`inspect` |
| 走 | `move_to`、`seek`、`stop` |
| 采集 | `pickup`、`harvest`、`gather`、`gather_area`、`chop`、`mine`、`dig`、`hammer` |
| 制作 | `craft`（torch / axe / pickaxe）、`build`（营火 / 火坑 / 箱子 / 锅 / 科学机器）、`cook` |
| 生存 | `eat`、`equip`、`unequip`、`drop`、`fuel`、`wait` |
| 交互 | `use`、`container_take`、`container_put`、`give` |
| 战斗 | `attack`、`kill` |
| 社交 | `say` |

**还没开放**：`pick`（手摘蘑菇/胡萝卜）、`heal`（主动回血）、`sleep`、`make_fire`。
回血目前只能靠吃东西和模组自带的保命反射。

**不靠模型的自动能力**：

- **保命反射（默认开）**：血/饿见底、入夜没光、火要灭、被敌人贴脸、理智太低时，模组自己动手（吃 / 举火把 / 做火把 / 添柴 / 后撤 / 采花），白天还会提前备 2 草 + 2 树枝。**残血被贴脸或天黑没光时，它会打断正在跑的任务先保命**；做过的事会写进 `get_state`。
- **HUD 小窗 + F8/F7**：见下面「游戏里的快捷键」。
- **控制租约**：F8 内置 AI 和 DSH 会话不会同时操作同一个角色，换手要等旧的一方确认停手。

---

## 环境要求

| 项 | 要求 |
|---|---|
| 系统 | Windows（脚本是 PowerShell 写的） |
| Node | 18+（开发/测试用到 `node --test`） |
| 游戏 | 《饥荒联机版》，**本地开世界自己当房主**（模组是服务器端模组） |
| 可选 | DSH（用会话玩）；不接 DSH 也能用 F8 内置 AI |

---

## 安装

**最短路径（三步）**

1. 重启一次 DSH（插件从 profile 的 `link:` 装，重启后才会加载、配置页才会出现）。
2. 打开游戏读档进世界；第一次会弹模组列表，勾上「大肥鱼饿不死」。
3. 回 DSH：侧边栏「插件」→ dsh-dont-starve-blind-whale-survivor → 「配置 ›」→
   打开「创建"大肥鱼饿不死"会话预设」→ 重启 DSH → 新建会话时选这个预设。

**详细一点**

1. **装插件**：DSH 插件页安装 `dsh-dont-starve-blind-whale-survivor`（本地开发用 `link:` 指向本仓库）。装完重启 DSH。
2. **装模组**：插件默认会自动把 `DontStarveWhaleSurvivor/` 复制到 `<游戏>/mods/`，
   并往 `mods/modsettings.lua` 写 `ForceEnableMod("DontStarveWhaleSurvivor")`。
   不想自动装就关掉设置里的开关，手动跑 `install.ps1`（或 `node tools/install-mod.mjs`）。
3. **进游戏读档**。
4. **确认连上了**：浏览器打开 `http://127.0.0.1:18090/status`，它会说有没有找到状态文件、在哪个目录。

> 端口默认 **18090**（星露谷那版占 18080，两个插件同时装不打架）。

---

## 启动与连接

插件的 MCP 服务器是标准 **Streamable HTTP**，地址 `http://127.0.0.1:端口/mcp`。

| 玩法 | 怎么做 |
|---|---|
| **在 DSH 会话里玩** | 用「大肥鱼饿不死」预设新建会话；或在设置里打开「在所有会话里提供 dst 入口工具」，然后在任意会话说"玩会儿饥荒" |
| **在游戏里按 F8** | 插件自己后台调模型、自己调工具，不需要 DSH 会话。第一次用先在设置里填「内置 AI 的 API Key」 |
| **用别的 MCP 客户端** | WorkBuddy / Claude Code / Cursor 直接连 `http://127.0.0.1:18090/mcp` |

⚠ 已经聊过天的会话不能换预设（DSH 的规定），要玩请新建会话。
`update_notes` 记的笔记会在每次 `get_state` 最前面出现，新会话能接着玩。

---

## 游戏里的快捷键

画面左边（三个状态球下面）有个小窗：

```
大肥鱼 ● 在玩（第 37 步）
正在做：move_to {"x":-28,"z":32}
结果：走到了附近
F8 开/停 · F7 显示/隐藏小窗
```

- **F8**：让内置 AI 开始 / 停止自己玩。
- **F7**：只显示 / 隐藏小窗，不影响 AI、也不打断正在做的事。
- DSH 没开着时小窗会写"插件没连上"。

> 内置 AI 和 DSH 会话**不要同时操作**：一方在跑时，另一方下动作会被控制租约挡住。

---

## 插件设置

| 设置 | 默认 | 说明 |
|---|---|---|
| 单个动作最长等多少分钟 | 5 | 走远路这类动作要等很久 |
| 内置 AI 的 API Key | 空 | F8 用；留空读环境变量 `SENSENOVA_API_KEY` / `DEEPSEEK_API_KEY` |
| 模型接口地址 / 模型 | `https://token.sensenova.cn/v1` / `sensenova-6.8-flash` | 任何 OpenAI 兼容 `/chat/completions`，且要支持 function calling |
| 每次最多输出多少 token | 1024 | 只按实际输出计费 |
| 思考时暂停世界 | 关 | 只有自己开的世界（房主）能用 |
| 多久没动作就暂停（秒） | 8 | 配合上一条 |
| 额外要求 | 空 | 比如"先建好家和锅，再考虑下洞"，每次读状态都会显示 |
| 攻略·主攻略 / 生存 / 战斗 / 烹饪 | 模组自带 | 改了十几秒内推给游戏；清空或改回原样用自带的 |
| MCP 端口 | 18090 | 改了重启 DSH |
| 创建"大肥鱼饿不死"会话预设 | 关 | 只在选了这个预设的会话里加载游戏工具 |
| 在所有会话里提供 dst 入口工具 | 关 | 不换预设、老会话也能玩 |
| 模型回复坏了自动接着玩 | 开 | 模型把工具调用吐成坏文字时自动补一句"接着玩" |
| 连续自动续玩最多几次 | 3 | 中间有一次动作成功就重新计数 |
| 预设名字 / 基础预设 | 大肥鱼饿不死 / standard | 显示名与底子 |
| 自动安装和更新饥荒模组 | 开 | 游戏开着时等关掉再装 |
| 饥荒游戏目录 | 空（自动找） | 留空在 Steam 各库 / GOG 里找 |
| 文件桥目录（一般不用填） | 空 | 自动找不到状态文件时手动指过去 |
| 自动写会话日志（覆盖写） | 开 | 见下面「日志」一节 |
| 日志目录 | 空（插件目录下 `latestLogs/`） | 可填绝对路径 |

---

## 日志（排查问题用）

玩的时候插件会自动把这一局写成日志，放在插件目录的 `latestLogs/`（设置里可以改目录）。
**每次插件启动、或新会话第一次玩，都覆盖写**——所以这里永远是「最新一次」，不会越堆越多。

| 文件 | 是什么 |
|---|---|
| `session.txt` | 人看的时间线：一行一条事件，工具返回和周边环境接着往下排 |
| `session.jsonl` | 同一份内容的结构化版本（每行一个 JSON），脚本分析 / `jq` 用 |
| `server_log.txt` | 游戏自己的 `server_log.txt` 快照（模组报错、`[Reflex]` 都在里面） |

`session.txt` 里每行开头的标签：

```
03:12:55 | CALL   | #1 get_state args={"format":"json"} by=mcp_client
03:12:55 | DONE   | #1 get_state ok 8ms 1428字
         | {
         |  "ok": true,
         |  "world": { "day": 1, "phase": "dusk" },
         |  ...
03:12:55 | ENV    | 帧=r1794710302-8078-n87 day=1 phase=dusk pos=(6,41) hp=200/200 半径=40 共=3/4
         |   威胁：#1 恐怖尖喙 (4,7) 距0.4 400/400血
         |   可收获：#2 浆果丛 (-4,14) 距0.2 已成熟
         |   可拾取物：#3 flint 距6.2
03:12:56 | STATE  | mod=0.37.0 day=1 phase=dusk hp=200/200 hunger=164.06/200 ... pos=(6,41)
03:12:56 | REFLEX | [00:05:36]: [Reflex] light_check:
```

| 标签 | 记的是 |
|---|---|
| `CALL` / `DONE` | **AI 下的每个操作**：动作名、参数、谁下的（`mcp_client` = DSH 会话，`内置AI` = 游戏里 F8）、成功/失败、`status`/`reason`、耗时、**返回原文**。`#N` 是同一次调用的编号，CALL 和 DONE 靠它配对 |
| `ENV` | **角色周边环境**：附近快照换帧时记一次，列出威胁 / 可拾取 / 可收获等物件的位置、距离、血量、是否成熟（和模型当时看到的「附近」一样） |
| `STATE` | **游戏状态**：每 5 秒一条，第几天、时段、血/饿/理智、位置、背包、手持 |
| `REFLEX` / `DEATH` / `LOG` | 模组保命反射、死亡、以及 `server_log.txt` 里匹配到的报错/警告 |
| `CMD` / `RESULT` | 直接写在文件桥上的动作与回执（手工发命令时用得上） |
| `NOTE` | 覆盖重置等标记 |

排查时的用法：先按时间顺序看 `session.txt`，找到出问题的那一步 → 看它上面最近的 `ENV`
（当时周围有什么）和 `STATE`（当时什么状况）→ 再看 `DONE` 里游戏到底回了什么。
返回原文是**整段留下**的（单条上限 20000 字，真到上限才会在事件里标 `truncated` 和原始字数）。
`session.jsonl` 里还多了结构化字段（`nearby` 原始数据、`status`/`reason`/`ms`），要脚本分析就用它。

---

## 常见问题

**连不上游戏（`get_state` 说找不到状态文件）**
① 游戏读档进世界了吗？② 模组启用了吗（游戏里第一次会弹列表）？③ 这个世界是**你自己开的**吗（服务器端模组只在本地主机生效）？
④ 打开 `http://127.0.0.1:18090/status` 看它找的是哪个目录。

**动作总是被拒绝（`actor_busy`）**
模组的保命反射正在做事（吃药 / 举火把 / 添柴 / 后撤），或者另一个调用方在跑。
先 `stop`，再重试。这是"一个角色同时只允许一个动作"的正常表现。

**`pickup` / `harvest` 说 `out_of_range`**
这两个动作**不会自己走过去**。先 `move_to` 靠近，再**重新 `get_state`** 拿新的 `#N` 和 `snapshot_id`。
注意原生拾取距离只有约 1 格，而 `move_to` 的到点容差也是 1 格左右——有时要走两次才进得去。

**回执是 `unknown` / `result_timeout`**
结果文件只有一个槽位，偶尔会被保命反射的回执覆盖。**先 `get_state` 看真实状态**，再决定要不要重发。

**`harvest` 成功了但背包没变**
背包满了时原生会把浆果丢在地上。看回执里的说明，必要时另外调 `pickup`（它不会自动捡）。

**版本号为什么有两个？**
`modinfo.lua` 的 `0.30.x` 是**游戏内模组**的版本；`package.json` 的 `0.9.x` 是**DSH 插件**的版本。
两者故意不同步，详见 [STATUS.md](docs/STATUS.md)。

**改了插件代码后没生效**
`lib/` 下的 Node 代码改完要重启 DSH（MCP 服务器在插件进程里）。
模组 Lua 改完要重装（`node tools/install-mod.mjs`）并重新读档。

---

## 文档

| 文档 | 看什么 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 现在这套系统怎么搭的（一张图 + 各层职责 + 安全边界） |
| [docs/STATUS.md](docs/STATUS.md) | 当前能力、验证等级、已知问题、还没做什么 |
| [docs/NATIVE_REUSE.md](docs/NATIVE_REUSE.md) | 哪些能力用了饥荒原版的、哪些是自己写的、为什么（含源码行号与许可证分析） |
| [docs/TESTING.md](docs/TESTING.md) | 怎么跑测试（命令都验过） |
| [docs/REFACTOR_AUDIT.md](docs/REFACTOR_AUDIT.md) | M2.2.1 全项目瘦身的审计与结果 |
| [docs/dsh-plugin.md](docs/dsh-plugin.md) | 插件形态说明（预设、入口工具、配置项） |

---

## 许可

MIT，见 [LICENSE](LICENSE)。
