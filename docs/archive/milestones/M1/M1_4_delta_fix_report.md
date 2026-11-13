# M1.4 · Delta 截断修复报告（0.13.2 → 0.13.3）

> 问题：Delta 用**截断后的返回集合**做基线，把"被容量限制挤出窗口"的实体误报成 `removed`。
> 修复：基线改成**本次完整 FindEntities 扫描的候选集合**；`removed` 只来自"完整扫描里真的没有了"。
> 版本：**0.13.3**（已重新装进游戏）。单测 **262 → 267**（新增 5 条 Delta 回归）。

---

## 1. 语义对照（修复前 / 修复后）

| 字段 | 0.13.2（错） | 0.13.3（对） |
|---|---|---|
| 比较基线 | 上一次的 **kept**（截断后） | 上一次的**完整扫描**（截断前） |
| `removed` | 上次在返回窗口里、这次不在 → 报"消失"（含被截断挤出的） | 上次完整扫描有、这次完整扫描**也没有** → 才是真消失 |
| `added` | 这次在返回窗口里、上次不在返回窗口里 → 报"新增"（含重新挤进窗口的老实体） | 这次进了 kept（有 `#N`）**且**上次完整扫描里没有 → 才是真新增 |
| `changed` | 两边都在 kept 就报（可能含被截断的） | 两次都在完整扫描**且这次进 kept（有 `#N`）**才报（否则模型没法操作） |
| 未返回实体 | 无表达（看起来像消失了） | 新字段 `not_returned_count` + `not_returned[]`（**不带 ref**，不能当可操作目标） |
| `previous_ref` | 总是存在（可能是错的编号） | 只在"上次确实返回过"时出现；仍然是历史信息，不可当当前引用 |

其余语义不变：`baseline`（首次 / 换 session / 换 shard / 上次失败）、`reused` 不重算、按 GUID 匹配。

---

## 2. 修复前后对比（可复现：`node tools/m14-delta-compare.mjs`）

场景：4 棵树、单桶上限 3。第一帧返回最近 3 棵（guid 1/2/3，guid 4 被挤出）；
第二帧**一棵都没少**，只是 guid 1 走到 10 格外，于是 guid 4 进窗、guid 1 出窗。

```
修复前（1751858 = 0.13.2）：
  第 1 帧 total_found=4 returned=3 delta=baseline
  第 2 帧 delta={"status":"ok","added":1,"removed":1,"changed":0,
                 "removedDetail":["#1:evergreen"]}      ← 误报：这棵树还在
修复后（0.13.3）：
  第 1 帧 total_found=4 returned=3 delta=baseline
  第 2 帧 delta={"status":"ok","added":0,"removed":0,"changed":0,
                 "notReturned":1}                       ← 正确：只是没返回
```

第 2 帧文本（修复后）：

```
附近（16 格内，只显示 3/4 个）：
  资源：#1 常青树(2,0) 距2 可砍；#2 常青树(3,0) 距3 可砍；#3 常青树(4,0) 距4 可砍
```

> 「只显示 3/4 个」+ `not_returned_count=1` 一起表达"还有 1 个没列出来"，
> 而不是捏造一条"某棵树消失了"。

---

## 3. 真机证据（修复前，来自 0.13.1/0.13.2 样本）

`tests/artifacts/M1_4/m14-runtime-2026-11-12T16-00-57.json`，玩家基本站着不动、
`total_found=145 / total_returned=27`，delta 里出现的 `removed`：

| 快照 | removed | 说明 |
|---|---|---|
| n111 | `#26:twiggytree` | 树不会自己消失 |
| n113 | `#26:grass` | 草也不会 |
| n120 | `#18:robin, #14:carrot_planted` | **胡萝卜种在地里** |

→ 这就是"截断挤出被当成消失"的真机证据。修复后同样的场景应表现为 `not_returned_count` 上涨，
`removed` 只出现在真正离开 16 格半径/被摧毁的实体上。

> ⚠️ **真机复测需要重新进一次世界**：采样时运行中的世界仍是 0.13.2 的内存镜像
> （样本里 `snapshot_id` 还是 `n314…`，没有运行实例号）。0.13.3 已装盘，重进世界后
> `snapshot_id` 会变成 `r<时间>-<随机>-n<序号>`，届时再跑一次
> `node tools/m14-watch.mjs --seconds 60` 就能对比。

---

## 4. 代码改动（只动 Delta 相关）

`DontStarveWhaleSurvivor/scripts/whale/nearby.lua`：

| 位置 | 改动 |
|---|---|
| `compute_delta(full, kept_set, key)` | 签名从"传 kept 列表"改成"传完整扫描列表 + kept 集合"；内部把条目压成视图（`entry_view`，`ref=nil` 表示这次没返回） |
| 基线 `prev.by_guid` | 现在存**完整扫描**的视图（而不是 kept） |
| `added` / `changed` 的过滤 | 都要求 `now.ref ~= nil`（这次真的返回了、有 `#N`） |
| `removed` | 仅当 `current[guid] == nil`（完整扫描里没有） |
| `delta_out(delta, not_returned)` | 新增 `not_returned_count` / `not_returned[]`（最多 12 条明细，且**不带 ref**）；`previous_ref` 仅在存在时输出 |
| `build()` 调用点 | 用完整扫描 `list` + `kept_set` 建基线；`not_returned` 从 `list \ kept` 得出 |
| guid 防御 | 没有 `GUID` 的条目（只会在假游戏里出现）不进 delta 逻辑，避免 nil 索引 |
| 观测错误信息 | `nearby_block` 兜底错误里带上原因（`nearby_failed: <原因>`），便于诊断 |

**没有改动**：扫描逻辑（仍是一次 `FindEntities`）、分类、排序/上限/截断、`#N` 分配、
`runtime_id` 与 `Resolve()` 安全保护（0.13.2 加的）、`observe.lua` 的 nearby 编排、Node 侧任何代码。

---

## 5. 新增测试（`tests/m1_4-delta-truncation.test.mjs`，5 条）

| 用例 | 场景 | 断言 |
|---|---|---|
| A | 4 个实体，单桶 3；第二帧一棵没少只是排序变了 | `removed_count=0`、`added_count=0`、`not_returned_count=1`、未返回项**不带 ref**、当前引用仍是 `#1..#3` |
| B | 第二帧完整扫描只有 3 个（真的少了一个） | `removed_count=1`、带 `previous_ref`、`removed` 里**没有** `ref` 字段、当前引用仍连续 |
| C | 实体在窗口边界来回抖动（进出 kept 共两次） | 两个方向都 `removed_count=0` / `added_count=0`，`not_returned_count=1` |
| D | 窗口外的实体掉血 | `changed_count=0`（没有 `#N` 就不可操作）、`removed_count=0` |
| E | `not_returned_count == total_found - total_returned`；reused 不重算 | 数量自洽、明细 ≤12、复用帧的 delta 与上一帧一致 |

既有 Delta 测试全部保留且通过：`M1.4-15`（added/removed/changed）、`M1.4-16`（无变化不制造噪声）、
`M1.4-17/18`（Session/Shard 重置）、`M1.4-19`（上次失败重建基线）、`M1.4-13`（reused 不重算）。

---

## 6. 测试与自检结果

| 项 | 结果 |
|---|---|
| 全量单元测试 | **267 / 267 通过**（262 + 5） |
| 管线自检（Lua → Node） | **32 / 32**（含 `nearby.status` / `delta.status=baseline` 断言） |
| 审计探针 A（截断是否误报） | **`removed_count=0`**（修复前是 1） |
| 审计探针 B（运行实例） | 仍按 0.13.2 的设计拒绝旧快照（`stale_snapshot`） |
| 修复前后对比脚本 | 见 §2 |
| 版本 | 0.13.2 → **0.13.3**，已重装（`installedVersion=0.13.3`） |

---

## 7. 已知限制（如实）

1. **真机复测待你重新进世界**：当前世界内存里是 0.13.2；重进后 `snapshot_id` 带运行实例号，
   再跑采样即可看到 `removed` 只剩真实缺席、`not_returned_count` 上升。
2. `not_returned[]` 只带前 12 条明细（控制 JSON 体积），精确数量看 `not_returned_count`。
3. `changed` 里仍然包含 `distance` 变化（阈值 1 格）——这是有意的（怪在移动），不属于本次修复范围。
4. 若某个实体**上次没返回、这次返回了**（挤进窗口），它既不是 `added`（因为上次完整扫描里有）
   也不会出现在 `changed`——它的"重新可见"只能从 `not_returned_count` 的下降看出来。
   如果将来模型需要"重新出现"这个语义，可再加 `reappeared`，本次没有加（避免扩大改动面）。
