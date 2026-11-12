# Phase 5 · M3：基础资源采集系统

> 结论：协议/Bridge/Lua/MCP/Agent 五层都已扩展完成，**沙箱测试全过，
> 全项目 451 个测试全过**。真机验证脚本已备好，但准备执行时游戏未连上
> （快照 31 分钟前，大概率又暂停），**真机采集尚未验证** —— 如实标注。

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
| **合计** | **451** | **全过** |

## 4. 真机验证：脚本已备好，未跑成（如实）

`survival/test/real-gather.mjs`（`node --check` 通过）会：
1. 等会话连上
2. `probe_game_actions` → 看真实 `ACTIONS.PICKUP` 是否可用（决定 M4 拾取怎么做）
3. 授权控制权
4. `gather_resource` 采 1 次树枝 → 验证 `EXECUTING → 终态` 且带回真实数量文本
5. 越权采集 → 403；非法资源名 `deerclops` → 被 Lua 拒绝
6. 清理控制权

新版 mod 已同步到 DST 安装目录（4 个改动文件 MD5 一致，`bws_config.lua` 保留）。

**准备执行时探测到 `alive=False`（快照 1860 秒前）**，结合前几轮经验大概率是游戏又暂停/没进世界。
没有空等、没有擅自重启，**真实采集未验证**，这一点不掩饰。

> 给后续真机测试的操作要求（前几轮踩过）：**游戏必须未暂停**，
> DST 暂停时引擎不触发任何 `DoPeriodicTask`，命令不会被 poll。

## 5. 未完成 / 风险

1. **真机采集未验证**（§4）
2. **`ACTIONS.PICKUP` 是否可用未知** —— `probe_game_actions` 真机结果出来后才能决定 `pick_up_item` 怎么做；为 false 时 M4 需另找原生路径，不能凭空写
3. `collect_dropped_items` 未实现（依赖上一条）
4. `chop_tree` / `mine_rock` 未开放（M4）
5. Controller HTTP 门面无认证、控制权变更未联动取消 Bridge 队列命令（M1/M2 遗留）
6. `unknown_completion` / `action_timeout` 分支只有沙箱验证，真机未触发

## 6. 复现

```powershell
# 沙箱回归
node --test --test-force-exit "tests/*.test.mjs"
# 真机（需游戏未暂停）
cd survival; node test/real-gather.mjs
```
