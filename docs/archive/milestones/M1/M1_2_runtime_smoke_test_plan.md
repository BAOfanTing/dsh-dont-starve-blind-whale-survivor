# M1.2 · 真机冒烟测试计划

> 目的：验证 M1.1 的（Actor Provider / 结构化 Observer / 统一快照读取）在**真实运行**下的表现。
> 本阶段不新增功能，只验收；发现问题按「记录 → 定位 → 最小修复 → 补回归测试」处理。
> 计划制定时间：2026-11-12 23:19 ~ 23:25（Asia/Shanghai）

---

## 1. 测试环境

| 项 | 实际值 | 来源 |
|---|---|---|
| 操作系统 | Windows 10 家庭中文版 | `Win32_OperatingSystem` |
| CPU / 内存 / 磁盘 | i5-12400F（12 逻辑核）/ 空闲 38 GB / E: 空闲 343 GB | `Win32_Processor`、`Win32_OperatingSystem`、`Get-PSDrive` |
| Node | v24.13.1 | `node --version` |
| 游戏 | 《饥荒联机版》build **762172** | `<游戏>/version.txt` |
| 游戏目录 | `E:\SteamLibrary\steamapps\common\Don't Starve Together` | `lib/bridge.js findGameDirs()` |
| 存档根 | `C:\Users\BAOfanTing\OneDrive\文档\Klei\DoNotStarveTogether\893016408` | 实测 |
| 现有世界 | `Cluster_1`（**测试期间只读，不写入**） | 实测 |
| 游戏客户端进程 | **未运行**（无 `dontstarve_steam_x64.exe`） | `Get-Process` |
| 遗留进程 | 6 个 `dontstarve_dedicated_server_nullrenderer_x64`（无法读命令行，工作集 0 MB） | `Get-CimInstance Win32_Process` |
| 遗留 A 栈 Node 服务 | `:18788` game-bridge（21:46 启动）、`:8790` mcp-server（22:19）、`:8791` agent（19:51） | `Get-NetTCPConnection` |
| B 栈 MCP 端口 18090 | **未监听**（DSH 插件本次会话没起 MCP） | `Get-NetTCPConnection` + `GET /status` 超时 |

**结论（环境层面）**：没有可交互的游戏客户端，也没有能连上 MCP 的 B 栈服务实例。
因此"进世界 / F8 实跑 / MCP 端到端"这三类只能标记 `BLOCKED`，而不是用 Mock 代替（见报告与 blockers）。

---

## 2. 测试工具

| 工具 | 作用 | 是否只读 |
|---|---|---|
| `node tools/install-mod.mjs` | 把 `DontStarveWhaleSurvivor/` 装进 `<游戏>/mods/`，并保证 `mods/modsettings.lua` 里有 `ForceEnableMod` | 写 `mods/`（**不碰存档**） |
| `node tools/m12-watch.mjs --seconds N` | M1.2 新增：在你玩游戏时只读采样状态文件（写盘间隔、sequence、reused、身份、actor、玩家、世界、新鲜度、F8/MCP 文本一致），产出 `tests/artifacts/M1_2/runtime-*.json/.md` | **只读**（从不调用 `bridge.call`，不发动作） |
| `node tools/m12-roundtrip.mjs` | M1.2 新增：管线自检 —— 用**真实的 0.12.x Lua 代码**（fengari）生成状态文件内容，交给**真实的 Node 读取代码**解析，逐字段比对 | 只读（临时目录） |
| `node --test "tests/*.test.mjs"` | 全部单元测试（233 项） | 只读 |
| 专用服务器（`bin64\dontstarve_dedicated_server_nullrenderer_x64.exe` + `-conf_dir <临时目录>`） | 想在没有客户端的情况下拿到真实运行数据 | 只在 `%TEMP%` 自建集群；失败见 blockers |

---

## 3. 测试步骤与预期

### 阶段 1 · 安装版本（必须最先做）

1. 记录源码版本（`modinfo.lua` + `modmain.lua` 兜底值）。
2. 记录已装版本、文件数、是否存在 `scripts/main/`、`mods/modsettings.lua` 的 SHA256、`Cluster_1` 文件数。
3. **备份**已装模组到 `.runtime/m12-backup-<时间>/`。
4. 读安装脚本源码，确认它只做两件事：覆盖 `mods/DontStarveWhaleSurvivor/`、往 `mods/modsettings.lua` 追加一行。
5. 执行安装，再记录一次全部指标。

**预期**：installedVersion == 源码版本；文件数从 34 降到 17（`scripts/main` 19 个文件不再随包分发）；
`scripts/main` 不存在；`actor.lua` / `config.lua` 存在；`modsettings.lua` SHA 不变（本来就已启用）；
`Cluster_1` 文件数不变。

### 阶段 2 · 真机启动

启动客户端 → 进测试世界 → 看 `server_log.txt`：
Mod 加载成功、无 Lua 编译/导入错误、`bridge.boot()` 正常、无 `[BWS2]`（A 栈已归档）、无持续报错。

**预期**：日志里只有 `[大肥鱼饿不死] 文件桥已启动（服务端）…`；`TheNet:GetClusterID()` 不存在时
`data.identity.cluster_id = null` 且 `cluster_id_source = "unavailable"`（**不允许拿 session 冒充**）。

### 阶段 3 · 状态文件

定位 `whale_state.json`，检查：是否持续更新、JSON 是否完整可解析、有没有半截/空文件；
新格式字段是否齐全（`schema / snapshot_id / sequence / timestamp / session_id / cluster_id /
cluster_id_source / shard_id / status / actor_id / actor_type / actor_prefab / player / world /
inventory / equipment / unavailable_fields / errors`）；`actor_id` 是否 `player:<userid>` 或有 userid 时降级为
`transient`；世界信息（天/季节/时段/温度/三围/背包/装备）是否与游戏画面一致；`data.day` 是否 = `cycles + 1`。

### 阶段 4 · 配置与采样

用 `m12-watch.mjs` 观察：写盘间隔是否接近 `INTERVAL`；`OBSERVER_INTERVAL` 未到期时是否标 `reused=true`；
`sample_age_ms` 是否随之增长；附近扫描是否按 `OBSERVER_SCAN_SECONDS` 命中缓存；
配置非法/越界时是否回退默认并记进 `Whale.config.problems`。

### 阶段 5 · 快照与新鲜度

运行中：`schema=bws.state/1`、`sequence` 递增、`age_ms` 与实际文件年龄一致、`stale=false`。
退出世界：文件不再更新 → `stale=true` 且文本首行提示。
旧格式（0.10.0 文件）：`schema=legacy` / `textSource=legacy` / 有明确提示 / 不当成新鲜数据。

### 阶段 6 · F8 与 MCP 一致性（重点）

同一时刻、同一世界、同一角色：
- `get_state` text：两条入口返回**逐字节相同**；
- `get_state format=json`：可解析、字段完整、不丢 `unavailable_fields` / `errors`。

**安全前提**：只走只读路径，不触发采集/建造/战斗。

### 阶段 7 · Session 与 Shard

记录首次进世界的 `session_id`、`sequence` 起点；退出重进后 `session_id` 是否变化、`sequence` 是否归零；
Node 比较快照时必须先比 session/shard，不能只比 `sequence`。
若进洞穴：Master / Caves 各自 `shard_id` 正确、互不覆盖、Node 不选错。

---

## 4. 判定规则（写在前面，避免事后解释）

每个测试项只允许四种状态：

| 状态 | 含义 |
|---|---|
| `PASS` | 有实际证据证明符合预期 |
| `FAIL` | 有证据证明不符合预期 |
| `BLOCKED` | 环境/权限不允许执行（例如没有游戏客户端、没有集群 token） |
| `NOT_RUN` | 本轮没有执行（条件具备但没做） |

每条结论必须标注证据类型，且**不得升级**：
`STATIC`（静态代码）< `UNIT`（单测/沙箱）< `RUNTIME`（真实 DST 日志/文件）< `END_TO_END`（游戏→F8/MCP 的完整调用）。

---

## 5. 安全约束（本阶段实际遵守的）

1. 不修改 `Cluster_1` 的任何文件；安装前后核对文件数（75 → 75）。
2. 安装前备份已装模组（`.runtime/m12-backup-20261112-231904`，34 个文件）。
3. 专用服务器只在 `%TEMP%\bws-m12-runtime` 自建临时集群里尝试，失败后连同临时目录一起清理。
4. `m12-watch.mjs` / `m12-roundtrip.mjs` 都是只读：不调用 `bridge.call`，不给游戏发任何动作。
5. 报告与产物里不出现 API Key / token / 账号凭据。
