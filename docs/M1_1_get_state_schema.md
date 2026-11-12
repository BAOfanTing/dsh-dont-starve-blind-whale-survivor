# M1.1 · `get_state` 数据结构（协议）

> 版本：`schema = "bws.state/1"`（模组 0.12.0 起）
> 适用双方：Lua `scripts/whale/{actor,observe,bridge}.lua` 写出，Node `lib/state/snapshot.js` 读取
> 原则：**取不到的字段一律 `null` + 写进 `unavailable_fields`**；不填 0、不猜、不补默认值。

---

## 1. 状态文件协议（`whale_state.json` / `whale_io_state.json`）

文件由 Lua 单方写入，外层结构保持向后兼容：

```jsonc
{
  "v": 1,                       // 文件协议版本（一直是 1，没动）
  "seq": 781,                   // 写入序号，进程内自增；重进世界从 0 开始（不可跨会话比较）
  "t": 1794493552,              // 写盘时刻（os.time，秒）
  "mod": "0.12.0",              // 模组版本（和 modinfo.lua 一致，有单测钉住）
  "ready": true,                // = data.observer.status == "ok"（老字段，保留）
  "text": "# 快照 s781 · …",    // 文本视图，**由 data 渲染**（见 §4）
  "data": {                     // 结构化快照（本节全部内容）
    "schema": "bws.state/1",
    // … identity / actor / player / world / nearby / warnings / observer
    // … 以及老字段 ready / dead / x / z / day / phase / players / tick / mastersim
  }
}
```

> 老格式（0.10.0/0.11.0 写的文件）没有 `data.schema`。Node 侧仍能读：`schema="legacy"`、`textSource="legacy"`，
> 并在 `errors` 里标一行"状态文件是老格式"。这条有单测（`M1.1-17`）和真实旧文件冒烟。

---

## 2. `data` 字段表

### 2.1 `data.observer`（每份快照必有）

| 字段 | 类型 | 来源 | 缺失时 |
|---|---|---|---|
| `schema` | string | 常量 `bws.state/1` | 不会缺 |
| `snapshot_id` | string | `"s" .. seq` | 不会缺 |
| `sequence` | number | 写入序号（同外层 `seq`） | 不会缺 |
| `timestamp` | number | 采样时刻（`U.now()` 秒，浮点） | 不会缺 |
| `sampled_at` | number | **数据实际采样时刻**（可能是上一次采样） | 不会缺 |
| `sample_age_ms` | number | `(now - sampled_at) * 1000` | 不会缺 |
| `reused` | bool | 是否复用了上一次采样（`OBSERVER_INTERVAL` 未到期） | 不会缺 |
| `status` | string | `ok` / `no_actor` / `actor_invalid` / `world_not_ready` / `error` | 不会缺 |
| `errors` | string[] | 人话说明（为什么没数据） | `[]` |
| `unavailable_fields` | string[] | 读不到的字段路径，如 `player.wetness`、`world.weather`、`actor.component.inventory` | `[]` |

### 2.2 `data.identity`

| 字段 | 类型 | 来源 | 缺失时 |
|---|---|---|---|
| `session_id` | string \| null | `TheNet:GetSessionIdentifier()` | `null` |
| `cluster_id` | string \| null | `TheNet:GetClusterID()`（**存在才取**） | `null` |
| `cluster_id_source` | string | `"the_net"` \| `"unavailable"` | `"unavailable"` |
| `shard_id` | string \| null | `TheShard:GetShardId()`（`Master` / `Caves`） | `null` |

> `cluster_id` 与 `session_id` **不混用**：前者是存档目录级（Cluster_N），后者是"这一次进世界"。

### 2.3 `data.actor`

| 字段 | 类型 | 来源 | 缺失时 |
|---|---|---|---|
| `actor_id` | string | `"player:<userid>"` 或 `"entity:<prefab>:<GUID>"` | — |
| `actor_id_kind` | string | `stable`（有 userid）\| `transient`（只能用 GUID） | — |
| `actor_type` | string | `player` \| `player_ghost` \| `creature` | — |
| `prefab` | string | `actor.prefab` | — |
| `name` | string | `STRINGS.NAMES[PREFAB]` → 退回 `inst.name` → 退回 prefab | — |
| `valid` | bool | `Actor.is_valid()` | — |
| `alive` | bool | `health:IsDead()` 取反 | 没有 health 组件时 `true` |
| `is_ghost` | bool | `HasTag("playerghost")` | `false` |
| `missing_components` | string[] | 必需组件里缺的（`health` / `inventory`） | `[]` |
| `tile_x` / `tile_z` | number | 世界坐标 / 4（格子，向下取整） | 读不到坐标时缺省 |
| `x` / `y` / `z` | number | `Transform:GetWorldPosition()` | 缺省 |
| `guid` | number | 实体 GUID（**仅本次运行有效**） | — |

> `status != "ok"` 时 `data.actor` 是 `null` —— 宁可没有对象，也不给一个假的对象。

### 2.4 `data.player`

| 字段 | 类型 | 来源 | 缺失时 |
|---|---|---|---|
| `health` | `{current, max, percent}` \| null | `components.health.currenthealth / maxhealth` | `null` + `player.health` 进 unavailable |
| `hunger` | 同上 | `components.hunger.current / max` | `null` + `player.hunger` |
| `sanity` | 同上 | `components.sanity.current / max` | `null` + `player.sanity` |
| `temperature` | `{value}` \| null | `components.temperature:GetCurrent()` | `null` + `player.temperature` |
| `wetness` | `{value}` \| null | `components.moisture:GetMoisture()` | `null` + `player.wetness` |
| `equipment` | `{slots:{hands,head,body}, worn:[…]}` \| null | `inventory:GetEquippedItem(EQUIPSLOTS.*)` | `null`（没有背包组件时） |
| `inventory` | `{slots, used, is_full, items:[…]}` \| null | `inventory:GetNumSlots / GetItemInSlot` | `null` + `player.inventory` |

物品块（`items[]`、`equipment.slots.*`）：

| 字段 | 类型 | 来源 |
|---|---|---|
| `prefab` | string | `item.prefab` |
| `name` | string | 中文名（`STRINGS.NAMES`） |
| `count` | number | `stackable:StackSize()`，不可堆叠为 1 |
| `percent` | number? | 耐久/新鲜度/燃料/护甲百分比（`finiteuses / perishable / fueled / armor`） |
| `slot` | number? | 背包槽位（1 起） |
| `food` | bool? | 有 `edible` 组件时为真 |
| `slot_key` | string? | 装备槽（`hands` / `head` / `body`） |

### 2.5 `data.world`

| 字段 | 类型 | 来源 | 缺失时 |
|---|---|---|---|
| `status` | string | `ok` \| `unavailable` | — |
| `day` | number | `TheWorld.state.cycles + 1`（**人话的第几天**） | `world.day` 进 unavailable |
| `season` / `season_name` | string | `state.season` / 中文名 | unavailable |
| `phase` / `phase_name` | string | `state.phase`（day/dusk/night）/ 中文名 | unavailable |
| `weather` | `{is_raining, is_snowing, is_full_moon, is_winter}` | `state.israining / issnowing / isfullmoon / iswinter` | 逐项缺省 |
| `world_temperature` | number \| null | `state.temperature` | unavailable |
| `is_cave` | bool | `TheWorld:HasTag("cave")` | `false` |
| `world_configuration` | object \| null | `TheWorld.meta.clock.{length_of_day, length_of_dusk, length_of_night, total_day_time, seasons}` | `null` + unavailable |

### 2.6 `data.nearby`（**M1.4 前的过渡形态**）

```jsonc
{
  "status": "legacy",        // legacy = 沿用现有扫描，M1.4 重写
  "radius": 16,              // 来自 OBSERVER_SCAN_RADIUS
  "scan_seconds": 4,         // 来自 OBSERVER_SCAN_SECONDS
  "scanned_at": 1794493550,  // 上次真正扫描的时刻
  "cached": false,           // 这次是不是用的缓存
  "buckets": [
    { "kind": "pickable", "label": "可采", "total": 4, "shown": 4, "truncated": false,
      "items": [ { "prefab": "berrybush", "name": "浆果丛", "tile_x": 13, "tile_z": 44, "dist": 1.4 } ] },
    { "kind": "hostile", "label": "敌人", "total": 1, "shown": 1, "truncated": false,
      "items": [ { "prefab": "spider", "name": "蜘蛛", "tile_x": 18, "tile_z": 42, "dist": 6.7,
                   "hp": 25, "hp_max": 25, "targeting_actor": false } ] }
  ]
}
```

桶类型：`pickable / ground / chop / mine / dig / hammer / hostile / fire / structure / ally`
（每桶上限 6/6/5/5/3/3/6/3/5/4，沿用现有配置）。

**没有 `#N` 引用**：那是 M1.4 的事。在那之前**不要**用名字+坐标之外的指代。

### 2.7 `data.warnings`

`string[]`，只报事实（血量、饥饿、理智、天黑夜无光、过冷/过热、以及"保命反射刚做过什么"）。

### 2.8 兼容字段（保留给老调用方）

| 字段 | 等于 |
|---|---|
| `ready` | `observer.status == "ok"` |
| `dead` | `not actor.alive` |
| `x` / `z` | `actor.tile_x / tile_z` |
| `day` / `phase` | `world.day / world.phase` |
| `players` | `U.count_players()`（`AllPlayers` 条数；读不到是 -1） |
| `tick` | 文件桥 tick 计数 |
| `mastersim` | 由 `TheWorld.ismastersim` 决定（模组只在服务端跑） |

---

## 3. `get_state(format="json")` 的返回

Node 侧 `toJsonPayload()` 输出（**字段名 snake_case**，去掉了内部 camelCase）：

```jsonc
{
  "ok": true, "schema": "bws.state/1", "status": "ok",
  "sequence": 781, "snapshot_id": "s781", "mod": "0.12.0",
  "identity": { "session_id": "…", "cluster_id": null, "cluster_id_source": "unavailable", "shard_id": "Master" },
  "actor": { "actor_id": "player:KU_xxx", "actor_id_kind": "stable", "actor_type": "player",
             "prefab": "warly", "name": "沃利", "valid": true, "alive": true, "is_ghost": false,
             "missing_components": [], "tile_x": 12, "tile_z": 45, "x": 48, "y": 0, "z": 180 },
  "player": { "health": {"current":45,"max":150,"percent":30}, "…": "…" },
  "world": { "day": 3, "season": "autumn", "season_name": "秋季", "phase": "day", "phase_name": "白天", "…": "…" },
  "warnings": ["血只剩 30%，快吃东西或跑"],
  "nearby": { "status": "legacy", "radius": 16, "buckets": [ "…" ] },
  "observer": { "snapshot_id": "s781", "sequence": 781, "status": "ok",
                "age_ms": 420, "sample_age_ms": 0, "stale": false,
                "errors": [], "unavailable_fields": ["world.weather"] }
}
```

`age_ms` 由 Node 用**文件 mtime** 计算（不是 Lua 写的），`sample_age_ms` 是"数据多久前采样的"。

---

## 4. 文本视图（`text`）

由 `O.Render(data)` 生成，规则固定：

```
# 快照 <snapshot_id> · 第<day>天 · <phase_name> · <season_name> · <world_temperature>° · 状态 <status>
你：<name>  生命 <cur>/<max>  饥饿 <cur>/<max>  理智 <cur>/<max>
位置：(<tile_x>,<tile_z>)
手持：<item>  头：<item>  身：<item>  体温 <n>°  潮湿 <n>%
背包（<used>/<slots> 格）：<物品、按名字排序 或 空>
注意：
  - <warning>
附近（<radius> 格内）：
  <label>：<名>(x,z) 距<d>[×n][ 血][ 正在追你][ 燃料 n%]；…（还有 N 个）
读不到的字段：<a>、<b>
```

规则：
1. **只出现 `data` 里有的东西**（没有 `hunger` 就不写那一项，不写 0）；
2. 角色不存在时第一段之后直接写"现在没有可观察的角色（<status>）"+ `errors`；
3. 每一行都能在 JSON 里找到对应字段，**文本不是第二个数据源**。

实测样例（假游戏沙箱输出，非真机）：

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

## 5. 变更记录

| 版本 | 变更 | 兼容性 |
|---|---|---|
| 0.10.0 及以前 | 顶层 `{v,seq,t,mod,ready,text,data:{ready,x,z,day,phase,dead,players,tick,mastersim}}` | — |
| 0.11.0（M1.0） | 只有结构调整（去 A 栈），状态字段没变 | 完全兼容 |
| **0.12.0（M1.1）** | `data.schema="bws.state/1"`；新增 `observer / identity / actor / player / world / nearby / warnings`；`data.day` 改为"人话的第几天"（cycles+1，与 A 栈观察器口径一致）；`text` 改由 data 渲染 | **读端已兼容老格式**（`textSource="legacy"`）；写端只写新格式 |

需要记住的一个口径变化：`data.day` 从 `cycles` 改成了 `cycles + 1`（游戏里人说的"第 3 天"= cycles 2）。
A 栈的 `world_observer` 一直是 `+1`，两边就此统一。
