# M2.3 · Harvest 安全说明

> 原则不变：**Node 是第一道闸，Lua 是最终授权者；观察永远不是授权。**
> 本文只列 harvest 新增/复用的安全点，以及每个点对应的测试。

---

## 0. 本阶段先修的一个安全底座缺口（P0）

`completeHandover()` 此前**没有校验 `ack.job_cleared === true`**，`lease_id` 也是**可选**的。

- 这条在 M2.0.1 审计里就列为 P0，M2.1 的任务书原文要求"必须确认 `job_cleared === true` 是完成换手的必要条件……在这个安全条件未满足前，不允许开放 pickup"；
- 但直到本轮才真正补上（pickup 是在缺这条的情况下开放的）；
- Harvest 是**会改世界对象**的跨 tick 动作，正是这条要防的场景，所以本次必须一起修。

**修复内容**（`lib/control.js`）：

| 检查 | 失败原因 |
|---|---|
| ack 存在且是对象 | `handover_ack_missing` |
| `authority_epoch` 精确匹配 | `handover_ack_epoch_mismatch` |
| `generation` 精确匹配 | `handover_ack_generation_mismatch` |
| `runtime_id` 匹配 | `handover_ack_runtime_mismatch` |
| **`lease_id` 必须存在** | `handover_ack_lease_id_missing` |
| `lease_id` 必须匹配 | `handover_ack_lease_id_mismatch` |
| **`job_cleared === true`（严格布尔）** | `handover_job_not_cleared` |
| 有时间戳 | `handover_ack_no_timestamp` |
| 不早于本次换手（含 3s 时钟偏差） | `handover_ack_stale` |
| 不超过 15s | `handover_ack_expired` |

任何一条不满足 → **保持 `revoking`**（fail-closed），Lua 继续拒绝一切动作。
测试：`harvest-25`（逐条拒绝 + 合法确认才放行）、`m2_0_1` / `m2_0_2` / `dispatcher` 的既有用例已更新到新契约。

---

## 1. Actor 校验（复用 M2.0，未改）

`guard.actor_status`：有效 / 是玩家 / 非 ghost（**先于 alive 判**）/ 存活 / `ismastersim` /
有 `locomotor`+`health`+`inventory`；兜底观察实体一律拒绝。
harvest 的 `required_components = { locomotor, health, inventory }`。

## 2. Control Lease（完全复用）

每次 dispatch 重新读权威租约；精确核对 `authority_epoch / generation / lease_id / owner_type /
owner_instance_id / runtime / session / shard / actor / expires_at`；`revoking` 期间双向拒绝。

## 3. Target Resolve（复用 `N.Resolve`，禁止 prefab 搜索）

- `ref` 必须属于**当前**快照，否则 `stale_snapshot`；
- 实体必须有效、不在 limbo，否则 `entity_gone` / `in_limbo`；
- **绝不**按 prefab 找同类的另一株植物来"替代"（`harvest-27` 用源码断言钉住：`harvest_by_ref` 里没有 `find_all`/`find_by_name`）。

## 4. 执行前重新判成熟度（本阶段重点）

**快照是过去的**：拿到 `#N` 到真正执行之间，可能被别人采了、可能刚进入不可采状态。

所以 `guard.validate` 的 harvest 分支在授权那一刻**重新**调用：

```lua
HarvestRules.IsCandidate(ent, actor)  → prefab_not_allowed / target_not_harvestable / in_limbo
HarvestRules.IsReady(ent)             → not_ready / already_harvested / target_busy
HarvestRules.InNativeRange(actor,ent) → out_of_range
```

只有全部通过才 `guard.accept(cmd)` 并把实体交给执行层。

测试：`harvest-11`（未成熟 → `not_ready`）、`harvest-12`（次数用尽/卡住）、`harvest-13`（超距）。

## 5. 距离（原生公式，服务端自己限）

原生 `PickRangeCheck` = `物理半径 + 4` 世界单位，**服务端不校验**。
`HarvestRules.InNativeRange` 照抄公式（读不到半径兜底 4 世界单位），超出一律 `out_of_range`，
**不替模型移动**（`harvest-04` / `harvest-13`）。

## 6. 防重复执行

- `command_id`（UUID）由 dispatcher 生成；Lua `last_cmd_id` 单槽 + guard 环形去重；
- 同 id 再送达 → `duplicate_command`；
- **`unknown` 不自动重试**（恢复流程是"先 `get_state` 看现状"，不是重发命令）；
- 一个 Actor 同时只允许一个动作：`Whale.job ~= nil` → `actor_busy`（不静默打断）。

## 7. 服务端权威

- `pickable` 组件只在 `TheWorld.ismastersim` 装配；`ACTIONS.PICK.fn` 在服务端跑；
- `guard` 强制 `ismastersim`；
- 产物由**原生** `SpawnProductLoot`/`GiveItem` 产生，**不手工造掉落、不改收获次数**。

## 8. 换手与 Abort（harvest 是跨 tick 动作）

| 关注点 | 结论 |
|---|---|
| 挂起的原生动作 | `A.Abort()` → `ClearBufferedAction()`，**在 fn 执行前**被丢弃 ⇒ 世界不变 |
| 已经执行的采摘 | 一次 fn 调用内完成；`canbepicked` 已翻转 ⇒ 属于**已完成**的副作用，不会继续变化 |
| 游戏自己的再生计时器 | `inst:DoTaskInTime(regentime, OnRegen)` 是**游戏状态**，不该由我们的 abort 取消 |
| ACK 时机 | 只有 `Whale.job == nil` **且** Node 校验 `job_cleared === true` 才放行换手；缺这条就保持 `revoking` |
| 未授权副作用 | 换手后旧 owner 的命令被 generation/epoch 拒绝；不会有"新 owner 已接管但旧动作还在改世界"的窗口（因为 ACK 要求 job 已清） |

> 「`Whale.job == nil` 就等于所有原生副作用都停了」这句话**不成立**，
> 所以本阶段的做法是：ACK 明确携带 `job_cleared`，并且 **Node 必须校验它为严格 true**；
> 同时 `A.Abort` 同步清掉 buffered action。测试 `harvest-26` 用源码断言钉住这两点。

## 9. 结果可信性

- 原生 `ACTIONS.PICK.fn` 返回 true 只代表"调用了 Pick"，**不是**核对；
- 真正的锚点是 `CanBePicked()` 翻转（`harvest-17`/`18`/`19`）；
- 背包满时产物会掉地上（原生 `GiveItem` 行为）⇒ 回执必须区分"入包 / 落地"，不能把没入包当失败，也不能把落地当入包；
- Node 第二层核对失败 → `unverified`；等不到回执 → `unknown`（不重试）。

## 10. 输入面

模型只能传 `target_ref` + `snapshot_id`；
`guid`/`prefab`/坐标/`owner_instance_id`/`lease_generation`/`authority_epoch`/`lease_id`/Lua 字符串
一律 `unknown_arg:*` 拒绝（`harvest-22`），且拒绝发生在**写命令之前**（`harvest-24`）。

## 11. 信任边界（继承）

能写 `Cluster_N/<分片>/save/whale_lease.json` 的人就能改控制权 —— 文件系统权限问题，本架构不防御恶意本地管理员。
