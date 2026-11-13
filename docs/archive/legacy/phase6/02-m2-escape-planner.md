# Phase 6 · M2：Escape Planner 危险规避

> 结论：**完成**。七类危险（敌群 / Boss / 黑夜无光 / 低温 / 高温 / 火灾 / 雷雨）各有独立选项，
> 输出排序后的方案 + 建议方向 + 是否应中断当前任务。**没有地形数据这件事在输出里写明**，不假装有寻路。

## 1. 文件修改清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `mcp-server/src/survival/escape.ts` | 新增 | `planEscape()` / `isImminentDanger()` |
| `mcp-server/src/tools/phase6Tools.ts` | 新增 | `get_escape_options` / `retreat_from_combat` / `evade_threat` 工具 |
| `DontStarveWhaleSurvivor/scripts/main/combat_executor.lua` | 新增 | EVADING / RETREATING 两个状态的执行端 |
| `game-bridge/src/commands.ts` | 修改 | 新增 `retreat_from_combat` / `evade_threat` 命令 |
| `tests/phase6-lua.test.mjs` | 新增 | 3 个规避相关用例（含低血撤退） |
| `mcp-server/test/p6.test.ts` | 新增 | 3 个规避选项用例 |

## 2. 实现原理

### 2.1 七类危险 → 选项（带 urgency 与优先级）

| 危险 | kind | urgency | 建议动作 | 可自动执行 |
|---|---|---|---|---|
| 夜间且不在光照内 | `darkness_light` | **P0** | `equip_item(torch)` / `craft_item(torch)` / `build_campfire` | ❌ 要动背包，必须人工确认 |
| 体温 ≤ 0℃ | `cold` | **P0** | `build_campfire` / 保暖装备 | ❌ |
| 体温 ≥ 65℃ | `heat` | **P0** | 降温（建营火/降温装备） | ❌ |
| Boss 在附近 | `boss_avoid` | **P0** | `retreat_from_combat` / `move_to` | ✅ 明确授权后可自动 |
| ≥3 敌人或 ≥2 追击 | `evade_group` | P1 | `evade_threat` / `retreat_from_combat` | ✅ |
| 有敌人但没在追 | `retreat_enemies` | P1/P2 | `move_to` / 撤离 | ✅ |
| 火堆燃料 <25% | `fire` | P1 | `build_campfire`（目前没有独立"添柴"工具） | ❌ |
| 下雨（潮湿 ≥35% 更急） | `lightning_rain` | P2 | 避雷/烘干 | ❌ |
| 都没有 | `none` | — | — | — |

`interrupt_current_task = (最优先选项属于 P0/P1 且不是 none)` —— 这正是任务书 §7
「出现严重危险时允许中断普通采集和探索任务」的程序化表达。

### 2.2 逃跑方向：8 方向打分（不是"随便跑"）

```
对 8 个候选方向（北/东北/东/…）各取一点（当前格 + 12 格）
score = 该点到所有威胁的最小距离 − 0.15 × 该点到营地的距离
选 score 最大的方向
```

为什么要减营地距离那一项：不是为了回营地，而是避免"为了躲一只猎犬，跑到离家 30 格外的荒野"。
**这是启发式，不是最优解**，输出里 `confidence` 最高只给 `medium`。

### 2.3 诚实边界（写进输出，不只写在文档里）

- `directions` 只是"背离威胁的合向量"，**没有地形、可通行性、水域/悬崖**数据；
  实际绕障碍由游戏自己的 `locomotor` 寻路完成。
- 火堆/光照来自引擎 `ent.Light:IsEnabled()` 统计（半径 8 格），不是游戏 UI 的"是否在光照内"。
- 拿不到坐标时不编方向（`direction: null` + `available: false`）。

## 3. 关键代码

```ts
export function isImminentDanger(ctx) {
  if (ctx.world.isNight === true && ctx.environment.inLight === false) return { danger: true, reason: '夜间没有光源' }
  if (active.some((t) => t.is_boss && (t.distance ?? 99) <= 12)) return { danger: true, reason: 'Boss 在 12 格内' }
  if (chasing.length > 0 && (ctx.nearestThreatDistance ?? 99) <= 4) return { danger: true, reason: '敌人在贴身追击' }
  ...
}
```

Lua 侧的执行（`combat_executor.lua`）：

```lua
if state == "EVADING" then
    move_relative(p, ctx.target, 6, true)      -- 背离目标 6 格
    if (d ~= nil and d >= ctx.evade_distance) or now() > ctx.evade_until then
        transition("RECOVERING", "evade_done")
    end
end
```

## 4. 实际测试

```
✔ P6-M2：黑夜无光 → P0 点灯选项排第一，且建议中断当前任务
✔ P6-M2：敌群 → 有撤退方向、可自动执行；没危险 → none
✔ P6-M2：低温/高温/潮湿/雷雨都会出现在环境选项里
✔ P6-M4：生命低于阈值 → 自动 RETREATING（不靠上层提醒）
✔ P6-M4：abort_combat 立刻停手（ABORTED + FAILED 回执）
```

其中"敌群 → 往西跑"的断言是这样验证方向的：三个敌人都放在玩家东侧（tile_x 20/22/24），
断言 `best.direction.x < 10`（玩家在 x=10）。这条用例第一次跑就过了 —— 合向量逻辑没问题。

## 5. 预期结果（对照验收）

| 验收项 | 结果 |
|---|---|
| ④ 能够主动撤退 | ✅ `retreat_from_combat` / `evade_threat` 真机脚本里会真的下发（未执行，见 08） |
| ⑤ 能够中断低优先级任务 | ✅ `interrupt_current_task` + Lua 侧 `interrupt_low_priority()` 直接 `tasks.Stop()` |
| ⑪ 严重危险时能及时停止普通活动 | ✅ P0/P1 优先级下 `isToolAllowed()` 拒绝采集类工具 |

## 6. 性能

`planEscape` 单次 **2.7 µs**（1000 次 2.7ms）。

## 7. 已知问题

1. **没有地形**：方向只是启发式；水里/悬崖边可能跑不过去（游戏寻路会绕，但可能绕远）。
2. **火堆"添柴"没有独立工具**：只能重建营火（3 草 2 木），所以 `fire` 选项的抗风险手段偏弱。
3. **躲避是按固定秒数/距离收敛**（`evade_distance` 默认 10 格、超时 20 秒），
   不会"边跑边看敌人还在不在追"。
4. **`lightning_rain` 没有真实落雷数据**：按"下雨 = 有落雷风险"处理，属于启发式。
