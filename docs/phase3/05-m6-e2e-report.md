# Phase 3 · M6：端到端集成测试与最终验收

> 结论：**任务书 §12 的 14 条验收项全部实测通过**，用的是**官方 MCP Client**（`@modelcontextprotocol/client@2.4.0`），
> 不是手写 JSON-RPC。全项目 **234 个测试全过**（MCP 68 + game-bridge 36 + Phase1 22 + Lua 108）。

## 1. 最终验收（14 条逐项实测）

| # | 验收项 | 结果 | 实测证据 |
|---|---|---|---|
| 1 | MCP Server 正常启动 | ✅ | stdio + Streamable HTTP 都能起 |
| 2 | 客户端完成初始化握手 | ✅ | 协商到协议 **2025-11-25**（SDK 支持的最新版） |
| 3 | 发现全部已启用工具 | ✅ | 12 个，**全部 `readOnlyHint: true`** |
| 4 | 查询真实玩家状态 | ✅ | WX-78，生命 100% |
| 5 | 查询背包 | ✅ | 1 种物品（电路提取器） |
| 6 | 查询世界信息 | ✅ | 第 1 天 night |
| 7 | 查询附近资源 | ✅ | 39 个 |
| 8 | 读取 MCP Resources | ✅ | 6 个资源，`resources/read` 成功 |
| 9 | 使用 MCP Prompts | ✅ | 4 个提示词，`prompts/get` 成功 |
| 10 | stdio 正常 | ✅ | 12 工具可发现可调用 |
| 11 | Streamable HTTP 正常 | ✅ | 12 工具可发现可调用 |
| 12 | Bridge 断开时正确返回错误 | ✅ | `BRIDGE_UNAVAILABLE` + 排查建议，**不编造数据** |
| 13 | 两种传输调用结果一致 | ✅ | 同一时刻玩家/坐标/生命逐项相同 |
| 14 | 无法执行未授权游戏修改 | ✅ | 10 个越权工具名（move_to/attack/chop_tree/mine_rock/eat/craft/build/drop_item/execute_lua/run_shell）**全部被拒** |

## 2. 集成测试（12 个用例，全部用官方 Client）

```
✔ stdio：官方 Client 握手 + 能力发现
✔ stdio：6 个资源 + 4 个提示词
✔ stdio：12 个工具全部可调用，且都不返回 NOT_IMPLEMENTED
✔ stdio：真实游戏数据（玩家/背包/世界/附近）
✔ stdio：资源可读，且带新鲜度
✔ stdio：4 个提示词都能取，且都禁止写操作
✔ stdio：参数校验 —— 越界参数被拒
✔ stdio：并发调用 6 个工具（不串数据）
✔ HTTP：官方 Client 走 Streamable HTTP，能力与 stdio 一致
✔ HTTP：工具调用结果与 stdio 一致（同一时刻对比）
✔ HTTP：多会话并发（两个客户端各自独立）
✔ Bridge 离线：工具返回明确错误码，不编造数据
# tests 12 / pass 12
```

测试里做了这些**真实性检查**（不是走过场）：

- 实体按距离**升序**验证；
- `limit` 参数真的限制返回条数；
- 生命百分比必须在 0~100；
- 天数 ≥ 1、phase ∈ {day,dusk,night}、season ∈ 四季；
- 提示词必须含"禁止写操作"与"检查 freshness.stale"；
- Bridge 离线时**不许出现 `player` 字段**（防编造）。

## 3. 全项目测试总览

| 套件 | 用例数 | 结果 |
|---|---|---|
| **MCP Server**（M1–M6） | **68** | 全过 |
| Phase 2 game-bridge | 36 | 全过 |
| Phase 1 Bridge | 22 | 全过 |
| Lua 模组 / DSH 插件 | 108 | 全过 |
| **合计** | **234** | **全过** |

## 4. 三个阶段的完整链路（已验证）

```
MCP Client（官方 SDK / DSH / 内置 Agent）
   │  stdio 或 Streamable HTTP（127.0.0.1:8790，Bearer token）
   ▼
MCP Server（12 工具 / 6 资源 / 4 提示词，全部只读）
   │  HTTP（127.0.0.1:18788，共享 token）
   ▼
Game Bridge（会话管理 / 快照缓存 / 命令队列 / 状态落盘）
   │  HTTP 长轮询（心跳 3s / 推送 2s / 命令轮询 1s）
   ▼
Lua 模组（v0.9.2，TheSim:QueryServer）
   │
   ▼
Don't Starve Together（真实游戏）
```

每一层都有独立的错误码与超时，任何一层断开都不会污染上层数据。

## 5. 本阶段修掉的关键 bug（复盘）

| # | Bug | 影响 | 根因 |
|---|---|---|---|
| 1 | 世界重载后 HTTP 通道永久停摆 | 换存档后心跳/推送全停 | `net.start()` 的 `started` 守卫没考虑 `DoPeriodicTask` 会被清掉 |
| 2 | 多分片选错会话 | `get_player_status` 说"没有玩家" | Bridge 只按"活着"选，选到了空洞穴 |
| 3 | HTTP 每个请求都新建会话 | 握手后一切请求都失败 | `transport.sessionId` 在 `connect()` 后仍是 undefined，我用兜底 id 当 key |
| 4 | 事件阈值设太大 | 事件流永远空 | 饥饿每秒只掉 0.1~0.2%，阈值设 3% 永不触发 |

前三个都是**只在特定场景才暴露**的（换存档、双分片、HTTP 传输），单靠单元测试抓不到 —— 都是实机跑出来的。

## 6. 已知限制（如实列出）

1. **只读**：12 个工具全是查询类，没有任何移动/攻击/采集/制作能力（任务书要求，M6 之后才可能放开）。
2. **事件流不持久**：MCP 进程内环形缓冲（200 条），重启即清零；多客户端各一份。
3. **共享 token，无 OAuth**：本机工具场景够用；若要跨机器访问需改造。
4. **Bridge 会话列表不清理**：历史会话会一直留着（`/api/v1/state` 已能选对，但 `get_bridge_status` 会看到一堆）。
5. **`get_base_status` 是启发式**：没有游戏内"基地"概念，靠结构/容器/光源打分，可能误判。
6. **附近实体上限 40 个**：受游戏日志长度限制，`scanned` 字段会告诉 AI 实际扫到多少。
7. **`game_version` 只有 `release`**：拿不到 762172 这样的 build 号。
8. **未测**：多人联机、洞穴内玩家、SSE 长连接压力、OAuth。

## 7. 怎么跑（三种使用方式）

```powershell
cd E:\Cache\XinLuguWuyu\dsh-dont-starve-blind-whale-survivor\mcp-server
npm install && npm run build

# ① stdio（Claude Desktop / Cursor 等本地 MCP 客户端）
node dist/src/index.js

# ② Streamable HTTP（DSH / 内置 Agent / 远程客户端）
$env:BWS_MCP_TRANSPORT='http'; $env:BWS_MCP_PORT='8790'
$env:BWS_TOKEN=(Get-Content ..\.runtime\token.txt -Raw).Trim()
node dist/src/index.js
# 健康检查 http://127.0.0.1:8790/healthz

# ③ 内置 Agent（不经 MCP 协议，直接复用业务层）
#    import { createGameToolService, callToolDirect } from './dist/src/server/createServer.js'
```

MCP 客户端配置（stdio 示例）：

```json
{
  "mcpServers": {
    "blind-whale-survivor": {
      "command": "node",
      "args": ["E:\\Cache\\XinLuguWuyu\\dsh-dont-starve-blind-whale-survivor\\mcp-server\\dist\\src\\index.js"],
      "env": { "BWS_BRIDGE_URL": "http://127.0.0.1:18788" }
    }
  }
}
```

## 8. Phase 3 交付清单

| 交付物 | 位置 |
|---|---|
| MCP Server 源码 | `mcp-server/src/`（server / transports / bridge / tools / resources / prompts / schemas / utils） |
| 集成测试 | `mcp-server/test/`（m1–m6，68 个用例） |
| 文档 | `docs/phase3/00-m1-mcp-skeleton.md` ~ `05-m6-e2e-report.md` |
| 12 个只读工具 | `tools/definitions.ts` + `tools/readTools.ts` |
| 事件流 | `tools/events.ts` |
| 6 个资源 / 4 个提示词 | `resources/gameResources.ts` / `prompts/gamePrompts.ts` |
| 双传输 | `transports/stdio.ts` / `transports/http.ts` |

## 9. Phase 3 的一句话总结

**外部 AI 现在可以通过标准 MCP 协议，用 12 个只读工具、6 个资源、4 个分析提示词，读到真实的饥荒世界状态
（玩家/背包/世界/附近资源/威胁/事件），并且明确知道数据有多新、什么时候不该信。**
