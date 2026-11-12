# Phase 5 · M2：角色移动系统 + 跨层控制权

> 结论：M1 报告 §9 写明的**前置条件（跨层控制权一致性）已补上**，并实现了
> `move_to` / `stop_movement` / `get_movement_status` 三个移动动作。
> 全项目 **419 个测试全过**，跨层端到端联调 6 项全部通过。
>
> **重要诚实标注**：本次游戏未运行（`alive=False`，快照 3217 秒前），
> 所以 Lua 侧动作只在 **fengari 沙箱**里验证，**真实游戏内移动没有验证**。
> 本报告不把沙箱测试说成游戏内测试。

## 0. 环境实测（不假设）

```
游戏/Bridge 会话：alive=False stale=True age=3217248ms 玩家=WX-78 pos=10,56
DST 安装目录：E:\SteamLibrary\steamapps\common\Don't Starve Together（存在）
运行中的 Bridge（18788）：旧版，/api/v1/control/status 返回 404
```

**M2 因此没有动用户正在跑的 18788 进程**，端到端联调全部在临时端口上做。

### 0.1 重大发现：mod 里已存在一套完整动作系统

读代码发现 `DontStarveWhaleSurvivor/scripts/whale/actions.lua`（33KB，仓库与安装目录一致），
是 0.1.0 时代**文件桥**通道的动作实现：

- 已用游戏原生 `ACTIONS` / `BufferedAction` / `locomotor:GoToPoint` / `PushAction`
- 17 个固定 JOBS 白名单：`move_to` / `go_to` / `chop` / `mine` / `pick` / `eat` / `craft` / `build` / …
- `move_to` 已有超时、卡住重试、到达判定（`tile_away <= 1.2`）
- 由 `whale/bridge.lua` 的 `server_tick`（0.2s）调 `Whale.actions.Tick()` 推进
- `last_cmd_id` 幂等去重

**决策（按"不假设 + 手术式改动"）**：M2 **复用**这套已测试的动作状态机，不重写。
只把 Phase 2 的 HTTP 命令通道桥接到它，并在执行前加控制权二次校验。

### 0.2 三层通道现状

| 层 | 通道 | 现状 |
|---|---|---|
| Controller | `survival/` HTTP | M1 dry-run；M2 加 Bridge 同步 |
| Bridge | Phase 2 `/api/v1/commands/*` | 原只支持 4 个测试命令、7 态 |
| MCP | Phase 3 工具 | 原 12 个只读工具 |
| Agent | Phase 4 ToolAdapter | 原 12 个白名单 |
| Lua | `scripts/main/commands.lua` | 原只处理 4 个测试命令 |
| Lua | `scripts/whale/actions.lua` | 已有 17 个原生动作（文件桥） |

## 1. 跨层控制权（M1 报告 §9 的前置条件）

### 方向（唯一写者，责任清晰）

```
Control Manager（权威，survival/）
   │ 每次变更 + 启动 + renew
   ▼ POST /api/v1/control/sync
Game Bridge（持久化到 .runtime/bridge-state-control.json）
   │
   ├─ GET  /api/v1/control/status   ← MCP get_control_status 工具（只读）
   └─ POST /api/v1/control/assert   ← Lua 执行端每个动作前二次校验
```

### 实现

| 文件 | 内容 |
|---|---|
| `game-bridge/src/control.ts` | `ControlStateStore`：独立落盘文件（**不改 PersistedState version=1**，避免破坏 Phase 2 恢复）、`assertCanExecute()` 五重校验、history 上限 50、坏文件回退默认 |
| `game-bridge/src/routes.ts` | 新增 3 个接口：`control/status` / `control/sync` / `control/assert` |
| `game-bridge/src/server.ts` | `ServerDeps.control` 可选注入，默认与 stateFile 同目录 |
| `survival/src/controlManager.ts` | 加 `setOnStatusChange()` / `syncNow()`；`change()` 与 `renewControl()` 触发同步；失败记 `lastSyncError` 不阻塞 |
| `survival/src/bridgeSync.ts` | Controller → Bridge 的 HTTP 同步器（2s 超时、Bearer token、失败只记日志） |
| `survival/src/controllerApi.ts` | `createController({bridge})` 可选启用；`/health` 暴露 `bridge_sync` 统计 |
| `mcp-server/src/bridge/client.ts` | 加 `controlStatus()`；旧版 Bridge 的 404 转成明确的 `BRIDGE_UNAVAILABLE` |
| `mcp-server/src/tools/controlTools.ts` | **新增第 13 个只读工具** `get_control_status` |
| `agent/src/mcp/toolAdapter.ts` | 白名单 12 → 13，加入 `get_control_status` |

**控制权只在 Node 内存里的问题已解决**：Bridge 落盘，重启可恢复；Lua 每次动作前问 Bridge，不自己存状态。

## 2. Action Protocol 扩展（Bridge 命令通道）

`game-bridge/src/commands.ts`：
```
COMMAND_TYPES = ping, echo, get_state, refresh_state,   // Phase 2 测试命令
                move_to, stop_movement, get_movement_status  // Phase 5 M2 移动动作
```

`routes.ts` 的 `/api/v1/commands/enqueue`：
- 动作命令**必须带** `controller_id` / `session_id`，缺 → 400
- 入队前调 `control.assertCanExecute()`，未授权 → **403**（程序层，不靠提示词）
- 授权通过后把控制字段写进 `params`，Lua 端会再验一次
- 只读动作 `get_movement_status` 不需要控制权
- 未知命令仍被白名单拒绝

## 3. Lua Action Executor（复用现有原生动作）

新增 `DontStarveWhaleSurvivor/scripts/main/action_executor.lua`：

| 安全边界 | 实现 |
|---|---|
| 固定白名单 | `ACTION_MAP = { move_to='move_to', stop_movement='stop' }`；**外部字符串只用来查表，绝不拼接成函数名/ACTIONS 名/代码**。未知直接 `unknown_action` |
| 服务端权威 | `TheWorld.ismastersim` 检查，非服务端 `not_server_authoritative` 拒绝 |
| 控制权二次校验 | 每个写动作执行前 `POST /api/v1/control/assert`；**请求失败一律拒绝，绝不乐观放行** |
| 玩家状态 | 死亡 / 幽灵 → `player_not_ready` |
| 参数校验 | `move_to` 必须数字 x/z，范围 ±10000；不传任意 ACTIONS 名 |
| 不阻塞主线程 | 只调 `Whale.actions.Start()`，推进由已有的 `server_tick` 驱动 |
| 结果反馈 | 通过 `report()` 回执 `ACCEPTED`（异步），最终成败由 `Whale.actions.Tick()` 经文件桥上报 |

`commands.lua` 改动（手术式）：
- `ALLOWED` 加 3 个动作命令
- `handle()` 把写动作分流给 `action_executor.execute(command, report)`，回执由执行器独占（避免重复回执）
- `get_movement_status` 直接读执行器状态（只读）
- `C.status()` 暴露 `action_executor` 状态

`modmain.lua` 加一行 `modimport("scripts/main/action_executor.lua")`。

## 4. 实际测试日志

### 4.1 全项目回归（419 个测试）

```
Lua/插件        pass 119  fail 0   （108 原有 + 11 个 M2 Lua 沙箱）
Phase 1 Bridge  pass 22   fail 0
Phase 2 Bridge  pass 52   fail 0   （36 原有 + 8 control + 8 actionCommands）
Phase 3 MCP     pass 68   fail 0   （工具 12 → 13，测试同步）
Phase 4 Agent   pass 110  fail 0   （白名单 12 → 13，测试同步）
Phase 5 survival pass 48  fail 0   （42 原有 + 6 跨层同步）
合计            pass 419  fail 0
```

### 4.2 Lua 沙箱（11 个，`tests/phase5-m2.test.mjs`）

```
✔ 未知动作直接拒绝，绝不执行任意外部字符串（eval_lua 被拒，STARTED=nil）
✔ 非服务端权威（客户端）拒绝执行
✔ 缺控制字段拒绝（不乐观放行）
✔ Bridge 不可用（assert 请求失败）→ 拒绝执行
✔ 控制权未授权（allowed=false）→ 拒绝，带明确错误码
✔ 玩家死亡 / 幽灵状态拒绝
✔ move_to 参数校验（缺坐标 / 非数字 / 超范围）
✔ 校验通过才启动原生 move_to，且回报 ACCEPTED（映射到 Whale.actions 的 move_to）
✔ stop_movement 映射到 stop，不执行任意字符串
✔ get_movement_status 只读，不需要控制权，不启动动作
✔ status() 只暴露固定白名单动作（2 个写动作）
```

### 4.3 跨层端到端联调（`survival/test/demo-m2.mjs`，临时端口）

```
=== ① 初始状态 ===
  Controller.mode=SUPERVISED holder=null
  Bridge.mode=SUPERVISED holder=null persisted=true
  一致: true

=== ② 申请控制权 → 三层同步 ===
  acquire: ok=true holder=C1
  Bridge: holder=C1 session=S1 lease_expires_at=1794457876165
  Lua 二次校验 C1:    allowed=true  code=OK
  Lua 二次校验 OTHER: allowed=false code=CONTROL_NOT_HELD

=== ③ 动作命令入队 ===
  move_to(C1):    HTTP 200 type=move_to 带控制字段=true
  move_to(OTHER): HTTP 403 CONTROL_NOT_HELD: 控制权属于 C1

=== ④ 紧急停止跨层生效 ===
  Controller.mode=EMERGENCY_STOP
  Bridge.mode=EMERGENCY_STOP emergency=true
  停止后入队: HTTP 403 EMERGENCY_STOP
  停止后 Lua assert: code=EMERGENCY_STOP

=== ⑤ Bridge 重启后控制状态从落盘恢复 ===
  重启后 Bridge.mode=EMERGENCY_STOP holder=null

=== ⑥ Controller /health ===
  sync_count=3 last_error=null

=== 完成：未连接游戏、未下发任何真实动作 ===
```

## 5. M2 验收对照

| M2 要求 | 结果 |
|---|---|
| 跨层控制权（Bridge 持久化 + MCP + Lua 二次校验） | ✅ 端到端 6 项验证 |
| `move_to` | ✅ Lua 沙箱验证映射到原生 `Whale.actions.move_to` |
| `stop_movement` | ✅ 映射到 `stop` |
| `get_movement_status` | ✅ 只读，无需控制权 |
| 目标位置验证 / 参数校验 | ✅ 数字 x/z、±10000 范围 |
| 路径可达性 / 到达判定 / 移动超时 / 卡住重试 | ✅ **复用** `whale/actions.lua` 已有实现（未重写） |
| 玩家状态检查（死亡/幽灵/忙碌） | ✅ 死亡/幽灵已验；忙碌由 `Whale.actions` 的 `busy()` 处理 |
| 服务端权威 | ✅ `ismastersim` |
| 不执行任意外部字符串 | ✅ 固定 `ACTION_MAP` |
| 控制权失效拒绝普通操作 | ✅ 端到端验证 |
| 紧急停止不被队列阻塞 | ✅ 同步生效 |
| 外部 MCP 与内置 Agent 共享控制权 | ✅ Agent 白名单加 `get_control_status` |

## 6. 未完成 / 风险（如实）

1. **真实游戏内移动未验证** —— 游戏本次没运行。Lua 侧只有 fengari 沙箱测试，
   没有验证 `locomotor:GoToPoint` 在**当前游戏构建版本**里真的让角色走起来。
   任务书要求"所有 API 必须通过当前游戏构建版本实际验证" —— **这一条 M2 没做到**，
   需要开游戏后实测。
2. **DST 脚本源码没拿到** —— `data/databundles` 是打包的，没法静态核对
   `locomotor` / `BufferedAction` 的当前签名。现有 `whale/actions.lua` 是 0.1.0 时代写的，
   虽经沙箱测试，但不代表与当前构建完全兼容。
3. **`move_to_target` 未实现** —— 需要实体目标解析，留到 M3（采集时自然带出），M2 不硬做。
4. **动作最终成败回执链路不完整** —— 现在启动成功立即回 `SUCCEEDED(accepted:true, running:true)`，
   真正的 done/fail 由 `Whale.bridge.Report`（文件桥）上报，**没有接回 Phase 2 HTTP 命令通道**。
   `get_movement_status` 能查进度，但 Bridge 命令记录不会自动从"运行中"变终态。M3 必须补。
5. **运行中的 18788 Bridge 仍是旧版** —— 本次没动用户进程。要真正启用 M2 需重启 Bridge，
   并重新生成/安装 mod（新增了 `action_executor.lua`）。
6. **Controller HTTP 门面仍无认证** —— M1 遗留，M3 前必须补 token。
7. **控制权变更不同步取消 Bridge 队列里的已入队命令** —— Controller 取消的是自己 registry 里的动作；
   Bridge 的 `CommandQueue` 里已 QUEUED 的旧控制器命令不会被自动取消（Lua 端二次校验会拒绝，
   但队列里会留 FAILED 记录）。M3 要加联动。
8. **`get_control_status` 在旧版 Bridge 上返回 `BRIDGE_UNAVAILABLE`** —— 已做明确降级，不假装成功。

## 7. 运行方式

```powershell
# 全量回归
cd E:\Cache\XinLuguWuyu\dsh-dont-starve-blind-whale-survivor
node --test --test-force-exit "tests/*.test.mjs"       # Lua/插件 119
cd game-bridge; node --test "dist/test/*.test.js"        # 52
cd ..\mcp-server; node --test "dist/test/*.test.js"      # 68
cd ..\agent; node --test "dist/test/*.test.js"           # 110
cd ..\survival; node --test "dist/test/*.test.js"        # 48

# 跨层端到端演示（临时端口，不动 18788）
cd survival; node test/demo-m2.mjs
```

## 8. 下一步（M3 预告）

基础资源采集系统。但动 M3 前必须先补 M2 遗留的两条：
- **动作最终回执链路**（第 4 条）：让 `Whale.actions.Tick()` 的 done/fail 回到 Phase 2 命令通道，
  否则"是否完成"无法确认，会破坏任务书的 `NEEDS_RECONCILIATION` 语义。
- **真实游戏内验证**（第 1 条）：需要开游戏，实测 `move_to` 真的让角色移动、到达判定准确。
- 顺带补 Controller HTTP 认证、控制权变更时联动取消 Bridge 队列命令。

M2 到此为止，等待确认后再进入 M3。
