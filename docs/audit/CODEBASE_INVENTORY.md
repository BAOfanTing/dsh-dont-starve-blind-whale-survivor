# 代码库完整清单与模块审计报告 (Codebase Inventory)

> 生成时间：2026-11-19
> 审计分支：`stabilize/architecture-baseline` (基于 commit `87cfcac`)
> 范围：Node.js 插件层、Lua 模组层、配套工具层与测试层全量文件

---

## 一、模块状态定义规范

- **active**：当前核心执行链实际调用且正常运作。
- **legacy**：历史旧实现，当前仍存在兼容调用或兜底作用，但计划收敛。
- **duplicate**：与其他模块存在显著职责或逻辑重复，维护成本高。
- **dead**：代码已实现，但无任何实际调用链（死代码）。
- **incomplete**：已实现部分逻辑，但上游入口未暴露或下游执行链断裂。
- **experimental**：实验性分支/通信通道，尚未作为生产唯一标准。
- **unknown**：暂时无法确认其完整生命周期。

---

## 二、Node.js 插件与规划模块清单 (`lib/`)

| 模块 | 文件路径 | 主要职责 | 调用方 (Callers) | 被调用方 (Callees) | 状态 |
|------|----------|----------|------------------|--------------------|------|
| **Plugin Entry** | `lib/index.js` | DSH 插件生命周期配置、设置项声明、预设与 MCP 服务器装配 | DSH 框架 / Cordis | `bridge.js`, `mcp-server.js`, `tools.js`, `agent.js`, `control.js`, `session-log.js`, `notes-store.js`, `planner/planner-core.js`, `mod-install.js` | **active** |
| **Tools Interface** | `lib/tools.js` | MCP 工具表暴露（42工具）、`executeTool` 总入口、`getState` 聚合与快照渲染 | `index.js`, `mcp-server.js`, `agent.js`, `tests/*` | `dispatcher.js`, `state/snapshot.js`, `actions/specs/index.js`, `plan.js`, `planner/decision-arbiter.js`, `skills/index.js`, `control.js` | **active** |
| **Action Dispatcher** | `lib/dispatcher.js` | 外部动作唯一出口：白名单校验、参数归一化、权威租约注入、命令持久化写入、超时等待、真实前后快照证据核对 | `tools.js` (`dispatcherFor`), `skills/skill-executor.js` | `control.js`, `actions/specs/index.js`, `actions/state-query.js`, `bridge.js` | **active** |
| **Game Bridge Client** | `lib/bridge.js` | 本地文件桥管理、寻找游戏存档与分片目录、轮询读写 `whale_*.json`、HTTP 加速通道启动 | `index.js`, `dispatcher.js`, `tools.js`, `session-log.js`, `tools/*` | `http-server.js`, 文件系统 `node:fs` | **active** |
| **Control Lease** | `lib/control.js` | 控制权租约管理（LeaseManager）：单写者互斥、世代标记 (generation fencing)、换手确认 ACK 检验 | `index.js`, `dispatcher.js`, `agent.js`, `tools.js` | 文件系统 `whale_lease.json`, `whale_lease_ack.json` | **active** |
| **HTTP Bridge Server** | `lib/http-server.js` | 本地 HTTP 交互通道服务器，供游戏 Lua 模组在具备网络环境时低延迟直连交换数据 | `lib/bridge.js` | `node:http`, `node:events` | **experimental** |
| **MCP Server** | `lib/mcp-server.js` | Streamable HTTP MCP 服务器实现（端点 `/mcp`, `/status`, `/settings`） | `lib/index.js` | `tools.js` (`executeTool`, `toolList`, `buildInstructions`) | **active** |
| **F8 Agent Loop** | `lib/agent.js` | 游戏内按 F8 触发的内置自主 AI 循环：自主获取状态、节流重读、调用 LLM、执行工具、背包增量追踪 | `lib/index.js` | `tools.js` (`readSnapshot`, `executeTool`), `plan.js`, OpenAI 兼容 API | **active** |
| **Game Client Bridge** | `lib/client.js` | 独立桥接客户端，供外部脚本连接与操作游戏状态 | `tools/build-client.mjs`, `package.json exports` | `lib/bridge.js` | **active** |
| **Mod Installer** | `lib/mod-install.js` | 自动/手动将 `DontStarveWhaleSurvivor` 复制到 DST `mods/` 目录并配置 `modsettings.lua` | `lib/index.js`, `tools/install-mod.mjs` | `bridge.js` (`findGameDirs`), 文件系统 | **active** |
| **World Notes Store** | `lib/notes-store.js` | 按 `world_key` 隔离持久化长期备忘笔记 (`notes.md`) | `lib/index.js`, `lib/tools.js` | 文件系统 | **active** |
| **Session Logger** | `lib/session-log.js` | 会话全流程日志归档（命令、回执、环境、反射与死亡事件写至 `latestLogs/`） | `lib/index.js`, `tools/session-recorder.mjs` | `state/snapshot.js` | **active** |
| **State Snapshot** | `lib/state/snapshot.js` | 归一化游戏快照解析器：解析 `whale_state.json`，校准时间差、渲染人机可读文本与 JSON 载荷 | `lib/tools.js`, `lib/agent.js`, `lib/session-log.js`, `lib/dispatcher.js` | `schema/state.schema.json` | **active** |
| **State Query Helper** | `lib/actions/state-query.js` | 快照查询工具集：背包数量统计、装备检测、实体比对与属性提取 | `dispatcher.js`, `plan.js`, `skills/skill-utils.js`, `planner/task-board.js` | 无 | **active** |
| **Target Kinds** | `lib/actions/target-kinds.js` | 实时目标类别枚举定义（与 Lua `targetrules.lua` 逐条对应，无需快照 ID） | `tools.js`, `dispatcher.js`, `plan.js` | 无 | **active** |
| **Legacy Survival Plan** | `lib/plan.js` | 旧版生存规则引擎：基于快照优先级列表（761 行）推导单一生存目标与 `_nearest` 原子动作建议 | `tools.js` (`derivePlan`), `agent.js`, `planner/decision-arbiter.js` | `actions/state-query.js`, `actions/target-kinds.js` | **legacy / duplicate** |
| **Planner Core** | `lib/planner/planner-core.js` | 层级规划中枢：编排发展阶段、任务看板、家园记忆、建家门槛 `guardBuild` | `index.js`, `tools.js` | `world-memory.js`, `task-board.js`, `development-stages.js`, `base-site-planner.js`, `survival-priority.js`, `skills/establish-home.js`, `skills/gather-resources.js` | **active** |
| **Decision Arbiter** | `lib/planner/decision-arbiter.js` | 统一决策出口：聚合生存规则引擎与层级任务看板，输出唯一 `decision` | `tools.js` (`getState`) | `survival-priority.js`, `development-stages.js` | **active** |
| **Task Board** | `lib/planner/task-board.js` | 中期任务看板：管理任务 DAG 依赖、优先级、执行状态机、快照证据核验 | `planner-core.js`, `decision-arbiter.js`, `tests/*` | `actions/state-query.js` | **active** |
| **Development Stages** | `lib/planner/development-stages.js` | 长期发展阶段（Stage 0~6）评估与里程碑判定 | `planner-core.js`, `decision-arbiter.js`, `skills/establish-home-skill.js` | 无 | **active** |
| **Base Site Planner** | `lib/planner/base-site-planner.js` | 营地多指标评分与选址计算（主营地 + 备选营地） | `planner-core.js`, `skills/establish-home-skill.js` | 无 | **active** |
| **Survival Priority** | `lib/planner/survival-priority.js` | P0~P4 生存危险等级划分与阻断状态判定 | `planner-core.js`, `decision-arbiter.js`, `skills/skill-executor.js`, `skills/survival-stabilize.js` | 无 | **active** |
| **World Memory Store** | `lib/planner/world-memory.js` | 按 `world_key` 隔离持久化长期发展记忆（营地、家锚点、阶段、里程碑、建筑） | `planner-core.js`, `tools.js` (`runSkillTool`), `tests/*` | `notes-store.js` | **active** |
| **Skill Registry** | `lib/skills/skill-registry.js` | 技能注册表，管理技能元数据与步骤定义规范 | `skills/index.js`, `skills/skill-executor.js` | 无 | **active** |
| **Skill Executor** | `lib/skills/skill-executor.js` | 复合技能增量执行器：逐步执行、单动作下发、真实快照证据核对、中断恢复与租约/抢占感知 | `skills/index.js`, `tools.js` (`runSkillTool`) | `skill-registry.js`, `planner/survival-priority.js` | **active** |
| **Skill Utilities** | `lib/skills/skill-utils.js` | 技能公共计算辅助：材料缺口、原材料/中间产物映射、距离感知与目标走位选择 | `skills/survival-stabilize.js`, `skills/establish-home-skill.js`, `skills/gather-resources-skill.js` | `actions/state-query.js`, `planner/task-board.js` | **active** |
| **Skill: Survival Stabilize** | `lib/skills/survival-stabilize.js` | 复合保命技能：光源保障 → 濒死回血 → 饱食维持 → 基础工具制作 | `skills/index.js` | `skill-utils.js`, `planner/survival-priority.js` | **active** |
| **Skill: Establish Home** | `lib/skills/establish-home-skill.js` | 复合建家执行技能：勘察选址 → 前往营地 → 收集核心材料 → 建造科学机器 → 建立家园锚点 → 验证 | `skills/index.js` | `skill-utils.js`, `planner/base-site-planner.js`, `planner/development-stages.js`, `skills/establish-home.js` (`CORE_RECIPE`) | **active** |
| **Task Generator: Establish Home** | `lib/skills/establish-home.js` | 旧版建家任务看板生成函数：向 Task Board 注入 5 个静态任务 | `planner/planner-core.js`, `skills/establish-home-skill.js` | `skills/gather-resources.js` | **duplicate / legacy** |
| **Skill: Gather Resources** | `lib/skills/gather-resources-skill.js` | 复合资源采集执行技能：计算材料配方缺口、中间产物依赖制作与采集原子动作派发 | `skills/index.js` | `skill-utils.js`, `skills/establish-home.js` (`CORE_RECIPE`) | **active** |
| **Task Generator: Gather Resources** | `lib/skills/gather-resources.js` | 旧版资源收集任务看板生成函数与材料动作映射字符串 | `skills/establish-home.js`, `planner/planner-core.js` | `actions/state-query.js` | **duplicate / legacy** |

---

## 三、Node.js 动作规格清单 (`lib/actions/specs/`)

| 模块 | 文件路径 | 主要职责 | 规格包含的动作 | 状态 |
|------|----------|----------|----------------|------|
| **Specs Index** | `lib/actions/specs/index.js` | 动作规格总汇总导出 `ACTION_SPECS` | 导出 38 个动作规格 | **active** |
| **Movement Specs** | `lib/actions/specs/movement.js` | 移动类动作规格及参数、验证逻辑 | `move_to`, `stop`, `seek` | **active** |
| **Gathering Specs** | `lib/actions/specs/gathering.js` | 采集与劳作类动作规格及验证逻辑 | `pickup_nearest`, `pickup_food`, `harvest_nearest`, `chop_nearest`, `mine_nearest`, `pickup`, `harvest`, `gather`, `chop`, `mine`, `dig`, `hammer`, `gather_area` | **active** |
| **Crafting Specs** | `lib/actions/specs/crafting.js` | 制作、建造与烹饪规格及验证逻辑 | `build`, `cook`, `craft` | **active** |
| **Survival Specs** | `lib/actions/specs/survival.js` | 生存、穿脱与睡眠规格及验证逻辑 | `eat`, `equip`, `unequip`, `drop`, `fuel`, `wait`, `sleep` | **active** |
| **Interaction Specs** | `lib/actions/specs/interaction.js` | 容器交互、物品给予与检查规格 | `use`, `container_take`, `container_put`, `give` | **active** |
| **Combat Specs** | `lib/actions/specs/combat.js` | 战斗与蜘蛛风筝战术规格及验证逻辑 | `attack`, `kill`, `fight_spider` | **active** |
| **Info Specs** | `lib/actions/specs/info.js` | 原生配方、实体与视野查询规格 | `recipes`, `lookup`, `probe`, `inspect` | **active** |
| **Social Specs** | `lib/actions/specs/social.js` | 游戏内打字聊天规格 | `say` | **active** |

---

## 四、Lua 模组模块清单 (`DontStarveWhaleSurvivor/`)

| 模块 | 文件路径 | 主要职责 | 调用方 | 被调用方 | 状态 |
|------|----------|----------|--------|----------|------|
| **Mod Metadata** | `modinfo.lua` | 模组基础信息、配置参数定义 (v0.41.0) | DST 游戏引擎 | 无 | **active** |
| **Mod Main Entry** | `modmain.lua` | 模组初始化、加载子模块、配置绑定与环境检测 | DST 游戏引擎 | 全部 whale 子模块 | **active** |
| **JSON Parser** | `scripts/whale/json.lua` | 纯 Lua 实现的轻量 JSON 编解码器 | `bridge.lua`, `guard.lua`, `observe.lua` | 无 | **active** |
| **Utilities** | `scripts/whale/util.lua` | 坐标转换、距离计算、实体检索、地皮通行检测等基础库 | 几乎所有 Lua 模块 | DST 原生 API | **active** |
| **Config Loader** | `scripts/whale/config.lua` | 安全区间夹取与模组配置参数生效出口 | `modmain.lua`, `observe.lua` | 无 | **active** |
| **Actor Provider** | `scripts/whale/actor.lua` | 确定本地玩家实体作为受控 Actor（排查死灵、非主机等） | `observe.lua`, `guard.lua`, `bridge.lua`, `actions/core.lua` | DST 原生 `ThePlayer` | **active** |
| **State Observer** | `scripts/whale/observe.lua` | 采集玩家世界、三维、背包、威胁与危险区，生成状态快照 | `bridge.lua` | `nearby.lua`, `util.lua`, `json.lua`, `native.lua` | **active** |
| **Nearby Observer** | `scripts/whale/nearby.lua` | 扫描周边实体，归类到 9 个桶，分配 `#N` 编号与稳定句柄 `h…` | `observe.lua` | `targetrules.lua`, `pickuprules.lua`, `harvestrules.lua` | **active** |
| **Target Rules** | `scripts/whale/targetrules.lua` | 目标选择权威规则：固定 `target_kind` 枚举与句柄注册表维护 | `nearby.lua`, `guard.lua`, `actions/gathering.lua` | `pickuprules.lua`, `harvestrules.lua`, `eatrules.lua` | **active** |
| **Pickup Rules** | `scripts/whale/pickuprules.lua` | 地面可拾取物白名单及合法性判定 | `nearby.lua`, `guard.lua`, `actions/gathering.lua` | 无 | **active** |
| **Harvest Rules** | `scripts/whale/harvestrules.lua` | 可收获/采摘植物（成熟期）白名单及判定 | `nearby.lua`, `guard.lua`, `actions/gathering.lua` | 无 | **active** |
| **Gather Rules** | `scripts/whale/gatherrules.lua` | 可采集植物（草、树苗、花）白名单及判定 | `guard.lua`, `actions/gathering.lua` | 无 | **active** |
| **Eat Rules** | `scripts/whale/eatrules.lua` | 食物安全进食白名单（排除生蘑菇与怪兽肉等有毒物） | `nearby.lua`, `guard.lua`, `chores.lua`, `reflex.lua`, `actions/survival.lua` | 无 | **active** |
| **Craft Rules** | `scripts/whale/craftrules.lua` | 原生合成配方与科技等级校验规则出口 | `guard.lua`, `actions/crafting.lua` | DST 原生 `AllRecipes` | **active** |
| **Equip Rules** | `scripts/whale/equiprules.lua` | 装备槽位与装备合法性校验规则 | `guard.lua`, `actions/survival.lua` | 无 | **active** |
| **Security Guard** | `scripts/whale/guard.lua` | 游戏内第二道安全闸门：指令白名单、参数防御校验、租约时代代际验证、目标实时复核 | `bridge.lua` | `targetrules.lua`, `pickuprules.lua`, `craftrules.lua`, `eatrules.lua` | **active** |
| **Native Wrappers** | `scripts/whale/native.lua` | DST 原版核心能力薄封装：真实物理照明 `IsLit`、原生 `RunAway` 避障向量、玩家挥砍动作组装 | `observe.lua`, `combat.lua`, `battle.lua`, `reflex.lua` | DST 原生组件 | **active** |
| **Action Hub** | `scripts/whale/actions.lua` | 动作注册总入口与 7 个子模块装配器 | `modmain.lua` | `actions/*.lua` | **active** |
| **Action Core** | `scripts/whale/actions/core.lua` | 动作底层状态机：行走与客户端 RPC 同步、`push` 缓冲动作、工具选择与生命周期管理 | `actions/*.lua`, `macros.lua` | DST 原生 `locomotor`, `BufferedAction` | **active** |
| **Action: Movement** | `scripts/whale/actions/movement.lua` | `move_to`, `go_to`, `seek`, `stop` 动作实现（含海岸线折返探路算法） | `actions.lua` | `core.lua`, `util.lua` | **active** (`go_to` 为 **legacy**) |
| **Action: Gathering** | `scripts/whale/actions/gathering.lua` | 采集与劳作动作实现（`pickup`, `harvest`, `chop`, `mine`, `dig`, `hammer`, `gather_area`, 5个 `_nearest` 动作） | `actions.lua` | `core.lua`, `targetrules.lua`, `pickuprules.lua` | **active** (`pick` 为 **legacy**) |
| **Action: Combat** | `scripts/whale/actions/combat.lua` | 基础战斗动作实现（`attack`, `kill`, `fight_spider`） | `actions.lua` | `core.lua`, `battle.lua`, `native.lua` | **active** |
| **Action: Survival** | `scripts/whale/actions/survival.lua` | 生存动作实现（`eat`, `equip`, `unequip`, `drop`, `fuel`, `wait`, `sleep`, `heal`） | `actions.lua` | `core.lua`, `eatrules.lua`, `equiprules.lua` | **active** (`make_fire`, `add_fuel`, `heal` 为 **incomplete**) |
| **Action: Crafting** | `scripts/whale/actions/crafting.lua` | 制作建造动作实现（`craft`, `build`, `cook`, `recipes`, `lookup`, `probe`） | `actions.lua` | `core.lua`, `craftrules.lua` | **active** (`list_recipes` 为 **legacy**) |
| **Action: Interaction** | `scripts/whale/actions/interaction.lua` | 交互动作实现（`use`, `container_take`, `container_put`, `give`, `inspect`, `say`） | `actions.lua` | `core.lua` | **active** (`store`, `take`, `act`, `list_actions` 为 **legacy**) |
| **Battle Subsystem** | `scripts/whale/battle.lua` | 独立战术战斗系统：蜘蛛打二撤一风筝状态机、安全拾取掉落物、与 Reflex 协同 | `actions/combat.lua` (`JOBS.fight_spider`) | `native.lua`, `actions/core.lua` | **active** |
| **Reflex Emergency** | `scripts/whale/reflex.lua` | 3秒濒死极端防御反射：入夜无光点火、被怪贴脸反向逃脱、濒死进食，支持任务抢占 | `modmain.lua` (`TheWorld:DoPeriodicTask`) | `actions/core.lua`, `native.lua` | **active** |
| **Life Chores** | `scripts/whale/chores.lua` | 生活家务宏（囤料、添柴、搜食、采花）：设计初衷为安全空闲期调度，但未被 Planner/Dispatcher 接驳 | `modmain.lua` | `actions/core.lua`, `util.lua` | **incomplete / dead** |
| **Action Macros** | `scripts/whale/macros.lua` | 旧版宏动作（`gather_macro`, `chop_until`, `cook_meal`, `night_watch`） | `modmain.lua` | `actions/core.lua` | **legacy / dead** |
| **File & HTTP Bridge** | `scripts/whale/bridge.lua` | 游戏端主循环：轮询指令、写状态与回执、同步权威租约与 HTTP 数据交换 | `modmain.lua` | `guard.lua`, `observe.lua`, `actions/core.lua` | **active** |
| **In-game HUD** | `scripts/whale/hud.lua` | 游戏内按键监听（F8/F7）与状态信息浮窗渲染 | `modmain.lua` | `actor.lua` | **active** |

---

## 五、测试套件与运维工具清单 (`tests/` & `tools/`)

### 1. 核心测试套件 (`tests/`)
- 全量自动化测试：**918 例测试通过 (0 fail, 0 skipped)**
- **合约与一致性测试**：`tool-parity.test.mjs` (工具表与白名单对齐), `recipe-parity.test.mjs` (配方一致性), `prompt-parity.test.mjs` (提示词能力清单)
- **动作执行测试**：`actions-movement`, `actions-gathering`, `actions-crafting`, `actions-combat`, `actions-survival`, `actions-interaction`
- **规划与决策测试**：`plan.test.mjs`, `planner.test.mjs`, `skill-executor.test.mjs`, `world-memory.test.mjs`
- **机制与安全测试**：`control-lease.test.mjs`, `guard.test.mjs`, `battle.test.mjs`, `reflex.test.mjs`, `native-reuse.test.mjs`, `target-nearest.test.mjs`

### 2. 配套辅助工具 (`tools/`)
- `tools/install-mod.mjs`：自动化安装模组至游戏目录 (**active**)
- `tools/session-recorder.mjs`：CLI 端会话记录器 (**active**)
- `tools/verify-live.mjs`：真机实机链路验收验证脚本 (**active**)
- `tools/dump-reference.mjs`：导出动作表与合成表参考文档 (**active**)
- `tools/lease-worker.mjs`, `tools/start-mcp.mjs`, `tools/bridge-call.mjs`：测试与调试辅助工具 (**active**)
- `tools/planner-live-check.mjs`, `tools/unpause.mjs`, `tools/watch-state.mjs`：现场监视脚本 (**active**)
