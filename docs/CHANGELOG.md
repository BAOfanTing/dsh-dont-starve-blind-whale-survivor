# 变更日志 (Changelog)

所有关键架构演进与版本改动均记录于此。

---

## [Phase R.7.2] - 2026-11-20

### 执行安全与生存稳定性收尾 (Execution Safety & Survival Stability Closing)
- **ISSUE-01: Stop 与 Runtime Mutex 安全协调机制**：
  - `WorldRuntime` 引入递增 `generation` 与 `lockOwnerId` 锁所有权体系，确保锁只能由当前持有者释放，杜绝旧任务 `finally` 误放新任务锁；
  - `stop()` 升级为原子协调流程：标记 `cancelRequested`，清空排队任务，通过 `AbortController` 向全链路（Runtime -> Orchestrator -> SkillExecutor -> Dispatcher -> Bridge）广播取消信号；
  - 下发底层的 `stop` 动作，严格保护 Lua 侧 Reflex 保命抢占（Reflex 正在执行时普通动作与 stop 均不可中断保命行为）；
  - 定义严格的 Stop 状态（`not_started`, `cancel_requested`, `in_flight`, `cancelled`, `completed`, `unknown`），超时必须如实返回 `unknown`，不得伪装成功。
- **ISSUE-02: `unknown` 结果对账与防重复执行**：
  - 当底层动作返回 `unknown` 或 `result_timeout` 时，实例进入 `awaiting_reconciliation` 状态，完整保留 `command_id`、`tool`、`args`、`issued_at` 等身份；
  - 严禁在结果未定时重复下发具有副作用的动作（如 `build`, `craft`, `eat`, `pickup`, `harvest`, `chop`, `mine`）；
  - 下一轮推进时优先通过新鲜快照与真实证据进行对账（如建筑是否生成、物品是否入包、血量/饥饿是否变化）；3 次对账仍无法确认时才进入终态 `unknown` 并上报。
- **ISSUE-03: `seek` 寻食预算全链路贯穿**：
  - 将 `plan.budget_s: 15` 从 Plan -> SkillExecutor -> WorldRuntime -> Dispatcher -> Bridge -> Lua Envelope 完整透传；
  - Dispatcher 动态根据 `budget_s` 计算有效超时时间（`budget_s * 1000 + 15000` 缓冲），杜绝上层先于游戏执行超时的截断问题。
- **ISSUE-04: 食物需求分类与精确评估 (Hunger / Health / Sanity)**：
  - 食物选择器严格区分 `hunger`、`health`、`sanity` 需求，饥饿模式下严格过滤饱食度为 0 的物品（如花瓣 `petals`），杜绝误吃花瓣充饥；
  - 综合考量营养缺口匹配度与新鲜度（`freshness * 50`），并与 Lua 模组 `eatrules.lua` 逻辑严格对齐。
- **ISSUE-05: 食物目标熔断器安全恢复机制**：
  - 区分暂时性失败（`reflex_active`、`actor_busy`、`result_timeout`、`awaiting_reconciliation` 不计入熔断）与永久性失效（`target_gone` 直接注销）；
  - 移除失败次数永久拉黑，熔断锁定状态随冷却时间自然到期恢复；
  - 实现定时清理器 `purgeExpiredFailures()`，设置 120 秒 TTL 并将失败记录上限限制为 50 条，避免内存泄漏。
- **ISSUE-06: MCP 工具列表动态变更推送与模式切换**：
  - 实现客户端 SSE 列表变更通知 `notifications/tools/list_changed`（`listChanged: true`）；
  - 模式切换后即时向客户端广播工具刷新通知，服务端 `executeTool` 保持同步拦截。
- **测试与验证**：
  - 新增 6 大核心测试套件（`tests/stop-mutex-concurrency.test.mjs`、`tests/unknown-reconciliation.test.mjs`、`tests/seek-budget-propagation.test.mjs`、`tests/food-effects-decision.test.mjs`、`tests/food-circuit-breaker-recovery.test.mjs`、`tests/mcp-dynamic-tools.test.mjs`），共 42 例新增专项测试。
  - 全量自动化测试达到 **1028/1028 全部通过**（1028 pass, 0 fail, 0 skipped）。

---

## [Phase R.7] - 2026-11-20

### 自主任务执行运行时集成与治理：WorldRuntime、advance_task 与生存紧急仲裁 (Autopilot Runtime Integration)
- **WorldRuntimeManager 与权威执行上下文**：
  - 新增 `lib/planner/world-runtime-manager.js`，管理世界级权威上下文与并发互斥锁（Mutex），同 `world_key` 共享单例 Runtime，杜绝跨世界记忆与执行串扰。
  - 接入 `advance_task` MCP 工具，打通 LLM -> `advance_task` -> `WorldRuntime` -> `Orchestrator.tick()` -> `SkillExecutor` -> `Dispatcher` 完整调度链路。
  - 支持多步骤动作连续预算调度（`budget_used` / `budget_remaining`），返回包含真实快照证据、执行轨迹与生存警报的结构化核验报告。
- **生存紧急仲裁与 Reflex 协作调度**：
  - 在 `lib/planner/task-skill-orchestrator.js` 中完善 P0/P1 生存危机（饥饿、黑夜无光、低血、Reflex 逃脱）仲裁逻辑。
  - 当触发危机时自动挂起（`paused`）当前任务实例，内部调度 `survival_stabilize` 或让位 `lua_reflex`；危机解除后无缝恢复原任务实例与上下文（保持相同的 `instance_id` 与参数，不重复重放动作）。
- **结构识别与 Prefab 规范化**：
  - 新增 `lib/planner/prefab-utils.js`，统一科技建筑与基础容器（`sciencemachine`/`researchlab`、`alchemyengine`/`researchlab2`、`chest`/`treasurechest`）的别名映射与 `matchStructure` 判定，彻底解决逻辑配方名与游戏原生 Prefab 之间的不一致问题。
- **安全食物选择器与熔断机制**：
  - 新增 `lib/skills/food-candidate-selector.js`，严格过滤危险食物并基于新鲜度和饱食度智能排序，增加连续采集/进食失败的熔断器保护，避免陷入无限尝试死循环。
- **运行模式控制与 stop 应急工具**：
  - 实现 Autopilot / Assisted / Manual 三种运行模式，动态过滤 `tools/list` 并通过 `executeTool` 服务端进行严格权限拦截，防止模型绕过看板调用底层原子指令。
  - 新增 `stop` 应急工具，支持最高优先级主动打断当前运行中的任务与底层 Dispatcher 命令。
- **测试与验证**：
  - 新增 4 个核心测试套件（`tests/advance-task-budget.test.mjs`、`tests/emergency-survival-orchestration.test.mjs`、`tests/food-candidate-circuit-breaker.test.mjs`、`tests/prefab-structure-identification.test.mjs`），并全面适配生命周期与调度器断言。
  - 全量自动化测试达到 **986/986 全部通过**（986 pass, 0 fail, 0 skipped）。

---

## [Phase R.6] - 2026-11-19

### 实例身份与生命周期：Task ID 与 Skill Instance ID 分离与真实重试 (Task Identity & Instance Lifecycle)
- **Task ID 与 Skill Instance ID 彻底分离**：
  - `lib/planner/world-memory.js`：将 `skill_instances` 从以 `skill_id` 为键升级为以 `instance_id` 为全局物理唯一键，根节点增加 `active_skill_instance_id`。通过 Proxy 包装层 `wrapSkillInstances` 保持向后兼容老代码对活动实例的直接读取。
  - `lib/skills/skill-executor.js`：`newInstance()` 生成具有唯一性的 `instance_id`，并记录 `task_id`、`skill_id`、`skill_args`、`status`、`step_index`、`step_attempts`、`step_calls`、`created_at`、`updated_at`、`failed_at`、`completed_at`。
  - 同一技能类型的多个不同任务（如 `gather_log`、`gather_rocks`、`gather_goldnugget`）各自绑定独立 `instance_id`，参数相互隔离，彻底根除跨任务串实例、串参数问题。
- **失败重试真实执行**：
  - 任务失败时保留失败原因与历史实例，不再覆盖旧实例。
  - 任务进入看板冷却，冷却期满后 Orchestrator 针对该任务分配全新 `instance_id` 重新调度，保留原 `skill_args`。
  - 重新读取最新快照，真实调用 Dispatcher 下发动作（调用计数 > 0），杜绝直接返回 failed 或重放历史动作。
  - 达到最大尝试次数（`MAX_ATTEMPTS`）后任务正式进入永久 `failed`。
- **调度边界与互斥保障**：
  - 单角色单活动实例互斥：`#pauseOthers()` 保证全系统同一时刻只有一个活动实例控制角色。
  - `run_skill` 支持显式 `task_id`，缺省默认为 `manual:${skillId}`，与自动调度实例彻底隔离。手动操作结束后，自动调度可安全恢复原自动任务。
  - `get_state` 绝对保持只读，不产生任何动作下发副作用。
  - 跨世界实例严格物理隔离，切换世界后绝不恢复其它世界的实例。
- **测试与验证**：
  - 新增 `tests/task-instance-lifecycle.test.mjs`，包含 LIFECYCLE-01 至 LIFECYCLE-16 全部 16 个场景以及 LIFECYCLE-INTEGRATION 三资源连续采集集成验证。
  - 全量自动化测试达到 **959/959 全部通过**（959 pass, 0 fail, 0 skipped）。

---

## [Phase R.4] - 2026-11-19

### 决策收敛：Planner 决策仲裁与 plan.js 纯粹化 (Planner Core Pureification)
- **仲裁梯队明确**：
  - P0/P1 生存绝对抢占，优先使用生存规则引擎保障角色安全。
  - P2/P3 统一驱动 Task Board 阶段任务。
  - P3/P4 负责开局基本生存、存粮与探索兜底。
- **plan.js 纯粹化**：
  - 移除中长期建造与高级装备制造规则，全面移交 Task Board。
  - `get_state` 纯只读渲染单一统一决策计划块。
- **测试与验证**：
  - 新增 `PLAN-R4-1`、`PLAN-R4-2`，全量测试达 943 项全绿。

---

## [Phase R.3] - 2026-11-19

### 记忆规范与自愈：World Memory Schema 统一与版本自愈升级 (World Memory Governance)
- **Schema 统一与校验**：
  - `emptyMemory` 显式补齐所有持久化契约字段：`schema` (`bws.world-memory/1`)、`worldKey`、`camp_site`、`backup_site`、`home_building_id`、`home_anchor`、`current_stage`、`current_goal`、`active_skill_id`、`task_board`、`skill_instances`、`explored_regions`、`known_resources`、`completed_milestones`、`blocked_tasks`、`danger_zones`、`known_buildings`、`recent_failures`、`updatedAt`。
  - 新增 `SUPPORTED_SCHEMAS` 与 `validateMemory(memory)`，提供完整的结构有效性与字段类型校验。
- **平滑升级与数据自愈**：
  - 新增 `migrateMemory(raw, targetSchema)`，平滑支持旧版本与未标记 schema 的旧世界记忆数据升级为 `bws.world-memory/1`（记录 `_migrated_from`）。
  - 对 NaN / 非法浮点数坐标、超出范围的 stage、异常的数组/对象结构进行防御性自愈清洗，杜绝记忆被脏数据破坏或整份丢失。
  - `createWorldMemoryStore#load` 读到旧格式或自愈后自动落盘升级。
- **测试与验证**：
  - 在 `tests/world-memory.test.mjs` 中新增 `WM-11`（校验与迁移自愈）与 `WM-12`（读取旧文件落盘自愈）。
  - 全量回归测试从 939 增至 941 项全绿。

---

## [Phase R.2] - 2026-11-19

### 架构收敛：Task Board 与 Skill Executor 架构收敛 (Orchestrator Convergence)
- **新增模块**：
  - `lib/planner/task-skill-orchestrator.js`：实现 `TaskSkillOrchestrator`，作为 Task Board 与 Skill Executor 的权威调度器。
  - `tests/task-skill-orchestrator.test.mjs`：新增 14 项完整端到端测试，覆盖任务启动、参数传递、实例恢复、防重复、单技能互斥、生存抢占与恢复、完成/失败记录、世界隔离、步骤防重放、`get_state` 纯读与状态一致性。
- **重构与收敛**：
  - 明确四大系统边界：Planner（阶段/目标/策略）、Task Board（任务注册/依赖/优先级/状态/证据）、Skill Executor（实例状态机/步骤原子动作/真实快照核验）、Orchestrator（桥接调度）。
  - 收敛建家任务定义：`lib/skills/establish-home.js` 统一维护 `establishHome` 复合技能，`establish-home-adapter.js` 保留看板任务适配。
  - 收敛资源采集任务定义：`lib/skills/gather-resources.js` 统一维护 `gatherResources` 复合技能，`gather-resources-adapter.js` 保留看板任务适配。
  - 任务数据结构统一：支持 `id`, `title`, `status`, `priority`, `skill_id`, `skill_args`, `depends_on`, `completion_evidence`, `blocked_reason`, `attempts`, `progress`。
  - 实例共享：`run_skill` 与自动调度共享同一个 `SkillExecutor` 实例。
  - 日志规范化：统一三层日志 `[TASK]`, `[ORCHESTRATOR]`, `[SKILL]`。
- **文档更新**：
  - 更新 `docs/ARCHITECTURE.md`、`docs/STATUS.md`、`docs/audit/REFACTOR_ROADMAP.md`（将 ISSUE-01 与 ISSUE-02 标记为已解决）。
- **测试指标**：
  - 全量 939 项单元与集成测试 100% 通过（0 失败、0 跳过）。

---

## [Phase R.1] - 2026-11-19

### 缺陷修复：打通技能参数传递 (Skill Args Passing)
- **修复**：
  - `lib/skills/skill-executor.js` 支持在 `run()` 时传入 `skill_args` 并持久化到 `inst.data.skill_args`。
  - `lib/tools.js` 在 `run_skill` 工具中正式声明 `skill_args` 输入字段并完整透传。
  - `lib/skills/gather-resources.js` 优先使用动态传入的目标物品和配方。
- **测试**：
  - 新增 `GATHER-SKILL-3`, `GATHER-SKILL-4`, `GATHER-SKILL-5` 测试。
