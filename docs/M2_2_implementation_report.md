# M2.2 · 实施报告

> 版本：0.15.2 → **0.16.0**；测试：418 → **444 / 444**
> 审查依据：`docs/M2_2_nearby_audit.md`

---

## 1. 修改文件一览

| 文件 | 类型 | 改动 |
|---|---|---|
| `DontStarveWhaleSurvivor/scripts/whale/pickuprules.lua` | **新增** | 拾取候选判定的唯一来源（白名单 + `IsCandidate`） |
| `DontStarveWhaleSurvivor/scripts/whale/nearby.lua` | 改 | 新增 `pickupables` 桶；`Classify` 拆成 `classify_base` + 候选分流；`describe`/`scan` 支持 `item_kind`；`is_real_food` 改为玩家食物白名单；error 分支空桶表补新桶 |
| `DontStarveWhaleSurvivor/scripts/whale/guard.lua` | 改 | 白名单改为引用 `PickupRules.PREFABS`（别名，同一张表）；候选判定改调 `PickupRules.IsCandidate`；**执行期校验一行未删** |
| `DontStarveWhaleSurvivor/scripts/whale/observe.lua` | 改 | 桶满时文本加"（本桶已满，可能还有没列出的）"（渲染自动跟随 `N.BUCKETS`） |
| `DontStarveWhaleSurvivor/modmain.lua` | 改 | 在 `util` 之后引入 `pickuprules.lua`；版本 → 0.16.0 |
| `DontStarveWhaleSurvivor/modinfo.lua` | 改 | 版本 → 0.16.0 |
| `lib/state/snapshot.js` | 改 | `BUCKET_LABELS` 插入 `pickupables`；文本补 `×N` 堆叠显示 |
| `tests/m2_2-actionable-nearby.test.mjs` | **新增** | 26 个用例 |
| `tests/m1_4-nearby.test.mjs` 等 6 个既有测试 | 改 | harness 加载顺序补 `pickuprules`；`lua-mod.test.mjs` 的 modimport 数量断言 12 → 13 并加顺序断言 |

**没有改**：`actions.lua`（执行器）、`bridge.lua`、`control.js`、`dispatcher.js`、`tools.js`、
`N.Resolve`、Delta、`m12-watch.mjs`、归档 A 栈、用户存档、API Key / 模型配置。

---

## 2. 每处改动的原因

### 2.1 为什么要新模块而不是把规则写两遍

`modmain.lua` 的加载顺序是 `util → config → actor → nearby → guard`，
`nearby` 在 `guard` **之前** ⇒ nearby 无法在加载期引用 guard。
如果把候选规则放在 guard 里、nearby 里再抄一份，就会出现审计报告 §4 说的
"Observer 说 #1 可拾取，pickup 却回 `prefab_not_allowed`"。
所以抽成独立模块，放在 `util` 之后、两边之前。

### 2.2 为什么 `Classify` 要拆成两个函数

原 `N.Classify` 是一个大 if 链。改造后需要"先算原本类别（作为 `item_kind`），再决定是否改判成 pickupables"。
把原函数整体改名为 `classify_base`（逻辑一行没动），再加一层薄薄的 `N.Classify`，
这样**原七类规则零改动**（回归风险最小），也天然保证"一个实体只返回一个桶"。

### 2.3 为什么食物判定改成白名单

审计报告 §5/§6：`flint` 带 `edible` + `ELEMENTAL`，旧逻辑只排除 3 种类型。
改成白名单后方向变成"不确定就不是食物"（fail-safe），并且有本机证据：
`edible` 组件默认 `GENERIC`（`edible.lua:24`），9 个没显式写 `foodtype` 的 prefab 全是真食物。

### 2.4 为什么 Node 文本要显示 `×N`

Lua 侧文本一直显示堆叠数，Node 的 fallback 文本没有 ⇒ 两条渲染路径不一致。
拾取物尤其需要"这里有 3 个树枝"这种信息。改动只有一行，风险极低。

---

## 3. 新增字段

| 字段 | 位置 | 说明 |
|---|---|---|
| `buckets.pickupables` | nearby | 新桶（对象结构里始终存在，空则 `[]`） |
| `item_kind` | 仅 `pickupables` 条目 | 原本的语义桶名（`resources`/`food`/…） |

其余字段（`ref`/`prefab`/`category`/`label`/`distance`/`position`/`stack_size`/`work_action`…）
**全部保持原名原义**，没有重命名、没有删除。

---

## 4. 新增配置

**没有新增任何配置项。**
`pickupables` 复用 `OBSERVER_NEARBY_MAX_PER_BUCKET`（默认 12），总量仍是 `OBSERVER_NEARBY_MAX_TOTAL`（60）。
不新增配置的好处：不引入"非数字/越界/兼容"这一整类问题，也不破坏现有 config 校验。

---

## 5. 分类错误修复对照

| prefab | 修复前 | 修复后 | 依据 |
|---|---|---|---|
| `flint` | `food` ❌ | `pickupables`（`item_kind=resources`） | ELEMENTAL 不是玩家食物 |
| `inv_rocks`（石头） | `food` ❌ | `resources` | NITRE/ELEMENTAL 同理（不在白名单，故不是候选） |
| `berries`（落地） | `food` ✅ | `food` ✅ | VEGGIE 在白名单里 |
| `butter` / `goatmilk` / `royal_jelly` | `food` ✅ | `food` ✅ | 组件默认 `GENERIC`，在白名单里 |
| `twigs` / `cutgrass` | `resources` | **`pickupables`** | 白名单 + 可拾取 |
| `log` / `seeds` / `gears` / `nitre` | `resources` | `resources`（仍不是 food） | WOOD/SEEDS/GEARS/NITRE 不在白名单 |

---

## 6. 观察与执行规则的一致性

| 面 | 观察侧 | 执行侧 | 是否共享 |
|---|---|---|---|
| Prefab 白名单 | `PickupRules.PREFABS` | **同一张表**（`G.PICKUP_PREFABS` 是别名） | ✅ 同一对象 |
| 组件/地面状态判定 | `PickupRules.IsCandidate` | **同一函数** | ✅ |
| 拒绝原因文案 | `prefab_not_allowed` / `target_not_pickable` / `in_limbo` | 同名 | ✅ |
| 距离 ≤ 2.5 格 | ❌ 不判（故意的） | ✅ `guard` 判 | 执行期专属 |
| 背包容量 | ❌ 不判 | ✅ `CanAcceptCount` | 执行期专属 |
| 角色状态 | ❌ 不判 | ✅ | 执行期专属 |
| Control Lease | ❌ 不判 | ✅ | 执行期专属 |

Pickup 执行器（`actions.lua` 的 `pickup_by_ref`）**一行未改**，真机闭环能力不受影响。

---

## 7. 性能变化

- **扫描次数：没有增加**。仍是 `scan()` 里一次 `TheSim:FindEntities`；
  `pickupables` 只是分类结果多了一个去处（审计报告 §8 的互斥分流）。
- 单实体新增开销：一次 `IsCandidate`（最多 6 次 `pcall` 包裹的只读检查）—— 只在**没被判成 threats** 时执行。
- `item_kind` 只是一个字符串字段；JSON 体积增量 ≈ 每个可拾取物 20~30 字节。
- 实测（真机样本，见测试报告 §真机）：`scan.duration_ms` 与 M1.4 同量级，`total_found/total_returned` 口径未变。

---

## 8. 实施过程中踩到的两个坑（都值得记下来）

1. **模组沙箱里不能直接用全局 `pcall`**。
   新模块一开始写的是 `pcall(fn)`，在测试沙箱（和真机模组沙箱）里全局 `pcall` 是 nil
   ⇒ `nearby.Classify` 抛错 ⇒ `Observe` 回退成没有 `snapshot_id` 的兜底表。
   修复：按项目既有约定 `local pcall = GLOBAL.pcall`。
   **教训**：新模块必须照抄现有模块的沙箱取全局函数方式。

2. **测试里的上限来自"构建后的配置"**。
   改 `MAX_TOTAL` 全局后不重新 `config.build()` 是不生效的（一直读到 60）。
   已在 harness 里加 `setCaps()`，避免以后写出"假通过"的上限测试。

---

## 9. 已知限制

见 `docs/M2_2_known_limitations.md`。要点：
白名单仍只有 3 个 prefab；`pickupables` 只表达"拾取候选"这一种可行动性；
桶容量未按桶单独配置；`item_kind` 只在 pickupables 上有；
真机样本需要重进世界加载 0.16.0 才能拿到（脚本已就绪）。
