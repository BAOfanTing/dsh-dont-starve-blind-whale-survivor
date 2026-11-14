# 饥荒联机版 · 模组 API 速查（本项目实测版）

这份文档里的每一条都是**在真机上跑过、或者到游戏源码里核对过**的，不是凭单机版的经验抄的。
踩过的坑都写在每条下面（"⚠"），项目的修法记在 `## 踩坑总表` 里。

游戏版本：`api_version = 10` 的《Don't Starve Together》（2026-11 的线上版本，`scripts.zip` 5660 万字节）。

---

## 0. 怎么核对（比背文档可靠）

游戏自带的 Lua 源码就在安装目录里：

```
<游戏目录>\data\databundles\scripts.zip
```

三种核对方式，任选：

```powershell
# ① 本仓库自带（推荐）：按符号查，打印文件:行号和签名
node tools/api-lookup.mjs Tool:CanDoAction
node tools/api-lookup.mjs "GetWorldPosition" --context=2

# ② 解压出来自己翻
Expand-Archive 不行（它是 zip 里的 zip）→ 用 PowerShell 的 .NET：
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory("...\scripts.zip", "D:\dst-scripts")

# ③ 只看某个组件有什么方法
node tools/api-lookup.mjs "^function Inventory:" --regex
```

这一步能省掉 90% 的"看起来对、其实这个版本没有"。

---

## 1. 模组沙箱的三条铁律

### 1.1 严格模式：读不存在的全局会**当场抛错**

```lua
GLOBAL.GetClock          -- ✖ "variable 'GetClock' is not declared"（DST 没有这个全局）
GLOBAL.YourModSomething  -- ✖ 任何拼错/不存在的全局都会炸，不是返回 nil
```

所以项目里一律用安全访问器（`scripts/whale/util.lua`）：

```lua
function U.g(name)
    local ok, value = pcall(function() return GLOBAL[name] end)
    if ok then return value end
    return nil
end

U.g("ACTIONS")   -- ✔ 有就给表，没有给 nil，不炸
```

白名单（这些一定存在，可以直接写）：`pcall` `tonumber` `error` `type` `tostring` `print` `math` `table` `string` `pairs` `ipairs`、`Vector3` `BufferedAction` `ACTIONS` `EQUIPSLOTS`。

> 测试 `tests/tool-parity.test.mjs` 会拦"除白名单外直接写 `GLOBAL.xxx`"。

### 1.2 没有 `TheSim:GetTime()`，秒表自己维护

```lua
TheSim:GetTime()      -- ✖ 不存在（只有 GetTickTime()，返回的是"每个 tick 多少秒"）
TheSim:GetTickTime()  -- ✔ 但那是 delta，不是累计时间
TheSim:GetTimeScale() -- ✔ 时间倍率
```

项目的做法：主循环每 tick 推自己的秒表（`U.advance(dt)` / `U.now()`）。
所有"隔 N 秒写一次状态""动作超时"都用它，**绝不依赖引擎时钟**。

> 症状对照：`TheSim:GetTime` 取不到 → 返回 0 → `now < next_write_at` 永远成立 → 状态只写第一份（`seq` 一直是 1）。

### 1.3 多返回值会被 `pcall` 截断

```lua
local ok, value = pcall(function() return inst.Transform:GetWorldPosition() end)
-- value 只有 x！y/z 丢了 → 后面 pos.z 是 nil（位置和"附近有什么"会一起静默消失）

-- 对的写法（本项目 U.call）：
function U.call(fn, ...)
    local ok, a, b, c, d = pcall(fn, ...)
    if not ok then return nil end
    return a, b, c, d
end
```

---

## 2. 时间与世界状态：读 `TheWorld.state`

**没有** `GetClock()`、**没有** `PHASES`、**没有** `TheWorld.components.clock`（那是别的版本）。
服务端和客户端都能读的是 `TheWorld.state`：

| 字段 | 类型 | 含义 |
|---|---|---|
| `state.cycles` | number | 已经过了几个循环（第几天 = `cycles + 1`） |
| `state.phase` | string | `"day"` / `"dusk"` / `"night"` |
| `state.isnight` | bool | 是不是晚上 |
| `state.season` | string | `"autumn"` / `"winter"` / `"spring"` / `"summer"` |
| `state.temperature` | number | 世界温度（℃） |
| `state.israining` | bool | 下雨 |
| `state.isfullmoon` | bool | 满月（猪人变疯猪） |
| `state.snowlevel` / `state.wetness` / `state.precipitation` | number | 雪量 / 潮湿度 / 降水量 |

```lua
local state = U.world_state()          -- scripts/whale/util.lua
local day   = (U.try(function() return state.cycles end) or 0) + 1
local phase = U.try(function() return state.phase end)   -- "day"
```

> ⚠ 字段要一个个用 `U.try` 读：`state` 是引擎给的表，某些分片/版本上可能缺项。

**服务端判断**：`TheWorld.ismastersim`（本项目 `U.is_master()`）。

---

## 3. 实体、坐标、扫描

| 要做的事 | 真实 API | 备注 |
|---|---|---|
| 拿世界坐标 | `inst.Transform:GetWorldPosition()` → **x, y, z** | 三个返回值，见 1.3 |
| 拿 Vector3 | `inst:GetPosition()` | 部分实体有 |
| 坐标换算 | 1 格 = **4** 个世界单位 | `tile = floor(x / 4)` |
| 找附近实体 | `TheSim:FindEntities(x, y, z, radius, musttags, cantags, mustoneoftags)` | 第 5 个是"必须有"、第 6 个是"有就不能有"；返回表 |
| 判断有效 | `inst:IsValid()`、`inst:HasTag("INLIMBO")` | 失效对象再用会炸 |
| 标签 | `inst:HasTag("hostile")` / `"tree"` / `"player"` … | |
| 碰撞半径 | `inst.Physics:GetRadius()` | 走到目标旁边时要留出这个距离 |

```lua
-- 扫半径 16 格（= 64 世界单位），排除特效/装饰/不可点
local ents = TheSim:FindEntities(x, 0, z, radius * 4, nil, { "INLIMBO", "FX", "DECOR", "NOCLICK" }, nil)
```

**玩家列表**：`AllPlayers`（main.lua 建的表，`player_common.lua` 每次生成玩家都往里塞）。
某些构建下它可能是空的，所以项目的 `U.players()` 空了会退回去翻 `Ents`。

---

## 4. 组件 API（重点：哪些方法**不存在**）

### 4.1 Inventory（背包）

```lua
-- ✔ 存在
inv:ForEachItem(fn)              -- 遍历（本项目的标准做法）
inv:FindItems(fn)                -- 返回列表
inv:NumItems() / NumStackedItems()
inv:GetNumSlots() / GetItemInSlot(slot)
inv:GiveItem(item, slot, src_pos)
inv:RemoveItem(item, wholestack, checkallcontainers, keepoverstacked)
inv:Equip(item, old_to_active, no_animation, force_ui_anim)
inv:Unequip(equipslot, slip, force)
inv:GetEquippedItem(eslot)       -- eslot 用 EQUIPSLOTS.HANDS / .BODY / .HEAD / .BACK
inv:DropItem(item, wholestack, randomdir, pos, keepoverstacked)
inv:Has(item, amount, checkallcontainers)
inv.itemslots                    -- 字段：slot → item

-- ✖ 不存在（单机版记忆里的）
inv:GetItems()                   -- 用了它 = 背包永远读成空
inv:GetItemCount(prefab)         -- 数数量要自己累加
```

```lua
-- 本项目 U.inv_items 的写法
local out = {}
inv:ForEachItem(function(item)
    if item ~= nil and item:IsValid() then
        out[#out + 1] = { item = item, prefab = item.prefab, count = U.stack_count(item) }
    end
end)
```

### 4.2 Container（箱子 / 冰箱 / 锅）

```lua
-- ✔ 存在
container:GetNumSlots()
container:GetItemInSlot(slot)
container:GiveItem(item, slot, src_pos, drop_on_fail)
container:RemoveItem(item, wholestack, _checkallcontainers_, keepoverstacked)

-- ✖ 不存在
container:GetItems()
container:GetNumItems()
```

```lua
-- 本项目 U.container_items
for i = 1, (U.try(function() return container:GetNumSlots() end) or 0) do
    local item = U.try(function() return container:GetItemInSlot(i) end)
    ...
end
```

### 4.3 Pickable（草 / 树苗 / 浆果丛 / 蘑菇 / 花 / 芦苇）

```lua
pickable:CanBePicked()      -- 现在能不能采
pickable:Pick(picker)       -- 直接采（一般不用手调，走动作即可）
pickable.product            -- 产出什么 prefab（"twigs"/"berries"/"cutgrass"）
pickable:SetUp(product, regen_time, number)
pickable:IsBarren()         -- 是否贫瘠
```

> ⚠ **采集动作是 `ACTIONS.PICK`**，不是 `HARVEST`。
> `ACTIONS.HARVEST` 是农场 / 蜂箱那类没有 `rangecheckfn` 的动作，推给浆果丛会被游戏直接拒绝。
> 来源：`scripts/actions.lua` 里 `PICK = Action({ rangecheckfn = PickRangeCheck, ... })`。

### 4.4 Workable（树 / 石头 / 建筑）

```lua
workable.action      -- ✖ 不是字符串！是 ACTIONS.CHOP 这种**动作对象**
workable.workleft    -- 还要敲几下 / 还剩多少工作量
```

```lua
-- 反查名字（本项目 U.action_name）
for name, value in pairs(ACTIONS) do
    if value == workable.action then return name end   -- "CHOP" / "MINE" / "DIG" / "HAMMER"
end
```

> ⚠ 直接 `tostring(workable.action)` 会打印成 `table: 000000000c654100`，AI 完全看不懂。

### 4.5 Tool（斧头 / 镐子 / 铲子 / 锤子）

```lua
tool.actions                 -- 表：动作对象 → 效率
tool:CanDoAction(action)     -- ✖ 收的是**动作对象**，传 "CHOP" 字符串永远 false
tool:GetEffectiveness(action)
tool:CanDoToughWork()        -- 能不能干硬活（金斧头之类）
```

```lua
local can = tool:CanDoAction(ACTIONS.CHOP)   -- ✔
```

> ⚠ 传字符串的后果：永远"背包里没有能砍的工具"，即使斧头就在包里。

### 4.6 配方与建造（Builder / AllRecipes）

```lua
AllRecipes[name]              -- 全局表：配方名 → recipe
recipe.name / recipe.product  -- "axe" → 产出 "axe"
recipe.placer                 -- 建筑才有（能放到地上的那种）
recipe.ingredients            -- { { type = "twigs", amount = 1 }, { type = "flint", amount = 1 }, ... }
                              -- type 可能是 "CHARACTER"（角色限定），要跳过

builder:KnowsRecipe(recipe)
builder:CanBuild(name)        -- ✔ 可用，但源码标注 deprecated（建议 HasIngredients）
builder:MakeRecipe(recipe, pt, rot, skin, onsuccess)     -- ✔ 服务端唯一能用的制作入口
builder:MakeRecipeFromMenu(recipe, skin)                 -- ✖ 客户端菜单专用，服务端调了直接返回
builder:MakeRecipeAtPoint(recipe, pt, rot, skin)         -- ✖ 同上
```

> ⚠ `MakeRecipe` 成功时**返回 nil**，别用返回值判断成败；按"产物数量有没有变"判断更稳。

### 4.7 Stewer（锅）

```lua
stewer:IsCooking() / IsDone() / CanCook()
stewer:GetTimeToCook()
stewer:StartCooking(doer)     -- ⚠ 收的是 **doer**（谁在做饭），不是食材
stewer:Harvest(harvester)     -- 把做好的菜拿出来
```

做饭的正确顺序（本项目 `cook`）：

1. 食材放进锅的 **container**（最多 4 格）：`pot.components.container:GiveItem(item, nil, pot:GetPosition())`
2. 放满之后：`pot.components.stewer:StartCooking(player)`

### 4.8 其它常用组件

| 组件 | 字段 / 方法 |
|---|---|
| `health` | `.currenthealth` `.maxhealth` `:GetPercent()` `:IsDead()` |
| `hunger` | `.current` `.max` |
| `sanity` | `.current` `.max` |
| `temperature`（角色体温） | `.current` |
| `moisture` | `:GetPercent()` |
| `perishable` | `:GetPercent()`（新鲜度） |
| `armor` | `:GetPercent()`（护甲耐久）`condition` |
| `finiteuses` | `:GetPercent()` `:GetUses()`（工具耐久） |
| `stackable` | `:StackSize()`（一摞几个） |
| `fueled`（火堆） | `.maxfuel` `.currentfuel` `:GetPercent()` `:IsEmpty()` |
| `burnable` | `.fuelvalue` `:IsBurning()` |
| `combat` | `.target` `.damage` |
| `eater` | `:Eat(item)`（`EAT` 动作推不动时的兜底） |
| `talker` | `:Say("文字")`（头顶气泡） |
| `sleepable`（帐篷 / 草席） | 有它就能睡 |
| `edible` | `.hungervalue` `.healthvalue` `.sanityvalue` |
| `weapon` | `.damage` |
| `inventoryitem` | 有它 = 是物品 |

---

## 5. 动作系统（让玩家真的动起来）

```lua
-- 组一个动作：谁、对什么、做什么、手上用什么、放到哪
local ba = BufferedAction(doer, target, ACTIONS.CHOP, invobject, pos)
-- 执行：交给 locomotor（会自动走过去再动手），和玩家点鼠标同一条路
doer.components.locomotor:PushAction(ba, true)     -- 第二个参数 = 到了就做
-- 或者只走路
doer.components.locomotor:GoToPoint(Vector3(x, 0, z), nil, true)   -- 第三参 = 跑不跑
```

其它：

```lua
doer:GetBufferedAction()      -- 现在手上有没有动作
doer:ClearBufferedAction()    -- 清掉
doer:PushBufferedAction(ba)   -- 没有 locomotor 时的兜底
```

**结果事件**（挂在玩家实体上）：

```lua
inst:ListenForEvent("actionsuccess", function(inst, data) ... end)   -- data.action
inst:ListenForEvent("actionfailed", function(inst, data) ... end)    -- data.action / data.reason
```

**连砍**（官方"按住 F 连砍"的机制）：`playercontroller.remote_controls[CONTROL_ACTION] = true`
——状态机会自己在 `TimeEvent` 里重推同一个动作。本项目 `hold_action` 用的就是它。

**成功判据要看游戏里的真实变化**，不要只看"我推了动作"：
树倒了 = 实体失效；采到了 = `pickable:CanBePicked()` 变 false 或背包里产物变多；捡到了 = 地上实体消失。

---

## 6. 客户端那半边

```lua
-- HUD 挂载点
AddClassPostConstruct("screens/playerhud", function(self, owner) ... end)
owner.HUD.overlayroot:AddChild(widget)      -- 往 HUD 上加自己的控件

-- 组件：require("widgets/widget") / require("widgets/text")
-- 字体：CHILLFONT / TITLEFONT / DEFAULTFONT（用 U.g 读，缺了就退下一个）
-- 锚点：ANCHOR_TOP / ANCHOR_LEFT；缩放：SCALEMODE_PROPORTIONAL

-- 键盘（客户端）
TheInput:AddKeyDownHandler(KEY_F8, function() ... end)

-- 暂停世界（只有房主 / 本地开世界有效）
SetServerPaused(true / false)
```

**走路动画**（重要，不然角色是"平移"的）：

- 服务端 `GoToPoint` 只改物理位置，`player_classified` 里没有"我在走路"这种同步字段，
  客户端不播动画 → 画面上就是滑行。
- 解法：服务端顺手给"那个玩家的客户端"发一条 mod RPC，让它自己也走一遍：

```lua
-- 服务端
SendModRPCToClient(GetClientModRPC(MODNAME, "walkto"), player.userid, x, z, run and 1 or 0)

-- 客户端
AddClientModRPCHandler(MODNAME, "walkto", function(x, z, run)
    ThePlayer.components.locomotor:GoToPoint(Vector3(x, 0, z), nil, run == 1)
end)
```

> ⚠ `SendModRPCToClient` 成功时返回 **nil**，别拿 `~= nil` 判断发成功。

---

## 7. 文件 I/O 与 Master/Caves 两个分片

```lua
-- ① 持久化字符串：落在**当前分片**的存档目录（Cluster_N/Master/save 或 /Caves/save）
TheSim:SetPersistentString(key, data, encode)
TheSim:GetPersistentString(key, function(success, data) ... end)   -- 异步回调

-- ② 直接写文件：相对**游戏进程的工作目录**（一般是 <游戏目录>\bin64）
local f = io.open("whale_io_state.json", "w")
f:write(text); f:close()

-- ③ 读文件
local f = io.open(name, "r"); local text = f:read("*a"); f:close()
```

- 持久化字符串文件前面有 Klei 的头：`KLEI     1 {json}`，外面读要先剥掉。
- `os.time()` 在某些沙箱里取不到 → 用 `U.real_time()` 兜底。

**分片的关键事实**：

| | 存档目录（持久化字符串） | 游戏工作目录（io.open） |
|---|---|---|
| Master（地上） | `Cluster_N\Master\save\` | **共用** `<游戏>\bin64\` |
| Caves（洞穴） | `Cluster_N\Caves\save\` | **共用** `<游戏>\bin64\` |
| 是否两个进程都在跑模组 | 是 | 是 |

→ 所以 io 通道是**两个分片抢着写**的。没人的那一侧如果也写状态、也应指令，
就会把"现在没有玩家"塞给外面的 AI，把真正干活的那侧的结果挤掉。

项目的规矩（`scripts/whale/bridge.lua`）：

- 没人的分片：**只写自己存档目录里的状态**，不写共享的 io 文件，**不执行指令**；
- 外面（`lib/bridge.js`）：每次发指令前现读状态，按"里面有没有活人"挑分片。

---

## 8. 模组入口与钩子

`modinfo.lua` 必须项：

```lua
name = "…"
description = [[…]]
author = "…"
version = "2.1.1"
api_version = 10
dst_compatible = true
all_clients_require_mod = true     -- 服务端+客户端都要装（本项目是）
client_only_mod = false
configuration_options = { { name = "INTERVAL", label = "…", hover = "…",
                            options = { { description = "1 秒", data = 1 } }, default = 1 } }
```

读取配置：`GetModConfigData("INTERVAL")`（在 modmain 环境里，`env.GetModConfigData`）。

钩子（`scripts/modutil.lua`）：

| 钩子 | 什么时候跑 | 注意 |
|---|---|---|
| `AddGamePostInit(fn)` | 模组加载后（`mods.lua` 的 `SetPostEnv`） | ⚠ **专用服务器上这时 `TheWorld` 还是 nil** |
| `AddSimPostInit(fn)` | 模拟起来之后 | 这里 `TheWorld` 有了 |
| `AddPlayerPostInit(fn)` | 每个玩家实体生成时 | 最可靠的"开始干活"时机 |
| `AddPrefabPostInit(prefab, fn)` | 某个 prefab 生成时 | |
| `AddClassPostConstruct(class, fn)` | 类构造之后（HUD、屏幕） | 客户端常用 |
| `AddComponentPostInit(comp, fn)` | 组件挂到实体时 | |

> ⚠ **必须多个钩子都尝试启动**，`boot()` 要幂等（本项目踩过一次：只有 `AddGamePostInit`，
> `TheWorld` 为 nil 时安静返回，之后再没人调 → 模组加载成功、零报错、一个文件都不写）。
> 另外：世界对象被换掉（读档/换分片）时，挂在世界上的任务会跟着旧实体一起消失，
> 所以本项目把看门狗挂在**玩家**身上，并在世界对象变化时整条桥重来。

---

## 9. 踩坑总表（本项目真机记录）

| 现象 | 根因 | 修法 |
|---|---|---|
| 模组加载成功、零报错，但一个文件都不写 | `GamePostInit` 跑时 `TheWorld == nil`，`boot()` 安静返回后没人重试 | `AddSimPostInit` / `AddPlayerPostInit` 也启动；`boot()` 幂等且世界变了重来 |
| 状态只写第一份（`seq` 一直是 1） | `TheSim:GetTime()` 不存在 → 恒为 0，"隔 N 秒"判断永不成立 | 自己推秒表 `U.advance` / `U.now` |
| 观察器整条崩：`variable 'GetClock' is not declared` | DST 没有 `GetClock` / `PHASES`，严格模式直接抛错 | 一律 `U.g("名字")`；时间读 `TheWorld.state` |
| 状态里没有"位置"、附近一片空 | `pcall` 只拿第一个返回值，`GetWorldPosition` 的 y/z 丢了 | `U.call` 保留多返回值 |
| `→ 用 table: 000000000c654100` | `workable.action` 是动作对象，不是字符串 | `U.action_name()` 反查 |
| 采草/树苗被拒："游戏说做不了这个动作" | 用了 `ACTIONS.HARVEST`，应该用 `ACTIONS.PICK` | 采集用 `pickable` 自己的动作，回退 `PICK` |
| 背包永远"0 样"（东西其实进包了） | `Inventory:GetItems()` 不存在 | `ForEachItem`（带 `itemslots` 兜底） |
| 箱子/锅内容永远读成空 | `Container:GetItems()` / `GetNumItems()` 不存在 | `GetNumSlots` + `GetItemInSlot(i)` |
| 永远"背包里没有能砍的工具" | `Tool:CanDoAction("CHOP")` 传字符串，键是动作**对象** | 传 `ACTIONS.CHOP` |
| 指令发给洞穴分片，回"现在没有玩家" | 两个分片共用 io 目录；桥的 active 分片缓存过期 | 没人的分片不执行指令；发指令前现读状态挑分片 |
| 地上草帽被认成"火还剩 100%" | `fueled` + `burnable` 判断太宽 | 要求真有 `maxfuel`；可捡物品先判 |

---

## 10. 本项目的 Lua 侧结构（对应关系）

```
scripts/whale/
├─ json.lua     纯 Lua 的 JSON 编解码（沙箱里不保证有游戏自带的 json）
├─ util.lua     U.g / U.try / U.call / U.now / 背包 / 容器 / 挑工具 / 世界状态   ← 本文档的落地
├─ observe.lua  状态 → 给 AI 看的文字（[编号] + 坐标 + 能做什么）
├─ actions.lua  30 个动作的状态机（BufferedAction + PushAction + 结果事件）
├─ bridge.lua   文件桥（双通道 + 分片规则）+ 主循环 + 看门狗
└─ client.lua   走路动画 RPC / 小窗 / F8（AI 开停）·F7（开关小窗）/ 可选暂停
```

改模组时请顺手做两件事：

1. `node tools/api-lookup.mjs <符号>` 核对一下要用的 API 在这个版本里真的存在；
2. 跑 `node --test "tests/*.test.mjs"` 和 `node tools/lua-check.mjs`（前者会拦"直接读 GLOBAL"、
   "拿 nil 判断成功"、"多返回值被截断"这类真机踩过的坑）。

## 两个"必须这么做"的机制（真机踩出来的，别再改回去）

### 1. 连砍 / 连挖：推一次 + hold_control，别每 0.25 秒重建 BufferedAction

官方"按住 F 连砍"不是玩家每下都点，而是 SG 状态机自己在动画第 14 帧重推同一个动作：

```lua
-- scripts/player_common.lua / SGwilson 的 chop 状态里（大意）
TimeEvent(14 * FRAMES, function(inst)
    if playercontroller:IsAnyOfControlsPressed(CONTROL_ACTION) then
        inst:ClearBufferedAction()
        inst:PushBufferedAction(inst.sg.statemem.action)   -- 引擎自己重推
    end
end)
```

而 `playercontroller:IsAnyOfControlsPressed` 在**专用服务器**上（`handler == nil`）读的是
`self.remote_controls[control]` —— 这正是远程客户端"按键状态"的同步通道。所以：

```lua
-- 推一次动作
local ba = BufferedAction(doer, target, ACTIONS.CHOP, tool)
ba.options.no_predict_fastforward = true       -- 官方连砍也打这个标记
doer.components.locomotor:PushAction(ba, true)
-- 然后"按住动作键"
pc = doer.components.playercontroller
pc.remote_controls = pc.remote_controls or {}
pc.remote_controls[CONTROL_ACTION] = true      -- 引擎自己在状态机里连砍
```

**反例（我们踩过）**：外部每 0.25 秒 `BufferedAction(...)` 重建再推 —— 重建会打断 SG，
表现是"砍一下顿一下"，甚至一直 busy 但推不动。要重推就**复用同一个 ba**（把 `ba.doable` 置 nil）。

**必须及时松手**：`pc.remote_controls[CONTROL_ACTION] = nil`，否则会一路砍下去（实测 2 分钟砍了 16 棵）。

**完工判据看游戏里的真实变化**，不是"我推了几次"：
`workable` 组件没了 / `workleft <= 0` / **`workable.action.id` 变了**（树砍倒会变树桩，CHOP → DIG/MINE）。

### 2. 服务端挪人时，客户端没有走路动画

DST 的跑动动画是**客户端自己预测**的（player_classified 里没有 ismoving/isrunning 这种字段），
服务端只改物理位置 → 画面上是"平移滑行"。两条路一起用：

```lua
-- 服务端：纯走路时通知玩家的客户端也走一遍（RPC handler 在 modmain 加载阶段就注册，别等 SimPostInit）
SendModRPCToClient(GetClientModRPC(MODNAME, "walkto"), player.userid, x, z, run and 1 or 0)
-- 客户端 handler：
p.components.locomotor:GoToPoint(Vector3(x, 0, z), nil, run == 1)
```

**但动作的接近段不能发**（砍树时走到目标旁那一段）：客户端和服务端各有一份移动意图会互相拽，
真机表现是"客户端把人拖到树上、服务端 busy 却是 false → chop 报推不动"。

于是再加一个纯视觉看门狗（不碰移动，只补动画）：

```lua
-- 客户端每 0.12 秒：位置在变、但自己的状态机没在走 → 自己播 run_loop
if not p.sg:HasStateTag("moving") and speed > 1.2 then p.AnimState:PlayAnimation("run_loop", true)
elseif 停了 then p.AnimState:PlayAnimation("idle_loop") end
```
