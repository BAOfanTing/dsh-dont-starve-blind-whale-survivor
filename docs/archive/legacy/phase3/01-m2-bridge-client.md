# Phase 3 · M2：完整 Bridge Client

> 结论：Bridge Client 从"M1 精简版"升级为完整版 —— **带 TTL 的快照缓存、并发请求合并、明确的 staleness 判定、
> 命令下发封装、8 类错误码的准确映射**。全部用真实 HTTP 假 Bridge 验证（不是 mock 函数）。
> 顺带在 Game Bridge 上新增了只读接口 `GET /api/v1/state`，因为原来 `/bridge/status` 只给元数据、不给快照。

## 1. 改动的文件

| 文件 | 改动 |
|---|---|
| `game-bridge/src/routes.ts` | **新增 `GET /api/v1/state`**（只读）：返回选定会话的最新快照 + `stale` / `stale_reason` / `snapshot_age_ms` |
| `game-bridge/src/config.ts` | 新增 `stateStaleMs`（默认 15000，`BWS_STATE_STALE_MS` 可覆盖） |
| `mcp-server/src/bridge/client.ts` | **重写**：缓存 + 并发合并 + 过期判定 + 命令封装 + 完整错误映射 |
| `mcp-server/src/tools/definitions.ts` | `get_game_status` 从 NOT_IMPLEMENTED 变成**真实现**（走快照 + 新鲜度标注） |
| `mcp-server/test/m2.test.ts` | 新增 11 个用例 |

## 2. 为什么 Bridge 要新增 `/api/v1/state`

原来的接口分工：

```
GET /api/v1/bridge/status   → 连接元数据（谁连着、心跳多久、命令队列）  ← 没有游戏内容
GET /api/v1/commands        → 命令队列
（游戏内容只在 telemetry 推送里，Bridge 自己缓存着，但没有接口读出来）
```

MCP 工具要读"当前玩家/世界/背包"，必须能拿到那份缓存。所以新增只读接口，并把**新鲜度**作为一等公民返回：

```json
GET /api/v1/state?token=…
{
  "success": true,
  "session": { "session_id": "26FA…-master-…", "shard": "master", "alive": true,
               "acknowledged_sequence": 373, "duplicates": 0, "gaps": 3 },
  "snapshot": { "player": {...}, "world": {...}, "inventory": {...}, "nearby": {...} },
  "snapshot_at": 1794447250000,
  "snapshot_age_ms": 1200,
  "stale": false,
  "stale_reason": null,
  "stale_after_ms": 15000,
  "other_sessions": 1
}
```

**会话选择规则**（多分片）：优先「活着的 + 有快照的」→「有快照的」→「活着的」；可用 `?shard=caves` 指定。
没有任何会话时返回 **503 + `no_session`**，而不是空 200。

## 3. Bridge Client 的四个能力

### ① 快照缓存（TTL 默认 1500ms）

游戏端每 2 秒推一次，缓存 1.5 秒既能挡住 AI 连续调用（一次问十个工具），又不会读到太旧的数据。
`readSnapshot({ force: true })` 强制绕过（`refresh_game_state` 会用）。

### ② 并发请求合并

三个工具同时要快照时，只打一次 Bridge：内部用 `inFlight` promise 合并。

> 这里踩了个坑：最初写 `void promise.finally(() => this.inFlight = null)`，
> 但 `.finally()` 会派生一个**新的 promise**，原 promise 拒绝时派生那个没人接 → **unhandled rejection**，
> 导致测试里 `assert.rejects` 接不住错误。改成 `promise.then(ok, err)` 两条路径都清掉。

### ③ staleness 判定（两层）

| 层 | 判断 |
|---|---|
| Bridge 端 | 心跳死了，或快照比 `stateStaleMs`（15 秒）更旧 → `stale: true` + 原因 |
| Client 端 | 本地再算一次 age（防止缓存把旧数据"洗白"），任一为 stale 就标 stale |

**`readSnapshot()` 不因过期抛错**（工具要能描述"这是最后一次已知状态"），
**`readFreshSnapshot()` 过期抛 `STATE_STALE`**（给"必须是当前状态"的场景）。

### ④ 错误码映射（实测逐条验证）

| Bridge 响应 | 映射成 | 说明 |
|---|---|---|
| 连不上（ECONNREFUSED） | `BRIDGE_UNAVAILABLE` | 附 hint：确认 Bridge 在跑 |
| 401 / 403 | `SESSION_INVALID` | token 可能已轮换 |
| 503 | `GAME_DISCONNECTED` | Bridge 活着但没游戏数据（游戏没开/暂停/没进世界） |
| 429 | `BRIDGE_UNAVAILABLE` | 命令队列满 |
| 500 / 其它非 2xx | `INTERNAL_ERROR` | |
| 响应不是 JSON | `INTERNAL_ERROR` | 附前 200 字符 |
| 超时（AbortController） | `TOOL_TIMEOUT` | 附 path 与耗时 |

## 4. 实际运行日志（真实游戏 + 真实 Bridge）

`get_game_status` 连续调用三次（第 2 次应命中缓存，第 3 次指定 caves 分片）：

```
=== 第 1 次 get_game_status ===
⚠️ 数据已过期（heartbeat_timeout，约 36272 秒前）—— 以下是最后一次已知状态，不代表当前
会话：26FA73B94506B226-master-1794410203 [master] alive=false
玩家：威尔逊 血 {"max":150,"current":50,"percent":33.3,"dead":false} 饥饿 {...,"percent":66.7} 位置 (-118, 18)
世界：第 3 天 day autumn 温度 30.6
背包：15 格，已用 0
freshness: stale=true reason=heartbeat_timeout age=36272364ms from_cache=false

=== 第 2 次（命中缓存）===
freshness: stale=true reason=heartbeat_timeout age=36273532ms from_cache=true

=== 指定 shard=caves ===
会话：56646B9386CE8145-caves-1794410205 [caves] alive=false
玩家：无
世界：第 3 天 night autumn 温度 17.2
freshness: ... from_cache=false
```

工具执行日志（stderr）：

```
INFO [bws-mcp] 工具执行 {"tool":"get_game_status","ok":true,"ms":39,"args":["include_raw"]}
INFO [bws-mcp] 工具执行 {"tool":"get_game_status","ok":true,"ms":0,"args":["include_raw"]}   ← 缓存命中
INFO [bws-mcp] 工具执行 {"tool":"get_game_status","ok":true,"ms":2,"args":["include_raw","shard"]}
```

**这次数据是"10 小时前的旧快照"**（Bridge 从落盘状态恢复，游戏当时没在跑）。
重点在于：MCP 层**如实标注了过期与原因**，还专门写了"不代表当前" —— 这正是任务书禁止的
"把旧数据描述为当前游戏状态"的反面教材处理方式。

## 5. 测试（11 个新用例，真实 HTTP 假 Bridge）

```
✔ readSnapshot：正常读取 + 缓存命中（缓存期内不重复打 Bridge）
✔ readSnapshot：并发调用只打一次 Bridge（inFlight 合并）
✔ readSnapshot：Bridge 说 stale 时如实透出（不抛错，交给工具层描述）
✔ readFreshSnapshot：过期就抛 STATE_STALE
✔ 错误分类：503 → GAME_DISCONNECTED，401 → SESSION_INVALID，500 → INTERNAL_ERROR
✔ 错误分类：Bridge 连不上 → BRIDGE_UNAVAILABLE；返回非 JSON → INTERNAL_ERROR
✔ 超时：Bridge 不响应 → TOOL_TIMEOUT
✔ 命令封装：enqueue + 轮询到终态
✔ 命令封装：一直不完成 → TOOL_TIMEOUT
✔ 命令查询：不存在的 id → INVALID_ARGUMENT
✔ 分片参数：带 shard 时请求会带上 ?shard=，且不写缓存
# tests 11 / pass 11
```

## 6. 全量回归

| 套件 | 用例 | 结果 |
|---|---|---|
| MCP Server（M1 + M2） | 16 | 全过 |
| Phase 2 game-bridge | 36 | 全过 |
| Phase 1 Bridge | 22 | 全过 |

## 7. 未完成 / 风险

1. **`get_game_status` 是我提前实现的**：任务书把第一批工具放在 M3。但它正是验证 M2 的唯一手段
   （缓存/过期/分片都得有真实调用才能证明），所以先做了这一个，其余 10 个仍 `NOT_IMPLEMENTED`。
2. **命令封装已写好但没接工具**：`runCommand()` 能用，`refresh_game_state` 要等 M3 才暴露。
3. **Bridge 侧 `sessions` 列表会包含历史会话**（落盘恢复的旧会话），`/api/v1/state` 的选择规则已经绕开它们
   （优先选 alive 的），但 `get_bridge_status` 里仍会看到。M3 可以考虑在 Bridge 加 TTL 清理。
4. **没有请求重试**：目前失败就返回错误，让 AI 自己决定要不要重试（避免 MCP 层长时间阻塞）。
   如果需要"自动重试 N 次"，M3 再加。
5. **缓存只在单进程内**：stdio 模式下每个客户端各一份；HTTP 模式（M5）要注意多会话共享同一份缓存是否合适。

## 8. 下一步（M3）

把剩下 10 个工具接上真实数据：`get_player_status` / `get_inventory` / `get_world_status` /
`get_nearby_entities` / `get_nearby_resources` / `get_nearby_threats` / `get_base_status` /
`refresh_game_state` / `get_command_result`，并统一用 M2 的 `readSnapshot()` + 新鲜度标注。
