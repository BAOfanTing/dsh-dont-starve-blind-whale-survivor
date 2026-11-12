# Phase 5 · M4：工具使用系统（equip / chop / mine / pick up）

> 结论：代码与测试完成，**全项目 475 个测试全过**；M4 的 4 个命令类型已在真实 Bridge 上验证部署
> （入队返回 403 = 类型已认识、只差控制权）。
> **真机动作未验证** —— 准备执行时发现 DST **客户端进程已退出**（只剩 CPU=0 的僵尸专用服务器），
> 没有客户端就没有世界在跑，无法执行任何动作。如实标注，不伪造。

## 0. 前置检查（不假设）

| 项 | 实测 |
|---|---|
| `Whale.actions` | `equip` / `chop` / `mine` / `dig` 已存在，走 `ACTIONS.*` + `BufferedAction`，`job_work` 自带工具自动装备与超时 |
| `ACTIONS.PICKUP` | M3 真机 `probe_game_actions` 确认 **true** → M4 才开放 `pick_up_item` |
| 游戏状态 | 客户端 `dontstarve_steam_x64` 已退出；6 个专用服务器进程 CPU=0（僵尸） |

## 1. 范围（任务书 §7.3 + §11）

**做**：
1. `equip_item` — 装备 `axe` / `pickaxe` / `torch`（白名单），复用 `JOBS.equip`
2. `chop_tree` — 砍树，复用 `JOBS.chop`，**需人工确认**
3. `mine_rock` — 采矿，复用 `JOBS.mine`，**需人工确认**
4. `pick_up_item` — 捡地面物品（M3 补遗，`PICKUP` 已确认可用），新增 `JOBS.pickup`
5. **三路互守**修周期任务停摆（M3 遗留的必修阻塞项）

**不做**：`collect_dropped_items`（多步批量，留 M6）、`eat` / `craft` / `build`（M5）。

## 2. 三路互守（M4 必修阻塞项）

M3 真机发现：游戏在跑、画面正常，但 **mod 的所有周期任务同时停摆**
（`whale_io_hud.json` 与心跳同一秒停止）。原来的 `net.keepAlive` 挂在 observer tick 上，
observer 一起死时无效。

**改法**：三条链互相守护，任一条活着就能拉起另外两条：

| 驱动方 | 被守护 |
|---|---|
| 观察器 `O.Tick()` | `BWS2.net.keepAlive()` + `Whale.bridge.KeepAlive()` |
| 文件桥 `server_tick()`（0.2s） | `BWS2.net.keepAlive()` + `BWS.observer.KeepAlive()` |
| net tick | （由上面两条守护） |

实现要点：
- 每条链记 `last_tick_at`，**不信任任务对象"看着有效"**，只看时间戳是否在走
- `O.KeepAlive()` / `B.KeepAlive()` 超时后重置守卫并重建 `DoPeriodicTask`
- 全部 `pcall` 隔离，任一条出错不影响自己
- 时钟用 `os.time`（`U.now()` 依赖 `TheSim:GetTime`，某些构建恒为 0）

**已知边界**：如果三条链同时死，Lua 侧无法自愈（需要重载世界）。这一点写在 §5。

## 3. 动作实现

### 3.1 Lua（`action_executor.lua`）

新增白名单（全部固定，外部字符串只查表）：
```lua
EQUIP_ITEMS  = { axe, pickaxe, torch }
CHOP_TARGETS = { evergreen, twiggytree, mushtree, tree }
MINE_TARGETS = { rock, rock1, rock2, rock_flintless }
PICKUP_ITEMS = { flint, rocks, log, twigs, cutgrass, berries }
LOOT_PREFABS = { chop_tree={log,twigs}, mine_rock={rocks,flint,nitre,goldnugget}, pick_up_item={...} }
CONFIRM_REQUIRED = { chop_tree=true, mine_rock=true }
```

- `buildJobArgs()` 规范化参数：`count` 砍/矿夹 1..5（比采集的 10 更严）、`radius` 2..20
- **人工确认程序层强制**：`params.confirmed ~= true` → `confirmation_required` 直接拒（不靠提示词）
- **掉落物清点**：动作前记 `count_prefab` 快照，完成后做差 → `verify.gained`
- **装备核验**：完成后查 `inventory:GetEquippedItem(HANDS).prefab` → `verify.equipped`
- 参数错误码透传（`invalid_target` / `invalid_item` 而非一律 `invalid_argument`）

### 3.2 真机抓到的 bug（已修）

`chop_tree` 传 `target="rock1"` 竟然通过了。原因是我写了：
```lua
local allowed = command.type == 'chop_tree' and CHOP_TARGETS[p.target] or MINE_TARGETS[p.target]
```
Lua 的 `and/or` 短路：`CHOP_TARGETS['rock1']` 是 `nil` 时，整个表达式**回退到** `MINE_TARGETS['rock1']`
→ chop 接受了矿石目标。已改成显式 `if/else` 分支，并加了回归测试。

### 3.3 新增 `JOBS.pickup`（`actions.lua`）

掉落物判据与 `entity_observer` 一致：有 `inventoryitem` 组件且 `owner == nil`。
走 `ACTIONS.PICKUP` + `BufferedAction`，超时/忙碌判断与 `pick` 同构。

> 编辑时我一度误删 `JOBS.attack` 的开头两行，已修复并用 luaparse 校验（10 个 JOBS 齐全）。

### 3.4 Bridge（`commands.ts`）

`COMMAND_TYPES` 加 4 个（共 14）；`ACTION_COMMAND_TYPES` 同步。
真机验证：4 个类型入队均返回 **403**（类型已认识、只差控制权）。

### 3.5 MCP（`toolUseTools.ts`）

| 工具 | readOnly | Schema |
|---|---|---|
| `equip_item` | false | `item` enum(axe/pickaxe/torch) |
| `chop_tree` | false | `count` 1..5、`radius` 2..20、`target` enum(树)、`confirmed` bool 默认 false |
| `mine_rock` | false | 同上（target enum 矿石） |
| `pick_up_item` | false | `item` enum(6 种)、`count` 1..10、`radius` 2..20 |

- 全部 `requireControl()` 程序层查控制权
- `chop_tree` / `mine_rock` 在 MCP 层也检查 `confirmed !== true` → 直接拒绝（双保险）
- 返回 `action_id`，不阻塞

MCP 工具 16 → **20**。

### 3.6 Agent 策略不变

写动作工具**仍不加**进 Agent 白名单（14 个只读）。任务书 §11：默认 SUPERVISED，
内置 Agent 这一版只读+规划，避免模型绕过确认直接改游戏。

## 4. 测试

| 新增 | 用例 | 覆盖 |
|---|---|---|
| `tests/phase5-m4.test.mjs` | 13 | 映射、装备/目标/物品白名单、**确认程序层强制**、掉落清点、装备核验（含核验不一致）、`and/or` 陷阱回归、三路互守接线 |
| `mcp-server/test/m4ToolUse.test.ts` | 10 | Schema 约束、确认拒绝、控制权 5 种拒绝、master 分片、参数透传 |

契约变更同步：MCP 16→20、Agent 适配仍 14（跳过 6 个写工具）、Lua 写动作 4→8、
Bridge 命令 10→14、`phase2-m4` 的白名单外命令示例 `chop_tree` → `eval_lua`。

### 全项目回归

| 套件 | 用例 | 结果 |
|---|---|---|
| Lua/插件 | **152** | 全过 |
| Phase 1 Bridge | 22 | 全过 |
| Phase 2 Bridge | 56 | 全过 |
| Phase 3 MCP | **87** | 全过 |
| Phase 4 Agent | 110 | 全过 |
| survival | 48 | 全过 |
| **合计** | **475** | **全过** |

## 5. 未完成 / 风险

1. **真机动作未验证**（§6）—— 客户端已退出，没有世界在跑
2. **三路互守对"三条链同时死"无效** —— 需要重载世界。这是已知边界，不是遗漏
3. `collect_dropped_items` 未实现（M6 多步任务）
4. `eat` / `craft` / `build` 未开放（M5）
5. Controller HTTP 门面无认证、控制权变更未联动取消 Bridge 队列命令（M1/M2 遗留）
6. `unknown_completion` / `action_timeout` 分支只有沙箱验证，真机未触发
7. 砍树/采矿依赖背包里有对应工具；没有时游戏会如实回报「背包里没有 axe」，不会伪造

## 6. 真机验证：脚本已备好，未跑成（如实）

`survival/test/real-tooluse.mjs`（`node --check` 通过）会依次验证：
1. 等会话连上 → 授权控制权 → 记采集前背包
2. `equip_item(axe)` → 核验 `verify.equipped`
3. `chop_tree` **不传 confirmed** → 应被拒 `confirmation_required`
4. `chop_tree(confirmed=true)` → 核验 `verify.gained.log/twigs`
5. `mine_rock(confirmed=true)` → 核验 `verify.gained.rocks/flint`
6. `pick_up_item(twigs)` → 核验 `verify.gained`
7. 白名单越权 4 例（spear / chop 传 rock1 / mine 传 evergreen / goldnugget）→ 应全被拒
8. 清理控制权

**准备执行时发现 `dontstarve_steam_x64` 进程不存在**（只剩 6 个 CPU=0 的僵尸专用服务器），
没有客户端就没有世界在跑，动作无从执行。没有空等、没有擅自启动游戏，**真机未验证**。

> 顺带把 `tools/unpause.mjs` 改好：找不到客户端时明确提示「游戏客户端没开，无法解除暂停」，
> 不再抛 PowerShell 异常。

## 7. 复现

```powershell
# 沙箱回归
node --test --test-force-exit "tests/*.test.mjs"
# 真机（需客户端在跑、窗口未最小化）
node tools/unpause.mjs
cd survival; node test/real-tooluse.mjs
```
