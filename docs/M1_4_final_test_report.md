# M1.4 最终测试报告（收尾轮）

> 版本：0.13.3 → **0.13.4**（`scan.duration_ms` 计时精度）
> 游戏：build 762172；真机采样期间客户端在跑（`Cluster_1` / Master / session `5F056B29DE65C542` / shard `1`）
> 命令：`node --test --test-force-exit "tests/*.test.mjs"`

---

## 1. 测试数量

| 阶段 | tests | pass | fail |
|---|---|---|---|
| 进入本轮前（0.13.3） | 267 | 267 | 0 |
| + 计时测试（7） | 274 | 274 | 0 |
| + watcher 统计口径（7） | 281 | 281 | 0 |
| + Node fallback（10） | **291** | **291** | **0** |

新增三个测试文件：

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `tests/m1_4-scan-timing.test.mjs` | 7 | os.clock / GetRealTime / 都不可用 / 返回值异常 / 时钟源不一致 / 扫描失败 / 复用不虚构 |
| `tests/m14-watch-counters.test.mjs` | 7 | 轮询去重、快照去重、reused/fresh 计数、重启后 sequence 归零、无 runtime 的回退、解析错误、empty 不是 error |
| `tests/m1_4-fallback.test.mjs` | 10 | 新对象结构 / 旧数组结构 / empty / error / 缺失 / #N 一致 / previous_ref 不当引用 / not_returned 无 ref / Node 不改 Delta / Lua text 优先 / legacy 文件 |

既有 267 例（含 Delta 截断修复的 5 例、运行实例隔离 2 例、真机分类回归 5 例）全部保持通过。

---

## 2. 其它自检

| 项 | 结果 | 证据类型 |
|---|---|---|
| Lua → Node 管线自检（`tools/m12-roundtrip.mjs`） | **32 / 32** | UNIT |
| 审计探针 A（截断是否误报 removed） | `removed_count=0`（修复保持） | UNIT |
| 审计探针 B（运行实例隔离） | 旧实例引用被 `stale_snapshot` 拒绝 | UNIT |
| 修复前后对比（`tools/m14-delta-compare.mjs`） | 前：added=1/removed=1；后：added=0/removed=0/notReturned=1 | UNIT |
| 全量单测 | **291 / 291** | UNIT |

---

## 3. 真机结果（RUNTIME）

### 3.1 样本清单（本轮相关）

| 样本 | 运行版本（推断） | 用途 |
|---|---|---|
| `m14-runtime-2026-11-12T16-22-23.*` | 0.13.3 | n11 明细来源 |
| `m14-runtime-2026-11-12T16-34-10.*` | 0.13.3 | ①新的缓存统计口径 ②玩家坐标 ↔ removed 相关性 |

### 3.2 16:22 样本（n11 所在）

| 项 | 值 |
|---|---|
| nearby 三态 | ok=117 / empty=0 / error=0 |
| 扫描快照 | 15 个（`…-n10` … `…-n24`），同一快照内引用稳定 |
| 引用问题 / totals 问题 / 解析错误 | 0 / 0 / 0 |
| 写盘中位数 | 999.65 ms |
| nearby JSON 中位数 | 5915 字节（max 9559） |
| `scan.duration_ms` | **[0]**（0.13.3 的秒级计时 → 说明当时还没修，符合预期） |
| n11 delta | added=0 / removed=12 / changed=22 |

### 3.3 16:34 样本（新统计口径 + 移动相关性）

| 项 | 值 |
|---|---|
| 轮询 / 唯一文件版本 / 重复轮询 | **49 / 30 / 19** |
| reused 版本 / 新扫描版本 / 复用率 | **14 / 16 / 0.467** |
| 去重键 | `session+shard+runtime+sequence` |
| 扫描快照 | 7 个（`…-n187`…`…-n193`） |
| `scan.duration_ms` | **[0]**（当前世界内存仍是 0.13.3 → 等重进世界） |
| nearby 体积 | min 5784 / median 6281 / max 10259 字节 |
| 玩家坐标 ↔ removed | 静止时 removed 0~7；走 3.2 格 → removed 26；走 3.6 格 → removed 37 |

### 3.4 逐项状态

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| 1 | nearby 三态 ok | PASS | RUNTIME |
| 2 | empty / error 真机样本 | NOT_OBSERVED（场景一直有实体、没让它失败） | — |
| 3 | 七桶结构（对象 + 数组型桶） | PASS | RUNTIME |
| 4 | 实际观察到的桶 | threats / food / resources / structures / creatures | RUNTIME |
| 5 | 未观察到的桶 | containers / other = NOT_OBSERVED | — |
| 6 | 引用唯一 / 连续 / 同快照稳定 | PASS | RUNTIME（`refIssues=0`，refsStable 全 true） |
| 7 | totals 自洽 | PASS | RUNTIME（`totalsIssues=0`） |
| 8 | Delta 语义（n11） | PASS（间接） | RUNTIME + STATIC（6/12 明细可见，其余证据不足） |
| 9 | 缓存统计口径（新） | PASS | RUNTIME（49/30/19、14/16） |
| 10 | `scan.duration_ms` 新实现 | **NOT_RUN（待重进世界）** | — |
| 11 | `scan.duration_source` 字段 | NOT_RUN（真机）／PASS（UNIT 7 例） | — |
| 12 | Node fallback nearby | PASS（UNIT 10 例） | UNIT |
| 13 | F8/MCP 共用 `readSnapshot()` | PASS（函数级） | UNIT（M1.1-16） |
| 14 | MCP 网络端到端 | **BLOCKED**（18090 未监听） | — |
| 15 | 双分片 Caves | **NOT_RUN** | — |

---

## 4. 性能数字（本轮的诚实口径）

| 指标 | 真机 | 说明 |
|---|---|---|
| `scan.duration_ms` | 仍为 0 | **不是**"扫描 0ms"，而是"运行中的世界还没加载 0.13.4" |
| `duration_source` | 缺席 | 同上 |
| nearby JSON | 5.6~10.3 KB（27~34 个返回实体） | 与沙箱 60 实体 9.95 KB 同量级 |
| 写盘间隔 | 996~1000 ms | 与 `INTERVAL=1` 一致 |
| 扫描节奏 | ≈4 s（15 个快照 / 60 s） | 与 `OBSERVER_SCAN_SECONDS=4` 一致 |

> 沙箱里的 `[perf] 60 实体：JSON 9954 字节、观察 26ms` 是 **UNIT**，不能当 DST 性能结论。

---

## 5. 版本与安装

| 项 | 值 |
|---|---|
| 源码版本 | **0.13.4** |
| `modmain` 兜底版本 | 0.13.4（一致，`tool-parity` 钉住） |
| 已装版本 | **0.13.4**（`node tools/install-mod.mjs` 输出） |
| 修改范围 | Lua 计时（nearby.lua）+ Node fallback（snapshot.js）+ 工具（m14-watch/counters）+ 测试 + 文档 |
| 未修改 | `m12-watch.mjs`（与 HEAD 一致）、`mcp-server`/`agent`/`game-bridge`、存档、modsettings.lua、任何 Key |

---

## 6. 尚未证明的事（列出，不含糊）

1. **0.13.4 的真机 `duration_ms`**：需要你重进一次世界；届时 `duration_ms` 应是 `0.x`、`duration_source="os.clock"`。
2. **n11 的 6 条 removed / 16 条 changed 明细**：当时采样器只存前 6 条（本轮已改为存全量），无法逐条断言。
3. **`status=empty` / `status=error` 的真机样本**：未观察到（UNIT 覆盖）。
4. **MCP 网络端到端**：18090 未监听（DSH 插件本次没起 MCP 服务）。
5. **双分片 Caves**：未进洞穴。
