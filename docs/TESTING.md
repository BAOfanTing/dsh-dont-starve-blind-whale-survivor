# 测试

> 这里只写**真的跑得通**的命令。每条命令都在 M2.2.1 期间实际执行过（除标注 `NOT_RUN` 的）。

---

## 1. 最快的一条

```powershell
powershell -ExecutionPolicy Bypass -File test.ps1
```

它会：找 Node → 缺 `fengari`/`luaparse` 就装上 → 跑全部单测。
最后一次实测：**479 passed / 0 failed，退出码 0**，约 6 秒。

等价的直接命令（不用 PowerShell 包装）：

```powershell
npm test
# 或
node --test --test-force-exit "tests/*.test.mjs"
```

> `--test-force-exit` 不能省：有的测试会留定时器，不加会挂住不退出。

---

## 2. 测试分六类

| 类 | 需要的环境 | 命令 | 数量 | 本次 |
|---|---|---|---|---|
| **单元 / 沙箱** | 只要 Node | `node --test tests/*.test.mjs` | **479** | ✅ 已跑 |
| **Lua 语法与加载** | Node + fengari | `node --test tests/lua-mod.test.mjs` | 含在 479 里 | ✅ 已跑 |
| **MCP（真 HTTP + SSE）** | Node（起临时服务器） | `node --test tests/mcp.test.mjs` | 含在 479 里 | ✅ 已跑 |
| **文件桥** | Node（临时目录 + 假游戏） | `node --test tests/bridge.test.mjs` | 含在 479 里 | ✅ 已跑 |
| **真实游戏（RUNTIME）** | 游戏开着 + 模组装着 | 见 §6 | 脚本，不算进 479 | **NOT_RUN** |
| **端到端（模型→游戏）** | 游戏 + DSH 会话 + API Key | 见 §6.5 | — | **NOT_RUN** |

---

## 3. 单测覆盖了什么（按主题）

```powershell
node --test --test-force-exit "tests/*.test.mjs"       # 全部
node --test --test-force-exit "tests/m2_3-harvest.test.mjs"   # 只跑 harvest
node --test --test-force-exit "tests/m2_*.test.mjs"    # 只跑 M2 系列
```

| 主题 | 文件 | 盯的是什么 |
|---|---|---|
| 工具表一致性 | `tool-parity.test.mjs` | 工具名唯一、可见动作 === dispatcher 白名单、reflex/macros 用到的 Lua 动作没被删、只读工具不走 dispatcher |
| 插件入口 | `plugin.test.mjs`、`client.test.mjs`、`install.test.mjs` | 配置项、预设、装模组、`dst` 入口工具 |
| 模组自身 | `lua-mod.test.mjs`、`lua.test.mjs` | `modmain` 能加载、14 个 `modimport`、所有 Lua 语法、版本号一致 |
| 状态与观察 | `m1_1-actor-observer`、`m1_2-regressions`、`m1_4-*`（5）、`m14-watch-counters` | Actor Provider、字段契约、Delta、截断、扫描计时 |
| 控制与安全 | `m2-control-dispatcher`、`m2-lua-guard`、`m2_0_1_lease_security`、`m2_0_2_authority_channel`、`m2_0_2_lease_ack` | 白名单、命令协议、租约换手 ACK 的五条硬条件、权威性通道 |
| 动作 | `m2_1-pickup-lua`、`m2_1-pickup-node`、`m2_2-actionable-nearby`、`m2_3-harvest`（30 例） | 白名单、目标校验、距离、成熟度、结果核对 |
| MCP / 桥 / Agent | `mcp.test.mjs`、`bridge.test.mjs`、`agent.test.mjs` | Streamable HTTP + SSE、文件桥读写、F8 循环 |
| **历史（A 栈）** | `phase1-*`（4）、`phase2-*`（4）、`phase5-*`（6）、`phase6-lua` | 跑的是 `archive/phase-a/scripts/main/*.lua`（fengari）+ `schema/state.schema.json`。**仍有效**：防止归档代码腐烂，`phase6-lua` 还核对归档 Lua 白名单 == `tests/fixtures/legacy-ts-profiles.json` |

---

## 4. Lua 测试怎么跑的（别以为是假 Lua）

`tests/lua-mod.test.mjs` 用 **fengari**（Lua 5.3 的 JS 实现）真的去 `luaL_loadstring` 了
`modmain.lua` 和全部 `scripts/whale/*.lua`，并注入假的 `GLOBAL`（`TUNING`、`TheSim`、`ThePlayer`…）。

所以它能抓到：语法错误、`modimport` 顺序错、沙箱里误用 `GLOBAL.io`、
`pcall == nil`（模组沙箱里必须 `local pcall = GLOBAL.pcall`）、版本兜底值漂移。

**它抓不到**：真实游戏里的组件行为、真实动画打断、真实 `FindEntities` 结果。
那些只能在 §6 的真机里验。

---

## 5. MCP 测试怎么跑的

`tests/mcp.test.mjs` 起一个**真的 HTTP 服务器**（`lib/mcp-server.js` 的 `apply`），
用 `fetch` 发 JSON-RPC（`initialize` / `tools/list` / `tools/call`），并读 SSE 流。
假游戏（`FakeGame`）会在临时目录里写/读状态、命令、结果文件。

覆盖：协议握手、`tools/list` 只暴露 7 个工具且名字唯一、未开放工具被拒、
动作结果原样返回、`get_state` 读不到游戏时的提示。

---

## 6. 真实游戏测试（RUNTIME）—— 本次 **NOT_RUN**

### 6.1 前置

1. 游戏开着，读档进了世界（本地主机）。
2. 模组已装：`node tools/install-mod.mjs`（输出里看 `installedVersion`）。
3. 状态文件在更新：

   ```powershell
   $save = "C:\Users\<你>\OneDrive\文档\Klei\DoNotStarveTogether\<steamid>\Cluster_2\Master\save"
   (Get-Item "$save\whale_state.json").LastWriteTime    # 应该是几秒内
   ```

4. **一定要传 `--bridgeDir`**：自动定位会挑 mtime 最新的分片，可能选到 `Cluster_1` 的旧档。

### 6.2 启动产品 MCP（如果要用 MCP 那条路）

```powershell
node tools/m2_0_2_start_mcp.mjs        # 默认 18090
```

> 改过 `lib/` 下的 Node 代码后**必须重启**这个进程，否则跑的还是旧代码。

### 6.3 分动作验证脚本

| 脚本 | 验证什么 | 支持 `--bridgeDir` |
|---|---|---|
| `node tools/m2_0_3_verify_lease.mjs` | 租约获取/换手/ACK | 否（自动定位） |
| `node tools/m2_0_3_verify_move.mjs` | `move_to` 真实走路 | 否 |
| `node tools/m2_0_3_verify_stop.mjs` | `stop` 打断 | 否 |
| `node tools/m2_1_verify_pickup.mjs` | `pickup` 闭环 | **否**（见 `STATUS.md` §5 #8） |
| `node tools/m2_2_verify_nearby.mjs --bridgeDir "<save>"` | 9 个桶 + `pickupables` | 是 |
| `node tools/m2_3_verify_harvest.mjs --bridgeDir "<save>"` | 可收获桶 / 未成熟 / 距离 / 不自动捡 | 是 |
| 上一条加 `--harvest` | 真的采一次（会改变世界！） | 是 |

最近一次 `m2_3_verify_harvest.mjs --harvest` 的结果：**14/14 PASS**（当时版本 0.17.1）。

### 6.4 观察类脚本（不改世界）

```powershell
node tools/m14-watch.mjs            # 每帧状态变化
node tools/m12-watch.mjs --seconds 60 --interval 2
node tools/m12-roundtrip.mjs        # 往返读写一次（会在 tests/artifacts/ 留证据）
```

### 6.5 端到端（模型真的下指令）

在 DSH 会话里选中「大肥鱼饿不死」预设（或打开「在所有会话里提供 dst 入口工具」），
让模型自己调 `get_state` → `move_to` → `pickup` / `harvest`。
**本次瘦身没有做这一步**（`NOT_RUN`）——它需要真实模型配额和一段连续游戏时间。

---

## 7. 标记规范（别把没跑的说成跑了）

- 只跑过单测 → 只能说 **UNIT 通过**。
- 真实游戏跑过 → 才能说 **RUNTIME 通过**，并写清版本号。
- 没跑 → 写 **`NOT_RUN`**，不要写"应该没问题"。
- 换过代码但只跑了旧版本的真机 → 那是旧版本的证据，不能算新版本的。

本次瘦身的诚实结论：

| 项 | 结论 |
|---|---|
| 单测 479 项 | **UNIT：通过** |
| 干净检出（把 `mcp-server/dist` 移走）后跑单测 | **通过**（479/479，M2.2.1 专门验过） |
| 真实游戏（`get_state` / `nearby` / `move_to` / `stop` / `pickup` / `harvest`） | **NOT_RUN**（本次没启动游戏） |
| 端到端（真实模型） | **NOT_RUN** |

---

## 8. 加新测试时

1. 新动作 → `tests/tool-parity.test.mjs` 会自动检查"可见动作 === dispatcher 白名单"，
   所以**先加白名单再加工具**，否则测试会红（这是故意的）。
2. 新 Lua 模块 → `tests/lua-mod.test.mjs` 会检查 `modimport` 数量与顺序。
3. 新状态字段 → 优先加进 `tests/m1_4-nearby.test.mjs` 或 `m1_1-actor-observer.test.mjs`。
4. 新拒绝码 → 加进对应 `m2_*.test.mjs` 的负向用例，并且**必须**断言"没有写命令文件"。