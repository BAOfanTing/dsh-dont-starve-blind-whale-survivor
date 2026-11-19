# 架构重构路线图与目标架构草案 (Refactor Roadmap & Target Architecture)

> 生成时间：2026-11-19
> 审计分支：`stabilize/architecture-baseline`
> 治理目标：从无序功能堆叠收敛为边界清晰、职责唯一、单执行出口、高可靠测试的架构基线。

---

## 一、问题清单与治理矩阵

| 序号 | 核心问题 | 涉及文件 | 严重等级 | 治理策略 | 迁移影响 |
|---|---|---|---|---|---|
| **ISSUE-01** | **技能参数传递断裂**：`SkillExecutor` 与 `run_skill` 无法接收 `skill_args`，`gather_resources` 强依赖默认 `CORE_RECIPE` | `lib/tools.js`, `lib/skills/skill-executor.js`, `lib/skills/gather-resources-skill.js` | **P0 (关键执行断链)** | 在 `run_skill`、`SkillExecutor.run(skillId, args)` 中打通参数，持久化保存至 `inst.data`，恢复时保留 | 低，全向后兼容 |
| **ISSUE-02** | **技能与任务定义双重冗余**：`establish-home.js` 与 `establish-home-skill.js`、`gather-resources.js` 与 `gather-resources-skill.js` 重复维护业务模型 | `lib/skills/establish-home.js`, `lib/skills/gather-resources.js`, `lib/planner/planner-core.js` | **P1 (核心架构冗余)** | 将静态任务生成职责完全收敛入 `TaskBoard` / `Skill` 内部，对外只保留单一任务-技能绑定，消除重复文件 | 中，需同步调整测试 |
| **ISSUE-03** | **世界记忆结构不完整**：`emptyMemory` 缺少 `skill_instances`、`explored_regions`、`known_resources` 声明 | `lib/planner/world-memory.js` | **P1 (持久化契约不全)** | 在 `world-memory.js` 中规范化内存字段与 schema 校验 | 低，纯增量补齐 |
| **ISSUE-04** | **规划层职责重叠**：旧版 `plan.js` 仍包含基础工具与背包防具规划，与层级任务看板重合 | `lib/plan.js`, `lib/planner/development-stages.js`, `lib/planner/decision-arbiter.js` | **P2 (规则冗余)** | 收缩 `plan.js` 仅保留 P0/P1 生存应急规则，发展类科技完全移交 `TaskBoard` | 中，需保障兼容性 |
| **ISSUE-05** | **Lua 家务宏孤岛代码**：`chores.lua` 注册了 6 个动作但无任何上游调用链 | `DontStarveWhaleSurvivor/scripts/whale/chores.lua` | **P2 (孤岛死代码)** | 评估接入规范或标记为 Internal，避免未经验证的代码累积 | 低 |
| **ISSUE-06** | **配方表 6 处硬编码维护**：材料数量分散在多个脚本 | `lib/plan.js`, `lib/planner/planner-core.js`, `lib/skills/*`, `lib/actions/specs/crafting.js` | **P2 (数据漂移风险)** | 提取统一只读配方模块 `lib/actions/recipes.js`，配方一致性测试统一盯防 | 低 |
| **ISSUE-07** | **文档严重滞后与数据冲突**：README 漏写工具数与 run_skill，ARCHITECTURE.md 缺少层级规划与技能层 | `README.md`, `docs/ARCHITECTURE.md`, `docs/STATUS.md` | **P1 (治理可信度)** | 更新所有文档，使工具数统一为 42、测试统一为 918、更新架构说明 | 无代码破坏 |

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

### 阶段 R.2：收敛任务生成器与技能的重复实现
- **目标**：彻底消除 `establish-home.js` 与 `gather-resources.js` 的双重维护（`ISSUE-02`）。
- **行动**：
  1. 将 `establishHomeTasks` 生成的高阶任务与 `establish-home-skill` 深度绑定。
  2. Task Board 只记录 1 个复合建家任务项，内部进度直接由 `SkillExecutor` 驱动。
  3. 标记或清理旧文件，更新所有引用。

### 阶段 R.3：统一世界记忆数据规范
- **目标**：完善 `world-memory.js` 的持久化字段（`ISSUE-03`）。
- **行动**：
  1. 补齐 `emptyMemory` 中的 `skill_instances`、`explored_regions`、`known_resources` 默认字段。
  2. 在记忆加载与重置时加入版本自愈。

### 阶段 R.4：文档基准完全对齐
- **目标**：消除所有文档间的版本、工具数、测试数冲突（`ISSUE-07`）。
- **行动**：
  1. 更新 `README.md`，写明 42 个工具并加入 `run_skill` 用法。
  2. 更新 `docs/STATUS.md`，将测试基准校准为 918+，消除内部矛盾。
  3. 将 `docs/ARCHITECTURE_ANALYSIS.md` 归档。
