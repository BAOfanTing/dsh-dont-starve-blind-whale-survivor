# M1.0 · 迁移报告：B 栈唯一运行

> 里程碑：M1.0（只做代码隔离与归档，**不开发新的 Observer 功能**）
> 结论：**A 栈（Phase 1~6 那套）的运行入口已全部断开，B 栈（`scripts/whale` + 根 `lib/`）成为唯一主线；代码 0 删除，全部归档；211 个既有单测仍然全过。**
> 日期：2026-11-12 · 模组版本 0.10.0 → **0.11.0**

---

## 0. 验收对照（第十二节 13 项）

| # | 要求 | 结果 | 证据 |
|---|---|---|---|
| 1 | 只有 B 栈正式启动 | ✅ | `modmain.lua` 只 `modimport` 8 个 `scripts/whale/*`，有单测钉住 |
| 2 | A 栈不再控制角色 | ✅ | `scripts/main/` 已移出模组目录；`whale/bridge.lua` 里 3 处反向拉 A 栈的钩子已删 |
| 3 | F8 仍然可用 | ✅（静态验证） | F8 走的是客户端 HUD → `whale_toggle.json` → `lib/index.js` → `lib/agent.js` → `lib/tools.js` → 文件桥，整条链**不含任何 A 栈文件** |
| 4 | 游戏状态来自真实游戏 | ✅（历史证据 + 读取冒烟） | 本次读到真实 `Cluster_1/Master/save/whale_state.json`（伏笔：该文件是 1951 秒前的，即游戏当前没开） |
| 5 | Observer 读取正确的目标角色 | ⏳ M1.1~M1.2 | 现在仍是 `Whale.util.player()`；尚未改成 Actor Provider（本轮不做） |
| 6 | 背包数据准确 | ⏳ M1.2 | 同上 |
| 7 | 世界信息准确 | ⏳ M1.3 | 同上 |
| 8 | 附近资源和生物准确 | ⏳ M1.4 | 同上 |
| 9 | 实体引用有效期正确 | ⏳ M1.4 | 尚未实现 `#N` 引用 |
| 10 | 局部地图能够正确生成 | ⏳ M1.5 | 尚未实现 |
| 11 | 文件桥或 QueryServer 通信可靠 | ⏳ M1.6（9 项实测） | 本轮只做了"能读到真实文件"的冒烟，没做 9 项真机验证 |
| 12 | 没有明显重复扫描和性能问题 | ✅（结构上） | 现在只剩一套观察器（`whale/observe.lua`）；扫描参数 12 格 / 每类 5~6 条不变 |
| 13 | 211 个既有单测仍然通过 | ✅ 211/211 | 见 `docs/M1_0_test_report.md` |
| 14 | 旧代码没有被删除 | ✅ | 59 个文件走 `git mv`（历史可追），0 删除 |

**一句话**：M1.0 = ✅。M1.1~M1.6 的验收项（5~11）本轮**按计划不做**，不冒充完成。

---

## 1. 审计：两套系统到底怎么启动的

### 1.1 `modmain.lua` 原样（M1.0 之前）

```lua
-- 55-64：B 栈 8 个
modimport("scripts/whale/json.lua") … observe, actions, macros, reflex, bridge, hud
-- 68-94：A 栈 19 个 + 1 个生成文件
modimport("scripts/main/json_encoder.lua") … player/inventory/world/entity/threat_observer,
         state_serializer, observer_manager,
pcall(modimport, "bws_config.lua")   -- 含 token 的生成文件
modimport("scripts/main/config.lua") … http_client, connection, heartbeat, telemetry,
         commands, action_executor, net, probe, task_runner, combat_executor
-- 104-121：AddGamePostInit 里
Whale.bridge.boot()                 -- B 栈
BWS.observer.Start()                -- A 栈观察器
BWS2.net.start()                    -- A 栈 HTTP 心跳/状态推送
BWS2.probe.start()                  -- A 栈通信探针
-- 123-128：AddPlayerPostInit 里
Whale.bridge.boot(); Whale.bridge.on_player(inst); BWS.observer.Start()
```

**关键事实**：A 栈不是"被动等待调用"的库，它**自带启动**——`AddGamePostInit` 里三行 `start()` 一跑，
它就开始：①每 `interval` 秒扫一遍实体并写 JSON 到日志；②向 `127.0.0.1:18788` 发心跳、推状态、拉命令；
③拉到命令就调 `Whale.actions.Start`（`action_executor.lua:440`）或自己起原生战斗（`combat:TryAttack`）。
所以删掉 import 就等于彻底断开，**不需要再改别的地方**。

### 1.2 反向耦合（这次一并拆掉）

`scripts/whale/bridge.lua` 里有 3 处反向拉 A 栈（A 栈没了它们就是死代码，但留着会误导"谁在调谁"）：

| 位置（原行号） | 作用 |
|---|---|
| `Report()` 内 133-139 | 把动作结果转发给 A 栈的 `actionExecutor.onActionReport` / `tasks.OnActionResult` |
| `server_tick()` 内 264-269 | 每个 0.2s tick 顺手调 `BWS2.net.keepAlive()` 与 `BWS.observer.KeepAlive()`（三路互守） |

两处都已删除，并在原位留下注释说明"原来是什么、为什么没了"。**B 栈现在对 A 栈 0 引用**（有单测钉住）。

### 1.3 F8 属于哪条链：**B 栈**

```
游戏客户端  hud.lua（TheInput:AddKeyHandler，F8/F7）
   └─ 写 whale_toggle.json / whale_io_toggle.json（{ai:bool, stop:bool, ts}）
DSH 插件    lib/index.js 每 500ms bridge.readToggle()
   ├─ stop=true  → runner.stop('按 F7 停手了') + bridge.call('stop')
   └─ ai=true    → runner.start() → lib/agent.js AiRunner → lib/tools.js executeTool
                                → lib/bridge.js call() 写 whale_cmd.json / whale_io_cmd.json
游戏服务端  scripts/whale/bridge.lua 0.3s 轮询 → Whale.actions.Start → BufferedAction/locomotor
```
**链路上没有任何 `scripts/main/*` 文件。** 也就是说：F8 从头到尾没碰过 A 栈。

### 1.4 MCP 的实际调用链：**也是 B 栈**

```
外部 MCP 客户端 → POST http://127.0.0.1:18090/mcp
   → lib/mcp-server.js handleMcpPost（手写 JSON-RPC：initialize/ping/tools/list/tools/call）
   → lib/tools.js toolList() / executeTool()（35 个工具同一份表）
   → lib/bridge.js（同一个文件桥）
```
`lib/mcp-server.js` **不 import 任何 A 栈包**；`lib/*.js` 全仓只 import `node:*` 和彼此。
A 栈那套 MCP（`mcp-server/` :8790，43 个工具）要连的是 `game-bridge/` :18788，
而 `game-bridge` 的输入来自 Lua 的 `scripts/main/*`——Lua 侧一断，它自然就没数据了（本轮不启动它，也没删它）。

### 1.5 依赖检查（归档前）

| 检查项 | 结果 |
|---|---|
| 有没有 Node 代码 `import` 根 `bridge/`？ | ❌ 没有（`mcp-server/src/bridge/client.ts` 是它自己的内部目录，同名不同物） |
| 有没有 Node 代码 `import` 根 `survival/`？ | ❌ 没有（`mcp-server/src/survival/*` 是它自己的内部目录，**必须保留**，已确认未动） |
| 根 `package.json` 有 workspaces 吗 | ❌ 没有，所以移动子包不影响依赖解析 |
| `modmain` / 其他 Lua 有没有 `require` 绝对路径到 `scripts/main` | ❌ 没有（全部 `modimport("scripts/main/…")`，已随 import 一起删） |
| 构建/启动脚本有没有引用 | ✅ 有 2 个：`install-bridge.ps1`、`start-bridge.ps1` → 已改指向 `archive/phase-a/bridge` 并加"已归档"提示 |
| 测试有没有引用 | ✅ 有 15 个测试文件按路径加载 `scripts/main/*` → 已改成从 `archive/phase-a` 加载（见测试报告） |

---

## 2. 移动 / 保留 / 禁用清单

### 2.1 移动（`git mv`，历史可追，0 删除）

| 原路径 | 新路径 | 文件数 | 为什么 |
|---|---|---|---|
| `DontStarveWhaleSurvivor/scripts/main/` | `archive/phase-a/scripts/main/` | 19 | A 栈 Lua：HTTP 通信 + 观察器 + 命令执行 + 战斗 + 任务链 |
| `bridge/` | `archive/phase-a/bridge/` | 10（src+test） | Phase 1「读日志」路线，早已被文件桥取代 |
| `survival/` | `archive/unused-survival/` | 24（src+test） | 孤儿包：无 `index.ts`、无 `start`、无人 import、执行侧硬编码 dry-run |

> 说明：`archive/**/node_modules/` 与 `archive/**/dist/` 已加进 `.gitignore`（构建产物不入库）。

### 2.2 保留（原处不动）

| 路径 | 状态 | 备注 |
|---|---|---|
| `mcp-server/src/survival/`（3023 行决策层） | **保留** | 明确要求保留；它是 `mcp-server` 的内部目录，与根 `survival/` 无关 |
| `mcp-server/`、`agent/`、`game-bridge/` | 保留（不启动） | A 栈剩余三包，M1.x 再逐个吸收/归档 |
| `DontStarveWhaleSurvivor/scripts/whale/`（8 文件） | 保留 | 唯一主线，本轮只删了 `bridge.lua` 里 3 处 A 栈钩子 |
| `DontStarveWhaleSurvivor/guide/`、`lib/*.js`、`tests/`、`tools/` | 保留 | — |
| `DontStarveWhaleSurvivor/bws_config.lua`（含 token，已 gitignore） | 保留但不加载 | A 栈的 token 文件；M2 若启用 HTTP 通道再处理 |

### 2.3 禁用的入口（这是 M1.0 的实质）

| 入口 | 原来 | 现在 |
|---|---|---|
| `AddGamePostInit` | B 栈 boot + `BWS.observer.Start()` + `BWS2.net.start()` + `BWS2.probe.start()` | **只有** `Whale.bridge.boot()` |
| `AddPlayerPostInit` #1 | boot + on_player + `BWS.observer.Start()` | boot + on_player |
| `AddPlayerPostInit` #2（death） | `Whale.actions.Abort` + `BWS2.combat.ForceStop` | 只有 `Whale.actions.Abort("你死了")` |
| `scripts/whale/bridge.lua` → A 栈转发 | 3 处 | 删 |
| `modimport("scripts/main/*")` × 19、`bws_config.lua` | 全部加载 | 全部不加载（modmain 里留注释指向 archive） |

---

## 3. 归档后的实际目录

```
仓库根
├─ DontStarveWhaleSurvivor/           ← 装进游戏的就是这个（少了一层 scripts/main，体积明显变小）
│  ├─ modinfo.lua   version = "0.11.0"
│  ├─ modmain.lua   8 个 modimport + 3 个 postinit + HUD 挂载
│  ├─ bws_config.lua（gitignore，不加载）
│  ├─ guide/*.md ×4
│  └─ scripts/whale/{json,util,observe,actions,macros,reflex,bridge,hud}.lua
├─ lib/{index,tools,bridge,mcp-server,agent,client,mod-install}.js   ← 唯一 Node 主线
├─ archive/
│  ├─ phase-a/scripts/main/ (19 个 Lua)
│  ├─ phase-a/bridge/       (TS 包：日志路线)
│  └─ unused-survival/      (TS 包：孤儿)
├─ mcp-server/ agent/ game-bridge/    ← A 栈剩余三包（保留、不启动，M1.x 处理）
├─ tests/ tools/ docs/ data/ guide/
```

---

## 4. 证明「只有一套能写游戏」

| 检查 | 方法 | 结果 |
|---|---|---|
| Lua 侧只有一个动作执行器 | 全仓搜 `BufferedAction(` 在运行链（`scripts/whale` + `modmain`）中的出现 | 只在 `actions.lua` / `macros.lua`（宏通过 `A.run_sub` 复用 `actions`） |
| 运行链里没有 A 栈全局 | 搜 `BWS` / `BWS2` | 运行链 0 命中（`modmain` 里仅剩注释说明） |
| 运行链没有第二条通信 | 搜 `QueryServer` 在 `scripts/whale` | 0 命中（HTTP 只在归档的 `http_client.lua`） |
| Node 侧只有一个工具表 | `lib/tools.js` 的 35 个工具被 `lib/mcp-server.js` 与 `lib/agent.js` 共用 | ✅（两条入口同一个 `executeTool`） |
| A 栈 Node 三包不会被拉起 | `lib/*.js` 无 import；无 ps1 自动启动 | ✅（`start-game-bridge.ps1` 需手动跑，且它的 Lua 端已不加载） |

> ⚠️ 一个诚实的边界：`mcp-server/`、`agent/`、`game-bridge/` **还在原地**，任何人手动
> `start-game-bridge.ps1` + `start-bridge.ps1` 仍能把它们跑起来——但它们**收不到游戏数据**
> （Lua 侧 `scripts/main` 不再加载），所以构不成"第二套能控制角色"的系统。M1.x 会把这三位归档。

---

## 5. 版本号与部署状态（必须做的一步）

- 模组版本：`0.10.0` → **`0.11.0`**（`modinfo.lua` 与 `modmain.lua` 的兜底值同时改，有单测钉住一致）。
- **为什么必须改**：插件自动装模组是按「版本号不同」判断要不要重装的。若版本不动，它认为已是最新，
  游戏里会继续跑**旧的、双栈的** `modmain.lua`。
- 当前实际状态（本轮实测）：

```
modStatus() → { sourceVersion: "0.11.0",
                games: [{ installed: true, installedVersion: "0.10.0" }] }
游戏 mods/DontStarveWhaleSurvivor/scripts/main 仍然存在 = True
游戏 mods/DontStarveWhaleSurvivor/modmain.lua 里 scripts/main 引用 = 19 行
```

→ **下次启动 DSH（或手动 `node tools/install-mod.mjs`）时会自动覆盖成 0.11.0 的单栈版本**；
覆盖后 `mods/…/scripts/main` 会被删掉（`lib/mod-install.js` 是整目录 `cpSync` 覆盖）。

---

## 6. 本轮没做的事（明确留给后续）

| 项 | 留给 | 原因 |
|---|---|---|
| Actor Provider（不再到处 `ThePlayer`） | M1.1 | 本轮只做收敛 |
| 统一 `get_state` 的 JSON 结构 / `snapshot_id` / 引用编号 | M1.1~M1.4 | 同上 |
| 局部地图 + 状态文本重写 | M1.5 | 同上 |
| 文件桥 9 项真机实测（含 caves、长轮询、io 权限） | M1.6 | 需要游戏在跑 |
| Control Lease（`controller_id/lease_id/generation`） | M2 前 | 按任务书：M2 开始动作前必须完成 |
| 三个 A 栈 Node 包（`mcp-server`/`agent`/`game-bridge`）归档 | M1.x | 用户本轮只点了 `bridge` 与 `survival` |
| `modinfo.lua` 里 `OBSERVER_INTERVAL` / `OBSERVER_SCAN_RADIUS` / `OBSERVER_SCAN_SECONDS` | M1.1 | 它们原本只被归档的 `observer_manager.lua` 读；现在**在设置里看得见但不生效**，M1.1 把 Observer 搬进 `whale/` 时重新绑上 |
| 已知 bug（`task_runner` 调不存在的 `Whale.actions.Stop`、`macros.lua` `text` 未定义、`drop` 的 `count` 被忽略、文件桥单槽去重、分片互盖） | M1.x / M2 | `task_runner` 已归档；其余三条在运行链上，**下一轮优先修** |

---

## 7. 改动文件清单（本轮实际改动）

| 文件 | 改动 |
|---|---|
| `DontStarveWhaleSurvivor/modmain.lua` | 删 20 个 A 栈 import（留注释块指向 archive）；`AddGamePostInit`/`AddPlayerPostInit` 去掉 A 栈 start 调用；版本兜底 0.11.0 |
| `DontStarveWhaleSurvivor/modinfo.lua` | 版本 0.11.0 |
| `DontStarveWhaleSurvivor/scripts/whale/bridge.lua` | 删 3 处 A 栈钩子（`Report` 转发 ×2、`server_tick` 的 keepAlive ×2 调用） |
| `.gitignore` | 加 `archive/**/node_modules/`、`archive/**/dist/` |
| `install-bridge.ps1` / `start-bridge.ps1` | 路径改指 `archive/phase-a/bridge`，加"已归档"提示 |
| `tests/lua-mod.test.mjs` | modmain 断言改成"只有 8 个 B 栈模块、禁止出现 scripts/main 与 bws_config" |
| `tests/phase5-m4.test.mjs` | "三路互守"断言改成"归档代码的自守保留、B 栈不再引用 A 栈" |
| `tests/phase1-*`、`phase2-*`、`phase5-*`、`phase6-lua.test.mjs`（13 个） | 加载路径 `MOD/scripts/main` → `LEGACY_HOME/scripts/main`（`LEGACY_HOME = ROOT/archive/phase-a`） |

> 工作区里另有 5 个文件（`scripts/whale/actions.lua`、`reflex.lua`、`lib/tools.js`、`mcp-server/src/survival/*`、`mcp-server/test/p6.test.ts`）
> 在**本轮开始之前**就已经是未提交状态，本轮没有动它们。
