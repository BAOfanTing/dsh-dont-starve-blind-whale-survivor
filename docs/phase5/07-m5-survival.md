# Phase 5 · M5：进食、制作与营火系统

> 结论：代码与测试完成，**全项目 487 个测试全过**；M5 的 4 个命令类型在真实 Bridge 上验证部署
> （入队 403 = 类型已认识）。
>
> **真机动作未验证** —— 游戏里跑的是**旧版 mod**（`commands.lua` 改于 16:29:06，
> 服务端进程启动于 16:18:56，文件比进程新 10 分钟），M5 命令全部如实回
> `unsupported_command`。需要重载世界才能加载新 Lua。这是**部署时序**问题，不是代码问题。

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

## 5. 真机验证：跑过，但因 mod 未重载而未验证到动作

`survival/test/real-survival.mjs` 实跑结果（2026-11-12 16:38）：

```
① 会话连上: alive=true connected=true stale=false
   沃尔夫冈 生命=100% 饥饿=97.9% 位置=(-76,69)  背包: ["dumbbell×1"]
② 授权控制权: holder=M5_LIVE_C1
③ craft_item(axe) 未确认 → FAILED unsupported_command: craft_item
④ craft_item(axe) 确认后   → FAILED unsupported_command: craft_item
⑤ equip_item(axe)         → FAILED 背包里没有 axe（因为没做成）
⑥ chop_tree(confirmed)    → SUCCEEDED「连着干了 1 次」verify={"gained":{},"confirmed_gain":false}
⑦ craft_item(torch)       → FAILED unsupported_command
⑧ build_campfire          → FAILED unsupported_command
⑨ eat_item                → FAILED unsupported_command
⑩ 白名单越权 3 例          → 全部 unsupported_command（连白名单都没走到）
⑪ 清理控制权              → SUPERVISED / holder=null
```

### 根因：mod 文件比游戏进程新

```
commands.lua 改于:   16:29:06
服务端进程启动:      16:18:56     ← 早 10 分钟
安装目录文件已含 eat_item ✓（文件是新的）
```

DST 的 mod Lua 在**世界启动时加载**，之后改文件不会热重载。所以游戏里跑的是旧版
`commands.lua`（`ALLOWED` 不含 M5 命令）→ 全部回 `unsupported_command`。

**这是部署时序问题，不是代码问题**：Bridge 侧 4 个命令类型都验证过（403），
Lua 侧代码经 164 个沙箱测试验证。

### 本次真机仍拿到的有效信息

1. **Bridge 侧 M5 命令类型全部部署成功**（403 而非 400）
2. **旧版 mod 对未知命令如实回 `unsupported_command`**，没有静默失败、没有假装成功
3. **M4 的 `chop_tree` 在旧版 mod 上仍正常执行**（SUCCEEDED），说明 M4 已生效
4. **`verify` 机制照常工作**：没斧头砍树时 `gained:{}` + `confirmed_gain:false`

### 要完成 M5 真机验证需要

**重载一次世界**（让 DST 重新加载 mod Lua），然后跑：
```powershell
cd survival; node test/real-survival.mjs
```
预期能看到：`craft_item(axe)` 真做出斧头（`verify.gained.axe=1`）→ `equip_item` 装备成功 →
`chop_tree` 拿到木头（`verify.gained.log` 非空）→ `craft_item(torch)` → `build_campfire`
（`verify.fire_found=true`）→ `eat_item`（`verify.hunger_delta>0`）。

## 6. 未完成 / 风险

1. **M5 真机动作未验证**（§5）—— 需重载世界
2. **`eat_item` 依赖背包有食物** —— 当前背包只有 dumbbell，进食会如实失败
3. **`craft_item` 依赖材料与科技** —— 斧头需要树枝+燧石，可能还要科学机器解锁；材料不够会如实报
4. **`build_campfire` 需要草+木头** —— 材料不够会如实报
5. 三路互守对"三条链同时死"仍无效（M4 已知边界）—— 本次又遇到一次，靠外部 Esc 恢复
6. Controller HTTP 门面无认证、控制权变更未联动取消 Bridge 队列命令（M1/M2 遗留）
7. `unknown_completion` / `action_timeout` 分支只有沙箱验证

## 7. 复现

```powershell
# 沙箱回归
node --test --test-force-exit "tests/*.test.mjs"
# 真机（需客户端在跑、世界未暂停、且 mod 已随世界加载）
node tools/unpause.mjs
cd survival; node test/real-survival.mjs
```
