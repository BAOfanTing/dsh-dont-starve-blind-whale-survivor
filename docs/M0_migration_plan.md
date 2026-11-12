# M0 · 迁移计划（保留 / 合并 / 暂缓 / 归档）

> 配套文档：`M0_architecture_audit.md`（为什么）、`M0_api_validation.md`（能不能）、`M0_final_directory.md`（最后长什么样）
> 前提：架构审计里 §8 的 6 个决策按建议执行（D1 选 B 栈、D2 先文件桥、D3 先玩家角色、D4 `scripts/main` 移 legacy、D5 保留 F8、D6 归档 `survival/`）。
> 如果你改了其中任何一条，本表的对应行要跟着改。

---

## 0. 四条铁律

1. **不删除任何已能工作的代码**。处置只有三种：**保留**（留在主链）、**合并**（逻辑搬进新文件，原文件归档）、**暂缓**（留在仓库但不 import / 不启动）。
2. **每一步都要保持"能玩"**。迁移期间不许出现「模组加载了但世界起不来」或「插件更新后 AI 完全不动」。
3. **先减 import，再搬文件，最后删壳**。顺序反了会同时失去可运行版本和可回退版本。
4. **每个批次落地都必须有真机验收**，单测全绿不算完成（仓库历史已经证明：211 个测试全过时，真机上"位置永远是 (x,0)"和"捡东西没接出来"两个 P0 还活着）。

---

## 1. 处置总览

| 类别 | 数量 | 一句话 |
|---|---|---|
| ✅ **保留（主链）** | Lua 11 个 + Node 7 个 | 就是产品的骨架，只做内部重构 |
| 🔀 **合并（吸收进新模块）** | Lua 8 个 + TS 4 个包的核心 | 逻辑有用，文件位置不对/重复 |
| ⏸ **暂缓（保留不启用）** | Lua 2 个 + 特性 3 项 | 有价值但不在 M1 路径上 |
| 📦 **归档（移入 `legacy/`，不删）** | Lua 11 个 + TS 5 个包 | 被取代或从未接进产品链 |

---

## 2. Lua 侧清单（逐文件）

### 2.1 `scripts/whale/` —— 保留，做内部分层（B 栈内核）

| 文件 | 行数 | 处置 | 说明 |
|---|---|---|---|
| `json.lua` | 279 | ✅ 保留 | 纯 Lua JSON，游戏自带的不合规，别换 |
| `util.lua` | 232 | ✅ 保留 → 拆成 `sandbox.lua`（兼容头）+ `util.lua` | 现在每个文件都抄一遍兼容头，抽出来一处维护 |
| `observe.lua` | 368 | 🔀 拆分 → `observe/{player,world,nearby,warnings,index}.lua` + 新增 `refs.lua`、`map.lua` | 368 行里 4 个 section 已经天然分开；`#N`/delta/预算要加进去 |
| `actions.lua` | 1746 | 🔀 拆分 → `actions/{index,move,work,item,craft,container}.lua` | 只按"能独立测试的边界"切，不重写逻辑 |
| `macros.lua` | 266 | ✅ 保留（修 `:144-150` 的 `text` 未定义 bug） | 修 bug 后加进 `tools/registry` 的宏组 |
| `reflex.lua` | 184 | ✅ 保留 + **改走 lease** | 现在直接 `Whale.actions.Start`，必须改成先 `Lease.acquire("reflex")` |
| `bridge.lua` | 388 | 🔀 合并 → `transport/file.lua` + `transport/index.lua` | 主循环保留；分片标识、`since` ack 要加 |
| `hud.lua` | 323 | ✅ 保留（把顶层 `require widgets` 包 `pcall`） | 纯专用服务器上会因缺 UI 崩 |
| — | — | ➕ 新增 `lease.lua` / `log.lua` / `refs.lua` | 三者是 M1 的核心新增 |

### 2.2 `scripts/main/` —— 逐文件处置（这是收敛的主战场）

| 文件 | 行数 | 处置 | 去向 / 理由 |
|---|---|---|---|
| `player_observer.lua` | 137 | 🔀 合并 | 字段并进 `observe/player.lua`；它比 whale 版多 `is_ghost/userid/guid` |
| `inventory_observer.lua` | 140 | 🔀 合并 | 并进 `observe/player.lua`；它比 whale 版多 `uses/freshness/fuel/armor` 结构化字段 |
| `world_observer.lua` | 112 | 🔀 合并 | 并进 `observe/world.lua`；它比 whale 版多 9 种天气、月相、洞穴标识 |
| `entity_observer.lua` | 199 | 🔀 合并 | 并进 `observe/nearby.lua`；它的 10 类分级 + 半径夹取比 whale 版的硬编码好 |
| `threat_observer.lua` | 328 | 🔀 合并 | 拆成 `observe/threat.lua`（采集） + 复用 Node 侧 `analysis/threat.js`（评分）；**B 栈现在完全缺威胁观察** |
| `state_serializer.lua` | 196 | 🔀 合并 | 只吸收它的**字符预算逻辑**（`MAX_RECORD_CHARS=3500` + `shrink_nearby`）到 `observe/index.lua` 的预算器 |
| `observer_manager.lua` | 356 | 📦 归档 | 它的三路互拉（Tick/keepAlive/重建）是"定时器不可信"的补丁；文件桥单循环已覆盖 |
| `json_encoder.lua` | 265 | 📦 归档 | `whale/json.lua` 更完整（前者缺 `GLOBAL.error`） |
| `config.lua` | 58 | 📦 归档（思路保留） | 配置改成 `modinfo.lua` + `Whale.files` 常量 |
| `http_client.lua` | 164 | ✅ 保留 → `transport/http.lua` | 唯一验证过 QueryServer 的实现（串行队列 + 自实现超时 + 统一回调形状） |
| `connection.lua` | 133 | 🔀 合并 → `transport/http.lua` | 保留「online/degraded/offline + 2^n 退避」，删掉从未赋值的 `connecting` |
| `heartbeat.lua` | 131 | 🔀 合并 → `transport/http.lua` | 心跳就是一次 GET /hello |
| `telemetry.lua` | 188 | 🔀 合并 → `transport/http.lua` | 状态推送（sequence 幂等：成功才 +1，4xx 直接丢） |
| `commands.lua` | 400 | 🔀 合并 → `transport/http.lua` | **保留 27 个命令白名单 + 幂等思路**，把单槽去重改成 `since` 序号 |
| `net.lua` | 189 | 📦 归档 | 与 `http_client` 调度重复；三路互保的 `keepAlive` 由 `lease`+`log` 取代 |
| `action_executor.lua` | 896 | 📦 归档（**先抽 2 段**） | ① `ACTION_MAP`（27 个命令→JOBS 映射）并进 `tools/registry` 的命令名表；② `onActionReport/pollCompletion` 的「终态补发 + `unknown_completion`」逻辑并进 `transport/*` 的结果回执 |
| `probe.lua` | 188 | ⏸ 暂缓 → `debug/probe.lua` | 通信探针非常好用，保留但只在 `probe=true` 时跑 |
| `task_runner.lua` | 653 | ⏸ 暂缓 → `actions/tasks.lua` | 8 个任务模板有价值；**必须先修 `:466-468` 调不存在的 `Whale.actions.Stop`**，且要接 lease |
| `combat_executor.lua` | 1026 | ⏸ 暂缓 → `actions/combat.lua` | Kiting 真机验证过，是 `fight/flee` 的实现基础；M4 接入，**接入前必须先和 reflex 划清控制权** |
| `bws_config.lua`（生成物） | 15 | 📦 归档 | 含明文 token；只有 HTTP 通道需要，M2 前不需要存在 |

### 2.3 处置后的 `modmain.lua`

```lua
-- 只留一条链
modimport("scripts/whale/sandbox.lua")
modimport("scripts/whale/json.lua")
modimport("scripts/whale/util.lua")
modimport("scripts/whale/lease.lua")
modimport("scripts/whale/log.lua")
modimport("scripts/whale/refs.lua")
modimport("scripts/whale/observe/index.lua")
modimport("scripts/whale/actions/index.lua")
modimport("scripts/whale/macros.lua")
modimport("scripts/whale/reflex.lua")
modimport("scripts/whale/transport/index.lua")   -- file（默认）/ http（M2）
modimport("scripts/whale/hud.lua")

-- 可选（config 开关，默认关）
-- modimport("scripts/whale/actions/combat.lua")   -- M4
-- modimport("scripts/whale/actions/tasks.lua")    -- M4
-- modimport("scripts/debug/probe.lua")            -- 诊断
```

`scripts/main/` 整体 `git mv DontStarveWhaleSurvivor/scripts/main DontStarveWhaleSurvivor/legacy/scripts-main`，并在 `DontStarveWhaleSurvivor/legacy/README.md` 里写清「为什么归档、哪段逻辑搬到哪、怎么一行改回来」。

---

## 3. Node 侧清单

### 3.1 根 `lib/` —— 保留，成为唯一产品线

| 文件 | 行数 | 处置 |
|---|---|---|
| `lib/index.js` | 864 | ✅ 保留（DSH 装配层）。把里面「MCP 客户端调用 + 内置 AI 调度」抽到 `runtime/`，index 只做装配 |
| `lib/bridge.js` | 406 | 🔀 → `runtime/transport-file.js`（找目录/读状态/写指令那套是对的） |
| `lib/tools.js` | 558 | 🔀 → `tools/{registry,local,actions,macros}.js`（拆表与派发） |
| `lib/mcp-server.js` | 322 | 🔀 → `mcp.js`（改成调用 `tools/registry` 的唯一派发，不许有第二套执行） |
| `lib/agent.js` | 221 | 🔀 → `agent/loop.js` + `agent/provider.js`（吸收 TS 版更严格的循环） |
| `lib/client.js` | 315 | ✅ 保留（`tools/build-client.mjs` 的生成物，别手改） |
| `lib/mod-install.js` | 152 | ✅ 保留（自动装模组） |
| — | — | ➕ 新增 `runtime/server.js`、`runtime/transport.js`、`state/{snapshot,control}.js`、`analysis/*.js`、`memory/*.js` |

### 3.2 TS 五包 —— 吸收 → 归档

| 包 | 行数 | 处置 | 吸收什么 / 为什么归档 |
|---|---|---|---|
| `bridge/` | 962 | 📦 归档 | 「tail 日志」路线已被文件桥取代；**不要吸收**（它的 `LogTailer` 是纯浪费） |
| `game-bridge/` | 2 195 | 🔀 部分吸收 → 归档 | 吸收：`commands.ts` 的**命令生命周期（7 态 + 首回执为准 + 迟到结果标记 + 会话丢失判 `unknown_completion` 不重放）**、`control.ts` 的 **lease 判定 6 条拒绝码**、`routes.ts` 的 `stale_reason` 判定、`auth.ts` 的 timingSafeEqual。**只在 M2 启用 HTTP 通道时需要**；不吸收它的 13 条路由写法（进程内直接调函数更简单） |
| `mcp-server/` | 7 681 | 🔀 部分吸收 → 归档 | 吸收：①`src/survival/*` 9 个文件 3 023 行**纯计算决策层**（威胁评分/战斗准备度/逃跑方案/季节/Boss/优先级仲裁）→ `analysis/*.js`；②`tools/snapshot.ts` 的字段解析容错；③`bridge/client.ts` 的 TTL 缓存 + 并发合并 + 错误分类。**不吸收**：43 个工具的 schema（我们重建 ~25 个）、两套传输、6 个 resource、4 个 prompt（纯提示词） |
| `survival/` | 1 211 | 📦 归档 | 无入口、无人 import、硬编码 dry-run、9 态与 7 态无适配。**只吸收一个思路**：`ActionRegistry` 的「状态迁移合法性表 + RUNNING 超时 → `NEEDS_RECONCILIATION`」写进 `state/control.js` 的注释与单测 |
| `agent/` | 4 057 | 🔀 部分吸收 → 归档 | 吸收：①`llm/openaiProvider.ts`（433 行，DeepSeek + 本地兼容一份实现）；②`runtime/agentLoop.ts`（轮次/超时/工具不重试/reasoning 回传）；③`mcp/toolAdapter.ts` 的**白名单 + ajv 参数校验**（注意：`agent.ts:113-118` 用 `indexOf('{')` 解析工具返回文本的做法**不要抄**）；④`prompts/systemPrompt.ts` 的 8 条铁律（并进 `guide/规则.md`） |

### 3.3 归档后的仓库顶层

```
lib/                     ← 唯一 Node 产品代码（无构建步骤）
DontStarveWhaleSurvivor/ ← 唯一 Lua 模组（legacy/ 里放历史代码）
docs/                    ← 文档
tests/                   ← 根测试（新栈）
tools/                   ← install / build-client / probe 等脚本
legacy/                  ← 五个 TS 包 + scripts-main，保留可查，不参与运行
```

---

## 4. 测试迁移

| 现有测试 | 行数 | 处置 |
|---|---|---|
| `tests/lua-mod.test.mjs`、`tests/lua.test.mjs`（fengari 真跑 Lua + luaparse 语法） | — | ✅ **必须保留并加强**（这是唯一能在不打开游戏时发现"沙箱兼容头漏写"的机制） |
| `tests/tool-parity.test.mjs`（Lua 动作名 ↔ Node 工具名） | — | ✅ 保留，**扩成双向**：Node 暴露的每个工具必须能在 Lua 找到，Lua 注册的每个动作必须能被某个工具触达 |
| `tests/plugin.test.mjs`、`tests/install.test.mjs`、`tests/bridge.test.mjs`、`tests/mcp.test.mjs`、`tests/client.test.mjs` | — | ✅ 保留（B 栈自己的测试） |
| `tests/phase1-*.test.mjs`、`phase2-*.test.mjs`、`phase5-*.test.mjs`、`phase6-lua.test.mjs` | — | 🔀 随 `scripts/main` 一起移入 `legacy/tests/`；**只保鲜活的用例**（沙箱兼容、实体分类、威胁评分口径） |
| `*/test/*.ts`（31 个文件 7 988 行） | — | 📦 随包归档；其中 `mcp-server/test/p6.test.ts`（38KB，决策层口径）里的**测试数据**值得搬成 JS 版 `analysis/*.test.js` |
| — | — | ➕ 新增（M1 必须有）：`lease` 抢占/超时/人工接管；`refs` 快照过期；`snapshot` 预算裁剪；`transport` 幂等（同一 id 不重复执行） |

---

## 5. 执行批次（每批都可独立回退）

### 批次 A · 止血（不改结构，1 天内）

| 动作 | 文件 | 验收 |
|---|---|---|
| A1 修 `task_runner` 调不存在的 `Whale.actions.Stop` | `scripts/main/task_runner.lua:466` | 单测 + `stop_task` 真机停下正在砍的树 |
| A2 修 `macros.lua:144-150` 的 `text` 未定义 | `scripts/whale/macros.lua` | `chop_until` 失败时给出原因而不是 `nil` |
| A3 reflex 增加"不看战斗"的临时互斥（最小改动：`if BWS2.combat:is_active()` 直接 return） | `scripts/whale/reflex.lua` | 战斗中反射不再抢 `locomotor` |
| A4 状态 JSON 带 `shard`，Node 侧过滤 | `scripts/whale/bridge.lua` + `lib/bridge.js` | Master/Caves 同时跑时不再读到另一个世界 |
| A5 `drop` 的 `count` 参数被忽略 | `actions.lua:1105-1112` | 丢 N 个真的只丢 N 个 |

### 批次 B · 收敛（结构动刀，2~3 天）

| 动作 | 验收 |
|---|---|
| B1 `modmain` 只 import `scripts/whale/*`；`scripts/main` 整体移入 `legacy/` | 进世界正常、F8 能玩、单元测试全绿 |
| B2 抽 `sandbox.lua`（统一兼容头），所有文件只引用它 | 新增一个「全部 GLOBAL 为 nil」的沙箱回归测试 |
| B3 新建 `lease.lua`，`actions.Start` 第一行查租约；reflex/战斗/任务/人工全部走租约 | 并发用例：reflex 抢占期间 agent 指令被拒且状态里能看到"我自己干了什么" |
| B4 文件桥单循环接管原来三路互拉（删掉 `observer_manager/net` 的 keepAlive 调用） | 连续 10 分钟不再出现"停摆重建"日志 |

### 批次 C · 观测与寻址（3~5 天）

| 动作 | 验收 |
|---|---|
| C1 新建 `refs.lua`（`#N ↔ 实体 ↔ snapshot_seq`），`get_state` 文本输出编号 | 模型 `gather(ref="#4")` 能采到指定那丛草 |
| C2 状态加 `delta`（新出现/消失/移动/背包变化） | 状态文本出现"自上次：+木头×2" |
| C3 预算器：总字数 ≤6000，按距离裁剪，置 `trimmed` | 蜘蛛巢密集场景下状态不超预算且最近的威胁一定在 |
| C4 过期引用返回 `stale_ref` | 用上一次的 `#3` 调工具被拒并提示重新 `get_state` |
| C5 合并 `threat_observer` 的威胁字段 | 状态里出现"3 只蜘蛛（最近 4.2 格）正在追你" |

### 批次 D · 闭环与吸收（1~2 周，与 M3 重叠）

| 动作 | 验收 |
|---|---|
| D1 `lib/agent/*` 吸收 TS 的 provider + loop | 内置 AI 支持 DeepSeek/本地双端点、最大轮数、超时、取消 |
| D2 `tools/registry.js` 统一 25 个工具 + 三态结果 | `tool-parity` 双向测试绿；每个工具都有失败原因码 |
| D3 `analysis/*.js` 吸收 3 023 行决策层 | 与 `mcp-server/test/p6.test.ts` 的口径一致（搬测试数据校验） |
| D4 `state/control.js` 统一租约（Node 侧副本） | MCP 与内置 AI 不同时写；F7 = 人工接管 |
| D5 `memory/*` 分层 Notes + transcript | Notes 每条都有 `[看到]/[推断]`；transcript 能复盘一轮完整决策 |

### 批次 E · 暂缓项的复活条件

| 项 | 复活条件 |
|---|---|
| `actions/combat.lua`（原 `combat_executor`） | M4：`fight/flee` 工具定义完成后，且 reflex/combat 的租约用例通过 |
| `actions/tasks.lua`（原 `task_runner`） | M4：Node 侧任务工具名与 Lua 模板名对得上（现在 `taskTools.ts:15` 枚举缺 4 项，永远调不到季节任务） |
| `transport/http.lua`（QueryServer） | M2：`M0_api_validation.md` §6 的 9 项验证至少过 6 项；且需要「mod 主动推送」而不是「Node 轮询文件」时 |
| `debug/probe.lua` | 随时（诊断用，默认不启用） |
| 无主幸存者实体（新 prefab 方案） | M2 spike 通过（`doattack` 补丁 + 能砍树 + 客户端可见） |

---

## 6. 回退方案

| 批次 | 回退方式 |
|---|---|
| A | 单文件 `git checkout`（改动都很小） |
| B | `modmain.lua` 恢复 import `scripts/main` 即可（`legacy/` 里的文件路径不变，改一行 import 就回来） |
| C | `refs`/`delta`/预算都是**加法**，关掉 `modinfo` 的开关就回到旧输出格式 |
| D | Node 侧保留旧路径：`lib/index.js` 里 `RUNTIME=new|legacy` 一个开关，新 runtime 出问题就切回 |

**关键回退保障**：B 批之后，`modmain.lua` 里保留一段被注释掉的旧 import 列表，并在 `legacy/README.md` 写明恢复方法。任何人（包括未来的 AI 会话）都能一行改回来。

---

## 7. 明确不做的事

1. 不重写 `json.lua`、不换 JSON 库（游戏自带的不合规）；
2. 不把 `combat_executor.lua` 的 Kiting 重写一遍（真机验证过的逻辑很贵）；
3. 不在 M1 引入 HTTP 通道（文件桥够用，先证明闭环）；
4. 不保留两套工具表（哪怕名字不同也不能都留着让模型选）；
5. 不给 `legacy/` 里的代码做任何维护性改动（除了 A 批那 5 个 bug —— 它们修在**新位置**上，不是修在旧文件里）。
