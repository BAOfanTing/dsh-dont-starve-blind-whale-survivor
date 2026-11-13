# 里程碑 2：最小 Lua Mod（加载检测 + 日志输出）

> 阶段定位：**只读观察**。这一步不读玩家/背包/实体，只证明「模组能加载、能按周期打结构化日志」，
> 让后面的观察器和 TypeScript Bridge 有一个确定的地基。

## 1. 本里程碑新增/修改的文件

| 文件 | 动作 | 作用 |
|---|---|---|
| `DontStarveWhaleSurvivor/scripts/main/json_encoder.lua` | 新增 | JSON 编码（游戏自带那个 encode 不合规范，日志里会被解析坏） |
| `DontStarveWhaleSurvivor/scripts/main/observer_manager.lua` | 新增 | 观察器管理器：boot 行 + 周期 heartbeat 行 |
| `DontStarveWhaleSurvivor/modmain.lua` | 修改 | `modimport` 上面两个文件；`AddGamePostInit` / `AddPlayerPostInit` 里 `BWS.observer.Start()` |
| `DontStarveWhaleSurvivor/modinfo.lua` | 修改 | 新增 `OBSERVER_INTERVAL`（默认 2 秒）；版本 0.3.0 |
| `tests/phase1-observer.test.mjs` | 新增 | 用真 Lua 虚拟机 + 沙箱规则（无 pcall/tonumber/os/io）跑这两个文件 |

## 2. 实现原理

### 2.1 为什么用日志当传输

Phase 1 的数据通道是**游戏日志**：

模组 `print("[BWS] " .. json)` → 引擎在每行前面加 `[hh:mm:ss]: ` → 落到
`<Klei>\DoNotStarveTogether\master_server_log.txt`（地面世界）或 `caves_server_log.txt`（洞穴）。

Bridge 只需要按 `[BWS] ` 标记截取后面的内容就能拿到结构化数据，不需要写文件、不需要端口。

实测的日志行长这样（来自本机 `master_server_log.txt`）：

```
[00:00:27]: [大肥鱼饿不死] 文件桥已启动（服务端）：写 whale_state.json
```

### 2.2 两条日志

| type | 时机 | 作用 |
|---|---|---|
| `boot` | 世界就绪、观察器启动时（一次） | 证明模组加载成功；说明跑在哪一端、哪个分片、采样间隔 |
| `heartbeat` | 每 `OBSERVER_INTERVAL` 秒 | 保活 + 给 Bridge 的最小解析样本（玩家数、天数、昼夜、季节） |

### 2.3 三条硬约束

1. **单行 JSON**：一行一条，不跨行。Bridge 只认 `[BWS] ` 之后的内容，半截行会被丢掉。
2. **全部 pcall**：编码/打印出错只记账（`errors` 字段），不让异常冒进游戏主线程。
3. **沙箱适配**：mod 环境只有 `pairs/ipairs/print/math/table/type/string/tostring/require/Class`，
   `pcall / tonumber / error / os / io` 一律从 `GLOBAL` 取（`GLOBAL` 就是引擎的 `_G`）。

### 2.4 不在主线程做耗时的事

本里程碑只读 4 个世界字段 + 数一下玩家个数（`pairs(AllPlayers)`），单次开销可忽略；
真正会扫实体的 `entity_observer`（里程碑 5）会自己控制半径、上限和周期，不会挂在 `OnUpdate` 上。

## 3. 字段来源（每个 JSON 字段都能对应到真实 API）

### boot

| 字段 | 来源 |
|---|---|
| `schema_version` | 常量 `"1"`（协议版本） |
| `type` | 常量 `"boot"` |
| `phase` | 常量 `1`（Phase 1） |
| `observer_version` | 常量 `"0.1.0"` |
| `side` | `TheWorld.ismastersim` → `server` / `client` |
| `shard` | `TheWorld:HasTag("cave")` → `caves` / `master` |
| `t` | `GLOBAL.os.time()`（unix 秒） |
| `rt` | `TheSim:GetRealTime() / 1000`（真实秒） |
| `session` | `TheNet:GetSessionIdentifier()` |
| `mod` | mod 环境变量 `modname` |
| `ismastersim` | `TheWorld.ismastersim` |
| `interval` | `GetModConfigData("OBSERVER_INTERVAL")`，夹在 0.5~30 |
| `players.count` / `.valid` / `.prefab` | `AllPlayers` 遍历 + `ent:IsValid()` + `ent.prefab` |
| `world.day` / `.phase` / `.season` / `.temperature` | `TheWorld.state.cycles / .phase / .season / .temperature` |

### heartbeat

| 字段 | 来源 |
|---|---|
| `tick` | 观察器自己的计数 |
| `errors` / `last_error` | 观察器内 `pcall` 累计 |
| 其余 | 同 boot |

## 4. 运行方式

**正常方式**：DSH 插件会自动把模组装进游戏（本机已装好 v0.3.0）：

```
E:\SteamLibrary\steamapps\common\Don't Starve Together\mods\DontStarveWhaleSurvivor
```

手动装/更新：

```powershell
cd E:\Cache\XinLuguWuyu\dsh-dont-starve-blind-whale-survivor
node tools/install-mod.mjs
```

## 5. 测试方法（需要你进游戏）

1. 保存并退出当前世界 → 退回桌面 → **完全退出游戏**（模组只在启动时加载）。
2. 重新启动游戏，读档进世界（模组列表里保持「大肥鱼饿不死」勾选）。
3. 进世界后等 10 秒，然后跟我说一声——我会跑下面这条命令，把最近的 `[BWS]` 行抓出来：

```powershell
$k = "C:\Users\BAOfanTing\OneDrive\文档\Klei\DoNotStarveTogether"
Get-Content "$k\master_server_log.txt" -Tail 200 -Encoding UTF8 | Where-Object { $_ -match '\[BWS\]' } | Select-Object -Last 6
```

你自己看也一样。**期望看到**（间隔 2 秒一条 heartbeat）：

```
[00:03:12]: [BWS] {"schema_version":"1","type":"boot","phase":1,"observer_version":"0.1.0","side":"server","shard":"master","t":1794410000,"rt":12.5,"sim_tick":777,"session":"...","mod":"BlindWhaleSurvivor","ismastersim":true,"interval":2,"players":{"available":true,"count":1,"valid":true,"prefab":"wilson"},"world":{"day":3,"phase":"day","season":"autumn","temperature":12.5}}
[00:03:14]: [BWS] {"schema_version":"1","type":"heartbeat","phase":1,"observer_version":"0.1.0","side":"server","shard":"master","t":1794410002,"gt":14.5,"session":"...","tick":1,"interval":2,"players":{"available":true,"count":1,"valid":true,"prefab":"wilson"},"world":{"day":3,"phase":"day","season":"autumn","temperature":12.5},"errors":0}
```

> 字段顺序不固定（Lua 的 table 遍历顺序），只要键值对得上就行。

如果你下洞穴，对应的是 `caves_server_log.txt`（`"shard":"caves"`）。

## 6. 通过标准（我来判定，你也可以自己核对）

- [ ] `master_server_log.txt` 里出现 `[BWS]{"type":"boot"...}` 且 `"side":"server"`、`"mod":"BlindWhaleSurvivor"`
- [ ] boot 之后每 2 秒一条 `"type":"heartbeat"`，`tick` 递增
- [ ] `players.count` 等于当前在线玩家数（单人应该是 1），`valid:true`
- [ ] `world.day / phase / season / temperature` 与游戏画面上的信息一致
- [ ] 没有 `"type":"error"` 行，`errors` 一直是 0

## 7. 本地已做的验证（不用进游戏就能跑的）

```powershell
cd E:\Cache\XinLuguWuyu\dsh-dont-starve-blind-whale-survivor
node --test tests/phase1-observer.test.mjs
```

4 个用例，覆盖：JSON 编码（中文/换行/引号/数组/嵌套/布尔/nil）、boot+heartbeat 字段、
世界未就绪时 `Start()` 返回 false、`AllPlayers` 缺失时不崩。全项目 56 个测试也全过。

## 8. 已知限制

- 客户端也会启动观察器（`"side":"client"`，日志在 `client_log.txt`），但客户端数据不是权威的；
  Bridge 只采信 `side=server` 的行。
- 日志时间戳是**游戏内经过时间**（`[00:03:12]` 是这局开了多久），不是系统时间；真实时间看 `t` 字段。
- 采样间隔最小 0.5 秒；这一阶段不追求实时，只保证数据准确。
- Phase 1 目前还没有 `state_serializer`（里程碑 6 统一成 `player/inventory/world/nearby` 结构），
  所以 boot/heartbeat 的字段会再整理一次，`schema_version` 会用来标记变化。
