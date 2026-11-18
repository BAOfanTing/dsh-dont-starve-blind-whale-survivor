# 大肥鱼饿不死：架构审计与层级规划设计（Phase A）

> 本文基于对**当前 main 分支真实代码**的逐文件阅读（2026-11-18，commit `5a7cd28`），
> 不以旧文档为事实来源。凡"文档说 X、代码是 Y"的地方都点出漂移。
>
> 审计范围：`lib/**`、`DontStarveWhaleSurvivor/scripts/whale/**`、`tests/**`、`docs/STATUS.md`、`docs/ARCHITECTURE.md`。

---

## 一、当前架构：真实状态

### 1.1 分层与职责（已核对代码）

| 层 | 文件 | 实际职责 |
|---|---|---|
| 观察（Lua） | `observe.lua` / `nearby.lua` | 把世界翻成 `data{actor,player,world,identity,nearby,danger_zones}`，写 `whale_state.json`（约 1 秒） |
| 执行（Lua） | `bridge.lua` / `guard.lua` / `actions.lua` / `actions/*.lua` | 读命令、第二道闸复检、`BufferedAction + push()` 执行、写结果 |
| 保命（Lua） | `reflex.lua` | **仅 P0/P1**：逃跑 / 入夜无光 / 濒死进食回血 / 越温。家务已剥离，不做长线规划 |
| 归一化（Node） | `state/snapshot.js` | 唯一解析 `whale_state.json` 的地方；F8 / MCP / HUD / 测试共用 |
| 动作规格（Node） | `actions/specs/*.js` | 每个动作声明参数白名单 + `verify()`（前后快照核对） |
| 唯一出口（Node） | `dispatcher.js` | 白名单 → 验参 → 快照/租约 → 下发 → 等结果 → 核对 |
| 控制权（Node） | `control.js` | Control Lease，跨进程互斥、两阶段换手 |
| 规划（Node） | `plan.js` | **纯函数**：快照 → 单一目标 + 原因 + 下一步（优先级列表） |
| 工具（Node） | `tools.js` | `TOOLS` = 3 本地 + 全部动作；`executeTool` 分发 |
| 入口（Node） | `index.js` / `agent.js` / `mcp-server.js` | F8 内置 AI 与 MCP 共用 `executeTool` + `TOOLS` + 同一份 plan |

### 1.2 原子动作清单（以 `ACTION_SPECS` 为准，共 38 个）

- **移动**（`movement.js`）：`move_to` `stop` `seek`
- **采集/劳作**（`gathering.js`）：`pickup_nearest` `pickup_food` `harvest_nearest` `chop_nearest` `mine_nearest` `pickup` `harvest` `gather` `chop` `mine` `dig` `hammer` `gather_area`
- **制作/建造**（`crafting.js`）：`build` `cook` `craft`
- **生存**（`survival.js`）：`eat` `equip` `unequip` `drop` `fuel` `wait` `sleep`
- **交互**（`interaction.js`）：`use` `container_take` `container_put` `give`
- **战斗**（`combat.js`）：`attack` `kill` `fight_spider`
- **查询**（`info.js`）：`recipes` `lookup` `probe` `inspect`
- **社交**（`social.js`）：`say`

> ⚠ **文档漂移**：`docs/STATUS.md` §2.1 写"40 个 = 3 本地 + 37 动作"，`docs/ARCHITECTURE.md` §7 写"39 个 = 3 + 36"。
> 实际 `ACTION_SPECS` 是 **38 个动作**（新增了 `fight_spider`），本地工具 3 个 → **共 41 个工具**。
> 这是"文档滞后于代码"的典型，本次随 Phase E 一并校正（见 §六）。

### 1.3 逐条回答任务书的 10 个问题

**Q1 当前有哪些原子动作？** —— 见 §1.2，38 个。全部经 `dispatcher.js` 唯一出口，Lua `guard.lua` 二次复检。

**Q2 哪些动作已经模块化？**
- 观察/执行/保命的**边界**是清晰的（Lua 观察 + 执行；Node 只规划与授权）。
- 动作规格按领域拆成 `actions/specs/*.js`，参数/核对自包含（真正模块化）。
- 但**"做事的过程"没有模块化**：采一组材料→做木板→造炼金引擎这种多步流程，完全是模型每轮用提示词临时拼的（见 Q3/Q4）。

**Q3 哪些功能只是模型通过提示词临时组合的？**
- `build sciencemachine` / `craft boards → cutstone → transistor → build researchlab2` 整条科技链，`tools.js` 的 `RULES` 与各工具描述用大段文字教模型按顺序做——**没有任何代码替它记住"做到第几步、还差什么、下一步是什么"**。
- `plan.js` 的 `craft_backpack_and_armor`（L415-633）把"先背包→再木甲→再长矛"的顺序写死在一个 `next()` 闭包里，模型读一句话后仍要靠自己串。
- 探索（`explore`/`seek`）没有任何目的地与预算，模型"朝没走过的方向走 10~20 格"。

**Q4 当前 plan 如何选择目标？** —— `plan.js` 的 `GOALS` 是**一维优先级列表**：每轮 `GOALS.filter(when(snapshot))` → 按 `priority` 排序 → 取最高；若上一轮目标仍成立且无更高优先级则保持（`derivePlan` L675-724）。**没有阶段、没有依赖、没有任务态**。优先级是写死的数字/函数。

**Q5 任务完成后如何记录？** —— **不记录**。`derivePlan` 是纯函数，完成与否只取决于**当前快照字段**（手上有火把、饥饿回到线）。没有任何持久化"已完成里程碑"。进程重启或换调用方（F8↔MCP），除了内存里的 `sharedPlan`，什么都不留。

**Q6 任务失败后是否会重复执行？** —— **会**。`plan.js` 的 `next()` 每次根据当前状态给同一句建议；只要 `when()` 仍成立，就反复给同一个 `next`（例如反复 `seek flint`）。`agent.js` 的 `isFailureText` 只负责"停掉同批后续动作 + 下轮重新观察"（L46-50、L449-454），**没有重试上限、没有冷却、没有换方案**。

**Q7 当前是否存在任务依赖系统？** —— **不存在**。依赖是隐式写进 `when()` 的前置判断（例如 `tool_axe` 的 `when` 要求"附近有树"），不是显式 DAG，无法阻止"材料齐了就跳步建造"。

**Q8 当前是否存在家园和建筑记忆？** —— **不存在**。`plan.js` L534-540 的 `build_science_machine` 目标：**只要材料齐 + 附近没有科学机器，就 `build` 在脚下**——这正是任务书点名禁止的行为。没有任何 `camp_site` / `home_building_id` 记忆；笔记（`notes-store.js`）只存自由文本，不结构化，也不参与规划判定。

**Q9 F8 内置 AI 与 DSH 是否共享执行规则？** —— **是（这一点做得好，不要动）**。二者都经 `executeTool → dispatcher`（`index.js` `runTool`），共享 `TOOLS`/`ACTION_SPECS`/`control` 租约/`readSnapshot`。F8 只多一层"先抢租约"。

**Q10 当前观察数据能否支持安全的基地选址？** —— **部分能，但不够做"图选址"**。
- 有：`actor.tileX/tileZ`、`nearby.buckets`（9 桶，含 resources/food/structures/threats，带 `position{x,z}` 与 `distance`，16 格内）、`danger_zones`、`world.{day,phase,season}`、`identity.world_key`。
- 缺：**已探索地图栅格**、`query_map` 类接口、建筑 GUID/`places` 注册表、跨水连通性。`#N` 与 `handle` 都**不暴露 GUID**。
- 结论：**可以做"基于已观察附近"的候选点评分与可达性近似，但不能假装有全图最佳选址**。选址不足时必须先探索（有预算），且必须诚实标注信息不足。

---

## 二、当前 `plan.js` 的具体问题（对照任务书"不能再出现"清单）

| 任务书痛点 | 代码根因 |
|---|---|
| 整天只在出生点附近捡东西 | `plan.js` 的 `stock_food`/`explore` 只在 16 格 `nearby` 内循环；`explore` 的 next 是"朝没走过的方向走 10~20 格"，无目的、无预算、无记忆 |
| 只知道砍树挖矿，不知道为什么 | `mine_rock`/`chop_wood` 的 `why` 只有"造科学机器还差…"；采集与长期目标无依赖绑定 |
| **材料齐全就地建科学机器** | `build_science_machine`（L534-540）`when = 材料齐 && 附近没机器` → `build` 在脚下。**必须移除** |
| 没有明确家园位置 | 无 `camp_site`/`home` 概念 |
| 做完一个不知道下一步 | 无任务态；`next` 只是单步建议 |
| 任务互相打断、顺序混乱 | 一维优先级，无依赖 DAG、无抢占分级 |
| 失败后重复相同动作 | 无 attempts/cooldown/换方案 |
| 每轮重新规划、长期目标丢失 | `derivePlan` 纯函数 + 仅内存 `prev`；重启即丢 |
| 探索没有目的 | `explore`/`seek` 无目的地、无预算 |
| 资源被次要动作消耗 | 只有 `prep_light` 保护火把材料（`protectedMaterials` L382-396），其余无保留策略 |

---

## 三、目标架构（三层时间尺度）

```
         ┌──────────────────────── Node（想 / 规划 / 授权）────────────────────────┐
长期      │  development-stages.js   阶段 0..6 的完成条件（只看快照+记忆证据）          │
          │        │ 完成则推进；未完成则本阶段目标持续存在（锁存，不每轮重推）            │
          ├────────┼───────────────────────────────────────────────────────────────┤
中期      │  task-board.js  任务看板：id/state/priority/depends_on/attempts/cooldown │
          │        │        progress-tracker(证据核对)  →  只有"有证据"才算 done     │
          │        │  skill（establish-home / gather-resources…）把阶段目标展开成任务   │
          │        │  survival-priority.js：P0..P4，紧急事件可暂停普通任务，不改长期目标 │
          ├────────┼───────────────────────────────────────────────────────────────┤
短期      │  plan.js 的 GOALS（生存优先级：复活/脱战/光照/进食/补理智/备光/工具…）  │
          │        │  → 具体原子动作（pickup_nearest / move_to / build / craft …）     │
          └────────┴───────────────────────────────────────────────────────────────┘
                                     │ 全部经 dispatcher → control lease → Lua guard
                                     ▼
         ┌──────────────────────── Lua（看 / 做 / 核对）─────────────────────────┐
          │ observe + nearby（16 格） · guard · actions · reflex(P0/P1)          │
          └──────────────────────────────────────────────────────────────────────┘
```

**硬边界（不得破坏）**：
1. 动作只有 `dispatcher` 一个出口；技能**只组合**已有原子动作，不新建执行通道。
2. 保命 `reflex.lua` 保留，是 P0/P1；规划层的抢占规则与它对齐，不复活"第二套自主循环"。
3. 观察数据不足时**必须承认不足**并安排探索，不能凭空猜坐标/建筑。
4. 记忆按 `world_key` 隔离；换世界绝不继承旧 `home`/`camp_site`。
5. 完成必须有**真实证据**（背包数、附近建筑实体、锚点范围），绝不因"材料减少"或"模型说做完了"算成功。

---

## 四、模块边界（新增，按现有架构落地，不造空壳）

| 文件 | 职责 | 关键约束 |
|---|---|---|
| `lib/planner/world-memory.js` | 按 `world_key` 持久化：`camp_site`/`backup_site`/`home_building_id`/`current_stage`/`known_buildings`/`danger_zones`/`completed_milestones`/`recent_failures`/`task_board` | 复用 `sanitizeWorldKey`；`world_key` 缺失→暂存但不冒认当前世界 |
| `lib/planner/task-board.js` | 任务状态机（pending/ready/in_progress/done/blocked/failed/cancelled/scheduled）、依赖 DAG、attempts+cooldown、合并保活、上限 | 完成需 evaluator 证据；失败记录原因/次数/重试条件；不无限重试 |
| `lib/planner/base-site-planner.js` | 多指标候选点评分（地形安全/资源/食物/空间/交通/危险惩罚/连通近似），选 primary+backup+理由 | 只用已观察数据；信息不足→`sufficient_info=false` 并要求探索；不选危险区；不把未探索当安全 |
| `lib/planner/development-stages.js` | 阶段 0..6 定义 + 完成条件（快照+记忆） | 完成才推进；已完成不重开 |
| `lib/planner/survival-priority.js` | 快照 → P0..P4 + 是否可推进普通任务 | 紧急可暂停普通任务，但不丢长期目标 |
| `lib/skills/establish-home.js` | 把"建立家园"展开为：探索→选址→前往→验证→补料→建核心建筑→设家 | 只产出任务，不直接下动作 |
| `lib/skills/gather-resources.js` | 按配方缺料展开采集任务，带搜索预算 | 复用 craftrules 配方，不复制静态材料表 |
| `lib/planner/planner-core.js` | 编排：读记忆→定阶段→刷看板→评估→给出"当前阶段/任务/下一步"，并持久化 | 纯函数为主，副作用仅写记忆 |

> 说明：`task-dependencies`/`progress-tracker`/`navigation-intents` 不单独开文件——依赖与进度证据就是 `task-board.js` 的职责，导航意图并入 `base-site-planner`/skill，避免空模块（任务书允许"按现有架构调整"）。

### 4.1 家园系统（最高优先）

- **`camp_site` ≠ `home`**：`camp_site` 是选址坐标（规划信息）；`home` 必须绑定**真实存在、已验证的建筑锚点**。
- **首个科学机器无锚点**：先选址 → `move_to` 前往 → 到场复验地形/危险 → `build sciencemachine` → 用**建造后快照里该建筑的坐标**记录稳定 `anchor_id`（形如 `building:researchlab@x,z`，不暴露 GUID）→ 写 `home_building_id`。
- **后续基地建筑**：必须带 `target.placement={anchor_id, radius}`，在锚点半径内建造；远处同类建筑**不算**完成。
- **强制门槛（Node 工具层）**：`executeTool('build', …)` 在 `ctx.planner` 存在时——
  - 无 `home` 且不是"首个科学机器/营火"的基地结构 → 拒绝并提示"先建立家园"；
  - 首个科学机器：要求已选 `camp_site` 且角色已在 camp 附近（否则拒绝"先选址并前往"）；
  - 已有 `home`：基地结构必须落在 `home` 锚点 `radius` 内，否则拒绝"回营地/在范围内建造"。
  这直接堵死"材料齐就地造机器"，且不碰 Lua。

### 4.2 为什么不做"图选址"

参考项目 `DST-Hierarchical-Agent` 有 `query_map`（导出 PNG 栅格）与 `query_places`（建筑注册表），依赖 Lua 导出已观察地图栅格 + GUID。
本项目当前 Lua **不导出地图栅格，也不暴露 GUID**。本阶段**不新增**这套 Lua（工作量大且需真机验证），而是：
- 用 `nearby`（16 格）+ `danger_zones` + `actor` 位置做**局部候选点评分**；
- 信息不足就明确 `sufficient_info=false`，安排**带预算的探索任务**（`explore_region`）；
- `anchor_id` 用"建造后观测到的建筑坐标"做稳定 ID（可核对、可复现），不伪造 GUID。
这是对参考项目 placement 设计的**适配**，不是照搬。

---

## 五、与 Reflex 的抢占规则

| 级别 | 含义 | 谁执行 | 规则 |
|---|---|---|---|
| P0 | 真实生命危险（被攻击/残血/黑夜无光） | `reflex.lua` | 可打断任何普通任务；技能被中断需存进度，恢复前重新观察 |
| P1 | 紧急生存（临界饥饿/低血/越温） | `reflex.lua` + plan 高层需求 | 可暂停普通任务 |
| P2 | 当前重点长期任务（建家/科技） | 规划层任务 | 生存 P0/P1 出现时让位，恢复后继续 |
| P3 | 普通资源工作 | 规划层任务 | 可被 P2 抢占 |
| P4 | 低优先探索/可选 | 规划层 | 空闲时做，有预算 |

- 规划层**只决定"现在该做哪件（阶段/任务/原子动作建议）"**，真正动手仍经 dispatcher；不新建抢占通道。
- 被 Reflex 打断的任务在 `task-board` 标 `in_progress`+保留进度，Reflex 结束后重新评估。

---

## 六、分阶段实施计划（本次交付范围）

| Phase | 内容 | 本次状态 |
|---|---|---|
| A | 本文（真实审查 + 设计） | ✅ 完成 |
| B | `task-board.js`：状态机/依赖/证据/重试冷却/合并/持久化 | ✅ 实现 + 测试 |
| C | `base-site-planner.js` + `world-memory.js` + 家园门槛（禁"就地建机"） | ✅ 实现 + 测试 |
| D | `skills/establish-home.js`、`skills/gather-resources.js` | ✅ 基础实现 + 测试 |
| E | `development-stages.js` + `survival-priority.js` + `planner-core.js` 接入 `get_state` | ✅ 基础实现 + 测试；文档校正（工具数 41） |
| F | 真机验收（全新世界活过首夜→选址→建家→科技→第 3/5/10 天） | ⏳ **需用户在游戏内执行**（不得用模拟冒充） |

**本次不做**（避免一次性重写、避免空壳）：
- Lua 侧地图栅格导出 / `query_map` PNG / GUID 级 `places` 注册表（需真机+大改，留待后续）。
- 新增 MCP 工具（`return_home` 等以规划层"建议 `move_to` 坐标"实现，不膨胀工具表）。

---

## 七、测试策略（不只单测）

- **任务规划**：新世界→Stage0；稳定→启动选址；无 home 必须建家；不能绕过选址直接建科技；选址出移动任务；未到场不建；建成才 set_home；换世界不继承；已完成不重复。
- **技能**：establish_home 全流程；缺料触发采集；目标消失重搜；导航失败切备用；预算到点结束；完成条件不满足不报成功。
- **家园**：不选危险区；信息不足要探索；建筑必须真实存在；后续建筑须在锚点半径；返回需真实坐标。
- **长期**：模拟第 1/3/5/10 天规划态（食物/照明/家园/科技/装备/任务积压/返家）。
- 全部为 Node 侧 UNIT/INTEGRATION（假 bridge + 真实现）。**真机验收见 Phase F，由用户完成。**
