# Phase 6 · M4：Combat Controller 与 Kiting

> 结论：**完成**。两颗状态机（Lua 执行侧 0.1 秒 tick / Node 编排侧审计），
> 只用游戏原生动作（`combat:TryAttack` 优先，退回 `BufferedAction(ATTACK)`），
> **不用 ForceAttack**；同一时间只允许一个战斗执行器；战斗期间每 2 秒复核控制权。

## 1. 文件修改清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `DontStarveWhaleSurvivor/scripts/main/combat_executor.lua` | 新增 | 9 态状态机 + Kiting + 白名单 + 控制权复核（约 640 行） |
| `DontStarveWhaleSurvivor/scripts/main/action_executor.lua` | 修改 | 战斗命令转交；战斗中拒绝原子动作；`heal_self` 映射与生命差核验 |
| `DontStarveWhaleSurvivor/scripts/main/commands.lua` | 修改 | 命令白名单 + `get_combat_status` / `probe_combat_api` |
| `DontStarveWhaleSurvivor/scripts/main/observer_manager.lua` | 修改 | 每 tick 驱动 `combat.Drive()`（周期任务失效时兜底） |
| `DontStarveWhaleSurvivor/scripts/main/task_runner.lua` | 修改 | 四季准备任务链（战斗会打断它们） |
| `DontStarveWhaleSurvivor/modmain.lua` | 修改 | 加载战斗执行器；死亡时 `ForceStop` |
| `mcp-server/src/survival/combatState.ts` | 新增 | Node 侧 9 态状态机 + `CombatLock` |
| `mcp-server/src/survival/combatController.ts` | 新增 | 五道程序层闸门的编排器 |
| `mcp-server/src/tools/phase6Tools.ts` | 新增 | `start_combat` / `abort_combat` / `recover_after_combat` / `get_combat_status` |
| `game-bridge/src/commands.ts` | 修改 | 命令白名单 21 → 28 |
| `tests/phase6-lua.test.mjs` | 新增 | 6 个战斗执行器用例 |
| `mcp-server/test/p6.test.ts` | 新增 | 状态机 + 控制器拒绝路径用例 |

## 2. 实现原理

### 2.1 9 态状态机（两侧同构）

```
IDLE → ASSESSING → PREPARING → ENGAGING ⇄ EVADING → RETREATING → RECOVERING → COMPLETE
                                              ↘ (任何状态) → ABORTED
```

合法迁移表在 `combat_executor.lua` 的 `TRANSITIONS` 与 `combatState.ts` 的 `COMBAT_TRANSITIONS`
里**同构**，两侧都拒绝非法迁移（如 `IDLE → COMPLETE`）。

每次迁移都记 `from/to/at/why` 审计（最多保留 40 条，`get_combat_status` 能看到）。

### 2.2 Kiting 循环（0.1 秒一次，全在 Lua）

```
① 死了 / 超时 / 目标消失             → 结算（ABORTED / COMPLETE）
② 生命 ≤ retreat_hp（默认 30%）      → RETREATING（自动脱离，不等上层提醒）
③ 每秒复核装备（手/身/头 + 耐久）    → equipment_warnings
④ 敌人正在出手 且 我在它攻击圈内      → 先让开（dodge）
⑤ 刚打完一刀（backoff 窗口内）        → 保持距离等冷却
⑥ 够不着（距离 > 0.9×攻击距离）       → 走到攻击距离边缘
⑦ CanAttack == false                 → 保持距离等他出手
⑧ 否则                               → attack_once()，命中 +1，进入 backoff
```

Kiting 参数按敌人类型配置（`KITE_PROFILES`）：

| prefab | attack_range | backoff | dodge |
|---|---|---|---|
| hound | 2.0 | 0.55s | 0.35s |
| spider | 2.0 | 0.45s | 0.30s |
| merm | 2.0 | 0.60s | 0.35s |
| 默认 | 2.0 | 0.60s | 0.40s |

**不是统一频率**（任务书明确禁止）：不同敌人的出手周期不同，backoff/dodge 分别配。

### 2.3 攻击只用原生路径

```lua
local function attack_once(p, target)
    if combat ~= nil and combat.TryAttack ~= nil then
        local ok, did = pcall(function() return combat:TryAttack(target) end)
        if ok and did == true then return true, "try_attack" end
        ...
    end
    -- 退回：BufferedAction(player, target, ACTIONS.ATTACK, nil) + locomotor:PushAction
end
```

- **首选** `combat:TryAttack(target)`：走游戏自己的攻击条件检查（距离/冷却/武器）；
- **退回** `BufferedAction`：和玩家点鼠标同一条路；
- **两条都没有** → 直接 `attack_api_unavailable` 失败，**绝不 ForceAttack**。

`probe_combat_api` 命令可随时探测当前构建：`try_attack / can_attack / get_attack_range /
actions_attack / buffered_action / locomotor_goto / player_combat`。

### 2.4 单执行者（三层保证）

1. **Node `CombatLock`**：一个玩家同时只有一个战斗持有者；`start_combat` 第二次直接 `COMBAT_BUSY`。
2. **Node 状态机**：`machine.isActive()` 时 `begin()` 抛错。
3. **Lua `combat_already_running`**：Lua 自己再拒一次。
4. **反向保护**：战斗进行中，`action_executor.execute()` 对**原子动作**返回
   `combat_in_progress`（"同一时间只允许一个执行者"）—— 这正是任务书 §5 最后一句。

### 2.5 控制权/紧急停止的战斗期复核

控制权 assert 只在命令**开始**时做过一次，而一场战斗可能持续几十秒。
所以 `combat_executor` 每 2 秒异步 `POST /api/v1/control/assert`：

- 被拒（紧急停止 / 人工接管 / lease 过期）→ **立刻** `locomotor:Stop()` + 结算
  `FAILED control_revoked`；
- 请求本身失败（Bridge 挂了）→ 不做"乐观放行"，下一轮继续查。

这补上了 Phase 5 遗留的"控制权变更不撤销已入队命令"在战斗场景下的窟窿。

### 2.6 白名单与 Boss 硬拦

```lua
local AUTONOMOUS_ENEMIES = { hound = true, spider = true, spider_warrior = true,
    mosquito = true, killerbee = true, frog = true, merm = true }
local BOSS_PREFABS = { deerclops = true, bearger = true, dragonfly = true, beequeen = true,
    antlion = true, moose = true, klaus = true, malbatross = true, toadstool = true,
    spiderqueen = true, stalker = true, crabking = true }
```

- `target_prefab` 命中 `BOSS_PREFABS` → `boss_requires_supervised_combat`（连参数都进不来）；
- 不在 `AUTONOMOUS_ENEMIES` → `unverified_enemy`（保守避战）；
- 不传目标时只会在白名单里挑最近的。

这两张表与 TS 侧 `profiles.ts` 的一致性由测试强制（`tests/phase6-lua.test.mjs` 解析 Lua 源比对）。

## 3. 实际测试

```
✔ P6-M4：start_combat 没有 confirmed=true → 拒绝（SUPERVISED_COMBAT 程序层强制）
✔ P6-M4：Boss 与无档案生物一律拒绝自动交战（保守避战）
✔ P6-M4：正常敌人 → ASSESSING/PREPARING/ENGAGING，tick 会真的攻击（原生 TryAttack）
✔ P6-M4：生命低于阈值 → 自动 RETREATING（不靠上层提醒）
✔ P6-M4：abort_combat 立刻停手（ABORTED + FAILED 回执）
✔ P6-M4：同一时间只允许一个战斗执行器（第二个 start_combat 被拒）
✔ P6-M4：状态机拒绝非法迁移（IDLE 不能直接 COMPLETE）
✔ P6-M4：9 态状态机合法/非法迁移 + 单执行者（Node 侧）
✔ P6-M4：控制器程序层拒绝 —— 没确认 / 没控制权 / 决策不是 ENGAGE / Boss / 未验证
✔ P6-M4：控制器成功路径 → 下发 start_combat 且带 confirmed=true；第二个战斗被拒
```

## 4. 预期结果（对照验收）

| 验收项 | 结果 |
|---|---|
| ⑥ 完成选定普通敌人的人工监督战斗 | ⏳ **沙箱通过，真机待执行**（见 08） |
| ⑦ 监控装备和生命变化 | ✅ Lua 每秒复核 + `equipment_warnings` + `hp/min_hp` |
| ⑪ 严重危险及时停止 | ✅ 生命阈值自动撤退 / 控制权复核 / abort 立刻生效 |

## 5. 性能

| 指标 | 数值 |
|---|---|
| Lua 战斗 tick 间隔 | 0.1 s（仅在战斗期间存在） |
| 每 tick 工作量 | 1 次血量读 + ≤1 次距离计算 + ≤1 次移动/攻击调用 |
| 控制权复核 | 每 2 s 一次异步 POST（不阻塞 tick） |
| 观察器兜底驱动 | 每 2 s 检查一次 tick 是否停摆，停摆才补跑 |

## 6. 已知问题（重要，别当成已解决）

1. **真机未验证**：`TryAttack` / `GoToPoint` 的战斗用法在**本机这个构建**上只做了 API 探测，
   没有真机跑过（游戏没开）。沙箱里是 stub。
2. **Kiting 参数是经验值**：`backoff/dodge` 按档案配置，没有真机调参；
   实测可能要按怪种微调（尤其猎犬群）。
3. **不做目标切换**：锁定目标后不会"打着打着换更近的"；目标死了才结算。
4. **不做走位预判**：不预测敌人下一次出手时间，只看当前 `sg` 的 `attack` 标签。
5. **多人游戏未验证**：只保证"操作第一个活着的玩家"。
6. `attack_range` 取玩家的 `combat:GetAttackRange()`（受武器影响），
   敌人攻击距离取敌人自己的 —— 两者不同源，极端情况下判断会有偏差。
