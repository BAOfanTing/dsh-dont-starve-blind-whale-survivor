# M0 · 饥荒 API 与通信能力验证报告

> 审计对象：`dsh-dont-starve-blind-whale-survivor`（当前工作区）
> 验证对象：本机真实安装的《饥荒联机版》**build 762172**
> 游戏目录：`E:\SteamLibrary\steamapps\common\Don't Starve Together`
> 存档目录：`C:\Users\BAOfanTing\OneDrive\文档\Klei\DoNotStarveTogether\893016408`
> 原则：**只写有出处的结论**。每条结论标明来源等级：
>
> - `[源码]` = 从 `data/databundles/scripts.zip`（4109 个条目）里读到的引擎脚本
> - `[实测]` = 本仓库已有的真机日志/磁盘产物（Phase 1~6 留下的证据），本轮复核过
> - `[参考 sei]` = 来自参考项目 `sei-studio/sei` 的 Lua mod 源码与 `native/dst-mod/PROTOCOL.md`（**别人的实测，不是我们的**）
> - `[未验证]` = 目前没有证据，M1 必须进游戏验证
>
> 本轮**没有启动游戏**，所以没有新增真机数据；`[实测]` 全部是对既有产物的复核，不是新结论。

---

## 0. 一句话结论

| 能力 | 结论 | 等级 |
|---|---|---|
| `TheSim:QueryServer`（GET/POST/回调/状态码/请求体） | **可用**，本机 build 实测通 | `[实测]` |
| QueryServer 自定义请求头 | **不可用**（API 没有这个参数） | `[源码]` |
| QueryServer 超时参数 | **没有**，必须自己计时 | `[源码]`+`[实测]` |
| QueryServer 并发/请求体上限 | 只知道「串行 1 并发、150KB 能送达」；外部参考里建议 body < ~20KB | `[实测]`+`[参考 sei]` |
| QueryServer 有界长轮询 | **外部项目在用**（hold 400ms 再回空数组），不是我们验的 | `[参考 sei]` |
| `TheSim:SetPersistentString` 通道 | **可用**，落存档目录，分片各一份 | `[源码]`+`[实测]` |
| `io.open` 写文件 | 本机 build **实测能写 bin64**；但官方 `unsafedata_readme.txt` 说只允许写 `unsafedata/` | `[源码]`+`[实测]`（存在冲突） |
| 模组里开 HTTP 端口（socket 服务器） | **不可用**，沙箱没有网络监听 API | `[源码]` |
| 用 `BufferedAction` + `locomotor:PushAction` 做原生动作 | **可用**，已有真机走位/采集证据 | `[实测]` |
| 独立 AI 幸存者实体（ownerless 玩家 prefab） | **技术上可行**：外部项目用 `SpawnPrefab("wilson")` 直接生成「无主幸存者」，全套玩家组件自带；但有 5 个必须打的补丁 | `[参考 sei]`+`[未验证]` |
| 日志通道单行长度 | 约 **3.9K 字符被引擎截断** | `[实测]` |

**因此在 M1 之前，通信和阿动作用「已验证的两条现实通道」就能开工；唯一必须先做技术验证的是「AI 用什么身体」这件事。**

---

## 1. 通信：`TheSim:QueryServer`

### 1.1 签名（来自引擎脚本，不是传闻）

`[源码]` 在 build 762172 的 `scripts.zip` 里，`QueryServer` 只出现在 7 个文件：

```
scripts/screens/multiplayermainscreen.lua:947, 1104, 1161
scripts/screens/mainscreen.lua:482
scripts/screens/redux/optionsscreen.lua:1347
scripts/screens/redux/purchasepackscreen.lua:587
scripts/motdmanager.lua:496
scripts/screens/emailsignupscreen.lua:126
scripts/lavaarena_communityprogression.lua:338, 441
```

其中 `emailsignupscreen.lua:126` 是唯一的 POST 用法，带 JSON 请求体；`motdmanager.lua:496` 的回调签名最完整：

```lua
TheSim:QueryServer(url, callback, method, data)
    callback(response_text, isSuccessful, resultCode)
```

- `method`：`"GET"` / `"POST"`（字符串）
- `data`：POST 的请求体字符串（GET 传 `nil`）
- **没有 headers 参数** → token / 元信息只能放进 URL 查询串或请求体
- 全部官方调用点都是 **客户端**（主菜单、MOTD、商城）。服务端可用性是靠本仓库的真机探针证明的，不是靠源码。

### 1.2 真机验证结果（Phase 2 M2，`docs/phase2/01-m2-lua-http.md`）

`[实测]` 五项探针全过（`master_server_log.txt` 里的 `[BWS2]` 行）：

| 项 | 结果 |
|---|---|
| API 存在 | `type(TheSim.QueryServer) == "function"`，`side=server`，`shard=master` |
| GET | `200` + 完整响应体（210 字节，`body_head` 截断显示） |
| POST | `200`，服务端收到 `keys=["echo","client","ts"]`，**中文 UTF-8 双向正常** |
| 鉴权 | 无 token / 错 token → `401`（说明请求体确实送达） |
| 大请求体 | 150KB → 服务端返回 `413`（说明大 body 能送达，拒绝是业务策略） |

### 1.3 五个「想当然」的坑（已踩过，必须写进设计）

1. **`isSuccessful` 不等于 HTTP 成功**。401 / 413 时 `isSuccessful` 仍是 `true`；只有连接失败才是 `false`（`resultCode=0`）。
   → 判成功必须用 `transport_ok and 200 <= status < 300`。
2. **回调没有超时参数**。本仓库做法：`DoTaskInTime` 自己计时（实测 5 次请求都在 1 秒内返回，超时分支没被触发过）。
   → 超时值只能是「保守的猜」，M1 要在坏网络/游戏卡顿时再验一次。
3. **`elapsed_ms` 精度**：`os.time()` 是整秒（日志里全是 0/2000），要用 `TheSim:GetRealTime()`。
4. **`x and nil or y` 在 Lua 里会踩**：`error = ok and nil or "http_"..code` 在 ok 时也会返回字符串。要么显式 if。
5. **不能自定义请求头** → Node 端**不许依赖 `content-type`**，一律 `readBody()` 拿原始文本再 `JSON.parse`（`game-bridge/src/http.ts`、`validate.ts`、`auth.ts` 都已经按这个写死）。

### 1.4 并发与体量（真实边界不清楚，但已知部分够用）

| 问题 | 现状 |
|---|---|
| 同时能发几个请求 | `[实测]` 本仓库 `http_client.lua` **自己限成串行 1 个**（队列），从未测过并行 → **真实并发上限未知** `[未验证]` |
| 单次请求体上限 | `[实测]` 150KB 能送达；引擎侧上限未知 `[未验证]` |
| 单次响应体上限 | `[未验证]`；目前观察到的响应都是几百字节 |
| 长轮询（挂住不回） | `[未验证]`，**不要假设**，M1 之前一律用短轮询 |
| 分片（caves shard）能否用 | `[未验证]`；目前 `net.start` 只在 `master` 跑 |

### 1.5 断线恢复（已实测）

`[实测]` 杀掉 Bridge 12 秒再重启，游戏端请求序列：`200 → 0(transport_failed) ×N → 200`，**不需要重进世界**。

### 1.6 启动时序的坑

`[实测]` `AddGamePostInit` 里挂的 `DoTaskInTime` 会被读档/世界加载推迟：`probe_scheduled → 首个请求` 实测间隔约 **50 秒**。
→ 心跳首包不能假设「进世界即发」，Agent 侧要有「等游戏就绪」的状态机。

### 1.7 外部参考项目的实测数字（`[参考 sei]`）

参考项目 `sei-studio/sei` 的 `native/dst-mod/PROTOCOL.md` 把 QueryServer 用到了极致，且把「为什么这么设计」写进了文档。这些数字**不是我们的实测**，但比自己猜要靠谱，M1 应当逐条复测：

| 项 | sei 的结论 | 对我们的意义 |
|---|---|---|
| 唯一网络出口 | `TheSim:QueryServer(url, cb, method, body)`；只能打 `localhost/127.0.0.1`；**没有 header、没有 content-type** | 与本仓库 `[实测]` 一致 |
| body 体量 | **建议 < ~20KB**（8KB 是他们的观测帧预算） | 状态要**分段/压缩**，别指望一次发几万字 |
| 鉴权 | token 只能挂 **query string**（`?t=<token>`） | 比 body 更省字节；本仓库走 body 也行，两者择一 |
| 长轮询 | **可用**：`GET /cmd?since=N` 挂 **400ms** 再回 `{"cmds":[]}`；单飞；失败退避 1s | 能把命令延迟从 300ms 降到 ~100ms，**M2 值得做** |
| 命令 ack | `since` = 已处理的最大 seq，`<= since` 永不再发 | 幂等比「单槽 `last_cmd_id`」可靠得多（本仓库现在的去重是单槽，见 §2.4） |
| 失败阈值 | 连续 8 次传输失败 → 认为 runtime 已死 → 主动 despawn 身体 | 「AI 死了不留一具没脑子的尸体」这条要抄 |
| 定时器 | 用 `DoStaticPeriodicTask`（墙钟）而不是 sim 时间：sim 时间的 task 在服务器自动暂停时会停 | 与本仓库 `[实测]`「游戏暂停 ≠ 链路故障」是同一件事 |
| 端口发现 | 固定候选端口区间 `27424..27428`，Node 抢第一个空闲的，mod 全探一遍并用 `app:"sei"` 字段拒绝陌生人 | 比 token 文件更适合分发型模组；我们本地开发用固定端口就够 |

> 结论：本仓库的「串行 + 自实现超时 + 请求体鉴权」是**够用的最小实现**；sei 证明「长轮询 + since 序号」也在这个沙箱里成立，这是 M2 的升级方向，不是 M1 的阻塞项。

### 1.8 2025 年 Klei 的本地访问策略

任务书里提到「2025 年更新后模组可以访问 localhost / 127.0.0.1」。本轮**无法从引擎脚本里读出这条策略**（它是引擎 C++ 层的地址白名单），只能给出两条客观事实：

- `[实测]` 在 build 762172 上，`http://127.0.0.1:18788` 是**通的**（GET/POST 都通）。
- `[未验证]` 换成 `http://localhost:18788`、或者访问局域网 IP，是否通 —— 没测过。**默认只走 `127.0.0.1`，不要试局域网。**

---

## 2. 文件通道（当前 DSH 插件走的就是这条）

### 2.1 两条子通道，模组侧「双写」

`[源码]` `DontStarveWhaleSurvivor/scripts/whale/bridge.lua:71-91`：

```lua
ps_write: TheSim:SetPersistentString(name, text, false)      -- 通道 1
io_write: io.open(name, "w") / file:write(text)              -- 通道 2
write_both(name, io_name, text)                              -- 两条都写
```

### 2.2 `SetPersistentString` 的签名与落点

- `[源码]` 签名：`TheSim:SetPersistentString(filename, data, encode, callback)`；读：`TheSim:GetPersistentString(filename, function(success, data) ... end)`
  （出处：`scripts/util/savedata.lua`、`scripts/generickv.lua`、`scripts/saveindex.lua` 等 19 个引擎脚本）
- `[实测]` 落点（本机真实文件）：
  - 服务端：`<Klei>\<userid>\Cluster_1\Master\save\whale_state.json`
  - 客户端：`<Klei>\<userid>\client_save\whale_cmd.json`
  - **洞穴分片也有独立一份**：`Cluster_1\Caves\save\whale_state.json`

> ⚠️ **分片问题（当前实现的隐患）**：`Master` 和 `Caves` 各写一份 `whale_state.json`，而 Node 侧按「最新 mtime」挑文件 → 两个分片会互相盖掉对方的状态。M1 必须在文件名或 payload 里带 `shard` 并在 Node 侧过滤（`scripts/main/` 那套旧实现里已有 shard 过滤逻辑，`git log` 里的 `eddf43b`/`e9e64c9` 提交就是在修这个）。

### 2.3 `io.open` 的限制：官方说明与实测冲突

`[源码]` 游戏自带 `data/unsafedata_readme.txt` 原文：

> unsafedata is where `io.open(path, "w")` operations are permitted to work. This directory is flat.
> The following file extensions are permitted to be used with io.open in write mode: `.txt, .tex, .xml, .png, .json`
> Windows 实际位置：`Documents/Klei/DoNotStarveTogether/<userid>/client_save/unsafedata/`

`[实测]` 但本机 build 762172 上，模组用**裸文件名**写的文件确实落在 `bin64\`：

```
bin64\whale_io_cmd.json        94 B   2026/11/12 20:17
bin64\whale_io_hud.json        62 B   2026/11/12 22:37
bin64\whale_io_pause.json      15 B   2026/11/12 20:49
bin64\whale_io_settings.json  182 B   2026/11/12 22:37
```

**结论**：`.json` 扩展名 + 裸路径在本 build 下能写。但这是「引擎当前行为」，不是「官方支持的 API」。设计上：

- **不能只依赖 io 通道**（双写要保留）；
- Node 侧找文件要**同时找 bin64、bin、unsafedata 三个位置**（`lib/bridge.js` 已经这么做了）；
- 若将来 Klei 收紧，只剩 `SetPersistentString` 一条也能跑 —— 这条不依赖任何路径约定。

### 2.4 文件通道的固有代价（评估结论）

| 维度 | 文件通道 | HTTP（QueryServer） |
|---|---|---|
| 延迟 | 轮询：写 1s / 读指令 0.3s（`bridge.lua:22-24`）→ 动作启动最坏 ~0.3s | 一次请求往返，实测 <1s |
| 语义 | 「最新文件态」，天然丢中间态 | 请求/响应，可带状态码与错误码 |
| 幂等 | 靠 `cmd.id` 去重（`bridge.lua:164`） | 靠 `command_id` + 服务端 expiresAt（`game-bridge`） |
| 依赖 | 存档目录路径、文件名约定 | token 文件 + 端口 |
| 断线 | 无「断线」概念（文件一直在） | 有，需重连退避（已验证可恢复） |
| 多分片 | **会互相覆盖**（见 2.2） | 可按 shard 分路径 |
| 大 payload | 无上限（磁盘） | 引擎侧上限未知 |

---

## 3. 模组能做什么、不能做什么（沙箱事实）

`[源码]` 与 `[实测]`（`docs/phase2/01-m2-lua-http.md` §6 的事故记录）：

- mod 环境只给：`pairs/ipairs/print/math/table/type/string/tostring/require/Class`；**`pcall / tonumber / error / os / io` 必须从 `GLOBAL` 取**，直接用会 `attempt to call global 'tonumber' (a nil value)` → 模组被判定 MOD ERROR → **世界起不来**。
- `strict.lua` 会抓动态读全局名：`_G[name]` 这种写法在分片进程里会直接崩（`git log` 的 `2755249` 就是修这个）。
- 没有 socket / HTTP server / 子进程 / 文件系统遍历。
- 所有可能出错的模块必须 `pcall` 包起来，**任何异常都不许把模组带崩**（否则玩家进不了世界）。

---

## 4. 动作层 API（做 GameActions 要用的）

全部 `[源码]`，逐个给出处：

| API | 出处 | 说明 |
|---|---|---|
| `BufferedAction(doer, target, action, invobject, pos, recipe, distance, forced, rotation, arrivedist)` | `scripts/bufferedaction.lua:2` | 一个「打算做某动作」的对象；`:Do()` / `:Fail()` / `:Succeed()` / `AddSuccessAction/AddFailAction` |
| `locomotor:PushAction(bufferedaction, run, try_instant)` | `scripts/components/locomotor.lua` | **NPC 和玩家共用**的动作入口（`behaviours/doaction.lua:31` 就是这么调 NPC 的） |
| `locomotor:GoToPoint(pt, bufferedaction, run, overridedest)` | 同上 | 走到某点，可顺带带一个动作 |
| `locomotor:Stop()` / `StopMoving()` / `RunForward()` | 同上 | 打断 |
| `ACTIONS.CHOP/MINE/HAMMER/DIG.fn` → `DoToolWork(act, ACTIONS.X)` | `scripts/actions.lua:1748~1790` | 采集类动作的真实实现（工具耐久、干活次数都在里面） |
| `ACTIONS.PICKUP.fn` / `ACTIONS.EAT.fn` / `ACTIONS.EQUIP.fn` | `actions.lua:894 / 799 / 858` | 捡/吃/装备 |
| `EntityScript:DoPeriodicTask / DoTaskInTime / SetBrain / RestartBrain` | `scripts/entityscript.lua` | 定时器与 brain 挂载 |
| `MakePlayerCharacter(name, customprefabs, customassets, common_postinit, master_postinit, starting_inventory)` | `scripts/prefabs/player_common.lua:1968`，`inst.isplayer = true` 在 `:2533` | **玩家** prefab 工厂 |
| 实体分类靠标签 | `HasTag("hostile"/"monster"/"animal"/"structure"/"pickable"/"barren"/"fire"/"player")` | Observer 分类的唯一可靠依据 |
| `components.prototyper` | `scripts/components/prototyper.lua` | 「科技设施」判定 |
| `TheWorld.Map` / `components/map.lua` / `TheWorld.topology` | `scripts/components/map.lua`（62KB） | 地形/生态/道路数据来源（做文字地图用） |
| `Brain` / `BrainManager` / `behaviours/*.lua`（29 个节点） | `scripts/brain.lua`、`scripts/behaviours/*` | 行为树（`DoAction`/`Wander`/`ChaseAndAttack`/`FindClosest`/`FaceEntity`…） |
| `components.builder` | `scripts/components/builder.lua` | **只有 2 处 `isplayer` 判断**（`:283`、`:852`，都跟皮肤解锁有关）→ 非玩家实体理论上能 craft/build |
| `components.inventory` | `scripts/components/inventory.lua` | 只有 1 处 `HasTag("player")` 判断（`:1874`，灵魂状态）→ 非玩家实体能拿东西 |
| `components.workable` / `worker` / `eater` | `components/workable.lua`、`worker.lua`（368B）、`eater.lua` | 采集判定 / 猪人干活 / 吃东西 |

### 4.1 一个必须知道的工程约束（Phase 1 实测）

`[实测]`

- `FindEntities` 的半径参数是**世界单位**，1 格 = 4 个单位 → 传 `radius_tiles * 4`。
- 观察器实测默认：半径 16 格、总条数 40、每类 10、扫描间隔 4 秒（`docs/phase1/04-entity-scan.md`）。
- **`Pickable` 组件没有 `CanBePicked()`**，能不能采只能看标签（有 `pickable`、无 `barren`）。
- 日志通道单行 **~3.9K 字符被截断**（实测所有 nearby 行都是 3913~3921 且断在半截 JSON 上）→ 文件/HTTP 通道没有这个问题，但**日志通道做不了大状态**。

---

## 5. AI 角色方案：三条路的可行性

这是 M0 唯一「必须先验」的技术分叉。任务书希望「用原生幸存者 Prefab 创建一个独立 AI 角色」。

### A. 控制房主玩家的角色（**当前实现，已验证**）

- 现状：`Whale.bridge.on_player(inst)` 抓住玩家实体，所有动作都在玩家身上执行（`scripts/whale/actions.lua` 的 `JOBS.*`）。
- 优点：动画/UI/背包/制作全部原生，零风险。
- 代价：AI 和玩家抢同一个身体 → 必须有「接管」机制（现在靠 F7/F8 + 插件侧互斥）。
- 真机证据：走路、砍树、采集、吃、造火堆都跑通过（Phase 5~6 文档 + `whale_state.json`）。

### B. 用原生幸存者 prefab 生成「无主（ownerless）幸存者」（**外部已验证，推荐作为独立实体路线**）

先说源码层面看起来的风险，再说外部世界已经把它跑通的事实 —— 两者都要写，不能只挑一个。

`[源码]` 风险面：

- `prefabs/player_common.lua` 里 `inst.isplayer = true`（`:2533`），整套依赖 `TheNet`（`inst.userid`、`player_classified`、`SetClientAuthoritativeSetting`）。
- `SGwilson` 的许多状态（移动预测、`isstrafing`、`reticule`）依赖 `player_classified`，而 ownerless 实体没有 client。

`[参考 sei]` 事实面（`sei-studio/sei` 的 `scripts/sei/companion.lua` + `README`）：

- 它在 **master sim 上直接 `SpawnPrefab(offer.prefab)`**，prefab 就是原版幸存者（`wilson/willow/wolfgang/wendy/wx78/...` 共 15 个），**没有任何自定义 prefab**。
- README 原话大意：每个服务端玩家组件（`locomotor / combat / inventory / builder / eater / health / hunger / sanity / talker …`）**都自带**，而且**不需要客户端装这个 mod**。
- 无 owner → 不触发 `OnSetOwner`，所以身份字段要自己写：`inst.name`、`userid` 留空、加自定义 tag、**`inst.persists = false`**（不存档）、`inst.entity:SetCanSleep(false)`（否则会睡着）。
- 它踩到并修掉的 5 个「无主身体」坑（**我们必须照抄的补丁清单**）：

| 坑 | 现象 | 补丁 |
|---|---|---|
| `SGwilson` 没有 `doattack` handler | `combat:TryAttack` 只推 `doattack`，而玩家是走 ATTACK action 挥的 → **蜘蛛贴脸 10 秒满血不动手** | `ListenForEvent("doattack", function() PushBufferedAction(BufferedAction(body, target, ACTIONS.ATTACK)) end)` |
| 睡着的灯不发光 | 远离玩家的实体是睡着的，睡着的 `lightsource` 不发光 → 夜晚判断全错 | 装备/生成光实体时 `SetCanSleep(false)`，火堆 FX 重新 respawn |
| 无主身体死亡不能变鬼复活 | 玩家死了能复活，它不能 | 死亡给 8 秒宽限后上报 `DST_BODY_DIED`，由上层重建 |
| `inst:Remove()` 可能抛异常 | despawn 卡住 | 兜底：传送到 `(4000,0,4000)` + `INLIMBO` + `Hide()` |
| `ACTIONS.GIVETOPLAYER` 不可用 | 需要接收方打开给予者背包 | 走到 3m 内直接 `GiveItem`，满了就掉地上并如实报告 |

- 它明确排除了 `wes / wonkey / woodie / wanda`（残废/只能解锁的猴子/会变身的角色/无自然回血），并把「角色差异」做成**数据表**（`survivors.lua`：`diet / eatsSpoiled / fireImmune / frail / noSleep …`）而不是分支代码。

**结论修正**：任务书想要的「用原生幸存者 Prefab 创建独立 AI 角色」**是可行的**，而且不需要自定义模型/动画；风险不在「能不能 spawn」，而在**这 5 个 vanilla 行为补丁加上「不存档 / 不能复活 / 客户端可见性」这几条运维性质的问题**。

### C. 自定义 prefab（保留为 B 不行的退路）

如果 B 在本机 build 762172 上出现无法绕过的问题（例如 `SpawnPrefab("wilson")` 在这个版本被拦），再退到「借 `pigman` 等生物当骨架 + 用组件拼装」：

```lua
-- 骨架：pigman 已经有 brain + combat + health + locomotor + worker
inst:AddComponent("inventory")   -- inventory.lua 里只有 1 处 player 判断（:1874，灵魂）
inst:AddComponent("hunger")      -- 饥饿
inst:AddComponent("eater")       -- 吃东西
inst:AddComponent("sanity")      -- 理智
inst:AddComponent("builder")     -- 制作/建造（builder.lua 只有 2 处 isplayer，且都与皮肤有关）
inst:SetBrain(require("brains/whalebrain"))
```

这条路的问题：**动画不是人形**（`SGwilson` 不复用）、要做自定义 stategraph、上手成本比 B 高一个量级。只在 B 失败时考虑。

### 5.1 M0 的建议（写进迁移计划）

采用**双阶段**，不要一次到位：

1. **M1 继续走 A（控制房主玩家角色）**，把 Observer / Tools / Agent Loop / Reflex 全部打磨到「能真的活过几天」。
   理由：任务书的最终闭环（观察→决策→行动）**不依赖身体是玩家还是 NPC**，而 A 已经真机跑通。
2. **M2 用 1~2 天做 B 的 spike**：`SpawnPrefab("warly")` → 看服务端日志 → 打 `doattack` 补丁 → 让它挥一次斧子 → 截图/录日志。
   通过就切到「独立小鲸鱼」，不通过就继续 A，并把 C 记为备选。

**不要把「独立实体」放在 MVP 的必经路径上**：它引入的是「客户端表现 / 存档 / 多人 / 不能复活」四类问题，会让第一阶段无限延期；但它也**不是幻想**，外部项目已经证明了核心机制成立。

---

## 6. 能力清单：需要进游戏再验一遍的 9 项

M1 开工前（或 M1 第一周）必须拿到真机数据，否则设计里会留雷：

| # | 待验证 | 为什么要验 | 验证方式 |
|---|---|---|---|
| 1 | QueryServer 的**并发上限** | 决定要不要串行队列 | 一次发 3/5 个请求，看回调顺序与失败 |
| 2 | QueryServer 的**响应体上限** | 决定状态能不能一次发完 | 让 Node 端返回 1KB/16KB/128KB 递增文本 |
| 3 | **有界长轮询**是否可行（sei 用 400ms） | 能把命令延迟从 300ms 降到 ~100ms | 让 Node 端挂 400ms/2s/5s 再回，看会不会被引擎掐 |
| 4 | caves 分片能否 QueryServer | 双分片世界必须 | 进洞穴后跑探针 |
| 5 | `io.open` 是否能写 `unsafedata/` 之外的路径（**官方策略收紧了吗**） | 决定文件桥是否长期可靠 | 冷启动后看 `bin64` 有没有文件 |
| 6 | 无主幸存者 `SpawnPrefab("warly")` 能否 spawn + 被打 `doattack` 补丁后挥斧 | 决定「小鲸鱼」方案 | 30~60 分钟 spike，见 §5 |
| 7 | `hostility` 判定（`HasTag("hostile")` 覆盖多少生物） | Observer「敌对/中立」分类准确性 | 扫一圈已知生物对比 |
| 8 | `TheWorld.topology` / 地形数据能否稳定读出（做文字地图） | 决定「理解周围地图」的形态 | 读 3 个不同世界对比 |
| 9 | 玩家死亡 → 复活 → 重新接管的全流程 | 长跑的必经路径 | 故意饿死一次 |

---

## 7. 明确**不采用**的方案（避免以后再讨论）

| 方案 | 为什么不做 |
|---|---|
| Lua 模组开 socket / HTTP server | 沙箱没有这个能力（`[源码]`） |
| 用 RPC（`SendModRPCToServer`）做 AI 通道 | 只能模组间、同端，跨进程到不了 Node；且需要客户端装同一个 mod |
| 局域网 / 远程访问 Node 服务 | 任务书默认只允许本机；QueryServer 的地址白名单行为未知 |
| API Key 放进 Lua | 模组的 `bws_config.lua` 会被复制进游戏目录，违反「Key 不出 Node」 |
| 用日志通道传大状态 | 单行 3.9K 截断（`[实测]`） |
| 数据库 / 向量检索做记忆 | Markdown + 覆盖写就够（任务书 §9 也这么要求） |

---

## 8. 本轮验证的边界（诚实声明）

1. **没有启动游戏**，所有 `[实测]` 都是对仓库里既有真机产物的复核（日志、磁盘文件、`.runtime/bridge-state.json`）。
2. 引擎侧只有 Lua 脚本可见；C++ 层的地址白名单、HTTP 实现细节（并发/超时/大小限制）**看不到**，只能靠探针。
3. 「2025 年 Klei 允许 mod 访问 localhost」这条**没有在源码里得到确认**，只有本机 build 762172 的实测支持。
4. 独立实体方案（§5B）**是外部项目在别的 build 上跑通的**，本机一次都没试过。所以 M0 里它的定位是「高风险待验证的候选方案」，不是结论；`doattack` 那 5 个补丁也只是**别人踩过的坑清单**，不能当成我们这边的验证。
5. `[参考 sei]` 的所有数字（400ms hold、8KB、<20KB、DEAD_AFTER=8）都来自对方文档与源码，**M1/M2 必须自己复测**一遍再写进我们的代码常量。
