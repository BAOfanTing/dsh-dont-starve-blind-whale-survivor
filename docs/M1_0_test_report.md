# M1.0 · 测试报告

> 范围：M1.0（B 栈唯一运行、A 栈归档）之后的回归测试与启动冒烟
> 环境：Windows 10 家庭中文版 · Node **v24.13.1** · 仓库 `E:\Cache\XinLuguWuyu\dsh-dont-starve-blind-whale-survivor`
> 游戏：**当前没有运行**（`whale_state.json` 最后写入距今 1951 秒）。所以本轮**没有任何新的真机数据**。
> 命令：`node --test --test-force-exit "tests/*.test.mjs"`（= `test.ps1`）

---

## 1. 结果总览

| 阶段 | tests | pass | fail | 用时 |
|---|---|---|---|---|
| 改动前基线（本轮开工时实测） | 211 | 211 | 0 | 3.30 s |
| 移动 + 改 modmain 之后（第一次） | 211 | 210 | 1 | 2.47 s |
| 修完那条断言之后 | 211 | **211** | 0 | 2.89 s |

**用例数没有减少（211 → 211）**，但其中**两条断言的语义被有意改写**（见 §3），因为它们断言的正是
「A 栈必须在运行链上」这件事——而 M1.0 的整个目的就是把它拿掉。

---

## 2. 这些测试到底测了什么（先说清可信度）

| 套件 | 文件数 | 测的是真东西吗 |
|---|---|---|
| `tests/lua*.test.mjs`、`phase*.test.mjs` | 22 | ✅ **用 fengari 在真 Lua 虚拟机里跑模组源码**（`json/util/observe/actions/bridge/hud`），配一套假 `GLOBAL`。动作有没有推进、`BufferedAction` 有没有推给 `locomotor`、结果有没有写成 `whale_result.json`，都是在 Lua 里真跑出来的，不是字符串匹配 |
| `tests/phase1|2|5|6-lua.test.mjs` | — | 同上，只是加载的是**归档到 `archive/phase-a/scripts/main`** 的那 19 个文件（用来保证归档代码没被搬坏，将来复活某段时还能用） |
| `tests/bridge.test.mjs`、`tests/helpers.mjs` | 1+ | ✅ 一个"假游戏"（只读写那几个 json）驱动 `lib/bridge.js` 的 `call()/readState()/status()` |
| `tests/mcp.test.mjs`、`tests/plugin.test.mjs` | 2 | ✅ 真起 `lib/mcp-server.js`（`listen(0)`）走 `initialize/tools/list/tools/call`；插件 `apply()` 在假 ctx 上跑 |
| `tests/install.test.mjs` | 1 | ✅ 在临时目录造一个假游戏目录，真跑 `installMod()` 并检查 `mods/...` 与 `modsettings.lua` |
| `tests/tool-parity.test.mjs` | 1 | ✅ **双向对齐**：`lib/tools.js` 的工具名 ↔ `scripts/whale/actions.lua` 的 `JOBS` 名字，少一个就红 |

**不可替代的缺口**：这些测试全都不需要游戏，因此**测不出**"进世界能不能起来""客户端能不能看到动画"
"文件桥在真实分片下会不会互相覆盖"。那部分只能真机验（§5）。

---

## 3. 有意改写的两条断言（差异记录）

### 3.1 `tests/lua-mod.test.mjs` · modmain 加载测试

| 项 | 改动前 | 改动后 | 为什么 |
|---|---|---|---|
| 模块数 | `#MODIMPORTS == 28` | `#MODIMPORTS == 8` | 20 个 A 栈 import 被摘掉 |
| 必须存在 | 8 个 whale + 13 个 `scripts/main/*` + `bws_config.lua` | 8 个 whale | 同上 |
| 顺序断言 | 含 `entity_observer < threat_observer < state_serializer`、`task_runner < combat_executor` | 删掉（这些文件不在运行链里了）；新增 `util < observe < actions < macros < bridge`、`hud` 最后 | 对应新链路 |
| **新增防回归** | — | 遍历 `MODIMPORTS`：**出现 `scripts/main/` 或 `bws_config.lua` 就失败** | 以后谁想偷偷把 A 栈加回来，测试立刻红 |

### 3.2 `tests/phase5-m4.test.mjs` · "三路互守"测试

| 项 | 改动前 | 改动后 |
|---|---|---|
| 名字 | `M4：三路互守 —— 观察器与文件桥都暴露 KeepAlive` | `M4：三路互守 —— 归档后的 A 栈互守保留，B 栈不再依赖 A 栈` |
| 断言 | `bridge.lua` 必须匹配 `BWS2.net.keepAlive`、`BWS.observer.KeepAlive` | `bridge.lua` **不得**出现 `BWS2`；`net.lua`/`observer_manager.lua`（归档）里的互守函数仍然在 |
| 为什么 | 这两行正是 A 栈与 B 栈互相拉起的证据，M1.0 要拆的就是它们 | 反过来钉住"拆干净了" |

> 除这两条外，**其余 209 条断言一字未改**，只是把 15 个文件里"去哪里找归档的 Lua 文件"的路径
> 从 `DontStarveWhaleSurvivor/scripts/main` 改成了 `archive/phase-a/scripts/main`。

---

## 4. B 栈启动/初始化冒烟（不打开游戏）

### 4.1 脚本

`.runtime/m1_0-smoke.mjs`（临时脚本，`.runtime/` 已 gitignore）：

```js
import { GameBridge } from '../lib/bridge.js'
import { modStatus } from '../lib/mod-install.js'

const bridge = new GameBridge({ log: (l, m) => console.log(`[${l}] ${m}`) })
const dirs = bridge.locate(true)
console.log('找到的桥目录数：', dirs.length)
console.log('前 8 个：', dirs.slice(0, 8).map((d) => `${d.channel}:${d.dir}`))
const state = bridge.readState()
// …打印 state.path / 通道 / 年龄 / ready / mod / players / 文本前三行
console.log('status():', JSON.stringify(bridge.status()))
console.log('模组安装状态：', JSON.stringify(modStatus({})))
```

### 4.2 实际输出（原样）

```
找到的桥目录数： 11
前 8 个： [
  "io:E:\\SteamLibrary\\steamapps\\common\\Don't Starve Together\\bin64",
  "io:E:\\SteamLibrary\\steamapps\\common\\Don't Starve Together\\bin",
  'persist:C:\\Users\\BAOfanTing\\OneDrive\\文档\\Klei\\DoNotStarveTogether\\893016408\\client_save',
  'persist:…\\Cluster_1\\Caves',
  'persist:…\\Cluster_1\\Caves\\save',
  'persist:…\\Cluster_1\\Master',
  'persist:…\\Cluster_1\\Master\\save',
  'persist:…\\trash\\1794486854_Cluster_3\\Caves'
]
选中状态文件： C:\Users\BAOfanTing\OneDrive\文档\Klei\DoNotStarveTogether\893016408\Cluster_1\Master\save\whale_state.json
  通道= persist  年龄(秒)= 1951  ready= true  mod= 0.10.0  players= 1
  文本头三行： ["世界：第3天 · 黄昏 · 秋季 · 29°","你：沃利  生命 50/150  饥饿 166/250  理智 100/200","位置：(19,-111)"]
status(): {"connected":false,"fresh":false,"ageMs":1950578.65,"ready":true,
           "dir":"…\\Cluster_1\\Master\\save","channel":"persist","mod":"0.10.0",
           "reason":"状态文件 1951 秒没更新了（游戏暂停了？还是退出世界了？）"}
模组安装状态： {"sourceVersion":"0.11.0","games":[{"installed":true,"installedVersion":"0.10.0"}]}
```

### 4.3 这证明了三件事（以及一件"没证明"）

| 结论 | 依据 |
|---|---|
| ✅ B 栈 Node 侧能独立找到全部桥目录（`bin64`/`bin`/`client_save`/`Master/Caves` 各层） | 11 个目录，通道分类正确 |
| ✅ 能读到**真实游戏写出来的**状态，且分片排序生效（选中 `Master/save`，不是 `Caves`） | `players=1 / ready=true`，路径是 Master |
| ✅ 状态文本来自模组真实输出（不是伪造的） | 三个换行片段与磁盘文件一致 |
| ⚠️ **游戏当前没开**，所以 `connected=false`；**这一条不算"通信可靠"的验证** | `ageMs ≈ 1951 s` |

> 顺带暴露一件必须处理的事：游戏里装的还是 **0.10.0（双栈版）**，源码已是 **0.11.0**。
> 插件的自动装模组按版本号判断，所以下次启动会自动覆盖；**在那之前进游戏，跑的仍是双栈旧版**。

---

## 5. 尚未验证的项目（不冒充）

| # | 未验证 | 为什么现在验不了 | 谁来验 / 怎么验 |
|---|---|---|---|
| 1 | 0.11.0 模组能否正常进世界（`modmain` 少 20 个 import 后） | 游戏没开 | M1.6：装模组 → 读档 → 看 `master_server_log.txt` 有没有 MOD ERROR |
| 2 | F8 是否真的还能驱动角色 | 同上 | M1.6：进世界按 F8，看走路/采集 |
| 3 | 状态文件是否仍在写（`whale_state.json` 是否 1 秒一刷） | 同上 | M1.6：看文件 mtime |
| 4 | 文件桥 9 项实测（`docs/M0_api_validation.md` §6） | 需要真机 + 可控的 Node 端 | M1.6 |
| 5 | Master/Caves 双分片下是否会互相覆盖（当前靠 Node 侧排名缓解，Lua 侧还没带 `shard` 字段） | 需要两个分片同时在跑 | M1.6（顺带补 `shard` 字段） |
| 6 | 客户端动画（服务端移动 + 客户端 RPC） | 需要图形客户端 | M1.6 |
| 7 | `mcp-server`/`agent`/`game-bridge` 三包在 A 栈断开后的行为 | 本轮不启动它们 | M1.x 归档时确认 |

---

## 6. 复现方式

```powershell
# 全部单测（不需要游戏）
powershell -ExecutionPolicy Bypass -File test.ps1
#   → tests 211 / pass 211 / fail 0

# 只跑受本次改动影响的三个套件
node --test --test-force-exit "tests/lua-mod.test.mjs" "tests/tool-parity.test.mjs" "tests/phase5-m4.test.mjs"

# 静态检查：运行链里不许出现 A 栈全局
Select-String -Path "DontStarveWhaleSurvivor\scripts\whale\*.lua","DontStarveWhaleSurvivor\modmain.lua" -Pattern "BWS2|BWS\b|QueryServer"

# 启动冒烟（不需要游戏，但需要机器上装过饥荒）
node .runtime/m1_0-smoke.mjs
```
