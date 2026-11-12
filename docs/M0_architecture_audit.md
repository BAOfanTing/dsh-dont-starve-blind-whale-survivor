# M0 · 架构审计报告（Blind Whale Survivor）

> 审计时间：2026-11-12
> 审计对象：`E:\Cache\XinLuguWuyu\dsh-dont-starve-blind-whale-survivor`（工作区当前状态，含未提交改动）
> 游戏环境：《饥荒联机版》build **762172**，`E:\SteamLibrary\steamapps\common\Don't Starve Together`
> 参考项目：`Darianliu23/dsh-stardew-blind-whale-farmer`（星露谷版）、`sei-studio/sei`（DST adapter）
> 性质：**只读审计 + 设计**。本轮没有改任何产品代码，没有启动游戏。

---

## 0. 结论摘要

### 0.1 一句话

**这个仓库不是一个项目，是两条并行的产品线，装在同一个 Lua 模组里，各自接了一套 Node 服务和一套 AI 循环。**
两条线都能真跑，但**彼此不知道对方存在**，并且**都能操作同一个角色**。M0 要做的不是"加功能"，是**把两条线收敛成一条**。

### 0.2 五个必须知道的事实

| # | 事实 | 证据 |
|---|---|---|
| 1 | **两套 Lua 同时被加载**：`scripts/whale/*`（文件桥 + 动作内核）与 `scripts/main/*`（HTTP + 观察/命令/战斗/任务） | `modmain.lua:55-64` 与 `:68-94`，无开关 |
| 2 | **两套 Node 栈互不 import**：`lib/*.js`（DSH 插件，35 工具，文件桥，:18090）与 `bridge/ + game-bridge/ + mcp-server/ + agent/ + survival/`（TS，43 工具，HTTP，:18788/:8790/:8791） | `lib/*.js` 只 import `node:*`；TS 侧全仓 0 处引用 `lib/` |
| 3 | **两套工具名完全不重叠**：35 vs 43，精确同名 0 个 | `lib/tools.js` vs `mcp-server/src/tools/*` |
| 4 | **AI 没有独立身体**：控制的是房主玩家角色；`FindEntity` 目标全部来自 `GLOBAL.AllPlayers` | `util.lua:63-83`、`modmain.lua:123-138`，全模组 0 处 `SpawnPrefab/MakePlayerCharacter` |
| 5 | **动作是真的**：28 个原子动作 + 4 个宏，全部走 `BufferedAction` / `locomotor` / 原生组件；真机上走位、砍树、采集、吃、造火堆都跑通过 | `actions.lua` 全文 + Phase 5/6 文档 + `whale_state.json` |

### 0.3 收敛后的目标（一句话）

> **一个 Lua 模组（观察 + 动作 + 反射 + 传输适配）+ 一个 Node 服务（唯一工具注册表 + 唯一 Agent Loop + 唯一状态快照 + 可选 MCP 门面）+ 一条明确的主链路。**

### 0.4 M0 建议的 5 个决策（需要你确认，见 §8）

1. 产品线选 **B 栈**（`lib/` + `scripts/whale`）为准，A 栈（TS 五包）作为**素材库**吸收后归档；
2. 主运输通道**先文件桥**（零依赖、已在跑），HTTP 作为 `transport/http` 适配在 M2 接入；
3. AI 身体：**M1 继续用玩家角色**，M2 做一次「无主幸存者」spike 再决定要不要独立小鲸鱼；
4. `scripts/main/*` **不删除**，移入 `legacy/` 目录并从 `modmain` 摘除；
5. M1 保留 F8 内置 AI，但**必须与 MCP 会话共享同一个控制权租约**（现在文件桥这条线根本没有租约）。

---

## 1. 审计方法与证据等级

1. **读代码**：Lua 30 个文件 9 795 行、TS `src` 71 个文件 16 106 行、根 `lib/*.js` 7 个文件 2 838 行，全部逐文件过一遍（行数为 UTF-8 精确统计）。
2. **跑测试**：根目录 `node --test tests/*.test.mjs` → **211 passed / 0 failed**（3.3 秒）。
3. **读真机产物**（不是文档里的说法）：
   - `Cluster_1\Master\save\whale_state.json`（模组写出的真实状态文本）
   - `bin64\whale_io_*.json`（io 通道真实落盘）
   - `.runtime\bridge-state.json` / `.runtime\bridge-state-control.json`（A 栈真机命令流水与租约）
   - `master_server_log.txt` 里的 `[BWS2]` 探针行（`docs/phase2/01-m2-lua-http.md` 引用）
4. **读引擎源码**：`data/databundles/scripts.zip`（4109 条目）里抽 20+ 个关键文件核对 API（见 `M0_api_validation.md`）。
5. **读参考项目**：两个仓库的 README / 目录树 / 关键源码 / 协议文档（sei 的 `PROTOCOL.md` 全文）。

证据等级：`[实测]` 真机产物 ｜ `[测试]` 单测 ｜ `[源码]` 游戏或本仓源码 ｜ `[参考]` 外部项目 ｜ `[未验证]` 无证据。

---

## 2. 现有项目分析

### 2.1 体量

| 区域 | 文件数 | 行数 | 状态 |
|---|---|---|---|
| Lua 模组 `DontStarveWhaleSurvivor/` | 30 | 9 795 | 两代并存，全部被 import |
| ├ `scripts/whale/`（B 栈内核） | 8 | 3 786 | 在跑（文件桥） |
| ├ `scripts/main/`（A 栈） | 19 | 5 759 | 也在跑（HTTP，需 token 文件） |
| └ `modmain.lua` / `modinfo.lua` / `bws_config.lua` | 3 | 250 | 双栈装配点 |
| 根 `lib/*.js`（B 栈 Node） | 7 | 2 838 | 产品代码，无构建步骤 |
| TS 五包 `src/`（A 栈 Node） | 71 | 16 106 | 4 个能跑，1 个孤儿 |
| 测试 | 25 (`tests/*.mjs`) + 31 (`*/test/*.ts`) | 6 525 + 7 988 | 都可在无游戏下跑 |
| 文档 `docs/` | 55 | 6 643 | Phase 1~6 + 一份 100 天审计 |

### 2.2 今天的真实运行形态

```
                    ┌──────────────── 用户按 F8（内置 AI）或 DSH 会话 ────────────────┐
                    ▼                                                              ▼
        lib/agent.js AiRunner（F8 自跑）                          DSH 会话 + lib/mcp-server.js(:18090)
                    └──────────────┬───────────────────────────────────────┬───────┘
                                   ▼                                       ▼
                        lib/tools.js（35 工具，唯一派发）           ← 同一份
                                   ▼
                        lib/bridge.js（找目录/读状态/写指令）
                                   ▼   whale_*.json（两条子通道：持久化字符串 + io.open）
        ┌────────────────── DontStarveWhaleSurvivor（服务端）──────────────────┐
        │  scripts/whale/bridge.lua  0.2s 主循环                               │
        │    ├─ observe.lua      → 写状态文本                                  │
        │    ├─ actions.lua      → 执行动作（BufferedAction/locomotor）         │
        │    ├─ macros.lua       → 高层组合                                    │
        │    └─ reflex.lua       → 保命反射                                    │
        │  scripts/main/*        → 另一条 HTTP 栈（有 token 时同时向 :18788 推送）│
        └──────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼  （仅当 bws_config.lua 存在）
        game-bridge(:18788) → mcp-server(:8790) → agent(:8791) → 自己的 LLM 循环
```

**关键事实**：同一个角色、同一个 tick 里，**有两条执行路径都能对它下发动作**：

- B 栈：`Whale.actions.Start()`（文件指令）
- A 栈：`BWS2.actionExecutor.execute()`（HTTP 指令）→ 内部**也调** `Whale.actions.Start()`（`action_executor.lua:440`），所以它至少不是两套动作实现，但**是两套指令入口、两套去重、两套状态机**；
- 外加 `BWS2.combat`（自建原生战斗，直接 `combat:TryAttack`）与 `BWS2.tasks`（任务链）——这两个是**真正绕开 `Whale.actions` 的第二/第三套执行器**。

### 2.3 完成度：真实 / 部分 / 桩 / 纯提示词

| 能力 | 现状 | 等级 |
|---|---|---|
| 观察（玩家/背包/世界/附近） | 两套都在写，B 栈是中文文本，A 栈是 JSON | ✅ 真实，但**重复** |
| 观察（威胁/环境/季节剩余） | 只在 A 栈（`threat_observer.lua` 328 行） | ✅ 真实，B 栈**没有** |
| 动作（移动/采集/砍/挖/铲/拆/打/吃/烤/造/建/装备/丢弃/睡/说话/等待/填柴/治疗） | B 栈 28 个 `JOBS.*` 全部真执行 | ✅ 真实 |
| 动作（存箱/取箱） | `store`/`take` 直接调 `container:GiveItem`，**绕过动作系统** | ⚠️ 能用但绕过游戏动画/失败分支 |
| 高层宏（gather/chop_until/cook_meal/night_watch） | 4 个，真执行 | ✅ 真实 |
| 战斗（Kiting/风筝/撤退） | A 栈 `combat_executor.lua` 1026 行，真机验证过 ENGAGING/RETREATING | ✅ 真实（但**与反射抢控制权**） |
| 任务链（8 个模板） | A 栈 `task_runner.lua` 653 行 | ⚠️ 真实但 `stop_task` 调了不存在的 `Whale.actions.Stop`（bug） |
| 反射（回血/举光/添柴/撤退） | B 栈 `reflex.lua` 184 行，默认**关** | ✅ 真实，但不看战斗状态 |
| 决策层（威胁评分/战斗评估/逃跑/季节/Boss/优先级） | A 栈 `mcp-server/src/survival/*` 3 023 行，**纯计算、零 I/O** | ✅ 真实，但只有 A 栈的 AI 用得到 |
| 控制权租约（SUPERVISED/holder/lease） | **只在 A 栈**（`game-bridge/src/control.ts` + `survival/src/controlManager.ts`），Lua 只负责 `assert` | ⚠️ 真实，但 B 栈**完全没有** |
| Agent Loop（多轮 + 工具调用） | 两份：`agent/src/runtime/agentLoop.ts`（严格）、`lib/agent.js`（简化） | ⚠️ 重复，后者薄 |
| MCP Server | 两份：`lib/mcp-server.js`（手写 JSON-RPC）、`mcp-server/src`（官方 SDK） | ⚠️ 重复 |
| 攻略 Guide | `guide/*.md` 4 篇（战斗/烹饪/生存/攻略） | ✅ 真实（纯文本） |
| Notes（长期记忆） | `lib/index.js` 写 `data/notes/世界ID.md` | ✅ 真实，但**没有区分观察事实/模型推断** |
| Transcript | A 栈有 `telemetry`/`logger`；B 栈没有结构化 transcript | ⚠️ 半成品 |
| 独立 AI 幸存者实体 | **完全没有** | ❌ 缺失（见 `M0_api_validation.md` §5） |
| 局部文字地图 | 没有（也没有地形/生态数据） | ❌ 缺失 |
| 实体引用编号 #N + 快照绑定 | **两套都没有** | ❌ 缺失（M0 重点补） |
| 增量 delta | 没有 | ❌ 缺失 |
| `survival/` 动作控制包 | 1211 行 + 656 行测试，**无入口、无人 import、执行侧硬编码 dry-run** | ❌ 死代码级孤儿 |

### 2.4 重复建设清单（8 类，全部给文件）

| # | 重复职责 | 出现位置 |
|---|---|---|
| 1 | **状态解析/字段归一化**（同一份快照解析 3~4 次） | `bridge/src/store.ts:115-211`；`mcp-server/src/tools/snapshot.ts`；`mcp-server/src/survival/context.ts:39-283`；`game-bridge/src/commands.ts:104`；`lib/bridge.js:162-406`（第 5 份） |
| 2 | **动作执行 / 命令状态机**（3 套状态机互不相通） | `game-bridge/src/commands.ts:133`（7 态，真跑）；`survival/src/actionRegistry.ts:48`（9 态，dry-run）；`lib/bridge.js:377`（文件轮询，无状态机）；Lua 侧还有 `commands.lua`、`action_executor.lua`、`bridge.lua` 三处去重逻辑 |
| 3 | **控制权判定**（7 份近似复制，判据还不一致） | `gatherTools.ts:20-38`、`survivalTools.ts:17-36`、`toolUseTools.ts:20-39`、`taskTools.ts:17-36`、`phase6Tools.ts:68-96`、`controlTools.ts:21-52`、`agent/src/runtime/agent.ts:98-140`（最后这份靠 `indexOf('{')` 从文本里抠 JSON）；另有 `game-bridge/src/control.ts:112` 与 `survival/src/controlManager.ts:230` 两套 lease |
| 4 | **Bridge/传输客户端**（5 份） | `mcp-server/src/bridge/client.ts:74`；`survival/src/bridgeSync.ts:18`；`agent/src/mcp/client.ts`；`lib/bridge.js`；`lib/index.js:629 mcpCall`（自己再写一个 JSON-RPC + SSE 解析） |
| 5 | **工具注册表**（2 套，名字 0 重叠） | `mcp-server/src/tools/*.ts`（43，zod）↔ `lib/tools.js`（35，手写 JSON Schema） |
| 6 | **MCP Server**（2 套） | `lib/mcp-server.js:58`（手写 JSON-RPC，:18090）↔ `mcp-server/src/server/createServer.ts:38`（官方 SDK，:8790） |
| 7 | **LLM Agent 循环**（2 份） | `agent/src/runtime/agentLoop.ts:121` ↔ `lib/agent.js:31 AiRunner`；LLM 客户端也有两份（`agent/src/llm/openaiProvider.ts` ↔ `lib/agent.js` 内部） |
| 8 | **观察器**（2 套，参数还不一致） | `scripts/whale/observe.lua`（12 格硬编码，每类上限 5~6）↔ `scripts/main/{player,inventory,world,entity}_observer.lua`（16 格可配，总数 40/每类 10） |

### 2.5 已经踩过的真 bug（信誉资产，迁移时别重犯）

| bug | 教训 |
|---|---|
| 模组少写 `local pcall = GLOBAL.pcall` → 模组被判 MOD ERROR → **世界起不来** | 沙箱兼容头必须每个文件都有，且要有「把 `pcall/tonumber/os/io` 全置 nil」的回归测试 |
| `strict.lua` 下动态读全局名导致分片进程直接死 | 不许 `_G[name]`；名字必须是字面量 |
| `U.tile_of(U.pos(p))` 多返回值踩坑 → **位置永远显示 `(x,0)`**，AI 照着走偏 18 格 | 多返回值必须显式解构；观察器要有「坐标合理性」断言 |
| 「捡东西」实现了但没接进工具表 → AI 永远捡不起地上的资源 | 必须有一致性测试：Lua 注册的动作 ↔ Node 工具表，双向覆盖（现在 `tests/tool-parity.test.mjs` 只覆盖 B 栈） |
| `chop/mine` 的 `count` 语义与工具说明相反 | 工具描述与实现要有同一个单测钉住 |
| 心跳漏 token → 152 次 401；4xx 还重试 | 鉴权失败不重试 |
| `os.time()` 当毫秒用 → `elapsed_ms` 全是 0/2000 | 计时统一用 `TheSim:GetRealTime()` |
| 日志单行 3.9K 被截断 → 半截 JSON 解析必失败 | 任何「日志通道」都要有硬预算（现在 `state_serializer.lua` 有 3500 字符预算，这是个好设计） |

---

## 3. 参考项目分析

### 3.1 星露谷版（`dsh-stardew-blind-whale-farmer`）

**架构**（全部从源码读出）：C# SMAPI 模组内直接跑 `HttpListener`（`127.0.0.1:18080`）同时提供 `/mcp` 与 `/settings`；`Observer.cs`（47KB）把游戏翻成中文 Markdown；`Tools.cs`（34KB，53 个工具）手写 schema 并分发；`MainThread.cs` 用主线程队列 + 逐帧协程执行动作；`Agent.cs` 是**无状态单轮**循环（每轮重读全量状态，只把「最近 25 条行动记录」当历史）。

**值得抄的 6 条**：

1. **无状态单轮 + 全量状态 + 最近 N 条行动日志**：工具定义固定可命中 prompt 缓存，上下文不滚雪球。
2. **状态 = 中文 Markdown 段落 + 坐标列表 + 局部字符地图 + 单字符图例**（29×19，`@` 是你），零 JSON、零视觉；图例本身就把"该用什么工具"编码进去。
3. **策略写进 tool description**（批量优先、失败别重复、背包满了怎么办），比堆 system prompt 有效。
4. **统一 `成功：/失败：原因` 结果前缀** → 内置 AI 的 break 决策和 MCP 的 `isError` 都从它推导。
5. **结果尾巴注入**（威胁警告、天黑了、背包满）：模型不主动 get_state 也能纠错。
6. **攻略三层**（规则代码化 / 主攻略常驻 / 专题按需 `get_guide`）+ Notes 短小按存档持久化并前置注入。

**不能照抄的 4 条**：

1. 「思考时冻结世界」（`Game1.isTimePaused`）—— DST 是实时 tick，服务器权威，**没法为 AI 暂停**（本仓库的 `SetServerPaused` 只在单机房主有效，且会让画面卡住）。
2. 模组内开 HTTP 端口 —— Lua 沙箱做不到。
3. 「模组直调游戏 API 一次成功」 —— DST 动作会漂移/被打断/被拒，结果必须是**三态**（成功/部分/失败+原因），不能二分成 `StartsWith("成功")`。
4. 15 分钟级长动作 —— 饥荒里等于饿死；动作必须是**秒级、可中断、可恢复**。
5. 坐标当主键 —— 星露谷的作物/机器不动，饥荒的怪会跑；**必须给实体短时效引用编号**（这恰好是星露谷版自己的缺口，我们别照抄它的缺口）。

### 3.2 sei（`sei-studio/sei` 的 DST adapter）

**架构**：三进程 —— main（只答 `/hello`、做世界发现与 summon 投递）、bot runtime（真正的 HTTP server：观测状态机 + 命令队列 + 结果回传）、brain（游戏无关的 LLM 回合循环）。所有通道都是 **mod 主动发 HTTP**，Node 侧当 server。端口 `27424..27428` 抢第一个空闲；业务面每次召唤一个新 token + 临时端口。

**线协议（`PROTOCOL.md`，全部读到）**：

- 发现：`GET /hello?q=<json>` 每 2s（session/world/day/season/players/ismastersim/caves/mod 版本），响应里可携带一次性 `summon{token,botPort,name,prefab,nearUserid}`；
- 观测：`POST /obs?t=` **3Hz delta**，8KB 上限、`RADIUS=24`、`MAX_ENTS=60`，坐标是**相对身体的 (dx,dz) 一位小数**，`full:true` 每 12 tick 一次重同步，`gone` 列离开半径的 guid，**"重发即全量、缺字段即清空"**；
- 命令：`GET /cmd?since=N&t=` **有界长轮询**（没队列 hold 400ms），`since` = 已 ack 的最大 seq，`<= since` 永不再发；
- 结果/事件：`POST /event`（`result/chat/attacked/death/enterdark/phase/survival/...`）、`POST /error`（所有 Lua 异常都上报）；
- 断线：连续 8 次失败 → 认为 runtime 已死 → **despawn 身体**（"a brain-dead survivor never stands in the world"）。

**AI 实体方案（最关键的一条）**：`SpawnPrefab(offer.prefab)` 在 master sim 上生成**无主（ownerless）的原版幸存者**（15 个 vanilla 角色），不写自定义 prefab；全套玩家组件自带（locomotor/combat/inventory/builder/eater/health/hunger/sanity/talker），`persists=false`、`SetCanSleep(false)`。踩坑清单见 `M0_api_validation.md` §5B（`doattack` 补丁、睡着的灯不发光、`Remove()` 可能抛、不能变鬼复活、`GIVETOPLAYER` 不可用）。

**Brain**：`Class(Brain)` + 一棵 `PriorityNode`（8 层：safety → flee → attack → fire → goto → command → follow → stand），**复用 vanilla `SGwilson`，不写 StateGraph**，只用 `sg:HasStateTag("busy")` 当"身体忙"的闸门。自定义节点只有两个（`SeiGoTo`、`SeiSeekLight`），后者是因为 vanilla `FindLight` 会把"自己手里的火把"当成光源（距离 0）。

**观测/决策**：`#N` **跨会话稳定句柄**（`guid → #1,#2…`，"so the model can refer back to something it saw two turns ago"）；工具 Target **只接受 #N 或名字，禁止模型写坐标**；快照是按"能对它做什么"分 13 个桶、每桶 cap 6；三级 alert（wake/nudge/note）带边沿触发与冷却。

**值得抄的 6 条**：`#N` 句柄 + 禁止发明坐标；有界长轮询 + `since` ack；观测 delta + 相对坐标 + 明示预算；**命令 = 作业，返回值 = 可操作诊断**（`cant_reach: no path (blocked by water or walls)`、`cannot chop without an axe: craft one or carry one`）；**反射层做保命并"汇报"给 LLM**（`survival` 事件 → 模型能说"我刚自己退开了"）；headless 可测（专用服务器 + FIFO 喂 Lua + `fake-dst-mod.mjs` 说完整协议）。

**风险 4 条**：协议边界全是实测数字（400ms/8KB/~20KB）不是承诺；ownerless 补丁链脆（依赖 vanilla 内部行为）；安装面侵入游戏目录并改 `modsettings.lua`；模块级单例状态 → **只能有一个身体**（做多幸存者要重写）。

### 3.3 三方对照

| 维度 | 星露谷版 | sei（DST） | 我们（现状） | 我们的目标 |
|---|---|---|---|---|
| 传输 | 模组内 HttpListener | mod→Node HTTP（QueryServer） | 文件桥（在用）+ HTTP（也在用） | **单接口，双实现** |
| 身体 | 玩家角色 | 无主原版幸存者 | 玩家角色 | M1 玩家，M2 试无主 |
| 保命 | 模组内中断（掉血即中断） | Brain 优先级树 | 4 条反射（默认关，无互斥） | **反射 + 租约** |
| 观测 | 29×19 字符地图，无实体编号 | delta + `#N` 句柄 | 中文文本，无编号无 delta | **`#N` + delta + 局部地图** |
| 决策 | 无状态单轮 | 回合制 function calling + 事件唤醒 | 两份循环（一厚一薄） | **一份，回合制** |
| 工具 | 53 个 | 22 个世界动词 | 35 + 43（两套） | **一套，~25 个** |
| 记忆 | Notes ≤1200 字/存档 | remember/forget + habits | Notes（不分事实/推断） | **事实/推断分层** |

---

## 4. 简化后的架构

### 4.1 一张图

```
┌──────────────────────── 游戏进程（Lua 模组 DontStarveWhaleSurvivor）────────────────────────┐
│                                                                                             │
│  modmain.lua  ──装配──▶  whale/                                                              │
│                          ├─ sandbox.lua   沙箱兼容头（唯一取 GLOBAL 的地方）                  │
│                          ├─ util.lua      几何/查找/背包小工具                                │
│                          ├─ refs.lua      #N 实体引用表（与 snapshot 绑定）                   │
│                          ├─ observe/      Build(p) → {text, data, refs, delta}               │
│                          │   ├─ player.lua  world.lua  nearby.lua  map.lua  warnings.lua     │
│                          ├─ actions/      JOBS 表：Start/Tick/Abort/Current                    │
│                          │   ├─ move.lua  work.lua  item.lua  craft.lua  container.lua  attack.lua │
│                          ├─ macros.lua    gather / chop_until / cook_meal / night_watch       │
│                          ├─ reflexes.lua  保命（只通过 lease 抢控制权）                      │
│                          ├─ lease.lua     ★唯一控制权裁决点（agent/reflex/combat/task/human） │
│                          ├─ transport/    统一接口 push(state)/poll()/result()                │
│                          │   ├─ file.lua  文件桥（默认）  └─ http.lua  QueryServer（M2+）    │
│                          ├─ log.lua       预算内的诊断/transcript                             │
│                          └─ hud.lua       小窗 + F7/F8                                        │
└──────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                       │  一条链（文件名或 /api/v1/*）
┌──────────────────────────────────────▼──────────────────────────────────────────────────────┐
│                        Node 单服务（根 lib/，无构建步骤，可直接跑）                          │
│  runtime/server.js   一个进程：MCP(/mcp) + 内部 API(/api/*) + 设置(/settings) + 状态(/status) │
│  runtime/transport.js  单一接口：getSnapshot() / sendCommand() / onResult()                   │
│  state/snapshot.js   Lua 快照 → 归一化对象（唯一解析点）                                      │
│  state/control.js    ★唯一控制权租约（agent / mcp / human / reflex）                          │
│  tools/registry.js   ★唯一工具注册表（schema + 校验 + 派发 + 三态结果）                        │
│  tools/{local,actions,macros}.js                                                             │
│  agent/loop.js       ★唯一 Agent Loop（预算/超时/取消/失败策略）                              │
│  agent/provider.js   OpenAI 兼容（DeepSeek 官方 + 本地）                                      │
│  analysis/*.js       纯计算：threat / combat / escape / season / boss（吸收 TS 决策层）       │
│  memory/{notes,guide,transcript}.js                                                          │
│  mcp.js              把 registry 暴露成 MCP（不给第二套逻辑）                                 │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 单一事实来源（SoT）

| 谁拥有 | 唯一责任人 | 现在的问题 |
|---|---|---|
| **游戏状态** | Lua `observe/`（只有它读游戏） | A/B 两套观察器各写一份 |
| **实体身份** | Lua `refs.lua`（`#N ↔ GUID/实体 ↔ snapshot_seq`） | 完全没有 |
| **动作执行** | Lua `actions/`（只有它碰 `BufferedAction`） | `combat_executor` 与 `task_runner` 绕过它 |
| **控制权** | Lua `lease.lua`（真机侧）+ `state/control.js`（Node 侧副本） | 只在 A 栈有，B 栈没有 |
| **工具清单** | Node `tools/registry.js` | 两套（35 vs 43） |
| **决策循环** | Node `agent/loop.js` | 两份 |
| **记忆** | Node `memory/notes.js`（单文件 Markdown） | 有，但不分事实/推断 |

**规则**：任何跨进程数据必须能回答「谁写的、什么时候写的、对应哪个 snapshot」。做不到就不许进架构。

### 4.3 Observer 设计（`get_state`）

目标：**一次调用给模型"够用且不超预算"的世界切片**，并让后续动作能"指代"其中的东西。

**输出结构**（文本 + 同源 JSON 两份，文本给模型、JSON 给 MCP/测试）：

```
# 快照 s=1287（2 秒前，第 3 天 黄昏 秋季 12°）
你：沃利 生命 84/150 饥饿 120/250 理智 190/200 体温 21° 手持 火把(61%)
位置：(19,-111) 地面  光照：火堆旁
注意：- 血低于 60%，附近有 3 只蜘蛛（最近 4.2 格）
背包(5/15)：木头×6、草×4、燧石×2、树枝×3、火把(61%)
#1 蜘蛛 4.2格 血 100/100 正在追你
#2 蜘蛛 5.1格 血 100/100
#3 常青树 2.0格 可砍（需斧头）
#4 草 1.4格 可采
#5 木头 1.1格 可捡 ×3
#6 营火 3.2格 燃料 12%（快灭了）
周围（16 格内，显示 6/23 类）：
  可砍 6 · 可采 4 · 可捡 3 · 可挖矿 2 · 敌人 3 · 建筑 1 · 科技 0
自上次快照：背包 +木头×2；#3 已消失；新出现 #7 猪人（中立，8.4 格）
```

**硬约束（写进代码常量，不靠提示词）**：

| 项 | 值 | 理由 |
|---|---|---|
| 扫描半径 | 默认 16 格（世界单位 ×4） | Phase 1 实测半径 40 格会拖慢服务端 |
| 实体上限 | 40 条（每类 6，威胁类单独最多 8） | 星露谷版每桶 cap 6 的经验 + 我们的 token 预算 |
| 快照文本 | ≤ 6000 字符（超了按距离砍，置 `trimmed`） | 状态 3~6k token 是参考项目实测区间 |
| 刷新 | 状态 1s 写一次；实体扫描 4s 一次（缓存，带 `scanned_at`） | 与现有实现一致 |
| 引用编号 | `#N` 与 `snapshot_seq` 绑定，**只在下一次 `get_state` 前有效**；过期 → 工具返回 `stale_ref` | sei 的做法；避免"拿旧编号指挥新世界" |
| 局部地图 | 21×11 字符，以 AI 为 `@`，图例固定 12 个字符（`.` 可走 `#` 阻挡 `~` 水 `T` 树 `o` 矿 `*` 可采 `$` 掉落 `F` 火 `B` 建筑 `S` 科技 `!` 敌人 `P` 玩家） | 星露谷版 29×19 的裁剪版；M3 才做 |

**分类口径**（都来自引擎真实 tag/组件，不猜）：

| 桶 | 判据 |
|---|---|
| 敌人 | `HasTag("hostile")` **或** `combat.target == 你`；带 `hp/maxhp`、`attack_range`、`是否在追` |
| 中立生物 | 有 `combat`+`health` 且不是 structure、不是 hostile（猪人/兔人/牛） |
| 可砍/可挖/可铲/可拆 | `components.workable.action.id == CHOP/MINE/DIG/HAMMER` |
| 可采 | `HasTag("pickable")` 且不是 `barren`，或 `harvestable:CanBeHarvested()` |
| 地面物品 | `components.inventoryitem.owner == nil` 且不是 bird/structure/cooker |
| 建筑 | `HasTag("structure")` |
| 科技设施 | `components.prototyper ~= nil` |
| 火/光源 | `HasTag("fire")` 或 `components.fueled` + `HasTag("light")` |
| 容器 | `components.container` |

**不做的事**：不扫整张地图；不把 40 条以上的实体发给模型；不伪造坐标（引擎没有的东西就不写）。

### 4.4 Tools / GameActions 设计

**任务书要求的 17 个工具 → 现状映射**：

| 工具 | 现状 | M1 要做的事 |
|---|---|---|
| `get_state` | ✅ 有（无编号） | 加 `#N`/delta/预算/局部地图 |
| `say` | ✅ 有 | 加长度上限（160 字符） |
| `move_to` | ✅ 有（坐标） | 加 `ref` 形式 + `cant_reach` 诊断 |
| `gather(kind,count)` | ✅ 宏 `gather` | 统一 `kind` 枚举（草/树枝/浆果/燧石…）+ 返回背包增量 |
| `pickup` | ✅ 有 | 支持 `ref`（捡指定那一堆） |
| `chop` / `mine` | ✅ 有 | 修 `count` 语义与说明一致；返回掉落物提示 |
| `craft` / `build` | ✅ 有 | 加 `missing_ingredients` 精确缺料 |
| `eat` | ✅ 有（按饥饿差判成功） | 保留该判据，暴露 `hp/hunger` 增量 |
| `equip` | ✅ 有 | 支持 `ref`/名字/槽位 |
| **`fight`** | ⚠️ 只有 `attack`（简单平A） | 定义 `fight(target=None, style=safe)`：内部先用 A 栈的战斗执行器（Kiting/撤退），**必须过 lease** |
| **`flee`** | ❌ 没有（只有 `retreat_from_combat`，仅 A 栈） | 新增：背离威胁 + 跑到安全点 + 报告剩余威胁 |
| `cook` | ✅ 有（营火直接烤） | 锅（crockpot）留到 M3 |
| `store` / `take` | ⚠️ 有，但绕过动作系统 | 改成走 `ACTIONS.GIVETOPLAYER`/箱子交互，失败要给原因 |
| `sleep` | ✅ 有 | 保留（只能睡帐篷/睡袋） |

**schema 原则**（写进 `tools/registry.js` 的公共层）：

1. 全部 JSON Schema（`type/properties/required/enum/minimum/maximum`），**不用自由文本参数**；
2. 目标优先用 `ref: "#3"` 或 `name: "evergreen"`，**坐标只在 `move_to` 里允许**（sei 的"禁止模型发明坐标"）；
3. 每个工具必须有 `success`（成功长什么样）与 `failure`（可能的原因码）写进 description；
4. 参数范围要夹取（半径 2~20、count 1~20、超时 5~120s），越界要**报错而不是静默改值**；
5. 高层工具内部组合原生动作（`gather` = 找→走→采→捡→计数），模型不需要知道按什么键。

**结果契约（三态，必须结构化）**：

```json
// 成功
{ "ok": true, "text": "砍倒 1 棵常青树，掉落木头×2（背包木头 6→8）",
  "effects": { "inventory_delta": {"log": 2}, "hp": 0, "hunger": -0.5 },
  "snapshot": 1288 }
// 部分成功
{ "ok": true, "partial": true, "text": "砍了 3 下没砍完：天黑了，先举手电",
  "reason": "too_dark", "effects": {"inventory_delta": {}}, "snapshot": 1288 }
// 失败（reason 是给模型看的、可操作的）
{ "ok": false, "reason": "cant_reach", "text": "走不到 (31,-132)：卡在 6.4 格外（可能有东西挡着）" }
```

固定原因码（不许自由发挥）：`stale_ref` `busy` `dead` `ghost` `cant_reach` `too_dark` `missing_tool` `missing_ingredients` `inventory_full` `no_target` `target_gone` `timeout` `control_denied` `not_implemented`。

### 4.5 Agent Loop 设计

**形态：回合制、单一循环、每次调用都是"一次新的请求"**（学星露谷版的成本控制 + sei 的回合语义）：

```
loop（最多 N 轮）：
  1. snapshot = get_snapshot()            // 必有；stale 就先刷新
  2. messages = [system(规则+攻略+笔记), user(状态 + 最近 12 条行动结果 + 告警)]
  3. 调模型（带 tools）
  4. 无 tool_calls → 结束本回合（模型想清楚了，说了话或没说话）
  5. 有 tool_calls → 串行执行（最多 4 个/轮），每个结果按三态写进行动日志
  6. 任一工具失败 → **立刻跳出，重读状态**（不拿过期状态继续跑计划）
预算：单轮 ≤ 45s；整回合 ≤ 8 轮 / 30 次工具调用；超了就把"预算用尽"写进状态，让模型收尾
取消：F7/人工接管 → 立刻 abort 当前动作 + 丢弃队列
失败：同一工具同样参数连续失败 2 次 → 禁止再试，提示"换个办法"
```

**上下文策略**：不喂完整多轮 tool 历史（省 token、保缓存），只喂「最近 12 条行动结果（旧→新）+ 当前快照」。若要追溯，靠 transcript 文件，不靠上下文。

**必须支持**：DeepSeek 官方 API / 本地 OpenAI 兼容（一份 provider 实现，两个 base_url）、function calling、多轮、超时、取消、最大调用数。

### 4.6 Reflexes 与控制权（`lease.lua`）

**问题（当前真实存在）**：`reflex.lua` 直接调 `Whale.actions.Start`，**不看** `BWS2.combat` 是否在打，也不检查 `action_executor` 的战斗门禁 → 战斗中反射会和战斗执行器抢 `locomotor`。

**方案：单一裁决点**

```lua
-- lease.lua（唯一有权改 holder 的地方）
Lease.acquire(holder, ttl, meta)   -- holder ∈ {"agent","reflex","combat","task","human"}
Lease.release(holder)
Lease.holder()                      -- 当前持有者 + 剩余 TTL
Lease.can_act(holder)               -- agent 想动 → 必须自己是 holder
-- 优先级：human > reflex(safety) > combat > agent > task
-- reflex 只能"抢占"（preempt），且必须留一条 preempted 记录，随下一次状态写给模型
```

配套约定：

1. **所有执行入口都先过 lease**（`actions.Start` 第一行就查，而不是各调用方自觉）；
2. **反射可抢占但必须汇报**：状态里出现 `注意：AI 思考期间我因为"快天黑了"自己举了火把`（sei 的 `survival` 事件那套）；
3. **人工接管 = `holder="human"`**，F7 立刻设成 human，所有 agent 指令返回 `control_denied`；
4. **战斗期间 agent 只能读**（`fight/flee` 除外），避免"一边 Kiting 一边被叫去砍树"。

### 4.7 Guide / Notes / Transcript

| 组件 | 形态 | 规则 |
|---|---|---|
| Guide | `guide/攻略.md`（主）、`基础生存.md`、`战斗.md`、`四季生存.md`（专题） | 主攻略常驻 system；专题走 `get_guide(topic)` 按需读 |
| Notes | `data/notes/<世界ID>.md`，**≤1200 字** | 每条必须带来源标记：`[看到]` 已观察事实 / `[推断]` 模型猜测；位置类必须带时间戳 |
| Transcript | `data/logs/transcript-<时间>.log` | 每轮：快照 seq、模型原文、工具名+参数、三态结果、耗时、token 用量 |

**Notes 硬规则（任务书要求）**：

```markdown
## 当前基地 [看到] 2026-11-12 日3
(19,-111) 有营火、1 个箱子
## 重要资源 [看到] 日3
西边 20 格有一片草和浆果丛 (0,-111)
## 危险地点 [推断] 日3
东北方向有蜘蛛巢（只看到过蜘蛛，没看到巢）
## 长期目标 [推断]
先活过冬天：需要 30 木头、10 草、1 个锅
```

### 4.8 外部 MCP

- **不给第二套逻辑**：`mcp.js` 只把 `tools/registry.js` 暴露成 MCP，`tools/call` 直接走同一个派发函数；
- **内置 Agent 与 MCP 客户端不同时拥有写权限**：靠 `state/control.js` 的租约，谁的 holder 是谁就谁能写；两边都想写时后到者拿 `control_denied`；
- **必须支持人工接管**：`F7` → `holder=human`，MCP 与内置 AI 同时被拒；
- **MCP 是可选功能**：关掉它，内置 AI 与 DSH 会话仍能玩。

---

## 5. 技术风险

| # | 风险 | 等级 | 说明 / 缓解 |
|---|---|---|---|
| R1 | **双栈并存导致动作冲突** | 🔴 P0 | `Whale.actions` 与 `BWS2.actionExecutor`/`combat`/`tasks` 都能动同一角色。缓解：M1 只留一个入口 + lease |
| R2 | **文件桥分片互相覆盖** | 🔴 P0 | `Master` 与 `Caves` 各写一份 `whale_state.json`，Node 按 mtime 挑 → 会读到另一个世界。缓解：payload 带 `shard`，Node 侧过滤 |
| R3 | **命令去重只有单槽 `last_cmd_id`** | 🟠 P1 | 跨 id 交错后旧 id 重放会再执行一次。缓解：改 `since` 序号 ack（sei 做法） |
| R4 | QueryServer 参数未知（并发/响应体/长轮询） | 🟠 P1 | 只有"串行 1、150KB 送达、<1s"的实测；`[未验证]` 项见 API 文档 §6 |
| R5 | **无主幸存者补丁链脆** | 🟠 P1（M2） | `doattack`/睡着的灯/`Remove()` 抛/不能变鬼/`GIVETOPLAYER`，每条都依赖 vanilla 内部行为 |
| R6 | 客户端动画靠 mod RPC | 🟠 P1 | 服务端走位 + 客户端 RPC 才能看到动画；多人时别人眼里是"平移" |
| R7 | **沙箱兼容头漏写会让世界起不来** | 🟠 P1 | 必须有"`pcall/tonumber/os/io` 全 nil"的回归测试（已有，不能丢） |
| R8 | token / API Key 泄漏面 | 🟠 P1 | `bws_config.lua` 含明文 token 且**会被复制进游戏目录**；API Key 必须只活在 Node |
| R9 | **单测通过 ≠ 真机能跑** | 🟠 P1 | 211 个测试全过，但历史上一堆 bug 只有真机才暴露（位置 `(x,0)`、捡东西没接出来）。每个里程碑必须有真机验收清单 |
| R10 | 两条产品线的维护成本 | 🟡 P2 | 收敛前每改一个功能都要改两遍；M1 必须先收敛 |
| R11 | 状态预算与 token 成本 | 🟡 P2 | 参考项目 3~6k token/步、每小时百万级输入；必须有硬预算与缓存友好的固定前缀 |
| R12 | 记忆污染（把推断当事实） | 🟡 P2 | Notes 必须分层标记；否则模型会"记得"从来没见过的蜘蛛巢 |

---

## 6. 开发顺序（M1~M5）

| 里程碑 | 目标 | 验收标准（必须可真机复现） |
|---|---|---|
| **M1 · 收敛** | 单入口、单执行器、lease、修 P0 | ①`modmain` 只 import 一条链；②同一时刻只有一个 holder 能动作；③R1/R2/R3 的 bug 复现用例变绿；④211+ 单测全过；⑤真机：AI 连续走位/采集 10 次无冲突 |
| **M2 · 观测与寻址** | `#N`、delta、预算、局部地图、stale 校验 | 模型能用 `#3` 采到"那丛草"；快照过期时报 `stale_ref` 而不是乱走；状态 ≤6000 字符 |
| **M3 · 闭环** | Agent Loop + 三态结果 + Notes/Guide/Transcript | 真机连续玩 3 个游戏日不用人插手；崩溃/取消都能恢复；transcript 可复盘 |
| **M4 · 独立实体 spike + 战斗** | 无主幸存者 spike；`fight/flee` 接战斗执行器 | spike 出一条"它自己砍倒一棵树"的真机日志；Kiting 与反射不再抢控制权 |
| **M5 · 长跑与外部 MCP** | 断线恢复、季节迁移、MCP 复用同一 registry | 断网/重启 Bridge/重进世界后自动恢复；MCP 与内置 AI 不互抢 |

---

## 7. 不建议做的事（明确排除）

1. 数据库 / 向量检索 / RAG（任务书 §9 已排除，Markdown 足够）；
2. 独立微服务（`survival/` 这类"只有协议没有入口"的包）；
3. 给 Lua 模组加 socket / HTTP server；
4. 提前做多 AI 幸存者（sei 的模块级单例说明这层要重写，现在没有需求）；
5. 把整张地图画成文本（先做 16 格半径，地图只在 M3 用 21×11 的字符图）；
6. 为"未验证的 API"写抽象层（先用最笨的办法真机跑通，再抽象）。

---

## 8. 需要你拍板的 6 件事

| # | 决策 | 我的建议 | 影响 |
|---|---|---|---|
| D1 | 产品线选哪条 | **B 栈（`lib/` + `scripts/whale`）** | 决定要吸收哪些 TS 代码 |
| D2 | 主传输通道 | **先文件桥**，M2 加 HTTP 适配 | 决定 M1 是否要动通信层 |
| D3 | AI 身体 | **M1 玩家角色**，M2 spike 无主幸存者 | 决定 M2 的时间安排 |
| D4 | `scripts/main/*` 怎么处理 | **移到 `legacy/`（不删）** | 决定目录结构 |
| D5 | 保留 F8 内置 AI 吗 | **保留**，但与 MCP 共享租约 | 决定 `lib/agent.js` 是否吸收 `agentLoop` |
| D6 | `survival/` 包 | **归档**（把 9 态状态机 + lease 的思路吸收进 `state/control.js`） | 决定是否再多一条死代码 |

> 这 6 条确认后，M1 的按文件改动清单见 `M0_migration_plan.md`，目标目录见 `M0_final_directory.md`。
