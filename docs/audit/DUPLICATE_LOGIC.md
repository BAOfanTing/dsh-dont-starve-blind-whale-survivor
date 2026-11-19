# 重复逻辑与多源异构审计报告 (Duplicate Logic Analysis)

> 生成时间：2026-11-19
> 审计分支：`stabilize/architecture-baseline`
> 审计目标：深度剖析系统中存在的重复逻辑、平行系统、数据双重维护及职责重叠问题，给出精确的代码证据与收敛策略。

---

## 一、重大重复与平行系统全景

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            核心业务逻辑重复重灾区                           │
├────────────────────────────────┬────────────────────────────────────────────┤
│ 1. 规划决策与主任务产出       │ lib/plan.js  vs  lib/planner/*             │
│ 2. 建家业务模型                │ establish-home.js  vs  establish-home-skill.js │
│ 3. 资源采集与配方缺口计算     │ gather-resources.js vs gather-resources-skill.js vs skill-utils.js │
│ 4. 战斗控制与战术走位          │ actions/combat.lua  vs  battle.lua         │
│ 5. 日常家务与生存管理          │ chores.lua  vs  reflex.lua                 │
│ 6. 配方材料表多处硬编码        │ 6 处独立维护配方清单                       │
│ 7. 物品与背包所有权核算        │ countInInventory  vs  ownedCount           │
└────────────────────────────────┴────────────────────────────────────────────┘
```

---

## 二、详细重复问题剖析

### 1. 规划层双核心并存：`lib/plan.js` vs `lib/planner/*`

- **位置**：
  - `lib/plan.js`: 761 行，定义 `derivePlan`, `GOALS` (含 16 个规则目标), `PLAN_SCHEMA`。
  - `lib/planner/planner-core.js`: 424 行，定义层级阶段 (Stage 0~6)、任务看板 (Task Board)、家园锚点。
  - `lib/planner/decision-arbiter.js`: 185 行，充当仲裁器将两者生硬粘合。
- **实际代码证据**：
  - `lib/plan.js` 内部包含了完整的生存规则与发展科技目标，如 `tool_axe`, `tool_pickaxe`, `craft_backpack_and_armor` (L415-633)。
  - `lib/planner/development-stages.js` 与 `task-board.js` 同样定义了从 Stage 0 (开局求生) 到 Stage 1 (建家) 再到 Stage 2 (科技工具) 的完整推进。
  - `decision-arbiter.js` L106-115 将 `survivalPlan` 与 `devPlan` 进行优先级比较，若发生紧急则直接由 `survivalPlan` 抢占。
- **风险**：
  - 维护两套并行的目标推导系统。新增一个生存目标或阶段任务时，必须同时在 `plan.js` 与 `development-stages.js` 考虑是否冲突。
  - 虽然 Decision Arbiter 实现了唯一输出，但内部本质上仍然是两套规则引擎在同一快照上重复推算。
- **处理建议**：
  - **保留 `plan.js` 中的纯生存即时应急规则**（P0/P1 保命、天黑点火、残血撤退），将其明确降级为 `SurvivalRuleEngine` 兜底子模块。
  - **彻底移除 `plan.js` 中越权的发展阶段目标**（如基础科技工具制作、背包防具制作等），这部分统一交由 `development-stages.js` 和 `task-board.js` 管理。

---

### 2. 建家系统双重实现：`establish-home.js` vs `establish-home-skill.js`

- **位置**：
  - `lib/skills/establish-home.js`: 106 行，通过 `establishHomeTasks()` 生成 Task Board 任务。
  - `lib/skills/establish-home-skill.js`: 156 行，定义复合执行技能 `establishHome` (包含 6 个 Steps)。
- **实际代码证据**：
  - `establish-home.js` 定义了 5 个任务：`choose_camp_site`, `travel_to_camp`, `gatherTasks`, `build_first_structure`, `set_home`。
  - `establish-home-skill.js` 同样定义了 6 个步骤：`survey_and_site`, `travel_to_camp`, `gather_materials`, `build_structure`, `set_home`, `verify_home`。
  - 在 `establish-home.js` 中：
    ```javascript
    // 依赖 task-board 的 evaluateTarget 进行状态检查
    target: { type: 'camp_site' }
    target: { type: 'move_to', x, z, arrival_radius: 2 }
    target: { type: 'structure', prefab: 'sciencemachine', near: { x, z, radius: 8 } }
    ```
  - 在 `establish-home-skill.js` 中：
    ```javascript
    // 独立维护一套 step.isDone(ctx) 进行快照状态检查
    isDone(ctx) { return Boolean(ctx.memory?.camp_site) ... }
    isDone(ctx) { return distTo(ctx.snapshot, camp) <= ARRIVE_RADIUS }
    isDone(ctx) { return hasStructure(ctx.snapshot, 'sciencemachine', ...) }
    ```
- **风险**：
  - **严重职责重叠与状态割裂**：Task Board 保存了一套任务状态（`tasks[i].status`），而 Skill Executor 在 `world_memory.skill_instances.establish_home` 里又保存了一套步骤进度（`inst.step_index`）。
  - 两者的完成条件判定公式略有出入（如到达营地半径判定、建筑识别别名处理），容易出现 Task Board 认为任务未完成，而 Skill Executor 认为步骤已完成的死锁或不同步。
- **处理建议**：
  - 确立统一模型：**Task Board 只保存高层目标（Goal / Task），不保存细粒度原子步骤状态机；Skill Executor 负责驱动完整步骤**。
  - 将 `establish-home.js` 中的静态任务拆解逻辑合并至 `establish-home-skill.js`，对外仅暴露一个高阶任务项绑定对应技能。

---

### 3. 资源收集与配方缺口计算三处重合：`gather-resources.js` vs `gather-resources-skill.js` vs `skill-utils.js`

- **位置**：
  - `lib/skills/gather-resources.js` (63 行)
  - `lib/skills/gather-resources-skill.js` (56 行)
  - `lib/skills/skill-utils.js` (223 行)
- **实际代码证据**：
  - `gather-resources.js` L28 定义 `missingMaterials(snapshot, recipe)`：
    ```javascript
    // 使用 countInInventory 仅统计纯背包内部数量
    const have = countInInventory(snapshot, prefab)
    ```
  - `skill-utils.js` L118 同样定义 `missingMaterials(snapshot, recipe)`：
    ```javascript
    // 使用 ownedCount 统计背包 + 手持 + 身体佩戴
    const have = ownedCount(snapshot, prefab)
    ```
  - `gather-resources.js` L12 定义了 `INGREDIENT_SOURCE`（返回自然语言动作提示），而 `skill-utils.js` L95 定义了 `MATERIAL_SPEC`（返回结构化 `{ tool, args }`）。
  - `gather-resources-skill.js` L17 内部写死：
    ```javascript
    function recipeOf(ctx) {
      const data = ctx.instance?.data ?? {}
      return data.recipe && typeof data.recipe === 'object' ? data.recipe : CORE_RECIPE
    }
    ```
    无法动态消费 Planner 下发的具体材料需求参数。
- **风险**：
  - 如果角色手持火把或斧头，`gather-resources.js` 计算缺口会认为缺 1，而 `skill-utils.js` 认为不缺。
  - 技能参数未打通：`gather_resources` 技能目前只能收集科学机器的材料 (`CORE_RECIPE`)，无法灵活用于造锅、造箱子或造帐篷。
- **处理建议**：
  - 删除 `gather-resources.js` 中的旧实现，统一收敛到 `skill-utils.js`（使用 `ownedCount`）。
  - 在 `gather-resources-skill.js` 中支持完整的 `skill_args` 注入与持久化恢复。

---

### 4. 战斗逻辑割裂：`actions/combat.lua` vs `battle.lua`

- **位置**：
  - `DontStarveWhaleSurvivor/scripts/whale/actions/combat.lua`: 258 行。
  - `DontStarveWhaleSurvivor/scripts/whale/battle.lua`: 785 行。
- **实际代码证据**：
  - `combat.lua` 实现了 `attack_by_ref`，内含武器装备选择、手持照明保护、原生 `BufferedAction` 组装。
  - `battle.lua` 独立实现了一个 13 状态的战术状态机 (`IDLE`, `PREPARE`, `APPROACH`, `LURE`, `WAIT_ATTACK`, `ATTACK`, `RETREAT`, `RESET`, `VERIFY`, `LOOT` 等)，同样包含了武器装备管理与目标有效性复核。
  - `combat.lua` L250 将 `JOBS.fight_spider` 转交由 `battle.StepJob` 调度。
- **风险**：
  - 普通生物（如青蛙、猎犬、蜜蜂）只能走简单的 `attack/kill`（站桩拼血），只有普通蜘蛛走 `fight_spider`（战术风筝）。
  - 两者对死亡掉落物的拾取逻辑割裂：`battle.lua` 自带掉落物拾取，而 `combat.lua` 的 `kill` 不拾取掉落物。
- **处理建议**：
  - 保持 `battle.lua` 为战术风筝权威模块，但将其接口标准化为 Strategy Pattern（策略模式）。
  - 避免在 `combat.lua` 与 `battle.lua` 中维护两套独立的武器装配检测逻辑。

---

### 5. 家务宏成孤岛代码：`chores.lua` vs `reflex.lua`

- **位置**：
  - `DontStarveWhaleSurvivor/scripts/whale/chores.lua`: 297 行。
  - `DontStarveWhaleSurvivor/scripts/whale/reflex.lua`: 1322 行。
- **实际代码证据**：
  - Commit `a0f60f2` 将 Reflex 中的日常家务剥离至 `chores.lua`，并在 `chores.lua` L264-297 注册了 6 个 Action。
  - 但是：上游 Node 端的 `ACTION_SPECS`、`tools.js` 完全没有这 6 个动作的定义，`planner` 也没有对它们发起调度的逻辑。
- **风险**：
  - 297 行的日常生活管理逻辑（自动添柴、安全搜食、采花补理智、收纳火把）在实际运行中**从未被调用**。
- **处理建议**：
  - 评估是作为高层复合技能（由 Node Skill Executor 调度原子动作替代），还是接入 Dispatcher 白名单。
  - 若 Node 端技能层（如 `survival_stabilize`）已能通过原子动作组合实现同样功能，应清理 `chores.lua` 中冗余的未接管代码。

---

### 6. 配方材料表多处硬编码

- **现状证据**：
  1. `lib/plan.js`: `TORCH_RECIPE`, `FIREPIT_RECIPE`, `TOOL_RECIPES`, `SCIENCE_MACHINE_RECIPE`, `BACKPACK_RECIPE`, `ARMORWOOD_RECIPE`, `SPEAR_RECIPE`
  2. `lib/planner/planner-core.js`: `BUILD_RECIPES` (campfire, firepit, chest, cookpot, sciencemachine, researchlab2, tent)
  3. `lib/skills/establish-home.js`: `CORE_RECIPE`
  4. `lib/skills/skill-utils.js`: `CRAFTED_DEPS`
  5. `lib/actions/specs/crafting.js`: `BUILDABLE_RECIPES`, `CRAFTABLE_RECIPES`
  6. `DontStarveWhaleSurvivor/scripts/whale/craftrules.lua`: `C.RECIPES`
- **风险**：
  - 任何配方调整（如营火材料、帐篷材料）必须在 6 个文件同时修改，极易导致前端提示与后端拦截不一致。
- **处理建议**：
  - Node 端建立唯一权威的只读配方字典模块 `lib/actions/recipes.js`，所有规划层与技能层统一从该文件 import。
  - 依靠 `tests/recipe-parity.test.mjs` 确保该字典与 Lua 模组原版配方保持 100% 同步。
