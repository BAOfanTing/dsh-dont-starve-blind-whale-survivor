# Phase 3 · M1：前置检查 + MCP Server 骨架

> 结论：**外部 MCP 客户端可以用标准 JSON-RPC 连上 Blind Whale Survivor，完成 initialize 握手、发现 12 个工具、并通过 `get_bridge_status` 真实读到 Bridge 数据。**
> 本里程碑只做 M1：不实现其余工具（老实返回 `NOT_IMPLEMENTED`），不实现 HTTP 传输（M5）。

## 1. 前置检查（不假设，全部实查）

### 1.1 Phase 1 / Phase 2 的真实状态

| 检查项 | 实测结果 |
|---|---|
| 仓库结构 | `DontStarveWhaleSurvivor/`（Lua 模组）、`game-bridge/`（Phase 2）、`bridge/`（Phase 1）、`schema/`、`tools/`、`docs/`、`tests/` |
| git 最新提交 | `3c06658 feat(phase2): M5 —— 连接恢复 + 命令幂等` |
| 模组版本（已装进游戏） | **v0.9.1**，`api_version = 10` |
| Phase 2 Bridge 版本 | **0.2.0-m5**，监听 `127.0.0.1:18788` |
| 测试基线 | Lua/插件 **108**、Phase 2 Bridge **36**、Phase 1 Bridge **22**，全过 |
| 日志通道契约 | `schema/state.schema.json`，实测 **933 条记录全部通过** |

### 1.2 Bridge 现有的真实接口（从 `game-bridge/src/routes.ts` 读出来）

```
GET  /health
GET  /api/v1/bridge/status
POST /api/v1/heartbeat
POST /api/v1/telemetry
POST /api/v1/probe
POST /api/v1/commands/poll
POST /api/v1/commands/result
POST /api/v1/commands/enqueue   （运维用）
GET  /api/v1/commands           （运维用）
```

### 1.3 环境与依赖

| 项 | 实测 |
|---|---|
| Node.js | v24.13.1（SDK 要求 ≥20 ✅） |
| npm | 11.8.0 |
| TypeScript | 5.9.x（仓库内） |
| **`@modelcontextprotocol/server`** | **2.4.0 真实存在**，engines node>=20 ✅ |
| **`@modelcontextprotocol/node`** | **2.1.2 真实存在**，engines node>=20 ✅ |
| zod | **4.6.7** ✅ |
| MCP 协议版本 | SDK 支持 `2025-11-25`（最新）/ `2025-06-18` / `2025-03-26` / `2024-11-05` / `2024-10-07` |

依赖已**锁定精确版本**（`"@modelcontextprotocol/server": "2.4.0"` 等，不带 `^`）。

### 1.4 SDK v2 的实际 API（从 `.d.mts` 里读，不猜）

```ts
new McpServer({ name, version })
server.registerTool(name, { title, description, inputSchema, annotations }, handler)
server.connect(transport)                      // stdio 用 StdioServerTransport
serveStdio(factory, options)                   // 另一种 stdio 用法（M1 用显式 transport，更清楚）
// HTTP（M5 用）：NodeStreamableHTTPServerTransport + toNodeHandler + host/origin 校验助手
```

`inputSchema` 接受 **Standard Schema**（zod 4 原生实现），SDK 据此生成 JSON Schema 并做参数校验。

## 2. 目录结构（已创建）

```
mcp-server/
├─ package.json          SDK 2.4.0 / node 2.1.2 / zod 4.6.7，版本锁定
├─ tsconfig.json         NodeNext + strict
├─ src/
│  ├─ index.ts                  入口：按 BWS_MCP_TRANSPORT 选传输（M1 只有 stdio）
│  ├─ config.ts                 配置解析（Bridge 地址 / token / 超时 / 端口 / 日志级别）
│  ├─ bridge/client.ts          Bridge Client（唯一能碰网络的层；超时 + 错误分类）
│  ├─ server/createServer.ts    GameToolService + McpServer 组装（注册表唯一事实来源）
│  ├─ transports/stdio.ts       stdio 传输
│  ├─ tools/definitions.ts      12 个工具定义（schema + handler）
│  ├─ resources/                （M4）
│  ├─ prompts/                  （M4）
│  ├─ schemas/errors.ts         8 个错误码 + ToolError
│  └─ utils/logger.ts           日志（**只写 stderr**，带 token 脱敏）
└─ test/m1.test.ts              5 个协议测试（真实子进程 + 真实 JSON-RPC）
```

## 3. 三层架构（M1 已落地）

```
MCP Client ──stdio JSON-RPC──> transports/stdio.ts
                                     │
                            server/createServer.ts（Tool Registry：唯一事实来源）
                                     │
                            tools/definitions.ts（Game Tool Service：业务逻辑）
                                     │
                            bridge/client.ts（Bridge Client：HTTP + 超时 + 错误分类）
                                     │
                            Game Bridge 127.0.0.1:18788
```

- **MCP Server 不直接碰 Lua Mod**，所有数据经 Bridge；
- stdio 与未来的 Streamable HTTP 调同一个 `createGameToolService()`；未来 DeepSeek Agent 也调它（`callToolDirect()` 已经留好）。

## 4. 12 个工具的现状（M1）

| 工具 | 状态 | 计划 |
|---|---|---|
| `get_bridge_status` | ✅ **已实现**（真实读 Bridge） | — |
| `get_game_status` | ⛔ NOT_IMPLEMENTED | M3 |
| `get_player_status` | ⛔ NOT_IMPLEMENTED | M3 |
| `get_inventory` | ⛔ NOT_IMPLEMENTED | M3 |
| `get_world_status` | ⛔ NOT_IMPLEMENTED | M3 |
| `get_nearby_entities` | ⛔ NOT_IMPLEMENTED | M3 |
| `get_nearby_resources` | ⛔ NOT_IMPLEMENTED | M3 |
| `get_nearby_threats` | ⛔ NOT_IMPLEMENTED | M3 |
| `get_base_status` | ⛔ NOT_IMPLEMENTED | M3（"基地"判定规则需先定义） |
| `refresh_game_state` | ⛔ NOT_IMPLEMENTED | M3 |
| `get_recent_events` | ⛔ NOT_IMPLEMENTED | M4（需要事件流缓存） |
| `get_command_result` | ⛔ NOT_IMPLEMENTED | M3 |

每个工具都已经有：名称、描述、zod 参数 schema（带范围限制）、`readOnlyHint: true` 注解、执行日志、超时（Bridge 调用 5 秒）。

## 5. 实际运行日志（真实交互，不是编的）

启动（stdout 干净，日志全在 stderr）：

```
[2026-11-11T15:41:56.314Z] INFO [bws-mcp] Blind Whale Survivor MCP Server 启动 {"version":"0.3.0-m1","transport":"stdio","bridge_url":"http://127.0.0.1:18788","token_source":"file","tool_timeout_ms":5000}
[2026-11-11T15:41:56.317Z] INFO [bws-mcp] 工具已注册 {"count":12,"tools":[...12 个...]}
[2026-11-11T15:41:56.318Z] INFO [bws-mcp] stdio 传输已就绪（stdout 仅用于 MCP 协议）
```

协议交互：

```
← initialize: protocolVersion=2025-06-18
              serverInfo={"name":"blind-whale-survivor","version":"0.3.0-m1"}
              capabilities={"tools":{"listChanged":true}}
← tools/list: 12 个工具 ->
   get_game_status, get_bridge_status, get_player_status, get_inventory, get_world_status,
   get_nearby_entities, get_nearby_resources, get_nearby_threats, get_base_status,
   refresh_game_state, get_recent_events, get_command_result
← tools/call get_bridge_status: isError=false
   文本首行: Bridge 通道：127.0.0.1:18788
   structuredContent: connected=false sessions=6 alive=0 最近心跳=688333ms
← tools/call get_player_status: isError=true code=NOT_IMPLEMENTED msg=玩家状态 还没实现（计划在 M3）
```

**注意 `connected=false`**：这是当时的真实情况 —— 游戏被暂停了（`Sim paused`），Bridge 十几分钟没收到心跳。
MCP Server 如实反映"没连上"，没有把旧数据当成当前状态报出来。这正是任务书要求的"禁止将旧数据描述为当前游戏状态"。

## 6. 测试（`node --test "dist/test/*.test.js"`）

```
✔ initialize 握手 + tools/list 列出全部工具
✔ tools/call：未实现的工具老实返回 NOT_IMPLEMENTED
✔ tools/call：get_bridge_status 打到真实 Bridge（或如实报 BRIDGE_UNAVAILABLE）
✔ stdout 只有 JSON-RPC：日志全部在 stderr
✔ 未知工具 → isError；参数越界由 SDK 依据 inputSchema 拦下
# tests 5 / pass 5 / fail 0
```

测试特点：**拉起真实子进程**、发**真实 JSON-RPC**、`get_bridge_status` 打的是**真实 Bridge**。

## 7. 启动命令

```powershell
cd E:\Cache\XinLuguWuyu\dsh-dont-starve-whale\mcp-server
npm install            # 只第一次
npm run build
node dist/src/index.js # stdio 模式（供 MCP 客户端拉起）
```

MCP 客户端配置（例如 Claude Desktop 风格）：

```json
{
  "mcpServers": {
    "blind-whale-survivor": {
      "command": "node",
      "args": ["E:\\Cache\\XinLuguWuyu\\dsh-dont-starve-whale\\mcp-server\\dist\\src\\index.js"],
      "env": { "BWS_BRIDGE_URL": "http://127.0.0.1:18788" }
    }
  }
}
```

环境变量：`BWS_BRIDGE_URL`（默认 `http://127.0.0.1:18788`）、`BWS_TOKEN`/`BWS_TOKEN_FILE`、`BWS_TOOL_TIMEOUT_MS`（5000）、`BWS_MCP_LOG`、`BWS_MCP_HOST`/`BWS_MCP_PORT`（8790，M5 用）。

## 8. 未完成 / 需要你确认的风险

1. **端口偏差（要你确认）**：任务书写"Game Bridge 8788"，但 Phase 2 实际用的是 **18788**（8788 被本机 python 进程占用，你当时选了改端口）。所以 MCP 默认连 `http://127.0.0.1:18788`。
   MCP Server 端口按任务书用 **8790**（M5 启用）。
2. **参数校验的两层差异**：schema 级违规由 SDK 拦下，返回标准 `isError` + 文本（**没有** `structuredContent`）；结构化错误码 `INVALID_ARGUMENT` 留给业务层语义校验（M3 接真实数据时才有，例如半径超过 Bridge 扫描上限）。这是 SDK 行为，不是我省略了。
3. **只实现了 1 个工具**：其余 11 个是 `NOT_IMPLEMENTED`，M3/M4 逐个接。
4. **没有 Resources / Prompts**：M4。
5. **没有 Streamable HTTP**：M5；现在 `BWS_MCP_TRANSPORT=http` 会明确报错退出（不假装支持）。
6. **没有 Bridge 缓存与过期标记**：`STATE_STALE` 错误码已定义但还没用上，M2 建 Bridge Client 完整版时补。
7. **游戏当前是暂停状态**：`connected=false` 是真实情况，不是 Server 的问题。

## 9. 下一步（M2 预告）

把 `bridge/client.ts` 从"M1 精简版"升级成完整的 Bridge Client：
会话选择（多分片）、状态快照缓存 + 过期时间、`STATE_STALE` 判定、命令下发与结果查询封装、并发去重与重试。
