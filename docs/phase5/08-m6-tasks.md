# Phase 5 · M6：多步骤任务执行系统

> 结论：代码与测试完成，**全项目 508 个测试全过**；M6 的 3 个命令类型已在真实 Bridge 上验证部署
> （`start_task` / `stop_task` 入队返回 403 = 类型已认识，`get_task_status` 返回 200）。
>
> **真机任务链未验证** —— 部署时游戏客户端已退出（只剩 6 个 CPU=0、线程=0 的僵尸服务端，
> 心跳停了 628 秒）。需要重开游戏才能跑真机。

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

## 6. 真机验证：未做（游戏客户端已退出）

部署 mod 时查到：

```
dontstarve_dedicated_server_nullrenderer_x64  ×6   全部 CPU=0、线程=0（僵尸）
dontstarve_steam_x64                          不存在
Bridge: connected=False 心跳距=628981ms
```

游戏客户端已退出，世界没在跑，任务链无从执行。**没有空等、没有擅自启动游戏**。

已确认的只有：Bridge 侧 3 个命令类型部署成功（`start_task`/`stop_task` 403、`get_task_status` 200）。

### 重开游戏后要跑的验证

```powershell
cd survival; node test/real-tasks.mjs
```

脚本会：
1. 等会话连上 → 授权控制权
2. `get_task_status` → 应报 `running=false` + 列出 4 个可用任务
3. `start_task(forage)` → 应启动并逐步推进（观察 `step_index` 增长）
4. 中途 `get_task_status` → 应看到当前步、已完成/跳过数
5. `stop_task` → 应中止且清理（人物停止连砍/移动）
6. 白名单越权 `start_task('rm_rf')` → 应被拒
7. 清理控制权

## 7. 未完成 / 风险

1. **M6 真机未验证**（§6）—— 需重开游戏
2. **任务链只支持 4 个固定模板** —— 组合更多场景需要继续加模板（比如 `mine_rocks`、`cook_food`）
3. **任务链不跨世界/不持久化** —— 世界重载后任务丢失（run 变量在内存里）
4. **前置条件依赖 `nearby_has` 的半径** —— 目标在半径外会被判"不满足"而跳过，可能需要先走一段路
5. 三路互守对"三条链同时死"仍无效（M4 已知边界）—— 本轮又遇到一次
6. Controller HTTP 门面无认证、控制权变更未联动取消 Bridge 队列命令（M1/M2 遗留）
7. `unknown_completion` / `action_timeout` 分支只有沙箱验证

## 8. 复现

```powershell
# 沙箱回归
node --test --test-force-exit "tests/*.test.mjs"
# 真机（需客户端在跑、窗口未最小化）
node tools/unpause.mjs
cd survival; node test/real-tasks.mjs
```
