# 变更日志 (Changelog)

所有关键架构演进与版本改动均记录于此。

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
