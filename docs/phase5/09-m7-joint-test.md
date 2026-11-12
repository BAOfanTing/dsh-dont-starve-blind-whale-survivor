# Phase 5 · M7：DeepSeek 联合测试（受控写入）

> 结论：代码与测试完成，**全项目 518 个测试全过**。
> Agent 已能加载 **27 个工具**（15 只读 + 12 写），并按权限档位切换提示词与守卫。
>
> **真机联合测试未完成** —— 启动 Agent 成功（`tools:27`、`has_api_key:true`、`mcp_state:connected`），
> 但执行联合测试时**游戏客户端已退出**（`dontstarve_steam_x64` 不存在，心跳停 406 秒）。
> 需要重开游戏才能跑。

## 0. 前置检查（不假设）

| 项 | 实测 |
|---|---|
| Agent 现有能力 | 16 个模块、15 个只读工具、`readOnlyGuard` 拦截所有写操作意图 |
| MCP Server 工具数 | 27 个（15 只读 + 12 写） |
| 控制权机制 | MCP 工具内 `requireControl()` + Lua `control/assert` 二次校验（M2 已实现） |
| 确认机制 | `chop_tree`/`mine_rock`/`eat_item`/`craft_item`/`build_*` 强制 `confirmed=true`（M4/M5） |
| LLM | sensenova-6.8-flash（`reasoningField='reasoning'`），凭据从 DSH 读取 |

## 1. 设计：三层权限模型

**问题**：M1~M6 的 Agent 是纯只读的（提示词第 8 条写死"绝对不能操作游戏"）。
M7 要让它**真的能玩**，但不能把安全边界交给提示词。

**方案**：按 `toolPermission` 分两档，**安全边界全在程序层**：

| 档位 | 可用工具 | 提示词第 8 条 |
|---|---|---|
| `read`（默认） | 15 个只读 | "绝对不能执行游戏修改操作" |
| `supervised` | 27 个（15 只读 + 12 写） | "可以执行，但必须遵守 4 条铁律" |

**四道程序层防线**（提示词只是第 0 道，不承重）：

1. **`ToolAdapter` 白名单** —— `read` 档根本不把写工具适配给模型（模型看不到就调不了）
2. **`WriteGuard`（M7 新增）** —— 每次调写工具前，用 `get_control_status` 查一遍：
   `mode=SUPERVISED` + `holder` 非空 + `lease` 未过期 + `emergency_stop=false`，任一不满足就拒绝
3. **MCP 工具内 `requireControl()`** —— 每个写工具的 handler 都查控制权（M3~M6 已实现）
4. **Lua `control/assert` 二次校验** —— 每个写动作执行前问 Bridge（M2 已实现）

另外 `chop_tree`/`mine_rock`/`eat_item`/`craft_item`/`build_*` 还要求 `confirmed=true`（M4/M5 已实现）。

### 关键约束：Agent 不能自己申请控制权

控制权只能由**人**通过 Survival Controller 授予。Agent 只能在已授予的 lease 下行动，
lease 过期就停手。这条写在提示词铁律 (b)，也在 `WriteGuard` 里（`holder` 为空直接拒）。

## 2. 实现

### 2.1 `toolAdapter.ts`

```ts
export const WRITE_ALLOWLIST = [
  'gather_resource', 'move_to_target',                          // M3
  'equip_item', 'chop_tree', 'mine_rock', 'pick_up_item',       // M4
  'eat_item', 'craft_item', 'build_structure', 'build_campfire', // M5
  'start_task', 'stop_task',                                     // M6
] as const

export type ToolPermission = 'read' | 'supervised'

export function toolsForPermission(permission: ToolPermission): string[]
export function isWriteTool(name: string): boolean
```

- `FORBIDDEN_TOOL_PATTERNS` 收窄：去掉 `^move`/`^chop`/`^mine`/`^eat`/`^craft`/`^build`
  （它们在 `supervised` 档要放行），保留 `^attack`/`^drop`/`^kill`/`^teleport`/`^exec`/`^shell`/`^lua`
  —— 这些**永远不给模型**。

### 2.2 `config.ts`

```ts
toolPermission: ((): 'read' | 'supervised' => {
  const v = String(env.BWS_TOOL_PERMISSION ?? 'read').toLowerCase()
  // 只认两个值；拼错就退回只读（安全默认，绝不因为拼错就放开写权限）
  return v === 'supervised' ? 'supervised' : 'read'
})(),
```

### 2.3 `systemPrompt.ts`

`CORE_RULES_BASE` 只保留铁律 1~7（安全底线，两档共用），第 8 条由 `buildCoreRules(permission)` 生成：

- `read` 档：`8. 现阶段绝对不能执行游戏修改操作...`
- `supervised` 档：`8. 你**可以执行游戏动作**...` + 4 条铁律：
  - (a) 每个写动作前先调 `get_control_status` 确认四项
  - (b) **绝不自己申请控制权**
  - (c) `confirmed=true` 才执行，调用前先说清要做什么
  - (d) **看 `verify` 字段**：`confirmed_gain=false` 就是没真的拿到东西，必须如实说

### 2.4 `agentLoop.ts` + `agent.ts`：`WriteGuard`

```ts
export interface WriteGuard {
  isWrite(name: string): boolean
  check(): Promise<{ allowed: boolean; message: string }>
}
```

`Agent.buildWriteGuard()` 用 MCP 的 `get_control_status` 实现，在 `executeOne()` 里
**调用写工具之前**拦截。不传 `writeGuard` = 不做预检（`read` 档就是这样，反正没写工具可用）。

## 3. 测试

| 新增 | 用例 | 覆盖 |
|---|---|---|
| `agent/test/m7.test.ts` | 10 | 两档工具数量（15/27）、read 档不含写工具、supervised 无重复、`isWriteTool` 判定、**两档提示词第 8 条不同**、**两档都保留铁律 1-7**、不传参数默认 read、**配置拼错退回 read**、工具清单标题 |

### 全项目回归

| 套件 | 用例 | 结果 |
|---|---|---|
| Lua/插件 | 176 | 全过 |
| Phase 1 Bridge | 22 | 全过 |
| Phase 2 Bridge | 56 | 全过 |
| Phase 3 MCP | 96 | 全过 |
| Phase 4 Agent | **120** | 全过 |
| survival | 48 | 全过 |
| **合计** | **518** | **全过** |

## 4. 启动方式（真机联合测试）

```powershell
# 1. 启动 MCP Server（HTTP 8790）
cd mcp-server
$env:BWS_TOKEN = (Get-Content ..\.runtime\token.txt -Raw).Trim()
$env:BWS_MCP_PORT = '8790'; $env:BWS_BRIDGE_URL = 'http://127.0.0.1:18788'
node dist/src/index.js

# 2. 启动 Agent（supervised 档 + --serve）
cd ..\agent
$env:BWS_TOOL_PERMISSION = 'supervised'      # ← 关键：不开就是只读
$env:BWS_LLM_API_KEY = '<从 DSH 凭据读 RRX_API_KEY>'
$env:BWS_LLM_BASE_URL = 'https://token.sensenova.cn/v1'
$env:BWS_LLM_MODEL = 'sensenova-6.8-flash'
$env:BWS_LLM_REASONING_FIELD = 'reasoning'
$env:BWS_AGENT_PORT = '8791'
node dist/src/index.js --serve                # ← 关键：不加 --serve 只会跑探测然后退出

# 3. 验证
curl http://127.0.0.1:8791/health
# 期望：{"tools":27,"has_api_key":true,"mcp_state":"connected"}

# 4. 跑联合测试
cd ..; node agent/test/m7-joint.mjs
```

### 已验证的启动结果

```
Agent /health:
{"ok":true,"service":"blind-whale-survivor-agent","version":"0.4.0-m6","ready":true,
 "mcp_state":"connected","tools":27,"provider":"sensenova-6.8-flash",
 "has_api_key":true,"uptime_s":6,...}

Agent 日志:
  能力已发现 {"tools":27,"resources":6,"prompts":4}
  🛠 chop_tree {"required":[]}
  🛠 mine_rock {"required":[]}
  🛠 craft_item {"required":["recipe"]}
  🛠 start_task {"required":["task"]}
  ...
```

**27 个工具全部适配，包括所有写工具与任务链工具。**

## 5. 真机联合测试：未完成（游戏客户端已退出）

启动 Agent 成功，但执行 `agent/test/m7-joint.mjs` 时查到：

```
dontstarve_steam_x64 不存在（unpause 工具报 NO_WINDOW）
Bridge: alive=false connected=false 心跳距=406361ms
```

游戏客户端已退出，世界没在跑，联合测试无从执行。**没有空等、没有擅自启动游戏**。

### 重开游戏后要跑的验证

`agent/test/m7-joint.mjs` 会：
1. 检查游戏连接
2. 授予控制权（模拟"主人同意 AI 动手"）
3. 检查 Agent API（未启动则提示怎么启动）
4. **让 DeepSeek 自己观察并决定做什么**：
   - 查玩家/背包/附近
   - 根据处境决定行动
   - 先查控制权再动手（写动作带 `confirmed=true`）
   - 看 `verify` 如实汇报
5. 对比游戏真实状态（位置/背包是否真变了）
6. 清理控制权

## 6. 未完成 / 风险

1. **M7 真机联合测试未做**（§5）—— 需重开游戏
2. **`WriteGuard` 只做"控制权预检"** —— 不判断"这个动作在该情境下是否合理"（比如血少时还去砍树）。
   这是刻意的：合不合理交给模型判断，程序层只管"有没有权限"。
3. **`supervised` 档下模型可以连续调多个写动作** —— 没有"每步人工确认"。
   任务书 §11 的"人工确认"体现在 `confirmed=true` 参数（模型必须显式传，且提示词要求它先说明），
   但不是"每次都弹窗让人点同意"。如果要更严，需要在 API 层加审批队列。
4. **Agent 不持久化控制权状态** —— 每次写动作都现查 `get_control_status`（多一次 Bridge 往返，但更准）
5. **`FORBIDDEN_TOOL_PATTERNS` 的 `^attack`/`^drop` 仍然禁止** —— 对应工具还没实现（M7 之后）
6. 三路互守对"三条链同时死"仍无效（M4 已知边界）
7. Controller HTTP 门面无认证（M1/M2 遗留）

## 7. 复现

```powershell
# 沙箱回归
node --test --test-force-exit "tests/*.test.mjs"
# M7 单元测试
cd agent; node --test "dist/test/m7.test.js"
# 真机联合测试（需游戏 + MCP Server + Agent --serve 都在跑）
node agent/test/m7-joint.mjs
```
