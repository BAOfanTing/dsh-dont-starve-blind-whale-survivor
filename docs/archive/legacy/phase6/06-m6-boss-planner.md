# Phase 6 · M6：Boss Planner Boss 战准备

> 结论：**完成**。12 个第一批 Boss 有档案；能识别（在场/不在场）、给准备度与战斗准备报告，
> 输出 **OBSERVE / PREPARE / AVOID / SUPERVISED_COMBAT** 四选一。
> `requires_human_confirmation` **恒为 true** —— 本阶段没有任何路径让 AI 自己开 Boss 战。

## 1. 文件修改清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `mcp-server/src/survival/profiles.ts` | 新增 | `BOSS_PROFILES`（12 条）+ `isBossPrefab()` / `bossList()` |
| `mcp-server/src/survival/boss.ts` | 新增 | `assessBossReadiness()`（识别 + 准备度 + 报告） |
| `mcp-server/src/tools/phase6Tools.ts` | 新增 | `get_boss_readiness` |
| `DontStarveWhaleSurvivor/scripts/main/threat_observer.lua` | 新增 | `BOSS_PREFABS` 标记（prefab + `epic` 标签） |
| `DontStarveWhaleSurvivor/scripts/main/combat_executor.lua` | 新增 | Boss 硬拦（不允许自动交战） |
| `mcp-server/test/p6.test.ts` | 新增 | 3 个 Boss 用例 |
| `tests/phase6-lua.test.mjs` | 新增 | Boss 名单一致性用例 |

## 2. 实现原理

### 2.1 第一批 Boss 档案（12 条）

| prefab | 名字 | 生命 | 伤害 | 关键特殊能力 | 默认建议 |
|---|---|---|---|---|---|
| `deerclops` | 独眼巨鹿 | 2000 | 150 | 冰冻/砸地、拆建筑 | AVOID |
| `bearger` | 熊獾 | 3000 | 200 | 横扫、吃地上食物 | AVOID |
| `moose` | 鹿角鹅（Moose/Goose） | 3000 | 150 | 下蛋、小鹅群攻 | AVOID |
| `antlion` | 蚁狮 | 1000 | 100 | 沙尘暴、地震塌陷 | AVOID |
| `beequeen` | 蜂后 | 22500 | 120 | 召唤蜂群 | AVOID |
| `dragonfly` | 龙蝇 | 27500 | 150 | 火焰 AOE、熔岩池 | AVOID |
| `klaus` | 克劳斯 | 10000 | 150 | 召唤鹿、冰火阶段 | AVOID |
| `malbatross` | 邪天翁 | 5000 | 100 | 海上追击 | AVOID |
| `toadstool` | 毒菌蟾蜍 | 20000 | 100 | 孢子云 | AVOID |
| `spiderqueen` | 蜘蛛女王 | 1250 | 80 | 持续召唤 | AVOID |
| `stalker` | 远古守护者 | 4000 | 100 | 冲锋撞击 | AVOID |
| `crabking` | 蟹王 | 8000 | 80 | 海域、召唤螃蟹 | AVOID |

每条还有 `spawn_hint`（"什么时候要小心"，**不写死日期**）与 `required_prep`（开打前置）。

### 2.2 准备度检查（与 `required_prep` 对齐）

| 检查 | 是否必需 | 判定 |
|---|---|---|
| 护甲 | ✅ 必需 | 最高减伤 ≥70% |
| 武器 | ✅ 必需 | 伤害 ≥34 |
| 治疗物品 | ✅ 必需 | 合计 ≥30 点 |
| 撤离路线 | ✅ 必需 | 能算出"背离威胁的方向" |
| 食物 | ⬜ 建议 | ≥2 份 |
| 光源 | 夜间必需 | `in_light != false` |

`readiness_score = 通过的必需项 / 必需项总数`，`ready = 必需项全过`。

### 2.3 四选一判定

```
没检测到 Boss                 → OBSERVE
检测到但没 ready：
    正在追我 或 ≤12 格        → AVOID
    否则                      → PREPARE
ready 但生命 <50%             → AVOID（先回血）
ready 且生命 ≥50%             → SUPERVISED_COMBAT（仍需人工确认）
```

### 2.4 "识别 ≠ 在场"

`get_boss_readiness(target_prefab='dragonfly')` 可以在**龙蝇根本不在附近**时
按档案给评估（`boss_detected=false` + `recommendation=OBSERVE`），
用来"提前准备"。这一点在实现上分了两个概念：
`boss_detected`（视野内真的有）与 `boss`（档案对象，可能是查来的）。

未知 prefab（例如 `ancient_horror`）→ 直接 `AVOID` + 明确说"没有档案"。

## 3. 关键代码

```ts
if (!detected) recommendation = 'OBSERVE'
else if (!ready) recommendation = chasing || close ? 'AVOID' : 'PREPARE'
else if (hp < 50) recommendation = 'AVOID'
else recommendation = 'SUPERVISED_COMBAT'
```

输出示例（`report` 数组，AI 直接念给人听）：

```
Boss：独眼巨鹿（Deerclops）（prefab=deerclops）
状态：在 8 格内，血量 100%，正在追玩家
特殊能力：大面积冰冻/砸地；会拆建筑；攻击间隔长（可以多次风筝）
出现时机：冬季后期（游戏内 first winter 附近）会循声而来
准备度 60/100，缺口：护甲（≥1 套，减伤 ≥70%）、治疗物品（合计 ≥30 点）
  ✓ 武器（伤害 ≥34） —— 手持 spear，约 34 伤害
  ✗ 护甲（≥1 套，减伤 ≥70%） —— 身上没有任何护甲
  ...
结论：AVOID
```

## 4. 实际测试

```
✔ P6-M6：没 Boss → OBSERVE；发现了但不ready → AVOID/PREPARE；ready → SUPERVISED_COMBAT
✔ P6-M6：指定一个不在附近的 Boss → 仍能出档案评估（识别不等于在场）
✔ P6-M6：未知 prefab 的"Boss" → 一律 AVOID
✔ P6：Lua 与 TS 的 Boss 名单一致
```

## 5. 预期结果（对照验收）

| 验收项 | 结果 |
|---|---|
| ⑨ 能够识别指定 Boss | ✅ 12 个第一批 Boss（prefab + 中文名 + 血量 + 位置 + 追击状态） |
| ⑩ 能够输出 Boss 战准备建议 | ✅ 逐项 checklist + 缺口 + 四选一结论 + 完整报告 |
| 权限：Boss 战必须人工确认 | ✅ `requires_human_confirmation` 恒 true；`start_combat` 对 Boss prefab 直接拒绝 |

## 6. 性能

`assessBossReadiness`（含一次准备度 + 一次规避规划）**6.1 µs**。

## 7. 已知问题

1. **不做任何 Boss 自动击杀**（设计如此）：本阶段只识别、避战、准备、建议。
2. **血量档案值可能过时**：`hp` 是社区数据；真机上以 `threats[].hp`（百分比）为准。
3. **没有 Boss 行为阶段识别**：不区分"克劳斯冰阶段/火阶段"、"龙蝇熔岩阶段"这类状态，
   只在档案里文字描述。
4. **`moose` 的 prefab 命名**：DST 里 Moose/Goose 的 prefab 是 `moose`（指那只鹅），
   档案里名字写成 "鹿角鹅（Moose/Goose）" 以免混淆；如果真机发现实际 prefab 不同，
   需要按实测改名（`get_boss_readiness` 对未知 prefab 会明确说没有档案）。
