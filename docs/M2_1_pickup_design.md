# M2.1 · Pickup 设计与安全

> 版本：0.14.4 → **0.15.0**（新动作，按 minor）
> 白名单：`move_to`（R1）、`stop`（R1）、**`pickup`（R2）**
> 原生 API 依据：`docs/M2_1_pickup_api_audit.md`

---

## 1. 一句话设计

模型只能给「当前 nearby 快照里的 `#N`」和「那一帧的 `snapshot_id`」；
其余一切（租约、generation、owner 实例、runtime、真实实体、距离、背包、执行）都由受信链路负责。

## 2. 工具（Function Calling）

```json
{
  "name": "pickup",
  "inputSchema": {
    "required": ["target_ref", "snapshot_id"],
    "properties": {
      "target_ref":  { "type": "string" },   // 形如 #3，正则 ^#[0-9]{1,4}$
      "snapshot_id": { "type": "string" }    // <= 64 字符
    }
  }
}
```

**模型不能传**：`prefab`、坐标、GUID、`owner_instance_id`、`lease_generation`、`authority_epoch`、`lease_id`、`runtime_id`、Lua 函数名。
所有授权字段由 `LeaseManager` + `Dispatcher` 生成（`tests/m2_1-pickup-node.test.mjs` pickup-2 钉住）。

## 3. 执行链路（与 M2.0 完全一致，只多一个目标字段）

```
F8 / MCP
  → lib/tools.js executeTool('pickup')
  → dispatcher.dispatch()                       ① 白名单 ② Schema ③ 快照新鲜度
  → control.readAuthority() / validate()        ④ 最新权威租约 + owner 实例 + generation
  → bridge.call(..., envelope)                  ⑤ 信封带 target_ref/snapshot_id + 全部授权字段
  → Lua bridge.handle_command → guard.validate  ⑥ 权威文件 + 解析 #N + 前置条件
  → actions.Start('pickup', args, id, ctx)      ⑦ ctx.target = 已解析实体
  → JOBS.pickup → pickup_by_ref()               ⑧ BufferedAction(PICKUP) + 等真实结果
  → Report(ok/text/reason)                      ⑨ 回执
  → dispatcher 重新读快照核对背包                ⑩ succeeded / unverified
```

## 4. Lua 侧前置校验（`guard.validate` 内，顺序固定）

| 检查 | 失败 reason |
|---|---|
| 权威租约可用/active/未过期/epoch/generation/lease_id/owner/instance/环境 | `authority_*` / `stale_generation` / `wrong_owner` / `wrong_instance` / `stale_lease` |
| `Whale.job ~= nil`（一个 Actor 只允许一个动作） | `actor_busy` |
| `N.Resolve(snapshot_id, target_ref)` | `stale_snapshot` / `unknown_ref` / `entity_gone` / `in_limbo` |
| prefab 在 `G.PICKUP_PREFABS`（twigs/cutgrass/flint） | `prefab_not_allowed` |
| 有 `inventoryitem` 且 `canbepickedup == true` 且 `owner == nil` | `target_not_pickable` |
| 距离 ≤ `G.PICKUP_MAX_TILES = 2.5` 格 | `out_of_range` |
| 角色可控制（玩家/活着/非 ghost/ismastersim/有 locomotor+health+inventory） | `actor_*` / `not_authoritative` / `missing_component:*` |
| 参数（`target_ref` 正则、`snapshot_id` 非空且 ≤64、无未知字段） | `bad_format:*` / `missing_arg:*` / `unknown_arg:*` |

全部通过才 `guard.accept(cmd)` 并返回 `detail.target`（真实实体）给执行层。

## 5. 执行（`JOBS.pickup` → `pickup_by_ref`）

```lua
push(p, BufferedAction(p, target, ACTIONS.PICKUP, nil))   -- 原生动作，doshortaction，不走路
```

- **不**调用任何 `GoToPoint`/寻路，**不**按 prefab 搜索，**不**替换目标；
- 每 tick 判断：
  - `target:GetParent() == p` 或 `inventoryitem.owner == p` → `done`
  - `not target:IsValid()` 且 背包该 prefab 总数 > 执行前 → `done`（堆叠合并）
  - 6 秒仍未完成 → `pickup_failed`（还在地上）或 `result_unverified`（消失了但背包没变）
- 老调用方（`args.item`）仍走原有 prefab 搜索分支，语义未变（`ctx.target` 才走新路径）。

## 6. Node 侧结果核对

- `spec.verify(before, after, args)`：从 **before 快照** 的 nearby 桶里按 `#N` 取 prefab，
  再比较 **after 快照** 背包里该 prefab 的 `count` 总和；`after > before` 才算通过；
- `verifyWaitMs = 3000`：状态文件约 1 秒一帧，所以按 250ms 轮询最多 3 秒；
- 核对不上 → `unverified`（`reason=inventory_unchanged`），**不报成功**；
- 游戏明确拒绝 → 映射成 `rejected` 并保留原因；超时 → `unknown`，**不自动重试**。

## 7. 结果结构（沿用现有协议）

```json
{
  "status": "succeeded",          // rejected/succeeded/unverified/failed/unknown/cancelled
  "reason": null,
  "message": "捡起了 树枝（背包：twigs+1）",
  "commandId": "…",
  "target_ref": "#3",
  "snapshot_id": "r…-n193",
  "prefab": "twigs",
  "gained": 1
}
```

`accepted ≠ succeeded`、`running ≠ succeeded`、`unknown ≠ failed` 三条都保持。

## 8. 与既有能力的关系

- `move_to` / `stop`：**代码与语义零改动**（pickup-10 钉住）；
- `N.Resolve()`、Snapshot、Control Lease、Command Protocol、文件桥：全部复用，**没有第二套**；
- `Whale.guard` 仍是最终授权者，Node 只是第一道闸。
