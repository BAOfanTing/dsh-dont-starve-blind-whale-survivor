# Phase 5 M2 · 两个阻塞项修复（net.lua 自愈 + 动作终态回执）

> 修的是上一轮真机验证暴露的两个反复出现的问题。
> **沙箱测试全过（11 个新用例，全项目 432 全过），真机验证脚本已备好但尚未跑成**
> （世界当时还没连上，见 §5）。如实标注，不把沙箱说成真机。

## 1. 阻塞项 A：net.lua 周期任务失效导致命令通道永久断

### 根因（实测两次）

`net.lua` 的 `N.start()` 只在 `AddGamePostInit` 调一次，心跳 / telemetry 补发 /
命令轮询全挂在**单一 `DoPeriodicTask`**。世界重载或 Bridge 重启后该任务失效，
但 `started` 守卫仍是 true，现有的 `IsValid()` 检查因为没人再调 `N.start()` 而永远没机会跑。
结果：游戏进程还在（CPU 在涨）、观察器 telemetry 偶尔还在推，但心跳=0、命令 poll 停，
所有动作命令永远 QUEUED。

### 修法：`N.keepAlive()`（不依赖任务对象"看着有效"，只看 tick 最近有没有真跑过）

- `net.lua` 加 `lastTickAt` / `lastRebuildAt` / `rebuildCount`；
  `tickBody()` 每次更新 `lastTickAt`。
- 新增 `N.keepAlive()`：
  - `now() - lastTickAt >= KEEPALIVE_GAP(3s)` → **立刻补跑一次 `tickBody()`**（pcall 隔离），
    保证心跳和命令轮询不断；
  - 同时按 `REBUILD_GAP(5s)` 间隔调 `N.start()` 重建周期任务，失败也不刷屏（下次观察器 tick 还会来）。
- `N.start()` 重写：`taskDead()` 判断现有任务是否失效；前置检查（token / TheWorld）先做；
  已有活任务直接返回 false，避免重复建。
- **`observer_manager.lua` 的 `O.Tick()` 里加两行 `pcall` 驱动**
  `BWS2.net.keepAlive()` 和 `BWS2.actionExecutor.pollCompletion()` ——
  观察器 Tick 是实证能长期存活的周期任务，作为自愈的驱动源。
- `N.status()` 暴露 `last_tick_ago_s` / `rebuilds` 便于诊断。

**为什么不依赖 `IsValid()`**：任务对象可能仍"有效"但回调不再触发；
只有 `lastTickAt` 能证明 tick 真的跑过。

## 2. 阻塞项 B：动作最终成败回执链路

### 根因

`startAction()` 启动成功立即回 `SUCCEEDED(accepted:true, running:true)` →
Bridge 命令直接终态。之后 `Whale.actions.Tick()` 的 done/fail 只写
`Whale.bridge.Report`（文件桥），HTTP 命令通道永远不知道结果。
这会破坏任务书的 `NEEDS_RECONCILIATION` 语义 —— 断线时无法区分"成功/失败/不知道"。

### 修法（不改 Bridge 状态机，复用既有能力）

查代码确认 **`CommandQueue.settle()` 已支持 `EXECUTING` 中间态**（第 229 行），
且已内置 `unknown_completion` 迟到结果处理（第 241 行）。所以：

1. **启动时回 `EXECUTING`**（不是终态），记录 `pending = {command_id, report, startedMs, action, job}`，
   并保存 `commands.lua` 的 `report` 函数引用。
2. **`whale/bridge.lua` 的 `B.Report` 加一行 hook**，把动作 done/fail 的真实 `ok/text`
   转给 `BWS2.actionExecutor.onActionReport`（不改原有文件桥逻辑）。
3. **新增 `E.pollCompletion()`**（由观察器 Tick 周期驱动）：
   - `Whale.actions.Current()` 仍非空 → 动作在跑；超过 120 秒则 `Stop()` + `ClearBufferedAction()`
     并补发 `FAILED(action_timeout)`；
   - `Current()` 变 nil → 动作结束：
     - 有真实 Report 且 `ok=true` → 补发 `SUCCEEDED`，带 `completed=true` 和真实文本；
     - `ok=false` → 补发 `FAILED`，带真实失败原因；
     - 文本含「打断了」→ `FAILED(interrupted)`，**打断不算成功**；
     - **没有任何 Report（断线/重载）→ `FAILED + unknown_completion`**，
       等价于 `NEEDS_RECONCILIATION`，明确禁止盲目重放，并计入 `completion.reconciled`。
   - 结算用**同一个 command_id**，Bridge 会从 EXECUTING 走到终态。
4. **`commands.lua` 重投保护**：第 195-200 行原本重投时回 `SUCCEEDED{duplicate:true}`，
   若发生在 EXECUTING 期间会把正在跑的动作提前判终态。改为先查
   `action_executor.status().pending_command_id`，仍在执行就不覆盖。
5. `movementStatus()` / `status()` 暴露 `completion` 计数与 `pending_command_id`。

### 关于 `NEEDS_RECONCILIATION` 的映射说明（重要）

Bridge 是 Phase 2 的 **7 态**状态机，没有第 9 态，且 `parseResultReport` 限制
游戏端只能报 `EXECUTING/SUCCEEDED/FAILED`。因此用
`FAILED + error='unknown_completion: …'` 表达同一语义：
**终态、结果未知、禁止重放**；Bridge 已有的 `unknown_completion` 迟到结果分支
还能在后续收到真实结果时修正并标 `late`。这是不破坏 Phase 2 契约的最小映射，
Phase 5 的 9 态协议（`survival/src/protocol.ts`）仍保留完整状态机。

## 3. 测试（11 个新用例，`tests/phase5-m2-fixes.test.mjs`）

```
A1  net.start 建一个周期任务，tick 发心跳并驱动命令轮询              ✔
A2  周期任务失效后 keepAlive 补跑心跳/轮询并重建任务（rebuilds>=1）    ✔
A3  tick 还活着时 keepAlive 不重复建任务（20 次调用仍 1 个任务）       ✔
A4  重复 start 不会建第二个任务                                      ✔
B1  启动动作回 EXECUTING（中间态），不是 SUCCEEDED                    ✔
B2  动作成功后用同一 command_id 补发 SUCCEEDED（completed=true）      ✔
B3  动作失败后补发 FAILED，带真实错误文本                             ✔
B4  完成信号丢失 → unknown_completion，禁止盲目重放（reconciled=1）    ✔
B5  被新指令打断 → FAILED(interrupted)，不算成功                      ✔
B6  动作还在跑时不结算；movementStatus 能看到 pending_command_id       ✔
B7  执行中重投不提前判 SUCCEEDED（pending_command_id 判据）            ✔
```

同时更新 `tests/phase5-m2.test.mjs` 的 2 个断言（`SUCCEEDED` → `EXECUTING`，
这是有意的契约变更）。

| 套件 | 用例 | 结果 |
|---|---|---|
| Lua/插件 | **130**（119 + 11 新） | 全过 |
| Phase 1 Bridge | 22 | 全过 |
| Phase 2 Bridge | 54 | 全过 |
| Phase 3 MCP | 68 | 全过 |
| Phase 4 Agent | 110 | 全过 |
| survival | 48 | 全过 |
| **合计** | **432** | **全过** |

## 4. 部署状态

新版 mod 已同步到
`E:\SteamLibrary\steamapps\common\Don't Starve Together\mods\DontStarveWhaleSurvivor`，
5 个改动文件 MD5 与仓库一致（`bws_config.lua` 保留）。
**运行中的世界仍是旧 Lua 代码，需要重启世界才能加载。**

## 5. 真机验证：脚本已备好，尚未跑成（如实）

`survival/test/verify-fixes.mjs`（`node --check` 通过）设计：
1. 等游戏会话连上
2. **故意重启 Bridge**（这正是之前导致通道永久断掉的操作）
3. 观察 `net.keepAlive` 是否在 40 秒内自动让心跳/命令轮询恢复
4. 授权后下发 `move_to`，验证命令从 `EXECUTING` 走到终态、并记录真实位移
5. 自动清理控制权

用户确认"重启世界后立刻测"，但准备执行时探测到：
```
alive=False stale=True  connected=False
所有会话心跳距 ≈1157 秒，日志只有外部 GET 查询、没有 heartbeat/telemetry
```
即**世界还没连上**（可能仍在启动或需 DSH 界面确认）。没有空等、没有擅自重启，
把代码先提交，真机验证留到世界起来后执行。

**这两个修复目前只有沙箱验证，没有真机验证** —— 这是本轮必须明说的空白。
尤其 `net.keepAlive` 的价值就在于"真机重启 Bridge 后能否自动恢复"，
沙箱测试无法替代。

## 6. 剩余未完成（累积）

1. **真机验证自愈与终态回执**（§5）
2. Controller HTTP 门面无认证
3. 控制权变更未联动取消 Bridge 队列里已入队命令
4. `move_to_target` 未实现（M3 采集时带出）
5. DST 脚本源码仍打包，无法静态核对 `locomotor` 签名（但真机已验证可用）

## 7. 复现

```powershell
# 沙箱测试
node --test --test-force-exit "tests/*.test.mjs"
# 真机验证（需世界已连上）
cd survival; node test/verify-fixes.mjs
```
