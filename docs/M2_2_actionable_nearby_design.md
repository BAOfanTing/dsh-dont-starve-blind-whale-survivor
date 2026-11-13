# M2.2 · Actionable Nearby 设计

> 版本：0.15.2 → **0.16.0**（观察层新功能，minor）
> 前置审查：`docs/M2_2_nearby_audit.md`（结论全部来自本机 `scripts.zip` 实测）
> 本阶段**只改观察与优先级**：不新增动作、不扩 Pickup 白名单、不改 Control Lease、不加第二次扫描。

---

## 1. 一句话设计

把"**能做什么**"从"**有什么**"里分出来：
凡是符合**拾取候选**条件的地面物品，进入新的 `pickupables` 桶并**优先拿到 `#N`**，
不再和草/树苗/岩石抢同一个 `resources` 桶的 12 个名额。

---

## 2. 八个观察桶

```text
threats → pickupables → food → resources → containers → structures → creatures → other
```

- 顺序 = 展示顺序 = **编号顺序** = 截断时的优先顺序（沿用 M1.4 的确定性策略）；
- `pickupables` 放在 `threats` **之后**：能打我们的东西绝不被"可拾取物"挤掉；
- 放在 `food`/`resources` **之前**：可行动目标不再被环境实体挤掉。

| 桶 | 含义 |
|---|---|
| `threats` | 敌对 / 正在打我们 |
| **`pickupables`** | **符合拾取候选的地面物品（本阶段唯一的"可行动"桶）** |
| `food` | 玩家真能吃的东西 / 采下来就是吃的 |
| `resources` | 可砍挖铲拆、可采的非食物、地上的其他材料 |
| `containers` | 箱子/冰箱/锅 |
| `structures` | 建筑、工作台、火堆、光源 |
| `creatures` | 有血但非敌对 |
| `other` | 兜底 |

---

## 3. Pickup Candidate 判定（唯一的共享规则）

新模块 `scripts/whale/pickuprules.lua`：

```lua
PickupRules.PREFABS                  -- 唯一白名单（twigs / cutgrass / flint）
PickupRules.IsCandidate(ent, actor)  -- 只读、无副作用，返回 ok, reason
```

判定内容（**全部只读**）：

| 检查 | 失败 reason |
|---|---|
| `ent ~= nil`、不是 actor 自己 | `entity_gone` / `is_actor` |
| `ent:IsValid()` | `entity_gone` |
| `PREFABS[ent.prefab] == true` | `prefab_not_allowed` |
| `not ent:IsInLimbo()` | `in_limbo` |
| `components.inventoryitem ~= nil` | `target_not_pickable` |
| `inventoryitem.canbepickedup == true` | `target_not_pickable` |
| `inventoryitem.owner == nil`（不是别人的库存物） | `target_not_pickable` |

组件读取一律走 `pcall` 包裹的 `safe_call`，目标失效时返回 `false` 而不是崩掉。

### 3.1 候选资格 ≠ 立即执行资格（本阶段的核心区分）

**不含**在候选判定里、只在执行时判的东西：

| 执行期条件 | 为什么不能进观察 |
|---|---|
| 距离 ≤ 2.5 格 | 8 格外的燧石也应该被看见，AI 才能先 `move_to` 过去 |
| Control Lease / 世代 | 观察不授权；换手期间照样要能看 |
| 角色能否行动（活/非 ghost/不忙） | 死了也要能看周围 |
| 背包能不能装 | 满了也要知道地上有什么 |
| 命令是否过期/重复 | 与"看到什么"无关 |

⇒ 因此 `pickupables` 里**可能**出现"看得见但现在捡不了"的目标，这是**故意的**。
执行侧（`guard.lua`）仍然独立做全部执行期校验，**Observer 永远不是授权者**。

### 3.2 观察-执行一致性

`guard.lua` 的 `G.PICKUP_PREFABS` 现在是 `PickupRules.PREFABS` 的**别名（同一张表）**，
候选判定也直接调用 `PickupRules.IsCandidate`。
测试 `M2.2-21/22` 钉住"同一张表"和"拒绝原因一致"，杜绝两份规则漂移。

---

## 4. `item_kind`：进入 pickupables 不丢失原语义

```json
{ "ref": "#2", "prefab": "flint", "category": "pickupables",
  "item_kind": "resources", "label": "燧石", "distance": 0.9,
  "position": { "x": -20, "z": 51 }, "stack_size": 1 }
```

- `category` 永远是**单一**桶名 ⇒ 一个实体只进一个桶；
- `item_kind` = 它**本来**会被分到哪个桶（`resources` / `food` / `other`…），只在 `pickupables` 条目上出现；
- 这样"可拾取"不会丢掉"它是什么"，将来按语义筛选也不用重新分类。

---

## 5. 分类流程（互斥，不重复）

```lua
function N.Classify(ent, actor)
    local base = classify_base(ent, actor)   -- 原七类逻辑，一行没改
    if base == nil then return nil end
    if base == "threats" then return "threats" end          -- 威胁优先
    if PickupRules.IsCandidate(ent, actor) then
        return "pickupables", base                            -- 第二返回值 = item_kind
    end
    return base
end
```

因为返回的是**单一桶名**，同一实体在一个快照里不可能进两个桶；
`scan()` 对每个实体只 `describe` 一次，`list` 里每个 GUID 只出现一次。

---

## 6. 食物分类修复（flint 不再进 food）

**根因**（本机实测）：`flint.lua` 真的 `AddComponent("edible")` 且 `foodtype = FOODTYPE.ELEMENTAL`；
旧逻辑只排除 `ROUGHAGE/SEEDS/GEARS` 三项，于是 flint 被判成食物。

**修复**：`is_real_food` 改成**玩家食物类型白名单**（依据 `scripts/constants.lua` 的 19 种 FOODTYPE
＋ `components/edible.lua:24` 的默认值 `GENERIC`）：

```lua
保留：GENERIC MEAT VEGGIE HORRIBLE INSECT GOODIES MONSTER
排除：ELEMENTAL NITRE GEARS WOOD ROUGHAGE SEEDS RAW BURNT LUNAR_SHARDS CORPSE MIASMA BERRY
```

- `BERRY` 排除的理由是游戏自己的注释（"只是给小鸟的 hack，浆果本体是 VEGGIE"）；
- 98 个带 `edible` 的 prefab 里，9 个没显式写 `foodtype`（butter/goatmilk/royal_jelly…）
  靠组件默认的 `GENERIC` 生效 ⇒ **真食物不回归**（`M2.2-05` 钉住）；
- 读不到 `foodtype` 时返回 `false`（旧逻辑返回 `true`，等于"有 edible 就算食物"，方向错了）。

---

## 7. 排序、容量与截断

- 排序（**未改**）：`桶序号 → 距离 → prefab → GUID`（GUID 只在 Lua 内部做最终稳定排序，不发给模型）；
- 截断（**未改**）：按上面顺序遍历，`桶内 < max_per_bucket` 且 `总数 < max_total` 才收；
- 容量：`pickupables` 复用现有单桶上限 12，总量仍 60 —— **不新增配置项**；
- 因为 `pickupables` 在桶序第 2 位，它先于 food/resources 拿名额 ⇒ 不再被植物挤掉；
- 统计口径不变：`total_found` / `total_returned` / `truncated` / `delta.not_returned_count` / `not_returned`。

**新增的"桶满"提示**（文本层，不改数据）：某桶条目数达到 `max_per_bucket` 时，
文本在该桶行尾加"（本桶已满，可能还有没列出的）"，避免模型以为"可拾取物一共只有这些"。

---

## 8. 引用规则（完全沿用 M1.4，新桶走同一套）

1. 所有桶分类完成后统一排序 → 统一截断 → 统一编号；
2. `ref` 全局唯一、从 `#1` 连续；
3. 同一快照 `reused` 时**不重新编号**；
4. 新扫描 → 新 `snapshot_id`；旧快照的 `#N` 立即失效（`refs` 只保留当前快照）；
5. `runtime_id` / session / shard 变化后旧引用失效；
6. `N.Resolve()` 继续校验实体有效性；
7. `not_returned` 实体**没有**当前 `ref`；
8. `previous_ref` 只作为 Delta 历史信息。

---

## 9. Delta 规则（未改一行）

`compute_delta(full, kept_set, key)` 用 **GUID** 在**完整扫描候选集合**上比对：

| 情况 | 报告 |
|---|---|
| 同一实体 `resources → pickupables` | `changed.category = {from, to}`（**不是** added/removed） |
| 新实体且这次有 `ref` | `added` |
| 完整扫描里没有、上次有 | `removed` |
| 完整扫描里有、这次被截断 | **什么都不报**（截断 ≠ 消失） |
| session/shard 变化 | `baseline` 重建 |

---

## 10. Node Snapshot 兼容

- `lib/state/snapshot.js` 的 `BUCKET_LABELS` 插入 `['pickupables','可拾取物']`（位置与 Lua 一致）；
- **未知桶透传**分支保留 ⇒ 新 Lua + 旧 Node 也不丢数据；
- 旧七桶快照在新 Node 下照常渲染，缺的桶按空处理；
- Node 文本补上 `stack_size > 1` 时显示 `×N`（与 Lua 文本一致）；
- `format=text` 与 `format=json` 共用同一份 nearby 数据；F8 与 MCP 共用同一份 Snapshot，
  **没有第二个状态读取入口**。

---

## 11. 明确不做

砍树 / 挖矿 / 采集 / 制作 / 建造 / 战斗 / 新宏动作 / 自主生存循环；
扩 Pickup 白名单；第二次 `FindEntities`；新命令文件；新 Node 服务；改 Control Lease；
改 `N.Resolve`；绕过 Pickup 的 Lua 最终校验。
