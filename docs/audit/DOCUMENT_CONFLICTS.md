# 项目文档冲突与滞后审计报告 (Document Conflicts Audit)

> 生成时间：2026-11-19
> 审计分支：`stabilize/architecture-baseline`
> 审计文档：`README.md`, `docs/ARCHITECTURE.md`, `docs/STATUS.md`, `docs/ARCHITECTURE_ANALYSIS.md`, `docs/reference/*`

---

## 一、核心文档状态差异全景对照表

| 审计维度 | 实际代码真实基线 (Ground Truth) | `README.md` (面向使用者) | `docs/ARCHITECTURE.md` (架构说明) | `docs/STATUS.md` (开发状态) | `docs/ARCHITECTURE_ANALYSIS.md` (历史审计报告) |
|---|---|---|---|---|---|
| **插件版本 (Node)** | **0.12.0** (`package.json`) | 未声明 | **0.10.0** (严重滞后) | **0.12.0** (一致) | 0.10.0 |
| **模组版本 (Lua)** | **0.41.0** (`modinfo.lua`) | 未明确注明版本 | **0.39.0** (严重滞后) | **0.41.0** (一致) | 0.39.0 |
| **测试总用例数** | **918 pass / 0 fail** | 未记录 | 未记录 | 871 → 892 (前言) / **914** (§7.0) (内部不一致) | 722 / 730 |
| **模型可用工具数** | **42 个** (38 动作 + 4 本地) | **41 个** (38 动作 + 3 本地) | **39 个** (36 动作 + 3 本地) | **42 个** (38 动作 + 4 本地) | 41 个 |
| **本地工具清单** | `get_state`, `get_guide`, `update_notes`, **`run_skill`** | 仅列 3 个 (漏 `run_skill`) | 仅列 3 个 (漏 `run_skill`) | 列全 4 个 | 仅列 3 个 |
| **规划层架构描述** | **层级规划 + 决策仲裁 + 复合技能执行器** | 仅提及层级规划文本，未提及技能执行 | **完全无层级规划** (仍停留在旧单层 `plan.js`) | 详尽记录 Phase G 仲裁与技能执行器 | 提出 Phase A 设计设想 |
| **技能执行器机制** | 真实存在 (`lib/skills/skill-executor.js`) | 完全未提及 | 完全未提及 | 记录在 §7 | 设想草案 |

---

## 二、重大矛盾与冲突剖析

### 1. `docs/ARCHITECTURE.md` 严重滞后于代码事实

- **冲突证据**：
  - `docs/ARCHITECTURE.md` L6 声明：“对应代码：`DontStarveWhaleSurvivor/`（Lua 模组，0.39.0）+ `lib/`（DSH 插件，0.10.0）”。
  - 核心架构图与分层描述中，完全没有包含：
    - `lib/planner/planner-core.js`
    - `lib/planner/decision-arbiter.js`
    - `lib/planner/task-board.js`
    - `lib/planner/development-stages.js`
    - `lib/planner/base-site-planner.js`
    - `lib/planner/survival-priority.js`
    - `lib/planner/world-memory.js`
    - `lib/skills/skill-executor.js`
    - `lib/skills/skill-registry.js`
  - 架构图只画了 `tools.js` 直接通过 `plan.js` 推导计划。
- **影响**：
  - 作为宣称“当前有效架构”的唯一文档，它实际上落后了两个完整的大版本（缺少层级规划与技能执行器）。开发者对照该文档无法理解系统的实际运行流程。

---

### 2. 工具数量在四份文档中各执一词 (39 vs 41 vs 42)

- **冲突证据**：
  - `docs/ARCHITECTURE.md`: “39 个 = 3 本地 + 36 动作”。
  - `README.md`: “38 个动作 + 3 个本地工具（共 41 个工具）”。
  - `docs/ARCHITECTURE_ANALYSIS.md`: “实际 ACTION_SPECS 是 38 个动作，本地工具 3 个 → 共 41 个工具”。
  - `docs/STATUS.md`: “42 个 = 4 本地 + 38 动作”。
- **真实代码核对**：
  - `lib/actions/specs/index.js`: 38 个原子动作。
  - `lib/tools.js`: 包含 38 个动作工具 + 4 个本地工具（`get_state`, `get_guide`, `update_notes`, `run_skill`）。
  - `tests/tool-parity.test.mjs` L91:
    ```javascript
    assert.deepEqual([...LOCAL_NAMES].sort(), ['get_guide', 'get_state', 'run_skill', 'update_notes'])
    ```
- **影响**：
  - 使用者在阅读 README 时不知道系统已经提供了 `run_skill` 复合技能执行入口。

---

### 3. `docs/STATUS.md` 内部测试数据不一致 (892 vs 914 vs 918)

- **冲突证据**：
  - `docs/STATUS.md` L3 前言导读：“测试 871 → 892 全绿”。
  - `docs/STATUS.md` L97：“测试从 799 → 824”。
  - `docs/STATUS.md` L270：“全量测试 914/914 通过”。
  - 当前实际运行 `npm test`：“**pass 918 / fail 0 / skipped 0**”。
- **影响**：
  - 前后章节由不同开发阶段追加编写，未做全文统筹校正，破坏了 STATUS 报告的权威性。

---

### 4. 历史分析文档未归档，造成理解混淆

- **冲突证据**：
  - 根目录下存在 `docs/ARCHITECTURE_ANALYSIS.md`，其标题为“架构审计与层级规划设计（Phase A）”。
  - 该文档是 2026-11-18 的阶段性提案，其中多处描述（如“没有家园记忆”、“没有任务依赖系统”）在 Phase G 完成后已经成为过时历史。
- **处理建议**：
  - 将 `docs/ARCHITECTURE_ANALYSIS.md` 移动至 `docs/archive/` 或在文件头部醒目标注历史归档标记。

---

## 三、文档治理行动清单

1. **更新 `README.md`**：修正工具数量为 42 个（4 本地 + 38 动作），补充 `run_skill` 使用说明。
2. **重构 `docs/ARCHITECTURE.md`**：将层级规划层（Planner Core / Task Board / Decision Arbiter）与技能执行层（Skill Executor / Registry）正式补充进权威架构图。
3. **校准 `docs/STATUS.md`**：更新前言版本号为 0.12.0 / 0.41.0，更新全量测试通过数为 918 例。
4. **归档历史报告**：将 `docs/ARCHITECTURE_ANALYSIS.md` 归档。
