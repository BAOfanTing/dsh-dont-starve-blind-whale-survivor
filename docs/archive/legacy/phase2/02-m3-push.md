# Phase 2 · M3：心跳 + 状态实时推送（序列号 / 幂等 / 退避）

> 结论：**游戏端每 3 秒心跳、每 2 秒推状态，Bridge 按会话管理、按 sequence 幂等，实机连续跑通。**
> 本次实测：主世界会话 26 次心跳 / 39 次推送 / ack=39 / 重复 0 / 跳号 0 / 单包 6107 字节；
> 洞穴会话 27 / 40 / ack=40 / 单包 1151 字节。

## 1. 交付的模块

### 游戏端（模组 v0.8.3）

| 文件 | 类 | 职责 |
|---|---|---|
| `scripts/main/connection.lua` | ConnectionManager | session_id（`会话-分片-启动时间`）、`offline/online/degraded` 状态机、连续失败退避 1/2/4/8 倍、计数、`isServerSide()` |
| `scripts/main/heartbeat.lua` | HeartbeatManager | 每 ~3 秒 POST `/api/v1/heartbeat`；带 `player_status`（血/饿/理智百分比、格子坐标、死亡）、`game_version`、`shard` |
| `scripts/main/telemetry.lua` | TelemetrySender | 观察器每次采样推一次；sequence 成功才 +1；单飞；超限裁剪；4xx 不重试 |
| `scripts/main/net.lua` | （调度） | **唯一**一个 1 秒周期任务（start 有守卫）；整个 tick 包 pcall；按退避调度心跳 |
| `scripts/main/json_encoder.lua` | — | 补上 `decode`（要读 Bridge 返回的 `acknowledged_sequence`，之前根本没有解码器） |

### Bridge 端（0.2.0-m3）

| 文件 | 类 | 职责 |
|---|---|---|
| `src/session.ts` | SessionManager | 会话表、心跳超时判定（10 秒）、sequence 幂等、跳号统计、`current()` 选会话 |
| `src/validate.ts` | （校验） | `session_id / sequence / timestamp / data / protocol_version` 校验，稳定错误码 |
| `src/routes.ts` | （路由） | heartbeat / telemetry 实现；bridge/status 输出 sessions 明细 |
| `src/state.ts` | BridgeState | 请求计数、最近错误（沿用 M1） |

## 2. 协议

### 心跳

```json
POST /api/v1/heartbeat
{ "protocol_version": "1.0", "token": "…", "session_id": "26FA…-master-1794409498",
  "timestamp": 1794409498,
  "player_status": { "present": true, "prefab": "wilson", "health_percent": 100,
                     "hunger_percent": 83.1, "sanity_percent": 100,
                     "tile_x": -118, "tile_z": 18, "dead": false },
  "game_version": "release", "shard": "master" }
→ 200 { "success": true, "protocol_version": "1.0", "server_time": …,
        "server_status": { "state": "running", "connected": true, "sessions": 2, "uptime_s": 300 } }
```

### 状态推送

```json
POST /api/v1/telemetry
{ "protocol_version": "1.0", "token": "…", "session_id": "…", "sequence": 39,
  "timestamp": …, "data": { /* Phase 1 的 GameState + nearby */ } }
→ 200 { "success": true, "acknowledged_sequence": 39, "server_time": …, "duplicate": false, "gap": false }
```

## 3. 可靠性设计（逐条对应任务书）

| 要求 | 落地方式 |
|---|---|
| sequence / 幂等 | 游戏端成功才 +1；Bridge 侧 `sequence <= acknowledged_sequence` → `duplicate: true`，**不覆盖快照** |
| 重复请求不重复执行 | 同上（同一 sequence 再来一次只回 ack，不动数据） |
| 断线恢复 | 失败保留同一份数据与同 sequence，退避后重试；Bridge 侧 `gap` 记跳号 |
| 不无限并发 | HTTPClient 串行队列（同时最多 1 个请求）；telemetry 单飞，飞的时候新样本覆盖 pending 并计 `dropped` |
| 指数退避 | 连续失败 → 心跳间隔 ×1/×2/×4/×8（封顶）；telemetry 重试间隔 ×2s×退避倍数 |
| 命令过期 / 命令状态 | **M4** 的内容，本里程碑不做 |
| 数据包大小限制 | `maxPayloadBytes` 64KB：先削 `nearby.entities` 一半，再丢整段 nearby；Bridge 侧 128KB 硬上限（413） |
| 不能重复创建周期任务 | `net.start()` 有 started 守卫；实测 start 两次只建 1 个任务（有单测） |
| 4xx 不该重试 | 400/401/403/404/413/422 视为永久错误：丢弃样本、计 `rejected`、打 ERROR、不重发 |

## 4. 实机验证（连续跑，真实数据）

`GET /api/v1/bridge/status`：

```
connected = true, connected_reason = ok, last_sequence = 39

会话 26FA…-master-1794409498   alive=true  心跳 26  推送 39  ack=39  dup=0  gap=0  包 6107B  最近心跳 2.4 秒前
会话 5664…-caves-1794409501    alive=true  心跳 27  推送 40  ack=40  dup=0  gap=0  包 1151B  最近心跳 2.8 秒前
```

- **心跳 : 推送 = 26 : 39 ≈ 2 : 3** —— 正好对应设计的 3 秒 / 2 秒；
- `acknowledged_sequence` 单调递增到 39，`duplicates: 0`、`gaps: 0` —— 没有丢包也没有重复入库；
- 单包 6107 字节（主世界，含 nearby 实体）、1151 字节（洞穴，附近没实体）；
- `player_status` 是实时值：实测中 `hunger_percent` 从 86.3 → 83.1 逐渐下降。

Bridge 访问日志分布（同一时间段）：

```
POST /api/v1/telemetry → 200   × 82
POST /api/v1/heartbeat → 200   × 41
GET  /health           → 200   × 14   （M2 探针的重复探测）
```

## 5. 两次事故（都记下来，避免再犯）

### 5.1 `strict.lua` 导致分片进程直接死

现象：进不了服务器，客户端提示"专用服务器无法启动 / Dedicated server process terminated prematurely"，
**但服务端日志里没有 MOD ERROR**。真正的栈在 `caves_server_log.txt`：

```
scripts/strict.lua:23 in ()
heartbeat.lua:36 in gameVersion:  n = GetBuildID
net.lua:55 → scheduler.lua:186 OnTick → update.lua:240
```

根因：DST 的 `strict.lua` 让"读不存在的全局名"**直接抛错**（不是返回 nil）；我写了 `GLOBAL[name]` 去猜
`GetBuildID/GetVersion`。而这个错误发生在 `DoPeriodicTask` 回调里且未捕获 → 穿过 scheduler/update →
**整个分片进程崩溃**。

修复：`gameVersion()` 全 pcall（只读 `GLOBAL.BRANCH` 与 `TheSim:GetBuildID()`）；`net.tick` 整体 pcall 隔离；
测试里给 `GLOBAL` 加 strict 元表（读不存在的全局直接报错），并加"gameVersion 在 strict 下不崩"、
"net tick 抛错被隔离"两个用例。

### 5.2 telemetry 漏了 token → 152 次 401 且不停重试

现象：心跳正常（200），但 telemetry 全是 401，Bridge 访问日志里 152 次 `POST /api/v1/telemetry → 401`。

根因：`send()` 里补了 `sequence/session_id/timestamp/protocol_version`，**唯独漏了 token**；
而且当时把所有失败都当可重试 → 401 被每 1~2 秒重发。

修复：请求体补 token；4xx 判为永久错误不重试；瞬时错误加退避；测试补"请求体必须带 token""4xx 不重试"
"瞬时失败要等退避到期"三个用例。

## 6. 已知问题 / 留给后续

1. **`game_version` 只有 `release`**：`TheSim:GetBuildID()` 在本机 build 762172 上不存在，只能拿到 `BRANCH`。
   Phase 1 是从日志里读的 `762172`，要精确到 build 号得另找途径（M4 之前会试 `TheSim:GetGameID` 之类）。
2. **两个分片各推一份**：主世界和洞穴各自有会话、各自推状态。这是对的（各自权威），
   但要"当前玩家在哪"得看哪条心跳的 `player_status.present = true`。M4 选命令投递目标时要按这个来。
3. **客户端不推送**（已修）：客户端的 components 是 replica，不权威；之前会多出一个没有心跳的"幽灵会话"。
4. **Bridge 不保留历史**：只留每个会话的最新快照；要曲线/回放得加环形缓冲（后续阶段）。
5. **死会话不自动清理**：目前最多保留 16 个会话，旧的 `alive: false` 会留在列表里。M4/M5 加 TTL 清理。

## 7. 怎么跑

```powershell
# 游戏端：装模组 → 起 Bridge → 进世界
node tools/install-mod.mjs
powershell -ExecutionPolicy Bypass -File start-game-bridge.ps1

# 看实时状态
curl "http://127.0.0.1:18788/api/v1/bridge/status?token=…"
```

测试：`node --test "tests/*.test.mjs"`（Lua 侧 95 例）、`cd game-bridge; node --test "dist/test/*.test.js"`（17 例）。

## 8. 本里程碑测试计数

| 套件 | 用例数 | 结果 |
|---|---|---|
| Lua / 插件侧（含 strict 模拟） | 95 | 全过 |
| Phase 2 game-bridge | 17 | 全过 |
| Phase 1 Bridge | 22 | 全过 |
