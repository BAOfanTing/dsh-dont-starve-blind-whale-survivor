# M1.4 真机测试计划（nearby 结构化观察）

> 目标：用真实 DST 运行数据验收 M1.4 的「附近实体结构化观察」——不是用沙箱结果代替。
> 本阶段只读：采样工具只读状态文件，不发任何游戏动作。

---

## 1. 版本与安装（实测）

| 项 | 值 | 证据 |
|---|---|---|
| 源码版本 | **0.13.2**（0.13.0 交付 → 0.13.1 修真机分类 → 0.13.2 加引用运行实例防护） | `DontStarveWhaleSurvivor/modinfo.lua` |
| `modmain` 兜底版本 | 0.13.2（与 modinfo 一致，`tool-parity` 测试钉住） | `modmain.lua` |
| 实际安装目录 | `E:\SteamLibrary\steamapps\common\Don't Starve Together\mods\DontStarveWhaleSurvivor` | `node tools/install-mod.mjs` 输出 |
| 已装版本 | **0.13.2** | 已装目录的 `modinfo.lua` |
| `scripts/whale/nearby.lua` 是否在已装目录 | ✅ 在（含 `RUNTIME_ID`） | 安装后核对 |
| 游戏版本 | build **762172** | `<游戏>/version.txt` |
| 运行环境 | Windows 10 · Node v24.13.1 · 客户端进程在跑（`dontstarve_steam_x64`） | `Get-Process` / 状态文件 mtime |

> ⚠️ 安装 ≠ 运行：**正在运行的世界仍然持有它加载时的 Lua 内存镜像**。要验证 0.13.2 的新字段
> （`nearby.runtime_id`），必须**重新进一次世界**。采样报告里会明确标注样本到底来自哪个版本。

---

## 2. 采样工具

`tools/m14-watch.mjs`（新增，**只读**）：

```powershell
node tools/m14-watch.mjs --seconds 60            # 默认 500ms 采样一次，跑 60 秒
node tools/m14-watch.mjs --seconds 60 --interval 500 --out tests/artifacts/M1_4
```

它做什么（对应任务书第二部分的 20 条要求）：

| # | 要求 | 实现 |
|---|---|---|
| 1-4 | 只读、不发动作、不改生产代码/存档/配置 | 只调 `bridge.readState()` + `normalizeState()`，**从不调用 `bridge.call`** |
| 5-6 | 500ms、默认 60 秒 | `--interval` / `--seconds` |
| 7-8 | 记录原始 JSON 与文件 mtime | `runtime-*.json` 里的每帧 `t/ageMs`，另有 `statePath` |
| 9-10 | 按 `nearby.snapshot_id` 归并、识别 reused | `perSnapshot` + `reusedSeen/freshSeen` |
| 11-13 | 引用数量、桶数量、唯一性与连续性 | `refIssues`（重复 / 不连续 / 同快照内变动） |
| 14 | totals 自洽 | `totalsIssues`（returned 与 refs 数、returned≤found、truncated 一致性） |
| 15 | Delta 每次变化 | `deltaTimeline`（只在计数变化时记一条） |
| 16 | `scan.duration_ms` | `scanDurationMsSeen` |
| 17 | 同一 `snapshot_id` 内引用是否稳定 | `perSnapshot[].refsStable` |
| 18 | 新 `snapshot_id` 引用是否按规则更新 | 快照序列 + `refs` 集合逐帧记录 |
| 19 | JSON 解析错误要保留 | `parseErrors[]`（不静默） |
| 20 | 附近为空不算失败 | `statusCounts`（ok/empty/error/missing 分开） |

输出：`tests/artifacts/M1_4/m14-runtime-<时间>.json` + `.md`。

**不改 `tools/m12-watch.mjs`**：它是 M1.2 的验收工具，本次审计期间已 `git checkout` 恢复原状。

---

## 3. 真机运行步骤

1. 打开《饥荒联机版》→ 进入测试世界（洞穴可关；**不要按 F8**，避免内置 AI 执行动作）。
2. 走到有实体聚集的地方（草/树/浆果丛/猪人村），保持站立 30~60 秒。
3. 仓库根目录执行：
   ```powershell
   node tools/m14-watch.mjs --seconds 60
   ```
4. 顺手再切一次黄昏/夜晚（会看到火把/光源桶变化），或在有怪的地方站一会儿（威胁桶）。
5. 把 `tests/artifacts/M1_4/*.md` 里的结论贴回来。
6. （可选，验证运行时实例号）**退出世界 → 重新进入 → 再采一次**，比较两次的 `nearby.snapshot_id` 前缀。

---

## 4. 要检查的字段与通过条件

| 项 | 通过条件 |
|---|---|
| `nearby.status` | 三态可区分：`ok` / `empty`（扫描成功但空）/ `error`（扫描失败）。**empty ≠ error** |
| 七个桶 | 每个桶都是数组；实际观察到的类别要如实记录，没观察到就写 `NOT_OBSERVED` |
| `#N` | 唯一、连续（1..N）、同一快照内稳定、文本与 JSON 一致、新扫描重新编号 |
| `total_found / total_returned / truncated` | 自洽（returned ≤ found；truncated == returned<found；returned == 实际引用数） |
| Delta | `baseline` 只在首次/换 session/换 shard/上次失败时出现；其余 `ok`；**removed 不应包含仍然存在、只是被截断的实体**（当前**不满足**，见审计 Q2） |
| `scan.duration_ms` | 有数值（真机 < 1ms 会被取整成 0，见报告说明） |
| nearby JSON 体积 | 记录 min/median/max |
| 引用安全 | 重启后旧 `#N` 必须被拒绝（需要 0.13.2 + 重新进世界） |
| F8 / MCP | 同一快照、同一函数；**MCP 网络端到端**要 18090 在监听才算 |

---

## 5. 本计划**不能**验证的东西（先说清）

| 项 | 为什么 | 替代办法 |
|---|---|---|
| 单桶/总量上限被触发 | 真实世界不一定有 >60 个候选；不为了测试去刷实体 | 用 `M1.4-09/10/12` 的 UNIT 结果 |
| 三个未出现的桶（容器/生物/其它） | 测试场景里可能没有箱子/猪人 | 换场景再采，或标 `NOT_OBSERVED` |
| `nearby.runtime_id` 真机字段 | 需要 0.13.2 重新进世界 | 重新进世界后重采 |
| 跨重启的引用拒绝（真机） | 需要"重启 + 保留旧引用"的自动化客户端 | 沙箱 `tests/m1_4-runtime-id.test.mjs` 已覆盖；真机靠 `runtime_id` 字段存在性证明 |
| MCP 网络端到端 | 18090 本次未监听 | 先确认 `/status` 有响应再测 |
| 双分片（Caves） | 本轮没下洞穴 | 计划里标 NOT_RUN |
