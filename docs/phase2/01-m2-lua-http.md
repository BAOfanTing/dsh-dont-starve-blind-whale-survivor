# Phase 2 · M2：Lua 调本地 HTTP（`TheSim:QueryServer` 能力验证）

> 结论：**本机 build 762172 的 `TheSim:QueryServer` 可以访问 `127.0.0.1`，GET/POST 都可用，
> 回调能拿到状态码与响应体，POST 能携带 JSON 请求体，Bridge 重启后能自动重连。**
> 全部结论来自真实游戏进程里的探针日志，不是社区传闻。

## 1. 先查源码（不猜 API）

762172 的 `scripts.zip` 里 `QueryServer` 的用法：

```
mainscreen.lua:482          TheSim:QueryServer(url, callback, "GET")
motdmanager.lua:496         TheSim:QueryServer(url, function(motd_json, isSuccessful, resultCode) ... end)
emailsignupscreen.lua:126   TheSim:QueryServer(query, callback, "POST", json.encode({ birthday = ... }))
```

得到的签名：

```lua
TheSim:QueryServer(url, callback, method, data)
    callback(response_text, isSuccessful, resultCode)
```

- `method`：`"GET"` / `"POST"`
- `data`：POST 的**请求体字符串**（GET 传 nil）
- **不能自定义请求头** → token 只能放请求体或查询串，Bridge 端因此不依赖 `content-type`

## 2. 新增 / 修改的文件

| 文件 | 说明 |
|---|---|
| `DontStarveWhaleSurvivor/scripts/main/http_client.lua` | HTTPClient：串行队列（同时最多 1 个请求）、自实现超时、指数退避留位、统一回调形状 |
| `DontStarveWhaleSurvivor/scripts/main/config.lua` | 读 `BWS_CONFIG`（由生成文件提供）合并默认值：baseUrl / token / 各频率 / 超时 |
| `DontStarveWhaleSurvivor/scripts/main/probe.lua` | M2 探针：A~E 五项验证，结果同时打 `[BWS2]` 日志（HTTP 全挂也能诊断） |
| `DontStarveWhaleSurvivor/modmain.lua` | `pcall(modimport, "bws_config.lua")` + 三个新模块；服务端且 `probe=true` 时启动探针 |
| `tools/write-bws-config.mjs` | 生成 `bws_config.lua`（含 token，不进仓库；token 复用 `.runtime/token.txt`） |
| `game-bridge/src/routes.ts` | 新增 `POST /api/v1/probe`（鉴权，回显收到的 body 结构，不回显 token） |
| `game-bridge/src/config.ts` | token 改为**复用** `.runtime/token.txt`（Bridge 重启后 token 不变） |
| `tests/phase2-modules.test.mjs` | 8 个用例：在**模拟沙箱**（`pcall/tonumber/os/io` 全 nil）里加载并跑通三个模块 |

**为什么 token 用「生成的 Lua 文件」传**：mod 沙箱没有 `io`，读不了任意文件；而 `modimport` 能加载
`MODROOT` 下的 `.lua`。所以让 Bridge 侧生成一个只做赋值的小文件是最干净的做法（不碰 sandbox、不搞 socket）。

## 3. 五项验证结果（真实日志）

`master_server_log.txt` 里的 `[BWS2]` 行，逐条对应任务书要求：

### A. Lua 能否访问 127.0.0.1 / API 是否存在

```json
{"step":"api_query_server","pass":true,"has_thesim":true,"type_of_queryserver":"function",
 "base_url":"http://127.0.0.1:18788","token_configured":true,"side":"server","shard":"master"}
```

### B. GET 是否成功、回调能否拿到状态码 + 响应内容

```json
{"step":"get_health","method":"GET","path":"/health","ok":true,"status":200,"expected":200,"pass":true,
 "elapsed_ms":0,
 "body_head":"{\"success\":true,\"version\":\"0.2.0-m1\",\"protocol_version\":\"1.0\",\"uptime_s\":847,
 \"server_time\":1794407485426,\"bound\":\"127.0.0.1:18788\",\"bridge\":{\"started\":true,\"connected\":false}}…(210 字节)"}
```

→ 拿到 **200 + 完整响应体**（210 字节，被 `body_head` 截断显示）。

### C. POST 能否发送请求体（含中文）

```json
{"step":"post_probe","method":"POST","path":"/api/v1/probe","ok":true,"status":200,"pass":true,
 "body_head":"{\"success\":true,\"protocol_version\":\"1.0\",…,\"received\":{\"is_object\":true,
 \"token_present\":true,\"keys\":[\"echo\",\"client\",\"ts\"],\"echo\":\"大肥鱼 M2 探测\",…}}…(228 字节)"}
```

→ 服务端 `received.keys = ["echo","client","ts"]`（`token` 被服务端主动排除），
`echo` 原样回显中文「大肥鱼 M2 探测」——**UTF-8 双向都没问题**。

### D. token 鉴权是否生效

```json
{"step":"post_no_token",  "status":401,"expected":401,"pass":true}   // 请求体里没有 token
{"step":"post_bad_token", "status":401,"expected":401,"pass":true}   // token 是错的
```

→ POST 请求体**确实送达**（否则服务端不会返回 401 而是 400），且鉴权拦截生效。

### E. 大请求体

```json
{"step":"post_big_body","status":413,"expected":413,"pass":true,
 "body_head":"{\"success\":false,\"error\":{\"code\":\"payload_too_large\",\"message\":\"请求体超过上限 131072 字节\"}}"}
```

→ 150KB 请求体被 Bridge 以 **413** 拒绝（上限 128KB），说明大 body 能送达、限制也生效。

### 汇总

```json
{"step":"summary","pass":true,"http":{"sent":5,"ok":5,"failed":0,"timeout":0,"dropped":0,"queued":0}}
```

## 4. 服务重启后能否重连（实测）

Bridge 被**手动杀掉 12 秒再重启**，游戏端（游戏一直在跑）每 10 秒的 `repeat_health`：

```
status=200  (restart 前)
status=0    ← 这段时间 Bridge 不在：ok=false, error="transport_failed"
status=200  ← Bridge 起来后自动恢复，无需重启游戏/模组
status=200 …
```

→ **断开后能自己恢复**（连接管理留在 M3 的心跳/重连里做策略，这里是底层能力已确认）。

## 5. 实机发现的两个「想当然」（已修）

| 发现 | 说明 | 处理 |
|---|---|---|
| **`isSuccessful` 不等于 HTTP 成功** | 401 / 413 时 `isSuccessful` 仍是 `true`，只有连接失败（`resultCode=0`）才是 `false`。所以「成功」必须看状态码 | `ok = transport_ok and 200 <= status < 300`；连接失败单独标 `error="transport_failed"` |
| **`elapsed_ms` 精度是整秒** | 我一开始用 `os.time()`（整秒）算耗时，日志里全是 `0` / `2000` | 改用 `TheSim:GetRealTime()`（毫秒），`os.time()` 只作兜底 |
| 另：`x and nil or y` 的 Lua 坑 | `error = ok and nil or 'http_'..code` 在 ok 时也会返回字符串 | 改成显式 if 分支 |

## 6. 事故记录（必须写下来）

第一次装 M2 代码后**进不了世界**，客户端提示「专用服务器无法启动」。日志：

```
error calling gamepostinit in mod DontStarveWhaleSurvivor:
  probe.lua:164: attempt to call global 'tonumber' (a nil value)
Disabling DontStarveWhaleSurvivor because it had an error.
```

根因：新增的三个 Lua 文件**忘了沙箱兼容头**（mod 环境没有 `tonumber`/`pcall`/`os`/`io`，
必须从 `GLOBAL` 取）。模组被判定 MOD ERROR → 被游戏禁用 → 世界起不来。

修复：

1. 三个文件统一加兼容头；
2. `probe.start` 整体再包一层 `pcall`（探针只是诊断工具，任何异常都不许把模组带崩）；
3. **补了沙箱回归测试** `tests/phase2-modules.test.mjs`：把 `pcall/tonumber/os/io` 全置 nil 再加载三个模块并跑通，
   这类错以后本地就能拦住。

## 7. 运行 / 测试

```powershell
# 1) 生成游戏端配置（含 token；token 复用 .runtime/token.txt）
node tools/write-bws-config.mjs --port 18788 --repeat 10 --repeat-count 30

# 2) 装模组进游戏
node tools/install-mod.mjs

# 3) 起 Bridge（端口 18788）
powershell -ExecutionPolicy Bypass -File start-game-bridge.ps1

# 4) 进游戏读档 → 6 秒后自动跑探针；看日志
$k="C:\Users\BAOfanTing\OneDrive\文档\Klei\DoNotStarveTogether"
Get-Content "$k\master_server_log.txt" -Encoding UTF8 | Where-Object { $_ -match '\[BWS2\]' }
```

单元测试（不需要游戏）：`node --test tests/phase2-modules.test.mjs` → 8 例。

## 8. 边界与遗留

- **本里程碑只验证通信能力**：`telemetry / heartbeat / commands/*` 仍是 501 占位，M3/M4 才实现。
- **没有任何游戏动作**：探针只发 HTTP，不操作角色。
- QueryServer **没有超时参数**，超时由我们自己的 `DoTaskInTime` 计时（本机 5 次请求都在 1 秒内返回，超时分支未被触发过）。
- 不能自定义请求头 → 以后所有鉴权/元信息都走请求体或查询串。
- token 通过 `bws_config.lua` 交付；该文件已 gitignore，但**它会随模组文件夹复制**到游戏目录
  （本机工具场景可接受；若以后分发模组，需要改成运行时配对）。
- 探针每次进世界都会跑一遍（延迟 6 秒），后续阶段会换成正式的心跳/状态推送。
- 观察到的世界进入耗时：`probe_scheduled` → 真正发请求间隔约 50 秒（读档 + 世界加载），
  说明 **DoTaskInTime 会被世界加载推迟**，M3 的心跳首包不能假设"进世界即发"。

## 9. 本里程碑测试计数

| 套件 | 用例数 | 结果 |
|---|---|---|
| Lua / DSH 插件侧（含 Phase 2 模块沙箱测试） | 82 | 全过 |
| Phase 1 Bridge | 22 | 全过 |
| Phase 2 game-bridge（M1） | 9 | 全过 |
