# dsh-dont-starve-blind-whale-survivor

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）里让 AI 玩 **《饥荒联机版》**（Don't Starve Together）。

**设置在哪**：DSH 左侧边栏「插件」→ dsh-dont-starve-blind-whale-survivor → 点组件名旁边的「配置 ›」，打开后按「游玩 / 攻略 / 会话与连接 / 模组安装」分组，改完点「保存」。装好插件后要重启一次 DSH，配置入口才会出现。（DSH 不会照着插件的配置结构自动画表单，这张配置卡片是插件自带的 `lib/client.js`。）

| 设置 | 默认 | 说明 |
|---|---|---|
| 单个动作最长等多少分钟 | 5 | 睡觉、走远路这类动作要等很久；超时会告诉模型先 `get_state` 看看 |
| 内置 AI 的 API Key | 空 | **游戏里按 F8** 让 AI 自己玩用的 Key（不经过 DSH 会话）。留空读环境变量 `DEEPSEEK_API_KEY` |
| 模型接口地址 / 用哪个模型 | DeepSeek 官方 / `deepseek-v4-flash` | 任何 OpenAI 兼容的 `/chat/completions` 都行；要支持 function calling |
| 内置 AI 每次最多输出多少 token | 1024 | 只按实际输出计费 |
| 思考时暂停世界 | **关** | 打开后 AI 思考时把世界暂停（只有自己开的世界、房主才行），不会一边想一边饿死。见下方说明 |
| 多久没动作就暂停（秒） | 8 | 上面开关打开时，多久没有新动作就暂停 |
| 额外要求 | 空 | 比如“先建好家和锅，再考虑下洞”。每次读游戏状态都会显示 |
| 攻略·主攻略 / 生存 / 战斗 / 烹饪 | 模组自带的内容 | 四个大文本框，直接改；改过的十几秒内推给游戏优先使用，清空或改回原样就用自带的 |
| MCP 端口 | 18090 | 插件里 MCP 服务器的端口，地址 `http://127.0.0.1:端口/mcp`。改了重启 DSH |
| 创建“大肥鱼饿不死”会话预设 | **关** | 只在选了这个预设的会话里加载游戏工具 |
| 在所有会话里提供 dst 入口工具 | **关** | 不换预设、老会话也能玩 |
| 模型回复坏了自动接着玩 | **开** | 模型把工具调用吐成坏文字时自动替你发“接着玩” |
| 连续自动续玩最多几次 | 3 | 中间有一次游戏动作成功就重新计数 |
| 预设名字 / 基础预设 | 大肥鱼饿不死 / standard | 预设显示名，和它的底子（默认 standard） |
| 自动安装和更新饥荒模组 | **开** | 把插件带的 Lua 模组装进游戏 `mods` 并写 `modsettings.lua`（游戏开着时等关掉再装） |
| 饥荒游戏目录 | 空（自动找） | 留空在 Steam 各库 / GOG 里找；找不到时填有 `bin64` 和 `mods` 的那个文件夹 |
| 文件桥目录（一般不用填） | 空 | 自动找不到游戏写的状态文件时，手动指过去 |

## 怎么起作用

星露谷那版模组是 C#，能在游戏里直接开 HTTP 服务；**饥荒的 Lua 模组不能监听端口**，所以这次的 MCP 服务器跑在 DSH 进程里，中间用一层本地文件桥接起来：

```
DSH 会话 ──MCP(HTTP)──> 插件里的 MCP 服务器 ──写/读 json 文件──> 饥荒 Lua 模组 ──> 游戏里的真实动作
                ↑                                                        │
                └──────────────── 状态文字（whale_state.json）────────────┘
```

- 模组每一步把游戏翻成文字（时间、位置、血/饿/理智、背包、附近能采能砍能挖的东西、敌人、火堆、危险提醒），写进 `whale_state.json`；
- 插件读出这段文字，交给模型；
- 模型调工具 → 插件写 `whale_cmd.json` → 模组读出来，用游戏自己的动作系统执行（`BufferedAction` + `locomotor:PushAction`，和玩家点鼠标走同一条路），把结果写进 `whale_result.json`。

两条通道同时用，谁能用就用谁：`TheSim:SetPersistentString`（落在存档目录）和 `io.open`（落在游戏进程的工作目录，一般是 `bin64`）。插件会自动找这些文件。

## 游戏里的小窗和快捷键（F8 / F7）

模组在画面左边（饥荒那三个状态球下面）挂了一个小窗，随时告诉你现在怎么回事：

```
大肥鱼 ● 在玩（第 37 步）
正在做：chop {"count":3}
结果：干了 3 次
F8 开/停 · F7 停手
```

- **F8**：让 AI 开始 / 停止自己玩。**不需要 DSH 会话**——插件自己在后台调模型、自己调工具（就是星露谷那版的“内置 AI”）。第一次用之前，在插件设置里填「内置 AI 的 API Key」（或者设环境变量 `DEEPSEEK_API_KEY`）。
- **F7**：让它立刻停手（正在走的动作、正在砍的树都停），然后你可以自己接管玩。
- 小窗内容由插件每秒写一次；DSH 没开着的时候它会写“插件没连上”。

内置 AI 的循环很朴素：`get_state` 看状态 → 模型决定调哪个工具 → 执行 → 结果回给模型 → 再看状态。每一步只做一件小事，因为饥荒是实时的（它思考的时候游戏不会停）。

> 内置 AI 和 DSH 会话**不要同时操作**：内置 AI 在跑的时候，DSH 里的动作类工具会回一句“先按 F8 停掉它”，避免两边抢角色。

## 安装

**最短路径（三步）**：

1. 重启一次 DSH（插件是从 profile 的 `link:` 装的，重启后才会加载、配置页才会出现）。
2. 打开《饥荒联机版》，读档进世界；第一次进会弹模组列表，勾上「大肥鱼饿不死」。
3. 回 DSH：设置 → 插件 → dsh-dont-starve-blind-whale-survivor → 「配置 ›」里打开「创建“大肥鱼饿不死”会话预设」→ 重启 DSH → 新建会话时选这个预设，然后说“先看看现在什么情况，再去采点浆果、生个火”。

想确认连上了没有：浏览器打开 `http://127.0.0.1:18090/status`，它会告诉你现在有没有找到游戏的状态文件、在哪个目录。

**详细一点**：

1. **装好游戏**：《饥荒联机版》；这个模组是服务器端模组，**本地开世界**（自己当房主）才生效。
2. **装插件**：DSH 插件页安装 `dsh-dont-starve-blind-whale-survivor`（本地开发时用 `link:` 指向这个仓库）。装完重启 DSH。
3. **装模组**：插件默认会自动把 `DontStarveWhaleSurvivor/` 复制到 `<游戏>/mods/` 并往 `mods/modsettings.lua` 里加一行 `ForceEnableMod("DontStarveWhaleSurvivor")`。不想让它自动装就关掉设置里的开关，手动复制也行（或者跑 `install.ps1`）。
4. **打开游戏、读档进世界**（模组要同意启用：游戏里第一次会弹模组列表）。
5. 回 DSH：新建一个会话，选「大肥鱼饿不死」预设（要先在设置里打开那个开关），或者打开 `dst` 入口工具后在任意会话说“玩会儿饥荒”。

> 端口默认 **18090**：星露谷那版插件的游戏端占了 18080，两个插件同时装也不打架。

**只在选中的会话里玩**：预设 = 基础预设（默认 `standard`）的全部插件 + 连游戏的 MCP 客户端。只有选了它的会话才有游戏工具和说明。⚠ 已经聊过天的会话不能换预设（DSH 的规定），要玩请新建会话；AI 用 `update_notes` 记的笔记会出现在每次 `get_state` 最前面，新会话能接着玩。

**用别的 MCP 客户端玩也行**：插件里的 MCP 服务器就是标准 Streamable HTTP，WorkBuddy / Claude Code / Cursor 连 `http://127.0.0.1:18090/mcp` 就能玩，不需要 DSH 的会话预设。

## AI 能看到的（纯文字）

- 第几天、白天/黄昏/夜晚、季节、气温、下雨、洞穴还是地面
- 生命 / 饥饿 / 理智、体温、潮湿、手持和穿戴
- 背包每一格（中文名、数量、耐久或新鲜度百分比）
- 12 格内：能采的、地上能捡的、能砍的树、能挖的矿、能铲的、能拆的、敌人（带血量）、火堆（带燃料）、建筑、队友
- 提醒：血量低、快饿死、理智低、天黑了没光源、太冷/太热、已经死了

## AI 能做什么（25 个动作）

| 类别 | 工具 |
|---|---|
| 看 | `get_state`、`get_guide`、`update_notes` |
| 移动 | `move_to`（格子坐标，自动绕障碍）、`go_to`（走到某个东西旁边，可按名字或 tag） |
| 采集 | `pick`（浆果/草/树枝/蘑菇/胡萝卜…）、`pickup`（捡地上的木头/石头/燧石/丝…）、`chop`（砍树）、`mine`（挖矿）、`dig`（铲）、`hammer`（拆） |
| 战斗 | `attack`（自动换最好的武器，血少于 30% 先吃东西） |
| 吃和做 | `eat`（自动挑最划算的）、`heal`（药膏/腺体，没有就吃东西回血）、`cook`（火上烤）、`craft`（做东西）、`build`（摆建筑）、`make_fire`（生营火）、`add_fuel`（往火里添柴续命） |
| 装备 | `equip`（拿火把/武器/穿护甲）、`drop` |
| 生活 | `sleep`（帐篷/睡袋）、`say`（游戏聊天说话）、`wait`、`stop`（立刻停下） |

砍树/挖矿/拆东西的 `count` 指「干倒几棵/挖空几块」（默认一直干到目标消失才计数）；掉落物**不会自动进背包**，要用 `pickup` 捡。动作做完会附带**背包净变化**（例如「（背包：log+4）」），模型不用靠猜。

## Phase 6：高级生存智能（威胁 / 战斗 / 规避 / 四季 / Boss）

除了上面那套给模型用的 25 个动作，仓库里还有一条更完整的**生存智能层**（MCP Server + Bridge，
和 Phase 1~5 同一套链路，文档在 [`docs/phase6/`](docs/phase6/00-index.md)）：

| 能回答什么 | 工具 |
|---|---|
| 现在有多危险？为什么？ | `get_threat_assessment`（0~100 分 + 每个因素的贡献 + 每个敌人的战术档案） |
| 打得过吗？ | `get_combat_readiness` / `get_combat_recommendation` / `evaluate_combat_target` |
| 往哪跑？ | `get_escape_options`（敌群 / Boss / 黑夜无光 / 低温 / 高温 / 火灾 / 雷雨） |
| 这季要准备什么？ | `get_seasonal_readiness` / `prepare_for_season` |
| 这是 Boss 吗？能打吗？ | `get_boss_readiness`（识别 + 准备报告；**不自动开 Boss 战**） |
| 现在最该干什么？ | `get_survival_priority`（P0 紧急生存 → P5 探索，硬规则在程序层） |

真正打起来时：

- **战斗执行器在 Lua 里 0.1 秒跑一次** Kiting（`scripts/main/combat_executor.lua`），只用游戏原生
  `combat:TryAttack` / `locomotor:GoToPoint`，**不用 ForceAttack**；
- 普通敌人第一版是 **SUPERVISED_COMBAT**（`start_combat` 必须 `confirmed=true`）；
- 只有 7 种验证过的普通敌人在自动白名单里；**Boss 一律硬拦**，没档案的生物一律避战；
- 战斗期间每 2 秒复核控制权：紧急停止 / 人工接管会立刻让它停手；
- 生命低于**动态阈值**（随敌人强度 / 追击数 / 护甲浮动，不是固定 30%）会自动脱离。

## 自助保命（模组自己动手，不等 AI 想）
AI 一步一步想，每步要几秒，而天黑、火烧完、血见底、猎犬贴脸都不等人。模组里有一层**反射**（模组设置里可关），只在**没有任务在跑**的空档触发，每件事做完会在游戏聊天里说一句：
| 触发条件 | 动作 |
|---|---|
| 生命 < 25% | `heal`：先用药膏/腺体，没有就吃东西 |
| 黄昏/夜晚且没有光源 | 举起背包里的火把；没有就现做一把 |
| 站在火堆边且燃料 < 15% | 自动添柴 |
| 生命 < 35% 且敌人贴脸 | 往反方向后撤 |

所有动作都走游戏自己的逻辑，不是改数据：走路是 `locomotor:GoToPoint`，干活是 `BufferedAction(...)`，工具耐久、体力、掉落、被打断都和手动玩一样。

## 已知限制（第一版）

- **走路动画**：饥荒里人物动画是**客户端**自己预测出来的（服务端只同步位置），所以模组一边让服务端走，一边用 mod RPC 通知那个玩家的客户端一起走，动画才正常。**客户端也要装这个模组**（本地装的时候本来就是同一份）；别人没装模组的话，在他们眼里 AI 是在"平移"。

- **没有「睡到天亮」**：饥荒本来就只能睡帐篷/睡袋，`sleep` 找帐篷或睡袋。
- **锅（crockpot）只支持到「往里放」这一步**：`cook` 目前是营火/火坑直接烤；用锅做菜要靠 `go_to` + 后续版本补。
- **只有一个玩家会动**：默认操作第一个活着的玩家（房主）。多人联机时别人也能玩自己的角色，AI 只动它那个。
- **思考时的时间**：默认不暂停（饥荒本来就是实时生存）；要看 AI 想得久，打开「思考时暂停世界」（只有房主有效，靠 `SetServerPaused`）。
- **战斗比较朴素**：靠近、打、血少就吃，不会走位躲技能、不会用陷阱和吹箭。
- **不含洞穴深度探索 / 远古 / 月岛**：能下去，但没有专门的路线规划。
- 模组只保证在**自己开的世界**里好用；去别人的服务器当客户端不生效（服务器端模组）。

## 目录结构

```
dsh-dont-starve-blind-whale-survivor/
├─ package.json / cordis.patch.yml / lib/   DSH 插件
│  ├─ lib/index.js       插件本体：设置、会话预设、dst 入口工具、自动续玩、自动装模组
│  ├─ lib/mcp-server.js  本机 MCP 服务器（Streamable HTTP + SSE 心跳）+ /settings + /status
│  ├─ lib/bridge.js      文件桥：找目录、读状态、发指令等结果、推设置/暂停
│  ├─ lib/tools.js       25 个工具的说明和参数 + 执行（还有给模型的规则和攻略）
│  ├─ lib/mod-install.js 把 Lua 模组装进游戏 mods、写 modsettings.lua
│  └─ lib/client.js      插件页的配置卡片（由 tools/build-client.mjs 生成，不要手改）
├─ DontStarveWhaleSurvivor/  饥荒模组（纯 Lua，直接复制进 mods 就能用）
│  ├─ modinfo.lua / modmain.lua
│  ├─ scripts/whale/bridge.lua    文件桥 + 主循环（服务端看和做；客户端管暂停）
│  ├─ scripts/whale/observe.lua   游戏状态 → 文字
│  ├─ scripts/whale/actions.lua   22 个动作的状态机
│  ├─ scripts/whale/util.lua      找实体、算距离、读背包
│  ├─ scripts/whale/hud.lua        游戏里的小窗 + F8/F7 快捷键（客户端）
│  ├─ scripts/whale/json.lua      迷你 JSON（游戏自带的那个 encode 不合规范）
│  └─ guide/                      攻略（主攻略、生存、战斗、烹饪）
├─ tests/                node --test：文件桥、MCP、插件、装模组、Lua 语法（用 fengari 真跑 Lua）
├─ docs/dsh-plugin.md    插件说明
├─ common.ps1 / install.ps1 / test.ps1 / build.ps1
└─ tools/build-client.mjs  生成配置卡片
```

## 开发

```bash
powershell -ExecutionPolicy Bypass -File test.ps1     # 不需要打开游戏
powershell -ExecutionPolicy Bypass -File build.ps1    # 重新生成配置卡片 + 测试
powershell -ExecutionPolicy Bypass -File install.ps1  # 只装模组（平时插件会自动装）
```

改了 `lib/index.js` 的 `Config`（加减设置项）以后必须跑 `build.ps1`，否则插件页的配置卡片和设置对不上（测试会报）。

模组改完要重新进游戏（模组在 `mods` 里，可以直接改仓库里的源文件再跑 `install.ps1`，或者删掉 `mods/DontStarveWhaleSurvivor` 等插件自动重装）。
