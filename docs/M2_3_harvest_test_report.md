# M2.3 · Harvest 测试报告

> 版本：**0.17.0**
> 全量：**477 / 477 通过**（M2.2 基线 447 + 本轮新增 **30**）
> Lua → Node 管线自检：32 / 32
> 证据类型：`UNIT`（fengari 假游戏 + 真实 harvestrules/nearby/guard/actions；Node 侧真实 dispatcher/control）、
> `STATIC`（本机 `scripts.zip` 审查 + 源码断言）、`RUNTIME`（真机，见 §7）

---

## 1. 数量

| 阶段 | tests | pass | fail |
|---|---|---|---|
| M2.2 基线 | 447 | 447 | 0 |
| + M2.3 Harvest（30 个新用例） | **477** | **477** | 0 |

新增文件：`tests/m2_3-harvest.test.mjs`（30 例）。

**既有测试没有删除或跳过。** 改动的既有文件只有两类：
1. 13 个 Lua harness 的模块列表补 `harvestrules`（跟随 `modmain` 真实顺序）；
2. `lua-mod.test.mjs` 的 modimport 数量 13 → **14**（+ 2 条顺序断言）；
   `dispatcher-11` 白名单纳入 `harvest`；`M2.2-01` 八桶 → 九桶；
   `M2.2-05` 更新为真实分类（浆果丛带原生 `pickable` 组件 ⇒ 进 `harvestables`，`item_kind` 仍是 `food`）；
   三个租约测试的 ACK 构造更新到 M2.3 收紧后的契约。

---

## 2. 原生 API 测试（STATIC + UNIT）

| 用例 | 断言 |
|---|---|
| `harvest-16` | `guard.ACTIONS.harvest` 存在；白名单 = `berrybush,berrybush2`；原生基数 = **4**（`PickRangeCheck` 的 `+4`） |
| `harvest-27` | `harvest_by_ref` 里**必须**有 `ACTIONS.PICK`，**不得**出现 `ACTIONS.PICKUP`、`find_all`、`find_by_name` |
| `harvest-04` | 距离公式：半径 0.1 → 上限 4.1 世界单位；4.0 通过、4.2 拒绝；半径 1.0 → 上限 5.0 |
| `harvest-05` | `ReadState` 只读原生真实字段（`can_be_picked`/`cycles_left`/`product`/`is_stuck`），**不造百分比** |

## 3. 候选判断（`harvest-01` / `harvest-02`）

批准的 `berrybush` / `berrybush2` 通过；`berrybush_juicy`、`evergreen`、`rock1`、`grass`、
`carrot_planted`、`beebox` 一律 `prefab_not_allowed`。
缺 `pickable` 组件 / 缺 `pickable` 标签 / `fire` / `intense` → `target_not_harvestable`；
失效 → `entity_gone`；limbo → `in_limbo`。

## 4. 成熟状态（`harvest-03`，Candidate 与 Ready 分离）

| 场景 | IsCandidate | IsReady | reason |
|---|---|---|---|
| 成熟 | true | true | — |
| 未成熟（`canbepicked=false`） | **true** | false | `not_ready` |
| 次数用尽（`cycles_left=0`） | true | false | `already_harvested` |
| 卡住（`stuck`） | true | false | `target_busy` |
| 不可交互 | true | false | `target_not_harvestable` |
| 非白名单 | false | false | `prefab_not_allowed` |

## 5. Observer（`harvest-06` ~ `harvest-09`）

- 成熟浆果丛进 `harvestables`，字段齐全（`is_harvestable`/`harvest_ready`/`cycles_left`/`product`/`item_kind=food`），且**不同时**出现在 `food`；
- 未成熟对象也在桶里（`harvest_ready: false`）—— 观察不限成熟度；
- 8 格外的也可见 —— **观察距离 ≠ 执行距离**；
- 九桶齐全、`ref` 全局唯一、一个实体只进一个桶。

## 6. Guard 前置条件（`harvest-10` ~ `harvest-15`）

| 场景 | 结果 |
|---|---|
| 成熟 + 1 格内 | 通过并带出实体 |
| 未成熟 | `not_ready` |
| 次数用尽 / 卡住 | `already_harvested` / `target_busy` |
| 5 格外 | `out_of_range` |
| 非白名单 / 旧快照 / 坏格式 / 缺参 | `prefab_not_allowed` / `stale_snapshot` / `bad_format:target_ref` / `missing_arg:snapshot_id` |
| 已有 job / 错 owner | `actor_busy` / `wrong_owner` |

## 7. 执行结果核对（`harvest-17` ~ `harvest-20`）

| 用例 | 结果 |
|---|---|
| 状态翻转 + 背包 `berries+1` | `done`，回执成功且写明 `berries+1`；**恰好提交 1 次** `BufferedAction`，且动作是 **`PICK`** |
| 状态翻转但背包没变（背包满会落地） | 仍然成功，但回执写明"没进背包/掉在地上" |
| 原生动作未生效（状态一直不变） | 超时后 `fail`，原因 `harvest_failed`，**不谎报成功** |
| 没有 `ctx.target`（没有 `#N`） | **不提交任何原生动作**（`#PUSHED == 0`），目标状态原封不动 |

## 8. Node 侧（`harvest-21` ~ `harvest-24`）

- 工具注册：`harvest` 在 `TOOLS` / `ACTION_NAMES` / `OPEN_ACTIONS` 三处；`required` 只有两个参数；描述含"浆果丛/成熟/snapshot_id/out_of_range/not_ready/不会/pickup"；
- Schema：缺参 / 坏格式 / 空串 / 类型错 + **伪造**`guid`/`prefab`/坐标/`owner_instance_id`/`lease_generation`/`authority_epoch`/Lua 字符串 → 全拒；
- 核对三条路径：背包增加（`how: inventory`）、**靠 prefab+位置**认同一实体且 `harvest_ready` 翻转（`how: state_flipped`，因为 `ref` 会重排）、都没变 → `harvest_state_unchanged`；
- 旧快照 → `stale_snapshot` 且**命令数 0**（拒绝发生在写命令之前）。

## 9. 租约换手加固（`harvest-25` / `harvest-26`）

`harvest-25` 逐条验证：缺 `job_cleared` / `false` / 字符串 `"true"` → `handover_job_not_cleared`；
缺 `lease_id` → `handover_ack_lease_id_missing`；`lease_id` 不匹配 → `handover_ack_lease_id_mismatch`；
无时间戳 → `handover_ack_no_timestamp`；太旧 → `handover_ack_(stale|expired)`；
**任何一条不满足都保持 `revoking`**，合法确认才转 `active`。

`harvest-26` 用源码断言钉住 Lua 侧：ACK 带 `job_cleared`/`lease_id`/`acked_at`；
`A.Abort` 里有 `ClearBufferedAction` 和 `Stop`。

## 10. 回归（`harvest-28`）

`OPEN_ACTIONS` = `harvest, move_to, pickup, stop`（只多了一个）；
`move_to`/`stop`/`pickup` 的参数 Schema 未变；`harvest.requiresSnapshot = true`。
既有 447 个用例全部保留并通过。

## 11. 真机（RUNTIME）

环境：真实 DST；世界已加载 **0.17.0**；MCP（产品 `apply()`）在 18090。
工具：`node tools/m2_3_verify_harvest.mjs --bridgeDir <Cluster_2\Master\save> [--harvest]`

### 11.1 0.17.0 实测：**11 / 11 PASS**

| 检查 | 实测 | 判定 |
|---|---|---|
| `harvestables` 桶存在 | 九桶齐全，文本段顺序正确（威胁 → 可拾取物 → **可收获** → 食物 → 资源） | ✅ |
| 附近浆果丛进入可收获桶 | **10 株全部 `harvest_ready: true`**，`cycles_left` 4~5，`product: berries`，`item_kind: food` | ✅ |
| 桶里只有批准对象 | 全是 `berrybush` | ✅ |
| 不重复跨桶 | 浆果丛没有同时出现在 `food` | ✅ |
| 过期引用 | 旧 `snapshot_id` → `stale_snapshot` | ✅ |
| 非白名单目标 | 对 `#23 sapling` → `拒绝：prefab_not_allowed` | ✅ |
| 超距 | 对 6.1 格的成熟浆果丛 → `拒绝：out_of_range`，**角色没有移动** | ✅ |
| **正常收获** | 先 `move_to`（6.1 格 → 1 格），再 `harvest` → **「采下了 浆果丛（berries+1）」** | ✅ |
| **产物入包** | 背包 **浆果 0 → 1** | ✅ |
| 与 Pickup 分离 | 只发了一次 harvest 调用，没有自动接续 pickup | ✅ |

> 这一轮证明了完整闭环：观察 → `#N` → `harvest` → 原生 `ACTIONS.PICK` → `canbepicked` 翻转
> → 产物入包 → 重新观察核对。**不是 Mock。**

### 11.2 真机发现并修掉的一个设计错误（0.17.1）

真机同时暴露了 M2.3 自己的一个设计错误：**被采过的浆果丛会从 `harvestables` 消失**，
掉进 `resources`（只显示"可铲"），`harvest_ready: false` **从未出现过**。

根因（本机 `scripts/components/pickable.lua` L1-6）：`pickable` **标签**由组件维护，
语义是 `canbepicked and caninteractwith`（= 现在能采）。我把它当成"候选资格"，
于是"没熟"的对象直接被判成"不是候选"。

修正（0.17.1）：
- `IsCandidate` 不再看标签，只看**组件**（+ 白名单 + fire/intense + 有效性）；
- `IsReady` 负责成熟度（正是那个标签的含义）；
- `nearby.interesting()` 改为认 `pickable` 组件，避免被采过又没有 workable 的植株彻底看不见；
- 新增回归 `harvest-29`（无标签 + `canbepicked=false` ⇒ 候选成立、`not_ready`）、
  `harvest-30`（必须出现在 `harvestables` 且 `harvest_ready: false`，不掉进 `resources`）。

**状态**：0.17.1 需要再重进一次世界才能真机复验这条（当前世界内存是 0.17.0）。
未复验前，该条只算 UNIT 证据。

**没有用 Fengari 或 Mock 冒充真机通过。**
