# 里程碑 7：TypeScript Bridge

> 把游戏日志里的 `[BWS]` 记录读出来（增量 tail）→ 按 schema 校验 → 合并成一份快照 → 用 REST 对外提供。
> 只读，不操作游戏。

## 1. 文件

```
bridge/
├─ package.json          ajv / typescript / @types/node；scripts: build / start / test
├─ tsconfig.json         NodeNext + strict，源码在 src/、测试在 test/，输出 dist/
├─ src/
│  ├─ config.ts          日志目录自动发现 + 全部参数可用环境变量覆盖
│  ├─ record.ts          从日志行抽 [BWS] 记录 + ajv 校验
│  ├─ logTailer.ts       增量 tail（半截行 / 轮转 / 缺文件 / 回填对齐）
│  ├─ store.ts           按分片（session）存快照，合并 state+nearby
│  ├─ server.ts          7 个 REST 接口
│  └─ index.ts           装配 + 启动 + 优雅退出
└─ test/                 4 个测试文件，22 个用例
```

根目录新增：`install-bridge.ps1`（装依赖 + 编译 + 跑测试）、`start-bridge.ps1`（启动）。

## 2. 为什么这么设计

| 问题 | 做法 |
|---|---|
| 日志在 OneDrive 下，`fs.watch` 不可靠 | **轮询**（默认 300ms）+ 自己记 `offset` |
| 可能读到半行 | 按字节切 `0x0A`，未成行的留在 `buffer` 等下一段（**按字节**切，避免多字节中文被切坏） |
| 游戏重开/日志被清空 | `size < offset` → 判定轮转，offset 归零重读并计数 |
| 游戏还没启动 | 文件缺失标 `missing`，出现后自动开始读 |
| 启动时日志里已有内容 | 回填最后 1MB，并**丢掉回填造成的首半行** |
| 日志每行 ~3.9K 会被截断 | 解析失败单独计数（`parseFails`），不当致命错误；没有 `[BWS]` 标记的普通行不算失败 |
| 同一行被重复读到 | 每个分片一个去重集合，`session+tick+type` 只算一次 |
| **Master 和 Caves 两个进程都在发状态** | 按 session 分别存快照；对外**优先给"有玩家"的那个**，避免空洞穴顶掉主世界 |
| 客户端记录不权威 | 只采信 `side === "server"` |
| 老版本 tick 位置不同 | `tick = record.tick ?? record.observer.tick` |

## 3. 接口

| 接口 | 说明 |
|---|---|
| `GET /health` | 进程/日志/记录统计，永远 200 |
| `GET /api/game/status` | 连接状态：`connected`、`lastRecordAgoMs`、`session/shard/tick`、`restarts`、按分片的明细 |
| `GET /api/game/state` | 合并后的完整快照（符合 `schema/state.schema.json` 的 `$defs.GameState`） |
| `GET /api/game/player` | 仅 `player` 段 |
| `GET /api/game/inventory` | 仅 `inventory` 段 |
| `GET /api/game/world` | 仅 `world` 段 |
| `GET /api/game/nearby` | 仅 `nearby` 段 |

没有数据时返回 **503 + 原因**（不是 200 + null）；非 GET 返回 405；未知路径 404 并列出可用接口。

## 4. 参数（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `BWS_LOG_DIR` | 自动找 | Klei 存档目录（`…\Klei\DoNotStarveTogether`） |
| `BWS_LOG_FILES` | `master_server_log.txt,caves_server_log.txt` | 跟哪些日志 |
| `BWS_INCLUDE_CLIENT` | 不跟 | 设 `1` 也跟 `client_log.txt`（默认不跟：客户端数据不权威） |
| `BWS_PORT` / `BWS_HOST` | 18081 / 127.0.0.1 | 只监听本机 |
| `BWS_POLL_MS` | 300 | 轮询间隔 |
| `BWS_MAX_TICK_GAP` | 3 | state 与 nearby 配对允许的 tick 差 |
| `BWS_SCHEMA` | 仓库里的 schema | 契约路径 |

## 5. 运行 & 测试

```powershell
powershell -ExecutionPolicy Bypass -File install-bridge.ps1   # 装依赖 + 编译 + 跑 22 个用例
powershell -ExecutionPolicy Bypass -File start-bridge.ps1     # 启动（默认 18081）
```

浏览器或 curl：

```powershell
curl http://127.0.0.1:18081/health
curl http://127.0.0.1:18081/api/game/status
curl http://127.0.0.1:18081/api/game/state
```

单元测试（不需要游戏）：

```powershell
cd bridge
npm run build
node --test "dist/test/*.test.js"
```

## 6. 实机验证结果（对着你正在跑的游戏）

启动后 4 秒内的 `/health`：

```
master_server_log.txt：768 行 → 79 条记录，parseFails 0，rotations 0
caves_server_log.txt ：632 行 → 41 条记录，parseFails 0
store：boot 2 / state 79 / nearby 39 / invalid 0 / duplicates 0
connected: true（最近记录 3.8 秒前）
```

`/api/game/status` 列出两个分片，并正确选了主世界：

```
shard=master session=0DEB4… tick=39 hasPlayer=true
shard=caves  session=07904… tick=40 hasPlayer=false   ← 没人，不顶掉主世界
```

`/api/game/state`（用 schema 的 `GameState` 校验**通过**）：

```
玩家 薇洛 tile(4,-16) 饿 60.2 血 150
装备 hands: {"prefab":"lighter","name":"薇洛的打火机","fuel":87.1}
世界 第 2 天 dusk autumn 温度 29.4
nearby 28/150 条 counts {tree:10, diggable:10, item:7, harvestable:5, creature:5, rock:1, damageable:2}
      前几条：常青树(4,-14) d=1.2 / 草(3,-14) d=1.4 / 种子(3,-15) d=1.5
```

（`草` 已经是 `harvestable`，说明里程碑 5 的分类修正在真实数据上生效。）

## 7. 已知限制

- 只 tail 文件，**不支持远程/联机服务器**（别人的服务器日志拿不到）。
- 记录是「最新快照」，不保留历史序列；要历史得在旁边加环形缓冲（Phase 2）。
- 日志被 Steam/OneDrive 整文件替换时，最多丢一次轮询间隔内的内容。
- 端口固定监听 127.0.0.1，没有鉴权（本机工具，Phase 1 不引入账号体系）。
