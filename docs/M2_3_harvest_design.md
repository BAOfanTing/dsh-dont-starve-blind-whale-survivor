# M2.3 · Harvest 设计

> 版本：0.16.0 → **0.17.0**
> 原生 API 依据：`docs/M2_3_harvest_api_audit.md`（本机 `scripts.zip` 实测）
> 工具名 `harvest`，**底层原生动作是 `ACTIONS.PICK`**（`ACTIONS.HARVEST` 属于 crop/harvestable，本阶段不开放）

---

## 1. 一句话设计

模型只能给「当前 nearby 快照里 **可收获** 段中的 `#N`」和「那一帧的 `snapshot_id`」；
Lua 在**授权那一刻**重新确认"还是不是批准的对象、现在成不成熟、够不够得着"，然后提交原生 `ACTIONS.PICK`；
成功以**原生 `canbepicked` 翻转**为准，而不是以"动作没报错"为准。

## 2. 试点对象（唯一）

| prefab | 用途 | 依据 |
|---|---|---|
| `berrybush` | 普通浆果丛 | `normal_postinit`：`pickable:SetUp("berries", BERRY_REGROW_TIME)`，未设 `droppicked` |
| `berrybush2` | 同一配置的视觉变体 | 同一个 `normal_postinit` |

产物固定 **`berries`**，正常情况**直接进背包**。

**明确不支持**（一律 `prefab_not_allowed`）：
`berrybush_juicy`（`droppicked` + `jostlepick`，产物落地、距离规则不同）、
`grass` / `sapling` / `reeds` / `carrot_planted` / 蘑菇（另外的动作语义或 `remove_when_picked`）、
农田作物、`harvestable` 设施（锅/晾肉架/蜂箱）、树/岩石/冰/建筑/生物。

## 3. 共享规则：`HarvestRules`（新模块）

`scripts/whale/harvestrules.lua`，**观察侧与执行侧共用同一份**：

```lua
HarvestRules.PREFABS            -- 唯一白名单（berrybush / berrybush2）
HarvestRules.PRODUCT            -- 产物表（仅用于核对，不用于搜目标）
HarvestRules.IsCandidate(ent)   -- 类型/组件/世界状态（不含成熟度、距离、权限）
HarvestRules.IsReady(ent)       -- 原生成熟判据
HarvestRules.ReadState(ent)     -- 只读可安全读到的字段
HarvestRules.NativeRangeLimit(ent) / InNativeRange(actor, ent)
```

`IsCandidate` 复刻原生资格（`componentactions.lua` 的 pickable 处理器）：

| 检查 | 失败原因 |
|---|---|
| 有效 / 非 actor / 不在 limbo | `entity_gone` / `is_actor` / `in_limbo` |
| prefab 在白名单 | `prefab_not_allowed` |
| 不带 `fire`/`intense` | `target_not_harvestable` |
| 有 `components.pickable` | `target_not_harvestable` |

> ⚠️ **故意不要求 `pickable` 标签**。真机（0.17.0）发现该标签由组件维护，
> 含义是 `canbepicked and caninteractwith`，即"现在能采" —— 把它当候选资格会让
> "被采过的对象"从观察里消失（掉进 resources），使 `harvest_ready: false` 永远不可达。
> 详见审查文档 §4.1。

`IsReady`（**Candidate 与 Ready 严格分离**）：

| 检查 | 失败原因 |
|---|---|
| `IsStuck()` | `target_busy` |
| `IsBarren()`（`cycles_left == 0`） | `already_harvested` |
| `caninteractwith` | `target_not_harvestable` |
| **`CanBePicked()`** | `not_ready` |

> `Candidate = true, Ready = false` 是**正常状态**：对象是正确的收获目标，但现在没熟。

## 4. 距离：照抄原生公式

原生 `PickRangeCheck`（`scripts/actions.lua:18`）：

```lua
target_r = target:GetPhysicsRadius(0) + 4 + extrarange
distsq(x,z) <= target_r^2
```

- 浆果丛 `MakeSmallObstaclePhysics(inst, .1)` → 半径 0.1 ⇒ 上限 **4.1 世界单位 ≈ 1.03 格**；
- 本试点对象没有 `jostlepick` ⇒ `extrarange = 0`；
- **服务端原生不校验距离**，所以 `guard` 必须自己限（`HarvestRules.InNativeRange`，读不到半径时兜底 4 世界单位）；
- 超出 → `out_of_range`，**绝不自动靠近**。

## 5. 观察：新增 `harvestables` 桶（第 9 个）

**为什么不能只靠 `resources`**（按任务要求先评估再决定）：

1. 浆果丛原本落在 **`food`** 桶（`FOOD_SOURCES` 命中），真机上 `food` 曾 **12/12 满**，会被挤掉；
2. 旧 Schema **没有"现在成不成熟"的字段** —— `is_harvestable` 只来自 `harvestable` 组件，
   而浆果丛没有这个组件 ⇒ 模型根本看不出能不能采；
3. 因此需要独立桶 + 明确字段。

桶顺序（= 展示顺序 = 编号顺序 = 截断优先顺序）：

```text
threats → pickupables → harvestables → food → resources → containers → structures → creatures → other
```

`harvestables` 条目字段：

```json
{ "ref": "#3", "prefab": "berrybush", "category": "harvestables", "item_kind": "food",
  "label": "浆果丛", "distance": 0.8, "position": {"x":3,"z":0},
  "is_harvestable": true, "harvest_ready": true, "cycles_left": 3, "product": "berries" }
```

- `harvest_ready` 就是原生 `CanBePicked()` 的结果，**不造百分比**；
- `item_kind` 保留原语义（浆果丛 = `food`）；
- 一个实体只进一个桶（分类函数返回单一 category）；
- 未成熟的对象**也在桶里**（`harvest_ready: false`），因为观察不限成熟度、也不限距离。

## 6. 工具（Function Calling）

```json
{ "name": "harvest",
  "inputSchema": { "required": ["target_ref", "snapshot_id"],
    "properties": { "target_ref": {"type":"string"}, "snapshot_id": {"type":"string"} } } }
```

模型**不能**传：GUID / prefab / 坐标 / Lua 字符串 / `owner_instance_id` / `lease_generation` /
`authority_epoch` / `lease_id` / `runtime_id` / 任意原生 Action 参数。授权字段一律由 Node 侧生成。

描述里明确写：只支持浆果丛、必须来自当前快照、必须当前成熟、超出原生距离拒绝、
**不会自动移动**、**成功不等于东西一定进背包**、要捡请另外调 `pickup`。

## 7. 执行链路（与 move_to/stop/pickup 完全一致，没有第二套）

```text
F8 / MCP → lib/tools.js → Action Dispatcher → Control Lease → Command Envelope
        → File Bridge → Lua bridge.handle_command → guard.validate（最终授权）
        → actions.Start('harvest', args, id, { target = 已解析实体 }) → harvest_by_ref
        → push(BufferedAction(p, target, ACTIONS.PICK, nil))
        → 引擎执行原生 PICK（状态机 doshortaction，不走路）
        → 等状态翻转 → Report → dispatcher 重新读快照核对
```

## 8. 执行与结果核对

**执行前**（Lua job `start`）记录：`prefab`、`label`、产物、**执行前 `CanBePicked()`**、
背包该产物数量（`snapshot_counts`）。

**执行后**逐 tick 判断：

| 判据 | 含义 |
|---|---|
| `CanBePicked()` 由 true 变 false | **真的采到了**（原生状态翻转） |
| 或目标失效 | 采到了（被移除的情形） |
| 6 秒仍未变化 | `harvest_failed`（够不着 / 已不可采） |

回执区分两种成功：

- 背包该产物数量增加 ⇒ `采下了 X（berries+1）`；
- 数量没变 ⇒ `采下了 X（berries 没进背包，应该掉在地上了）`
  —— **收获成功，但不能说东西进包了**。

**Node 侧第二层核对**（`ACTION_SPECS.harvest.verify`，`verifyWaitMs = 4000`）：
① 背包产物增加；② 同一实体（**prefab + 格子坐标**匹配，因为 `ref` 会重排）
的 `harvest_ready` 由 true 变 false；③ 目标从可收获桶消失。
三条都不成立 → `unverified`（`harvest_state_unchanged`），**不谎报成功也不谎报失败**。

## 9. 与 Pickup 的边界

```text
观察 → harvest #N → 确认原生收获成功 → 重新观察
     → 若产物落地，下一次快照会出现新的 pickupables #N
     → 由模型单独决定是否 pickup
```

**不做**：harvest 成功后自动 pickup；一个 command_id 跑多个动作；失败后自动换目标；
目标失效后按 prefab 找替代；把"产物是否进背包"当作收获成功的唯一条件。

## 10. 中断与换手

- `A.Abort()` → `locomotor:Stop()` + `ClearBufferedAction()` + 上报；
- `Pick` 是一次 fn 调用内完成的原子操作：abort 在之前 ⇒ 世界不变；在之后 ⇒ 采摘已完成（属于**已完成**的副作用，不是未授权的后续副作用）；
- 游戏自己的再生计时器（`DoTaskInTime`）**不**由我们取消 —— 那是游戏状态；
- 换手安全性：ACK 只有在 **`job_cleared == true`** 时才被 Node 接受（见安全文档）。

## 11. 配置与新字段

- **没有新增配置项**（`harvestables` 复用单桶上限 12、总量 60）；
- 新字段：`buckets.harvestables`、`harvest_ready`、`cycles_left`、`product`、`is_stuck`（`harvestables` 条目专用）；
- Node `BUCKET_LABELS` 增加 `['harvestables','可收获']`；文本渲染显示"已成熟/未成熟"。

## 12. 明确不做

砍树 / 挖矿 / 凿冰 / 破坏建筑 / 捕猎 / 战斗 / 自动连续采集 / 采集多个目标 /
自主循环收获 / 扩 Pickup 白名单 / 第二个工具注册中心 / 第二套控制入口 / 第二次 `FindEntities`。
