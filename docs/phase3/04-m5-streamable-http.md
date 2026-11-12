# Phase 3 · M5：Streamable HTTP 传输

> 结论：MCP Server 支持 **stdio + Streamable HTTP 双传输**，共用同一套 Tool Registry / Resources / Prompts。
> 真实端到端验证：HTTP 通道读到真实游戏数据（WX-78、生命 100/100、饥饿 39.1%、背包「电路提取器」），
> 且**与 stdio 结果完全一致**（玩家/生命/坐标/饥饿逐项相同）。10 个新测试全过。

## 1. 改动的文件

| 文件 | 内容 |
|---|---|
| `mcp-server/src/transports/http.ts` | **新增**：Streamable HTTP 传输（官方 `NodeStreamableHTTPServerTransport`） |
| `mcp-server/src/index.ts` | `BWS_MCP_TRANSPORT=http` 分支真实现（原来明确拒绝） |
| `mcp-server/test/m5.test.ts` | **新增** 10 个用例 |

## 2. 安全要求逐条落地

| 任务书要求 | 实现 | 实测 |
|---|---|---|
| 只监听 127.0.0.1 | `server.listen(port, host)`，host 来自 `BWS_MCP_HOST`（默认 127.0.0.1） | ✅ |
| Host 校验（防 DNS rebinding） | `localhostHostValidation()`（SDK 提供） | ✅ `host: evil.example.com` → **403** |
| Origin 校验 | `localhostOriginValidation()` | ✅ `origin: https://evil.example.com` → **403** |
| 访问认证 | 共享 token；`Authorization: Bearer` 或 `?token=`；`sha256 + timingSafeEqual` | ✅ 无 token / 错 token → **401** |
| 请求体大小限制 | 先查 `content-length`，超限 → 413 | ✅ 2KB body（上限 512B）→ **413** |
| 会话管理 | 每个会话一个 transport + 一个 McpServer；`mcp-session-id` 头复用 | ✅ 握手后 5 次请求只有 **1 个会话** |
| 断线重连 | 会话保留 TTL（默认 30 分钟），空闲回收；`onclose` 自动清理 | ✅ |
| 不允许公网直接访问 | 只 bind 127.0.0.1 + Host/Origin 双校验 + 强制 token（空 token 直接拒绝启动） | ✅ |

## 3. 过程中修掉的两个真 bug

### 3.1 【严重】每个请求都新建会话

**现象**：握手返回 session id，但带着这个 id 发 `notifications/initialized` 却报
`Bad Request: Server not initialized`，`tools/call` 同样失败；日志显示**每个请求都创建了一个新会话**。

**根因**：`transport.sessionId` 在 `server.connect()` 之后仍然是 `undefined` ——
官方 transport 是在**第一次 `handleRequest` 时**才生成 session id 的。
我当时用 `crypto.randomUUID()` 兜底当 Map 的 key，导致：

```
Map 里的 key:    a95acf99-…（我自己生成的）
返回给客户端的:  04968b26-…（transport 生成的）
```

两者永远不相等 → 每次请求都找不到会话 → 每次都新建。

**修复**：用 `sessionIdGenerator` 闭包捕获 transport 真正生成的 id，第一次 `handleRequest`
之后把临时 key 迁移成真 id：

```ts
let assignedId: string | null = null
const transport = new NodeStreamableHTTPServerTransport({
  sessionIdGenerator: () => { assignedId = crypto.randomUUID(); return assignedId },
})
await server.connect(transport)
// …第一次 handleRequest 之后
if (entry.pendingId) registerSessionId(entry)   // 临时 key → 真 id
```

修复后：`initialize` → 200 + session id、`initialized` → 202、`tools/list` → 12 个工具、**会话数 = 1**。

### 3.2 【测试问题】`fetch` 不能改 Host 头

最初用 `fetch` 测 DNS rebinding，结果 evil host 也返回 200 —— 因为 **Node 的 `fetch` 会忽略/覆盖 `Host` 头**。
改用原生 `http.request` 后确认 guard 完全正常：

```
[host=evil.example.com] hostGuard=false sent=true status=403
[host=127.0.0.1:xxxxx]  hostGuard=true  sent=false status=200
```

## 4. 真实端到端验收（HTTP 通道，真实游戏）

```
=== 1. 握手 ===
initialize: 200 | session=bde87e94… | server=blind-whale-survivor

=== 2. 能力发现 ===
tools: 12 个      prompts: 4 个      resources: 6 个

=== 3. 真实游戏数据 ===
get_player_status:
  数据新鲜（约 2 秒前采集）
  玩家：WX-78
  生命：100/100（100%）
  饥饿：39.1/100（39.1%）
  理智：87.3/100（87.3%）

get_inventory:
  数据新鲜（约 2 秒前采集，来自缓存）
  背包：1/15 格
    · 电路提取器

get_world_status:
  世界：第 1 天（cycles 0），dusk，autumn

get_nearby_threats:
  威胁等级：低，敌对 0 个

=== 4. Resource 读取 ===
dst://game/world: stale=false 天数=1 季节=autumn

=== 5. Prompt ===
night_preparation: 686 字符，含取数步骤=true，含禁止写操作=true
```

## 5. 双传输一致性（核心验收项）

同一时刻用 stdio 和 HTTP 各调一次 `get_player_status`：

```
=== stdio 结果 ===
{"name":"WX-78","hp":100,"hunger":37.5,"tile":{"x":10,"z":56}}
=== HTTP 结果 ===
{"name":"WX-78","hp":100,"hunger":37.5,"tile":{"x":10,"z":56}}

一致性:
  玩家相同: true
  生命相同: true
  坐标相同: true
  饥饿差(秒级自然变化): 0.00 %
```

**两种传输完全一致** —— 因为它们共用同一个 `createGameToolService()`，这是任务书"不允许实现三套工具"的直接证据。

## 6. 启动方式

```powershell
cd E:\Cache\XinLuguWuyu\dsh-dont-starve-blind-whale-survivor\mcp-server

# stdio（默认，本地 MCP 客户端拉起子进程）
node dist/src/index.js

# Streamable HTTP（给 DSH / 内置 Agent / 其它客户端）
$env:BWS_MCP_TRANSPORT='http'; $env:BWS_MCP_PORT='8790'
$env:BWS_TOKEN=(Get-Content ..\.runtime\token.txt -Raw).Trim()
node dist/src/index.js
# → http://127.0.0.1:8790（健康检查 /healthz）
```

环境变量：`BWS_MCP_TRANSPORT`（stdio/http）、`BWS_MCP_HOST`（127.0.0.1）、`BWS_MCP_PORT`（8790）、
`BWS_TOKEN`/`BWS_TOKEN_FILE`、`BWS_BRIDGE_URL`、`BWS_TOOL_TIMEOUT_MS`、`BWS_MCP_LOG`。

## 7. 测试（10 个新用例）

```
✔ HTTP：/healthz 不需要 token
✔ HTTP：没有 token → 401，且不建会话
✔ HTTP：完整握手 + tools/list（与 stdio 同一套工具）
✔ HTTP：会话复用 —— 同一 session-id 的多次请求不新建会话
✔ HTTP：缺少 session-id 的 GET 被明确拒绝（不悄悄建会话）
✔ HTTP：Host 头不是本机 → 403（防 DNS rebinding）
✔ HTTP：Origin 不是本机 → 403
✔ HTTP：请求体超过上限 → 413
✔ HTTP：tools/call 走真实 Bridge（结果与 stdio 一致）
✔ HTTP：没有 token 的配置直接拒绝启动
# tests 10 / pass 10
```

## 8. 全量回归

| 套件 | 用例 | 结果 |
|---|---|---|
| MCP Server（M1–M5） | 56 | 全过 |
| Phase 2 game-bridge | 36 | 全过 |
| Phase 1 Bridge | 22 | 全过 |
| Lua / 插件侧 | 108 | 全过 |

## 9. 未完成 / 风险

1. **无 OAuth**：只有共享 token。MCP 规范支持 OAuth 2.1（SDK 有 `requireBearerAuth` 等工具），本阶段按任务书用共享 token。
2. **会话不持久化**：进程重启后所有 HTTP 会话失效，客户端需重新握手（符合 MCP 语义）。
3. **没有并发限流**：多个客户端同时猛调工具会各自打 Bridge（有 1.5 秒缓存挡一部分，但没做全局限流）。
4. **SSE 长连接未压力测试**：GET 的 SSE 流由 transport 自己处理，只做过基本握手验证。
5. **模组 0.9.2 的周期任务修复已确认真实生效**（新会话心跳 10 次、tick 15→16 推进、`stale=false age=342ms`）。

## 10. 下一步（M6）

第三方客户端集成测试：
- 用真实 MCP 客户端（不只是手写 JSON-RPC）连 stdio 和 HTTP；
- 完整走一遍 12 个工具 + 6 个资源 + 4 个提示词；
- 断线重连、Bridge 离线时的错误码、并发调用；
- 出最终验收报告。
