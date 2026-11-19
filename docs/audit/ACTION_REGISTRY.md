# 动作系统全量注册与一致性审计报告 (Action Registry & Parity Audit)

> 生成时间：2026-11-19
> 审计分支：`stabilize/architecture-baseline`
> 权威定义基线：Node.js `lib/actions/specs/index.js` (`ACTION_SPECS`) 与 Lua `DontStarveWhaleSurvivor/scripts/whale/guard.lua` (`G.ACTIONS`)

---

## 一、动作系统全景总表

当前系统共定义了 **38 个原子动作** 与 **4 个本地宿主工具**（共计 42 个可用工具），以及 **17 个 Lua 内部/旧版未暴露动作**。

### 1. 模型可见动作与工具状态矩阵 (42 项)

| # | 动作名称 (Action) | Node Spec | Tool 注册 | Dispatcher 白名单 | Lua Guard 校验 | Lua 执行实现 | 单元/合约测试 | 状态 (Status) |
|---|-------------------|-----------|-----------|-------------------|----------------|--------------|---------------|---------------|
| 1 | `move_to` | `movement.js` | `tools.js` (L163) | 包含 | `guard.lua` (L124) | `movement.lua` (L19) | `actions-movement.test.mjs` | **active** |
| 2 | `stop` | `movement.js` | `tools.js` (L176) | 包含 | `guard.lua` (L133) | `movement.lua` (L363) | `actions-movement.test.mjs` | **active** |
| 3 | `seek` | `movement.js` | `tools.js` (L726) | 包含 | `guard.lua` (L272) | `movement.lua` (L267) | `actions-movement.test.mjs` | **active** |
| 4 | `pickup_nearest` | `gathering.js` | `tools.js` (L185) | 包含 | `guard.lua` (L170) | `gathering.lua` (L1220) | `target-nearest.test.mjs` | **active** |
| 5 | `pickup_food` | `gathering.js` | `tools.js` (L209) | 包含 | `guard.lua` (L178) | `gathering.lua` (L1228) | `food-expansion.test.mjs` | **active** |
| 6 | `harvest_nearest` | `gathering.js` | `tools.js` (L232) | 包含 | `guard.lua` (L187) | `gathering.lua` (L1236) | `target-nearest.test.mjs` | **active** |
| 7 | `chop_nearest` | `gathering.js` | `tools.js` (L255) | 包含 | `guard.lua` (L195) | `gathering.lua` (L1244) | `target-nearest.test.mjs` | **active** |
| 8 | `mine_nearest` | `gathering.js` | `tools.js` (L272) | 包含 | `guard.lua` (L203) | `gathering.lua` (L1252) | `target-nearest.test.mjs` | **active** |
| 9 | `pickup` | `gathering.js` | `tools.js` (L293) | 包含 | `guard.lua` (L139) | `gathering.lua` (L396) | `pickup.test.mjs` | **active** |
| 10 | `harvest` | `gathering.js` | `tools.js` (L320) | 包含 | `guard.lua` (L153) | `gathering.lua` (L1153) | `harvest.test.mjs` | **active** |
| 11 | `gather` | `gathering.js` | `tools.js` (L349) | 包含 | `guard.lua` (L213) | `gathering.lua` (L517) | `actions-gathering.test.mjs` | **active** |
| 12 | `gather_area` | `gathering.js` | `tools.js` (L707) | 包含 | `guard.lua` (L262) | `gathering.lua` (L586) | `actions-gathering.test.mjs` | **active** |
| 13 | `chop` | `gathering.js` | `tools.js` (L374) | 包含 | `guard.lua` (L284) | `gathering.lua` (L1146) | `chop-chain.test.mjs` | **active** |
| 14 | `mine` | `gathering.js` | `tools.js` (L389) | 包含 | `guard.lua` (L296) | `gathering.lua` (L1147) | `actions-gathering.test.mjs` | **active** |
| 15 | `dig` | `gathering.js` | `tools.js` (L403) | 包含 | `guard.lua` (L308) | `gathering.lua` (L1148) | `actions-gathering.test.mjs` | **active** |
| 16 | `hammer` | `gathering.js` | `tools.js` (L415) | 包含 | `guard.lua` (L320) | `gathering.lua` (L1149) | `actions-gathering.test.mjs` | **active** |
| 17 | `craft` | `crafting.js` | `tools.js` (L766) | 包含 | `guard.lua` (L234) | `crafting.lua` (L280) | `actions-crafting.test.mjs` | **active** |
| 18 | `build` | `crafting.js` | `tools.js` (L640) | 包含 | `guard.lua` (L493) | `crafting.lua` (L273) | `science-chain.test.mjs` | **active** |
| 19 | `cook` | `crafting.js` | `tools.js` (L623) | 包含 | `guard.lua` (L479) | `crafting.lua` (L463) | `actions-crafting.test.mjs` | **active** |
| 20 | `eat` | `survival.js` | `tools.js` (L744) | 包含 | `guard.lua` (L226) | `survival.lua` (L149) | `actions-survival.test.mjs` | **active** |
| 21 | `equip` | `survival.js` | `tools.js` (L797) | 包含 | `guard.lua` (L242) | `survival.lua` (L236) | `actions-survival.test.mjs` | **active** |
| 22 | `unequip` | `survival.js` | `tools.js` (L507) | 包含 | `guard.lua` (L386) | `survival.lua` (L119) | `actions-survival.test.mjs` | **active** |
| 23 | `drop` | `survival.js` | `tools.js` (L496) | 包含 | `guard.lua` (L378) | `survival.lua` (L128) | `actions-survival.test.mjs` | **active** |
| 24 | `fuel` | `survival.js` | `tools.js` (L528) | 包含 | `guard.lua` (L400) | `survival.lua` (L292) | `actions-survival.test.mjs` | **active** |
| 25 | `wait` | `survival.js` | `tools.js` (L471) | 包含 | `guard.lua` (L371) | `survival.lua` (L382) | `actions-survival.test.mjs` | **active** |
| 26 | `sleep` | `survival.js` | `tools.js` (L481) | 包含 | `guard.lua` (L253) | `survival.lua` (L454) | `actions-survival.test.mjs` | **active** |
| 27 | `use` | `interaction.js` | `tools.js` (L544) | 包含 | `guard.lua` (L413) | `interaction.lua` (L44) | `actions-interaction.test.mjs` | **active** |
| 28 | `container_take`| `interaction.js` | `tools.js` (L576) | 包含 | `guard.lua` (L439) | `interaction.lua` (L228)| `actions-interaction.test.mjs` | **active** |
| 29 | `container_put` | `interaction.js` | `tools.js` (L593) | 包含 | `guard.lua` (L453) | `interaction.lua` (L234)| `actions-interaction.test.mjs` | **active** |
| 30 | `give` | `interaction.js` | `tools.js` (L608) | 包含 | `guard.lua` (L466) | `interaction.lua` (L241)| `actions-interaction.test.mjs` | **active** |
| 31 | `attack` | `combat.js` | `tools.js` (L427) | 包含 | `guard.lua` (L333) | `combat.lua` (L234) | `actions-combat.test.mjs` | **active** |
| 32 | `kill` | `combat.js` | `tools.js` (L442) | 包含 | `guard.lua` (L346) | `combat.lua` (L242) | `actions-combat.test.mjs` | **active** |
| 33 | `fight_spider` | `combat.js` | `tools.js` (L456) | 包含 | `guard.lua` (L358) | `combat.lua` (L250) | `battle.test.mjs` | **active** |
| 34 | `recipes` | `info.js` | `tools.js` (L665) | 包含 | `guard.lua` (L500) | `crafting.lua` (L595) | `actions-crafting.test.mjs` | **active** |
| 35 | `lookup` | `info.js` | `tools.js` (L679) | 包含 | `guard.lua` (L508) | `crafting.lua` (L641) | `science-chain.test.mjs` | **active** |
| 36 | `probe` | `info.js` | `tools.js` (L692) | 包含 | `guard.lua` (L515) | `crafting.lua` (L679) | `science-chain.test.mjs` | **active** |
| 37 | `inspect` | `info.js` | `tools.js` (L562) | 包含 | `guard.lua` (L426) | `interaction.lua` (L99) | `actions-interaction.test.mjs` | **active** |
| 38 | `say` | `social.js` | `tools.js` (L517) | 包含 | `guard.lua` (L393) | `interaction.lua` (L133)| `actions-interaction.test.mjs` | **active** |
| 39 | `get_state` | 宿主本地工具 | `tools.js` (L846) | 不进(本地) | 无 (本地读取) | 读 `snapshot` | `observation.test.mjs` | **active** |
| 40 | `get_guide` | 宿主本地工具 | `tools.js` (L863) | 不进(本地) | 无 (本地读取) | 读 Markdown | `tool-parity.test.mjs` | **active** |
| 41 | `update_notes` | 宿主本地工具 | `tools.js` (L873) | 不进(本地) | 无 (本地写入) | 写 `notes-store` | `tool-parity.test.mjs` | **active** |
| 42 | `run_skill` | 宿主本地工具 | `tools.js` (L884) | 不进(本地) | 无 (本地编排) | 调 `SkillExecutor` | `skill-executor.test.mjs` | **active** |

---

### 2. 未暴露/旧版未清理动作清单 (17 项)

| 动作名称 | 实现位置 | 注册方式 | 原预期用途 | 当前状态 | 推荐处理建议 |
|----------|----------|----------|------------|----------|--------------|
| `go_to` | `actions/movement.lua:188` | `JOBS.go_to` | 早期近似寻路 | **legacy / dead** | 已被带避障探水的 `move_to` 替代，标记废弃并清理 |
| `pick` | `actions/gathering.lua:1150` | `JOBS.pick` | 手摘植物 | **legacy / dead** | 已被 `harvest` / `harvest_nearest` 替代，计划清理 |
| `add_fuel` | `actions/survival.lua:335` | `JOBS.add_fuel` | 早期添柴动作 | **legacy / duplicate** | 已由标准 `fuel` 接管，冗余未暴露，计划清理 |
| `make_fire` | `actions/survival.lua:373` | `JOBS.make_fire` | 快速点火堆 | **legacy / incomplete**| 已由标准 `build campfire/firepit` 替代，计划清理 |
| `heal` | `actions/survival.lua:407` | `JOBS.heal` | 主动使用回血物品 | **incomplete** | 暂未设计 Node Spec，计划后续标准化为主动治疗工具 |
| `list_recipes` | `actions/crafting.lua:707` | `JOBS.list_recipes`| 列出配方 | **legacy / dead** | 已由 `recipes` 和 `lookup` 替代，计划清理 |
| `store` | `actions/interaction.lua:275` | `JOBS.store` | 箱子存物 | **legacy / duplicate** | 已由 `container_put` 接管，计划清理 |
| `take` | `actions/interaction.lua:291` | `JOBS.take` | 箱子取物 | **legacy / duplicate** | 已由 `container_take` 接管，计划清理 |
| `act` | `actions/interaction.lua:324` | `JOBS.act` | 任意原生动作执行 | **dead / dangerous** | 属于无类型任意动作调用，绕过安全校验，必须清除 |
| `list_actions` | `actions/interaction.lua:377` | `JOBS.list_actions`| 列出动作 | **legacy / dead** | 内部反射调试遗留，计划清理 |
| `gather_macro` | `macros.lua:59` | `A.register` | 旧版采集宏 | **legacy / dead** | 已被 `gather_area` 与 Skill 层替代，已禁止暴露 |
| `chop_until` | `macros.lua:115` | `A.register` | 旧版砍树宏 | **legacy / dead** | 动作层 `chop` 自带 `until_gone`，宏已无用 |
| `cook_meal` | `macros.lua:158` | `A.register` | 批量烹饪宏 | **legacy / dead** | 暂无调度调用方 |
| `night_watch` | `macros.lua:207` | `A.register` | 守夜挂起宏 | **legacy / dead** | 逻辑已被 Reflex 接管 |
| `stock_light_materials` | `chores.lua:264` | `A.register` | 囤积照明材料家务 | **incomplete / dead** | 上游无调用，计划重构或清理 |
| `chore_*` (5项)| `chores.lua:272-297` | `A.register` | 5 项生活家务宏 | **incomplete / dead** | 完全无上游调用链 |

---

## 三、十大检查项权威审计结果

1. **是否存在重复 Action**：
   - 暴露工具层无重复名称（经 `tool-parity.test.mjs` 强制断言保障）。
   - 但内部实现存在同义异名动作（如 `store` vs `container_put`，`take` vs `container_take`，`add_fuel` vs `fuel`）。
2. **是否存在已删除实现但仍暴露的工具**：
   - 否。所有 38 个暴露动作均在 Lua `guard.lua` 与 `actions/*.lua` 中有对应实体。
3. **是否存在有 Lua 实现但没有 Node Spec 的动作**：
   - **是**。存在 17 个内部/遗留未暴露动作（见上表 §二）。
4. **是否存在 Node 暴露但 Lua 未注册的动作**：
   - 否。自动化 parity 测试保证了暴露集合是 Lua 注册集的真子集。
5. **同一类动作是否存在不同名称、不同参数**：
   - **是**。采集类存在 `pickup` (需要 `#N`+快照) 与 `pickup_nearest` (传 `target_kind`) 两种接口形式。
   - 移动类存在 `move_to` (强制传 `x, z`) 与 `seek` (传 `prefab`)。
6. **F8 和 DSH 是否使用一致的工具定义**：
   - **是**。两者均通过 `lib/index.js` 的 `runTool` 转发给 `lib/tools.js` 的 `executeTool`，共享完全相同的定义与白名单。
7. **工具返回值是否统一**：
   - 大部分已由 `dispatcher.describe(outcome)` 归一化为中文回执。
   - 但 `get_state format=json` 与 `recipes` 返回纯 JSON 字符串，其余返回人读 Markdown 字符串。
8. **失败原因是否统一**：
   - Dispatcher 返回标准状态机：`rejected`, `succeeded`, `unverified`, `failed`, `expired`, `unknown`。
   - 错误 reason 字段统一采用 `snake_case` (如 `out_of_range`, `stale_snapshot`, `control_denied`)。
9. **动作租约和互斥是否统一**：
   - **是**。所有进入 Dispatcher 的动作均强制要求并注入权威租约字段 (`lease_id`, `generation`, `authority_epoch`)，Lua `guard.lua` 严格核验代际。
10. **是否存在绕过 Dispatcher 直接下达角色动作的代码**：
    - **Node.js 侧完全不存在**：所有改动状态的外部工具调用 100% 走 `dispatcher.dispatch()`。
    - **Lua 模组内部存在紧急抢占通道**：`reflex.lua` 在 P0 险情下直接调用 `A.Start("reflex")` 和 `A.Abort()`，此为经过架构批准的 3 秒生死抢占，不属于非法绕过。
