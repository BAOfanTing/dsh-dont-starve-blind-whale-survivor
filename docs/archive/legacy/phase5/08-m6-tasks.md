# Phase 5 · M6：多步骤任务执行系统

> 结论：**M6 真机验证通过**（2026-11-12 19:30-19:40）。任务链在真实游戏里逐步推进
> （亲眼观察到 `step 1→2→4`、`done/skipped` 变化），`stop_task` 能清理，
> 白名单越权被拒，人物真的移动并采到草。
> 全项目 **508 个测试全过**。
>
> 真机过程中抓到并修掉 3 个真 bug（路由错误 / 进度丢失 / 砍树重复计数），
> 另外**我自己的验证方法错了两次**（用半径内实体计数判断砍树结果，但掉落物会滚、树桩也算树）。

## 0. 前置检查（不假设）

| 项 | 实测 |
|---|---|
| 原子动作 | `Whale.actions` 已有 **19 个 JOBS**：move_to / go_to / chop / mine / hammer / dig / pick / pickup / attack / eat / cook / craft / build / make_fire / equip / drop / sleep / say / wait / stop |
| 动作接口 | `A.Start(name, args)` / `A.Tick()` / `A.Current()` / `A.Stop()` / `A.Known()` 稳定可用 |
| 动作结果回执 | `Whale.bridge.Report(ok, text)` → `BWS2.actionExecutor.onActionReport`（M2 已接通） |
| 周期驱动 | `observer Tick`（1-2s）已在驱动 `actionExecutor.pollCompletion`，M6 复用同一处 |

## 1. 范围（任务书 §8 多步骤任务）

**做**：新增**任务链引擎** `task_runner.lua`，把已有原子动作串成**固定模板**任务。

**不做**：不接受任意脚本/表达式；不做"AI 自由规划"（那是 M7 的事）。

### 设计原则

1. **固定模板白名单**：外部只能请求 `TASKS` 表里的任务名，绝不接受任意代码。
2. **每步带前置检查**：材料不够/没工具/附近没目标 → 可选步骤跳过，必需步骤则整任务失败。
3. **失败可重试**：单步失败按 `retry` 次数重试，超过就跳过（可选）或中止（必需）。
4. **中断可清理**：任何异常退出都松开 `remote_controls`（停止连砍）、`locomotor:Stop/Clear`、`ClearBufferedAction`。
5. **进度可查**：`Summary()` 暴露当前任务、第几步/共几步、已完成/跳过步数、上次错误、耗时。

## 2. 任务模板（4 个）

| 任务 | 说明 | 步骤 |
|---|---|---|
| `survive_night` | 过夜准备 | 采草 → 砍树 → 捡木头 → 建营火（必需）→ 饿了就吃 |
| `stock_logs` | 攒木头 | 采树枝 → 捡燧石 → 做斧头 → 砍 3 棵树（必需）→ 捡木头 |
| `toolkit` | 备齐工具 | 采树枝 → 捡燧石 → 采草 → 做斧头 → 做镐 → 做火把 |
| `forage` | 就近采集 | 采草 → 采树枝 → 采浆果 |

每步字段：`job`（原子动作名）/ `args` / `need(p)`（前置条件）/ `retry` / `optional` / `timeout` / `why`（人话描述）。

## 3. 状态机

`T.Tick()` 由 observer Tick 周期调用，一次只推进一步：

```
[检查前置] ──不满足──> optional? 跳过 : 整任务失败
     │满足
     ▼
[启动原子动作] ──启动失败──> 重试 N 次 ──超过──> optional? 跳过 : 失败
     │成功
     ▼
[等动作结束] ──超时──> 停止动作 + 下一步
     │
     ▼
[结算结果] ──成功──> steps_done++ → 下一步
     │失败
     ▼
   重试 N 次 ──超过──> optional? 跳过 : 整任务失败
```

动作结果通过 `bridge.Report` → `T.OnActionResult(ok, text)` 回传（和 action_executor 共用同一个 hook）。

## 4. 实现

### 4.1 Lua（`task_runner.lua`，新增 480 行）

- `TASKS` 表：4 个固定模板
- `T.Start(name)` / `T.Stop(reason)` / `T.Tick()` / `T.Summary()` / `T.OnActionResult(ok, text)`
- `count_prefab` 用官方 `StackSize()`（M5 踩过 `GetStackCount` 不存在的坑）
- `nearby_has(p, pattern, radius)` 用 `Whale.util.find_all` 做 prefab 子串匹配
- `release_controls(p)` 清理：`hold_control(false)` + `locomotor:Stop/Clear` + `ClearBufferedAction`

### 4.2 接线

| 位置 | 改动 |
|---|---|
| `modmain.lua` | 第 82 行 `modimport("scripts/main/task_runner.lua")`（放最后，依赖 `Whale.actions`/`Whale.util`） |
| `observer_manager.lua` | Tick 里 `pcall(BWS2.tasks.Tick)` |
| `bridge.lua` | `B.Report` 里 `pcall(BWS2.tasks.OnActionResult, ok, text)` |
| `commands.lua` | 白名单加 3 个；`execute` 加 `start_task` / `stop_task` / `get_task_status` 分支 |

### 4.3 Bridge / MCP

- `COMMAND_TYPES` 18 → **21**；`ACTION_COMMAND_TYPES` 加 `start_task`/`stop_task`；
  `READ_ONLY_COMMAND_TYPES` 加 `get_task_status`
- 真机验证：`start_task` / `stop_task` 入队 **403**（类型已认识），`get_task_status` **200**
- MCP 新增 `taskTools.ts` 3 个工具，工具 24 → **27**：
  | 工具 | readOnly | Schema |
  |---|---|---|
  | `start_task` | false | `task` enum(4 个固定任务名) |
  | `stop_task` | false | 无参数 |
  | `get_task_status` | true | 无参数 |
- Agent `READ_ONLY_ALLOWLIST` 加 `get_task_status`（只读），适配数 14 → **15**，
  跳过写工具 10 → **12**

## 5. 测试

| 新增 | 用例 | 覆盖 |
|---|---|---|
| `tests/phase5-m6.test.mjs` | 11 | 任务名白名单（未知/非字符串被拒）、重复启动被拒、前置不满足跳过、前置满足启动对应动作、成功推进、可选失败跳过、**必需失败中止**、停止清理（松开按键）、超时跳步、Summary 字段 |
| `mcp-server/test/m6Tasks.test.ts` | 9 | 工具数 27、readOnly 标记、任务名 enum 白名单、start/stop 需要控制权（5 种拒绝态）、status 只读免控制权、进度文案、未运行文案 |

契约同步：Lua modimport 23→24、Bridge 命令 18→21、MCP 工具 24→27、Agent 适配 14→15。

### 全项目回归

| 套件 | 用例 | 结果 |
|---|---|---|
| Lua/插件 | **176** | 全过 |
| Phase 1 Bridge | 22 | 全过 |
| Phase 2 Bridge | 56 | 全过 |
| Phase 3 MCP | **96** | 全过 |
| Phase 4 Agent | 110 | 全过 |
| survival | 48 | 全过 |
| **合计** | **508** | **全过** |

## 6. 真机验证：通过（2026-11-12 19:30-19:40）

角色：沃利（Warly）第 1 天，背包 portablecookpot_item + 土豆 + 大蒜 + 燧石。

### 6.1 验收结果

| # | 项目 | 实测 |
|---|---|---|
| ③ | `get_task_status` 初始 | ✅ `{"known_tasks":["forage","stock_logs","survive_night","toolkit"],"running":false}` |
| ④ | **白名单越权** | ✅ `没有这个任务：rm_rf（能用的：forage、stock_logs、survive_night、toolkit）` |
| ⑤ | **`start_task(stock_logs)`** | ✅ `{"running":true,"task":"stock_logs","step_index":1,"step_total":5,"current_why":"采树枝（做斧头用）"}` |
| ⑥ | **逐步推进** | ✅ 亲眼观察到：<br>`t+1s  step=2/5 skipped=1 why=捡燧石`<br>`t+10s step=4/5 done=1 skipped=2 why=砍 3 棵树` |
| ⑦ | **重复启动被拒** | ✅ `已有任务在跑：forage（先 stop_task）` |
| ⑦ | **`stop_task`** | ✅ `{"stopped":true,"running":false}` |
| ⑧ | **人物真干活** | ✅ 位置 `(72,-72)→(-24,73)`、背包多出 `cutgrass×2` |
| 附 | `chop_tree(count=3)` | ✅ `干倒了 3 个目标`，实测 `log +5`、`pinecone -2`、`twiggy_nut -1`、`evergreen -1` |
| 附 | `verify.gained` | ✅ `{"gained":{"log":8},"confirmed_gain":true}`（M5 的 StackSize 修复彻底生效） |

### 6.2 任务链跳步是正确行为

`stock_logs` 第 1 步「采树枝」被跳过，因为附近只有 `twiggytree`（多枝树）没有 `sapling`（树苗）——
前置条件 `nearby_has(p,'sapling',20)` 不满足 → 按设计跳过，不硬干。
**但这暴露一个可用性问题**：`stock_logs` 应该把 `twiggytree` 也接受为树枝来源。

## 7. 真机过程中修掉的 3 个 bug

### ① `ACTION_COMMANDS` 路由错误

`start_task` / `stop_task` 被加进 `ACTION_COMMANDS` → 被转给 `action_executor` →
那里没有同名动作 → `unknown_action: 没有这个动作：start_task`。

**根因**：`ACTION_COMMANDS` 的语义是"走执行器的**原子游戏动作**"，不是"所有会改状态的命令"。
任务链命令由 `commands.lua` 自己处理（内部会去调原子动作，不需要 assert 流程）。

### ② 任务结束后进度丢失

任务跑完 `run = nil`，上层只能看到 `running=false`，不知道刚才做了几步、跳了几步、有没有失败。

**修复**：加 `last_run` 保存总结（`{task, ok, steps_done, steps_skipped, elapsed_s, text/error}`），
`get_task_status` 在 `running=false` 时带 `last` 字段。

### ③ 砍树重复计数

`chop_tree(count=3)` 报"干倒了 3 个目标"但实际只倒 1 棵。

**两层根因**：
1. `done_targets` 在 `busy` 分支和 `done_count` 分支**都会累加** → 同一棵树算两次；
2. `done_this` 判据只看"目标无效/动作变了"，**根本没挥过斧头**的目标也被当砍倒。

**修复**：加 `counted` 标记（每个目标只计一次）+ `actually_chopped = cur_hits > 0`（必须真挥过斧头）。

### ④ 我自己的验证方法错了两次（值得记下）

1. 第一次看"半径内木头只 +1"就判断没砍倒 → 其实木头滚到半径外了；
2. 第二次看"trees 2→3"以为没砍够 → 其实**砍倒的树变树桩也算 tree**，+1 是正常的。

**正确指标**：用 `log` / `pinecone` / `twiggy_nut` 的**增量**（这些只在树倒时才出现），
不要用"半径内 tree 数量"或"半径内 log 数量"。

## 8. 未完成 / 风险

1. **`stock_logs` 只认 `sapling`** —— 地图上只有 `twiggytree` 时会跳过采树枝步骤（§6.2）
2. **任务链只支持 4 个固定模板** —— 组合更多场景需继续加模板
3. **任务链不跨世界/不持久化** —— 世界重载后任务丢失
4. **`hold_control` 期间引擎砍的是它自己选的最近目标**，不是我们指定的 `j.data.target` ——
   这个认知偏差导致砍树计数改了 3 次才对
5. 三路互守对"三条链同时死"仍无效（M4 已知边界）
6. Controller HTTP 门面无认证、控制权变更未联动取消 Bridge 队列命令（M1/M2 遗留）
7. `unknown_completion` / `action_timeout` 分支只有沙箱验证

## 9. 复现

```powershell
# 沙箱回归
node --test --test-force-exit "tests/*.test.mjs"
# 真机（需客户端在跑、窗口未最小化）
node tools/unpause.mjs
cd survival; node test/real-tasks.mjs
```
