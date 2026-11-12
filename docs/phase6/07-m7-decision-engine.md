# Phase 6 · M7：Survival Decision Engine + MCP 工具 + 全量测试

> 结论：**完成**。全局仲裁器 P0~P5 + 16 个新 MCP 工具（总数 27 → 43）+
> 程序层工具门禁。**硬性安全规则不在提示词里**，在 `isToolAllowed()` 里。

## 1. 文件修改清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `mcp-server/src/survival/decision.ts` | 新增 | `arbitrate()` + `isToolAllowed()` + 工具分组 |
| `mcp-server/src/tools/phase6Tools.ts` | 新增 | 16 个工具（10 只读 + 6 写） |
| `mcp-server/src/tools/definitions.ts` | 修改 | 注册 Phase 6 工具 |
| `mcp-server/src/bridge/client.ts` | 未改（复用） | `readSnapshot` / `controlStatus` / `enqueueCommand` / `runCommand` |
| `agent/src/mcp/toolAdapter.ts` | 修改 | 只读 25 / 写 18 白名单 |
| `mcp-server/test/p6.test.ts` | 新增 | 仲裁 + 工具门禁 + 工具清单用例 |
| `tools/bench-phase6.mjs` | 新增 | 决策链路性能测量 |

## 2. 实现原理

### 2.1 优先级阶梯（P0 最高）

| 优先级 | 触发条件（按顺序判） | 建议动作 | 允许的写动作 |
|---|---|---|---|
| **P0** 紧急生存 | 死亡/幽灵 | `STOP_ALL` | 无 |
| | 生命 ≤25% | `HEAL` | 治疗/进食/撤退/中止 |
| | 夜间且不在光照内 | `LIGHT` | 做火把/建火/撤离 |
| | 体温 ≤0℃ 或 ≥65℃ | `WARM_OR_COOL` | 保暖/降温/建火 |
| | 被 1+ 敌人贴身追击（≤3 格） | `RETREAT` | 撤退/躲避/中止 |
| | 饥饿 ≤15% | `EAT` | 进食 |
| **P1** 立即避险 | 威胁 `critical` 或 Boss ≤12 格 | `RETREAT`/`EVADE` | 撤退/躲避/中止 |
| | 威胁 `high` | `EVADE` | 撤退/躲避/少量制作 |
| **P2** 需求 | 饥饿 ≤30% / 理智 ≤20% / 潮湿 ≥50% / 体温 ≤8℃ | `EAT` / `WARM_OR_COOL` | 吃喝/制作/采集 |
| **P3** 季节准备 | 季节准备度缺关键项 | `PREPARE_SEASON` | 制作/采集/建造/治疗 + **防御动作** |
| **P4** 普通发展 | 威胁 medium | `DEVELOP` | 全部 + `start_combat`（仍需人工确认） |
| **P5** 探索/Boss | 其余 | `EXPLORE`/`DEVELOP` | 全部 |

三条硬规则（写死在代码里，不可配置）：

1. **P0 一律禁止采集/砍矿/探索/开新战线**（只有治疗、进食、点灯、保暖、撤离、中止可做）。
2. **`stop_task` 在所有优先级都允许** —— 紧急时连"停手"都不让做是荒谬的。
3. **撤退/躲避/中止（`retreat_from_combat` / `evade_threat` / `abort_combat`）
   在 P1~P3 也不受限**：季节没准备好不代表不能跑。

### 2.2 工具门禁（不在提示词里）

```ts
export function isToolAllowed(decision, tool): { allowed: boolean; reason: string } {
  // 只读工具永远允许（不看优先级）
  // 写动作工具：查 blocked_write_tools，命中就拒绝并说明"当前 P? 不允许 X：原因"
}
```

所有 Phase 6 的写工具在下发前都过这一关（`requirePriorityAllows()`）；
**顺序是：控制权 → 优先级 → 业务判断**。
为什么这个顺序：紧急停止/人工接管的拒绝优先级高于任何业务理由。

### 2.3 16 个 MCP 工具

**只读（10）**

| 工具 | 关键参数 | 返回 |
|---|---|---|
| `get_threat_assessment` | `include_factors` / `include_targets` | 评分 + 因素明细 + 敌人档案 |
| `get_combat_readiness` | — | ready/score/blockers/逐项明细/区域/撤退 |
| `get_combat_status` | — | Node 状态机 + Lua 执行器真实状态 + API 探测 |
| `get_combat_recommendation` | `target_prefab?` | ENGAGE/PREPARE/EVADE/RETREAT + 理由 + 阈值 |
| `evaluate_combat_target` | `target_prefab`（必需） | 单目标能不能打 + 白名单 + 档案 |
| `get_escape_options` | `camp_x/z` / `flee_distance_tiles` | 排序后的选项 + 方向 + 是否中断任务 |
| `get_seasonal_readiness` | — | 四季检查 + 计划 + 可信度 |
| `get_environment_hazards` | — | 黑暗/冷/热/潮湿/火/雷雨/理智 + 最严重项 |
| `get_boss_readiness` | `target_prefab?` | Boss 识别 + 准备报告 + 四选一 |
| `get_survival_priority` | — | P0~P5 + 允许/禁止的工具 + 硬规则 |

**写（6）**

| 工具 | 人工确认 | 前置 | 说明 |
|---|---|---|---|
| `start_combat` | **必须** `confirmed=true` | 控制权 + 决策 ENGAGE + 目标在白名单 | SUPERVISED_COMBAT |
| `retreat_from_combat` | 不需要 | 控制权 | 主动撤离（明确授权后可自动） |
| `evade_threat` | 不需要 | 控制权 | 不接战拉开距离 |
| `abort_combat` | 不需要 | 无（无控制权也先清 Node 状态） | 立刻停手 |
| `prepare_for_season` | **必须**（`execute=true` 时） | 控制权 | 计划 + 启动季节任务链 |
| `recover_after_combat` | **必须** | 控制权 | 治疗（`heal_self`）→ 进食 → 装备 |

**参数 Schema**：全部 Zod（`enum` / `min` / `max` / `default`），
`target_prefab` 用 `z.enum(autoEngageList())` —— 模型连"传个不在白名单的怪"都做不到。

### 2.4 错误语义（不编数据）

| 情况 | 返回 |
|---|---|
| 没有快照 | `GAME_DISCONNECTED` |
| 数据过期 | 照常返回 + `freshness.stale` 标记（不抛错） |
| 没有威胁数据 | `get_threat_assessment` 返回 `data_ok=false`，**不猜** |
| 没有附近数据 | `NOT_IMPLEMENTED`（阶段 3 的既有语义） |
| 缺参数/没确认/没控制权 | `INVALID_ARGUMENT` / `SESSION_INVALID` |

## 3. 实际测试

```
✔ P6-M7：P0 濒死 → 只允许治疗/撤离，采集与探索被禁止
✔ P6-M7：黑夜无光 → P0 LIGHT；状态良好 → P5 全开
✔ P6：MCP 注册了 16 个 Phase 6 工具，总数 43，名字不重复
✔ P6：威胁/准备/建议等只读工具能真的跑通并给出结构化输出
✔ P6：写工具的程序层门禁 —— 没确认 / 没控制权一律拒绝
✔ P6：start_combat 走通全流程（确认 + 决策 ENGAGE + 控制权）→ 真的下发命令
```

调试中修掉的两个真实问题：

1. **P3（季节准备）把 `evade_threat` 也禁了** —— 测试里"紧急停止中调 evade"返回的是
   `P3 不允许 evade_threat`，而不是"紧急停止"。这说明两件事：
   ① 防御性动作不该被季节准备挡住（已把撤退/躲避/中止加进 P3 白名单）；
   ② 写工具的检查顺序要"控制权优先"（已改成 `requireControl` → `requirePriorityAllows`）。
2. **P4（中等威胁）把 `start_combat` 也禁了** —— 那会让"打一只猎犬"永远做不到。
   已改为：P4 允许 `start_combat`（人工确认仍由工具自身强制），
   P3 才禁止"开新战线"。

## 4. 全量测试与性能

### 4.1 测试

| 套件 | 用例 | 结果 |
|---|---|---|
| Lua / DSH 插件 | 209 | 全过 |
| MCP Server（含 30 个 Phase 6 用例） | 126 | 全过 |
| Game Bridge | 56 | 全过 |
| Agent | 120 | 全过 |
| Survival Controller | 48 | 全过 |
| **合计** | **559** | **全过** |

### 4.2 性能（`node tools/bench-phase6.mjs`，真机日志原文）

```
buildContext（快照→上下文）               1000 次 5.5ms → 单次 5.5µs
assessThreat（威胁评分）                 1000 次 7.0ms → 单次 7.0µs
assessReadiness（准备度）               1000 次 6.2ms → 单次 6.2µs
decideCombat（四选一决策）                1000 次 10.8ms → 单次 10.8µs
planEscape（规避选项）                  1000 次 2.7ms → 单次 2.7µs
assessSeason（季节准备）                 1000 次 3.4ms → 单次 3.4µs
assessBossReadiness（Boss）          1000 次 6.1ms → 单次 6.1µs
arbitrate（全局仲裁）                    500 次 9.4ms → 单次 18.8µs
完整一轮（威胁+准备+规避+季节+仲裁）               500 次 6.7ms → 单次 13.4µs

结论：一轮完整决策约 0.01 ms（Node 侧，不含 Bridge 往返与模型推理）
```

**结论**：决策层完全不是瓶颈（一轮 0.013 ms）。真正的延迟在 Bridge 往返（几十 ms）
与模型推理（秒级）。Lua 侧战斗 tick 只在战斗期间存在，是 0.1 秒一次。

## 5. 预期结果（对照验收 12 项）

| # | 验收要求 | 结果 |
|---|---|---|
| 1 | 正确识别已配置的敌对生物 | ✅ 15 个档案 + 白名单 |
| 2 | 区分普通敌人和高危险敌人 | ✅ 等级 1~5 / 总分等级 / 硬规则 |
| 3 | 评估当前战斗准备度 | ✅ 12 项检查 + 阻断项 |
| 4 | 主动撤退 | ✅ `retreat_from_combat` / `evade_threat`（真机待验） |
| 5 | 中断低优先级任务 | ✅ 仲裁 + Lua `interrupt_low_priority()` |
| 6 | 完成选定普通敌人的人工监督战斗 | ⏳ 沙箱通过，真机待执行 |
| 7 | 监控装备和生命变化 | ✅ Lua 每秒复核 + verify 差值 |
| 8 | 根据四季生成准备计划 | ✅ 四季检查 + 计划 + 任务链 |
| 9 | 识别指定 Boss | ✅ 12 个第一批 Boss |
| 10 | 输出 Boss 战准备建议 | ✅ 准备报告 + 四选一 |
| 11 | 严重危险时停止普通活动 | ✅ P0/P1 门禁 + 战斗期 2s 控制权复核 |
| 12 | 不因无效数据/幻觉进入高风险战斗 | ✅ `data_ok=false` → RETREAT；白名单 + Boss 硬拦 + 确认 |

## 6. 已知问题

1. **真机未验证**（游戏没开）：只有沙箱 + 逻辑验证。见 08。
2. **仲裁只看"当下"**：没有时间维度（不会说"再等 3 秒火就灭了"）。
3. **`get_combat_status` 依赖一条只读命令**：Bridge 或游戏暂停时会拿不到 Lua 侧状态，
   只返回 Node 侧视图（输出里 `lua_available=false` 明确标注）。
4. **`recover_after_combat` 只做三步**（治疗 → 进食 → 提示穿甲），
   不会自动挑护甲穿（`equip_item` 需要明确物品名）。
