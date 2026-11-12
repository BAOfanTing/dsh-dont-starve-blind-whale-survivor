# M1.4 · 附近实体观察数据结构（协议）

> schema：`bws.nearby/1`（模组 0.13.0 起）
> 生产者：Lua `scripts/whale/nearby.lua`（唯一实现），由 `observe.lua` 放进 `data.nearby`
> 消费者：Node `lib/state/snapshot.js`（原样透传）→ `get_state`（text / json）
> 原则：**只报真实读到的东西**；读不到就 `null` / 不出现；**GUID 只在 Lua 内部用于跨扫描匹配，绝不发给模型**。

---

## 1. 顶层结构

```jsonc
"nearby": {
  "status": "ok",              // ok | empty | error
  "schema": "bws.nearby/1",
  "snapshot_id": "n17",        // ★ 扫描快照号：#N 只在这个 id 内有效
  "radius": 20,                // 来自 OBSERVER_SCAN_RADIUS（格）
  "scan_seconds": 4,           // 来自 OBSERVER_SCAN_SECONDS
  "cached": false,             // true = 本次没重扫，用的是上一次结果
  "max_total": 60,             // 来自 OBSERVER_NEARBY_MAX_TOTAL
  "max_per_bucket": 12,        // 来自 OBSERVER_NEARBY_MAX_PER_BUCKET
  "total_found": 35,           // 扫到多少（去重、过滤后，截断前）
  "total_returned": 20,        // 实际给出多少
  "truncated": true,           // total_returned < total_found
  "scan": {
    "reused": false,           // 是否复用上次扫描
    "timestamp": 1794500012.5, // 这次扫描发生的游戏时间（秒）
    "age_ms": 0,               // 距这次扫描多久（reused 时 > 0）
    "duration_ms": 2,          // 扫描耗时（Lua 侧实测，诊断用）
    "scan_seconds": 4
  },
  "buckets": { "threats": [], "food": [], "resources": [], "containers": [],
               "structures": [], "creatures": [], "other": [] },
  "delta": { "status": "baseline" | "ok" | "reset",
             "added_count": 0, "removed_count": 0, "changed_count": 0,
             "added": [], "removed": [], "changed": [] },
  "error": "find_entities_failed"   // 仅 status=error 时出现
}
```

**三种 status 的语义（必须能区分）**：

| status | 含义 | 模型该怎么理解 |
|---|---|---|
| `ok` | 扫到东西了 | 桶里就是全部（注意 `truncated`） |
| `empty` | 扫描成功，附近确实没有值得看的东西 | 附近是空的，不是故障 |
| `error` | 扫描本身失败（`TheSim:FindEntities` 抛错 / 没有位置 / 模块缺失） | 这份 nearby 不可信，别据此判断"附近安全" |

> 兼容：`radius` / `scan_seconds` / `cached` 这些顶层字段沿用 M1.1 的名字，Node 侧与老调用方不受影响。
> 变化的是 `buckets`：M1.1 是**数组**（`[{kind,label,items}]`），M1.4 是**以桶名为键的对象**（见 §2）。

---

## 2. 分类（桶）

| 桶 | 判据（全部来自真实 tag / 组件） | 备注 |
|---|---|---|
| `threats` | 有 `health` 且未死，并且：`HasTag("hostile")` **或** `combat.target == 当前观察对象` | 不看 prefab 名字 |
| `food` | ①地上的可食用物品（`inventoryitem.owner == nil` 且有 `edible`）；②可采/可收且来源在食物白名单（浆果丛、胡萝卜、蘑菇、玉米…） | 白名单 `FOOD_SOURCES` |
| `resources` | 有 `workable`（CHOP/MINE/DIG/HAMMER）；或可采/可收但**不是食物**；或地上的材料（`inventoryitem` 无 owner 且不可食用） | 草/树枝/木头/石头都在这 |
| `containers` | 有 `container` 组件 | 箱子、冰箱、锅 |
| `structures` | `HasTag("structure")`；或 `prototyper`（科技设施）；或 `fueled` + `HasTag("fire")`（火堆/火坑） | 容器优先于本桶 |
| `creatures` | 有 `health` 但不是威胁；或 `animal`/`monster` 标签 | 猪人、兔子、牛 |
| `other` | 有观察价值但不属于上面任何一类 | 兜底 |

规则：

1. **一个实体只进一个桶**：分类函数对每个实体只调用一次（单一返回值），天然去重。
2. **不看名字猜**：`prefab == "spider"` 但没有 `hostile`/`combat` 的实体**不算威胁**（有单测钉住）。
3. **玩家自己不会进 nearby**（扫描时排除 `actor`）。
4. **无效/已移除/INLIMBO 的实体直接跳过**。
5. **没有观察价值的实体（fx、纯装饰）不进任何桶**——否则会白吃预算。
6. 分类码在 `nearby.lua` 的 `N.Classify`，以后加种类只改这一处。

---

## 3. 实体字段

```jsonc
{
  "ref": "#1",                    // 本轮快照内的短引用
  "prefab": "spider",
  "category": "threats",
  "label": "蜘蛛",                 // 中文名（STRINGS.NAMES / inst.name / prefab 兜底）
  "distance": 4.2,                // 格，1 位小数
  "position": { "x": 12, "z": -3 } // 格子索引（floor，和"你：位置 (12,45)"同口径）

  // 下面这些"有才给"，没有就不出现（不填 0、不编）
  "is_alive": true, "health": 25, "max_health": 25,   // threats / creatures
  "targeting_you": true,                              // 正在打你
  "is_workable": true, "work_action": "CHOP",         // 可砍/挖/铲/拆
  "is_harvestable": true,                             // 可收割（晒肉架、作物）
  "stack_size": 3,                                    // 地上那堆有几个
  "edible": true,                                     // 地上能吃
  "is_open": true,                                    // 容器开着（组件有 IsOpen 时）
  "fuel_percent": 60                                  // 火堆燃料
}
```

**不发的东西**（重要）：`GUID`、组件对象、动画/网络变量、`tags` 全表。
GUID 只存在于 Lua 内部的 refs 表与 delta 基线里，用于"两次扫描里是不是同一个实体"。

---

## 4. `#N` 引用

| 规则 | 说明 |
|---|---|
| 生成时机 | 每次**成功扫描**后，在「排序 → 分桶 → 截断」**之后**统一分配 |
| 编号方式 | 按桶优先级（threats → food → resources → containers → structures → creatures → other）+ 桶内距离升序，从 `#1` 连续编号 |
| 唯一性 | 一份快照内唯一；`#N` 与 `buckets` 里的对象一一对应 |
| 文本/JSON | 用**同一个** `ref` 字段（文本渲染只读这份数据） |
| 复用 | 缓存命中（`scan.reused = true`）时**不重新编号**，`snapshot_id` 也不变 |
| 绑定 | 绑定 `nearby.snapshot_id`（扫描快照号），**不是** `observer.snapshot_id`（写盘序号） |
| 过期 | 新扫描 = 新 `snapshot_id`，旧 `#N` 不能当新快照里的同一个实体 |

**为什么不用 `observer.snapshot_id`**：状态文件每秒重写一次（`INTERVAL`），但扫描按 `OBSERVER_SCAN_SECONDS` 才做一次。
如果把 `#N` 绑在写盘序号上，同一批实体每秒钟都会"换号"，M2 的动作校验就没法用了。

**内部映射**（Lua 运行时，不落盘）：

```
refs[snapshot_id] = { ["#1"] = <entity>, ["#2"] = <entity>, ... }
```

由 `Whale.nearby.Resolve(snapshot_id, ref)` 解析，返回 `(entity, nil)` 或 `(nil, reason)`：

| reason | 含义 |
|---|---|
| `stale_snapshot` | 这个扫描快照号已经不在表里（旧快照） |
| `unknown_ref` | 该快照里没有这个编号 |
| `entity_gone` | 实体已失效/被移除 |
| `in_limbo` | 实体不在世界里（被装进背包/传送中） |

> M1.4 只提供解析能力，**不做任何动作**；动作执行器（M2）在执行前必须校验：
> `ref 存在` → `snapshot_id 匹配` → `实体仍有效` → `仍在观察范围内` → 允许该操作。

---

## 5. 上限与排序

| 配置 | 默认 | 区间 | 作用 |
|---|---|---|---|
| `OBSERVER_NEARBY_MAX_TOTAL`（`nearby_max_total`） | 60 | 10–200 | 一次快照最多给多少个实体 |
| `OBSERVER_NEARBY_MAX_PER_BUCKET`（`nearby_max_per_bucket`） | 12 | 2–50 | 每个桶最多几个 |
| `OBSERVER_SCAN_RADIUS` | 16 | 4–40 | 扫描半径（格） |
| `OBSERVER_SCAN_SECONDS` | 4 | 1–60 | 扫描缓存时长（秒） |

- 越界值**夹取**、非数字回落默认，问题记进 `Whale.config.problems`（不静默）。
- 排序完全确定：桶优先级 → 距离升序 → prefab 字典序 → GUID（仅内部稳定用）。
- 截断先按单桶、再按总量；`total_found` / `total_returned` / `truncated` 三个字段让模型知道"看到的不是全部"。

---

## 6. Delta（相邻两次成功扫描的变化）

```jsonc
"delta": {
  "status": "ok",
  "added_count": 1, "removed_count": 1, "changed_count": 1,
  "added":   [ { "ref": "#1", "prefab": "evergreen", "label": "常青树", "category": "resources" } ],
  "removed": [ { "previous_ref": "#2", "prefab": "berrybush", "label": "浆果丛", "category": "food" } ],
  "changed": [ { "ref": "#1", "prefab": "spider", "label": "蜘蛛", "category": "threats",
                 "fields": { "health": { "from": 25, "to": 10 } } } ]
}
```

| 字段 | 说明 |
|---|---|
| `added[].ref` | **当前**快照的引用（可操作） |
| `removed[].previous_ref` | **旧**快照的引用 —— 只是历史信息，**不能当现在的引用用** |
| `changed[].fields` | 只放有意义的变化：`health`（≥1）、`distance`（≥1 格）、`stack_size`、`is_harvestable` 翻转、`work_action` 变化、`category` 变化 |

匹配方式：**按 GUID 匹配**（Lua 内部），不使用 `#N`（每次扫描都会重排）。

### 什么时候 `status = "baseline"`（不报新增）

- 第一次扫描（没有基线）；
- **Session 变化**（`TheNet:GetSessionIdentifier()` 变了）；
- **Shard 变化**（`TheShard:GetShardId()` 变了）；
- 上一次扫描失败（`status = "error"`）；
- 观察对象换了（actor 变了会换缓存 key，基线随之重建）。

### 什么时候 `status = "reset"`

扫描失败时返回 `reset`，表示"这份 delta 不可用"，同时 `prev` 基线被清空——下一次成功扫描会重新出 `baseline`，
**绝不**把失败当成"附近的东西全消失了"。

### 复用（`scan.reused = true`）

不重算 delta，原样返回上一次的 delta 结果。所以同一个 `nearby.snapshot_id` 内看到的 delta 是稳定的。

---

## 7. 文本渲染规则

`observe.lua` 的 `Render()` 只读上面这份结构化数据：

```
附近（20 格内，只显示 20/35 个）：      ← 截断时带"只显示"；复用扫描时带"沿用 N 秒前的扫描"
  威胁：#1 蜘蛛(12,-3) 距4.2 25/25血
  食物：#2 浆果丛(13,44) 距3.5
  资源：#3 常青树(15,43) 距5.1 可砍
  变化：新出现 #4 常青树；消失 1 个（浆果丛）；变化 #1 蜘蛛（生命 25→10）
```

- 空结果：`附近（20 格内）：没什么值得注意的`
- 扫描失败：`附近：暂时读不到（扫描出错：find_entities_failed）`
- 坐标用格子索引（与"你：位置 (12,45)"同口径），距离 1 位小数；整数不带 `.0`。
- 文本里**不会**出现 GUID，也不会出现被截断掉的实体。

---

## 8. 变更记录

| 版本 | nearby 结构 | 兼容性 |
|---|---|---|
| 0.10.x | `data.nearby` 不存在（状态是纯文本） | — |
| 0.12.0（M1.1） | `{status:"legacy", radius, scan_seconds, scanned_at, cached, buckets:[{kind,label,items}]}` | Node 透传，无消费方 |
| 0.13.0（M1.4） | `{status: ok/empty/error, schema, snapshot_id, buckets:{…}, delta, scan, max_*}` | Node 仍原样透传；`radius`/`scan_seconds`/`cached` 保留；`buckets` 从数组变为对象（有测试记录） |
