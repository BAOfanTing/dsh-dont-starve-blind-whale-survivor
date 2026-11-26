# 大肥鱼饿不死（Blind Whale Survivor）

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）里，让 AI **不靠画面**玩《饥荒联机版》（Don't Starve Together）：模组把游戏翻成文字，模型靠文字做决定、靠工具动手。

这是一个 DSH 插件，自带饥荒 Lua 模组、本机 MCP 服务器和文件桥。也可以不接 DSH，直接在游戏里按 F8 让内置 AI 自己玩。

核心能力：基础生存与资源采集 · 层级规划（发展阶段 / 任务看板） · 家园选址与建造约束 · 自主执行运行时 (Autopilot) · 角色 Profile 与温蒂伴生防御（阿比盖尔召唤、蜘蛛/青蛙应对与花朵回收）。

---

## 现在能做什么

**模型能用的 39 个动作 + 5 个本地工具（共 44 个工具）**（下表按用途整理；动作与本地工具的数量、工具集由 `npm run check:docs` 对照 `ACTION_SPECS` / `TOOLS` 校验，不会和代码脱节）：

| 用途 | 工具 |
|---|---|
| 看 | `get_state`、`get_guide`、`update_notes`、`recipes`、`lookup`、`probe`、`inspect` |
| 走 | `move_to`、`seek`、`stop` |
| **实时找目标**（不会过期） | `pickup_nearest`、`pickup_food`、`harvest_nearest`、`chop_nearest`、`mine_nearest` |
| 采集 | `pickup`、`harvest`、`gather`、`gather_area`、`chop`、`mine`、`dig`、`hammer` |
| 制作 | `craft`（torch / axe / pickaxe / flowerhat + 第一阶段科技 rope / boards / backpack / spear / armorwood）、`build`（营火 / 火坑 / 箱子 / 锅 / 科学机器）、`cook` |
| 生存 | `eat`、`equip`（火把 / 提灯 / 矿工帽 / 长矛 / 防具等，已实机验证）、`unequip`、`drop`、`fuel`、`wait`、`sleep`（帐篷/睡袋） |
| 交互 | `use`、`container_take`、`container_put`、`give` |
| 战斗 | `attack`、`kill`、`fight_spider`（风筝战术）、`summon_companion`（召唤伴生生物，如温蒂的阿比盖尔） |
| 社交 | `say` |
| **任务调度** | `advance_task`（全自动推进任务看板、并发互斥、结构化报告） |
| **复合技能** | `run_skill`（执行多步复合工作流：`survival_stabilize` 紧急保命、`establish_home` 选址前往建造设家全流程、`gather_resources` 指定配方/物品智能缺口采集，支持 `skill_args` 定制目标） |

**目标引用有三种方式**（前两种不会过期，优先用）：

1. **只说类别**（推荐）：`pickup_nearest {"target_kind":"flint"}` —— 服务端在动手那一刻用当前世界状态
   重新找最近的目标，不需要 `#N`、不需要 `snapshot_id`，所以**永远不会 stale_snapshot**。
2. **稳定句柄**：`get_state` 的「附近」里每个能操作的目标后面带一个 `句柄h…`，填进 `target_handle` 即可
   （跨快照有效；目标没了回 `target_gone`，**绝不会**被换成别的东西）。
3. **`#N` + Nearby 快照 ID**：要精确指定"就是这一个"时才用。引用只在一帧内有效，
   而且**不能靠猜**（把 snapshot_id 加 1 或预补偿会被连着拒并触发熔断 `stale_snapshot_circuit_open`）。


**还没开放**：`pick`（手摘蘑菇/胡萝卜）、`heal`（主动回血）、`make_fire`。
回血目前只能靠吃东西和模组自带的保命反射。

**不靠模型的自动能力**：

- **保命反射 / 本地生存大脑（默认开）**：暗夜自动举火把/做火把、极饿/低血进食、贴脸受袭时 8 方向动态逃生并记忆危险区；**火源燃料偏低时添一份柴（加完等状态更新，不连续添）**、**理智低且近处有花时就近采花（没花只上报）**、**过热不去烤火、过冷才靠近点燃的热源**（阈值带滞回）。做过的事写进 `get_state`；不抢占正在跑的任务（P2 维护仅空闲执行，P0/P1 紧急才抢占）。
- **HUD 小窗 + F8/F7**：见下面「游戏里的快捷键」。
- **控制租约**：F8 内置 AI 和 DSH 会话不会同时操作同一个角色，换手要等旧的一方确认停手。
- **层级规划（长期→中期→短期）**：`get_state` 末尾会给出「发展阶段 / 营地候选 / 任务看板 / 下一步」。
  顺序是：先勘察选址 → 前往营地 → 建第一座科学机器 → 设家；之后所有基地建筑都必须在**家的锚点范围内**建。
  材料一够就地在脚下建机器会被工具层直接拒绝（`no_camp_site` / `not_at_camp` / `out_of_home_range`）。
  阶段与任务看板（依赖关系、完成证据、重试冷却）按**存档隔离并落盘**，重启或 F8↔MCP 换入口都不会丢未完成的长期目标。

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

屏幕右上角有个状态小窗：

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
| 执行模式 | assisted | `assisted`（默认：完整动作 + 辅助规划）/ `autopilot`（仅高层任务接口 `advance_task`）/ `manual`（手动单次指令） |
| 思考超时暂停世界 | 开 | AI 思考超过下面秒数后自动暂停世界（房主生效）；动作执行前立刻恢复 |
| 思考多少秒后暂停世界 | 5 | 默认思考超 5 秒自动暂停（1~120 秒可调） |
| 额外要求 | 空 | 比如"先建好家和锅，再考虑下洞"，每次读状态都会显示 |
| 攻略·主攻略 / 生存 / 战斗 / 烹饪 | 自带攻略 | 仅提供给内置 AI / MCP 会话使用（不会推给模组）；`autopilot` 不自动注入主攻略 |
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
不想操心跳过快照的话，直接用上表的 `pickup_nearest` / `pickup_food` / `harvest_nearest`
（只说类别，服务端实时找目标，不会过期）。

**`stale_snapshot` / `stale_snapshot_circuit_open`**
`#N` 只在一帧内有效，而模型思考一轮要几十秒，所以拿 `#N` 去动手本来就容易过期。
**不要把 `snapshot_id` 加 1 或往上猜** —— 编号每帧重排，猜不到；连着两次用同一个旧引用会被**熔断**，
那一轮就白费。正确做法：① 改用 `*_nearest` 系列；② 或把「附近」里那个「句柄h…」填进 `target_handle`；
③ 或重新 `get_state` 后把打印出来的 Nearby 快照 ID **原样照抄**。

**`eat` 说 `not_in_inventory` 但我明明记得背包里有**
回执说的是**此刻真实背包**。模组的保命反射可能刚把那样东西吃掉/收走，所以别凭上一轮的背包判断。
被拒时回执会直接列出"背包里现在真正能吃的"和正确 prefab 名，照着那个改就行。
另外：**地上那株植物**叫 `green_mushroom` / `blue_mushroom`，**采下来的物品**才叫 `green_cap` / `blue_cap`。


**回执是 `unknown` / `result_timeout`**
结果文件只有一个槽位，偶尔会被保命反射的回执覆盖。**先 `get_state` 看真实状态**，再决定要不要重发。

**`harvest` 成功了但背包没变**
背包满了时原生会把浆果丢在地上。看回执里的说明，必要时另外调 `pickup`（它不会自动捡）。

**版本号为什么有两个？**
`modinfo.lua` 的 `0.41.x` 是**游戏内模组**的版本；`package.json` 的 `0.12.x` 是**DSH 插件**的版本。
两者独立演进，详见 [CHANGELOG.md](docs/CHANGELOG.md)。

**改了插件代码后没生效**
`lib/` 下的 Node 代码改完要重启 DSH（MCP 服务器在插件进程里）。
模组 Lua 改完要重装（`node tools/install-mod.mjs`）并重新读档。

---

## 全自动游玩测试（AUTODEV）

把「静态门禁 → 重装模组/重置世界 → 分层真机测试 → 质检员压缩报告 → 自动评分/回滚 → Coding Agent 修复」串成一条闭环，详见 [docs/AUTODEV.md](docs/AUTODEV.md)。最常用的三条：

```bash
npm run autodev            # dry：只跑 lint/check:docs/test + 分析现有 latestLogs，产出 .runtime/issue-report.json 与 AUTODEV_SUMMARY.md
npm run analyze            # 单独把 latestLogs 压成 issue-report.json（0 token、纯确定性）
npm run autodev:live       # LIVE：真正重装模组 + 分层真机测试（需游戏/专用服可用；按需再开 --allow-git --agent-cmd）
```

安全默认：dry 模式不动游戏、不 git、不调模型；动游戏 / 改 git / 叫 Agent 都要显式开关。

## 文档

| 文档 | 看什么 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统架构总览：各层职责、执行链、控制租约与安全边界 |
| [docs/GAME_API.md](docs/GAME_API.md) | 饥荒联机版模组 API 实测速查、Lua 模块对应关系与 `api-lookup` 用法 |
| [docs/TESTING.md](docs/TESTING.md) | 静态门禁、测试目录结构、验证等级与真机工具用法 |
| [docs/AUTODEV.md](docs/AUTODEV.md) | 全自动游玩测试闭环：质检员 Oracle、分层 E2E、自动修复与回滚护栏 |
| [docs/dsh-plugin.md](docs/dsh-plugin.md) | 插件形态说明（预设、入口工具、配置项、思考暂停机制） |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 历史版本与架构演进记录（阶段报告已归档于 [docs/archive/](docs/archive/README.md)） |

---

## 参考与致谢

在设计与实现「大肥鱼饿不死」的过程中，参考和借鉴了以下优秀项目与架构探索：

- **[DontStarveAI](https://github.com/)**：结合规则系统、目标驱动与 LLM 辅助规划的饥荒决策智能体，本项目在范围采集（`harvest_area`）及部分目标筛选逻辑上借鉴了其设计。
- **[DST-AICompanion](https://github.com/)**：基于 FAtiMA 框架的饥荒联机版互动 AI 伴侣模组，探索了自主行动、资源采集、协同战斗与个性化交互机制。
- **[DST-Hierarchical-Agent](https://github.com/)**：面向饥荒联机版的分层规划智能体（涵盖玩家自主代理 Player Agent 与召唤伴侣 Buddy Agent），提供了分层任务执行架构参考。
- **[Sei](https://sei.gg)** (`sei-feat-stardew-dst-gaps`)：面向多游戏（星露谷、饥荒等）的桌面级 AI 伴侣平台，在跨游戏感知桥接、AI 协同与伴侣体验设计上提供了重要参考。

---

## 许可

MIT，见 [LICENSE](LICENSE)。
