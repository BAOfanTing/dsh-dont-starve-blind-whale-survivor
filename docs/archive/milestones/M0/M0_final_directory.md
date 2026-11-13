# M0 · 最终目录结构（收敛后）

> 目标：一个 Lua 模组 + 一个 Node 服务 + 一条主链路。**没有第二套工具表、没有第二套执行器、没有独立微服务。**
> 目录名与文件名是自解释的：任何人（或 AI）打开仓库 30 秒内应该能说出"我应该改哪个文件"。

---

## 1. 仓库根

```
dsh-dont-starve-blind-whale-survivor/
├─ package.json                  DSH 插件清单（name/main/exports/dsh.bundle）
├─ cordis.patch.yml             DSH 插件注册
├─ lib/                         ★唯一 Node 产品代码（纯 JS，无构建步骤）
├─ DontStarveWhaleSurvivor/     ★唯一 Lua 模组（直接可复制进 mods/）
│   └─ legacy/                  历史代码（不 import，可查可回退）
├─ guide/                       攻略（随模组分发，Node 读，游戏内也读）
├─ data/                        运行期数据（notes / logs / 世界ID.md；不进仓库）
├─ docs/                        文档（M0 四篇 + 各里程碑）
├─ tests/                       Node 侧测试（node --test，无需游戏）
├─ tools/                       安装/生成/诊断脚本
├─ legacy/                      归档的 5 个 TS 包（不参与运行）
├─ common.ps1 / install.ps1 / test.ps1 / build.ps1
└─ start-*.ps1                  只保留真正需要的启动脚本
```

> `legacy/`（仓库根）与 `DontStarveWhaleSurvivor/legacy/` 的区别：前者是 Node 历史（TS 五包），后者是 Lua 历史（`legacy/scripts-main/*`）。两者都**不参与运行**，只作为参考与回退。

---

## 2. Lua 模组

```
DontStarveWhaleSurvivor/
├─ modinfo.lua                  模组元信息 + 配置项（VERBOSE/INTERVAL/REFLEX/SCAN_*/TRANSPORT）
├─ modmain.lua                  ★唯一装配点：只 modimport，不写逻辑
├─ guide/                       攻略副本（安装时与根 guide/ 同步）
└─ scripts/
   ├─ whale/
   │  ├─ sandbox.lua            ★唯一从 GLOBAL 取 pcall/tonumber/error/os/io 的地方
   │  ├─ json.lua               纯 Lua JSON（编/解）
   │  ├─ util.lua               几何/距离/找实体/读背包/名字翻译
   │  ├─ lease.lua              ★控制权租约：agent / reflex / combat / task / human
   │  ├─ refs.lua               ★实体引用表 #N ↔ 实体 ↔ snapshot_seq（含过期判定）
   │  ├─ log.lua                诊断日志 + 带预算的 transcript（防单行 3.9K 截断）
   │  │
   │  ├─ observe/
   │  │  ├─ index.lua           Build(p) → {text, data, refs, delta}（含预算裁剪）
   │  │  ├─ player.lua          生命/饥饿/理智/体温/潮湿/装备/背包
   │  │  ├─ world.lua           天数/季节/昼夜/天气/月相/洞穴/季节剩余天数
   │  │  ├─ nearby.lua          半径扫描 + 分类（10 类 + 上限 + 缓存）
   │  │  ├─ threat.lua          敌对/中立/追击/出手/血量/Boss 标记 + 光照/体温读数
   │  │  ├─ map.lua             局部字符地图 21×11（M3）
   │  │  └─ warnings.lua        只报事实的告警（血低/饿/理智/天黑夜/极端温度）
   │  │
   │  ├─ actions/
   │  │  ├─ index.lua           ★JOBS 表 + Start/Tick/Abort/Current/Known（唯一执行器）
   │  │  ├─ move.lua            move_to / go_to（含 cant_reach 判定 + 客户端走路 RPC）
   │  │  ├─ work.lua            chop / mine / hammer / dig（BufferedAction + 重发直到 tag 消失）
   │  │  ├─ item.lua            pick / pickup / eat / equip / drop / heal / cook / sleep
   │  │  ├─ craft.lua           craft / build / make_fire / add_fuel（含缺料原因）
   │  │  ├─ container.lua       store / take / harvest（走原生动作，不直接改容器）
   │  │  ├─ combat.lua          ⏸ fight / flee（由原 combat_executor 改造，M4 启用）
   │  │  └─ tasks.lua           ⏸ 任务链 8 模板（由原 task_runner 改造，M4 启用）
   │  │
   │  ├─ macros.lua             gather / chop_until / cook_meal / night_watch（组合原子动作）
   │  ├─ reflexes.lua           回血/举光/添柴/撤退（只通过 lease 抢占，必须汇报）
   │  ├─ transport/
   │  │  ├─ index.lua           ★统一接口 push(state) / poll() / result(r)（按配置选实现）
   │  │  ├─ file.lua            文件桥（默认）：持久化字符串 + io.open 双写，0.2s 主循环
   │  │  └─ http.lua            ⏸ QueryServer：串行队列 + 自实现超时 + since ack（M2 启用）
   │  └─ hud.lua                游戏内小窗 + F7（停手/人工接管）/ F8（开关内置 AI）
   ├─ debug/
   │  └─ probe.lua              ⏸ 通信/动作能力探针（只诊断，默认不跑）
   └─ (../legacy/scripts-main/) ⏸ 原 scripts/main/*（19 个文件，不 import，见 §6）
```

**Lua 侧职责边界（不许越界）**

| 该做 | 不许做 |
|---|---|
| 读游戏状态、执行原生动作、保命反射、控制权裁决、把状态写成文本 | 调用 LLM、决定"要不要去砍树"、保存策略、写 Notes、做 JSON Schema |

---

## 3. Node 服务（`lib/`）

```
lib/
├─ index.js                    ★DSH 插件装配：Config / 会话预设 / dst 入口工具 / 自动装模组 / 自动续玩
├─ client.js                   DSH 设置卡片（由 tools/build-client.mjs 生成，不手改）
├─ mod-install.js              把 Lua 模组装进游戏 mods/ + modsettings.lua
├─ mcp.js                      ★MCP 门面：只把 tools/registry 暴露出去，不含第二套逻辑
│
├─ runtime/
│  ├─ server.js                一个进程：/mcp + /api/* + /settings + /status
│  ├─ transport.js             ★统一传输接口：getSnapshot() / sendCommand() / onResult()
│  ├─ transport-file.js        文件桥适配（找目录/读 json/原子写指令/结果轮询）
│  └─ transport-http.js        ⏸ QueryServer 端适配（M2；吸收 game-bridge 的命令队列语义）
│
├─ state/
│  ├─ snapshot.js              ★唯一解析点：Lua 快照 → 归一化对象（玩家/世界/实体/背包）
│  ├─ control.js               ★唯一控制权（lease 副本 + 6 条拒绝码 + 人工接管）
│  └─ freshness.js             stale 判定（时间差 + 分片 + 快照 seq）
│
├─ tools/
│  ├─ registry.js              ★唯一工具注册表：schema + 参数校验 + 派发 + 三态结果
│  ├─ local.js                 get_state / get_guide / update_notes
│  ├─ actions.js               move_to / gather / pickup / chop / mine / craft / build /
│  │                           eat / equip / store / take / cook / sleep / say / stop
│  ├─ combat.js                fight / flee（M4）
│  └─ macros.js                高层组合（与 Lua macros 一一对应）
│
├─ agent/
│  ├─ loop.js                  ★唯一 Agent Loop（回合制、预算、超时、取消、失败策略）
│  └─ provider.js              OpenAI 兼容（DeepSeek 官方 / 本地），function calling
│
├─ analysis/                   纯计算，零 I/O（吸收 mcp-server/src/survival/*）
│  ├─ context.js               归一化快照 → 决策上下文
│  ├─ threat.js                威胁评分（0~100 + 因素拆解）
│  ├─ combat.js                准备度 + ENGAGE/PREPARE/EVADE/RETREAT
│  ├─ escape.js                逃跑方案
│  ├─ season.js                季节/剩余天数/准备度
│  ├─ boss.js                  Boss 识别与准备
│  └─ priority.js              全局仲裁（P0 存活 → P5 探索）
│
└─ memory/
   ├─ notes.js                 世界笔记（≤1200 字，[看到]/[推断] 分层）
   ├─ guide.js                 攻略加载（主攻略常驻 / 专题按需）
   └─ transcript.js            每轮调用与动作的完整记录
```

**Node 侧职责边界**

| 该做 | 不许做 |
|---|---|
| 调模型、组 prompt、跑工具循环、校验参数、算决策分数、存记忆、暴露 MCP | 直接读游戏内存、自己实现动作、持有 API Key 以外的游戏凭据、开端口给外网 |

---

## 4. 运行期文件协议（唯一真相：`Whale.files` ↔ `lib/runtime/transport-file.js`）

| 文件 | 方向 | 内容 | 频率 | 备注 |
|---|---|---|---|---|
| `whale_state.json` | Lua → Node | `{v,seq,shard,t,mod,ready,text,data}` | 1s（可配） | 文本给模型；`data` 给程序；**必须带 `shard`** |
| `whale_result.json` | Lua → Node | `{v,id,ok,partial?,reason?,text,effects,t}` | 每次动作结束 | 三态结果 |
| `whale_cmd.json` | Node → Lua | `{v,id,action,args}` | 按需 | Lua 侧按 `id` 去重（后续改 `since`） |
| `whale_settings.json` | Node → Lua | `{pause,verbose,interval,…}` | 改动时 | 热更新 |
| `whale_pause.json` | Node → 客户端 | `{pause:bool}` | 改动时 | 仅单机房主有效 |
| `whale_hud.json` | Node → 客户端 | `{title,doing,result}` | 1s | 小窗内容 |

每类文件都有两条子通道（持久化字符串 / `io.open`），Node 侧按「三种目录 + 最新 mtime」挑。**新增文件必须同时加进 `Whale.files` 与 `lib/runtime/transport-file.js` 的常量表，并有单测钉住两边一致**（现在靠人工，容易漂）。

---

## 5. 工具清单（收敛后 25 个）

| 组 | 工具 | 参数要点 | 谁执行 |
|---|---|---|---|
| 观察 | `get_state` | `{detail?: "brief"\|"full"}` | Node（读快照） |
| 观察 | `get_guide` | `{topic?}` | Node（读 Markdown） |
| 观察 | `update_notes` | `{text}`（覆盖写，≤1200 字） | Node（写文件） |
| 移动 | `move_to` | `{ref?｜x,z, timeout?}` | Lua `actions/move` |
| 移动 | `stop` | `{}` | Lua（立刻打断） |
| 采集 | `gather` | `{kind, count?, radius?}` | Lua `macros.gather` |
| 采集 | `pickup` | `{ref?｜item, count?}` | Lua `actions/item` |
| 采集 | `harvest` | `{ref?｜kind}`（浆果/作物/晒肉架） | Lua `actions/container` |
| 工具 | `chop` | `{ref?｜radius, count?}` | Lua `actions/work` |
| 工具 | `mine` | `{ref?｜radius, count?}` | Lua `actions/work` |
| 工具 | `hammer` | `{ref?}` | Lua `actions/work` |
| 工具 | `dig` | `{ref?}` | Lua `actions/work` |
| 制作 | `craft` | `{recipe, count?}` | Lua `actions/craft` |
| 制作 | `build` | `{recipe, x?, z?}` | Lua `actions/craft` |
| 制作 | `cook` | `{ref?｜kind}` | Lua `actions/item` |
| 火 | `make_fire` | `{}` | Lua `actions/craft` |
| 火 | `add_fuel` | `{ref?}` | Lua `actions/craft` |
| 物品 | `eat` | `{item?, prefer?}` | Lua `actions/item` |
| 物品 | `equip` | `{item｜ref, slot?}` | Lua `actions/item` |
| 物品 | `drop` | `{item, count?}` | Lua `actions/item` |
| 物品 | `heal` | `{}` | Lua `actions/item` |
| 容器 | `store` | `{ref?｜container, item, count?}` | Lua `actions/container` |
| 容器 | `take` | `{ref?｜container, item, count?}` | Lua `actions/container` |
| 战斗 | `fight` | `{ref?, style?: "safe"}` | Lua `actions/combat`（M4） |
| 战斗 | `flee` | `{from?, seconds?}` | Lua `actions/combat`（M4） |
| 生活 | `sleep` | `{}` | Lua `actions/item` |
| 生活 | `say` | `{text}`（≤160 字） | Lua（聊天） |

> 一共 27 行（`gather/harvest` 与 `make_fire/add_fuel` 算同组），落在 25~27 个工具区间 —— 比现在的 35 或 43 都少，**没有一条是"给模型看的规则文本"，全是可执行动作**。

---

## 6. 从现状搬到目标：对照表

| 现在 | 目标位置 | 动作 |
|---|---|---|
| `scripts/whale/actions.lua`（1746 行） | `scripts/whale/actions/*` | 按边界拆分 |
| `scripts/whale/observe.lua`（368 行） | `scripts/whale/observe/*` | 拆分 + 加 `#N`/delta/预算 |
| `scripts/whale/bridge.lua`（388 行） | `scripts/whale/transport/file.lua` | 改名 + 加 shard |
| `scripts/main/http_client.lua` | `scripts/whale/transport/http.lua` | 保留，加 since ack |
| `scripts/main/threat_observer.lua` | `scripts/whale/observe/threat.lua` | 合并 |
| `scripts/main/combat_executor.lua` | `scripts/whale/actions/combat.lua` | 暂缓（M4） |
| `scripts/main/task_runner.lua` | `scripts/whale/actions/tasks.lua` | 暂缓（M4，先修 bug） |
| 其余 `scripts/main/*`（16 个） | `DontStarveWhaleSurvivor/legacy/scripts-main/` | 归档（不 import） |
| `lib/tools.js`（35 工具） | `lib/tools/{registry,local,actions,macros}.js` | 重建为 25 个 |
| `lib/bridge.js` | `lib/runtime/transport-file.js` | 改名分层 |
| `lib/mcp-server.js` | `lib/mcp.js` | 只调用 registry |
| `lib/agent.js` | `lib/agent/{loop,provider}.js` | 吸收 TS 版 |
| `agent/src/llm/openaiProvider.ts` | `lib/agent/provider.js` | 吸收 |
| `agent/src/runtime/agentLoop.ts` | `lib/agent/loop.js` | 吸收 |
| `mcp-server/src/survival/*`（3023 行） | `lib/analysis/*` | 吸收（纯计算） |
| `game-bridge/src/{commands,control,auth}.ts` | `lib/runtime/transport-http.js` + `lib/state/control.js` | 吸收（M2） |
| `bridge/`、`survival/`、其余 TS 壳 | `legacy/` | 归档 |

---

## 7. 反模式清单（出现即打回）

1. **两个地方都能改游戏状态**（第二执行器、第二工具表、第二控制权）。
2. **同一个文件里既有观察又有动作**（`whale/observe.lua` 现在有 12 格硬编码，`actions.lua` 1746 行什么都有）。
3. **只有协议没有入口的包**（`survival/` 那种：1211 行、无 `index.ts`、无人 import）。
4. **"能跑但没接进工具表"的代码**（历史上 `pickup` 就这样被埋了半个月）。
5. **给模型看的规则写成大段 prompt，而不是写成工具约束/程序门槛**（星露谷版的经验：策略写在 description 里比写在 system 里有效）。
6. **依赖"日志单行不超长"**（3.9K 截断是实测事实）。
7. **在 Lua 里放密钥**（`bws_config.lua` 已含明文 token，M2 要改成运行时配对）。
8. **新增一个服务来解决进程内能解决的问题**。

---

## 8. 目录验收清单（M1 结束时逐条打勾）

- [ ] `modmain.lua` 的 `modimport` 全部指向 `scripts/whale/**`，没有 `scripts/main/`
- [ ] 全仓库只有一处 `BufferedAction(`（`actions/` 内），只有一处 `Lease.acquire` 调用点之外**没有**绕过
- [ ] 全仓库只有一个工具注册表（`lib/tools/registry.js`），`lib/mcp.js` 与 `lib/runtime/server.js` 都从它取
- [ ] 全仓库只有一个 LLM 调用循环（`lib/agent/loop.js`）
- [ ] 每个 Lua 文件都以 `local pcall = GLOBAL.pcall` 那类兼容头开头（或用 `sandbox.lua`）
- [ ] `tests/tool-parity.test.mjs` 是**双向**的且为绿
- [ ] 每个 `whale_*.json` 文件名在 Lua 与 Node 两侧都能各搜到一次，且有测试钉住
- [ ] `legacy/` 与 `DontStarveWhaleSurvivor/legacy/` 都不被任何运行代码 import
- [ ] `docs/` 里 M0 四篇齐备，且与代码现状一致（改代码要改文档）
