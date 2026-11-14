# 架构（当前有效）

> 本文只描述**现在真正在跑**的系统。历史架构（A 栈的 TypeScript bridge / mcp-server / agent、
> HTTP 18788 那一套）已全部归档，见 [`archive/milestones/INDEX.md`](archive/milestones/INDEX.md)。
>
> 对应代码：`DontStarveWhaleSurvivor/`（Lua 模组，0.31.1）+ `lib/`（DSH 插件，0.9.2）

---

## 1. 一句话

**游戏里的 Lua 模组负责"看"和"做"，插件进程里的 Node 负责"想"和"管"，中间用本机 JSON 文件桥连接。**

DSH 不能直接把鼠标点进游戏，饥荒的 Lua 模组也不能监听端口。所以整条链路被拆成三个互不信任的角色，
用"谁写哪个文件"来划分权限。

---

## 2. 核心架构图

```
┌──────────────────────────── 调用方（任选其一，共用同一条链路）────────────────────────────┐
│  ① DSH 会话：模型 → MCP 工具（Streamable HTTP + SSE）                                      │
│  ② 游戏里按 F8：插件内置 AI → 同一套工具定义                                               │
└───────────────────────────────────────┬─────────────────────────────────────────────────┘
                                        │  工具 = lib/tools.js 的 TOOLS（34 个 = 3 本地 + 31 动作）
                                        ▼
┌──────────────────────────── DSH 插件进程（Node，lib/）────────────────────────────────────┐
│                                                                                          │
│  tools.js  executeTool()                                                                 │
│     ├─ 本地工具 → 读快照/写笔记（get_state / get_guide / update_notes）                       │
│     └─ 动作      → dispatcher.dispatch()  ────────────────┐                               │
│                                                            │                               │
│  dispatcher.js  ①参数与快照校验 ②拿控制租约 ③写命令 ④等结果 ⑤核对真实状态  ◄── 唯一允许    │
│                 （白名单：ACTION_SPECS 的全部 31 个动作）                      下发动作的地方 │
│                                                                                          │
│  actions/specs/*.js   按领域拆分的动作规格（movement / gathering / crafting / ...）        │
│                       每个动作声明 riskLevel / 参数白名单 / verify（核对方式）              │
│  actions/state-query.js  快照查询：背包两种 JSON 形状、装备栏两种形状的统一读取            │
│                                                            │                               │
│  control.js     Control Lease（本机文件锁 + 跨进程互斥 + 换手 ACK）                        │
│  bridge.js      文件桥客户端：找目录、读状态、写命令、读结果、权威性判定                     │
│  state/snapshot.js  把 whale_state.json 归一化成同一份快照（文本渲染 / 字段校正）           │
│  mcp-server.js  MCP 服务器（HTTP，默认 18090）        agent.js  F8 内置 AI 循环             │
│  index.js       插件入口：配置、预设、入口工具、自动装模组                                   │
└───────────────────────────────────────┬─────────────────────────────────────────────────┘
                                        │  本机文件桥（游戏存档目录 / 模组目录）
                    ┌───────────────────┴───────────────────┐
                    │  whale_state.json  ← 模组写，Node 读  │   状态（1 秒一版）
                    │  whale_cmd.json    ← Node 写，模组读  │   指令（8 秒有效期）
                    │  whale_result.json ← 模组写，Node 读  │   结果（单槽）
                    │  *.lease/*.ack     ← 双方写            │   控制租约与换手回执
                    └───────────────────┬───────────────────┘
                                        ▼
┌──────────────────────────── 游戏进程（Lua 模组，DontStarveWhaleSurvivor/）────────────────┐
│                                                                                          │
│  observe.lua    把世界翻成文字（时间/位置/三维/背包/附近/威胁）→ 写 state                  │
│  nearby.lua     结构化附近：9 个桶、带 #N 引用、带 snapshot_id、带 delta                   │
│  actor.lua      Actor Provider：只认"本地主机、活着、非灵魂"的那个玩家                     │
│  bridge.lua     读命令、写结果、维护租约回执（含 job_cleared）                             │
│  guard.lua      ★ 第二道闸：白名单 + 参数 + 目标 + 租约 + 代际 + 权限，逐条复核             │
│  actions.lua    动作实现：BufferedAction + locomotor:PushAction（和玩家点鼠标同一条路）     │
│  macros.lua     宏（仍在，但**不对模型开放**）                                             │
│  reflex.lua     保命反射：血少/天黑/火灭/贴脸时自己动手（只在没有任务时）                   │
│  hud.lua        游戏内 HUD；config.lua 配置（夹到安全区间）                                │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**为什么要有两道闸**：Node 侧的白名单防"模型乱点"，Lua 侧的 guard 防"Node 被绕过/被改坏"。
两边都必须校验目标仍然合法——因为从 Node 判断到游戏执行之间，世界可能已经变了。

---

## 3. 三个角色与职责边界

| 角色 | 能做什么 | 不能做什么 |
|---|---|---|
| **Lua 模组** | 读世界、写状态、执行 `BufferedAction`、写结果、维护租约回执 | 不能监听端口、不能调用网络、不能自己决定动作 |
| **插件进程（Node）** | 解析状态、暴露工具、校验与授权、写命令、核对结果 | 不能直接改游戏内存、不能跳过 guard（它根本改不了 Lua） |
| **调用方（模型/F8）** | 调工具、读回执 | 不能直接写命令文件、不能指定任意 prefab、不能绕过 `snapshot_id` |

---

## 4. 文件桥

### 4.1 文件与方向

| 文件 | 谁写 | 谁读 | 作用 | 时效 |
|---|---|---|---|---|
| `whale_state.json` | 模组 | Node | 世界状态（文本 + JSON） | 每 1 秒重写；> 5 秒算过期 |
| `whale_cmd.json` | Node | 模组 | 一条动作指令 | **8 秒**（过期不执行） |
| `whale_result.json` | 模组 | Node | 结果回执 | 单槽，可能被 reflex 覆盖 |
| `whale_settings.json` | Node | 模组 | 攻略/额外要求等 | 随改随推 |
| `whale_pause.json` | Node | 模组 | 「思考时暂停」开关 | — |
| 租约/回执 | 双方 | 双方 | Channel 1（持久化，Klei 头）写租约；ACK 由模组写 | TTL 30 秒 |

**两条通道**：`persist`（走 `TheSim:GetPersistentString` / `SetPersistentString`，带 Klei 头，跨重启保留）
和 `io`（普通 JSON 文件，走 bin64）。Lua 沙箱里 `GLOBAL.io == nil`，所以权威性判断走 persist 的
`Whale.authority_cache`（5 秒新鲜度）。

### 4.2 为什么用文件而不是 socket

饥荒的 Lua 沙箱不提供监听能力。文件桥是唯一在"模组不能开端口"前提下的可行方案，
代价是**延迟**（状态最多 1 秒旧）和**单槽覆盖**（见 `STATUS.md` 已知问题）。

---

## 5. 状态读取（模组 → Node）

1. `observe.lua` 每 `state_interval`（默认 1 秒）把世界翻成文字 + JSON，写 `whale_state.json`。
2. `nearby.lua` 按 `observe_interval`（默认 2 秒）重算附近，结果缓存 `scan_seconds`（默认 4 秒）。
3. Node 侧 `lib/bridge.js` 找到状态文件（多路径探测 + 按 mtime 选最新的活跃分片）。
4. `lib/state/snapshot.js` 把 JSON 归一化：统一字段名、补默认值、算 `ageMs`、
   渲染成给人看的中文文本。**F8、MCP、HUD、测试都走这一个函数**，所以三方看到的是同一份快照。

---

## 6. Nearby（模型看到的"附近"）

- **9 个桶**，顺序固定：`threats`（威胁）→ `pickupables`（可拾取物）→ `harvestables`（可收获）→
  `food`（食物）→ `resources`（资源）→ `containers`（容器）→ `structures`（建筑）→
  `creatures`（生物）→ `other`（其他）。
- **上限**：总数 60、每桶 12。超出按距离取近的，并在文本里标 `×N`（stack）与"已成熟/未成熟"。
- **引用**：每个条目有 `#N`，**只在当前 `snapshot_id` 内有效**。
  `snapshot_id = <runtime_id>-n<扫描序号>`：`runtime_id` 区分进程/世界，`n` 区分第几次扫描。
  世界重载后 `runtime_id` 变，旧引用自动作废。
- **Delta**：与上一次**完整扫描集合**（不是上一帧截断后的列表）对比，算出新增/消失/变化，
  避免"因为超出上限被截掉"被误报成"消失了"。
- 只有 `pickupables` / `harvestables` 里的条目能被对应动作使用；
  白名单本身在 `pickuprules.lua` / `harvestrules.lua`，**观察侧和执行侧共用同一份**。

---

## 7. 工具表面（34 个）与共用链路

```
TOOLS = [get_state, get_guide, update_notes]        ← 本地：读快照 / 写笔记
      + ACTION_SPECS 的 31 个动作                   ← 必须过 dispatcher
```

动作按领域放在 `lib/actions/specs/`：

| 文件 | 动作 | 数量 |
|---|---|---|
| `movement.js` | move_to / stop / seek | 3 |
| `gathering.js` | pickup / harvest / gather / gather_area / chop / mine / dig / hammer | 8 |
| `crafting.js` | craft / build / cook | 3 |
| `survival.js` | eat / equip / unequip / drop / fuel / wait | 6 |
| `interaction.js` | use / container_take / container_put / give | 4 |
| `combat.js` | attack / kill | 2 |
| `info.js` | recipes / lookup / probe / inspect | 4 |
| `social.js` | say | 1 |

`lib/actions/state-query.js` 集中处理"快照的两种 JSON 形状"（背包数组/对象、装备 slots/worn），
所有 `verify()` 都基于它做前后比对。

- 这 3 个**本地工具**不进 dispatcher：`get_state` / `get_guide` 只读快照与攻略；
  **`update_notes` 会写本地文件**（覆盖 `~/.dsh/plugins-data/…/notes.md`，空字符串 = 清空）。
- F8 的 `agent.js` 和 MCP 的 `mcp-server.js` 都调**同一个** `executeTool()` 和**同一份** `TOOLS`。
- 所以"F8 能做的事"和"MCP 能做的事"必然一致，不存在两条链路。
- dispatcher 的白名单 `OPEN_ACTIONS = Object.keys(ACTION_SPECS)` 是唯一开关：工具表里有的动作，
  这里不放行也会被拒；两边完全对齐（`tool-parity.test.mjs` 盯着）。
- `RULES` 里的能力清单**从 `ACTION_SPECS` 生成**，不再手写数字（`prompt-parity.test.mjs` 盯着），
  所以加一个动作不会出现"代码能用、说明书还说没有"的漂移。

---

## 8. Control Lease（谁有权操作这个角色）

目的：F8 内置 AI 和 DSH 会话**不能同时**下指令；换手必须干净，不能让上一条指令打在新世界或新主人身上。

- **Schema**：`bws.control-lease/1`，记录 `owner` / `owner_instance` / `generation` / `runtime_id` /
  `authority_epoch` / `acquired_at` / `expires_at`。
- **TTL**：租约 30 秒（心跳续约），文件锁 5 秒。
- **两阶段换手**：`revoking`（旧主人还在跑）→ 等它交回 `ack` → `active`（新主人可以动）。
- **ACK 硬条件**（`control.js` `completeHandover`，缺一不可）：
  1. `job_cleared === true`（严格布尔）—— **游戏里确实没有任务在跑**
  2. `lease_id` 必备且匹配
  3. `authority_epoch` / `generation` / `runtime_id` 全部匹配
  4. 有 `acked_at`，不早于本次换手开始（允许 3 秒时钟偏差），不超过 15 秒
  不满足就**保持 revoking**，绝不"先把权给出去再说"。
- 权威性来源：模组的 `authority_cache`（persist 通道，5 秒新鲜度）；读不到就按"不可信"处理。

---

## 9. Action Dispatcher（Node 侧，唯一的动作出口）

```
dispatch({tool, args, owner})
 ├─ 0. 动作在白名单里吗？                    → action_not_allowed
 ├─ 1. 参数结构对不对（ajv/schema）          → bad_args
 ├─ 2. requiresSnapshot：snapshot_id 是当前快照吗 → stale_snapshot
 ├─ 3. 拿控制租约（必要时换手）               → lease_* / authority_*
 ├─ 4. 写 whale_cmd.json（带 command_id / 过期时间 / 租约指纹）
 ├─ 5. 等 whale_result.json（超时 → unknown/result_timeout）
 └─ 6. 核对真实状态（见 §11）                  → succeeded / unverified / failed
```

- 命令有效期 **8 秒**：游戏卡住时不会执行几分钟前的旧指令。
- 结果只认 `command_id` 对得上的那份；对不上就是 `unknown`（不猜、不重试）。
- 每种动作在自己的规格里声明核对方式（`verify`）与等待时间（`verifyWaitMs`）：
  `move_to` 2.5s、`pickup` 3s、`harvest` 4s、`build` 5s。

---

## 10. Lua Guard（游戏侧，第二道闸）

顺序（任一不满足就 `Report(false, reason)`，**一条动作都不执行**）：

1. 协议/版本、`command_id` 存在且不重复（防重放）
2. 动作在白名单里（`move_to` / `stop` / `pickup` / `harvest`）
3. 命令没过期、租约有效（`lease_id` / `generation` / `authority_epoch` / `runtime_id`）
4. 这个角色归我管（本地主机、活着、非灵魂）、没有别的任务在跑
5. 参数逐个校验（类型/范围/长度/格式），**多余参数直接拒**
6. 目标校验：还在吗（`entity_gone`）、在白名单里吗（`prefab_not_allowed`）、
   状态对吗（`not_ready` / `already_harvested` / `target_busy`）、
   距离对吗（`out_of_range`，照抄原生 `PickRangeCheck`）
7. 组件的动作执行权限（`canbepicked` / `caninteractwith` / 不是 `stuck`）

**关键原则**：Node 侧校验过的结论，Lua 侧**重新算一遍**。两边都不信任对方的结论。

---

## 11. 动作执行与结果确认

**执行**：`actions.lua` 里每个动作是一个状态机函数（`JOBS.xxx`），返回 `run` / `done` / `fail`。
真正动手用 `BufferedAction(player, target, ACTIONS.XXX)` + `locomotor:PushAction`，
和玩家点鼠标走的是同一条路——所以游戏自己的距离、动画、打断规则全都生效。

**确认**（不以"函数返回成功"为准，以世界真实变化为准）：

| 动作 | 核对路径（命中任一） |
|---|---|
| `move_to` | 位置到点 / 距离明显变小 |
| `pickup` | 背包里该 prefab 数量 +1 / 目标从地上消失 |
| `harvest` | ① 背包里产物 +1 ② 同一株（prefab+坐标）`harvest_ready` 由 true 变 false ③ 目标消失 |

都对不上就返回 `unverified` 或 `unknown`——**模型不该自己宣布成功**。
`harvest` 特意保留"产物没进背包"的可能（背包满时原生会掉地上），所以回执会明说。

---

## 12. 安全边界（这些不能因为"瘦身"被删掉）

1. Actor Provider（只认一个玩家）
2. Nearby 的 `#N` 引用 + `snapshot_id`（引用不能跨快照）
3. Pickup / Harvest 白名单（观察侧与执行侧共用一份）
4. Action Dispatcher（唯一动作出口）
5. Control Lease（含两阶段换手与 ACK 硬条件）
6. Lua Guard（白名单 + 参数 + 目标 + 租约复核）
7. Command Protocol（`command_id`、防重放、8 秒过期）
8. ACK / Handover（`job_cleared` 等五条硬条件）
9. 目标校验（存在性、白名单、状态、距离、组件权限）
10. 动作执行与结果确认（以真实状态为准）

M2.2.1 的瘦身**只删了模型可见但永远被拒的工具定义**，上面 10 条一条没动（有测试守着）。

---

## 13. 计划层（Plan：减少每轮重新规划）

`lib/plan.js` 是**纯函数**：输入一份归一化快照，输出「当前目标 + 原因 + 下一步」。
它不调模型、不改世界、不写游戏文件，只把"现在最值得做的一件事"固定下来。

- **优先级固定**：灵魂（revive）> 脱战（retreat）> 光源（light）> 回血（heal）> 进食（eat）
  > 补理智（sanity）> 存粮（stock_food）> 白天备火把材料（prep_light）> 斧头（tool_axe）
  > 镐（tool_pickaxe）> 探索（explore）。
- **稳定保持**：上一份计划的世界（`nearby.runtime_id`）没变、旧目标仍然成立、
  且没有更高优先级的新目标时，沿用旧目标（`changed=false`，`since` 不变），
  避免模型每轮在"吃 / 砍树 / 探路"之间来回翻烧饼。
- **可核对**：目标是否成立只看快照字段（灵魂、血量、饥饿、相位、背包、附近桶），
  不依赖模型自己说"做完了"。
- **省 token 的注入方式**：`get_state` 文本末尾输出完整计划，JSON 模式放在 `plan` 字段；
  F8 每轮只注入一行紧凑计划，只有目标切换时才展开完整版。
- F8 与 MCP 通过 `lib/index.js` 的 `sharedPlan` 共用同一份计划，换入口不会重新规划。
