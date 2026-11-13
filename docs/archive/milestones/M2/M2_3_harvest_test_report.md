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

## 11. 真机（RUNTIME）—— **14 / 14 PASS**

环境：真实 DST；世界已加载 **0.17.1**；MCP（产品 `apply()`）在 18090。
命令：`node tools/m2_3_verify_harvest.mjs --bridgeDir <Cluster_2\Master\save> --harvest`

| # | 检查 | 实测 | 判定 |
|---|---|---|---|
| 1 | `harvestables` 桶存在 | 九桶齐全，文本段顺序正确（威胁 → 可拾取物 → **可收获** → 食物 → 资源） | ✅ |
| 2 | 桶里只有批准对象 | 10 株全是 `berrybush` | ✅ |
| 3 | `harvest_ready` 字段 | 已成熟 8 / 共 10（另 2 株正是前几轮采过的） | ✅ |
| 4 | 浆果丛不重复跨桶 | 不在 `food`/`resources` | ✅ |
| 5 | 过期引用 | 旧 `snapshot_id` → `stale_snapshot` | ✅ |
| 6 | 非白名单目标 | `#sapling` → `prefab_not_allowed` | ✅ |
| 7 | **未成熟目标** | 采过的浆果丛 → **`not_ready`** | ✅ |
| 8 | 超出原生距离 | 7 格的成熟浆果丛 → `out_of_range`，**角色没有移动** | ✅ |
| 9 | **正常收获** | `move_to` 靠近后 → **「采下了 浆果丛（berries+1）」** | ✅ |
| 10 | **产物入包** | Node 侧独立读到 **浆果 0 → 1** | ✅ |
| 11 | 与 Pickup 分离 | 只发 harvest 调用，没有自动接续 pickup | ✅ |
| 12 | **采过的对象仍可见（0.17.1 修复）** | 同一株仍在 `harvestables` 且 `harvest_ready: false` | ✅ |
| 13 | 刚采过再采 | 同一株再 harvest → **`not_ready`** | ✅ |
| 14 | 状态核对 | 同一株（prefab+坐标）`harvest_ready: true → false` | ✅ |

这一轮同时验证了三层：
**观察**（不成熟对象可见 + 语义字段）、**授权**（成熟度在授权那一刻复判）、**核对**（背包 + 状态翻转 + 不接续 pickup）。

### 11.1 真机过程中遇到的三个环境性现象（都不是 harvest 的 bug）

1. **`actor_busy` 来自 reflex 模块**
   模组里的 reflex（独立生存反射）会自己起动作：
   `A.Start("heal"/"craft"/"add_fuel"/"move_to")`。
   它在跑的时候 `Whale.job ~= nil`，于是 harvest 正确地回 `actor_busy`。
   **真实用法就是先 `stop` 再重试** —— 脚本已内置（`harvestCall`），并在日志里说明。

2. **`result_timeout`：结果文件是单槽，会被 reflex 的报告盖掉**
   真机上出现过一次 harvest 回执为 `unknown（result_timeout）`，
   而同期的 `whale_result.json` 里是 reflex 的 `{"id":"reflex","text":"torch 材料不够"}`。
   ⇒ 单槽结果文件在"多动作源"（模型指令 + reflex）并存时会互相覆盖。
   这是**桥的既有设计**（M1 起如此），不是 M2.3 引入的；脚本把它记为 NOT_OBSERVED 并重试一次。

3. **角色中途死亡导致背包清空**
   某次 harvest 回执是 `berries+1`（Lua 的 `count_diff` 亲眼看到入包），
   但 2 秒后 Node 侧读到 0 —— 随后查到角色已变成**灵魂**（`isGhost: true`），
   死亡掉落清空了背包。最终一轮（角色复活后）**Node 侧独立确认了 浆果 0 → 1**。

### 11.2 原生距离与 move_to 的容差同量级

原生上限 ≈1.03 格，而 `move_to` 的到点容差实测是"还差 0.9~1.2 格"。
所以第一次 harvest **很可能** `out_of_range`，需要再 `move_to` 一次才进得去。
真机日志里就是这个过程（第 1、2 次 out_of_range，第 3 次成功）。
**没有放宽原生距离**，只是如实记录这个体验问题。

**没有用 Fengari 或 Mock 冒充真机通过。**
