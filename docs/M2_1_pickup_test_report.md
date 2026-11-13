# M2.1 · Pickup 测试报告

> 版本：0.15.0
> 全量：**414 / 414 通过**（M2.0.3 基线 391 + 本轮新增 23）
> 管线自检：32 / 32
> 证据类型：`UNIT`（fengari / 假 bridge / 真实临时租约文件）、`STATIC`（源码审查）、`RUNTIME`（真机，见 §6）

---

## 1. 数量

| 阶段 | tests | pass | fail |
|---|---|---|---|
| M2.0.3 基线 | 391 | 391 | 0 |
| + M2.1 Pickup（Node 10 + Lua 13） | **414** | **414** | 0 |

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `tests/m2_1-pickup-node.test.mjs` | 10 | 工具注册/Schema/快照校验/租约/信封字段/结果核对/失败映射/unknown/move_to 未变 |
| `tests/m2_1-pickup-lua.test.mjs` | 13 | guard 白名单/组件/持有/距离/失效/limbo/旧快照/忙碌/参数 + 执行三条路径（进包/合并/失败）与零副作用 |
| `tests/m2-control-dispatcher.test.mjs` | 20（既有） | **dispatcher-11 更新**：白名单从 2 个变 3 个，新增 `pickup` 为 R2（保留原意） |

> 没有删除或跳过任何既有测试；唯一改动是把 dispatcher-11 的预期从"只有两个 R1"更新为"两个 R1 + 一个 R2"。

## 2. 工具 Schema（pickup-1 / pickup-2）

- `pickup` 在 `TOOLS`、`ACTION_NAMES`、`OPEN_ACTIONS` 三处都存在（单一注册入口）；
- `required = [target_ref, snapshot_id]`，无第三个参数；
- 拒绝：缺参、`bad_format:target_ref`（`3` / `#abc` / `#12345`）、`empty_string`、`too_long:snapshot_id`、`bad_type`；
- 拒绝模型夹带：`prefab` / `x,z` / `owner_instance_id` / `lease_generation` / `guid` → `unknown_arg:*`；
- 描述里明确写了"树/建筑/容器/生物捡不了""不会自己走过去""背包满返回 inventory_full"，且不含含糊表述。

## 3. 快照与租约（pickup-3 / pickup-4 / pickup-5）

| 用例 | 结果 |
|---|---|
| 旧 `snapshot_id` | `rejected / stale_snapshot`，**命令数 0** |
| 无租约（MCP owner） | `rejected / control_denied`，**命令数 0** |
| 合法请求 | 信封含 `target_ref`、`snapshot_id`、`owner_type`、`owner_instance_id`、`authority_epoch`、`lease_id`、`lease_generation`、`runtime/session/shard/actor`、`created_at/expires_at`；授权字段全部等于权威租约 |

## 4. Lua 前置校验（pickup-L1..L9）

| 用例 | 期望 | 结果 |
|---|---|---|
| 白名单 + 1 格内 | 通过并带出实体 | ✅ `true\|nil\|true` |
| `evergreen`（树） | `prefab_not_allowed` | ✅ |
| 无 `inventoryitem` | `target_not_pickable` | ✅ |
| `canbepickedup=false` / 已被持有 | `target_not_pickable` | ✅ |
| 5 格远 | `out_of_range` | ✅ |
| 失效 / limbo / 引用不存在 | `entity_gone` / (`in_limbo`\|`unknown_ref`) / `unknown_ref` | ✅ |
| 旧快照 / 坏格式 / 缺 snapshot_id | `stale_snapshot` / `bad_format:target_ref` / `missing_arg:snapshot_id` | ✅ |
| 已有 job 在跑 | `actor_busy` | ✅ |
| `inv_rocks`（未启用） | `prefab_not_allowed` | ✅ |

## 5. 执行与结果核对（pickup-L10..L13 / pickup-6..9）

| 用例 | 结果 |
|---|---|
| 目标 `parent = 玩家` → `done`，且**恰好提交 1 次** `BufferedAction(PICKUP)` | ✅ |
| 目标失效 + 背包总数 3→4（堆叠合并）→ `done` | ✅ |
| 目标一直在地上 + 超时 → `fail`，回执是 `false`，原因 `pickup_failed`（不谎报成功） | ✅ |
| 非白名单时 `#PUSHED == 0`、`actions.Start` 未执行（零副作用） | ✅ |
| Node：游戏说成功但背包没变 → `unverified / inventory_unchanged` | ✅ |
| Node：背包 twigs 3→5 → `verify` 通过（`gained=2`）；ref 不存在 → `unknown_ref` | ✅ |
| Node：游戏拒绝（5 种 reason）→ `rejected` 且只发 1 次 | ✅ |
| Node：等不到回执 → `unknown`，只发 1 次（**不自动重试**） | ✅ |

## 6. 真机（RUNTIME）—— 0.15.0 实测

环境：真实 DST（独立服务端 PID 在跑）+ MCP 用产品 `apply()` 起在 18090；世界已加载 **0.15.0**；角色活着（wolfgang）。

| 用例 | 实测 | 判定 |
|---|---|---|
| 附近快照 / get_state | `mod=0.15.0`，40 个附近条目，白名单候选 = flint ×3 | ✅ |
| 先 move_to 靠近（8.4 格 → 1 格） | `走到了 (-16,47) 附近（还差 1.2 格）` | ✅ |
| **pickup #1 flint（1 格内）** | **背包 flint 0 → 1，物品真的进包了** | ✅ **功能生效** |
| 回执是否正确 | ❌ 报了 `in_limbo: 目标进入了 limbo`（**误报**） | ❌ 见 §7 |
| 负向：对 `deciduoustree` 调 pickup | `拒绝：prefab_not_allowed` | ✅ |
| 负向：旧 snapshot_id | `附近快照变了…（stale_snapshot）` | ✅ |
| 距离超限（6 格） | `out_of_range`（在 0.15.0 首轮里实测） | ✅ |
| 零副作用（负向用例） | 树/旧快照两种拒绝后背包与位置无变化 | ✅ |

**关键：这是真机第一次证明 pickup 能真的把东西捡进背包。**
但回执判错了（明明捡到了却报 in_limbo），所以按"回执与真实状态一致"这条，0.15.0 **不通过**。

### 6.1 0.15.1 真机复验 —— **全链路通过**

用户把背包里的燧石丢到地上（0.5~0.9 格），重进世界加载 0.15.1 后实测：

```
附近：#1 flint 0.9 格
pickup 回执: 捡起了 燧石（背包：flint+1）
背包 flint: 0 → 1
✅ pickup 返回成功
✅ 背包里该物品真的增加了（0 → 1）
✅ 回执与真实状态一致（没有谎报）   ← 0.15.0 的 in_limbo 误报已消除
✅ 旧 snapshot_id 被拒（stale_snapshot）
```

| 清单项 | 状态 |
|---|---|
| A 正常拾取 | ✅ **真机通过**（含"先 move_to 靠近再捡"） |
| B 不该捡（树） | ✅ 真机通过（`prefab_not_allowed`） |
| C 过期引用 | ✅ 真机通过（`stale_snapshot`） |
| D 背包满 | **NOT_RUN**（需要把背包塞满；`inventory_full` 已有 UNIT 用例 pickup-L15，0.15.2 起生效） |
| E 距离 | ✅ 真机通过（6 格外 → `out_of_range`） |
| F 换手 | ✅ 真机通过（M2.0.3 已验，本轮沿用同一链路） |

## 7. 本轮修掉的三个实现缺陷（测试 + 真机驱动）

1. **动作名分流**：动作名是 `pickup`，而 `JOBS.pickup` 原本是"按 prefab 搜索"的老实现 —— 新参数会被老分支吃掉。
   改为在 `JOBS.pickup` 顶部按 `ctx.target` 分流，动作名保持不变（也避免动 `tool-parity` 的动作集合）。
2. **局部函数顺序**：`snapshot_counts` / `pickup_by_ref` 若定义在调用者之后，Lua 会解析成全局 nil
   （真机表现是"动作出错: attempt to call a nil value"）。已把定义前移。

3. **limbo 判定顺序**（真机发现，0.15.1 修）：物品捡进背包后 DST 会把它放进 limbo，
   而 0.15.0 的 `pickup_by_ref` 在**判定归属之前**就因 `IsInLimbo()` 返回失败 ——
   于是"东西捡到了，回执却是 in_limbo"。0.15.1 改为：**先判归属（parent/owner==玩家）→ 再判堆叠合并 → 最后才看 limbo**。
   回归用例 `pickup-L14`（捡起后 limbo + parent=玩家 → 必须成功）。

> 这三个都是"看起来能跑、实际会在真机静默失败"的问题；其中第 3 个只有真机能发现。


## 8. 真机验证下一步（需要三件事同时满足）

1. **重进世界/重启服务端**，让 0.15.0 进内存（状态文件 `mod=0.15.0`）；
2. 角色**活着**（非 ghost）；
3. 站在**树枝 / 割下的草 / 燧石**旁边（2.5 格内）。

满足后执行：`node tools/m2_1_verify_pickup.mjs`（脚本会自动 get_state → 挑最近的候选 → pickup → 复查背包）。
