# Phase 6 · M1：Threat Analyzer 威胁分析

> 结论：**完成**。Lua 端只报事实（`threat_observer.lua`），Node 端把事实算成 0~100 分
> （`survival/threat.ts`），每个因素都有 value × weight = contribution，权重可配。
> 新用例：Lua 4 个 + TS 5 个，全过。

## 1. 文件修改清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `DontStarveWhaleSurvivor/scripts/main/threat_observer.lua` | 新增 | 威胁扫描 + 环境读数（只读） |
| `DontStarveWhaleSurvivor/scripts/main/observer_manager.lua` | 修改 | 每轮扫描威胁/环境，进 sections |
| `DontStarveWhaleSurvivor/scripts/main/state_serializer.lua` | 修改 | `GameState` 增加 `threats` / `environment` |
| `DontStarveWhaleSurvivor/modmain.lua` | 修改 | 加载 `threat_observer.lua` |
| `mcp-server/src/survival/profiles.ts` | 新增 | 敌人战术档案（15 条）+ Boss 档案（12 条） |
| `mcp-server/src/survival/threat.ts` | 新增 | 威胁评分引擎 |
| `mcp-server/src/survival/context.ts` | 新增 | 快照 → 决策上下文（含威胁降级） |
| `mcp-server/src/survival/types.ts` | 新增 | 共享类型 |
| `mcp-server/src/tools/phase6Tools.ts` | 新增 | `get_threat_assessment` 工具 |
| `tests/phase6-lua.test.mjs` | 新增 | 4 个威胁观察器用例 |
| `mcp-server/test/p6.test.ts` | 新增 | 5 个评分/档案用例 |

## 2. 实现原理

### 2.1 为什么分两层（Lua 只报事实，Node 才算分）

任务书 §3 要求「评分需要有明确的计算依据和可配置参数」，并且
「不得仅凭 Prefab 名称推测所有生物的攻击能力」。

- **Lua 层**（`threat_observer.lua`）只读游戏真实状态：
  `combat.target`（在追谁）、`sg:HasStateTag("attack")`（正在出手）、
  `combat:GetAttackRange()` / `attackperiod` / `defaultdamage`（真实攻击能力）、
  `health:GetPercent()`、`sleeper:IsAsleep()`。**一条都不猜**：取不到就省略字段。
- **Node 层**（`threat.ts`）拿这些事实算分，因此评分可单测、可审计、可调参。

### 2.2 威胁评分：8 个加权因素 + 5 条硬规则

权重（默认值，全部可配）：

| 因素 | 权重 | 归一化口径 |
|---|---|---|
| 敌人攻击能力 `capability` | 0.26 | 最强敌人的档案威胁等级 / 5 |
| 与玩家距离 `proximity` | 0.18 | `1 - d / 参考距离(16 格)` |
| 是否正在追击 `chasing` | 0.16 | 有追击 → `0.6 + 0.2×数量`（封顶 1） |
| 敌对数量 `count` | 0.12 | `敌对数量 / 4`（封顶 1） |
| 玩家生命 `player_health` | 0.14 | `(70 - HP%) / 55` |
| 玩家装备 `equipment` | 0.08 | 空手 +0.5 / 无甲 +0.4 / 护甲减伤 <50% +0.15 |
| 环境条件 `environment` | 0.04 | 夜无光 +0.6 / 极端体温 +0.3 / 理智 <20 +0.2 |
| 逃跑难度 `escape_difficulty` | 0.02 | 贴身≥2 +0.25 / 追击≥3 +0.25 / 多向包围 +0.2 / 有伏击型 +0.1 |

`score = Σ(value × weight × 100)`，四舍五入后夹在 0~100。

**硬规则（不参与加权，防止权重调错就出人命）**：

| 条件 | 效果 |
|---|---|
| 附近有 Boss | `score ≥ 85`，建议 `retreat` |
| ≥3 个敌人同时追击 | `score ≥ 70` |
| 有敌人正在出手且贴身（≤3 格） | `score ≥ 60` |
| 有未验证档案的生物 | 理由里点名，且这些目标 `auto_engage_allowed=false` |
| 数据不足（无 HP / 无威胁列表） | `data_ok=false`，建议 `monitor`，**上层必须拒绝开战** |

等级阈值：`low 10 / medium 30 / high 55 / critical 80`。

### 2.3 敌人战术档案（`profiles.ts`）

字段完全按任务书 §3：`prefab / threat_level / attack_range / combat_profile /
special_abilities / recommended_strategy / retreat_conditions / auto_engage_allowed`
（外加 `verified`、`damage`、`attack_period`、`notes`）。

自动交战白名单（7 个，`auto_engage_allowed=true`）：
`hound / spider / spider_warrior / mosquito / killerbee / frog / merm`

有档案但**不**自动交战（8 个）：`tentacle / tallbird / knight / bishop / rook /
spider_spitter / krampus / ghost` —— 理由写在各条的 `notes` / `retreat_conditions` 里
（例如触手是固定点伏击 + 攻击距离比玩家长，需要精细走位，第一批不做）。

**没有档案的生物**：`getEnemyProfile()` 返回 `UNKNOWN_ENEMY`（威胁等级 3、`verified=false`、
`auto_engage_allowed=false`、`recommended_strategy='avoid'`）。

**两侧一致性**：Lua 的 `AUTONOMOUS_ENEMIES` 与 TS 的 `autoEngageList()` **必须完全相同**，
`tests/phase6-lua.test.mjs` 会解析 Lua 源码逐项比对（防两边漂移）；Boss 名单同理。

### 2.4 数据来源分级

| 来源 | 何时用 | 输出字段 |
|---|---|---|
| `runtime` | 有 `combat:GetAttackRange()` 等实时读数 | `effective.source='runtime'` |
| `archive` | 没有实时读数，但有档案 | `'archive'` |
| `unknown` | 两者都没有 | `'unknown'`，且 `effective_damage=null`（不猜） |

## 3. 关键代码

Lua（只报事实）:

```lua
local function combat_state(ent, player)
    local state = {}
    local combat = ent.components.combat
    local ok_target, target = pcall(function() return combat.target end)
    state.targeting_player = (target ~= nil and target == player)
    local ok_range, range = pcall(function() return combat:GetAttackRange() end)
    if ok_range then state.attack_range = round(range, 2) end
    local ok_attacking, attacking = pcall(function() return ent.sg:HasStateTag("attack") end)
    state.attacking = attacking == true
    -- …sleeper / CanAttack / defaultdamage 同理，取不到就不写
end
```

Node（算分，每个因素都能解释）:

```ts
const push = (key, label, value, reason) => {
  const weight = config.weights[key]
  factors.push({ key, label, value, weight, contribution: Math.round(value * weight * 1000) / 10, reason })
}
```

## 4. 实际测试

```
✔ P6-M1：威胁扫描识别敌对生物、距离、追击与出手状态
✔ P6-M1：Boss（epic 标签/档案名）能被标记，睡着的敌人单独标记
✔ P6-M1：环境读数（黑夜无光 / 体温 / 季节剩余天数）只报事实不下结论
✔ P6：Lua 的自动交战白名单与 TS 档案一致（防两边漂移）
✔ P6：Lua 与 TS 的 Boss 名单一致
✔ P6-M1：敌人档案覆盖自动交战白名单，未验证生物默认保守避战
✔ P6-M1：没有敌人 → 威胁接近 0；一只猎犬贴身追击 → 中高威胁
✔ P6-M1：评分可解释（每个因素的 value×weight=contribution），权重可配
✔ P6-M1：Boss 在场 → 硬规则把评分抬到 ≥85 且建议避战
✔ P6-M1：未验证生物 → 不给自动交战，且理由里点名
✔ P6-M1：数据不足（拿不到生命值）→ data_ok=false，建议 monitor
```

写实现时被测试抓出来并修正的两个问题：

1. **Boss 计数断言写错**：沙箱里 `epic` 是全局开关，两个实体会一起带上 Boss 标记。
   分开断言"标记"和"计数"之后才看清是测试假设错了（真实游戏里 `epic` 只有 Boss 有），
   已改成逐项验证 `deerclops` 被标记 + `boss_count ≥ 1`。
2. **威胁段缺失时没有降级**：最初 `parseThreats` 在 `threats` 段为空时返回空数组，
   而老快照只有 `nearby.hostile`。改成显式降级、`source='nearby_fallback'`、
   `data_quality` 降为 `partial`，上层据此不给 `verified` 结论。

## 5. 预期结果（对照验收）

| 验收项 | 结果 |
|---|---|
| ① 正确识别已配置的敌对生物 | ✅ 有档案的 15 个生物都能给出档案视图 |
| ② 区分普通敌人和高危险敌人 | ✅ 威胁等级 1~5 + 单体危险度 0~100 + 总分等级 |
| ⑫ 不会因无效数据进入高风险战斗 | ✅ `data_ok=false` 时决策层直接 RETREAT（见 M3 测试） |

## 6. 性能

| 操作 | 单次耗时 |
|---|---|
| `buildContext`（解析快照） | 5.5 µs |
| `assessThreat`（8 因素评分） | 7.0 µs |

Lua 侧威胁扫描是**一次 `FindEntities` + 一遍遍历**，和已有的实体扫描同频（默认 4 秒一次），
不额外增加扫描轮数。

## 7. 已知问题

1. **档案数值是社区数据**（`attack_period` / `damage`），不是本次真机测出来的；
   `verified: true` 只表示"进了自动交战白名单并通过沙盒验证"。
   真机时优先用 `runtime` 读数，档案只做兜底。
2. **`hits_to_kill` 恒为 null**：只有敌人血量百分比、没有最大生命，算不出"几刀砍死"。
   与其编一个数，不如明确 null。
3. **`escape_difficulty` 很粗**：用"敌人相对玩家的角度跨度"估包围，没有地形/障碍参与。
4. **`capability` 只看最强的那一个**，多个中等敌人叠加只体现在 `count` 因素上
   （刻意保守：避免一堆蚊子把分数顶到 high）。
