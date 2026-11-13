# Phase 2 · M1：Bridge HTTP 服务（已完成并实测）

> 交付范围：只做 **M1**。`telemetry / heartbeat / commands` 是 501 占位（M3/M4 实现）；
> Lua 侧、`TheSim:QueryServer` 能力验证全部留给 M2 —— **本里程碑没有写任何 Lua 代码**。

## 1. 先行检查结果（不假设 Phase 1 已完成）

| 检查项 | 结果 |
|---|---|
| Phase 1 Lua 观察器 | `DontStarveWhaleSurvivor/scripts/main/` 7 个文件在位（json_encoder / player·inventory·world·entity_observer / state_serializer / observer_manager） |
| Phase 1 Bridge | `bridge/src/` 6 个文件在位（config / record / logTailer / store / server / index） |
| **Phase 1 测试基线（实跑）** | `node --test "tests/*.test.mjs"` → **74 passed**；`bridge/dist/test/*.js` → **22 passed** |
| Node | v24.13.1；npm 11.8.0 |
| TypeScript | 仓库内 5.9.3（`bridge/node_modules`），新项目自行装 5.x |
| 端口 8788 | ⚠️ **被占用**：PID 5164 `E:\APP\Anaconda\python.exe`（今日 08:55 启动，监听 127.0.0.1:8788） |
| 端口 18081 | 空闲（Phase 1 Bridge 用，目前没起） |
| 游戏进程 | 在跑（`dontstarve_steam_x64` + 两个 shard 进程） |

**Phase 1 事实核对（必须说清楚）**：Phase 1 的传输通道是**游戏日志**（`[BWS]` 记录 + Bridge tail），
**没有任何 HTTP**。所以 Phase 2 的 HTTP 通信是全新的东西，不是"接上已有的"。

## 2. 新增 / 修改的文件

| 文件 | 说明 |
|---|---|
| `game-bridge/package.json` | 新项目（无运行时依赖；devDeps: typescript、@types/node） |
| `game-bridge/tsconfig.json` | NodeNext + strict，`src/` → `dist/` |
| `game-bridge/src/config.ts` | 配置：默认 `127.0.0.1:18788`、随机 token（或 `BWS_TOKEN`）、token 落盘、请求体上限、协议版本 |
| `game-bridge/src/logger.ts` | INFO/WARN/ERROR 分级 + **token 脱敏**（把 secret 换成 `***`）+ 保留历史行供断言 |
| `game-bridge/src/http.ts` | 请求体读取（有上限）、**原始文本 JSON.parse（不看 content-type）**、统一 JSON 响应、request_id |
| `game-bridge/src/auth.ts` | token 校验：body / `?token=` / `Authorization: Bearer` 三种来源，`sha256 + timingSafeEqual` |
| `game-bridge/src/state.ts` | Bridge 运行态：started / connected / lastHeartbeat / session / lastSequence / queuedCommands / lastError / 请求计数 |
| `game-bridge/src/routes.ts` | 路由表：`GET /health`、`GET /api/v1/bridge/status`；四个 POST 占位返回 501 |
| `game-bridge/src/server.ts` | 路由分发 + body 解析 + token 校验 + 统一错误/边界（404/405/413/500）+ 访问日志 + `requestTimeout` |
| `game-bridge/src/index.ts` | 启动入口：EADDRINUSE 明确报错（退出码 2）、token 掩码打印、优雅退出 |
| `game-bridge/test/m1.test.ts` | 9 个用例，全部打真实 HTTP |
| `install-game-bridge.ps1` / `start-game-bridge.ps1` | 装依赖+编译+测试 / 启动（`-Port` `-Token` 可传） |
| `.gitignore` | 加 `game-bridge/node_modules/`、`game-bridge/dist/`、`.runtime/` |

**没有动** Phase 1 的任何文件（Lua 模组、`bridge/`、`schema/`、DSH 插件）。

## 3. 设计要点

1. **只绑 127.0.0.1**：`config.host` 默认值，`server.listen(port, host)` 显式传入；无 CORS、无代理。
2. **不依赖 content-type**：POST 一律 `readBody()` 取原始文本 → `JSON.parse`。这条是给 M2 的 `QueryServer` 铺路（它不能自由设请求头）。
3. **Token 三个来源**：JSON body 的 `token`（POST 主用）、`?token=`、`Authorization: Bearer`（调试用）。比较用 `sha256` 后 `timingSafeEqual`。
4. **Token 不进日志**：`createLogger({ secrets: [token] })` 统一脱敏；启动时只打印 `m1-d…89（长度 30）`。生成的 token 写 `.runtime/token.txt`（gitignore），供 M2 取用。
5. **请求体上限**：默认 128KB；超限**不 destroy**（那样客户端只会看到 `ECONNRESET`），而是丢弃剩余字节、回 413、`connection: close`。
6. **统一错误形状**：`{success:false, error:{code,message}, request_id}`；每个响应都带 `request_id`（可用 `x-request-id` 透传，便于端到端排查）。
7. **不做阻塞主线程的事**：全是异步回调；`requestTimeout=15s`、`headersTimeout=10s`，慢客户端不会挂死。
8. **频率参数留空位**：心跳 3s / 状态 2s / 轮询 1s 在 M3/M4 实现时通过配置注入，不在 M1 里硬编码定时器。

## 4. 接口（M1 实际状态）

| 方法 | 路径 | 鉴权 | M1 状态 |
|---|---|---|---|
| GET | `/health` | 否 | ✅ 实现：version / protocol_version / uptime / bound / bridge{started,connected} |
| GET | `/api/v1/bridge/status` | 是 | ✅ 实现：started / connected / connected_reason / last_heartbeat_at / session_id / last_sequence / queued_commands / last_error / requests |
| POST | `/api/v1/telemetry` | 是 | ⛔ 501 `not_implemented`（M3） |
| POST | `/api/v1/heartbeat` | 是 | ⛔ 501（M3） |
| POST | `/api/v1/commands/poll` | 是 | ⛔ 501（M4） |
| POST | `/api/v1/commands/result` | 是 | ⛔ 501（M4） |

占位路由**仍然走完整的 body 解析 + token 校验**，所以 M1 就能验证「原始文本 JSON + body 里的 token」这条链路。

## 5. 启动方法

```powershell
powershell -ExecutionPolicy Bypass -File install-game-bridge.ps1   # 装依赖 + 编译 + 跑 9 个用例
powershell -ExecutionPolicy Bypass -File start-game-bridge.ps1     # 默认 18788
powershell -ExecutionPolicy Bypass -File start-game-bridge.ps1 -Port 18788 -Token "m1-demo"
```

环境变量：`BWS_HOST`（默认 127.0.0.1）、`BWS_PORT`（18788）、`BWS_TOKEN`、`BWS_MAX_BODY_BYTES`（131072）、`BWS_TOKEN_FILE`（`.runtime/token.txt`）、`BWS_REQUEST_TIMEOUT_MS`（15000）。

## 6. 测试方法

```powershell
cd game-bridge
npm run build
node --test "dist/test/*.test.js"     # 9 个用例
```

用例覆盖：`/health` 无需 token、`bridge/status` 无 token 401 / 带 token 200（query + header 两种）、
POST 原始文本无 content-type 能解析、错 token 401、坏 JSON 400、空 body 400、超长 413、
405 / 404、只绑回环、日志分级 + token 不泄露 + request_id 透传、配置默认值。

## 7. 实际测试结果（本机实跑，2026-11-11 22:06）

### 7.1 单元测试

```
$ node --test "dist/test/*.test.js"
✔ GET /health：不需要 token，返回版本/协议/运行时长
✔ GET /api/v1/bridge/status：没 token 401，带 token 200 且字段齐全
✔ POST 原始文本 JSON（不带 content-type）：能解析、token 从 body 里取到
✔ POST 的错误分支：错 token 401、坏 JSON 400、没 body 400、超长 413
✔ 方法 / 路径不对：405 与 404
✔ 只监听 127.0.0.1（本地回环）
✔ 日志分级 + token 不出现在日志里 + request_id 透传
✔ maskToken 不泄露完整 token
✔ config：默认端口 8788 / 默认只监听 127.0.0.1 / 生成随机 token
# tests 9 / pass 9 / fail 0
```

### 7.2 端口冲突行为（默认 8788）

```
$ node dist/src/index.js          （8788 被 python 占用）
[2026-11-11T14:06:58.121Z] ERROR 端口 8788 已被占用，Bridge 起不来 {"hint":"换端口：set BWS_PORT=18788，或停掉占用该端口的进程"}
退出码: 2
```

### 7.3 真实请求（换到 18788 验收）

启动日志：

```
INFO Bridge 已启动，监听 http://127.0.0.1:18788（只本机） {"protocol_version":"1.0","version":"0.2.0-m1"}
INFO Token 已就绪（不写日志） {"token_source":"env","token_mask":"m1-d…89（长度 30）","token_file":"(使用环境变量)"}
```

1) `GET /health` → **200**

```json
{"success":true,"version":"0.2.0-m1","protocol_version":"1.0","uptime_s":3,
 "server_time":1794406030677,"bound":"127.0.0.1:18788",
 "bridge":{"started":true,"connected":false},"request_id":"req_mwc70qj9_t5z828"}
```

2) `GET /api/v1/bridge/status` 无 token → **401 Unauthorized**

3) 带 token → **200**

```json
{"success":true,"protocol_version":"1.0","server_time":1794406030728,
 "bridge":{"started":true,"connected":false,
           "connected_reason":"还没有收到过游戏端的心跳（M3 才接）",
           "last_heartbeat_at":null,"last_heartbeat_ago_ms":null,"session_id":null,
           "last_sequence":null,"queued_commands":0,"last_error":null,
           "requests":{"total":3,"unauthorized":1,"badRequests":0,"serverErrors":0}},
 "request_id":"req_mwc70qko_3nbvw2"}
```

4) `POST /api/v1/telemetry`（**原始文本、不带 content-type**，token 在 body 里）→ **501**（证明解析 + 鉴权都过了）

```json
{"success":false,"error":{"code":"not_implemented","message":"状态推送 /api/v1/telemetry 还没实现（计划在 M3/M4）"},"request_id":"req_mwc71559_ycoct9"}
```

5) 错 token → **401**；6) 请求体 140KB（上限 128KB）→ **413 payload_too_large**。

### 7.4 改端口后的默认配置实跑（不设任何环境变量）

按确认把默认端口改成 **18788**（原定 8788 被本机 python 占用）。重新编译后**不带任何环境变量**启动：

```
INFO Bridge 已启动，监听 http://127.0.0.1:18788（只本机） {"protocol_version":"1.0","version":"0.2.0-m1"}
INFO Token 已就绪（不写日志） {"token_source":"generated","token_mask":"2f5c…51（长度 64）",
     "token_file":"E:\\…\\.runtime\\token.txt"}
INFO 请求体上限 131072 字节；接口：GET /health、GET /api/v1/bridge/status（其余 M3/M4 实现）
```

- `GET /health` → 200，`"bound":"127.0.0.1:18788"`
- `.runtime/token.txt` 生成成功（64 hex），用文件里的 token 访问 `/api/v1/bridge/status` → 200
- 断言 `日志里是否出现 token` → **False**（脱敏生效）
- 改端口后单元测试仍 **9/9 通过**

## 8. 未解决 / 需要你决定

1. **端口已定案**：原定 8788 被本机 python 进程（PID 5164，`E:\APP\Anaconda\python.exe`）占用,
   经确认改为默认 **18788**（代码默认值、启动脚本、文档已全部同步；那个 python 进程没动）。
2. **M2 的核心不确定性还没验证**：`TheSim:QueryServer` 在本机 build 762172 上是否真能访问 `127.0.0.1`、GET/POST 是否可用、回调能否拿到状态码与响应体 —— 这必须实际进游戏验证，我不会因为"社区有人这么做"就当成可用。M2 会按你给的顺序做独立验证，并准备降级方案（unsafedata 文件交换 / Phase 1 日志通道）。
3. **M1 里 `connected` 恒为 false**：这是如实反映（还没有心跳接口），不是 bug。

## 9. 提交

见 git 提交 `feat(phase2): M1 —— Bridge HTTP 服务（路由/Token/原始文本 JSON/健康检查）+ 9 个实跑用例`。
