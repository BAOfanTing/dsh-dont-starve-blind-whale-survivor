# Phase 5 · M3：基础资源采集系统

> 结论：五层扩展完成，**452 个沙箱测试全过**；**真机验证已通过**（2026-11-12 14:40-14:47）：
> `probe_game_actions` 拿到当前构建的真实 ACTIONS 表，`gather_resource` 真实采到草
> （`EXECUTING → SUCCEEDED`，游戏内文本「采了 1 次」）。真机还发现并修正了 `twigs` 的映射错误。
>
> 同时**更正了一个反复误判的根因**：之前的"连不上"主因不是游戏暂停，而是
> **mod 的所有周期任务会一起死掉**（见 §4.3）。这是真机测试的阻塞项，留给 M4 修。

## 0. 前置检查（不假设）

| 项 | 实测 |
|---|---|
| 游戏状态 | `alive=False stale=True age=1860497ms`，玩家 沃尔夫冈 (-77,-96) —— 未连上 |
| `Whale.actions` | 已有 `pick` / `go_to` / `chop` / `mine` / `dig`，走 `ACTIONS.PICK`/`HARVEST` + `BufferedAction`，已有 Lua 沙箱测试 → **复用，不重写** |
| Phase 3 MCP | 原 12 工具；M2 加 `get_control_status` → 13 |
| M2 能力 | `ACTION_MAP` 固定白名单、`EXECUTING→终态` 回执、控制权二次校验、master shard 绑定，**已真机验证** |
| `ACTIONS.PICKUP` | **未验证**（沙箱 stub 里没有，游戏里是否存在未知）→ 因此 M3 不硬写 `pick_up_item` |

## 1. 范围决策（说清取舍）

**做**：
1. `gather_resource` —— 采摘 `twigs` / `grass` / `berries`，复用 `pick` job
2. `move_to_target` —— 走向已知可采资源，复用 `go_to`（M2 遗留）
3. `probe_game_actions` —— **只读探测**当前游戏构建里 `ACTIONS` 是否可用，为 M4 的 `pick_up_item` 提供依据

**不做（按里程碑）**：
- `pick_up_item` / `collect_dropped_items`：`ACTIONS.PICKUP` 是否在真实游戏里可用**没验证过**，不凭空写。先探测，M4 再决定。
- `chop_tree` / `mine_rock`：虽已有 `chop`/`mine` job，但属 M4「工具使用系统」，本轮不动。
- `flint` / `logs` / `rocks`：地面掉落物或需工具资源，不在 M3 第一批。

## 2. 五层改动

### 2.1 `survival/src/protocol.ts`（Action Protocol）
- `ACTION_TYPES` 加 `probe_game_actions`（17 → 18）
- 新增 `AUTONOMOUS_SAFE_ACTIONS`（任务书 §11 允许受限自动执行的采集类）
- `READ_ONLY_ACTIONS` 加探测工具

### 2.2 `game-bridge/src/commands.ts` + `routes.ts`
- `COMMAND_TYPES` 加 `gather_resource` / `move_to_target` / `probe_game_actions`（7 → 10）
- `ACTION_COMMAND_TYPES` 加 2 个写动作；`MASTER_SHARD_COMMANDS` 统一收拢所有需绑 master 的命令（含只读探测）
- routes 用常量替代散落硬编码，动作命令仍强制 `controller_id`/`session_id` + 控制权校验 + master 分片

### 2.3 `DontStarveWhaleSurvivor/scripts/main/action_executor.lua`（核心）
- `ACTION_MAP` 加 `gather_resource → pick`、`move_to_target → go_to`（固定白名单，外部字符串只查表）
- `GATHER_TARGETS = { twigs='twigs', grass='grass', berries='berrybush' }` —— **资源名白名单**，不接受任意 prefab 名
- `buildJobArgs()`：把外部参数规范化成固定 job 参数；`count` 夹 1..10、`radius` 夹 2..20；**绝不透传任意字符串**
- 参数校验提前（不必等控制权 assert 回调才报参数错）
- `EXECUTING` 回执与终态回执都带 `args`（规范化后的真实参数）
- `E.probeGameActions()`：只读报告 `ACTIONS.PICKUP/PICK/HARVEST/...` 是否存在、`Whale.actions.Known()` 的 JOBS、资源白名单；`pickup_supported` 由真实游戏返回值决定

### 2.4 `commands.lua` / `observer_manager.lua`
- `ALLOWED` / `ACTION_COMMANDS` 加 3 个命令；`execute()` 加 `probe_game_actions` 只读分支
- `C.status().allowed` 同步

### 2.5 MCP（`mcp-server/src/tools/gatherTools.ts`）
新增 3 个工具，**全部带 Zod Schema**：
| 工具 | readOnly | Schema |
|---|---|---|
| `gather_resource` | false | `resource` enum(twigs/grass/berries)、`count` int 1..10 默认1、`radius` int 2..20 默认12 |
| `move_to_target` | false | `resource` enum、`radius` int 2..20 |
| `probe_game_actions` | true | `{}` |

- `requireControl()`：**程序层**查 Bridge 控制权（紧急停止/人工接管/PAUSED/无 holder/lease 过期一律 `SESSION_INVALID`），不靠提示词
- `controller_id` 取 Bridge 当前 holder（外部 MCP 客户端与内置 Agent 共享控制权）
- 长时间动作返回 `action_id`（= command_id），**不阻塞 MCP 请求**，由 `get_command_result` 查进度
- 旧版 Bridge 不认识探测命令时明确降级为 `BRIDGE_UNAVAILABLE`，不假装成功

`ToolDefinition.readOnly` 从字面量 `true` 放宽为 `boolean`；`createServer.ts` 的 `readOnlyHint`/`destructiveHint`/`idempotentHint` 改为按工具实际标注（这是必要的架构变更）。

### 2.6 Agent（`agent/src/mcp/toolAdapter.ts`）
**安全决策**：白名单只加 `probe_game_actions`（14 个只读工具）；
`gather_resource` / `move_to_target` 是写动作，**故意不加入** —— 任务书 §11 默认 SUPERVISED、用户确认前不允许改游戏状态。
内置 Agent 这一版仍只能读和规划；外部 MCP 客户端能看到写工具，但调用时 `requireControl()` 会再查一次控制权。

## 3. 测试

### 新增
| 文件 | 用例 | 覆盖 |
|---|---|---|
| `tests/phase5-m3.test.mjs` | 9 | 资源白名单（任意 prefab 拒绝）、参数夹取、映射 pick/go_to、probe、终态回执带真实数量文本 |
| `mcp-server/test/m3GatherTools.test.ts` | 9 | Schema 约束、readOnly 标注、控制权 5 种拒绝、下发参数与 master 绑定 |
| `game-bridge/test/actionCommands.test.ts` | +2 | 命令类型、采集动作控制权 + shard |

### 契约变更（测试同步）
- MCP 工具 13 → 16；`readOnlyHint` 2 个写工具为 false
- Agent 白名单 13 → 14（MCP 发现 16，2 个写工具被跳过）
- Lua `ACTION_MAP` 2 → 4；Bridge `COMMAND_TYPES` 7 → 10；`ACTION_TYPES` 17 → 18

### 全项目回归

| 套件 | 用例 | 结果 |
|---|---|---|
| Lua/插件 | **139** | 全过 |
| Phase 1 Bridge | 22 | 全过 |
| Phase 2 Bridge | **56** | 全过 |
| Phase 3 MCP | **77** | 全过 |
| Phase 4 Agent | 110 | 全过 |
| survival | 48 | 全过 |
| **合计** | **452** | **全过** |

## 4. 真机验证：已通过（2026-11-12 14:40-14:47）

### 4.1 probe_game_actions 拿到真实 ACTIONS 表（关键收获）

```json
{"ok":true,"pickup_supported":true,
 "actions":{"PICK":true,"HARVEST":true,"CHOP":true,"MINE":true,"DIG":true,
            "PICKUP":true,"GIVE":true,"EAT":true,"BUILD":true},
 "gather_targets":["berries","grass","twigs"],
 "jobs":["attack","build","chop","cook","craft","dig","drop","eat","equip","go_to",
         "hammer","make_fire","mine","move_to","pick","say","sleep","stop","wait"]}
```

**`ACTIONS.PICKUP = true`** —— M4 的 `pick_up_item` 可以走原生拾取动作，不必另找路径。
19 个 JOBS 全部登记在案。

### 4.2 gather_resource 真实采集成功

第一次采 `twigs` 失败（真实原因：附近 12 格没有可采树枝，回执如实说「没有能采的东西」），
随后改测 `grass`（附近 7.1 格确有草）：

```
t+2s   EXECUTING
t+4~8s EXECUTING     ← 角色走过去 + 采摘动作
t+10s  SUCCEEDED
result={"completed":true,"action":"gather_resource",
        "args":{"target":"grass","radius":12,"count":1},
        "text":"采了 1 次","job":"pick"}
```

- `EXECUTING → SUCCEEDED` 两阶段（M2 修的终态回执链路在采集动作上同样生效）
- 完成文本「采了 1 次」来自游戏内 `Whale.actions`，不是编造
- 越权采集 `403 CONTROL_NOT_HELD`；非法资源 `deerclops` 被 Lua 白名单拒绝

### 4.3 真机发现并修正：twigs 映射错误

`find_by_name` 按 prefab/显示名**子串**匹配。`twigs` 匹配不到 `twiggytree`
（那是 `tree`，走 CHOP 不是 PICK）。真正可采的树枝来源是 `sapling`（树苗，pickable）。
已把 `GATHER_TARGETS.twigs` 改为 `'sapling'`，测试断言同步。

### 4.4 更正根因：不是暂停，是 mod 周期任务全死

前几轮把"连不上"归因为游戏暂停，**这次拿到了决定性证据推翻它**：

```
服务端 PID 15880/37196: 5 秒内 CPU +0.58s  → 模拟在跑
客户端 PID 37868:       3 秒内 CPU +3.77s  → 在跑
文件桥 whale_io_hud.json / whale_io_settings.json: 停在 14:47:17（与心跳同一时刻）
Bridge: connected=False 心跳距 609846ms
游戏截图：60 FPS、HUD 完整、无暂停菜单
```

**游戏在跑、画面正常，但 mod 的所有周期任务（net tick + observer tick + 文件桥）
同时停摆**。所以：

1. M2 的 `net.keepAlive()` 修复**不够** —— 它挂在 observer Tick 上，
   observer 一起死时它没机会跑。这是真实漏洞。
2. 顺带查到过一个次要原因：**游戏窗口被最小化时 DST 也会暂停**（`IsIconic=True`），
   此时发 Esc 无效，必须先 `ShowWindow(SW_RESTORE)`。已写进 `tools/unpause.mjs`。

**M4 必须解决**：周期任务不能只靠单一 `DoPeriodicTask` 链，需要
"任意外部触发即可自愈"的机制（例如多个独立周期任务互为守护，或由 HTTP 请求反驱）。
否则每次真机测试跑几分钟就会失联。

## 5. 未完成 / 风险

1. **mod 周期任务整体停摆**（§4.4）—— 真机测试阻塞项，M4 必修
2. `collect_dropped_items` 未实现（`PICKUP` 已确认可用，可基于它做）
3. `chop_tree` / `mine_rock` 未开放（M4）
4. Controller HTTP 门面无认证、控制权变更未联动取消 Bridge 队列命令（M1/M2 遗留）
5. `unknown_completion` / `action_timeout` 分支只有沙箱验证，真机未触发
6. `twigs` 在只有 `twiggytree` 没有 `sapling` 的地图会采不到（游戏会如实回报，不编造）

## 6. 复现

```powershell
# 沙箱回归
node --test --test-force-exit "tests/*.test.mjs"
# 真机（游戏需未暂停；窗口最小化会暂停，用工具恢复）
node tools/unpause.mjs
cd survival; node test/real-gather.mjs
```
