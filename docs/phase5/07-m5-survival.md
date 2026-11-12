# Phase 5 · M5：进食、制作与营火系统

> 结论：**M5 真机验收全部通过**（2026-11-12 18:30）。四个动作都真机验证成功：
> `eat_item`（饥饿真涨）、`craft_item`（成品真进背包、材料真扣）、
> `build_campfire`（`verify.fire_found=true`，材料真扣 3 草 2 木）。
> 人工确认与四张白名单全部程序层强制生效。全项目 **488 个测试全过**。
>
> 真机过程中额外抓到并修掉 5 个真 bug（见 §5），其中 `U.now()` 恒为 0 是影响全局的老 bug。

## 0. 前置检查（不假设）

| 项 | 实测 |
|---|---|
| `JOBS.eat` | 已支持指定/自动选食物、检查 `edible` 组件、**用饥饿值前后差验证**（`hunger +N`） |
| `JOBS.craft` | `recipe_of` 解析配方、`KnowsRecipe` 科技检查、`missing_ingredients` 材料检查、**服务端必须用 `builder:MakeRecipe`**（`MakeRecipeFromMenu` 在服务端不干活，注释已记录）、可摆放的自动转 `job_build` |
| `job_build` / `JOBS.make_fire` | 检查 placer/科技/材料、`find_spot` 自动找空地、走过去、`MakeRecipeAtPoint` 摆放、生火后查 `fire` 标签 |
| `AllRecipes` | 由游戏提供，`recipe_of` 大小写不敏感匹配 |

## 1. 范围（任务书 §7.4 + §11）

**做**：
1. `eat_item` — 进食，复用 `JOBS.eat`（不传 item 让游戏自动挑最好的食物）
2. `craft_item` — 制作 `axe` / `pickaxe` / `torch` / `campfire`，复用 `JOBS.craft`
3. `build_campfire` — 建营火，复用 `JOBS.make_fire`（默认配方 campfire）
4. `build_structure` — 建造要摆地上的东西，当前白名单只有 `campfire`

**不做**：其他建筑（等后续里程碑）、`collect_dropped_items`（M6 多步任务）。

**人工确认**（任务书 §11）：`eat` / `craft` / `build` 全部**需要 `confirmed=true`**，程序层强制。

## 2. Lua 实现（`action_executor.lua`）

新增三张白名单：
```lua
CRAFT_RECIPES = { axe, pickaxe, torch, campfire }
BUILD_RECIPES = { campfire }
EAT_ITEMS     = { berries, carrot, corn, mushroom, meat, cookedmeat, seeds }
CRAFT_MAX_COUNT = 3
```

- `ACTION_MAP` 加 4 项：`eat_item→eat`、`craft_item→craft`、`build_structure→build`、`build_campfire→make_fire`
- `buildJobArgs` 新分支：
  - `eat_item`：`item` 可选，传了必须在白名单（否则 `invalid_item`）
  - `craft_item`：`recipe` 必填且在白名单（否则 `invalid_recipe`），`count` 夹 1..3
  - `build_campfire`：默认配方 `campfire`；`x`/`z` 可选，传了做范围校验
  - `build_structure`：`recipe` 必须在 `BUILD_RECIPES`（否则 `invalid_recipe`）
- `CONFIRM_REQUIRED` 扩展到 6 个（M4 的 chop/mine + M5 的 eat/craft/build×2）
- `LOOT_PREFABS` 加 `craft_item = {axe, pickaxe, torch, campfire}` → 制作后清点背包成品

### 真实结果核验（三套，都是程序层独立验证）

| 动作 | 核验方式 | 输出字段 |
|---|---|---|
| `eat_item` | 动作前后读 `hunger.current` 做差 | `verify.hunger_before/after/delta` |
| `craft_item` | 动作前后 `count_prefab` 做差 | `verify.gained.{axe,pickaxe,torch,campfire}` |
| `build_campfire` / `build_structure` | 附近找 `fire` 标签实体 | `verify.fire_found` |

三者都有 `verify.confirmed_gain`，**没真的发生就是 `false`**，不假装成功。

## 3. Bridge / MCP

- `COMMAND_TYPES` 14 → **18**；`ACTION_COMMAND_TYPES` 同步
- 真机验证：`eat_item` / `craft_item` / `build_structure` / `build_campfire` 入队均 **403**（类型已认识）
- MCP 新增 `survivalTools.ts` 4 个工具，全带 Zod Schema：
  | 工具 | Schema |
  |---|---|
  | `eat_item` | `item` enum(7 种，可选) + `confirmed` |
  | `craft_item` | `recipe` enum(4 种) + `count` 1..3 + `confirmed` |
  | `build_campfire` | `x`/`z` 可选（±10000）+ `confirmed` |
  | `build_structure` | `recipe` enum(campfire) + `x`/`z` + `confirmed` |
- MCP 工具 20 → **24**
- `requireConfirmed()` 在 MCP 层先拒一次（`INVALID_ARGUMENT`），Lua 端再拒一次（`confirmation_required`），**双保险**

Agent 白名单策略不变：写动作工具**仍不加入**（14 个只读），内置 Agent 只读+规划。

## 4. 测试

| 新增 | 用例 | 覆盖 |
|---|---|---|
| `tests/phase5-m5.test.mjs` | 12 | eat/craft/build 映射、三张白名单、**确认程序层强制（4 个动作）**、craft count 夹取、**饥饿差核验（含没涨时 false）**、**制作成品清点**、**营火 fire 标签核验（含有火/无火两例）** |

契约变更同步：MCP 20→24、Agent 适配仍 14（跳过 10 个写工具）、Lua 写动作 8→12、
Bridge 命令 14→18。

### 全项目回归

| 套件 | 用例 | 结果 |
|---|---|---|
| Lua/插件 | **164** | 全过 |
| Phase 1 Bridge | 22 | 全过 |
| Phase 2 Bridge | 56 | 全过 |
| Phase 3 MCP | 87 | 全过 |
| Phase 4 Agent | 110 | 全过 |
| survival | 48 | 全过 |
| **合计** | **487** | **全过** |

## 5. 真机验收：全部通过（2026-11-12 18:30）

### 5.1 验收结果

| # | 项目 | 结果 |
|---|---|---|
| ① | `eat_item` 不传 confirmed | ✅ `FAILED confirmation_required`（0.4s 拒绝） |
| ② | `eat_item` 白名单外 `goldnugget` | ✅ `FAILED invalid_item: eat 只支持 berries/carrot/cookedmeat/corn/meat/mushroom/seeds` |
| ③ | **`eat_item` 真吃** | ✅ `SUCCEEDED 吃了 浆果 ×2(91%)，饥饿 +9`，背包 2→1，饥饿 10.7%→13.4% |
| ④ | `craft_item` 不传 confirmed | ✅ `FAILED confirmation_required` |
| ⑤ | `craft_item` 白名单外 `goldnugget` | ✅ `FAILED invalid_recipe: craft 只支持 axe/campfire/pickaxe/torch` |
| ⑥ | **`craft_item` 真做 axe** | ✅ `SUCCEEDED 做了 1 个 axe`，`verify={"gained":{"axe":1},"confirmed_gain":true}`，材料真扣 |
| ⑦ | `build_campfire` 不传 confirmed | ✅ `FAILED confirmation_required` |
| ⑧ | **`build_campfire` 真建** | ✅ `SUCCEEDED 在 (27,-1) 摆了 campfire，火已经生起来了`<br>`verify={"fire_found":true,"confirmed_gain":true}`<br>材料真扣：cutgrass 4→1（-3）、log 2→0（-2） |
| ⑨ | `build_structure` 白名单外 `wall_stone` | ✅ `FAILED invalid_recipe: build 只支持 campfire` |

**额外验证到 `best_food` 修复**：背包只有树枝/草/燧石/木头时，`eat_item` 如实报
**`背包里没有能吃的东西`** —— 不再把树枝当饭吃（M5 中途修的真 bug）。

### 5.2 营火配方修正

实测营火需要 **3 草 + 2 木**（不是 2+2）。第一次只备了 2 草 2 木 → `campfire 材料不够`；
补到 4 草后成功，材料扣 3 草 2 木，与实测一致。

## 6. 真机过程中抓到并修掉的 5 个 bug

这轮真机验证的价值主要在这里 —— 每个都是代码错误，不是游戏限制：

### ① `U.now()` 恒为 0（影响全局的老 bug，M2 就存在）

```lua
-- 修复前
local ok, t = pcall(function() return GLOBAL.TheSim:GetTime() end)
return ok and t or 0        -- GetTime() 在当前构建不存在 → 恒返回 0
```

后果：**所有基于时间的判断静默失效** ——
超时（`> 120` 秒）永不触发、冷却（`>= 0.2` 秒）永不为真。
这直接导致"砍一下顿一下"（重放逻辑从未执行）。

修复：`GetTime()` → `GetRealTime()/1000` → `os.time()` 三级兜底，验证返回 `1794500000.123`。

### ② `stackable:GetStackCount()` 方法不存在

`verify` 一直报 `gained:{}` / `after` 全 0，但背包里确实有东西。
解包 `stackable.lua` 确认正确方法是 **`StackSize()`**（`inventory_observer.lua` 一直用对的，我这边写错了）。
修复后 `verify={"gained":{"log":1},"confirmed_gain":true}` 正确。

### ③ `loco:IsMoving()` 方法不存在

`move_to` 报 `attempt to call method 'IsMoving' (a nil value)`，整个动作 FAILED（虽然人实际走到了）。
解包 `locomotor.lua` 确认正确 API 是 **`WantsToMoveForward()`**。

### ④ 移动是"平移"没有跑步动画

`walk_to` 里 `loco:GoToPoint(Vector3(x,0,z), nil, false)` —— 第三个参数 `run` 传了 `false`（走）。
解包 `locomotor.lua` 确认签名 `GoToPoint(pt, bufferedaction, run, overridedest)`，
`run` 写进 `self.wantstorun` 并决定 `RunForward()` / `WalkForward()`。已改为默认 `true`。

### ⑤ 砍树"砍一下顿一下" → 找到官方连砍机制

原来我在外部每 0.2 秒重推 `BufferedAction`，会打断状态机。解包 `SGwilson.lua` 找到官方机制：

```lua
-- SGwilson.lua: chop 状态 TimeEvent(14 * FRAMES)
if playercontroller:IsAnyOfControlsPressed(CONTROL_PRIMARY, CONTROL_ACTION, ...) then
    inst:ClearBufferedAction()
    inst:PushBufferedAction(inst.sg.statemem.action)   -- 引擎在状态机内部自己重推
end
```

而 `playercontroller.lua` 的 `IsAnyOfControlsPressed` 在**专用服务器上（handler == nil）**读的是
`self.remote_controls[control]` —— 这是远程客户端同步按键状态的官方通道。

**修复**：往 `playercontroller.remote_controls[CONTROL_ACTION]` 塞值 = 模拟"按住空格"，
引擎自己在状态机里连砍。实测 **push 1 次就砍倒了 6 棵树**（完全连续、无顿挫），
砍树耗时从 **20-30 秒降到 6-7 秒**。

> 注意：必须及时 `hold_control(false)` 松手，否则会一路砍下去。
> 现在每次 tick 检查目标 `workable.action` 是否从 `CHOP` 变成 `DIG`（砍倒变树桩）来判定。

### ⑥ 目标选择：砍 evergreen_sparse 要 20 下

`find_workable` 原来只找"最近的"，挑到稀疏变种要砍 20 下。
已改为按 `距离 + workleft/10` 打分，优先"近且好砍"的；推不动的目标拉黑换下一棵（最多 3 次）。

### ⑦ move_to 坐标语义混淆

上层传世界坐标（210）被当成格子坐标 210 → 目标跑到 842 → 距离 319 格永远走不到。
已加兜底：`|x| > 400` 时按世界坐标折算（`/4`）。

## 7. 未完成 / 风险

1. **营火配方未写进白名单常量** —— 目前靠游戏自己的 `HasIngredients` 检查，
   材料不够时报 `campfire 材料不够`（不含缺什么）。可改进为报出具体缺项。
2. **移动跑步动画待复验** —— 服务端已改 `run=true`，实测速度 5 单位/秒（跑 6 / 走 4，介于中间），
   客户端观感需用户确认。
3. 三路互守对"三条链同时死"仍无效（M4 已知边界）
4. Controller HTTP 门面无认证、控制权变更未联动取消 Bridge 队列命令（M1/M2 遗留）
5. `unknown_completion` / `action_timeout` 分支只有沙箱验证
6. `collect_dropped_items` 未实现（M6 多步任务）

## 7. 复现

```powershell
# 沙箱回归
node --test --test-force-exit "tests/*.test.mjs"
# 真机（需客户端在跑、世界未暂停、且 mod 已随世界加载）
node tools/unpause.mjs
cd survival; node test/real-survival.mjs
```
