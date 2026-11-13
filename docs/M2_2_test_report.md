# M2.2 · 测试报告

> 版本：**0.16.0**
> 全量：**444 / 444 通过**（M2.1 基线 418 + 本轮新增 **26**）
> Lua → Node 管线自检：32 / 32
> 证据类型：`UNIT`（fengari 假游戏 + 真实 `nearby.lua`/`pickuprules.lua`；Node 侧用真实 `snapshot.js`）、
> `STATIC`（本机 `scripts.zip` 源码审查）、`RUNTIME`（真机，见 §5）

---

## 1. 测试数量

| 阶段 | tests | pass | fail |
|---|---|---|---|
| M2.1 基线 | 418 | 418 | 0 |
| + M2.2（26 个新用例） | **444** | **444** | 0 |

新增文件：`tests/m2_2-actionable-nearby.test.mjs`（26 例）。

**既有测试没有被删除或跳过。** 有 7 个既有文件被改动，改动只有两类：
1. 6 个 Lua harness 的模块加载列表补上 `pickuprules`（跟随 `modmain` 的真实加载顺序）；
2. `lua-mod.test.mjs` 的"只该 modimport N 个模块"断言 12 → **13**，并新增 3 条顺序断言
   （`util < pickuprules < nearby`、`util < pickuprules < guard`）。

---

## 2. 逐项覆盖（对照任务书第十二节的 20 条）

| # | 要求 | 用例 | 结果 |
|---|---|---|---|
| 1 | 新增 pickupables 桶 | M2.2-01 | ✅ |
| 2 | pickupables 结构正确 | M2.2-02 | ✅ |
| 3 | 白名单物品进入 pickupables | M2.2-02 | ✅ |
| 4 | flint 不进入 food | M2.2-04 | ✅ |
| 5 | 普通食物仍正确分类 | M2.2-05 / M2.2-06 | ✅ |
| 6 | 不可拾取资源不进入 pickupables | M2.2-07 / M2.2-09 | ✅ |
| 7 | 不允许重复跨桶出现 | M2.2-03 | ✅ |
| 8 | pickupables 排序 | M2.2-11 | ✅ |
| 9 | pickupables 单桶上限 | M2.2-13 | ✅ |
| 10 | 全局总量上限 | M2.2-14 / M2.2-15 | ✅ |
| 11 | 截断情况正确 | M2.2-13 / M2.2-20 | ✅ |
| 12 | 引用唯一 | M2.2-16 | ✅ |
| 13 | 同快照 ref 稳定 | M2.2-17 | ✅ |
| 14 | reused 不重编号 | M2.2-17 | ✅ |
| 15 | 新扫描正确更新引用 | M2.2-17 | ✅ |
| 16 | Delta 跨桶分类变化 | M2.2-18 | ✅ |
| 17 | 完整扫描基线不回退 | M2.2-19 / M2.2-20 | ✅ |
| 18 | not_returned 正确 | M2.2-20 | ✅ |
| 19 | Node 新结构 fallback | M2.2-23 / M2.2-24 / M2.2-25 / M2.2-26 | ✅ |
| 20 | Lua → Node 管线兼容 | `tools/m12-roundtrip.mjs` 32/32 | ✅ |

---

## 3. 关键用例详情

### 3.1 优先级：可拾取物不再被植物挤掉（M2.2-12）——本阶段的核心修复

```text
场景：12 个草（0.5~11 格）+ 1 个燧石（8 格外的近处）
期望：燧石必须进 pickupables 并拿到 #N；草照常按单桶上限返回
结果：pickupables = [#1 flint]；resources = 12 个草；truncated = false   ✅
```

对照修复前（真机 0.15.1 实测）：`resources = 12/12 全植物`，`not_returned = 83`，燧石拿不到 `#N`。

### 3.2 候选判定不含距离限制（M2.2-08）

8 格（32 世界单位）外的燧石仍进 `pickupables`，`distance = 8` ⇒
AI 可以"先看见 → `move_to` 靠近 → 再 `pickup`"。执行侧仍严格限 2.5 格。

### 3.3 flint 修复（M2.2-04 / M2.2-06）

| 输入 | food 桶 | pickupables | 说明 |
|---|---|---|---|
| `flint` + `edible/ELEMENTAL` | **0** | 1 | ✅ 修复点 |
| `log` + `edible/WOOD` | 0 | 0 | 落 `resources` |
| `seeds` + `edible/SEEDS` | 0 | 0 | 落 `resources` |
| `gears` + `edible/GEARS` | 0 | 0 | 落 `resources` |
| `nitre` + `edible/NITRE` | 0 | 0 | 落 `resources` |
| `twigs` + `edible/ROUGHAGE` | 0 | 1 | 白名单物品 |

### 3.4 真食物不回归（M2.2-05）

落地 `berries`(VEGGIE)、`berrybush`(可采)、`carrot_planted`(可采) 全部照常进 `food`。

### 3.5 观察-执行一致（M2.2-21 / M2.2-22）

- `Whale.guard.PICKUP_PREFABS == Whale.pickuprules.PREFABS` → `true`（**同一张表**，不是复制）；
- 白名单仍是 `cutgrass,flint,twigs`；执行距离上限仍在执行侧（2.5）；
- `IsCandidate` 的四种返回与执行侧同名：
  `prefab_not_allowed` / `true,nil` / `target_not_pickable` / `in_limbo`。

### 3.6 引用与 Delta（M2.2-16 ~ M2.2-20）

- ref 连续 `#1..#N`、全局唯一、跨八桶不重复；
- `reused` 复用同一 `snapshot_id` 且不重编号；新扫描后旧 `snapshot_id` 的 `#1` 解析为 `nil|stale_snapshot`；
- 跨桶（`resources → pickupables`）只报 `changed.category = {from,to}`，`added_count = removed_count = 0`；
- 15 个树枝只返回 12 个时：`removed_count = 0`（截断 ≠ 消失）、`not_returned_count = 3` 且这 3 条**没有 ref**。

### 3.7 Node 兼容（M2.2-23 ~ M2.2-26）

| 场景 | 结果 |
|---|---|
| 八桶快照渲染 | 出现"可拾取物："，`#1 燧石`、`#2 树枝`、`×3` 都在 |
| 旧七桶快照 | 照常渲染"资源：#1 燧石"，且**不会凭空出现**"可拾取物：" |
| 未知桶名 | 透传渲染（`mystery_bucket：#1 神秘`） |
| 桶顺序 | 威胁 → 可拾取物 → 食物 → 资源（位置单调递增） |

---

## 4. 性能（单次扫描口径）

| 指标 | 说明 |
|---|---|
| `FindEntities` 次数 | **1 次/扫描**（未新增第二次完整扫描） |
| 新增每实体开销 | 一次 `IsCandidate`（≤6 个只读检查，`pcall` 包裹） |
| JSON 体积增量 | 每个可拾取物约 +20~30 字节（`item_kind` 字段） |
| `total_found` / `total_returned` / `truncated` | 口径不变（M1.4 语义） |
| `scan.duration_ms` | 由 `os.clock`/`GetRealTime` 测量，真机样本见 §5 |

> 真机 `duration_ms` 会在 §5 用真实样本补充；若真机未跑，此处置 **NOT_RUN**，不用假数据填充。

---

## 5. 真机（RUNTIME）

**状态：PENDING —— 需要重进世界加载 0.16.0 后才能取样本。**

已确认（不是 Mock）：

| 项 | 结果 |
|---|---|
| 0.16.0 已装盘，`pickuprules.lua` 已就位 | ✅ |
| 源码与已装版本一致（`modinfo` = 0.16.0） | ✅ |
| 体验时世界内存版本 | **0.15.1**（还没有 `pickupables` 桶，实测确认 `桶: other, creatures, food, ...`） |
| 工具白名单未变 | ✅ `move_to, stop, pickup`；工具数 36 |
| 管线自检 | ✅ 32/32 |

**重进世界后要跑**（脚本已就绪：`node tools/m2_2_verify_nearby.mjs`）：

1. 地面燧石/树枝是否进 `pickupables`（应能拿到 `#N`）；
2. flint 是否不再出现在 `food`；
3. 12 个草的场景下燧石是否仍能拿到 `#N`；
4. 用当前 `pickup` 工具是否仍能成功拾取（回归）；
5. Delta 是否没有误报（跨桶只报 category changed）；
6. `scan.duration_ms` / JSON 字节数 / `not_returned_count` 实测值。

**没有用 Fengari 或 Mock 冒充真机通过。**
