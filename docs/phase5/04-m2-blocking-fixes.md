# Phase 5 M2 · 两个阻塞项修复（net.lua 自愈 + 动作终态回执）

> 两个修复**已通过真机验证**（2026-11-12 13:45）：故意重启 Bridge 后
> `net.keepAlive` 在 2 秒内自动恢复心跳；`move_to` 走完
> `EXECUTING → SUCCEEDED` 并带回游戏内真实完成文本。详见 §5.2。
>
> ⚠️ **诊断更正（2026-11-12 13:43）**：§1 早期把"通道断"归因为 `DoPeriodicTask` 失效，
> 实测证明**前几轮的主因是游戏被暂停**（详见 §5.1）。`net.keepAlive` 修的是
> "任务失效但观察器 Tick 还活着"的场景，**对游戏暂停无效，也不该有效**。
> 该修复的价值由 §5.2 的"重启 Bridge 后自动恢复"直接验证。

## 1. 阻塞项 A：命令通道在运行中断掉

### 现象（实测多次）

游戏进程还在（CPU 在涨），但 Bridge 侧心跳/telemetry/命令 poll 全停，
`connected=False`、所有动作命令永远 QUEUED。

### 根因：两个不同的原因，之前被混为一谈

1. **主因（已实测确认）：游戏被暂停。**
   DST 暂停时引擎不再触发 `DoPeriodicTask`，所有 Lua 周期任务（观察器、
   `net.tick`、命令轮询）一起停摆 —— 见 §5.1 的时间戳证据。
   这是**引擎的正常行为**，不是 bug；暂停时本来也不该执行游戏动作。
2. **次因（推测，未单独证实）：世界重载后单个周期任务失效但其它任务仍活着。**
   这种情况下 `started` 守卫仍是 true，现有 `IsValid()` 检查没机会跑。
   `net.keepAlive` 针对的是这一类。

**之前的诊断把 1 误判成 2，这里更正。** `keepAlive` 挂在观察器 Tick 上，
而观察器在暂停时也停，所以它救不了暂停场景 —— 设计上就不该救。

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

用户确认"重启世界后立刻测"，第一次探测到世界还没连上；用户再次进入游戏后
脚本等了 80 秒仍是 `alive=false connected=false`。

### 5.1 最终查明：游戏被暂停（用户指出，实测证实）

用户提示「我游戏打开地图暂停了，你好像 bridge 就连不上」。查 Bridge 日志：

```
最后一次游戏端 POST: 13:38:35 (heartbeat + telemetry)
之后到 13:43:07: 只剩我脚本的 GET /state 与 /bridge/status，游戏端 0 条 POST
新会话 41871255830AC8ED-master-1794461892: 心跳=9 推送=12，然后停
DST 进程仍在：PID 15880/37196，13:34:07 启动，CPU 130.8 / 113.6
```

**DST 暂停时引擎不再触发 `DoPeriodicTask`**，所有 Lua 周期任务
（观察器 Tick、`net.tick`、`commands.poll`）一起停摆 →
心跳停 → Bridge 判超时 → `connected=False` → 命令永远 QUEUED。

这是**引擎的正常行为**，不是 `net.lua` 的 bug，也不是 Bridge 重启导致的。
前几轮反复出现的"通道断"，主因应该都是这个；之前把它归因为
"周期任务失效"是**误判**，已在 §1 更正。

`net.keepAlive()` 挂在观察器 Tick 上，而观察器在暂停时也停，
所以**它对暂停场景无效，也不该有效**（暂停时本来就不该执行游戏动作）。
该修复针对的是另一类场景：单个周期任务失效但观察器仍活着。

**给后续真机测试的操作要求：游戏必须处于未暂停状态**（关掉地图/暂停菜单），
否则任何命令都不会被 poll。

### 5.2 真机验证通过（2026-11-12 13:45，用户取消暂停后）

用户取消暂停后立刻跑 `survival/test/verify-fixes.mjs`（脚本会**故意重启 Bridge**
来制造之前导致通道断掉的场景）。完整输出：

```
=== ① 等游戏会话连上 ===
  t+0s alive=true connected=true stale=false
  就绪: session=41871255830AC8ED-master-1794461892 玩家=沃尔夫冈 位置=(-82,70)

=== ② 故意重启 Bridge ===
  已停旧 Bridge → 新 Bridge PID=43948

=== ③ 观察 net.keepAlive 是否自动恢复 ===
  t+2s connected=true alive=true stale=false 心跳距=665ms
  ✅ 自动恢复（之前会永久断）

=== ④ 授权控制权 ===
  sync HTTP 200 holder=FIX_C1

=== ⑤ 下发 move_to，验证完整回执链路 ===
  起点 (-82,70) → 目标 (-79,71)
  enqueue HTTP 200 id=cmd_mwd4kygs_17
  t+3s  状态=EXECUTING  result=null
  终态  SUCCEEDED
    result={"completed":true,"text":"走到了 (-79,71) 附近（还差 1.1 格）",
            "action":"move_to","job":"move_to"}
  终点 (-79,71) x=-314.05  位移=true

=== ⑥ 清理 ===
  最终 control: mode=SUPERVISED holder=null
```

**结论**：
- **A（自愈）**：重启 Bridge 后 **2 秒**心跳自动恢复（665ms 前），
  `net.keepAlive` 真机生效；之前每次重启都会永久断。
- **B（终态回执）**：命令真的走了 `EXECUTING → SUCCEEDED` 两阶段，
  终态带**游戏内真实完成文本**（"还差 1.1 格"正是 `Whale.actions.move_to` 的
  到达判定输出），且角色真实位移 `(-82,70) → (-79,71)`。
  `NEEDS_RECONCILIATION` 语义所需的"是否完成可知"链路已打通。
- 控制权自动清理回 `SUPERVISED / holder=null`。

两个修复至此**沙箱 + 真机双重验证通过**。

## 6. 剩余未完成（累积）

1. ~~真机验证自愈与终态回执~~ ✅ 已在 §5.2 完成
2. Controller HTTP 门面无认证
3. 控制权变更未联动取消 Bridge 队列里已入队命令
4. `move_to_target` 未实现（M3 采集时带出）
5. DST 脚本源码仍打包，无法静态核对 `locomotor` 签名（但真机已验证可用）
6. `unknown_completion` / `action_timeout` 分支只有沙箱验证，真机未触发（需制造断线场景）

## 7. 复现

```powershell
# 沙箱测试
node --test --test-force-exit "tests/*.test.mjs"
# 真机验证（需世界已连上）
cd survival; node test/verify-fixes.mjs
```
