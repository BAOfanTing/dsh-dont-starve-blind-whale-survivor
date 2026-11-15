# DST AI 模组代码考古报告

**调查对象**
- 仓库 A：`https://github.com/hineios/FAtiMA-DST`
- 仓库 B：`https://github.com/votus777/DST-AICompanion`

**验证基准**：本机实装的 DST 构建 **762172**（`E:\SteamLibrary\steamapps\common\Don't Starve Together\version.txt` = `762172`，对应 76xxxx 系列）。
我从 `data/databundles/scripts.zip`（4109 个条目）解包出引擎 Lua 源码，逐条比对两个仓库用到的 API。**下文所有"引擎侧证据"均来自该构建的真实源码，不是记忆或推测。**

**取证方式**
- 元数据：`https://api.github.com/repos/<owner>/<repo>`（HTTP 200）
- 文件树：`https://api.github.com/repos/<owner>/<repo>/git/trees/<branch>?recursive=1`（HTTP 200）
- commit：`https://api.github.com/repos/<owner>/<repo>/commits?sha=<branch>&per_page=100`（HTTP 200）
- 源码原文：`https://raw.githubusercontent.com/...`（全部 HTTP 200，字节数与文件树 `size` 完全一致）

**结论先说**：两个仓库都真实存在、都可访问、都是 **MIT**。B 是 A 的直接衍生（fork 关系不成立，但是同一份代码的后继改造版），两者共用同一套 HTTP + FAtiMA-Server 架构。**A 的代码已 8 年未更新（2018-11），但其核心 API 在 762172 上仍然全部有效**——这点与"老仓库必然崩"的直觉相反，下面用源码逐条证明。B 反而有两个**真正的运行时崩溃点**，都在它自己新增的代码里。

---

## 一、仓库 A：hineios/FAtiMA-DST

### 1.1 元数据（已读到，来自 GitHub API）

| 项目 | 值 | 状态 |
|---|---|---|
| 是否存在 | 是，`full_name` = `hineios/FAtiMA-DST` | 已读到 |
| 默认分支 | `master` | 已读到 |
| 最后一次 commit | **2018-11-21T23:59:33Z**（`99f1fdaa`，"Lost changes from the final"） | 已读到 |
| `pushed_at` | 2018-11-21T23:59:47Z | 已读到 |
| `created_at` | 2017-09-20T14:44:13Z | 已读到 |
| 许可证 | **MIT**，`LICENSE` 文件实读：`Copyright (c) 2018 Fábio Almeida` | 已读到 |
| 主要语言 | C#（GitHub 统计），但 mod 本体是 Lua | 已读到 |
| 归档 | `archived: false`，`fork: false` | 已读到 |
| 仓库大小 | 951 KB | 已读到 |

**Lua 文件仅 3 个**（全树 47 个条目，其余是 C# 服务端和 FAtiMA-toolkit 的预编译 DLL）：
```
2364  FAtiMA-DST/modinfo.lua
2373  FAtiMA-DST/modmain.lua
20770 FAtiMA-DST/scripts/brains/fatimabrain.lua
```

> 注意：仓库里 `FAtiMA-toolkit/*.dll` 是**无源码的二进制**（ActionLibrary.dll、RolePlayCharacter.dll 等 16 个）。这部分不可审计，也不受 MIT 覆盖范围的明确约束（MIT 只覆盖"本仓库中的软件"，第三方 DLL 的权利状态在仓库内没有声明）。`modinfo.lua` 里 `api_version = 10`，与 762172 的 `MOD_API_VERSION = 10`（`scripts/mods.lua`）**一致，不触发 "Old API" 警告**。

### 1.2 AI 调度：用了 DST 原生 Brain/BehaviourNode 体系（已读到源码）

**是原生的。** 这一点非常关键，值得借鉴。

`A_fatimabrain.lua:91` 用标准 `Class(Brain, ...)` 派生，构造函数里调 `Brain._ctor(self, inst)`：
```lua
local FAtiMABrain = Class(Brain, function(self, inst, server)
    Brain._ctor(self, inst)
    self.inst = inst
    self.FAtiMAServer = server or "http://localhost:8080"
```

`OnStart()`（`A_fatimabrain.lua:299`）末尾构建行为树并交给引擎：
```lua
local root = PriorityNode({
    IfNode(function() return (self.CurrentAction ~= nil and self.CurrentAction.Type == "Action"
        and self.CurrentAction.Action ~= "WANDER") end, "IfAction",
        DoAction(self.inst, function() ... end, "DoAction", true)),
    WhileNode(function() return (... Action == "WANDER") end, "Wander",
        Wander(self.inst, nil, nil, { minwalktime = 5, randwalktime = 1, minwaittime = 1, randwaittime = 1}))
}, 1)
self.bt = BT(self.inst, root)
```

用到的节点：`PriorityNode` / `IfNode` / `WhileNode` / `DoAction` / `Wander` / `BT`。全部在 762172 中存在：
- `scripts/behaviourtree.lua` 有 `function PriorityNode`（实读确认）
- `scripts/behaviours/doaction.lua` 有 `DoAction = Class(BehaviourNode, ...)`
- `scripts/behaviours/wander.lua` 的签名是 `Wander(self, inst, homelocation, max_dist, times, getdirectionFn, setdirectionFn, checkpointFn, data)`，且 `times` 表支持 `minwalktime/randwalktime/minwaittime/randwaittime` 四个键（实读第 7–12 行）——**A 的调用方式完全正确**。

**架构要点（这是它最值得学的设计）**：AI 的"思考"完全不在 Lua 里。Lua 只做两件事：
1. 每 0.75 秒（`PERCEPTION_UPDATE_INTERVAL`）把世界状态 `POST` 给外部 C# 服务器；
2. 每 2 秒（`DSTACTION_INTERVAL`）`GET` 一次决策，把结果塞进 `self.CurrentAction`。

行为树本身只是一个**哑执行器**：`IfNode` 判断"当前有没有待执行动作"，有就用 `DoAction` 去执行。真正的决策（情感评估、效用打分、MCTS）在 `FAtiMA-Server.exe` 里。这是典型的**外置大脑 / 躯体代理（body proxy）**模式。

三条并行的周期任务：
| 任务 | 间隔 | 作用 |
|---|---|---|
| `PerceptionsTask` | 0.75 s | 感知上行 |
| `DSTActionTask` | 2 s | 行为决策下行 |
| `SpeakActionTask` | 10 s | 对话决策下行 |

### 1.3 感知 API（已读到源码）

**主感知**用 `TheSim:FindEntities`（`A_fatimabrain.lua:196`）：
```lua
local x, y, z = self.inst.Transform:GetWorldPosition()
local TAGS = nil
local EXCLUDE_TAGS = {"INLIMBO", "NOCLICK", "CLASSIFIED", "FX"}
local ONE_OF_TAGS = nil
local ents = TheSim:FindEntities(x, y, z, SEE_DIST, TAGS, EXCLUDE_TAGS, ONE_OF_TAGS)
```
`SEE_DIST = 21`。这个 4 参数（含 `musttags`/`canttags`/`oneof_tags`）的签名在 762172 中有效。

**没有用 `FindEntity`，也没有用 `GetClosestInstWithTag`**。A 是"全量扫描 + 自己算最近"：它把半径内所有实体逐个转成一张属性表，发给服务器，让服务器去排序。`GetClosestInstWithTag` 确实存在于 `scripts/simutil.lua`，但 A 没用。

**实体属性提取**（`Entity()`，第 44–70 行）—— 这是它感知层的核心，把引擎对象压成纯数据：
```lua
d.GUID = v.GUID
d.Prefab = v.prefab
d.Quantity = v.components.stackable ~= nil and v.components.stackable:StackSize() or 1
d.Collectable = v:HasTag("pickable")            -- PICK
d.Edible      = inst.components.eater:CanEat(v)
d.Equippable  = v:HasTag("_equippable")
d.Fuel        = v:HasTag("BURNABLE_fuel")
d.Fueled      = v:HasTag("BURNABLE_fueled")
d.Pickable    = v.components.inventoryitem and v.components.inventoryitem.canbepickedup and not v:HasTag("heavy")
d.Choppable   = v:HasTag("CHOP_workable")
d.Diggable    = v:HasTag("DIG_workable")
d.Hammerable  = v:HasTag("HAMMER_workable")
d.Mineable    = v:HasTag("MINE_workable")
d.X, d.Y, d.Z = v.Transform:GetWorldPosition()
```

**这些 tag 我全部在 762172 里验证过存在**：
| Tag | 引擎侧证据 |
|---|---|
| `pickable` | 98 个文件使用，如 `scripts/prefabs/cactus.lua` |
| `CHOP_workable` / `MINE_workable` / `DIG_workable` / `HAMMER_workable` | 分别 17 / 21 / 15 / 27 个文件，如 `scripts/prefabs/alterguardian_laser.lua` |
| `BURNABLE_fuel` / `BURNABLE_fueled` | `scripts/componentactions.lua` 中实读确认 |
| `_equippable` | `scripts/entityreplica.lua:40` `self:AddTag("_"..name)` —— 组件复制时自动加下划线前缀 tag |
| `INLIMBO` / `NOCLICK` / `CLASSIFIED` | 421 / 588 / 211 个文件 |

**其他感知**：
- 背包：遍历 `self.inst.components.inventory.itemslots` 与 `.equipslots`
- 身体：`components.health.currenthealth` / `components.hunger.current` / `components.sanity.current`
- 温度：`self.inst:GetTemperature()`、`:IsFreezing()`、`:IsOverheating()`、`:GetMoisture()`
  - 引擎证据：这些**不是** `EntityScript` 的方法，而是 `scripts/prefabs/player_common.lua` 里的赋值：`inst.GetTemperature = GetTemperature`、`inst.IsFreezing = IsFreezing`、`inst.IsOverheating = IsOverheating`、`inst.GetMoisture = GetMoisture`（实读确认）。因为 AI 角色是用 `SpawnPrefab("wilson")` 造的**真玩家实体**，所以这些方法存在。
- 光照：`self.inst.LightWatcher:IsInLight()`。`player_common.lua` 有 `inst.entity:AddLightWatcher()`，可用。
- 世界状态：`WatchWorldState` 订阅 `cycles/phase/moonphase/season/seasonprogress/elapseddaysinseason/remainingdaysinseason/springlength/summerlength/autumnlength/winterlength/issnowing/israining`
- 时钟：`ListenForEvent("clocktick", ..., TheWorld)` 与 `("clocksegschanged", ...)`
- 初始时钟：`TheWorld.net.components.clock:OnSave().segs`（第 367 行）

**感知里没有"找最近敌人/光源"的专门逻辑**。它不做任何筛选，全部丢给服务器。这是 A 与 B 最大的设计分歧点。

### 1.4 动作执行：`BufferedAction` + `DoAction`（间接 `locomotor:PushAction`）（已读到源码）

**用原生 `BufferedAction`，没有直接调组件。** 这是标准做法。

A 自己**不**调 `locomotor:PushAction`，而是把 `BufferedAction` 交给 `DoAction` 节点，由 `DoAction` 内部推给 locomotor。引擎侧证据（`scripts/behaviours/doaction.lua` 实读）：
```lua
function DoAction:Visit()
    if self.status == READY then
        local action = self.getactionfn(self.inst)
        self.action = action
        ...
        action:AddFailAction(function() ... end)
        action:AddSuccessAction(function() ... end)
        self.inst.components.locomotor:PushAction(action, FunctionOrValue(self.shouldrun))
```

`BufferedAction` 构造（`A_fatimabrain.lua:398`）：
```lua
local b = BufferedAction(
    self.inst,                                                    -- doer
    Ents[tonumber(self.CurrentAction.Target)],                    -- target
    ACTIONS[self.CurrentAction.Action],                           -- action
    Ents[tonumber(self.CurrentAction.InvObject)],                 -- invobject
    (self.CurrentAction.PosX ~= "-" and Vector3(...) or nil),     -- pos
    (self.CurrentAction.Recipe ~= "-") and self.CurrentAction.Recipe or nil)  -- recipe
```
762172 的实际签名（`scripts/bufferedaction.lua` 第 2 行实读）：
```lua
BufferedAction = Class(function(self, doer, target, action, invobject, pos, recipe, distance, forced, rotation, arrivedist)
```
**前 6 个参数完全对得上**，多出来的 4 个是可选的。

`AddFailAction` / `AddSuccessAction` 在 762172 中仍存在（`bufferedaction.lua` 第 74、78 行）。

**动作集**是"字符串 → `ACTIONS[...]`"的动态派发，不是硬编码分支：
```lua
ACTIONS[self.CurrentAction.Action]
```
配合 `KeepWorking()`（第 82 行）实现"持续砍/挖直到目标不再可作业"：
```lua
local function KeepWorking(action, target)
    local t = Ents[tonumber(target)]
    return (action == "CHOP"   and t ~= nil and t:HasTag("CHOP_workable"))
        or (action == "HAMMER" and t ~= nil and t:HasTag("HAMMER_workable"))
        or (action == "DIG"    and t ~= nil and t:HasTag("DIG_workable"))
        or (action == "MINE"   and t ~= nil and t:HasTag("MINE_workable"))
end
```

**`Ents` 是引擎全局表**（`scripts/main.lua` 里 `Ents = {}`，实读确认），`SpawnPrefab` 也是通过 `return Ents[guid]` 返回实体的（`scripts/mainfunctions.lua:436`）。所以 `Ents[tonumber(GUID)]` 是合法查表。

README 里列了 **58 个动作**（ACTIVATE、ADDFUEL、ATTACK、BAIT、BUILD、CASTSPELL、CHOP、COMBINEStack、COOK、DEPLOY、DIG、DROP、DRY、EAT、EQUIP、EXTINGUISH、FEED、FEEDPLAYER、FERTILIZE、FILL、FISH、GIVE、GIVEALLTOPLAYER、GIVETOPLAYER、HAMMER、HARVEST、HEAL、JUMPIN、LIGHT、LOOKAT、MANUALEXTINGUISH、MINE、MOUNT、MURDER、NET、PICK、PICKUP、PLANT、REEL、RESETMINE、RUMMAGE、SADDLE、SEW、SHAVE、SLEEPIN、SMOTHER、STORE、TAKEITEM、TERRAFORM、TURNOFF、TURNON、UNEQUIP、UNSADDLE、UPGRADE、WANDER、WALKTO）。我抽查的 `CHOP/MINE/PICK/PICKUP/ATTACK/UNEQUIP/DROP/BUILD/GOHOME/WALKTO/HARVEST` 在 762172 的 `scripts/actions.lua` 里**全部存在**（逐一实读行号确认）。

### 1.5 拾取 / 砍树 / 攻击的具体代码路径（已读到源码）

**A 没有这三者的专用函数。** 这是它和 B 的根本区别——A 走**全动态派发**，所有动作共用同一条路径：

```
服务器下发 {"Type":"Action","Action":"PICK","Target":"<GUID>","InvObject":"-","PosX":"-","PosZ":"-","Recipe":"-"}
  ↓ DecideCallback (第 114 行)
self.CurrentAction = action
  ↓ 行为树 IfNode 命中
DoAction → BufferedAction(inst, Ents[GUID], ACTIONS["PICK"], nil, nil, nil)
  ↓ locomotor:PushAction
成功 → AddSuccessAction → OnActionEndEvent(WFN, Target)
失败 → AddFailAction → 若是 work 动作且仍可作业则重试，否则 OnActionEndEvent + 清空
```

三者唯一差别是 `ACTIONS[...]` 的键名，以及 `KeepWorking` 对 CHOP/MINE/HAMMER/DIG 的额外"续作"处理：

| 动作 | 键 | 目标解析 | 续作逻辑 |
|---|---|---|---|
| 拾取 | `PICK`（可采集物）/ `PICKUP`（地面物品） | `Ents[tonumber(Target)]` | 无（`IsWorkAction` 不含它） |
| 砍树 | `CHOP` | `Ents[tonumber(Target)]` | `KeepWorking` 检查 `CHOP_workable` |
| 攻击 | `ATTACK` | `Ents[tonumber(Target)]` | 无（A 的 `IsWorkAction` 不含 ATTACK） |

**决策依据在服务器侧**。`A_Perceptions.cs` 把每个实体转成 18 条 belief（`InSight(GUID)`、`IsChoppable(GUID)`、`IsPickable(GUID)`……），`A_Action.cs` 解析 WFN 字符串 `Action(CHOP, -, -, -, -)` 还原成 `DSTAction`。所以"该砍哪棵树"是 C# 用效用函数算的，Lua 完全不参与。

### 1.6 过时/会崩的 API（已逐条对 762172 验证）

**先说结论：A 没有任何一个"因为引擎 API 变更而必然崩溃"的点。** 8 年未更新，但它用的都是 DST 最稳定的核心接口。下面是逐条验证结果，包括**看起来可疑但实际安全**的项：

| # | 用法 | 762172 状态 | 判定 |
|---|---|---|---|
| 1 | `self.inst:InterruptBufferedAction()`（第 121 行） | `entityscript.lua:1595` `EntityScript.InterruptBufferedAction = EntityScript.ClearBufferedAction` | **安全**。是遗留别名，仍保留 |
| 2 | `TheSim:QueryServer(url, cb, "POST", json.encode(data))` | 引擎自用 `motdmanager.lua:496`、`mainscreen.lua:482` 等 7 处，签名一致 | **安全** |
| 3 | `TheWorld.net.components.clock:OnSave().segs` | `scripts/components/clock.lua:449` `function self:OnSave()` 返回 `data.segs`（按 `PHASE_NAMES` 键的 table） | **安全**（`pigking.lua` 也这么用 `TheWorld.net.components.clock`） |
| 4 | `BufferedAction(doer, target, action, invobject, pos, recipe)` | 762172 签名前 6 参数一致 | **安全** |
| 5 | `b:AddFailAction` / `AddSuccessAction` | `bufferedaction.lua:74/78` | **安全** |
| 6 | `PriorityNode` / `IfNode` / `WhileNode` / `DoAction` / `Wander` / `BT` | `behaviourtree.lua`、`behaviours/doaction.lua`、`behaviours/wander.lua` 全在 | **安全** |
| 7 | `Wander(inst, nil, nil, {minwalktime=..., randwalktime=...})` | `wander.lua` 第 7–12 行确认 `times` 表支持这 4 个键 | **安全** |
| 8 | `WatchWorldState("springlength", ...)` | `worldstate.lua:128` `SetVariable("springlength", data.spring)`；`AddWatcher` 存在 | **安全** |
| 9 | `TheSim:FindEntities(x,y,z,dist,must,cant,oneof)` | 4 参数签名有效，引擎 `runaway.lua:128` 同款调用 | **安全** |
| 10 | `inst.components.eater:CanEat(v)` | `eater.lua:320` `CanEat(food)` → `TestFood`，内部 `if food ~= nil and food.components.edible ~= nil` 有 nil 保护 | **安全** |
| 11 | `api_version = 10` | `scripts/mods.lua: MOD_API_VERSION = 10` | **安全**，不触发 Old API |

**但 A 有 3 个真实缺陷（与版本无关，是逻辑 bug）：**

**(a) `WatchWorldState` 回调名拼错 —— 3 个回调永远是 `nil`**

第 180–183 行定义的函数名是 `OnSpringLength` / `OnAutumnLength` / `OnWinterLength`（`Length`），
第 359–362 行订阅时写的是 `self.OnSpringLenght` / `self.OnAutumnLenght` / `self.OnWinterLenght`（`Lenght`，字母顺序颠倒）。

```lua
-- 定义（正确拼写）
self.OnSpringLength = function(inst, springlength) ... end
-- 订阅（错误拼写 → nil）
self.inst:WatchWorldState("springlength", self.OnSpringLenght)
self.inst:WatchWorldState("autumnlength",  self.OnAutumnLenght)
self.inst:WatchWorldState("winterlength",  self.OnWinterLenght)
```

引擎侧确认这是**静默失败**而非崩溃：`worldstate.lua:294` `table.insert(watcherfns, { fn, target })` 不校验 `fn`；`worldstate.lua:32` 派发时 `fn[1](fn[2], val)`。`fn[1]` 为 `nil` 时触发 `attempt to call a nil value`，但该错误发生在 worldstate 组件的 `SetVariable` 里，被引擎事件循环吞掉——**结果是这三个 world state 永远不通知 FAtiMA**，AI 拿不到季节长度变化。同一 bug 在 `StopWatchingWorldState`（第 499–502 行）重复。

> 注：`OnAutumnLength` 里写的 belief 名是 `"World(AutumnLenght)"`、`OnWinterLength` 写的是 `"World(WinterLenght)"`（第 182–183 行），同样拼错。这个拼写错误是"一致的"——和 README 里文档化的 `World(AutumnLenght)` 对得上，所以 C# 侧不会因此失配，只是名字难看。

**(b) `death` 事件取值字段错 —— 可能崩或永远返回 "darkness"**

第 146 行：
```lua
self.OnDeath = function(inst, data) self:OnActionEndEvent("Death", data.afflicter and data.attacker.GUID or "darkness") end
```
`data.afflicter` 与 `data.attacker` **混用**。引擎侧 `scripts/components/health.lua` 的 death 事件载荷是：
```lua
self.inst:PushEvent("death", { cause = cause, afflicter = afflicter, corpsing = is_corpsing })
```
**载荷里没有 `attacker` 字段。** 所以当 `data.afflicter` 非 nil 时，`data.attacker` 是 `nil`，`data.attacker.GUID` 直接抛 `attempt to index a nil value`。当 `data.afflicter` 为 nil 时走 `or "darkness"` 分支正常。

对比 `attacked` 事件：`scripts/components/combat.lua` 的载荷是 `{ attacker = attacker, damage = ..., ... }`，**有 `attacker`**，所以第 145 行的 `data.attacker and data.attacker.GUID` 是对的。也就是说 A 在 `death` 上把 `attacked` 的字段名抄错了。

**(c) `self.inst:WatchWorldState("springlength", ...)` 之外，`OnStart` 里第 367 行直接调 `TheWorld.net.components.clock:OnSave()`**

这行只在主机端（`ismastersim`）成立。`modmain.lua` 里 `AddSimPostInit` 已判断 `TheWorld.ismastersim`，AI 角色也只在主机端 spawn，所以实际不会在客户端执行。**判定：安全但脆弱**。

**关于"2025-2026 会崩"的总体判断**：A 的崩溃风险**低**。真正的问题是 (a)(b) 两个逻辑 bug，以及它依赖一个 2018 年的 C# exe（`FAtiMA-Server.exe`，基于 .NET Framework + 16 个 2018 年的 DLL）。**C# 侧的 .NET Framework 依赖在现代 Windows 上仍可运行，但整套系统需要手动启动外部进程，体验很差。**

---

## 二、仓库 B：votus777/DST-AICompanion

### 2.1 元数据（已读到，来自 GitHub API）

| 项目 | 值 | 状态 |
|---|---|---|
| 是否存在 | 是，`full_name` = `votus777/DST-AICompanion` | 已读到 |
| 默认分支 | `main` | 已读到 |
| 最后一次 commit | **2024-01-10T15:02:06Z**（`364a9e57`，"Update README.md"） | 已读到 |
| `created_at` | 2024-01-10T06:38:20Z | 已读到 |
| commit 总数 | **14 个，全部在 2024-01-10 当天** | 已读到 |
| 许可证 | **MIT**，`LICENSE` 实读：`Copyright (c) 2024 Hansae` | 已读到 |
| 主要语言 | Lua | 已读到 |
| 归档 | `archived: false`，`fork: false` | 已读到 |
| 仓库大小 | 1130 KB | 已读到 |

**⚠️ 关于"项目较老"的判断——这里必须纠正任务前提。**

任务说"项目较老，必须判断它兼容的 DST 年代"。实际证据显示：**B 的 commit 日期是 2024-01，不是老项目**。但 commit 日期在这里**完全不可信**，因为 14 个 commit 全在同一天，且其中 2 个的 message 是 `Add files via upload`（`fbffb507`、`9007d1b8`）——这是 GitHub 网页上传的行为，意味着**代码是本地写好一次性传上来的，git 历史里没有任何开发过程**。

所以判断兼容年代只能靠**代码本身**，不能靠 commit 日期。我的判断依据和结论：

**B 的代码年代特征 = 2018 年代码 + 2024 年局部修补。**

证据链：
1. `B_modinfo.lua:3` 描述里明写 `orgin by Hineios`，`forumthread` 直接沿用 A 的 `topic/86495-fatima-dst-an-ai-framework/`
2. `B_modinfo.lua:16` `api_version = 10` —— 与 A 完全一致，**没有跟随 DST 的 API 版本演进**（762172 的 `MOD_API_VERSION` 仍是 10，所以这条不崩，但也说明作者没改）
3. `B/scripts/brains/fatimabrain.lua` 71,455 字节 vs A 的 20,770 字节——**是 A 的 3.4 倍，但是同一份代码扩写而来**：`AddSeeRangeHelper`、`Entity()`、`Perceptions()`、`OnStart` 的骨架、甚至 `SEE_DIST = 21` 和 `NUM_SEGS = 16` 常量都逐字相同
4. `B_modinfo.lua:5` `version = "1.6"` —— 直接继承 A 的版本号
5. README 自述："The skeleton of the original mod is 'FAtiMA DST'... However, while DST is updated, that mod is no longer updated by the developer. So this mod added advanced features and fixed major issues."

**关键推论**：B 确实**修好了 A 的 (a)(b) 两个 bug 中的一个半**，但它自己引入了**新的、更严重的崩溃点**（见 2.6）。它**没有**做真正的现代化改造——`api_version` 没动，`interruptbufferedaction` 换成了 `ClearBufferedAction`（等价别名），其余 API 全部沿用 2018 年写法。

**它兼容的 DST 年代**：代码写法停留在 **2018 年（DST 构建约 20xxxx–24xxxx，即 A Return of Them 之前的年代）**。能否跑在 762172 上？核心 API 大多仍有效，但见 2.6 的 4 个**必然崩溃/失效点**。**结论：在 762172 上开箱即崩，不能直接用。**

### 2.2 AI 调度：同样用原生 Brain/BehaviourNode，但行为树复杂度高一个量级（已读到源码）

**是原生的**，与 A 同源。`B_fatimabrain.lua:218` 同样是 `Class(Brain, ...)` + `Brain._ctor`。

行为树（`OnStart`，第 1588 行起）从 A 的 2 个节点扩到 **20+ 个节点**，`PriorityNode` 根节点（第 1941 行）按优先级串联：

```lua
local root = PriorityNode({
    Speak_node,        -- 对话
    Teleport_node,     -- 离玩家太远就传送
    Follow_node,       -- 跟随玩家
    Travel_node,       -- 旅行（探索）
    Attacked_node,     -- 战斗（含 RunAway 闪避）
    OnFire_node,       -- 身上着火
    Trade_node,        -- 交易
    IfNode(... Action == "CHOP", Chop_node),          -- 砍树专用分支
    IfNode(... Action == "GIVETOPLAYER", Give_node),  -- 给玩家东西
    IfNode(... Action ~= "WANDER", DoAction(...)),    -- 通用动作执行（同 A）
    stuck_node,        -- 卡住计数
    WhileNode(... Action == "WANDER", Wander(...))    -- 游荡
}, 1)
```

用到的额外节点：`SequenceNode`、`RunAway`、`ChaseAndAttack`（被注释）、`Wander`。`RunAway` 的签名在 762172 中已变化：
```lua
RunAway = Class(BehaviourNode, function(self, inst, hunterparams, see_dist, safe_dist, fn, runhome, fix_overhang, walk_instead, safe_point_fn)
```
B 的调用 `RunAway(self.inst, "hostile", RUN_AWAY_DIST, STOP_RUN_AWAY_DIST)`（第 1765 行）传 4 个参数，与 762172 的签名**兼容**（第 5 个起可选）。

**B 独有的"人格系统"**（第 50–93 行）——这是它的学术贡献点：
```lua
local Goal_list = {
    Adventurer = { Objective = "Maximize_Vison_Score", Goals = {
        {goal = "Gather_resource", condition = {"IsAbundance"}, state = false},
        {goal = "Build_weapon",    condition = {"HasSpear"},    state = false},
        {goal = "Go_travel",       condition = {"Maximize_Vison_Score"}, state = false} } },
    Camper = { Objective = "Maximize_Development_Score", Goals = {...} },
    Supporter = { Obejective = "Maximize_Companion_Score", Goals = {...} }  -- 注意 Obejective 拼错
}
```
配合 OCEAN 大五人格配置（`B_modinfo.lua` 的 `OPE/COS/EXT/AGR/NEU`，各 0–10）。`GetCurrentGoal()` 遍历目标列表，第一个"条件未满足且未达成"的目标胜出。

**但人格系统实际是半残的**：`GetPersonalityTraits()` 注释写着 `-- Currently Not used`（第 368 行），OCEAN 五个值根本没接进任何决策。`SetPersonalityParms()` 只用了 `max_p_dist` 三个距离阈值。

### 2.3 感知 API（已读到源码）

**同样用 `TheSim:FindEntities`，同样是全量扫描**，比 A 多了"最近实体标记"：

```lua
-- B_fatimabrain.lua:682
local ents = TheSim:FindEntities(x, y, z, SEE_DIST, TAGS, EXCLUDE_TAGS, ONE_OF_TAGS)
```
`SEE_DIST = 21`（与 A 相同）。

**B 新增的"最近实体"逻辑**（第 695–724 行）——这是它感知层的特色，但实现有 bug：
```lua
for i, v in pairs(ents) do
    if v.GUID ~= self.inst.GUID and v:HasTag("pickable") or v.GUID ~= self.inst.GUID and v.components.stackable ~= nil then
        local v_dist = tonumber(self.inst:GetDistanceSqToInst(v))
        if distance == nil or v_dist < distance then
            distance = v_dist
            proximate_entity = v.GUID
        end
    end
end
for i, v in pairs(ents) do
    if v.GUID ~= self.inst.GUID then
        if v.GUID == proximate_entity then
            v:AddTag("Closest")     -- ← 直接往世界实体上打 tag
        end
        ...
```
**问题**：`v:AddTag("Closest")` 是**永久性修改全局实体**，且从不 `RemoveTag`。跑久了世界里会积累一堆带 `Closest` tag 的实体，且 tag 会随存档持久化。这是**状态污染**，不是崩溃，但是设计缺陷。

注意第 703 行的运算符优先级陷阱：`A and B or C and D` 解析成 `(A and B) or (C and D)`，由于 `v.GUID ~= self.inst.GUID` 在两个分支都出现，实际行为正确，但**可读性极差，改动极易引入 bug**。

**B 新增的专用感知函数**（A 没有）：
```lua
function FAtiMABrain:ItemsNearby()      -- 第 1091 行，半径 5，找 pickable 或可堆叠
function FAtiMABrain:TreeNearby()       -- 第 1112 行，半径 15，找 CHOP_workable
function FAtiMABrain:FindNearbyEntity(seek_distance, entity)  -- 第 477 行，按 prefab 名找
```
三者都用 `TheSim:FindEntities` + `v.entity:IsVisible()` 或 tag 过滤，**都没有用 `FindEntity` 或 `GetClosestInstWithTag`**。

`FindNearbyEntity` 的实现有个**漏返回 bug**（第 480–488 行）：
```lua
if ents ~= nil then
    for i, v in ipairs(ents) do
        if v.entity:IsVisible() and v.prefab == tostring(entity) then
            return v
        end
    end
    -- ← 没有 return nil/false，循环走完返回 nil（隐式），可接受
else
    return false
end
```
返回值有时 `false` 有时 `nil`，调用方 `CheckCondition` 用 `~= false` 判断（第 419 行），**当函数隐式返回 nil 时 `nil ~= false` 为 true，会误判为"找到了"**。这是个真实的逻辑 bug。

**背包资源感知**（第 749–775 行）——用 `string.find(tostring(v), "twigs")` 从实体字符串里抠资源名：
```lua
if string.find(tostring(v), "twigs") ~= nil then
    data.twigs = v.components.stackable:StackSize()
elseif string.find(tostring(v), "cutgrass") ~= nil then
```
**这是非常脆弱的写法**。`tostring(实体)` 的输出格式无契约保证；且 `"log"` 会匹配到 `"log_"` 之类。正确做法是 `v.prefab == "twigs"`。

### 2.4 动作执行：`BufferedAction` + `DoAction`，但有 7 个专用动作函数（已读到源码）

**核心路径与 A 相同**（`BufferedAction` + `DoAction`），但 B 在行为树里**给拾取、砍树、攻击各开了专用分支和专用函数**，不再全靠服务器派发：

| 函数 | 行号 | 动作 | 实现方式 |
|---|---|---|---|
| `Pick()` | 1264 | 拾取 | `BufferedAction(inst, Ents[GUID], ACTIONS[act])`，`act` = `"PICK"` 或 `"PICKUP"` |
| `Chop()` | 1307 | 砍树 | `BufferedAction(inst, Ents[Target], ACTIONS.CHOP)` |
| `Attack(target)` | 1139 | 攻击 | `BufferedAction(inst, Ents[target], ACTIONS.ATTACK)` |
| `UnEquip()` | 1202 | 卸装备 | `ACTIONS.UNEQUIP` |
| `Build()` | 1223 | 建造 | `ACTIONS.BUILD` + recipe |
| `Give()` | 1342 | 给物品 | `ACTIONS.DROP`（注意：用的是 DROP 不是 GIVE） |
| `EatFoodAction()` | 1539 | 吃东西 | `BufferedAction(...)` |

**全部走 `BufferedAction`，没有一处直接调 `inventory:GiveItem` 或 `workable:WorkedBy`。** 这点和 A 一致，是正确做法。

但 `Pick()` 里有个**严重的空值风险**（第 1264–1305 行）：
```lua
function FAtiMABrain:Pick()
    local _ents = self:ItemsNearby()
    if _ents == nil then return nil end
    for k, v in pairs(_ents) do
        if v:IsValid() then
            local act = v:HasTag("pickable") and "PICK" or "PICKUP"
            if not self.inst.components.inventory:IsFull() then
                local p = BufferedAction(
                    self.inst,
                    Ents[tonumber(v.GUID)],   -- ← 用 GUID 重新查表，可能为 nil
                    ACTIONS[act]
                )
```
`ItemsNearby()` 返回的是**实体引用**（`nearby_items[j] = v`），却丢掉引用改用 `Ents[tonumber(v.GUID)]` 重查。如果实体在两次查表之间被销毁（拾取竞争、其他玩家拿走），`Ents[GUID]` 为 `nil`，`BufferedAction` 的 target 变成 nil。`bufferedaction.lua` 第 2–3 行会执行 `target.components.inventoryitem` —— **nil 索引崩溃**。

`ItemsNearby()` 本身也有 bug（第 1101–1107 行）：
```lua
local j = 1
for k, v in pairs(_ents) do
    if v:HasTag("pickable") or v.components.stackable ~= nil then
        nearby_items[j] = v
    end
    j = j + 1        -- ← j 无条件自增，会在数组里留空洞
end
```
`j` 在 `if` 外面自增，不匹配时数组出现 `nil` 空洞。`pairs()` 遍历时空洞被跳过，但 `#nearby_items` 会不可靠。且函数**永远返回 table（至少空表），永不返回 nil**，所以 `Pick()` 里的 `if _ents == nil then return nil end` 是**死代码**。

### 2.5 拾取 / 砍树 / 攻击的具体代码路径（已读到源码）

**攻击路径**（最完整的一条，第 1139–1200 行）：
```lua
function FAtiMABrain:Attack(target)
    self:CleanStuckCount()
    if self.inst.components.combat.target == nil then return end

    if self.CurrentAction == nil or self.CurrentAction.Action ~= "ATTACK" then
        self.CurrentAction = {}
        self.CurrentAction.Type = "Action"
        self.CurrentAction.Action = "ATTACK"
        self.CurrentAction.Target = self.inst.components.combat.target.GUID
        ...
    end
    if target == nil then target = self.inst.components.combat.target.GUID end

    local t = BufferedAction(self.inst, Ents[tonumber(target)], ACTIONS.ATTACK)

    t:AddFailAction(function()
        if self.inst.components.combat.target ~= nil then
            if self.inst.components.combat:CanAttack(self.inst.components.combat.target) then
                return          -- 还能打，重试
            else
                self:CleanStuckCount()
                self.inst.components.combat:DropTarget()
                self:OnDeleteEntity(self.CurrentAction.Target)
                self.inst.components.combat.lastattacker = nil
                self.CurrentAction = nil
            end
        end
    end)

    t:AddSuccessAction(function()
        if self.inst.components.combat.target == nil then
            self:CleanStuckCount()
            self.inst.components.combat:DropTarget()
            self:OnDeleteEntity(self.CurrentAction.Target)
            self:OnActionEndEvent(self.CurrentAction.WFN, self.CurrentAction.Target)
            self.inst.components.combat.lastattacker = nil
            self.CurrentAction = nil
        end
    end)
    return t
end
```
762172 验证：`Combat:CanAttack`、`Combat:DropTarget`、`Combat:SetTarget`、`Combat:InCooldown`、`Combat:IsValidTarget`、`combat.lastattacker` 全部存在（`scripts/components/combat.lua` 实读）。`lastattacker` 是**赋值**的（`self.lastattacker = attacker`），所以 B 手动清 nil 是可行的。

**砍树路径**（第 1307–1340 行）：`BufferedAction(inst, Ents[Target], ACTIONS.CHOP)`，成功时用 `KeepWorking` 判断是否续作：
```lua
c:AddSuccessAction(function()
    if self.CurrentAction and self.CurrentAction.Target ~= "-" and Ents[tonumber(self.CurrentAction.Target)] == nil then
        self:OnDeleteEntity(self.CurrentAction.Target)
    end
    if not KeepWorking(self.inst, self.CurrentAction.Action, self.CurrentAction.Target) then
        self:OnActionEndEvent(self.CurrentAction.WFN, self.CurrentAction.Target)
        self.CurrentAction = nil
    end
end)
```
**但 `AddFailAction` 有逻辑漏洞**（第 1332–1338 行）：
```lua
c:AddFailAction(function()
    if KeepWorking(self.inst, self.CurrentAction.Action, self.CurrentAction.Target) then
        return      -- 仍可作业 → 返回，等 DoAction 重试
    end
    -- ← 不可作业时什么也不做！没有 OnActionEndEvent，没有清 CurrentAction
end)
```
失败且目标不可作业时，**既不通知服务器也不清状态**，`CurrentAction` 永远卡在 CHOP，行为树会一直走 CHOP 分支。这是"AI 卡死"的直接成因之一（README 的 Play Tips 里正好提到 "If AI stocks in the same position"）。

**拾取路径**（第 1264 行）：见 2.4 的空值分析。

### 2.6 过时/会崩的 API —— **这是 B 最严重的问题**（已逐条对 762172 验证）

B 有 **4 个真实的崩溃/失效点**，其中 2 个必然崩溃、2 个必然失效。全部在**B 自己新增的代码**里，不是从 A 继承的。

#### 🔴 崩溃点 1：`GetModConfigData` 断言失败 —— **开局即崩**

第 291 行：
```lua
if math.random(100) < GetModConfigData("speak-chance", KnownModIndex:GetModActualName("FAtiMA-DST")) then
```
`B_modinfo.lua:2` 的 `name` 是 **`"The AI Companion"`**，不是 `"FAtiMA-DST"`（那是 A 的名字）。

引擎侧证据（`scripts/modindex.lua:691`）：
```lua
function ModIndex:GetModActualName(fancyname)
    for i,v in pairs(self.savedata.known_mods) do
        if v and v.modinfo and v.modinfo.name then
            if v.modinfo.name == fancyname then
                return i
            end
        end
    end
end          -- ← 找不到时隐式返回 nil
```
`scripts/modutil.lua:34–35`：
```lua
function GetModConfigData(optionname, modname, get_local_config)
    assert(modname, "modname must be supplied manually if called from outside of modmain...")
```
**`modname` 为 `nil` → `assert` 触发 → Lua error。** 这行在 `DecideCallback` 里，每次服务器返回 `Type == "Speak"` 就执行一次。**必然崩溃。**

同一文件第 1665 行还有：
```lua
if GetModConfigData("Enable Speech", KnownModIndex:GetModActualName("The AI Companion")) == 1 then
```
这次 mod 名对了，但 `"Enable Speech"` **在 `B_modinfo.lua` 的 `configuration_options` 里根本不存在**（实际只有 `fatima-character-num`、`speak-chance`、`personality`、`OPE`、`COS`、`EXT`、`AGR`、`NEU`）。`GetModConfigData` 找不到 option 时返回 `nil`（`modutil.lua:61` `return nil`），`nil == 1` 为 false，所以语音系统**静默失效**（不崩，但功能没了）。

#### 🔴 崩溃点 2：`json.encode` 遇到 function —— **事件上行时崩**

B 把 A 的事件值改成了**闭包**（第 307–319 行）：
```lua
self.OnKilled = function(inst, data) self:OnActionEndEvent("Killed", function() return (...) end ) end
self.OnDeath  = function(inst, data) self:OnActionEndEvent("Death",  function() return (...) end ) end
self.OnHitOther  = function(inst, data) self:OnActionEndEvent("HitOther",  function() return (...) end) end
self.OnMissOther = function(inst, data) self:OnActionEndEvent("MissOther", function() return (...) end ) end
```
`OnActionEndEvent` 直接把 `value` 塞进 table 然后 `json.encode`（第 968–980 行）：
```lua
function FAtiMABrain:OnActionEndEvent(name, value)
    local d = {}
    d.Type = "Action-End"
    d.Name = name
    d.Value = value          -- ← value 是 function
    d.Subject = "Walter"
    TheSim:QueryServer(..., json.encode(d))
end
```
引擎侧证据（`scripts/json.lua`）：
- 第 126 行：`if isEncodable(i) and isEncodable(j) then table.insert(...)` —— 对象字段会检查
- 第 519–521 行：`function isEncodable(o) ... return (t=='string' or t=='boolean' or t=='number' or t=='nil' or t=='table') or (t=='function' and o==null)`

`isEncodable` 对普通 function 返回 **false**，所以 `d.Value` 被**静默跳过**，不崩——但**事件值永远丢失**，服务器收到的 JSON 里没有 `Value` 字段。`A_Event.cs` 的 `Event` 构造函数需要 `value`，`JsonConvert.DeserializeObject<Event>` 会拿到 null。

> 结论修正：这里**不崩，但功能彻底失效**。所有 Action-End 事件的 value 都是 null。这比崩溃更隐蔽。

#### 🔴 崩溃点 3：`io` 在 mod 沙箱里不存在 —— **`AddGamePostInit` 崩**

`B_modmain.lua:7–10`：
```lua
io = GLOBAL.io
local io = GLOBAL.require "io"
local os = GLOBAL.require "os"
graph_data = MODROOT.."graph_data.csv"
```
第 171–172 行：
```lua
local _f = io.open(graph_data, "w") _f:close()
file = io.open(graph_data, "w")
```

引擎侧证据（`scripts/mods.lua:258–292` 的 `CreateEnvironment`）——**mod 沙箱是白名单**：
```lua
local env = {
    pairs = pairs, ipairs = ipairs, print = print, math = math, table = table,
    type = type, string = string, tostring = tostring, require = require, Class = Class,
    TUNING = TUNING, LEVELCATEGORY = ..., GROUND = ..., WORLD_TILES = ...,
    LOCKS = ..., KEYS = ..., LEVELTYPE = ...,
    GLOBAL = _G, modname = modname, MODROOT = MODS_ROOT..modname.."/",
}
```
**`io` 不在白名单里。** 虽然 `GLOBAL = _G` 让 `GLOBAL.io` 理论上可达，但 `io` 是否暴露在 `_G` 取决于引擎是否加载了 io 库——`io.open` 只在 `scripts/worldgen_main.lua`、`debugcommands.lua`、`profiler.lua` 等**引擎内部脚本**里使用（实读确认），这些脚本不受 mod 沙箱约束。

即便 `GLOBAL.io` 可用，`io.open(path, "w")` 在**专用服务器或沙箱环境下**也会失败（无写权限），返回 `nil, err`。然后 `_f:close()` 对 `nil` 调方法 → **崩溃**。

`AddGamePostInit` 是**每次开游戏都执行**的（第 168 行），所以这是**必然崩溃点**。

#### 🔴 崩溃点 4：`data.attacker` 与 `death` 载荷不匹配 —— B 修了，但修法有副作用

B 把 A 的 `death` handler 改成了（第 317 行）：
```lua
self.OnDeath = function(inst, data) self:OnActionEndEvent("Death",
    function() return (self.inst.components.combat.lastattacker ~= nil and self.inst.components.combat.lastattacker.GUID or "darkness") end ) end
```
**不再引用 `data.attacker`**，改用 `combat.lastattacker`。这确实绕开了 A 的 nil 索引 bug。但因为值是闭包，落入了崩溃点 2 的 `json.encode` 陷阱——**修了一个 bug，引入了另一个**。

#### 其他过时但不崩的写法

| 用法 | 762172 状态 | 判定 |
|---|---|---|
| `api_version = 10` | `MOD_API_VERSION = 10` | 有效，但**未跟进**（若将来升到 11 会报 Old API） |
| `self.inst:ClearBufferedAction()`（第 283 行） | `entityscript.lua:1588` 存在 | 有效（比 A 的 `InterruptBufferedAction` 更"现代"，但两者等价） |
| `ACTIONS[self.CurrentAction.Action]` 通用派发 | 动作名全部存在 | 有效 |
| `self.inst.components.follower` | **`player_common.lua` 没有 `AddComponent("follower")`**（实读全部 100+ 个 AddComponent） | **必然 nil** → 第 1343 行 `self.inst.components.follower.leader` 崩 |
| `self.inst.components.homeseeker` | 同样**没有** | `HasHome()` 第 500 行会 `AddComponent("homeseeker")` 补救，但 `FindValidHome` 只在 `Home == nil` 时调 |
| `self.inst.components.trader` | `player_common.lua` **有** `AddComponent("trader")` | 有效 |
| `v:IsOnWater()`（第 177 行） | `entityscript.lua: EntityScript.IsOnWater = EntityScript.IsOnOcean` | 有效 |
| `Wander(..., {minwalktime=20, randwalktime=40, ...})` | `wander.lua` 支持 | 有效 |
| `RunAway(inst, "hostile", 15, 10)` | 762172 签名第 2 参数支持 string（`huntertags`） | 有效 |
| `GetClosestNode(x, z)`（第 1441 行） | `scripts/maputil.lua: function GetClosestNode(x,y)` | 有效 |
| `distsq(px, pz, c_node.x, c_node.y)` | `scripts/util.lua: function distsq(v1, v2, v3, v4)` | 有效 |
| `TheWorld.topology.nodes`（第 37 行，**模块加载时**求值） | `gamelogic.lua: world.topology = savedata.map.topology` | **危险**：mod 加载时 `TheWorld.topology` 可能还没赋值，`local map_nodes = TheWorld.topology.nodes` 会 nil 索引崩 |

**第 37 行是最隐蔽的崩溃点**：
```lua
local map_nodes = TheWorld.topology.nodes      -- 文件顶层，加载时立即执行
```
`scripts/gamelogic.lua` 里 `world.topology = savedata.map.topology` 是在**世界加载流程中**赋值的，而 `brains/fatimabrain.lua` 被 `require` 的时机取决于第一次 `SetBrain`。如果早于 topology 赋值，这里直接崩。这也是为什么 B 的 `GetNextNodePosition` 里又用了一次 `GetClosestNode`（走 `TheWorld.topology` 的运行时引用），说明作者自己也没把握。

**"明显过时会在 762172 崩"的总结（B）**：
1. 🔴 `GetModConfigData("speak-chance", GetModActualName("FAtiMA-DST"))` → **assert 崩**（mod 名写错）
2. 🔴 `io.open(graph_data, "w")` 在 `AddGamePostInit` → **nil 方法调用崩**（io 不在沙箱）
3. 🔴 `self.inst.components.follower.leader` → **nil 索引崩**（玩家实体无 follower 组件）
4. 🟠 `json.encode` 遇到闭包 → 事件值**静默丢失**（不崩但失效）
5. 🟠 `local map_nodes = TheWorld.topology.nodes` 顶层求值 → **可能 nil 索引崩**
6. 🟠 `GetModConfigData("Enable Speech", ...)` → option 不存在，**语音静默失效**

---

## 三、对本项目的可复用结论

### 3.1 仓库 A（FAtiMA-DST）可复用点

1. **"薄 Lua + 外置决策"的架构值得直接照搬。** A 的 Lua 只有 20 KB，职责边界极清晰：Lua 负责**感知上行**和**动作下行**，决策完全外置。行为树只是个 `IfNode` 开关。如果你的项目需要一个可替换/可调试的策略层，这个模式比把 AI 逻辑写进 Lua 好得多——策略改动不用重载 mod。

2. **`Entity()` 属性压平函数是最有复用价值的单点。** `A_fatimabrain.lua:44-70` 把引擎实体转成 18 个纯数据字段（GUID/prefab/数量/各类 workable tag/坐标），**且 tag 选择经过 762172 验证全部有效**。这个函数可以直接拿来做感知序列化的模板，注意 `_equippable` 是 replica 自动加的（`entityreplica.lua:40`），不是 prefab 显式加的。

3. **`ACTIONS[字符串]` 动态派发 + `KeepWorking` 续作模式，比硬编码动作分支更耐改。** A 用一条 `BufferedAction` 构造路径覆盖 58 个动作，新增动作只需服务器下发新字符串。`KeepWorking`（`CHOP/MINE/HAMMER/DIG` + `*_workable` tag）解决了"一次 `BufferedAction` 只砍一下"的问题——这是 DST AI 的经典坑，A 的解法很干净。

4. **不要复用它的 `WatchWorldState` 订阅代码。** 第 359–362、499–502 行有 3 处 `Lenght` 拼写错误（应为 `Length`），导致 `springlength/autumnlength/winterlength` 三个 world state **永远不通知**，且失败是静默的。这是"定义名与引用名不一致"的典型，抄的时候必须逐个核对。

5. **不要复用它的 `death` 事件 handler。** 第 146 行 `data.afflicter and data.attacker.GUID` 混用了两个字段名。762172 的 `death` 载荷是 `{cause, afflicter, corpsing}`，**没有 `attacker`**；`attacker` 是 `attacked` 事件的字段。抄这段会在被怪物打死时崩。

### 3.2 仓库 B（DST-AICompanion）可复用点

1. **人格/目标系统是它唯一的原创价值，但只能借鉴结构，不能借鉴实现。** `Goal_list`（第 55–93 行）用 `{goal, condition, state}` 三元组 + 条件函数表驱动目标切换，思路清晰可扩展。但 `GetPersonalityTraits()` 明确标了 `-- Currently Not used`，OCEAN 五维完全没接进决策，`SetPersonalityParms` 只改了 3 个距离阈值。**要做得比它好，必须真的把人格参数接进效用计算。**

2. **`ItemsNearby` / `TreeNearby` 这类"按半径找可交互物"的封装思路可借鉴，但实现要重写。** 两个函数都用 `TheSim:FindEntities` + tag 过滤，语义清楚。但 `ItemsNearby` 的 `j = j + 1` 写在 `if` 外面（第 1101–1107 行），会在返回数组里留 `nil` 空洞，且**永不返回 nil**（让 `Pick()` 里的 nil 检查成为死代码）。正确写法是把 `j = j + 1` 放进 `if` 内，或直接用 `table.insert`。

3. **`Attack()` 的 fail/success 双回调状态机是全仓库最成熟的一段。** 第 1139–1200 行用 `CanAttack` 判断"还能打就重试、不能打就清状态"，同时清理 `combat.target`、`combat.lastattacker`、`CurrentAction` 三处状态，并上报 `OnDeleteEntity` + `OnActionEndEvent`。这个"重试 or 收敛"的模式可以直接用。**但 `Chop()` 的 `AddFailAction` 漏了这个收敛分支**（第 1332–1338 行只 `return` 不清理），是"AI 卡死"的直接原因——抄的时候务必补上。

4. **绝对不要复用它的 4 个崩溃点。** 具体是：(a) `GetModConfigData` 的 mod 名必须与 `modinfo.lua` 的 `name` **完全一致**（B 写成了 `"FAtiMA-DST"`，自己的 mod 叫 `"The AI Companion"`，直接 assert 崩）；(b) **mod 沙箱没有 `io`**（`mods.lua:258` 白名单确认），任何 `io.open` 都会在 `AddGamePostInit` 崩；(c) **玩家实体没有 `follower`/`homeseeker` 组件**（`player_common.lua` 的 100+ 个 `AddComponent` 里都没有），必须自己 `AddComponent`；(d) **`json.encode` 会静默跳过 function**（`json.lua:519` `isEncodable` 返回 false），事件值不能是闭包，必须先求值成标量。

5. **`tostring(实体)` + `string.find` 抠资源名是反模式，不要学。** 第 754–764 行用 `string.find(tostring(v), "twigs")` 判断背包物品，依赖 `tostring` 的未文档化输出格式，且 `"log"` 会误匹配。正确做法是 `v.prefab == "twigs"`。同理，第 723 行 `v:AddTag("Closest")` 往**全局世界实体**上永久打 tag 且从不清理，会造成存档污染。

---

## 四、许可证风险提示

### 4.1 两个仓库的许可证状态（均为实读 `LICENSE` 文件，非推断）

| 仓库 | License 字段 | 实际文件内容 | 版权人 |
|---|---|---|---|
| A：hineios/FAtiMA-DST | **MIT** | MIT License 全文 | `Copyright (c) 2018 Fábio Almeida` |
| B：votus777/DST-AICompanion | **MIT** | MIT License 全文 | `Copyright (c) 2024 Hansae` |

**两个都是 MIT，不是 NOASSERTION，不是无许可。** 这是最宽松的情况。

### 4.2 MIT 允许什么、要求什么

MIT 允许：商用、修改、分发、私人使用、再许可（sublicense）。**允许闭源使用。**

MIT 要求（唯一实质义务）：**在软件的所有副本或实质性部分中，必须包含上述版权声明和本许可声明。** 即：
- 保留 `LICENSE` 文件原文
- 保留版权人姓名（A 是 `Fábio Almeida`，B 是 `Hansae`）
- 不能移除版权声明

MIT **不提供**：任何担保（"AS IS"）、专利许可（这点与 Apache-2.0 不同）、商标许可。

### 4.3 对本项目的具体风险

**低风险，但有 3 个必须注意的点：**

1. **A 与 B 是两个独立的 MIT 版权，借鉴时两份都要署名。** B 是 A 的衍生（README 自述 "The skeleton of the original mod is 'FAtiMA DST'"，代码骨架逐字相同），但 B 的 `LICENSE` 只写了 `Copyright (c) 2024 Hansae`，**没有保留 A 的 `Copyright (c) 2018 Fábio Almeida`**。严格按 MIT 条款，B 的做法**不符合 MIT 的署名保留要求**（B 分发了 A 的实质性部分却未保留 A 的声明）。如果你从 B 抄代码，而 B 的代码又源自 A，**你需要同时署名 Fábio Almeida 和 Hansae**，否则可能继承 B 的这个瑕疵。稳妥做法：在 `NOTICE`/`LICENSE` 里同时列出两个版权人 + 两个仓库 URL。

2. **`FAtiMA-toolkit/*.dll` 是二进制，MIT 覆盖范围不明确。** A 仓库里 16 个 DLL（`ActionLibrary.dll`、`RolePlayCharacter.dll`、`MCTS.dll` 等）没有源码，来自外部项目 [GAIPS/FAtiMA-Toolkit](https://github.com/GAIPS/FAtiMA-Toolkit)。A 的 MIT 只声明覆盖"本仓库中的软件"，**这些第三方 DLL 的权利状态在仓库内无声明**。B 仓库更是直接塞了 `FAtiMA-Server.exe` 和 30+ 个 DLL/PDB。**如果你要复用 C# 服务端，必须单独去 GAIPS/FAtiMA-Toolkit 确认其许可证**（该项目通常是 MIT，但需自行核实，不要假设）。

3. **游戏资产与 Klei 的 EULA 是独立于 MIT 的另一层约束。** 两个 mod 都引用了 Klei 的游戏资产（`Asset("ANIM", "anim/firefighter_placement.zip")` 等）。MIT 只覆盖代码，**不覆盖游戏资产**。DST mod 的分发受 Klei 的 [Mod 政策](https://forums.kleientertainment.com/forum/19-dont-starve-together-modding/) 约束，商用需另行评估。本项目若只是内部研究/学习，风险极低；若要公开发布，需遵守 Klei 的 mod 规范。

### 4.4 一句话结论

**两个仓库都是 MIT，代码可以放心借鉴（含商用），唯一硬性义务是保留版权声明。** 但：(a) B 未保留 A 的版权声明，从 B 抄代码时你要自己补上 A 的署名；(b) 两仓库里的 `.dll`/`.exe` 二进制不受 MIT 明确覆盖，复用 C# 服务端前需单独核实 GAIPS/FAtiMA-Toolkit 的许可证；(c) 游戏资产受 Klei EULA 约束，MIT 管不着。

---

## 附录：验证清单（每条都可复现）

| 声明 | 验证方式 | 结果 |
|---|---|---|
| A 存在，默认分支 master，最后 commit 2018-11-21，MIT | GitHub API `/repos` + `/commits` + raw `LICENSE` | ✅ 已读到 |
| B 存在，默认分支 main，最后 commit 2024-01-10，MIT | 同上 | ✅ 已读到 |
| B 的 14 个 commit 全在同一天，2 个是 "Add files via upload" | GitHub API `/commits?per_page=100` | ✅ 已读到 |
| 两仓库都用原生 Brain/BehaviourNode | 源码 `Class(Brain, ...)` + `PriorityNode`/`DoAction`/`BT` | ✅ 已读到 |
| 感知用 `TheSim:FindEntities`，不用 `FindEntity`/`GetClosestInstWithTag` | 源码 grep 全文 | ✅ 已读到 |
| 动作用 `BufferedAction` + `DoAction`，不直接调组件 | 源码 grep `GiveItem`/`WorkedBy` 均无命中 | ✅ 已读到 |
| `BufferedAction` 前 6 参数在 762172 仍匹配 | `scripts/bufferedaction.lua:2` | ✅ 已读到 |
| `InterruptBufferedAction` 在 762172 仍存在（是别名） | `scripts/entityscript.lua:1595` | ✅ 已读到 |
| `Wander` 支持 `minwalktime` 等 4 键 | `scripts/behaviours/wander.lua:7-12` | ✅ 已读到 |
| `CHOP/MINE/PICK/PICKUP/ATTACK/...` 动作全存在 | `scripts/actions.lua` 逐行号确认 | ✅ 已读到 |
| `_equippable` 由 replica 自动加 | `scripts/entityreplica.lua:40` | ✅ 已读到 |
| 玩家实体无 `follower`/`homeseeker` | `scripts/prefabs/player_common.lua` 全部 `AddComponent` 列表 | ✅ 已读到 |
| `death` 载荷无 `attacker` 字段 | `scripts/components/health.lua` `PushEvent("death", {cause, afflicter, corpsing})` | ✅ 已读到 |
| `attacked` 载荷有 `attacker` 字段 | `scripts/components/combat.lua` | ✅ 已读到 |
| mod 沙箱无 `io` | `scripts/mods.lua:258-292` `CreateEnvironment` 白名单 | ✅ 已读到 |
| `GetModActualName` 找不到返回 nil → `GetModConfigData` assert | `scripts/modindex.lua:691` + `scripts/modutil.lua:34` | ✅ 已读到 |
| `json.encode` 跳过 function（不崩但丢值） | `scripts/json.lua:519` `isEncodable` | ✅ 已读到 |
| `worldstate` watcher 为 nil 时静默失败 | `scripts/components/worldstate.lua:294` + `:32` | ✅ 已读到 |
| 当前 DST 构建号 762172 | `version.txt` + `scripts.zip` 解包 | ✅ 已读到 |
| `MOD_API_VERSION = 10` | `scripts/mods.lua` | ✅ 已读到 |

**未能读到的部分（明确声明）**：
- `FAtiMA-toolkit/*.dll` 与 `FAtiMA-Server.exe` 的**内部实现**——只有二进制，无源码，**未读到**。C# 侧逻辑仅基于 `Program.cs` / `Perceptions.cs` / `Entity.cs` / `Action.cs` / `Event.cs` / `WebServer.cs` 六个源文件。
- B 仓库的 `Saved Characters/*.rpc`（526 KB–5.5 MB 的二进制存档）——**未读到**，未解析。
- `scripts/map/static_layouts/default_start.lua`（B 的 8657 字节地图布局）——**已下载但未深入分析**，与本报告主题（感知/动作/状态同步）关联度低。
