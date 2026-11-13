# M2.3 · DST 原生收获 API 审查

> 依据：**本机** `E:\SteamLibrary\steamapps\common\Don't Starve Together\data\databundles\scripts.zip`（build 762172）
> 方法：解包读真实脚本，不用其他版本经验推断。
> 证据类型：**STATIC**（源码）＋ 后续 **RUNTIME**（真机，见测试报告）

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 本阶段用什么原生动作 | **`ACTIONS.PICK`**（不是 `ACTIONS.HARVEST`） |
| 试点对象 | **`berrybush` / `berrybush2`**（普通浆果丛） |
| 成熟判据 | `pickable:CanBePicked()` == true（且未 stuck / 未 barren / 可交互） |
| 执行结果 | 产物 `berries` **直接进背包**（`inventory:GiveItem`） |
| 状态变化 | 成功后 `canbepicked` 立刻变 false ⇒ 可靠可核对 |
| 距离 | 原生 = `目标物理半径 + 4` 世界单位；浆果丛物理半径 0.1 ⇒ **≈1.03 格** |
| 服务端是否限距 | **不限**（和 PICKUP 一样）⇒ 必须我们自己限 |
| 会走路吗 | **不会**（`doshortaction`） |

---

## 1. `ACTIONS.HARVEST` 存在吗？

存在，但**很"素"**：

```lua
-- scripts/actions.lua:392
HARVEST = Action(),
```

没有 `distance`、没有 `rangecheckfn`、没有 `canforce`。
它的执行函数 `ACTIONS.HARVEST.fn`（L2651）分派给：

```lua
crop → harvestable → stewer → dryer → dryingrack → occupiable → quagmire_tappable
```

即**农田作物、晾肉架、锅、蜂箱（harvestable）**这一类。
**浆果丛不在其中** —— 浆果丛没有 `crop` 也没有 `harvestable` 组件。

## 2. 那么成熟浆果丛的真实收获动作是？

**`ACTIONS.PICK`**：

```lua
-- scripts/actions.lua:366
PICK = Action({ canforce=true, rangecheckfn=PickRangeCheck,
                extra_arrive_dist=ExtraPickRange, mount_valid = true }),
```

原生资格由组件动作表给出：

```lua
-- scripts/componentactions.lua（pickable 处理器）
pickable = function(inst, doer, actions)
    if inst:HasTag("pickable") and not inst:HasAnyTag("fire", "intense") then
        table.insert(actions, ACTIONS.PICK)
    end
end,
```

执行函数：

```lua
-- scripts/actions.lua:1933
ACTIONS.PICK.fn = function(act)
    if act.target ~= nil then
        if act.target.components.pickable ~= nil then
            if act.target.components.pickable:IsStuck() then return false, "STUCK" end
            act.target.components.pickable:Pick(act.doer)
            return true
        elseif act.target.components.searchable ~= nil then
            return act.target.components.searchable:Search(act.doer)
        end
    end
end

-- 还有一个原生的"能不能采"前置（客户端用）
ACTIONS.PICK.validfn = function(act)
    return act.target and (
        (act.target.components.pickable and act.target.components.pickable:CanBePicked())
        or (act.target.components.searchable and act.target.components.searchable.canbesearched))
end
```

**结论：本阶段工具名叫 `harvest`（任务书指定），但底层走原生 `ACTIONS.PICK`。**
`ACTIONS.HARVEST` 属于 crop/harvestable 等对象，**本阶段不开放**。

## 3. 候选对象对应的组件

`pickable`（`scripts/components/pickable.lua`）。
组件只在**服务端**装配（`berrybush.lua` 里在 `if not TheWorld.ismastersim then return inst end` 之后）：

```lua
inst:AddComponent("pickable")
inst.components.pickable.picksound = "dontstarve/wilson/harvest_berries"
...
local function normal_postinit(inst)
    inst.components.pickable:SetUp("berries", TUNING.BERRY_REGROW_TIME)
    inst.components.pickable.max_cycles = TUNING.BERRYBUSH_CYCLES + math.random(2)
    inst.components.pickable.cycles_left = inst.components.pickable.max_cycles
    ...
end
```

## 4. 成熟怎么判断

`pickable` 的原生接口（全部实测于本机构建）：

| 方法/字段 | 实现 | 含义 |
|---|---|---|
| `CanBePicked()` | `return self.canbepicked` | **能采**（这就是"成熟"） |
| `IsBarren()` | `return self.cycles_left == 0` | 采摘次数用尽 |
| `IsStuck()` | `return self.stuck == true` | 卡住（不可采） |
| `caninteractwith` | 字段，默认 `true` | 可交互 |
| `product` | 字段 | 产物 prefab（浆果丛 = `berries`） |
| `numtoharvest` | 字段，`SetUp` 里 `number or 1` | 每次产量 |
| `cycles_left` / `max_cycles` | 字段 | 剩余/最大采摘次数 |

`SetUp` 会把 `canbepicked` 置 true：

```lua
function Pickable:SetUp(product, regen, number)
    self.canbepicked = true          -- ★ 新长出来的就是"可采"
    self.product = product
    self.baseregentime = regen
    self.regentime = regen
    self.numtoharvest = number or 1
end
```

`Pick` 成功后置 false：

```lua
function Pickable:Pick(picker)
    if self.canbepicked and self.caninteractwith and not self.stuck then
        ...
        local loot = self:SpawnProductLoot(picker)
        ...
        self.canbepicked = false      -- ★ 可靠的状态变化（核对锚点）
        if self.baseregentime ~= nil and not (self.paused or self:IsBarren() ...) then
            self.task = self.inst:DoTaskInTime(self.regentime, OnRegen)   -- 游戏自己的再生计时器
        end
        self.inst:PushEvent("picked", { picker = picker, loot = loot, plant = self.inst })
        return true, ...
    end
end
```

⇒ **成熟判据 = `CanBePicked()` 为 true**（并附 `not IsStuck()`、`not IsBarren()`、`caninteractwith`）。
**不伪造成熟度百分比**：原生没有百分比接口，只有布尔。

## 5. 执行入口 / 是否需要 PlayerController / StateGraph

- 执行：`ACTIONS.PICK.fn → pickable:Pick(doer)`；
- **PlayerController 只用于客户端**判断"能不能点"（`rangecheckfn`）；服务端 `PushAction` 不做距离校验；
- StateGraph（`SGwilson.lua:1108`）：

  ```lua
  ActionHandler(ACTIONS.PICK, function(inst, action)
      if action.target:HasTag("noquickpick") then return "dolongaction"
      elseif ... farm_plant ... then return "domediumaction"
      ... end)   -- 浆果丛 → doshortaction
  ```
  只是**播个短动画**，不带 `locomote`。

## 6. 是否通过 BufferedAction / 是否服务端权威

- 是：本项目沿用 `push(p, BufferedAction(p, target, ACTIONS.PICK, nil))`（`actions.lua` 里 `push` → `locomotor:PushAction(ba, true)`）；
- 服务端权威：`pickable` 组件只在 mastersim 装配，`ACTIONS.PICK.fn` 在服务端跑；
  本项目 `guard` 也强制 `TheWorld.ismastersim`。

## 7. 会自动移动角色吗

**不会**。`doshortaction` 没有移动步。本项目也**不**调用任何 `GoToPoint`。

## 8. 收获距离

原生（`scripts/actions.lua:18`）：

```lua
local function PickRangeCheck(doer, target)
    local extrarange = 0
    if doer.replica.combat then
        if target:HasAnyTag("jostlepick", "jostlerummage", "jostlesearch") then
            extrarange = doer.replica.combat:GetWeaponAttackRange()
        end
    end
    local target_x, _, target_z = target.Transform:GetWorldPosition()
    local doer_x, _, doer_z = doer.Transform:GetWorldPosition()
    local target_r = target:GetPhysicsRadius(0) + 4 + extrarange
    local dst = distsq(target_x, target_z, doer_x, doer_z)
    return dst <= target_r * target_r
end
```

- 浆果丛：`MakeSmallObstaclePhysics(inst, .1)` → `phys:SetCapsule(0.1, 2)` → 物理半径 **0.1**
  ⇒ 有效距离 = `0.1 + 4 = 4.1` 世界单位 ≈ **1.03 格**（1 格 = 4 世界单位）；
- **服务端不校验**（`ACTION.PICK.fn` 不看距离）⇒ 本项目必须在 `guard` 里**照抄这个公式**限制，
  否则模型可以隔空采 16 格外的浆果丛；
- 本试点对象**没有** `jostlepick` 标签（那是 juicy 浆果丛），所以 `extrarange = 0`。

> 注意：这个距离比 pickup 的 2.5 格更紧 —— 必须站得很近。这是原生规则，不放大。

## 9. 冷却 / 季节 / 成熟限制

- 采摘后按 `regentime`（`BERRY_REGROW_TIME`，受 `getregentimefn` 影响）由**游戏自己**的
  `DoTaskInTime` 计时再生；
- `cycles_left` 用尽 ⇒ `IsBarren()`，不再可采（除非移植/施肥）；
- `witherable`：冬天会枯萎，枯萎时 `Pick` 的再生分支被跳过（`inst:HasTag("withered")`）；
- 移植过的（`transplanted`）每次采摘会扣 `cycles_left`。

## 10. 收获成功后对象发生什么变化

1. `canbepicked = false`（**立刻**，可核对）；
2. 播 `picked` 事件；
3. 排一个再生任务（游戏自己的计时器）；
4. `remove_when_picked` 为真时对象移除（浆果丛不是）。

## 11. 产物是进背包还是落地

`Pickable:SpawnProductLoot`（L450）：

```lua
if self.droppicked and self.inst.components.lootdropper ~= nil then
    ... lootdropper:SpawnLootPrefab(self.product, pt)      -- 落地
else
    ... loot = ... GenerateLoot() / SpawnLootPrefab ...
    for i, item in ipairs(loot) do
        if inventory and item.components.inventoryitem then
            inventory:GiveItem(item, nil, pt)               -- ★ 直接进背包
        else
            item.Transform:SetPosition(pt:Get())
        end
    end
end
```

**本试点选普通浆果丛**：`normal_postinit` **没有**设 `droppicked` ⇒ 产物 `berries` **直接进背包**。
（`berrybush_juicy` 设了 `droppicked = true` + `jostlepick = true` ⇒ 落地，**本阶段不选**。）

## 12. 背包满时原生怎么处理

`inventory:GiveItem` 放不下时会 `DropItem` 把物品丢回地面（M2.1 已实测确认）。
⇒ 表现是"采成功了，东西掉在脚边"。所以**不能**把"背包里多了浆果"当作收获成功的唯一判据，
真正的成功锚点是 **`CanBePicked()` 翻转**。

## 13. 能否被 Abort 安全中断

- `A.Abort(reason)` 会做 `locomotor:Stop()` + `p:ClearBufferedAction()`（已有实现）；
- `Pick` 是**一次 fn 调用内完成**的原子操作：abort 发生在 fn 之前 ⇒ 世界不变；
  发生在之后 ⇒ 采摘已经发生（`canbepicked` 已 false），此时"世界副作用"属于**已完成的采摘**，
  而不是"未授权的后续副作用"；
- **再生计时器是游戏自己的**（`inst:DoTaskInTime`），它属于游戏状态，**不应该**被我们的 abort 取消；
- ⇒ 换手安全性判据：**`Whale.job == nil` 不能单独作为"没有未完成副作用"的证明**。
  必须额外确认：① 没有待执行的我们自己排的动作；② 目标状态已经定格（`canbepicked` 已 false 或
  明确未变化）。本阶段的做法：harvest job 在**核对完成或超时**后才清 `Whale.job`，
  并且 ACK 只在 `job_cleared == true` 时才被 Node 接受（见安全文档）。

---

## 14. 试点对象选择

| 候选 | 原生动作 | 需要工具 | 成熟可判 | 结果可核对 | 风险 | 结论 |
|---|---|---|---|---|---|---|
| **`berrybush` / `berrybush2`** | `ACTIONS.PICK` | 否 | `CanBePicked()` | 状态翻转 + 背包 `berries` | 无（不会打人、不掉血、不破坏建筑） | ✅ **选它** |
| `berrybush_juicy` | `ACTIONS.PICK` | 否 | 同上 | 同上（但产物**落地**） | `droppicked` + `jostlepick`（距离规则不同） | ❌ 本阶段不选 |
| `grass` / `sapling` | `ACTIONS.PICK` | 否 | `CanBePicked()` | 状态翻转 | 同时带 `workable(DIG)`，容易和"挖"混 | ❌ 本阶段不选 |
| `carrot_planted` | `ACTIONS.PICK` | 否 | `CanBePicked()` | 状态翻转 | 会 `remove_when_picked`（收获即移除），"对象变化"语义不同 | ❌ 本阶段不选（留作下一轮） |
| 农田作物 | **`ACTIONS.HARVEST`** | 否 | `crop` 组件 | 复杂（要照料/水/季节） | 前置条件多，不易重复验证 | ❌ 本阶段不选 |
| 晾肉架/锅/蜂箱 | `ACTIONS.HARVEST` | 视情况 | `harvestable` | 中等 | 属于"设施"不是"采集" | ❌ 本阶段不选 |
| 树 / 岩石 / 冰 | `CHOP`/`MINE` | 需要 | — | — | 破坏性 | 🚫 明确禁止 |

**最终选择：`berrybush` 与 `berrybush2`**（两者用**同一个** `normal_postinit`，语义完全一致，
差别只是动画 bank；所以按"同一种目标类型"一起放行）。
产物固定 `berries`，`droppicked` 未设 ⇒ 直接入包。

## 15. 暂不支持的对象（明确拒绝）

`berrybush_juicy`、`grass`、`sapling`、`reeds`、`carrot_planted`、`mushroom*`、农田 `crop`、
`harvestable` 设施（晾肉架/锅/蜂箱）、树/岩石/冰/建筑/生物 —— 一律 `prefab_not_allowed`。

## 16. 由审查得出的硬约束

1. 工具名 `harvest`，**底层原生动作是 `ACTIONS.PICK`**，文档与描述里都要写清楚；
2. 成功判据**不能只看 fn 返回值**，要看 `CanBePicked()` 是否翻转（必要时叠加背包产物数量）；
3. 距离必须**照抄原生公式** `physics_radius + 4`（世界单位），服务端不限距；
4. 成熟判据用原生 `CanBePicked()`（+ 非 stuck / 非 barren / 可交互），**不造百分比**；
5. 只对白名单 prefab 放行；目标必须来自 `N.Resolve()` 的当前快照实体，禁止按 prefab 搜替代；
6. 背包满时产物会落地 ⇒ 报告要区分"已入包"与"已收获但落地"；
7. 与 Pickup **不合并**：不自动接着捡。
