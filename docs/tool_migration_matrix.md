# A/B 功能映射表（工具迁移矩阵）

> 用途：M1.0 的"保护现有资产"清单。**先映射、后迁移；迁移完成前不删原实现。**
> 输入：A 栈 `mcp-server/src/tools/*.ts`（43 个 MCP 工具，25 只读 / 18 写）+ B 栈 `lib/tools.js`（35 个工具）
> 结论速览：A 栈 43 个里 —— **19 个 B 栈已有等价实现（重复）**、**11 个有 B 栈拿不到的价值**（8 个纯计算决策 + 威胁字段 + 事件流 + 诊断探针）、**11 个依赖已归档的 Lua 实现（暂缓到 M4）**、**2 个低价值不迁**。

---

## 1. B 栈现有资产（本轮全部保留，不动）

### 1.1 Node 工具：35 个（`lib/tools.js`）

| 组 | 工具 | 备注 |
|---|---|---|
| 本地（3） | `get_state`、`get_guide`、`update_notes` | 不走文件桥，Node 自己处理 |
| 原子动作（25） | `move_to`、`go_to`、`pick`、`pickup`、`chop`、`mine`、`hammer`、`dig`、`attack`、`eat`、`cook`、`craft`、`build`、`make_fire`、`add_fuel`、`heal`、`equip`、`drop`、`sleep`、`say`、`wait`、`stop`、`act`、`list_actions`、`list_recipes` | 全部转发到 Lua `JOBS.*` |
| 宏（7） | `store`、`take`、`harvest`、`gather`、`chop_until`、`cook_meal`、`night_watch` | `lib/tools.js` 里 4 个是 Lua 宏（gather/chop_until/cook_meal/night_watch），3 个是原子动作的组合封装 |

### 1.2 Lua 动作：28 个原子 + 4 个宏（`scripts/whale/actions.lua` / `macros.lua`）

原子：`move_to go_to chop mine hammer dig pick pickup attack eat cook craft build make_fire equip drop sleep say wait add_fuel heal act list_actions list_recipes store take harvest stop`（`A.Known()` 返回的就是这份，`tests/tool-parity.test.mjs` 逐名比对）
宏：`gather chop_until cook_meal night_watch`（`A.register` 注册进同一张 `JOBS` 表）

### 1.3 其它必须保留的实现

| 资产 | 位置 | 为什么不能丢 |
|---|---|---|
| Kiting 战斗执行器（1026 行，真机验证过 `combat:TryAttack` + `locomotor:GoToPoint`） | `archive/phase-a/scripts/main/combat_executor.lua` | M4 的 `fight/flee` 要基于它；不是重复造 |
| QueryServer 客户端（串行队列 + 自实现超时 + 结果形状） | `archive/phase-a/scripts/main/http_client.lua` | 唯一验证过 `TheSim:QueryServer` 的 Lua 实现 |
| 威胁/环境观察字段（attack_range/是否在追/Boss/光照/体温） | `archive/phase-a/scripts/main/threat_observer.lua` | B 栈观察器现在**没有**这些字段 |
| 决策层 3023 行（威胁评分/战斗准备度/逃跑/季节/Boss/优先级仲裁） | `mcp-server/src/survival/*.ts`（**原处保留**） | 纯计算、零 I/O，是 A 栈最值钱的部分 |
| 命令生命周期（7 态 + 首回执为准 + 会话丢失判 `unknown_completion`） | `archive/` 之前的 `game-bridge/src/commands.ts`（原地未动） | M2 若启用 HTTP 通道要用 |
| 211 个单测 | `tests/*.test.mjs` | 唯一能在无游戏时发现"沙箱兼容/动作不推进"的机制 |

---

## 2. A 栈 43 个工具逐项判断

判据说明：
`✅重复` = B 栈已有等价能力（换栈时直接弃用）
`🔵独有` = B 栈没有等价物，且有独立价值 → **值得迁**
`⏸暂缓` = 价值在，但底层 Lua 实现已归档（要连 Lua 一起复活）
`🟡低价值` = B 栈缺，但收益不明显

### 2.1 只读（25）

| # | A 工具 | 它真正做什么 | B 栈等价 | 判断 |
|---|---|---|---|---|
| 1 | `get_bridge_status` | 桥/会话/队列状态 | `get_state` 有"状态是几秒前的"提示；`/status` 有连接信息 | 🟡低价值（B 侧已有 /status，不必做成工具） |
| 2 | `get_control_status` | 查控制权 holder/lease | 无 | ⏸暂缓（M2 做 Lease 时一起做，接口按 M2 设计重写） |
| 3 | `get_game_status` | 快照总览 | `get_state` | ✅重复 |
| 4 | `get_player_status` | 生命/饥饿/理智/体温 | `get_state` 含 | ✅重复 |
| 5 | `get_inventory` | 背包 + 装备（结构化 JSON） | `get_state` 含（中文文本） | ✅重复（结构化的部分在 M1.2 直接进 `get_state` 的 JSON） |
| 6 | `get_world_status` | 天/季/昼夜/天气/月相 | `get_state` 含（少月相/天气枚举） | ✅重复（缺的 2 个字段 M1.3 补） |
| 7 | `get_nearby_entities` | 附近实体（分类/上限/truncated） | `get_state` 分桶文本 | ✅重复（M1.4 迁它的分类字段） |
| 8 | `get_nearby_resources` | 可采资源 | 同上 | ✅重复 |
| 9 | `get_nearby_threats` | 威胁（attack_range/是否在追/是否 Boss/睡没睡） | **没有** | 🔵**独有** → M1.4 把字段并进观察器 |
| 10 | `get_base_status` | 启发式"像不像家" | 无 | 🟡低价值（启发式、无真机验证） |
| 11 | `refresh_game_state` | 下发 `refresh_state` 命令并等回执 | 不需要（B 栈状态 1s 自然刷新） | ✅重复（语义已被取代） |
| 12 | `get_command_result` | 按 id 查命令结果 | 不需要（B 栈按 id 同步等结果） | ✅重复 |
| 13 | `get_recent_events` | 快照 diff 出 19 类事件 | 无 | 🔵**独有**（"刚刚发生了什么"对实时游戏有用，如"你刚被打了一下"）→ M1.5 之后做 |
| 14 | `probe_game_actions` | 探针：ACTIONS 是否存在、组件可访问 | 无 | 🔵**独有**（诊断用）→ 连 `probe.lua` 一起复活到 `debug/` |
| 15 | `get_task_status` | 任务链进度 | 无（`task_runner` 已归档） | ⏸暂缓（M4 任务链） |
| 16 | `get_threat_assessment` | 0~100 威胁分 + 因素拆解 + 每敌战术档案 | **没有** | 🔵**独有算法** → 迁到 Node（纯计算） |
| 17 | `get_combat_readiness` | 战斗准备度（动态血量阈值/护甲/武器） | 无 | 🔵**独有算法** → 迁到 Node |
| 18 | `get_combat_status` | Node+Lua 战斗状态机 | 无（依赖归档的 combat_executor） | ⏸暂缓（M4） |
| 19 | `get_combat_recommendation` | ENGAGE/PREPARE/EVADE/RETREAT | 无 | 🔵**独有算法** → 迁到 Node（决策） |
| 20 | `evaluate_combat_target` | 单目标评估 | 无 | 🔵**独有算法** → 迁到 Node |
| 21 | `get_escape_options` | 逃跑方案（背离合向量/安全点） | 无 | 🔵**独有算法** → 迁到 Node |
| 22 | `get_seasonal_readiness` | 季节准备度 + 剩余天数 | `get_state` 有季节名，无"准备度" | 🔵**独有算法** → 迁到 Node |
| 23 | `get_environment_hazards` | 黑夜无光/低温/高温/雨 | `get_state` 的"注意"里有粗糙版 | ✅重复（B 版够用；精细版随 `threat_observer` 一起迁） |
| 24 | `get_boss_readiness` | Boss 识别 + 准备报告 | 无 | 🔵**独有算法** → 迁到 Node |
| 25 | `get_survival_priority` | P0 存活 → P5 探索 的全局仲裁 | 无 | 🔵**独有算法** → 迁到 Node |

### 2.2 会改游戏状态（18）

| # | A 工具 | 它做什么 | B 栈等价 | 判断 |
|---|---|---|---|---|
| 1 | `gather_resource` | 采集到够数 | `gather` 宏（多了 until_gone、背包增量校验） | ✅重复（B 更好） |
| 2 | `move_to_target` | 走到某物旁边 | `go_to` | ✅重复 |
| 3 | `equip_item` | 装备 | `equip` | ✅重复 |
| 4 | `chop_tree` | 砍树 | `chop` | ✅重复 |
| 5 | `mine_rock` | 挖矿 | `mine` | ✅重复 |
| 6 | `pick_up_item` | 捡地上物品 | `pickup` | ✅重复 |
| 7 | `eat_item` | 吃 | `eat` | ✅重复 |
| 8 | `craft_item` | 制作 | `craft` | ✅重复 |
| 9 | `build_campfire` | 生营火 | `make_fire` | ✅重复 |
| 10 | `build_structure` | 摆建筑 | `build` | ✅重复 |
| 11 | `start_task` | 启动任务链（8 模板） | 无 | ⏸暂缓（M4；顺带修它 schema 缺 4 个季节任务的老 bug） |
| 12 | `stop_task` | 停任务链 | `stop`（停当前动作） | ⏸暂缓（语义不同，M4 一起） |
| 13 | `start_combat` | 受控开战（confirmed + 白名单 + 单执行者） | 只有 `attack`（平 A，无 Kiting/无撤退） | ⏸暂缓（M4，需先复活 `combat_executor.lua`） |
| 14 | `retreat_from_combat` | 脱离战斗 | 无 | ⏸暂缓（M4） |
| 15 | `evade_threat` | 规避威胁 | 无（反射层有简陋版"血少后退"） | ⏸暂缓（M4） |
| 16 | `abort_combat` | 立刻停战 | 无 | ⏸暂缓（M4） |
| 17 | `prepare_for_season` | 按季节准备 | 无 | ⏸暂缓（M4） |
| 18 | `recover_after_combat` | 战后恢复 | 无 | ⏸暂缓（M4） |

### 2.3 汇总

| 判断 | 数量 | 处理 |
|---|---|---|
| ✅ B 栈已有等价（重复） | **19**（只读 9 + 写 10：`get_game/player/inventory/world/nearby_entities/nearby_resources/environment_hazards`、`refresh_game_state`、`get_command_result` + 10 个动作） | 不迁移；换栈即弃用（原实现留在 `mcp-server/` 不删） |
| 🔵 A 栈独有且有价值 | **11**：8 个决策（`get_threat_assessment`、`get_combat_readiness`、`get_combat_recommendation`、`evaluate_combat_target`、`get_escape_options`、`get_seasonal_readiness`、`get_boss_readiness`、`get_survival_priority`）+ `get_nearby_threats`（字段）+ `get_recent_events` + `probe_game_actions` | 决策算法进 Node（纯函数）、威胁字段进 Lua 观察器、探针进 `debug/` |
| ⏸ 依赖已归档 Lua（暂缓） | **11**：`get_task_status`、`get_combat_status`、`get_control_status`、`start_task`、`stop_task`、`start_combat`、`retreat_from_combat`、`evade_threat`、`abort_combat`、`prepare_for_season`、`recover_after_combat` | M4 与 `combat_executor` / `task_runner` / Lease 一起复活 |
| 🟡 低价值 | **2**：`get_bridge_status`、`get_base_status` | 不迁 |
| 合计 | **43**（19+11+11+2） | ✔ |

---

## 3. 迁移批次（按价值/风险排序）

### 批次 1（M2，最值钱、纯计算、零风险）：决策层 7 个 → Node

| 迁什么 | 从哪来 | 落到哪 | 验收 |
|---|---|---|---|
| 威胁评分（0~100 + 因素拆解） | `mcp-server/src/survival/threat.ts`（436 行） | `lib/analysis/threat.js` | 用 `mcp-server/test/p6.test.ts` 里的算例做 JS 版断言，分数一致 |
| 战斗准备度 + 决策 | `combat.ts`（474 行） | `lib/analysis/combat.js` | 同上 |
| 逃跑方案 | `escape.ts`（366 行） | `lib/analysis/escape.js` | 同上 |
| 季节准备度 | `season.ts`（278 行） | `lib/analysis/season.js` | 同上 |
| Boss 准备 | `boss.ts`（240 行） | `lib/analysis/boss.js` | 同上 |
| 全局仲裁 P0~P5 | `decision.ts`（261 行） | `lib/analysis/priority.js` | 同上 |
| 上下文装配 + 敌人档案表 | `context.ts`（287）+ `profiles.ts`（490） | `lib/analysis/context.js`、`profile.js` | 同上 |

> 为什么先迁它们：**纯函数、无 I/O**（审计确认对 `fs/http/fetch` 引用数为 0），搬过来不会把 A 栈的进程模型带进来；
> 而它们正是"让模型少瞎猜"的关键（打分/比较/给建议），B 栈现在完全没有。

### 批次 2（M1.4）：威胁观察字段 → Lua 观察器

把 `threat_observer.lua` 的字段并进 `scripts/whale/observe.lua` 的"附近"分桶：
`attack_range` / `attack_period` / `attack_damage` / `can_attack_player` / `attacking` / `targeting_player` / `sleeping` / `is_boss`。
**不迁**它的 JSON 序列化与 4 秒扫描调度（B 栈已有自己的节奏）。

### 批次 3（M4）：战斗与任务链（连 Lua 一起复活）

`combat_executor.lua` → `scripts/whale/actions/combat.lua`，`task_runner.lua` → `scripts/whale/actions/tasks.lua`，
并同时补齐 M0 文档点名的 6 条前置：Lease 共享、服务端二次校验、人工接管、紧急停止、旧 generation 拒绝、`stop_task` 调不存在的 `Whale.actions.Stop` 修掉。

### 批次 4（视需要）：诊断

`probe.lua` + `probe_game_actions` → `scripts/debug/probe.lua` + 一个 `debug` 工具（默认关）。

---

## 4. 迁移铁律（写在这里防止以后偷懒）

1. **迁一份、测一份、再归档一份**。原实现不删（`mcp-server/` 原地保留，`archive/` 里的也保留）。
2. **不把 A 栈的进程模型带进来**：不新增端口、不新增服务、不引入第二套工具表。
3. **迁到 Node 的只允许是纯函数**（给定快照对象 → 给结论）。它不许自己读文件、不许自己发请求。
4. **工具的最终形态只有一套**（`lib/tools.js` 的 35 → 目标 25~27）；迁进来的能力如果是"只读分析"，做成 `get_state` 的一部分或一个只读工具，**不要**做成第二个 `get_*` 家族。
5. 每个迁移项都要在 `docs/` 留一条记录：从哪来、改了什么、用什么算例验证。
