# M1.1 · Actor Provider + 统一 get_state 报告

> 里程碑：M1.1（只做**观察对象入口**与**统一状态接口**；不做实体全量扫描、不做动作、不接模型推理）
> 产品版本：0.11.0 → **0.12.0**（状态数据结构变更为 `bws.state/1`，必须让插件重装模组）
> 环境：Windows 10 · Node v24.13.1 · 游戏 build 762172 · **本轮没有启动游戏**（所有真机项标 ⏳）

---

## 0. 结论

| 要求 | 结果 |
|---|---|
| 观察对象只有一个入口 | ✅ `Whale.actor.get_actor()`；`util.player()` 降级为兼容层，`observe.lua` 里 **0 处** `ThePlayer`/`AllPlayers` |
| 统一 `get_state` 只有一个 | ✅ `lib/tools.js` 里就地扩展（没有新增第二个工具），F8 与 MCP 共用 `readSnapshot()` |
| 状态真实、可追溯 | ✅ 每份快照带 `schema/sequence/snapshot_id/session_id/shard_id/status/errors/unavailable_fields`；取不到的字段进 `unavailable_fields`，**不填 0** |
| 文本与 JSON 同源 | ✅ Lua 先建 `data`，`O.Render(data)` 渲染文本；Node 侧只有"兜底渲染"（老文件/被截断时才用），并标 `textSource` |
| 配置真生效 | ✅ `OBSERVER_INTERVAL / OBSERVER_SCAN_RADIUS / OBSERVER_SCAN_SECONDS` 已绑到活的 B 栈观察器（越界夹取、非数字回落默认） |
| 单测 | ✅ **230 / 230**（原 211 + 新增 19） |
| 真机 | ⏳ 未做（游戏没开），见 §8 |

---

## 1. 修改文件清单

### Lua（`DontStarveWhaleSurvivor/`）

| 文件 | 改动 |
|---|---|
| `scripts/whale/actor.lua` | **新增**：Actor Provider（`get_actor / is_valid / get_actor_info / get_identity / missing_components / reset`） |
| `scripts/whale/config.lua` | **新增**：配置唯一出口（`DEFAULTS / RANGES / clamp / build / get`） |
| `scripts/whale/observe.lua` | **重写**：`BuildData`（结构化）→ `Render`（文本）→ `Build` / `BuildSample`（按 `OBSERVER_INTERVAL` 采样）；附近块按 `SCAN_SECONDS` 缓存；补 `warnings`、`unavailable_fields`；接上反射层"我刚做过什么" |
| `scripts/whale/util.lua` | `U.player()` 改为**调用 Actor Provider**（未加载时才退回旧逻辑） |
| `scripts/whale/bridge.lua` | `build_state()` 走 Provider + `BuildSample`，输出 `data.observer` 等；写盘间隔绑 `state_interval`；异常时写"观察器出错"而不是崩 |
| `modmain.lua` | 新增 `config.lua` / `actor.lua` 两个 import（顺序：json → util → config → actor → observe → …）；用 `modconfig()` 建配置；版本兜底 0.12.0 |
| `modinfo.lua` | 版本 0.12.0（配置项一个没删，只是现在真的生效） |

### Node（`lib/`）

| 文件 | 改动 |
|---|---|
| `lib/state/snapshot.js` | **新增**：唯一归一化层（`normalizeState` / `freshnessLine` / `renderFallbackText` / `toJsonPayload` / `readSnapshot` 的上游） |
| `lib/tools.js` | `get_state` 增加 `format: text|json`；改用 `readSnapshot()` + `freshnessLine()`；导出 `readSnapshot` 供 Agent/HUD/测试复用 |

> 除此之外**没有改**：`actions.lua`、`macros.lua`、`reflex.lua`、`hud.lua`、`json.lua`、`lib/{index,bridge,mcp-server,agent,client,mod-install}.js`、以及 `mcp-server/src/survival/`（S级保留项）。

---

## 2. Actor Provider

### 2.1 接口

```lua
Whale.actor.get_actor()                  --> actor | nil, reason       -- reason: world_not_ready / no_player
Whale.actor.is_valid(actor)              --> bool, reason             -- missing / invalid / in_limbo / no_transform
Whale.actor.get_actor_info(actor)        --> info | nil, reason
Whale.actor.get_identity(now)            --> {session_id, cluster_id, cluster_id_source, shard_id}
Whale.actor.missing_components(actor)    --> { "inventory", ... }
Whale.actor.reset()                      -- 测试用：清身份缓存
```

### 2.2 挑人规则（沿用 B 栈已验证的行为，不引入新策略）

```
遍历 GLOBAL.AllPlayers
  ├─ 有效实体里优先「有 player 标签且不是 playerghost」
  │    两个"活人"时优先有 userid 的那个
  ├─ 没有活人 → 退回任意有效实体（死了也要能被观察，否则 AI 不知道自己死了）
  └─ 一个有效实体都没有 → (nil, "no_player")
```

`AllPlayers == nil`（世界还没加载完）→ `(nil, "world_not_ready")`。

### 2.3 有效性判定

| 情况 | `is_valid` | 说明 |
|---|---|---|
| `actor == nil` | `false, "missing"` | — |
| `actor:IsValid() == false` | `false, "invalid"` | 实体已被移除 |
| `HasTag("INLIMBO")` | `false, "in_limbo"` | 不在世界里（被装进包里/传送中） |
| `Transform == nil` | `false, "no_transform"` | 读不到坐标 |
| 死亡（health:IsDead） | **`true`** | 死亡**不是**失效：要能把"我死了"告诉 AI |

必需组件 `health` / `inventory`；可选 `hunger` / `sanity` / `temperature` / `moisture`。
缺必需组件 → 记 `data.observer.unavailable_fields += "actor.component.<名字>"`。

### 2.4 为将来的"无主幸存者"留的口子

```lua
local function pick_actor() ... end   -- 只有这一个函数知道"怎么挑"
```

M2 做 `SpawnPrefab("wilson")` 时，把 `pick_actor()` 改成"先找带 `bws_whale` 标签的实体、找不到再退回玩家"即可；
`observe / actions / bridge / tools` 全部不用改。这也是本轮把 `util.player()` 改成转发的目的。

---

## 3. 观察对象身份

| 字段 | 来源（真实 API） | 边界 |
|---|---|---|
| `actor_id` | 有 `userid` → `"player:"..userid`；否则 `"entity:<prefab>:<GUID>"` | 后者标 `actor_id_kind = "transient"`，**GUID 不能当长期 ID**（M0 要求） |
| `actor_type` | `player` / `player_ghost` / `creature`（按 tag 判定） | — |
| `actor_prefab` | `actor.prefab` | — |
| `session_id` | `TheNet:GetSessionIdentifier()`（引擎脚本 `shardindex.lua:317` 同款用法） | 每次读档/新建世界都会变；缓存 60 秒 |
| `cluster_id` | `TheNet:GetClusterID()`（**存在才取**） | 部分构建没有这个 API → `null` + `cluster_id_source="unavailable"`，**不拿 session 冒充** |
| `shard_id` | `TheShard:GetShardId()`（`player_common_extensions.lua:234` 同款用法） | Master / Caves 靠它区分 |

`data.identity` 每份快照都带，Node 侧原样透出（`identity.shard_id` 在 `get_state` 文本第一行的"状态"之后可见于 JSON）。

---

## 4. 统一 get_state

### 4.1 只有一个入口

```
F8（lib/agent.js → callTool）    ┐
                                 ├→ lib/tools.js executeTool('get_state')
MCP（lib/mcp-server.js tools/call）┘        └→ readSnapshot() → lib/state/snapshot.js normalizeState()
                                                    └→ bridge.readState()（唯一读文件的地方）
```

`readSnapshot()` 是**唯一**解析状态文件的函数；`lib/agent.js`、`lib/mcp-server.js`、HUD、测试都调它。
单测 `M1.1-16` 直接对比"两条入口的返回字符串"，必须**逐字节相同**。

### 4.2 两种输出

| `format` | 返回 | 用途 |
|---|---|---|
| `text`（默认） | 笔记 + 新鲜度提示 + **Lua 从 data 渲染的文本** | 给模型看（token 友好） |
| `json` | 结构化快照（字段名 snake_case，见 `M1_1_get_state_schema.md`） | 给程序/后续 Agent Loop 用 |

文本与 JSON 同源：`data` 是唯一事实，`O.Render(data)` 只是它的一个视图；
Node 侧**不另写一份完整文案**（只有 `renderFallbackText` 兜底，且标 `textSource="fallback"`）。

---

## 5. 文件桥数据来源确认（七问七答）

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 谁写 `whale_state.json` | **只有** `scripts/whale/bridge.lua` 的 `B.WriteState()` → `build_state()` → `write_both()`（持久化字符串 + `io.open` 两条子通道） | `bridge.lua` 里 `write_both(FILES.state, ...)` 仅此一处 |
| 2 | 谁读 | `lib/bridge.js readState()` → `lib/tools.js readSnapshot()` → `lib/state/snapshot.js normalizeState()`（**唯一解析点**） | 全仓搜 `whale_state.json` 的读取只在这三层 |
| 3 | 有没有多个写入者 | Lua 侧每个分片进程各一个写入者（Master 进程 / Caves 进程），写各自目录；**Node 侧从不写状态**（只写 `cmd / settings / pause / hud`） | `lib/bridge.js` 只有 `writeToAll` 给 cmd/settings/pause/hud 用 |
| 4 | 更新时间真实吗 | `t = os.time()`（秒）、`seq` 自增、`observer.timestamp`=采样时刻；文件 mtime 由 OS 给，Node 用它算 `age_ms` | 本轮实测：老文件 `age=2760s` → `stale=true` |
| 5 | `sequence` 是否递增 | 是：`seq = seq + 1`，进程内自增；**重进世界从 0 重新开始**（所以不能跨会话比较序列号） | `bridge.lua build_state()` |
| 6 | 双分片是否互相覆盖 | **文件不覆盖**（各自目录 `Master/save`、`Caves/save`）。风险在**读端挑选**：Node 用「ready + players + 新鲜度」排名，实测优先选中 Master | `lib/bridge.js readState()` rank；`M1.1-15` 单测 |
| 7 | 重启后 Session 是否更新 | 会（`GetSessionIdentifier()` 每次进世界都变），缓存 60 秒后重读。**尚未真机验证** | `actor.lua` 缓存逻辑 + `M1.1-11` 单测 |
| 8 | 旧文件会不会被当成新鲜 | 不会：`age_ms > 15s` → `stale=true`，文本第一行写明「⚠ 状态已经过期」 | `M1.1-14` + 真实旧文件冒烟 |

---

## 6. 双分片处理

- **写**：每个分片进程都写自己的目录，互不干扰（**没有跨分片写同一个文件**）。
- **读**：`readState()` 先按「`ready` 且 `players>0`」加分，再按新鲜度、再按 mtime 决胜；选中后 `this.active` 记住该目录，**命令只发给那片**（避免没人的洞穴抢答"现在没有玩家"）。
- **身份**：`data.identity.shard_id` 让上层能判断"这份状态来自哪片"，M2 的 `agent` 可以据此拒绝跨片命令。
- **未做**：`get_state` 目前不会把两片状态合并（任务书也没要求）。如果将来要在地面看洞穴数据，属于另一个设计（跨进程读文件）。

---

## 7. 配置绑定（任务书第六部分）

| modinfo 配置 | 内部键 | 默认 | 夹取区间 | 真正影响哪里 |
|---|---|---|---|---|
| `INTERVAL` | `state_interval` | 1 s | 0.5 – 10 | `bridge.lua` 的 `WRITE_STATE`（状态写盘间隔）；插件还能用 `whale_settings.json` 的 `interval` 热覆盖 |
| `OBSERVER_INTERVAL` | `observe_interval` | 2 s | 0.5 – 10 | `observe.BuildSample()`：多久**重新采样**一次（未到期就复用上次采样，标 `observer.reused=true`） |
| `OBSERVER_SCAN_RADIUS` | `scan_radius` | 16 格 | 4 – 40 | 附近实体 `FindEntities` 的半径（世界单位 ×4） |
| `OBSERVER_SCAN_SECONDS` | `scan_seconds` | 4 s | 1 – 60 | 附近扫描结果缓存时长（`nearby.scanned_at` / `cached`） |
| `REFLEX` / `VERBOSE` | `reflex` / `verbose` | false | 布尔 | 保命反射 / 调试日志（沿用原有绑定） |

- 越界值**夹取**而不是报错（游戏里改配置不该让模组炸）；非数字回落默认值，并记进 `Whale.config.problems`。
- 归档的 `observer_manager.lua` 不再被任何代码引用（`grep` 为 0）。

---

## 8. 性能与可靠性（任务书第九部分逐条）

| # | 要求 | 做法 |
|---|---|---|
| 1 | 不重复生成快照 | `BuildSample` 按 `observe_interval` 复用采样；命中时 `observer.reused=true` + `sample_age_ms` |
| 2 | 不重复读相同组件 | `player_block` 只从 `p.components` 取一次，各字段复用同一引用 |
| 3 | 不重复统计装备栏 | `inventory_block` **一次**遍历 15 格，同时产出 `inventory.items` 与 `equipment.slots/worn` |
| 4 | 实体失效 | `ACT.is_valid` 四类判定；`build_state` 整体 `pcall`，失败会写"观察器出错"而不是让桥哑掉 |
| 5 | 游戏未加载完成 | `AllPlayers == nil` → `world_not_ready`；`data.observer.status="no_actor"`，文本说清"可能还在读档" |
| 6 | 玩家死亡 | `actor.alive=false` / `data.dead=true`，**状态仍是 ok**，文本"你已经死了"；不会把死亡误判成程序错误 |
| 7 | 通信断开 | 找不到文件 → `get_state` 明确提示怎么修；文件过期 → `stale` + 文本警告 |
| 8 | 保留状态更新时间 | `t`（写盘时刻）、`observer.timestamp`（采样时刻）、`observer.sampled_at`、Node 侧 `age_ms` |
| 9 | 避免旧快照冒充 | `stale`（15 秒阈值）+ `freshnessLine()` 前缀；老格式文件额外标 `textSource="legacy"` |
| 10 | 不阻塞主线程 | 状态 1 秒一次、扫描 4 秒一次缓存；**没有全图扫描**（M1.4 才做附近全量结构化）；单次采样只做一次 `FindEntities` + 一次背包遍历 |

主循环仍是 0.2 秒 tick（`bridge.lua`），采样与扫描都挂在这个 tick 上按间隔节流。

---

## 9. 还没做的（明确留给后面）

| 项 | 留给 | 说明 |
|---|---|---|
| 附近实体的**结构化重写**（`#N` 引用、分类桶、上限、增量 delta） | M1.4 | 现在 `nearby` 是"沿用现有扫描 + 序列化"，标了 `status:"legacy"` |
| 局部文字地图 | M1.5 | 未做 |
| 世界配置（季节长度等）真机验证 | M1.6 | `world.world_configuration` 来自 `TheWorld.meta.clock`，沙箱里能用，真机没验 |
| `cluster_id` 在真机上是否有 API | M1.6 | 现在靠 `type(net.GetClusterID)=="function"` 探测 |
| 文件桥 9 项实测 | M1.6 | 见 `docs/M0_api_validation.md` §6 |
| 战斗/任务链工具（A 栈那 11 个） | M4 | 见 `docs/tool_migration_matrix.md` |
| Control Lease | M2 前 | 任务书写明 M2 开始动作前必须完成 |
