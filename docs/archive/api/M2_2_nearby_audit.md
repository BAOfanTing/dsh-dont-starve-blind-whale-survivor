# M2.2 · Actionable Nearby 开发前审查

> 版本：0.15.2（源码 = 已装）；分支 main，HEAD `97c7696`，工作区干净
> 世界内存版本：0.15.1（真机观察时）
> 测试基线：**418 / 418**
> 动作白名单：`move_to`、`stop`、`pickup`
> 证据类型：**STATIC**（本机 `scripts.zip` + 本项目源码）
> 说明：本文只做只读审查，结论全部来自本机实际文件，未按其他 DST 版本推断。

---

## 0. 实际文件清单（先核实，不按列表推断）

| 位置 | 文件 | 作用 |
|---|---|---|
| Lua | `scripts/whale/actor.lua` | Actor Provider |
| Lua | `scripts/whale/config.lua` | 配置（`nearby_max_total=60`、`nearby_max_per_bucket=12`、`scan_radius=16`） |
| Lua | `scripts/whale/nearby.lua` | **扫描/分类/桶/排序/截断/#N/Delta**（本阶段主战场） |
| Lua | `scripts/whale/observe.lua` | `BuildData` + `Render`（文本渲染） |
| Lua | `scripts/whale/guard.lua` | 动作安全底座 + **Pickup 白名单与守卫** |
| Lua | `scripts/whale/actions.lua` | `pickup_by_ref` 执行器 |
| Lua | `scripts/whale/bridge.lua` | 文件桥 |
| Node | `lib/state/snapshot.js` | 快照归一化 + 旧结构 fallback + 文本渲染 |
| Node | `lib/tools.js` | 工具定义与 `get_state` |
| Node | `lib/dispatcher.js` | 动作白名单/校验/结果核对 |

`modmain.lua` 的 import 顺序（决定了模块之间能否互相引用）：

```text
json → util → config → actor → nearby → guard → observe → actions → macros → reflex → bridge → hud
```

**关键约束**：`nearby` 在 `guard` **之前**加载 ⇒ nearby 不能在加载期读取 `Whale.guard`。
所以共享的拾取候选规则必须抽成**独立模块**，放在 `util` 之后、`actor`/`nearby` 之前。

---

## 1. `resources` 桶为什么会被大量普通环境实体占满？

`N.Classify`（`nearby.lua:140`）的第 3 条规则：

```lua
-- 3) 资源：能砍/挖/铲/拆的，能采的非食物，地上的材料/工具/燃料
if work ~= nil then return "resources" end          -- 可砍/挖/铲（树、岩石、树苗…）
if pickable or harvestable then return "resources" end
if ground_item then return "resources" end           -- ★ 掉落物也在这里
```

真机样本（0.15.1，半径 16）：

```text
total_found = 113   total_returned = 23   not_returned = 83(90)
resources = 12/12 → grass×6, sapling, rock1, rabbithole×2, flower, …
food      = 7      structures = 3    creatures = 3    threats = 0
```

结论：**"地面可拾取物"和"环境资源"共用同一个桶、同权竞争 12 个名额。**
排序是 `桶序 → 距离 → prefab → GUID`，于是最近的一批植物（草 0.5 格、树苗 2.5 格…）
先把 `resources` 占满，**更远的地面 twigs/flint 直接掉进 `not_returned`，拿不到 `#N`。**

这不是分类错误（植物确实是资源），而是**桶的语义太粗 + 名额分配没有把"可操作"当回事**。

---

## 2. 当前 Pickup 白名单

`guard.lua`：

```lua
G.PICKUP_PREFABS = { twigs = true, cutgrass = true, flint = true }
G.PICKUP_MAX_TILES = 2.5     -- 执行距离上限（服务端原生不限，必须自己限）
```

本阶段**不扩展**该白名单。

---

## 3. 当前 Pickup 执行器用哪些判断认定"可拾取"

`guard.validate` 中 pickup 分支（按实际执行顺序）：

| # | 判断 | reason | 性质 |
|---|---|---|---|
| 1 | `Whale.job == nil`（不静默打断） | `actor_busy` | **执行期** |
| 2 | `N.Resolve(snapshot_id, ref)` 能解析到实体 | `stale_snapshot`/`unknown_ref` | 引用 |
| 3 | `ent:IsInLimbo() == false` | `in_limbo` | 目标状态 |
| 4 | `G.PICKUP_PREFABS[ent.prefab] == true` | `prefab_not_allowed` | **类型** |
| 5 | `components.inventoryitem ~= nil` | `target_not_pickable` | **组件** |
| 6 | `inventoryitem.canbepickedup == true` | `target_not_pickable` | **组件** |
| 7 | `inventoryitem.owner == nil`（不是别人的库存物） | `target_not_pickable` | **地面状态** |
| 8 | `inventory:CanAcceptCount(ent, 1) > 0` | `inventory_full` | **执行期** |
| 9 | 距离 ≤ `PICKUP_MAX_TILES` | `out_of_range` | **执行期** |
| 10 | 角色可控制（玩家/活着/非 ghost/ismastersim/有组件） | `actor_*`/`not_authoritative` | **执行期** |
| 11 | 权威租约（epoch/generation/lease_id/owner/instance/环境） | `authority_*`/`stale_*`/`wrong_*` | **执行期** |

`actions.lua` 的 `pickup_by_ref` 用的是**原生** `BufferedAction(p, target, ACTIONS.PICKUP)`，
成功判据为"目标被玩家持有 / 目标被堆叠合并且背包总量增加"。

---

## 4. Observer 是否可以复用这些判断？

**可以，而且必须**，但要**只取候选资格**（第 4~7 条 + 有效性），**剔除执行期条件**（第 1、8、9、10、11 条）。

理由（任务书明确要求）：如果 Observer 自己写一套"看起来差不多"的规则，
就会出现"Observer 说 #1 树枝可拾取，pickup 却回 `prefab_not_allowed`"的**观察-执行不一致**。

抽取方案：新模块 `scripts/whale/pickuprules.lua`，导出

```lua
PickupRules.PREFABS              -- 唯一白名单（guard 只做别名引用，不再自己维护一份）
PickupRules.IsCandidate(ent, actor)  -- 只读、无副作用；返回 ok, reason
```

`reason` 复用执行器已有的名字（`prefab_not_allowed`/`target_not_pickable`/`in_limbo`/`entity_gone`），
这样观察侧与执行侧的失败语义天然一致。

---

## 5. `flint` 为什么被判断为 food？

**因为 DST 的 flint 真的带 `edible` 组件。** 本机 `scripts/prefabs/flint.lua`：

```lua
inst:AddComponent("edible")
inst.components.edible.foodtype = FOODTYPE.ELEMENTAL
inst.components.edible.hungervalue = 1
```

而 `nearby.lua` 的判定是：

```lua
local NON_FOOD_TYPES = {}                    -- 只排除了 3 个
for _, key in ipairs({ "ROUGHAGE", "SEEDS", "GEARS" }) do ... end

local function is_real_food(edible)
    if edible == nil then return false end
    local foodtype = edible.foodtype
    if foodtype == nil then return true end   -- ★ 没写就默认是食物
    if NON_FOOD_TYPES[foodtype] then return false end
    return true                               -- ★ 不在排除表里就算食物 → ELEMENTAL 中招
end
```

`ELEMENTAL` 不在排除表里 ⇒ `flint` → food。**`inv_rocks`（石头物品）同理**。

---

## 6. 食物分类目前是否过度依赖 `edible` 组件？

**是。** 两个问题：

1. **排除表只有 3 项**，而本机 `scripts/constants.lua` 的 `FOODTYPE` 共有 **19** 种：

   ```text
   GENERIC MEAT VEGGIE ELEMENTAL GEARS HORRIBLE INSECT SEEDS BERRY
   RAW BURNT NITRE ROUGHAGE WOOD GOODIES MONSTER LUNAR_SHARDS CORPSE MIASMA
   ```

   其中 `ELEMENTAL`（燧石/石头/金块）、`NITRE`（硝石，"part of elemental"）、`WOOD`（木头）、
   `LUNAR_SHARDS`、"rift birds"、`CORPSE`、"rift buzzards"、`MIASMA`、`BURNT`（lavae）、
   `RAW`（"animals can eat off the ground, but players need to cook"）—— 游戏注释已说明
   **这些是给动物/特殊生物用的，不是玩家食物**。

2. `foodtype == nil → true` 这条兜底把"读不到类型"当成食物，方向错了（应该 fail-safe 成"不是食物"）。

**本机复核（决定修复方案的关键证据）**：`scripts/components/edible.lua:24` 里

```lua
self.foodtype = FOODTYPE.GENERIC
```

⇒ **`edible.foodtype` 永远不会是 nil**。实测 98 个带 `edible` 的 prefab 里，
只有 9 个没显式写 `foodtype`（`butter`、`goatmilk`、`royal_jelly`、`milkywhites`、`glommerfuel`…），
它们**全是真食物**，靠组件默认的 `GENERIC` 生效。

⇒ 因此可以安全地把判定改成**白名单**（玩家食物语义），既修掉 flint，又不会误伤真食物。

---

## 7. 当前排序是否会让重要目标长期拿不到 `#N`？

**会。** 现行策略（`nearby.lua:329` `sort_entities` + `build` 截断循环）：

```text
排序：BUCKET_ORDER[category] → distance → prefab → GUID
截断：按上面顺序遍历，桶内 <12 且 总数 <60 就收
```

问题：**它按"类别"分配优先级，但类别内部只看距离**。
地面物品和环境资源同属 `resources`，于是"最近的 12 个资源"里全是植物。
真机 `not_returned = 83~90` 就是证据。

⇒ 需要一个**独立的 `pickupables` 桶**，让"可操作目标"先拿到名额（任务书要求），
同时**不能**把威胁挤掉。

---

## 8. 新增 `pickupables` 后，怎样保证实体不重复进多个桶？

靠**分类函数返回单一 category**（互斥分支），而不是"先入原桶再补一个桶"：

```lua
function N.Classify(ent, actor)
    local base = classify_base(ent, actor)     -- 原七类逻辑（threats 仍最优先）
    if base == "threats" then return "threats" end
    if PickupRules.IsCandidate(ent, actor) then
        return "pickupables", base              -- 第二返回值 = item_kind（语义附注）
    end
    return base
end
```

- 每个实体**只返回一个桶** ⇒ 一次扫描内不可能重复；
- `item_kind` 只是**字段**，不产生第二个桶条目；
- `scan()` 对每个实体只 `describe` 一次，list 里每个 GUID 只出现一次；
- 现有 `sort_entities` + 截断循环天然保证"每个实体最多进 kept 一次"。

---

## 9. 当前 Delta 能否正确处理实体从 `resources` 转入 `pickupables`？

**能，不需要改 Delta。** `compute_delta(full, kept_set, key)`（`nearby.lua:380`）的实现要点：

1. 用 **GUID** 在**完整扫描候选集合 `list`** 上建 `current` 表 —— 与桶无关；
2. 新进扫描的实体，**只有这次也进了 kept（有 ref）才算 added**；
3. 两次都在、这次有 ref 的，逐字段比较，其中**已包含**

   ```lua
   if before.category ~= now.category then
       fields.category = { from = before.category, to = now.category }
   end
   ```

   ⇒ `resources → pickupables` 会精确报成 **`changed.category`**，既不是 added 也不是 removed；
4. 被截断（在 `list` 里、不在 `kept` 里）的实体**什么都不报**；
5. `prev.key`（session|shard）变化 → 重建基线；
6. `snapshot.reused` 时不重复计算（复用同一份 nearby 数据）。

⇒ **同一实体跨桶只报 category changed**，符合作业要求。

---

## 10. 如何保持 M1.4 旧快照兼容？

| 面 | 策略 |
|---|---|
| `N.SCHEMA` | 保持 `"bws.nearby/1"`（**只增字段**，不删不改已有字段语义） |
| 新字段 | `item_kind`，**只在 `pickupables` 条目上出现**；旧读端忽略未知字段即可 |
| 桶集合 | 新 Node 用 `BUCKET_LABELS` 渲染八桶；**未知桶仍有透传分支**（`snapshot.js:203`），所以"新 Lua + 旧 Node"也不丢数据 |
| 旧快照 | 七桶数据在新 Node 下按 `BUCKET_LABELS` 顺序渲染，缺的 `pickupables` 按空数组处理（不报错） |
| 空表约定 | 八桶都过 `arr({})`，JSON 里是 `[]` 而不是 `{}` |
| 错误态 | `status=error` 时的空桶表也要包含 `pickupables`，否则 Node 侧读 `buckets.pickupables` 会 nil |
| 引用 | `snapshot_id` / `#N` / `N.Resolve` / `runtime_id` 规则**完全不变**，新桶走同一套编号与失效逻辑 |
| 截断统计 | `total_found` / `total_returned` / `truncated` / `not_returned_count` 口径不变（新桶只是多一个去处，不改总数语义） |

---

## 11. 由审查得出的实施结论（最小改动）

1. **新增** `scripts/whale/pickuprules.lua`：唯一的拾取候选判定 + 白名单；
2. `modmain.lua`：在 `util` 之后 import 它；
3. `nearby.lua`：
   - `N.BUCKETS` 在 `threats` 之后插入 `pickupables`；
   - `N.Classify` 拆成 `classify_base` + 候选分流，并返回 `item_kind`；
   - `describe` 记录 `item_kind`；
   - `is_real_food` 改为**玩家食物类型白名单**（依据 §6 的真实类型表）；
   - error 分支的桶表补 `pickupables`；
4. `guard.lua`：白名单改为引用 `PickupRules.PREFABS`，候选判定调用 `PickupRules.IsCandidate`，
   **执行期条件（距离/背包/角色/租约）全部保留在 guard**；
5. `observe.lua`：渲染自动跟随 `N.BUCKETS`；额外在"某桶已达上限"时给出明确提示；
6. `lib/state/snapshot.js`：`BUCKET_LABELS` 插入 `['pickupables','可拾取物']`；
7. **不动**：`N.Resolve`、`snapshot_id`、Delta、Control Lease、Pickup 执行器、白名单内容、动作集合；
8. **不加**：第二次 FindEntities、新命令文件、新服务。
