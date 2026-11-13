# M2.1 · DST 原生拾取机制审查

> 依据：**本机** `E:\SteamLibrary\steamapps\common\Don't Starve Together\data\databundles\scripts.zip`（build 762172）
> 方法：解包读取真实脚本，不用其他版本的经验推断。
> 证据类型：**STATIC**（源码） + 少量 **RUNTIME**（后续真机验证另见 `M2_1_pickup_test_report.md`）

---

## 1. `ACTIONS.PICKUP` 存在吗？

存在。`scripts/actions.lua`：

```lua
PICKUP = Action({ priority=1, extra_arrive_dist=ExtraPickupRange, mount_valid=true }),
```

- 没有自定义 `distance`（`self.distance = data.distance or nil`），也没有 `rangecheckfn`；
- `extra_arrive_dist = ExtraPickupRange`：只有**目标在海面上**时返回 `0.75`，否则 `0`。

## 2. 地面普通物品的真实执行入口

组件动作机制（不是 actionhandler）：

- `scripts/componentactions.lua` 的 `inventoryitem` 分支在满足条件时 `table.insert(actions, ACTIONS.PICKUP)`；
- 玩家状态机 `scripts/stategraphs/SGwilson.lua`：
  ```lua
  ActionHandler(ACTIONS.PICKUP, function(inst, action)
      return (rider...) or (minigameitem and "dosilentshortaction") or "doshortaction"
  end),
  ```
  即执行的是 **`doshortaction`（短动作，不走路）**。
- 服务端执行函数 `scripts/actions.lua` 的 `ACTIONS.PICKUP.fn`（约 894 行）：
  ```lua
  ACTIONS.PICKUP.fn = function(act)
      if act.doer.components.inventory ~= nil and act.target ~= nil
         and act.target.components.inventoryitem ~= nil
         and (act.target.components.inventoryitem.canbepickedup or ...) and
         not (act.target:IsInLimbo() or burning or projectile thrown) then
          ...
          act.doer:PushEvent("onpickupitem", { item = act.target })
          ...
          act.doer.components.inventory:GiveItem(act.target, nil, act.target:GetPosition())
          return true
      end
  end
  ```

## 3. 玩家拾取由哪个组件执行

- **`inventory`（`scripts/components/inventory.lua`）** 的 `GiveItem` 完成入包；
- `inventoryitem`（`scripts/components/inventoryitem.lua`）提供 `canbepickedup` / `owner` 等状态；
- 动画/状态由 `stategraphs/SGwilson.lua` 的 `doshortaction` 承担。

## 4. 是否经过 Locomotor / PlayerController

- **不经 PlayerController**（那是客户端选目标用的）。
- 项目里既有的 `push(p, ba)` 走的是 `p.components.locomotor:PushAction(ba, true)`。
  对 `PICKUP` 而言，状态机是 `doshortaction`，**不会触发移动**。

## 5. 会不会自动移动到目标？

**PICKUP 自身不会**（`doshortaction` 无 `locomote`）。但要注意：
- `ACTIONS.PICK`（采摘，`canforce=true`）和别的动作会走 `locomote`；
- 我们的 pickup 只提交 `BufferedAction(p, target, ACTIONS.PICKUP)`，不调任何 `GoToPoint`。

## 6. 是否有原生距离限制

**服务端没有**。`PICKUP.fn` 完全不检查距离；`Action` 也没有 `distance`。
客户端选目标时才有范围概念，所以**服务端可以"隔空捡"**。

→ 因此本项目**必须自己限制距离**（见 §7），这也是 M2.1 的一个关键结论。

## 7. 物品如何判断已进入背包

`inventory:GiveItem(inst, slot, src_pos)` 的行为（`components/inventory.lua`）：
- 先 `inventoryitem:OnPickup(owner, src_pos)`，若返回 `objectDestroyed` 则直接 `return`（**堆叠合并**场景：物品被吸收销毁）；
- 找不到空位时走 `self:DropItem(inst, true, true)`（**丢回地面**）；
- 成功放入槽位时 `return true`（部分分支）。

**关键**：`PICKUP.fn` 无论 `GiveItem` 成功与否都 `return true`。
→ **绝不能**用"动作没报错 / fn 返回 true"当成功判据。

正确的判据（本项目采用组合判断）：
1. 目标实体 `GetParent() == 玩家` 或 `inventoryitem.owner == 玩家` → 进了背包；
2. 目标实体已被销毁（`IsValid() == false`）**且** 玩家背包里该 prefab 总数增加 → 堆叠合并；
3. 目标仍在地上（valid）→ 失败。

## 8. 多个相同 prefab 堆叠时怎么判本次数量

- 目标实体有 `components.stackable:StackSize()`（可读本次被捡的数量）；
- 但合并进已有堆时目标实体直接失效，读不到数量；
- 因此本项目用 **执行前后"背包里该 prefab 总数"之差** 作为可核对的量，并把它作为 Node 端 `verify` 的判据；
- `picked_count` 只在能确定时给出（Lua 的 `stack_size`），不确定就不伪造（结果里用 `gained` 表达量差）。

## 9. 背包满时原生怎么返回

`GiveItem` 找不到槽位 → `DropItem` 把物品丢回地面（视觉上"捡了又掉"），`fn` 仍 `return true`。
原生也不给"背包满"的明确错误码。
→ 本项目：
- 执行**前**用原生 `inventory:CanAcceptCount(item, maxcount)` 预判，`<= 0` 直接 `inventory_full`；
- 执行**后**若目标仍在地上 → `pickup_failed`，绝不报成功。

## 10. 服务端权威执行在哪里

`ACTIONS.PICKUP.fn` 在 **服务端** 运行（`inventory:GiveItem` 会 `PushEvent("gotnewitem")` 等）。
本项目所有动作只在 `TheWorld.ismastersim` 分支执行（`guard.actor_status` 已强制 `not_authoritative` 拒绝）。

---

## 11. 候选 prefab 核实（本构建）

| prefab | 是否普通地面物品 | 依据 |
|---|---|---|
| `twigs` | ✅ | `scripts/prefabs/twigs.lua`：`inst:AddComponent("inventoryitem")` |
| `cutgrass` | ✅ | `scripts/prefabs/cutgrass.lua`：同上 |
| `flint` | ✅ | `scripts/prefabs/flint.lua`：同上（另有 `SetSinks(true)`，不影响拾取） |
| `rocks` | ❌ **不是物品** | `scripts/prefabs/rocks.lua` 定义的是巨石 `rock1/rock2/rock_flintless_*`（`baserock_fn`），不是可拾取物品 |
| `inv_rocks` | ⚠️ **本构建的真·石头物品** | `scripts/prefabs/inv_rocks.lua`（`MakeInventoryPhysics` + `rocks` 标签） |

> **这就是"必须查本机脚本"的价值**：按常见 DST 版本经验写 `rocks` 会永远拾取失败。
> 本阶段**只放行 `twigs` / `cutgrass` / `flint`**；`inv_rocks` 需要再验证其掉落形态后再决定是否加入白名单（未启用）。

## 12. 由审查得出的硬约束（已落进实现）

1. 成功判据不能用 `fn` 返回值 → 用"实体归属 / 背包 prefab 总量差"；
2. 距离必须自己限（取保守 `2.5` 格），且**不做任何自动移动**；
3. 背包可接收性用原生 `CanAcceptCount`；
4. 只对白名单 prefab 放行；
5. 目标必须来自 `N.Resolve()` 的当前快照实体，禁止按 prefab 重新搜索。
