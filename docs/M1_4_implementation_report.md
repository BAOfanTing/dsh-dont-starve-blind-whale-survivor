# M1.4 · 实现报告（附近实体结构化观察）

> 版本：**0.12.1 → 0.13.2**（0.13.0 结构化 nearby；0.13.1 修真机暴露的分类错判；0.13.2 加引用运行实例防护）
> 结论：附近实体已经结构化（分类桶 + `#N` 引用 + 上限/截断 + delta + 复用不重编号），
> 文本与 JSON 同源，Node 侧零改动即兼容；**单元测试 233 → 255，全过**。
> 真机：本轮**没有启动游戏**（上一轮 M1.2 已有 Master 单分片真机采样，但那是 M1.1 的 nearby 结构）。

---

## 1. 这次到底改了什么（按文件）

| 文件 | 改动 | 说明 |
|---|---|---|
| `scripts/whale/nearby.lua` | **新增**（约 480 行） | 附近实体的唯一实现：分类 / 扫描 / 排序 / 上限 / `#N` / delta / 缓存 / `Resolve()` |
| `scripts/whale/observe.lua` | 改 | ①删掉旧的 `collect_buckets/scan_cache/entry_block/workable_is`（约 150 行）；②`nearby_block` 变成"调 `Whale.nearby.Observe()` + 兜底"（约 30 行）；③`Render()` 的 nearby 段改成读取结构化桶 + `#N` + delta；④新增 `fmt_num` / `WORK_LABELS` |
| `scripts/whale/json.lua` | 改 | 新增 `J.ARRAY` + `J.arr()`：让"空数组"也能序列化成 `[]`（Lua 里 `{}` 的 JSON 形状天生有歧义） |
| `scripts/whale/config.lua` | 改 | 新增 `nearby_max_total`（默认 60，10–200）、`nearby_max_per_bucket`（默认 12，2–50） |
| `modinfo.lua` | 改 | 新增两个设置项 `OBSERVER_NEARBY_MAX_TOTAL` / `OBSERVER_NEARBY_MAX_PER_BUCKET`（带中文说明与档位） |
| `modmain.lua` | 改 | `modimport("scripts/whale/nearby.lua")`（在 observe 之前）；把两个新配置从 `modconfig()` 映射进 `Whale.config` |
| `lib/state/snapshot.js` | **没改** | `data.nearby` 本来就是原样透传；确认 `toJsonPayload()` 不丢 buckets/delta/snapshot_id（新增单测 M1.4-22 钉住） |
| `lib/tools.js` / `lib/agent.js` | **没改** | `get_state` 仍只有一个；文本仍由 Lua 渲染（同源） |
| `tests/m1_4-nearby.test.mjs` | **新增** | 22 个用例（见测试报告） |
| `tests/lua-mod.test.mjs` | 改 | 模块数 10→11、加 `nearby.lua` 与顺序断言；`loadMod` 列表补 `config/actor/nearby` |
| `tests/m1_1-actor-observer.test.mjs` | 改 | 加载列表补 `nearby`；沙箱补 `GLOBAL.setmetatable` |
| `tests/m1_2-regressions.test.mjs` | 改 | 空结果断言从 `status="legacy"` 改为 `status="empty"`（M1.4 语义更准） |
| `tools/m12-roundtrip.mjs` | 改 | 加载 `nearby.lua`；断言改为 `status=empty / schema=bws.nearby/1 / delta=baseline`，检查项 30 → 32 |
| `README.md` | 改 | 模型默认值（上一轮遗留）+ 附近实体两个新设置 |

**没有动**：`actor.lua`（观察对象入口）、`bridge.lua`（状态写盘）、`lib/state/snapshot.js` 的归一化逻辑、
任何动作代码（`actions.lua` / `macros.lua` / `reflex.lua`）、`archive/`。

---

## 2. 旧逻辑怎么复用的

M1.1 的 nearby 已经有一套"扫描 → 分类 → 桶 → 渲染"，但：

- 分类硬编码在 `collect_buckets` 里（10 个桶、每种一坨 `U.find_all(...)`）；
- **每种桶都各调一次 `FindEntities`**（10 次全量扫描！）；
- 没有引用、没有截断统计、没有 delta；
- 状态标记是 `"legacy"`（把"旧实现"和"故障"混在一起）。

M1.4 的做法是**把这一层整体搬进 `nearby.lua` 并改成"一次扫描 + 一次分类"**：

- 保留：`U.find_all` 的距离/过滤口径、`U.pretty` 的中文名、`U.tile_of` 的格子口径、每个桶的语义；
- 改掉：10 次 `FindEntities` → **1 次**；字符串拼接 → 结构化对象；`"legacy"` → `ok/empty/error`。
- 排序/上限/引用全部在"扫描结果"这一层做，渲染只读结果。

顺带修掉一个 M1.1 遗留的性能问题：以前一次 `BuildData` 最多会扫 10 遍附近（每桶一遍），现在是 1 遍（已按 `OBSERVER_SCAN_SECONDS` 缓存）。

---

## 3. `#N` 怎么生成和管理

```
build() 里：
  1. scan()              → 一次 FindEntities + 逐个分类（只用真实 tag/组件）
  2. sort_entities()     → 桶优先级 → 距离 → prefab → GUID（完全确定）
  3. 截断（单桶 → 总量）  → kept 列表
  4. 给 kept 逐个编号 #1..#N（只在截断后编号！）
  5. refs[snapshot_id] = { ["#1"]=entity, ... }   ← 只在 Lua 内存里
  6. delta = compute_delta(kept, session|shard)
```

- `snapshot_id` 是**扫描**序号（`n1, n2, …`），不是写盘序号。这样缓存复用期间 `#N` 不会每秒变一次。
- `N.Resolve(snapshot_id, ref)` 给 M2 用：`stale_snapshot` / `unknown_ref` / `entity_gone` / `in_limbo` 四种拒绝原因。
- **GUID 不出 Lua**：不进 JSON，不进文本；只在 `refs` 与 delta 基线里做"同一个实体"的判定。

---

## 4. Delta 怎么算

- 基线：`prev = { key = "<session_id>|<shard_id>", by_guid = { [guid] = entry } }`，只在**成功扫描**后更新。
- 逐 GUID 对比：
  - 当前有、基线无 → `added`（带当前 `ref`）
  - 基线有、当前无 → `removed`（带 `previous_ref`，**只是历史**）
  - 两边都有但字段变了 → `changed`（`health ≥1`、`distance ≥1 格`、`stack_size`、`is_harvestable`、`work_action`、`category`）
- `Session`/`Shard` 变了、或上次扫描失败 → `prev` 清空，本次返回 `baseline`（不把"换了世界"误报成"东西全消失"）。
- 缓存命中（`reused`）→ **原样返回上一次的 delta**，不重算。

---

## 5. Node / F8 / MCP 兼容

| 关注点 | 结果 |
|---|---|
| `normalizeState()` 保留新字段 | ✅ `data.nearby` 原样透传（M1.4-22 用 deepEqual 钉住 buckets/refs/delta） |
| `toJsonPayload()` 不丢分类/引用/delta | ✅ 同上 |
| `format=text` 与 `format=json` 同一份快照 | ✅ 仍走同一个 `readSnapshot()` |
| `get_state` 只有一个工具 | ✅ 工具总数仍 35（`tool-parity` 测试守着） |
| F8 与 MCP 文本逐字节一致 | ✅ 同一函数；M1.1-16 与 M12 采样都验证过（同进程同文件） |
| 旧文件（`schema=legacy`）仍能读 | ✅ `m1_2-regressions` + `M1.1-17` + 真实旧文件冒烟都不变 |
| 旧 nearby 字段 | ✅ `radius` / `scan_seconds` / `cached` 保留；`buckets` 从数组变对象（唯一破坏性变更，已记录） |

---

## 6. 性能与体积（沙箱实测，非真机）

`M1.4-21`（60 个实体：30 只蜘蛛 + 30 棵树，单桶上限放开到 50）：

```
[perf] 60 实体：JSON 9835 字节，观察 26ms，scan 0ms
```

| 指标 | 数值 | 说明 |
|---|---|---|
| nearby JSON 体积 | **9.8 KB / 60 实体** | 约 164 字节/实体；< 12 KB 预算 |
| `BuildData` 全程（含附近） | ~26 ms（fengari，比真机慢） | 真机 LuaJIT 应更快；`scan.duration_ms` 会带到状态里 |
| `FindEntities` 次数 | **1 次/扫描**（M1.1 是 10 次/次观察） | 已在缓存期内复用 |
| 状态文件整体 | 60 实体时约 +9.8 KB（原 ~1.9 KB） | 仍远小于 Node 侧 128KB 上限与模型上下文预算 |

> 真机数字要等下一次进世界才能测；`m12-watch.mjs` 会把 `scan.duration_ms` 与文件年龄一起采下来。

---

## 7. 已知限制（不隐瞒）

1. **分类是白名单式启发**：`food` 依赖 `FOOD_SOURCES` 表；新食物源（DLC/新作物）会被归到 `resources`，不会丢但不够准。
2. **不认识的实体不进桶**：只有 `health/workable/harvestable/inventoryitem/container/fueled/prototyper/combat/结构标签` 之一才算"有观察价值"。纯装饰、特效永远不出现。
3. **坐标是格子索引（floor）**：和"你：位置 (12,45)"一致；亚格精度只体现在 `distance`（1 位小数）。M2 若需要精确点，用 `ref` 解析实体本身。
4. **上限会丢东西**：极端场景（蜘蛛巢/浆果田）会把远处实体截掉；`truncated` + `total_found` 会如实说明，但模型仍可能"以为附近就这些"。
5. **delta 只对相邻成功扫描有意义**：`reused` 期间不更新；跨 Session/Shard 不比较（这也是设计要求）。
6. **`is_open` 依赖组件是否有 `IsOpen`**：没有就不给这个字段。
7. **`#N` 只活在一次扫描内**：M2 必须按 `nearby.snapshot_id` 校验，不能跨快照复用编号。
8. **没有做局部地图**（M1.5）、没有做任何动作（M2）。


---

## 8. 交付后的两次修正（都有真机依据）

### 0.13.1 · 分类按真实组件修正

真机采样发现三个错判，根因都在《饥荒》自己的 prefab 定义里：

| 现象 | 根因（游戏源码） | 修正 |
|---|---|---|
| 12 根 `树枝` 被判成"食物" | `twigs.lua` 真的 `AddComponent("edible")`（foodtype=ROUGHAGE） | 食物加 `is_real_food()`：排除 ROUGHAGE / SEEDS / GEARS |
| `种子` 被判成"食物" | `seeds.lua` 有 edible（foodtype=SEEDS） | 同上 |
| `红雀` 被判成"资源（掉落物）" | `birds.lua` 带 `inventoryitem` + health + combat | "地上物品"分支要求**没有 health** |
| `南瓜灯` 被判成"资源" | `pumpkin_lantern.lua` 带 `inventoryitem` + health + light | 同上；并新增 `HasTag("light")` → structures |

新增 5 条回归用例（M1.4-23…27）。

### 0.13.2 · 引用运行实例防护（M1.4 验收发现）

真机确认 **session_id 跨重启不变**，而 `scan_seq` 每次运行从 1 开始 →
`snapshot_id` 只有 `n<序号>` 时，重启后新旧实例会撞号，旧 `#N` 能解析成新实例里的另一个实体。

修法（`nearby.lua` 约 25 行）：

- 模块加载时生成 `RUNTIME_ID`（`r<os.time>-<4位随机>`），`snapshot_id = "<RUNTIME_ID>-n<序号>"`；
- 输出 `nearby.runtime_id`，供 Node/M2 绑定；
- `Resolve()` 先校验前缀，非当前实例一律 `stale_snapshot`；
- `refs` 只保留当前扫描（旧快照的 #N 同时失效，也不再无限增长）。

新增测试：`tests/m1_4-runtime-id.test.mjs`（跨实例拒绝、同实例旧扫描号拒绝）。

> 仍未修（已报告、等你确认）：**Delta 用截断后的集合比较**，会把被挤出窗口的实体误报成 `removed`
> （见 `docs/M1_4_acceptance_audit.md` Q2 的最小修复建议）。
