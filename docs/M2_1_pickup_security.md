# M2.1 · Pickup 安全说明

> 与 `docs/M2_0_2_league_security_matrix` 同一套原则：**Node 是第一道闸，Lua 是最终授权者。**
> 本文只列 pickup 新增/复用的安全点，以及每个点对应的测试。

---

## 1. Actor 安全（复用 M2.0，未改）

| 场景 | 结果 | 测试 |
|---|---|---|
| Actor 不存在 | `no_actor_*` | M2.0 guard-* |
| 非玩家（观察兜底实体） | `actor_not_player` | M2.0 guard-25 |
| ghost | `actor_is_ghost`（**先于 alive 判**） | M2.0 guard-23 |
| 死亡 | `actor_dead` | M2.0 guard-24 |
| 缺 `inventory` 组件 | `missing_component:inventory` | pickup 规格里已声明 required_components |
| 非权威环境 | `not_authoritative` | M2.0 guard-26 |

pickup 的 `required_components = { locomotor, health, inventory }`，比 move_to 多了 `inventory`。

## 2. Control Lease / Generation Fencing（完全复用）

- 每次 dispatch 重新读权威租约（`control.readAuthority()`），不信任内存旧副本；
- 精确核对 `authority_epoch / generation / lease_id / owner_type / owner_instance_id / runtime / session / shard / actor`；
- `revoking` 期间 Lua 与 Node 双向拒绝；
- 测试：M2.0 的 lease-1..9、guard-*、`pickup-4`（无租约 → `control_denied` 且不写命令）。

## 3. #N 解析（复用 `N.Resolve`，禁止 prefab 搜索）

| 场景 | reason |
|---|---|
| snapshot_id 不是当前扫描 | `stale_snapshot` |
| ref 不存在 | `unknown_ref` |
| 实体失效 | `entity_gone` |
| 进 limbo | `in_limbo`（注：INLIMBO 实体会被 nearby 扫描直接过滤，所以实际多为 `unknown_ref`，两者都是拒绝） |
| 换手/重启后的旧引用 | `stale_snapshot`（runtime 前缀不匹配） |

Node 侧额外一道：`args.snapshot_id` 必须**等于**当前快照 id，否则 `stale_snapshot` 且**不写命令**（pickup-3）。

## 4. 目标前置条件（本阶段新增）

| 场景 | reason | 测试 |
|---|---|---|
| 树/建筑/容器/生物（不在白名单） | `prefab_not_allowed` | pickup-L2 / pickup-L9 |
| 没有 `inventoryitem` | `target_not_pickable` | pickup-L3 |
| `canbepickedup = false` | `target_not_pickable` | pickup-L4 |
| 已被别人/别处持有（`owner ~= nil`） | `target_not_pickable` | pickup-L4 |
| 超过 2.5 格 | `out_of_range` | pickup-L5 |

**不做**：不找同 prefab 的替代目标、不修改 ref、不扩大范围、不自动移动靠近。

## 5. 防重复执行

- `command_id`（UUID）由 dispatcher 生成；Lua `last_cmd_id` 单槽 + guard 32 条环形去重；
- 同一 `command_id` 再送达 → `duplicate_command`；
- **unknown 不自动重试**（pickup-9：只发一次）。

## 6. 权威性

- 动作只在 `TheWorld.ismastersim` 执行；
- Lua 每次 validate 重读权威租约文件（ps 缓存 ≤5s，过期即 fail-closed）；
- 无第二写入者：Node 写权威，Lua 只写 `whale_lease_ack.json`（换手确认）。

## 7. 结果可信性（本阶段重点）

**`ACTIONS.PICKUP.fn` 在背包满时仍 `return true`**（物品被 `DropItem` 丢回地面），
所以"动作没报错" ≠ 成功。三重判据：

1. Lua：目标 `parent/owner == 玩家` → 成功；
2. Lua：目标失效且背包该 prefab 总数增加 → 成功（堆叠合并）；
3. Node：after 快照背包该 prefab `count` 总和 > before → 才 `succeeded`；否则 `unverified`。

对应测试：pickup-6（不变 → unverified）、pickup-7（增量 → 通过）、pickup-L10（进背包）、pickup-L11（合并）、pickup-L12（一直在地上 → fail）。

## 8. 失败与超时

| 情况 | 行为 |
|---|---|
| 游戏明确拒绝 | `rejected` + 原始 reason，不重试 |
| 动作 6 秒没完成 | `pickup_failed` / `result_unverified` |
| 等不到回执 | `unknown`（`result_timeout`），**禁止自动重试** |
| 核对不上 | `unverified`（`inventory_unchanged`） |

## 9. 信任边界（继承 M2.0.3 结论）

能写 `Cluster_N/<分片>/save/whale_lease.json` 的人就能改控制权 —— 这是文件系统权限问题，
本架构不防御恶意本地管理员。`authority_epoch`/`runtime_id` 只挡"换手前的旧命令"。
