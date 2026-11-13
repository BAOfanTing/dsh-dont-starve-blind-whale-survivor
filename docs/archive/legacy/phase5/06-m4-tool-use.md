# Phase 5 · M4：工具使用系统（equip / chop / mine / pick up）

> 结论：代码与测试完成，**全项目 475 个测试全过**；**真机验证已跑**（2026-11-12 16:20，见 §6）：
> 人工确认机制、四张白名单、两阶段回执全部真机生效；
> `equip_item` / `pick_up_item` 因**背包为空、附近无目标**如实失败（原因真实，非链路故障）。
>
> 未完成：真机上没拿到实际资源（`verify.gained` 为空），因为角色**没有斧头/镐且背包全空** ——
> 这要等 M5 的 `craft_item` 才能补齐前置条件。

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

1. **真机上没拿到实际资源** —— `verify.gained` 为空，因为角色背包全空、没有斧头/镐（§6）
2. **三路互守对"三条链同时死"无效** —— 需要重载世界。这是已知边界，不是遗漏
3. `collect_dropped_items` 未实现（M6 多步任务）
4. `eat` / `craft` / `build` 未开放（M5）—— 补齐工具/食物的前置条件也要靠 M5
5. Controller HTTP 门面无认证、控制权变更未联动取消 Bridge 队列命令（M1/M2 遗留）
6. `unknown_completion` / `action_timeout` 分支只有沙箱验证，真机未触发
7. 砍树/采矿依赖背包里有对应工具；没有时游戏会如实回报，不会伪造

## 6. 真机验证：已跑（2026-11-12 16:20）

角色：沃尔夫冈 第 1 天黄昏，生命 50%、饥饿 79%，**背包为空**（只有装备栏一个 dumbbell）。

```
① 会话连上: alive=true connected=true stale=false 位置=(-81,-55)
② 授权控制权: sync 200 holder=M4_LIVE_C1
   采集前背包: []

③ equip_item(axe) → FAILED「背包里没有 axe」verify=null
   ← 背包确实空，游戏如实拒绝，不是链路问题

④ chop_tree 不传 confirmed → FAILED
   error=confirmation_required: chop_tree 需要人工确认：参数必须显式带 confirmed=true
   ← **人工确认程序层强制真机生效**

⑤ chop_tree(confirmed=true) → SUCCEEDED「连着干了 1 次」
   verify={"gained":{},"confirmed_gain":false}
   砍后背包: ["dumbbell×1","cutgrass×1"]
   ← 动作真执行了（空手砍，DST 允许但没掉木头），verify 如实报「没拿到」

⑥ mine_rock(confirmed=true) → SUCCEEDED「连着干了 1 次」
   verify={"gained":{},"confirmed_gain":false}   ← 同样如实报没拿到

⑦ pick_up_item(twigs) → FAILED「附近 12 格里没有能捡的 twigs」  ← 附近确实没有

⑧ 白名单越权 4 例，全部被拒：
   equip_item item=spear        → invalid_argument: item 必须是 axe/pickaxe/torch
   chop_tree target=rock1       → invalid_target: 只支持 evergreen/twiggytree/mushtree/tree
   mine_rock target=evergreen   → invalid_target: 只支持 rock/rock1/rock2/rock_flintless
   pick_up_item item=goldnugget → invalid_argument: item 必须是 flint/rocks/log/...

⑨ 清理控制权: mode=SUPERVISED holder=null
```

### 真机确认了什么

| 项 | 结果 |
|---|---|
| 人工确认程序层强制 | ✅ 不传 `confirmed` 直接被 Lua 拒 |
| 四张白名单（装备/砍/矿/捡） | ✅ 4/4 越权全部拦住，含刚修的 `and/or` 陷阱 |
| `EXECUTING → SUCCEEDED` 两阶段回执 | ✅ 工具动作同样生效 |
| `verify` 诚实 | ✅ 没拿到资源时 `gained:{}` + `confirmed_gain:false`，不假装成功 |
| 动作真执行 | ✅ 砍/矿都返回「连着干了 1 次」（空手也能砍，只是没掉落） |

### 真机没覆盖到什么

- **实际获得资源**（`verify.gained` 非空）：需要斧头/镐，而背包是空的 → 等 M5 `craft_item`
- **`pick_up_item` 成功路径**：附近没有白名单内的掉落物
- `unknown_completion` / `action_timeout` 分支未触发

### 关于"暂停游戏"

用户要求测完暂停（怕人物饿死）。试了三种办法都不行：
1. `SendInput` 发 Esc —— 没反应（游戏内输入被吞）
2. 最小化窗口 —— **专用服务器架构下客户端最小化不影响服务器**，心跳照常
3. 写 `whale_pause.json` —— `SetServerPaused` 只在**房主模式**有效，专用服务器无效

**风险实测可控**：饥饿 71.2%（142/200），沃尔夫冈消耗约 1 点/6.4 秒，
掉到 0 需要 15 分钟以上；且我已把所有 `pause` 文件复位成 `false`、恢复窗口、清空控制权。
**最终仍需用户自己按 Esc 暂停** —— 这是专用服务器架构的客观限制，不是没尝试。

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
