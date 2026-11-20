# 架构重构路线图与目标架构草案 (Refactor Roadmap & Target Architecture)

> 生成时间：2026-11-19
> 审计分支：`stabilize/architecture-baseline`
> 治理目标：从无序功能堆叠收敛为边界清晰、职责唯一、单执行出口、高可靠测试的架构基线。

---

## 一、问题清单与治理矩阵

| 序号 | 核心问题 | 涉及文件 | 严重等级 | 治理策略 | 状态 |
|---|---|---|---|---|---|
| **ISSUE-01** | **技能参数传递断裂**：`SkillExecutor` 与 `run_skill` 无法接收 `skill_args`，`gather_resources` 强依赖默认 `CORE_RECIPE` | `lib/tools.js`, `lib/skills/skill-executor.js`, `lib/skills/gather-resources.js` | **P0 (关键执行断链)** | 在 `run_skill`、`SkillExecutor.run(skillId, taskId, args)` 中打通参数，持久化保存至 `inst.data`，恢复时保留 | **已解决 (Phase R.1)** |
| **ISSUE-02** | **技能与任务定义双重冗余**：`establish-home.js` 与 `establish-home-skill.js`、`gather-resources.js` 与 `gather-resources-skill.js` 重复维护业务模型 | `lib/skills/establish-home.js`, `lib/skills/gather-resources.js`, `lib/planner/task-skill-orchestrator.js` | **P1 (核心架构冗余)** | 彻底分离 Task 与 Skill 职责，新增 `TaskSkillOrchestrator`，消除两套重复维护的状态机，单一入口推进 | **已解决 (Phase R.2)** |
| **ISSUE-03** | **世界记忆结构不完整**：`emptyMemory` 缺少 `skill_instances`、`explored_regions`、`known_resources` 声明 | `lib/planner/world-memory.js` | **P1 (持久化契约不全)** | 在 `world-memory.js` 中规范化内存字段与 schema 校验 | **已解决 (Phase R.3)** |
| **ISSUE-04** | **规划层职责重叠**：旧版 `plan.js` 仍包含基础工具与背包防具规划，与层级任务看板重合 | `lib/plan.js`, `lib/planner/development-stages.js`, `lib/planner/decision-arbiter.js` | **P2 (规则冗余)** | 收缩 `plan.js` 仅保留 P0/P1 生存应急规则，发展类科技完全移交 `TaskBoard` | **已解决 (Phase R.4)** |
| **ISSUE-05** | **Lua 家务宏孤岛代码**：`chores.lua` 注册了 6 个动作但无任何上游调用链 | `DontStarveWhaleSurvivor/scripts/whale/chores.lua` | **P2 (孤岛死代码)** | 评估接入规范或标记为 Internal，避免未经验证的代码累积 | 低 |
| **ISSUE-06** | **配方表 6 处硬编码维护**：材料数量分散在多个脚本 | `lib/plan.js`, `lib/planner/planner-core.js`, `lib/skills/*`, `lib/actions/specs/crafting.js` | **P2 (数据漂移风险)** | 提取统一只读配方模块 `lib/actions/recipes.js`，配方一致性测试统一盯防 | 低 |
| **ISSUE-07** | **文档严重滞后与数据冲突**：README 漏写工具数与 run_skill，ARCHITECTURE.md 缺少层级规划与技能层 | `README.md`, `docs/ARCHITECTURE.md`, `docs/STATUS.md` | **P1 (治理可信度)** | 更新所有文档，使工具数统一为 42、测试对齐最新状态、更新架构说明 | **已解决 (Phase R.5)** |
| **ISSUE-08** | **任务与技能实例身份混淆与重试失效**：不同 Task 共享 `memory.skill_instances[skill_id]`，失败实例未真实重试下发动作，并发无互斥保障 | `lib/skills/skill-executor.js`, `lib/planner/world-memory.js`, `lib/planner/task-board.js`, `lib/planner/task-skill-orchestrator.js`, `lib/tools.js` | **P0 (生命周期与身份缺陷)** | Task ID 与 Skill Instance ID 彻底分离，冷却期满重建全新 instance_id 并真实下发动作，单角色单实例互斥 | **已解决 (Phase R.6)** |
| **ISSUE-09** | **自主执行接入缺失与运行隔离不足**：正式 MCP 入口未接通调度器，缺乏跨请求共享且互斥的世界运行时，缺乏自动/手动模式控制 | `lib/planner/world-runtime-manager.js`, `lib/tools.js`, `tests/autopilot-runtime.test.mjs` | **P0 (自主执行能力缺失)** | 新增 `WorldRuntimeManager` 集中世界上下文与互斥锁，引入 `advance_task` 工具接入 Orchestrator，实现三种执行模式权限隔离 | **已解决 (Phase R.7)** |
| **ISSUE-10** | **自主生存循环循环不闭环** | (待定) | **P1 (自治闭环)** | 实现长期目标自主生成与持续生存任务自主循环 | **待办 (Phase R.8)** |

---

## 二、问题详细证据与处理建议

### ISSUE-01：技能参数传递断裂（本轮阶段门禁选定修复目标）
- **位置**：
  - `lib/tools.js:1186-1232` (`runSkillTool`)
  - `lib/skills/skill-executor.js:158` (`run(skillId)`)
  - `lib/skills/gather-resources-skill.js:17` (`recipeOf(ctx)`)
- **实际代码证据**：
  - `tools.js:1223`：`result = await exec.run(skillId)`，完全未向 `exec.run` 传递 `input.skill_args` 或 `input.args`。
  - `skill-executor.js:158`：函数签名仅为 `async run(skillId)`，没有入参接收业务定制参数。
  - `gather-resources-skill.js:17`：只能从 `ctx.instance?.data?.recipe` 读，否则写死退回 `CORE_RECIPE`。
- **风险**：
  - 模型无法通过 `run_skill` 指定采集目标（例如指定收集 4 个木头、或指定收集锅的材料）。
  - 任务看板即使给出了 `skill_args`，技能执行器也完全无法消费，使得 `gather_resources` 技能形同虚设。
- **推荐归属模块**：`lib/skills/skill-executor.js` & `lib/tools.js`
- **处理建议**：
  1. `SkillExecutor.run(skillId, args = null)` 支持传入 `args`。
  2. 若传入了合法的 `args`（例如 `{ recipe, target_items }`），将其合并持久化至 `instance.data`，恢复执行时保持原有 `skill_args`。
  3. `tools.js` 的 `runSkillTool` 支持解析 `input.skill_args` 或 `input.args` 并透传。
  4. `gather-resources-skill.js` 支持从 `instance.data.skill_args` 提取动态配方与目标。
- **需要补充的测试**：
  - 验证 `run_skill` 带 `skill_args` 能够正确传导至实例 `inst.data`。
  - 验证技能中断再恢复时，原有 `skill_args` 保持不丢。

---

## 三、目标架构草案 (`docs/ARCHITECTURE.md` 目标草案)

> 说明：本草案为后续统一更新 `docs/ARCHITECTURE.md` 的权威设计基线，目前先记录于此。

### 1. 架构目标模型

```
┌───────────────────────────────────────────────────────────────────────────┐
│                     调用层 (DSH MCP / 游戏内 F8)                         │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │
                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                 Node 决策中枢 (Single Decision Pipeline)                  │
│                                                                           │
│  Planner (发展阶段) ──┐                                                   │
│                       ▼                                                   │
│  Task Board (目标看板) ──► Decision Arbiter (唯一出口)                     │
│                       ▲                                                   │
│  Survival (保命规则) ──┘           │                                      │
│                                    │ 绑定                                 │
│                                    ▼                                      │
│                        Task ──► Skill Executor                            │
│                                    │ (逐步推进)                           │
│                                    ▼                                      │
│                            Action Dispatcher                              │
│                      (参数归一 / 租约注入 / 证据核验)                     │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │ IPC 通信 (文件桥 / HTTP)
                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    Lua 原生执行层 (Native DST Runtime)                    │
│                                                                           │
│  bridge.lua (轮询/分发) ──► guard.lua (白名单/代际/目标二道闸)             │
│                                    │                                      │
│                                    ▼                                      │
│                        actions/*.lua + battle.lua                         │
│                                    │                                      │
│                                    ▼                                      │
│                         DST Locomotor / Actions                           │
│                                                                           │
│  [紧急避险旁路] reflex.lua (3秒生死线抢占) ──► A.Abort() 停止当前任务     │
└───────────────────────────────────────────────────────────────────────────┘
```

### 2. 核心设计原则
1. **单一决策出口**：模型每次只看到一个明确主目标，不允许旧 plan 与新 planner 互相打架。
2. **Task 与 Skill 职责解耦**：Task Board 负责“目标与完成标准”；Skill Executor 负责“执行步骤与状态机”，绝不维护双份步骤记录。
3. **真实证据核验**：所有动作与技能完成必须依靠最新快照事实核对，不轻信 `ok=true`。
4. **权威租约与两道闸门**：全系统只有 Dispatcher 一个动作出口；Lua Guard 永远进行二次防御校验。

---

## 四、分阶段重构路线图 (Implementation Phases)

### 阶段 R.1：打通技能参数传递与工具说明补齐 (Stage Gate - 本轮实施)
- **目标**：解决最紧迫的参数断链问题（`ISSUE-01`）。
- **行动**：
  1. `lib/skills/skill-executor.js` 支持 `run(skillId, skillArgs)`，将参数落盘在 `inst.data.skill_args`。
  2. `lib/tools.js` 的 `runSkillTool` 提取 `input.skill_args` 并透传。
  3. `lib/skills/gather-resources-skill.js` 优先使用传入的 `skill_args.recipe`。
  4. 补齐对应单元测试，确保全量测试通过。

### 阶段 R.2：收敛任务生成器与技能的重复实现（已完成）
- **目标**：彻底消除 `establish-home.js` 与 `gather-resources.js` 的双重维护（`ISSUE-02`）。
- **行动与成果**：
  1. 新增 `lib/planner/task-skill-orchestrator.js`，实现 `TaskSkillOrchestrator`，作为 Task Board 与 Skill Executor 的唯一连接器；
  2. 收敛职责：Planner 负责阶段/策略，Task Board 负责任务看板/依赖/状态，Skill Executor 负责单步状态机与真实快照核验，消除两套重复维护的状态机；
  3. 统一重构 `establish-home.js` 与 `gather-resources.js`，保留原有全部选址、备选位置、可达性验证与真实建筑验证；
  4. 支持 Reflex 抢占与优雅恢复，已完成步骤不重放；
  5. 规范 `[TASK]`, `[ORCHESTRATOR]`, `[SKILL]` 标准化日志输出；
  6. 新增 `tests/task-skill-orchestrator.test.mjs`（14/14 通过），全量回归测试 939 项全部通过。

### 阶段 R.3：统一世界记忆数据规范 (Phase R.3 已完成)
- **目标**：完善 `world-memory.js` 的持久化字段与 schema 版本自愈升级（`ISSUE-03`）。
- **行动与成果**：
  1. 补齐 `emptyMemory` 中的 `skill_instances`、`explored_regions`、`known_resources` 等全部结构字段声明。
  2. 实现 `SUPPORTED_SCHEMAS`、`validateMemory` 与 `migrateMemory`。
  3. 支持旧版本及无版本数据的平滑升级，修复损坏坐标、越界 stage 与异常结构。
  4. `store.load` 自动检测并落盘自愈。
  5. 补齐 `tests/world-memory.test.mjs`（WM-11, WM-12），全量 941 项测试全绿。

### 阶段 R.4：收敛 Planner 决策仲裁与职责边界 (Phase R.4 已完成)
- **目标**：彻底理清 Planner Core、Decision Arbiter 与旧 plan.js 的边界冲突（`ISSUE-04`）。
- **行动与成果**：
  1. 梳理 Decision Arbiter 优先级梯队：P0（生命危险）/ P1（生存临界）绝对优先抢占；P2 驱动 Task Board 阶段任务；P3/P4 执行探索与日常维护。
  2. 收敛 `lib/plan.js` 为纯生存应急引擎与开局基本生存兜底，彻底移除旧有的中长期发展与装备制造目标（`mine_rock`, `chop_wood`, `craft_backpack_and_armor`, `build_science_machine`），将中长期发展编排全权交由 Task Board 与 Skill Executor。
  3. 强化统一决策输出：`get_state` 在装配 planner 时统一输出 `## 当前计划（统一决策）`，彻底消除双份计划对 AI 模型的认知干扰。
  4. 新增 `PLAN-R4-1`、`PLAN-R4-2` 契约回归测试，全量测试达 943 项全绿。

### 阶段 R.5：文档基准完全对齐（已完成）
- **目标**：消除所有文档间的版本、工具数、测试数冲突（`ISSUE-07`）。
- **行动与成果**：
  1. 更新 `README.md`，写明 42 个工具并加入 `run_skill` 用法。
  2. 更新 `docs/STATUS.md`，将测试基准校准为 943 全绿，消除内部矛盾。
  3. 整理文档结构，确保系统只有一份权威架构说明。

### 阶段 R.6：任务身份与技能实例生命周期重构 (Phase R.6 已完成)
- **目标**：彻底解决 Task ID 与 Skill Instance ID 混淆、失败重试未真正下发动作、同技能跨任务参数串扰与并发互斥问题（`ISSUE-08`）。
- **行动与成果**：
  1. **Task ID 与 Skill Instance ID 彻底分离**：
     - `world memory.skill_instances[instance_id]` 唯一存储实例，增加 `active_skill_instance_id`；
     - 实例包含 `instance_id`、`task_id`、`skill_id`、`skill_args`、`status`、`step_index`、`step_attempts`、`step_calls`、`created_at`、`updated_at`、`failed_at`、`completed_at`；
     - Proxy 包装层保障历史以 `skill_id` 读取时的透明向前兼容；
     - 同一技能模板的多个不同任务（如连续三个材料采集任务）强制拥有不同 `instance_id`，参数相互独立。
  2. **失败重试真实执行**：
     - 任务失败保留失败原因与历史实例，不再覆盖；
     - Task Board 进入冷却期 `cooldown`，任务临时置为 `blocked`；
     - 冷却结束后恢复 `ready`；再次调度时分配全新 `instance_id`，重新读取最新快照，真实调用 Dispatcher 执行动作（动作调用计数 > 0），杜绝直接返回 failed 或盲目重放动作；达到 `MAX_ATTEMPTS` 后标记为永久 `failed`。
  3. **调度边界与互斥保障**：
     - 严格单角色单活动实例互斥，启动新实例自动将其它实例置为 `paused`；
     - `run_skill` 默认绑定 `manual:${skillId}`，与自动调度实例彻底隔离；手动操作结束后自动任务安全恢复；
     - `get_state` 绝对保持只读，不产生任何动作下发副作用；
     - 跨世界实例严格物理隔离，切换世界后绝不恢复其它世界的实例。
  4. **测试与验证**：
     - 新增 `tests/task-instance-lifecycle.test.mjs`，包含 16 个生命周期场景测试（LIFECYCLE-01 至 LIFECYCLE-16）以及 1 个完整端到端三资源串行任务测试（LIFECYCLE-INTEGRATION）；
     - 全量测试通过数从 943 增至 **959/959 全部通过**（0 失败、0 跳过）。

### 阶段 R.7：自主执行运行时集成 (Phase R.7 已完成)
- **目标**：打通自主任务执行运行时闭环，实现 advance_task 多步调度、生存紧急仲裁、结构识别与食物熔断机制（`ISSUE-09`）。
- **行动与成果**：
  1. **WorldRuntimeManager 与权威执行上下文**：
     - 新增 `lib/planner/world-runtime-manager.js`，管理世界级权威上下文与并发互斥锁（Mutex），同 `world_key` 共享单例 Runtime，杜绝跨世界记忆与执行串扰；
     - 接入 `advance_task` MCP 工具，打通 LLM -> `advance_task` -> `WorldRuntime` -> `Orchestrator.tick()` -> `SkillExecutor` -> `Dispatcher` 完整调度链路；
     - 支持多步骤连续预算调度（`budget_used` / `budget_remaining`），返回包含真实快照证据、执行轨迹与生存警报的结构化核验报告。
  2. **生存紧急仲裁与 Reflex 协作调度**：
     - 在 `lib/planner/task-skill-orchestrator.js` 中完善 P0/P1 生存危机（饥饿、黑夜无光、低血、Reflex 逃脱）仲裁逻辑；
     - 触发危机时自动挂起（`paused`）当前任务实例，内部调度 `survival_stabilize` 或让位 `lua_reflex`；危机解除后无缝恢复原任务实例与上下文（保持相同的 `instance_id` 与参数，不重复重放动作）。
  3. **结构识别与 Prefab 规范化**：
     - 新增 `lib/planner/prefab-utils.js`，统一科技建筑与基础容器（`sciencemachine`/`researchlab`、`alchemyengine`/`researchlab2`、`chest`/`treasurechest`）的别名映射与 `matchStructure` 判定，彻底解决逻辑配方名与游戏原生 Prefab 之间的不一致问题。
  4. **安全食物选择器与熔断机制**：
     - 新增 `lib/skills/food-candidate-selector.js`，严格过滤危险食物并基于新鲜度和饱食度智能排序，增加连续采集/进食失败的熔断器保护，避免陷入无限尝试死循环。
  5. **运行模式控制与 stop 应急工具**：
     - 实现 Autopilot / Assisted / Manual 三种运行模式，动态过滤 `tools/list` 并通过 `executeTool` 服务端进行严格权限拦截，防止模型绕过看板调用底层原子指令；
     - 新增 `stop` 应急工具，支持最高优先级主动打断当前运行中的任务与底层 Dispatcher 命令。
  6. **测试与验证**：
     - 新增 4 个核心测试套件（`tests/advance-task-budget.test.mjs`、`tests/emergency-survival-orchestration.test.mjs`、`tests/food-candidate-circuit-breaker.test.mjs`、`tests/prefab-structure-identification.test.mjs`），并全面适配生命周期与调度器断言；
     - 全量自动化测试达到 **986/986 全部通过**（986 pass, 0 fail, 0 skipped）。
