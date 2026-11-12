# M1.2 · 真机冒烟测试报告

> 结论先说：**安装这一关通过了（0.10.0 → 0.12.1，A 栈残留已消失）；真机运行这一关 BLOCKED**——
> 这台机器上没有可交互的游戏客户端，专用服务器又缺 Klei 集群 token。
> 我没有用 Mock 冒充真机结论：`RUNTIME` 一栏只写真实文件/日志能证明的事，其余明确标 `BLOCKED` / `NOT_RUN`。
>
> 本轮还**真的抓到并修掉了 2 个 bug**（都只影响文案，附回归测试），版本 0.12.0 → **0.12.1**。

---

## 1. 版本与安装

| 项 | 值 |
|---|---|
| 源码版本（`modinfo.lua`） | **0.12.1**（本轮从 0.12.0 修复后升 patch） |
| `modmain.lua` 兜底版本 | 0.12.1（与 modinfo 一致，有单测钉住） |
| 安装前已装版本 | 0.10.0（34 个文件，含 `scripts/main/`） |
| **安装后已装版本** | **0.12.1**（17 个文件，无 `scripts/main/`） |
| 实际安装路径 | `E:\SteamLibrary\steamapps\common\Don't Starve Together\mods\DontStarveWhaleSurvivor` |
| DSH 使用的安装目录 | 同上（`lib/mod-install.js` 用 `findGameDirs()` 自动定位，插件与 `tools/install-mod.mjs` 走同一份代码） |
| 安装脚本行为（读过源码） | ①`rm -rf` 目标目录 → ②`cpSync(源, 目标, recursive)` → ③确保 `mods/modsettings.lua` 含 `ForceEnableMod("DontStarveWhaleSurvivor")`。**不碰存档、不碰 mod 配置** |
| 备份 | `.runtime/m12-backup-20261112-231904/`（34 个文件，安装前完整副本） |

**安装前后对照**（`tests/artifacts/M1_2/install-before.json` / `install-after.json`）：

| 检查项 | 安装前 | 安装后 | 判定 |
|---|---|---|---|
| installedVersion | 0.10.0 | **0.12.1** | ✅ |
| 文件数 | 34 | 17 | ✅（少了 A 栈 19 个，多了 config/actor） |
| `scripts/main/` 残留 | 存在 | **不存在** | ✅ 无 A 栈残留 |
| `scripts/whale/actor.lua` | 无 | **有** | ✅ |
| `scripts/whale/config.lua` | 无 | **有** | ✅ |
| `modmain.lua` 里 `modimport("scripts/main/…")` | 19 处 | **0 处** | ✅ 无 A 栈入口 |
| `mods/modsettings.lua` SHA256 | `66BC5786…20B09` | `66BC5786…20B09` | ✅ 未被改动（本来就已启用） |
| `Cluster_1` 文件数 | 75 | **75** | ✅ 存档未被触碰 |

> 证据类型：`STATIC`（安装脚本源码）+ 文件系统实测（前后 JSON）。**这不是 DST 运行时证据。**

---

## 2. 逐项结果（状态 + 证据类型 + 证据位置）

| # | 测试项 | 状态 | 证据 | 证据位置 |
|---|---|---|---|---|
| 1.1 | 源码 / 兜底 / 已装版本三方一致 | **PASS** | STATIC + 文件实测 | `tests/artifacts/M1_2/install-*.json` |
| 1.2 | 安装包含正确的 `scripts/whale/`（10 个文件） | **PASS** | 文件实测 | 同上（17 文件清单） |
| 1.3 | 旧 A 栈 `scripts/main/` 无残留 | **PASS** | 文件实测 | 同上 `hasScriptsMain=false` |
| 1.4 | 无任何旧 A 栈入口被 modmain 加载 | **PASS** | STATIC（代码扫描 0 命中）+ UNIT（`M1.1-19` 断言） | `tests/m1_1-actor-observer.test.mjs` |
| 1.5 | 安装不碰存档 / 用户配置 | **PASS** | 文件实测（`Cluster_1` 75→75；modsettings SHA 不变） | 同上 |
| 2.1 | 游戏客户端启动、进世界 | **BLOCKED** | —（无客户端进程；无法用 UI 进世界） | `docs/M1_2_blockers.md` §1 |
| 2.2 | 专用服务器替代方案 | **BLOCKED** | RUNTIME（真实启动日志） | `tests/artifacts/M1_2/dedicated-server-attempt{1,2}.log` |
| 2.3 | 模组加载无 Lua 编译/导入错误 | **NOT_RUN** | —（需要 2.1） | — |
| 2.4 | `bridge.boot()` 正常执行 | **NOT_RUN** | —（需要 2.1） | — |
| 2.5 | 无 `[BWS2]` 等 A 栈启动痕迹 | **PASS** | STATIC（运行链 0 命中，仅注释提到） | `tests/m1_1-actor-observer.test.mjs`（`M1.1-19`） |
| 2.6 | `GetClusterID()` 缺失时降级为 `null` + `unavailable`，不拿 session 冒充 | **PASS** | UNIT（沙箱分支覆盖） | `M1.1-10` |
| 3.1 | 进入世界后 `whale_state.json` 持续写入 | **BLOCKED** | 现存文件是 **0.10.0 写的旧格式**，不能当 0.12.1 的证据 | `runtime-*.json`（legacy） |
| 3.2 | 新格式字段齐全（18 项） | **PASS** | UNIT（管线自检：真 Lua 代码写 → 真 Node 代码读，30/30 项） | `tests/artifacts/M1_2/roundtrip-*.json` |
| 3.3 | 真实文件 JSON 完整可解析、无半截 | **PASS**（仅旧格式文件） | RUNTIME（真实游戏文件）+ UNIT | 同上 + `runtime-*.md` |
| 3.4 | 角色身份（`actor_id` / 类型 / prefab / alive） | **NOT_RUN**（真机）｜**PASS**（管线） | UNIT | `roundtrip-*.json` |
| 3.5 | `actor.userid` 在服务端玩家实体上是否存在 | **NOT_RUN** | —（必须真机；沙箱只证明"有就优先用"） | 见 blockers §3 |
| 3.6 | 世界信息（天/季/时段/温度/三围/背包/装备） | **NOT_RUN**（真机）｜**PASS**（管线） | UNIT | `roundtrip-*.json` |
| 3.7 | `data.day = cycles + 1` 口径 | **PASS** | UNIT | `roundtrip` 第 5 天（cycles=4）；`M1.1` 用例 |
| 3.8 | `TheWorld.meta.clock` 读不到时不拖垮快照 | **PASS** | UNIT（`world_configuration` 进 unavailable，快照仍 ok） | `M1.1-9`、`roundtrip` |
| 4.1 | `INTERVAL` 控制写盘间隔 | **NOT_RUN**（真机）｜**PASS**（代码绑定 + UNIT） | STATIC + UNIT | `bridge.lua` `WRITE_STATE`、`M1.1-12` |
| 4.2 | `OBSERVER_INTERVAL` 控制重采样、未到期标 `reused` | **NOT_RUN**（真机）｜**PASS**（逻辑） | STATIC + UNIT | `observe.BuildSample`、`m12-watch` 已能统计 `reused` 次数 |
| 4.3 | `OBSERVER_SCAN_RADIUS` / `SCAN_SECONDS` 生效 | **NOT_RUN**（真机）｜**PASS**（数组合法） | UNIT | `M1.1-12`（99→夹到 40；`nearby.radius=40`） |
| 4.4 | 非法/非数字/越界回退 | **PASS** | UNIT | `M1.1-12`（`"abc"`→默认 2） |
| 4.5 | 配置问题记录到 `problems` | **PASS** | UNIT | `config.clamp` 返回 note → `Whale.config.problems` |
| 5.1 | `readSnapshot()` 读对文件 | **PASS** | RUNTIME（真实旧文件）+ UNIT | `runtime-2026-11-12T15-23-31.json` |
| 5.2 | 新格式识别 | **PASS** | UNIT（管线自检 30/30） | `roundtrip-*.json` |
| 5.3 | 运行中 `fresh` / 停游戏后 `stale` | **PARTIAL** | `stale` 用**真实旧文件**验证过（age 3329s → stale=true）；`fresh` 只在管线与单测里验证 | 同上 |
| 5.4 | 旧 0.10.0 文件识别为 `legacy`、原样保留、标 stale、给提示 | **PASS** | RUNTIME（真实旧文件） | `runtime-*.md`：`schema=legacy / textSource=legacy / stale=true / "状态文件是老格式…"` |
| 5.5 | 不会把旧格式误判为新鲜新格式 | **PASS** | RUNTIME + UNIT | 同上（`M1.1-17`） |
| 6.1 | F8 与 MCP 的 text 逐字节一致 | **BLOCKED**（端到端）｜**PASS**（同函数） | UNIT + 只读实测 | `M1.1-16`；`m12-watch` 采样里 `textEqual=true`（同进程同文件） |
| 6.2 | `format=json` 可解析、字段不丢 | **PASS** | UNIT + 真文件 | `roundtrip-*.json`、`runtime-*.md`（`JSON 可解析：true`） |
| 7.1 | `session_id` 首次/重进世界对比 | **NOT_RUN** | —（需要进出世界两次） | blockers §2 |
| 7.2 | 重进后 `sequence` 行为、Node 不误判 | **NOT_RUN** | —（同上；代码层面已要求"先比 session/shard"） | blockers §2 |
| 7.3 | Master / Caves 双分片各自写入、不覆盖、读端不选错 | **NOT_RUN**（真机）｜**PASS**（逻辑） | UNIT | `M1.1-15`（故意把 Caves 排前面仍选 Master） |

---

## 3. 关键证据摘录

### 3.1 安装（真实文件）

```
installed：已装到 …\mods\DontStarveWhaleSurvivor（v0.12.1）
{ "sourceVersion": "0.12.1", "games": [{ "installed": true, "installedVersion": "0.12.1" }] }
```
装进去的脚本（17 个文件之一部分）：
`scripts/whale/{actions,actor,bridge,config,hud,json,macros,observe,reflex,util}.lua` —— 没有 `scripts/main/`。

### 3.2 专用服务器为什么起不来（真实日志）

`tests/artifacts/M1_2/dedicated-server-attempt1.log`：

```
[00:00:00]: Token file not found: APP:Klei//…/Cluster_M12/cluster_token.txt, success: F, len: 0
[00:00:04]: Unable to write to config directory. … CONFIG_DIR_WRITE_PERMISSION
[00:00:05]: [200] Account Failed (6): "E_INVALID_TOKEN"
[00:00:05]: !!!! Your Server Will Not Start !!!!
[00:00:05]: No auth token could be found.
```

试了两种配置（`offline_cluster=true` / `lan_only_cluster=true`）都是同一个结论：**专用服务器必须要有
Klei 账户签发的 `cluster_token.txt`**。你的 `Cluster_1` 里没有这个文件（客户端开世界不需要它），
我也没有去读/复用任何凭据。

### 3.3 现存状态文件（真实、但来自 0.10.0）

`tests/artifacts/M1_2/runtime-2026-11-12T15-23-31.md`：

```
状态文件：…\Cluster_1\Master\save\whale_state.json
schema：legacy ｜ textSource：legacy ｜ status：ok
新鲜度：age 3329 秒 ｜ stale=true
序列：781 → 781（回退 0 次）
身份：session=null / shard=null / cluster=null(unavailable)
观察对象：null
F8 与 MCP 文本一致：true ｜ JSON 可解析：true
错误：状态文件是老格式（没有 data.schema），字段可能不全
```

→ 证明：**旧文件不会被当成新鲜数据**、**legacy 兜底路径可用**、**两个入口读的是同一份**。
→ 不能证明：新格式在真实游戏里长什么样（那是 0.12.1 Lua 才会写的东西）。

### 3.4 管线自检（真 Lua 代码 → 真 Node 代码，30/30）

`node tools/m12-roundtrip.mjs`：

```
Lua 写出的 payload：1967 字节
检查项：30，失败：0
--- Node 从 Lua 数据渲染出的文本 ---
# 快照 s1 · 第5天 · 黄昏 · 秋季 · 12° · 状态 ok
你：沃利  生命 132/150  饥饿 118/150  理智 176/200
位置：(12,45)
手持：斧头(80%)  体温 22°
背包（3/15 格）：斧头(80%)、树枝 ×5、草 ×8
注意：
  - 快天黑了，先准备火把或火堆
附近（16 格内）：没什么值得注意的
```

逐项通过内容包括：`schema / status / session_id / shard_id / cluster_id=null / cluster_id_source=unavailable /
actor_id=player:KU_m12 / actor_id_kind=stable / actor_type / prefab / 格子坐标 (12,45) / 三围数值 /
temperature=21.5 / inventory 3/15 / hands=axe / day=5(cycles+1) / phase / season / world_temperature /
nearby.radius=16 / nearby.status=legacy / textSource=lua / 文本含角色名与坐标 / json 保留 unavailable_fields`。

---

## 4. 本轮发现并修复的问题（各附回归测试）

| # | 问题 | 现象 | 修复 | 回归测试 |
|---|---|---|---|---|
| 1 | 附近实体为空时文案误报"读不到" | 管线自检输出 `附近：暂时读不到（legacy）` —— 把"这套还是旧扫描"的标记当成了故障 | `observe.lua` `Render()`：只有 `status=="error"` 才说"读不到"；空桶时写"附近（N 格内）：没什么值得注意的" | `tests/m1_2-regressions.test.mjs` 回归1、回归2 |
| 2 | 新鲜文件的多余前缀 | 状态刚写完也输出 `（文件 0 秒前写过）`，属于噪音 | `lib/state/snapshot.js freshnessLine()`：`ageMs < 2000` 不输出文件年龄 | 同上，回归3（<2s 无前缀，8s 有提示） |

附带修正了 `tests/m1_1-actor-observer.test.mjs` 的 `M1.1-14`：它之前是靠上面那句噪音"碰巧通过"的，
现在改成用 `utimesSync` 把临时文件 mtime 真的往回拨 20 秒，走真实读取路径验证过期提示。

版本：`0.12.0` → **`0.12.1`**（`modinfo.lua` + `modmain.lua` 兜底值），并已重新安装进游戏目录。

---

## 5. 单元测试

| 时间点 | tests | pass | fail |
|---|---|---|---|
| M1.1 结束（基线） | 230 | 230 | 0 |
| M1.2 修完两个 bug + 新增 3 个回归用例 | **233** | **233** | **0** |

```
ℹ tests 233  ℹ pass 233  ℹ fail 0  ℹ duration_ms ~2.9s
```

新增文件：`tests/m1_2-regressions.test.mjs`（3 例）。

---

## 6. 产物清单（`tests/artifacts/M1_2/`，均已脱敏：无 Key / 无 token）

| 文件 | 内容 |
|---|---|
| `install-before.json` | 安装前：0.10.0 / 34 文件 / 有 `scripts/main` / modsettings SHA / Cluster_1 文件数 |
| `install-after.json` | 安装后：0.12.1 / 17 文件 / 无 `scripts/main` / actor+config 在 / modmain 0 处 A 栈 import |
| `dedicated-server-attempt1.log` / `attempt2.log` | 专用服务器两次尝试的真实日志（token 缺失，未能启动） |
| `roundtrip-*.json` | 管线自检 30 项逐条结果 + Lua 写出的 payload 头部 + Node 渲染文本 + JSON 视图 |
| `runtime-*.json` / `runtime-*.md` | `m12-watch.mjs` 采样：真实旧文件的 schema/新鲜度/身份/字段存在性/F8-MCP 一致性 |

---

## 7. 诚实声明

1. **没有一条 `RUNTIME` 结论来自 0.12.1**。现存 `whale_state.json` 是 0.10.0 写的，只能证明"读端向后兼容"。
2. **F8 实跑、进世界、双分片实测、Session 重进对比** 全部 `NOT_RUN` / `BLOCKED`，需要你在客户端里操作。
3. `m12-watch.mjs` 里的 `textEqual=true` 是**同一进程、同一文件**的两次调用结果，属于"同一函数"证据，
   不是"F8 与 MCP 两个真实客户端"的端到端证据（后者需要游戏 + 两个入口同时在线）。
4. 三个 A 栈 Node 服务（18788 / 8790 / 8791）仍在运行，它们是历史遗留进程，**B 栈不使用**；
   报告里没有把它们当成"MCP 端到端"的证据（B 栈 MCP 是 18090，本次未监听）。
