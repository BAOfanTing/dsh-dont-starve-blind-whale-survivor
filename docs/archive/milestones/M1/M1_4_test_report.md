# M1.4 · 测试报告（附近实体结构化观察）

> 环境：Windows 10 · Node v24.13.1 · **本轮没有启动 DST**（真机项标 NOT_RUN）
> 命令：`node --test --test-force-exit "tests/*.test.mjs"`

---

## 1. 总体

| 阶段 | tests | pass | fail |
|---|---|---|---|
| M1.2 结束时（基线） | 233 | 233 | 0 |
| M1.4 加完结构化 nearby + 22 个新用例 | **255** | **255** | **0** |

```
ℹ tests 255   ℹ pass 255   ℹ fail 0   ℹ duration_ms ~3.5s
```

新增：`tests/m1_4-nearby.test.mjs`（22 例）。
改动：`tests/lua-mod.test.mjs`（模块数 10→11、加载列表）、`tests/m1_1-actor-observer.test.mjs`（加载列表 + 沙箱补 `setmetatable`）、
`tests/m1_2-regressions.test.mjs`（空结果断言从 `legacy` 改为 `empty`）、`tools/m12-roundtrip.mjs`（检查项 30→32）。

**证据类型**：除 §6 标注外，全部是 **UNIT**（fengari 沙箱真跑模组代码 + 假 GAME API）。
本文档**没有**任何 `RUNTIME` / `END_TO_END` 结论。

---

## 2. 逐项结果

| # | 用例 | 覆盖点 | 状态 | 证据 |
|---|---|---|---|---|
| 01 | 附近为空 | `status=empty`、七个桶都为空数组、`delta=baseline`、文本说"没什么值得注意的" | PASS | UNIT |
| 02 | 扫描失败 | `status=error` + `error` 码，与 empty 可区分，文本"暂时读不到" | PASS | UNIT |
| 03 | 单个实体 | 字段齐全（ref/prefab/category/label/distance/position/is_workable/work_action），**不含 guid** | PASS | UNIT |
| 04 | 六类分类 | 威胁/食物/资源/容器/建筑/生物各归其桶；`fx` 不进；引用唯一、实体只出现一次 | PASS | UNIT |
| 05 | 不按名字猜 | `prefab=spider` 但无 hostile/combat → 不算威胁、也不进任何桶 | PASS | UNIT |
| 06 | 玩家与无效实体 | 玩家自己不进 nearby；`IsValid=false` 的跳过 | PASS | UNIT |
| 07 | 组件缺失 | 只有 tag 的浆果丛也能观察，不崩（按"采下来是食物"进 food） | PASS | UNIT |
| 08 | 排序确定性 | 桶优先级（威胁在前）+ 桶内距离升序 → `#1..#3` 顺序可复现 | PASS | UNIT |
| 09 | 单桶上限 | 20 丛浆果 + 单桶 12 → 返回 12（最近的），`total_found=20`、`truncated=true` | PASS | UNIT |
| 10 | 总量上限 | 30 棵树 + 总量 10 → 返回 10，`truncated=true`、`max_total=10` | PASS | UNIT |
| 11 | 引用分配 | 截断后从 `#1` 连续编号、数量等于返回数 | PASS | UNIT |
| 12 | 文本与 JSON 同源 | 截断提示"只显示 10/12 个"、桶名与 `#N` 与 JSON 一致、被截断的不出现在文本 | PASS | UNIT |
| 13 | 复用不重编号 | 未到 `scan_seconds`：`scan.reused=true`、`snapshot_id` 不变、`#N` 不变、delta 不变 | PASS | UNIT |
| 14 | 到期重扫 | 新 `snapshot_id`、引用从 `#1` 重新开始 | PASS | UNIT |
| 15 | Delta 三态 | 新增 1 / 消失 1（带 `previous_ref`）/ 变化 1（`health 25→10`） | PASS | UNIT |
| 16 | 无变化 | `delta.status=ok` 且三个计数为 0，文本不出现"变化：" | PASS | UNIT |
| 17 | Session 变化 | 换 session → `delta=baseline`，不把新世界报成新增 | PASS | UNIT |
| 18 | Shard 变化 | 换 shard → `delta=baseline` | PASS | UNIT |
| 19 | 扫描失败后 | 失败不产生"全消失"；下次成功扫描重建 `baseline` | PASS | UNIT |
| 20 | `Resolve()` | 当前快照可解析 `#1`；未知引用 `unknown_ref`；旧快照号 `stale_snapshot` | PASS | UNIT |
| 21 | 性能与体积 | 60 实体：JSON **9835 字节**、沙箱观察 26ms、`scan.duration_ms` 有值 | PASS | UNIT |
| 22 | Node 归一化 | `normalizeState`/`toJsonPayload` 原样保留 buckets/refs/delta/snapshot_id/truncated | PASS | UNIT |

### 与任务书要求逐条对照

| 要求 | 覆盖用例 |
|---|---|
| nearby 结构正确 / 桶结构明确 | 01、03、04 |
| 缺组件不崩 | 07 |
| 空结果与错误区分 | 01、02 |
| `#N` 唯一、连续、文本与 JSON 一致 | 03、04、11、12 |
| 排序与截断后引用仍正确 | 08、09、10、11 |
| `reused` 不重新编号 | 13 |
| 新快照引用不继承旧映射 | 14、20 |
| 分类正确、同一实体只出现一次 | 04、05 |
| 排序确定 | 08 |
| 单桶 / 总量限制与 truncated 统计 | 09、10 |
| Delta 新增/消失/变化/无噪声/首次 baseline | 15、16、01 |
| `reused` 不重复生成 Delta | 13 |
| Session/Shard 变化重置 | 17、18 |
| 不依赖 `#N` 跨快照匹配 | 15（GUID 匹配）、14 |
| 旧文件仍能读取 | `m1_2-regressions`、`M1.1-17` |
| F8/MCP 保持一致 | `M1.1-16`（同函数逐字节相等） |
| `get_state` 仍只有一个 | `tool-parity`（工具总数 35，`get_state` 唯一） |

---

## 3. 管线自检（真 Lua → 真 Node）

`node tools/m12-roundtrip.mjs`（沙箱，**不是真机**）：

```
Lua 写出的 payload：2378 字节
检查项：32，失败：0
（含：schema / status / session / shard / cluster_id_source / actor_id / 三围 / 背包 / 装备 /
  day=cycles+1 / nearby.radius=16 / nearby.status=empty / nearby.schema=bws.nearby/1 / delta=baseline）
```

---

## 4. 与 M1.2 真机采样的关系（重要）

M1.2 采到的真实样本（`tests/artifacts/M1_2/runtime-2026-11-12T15-34-09.json`）是 **M1.1 的 nearby 结构**
（`status="legacy"`、`buckets` 是数组）。M1.4 改了结构，**所以那份样本不能当 M1.4 的真机证据**。
它仍然有用的地方：证明 0.12.x 的 Actor/Player/World/身份字段在真机上是通的（M1.4 没动这些）。

需要你在游戏里再跑一次 `node tools/m12-watch.mjs --seconds 60` 才能拿到 M1.4 的真机样本
（`status=ok`、`buckets` 是对象、能看到 `#N` 与 delta）。

---

## 5. 真机测试情况

| 项 | 状态 | 说明 |
|---|---|---|
| 0.13.0 能否进世界 | **NOT_RUN** | 本轮没有启动游戏（配置已装好：`installedVersion=0.13.0`，18 个文件） |
| 新 nearby 在真机的字段/取值 | **NOT_RUN** | 需要一次采样（见上） |
| 桶上限/截断在真机的表现 | **NOT_RUN** | 同上 |
| `#N` 与实体是否一一对应 | **NOT_RUN** | 同上（沙箱已验证逻辑） |
| delta 在真机的语义（怪走近/打你/掉血） | **NOT_RUN** | 同上 |
| 扫描耗时（真机） | **NOT_RUN** | `scan.duration_ms` 会自动出现在状态里 |

> 没有把任何 UNIT 结果写成真机通过。

---

## 6. 本轮修的问题（都补了测试或已由测试覆盖）

| 问题 | 现象 | 处理 |
|---|---|---|
| 空数组的 JSON 形状 | Lua 空表编码成 `{}`，Node 侧 `Array.isArray` 失败、`for..of` 抛错 | `json.lua` 加 `J.ARRAY` + `J.arr()`：给需要的表打标记，空也输出 `[]`；nearby 的七个桶与 delta 三组数组都用了 |
| `arr()` 作用域 | 提升前 `delta_out()` 里调用会拿到 nil | 提到模块级（`nearby.lua` 顶部） |
| `next()` 在沙箱可能不存在 | 用 `next(fields)` 判断空表 | 改成显式计数循环（`pairs` 计数） |
| 沙箱缺 `setmetatable` | 测试 stub 里没有 `GLOBAL.setmetatable` → 数组标记失效 | 5 个测试/工具 stub 补上（真机 `GLOBAL` 就是 `_G`，本来就有） |
| 坐标口径 | 一开始用 1 位小数的格子坐标，与"你：位置 (12,45)"不一致 | 改回**格子索引（floor）**；精度只体现在 `distance` |
