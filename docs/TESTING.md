# 测试

> 这里只写**真的跑得通**的命令。每条命令都在 M2.2.1 期间实际执行过（除标注 `NOT_RUN` 的）。

---

## 1. 最快的一条

```powershell
powershell -ExecutionPolicy Bypass -File test.ps1
```

它会：找 Node → 缺 `fengari`/`luaparse` 就装上 → 跑全部单测。
最后一次实测（SURVIVAL-02.1）：**566 passed / 0 failed，退出码 0**。

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
| **单元 / 沙箱** | 只要 Node | `node --test tests/*.test.mjs` | **566** | ✅ 已跑 |
| **Lua 语法与加载** | Node + fengari | `node --test tests/lua-mod.test.mjs` | 含在 566 里 | ✅ 已跑 |
| **MCP（真 HTTP + SSE）** | Node（起临时服务器） | `node --test tests/mcp.test.mjs` | 含在 566 里 | ✅ 已跑 |
| **文件桥** | Node（临时目录 + 假游戏） | `node --test tests/bridge.test.mjs` | 含在 566 里 | ✅ 已跑 |
| **真实游戏（RUNTIME）** | 游戏开着 + 模组装着 | 见 §6 | 脚本，不算进 566 | 见 §6.8 |
| **端到端（模型→游戏）** | 游戏 + DSH 会话 + API Key | 见 §6.5 | — | **NOT_RUN** |

趋势：479（M2.2.1）→ 531（SURVIVAL-02）→ **566（SURVIVAL-02.1，新增 31）**。测试只增不减。

---

## 3. 单测覆盖了什么（按主题）

```powershell
node --test --test-force-exit "tests/*.test.mjs"       # 全部
node --test --test-force-exit "tests/m2_3-harvest.test.mjs"   # 只跑 harvest
node --test --test-force-exit "tests/m2_*.test.mjs"    # 只跑 M2 系列
```

| 主题 | 文件 | 盯的是什么 |
|---|---|---|
| 工具表一致性 | `tool-parity.test.mjs` | 工具名唯一、可见动作 === dispatcher 白名单、reflex/macros 用到的 Lua 动作没被删、本地工具（含 `update_notes`）不走 dispatcher |
| 插件入口 | `plugin.test.mjs`、`client.test.mjs`、`install.test.mjs` | 配置项、预设、装模组、`dst` 入口工具 |
| 模组自身 | `lua-mod.test.mjs`、`lua.test.mjs` | `modmain` 能加载、14 个 `modimport`、所有 Lua 语法、版本号一致 |
| 状态与观察 | `m1_1-actor-observer`、`m1_2-regressions`、`m1_4-*`（5）、`m14-watch-counters` | Actor Provider、字段契约、Delta、截断、扫描计时 |
| 控制与安全 | `m2-control-dispatcher`、`m2-lua-guard`、`m2_0_1_lease_security`、`m2_0_2_authority_channel`、`m2_0_2_lease_ack` | 白名单、命令协议、租约换手 ACK 的五条硬条件、权威性通道 |
| 动作 | `m2_1-pickup-lua`、`m2_1-pickup-node`、`m2_2-actionable-nearby`、`m2_3-harvest`（30 例） | 白名单、目标校验、距离、成熟度、结果核对 |
| MCP / 桥 / Agent | `mcp.test.mjs`、`bridge.test.mjs`、`agent.test.mjs` | Streamable HTTP + SSE、文件桥读写、F8 循环 |

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

覆盖：协议握手、`tools/list` 暴露 34 个工具（3 本地 + 31 动作）且名字唯一、未开放工具被拒、
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
| `node tools/m2_0_3_verify_lease.mjs` | 租约 / 换手 / ACK / 权威副本（**只用 stop，不移动角色**） | 否（自动定位） |
| `node tools/m2_0_3_verify_move.mjs` | `move_to` 真实走路 + 移动中换手中断 | 否 |
| `node tools/m2_0_3_verify_stop.mjs` | 换手 Abort 后**逐帧**确认角色停住 | 否 |
| `node tools/m2_1_verify_pickup.mjs` | `pickup` 闭环（走 MCP 入口，桥目录由 MCP 决定） | 否（不需要） |
| `node tools/m2_2_verify_nearby.mjs --bridgeDir "<save>"` | 9 个桶 + `pickupables` + 上限 + 性能 | 是 |
| `node tools/m2_3_verify_harvest.mjs --bridgeDir "<save>"` | 可收获桶 / 未成熟 / 距离 / 不自动捡 | 是 |
| 上一条加 `--harvest` | 真的采一次（会改变世界！） | 是 |

**每条命令都实测过**（STABILITY-01，2026-11-13，模组 0.17.2）：

```powershell
node tools/m2_0_3_verify_lease.mjs                                            # 11/11 PASS
node tools/m2_1_verify_pickup.mjs                                             # 5/5 PASS
node tools/m2_3_verify_harvest.mjs --bridgeDir "<save>" --harvest             # 13 PASS / 0 FAIL / 1 NOT_OBSERVED
node tools/m2_0_3_verify_move.mjs                                             # 4 PASS / 1 FAIL（见下）
node tools/m2_0_3_verify_stop.mjs                                             # 3/3 PASS
node tools/m2_2_verify_nearby.mjs --bridgeDir "<save>"                        # 13 PASS / 0 FAIL / 1 NOT_OBSERVED
```

⚠️ **`verify_move.mjs` 的 ⑤-3 会假报失败**：它"ack 前后各读一次位置"，而状态文件每秒才写一次、
位置在帧里成段跳变，于是把一次 2 格跳变算成"Abort 后还在走"。
**以 `verify_stop.mjs` 为准**（逐帧去重采样）：实测 Abort 后 6 帧位置不变 = 真的停住了。
详见 `STATUS.md` §5 #12。

### 6.3.1 真机跑之前的三步准备（缺一步就会失败）

```powershell
# 1) 游戏暂停着的话，先解除（窗口失焦会暂停，主机暂停会让命令轮询全停）
node tools/unpause.mjs

# 2) 确认状态文件在更新（年龄应该是几百毫秒，不是几百秒）
(Get-Item "<save>\whale_state.json").LastWriteTime

# 3) 改过 lib/ 下的 Node 代码，就必须重启 MCP，否则 tools/list 还是旧的
node tools/m2_0_2_start_mcp.mjs        # 后台跑；然后 http://127.0.0.1:18090/status 应该 HTTP 200
```

确认产品入口暴露的工具表（应该是 34 个、名字唯一；数量以 `ACTION_SPECS` 为准）：

```powershell
# JSON-RPC：initialize → tools/list
node --input-type=module -e "..."      # 或直接用 tests/mcp.test.mjs 里的 rpc() 写法
```

### 6.6 真实 LLM 闭环（END_TO_END）

这是唯一能证明"模型真的能玩"的测试：真实模型读状态 → 自己选工具 → 游戏真执行 → 再读状态核对。

**前置**

1. 游戏开着、读档进世界（模组版本要和仓库一致，改过 Lua 就必须重进世界）。
2. 本机有可用的 OpenAI 兼容端点（当前用户环境是 `http://127.0.0.1:8788/v1`）。
   凭据**只从用户已有配置读**（`~/.dsh/.credentials.yaml` 的 `LOCAL_API_KEY`），
   **绝不打印、绝不写进仓库或日志**。
3. 单控制者：跑之前不要按 F8，也不要让别的客户端同时下动作。

**跑法**

```powershell
# 预算：最多 20 次模型工具调用；Lease 内部等待不计入，但会记录等待时长
$env:AGENT01_MAX_CALLS='20'
node .runtime/agent01-run.mjs
```

脚本**只做**这些事（不替模型决策）：启动产品 `AiRunner`、配置端点、统计调用次数、
记录每次工具名与参数、执行预算、汇总游戏状态。工具选择完全由模型决定。

**怎么确认"游戏真的变了"**（不能只看 accepted）

| 动作 | 判据 |
|---|---|
| `move_to` | `get_state` 里的「位置：(x,z)」变了 |
| `pickup` | 背包里对应 prefab 的数量 +1，且目标从「附近」里消失 |
| `harvest` | 背包浆果 +1 **或** 同一株（prefab+坐标）`harvest_ready` 由 true 变 false |
| `stop` | 回执是「停下了」，且随后位置不再变化 |

**等级怎么标**

- 只有单测 → **UNIT**
- 真实游戏在跑、脚本（不是 LLM）下动作 → **RUNTIME**
- 真实模型自己决定调什么、并且用真实状态核对过结果 → **END_TO_END**

**注意**：`get_state` 文本里有两个 id，别搞混 ——
第一行「状态快照序列号 s…」只是给人看的序号；
`pickup`/`harvest` 的 `snapshot_id` 要填「附近」段开头那个 **Nearby 快照 ID（r…-n…）**。

### 6.7 SURVIVAL-01：完整基础生存闭环（END_TO_END）

跑法（预算 40 次工具调用）：

```powershell
$env:SURVIVAL_MAX_CALLS='40'
node .runtime/survival01-run.mjs
```

脚本只做这些：启动产品 `AiRunner`、配端点、计数、记录每次工具与前后状态、执行预算。
**不替模型决定**用哪个工具、选哪个目标。

**逐动作判据**（不能只看回执文字）：

| 动作 | 必须看到 |
|---|---|
| `gather` | 背包 `cutgrass`/`twigs` 增加，或同一株从「可收」变成「未成熟」 |
| `pickup` | 背包对应 prefab +N |
| `harvest` | 背包 `berries` +N，同一株 `harvest_ready` true → false |
| `eat` | 饥饿值上涨，**或**该食物数量减少 |
| `craft` | 材料减少 **且** 成品进背包（`torch`/`axe`/`pickaxe` 数量 +1） |
| `equip` | 装备栏 hand 真的变成它 |

脚本会把每次动作的"前后"（位置 / 背包 / 手持 / 饥饿）打进日志，并写
`.runtime/survival01-actions.json` 便于核对。

**注意**：`craft` 和 `equip` 只在**世界加载了 0.18.0 之后**才存在；
如果状态文件的 `mod` 还是旧版本，说明没重读世界，这时跑出来的结果不算数。

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

### 6.8 SURVIVAL-02.1：生存优先级 / 火源提前准备 / 紧急抢占（RUNTIME）

**前置（缺一不可）**

1. 游戏里模组版本必须是 **0.32.1**（看状态文件 `mod` 字段，或服务器日志
   `Loading mod: DontStarveWhaleSurvivor ... Version:0.32.1`）。
2. **`REFLEX` 必须是 `true`**：检查 `Cluster_1/{Master,Caves}/modoverrides.lua`。
   旧存档默认是 `false`（本阶段把真实死因查出来的关键一条，见 `STATUS.md` §3.5.3），
   改完必须**重新读档**才生效。
3. 世界不暂停（窗口在前台 / 关掉"思考时暂停"），状态文件年龄应在几百毫秒级。

**怎么判"能活过夜"（不靠感觉，看真实状态与诊断日志）**

| 检查点 | 证据 |
|---|---|
| 白天提前做火把 | server_log 里出现 `[Reflex] craft_torch: started=true` 且随后 `result=succeeded inventory_confirmed=true`（或 `in_hand=true`）；`get_state` 背包/手持出现 torch |
| 火把材料没被斧头抢 | 做出火把前，斧头目标不出现（`prep_light` 优先）；日志里没有"树枝被扣去做斧头、火把材料不够" |
| 黄昏装备 | `get_state` 装备栏 hands = torch；诊断 `light_check: has_usable_light=true` |
| 第一夜不被黑暗/暗影怪打死 | 角色存活且 `get_state` 里 phase 从 night 回到 day，血量没有持续下降到 0 |
| 饥饿/生命处理 | 饥饿 <35% 时出现 `[Reflex] eat:`，或 `[Reflex] priority=P1 reason=hunger_emergency` |
| 任务抢占 | 被攻击时 `[Reflex] protection: current_job=... interrupt=true reason=under_attack`，旧指令收到回执 |
| 反射真开着 | `get_state` 顶部**没有**"⚠ 保命反射被关掉了"这句 |

> 若只跑到某个白天/夜晚就中断，如实写"观测到第 N 天/夜"，不要把没跑到的第二夜说成跑到了。
> 真实游戏里 `darkness=nonlethal`，所以"没死"本身不等于"光照对了"——必须同时看理智有没有崩、
> 暗影怪有没有刷出来（见 §6.8 检查点）。

---

## 7. 标记规范（别把没跑的说成跑了）

- 只跑过单测 → 只能说 **UNIT 通过**。
- 真实游戏跑过 → 才能说 **RUNTIME 通过**，并写清版本号。
- 没跑 → 写 **`NOT_RUN`**，不要写"应该没问题"。
- 换过代码但只跑了旧版本的真机 → 那是旧版本的证据，不能算新版本的。

诚实结论（截至 SURVIVAL-02.1，模组 **0.32.1**；下表历史动作项仍是 0.17.2 的旧证据，未继承）：

| 项 | 结论 |
|---|---|
| 单测 **566** 项（含 SURVIVAL-02.1 新增 31） | **UNIT：通过**（566/566） |
| 干净检出（没有 `dist`/`bwc_config`/`.runtime`）后跑单测 | **通过**（479/479，M2.2.1 与 STABILITY-01 都验过） |
| 真实游戏：模组加载（两个分片无 Lua 错误） | **RUNTIME：通过** |
| 真实游戏：`get_state` / `nearby` | **RUNTIME：通过**（9 桶、`#N` 唯一、上限生效） |
| 真实游戏：`stop` / `move_to` / `pickup` / `harvest` | **RUNTIME：通过**（pickup 5/5、harvest 13 PASS/0 FAIL、stop 3/3、move 4 PASS） |
| 真实游戏：安全底座（lease / ACK / 权威副本） | **RUNTIME：通过**（11/11） |
| 真实游戏：MCP `tools/list` | **RUNTIME：通过**（7 个、唯一） |
| 真实游戏：**F8 内置 AI** | **NOT_RUN**（HUD 自报「没配 API Key」；无法在不接管键鼠的前提下模拟 F8） |
| 端到端（真实 LLM 长跑） | **NOT_RUN** |

---

## 8. 加新测试时

1. 新动作 → `tests/tool-parity.test.mjs` 会自动检查"可见动作 === dispatcher 白名单"，
   所以**先加白名单再加工具**，否则测试会红（这是故意的）。
2. 新 Lua 模块 → `tests/lua-mod.test.mjs` 会检查 `modimport` 数量与顺序。
3. 新状态字段 → 优先加进 `tests/m1_4-nearby.test.mjs` 或 `m1_1-actor-observer.test.mjs`。
4. 新拒绝码 → 加进对应 `m2_*.test.mjs` 的负向用例，并且**必须**断言"没有写命令文件"。
