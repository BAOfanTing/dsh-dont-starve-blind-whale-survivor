# Phase 4 · M1：Agent 工程初始化 + MCP Client 连接

> 结论：**Agent 能用 HTTP 与 stdio 两种方式连上 Phase 3 的 MCP Server，自动发现 12 工具 / 6 资源 / 4 提示词，
> 并成功调用真实工具做冒烟测试。** 10 个测试全过。本里程碑不接 LLM、不跑 Agent Loop（那是 M2/M4）。

## 0. 项目改名（按你的要求）

| 项 | 变更 |
|---|---|
| 目录 | `dsh-dont-starve-whale` → **`dsh-dont-starve-blind-whale-survivor`** |
| 根 `package.json` name | 同步改名 |
| 文档/脚本里的旧路径 | 9 个文件已批量更新（README / docs / tests / package-lock） |

> 改名用的是 robocopy 迁移（原目录被当前会话的工作目录占用，`Rename-Item` 拿不到句柄）。
> 迁移后重新安装了 `mcp-server` / `game-bridge` / `bridge` 的 node_modules（robocopy 排除了它们），并重新 build 了 mcp-server。

## 1. 前置检查（以现有代码为准，不靠记忆）

| 检查项 | 实测结果 |
|---|---|
| Phase 1 模组 | `DontStarveWhaleSurvivor/scripts/main/` **15 个 Lua 模块** |
| Phase 2 Bridge 接口 | `/health`、`/api/v1/bridge/status`、`/api/v1/state`、`/api/v1/heartbeat`、`/api/v1/telemetry`、`/api/v1/probe`、`/api/v1/commands/{poll,result,enqueue}`、`/api/v1/commands` |
| Phase 3 MCP Server | `mcp-server/src/` **14 个 TS 文件** |
| MCP Server 监听 | `127.0.0.1:8790`（`BWS_MCP_HOST`/`BWS_MCP_PORT`） |
| Streamable HTTP 地址 | `http://127.0.0.1:8790`（健康检查 `/healthz`） |
| stdio 启动方式 | `node mcp-server/dist/src/index.js`（`BWS_MCP_TRANSPORT=stdio`） |
| **实际工具列表（12 个）** | `get_game_status` `get_bridge_status` `get_player_status` `get_inventory` `get_world_status` `get_nearby_entities` `get_nearby_resources` `get_nearby_threats` `get_base_status` `refresh_game_state` `get_recent_events` `get_command_result` |
| 工具输入 Schema | 全部由 zod 生成，`required` 字段可从 `inputSchema.required` 提取（如 `get_command_result` 必填 `command_id`） |
| 环境 | node v24.13.1 / npm 11.8.0 |

**如实报告**：前三阶段功能完整（Phase 3 的 14 条验收全过），没有未实现的阻塞项。

## 2. 新增目录

```
agent/
├─ package.json          @modelcontextprotocol/client 2.4.0 + server 2.4.0 + zod 4.6.7
├─ tsconfig.json         NodeNext + strict
├─ src/
│  ├─ config.ts          配置（MCP 传输方式/地址/token/超时；LLM 配置等 M2）
│  ├─ index.ts           入口：连接 + 打印完整能力清单 + 冒烟测试
│  ├─ mcp/client.ts      ★ MCP Client（连接/重连/发现/调用/状态监控）
│  ├─ utils/logger.ts    日志（分级 + token 脱敏）
│  └─ llm/ runtime/ prompts/ safety/ context/ api/   （M2~M6 预留）
└─ test/m1.test.ts       10 个用例
```

## 3. MCP Client 的实现要点

### 两种传输共用一套逻辑

```ts
private createTransport() {
  if (this.config.mcpTransport === 'http') {
    return new StreamableHTTPClientTransport(new URL(this.config.mcpHttpUrl), {
      requestInit: { headers: { authorization: `Bearer ${this.config.token}` } },
    })
  }
  return new StdioClientTransport({ command, args, env: { ...process.env, BWS_TOKEN } })
}
```

除建传输这一处，**连接、发现、调用、重连、状态监控全部共用**。

### 不写死工具列表

```ts
async refreshCatalog() {
  const [tools, resources, prompts] = await Promise.all([listTools(), listResources(), listPrompts()])
  // 全部从 Server 拿；Server 换版本/加工具后调 refreshCatalog() 即可
}
```

`listResources` / `listPrompts` 失败**不会让整个连接失败**（Server 可能没声明这些能力），只 warn。

### 连接状态机 + 可观测

```
disconnected → connecting → connected → (error | disconnected)
```

`status()` 返回：`state` / `transport` / `target` / `server{name,version,protocolVersion,capabilities}` /
`toolCount` / `resourceCount` / `promptCount` / `connectedAt` / `lastError` / `lastErrorAt` /
`reconnects` / `toolCalls` / `toolFailures`。

### 错误分类（不吞错）

| 错误码 | 触发场景 |
|---|---|
| `MCP_NOT_CONNECTED` | 没连上就调工具；或 HTTP 模式缺 token |
| `MCP_TOOL_NOT_FOUND` | 调不存在的工具（detail 里列出全部可用工具） |
| `MCP_TOOL_FAILED` | 工具执行抛错 |
| `MCP_TIMEOUT` | 连接或调用超时（默认连接 10s、工具 15s） |

## 4. 实际运行日志（真实连接）

### HTTP 模式

```
INFO [bws-agent] Agent 启动（M1） {"transport":"http","target":"http://127.0.0.1:8790","token_source":"env"}
INFO [bws-agent] 已连接 MCP Server {"transport":"http","server":"blind-whale-survivor@0.3.0-m4",
                                    "protocol":"2025-11-25","ms":89}
INFO [bws-agent] 能力已发现 {"tools":12,"resources":6,"prompts":4}
INFO [bws-agent] === MCP Server 信息 === {"capabilities":["prompts","resources","tools"]}
INFO [bws-agent] === 工具清单（12 个，全部来自 listTools，未写死）===
INFO [bws-agent]   👁 get_bridge_status   {"title":"Bridge 通道状态","required":[]}
INFO [bws-agent]   👁 get_game_status     {"title":"游戏总状态","required":[]}
INFO [bws-agent]   👁 get_player_status   {"title":"玩家状态","required":[]}
INFO [bws-agent]   👁 get_inventory       {"title":"背包","required":[]}
INFO [bws-agent]   👁 get_world_status    {"title":"世界状态","required":[]}
INFO [bws-agent]   👁 get_nearby_entities {"title":"附近实体","required":[]}
INFO [bws-agent]   👁 get_nearby_resources{"title":"附近资源","required":[]}
INFO [bws-agent]   👁 get_nearby_threats  {"title":"附近威胁","required":[]}
INFO [bws-agent]   👁 get_base_status     {"title":"基地概况","required":[]}
INFO [bws-agent]   👁 refresh_game_state  {"title":"刷新状态","required":[]}
INFO [bws-agent]   👁 get_command_result  {"title":"命令结果","required":["command_id"]}   ← 必填参数正确提取
INFO [bws-agent]   👁 get_recent_events   {"title":"最近事件","required":[]}
INFO [bws-agent] === 资源（6 个）===  dst://game/{status,player,inventory,world,nearby,bridge}
INFO [bws-agent] === 提示词（4 个）=== survival_report{args:[focus]} / resource_assessment{args:[goal]}
                                       / night_preparation{args:[]} / season_preparation{args:[next_season]}
INFO [bws-agent] 冒烟测试 get_bridge_status {"isError":false,"text":"Bridge 通道：127.0.0.1:18788"}
INFO [bws-agent] M1 完成：连接与能力发现正常 {"tools":12,"resources":6,"prompts":4}
```

### stdio 模式

```
INFO [bws-agent] 已连接 MCP Server {"transport":"stdio","target":"node.exe …\\mcp-server\\dist\\src\\index.js"}
INFO [bws-agent] 能力已发现 {"tools":12,"resources":6,"prompts":4}
INFO [bws-agent] 冒烟测试 get_bridge_status {"isError":false,"text":"Bridge 通道：127.0.0.1:18788"}
INFO [bws-agent] M1 完成：连接与能力发现正常 {"tools":12,"resources":6,"prompts":4}
```

**两种传输发现的能力完全一致**（12/6/4）。

## 5. 测试（10 个用例）

```
✔ HTTP：连接真实 MCP Server，自动发现工具/资源/提示词
✔ HTTP：调用真实工具（get_bridge_status）
✔ HTTP：读取资源和提示词
✔ stdio：拉起真实子进程，能力与 HTTP 一致
✔ 未连接时调用工具 → MCP_NOT_CONNECTED
✔ 连接不存在的 Server → 状态变 error，带错误信息
✔ 调用不存在的工具 → MCP_TOOL_NOT_FOUND，并列出可用工具
✔ token 缺失时 HTTP 连接直接报错（不静默失败）
✔ reconnect：断开后能重新连上并计数
✔ refreshCatalog：Server 工具变化后能刷新（不写死列表）
# tests 10 / pass 10
```

测试特点：**起真实 MCP Server 子进程**（随机端口 + 等 `/healthz`），不是 mock。

## 6. 运行方式

```powershell
# 1) 先起 MCP Server（HTTP）
cd mcp-server
$env:BWS_MCP_TRANSPORT='http'; $env:BWS_MCP_PORT='8790'
$env:BWS_TOKEN=(Get-Content ..\.runtime\token.txt -Raw).Trim()
node dist/src/index.js

# 2) 再跑 Agent M1
cd ..\agent
npm run build
$env:BWS_MCP_URL='http://127.0.0.1:8790'
$env:BWS_TOKEN=(Get-Content ..\.runtime\token.txt -Raw).Trim()
node dist/src/index.js            # HTTP 模式

# 或者 stdio 模式（Agent 自己拉起 MCP Server）
$env:BWS_AGENT_MCP_TRANSPORT='stdio'
node dist/src/index.js
```

环境变量：`BWS_MCP_URL`、`BWS_AGENT_MCP_TRANSPORT`（http/stdio）、`BWS_TOKEN`/`BWS_TOKEN_FILE`、
`BWS_AGENT_TOOL_TIMEOUT_MS`、`BWS_AGENT_CONNECT_TIMEOUT_MS`、`BWS_AGENT_LOG`。

## 7. 未完成项（M1 范围外，按任务书要求暂不做）

1. **没有接 LLM**：`src/llm/` 是空目录，M2 实现 DeepSeek + 本地 OpenAI 兼容 Provider。
2. **没有 Agent Loop**：M4。
3. **没有 Task Planner / Risk Assessor**：M4/M5。
4. **没有 Agent HTTP API**：M6（`src/api/` 空目录）。
5. **没有只读白名单强制**：M3/M5（`src/safety/` 空目录）。M1 只是"发现工具"，还没有"限制能调哪些"。
6. **断线自动重连**：`reconnect()` 已实现但**没有后台监控**，M4 的 Agent Loop 里会加。

## 8. 风险

1. **stdio 模式下 MCP Server 子进程的生命周期**由 Agent 管理；Agent 崩溃可能留下孤儿进程（M6 加清理）。
2. **MCP Server 的 token 与 Bridge token 是同一个**：Agent 只需要这一个，但意味着 token 泄露影响两层。
3. **`refreshCatalog` 不是自动的**：Server 换工具后需要显式刷新（M4 会在每轮 Agent Loop 开始时刷新，或在收到 `tools/list_changed` 通知时刷新）。
4. **迁移后 node_modules 是重装的**：`package-lock.json` 里的路径已同步改名，但如果你在旧目录还有进程在跑，要注意别混用。

## 9. 下一步（M2）

接 LLM Provider：
- DeepSeek 官方 API（base URL / model / thinking mode / reasoning effort / max tokens / timeout / retry，全部配置化，模型名不写死）；
- 本地 OpenAI 兼容模型（必须**实测** function calling 是否支持，不支持就明确报错）；
- 统一 `LLMProvider` 接口 + `healthCheck()`。
