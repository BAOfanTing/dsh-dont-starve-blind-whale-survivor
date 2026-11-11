# Phase 2 · M4：命令轮询 + 执行回执

> 范围：只实现 **ping / echo / get_state / refresh_state** 四个测试命令。
> 任务书明确禁止移动、攻击、采集、制作 —— 本里程碑**没有任何游戏操作类命令**。
> Bridge 侧已实机验证（模拟会话）；游戏端执行链路需重启游戏加载新模组后验证（见 §6）。

## 1. 协议

### 轮询（游戏端每 ~1 秒）

```json
POST /api/v1/commands/poll
{ "protocol_version": "1.0", "token": "…",
  "session_id": "26FA…-master-1794409498", "shard": "master",
  "last_acknowledged_id": "cmd_mwc9bh1m_1" }

→ 200 { "success": true, "server_time": …,
        "command": { "id": "cmd_…", "type": "ping", "params": {},
                     "status": "DELIVERED", "created_at": …, "expires_at": …, "deliveries": 1 } | null,
        "pending_count": 0 }
```

### 回执

```json
POST /api/v1/commands/result
{ "protocol_version": "1.0", "token": "…", "session_id": "…",
  "command_id": "cmd_mw…", "status": "SUCCEEDED",
  "result": { "message": "Pong from DST" }, "error": null, "execution_time": 0.0012 }

→ 200 { "success": true, "command_id": "cmd_mw…", "status": "SUCCEEDED",
        "duplicate": false, "late": false }
```

### 运维接口（不属于游戏端协议，仅本机联调用）

| 接口 | 用途 |
|---|---|
| `POST /api/v1/commands/enqueue` | 人工下发一条测试命令（类型白名单校验） |
| `GET /api/v1/commands` | 看队列现状：`stats` + 最近 20 条（含结果/错误/耗时） |

## 2. 命令状态机（7 个状态全部实现）

```
QUEUED ──poll──> DELIVERED ──(EXECUTING 可选)──> SUCCEEDED / FAILED
  │                  │
  │                  ├── 超时未回执 ──> 重投同一条（同 id，游戏端去重）
  │                  └── 会话丢失 ──> FAILED(error=unknown_completion)，绝不重放
  └── TTL 到期 ──> EXPIRED
任意非终态 ──cancel──> CANCELLED
```

## 3. 可靠性（逐条对应任务书）

| 要求 | 落地 |
|---|---|
| 重复请求不得重复执行 | 游戏端 `executed[command_id]` 去重（最多记 200 条）；Bridge 侧 `settle()` 只认第一次，之后 `duplicate: true` 且不覆盖结果 |
| 不能盲目重放旧命令 | 会话心跳超时（游戏重启/换会话）→ `reapSession()` 把它手上 DELIVERED/EXECUTING 的命令判 `FAILED + unknown_completion`，**不会**再投给新会话 |
| 迟到结果 | 被判 unknown_completion 后又收到结果 → 接受、标 `late: true` 并修正状态（说明其实执行完了） |
| 投递丢了能补 | DELIVERED 超过 `redeliverAfterMs`（默认 5 秒）没回执 → 同一条命令再投一次 |
| 命令过期 | `ttlMs`（默认 60 秒）内没被取走 → EXPIRED，不再投递 |
| 队列有上限 | `maxQueue`（默认 100），超了返回 `queue_full`（HTTP 429） |
| 结果过大 | `maxResultBytes`（默认 64KB），超了截断成 `{truncated:true, original_bytes:N}` 并标 `note=result_truncated` |
| 禁止任意代码执行 | 类型白名单**双层校验**：Bridge 入队时拒、游戏端执行时再拒（`unsupported_command`）；没有 eval / loadstring / shell |
| 会话校验 | 回执要带 `session_id`，且必须与投递该命令的会话一致（否则 `session_mismatch`） |

## 4. 游戏端实现（模组 v0.9.0）

`scripts/main/commands.lua`：

| 命令 | 行为 |
|---|---|
| `ping` | 返回 `{ message = "Pong from DST" }` |
| `echo` | 原样返回 `params`，另附 `received_keys` |
| `get_state` | 现场采集 `player / inventory / world`，`params.include_nearby = true` 时再扫附近实体；复用 Phase 1 的观察器与序列化器，形状与 telemetry 一致 |
| `refresh_state` | 立刻重新采集一次（含 nearby），返回 `{refreshed:true, tick, collected_at, player_tile, nearby_returned}` |

另外：

- **轮询由 `net.lua` 的 1 秒任务驱动**（`BWS2.commands.poll(false)`），自带单飞（`polling` 标志）与失败退避（≥2 秒 × 连接退避倍数）；
- 回执 `POST /api/v1/commands/result` 带 `execution_time`（毫秒精度）；
- 客户端（`ismastersim=false`）不轮询命令 —— 只有权威服务端执行。

## 5. 实机验证（Bridge 侧，模拟会话 curl-probe-master-1）

```
1) 心跳: 200 {"state":"running","connected":true,"sessions":1,"uptime_s":29}
2) 入队 ping: 200 {"id":"cmd_mwc9bh1m_1","type":"ping","status":"QUEUED","deliveries":0}
3) 轮询: 200 拿到: ping/DELIVERED 待处理: 0
4) 回执: 200 SUCCEEDED duplicate=false
5) 重复回执: 200 duplicate=true          ← 幂等：第二次不覆盖结果
6) 白名单外类型: 400 type 必须是 ping/echo/get_state/refresh_state 之一（本阶段不实现任何真实游戏动作）
7) 再轮询: 200 command=null              ← 没有新命令时给 null
8) 队列统计: {"total":1,"QUEUED":0,"DELIVERED":0,"EXECUTING":0,"SUCCEEDED":1,"FAILED":0,"EXPIRED":0,"CANCELLED":0}
   最近命令: {"type":"ping","status":"SUCCEEDED","result":{"message":"Pong from DST"},"execution_time":0.0012}
```

## 6. 待验证（需要重启游戏加载 v0.9.0）

游戏端四个命令的真实执行还没跑过，因为当前在跑的游戏是 v0.8.3（没有 `commands.lua`）。
重启后我会依次下发 `ping / echo / get_state / refresh_state`，核对：

1. 回执 `status=SUCCEEDED`，`ping` 的结果是 `Pong from DST`；
2. `echo` 原样带回参数；
3. `get_state` 带回真实玩家/背包/世界（与 telemetry 一致）；
4. `refresh_state` 的 `tick` 在增长；
5. 队列里没有 `FAILED`，`deliveries = 1`（没有多余重投）。

## 7. 测试

| 套件 | 用例数 | 说明 |
|---|---|---|
| game-bridge（M1+M3+M4） | 28 | 含 11 个命令队列用例：白名单、投递/结算、重投、过期、会话丢失、迟到结果、会话不匹配、队列上限、结果截断、HTTP 全链路、死会话 reap |
| Lua / 插件侧 | 105 | 含 10 个 M4 沙箱用例：四个命令的真实执行、白名单外拒绝、重投不重复执行、单飞保护、轮询退避、客户端不轮询 |
| Phase 1 Bridge | 22 | 未受影响 |
