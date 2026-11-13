# M1.1 · 测试报告

> 环境：Windows 10 · Node **v24.13.1** · 游戏 **未启动**（`whale_state.json` 最后一次写入距今 46 分钟）
> 命令：`node --test --test-force-exit "tests/*.test.mjs"`（= `test.ps1`）

---

## 1. 结果总览

| 阶段 | tests | pass | fail |
|---|---|---|---|
| M1.0 结束（基线） | 211 | 211 | 0 |
| M1.1 改完 Lua（actor/observe/bridge/config） | 211 | 209 → 211 | 2 → 0 |
| M1.1 改完 Node（snapshot/get_state） | 211 | 211 | 0 |
| M1.1 加上 19 个新用例 | **230** | **230** | **0** |

```
ℹ tests 230
ℹ pass 230
ℹ fail 0
ℹ duration_ms 2980
```

**关键区分（任务书第十部分最后一句）**：
- **沙箱/Mock 测试**证明的是"代码逻辑对"（读字段、挑人、缺字段处理、文本渲染）；
- **它们不能证明游戏 API 真的这样返回** —— 那部分本轮**没做**，见 §6。

---

## 2. 新增测试：`tests/m1_1-actor-observer.test.mjs`（19 个）

### 2.1 前半：Lua 沙箱（fengari 真跑模组源码，假 GLOBAL）

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | 正常获取 Actor | `actor_id="player:KU_abc"` / `actor_id_kind="stable"` / `actor_type="player"` / 格子坐标 `(12,45)` |
| 2 | Actor 不存在 | `get_actor()` → `(nil,"no_player")`；`data.observer.status="no_actor"`；`data.actor=nil`（不编） |
| 3 | Actor 已失效 | `IsValid=false` → `(false,"invalid")`；不进候选；`get_actor_info` 返回 `nil` |
| 4 | Actor 死亡 | 仍然 `valid=true`，`alive=false`，`data.dead=true`，`status` 仍是 `ok`，文本含「你已经死了」 |
| 5 | 组件缺失（可选） | 缺 `hunger/sanity` → 字段为 `nil` 且写进 `unavailable_fields`，**不是 0** |
| 6 | 必需组件缺失 | 缺 `inventory` → `missing_components=["inventory"]` + `actor.component.inventory` 进 unavailable |
| 7 | 玩家属性缺失 | 缺 `temperature/moisture` → 两个 `player.*` 都进 unavailable |
| 8 | 背包/装备为空 | `inventory.used=0`、`is_full=false`、`items=[]`；`equipment.slots.hands=nil`；文本「背包（0/15 格）：空」「手持：空手」 |
| 9 | 世界状态不可用 | `TheWorld=nil` → `world.status="unavailable"`、`day=nil`、`world` 进 unavailable |
| 10 | 身份字段 | `session_id` / `shard_id` 各自独立；没有 `GetClusterID` 时 `cluster_id=null` 且 `cluster_id_source="unavailable"`；有则 `"the_net"` |
| 11 | Session 变化 | 缓存期内（10s）不变、过期后（100s）换成新 session |
| 12 | 配置绑定 | `scan_radius=99` 被夹到 40、`observe_interval="abc"` 回落 2；`nearby.radius` 反映配置 |

### 2.2 后半：Node（真写文件 + 真跑工具分发）

| # | 用例 | 断言要点 |
|---|---|---|
| 13 | JSON Schema | 用 ajv 按 `M1_1_get_state_schema.md` 的约束校验 `toJsonPayload()`：`identity/actor/observer` 必填字段、`actor_id_kind` 枚举、类型都对 |
| 14 | 快照过期 | `ageMs=500` → `stale=false`；`ageMs=STALE_MS+5000` → `stale=true`，`freshnessLine` 含「过期」，`get_state` 文本里也带 |
| 15 | 双分片 | 两份文件（Master 有人 / Caves 无人）故意把 Caves 排在前面 → 仍选 Master；两份 `shard_id` 各自独立 |
| 16 | **F8 与 MCP 同一份快照** | `executeTool('get_state')`（MCP 路径）与 `callTool('get_state')`（F8 路径）返回**完全相等**的字符串 |
| 17 | 老格式兼容 | 没有 `data.schema` → `schema="legacy"`、`textSource="legacy"`、`errors` 标注；老文本原样给模型 |
| 18 | `format=json` | 返回结构化字段（`actor.actor_id` / `player.health.current` / `world.day` / `identity.shard_id` / `observer.sequence`） |
| 19 | A 栈没被重新加载 | `modmain` 的 `modimport` 里没有 `scripts/main/*`、没有 `bws_config.lua`；`DontStarveWhaleSurvivor/scripts/main` 不存在；`archive/phase-a/scripts/main` 存在；**`observe.lua` 里不许出现 `ThePlayer` / 自己遍历 `AllPlayers`** |

### 2.3 覆盖对照（任务书「至少包括」15 项）

| 要求 | 对应用例 |
|---|---|
| 1 正常获取 Actor | 1 |
| 2 Actor 不存在 | 2 |
| 3 Actor 已失效 | 3 |
| 4 Actor 死亡 | 4 |
| 5 组件缺失 | 5、6 |
| 6 玩家属性缺失 | 7 |
| 7 背包为空 | 8 |
| 8 装备为空 | 8 |
| 9 世界状态不可用 | 9 |
| 10 JSON Schema 验证 | 13 |
| 11 Session 变化 | 11 |
| 12 Shard 区分 | 15（+10 验证身份字段） |
| 13 快照过期 | 14 |
| 14 F8 和 MCP 返回相同快照 | 16 |
| 15 归档 A 栈没有被重新加载 | 19（+ M1.0 的 modmain 断言继续守着） |

---

## 3. 改动的既有断言（2 处，都有理由）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `tests/lua-mod.test.mjs` | `#MODIMPORTS == 8` → `== 10`，列表加 `config.lua` / `actor.lua`，新增顺序断言（`util < config < actor < observe`） | M1.1 多了两个 B 栈模块；防回归断言（不许出现 `scripts/main`）保留 |
| `tests/lua-mod.test.mjs` | `data.day == 2` → `== 3` | `data.day` 语义统一成"人话的第几天"（`cycles+1`）。stub 里 `cycles=2`，所以人看到的是第 3 天；A 栈 `world_observer` 一直是这个口径（`phase1-observers.test.mjs:266` 同样断言） |

其余 **209 条断言一字未改**。

---

## 4. 沙箱测试实际跑出来的状态文本（原样，非伪造）

`tests/lua-mod.test.mjs` 的失败输出里第一次暴露了新渲染器的问题（"燃料60%"少了空格），修好前后各跑了一次。
当前渲染结果（假游戏：`cycles=2 / dusk / autumn`、血 45/150、背包 2 格、附近 4 类实体）：

```
# 快照 s0 · 第3天 · 白天 · 秋季 · 14° · 状态 ok
你：威尔逊  生命 45/150  饥饿 120/150  理智 200/200
位置：(12,45)
手持：火把(50%)  体温 12°
背包（2/15 格）：斧头(80%)、浆果 ×6(90%)
注意：
  - 血只剩 30%，快吃东西或跑
附近（16 格内）：
  可采：浆果丛(13,44) 距1.4
  可砍：常青树(15,43) 距3.6
  敌人：蜘蛛(18,42) 距6.7 25/25血
  火堆：火坑(13,46) 距1.4 燃料 60%
读不到的字段：world.weather、world.world_configuration
```

---

## 5. 真实磁盘文件冒烟（不是真机，但是**真的文件**）

脚本：`.runtime/m1_1-smoke.mjs`（`.runtime/` 已 gitignore）。读的是游戏 0.10.0 **真写过**的
`Cluster_1/Master/save/whale_state.json`：

```
schema = legacy | textSource = legacy | stale = true
errors = [ '状态文件是老格式（没有 data.schema），字段可能不全' ]
age(秒) = 2760 | sequence = 781
--- get_state(text) 前 5 行 ---
（文件 2760 秒前写过；⚠ 状态已经过期，游戏可能暂停或退出了）
世界：第3天 · 黄昏 · 秋季 · 29°
你：沃利  生命 50/150  饥饿 166/250  理智 100/200
位置：(19,-111)
手持：空手
```

这证明了三件事：
1. **老格式不会被读崩**，而且会明确标成 `legacy`；
2. **旧文件不会被当成新鲜数据**（2760 秒 → `stale` + 文本警告）；
3. 新加的 `freshnessLine` 会出现在 F8 和 MCP 的同一段文本里（它们共用 `get_state`）。

> ⚠️ 这**不是**新格式的运行证据：新格式（`bws.state/1`）只有装 0.12.0 进游戏并进世界之后才会产生。

---

## 6. 真机测试情况：**没做**

| 项 | 状态 | 为什么 |
|---|---|---|
| 0.12.0 模组能否进世界 | ⏳ | 游戏没开 |
| 新格式 `whale_state.json` 是否真的写出来 | ⏳ | 同上 |
| `actor.userid` 在服务端玩家实体上是否非空（决定 `actor_id_kind`） | ⏳ | 沙箱只能证明"有就优先用" |
| `TheNet:GetClusterID()` 在当前构建是否存在 | ⏳ | 现在靠 `type()=="function"` 探测；真机才知道走哪条分支 |
| `TheWorld.meta.clock` 是否可读（`world.world_configuration`） | ⏳ | 沙箱假数据；真机为 nil 时会进 unavailable |
| `FindEntities` 半径 ×4 的行为 | ✅ 已有历史真机证据（Phase 1），本轮未复测 | — |
| 双分片同时写、Node 挑对 | ⏳ | 需要两个分片都在跑 |
| F8 与 MCP 在同一时刻的端到端一致 | ⏳（单测已证同一函数） | 需要游戏在跑才能看到真实文件 |

**升级提醒**：版本已升到 **0.12.0**。插件按版本号判断是否重装；不重装的话游戏里跑的还是 0.10.0 旧模组，
`get_state` 会一直走 `legacy` 分支（能跑，但没有新字段）。

---

## 7. 复现方式

```powershell
# 全部单测
powershell -ExecutionPolicy Bypass -File test.ps1     # → 230 / 230

# 只跑 M1.1 的 19 个用例
node --test --test-force-exit "tests/m1_1-actor-observer.test.mjs"

# 真文件冒烟（老格式兼容）
node .runtime/m1_1-smoke.mjs

# 静态检查：观察器不许自己找玩家
Select-String -Path "DontStarveWhaleSurvivor\scripts\whale\observe.lua" -Pattern "ThePlayer|AllPlayers"
```
