# M1.4 真机测试报告（nearby 结构化观察）

> 采样时间：2026-11-12 16:00:57Z（60 秒）与 16:04:47Z（30 秒）—— 本地时间 00:00 / 00:04（UTC+8）
> 采样工具：`tools/m14-watch.mjs`（新增，只读）；不改 `tools/m12-watch.mjs`
> 运行中的世界：`Cluster_1` / Master / session `5F056B29DE65C542` / shard `1`
> 版本说明：采样时**运行中的世界是 0.13.1 的内存镜像**（0.13.2 已装盘但未重新进世界），
> 因此样本里没有 `nearby.runtime_id`，其余字段（分类桶、#N、截断、delta）都是 0.13.1 的真实行为。

---

## 1. 一句话结论

**nearby 结构化观察在真机上跑通了**（`status=ok`、七个桶对象、`#N 1..N`、`truncated` 准确、引用唯一连续、
JSON 体积可控），**但 Delta 的 `removed` 会把"被截断挤出窗口"的实体误报成消失**（真机 + 沙箱双向证明）。
引用安全洞（跨运行撞号）已在 0.13.2 修掉并加了测试。

---

## 2. 样本与统计

| 项 | 样本 A（60s） | 样本 B（30s） |
|---|---|---|
| 文件 | `tests/artifacts/M1_4/m14-runtime-2026-11-12T16-00-57.json` | `…-16-04-47.json` |
| 帧数 | 117 | 62 |
| `nearby.status` 计数 | ok=117，empty=0，error=0 | ok=62 |
| 扫描快照 | 16 个（`n111`…`n126`） | 6 个（`n169`…`n176`） |
| 扫描频率 | ≈4 秒一次（= `OBSERVER_SCAN_SECONDS`） | 同上 |
| 同一快照内引用稳定 | **true（16/16）** | true |
| 纯复用快照 / 含新扫描 | 1 / 15 | 0 / 6 |
| `total_found` | 145 | 146 |
| `total_returned` | 27（末帧） | 25（末帧） |
| `truncated` | **true** | true |
| 引用问题 | **0** | 0 |
| totals 自洽问题 | **0** | 0 |
| JSON 解析错误 | 0 | 0 |
| 写盘间隔中位数 | 1000.14 ms | — |
| `sequence` | 末值 546，回退 0 次 | — |
| nearby JSON 体积 | min 4382 / median 4507 / max 5046 字节 | — |
| `scan.duration_ms` | 只观察到 `0` | 0 |

---

## 3. 逐项结果（状态 + 证据类型）

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| 1 | `nearby.status=ok`（真实扫描到实体） | **PASS** | RUNTIME（117/117 帧） |
| 2 | `status=empty`（扫描成功但空） | **NOT_OBSERVED** | 本场景一直有实体；由 `M1.4-01`（UNIT）覆盖 |
| 3 | `status=error`（真实扫描失败） | **NOT_OBSERVED** | 没让它失败；由 `M1.4-02`（UNIT）+ 解码分支覆盖 |
| 4 | empty 不会被当成 error | **PASS** | STATIC：三态在 `nearby.lua` 分开写；文本分支不同 |
| 5 | 七个桶都是数组 | **PASS** | RUNTIME：`buckets` 为对象，7 个键都在（空桶为 `[]`） |
| 6 | 实际观察到的桶 | threats / food / resources / structures | RUNTIME（见 §4） |
| 7 | 未出现的桶 | **containers / creatures / other = NOT_OBSERVED** | 场景里没有箱子/猪人；没有为了凑数刷实体 |
| 8 | `#N` 唯一 | **PASS** | RUNTIME：`refIssues=0`（117 帧 × 每次 24~28 个引用） |
| 9 | `#N` 连续（1..N） | **PASS** | RUNTIME：同上 |
| 10 | 同一快照内引用稳定 | **PASS** | RUNTIME：16/16 快照 `refsStable=true`（复用不重编号） |
| 11 | 新扫描重新编号（从 #1 开始） | **PASS** | RUNTIME：每个新快照的 refs 集合都是 `#1..` |
| 12 | 文本与 JSON 引用一致 | **PASS** | RUNTIME（M1.2 采样的 `fullText` 里出现 `威胁：#1 青蛙…`；M1.4 样本的文本同源） |
| 13 | `total_found` 是真实候选数 | **PASS** | RUNTIME：145/146，远大于返回数（合理） |
| 14 | `total_returned` == 实际引用数 | **PASS** | RUNTIME：`totalsIssues=0` |
| 15 | `truncated` 表达准确 | **PASS** | RUNTIME：`returned<found` 时恒为 true |
| 16 | 单桶上限 12 生效 | **PASS（结构上）** | RUNTIME：food=12、resources=12 正好顶格；`M1.4-09`（UNIT）证明超限截断 |
| 17 | 总量上限 60 生效 | **NOT_OBSERVED（真机）** | 本场景总返回 24~28，没到 60；`M1.4-10`（UNIT）证明 |
| 18 | Delta `baseline` | **NOT_OBSERVED** | 采样窗口内没有换 session/shard；`M1.4-15/17/18`（UNIT） |
| 19 | Delta `added/changed` | **PASS** | RUNTIME：见 §5 轨迹（robin 飞入、frog 距离变化） |
| 20 | Delta `removed` 是否只报"真消失" | **FAIL** | RUNTIME：`twiggytree`/`carrot_planted`/`grass` 被报 removed，它们不会自己消失 → 截断误报（审计 Q2） |
| 21 | `scan.duration_ms` 有值 | **PASS（但有精度问题）** | RUNTIME：恒为 `0`（`U.now()` 是秒级，单次扫描 <0.5ms 被取整） |
| 22 | `scan.reused` / `scan.timestamp` | **PASS** | RUNTIME：复用与新建都能看到，频率 ≈4s |
| 23 | 引用安全：跨运行不撞号 | **PASS（代码级）** | UNIT：`tests/m1_4-runtime-id.test.mjs`；真机待重新进世界后看 `nearby.runtime_id` |
| 24 | F8 与 MCP 文本一致 | **PASS（函数级）** | UNIT：`M1.1-16`；真机：M1.2 采样 `textEqual=true` |
| 25 | MCP **网络**端到端 | **BLOCKED** | `127.0.0.1:18090` 本次未监听（DSH 插件没起 MCP 服务） |
| 26 | 双分片（Caves） | **NOT_RUN** | 本轮没下洞穴 |
| 27 | 上限/异常/复用等边界 | **PASS（UNIT）** | `tests/m1_4-nearby.test.mjs` 27 例 |

---

## 4. 实际观察到的分类（真机）

样本 A 末帧（145 个候选 / 返回 27）：

```
threats   = 2     青蛙（frog）
food      = 12    浆果丛/胡萝卜/蘑菇/地上的食物类
resources = 12    多枝树/常青树/草/树枝/花…
structures= 1     南瓜灯（0.13.1 起归到"建筑/光源"，之前被误判成资源）
containers/creatures/other = 0（本场景没有）
```

> 0.13.0 的同一场景里 `resources` 里混着红雀、`food` 里混着树枝——这两个错判已由 0.13.1 修掉，
> 本样本是修好之后的数据（`threats/food/resources/structures` 分布合理）。

---

## 5. Delta 真机轨迹（关键证据）

样本 A 的 15 次 delta 变化里，挑最说明问题的几条：

```
n111  added=[#19:robin]                          removed=[#26:twiggytree]        ← 树不会自己消失
n113  added=[#22:robin]                          removed=[#26:grass]             ← 草也不会
n120  added=[#12:twigs, #21:robin, #2:frog]      removed=[#18:robin, #14:carrot_planted]  ← 胡萝卜（种在地里）
n123  added=[]                                   removed=[#3:frog]               ← 之前还在"变化"的同一只青蛙
changed 多次出现 [#1:frog:distance] / [#2:frog:distance]                          ← 这是合理变化（怪在动）
```

判定：

- `changed=distance` 属于**正确**行为（怪确实在移动，阈值 1 格）。
- `removed` 里出现**不会移动的实体** → 只能是"被截断/排序挤出返回窗口"，属于**误报**（审计 Q2）。
- `added` 里出现 `#2:frog`（之前就在）→ 同理，是"重新挤进窗口"，不是新出现。

---

## 6. 性能（真机）

| 指标 | 真机值 | 说明 |
|---|---|---|
| nearby JSON 体积 | 4.4~5.0 KB（24~28 个实体） | 约 175 字节/实体；比沙箱 60 实体 9.8KB 同量级 |
| `scan.duration_ms` | 恒为 0 | 精度问题：`U.now()` 是秒级；建议扫描计时改用 `TheSim:GetRealTime()`（ms） |
| 扫描频率 | ≈4 秒 | 与 `OBSERVER_SCAN_SECONDS=4` 一致 |
| 状态写盘 | 1000 ms 中位数 | 与 `INTERVAL=1` 一致 |
| 复用比例 | 约一半帧是复用 | 采样 500ms vs 扫描 4s，符合预期 |

> 沙箱的 26ms **不能**当 DST 性能结论；真机这边单次扫描快于计时精度，只能说明"不慢"。

---

## 7. 证据文件

| 文件 | 内容 |
|---|---|
| `tests/artifacts/M1_4/m14-runtime-2026-11-12T16-00-57.json/.md` | 样本 A：117 帧、16 个快照、delta 轨迹、refs、桶计数、体积 |
| `tests/artifacts/M1_4/m14-runtime-2026-11-12T16-04-47.json/.md` | 样本 B：30 秒复核（同样的 delta 抖动模式） |
| `tools/m14-audit-probes.mjs` | 探针 A（截断→removed 误报）、探针 B（snapshot_id 跨运行撞号） |
| `tests/m1_4-nearby.test.mjs` | 27 个 UNIT 用例（分类/引用/上限/delta/复用/运行实例） |
| `tests/m1_4-runtime-id.test.mjs` | 2 个运行实例隔离用例 |

---

## 8. 本轮审计期间的版本变化（透明记录）

| 版本 | 内容 | 依据 |
|---|---|---|
| 0.13.0 | M1.4 交付（结构化 nearby） | 上次交付 |
| 0.13.1 | 修真机暴露的 3 个分类错判（树枝当食物、红雀/南瓜灯当掉落物） | 真机采样 |
| 0.13.2 | 引用安全：`snapshot_id` 加运行实例号、`refs` 只保留当前扫描、`Resolve` 只认当前实例 | 审计 Q3（安全洞） |

> 0.13.2 已装盘；**正在运行的世界仍是 0.13.1 内存镜像**，重新进世界后才会出现 `nearby.runtime_id`。
> 分类修正（0.13.1）在本次样本里已经生效。

---

## 9. 没做到的事（如实）

1. `status=empty` / `status=error` 的真机样本没拿到（本场景一直有实体，也没让扫描失败）——UNIT 已覆盖。
2. 总量上限 60 在真机没触发（场景只有 24~28 个返回）——UNIT 已覆盖。
3. `containers / creatures / other` 三个桶在真机上 `NOT_OBSERVED`。
4. MCP **网络**端到端 `BLOCKED`（18090 未监听）。
5. 双分片 `NOT_RUN`。
6. 真机 `nearby.runtime_id` 字段待重新进世界后补（代码与单测已就绪）。
