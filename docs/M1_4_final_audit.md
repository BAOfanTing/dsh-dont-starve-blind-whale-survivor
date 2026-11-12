# M1.4 最终审计（收尾轮）

> 版本：0.13.3（审计基线）→ **0.13.4**（修 `scan.duration_ms` 精度）
> 依据：真机样本 `tests/artifacts/M1_4/m14-runtime-2026-11-12T16-22-23.*`（n11 所在样本，0.13.3 运行）
> 与 `…-16-34-10.*`（0.13.3 运行、采样器已记录 actor 坐标）
> 证据类型：`RUNTIME`（真实游戏文件）、`STATIC`（代码）、`UNIT`（沙箱）、`NOT_RUN`/`BLOCKED`

---

## 0. 结论速览

| 审查项 | 结论 |
|---|---|
| n11 的 12 条 `removed` | **符合"完整扫描缺席"语义**（6 条可见明细全是**不会自己移动的植物**；同伴样本用玩家坐标直接证明"走动→removed 激增"）。其中 6 条明细未被采样器保存 → 对那 6 条**证据不足**，不做断言 |
| n11 的 22 条 `changed` | **符合现有变化规则**（全部是 `distance` ≥1 格的位移；每条都带**当前** `#N`，说明它确实在本次 kept 里） |
| `total_found` 口径 | = **过滤（有效性/自身/INLIMBO/有观察价值/能取坐标）+ 分类之后**的候选数；**不是** FindEntities 原始条数 |
| `scan.duration_ms` | **已修**（0.13.4：`os.clock` → `TheSim:GetRealTime`，1 位小数，不可用写 null）；真机复测**待重进世界** |
| watcher 缓存统计 | **已修**（轮询/文件版本/扫描快照三层分开；去重键 `session+shard+runtime+sequence`） |
| Node fallback nearby | **已补**（新旧结构、empty/error/缺失、#N、delta、not_returned 都能渲染） |
| 是否可正式关闭 M1.4 | **可关闭**，但两条真机复测留待办（见 §7） |

---

## 1. n11 的 Delta 明细审查

### 1.1 上下文（同一帧的其它数字）

| 快照 | total_found | total_returned | 桶分布 | delta |
|---|---|---|---|---|
| n10 | 162 | 34 | threats1 / food12 / res12 / struct4 / creatures5 | added=1 removed=1 changed=1 |
| **n11** | **160** | 34 | 同 n10 | **added=0 removed=12 changed=22** |
| n12 | 157 | 31 | struct3 / creatures3 | added=0 removed=3 changed=0 |

算术自洽性：n10→n11 完整候选 162→160（−2），而 removed=12、added=0
→ 意味着**有 10 个实体新进入完整扫描、但都没进 kept**（added 只统计"进了 kept 的新实体"）。
这与"玩家在走动、边缘不断有实体掉出/进入半径"完全一致，且不违反 0.13.3 的语义。

### 1.2 removed 明细表

> 采样器保存了前 6 条（其余 6 条只有计数）。**previous_ref 字段全部缺失** —— 说明这 12 条在 n10 里就**没有被返回**（只在完整扫描里），本来就没有编号可给。

| 项目 | prefab | 之前是否存在（n10 完整扫描） | 本次完整扫描是否存在（n11） | 当前是否返回 | 结论 |
|---|---|---|---|---|---|
| 1 | `twiggytree`（多枝树） | 是（推断：见 1.3） | **否** | 否 | 符合"真实缺席"；树不会自己移动 → 只能是离开 16 格半径 |
| 2 | `twiggytree` | 同上 | 否 | 否 | 同上 |
| 3 | `twigs`（树枝） | 同上 | 否 | 否 | 同上（地上掉落物） |
| 4 | `grass`（草） | 同上 | 否 | 否 | 同上 |
| 5 | `twigs` | 同上 | 否 | 否 | 同上 |
| 6 | `evergreen`（常青树） | 同上 | 否 | 否 | 同上 |
| 7-12 | （未被采样器保存） | **证据不足** | **证据不足** | 否 | 记录为"证据不足"，不做断言 |

### 1.3 为什么能确定是"玩家走动"而不是 Delta 误报

1. **静态证据（STATIC）**：0.13.3 的 `compute_delta` 用**完整扫描集合**建基线，`removed` 只在 `current[guid] == nil`（本次完整扫描里没有）时产生 —— 被截断但仍在半径内的实体**进不了 removed**。
2. **RUNTIME 直接证据（同伴样本）**：0.13.3 的另一次采样（工具箱已记录玩家坐标）里，removed 数量与"本帧玩家走了几格"高度相关：

   | 快照 | 玩家格子 | 相对上次移动 | found | delta |
   |---|---|---|---|---|
   | n187 | (-3,-149) | — | 157 | added=1 removed=1 changed=0 |
   | n188 | (-3,-149) | 0.0 格 | 158 | added=1 removed=0 |
   | n189 | (-3,-149) | 0.0 格 | 157 | removed=1 |
   | n190 | (-3,-149) | 0.0 格 | 160 | removed=7 |
   | n191 | (-6,-148) | **3.2 格** | 154 | **removed=26 changed=20** |
   | n192 | (-7,-147) | 1.4 格 | 160 | removed=9 changed=14 |
   | n193 | (-4,-149) | **3.6 格** | 151 | **removed=37 changed=20** |

   → 站着不动时 removed 只有 0~7；一走 3 格就跳到 26~37。**这就是"离开 16 格半径"的直接证据**。
3. **n11 自身**没有记玩家坐标（采样器当时还没记录），所以对 n11 只能给出"同类机制 + 静态植物不可能自行消失"的**间接结论**，不能声称逐条证明了 n10 的完整集合。

### 1.4 changed 明细审查（22 条，采样器保存了前 6 条）

| ref | prefab | 变化字段 | 变化量 | 判定 |
|---|---|---|---|---|
| #26 | 南瓜灯 | distance 2.3 → 0.6 | 1.7 格 | 合理（≥1 格阈值），且带**当前** #N → 说明它在 kept 里 ✓ |
| #28 | 怪皮弗娄牛（wanderingtrader） | 1.0 → 2.1 | 1.1 格 | 同上 |
| #29 | 南瓜灯 | 0.6 → 2.2 | 1.6 格 | 同上 |
| #15 | 种子 | 1.3 → 2.9 | 1.6 格 | 同上 |
| #16 | 常青树 | 1.6 → 3.3 | 1.7 格 | 同上 |
| #31 | 红雀 | 2.5 → 3.5 | 1.0 格 | 正好达到阈值，合理 |

- 全部是 `distance`，**没有** health / stack_size / 可采状态噪声 → 符合"只报有意义的变化"。
- 每条都带 `ref`，说明它们**在本次 kept 里**（可操作）；没有给窗口外实体乱发引用。
- 方向混杂（有的变近、有的变远）→ 与"玩家平移"一致，而不是某个实体自己跑。

> 未保存的 16 条 changed：按同样规则产生（`ref` 必须非空），但**没有逐条看到**，不做断言。

### 1.5 与"误报"的区分

0.13.2 及以前，`removed` 里会出现"仍存在、只是被截断"的实体（那次真机样本里 `twiggytree/carrot_planted` 是被截断的）。
**本次（0.13.3）n11 的 removed 全部是"离开完整扫描"的实体**，且 6 条明细里没有任何一条同时满足
"仍在完整扫描 + 只是没进 kept"（那种情况 0.13.3 根本不会产生 removed）。
→ **结论：n11 符合完整扫描语义，未发现新的 Delta 误报。**

---

## 2. `total_found` 的统计口径（代码实证）

`scripts/whale/nearby.lua`：

```lua
-- scan()（L265-288）
for _, ent in ipairs(ents) do
    if ent ~= nil and ent ~= actor and ent:IsValid() and not ent:HasTag("INLIMBO") then   -- 有效性/自身/limbo
        if interesting(ent) then                                                          -- 有观察价值
            local category = N.Classify(ent, actor)                                       -- 必须能分类
            if category ~= nil then
                local block = describe(ent, actor, category)                              -- 必须能取到坐标
                if block ~= nil then out[#out + 1] = {...} end
-- ...
return { entities = out, found = #out }                                                   -- found = 上面全部通过的数量

-- build()（L579-581）
total_found    = scanned.found,
total_returned = #kept,
truncated      = #kept < scanned.found,
```

| 问题 | 结论 |
|---|---|
| A. FindEntities 原始返回总数？ | **不是**。原始条数没有记录（也没必要：被过滤掉的不是"可观察候选"） |
| B. 过滤后的候选数？ | **是**（有效性 + 排除自己 + INLIMBO + 有观察价值） |
| C. 分类后准备进限额的数量？ | **也是**（分类必定成功才入表；`other` 兜底也算在 found 里） |
| `total_returned` == 所有桶条目之和？ | **是**（`#kept` 就是被分进各桶的条目数；每实体只进一个桶）。真机 `totalsIssues=0`（watcher 每帧校验 `total_returned === 所有桶 flat 后长度`） |
| `not_returned_count` == 限额造成的未返回数？ | **是**：`#list - #kept`，且 `#list == total_found` → 恒等于 `total_found - total_returned`（单测 `E` 钉住） |
| 单桶限制与总量限制都计入截断？ | **是**：截断循环同时检查 `count < max_per_bucket` 和 `total < max_total` |
| 无效实体计入 total_found？ | **不计入**（在扫描循环里就跳过了） |
| 未分类/进 other 的实体计入？ | **计入**（`other` 也是可观察桶） |
| 有没有重复计数（同一实体进多个桶）？ | **没有**（每个实体只调用一次 `Classify`，只进一个桶；真机引用唯一性 `refIssues=0` 佐证） |

**不新增字段**：现有 `total_found / total_returned / truncated / not_returned_count` 已能表达
"扫到多少候选 / 返回多少 / 截断多少"，只是文档和渲染文案需要讲清楚"候选 = 过滤+分类之后"。
（Schema 文档已更新，见 `docs/M1_4_nearby_schema.md` §5。）

---

## 3. `scan.duration_ms` 的精度问题与修复

### 3.1 根因（STATIC + 引擎源码）

- 旧实现：`math.floor((U.now() - started) * 1000)`；`U.now()` 在真机优先取 `TheSim:GetTime()`
  （本构建没有）→ 退回 `TheSim:GetRealTime()/1000`（秒，浮点）→ 再 `os.time()` 兜底（整秒）。
- 单次扫描远小于 1ms → `floor(...)` 恒为 **0**（真机 3 次采样全是 `[0]`）。
- 引擎里 `TheSim:GetRealTime()` 的单位是**毫秒**：`scripts/mainfunctions.lua:608 return TheSim:GetRealTime()`、
  `:612 return TheSim:GetRealTime() / 1000`（同一函数两个包装，一个 ms 一个 s）。

### 3.2 修复（0.13.4）

```lua
local function clock_ms()          -- 返回 (毫秒 | nil, 来源)
    if os.clock then return os.clock() * 1000, "os.clock" end          -- 亚毫秒精度
    if TheSim.GetRealTime then return TheSim:GetRealTime(), "realtime" end  -- 毫秒
    return nil, "none"
end
```

- 开始/结束各取一次，**且要求两次来源一致**（混用两个时钟算出来的差值没有意义）；不一致 → null；
- 差值保留 **1 位小数**（`0.7` 而不是 `0`）；
- 拿不到可信耗时 → `duration_ms` 不写（JSON 里缺席 = null 语义），`duration_source = "unavailable"`；
- 出错分支也写 `unavailable`；**复用快照时沿用原耗时**，不虚构一次新扫描；
- 新增 `scan.duration_source`（`os.clock` / `realtime` / `unavailable`）—— 以后不会再把"看不到"当成"很快"。

测试：`tests/m1_4-scan-timing.test.mjs` 7 例（os.clock / realtime / 都不可用 / 返回垃圾 / 源不一致 /
扫描失败 / 复用不虚构）。

### 3.3 真机复测状态：**待重进世界**

0.13.4 已装盘，但**当前运行中的世界仍是 0.13.3 的内存镜像**（采样 `scan.duration_ms` 仍为 `[0]`）。
重进世界后才会看到 `duration_ms: 0.x` 与 `duration_source: "os.clock"`。→ 标 **NOT_RUN（待人工重进世界）**。

---

## 4. watcher 缓存统计口径（已修）

### 4.1 旧口径的问题

旧报告里 `纯复用快照: 0 / 含新扫描的快照: 15 / 不同扫描快照: 15` 是**按 nearby 快照归并**的，
而 `reused` 是**文件版本级**属性（每秒写盘、每 4 秒扫描），两者混在一起 → 数字无法解释。

### 4.2 新口径（三层，`tools/m14-counters.mjs`）

| 层 | 字段 | 含义 |
|---|---|---|
| 轮询 | `poll_count` / `duplicate_polls` | watcher 读了几次文件；其中几次是同一版本重复读 |
| 文件版本 | `unique_file_versions` | 状态文件真正换版几次（去重键：`session+shard+runtime+sequence`） |
| 扫描 | `unique_snapshot_ids` / `reused_file_versions` / `fresh_scan_file_versions` / `reused_ratio` / `fresh_scan_ratio` | 扫描快照数；其中复用 vs 新扫描的文件版本数 |

- 去重键带 `runtime_id` → 游戏重启后 `sequence` 归零也不会被误合并；
  没有 `runtime_id`（0.13.2 以前）时退回 `sequence` 键，并在结果里标 `version_key_kind: "sequence"`。
- 解析错误单独记 `parse_errors`；文件不存在记 `missing_frames`（两者不混）。

真机实测（0.13.3，25 秒）：`poll 49 / unique 30 / dup 19 / reused 14 / fresh 16 / 复用率 0.467`。

---

## 5. Node fallback 的 nearby 渲染（已补）

`lib/state/snapshot.js` 新增 `nearbyLines()`，`renderFallbackText()` 在"读不到的字段"之前调用它：

| 支持 | 说明 |
|---|---|
| 新结构（对象 buckets） | 按 threats→…→other 顺序、只输出非空桶 |
| 旧结构（数组 buckets） | 按 `kind/label/items` 渲染，**不伪造 #N** |
| `ok` / `empty` / `error` | 分别输出：桶内容 / "没什么值得注意的" / "暂时读不到（扫描出错：原因）" |
| 缺失 nearby | 不输出附近段 |
| 半径 / 总数 / 截断 | `附近（16 格内，只显示 32/157 个）：` |
| `#N` | 桶内条目原样带出 |
| Delta | 只在 `status=ok` 且有计数时输出：新出现（带 ref）/ 消失（只用名字）/ 变化（带 ref） |
| `not_returned_count` | `未列出 N 个（附近还有，但这次没有编号，不能直接对它操作）` |
| 禁止项 | 不重扫、不重编号、不重算 delta、不把 `previous_ref` 当当前引用、不把 `not_returned` 当目标 |

测试：`tests/m1_4-fallback.test.mjs` 10 例。
`get_state` 仍优先用 Lua 原生 text（有 text 时 fallback 不被使用）。

---

## 6. 本轮改动的边界（对照任务书）

| 允许 | 实际 |
|---|---|
| Delta 逻辑 / 必要 Schema / 文本输出 / 测试 | Delta 上一轮已修；本轮只改计时、统计口径、fallback 渲染 |
| 不重构 nearby.lua | 只加 `clock_ms/duration_of` 两个局部函数 + `scan` 里 2 个字段 + FOODTYPE 防御 |
| 不改 #N 保护 | `runtime_id` / `Resolve` / `refs` 单快照保留 未动 |
| 不新增扫描 / 不改 Node 架构 | 未动；`get_state` 仍是唯一入口 |
| 不改 m12-watch | 已确认与 HEAD 一致（`git diff` 为空） |

---

## 7. 遗留待办（不影响关闭 M1.4，但不能算已证）

1. **0.13.4 的 duration_ms 真机复测**：需要重进一次世界（当前内存是 0.13.3）。
2. **n11 的另外 6 条 removed / 16 条 changed 没被采样器保存**（当时的工具只存前 6 条；
   本轮已改成保存完整明细，下次采样就能逐条核）。→ 证据不足，不做断言。
3. 分类小瑕疵（观察项，非缺陷）：`wanderingtrader`（怪皮弗娄牛）被归到 `structures`；
   它其实是个会走动的 NPC。原因未知（可能带 `structure` 标签），需要一次针对性采样再决定要不要调。
4. 双分片（Caves）/ MCP 网络端到端 仍未验（M1.2 起一直记着）。
