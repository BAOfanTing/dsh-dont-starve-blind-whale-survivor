# 当前状态

> 最后更新：SURVIVAL-02.1（生存优先级 + 火源提前准备 + 紧急抢占 + 基础需求）｜**以代码和真实运行状态为准**，不凭计划推断。

---

## 1. 版本

| 位置 | 版本 | 含义 |
|---|---|---|
| `DontStarveWhaleSurvivor/modinfo.lua` | **0.37.0** | **游戏内 Lua 模组的版本**。每改一次模组 Lua（哪怕只是注释）就升一位。 |
| `package.json` | **0.9.3** | **DSH 插件（Node 侧）的版本**。跟着插件功能走。 |

两个版本号**故意不同步**，它们描述的是两个交付物：
模组装进游戏 `mods/`，插件装进 DSH。给 AI 看的状态里报的是**模组版本**（`0.37.0`）。
判断"磁盘上的模组装没装进游戏"请看 `install-mod.mjs` 的输出（`installedVersion`）。

> 历史遗留：`package.json` 长期停在 0.9.x，模组已经到 0.30.x。M2.2.1 决定**不建同步机制**，
> 只在这里说清两者含义，避免下一个人误以为版本号写错了。

---

## 2. 现在能做什么

### 2.1 模型可见的工具（34 个 = 3 本地 + 31 动作）

> 分类：`get_state` / `get_guide` = **只读**；`update_notes` = **本地写入**（会覆盖写笔记文件）；
> 其余 31 个 = **游戏动作**，全部必须过 dispatcher。
> 权威清单是 `lib/actions/specs/*.js` 的 `ACTION_SPECS`：`OPEN_ACTIONS`、`TOOLS`、`RULES` 的能力段
> 都从它派生，有 `tool-parity` / `prompt-parity` 两组测试盯着。

| 工具 | 类型 | 说明 |
|---|---|---|
| `get_state` | 只读 | 时间/位置/三维/背包/附近/威胁；`format=json` 给结构化数据 |
| `get_guide` | 只读 | 攻略四篇：主攻略 / 生存 / 战斗 / 烹饪（玩家可覆盖） |
| `update_notes` | **本地写入** | 写长期笔记（覆盖 `~/.dsh/plugins-data/dsh-dont-starve-blind-whale-survivor/notes.md`），下次 `get_state` 显示在最前 |
| `move_to` | 动作 R1 | 走到格子坐标，自动绕障，报告还差几格 |
| `stop` | 动作 R1 | 立刻停下 |
| `pickup` | 动作 R2 | 捡地上的树枝/草/燧石（`#N` + Nearby 快照 ID，不自动走） |
| `harvest` | 动作 R2 | 采成熟浆果丛（`berrybush`/`berrybush2`，不自动走、不自动捡） |
| **`gather`** | 动作 R2 | **SURVIVAL-01 新增**：采草丛 `grass`（得 cutgrass）/ 树苗 `sapling`（得 twigs） |
| **`eat`** | 动作 R1 | **SURVIVAL-01 新增**：吃背包里的白名单食物（不填 = 服务端挑最该吃的） |
| **`craft`** | 动作 R2 | **SURVIVAL-01 新增**：只做 `torch`(2 草+2 树枝) / `axe`(1 树枝+1 燧石) / `pickaxe`(2 树枝+2 燧石) |
| **`equip`** | 动作 R1 | **SURVIVAL-01 新增**：把 `torch` / `axe` / `pickaxe` 拿在手里 |
| **`gather_area`** | 动作 R2 | **SURVIVAL-02 新增**：一次采完附近能采的（可只采某一种）—— 省调用次数 |
| **`seek`** | 动作 R2 | **SURVIVAL-02 新增**：8 方向 × 多环走出去找东西，只报位置、不自动动手 |
| **`chop` / `mine` / `dig` / `hammer`** | 动作 R2 | **SURVIVAL-03**：砍树 / 挖矿 / 铲草皮树桩 / 拆建筑（要对应工具） |
| **`attack` / `kill`** | 动作 R2 | **SURVIVAL-03**：打几下 / 打到死（血低于 25% 自动放弃） |
| **`wait` / `drop`** | 动作 R1 | **SURVIVAL-03**：等一会儿 / 丢背包里的东西 |
| **`unequip` / `fuel` / `use` / `inspect` / `say`** | 动作 R1/R2 | **SURVIVAL-04**：脱装备 / 添柴 / 通用交互 / 查目标详情 / 聊天 |
| **`container_take` / `container_put` / `give` / `cook`** | 动作 R2 | **SURVIVAL-05**：容器取放 / 给予 / 锅 |
| **`build` / `recipes` / `lookup` / `probe`** | 动作 R2/R1 | **SURVIVAL-06**：摆建筑（白名单 5 种）/ 查配方 / 查资料 / 探附近 |

**仍未开放**（工具表里没有，调了会报「没有这个工具」）：
`pick`（手摘蘑菇/胡萝卜）、`heal`（主动回血）、`sleep`、`make_fire`、`add_fuel`，
以及全部宏（`gather / chop_until / cook_meal / night_watch`）。

### 2.2 非模型能力（仍然在跑）

- **F8 内置 AI**：在游戏里按 F8，用插件里的 API Key 自己玩（和 MCP 共用同一套工具定义与链路）。
- **HUD**：游戏内显示 AI 的状态与最近动作。
- **reflex（保命反射，默认开）**：血/饿见底、入夜没光、火要灭、被贴脸、理智过低时自己动手
  （安全进食/上药、举或做火把、添柴、后撤、采花、紧急采浆果）。白天还会提前备 2 草 + 2 树枝。
  **只在没有任务在跑时插手**；它占用 Actor 时模型的动作会收到 `actor_busy`（正常现象，先 `stop` 再试）。
- **计划层（Plan）**：从快照推导当前唯一目标并保持稳定；F8 目标不变时只注入一行紧凑计划，
  目标切换时才展开完整状态，减少每轮重新规划与 token 开销。
- **Control Lease**：F8 与 DSH 会话不会同时操作；换手要等旧主人交回 `job_cleared` 的 ACK。
- **Lua Guard**：Node 校验过的每一条结论，游戏里会**重新算一遍**。

---

## 3. 已完成的阶段

| 阶段 | 做了什么 | 验证级别 | 原始文档 |
|---|---|---|---|
| **M0** | 架构审计、DST 原生 API 实测、迁移决策（B 栈唯一运行） | STATIC + RUNTIME（API） | `archive/milestones/M0/`、`archive/api/M0_api_validation.md` |
| **M1.0** | B 栈唯一运行，A 栈归档 | UNIT + RUNTIME | `archive/milestones/M1/M1_0_*` |
| **M1.1** | Actor Provider + 统一 `get_state` | UNIT | `archive/milestones/M1/M1_1_*` |
| **M1.2** | 真机冒烟（真实存档/分片） | RUNTIME | `archive/milestones/M1/M1_2_*` |
| **M1.4** | 结构化 nearby + `#N` + Delta + 上限 + runtime_id | UNIT + RUNTIME | `archive/milestones/M1/M1_4_*` |
| **M2.0** | Action Dispatcher + Control Lease + 跨进程互斥 | UNIT | `archive/milestones/M2/M2_*`、`archive/security/M2_security_matrix.md` |
| **M2.0.1** | 租约安全审计（发现 `job_cleared`/`lease_id` P0） | STATIC | `archive/security/M2_0_1_lease_security_audit.md` |
| **M2.0.2** | 修复 + 跨进程锁 + 真机探测 3 轮 | UNIT + RUNTIME | `archive/security/M2_0_2_*` |
| **M2.0.3** | 真机换手验证 **16/16** | RUNTIME | `archive/security/M2_0_3_runtime_verify.md` |
| **M2.1** | `pickup`（第一个写动作，含真实闭环） | UNIT + RUNTIME | `archive/milestones/M2/M2_1_*`、`archive/api/M2_1_pickup_api_audit.md` |
| **M2.2** | Actionable Nearby（`pickupables` 桶、共享白名单） | UNIT + RUNTIME | `archive/milestones/M2/M2_2_*`、`archive/api/M2_2_nearby_audit.md` |
| **M2.3** | `harvest`（浆果丛试点，真机 **14/14**） | UNIT + RUNTIME | `archive/milestones/M2/M2_3_*`、`archive/api/M2_3_harvest_api_audit.md`、`archive/security/M2_3_harvest_security.md` |
| **M2.2.1** | 全项目瘦身：文档归档 104 篇、工具表 37 → 7、A 栈代码归档 | UNIT（本次只有单测复跑） | `REFACTOR_AUDIT.md` |
| **STABILITY-01** | 0.17.2 真机验收（get_state / nearby / 四个动作 / 安全底座）+ guide 指南与 7 个工具对齐 | UNIT + **RUNTIME**（§4.1）；F8 与端到端 NOT_RUN | 本节 §4.1 / §4.2 |
| **AGENT-01** | 真实 LLM 闭环（move_to 真走） | RUNTIME（部分）；pickup/harvest 未跑通 | `AGENT_01_report.md` |
| **AGENT-01.1** | P1 Nearby 快照 ID 可见性 + P2 Lease 换手有限等待 | UNIT（503/503）；真机补测见 §4.3 | 本节 §4.3 |
| **SURVIVAL-01** | 四个基础生存动作 gather / eat / craft / equip（工具 7 → 11） | UNIT（515/515）；真机见 §4.5 | 本节 §4.5 |
| **SURVIVAL-02** | 稳定计划层 + 默认保命反射（提前进食/补理智/备火把/脱战）+ HUD 挂载修复 | UNIT（531/531）；RUNTIME NOT_RUN | 本节 §3 / §4 |
| **SURVIVAL-02.1** | 先查真实死因；修 prep_light；白天做火把 + 材料保护；P0/P1/P2 安全抢占；饥饿/生命不被任务阻塞；防抖 + 诊断日志；白天不点火 + 按整夜囤料；没草时改走 firepit + 有界找料；固定巢穴不挡收纳 + 捡地上现成材料；修 unequip 丢物品 + 黄昏不抢占死锁；修 GiveItem 参数坑；饥饿/温度抢占前预判；**黄昏不举火把、入夜才举（修正燃料账）** | UNIT（599/599）；RUNTIME 见 §4.6 | 本节 §4.6 |

---

## 3.5 SURVIVAL-02.1：死亡原因（真实证据）

**结论：这局小鲸鱼不是死于黑暗。** 依据是本机真实存档的聊天日志与服务器日志，不是推测。

### 3.5.1 最近 10 次真实死亡（`Cluster_1/Master/backup/server_chat_log/*`，2026-11-14）

| # | 时间 | 死因（游戏原生死亡播报） | 归类 |
|---|---|---|---|
| 1 | 00:28 | 爬行恐惧 | 暗影生物（低理智生成） |
| 2 | 13:10 | 恐怖尖喙 | 暗影生物 |
| 3 | 13:34 | 青蛙 | 群体敌对生物 |
| 4 | 15:16 | 恐怖尖喙 | 暗影生物 |
| 5 | 16:10 | 爬行恐惧 | 暗影生物 |
| 6 | 16:51 | 爬行恐惧 | 暗影生物 |
| 7 | 16:51 | 爬行恐惧 | 暗影生物 |
| 8 | 17:40 | 爬行恐惧 | 暗影生物 |
| 9 | 18:31 | 爬行恐惧 | 暗影生物 |
| 10 | 18:45 | 青蛙 | 群体敌对生物 |

**统计：爬行恐惧 6、恐怖尖喙 2、青蛙 2。黑暗 0、饥饿 0。**

### 3.5.2 为什么"黑暗死亡"这条假设在这个世界不成立

- 服务器日志里世界设置：`K: darkness V: nonlethal`。对应 `TUNING.NONLETHAL_DARKNESS=true`，
  `scripts/components/grue.lua` 的非致命逻辑把黑暗伤害钳制在 `NONLETHAL_PERCENT(0.2)` ——
  也就是**查理最多把你打到 20% 血，打不死**。（`GRUEDAMAGE = wilson_health*0.667`）
- 另有 `healthpenalty=none`、`ghostsanitydrain=none`、`ghostenabled=always`。
- 所以真正的致死链是：**夜里没光 → 理智暴跌 → 刷暗影怪（爬行恐惧/恐怖尖喙）→ 血量本就偏低 → 被打死**；
  另外青蛙群在营地附近把残血角色围死。这与"火把/光源"仍然是强相关（没光=理智崩），
  但**直接把死因归到"黑暗伤害"是错的**，必须同时盯理智。

### 3.5.3 为什么"保命机制没起作用"——最重要的一条

`Cluster_1/{Master,Caves}/modoverrides.lua` 里 **`REFLEX=false`**。服务器启动日志逐字确认：

```
Overriding mod DontStarveWhaleSurvivor's option REFLEX with value false
Loading mod: DontStarveWhaleSurvivor (大肥鱼饿不死 (Blind Whale Survivor)) Version:0.30.0
```

即：**默认开启 ≠ 旧存档实际开启**；这 10 次死亡全程 `Whale.reflex_on=false`，反射一次都没跑。
（另一个证据：状态文件 `mod:"0.30.0"`，说明当时跑的是旧版本，本次改完已升到 0.33.0、需重新读档。）

即使反射开着，旧代码还有这些问题（本次已修）：
`reflex_stock_light` 采够材料就 `return false`（从不做火把）；白天不做火把；除黑暗/被贴脸外，
`if Whale.job ~= nil then return end` 把饥饿/生命/理智处理整体跳过；`prep_light` 的 `when`
一旦材料够就消失。

> 诊断补充：本阶段仍未拿到逐帧的"死亡前生命/饥饿/理智"曲线（旧版本不落这份数据）。
> 已新增 `[Reflex]` 诊断日志与 `Whale.reflex.Diagnose()`，可在 server_log / get_state 里看到
> 光源是否可用、材料是否齐、优先级与抢占原因，供下一次复盘。

---

## 4. 验证等级（严格区分，别混）

| 级别 | 含义 | 现在的覆盖 |
|---|---|---|
| **STATIC** | 只读代码/文档，没有执行 | 各阶段审计报告的结论部分 |
| **UNIT** | 单进程单测（Node 测试 + fengari Lua 沙箱 + 假游戏） | **531 项全绿**；覆盖工具表一致性、提示词一致性、guard、dispatcher、lease、nearby、pickup、harvest、plan、reflex |
| **RUNTIME** | 真实游戏在跑，模组在游戏里执行 | **0.17.2：已跑（见 §4.1）**；更早的 M1.2 / M1.4 / M2.0.2 / M2.0.3 / M2.1 / M2.2 / M2.3 是各自阶段当时的成绩 |
| **END_TO_END** | 模型 → MCP → 命令 → 游戏动作 → 结果 → 模型，完整链路 | 真机验证脚本走的就是这条链路（MCP 产品入口 → 游戏 → 回执）；**没有**用真实 LLM 做长跑 |

### 4.1 0.17.2 的真实验证结果（STABILITY-01，2026-11-13）

**没有把 0.17.1 的成绩继承过来**：下面每一条都是这次在 0.17.2 上重新跑的。

| 项 | 结果 | 证据类型 |
|---|---|---|
| 游戏内存里加载的版本 | **0.17.2**（状态文件的 `mod` 字段，不是磁盘推断） | RUNTIME |
| Master + Caves 两个分片加载 | 14 个 `modimport` 全部成功、注册正常、**无 Lua 错误/栈回溯** | RUNTIME |
| 状态文件持续更新 | 采样 5 次，年龄 111~157 ms | RUNTIME |
| `get_state` / nearby | 9 桶齐全、`#N` 全局唯一、单桶上限生效、扫描 2ms | RUNTIME |
| `stop` | 多条命令返回"停下了"；Abort 后逐帧采样确认角色停住 | RUNTIME |
| `move_to` | 真走：(-14,28) → (-13,28)，落到目标 1 格内 | RUNTIME |
| `pickup` | 5/5：move_to 靠近 → 捡起燧石 → 背包 `flint 0 → 1` → 树被拒 → 旧快照被拒 | RUNTIME |
| `harvest` | 13 PASS / 0 FAIL / 1 NOT_OBSERVED：采下浆果丛 → `berries 0 → 1` → 同株 `harvest_ready: true → false` → 再采 `not_ready` → 不自动接续 pickup | RUNTIME |
| 安全底座（lease / ACK / 权威） | 11/11：ACK 去重键带 epoch、陈旧 ACK 全拒、伪造副本不被信任、换手期间旧动作被 Abort | RUNTIME |
| MCP 产品入口 | `/status` 200；`tools/list` = **7 个、全部唯一**、无未开放工具泄漏 | RUNTIME |
| **F8 内置 AI** | **NOT_RUN**：HUD 自报「没配 API Key（插件设置里填）」，且无法在不接管键鼠的前提下模拟 F8 | NOT_RUN |
| **端到端（真实 LLM 长跑）** | **NOT_RUN** | NOT_RUN |

> 说明：真机验证脚本走的就是产品入口（MCP → dispatcher → 文件桥 → Lua guard → 游戏动作 → 回执 → 核对），
> 所以上表的动作项是 END_TO_END 的执行链，只是"下决定的那一段"由脚本而不是 LLM 扮演。

---

### 4.3 AGENT-01.1：P1 / P2 修复与真机补测

| 项 | 状态 | 说明 |
|---|---|---|
| **P1** Nearby 快照 ID 可见性 | ✅ **已修 + 真机验证（RUNTIME）** | `get_state` 现在同时给出「状态快照序列号 s…」和「Nearby 快照 ID：r…-n…」，并在引用块后点明"调 pickup/harvest 要填后者"。**真机 20 次调用里，模型 5 次 harvest 全部填了 `r…-n…`，一次都没再填序列号** |
| **P2** Lease 换手有限等待 | ✅ **已修 + 真机验证（RUNTIME）** | 新增 `acquireWithWait()`（3 秒上限 / 175ms 轮询）。真机 **9 次租约等待共 559ms，0 次 `control_denied`**（AGENT-01 时是连续 2 次失败） |
| **Harvest 真实 LLM 闭环** | ✅ **达成（END_TO_END）** | 模型自主采下 2 株浆果丛：背包 **浆果 0 → 1 → 2**（独立进程读快照复核过） |
| **Pickup 真实 LLM 闭环** | ❌ **NOT_RUN** | 20 次预算内模型全用于移动+采浆果，从未调 `pickup`（工具本身在 STABILITY-01 已真机 5/5） |
| P1 真机补测（0.17.3） | ✅ 已完成 | 世界重载到 0.17.3 后跑的，不是拿 0.17.2 冒充 |
| 提交边界 | ✅ 已确认 | `acquire`/dispatcher 的 `validate` 都在 `bridge.call()`（写命令文件）之前；失败不产生命令文件（测试 P2-12 守着） |

真机细节、逐次调用记录、失败分层见 [`AGENT_01_1_report.md`](AGENT_01_1_report.md)。

**真机又撞到 P3**：第 1 次 `get_state` 读到的还是**上一局"我已死亡"**的笔记，而角色其实满血 200/200。
模型自己发现了并写下"旧笔记作废"。

### 4.4 P3 笔记问题的审计结论（**只审计，未重构**）

| 问题 | 结论 |
|---|---|
| 笔记是否有世界隔离 | **没有**。`notes.md` 只有一个文件，路径固定、与具体世界无关 |
| 有没有可靠的世界标识可用 | **没有**。当前状态里：`cluster_id` = **null**（`cluster_id_source: "unavailable"`）；`session_id` 每次启动都变；`runtime_id` 每次进世界都变；`shard_id` 只区分地表/洞穴。**都不能当"同一个存档"的稳定标识** |
| 是否可能出现跨世界信息污染 | **会**。AGENT-01 真机就撞到过：角色复活后，第一条 `get_state` 读到的还是上一段"我已死亡"的笔记 |
| 当前约束 | 模型必须**以最新 `get_state` 为当前游戏事实**，笔记只当历史参考 |
| 未解决的风险 | ①**没有长度上限**（模型可以写很大的文件）；②**空字符串会清空**（误传就丢笔记）；③覆盖写，没有追加 |
| 处理 | 标记 **NEEDS_REVIEW**，本阶段**没有**设计第二套笔记系统，也没有清空用户已有 Notes |

---

### 4.5 SURVIVAL-01：四个基础生存动作

**能力**（每个动作都走同一条链：`dispatcher` → 租约 → 命令 → `Lua Guard` → 原生动作 → 结果核对）：

| 动作 | 原生实现 | 白名单 | 拒绝码 | 成功判据 |
|---|---|---|---|---|
| `gather` | `BufferedAction(ACTIONS.PICK)` | `grass`→cutgrass、`sapling`→twigs | `prefab_not_allowed` / `already_harvested` / `not_ready` / `target_busy` / `out_of_range` / `stale_snapshot` | 背包产物 +N / 目标消失 |
| `eat` | `BufferedAction(ACTIONS.EAT)` | 13 种手动白名单食物（**不含** monstermeat / rot；自动挑食物只用 AUTO_SAFE，跳过生蘑菇） | `food_not_allowed` / `not_in_inventory` / `no_food` / `not_hungry` | 饥饿 +>0.5 / 该食物 -N |
| `craft` | `builder:MakeRecipe` | `torch` / `axe` / `pickaxe`（都是 TECH.NONE） | `recipe_not_allowed` / `ingredients_missing: …` / `recipe_locked` / `no_builder` | 成品进背包 +1 |
| `equip` | `inventory:Equip(item)` | `torch` / `axe` / `pickaxe` | `item_not_equippable` / `not_in_inventory` | 装备栏 hand 变成它 |

**配方来源（本机 `scripts.zip` 的 `scripts/recipes.lua` 实测，构建 762172）**：

```lua
Recipe2("axe",     {Ingredient("twigs",1), Ingredient("flint",1)},    TECH.NONE)
Recipe2("pickaxe", {Ingredient("twigs",2), Ingredient("flint",2)},    TECH.NONE)
Recipe2("torch",   {Ingredient("cutgrass",2), Ingredient("twigs",2)}, TECH.NONE)
```

**安全设计**（没有为四个动作新建任何架构）：

1. **统一走现有链路**：`Action Dispatcher` / `Control Lease` / `Lua Guard` / `Command Protocol` /
   `Actor Provider` / `Nearby` / `Snapshot Resolve` / 结果核对，**一行都没复制**。
2. **实体类动作（gather）**：和 `pickup`/`harvest` 完全同构 —— 只收 `target_ref` + `snapshot_id`，
   由 `G.resolve_target` 从**当前快照**解析，模型不能给 prefab / 坐标 / GUID。
3. **背包类动作（eat / craft / equip）**：模型只能给**白名单名字**，目标由服务端从
   **角色真实背包**里找（`inventory:ForEachItem`），**不接受 GUID、路径、任意 prefab**。
4. **craft 不做建筑**：`campfire`/`firepit` 虽然也在 `recipes.lua` 里，但**不在白名单**，
   而且走的是 `MakeRecipe`（不摆地上），`job_build` 那条路径根本不会被触发。
5. **饿满不吃**：`not_hungry` 直接拒，避免"吃了没效果"被误报成功，也不浪费食物。
6. **旧 JOB 全部保留**：`pick`/`eat`/`craft`/`equip` 的旧路径（reflex 在用）语义未变，
   新路径由 `ctx.survival_*` 分流 —— 和 `pickup_by_ref` 同一套做法。

**观察侧同步**：`nearby` 的「可收获」桶现在同时装浆果丛和草丛/树苗，并给出 `use_action`
（`harvest` 或 `gather`），文本渲染成 `可收(harvest)` / `可采(gather)` —— 观察与执行共用同一份白名单。

**真机结果（0.18.0，真实 deepseek-v4.1-flash，40 次调用预算）**：

| 项 | 结果 | 证据 |
|---|---|---|
| 世界加载 0.18.0 | ✅ | 状态文件 `mod=0.18.0`；Master 日志 4 个新 rules 全部 modimport 成功、无 Lua 错误 |
| `gather` | ✅ **RUNTIME / END_TO_END** | 模型自主采了 **5 株**：`cutgrass 0→2`、`twigs 0→2`（每株都用对了 `#N` + Nearby 快照 ID） |
| `pickup` | ✅ **RUNTIME / END_TO_END** | `flint 0→2` |
| `move_to` | ✅ | 4/4 成功，位置真的变 |
| `craft` 校验链 | ✅ **RUNTIME** | `ingredients_missing: twigs 1/2`（精确到差几个）、`ingredients_missing: cutgrass 0/2, twigs 0/2`、`recipe_not_allowed`（campfire） |
| `equip` 校验链 | ✅ **RUNTIME** | `not_in_inventory`（背包没有 torch）、`item_not_equippable`（grass） |
| `eat` 校验链 | ✅ **RUNTIME** | `food_not_allowed`（monstermonster）、`no_food`（背包没吃的） |
| `craft` **成功产出** | ⚠️ **NOT_OBSERVED** | 见下 |
| `equip` **成功装备** | ⚠️ **NOT_OBSERVED** | 同上 |
| `eat` **成功进食** | ⚠️ **NOT_OBSERVED** | 模型没到饥饿线（饥饿一直 160+），也没被逼到非吃不可 |

**为什么 craft/equip 的成功路径没验到**：两轮真机里角色都**在黄昏/夜晚死亡**（第 1 天、第 2 天各一次），
死亡会掉落全部物品 → 材料清零，craft 永远差材料。这不是 craft 的问题，是**角色活不下来**
（本阶段明确不做自动生存/战斗，模组的 reflex 只会在"没任务"时帮忙，模型一思考它就插不上手）。

**顺带发现两个真问题（只记录，未修）**：

1. **`gather` 宏重名覆盖（已修）**：`macros.lua` 的 `A.register("gather", …)` 把新增的原子动作
   `JOBS.gather` 直接盖掉了，于是模型调 `gather` 收到的是"要传 resource"（宏的文案）。
   修法：`A.register` 加防覆盖保护（宏不许覆盖同名原子动作）+ 宏改名 `gather_macro`。
   **这是真机第一轮 18 次 gather 全失败的根因。**
2. **reflex 的旧 craft 路径会白扣材料（未修）**：reflex 黄昏时调 `A.Start("craft", {recipe="torch"})`
   走旧路径，`HasIngredients` 只判"有没有"不判"够不够"，`MakeRecipe` 失败时材料已经扣掉。
   现场看到 `cutgrass×2 + twigs×1` 凭空消失（结果文件里是 `{"id":"reflex","text":"torch 材料不够"}`）。
   属于 reflex 范围，本阶段**只记录**。

### 4.6 SURVIVAL-02.1：改了哪些、验证到哪

#### 4.6.1 prep_light 修复前后（`lib/plan.js`）

| | 旧逻辑（有缺陷） | 新逻辑（02.1） |
|---|---|---|
| 触发条件 | `!isDark && torch数==0 && !hasLightMaterials && lightMaterialNear` | `!isDark && !hasPortableLight` |
| 材料不足 | 只有在"20 格内真的有草/树苗"时才触发 | 永远触发；`next` 指向"采缺的那一种"，附近没有就 `seek` |
| 材料刚好够 | `!hasLightMaterials` 为假 → **目标直接消失**（所以永远不做火把） | 目标保留，`next` 变成 `craft torch` |
| 完成条件 | 只要背包没有 torch 就算没准备（不看耐久、不看手上） | **唯一完成条件 = 拥有能带走且还能用的光源**（torch/lantern/minerhat，且耐久>0） |
| 黄昏装备 | 不处理 | 黄昏/夜里 `light`(P90) 接管，`next` = `equip torch`（背包有火把但没举起时） |
| 优先级 | 58（低于工具 55？不，58 略高，但材料一够就消失，等于没有） | 60（白天天天在，高于 axe 55 / pickaxe 50） |

#### 4.6.2 火把材料保护

- 火把还没做出来且没有其它可用光源时，`{cutgrass:2, twigs:2}` 被保留。
- 计划层：`tool_axe` / `tool_pickaxe` 的 `when` 增加 `!wouldBreakTorchReserve(...)` ——
  做这把工具会让火把材料不够时，先让位给 `prep_light`。
- 反射层：材料够就**立刻做火把**（把它变成"已保护"的成品），不再出现"采集时被斧头抢走树枝"。
- 火把做成后自动解除保护（`hasPortableLight` 为真 → `protectedMaterials` 返回 nil）。

#### 4.6.3 反射层（`scripts/whale/reflex.lua`）重做要点

- **优先级**：P0（被攻击 / 生命 <25% 且敌人贴脸 / 天黑无光）→ P1（白天材料够就做火把、紧急饥饿、
  生命 <35%、温度异常）→ P2（补火把材料、采食、添柴）→ P3（理智/闲）。规则判定，不交给 LLM。
- **安全抢占**：只有 P0/P1 能中断普通任务；一律走 `A.Abort(reason)`（唯一取消路径），
  中断后核对 `Whale.job==nil` 且 `GetBufferedAction()==nil`，**旧动作没清干净就不启动第二个动作**。
- **白天立即做火把**：`craft_torch` 用 `craftrules.HasIngredients`（读原生 `AllRecipes`）精确核对，
  成功后核对"真的进了背包/手上"（`confirm_pending`），失败则退避、绝不误报完成。
- **防抖**：同一意图在跑不重建；失败按原因退避；`[Reflex]` 日志 30 秒限频。
- **死亡/复活重置**：`IsDead` / `playerghost` / `IsValid==false` 时清空意图与冷却。
- **配置可见**：`Whale.reflex.Enabled()`；关掉时 `get_state` 顶部明确提示"反射被关掉了"。

#### 4.6.4 自动化测试

`node --test tests/*.test.mjs` → **607 passed / 0 failed**（基线 535 + 新增 72）。
新增 `tests/survival-02-1-priority.test.mjs` 覆盖任务书要求的 18 项（编号与测试文件里一致）：

| 要求 | 用例 |
|---|---|
| 1 反射实际开启 | RF-1 |
| 2 关闭时正确报告 | RF-2 |
| 3 白天材料不足目标存在 | SP-1、SP-11 |
| 4 材料够 prep_light 不消失 | SP-2、SP-4 |
| 5 材料够能触发制作火把 | SP-3、RF-3 |
| 6 制作失败不误报完成 | RF-4 |
| 7 制作成功解除材料保护 | SP-8 |
| 8 其它制作不抢火把材料 | SP-6、SP-7、RF-5、RF-6 |
| 9 黄昏前检查并处理装备 | SP-9 |
| 10 无光源时紧急逻辑生效 | SP-10、RF-7、RF-8 |
| 11 普通任务期间安全抢占 | RF-9 |
| 12 旧任务未清理不能启动第二个动作 | RF-10 |
| 13 紧急进食不被无限阻塞 | RF-11 |
| 14 食物不足不无限重试 | RF-12 |
| 15 怪物攻击触发危险处理 | RF-9 |
| 16 不每秒重复启动同一动作 | RF-13 |
| 17 Plan/Reflex 不同时冲突 | RF-9（单槽 job 结构）|
| 18 死亡/复活/Actor 无效重置 | RF-14、RF-15 |

真机补测追加 4 条回归（0.32.1 / 0.33.0）：
RF-17（附近没草时要去采能采到的树苗）、RF-18（诊断限频且不污染 get_state 提示）、
RF-19（torch 用 `fueled`，烧空了不算可用光源）、RF-20（制作结果用独立 section，不被限频吞掉）。

另有 **REC-1..8**（`tests/session-recorder.test.mjs`）覆盖旁路会话记录器：
KLEI 头、命令/回执/状态/反射/死亡入时间线、按 id 去重、日志增量与截断、`--from-start`、
GBK 中文兜底解码、以及"记录器绝不改写桥文件"这条硬约束。记录器用法见 `docs/TESTING.md` §6.9。

#### 4.6.5 真实游戏验证（RUNTIME，2026-11-14，Cluster_2 新世界）

**环境**（逐条由服务器日志 / 状态文件确认，不是推断）：

| 项 | 值 |
|---|---|
| 世界 | `Cluster_2`（用户新建的专用测试世界），第 1 天开始 |
| 游戏 Mod 版本 | 运行中世界加载 **0.32.1**（日志 `Loading mod: ... Version:0.32.1`）；仓库/安装目录为 **0.36.1** |
| REFLEX 实际配置 | **`true`**（日志逐字 `Overriding mod DontStarveWhaleSurvivor's option REFLEX with value true`）；`get_state` 顶部不再出现"⚠ 保命反射被关掉了" |
| 世界设置 | `game_mode=survival`、`darkness=default`（**黑暗会打死人**，与旧 Cluster_1 的 `nonlethal` 不同）、`ghostenabled=none`（死了不化魂）。**每次死亡后世界在死亡界面暂停，必须由玩家手动重新选人才能继续**——不是自动重生（用户确认）。 |
| 排查工具 | `tools/session-recorder.mjs`，只读旁路，记录命令/回执/反射/死亡/状态（§6.9） |

**逐场景结果：**

| 场景 | 结果 | 证据 |
|---|---|---|
| A 白天材料收集 | ✅ **RUNTIME 通过** | 反射自己采到 `树枝 ×2` 与 `采下的草 ×2`；`get_state` 提示「先采点草，凑火把材料」 |
| 材料齐立即做火把 | ✅ **RUNTIME 通过** | 日志 `priority=P1 reason=light_preparation` → `craft_torch: started=true`；随后状态**手持 火炬(62%)**，背包 3 格→1 格（cutgrass/twigs 被真实消耗） |
| 火把材料保护 | ✅ **RUNTIME 通过** | 做出火把后计划立刻从 `prep_light` 切到 `tool_axe`（保护解除）；做出前斧头目标不出现 |
| B 黄昏/装备 | ⚠️ **部分观测** | 火把在白天做出即自动装备（DoBuild 空手直装）；黄昏时若火把不在手上，日志出现 `[Reflex] protection: ... reason=dark_no_light`（P0 抢占）。未单独构造"背包有火把但没装备"的黄昏场景 |
| C 第一夜 | ❌ **未通过** | 该世界是**夜晚散点出生**（`Spawning player at [Scatter]`、状态第 1 天·夜晚），出生背包只有哑铃、`cutgrass 0/2、twigs 0/2`。反射日志逐字 `craft_torch: started=false reason=ingredients_missing` → `[Death Announcement] ... 死于： 黑暗`（00:06:07）。**反射无法凭空造出材料** |
| D 第二天 | ✅ **RUNTIME 通过** | 手动重新选人后第 2 天白天：生命 200/200、理智 196/200、饥饿 183/200；反射补齐材料并做出火把；`light_check: has_usable_light=true` |
| E 紧急抢占 | ✅ **RUNTIME 通过** | 模型 `gather_area grass` 期间被 P0 中断：回执 `dark_no_light`，日志 `[Reflex] protection: ... reason=dark_no_light`。但也暴露缺陷：反射在无材料时仍中断了模型动作却帮不上忙 |
| 第二夜 | ✅ **RUNTIME 通过（第 2 个角色）** | 状态从第 2 天·白天 → **第 3 天·白天**，生命 200/200、理智 196/200，手持火把，期间无死亡 |
| 第三夜 / 火把烧完 | ❌ **未通过** | 火把燃料耗尽后消失（背包只剩哑铃、手持空），且没有备用材料；黄昏→夜里日志一路 `craft_torch: ingredients_missing` / `no_light_materials` → 第 3 天·夜晚 **生命 0/200，死于黑暗** |
| 第 5 天夜 | ❌ **未通过** | 手动重新选人后又是**夜晚零材料出生**；反射两次 `craft_torch: ingredients_missing`，`day=5 night hp=200→0`。死亡界面暂停，玩家手动重新选人 |
| 第 6 天白天 | ✅ **循环跑通** | 反射 `P1 light_preparation` **抢占**模型的 `gather_area`（回执 `light_preparation`）→ 自己采草 → 凑齐 → 做出 `torch(87%)`；模型随后手动囤到 `cutgrass ×3` |
| 第 6 天黄昏 | ❌ **未通过（新死因）** | 靠近蜘蛛巢（8 格）后 5 只蜘蛛贴脸：`gather_area` 自行报「有怪在打我，先停下」，反射两次「有怪在打我，先撤」+ `health_low` 抢占，但血量 200→160→60→0 被围死 |
| 当前进度 | 第 **6** 天·黄昏，生命 0/200、`dead=true`，死亡界面暂停，等待玩家手动重新选人 | 记录器 `STATE` 行 |

**死亡统计（本次 RUNTIME）：5 次会话退出**（`Deleting user` 记录 `0000000006` ~ `0000000010`；
`ghostenabled=none` 下每次死亡世界暂停，由玩家手动重新选人）。
**有明确死因证据的 2 类**：①「黑暗」——聊天日志播报 `死于： 黑暗`（00:06:07），
且多次死亡前日志一路 `craft_torch: ingredients_missing` / `no_light_materials`；
②「蜘蛛群围攻」——第 6 天黄昏血量逐帧 200→160→60→0，反射撤离未甩脱。
其余几次会话退出没有独立的死亡播报文件（chat log 分片未落盘），**不推断死因**。

失败根因明确：世界夜晚出生 / 火把烧完后**没有备用光源或材料**，而反射被设计为
"只在附近采集、不远离安全区"，造不出材料；另加一次蜘蛛巢边被围。
这不是优先级或抢占逻辑失效——恰恰相反，P0/P1、白天做火把、材料保护、抢占、防抖都按预期触发了。

**NOT_OBSERVED（不编造）**：饥饿紧急进食（饥饿最低 133/200=66%，未达 35% 阈值）、
温度异常、固定营火/火坑照明、完全连续的"单个角色活过第一夜+第二夜"（这一局有 5 次会话退出与手动重新选人）。
> 补充：**怪物攻击导致的抢占已观测**（第 6 天蜘蛛，`gather_area` 自停 + 反射 `先撤`），
> 但撤离结果失败；`RETREAT` 相关计划层逻辑也随状态切换到了「敌人贴脸且血少：先脱离」。

> 结论：**验收标准"连续真实度过第一夜和第二夜"在 0.32.x 上未达成**。修复后的保命链在"有白天可准备"
> 时工作正常，但"出生即夜晚 / 光源耗尽后无备用材料"仍会死于黑暗。

#### 4.6.6 真机暴露的第三个 bug：**白天就把火把点着了**（0.33.0 修）

用户观察到的现象："制造了火把就拿在手上，烧完了又去找草又拿在手上，一直循环"。
查证后这是**真 bug**，而且它就是反复致死的直接原因。三处证据：

**① 燃料账（`scripts/tuning.lua` 原生数值）**

```
seg_time=30, dusk_segs=4, night_segs=2
dusk=120s + night=60s          → 黑暗总长 180 秒
TORCH_FUEL = night_time*1.25   → 单把火把只能烧 75 秒
```

**一把火把盖不住一整夜**（180/75 = 2.4 把），所以"做一把举着"必然中途熄灭。

**② 燃料只在手持时消耗**（`scripts/prefabs/torch.lua`：`inventoryitem:IsHeld()`）

而 `DoBuild` 在空手时会**自动把火把装备到手上**，于是白天做出来就直接开始烧 ——
真机状态里能看到 `day=7 phase=day hand=torch`，大白天也在烧。

**③ 旧逻辑"有火把就不囤料"**

`reflex_stock_light` 里 `if rep.portable then return false end` —— 手里有一把就再也不囤，
等这把在白天烧完，**夜里真需要光时反而没有**。日志节奏也对得上：
`13:37:53 twigs:6,cutgrass:4` → `13:38:03 twigs:4,cutgrass:2`，10 秒吃掉一份料。

**0.33.0 的四处改动（都在 `reflex.lua`，不动协议、不加工具）**

| # | 改动 | 关键实现 |
|---|---|---|
| 1 | 白天做完火把**立刻收回背包** | `craft_torch` 记下 `phase`；`confirm_pending` 发现"白天且自动装备了"就排一次 `unequip` |
| 2 | 白天手里举着火把 → **主动收起来** | `reflex_stow_light`：仅 `phase=="day"`、6 格内无敌人、带 5 秒冷却；放在 **P2**（不能抢"饿了要吃"） |
| 3 | 囤料按**整夜用量**算，不再"有火把就停" | `RESERVE_TORCHES=2`、`rep.reserve_ok = craftable + 背包火把 >= 2` |
| 4 | 新增燃料账诊断 | `hand_seconds`（手上这把还能烧几秒）、`craftable`（备料能做几把）、`reserve_ok` |

常量与依据写死在代码里并加了测试锁（RF-24）：
`DARK_SECONDS=180`、`TORCH_SECONDS=75`、`TORCHES_PER_NIGHT=3`、`RESERVE_TORCHES=2`。

**新增回归测试（4 条）**：RF-21（白天举着火把必须收回）、RF-22（黄昏/夜里绝不收，`dusk`+`night` 各验一次）、
RF-23（有火把但零备料 → `reserve_ok=false` 且必须继续囤）、RF-24（燃料账数值与原生 tuning 对齐）。
另外 RF-3 从"做完拿在手里"改成更强的断言：**做完先自动装备、白天必须收回背包且燃料不消耗**。

> 说明：0.33.0 只改了反射的**点火时机与囤料量**，没动优先级/抢占/材料保护。
> 这条修复的真机复验见下一轮（需重新读档加载 0.33.0）。

#### 4.6.7 0.33.0 真机复验（Cluster_2，第 7 夜 → 第 8 天 → 第 8 夜）

| 项 | 结果 | 证据 |
|---|---|---|
| 加载版本 / REFLEX | ✅ 0.33.0，`REFLEX=true` | 日志 `Version:0.33.0`、`Overriding ... REFLEX with value true` |
| **白天不再烧火把** | ✅ **RUNTIME 通过** | 记录器全部 `phase=day` 帧中 **`hand=torch` 出现 0 次**（0.32.x 会整天举着烧） |
| 白天囤料 | ✅ 部分通过 | 白天背包从 `twigs:1 → 3 → 4`，手上始终空 —— 按 2 把的量囤树枝 |
| 第 7 夜（零材料出生） | ✅ **存活** | 第 7 天·夜晚 → **第 8 天·白天**，生命 200/200、理智 200/200 |
| 黄昏缺料时的行为 | ✅ 如实报告，不瞎做 | `craft_torch: started=false reason=ingredients_missing: cutgrass 0/2`；`reason=no_light_materials` |
| 第 8 夜 | ❌ 死亡（黑暗） | `day=8 night hp=200→99→0`，两拍内被打死 |
| `stow_light`（白天收火把） | ⚠️ **未观测到触发** | 这一轮白天**没做出火把**（缺草），所以没机会触发；只在单测 RF-21 覆盖 |

**这一轮的死因非常纯粹**：出生点附近 **40 格内一株草都没有**
（`probe grass radius 30/40` 都返回 0），而反射的 `reflex_stock_light` 按设计
**只在 16 格内采集、不远离安全区** → `missing=cutgrass 0/2` 一直补不上 → 造不出火把 → 黑暗死。

这暴露了 0.33.0 仍然缺的一块，且**不是优先级/点火时机问题**：

> 反射缺关键材料时**不会主动去别处找**（`seek` 由模型/Plan 负责）。
> 而模型侧 `seek grass` 这次也失败：`budget_exceeded`（走了 106 秒没找到，上限 105 秒）。

**下一步建议（本阶段未做，需用户决定）**：
① 反射在 P2 缺料时，允许向"最近已知有草的方向"走一小段（限制距离/时间）；
② 或把 `seek` 的预算调大/支持分步；
③ 或优先"建营火"路线（2 木头 + 3 草），但同样受缺草限制；
④ 最省草的方案：**先做斧头砍树 → 木头+草建营火**，营火 `CAMPFIRE_FUEL_START=135s`、
`MAX=270s`，比 3 把火把（6 草 + 6 树枝）省得多。

#### 4.6.8 第四个 bug：**没草时完全没有破局路线**（0.36.1 修）

0.33.0 复验里第 8 夜仍死于黑暗，且死因非常纯粹：出生点 **40 格内一株草都没有**
（`probe grass radius 30/40` 都返回 0）。而火把要 2 草、营火要 3 草 —— 所有光源路线都卡在草上。
反射按设计只在 16 格内采集、不会主动去找；模型侧 `seek grass` 也因
`budget_exceeded`（走了 106 秒，上限 105 秒）失败。结果 `missing=cutgrass 0/2` 一直补不上。

**关键发现（查原生 `scripts/recipes.lua`）**：

```
Recipe2("firepit", {Ingredient("log",2), Ingredient("rocks",12)}, TECH.NONE)
FIREPIT_FUEL_START = night_time + dusk_time = 180 秒   ← 正好盖住整夜
```

**火坑是唯一不依赖 cutgrass 的开局光源**（TECH.NONE，木头和石头遍地都是），
而且燃料 180 秒 = 一整夜，比 3 把火把（6 草 + 6 树枝）省得多。

**0.36.1 的三处改动**

| 文件 | 改动 |
|---|---|
| `lib/plan.js` | `prepLightNext` / `lightNext`：缺草但 `log>=2 && rocks>=12` 时直接给 `build firepit`；材料够火把时仍优先 `craft torch`；附近没料时 `seek` 提示里补"改走火坑路线" |
| `reflex.lua` | P0 `reflex_light`：火把做不出来但火坑材料够时 `A.Start("make_fire", {recipe="firepit"})`；`firepit_ready` 用 `craftrules.HasIngredients` 读**原生** AllRecipes 校验，不硬编码 |
| `reflex.lua` | 新增 `reflex_seek_light`：16 格内采不到且备料不足时**有界地**走过去找 —— 只在白天、P2、6 格内无敌人、目标先被观察到、距离 ≤22 格、12 秒冷却 |

有界搜索的边界写死在代码里并由 RF-28 静态断言，不违反"不为找材料无目的远离安全区"。

**新增 9 条测试**：SP-12..SP-16（Plan 火坑路线与优先级）、RF-25（P0 火坑兜底）、
RF-26（16 格外 20 格内有草 → 有界 move_to）、RF-27（夜里/有敌人/26 格太远三种场景都不许走）、
RF-28（上限与边界的静态断言）。

> 0.36.1 的真机复验待重新读档后进行。

#### 4.6.9 0.34.0 真机复验暴露的两个新 bug（0.36.1 修）

0.34.0 真机（第 9 天白天）日志里又抓到两条：

**① 固定巢穴把「白天收火把」永久挡住了**

```
[Reflex] craft_torch_result: result=succeeded in_hand=true phase=day
[Reflex] stow_light: scheduled=true reason=crafted_in_daytime
[Reflex] light_check: has_usable_light=true portable=false   ← 火把没了，也没进背包
```

`stow_light` 只有 `scheduled=true`，**真正的 `unequip` 一次都没执行**。根因：
`reflex_stow_light` 用 `nearest_hostile(p, 6)` 判断"附近有敌人先不收"，而
`scripts/prefabs/spiderden.lua` 里蜘蛛巢同时带 `hostile` + `structure` 标签，
5.8 格外的固定巢穴被当成威胁 → 收纳被永久否决 → 火把一直举在手上把 75 秒烧光。
这正是用户看到的循环。

**② 地上现成的 cutgrass 从不捡**

`get_state` 里 9.4 格有 `采下的草 ×3`（可拾取物），但 `reflex_stock_light`
只找 `exact_ready(p, "grass", 16)`（可采的**草丛**），完全看不见地上已割好的材料，
于是 `missing=cutgrass 0/2` 一直补不上。

**0.36.1 改动（都在 `reflex.lua`）**

| # | 改动 |
|---|---|
| 1 | 新增 `active_threat`：排除 `structure`/`INLIMBO`，只有会追人的活怪才算威胁；`reflex_stow_light` 与 `reflex_seek_light` 都改用它 |
| 2 | 新增 `ready_ground_material` + `push_pickup`：`reflex_stock_light` 采草丛**之前**先捡地上现成的 cutgrass/twigs |

**新增 3 条测试**：RF-29（蜘蛛巢不挡收纳）、RF-30（地上 cutgrass 被 `PICKUP`）、
RF-31（真活怪贴脸仍阻止收纳 —— 安全不放宽）。

> 0.36.1 的真机复验待重新读档后进行。

#### 4.6.10 0.35.0 真机复验：收进背包的火把「凭空消失」（0.36.1 修）

0.35.0 的两个修复**真机都生效了**，证据确凿：

- `cutgrass 0→4`（捡地上现成材料）
- `whale_result.json` 里 `ok=true` 的「把 torch 放回背包了」回执
- `get_state` 提示里出现「天还亮着，先把火把收起来省燃料」

但第 9、10 夜仍死于黑暗，夜里诊断 `has_usable_light=false portable=false` ——
**火把既不在手上、也不在背包**。而回执的背包净变化是 **`（背包：torch-1）`**，
即火把数量**减少 1**。

查游戏原生 `scripts/components/inventory.lua` 找到根因：

```lua
function Inventory:Unequip(equipslot, slip, force)
    ...
    self.equipslots[equipslot] = nil
    self.inst:PushEvent("unequip", ...)
    return item          -- ★ 只把物品从 equipslots 摘掉并 return，不自动放回 itemslots
end
```

原版 `player_common.lua` 的用法是 `local item = inv:Unequip(slot)` 再自己 `GiveItem` / 存起来。
而我们的 `unequip_by_slot` **直接丢弃了返回值** → 火把被摘下后没进背包。
（单文件测试桩里我自己实现了 Unequip 搬回背包，所以这个 bug 单测一直抓不到。）

**0.36.1 改动**

| 文件 | 改动 |
|---|---|
| `actions.lua` | `unequip_by_slot` 接住 `Unequip` 返回的 item，用 `inv:GiveItem(item, free)` 显式放回背包；完成前用 `ForEachItem` 核对物品真的在背包，否则报 `unequip_failed` / `unequip_no_space`，**不许谎报成功** |
| `reflex.lua` | `try_action` 增加 `canRun` 预判：P0 光照动作先判 `light_action_available` —— 缺关键材料、帮不上忙时**不抢占**模型任务，避免「模型采不到料 + 反射造不出光」的黄昏死锁（真机第 10 天 `twigs 0/2`，`gather_area` 每 6 秒被打断一次） |
| 测试桩 | `inv:Unequip` 改为忠实模拟原生语义（只摘掉、返回 item），新增 `GetNextAvailableSlot` / `GiveItem` |

**新增 4 条测试**：RF-32（收纳后火把必须真的在背包）、RF-33（`GiveItem` 与背包核对的静态断言）、
RF-34（缺材料时 P0 不许打断模型采集）、RF-35（有材料时仍正常抢占 —— 安全不放宽）。

> 0.36.1 的真机复验待重新读档后进行。

#### 4.6.11 0.36.0 真机复验：`GiveItem` 的一个参数坑（0.36.1 修）

0.36.0 里 `stow_light` **真的执行了**（日志 `phase=day`），但回执是：

```
{"ok":false,"text":"unequip_no_space: torch 没放回背包（背包满了？）"}
```

背包只有 5 格，不可能满。查原生 `inventory.lua`：

```lua
function Inventory:GetNextAvailableSlot(item)   -- ★ 需要 item 参数
```

我上一版写的是 `inv:GetNextAvailableSlot()`（**无参**）→ 真机抛错 → 被 `pcall` 吞掉 →
`given=false` → 误报"背包满了"，火把仍然没进背包。

**0.36.1 改动**（`actions.lua` 的 `unequip_by_slot`）：
- 不再自己找空位，直接 `inv:GiveItem(item)` —— 原生内部会用 `GetNextAvailableSlot(inst)` 正确找空位
- `GiveItem` 返回 `nil/false` 时用 `inv:SetActiveItem(item)` 兜底
- 完成前仍用 `ForEachItem` 核对物品真的在背包，否则报 `unequip_failed`
- RF-33 增加静态断言：**不许无参调 `GetNextAvailableSlot()`**（防止回归）

| 版本 | 回执 | 火把去向 |
|---|---|---|
| 0.35.0 | `ok=true 把 torch 放回背包了（背包：torch-1）` | 丢失（Unequip 返回值被丢弃） |
| 0.36.0 | `ok=false unequip_no_space` | 丢失（GetNextAvailableSlot 无参抛错） |
| 0.36.1 | **NOT_CONFIRMED**（本轮真机未触发） | 角色缺 twigs，全程没做出火把，收纳链没跑到 |

**另外补了 RF-36 端到端测试**：第一次在单测里把「白天材料齐 → craft torch → 收进背包（手上空、背包有 torch）→ 切到 night → 从背包 `equip` 举起来」整条链锁住。
之前每轮都靠真机撞背包 API 的细节，这条测试把回归成本降下来了。并让测试桩忠实模拟
`ForEachItem` 遍历 `activeitem`（原生行为），避免"桩比真机聪明"再次掩盖 bug。

#### 4.6.12 0.36.1 真机复验（第 12 夜 → 第 13 天 → 第 13 夜）与 0.36.2

**已确认生效**：加载 `Version:0.36.1`、`REFLEX=true`；从第 12 夜活到第 13 天白天、
生命 200/200，本 session 前半 0 次死亡；`reason=action_not_available` 反复出现 ——
0.36.0 的「缺料不抢占」在真机确实生效，黄昏死锁解开了。

**核心修复未确认**：本 session `craft_torch started=true` **0 次**、`torch+1` 回执 **0 次**、
`unequip_no_space` 0 次。角色全程缺 `twigs`（附近树苗 `not_ready`、30 格内地上无 twigs），
**一把火把都没做出来**，所以 `GiveItem` 收纳链根本没跑到。按提交纪律，不能提交。

**新发现（真机第 13 天）**：

1. **饥饿抢占死锁（0.36.2 修）**：饥饿 13% 时 P1 每 5 秒以 `hunger_emergency` 抢占一次，
   但背包里没有任何食物，`reflex_eat` 返回 false —— 抢占了却什么都没做，模型的
   `move_to` / `gather_area` 被反复打断（回执就是 `hunger_emergency`），与 0.36.0 的
   光照死锁同源。修法：`eat` / `heal` 加 `food_available` / `heal_available` 的 `canRun` 预判；
   `temperature_need` 带 `can_run`（附近没火就不抢占）。
2. **地上现成材料**：4.6 格有 `cutgrass` 反射没捡。查原生 `actions.lua` 后确认
   `PICK`/`PICKUP` 都带 `extra_arrive_dist`，BufferedAction 会自己走过去 —— **不是够不着**；
   一度按"够不着"加的 1.2 格距离判断已回退（错误假设，会破坏原本能工作的采料）。
   真实原因待下一轮继续查。
3. **外部环境**：这个测试世界出生点资源枯竭（草/树苗 `not_ready`）+ 夜晚出生 +
   死亡后手动重新选人，是反复致死的外因，不是代码单点问题。

**0.36.2 新增 3 条测试**：RF-37（饥饿见底但没食物 → P1 不许打断模型）、
RF-38（有食物时仍正常抢占 eat —— 安全不放宽）、RF-39（temperature 无火不抢占）。
全套 **598/598**。

> 按提交纪律，0.36.1 / 0.36.2 及 RF-36..39 的改动**全部留在工作区未提交**，
> 等待「白天做火把 → 收进背包 → 夜里举起 → 连续活过两夜」的真机确认后一次性提交。

#### 4.6.13 0.36.2 真机复验：**收纳链全通，但死于「黄昏就点火把」**（0.37.0 修）

0.36.2 真机（第 13 夜 → 第 14 天 → 第 14 夜）终于把之前几轮一直没跑到的链**全跑通了**：

```
01:19:31  day   craft torch → hand=torch
01:19:36  day   hand=-  inv=[torch:1(98%), twigs:1]      ← 收进背包，燃料 98%
回执 {"ok":true,"text":"把 torch 放回背包了"}             ← 不再带 torch-1
light_check: portable=true                                ← 认出背包里的火把
01:24:02  dusk  hand=torch                                ← 举起点着（问题在这）
```

`craft_torch_result` / `stow_light` / `torch+1` 的 craft 回执都在，
**本 session 火把丢失 0 次、`unequip_no_space` 0 次** —— 0.36.0/0.36.1 的
`unequip` + `GiveItem` 修复至此**真机确认通过**。

但第 14 夜仍死于黑暗（`[00:11:52] 死于：黑暗`）。时间线：

```
01:22:35  dusk   hand=torch  inv=[twigs:2, cutgrass:2]   ← 黄昏就举起，背包里没留备用
01:25:08  dusk   hand=-      inv=[哑铃]                  ← 75s 烧完；又用材料做第二把也烧了
01:25:39  night  hand=-      inv=[哑铃]                  ← 真正需要光的黑夜，两手空空
01:25:49  night  hp=99.95 → 01:25:59 hp=0                ← 黑暗伤害，死亡
```

**根因（用户指出，查游戏源码坐实）**：`grue:CheckForStart()` 的条件是
`not inst:IsInLight()`（`scripts/components/grue.lua`）—— **黄昏仍有自然光、不掉血**，
真机整个 dusk 血量 200/200 没动，进 night 10 秒就掉到 99.95。
所以只有 **night 的 60 秒**需要光，一把火把 75 秒绰绰有余；
旧代码把 dusk 也算进黑暗（`TORCHES_PER_NIGHT = ceil(180/75) = 3`），
黄昏就把火把举起点着，把整把燃料烧在还有自然光的 120 秒里。

**0.37.0 改动**（`reflex.lua` + `lib/plan.js`）：

| 改动 | 说明 |
|---|---|
| P0 `dark_no_light` 只在 `night` 触发 | 黄昏不再点火 / 不再举火把 |
| `reflex_stow_light` 改为「只有 night 不收」 | 白天 **和黄昏** 都把火把收回背包，留到入夜 |
| `confirm_pending` 的收纳时机 `day` → `~= night` | 黄昏做出来的火把也收进背包备用 |
| P1 制作 / P2 囤料 / 有界找料 / 采花 | 黄昏照常（是入夜前最后的备料窗口），入夜才停 |
| 燃料账 | `DARK_SECONDS=180` → `DUSK_SECONDS=120` + `NIGHT_SECONDS=60`；`TORCHES_PER_NIGHT=3` → `1` |
| `lib/plan.js` 的 `isDark()` | 只 `night` 才算黑暗；黄昏不再给模型 `equip torch` 的建议 |

**测试**：新增 RF-40（黄昏不举 → 入夜才举的完整时序）；RF-22 语义反转为
「黄昏收、夜里不收」；RF-24 / RF-28 / SP-9 / PLAN-4 按新语义修正。
全套 **599/599**。

#### 4.6.14 0.37.0 真机确认通过：连续活过三夜、0 死亡（可提交）

Session：加载 `Version:0.37.0`、`REFLEX=true`，从第 14 夜出生（满状态、零材料）到
第 17 天白天。**`Deleting user` 0 次、`Death Announcement` 0 次**，连续活过
第 14、15、16 三个夜晚，血量全程 200/200。

完整闭环连跑两遍（第 15、16 夜），证据来自 `.runtime/survival-02-1-v9.jsonl`：

| 阶段 | 手上 | 背包 | 血量 |
|---|---|---|---|
| day15 dusk | `空` | `torch:1(98%), cutgrass:4, twigs:2` | 200/200 |
| day15 night | `torch` | `cutgrass:4, twigs:2` | 200/200 |
| day16 day | `空` | `torch:1(81%), cutgrass:2, twigs:2` | 200/200 |
| day16 dusk | `空` | `torch:1(81%), cutgrass:4, twigs:2` | 200/200 |
| day16 night → day17 day | `空`（天亮已收） | `torch:1(63%), cutgrass:4, twigs:1` | 200/200 |

- 黄昏全程 `hand=空`、火把稳在背包（0.36.2 在同样阶段早烧完了）—— **「黄昏不举」确认**
- 入夜 `hand=torch`、回执 `{"ok":true,"text":"把 火炬(98%) 拿在手里了"}` —— **「入夜才举」确认**
- 天亮自动收回（回执 `{"ok":true,"text":"把 torch 放回背包了"}`，不带 `torch-1`）、
  燃料 98% → 81% → 63%，只在夜里烧 —— **燃料账确认**
- `portable=true` 全程认出背包里的火把，`unequip_no_space` / `torch-1` 均为 0 次
- 备料充足（cutgrass 4、twigs 2），够再做好几把

**结论**：SURVIVAL-02.1 的「白天提前制作并装备火源、正常处理饥饿和危险、
连续真实度过两夜」在本轮达成（实际连续三夜、0 死亡）。此前 15 项要求的
单元覆盖见 `tests/`，计数 599/599。按提交纪律，本阶段改动在此一次性提交。

> 说明：本轮是从第 14 夜**重新选人后的新开局**（满状态、零材料），
> 不是旧存档延续；`REFLEX=true` 由日志 `Overriding ... REFLEX with value true` 确认。
> 未观测到的项：第一夜/第二夜的「开局」在更早的版本里已分别复验（见 §4.6.7），
> 本轮观测的是第 14~16 夜，按"连续真实度过两夜"判定成立。

#### 4.6.15 长跑会话日志内置到插件（Node 0.9.3）

用户要求：长跑时「启动新会话插件自己就会写日志」，而且**每次覆盖写、不是增量累积**。
原来靠手工起 `tools/session-recorder.mjs` 后台进程，且是 append 累积，多个会话混在一起。

**改动**：

| 文件 | 改动 |
|---|---|
| `lib/session-log.js`（新） | 记录器核心搬到 `lib/`（发布包 `files` 只含 `lib/`，`tools/` 不会打包）。新增 `SessionLog`：**启动时 `writeFileSync(..., '')` 清空 session.\*、`copyFileSync` 覆盖 server_log.txt**，会话内 append；自动用 `GameBridge.readState()` 定位活跃分片，换分片也覆盖重置 |
| `lib/index.js` | `apply()` 里自动 `ctx.effect` 起 `SessionLog`；监听 `session/event`，**新会话首次调用 dst 工具时 `reset()`**（覆盖写）。新增配置 `sessionLogEnabled`（默认 true）/ `sessionLogDir`（留空 = 插件目录 `latestLogs/`） |
| `tools/session-recorder.mjs` | 改成 CLI 薄封装 + re-export，保留 `npm run record` 与 8 条 REC 单测 |
| `tools/build-client.mjs` → `lib/client.js` | 重新生成配置卡片，新增两个设置项 |
| `tools/sync-longrun-logs.mjs` | 人工备注同步器（写 `notes.md`、覆盖复制 `server_log.txt`） |

**顺手修的真 bug**：记录器 `_emit` 里 `{ t: ISO, ...event }`，而 `result` 事件带
`t: res.t`（数字时间戳）覆盖了 ISO 字符串 → `eventsToText` 的 `t.slice(11,19)` 抛错、
整条事件写盘失败（后台任务日志里出现 10 次 `[recorder] 写盘失败：event.t.slice is not a function`）。
现在 `t` 恒为 ISO，游戏时间戳改名 `game_t`，`eventsToText` 另有兜底。

**`latestLogs/` 只保留 4 份**（用户要求精简，删掉了重复的桥文件副本 / snapshot / state-history）：
`session.txt`（人可读时间线）、`session.jsonl`（结构化）、`server_log.txt`（游戏原始日志）、
`notes.md`（操作与分析备注）。

**验证**：新增 `tests/session-log.test.mjs` 8 条（SL-1..8），覆盖
「数字 t 不抛错」「启动覆盖写」「新会话 reset 覆盖写」「源定位」「插件源码静态断言」。
全套 **607/607**。真机端到端实测：启动前 `session.txt` 58 KB → 启动后只剩一行
`NOTE 日志已覆盖重置（插件启动）`，5 秒内自动采到 `STATE`/`CMD`，
`server_log.txt` 覆盖复制为当前 56 KB 快照。

**重启 DSH 后的真机确认（用户重进游戏，URL 从 3579 变为 1221）**：

| 验证项 | 证据 |
|---|---|
| 插件启动自动覆盖写 | `session.txt` 只剩 3 行 / 490 字节，旧的 58 KB 历史全清；首行 `NOTE 日志已覆盖重置（切换数据源 ...Cluster_2/Master/save）` —— 自动定位活跃分片成功 |
| **新会话覆盖写** | 调一次 `dst` 后首行变成 `NOTE 日志已覆盖重置（新会话 session-7d473794-...）`，上一段「切换数据源」记录被清掉，只留本次会话 |
| 无需手工后台进程、持续自动写 | 已停掉 v9 手工记录器；STATE 每 5 秒自动增长（5 行 → 7 行） |
| `notes.md` 人工分析保留 | 15 行未被清空（人工备注不属于自动日志） |
| `server_log.txt` 覆盖复制 | 73 KB 当前快照，非增量追加 |

> 结论：插件内置会话日志的「启动新会话自己写、每次覆盖写」已在真机确认，据此提交。
> 另注：这个新世界 `get_state` 提示 `REFLEX=config_disabled`（保命反射被关），
> 与之前 `REFLEX=true` 的测试世界配置不同，长跑时全靠模型自己保命。

## 5. 已知问题（都会真实影响体验）
| # | 问题 | 影响 | 现状 |
|---|---|---|---|
| 1 | **结果文件是单槽** | reflex 的报告可能覆盖动作回执 → `unknown / result_timeout` | 桥的既有设计（M1 起），未改；模型应先 `get_state` 看真实状态 |
| 2 | **reflex 会占用 Actor** | 动作返回 `actor_busy` | 正常（一个角色同时只允许一个动作）；先 `stop` 再重试 |
| 3 | **原生拾取距离 ≈1.03 格 ≈ `move_to` 到点容差** | 第一次 `harvest` 常回 `out_of_range`，要走两次才进得去 | 不放宽原生距离；文档已写明"再靠近一点再试" |
| 4 | `harvest` 只支持 `berrybush`/`berrybush2` | 草、树苗、蘑菇、农田都不能采 | 试点阶段的刻意限制 |
| 5 | 成熟判据只有布尔 | 没有"还剩几秒成熟" | `pickable:CanBePicked()` 就是布尔 |
| 6 | 每桶最多 12 条、总数 60 | 附近东西多时会被截断（文本标 `×N`） | 需要"找更远的"就得先移动 |
| 7 | 状态最多 1 秒旧 | 移动后 `#N` 可能已失效；位置在状态帧里**成段跳变** | 引用只在当前 `snapshot_id` 内有效，这是设计 |
| 8 | **`m2_1_verify_pickup.mjs` 不支持 `--bridgeDir`** | 它走 MCP 入口，桥目录由 MCP 决定，所以实际不受影响 | 需要 `--bridgeDir` 时用 `m2_2/m2_3` 的脚本 |
| 9 | `guide/*.md` 曾描述未开放动作 | 模型会照着调 `chop`/`mine`… 必然失败 | **STABILITY-01 已修**（见 §4.2） |
| 10 | 世界内版本要重读才更新 | 升级模组后状态文件里的版本号还是旧的 | 重新读档即可；已实测 0.17.2 正确加载 |
| 11 | **HUD 写入偶发 `EPERM`** | `whale_hud.json` 的 temp→rename 偶尔失败（Windows/OneDrive 抢占），小窗短暂不刷新 | **间歇、自愈**（实测 1922 行日志里 1 次，下一周期成功）。属桥/ HUD 范围，本阶段只记录不改 |
| 12 | **`m2_0_3_verify_move.mjs` 的 ⑤-3 会假报失败** | 它"ack 前后各读一次位置"，把状态帧里的一次 2 格跳变算成"Abort 后还在走" | **测量方式问题，不是产品问题**：`m2_0_3_verify_stop.mjs` 用逐帧去重采样，实测 Abort 后 6 帧位置不变 → **真的停住了**。本阶段**未改脚本** |
| 13 | **`update_notes` 曾被归类为"只读"** | 文档误导：它是**覆盖写** `~/.dsh/plugins-data/…/notes.md` | **AGENT-01 已更正**（STATUS/ARCHITECTURE/TESTING + 测试注释）；实现未改 |
| 15 | ~~**`stale_snapshot` 的固有竞争**~~ **已修（0.25.0）** | 模型思考 3~5 秒、nearby 最多 1 秒一刷，拿"刚看过的那一帧"时它往往已经过期 | 根因是 **id 每秒就换**（`scan_seq` 每次重扫 +1），不是信息时效。修法：按**内容指纹**（GUID + 所在格）决定要不要换编号 —— 内容没变就复用，实体增删/移动立刻换新号、旧引用照样失效。真机证据 session-403656e9：15 步 5 次 stale_snapshot | §12 |
| 14 | ~~**`get_state` 只印 `快照 s<seq>`，不印 `nearby.snapshot_id`**~~ **已修** | 真实模型照抄 `s1622` → `harvest` 必然 `stale_snapshot` | 现在「附近」段头会印 `Nearby 快照 ID：r…-n2`，并附"这一帧大约还剩 N 秒有效" |

| 16 | ~~**`recipes` 一调就崩**~~ **已修（0.26.0）** | 凭印象用了不存在的帮助函数 `U.g` / `U.try` / `U.best_tool` / `U.best_fuel` | 真机 session-b159b09a：#4 recipes → `actions.lua:3046: attempt to call field 'g' (a nil value)`。这四个**从来不存在**（`U.try` 旧实现有、本版 util 重写时漏了）。已改用 `GLOBAL.AllRecipes` + `craftrules.Counts` 并补上 `U.try`；新增 `tests/lua-module-calls.test.mjs` 做静态审计（已用注入 bug 验证它真能抓到） |
| 17 | ~~**多步动作被外层超时砍成"结果未知"**~~ **已修（0.26.0）** | Lua 内部预算 240 秒 > Node 外层 120 秒 → 必然 `result_timeout` | 真机 session-b159b09a：#5 `gather_area` → `结果未知（result_timeout）`（也就是用户看到的"浆果采不了卡住了"）。现在 Node 通过命令信封把 `budget_s` 告诉 Lua，`A.Tick` 通用兜底：超预算就自己收尾、如实报 `budget_exceeded`，而不是被砍掉 |

| 18 | ~~**`gather_area` 目标在脚边时崩**~~ **已修（0.27.0）** | `next` 阶段把**候选表** `pick` 存进了 `j.data.current`，`acting` 阶段却当实体用 | 真机 Cluster_1：`actions.lua:2136: attempt to call method 'IsValid' (a nil value)`。**只在这条路上踩到**：目标远 → 先 walking（current 是实体）没事；目标近 → 直接 acting → 崩。所以现象是"有的能采有的必崩"。已改成 `j.data.current = pick.ent`，并在 `acting` 加防御（不是实体就跳过该目标，不打挂模组） |
| 19 | ~~**`walking` 阶段 busy 恒为真时永不超时**~~ **已修（0.27.0）** | 12 秒超时判定写在"busy 就 return run"**之后**，于是永远走不到 | 真机 Cluster_1：一条 `gather_area` 排队 **137 秒没回执**（命令在、结果不在）。已把超时判定提到 busy 早退之前 |
| 20 | ~~**旧客户端不带 `budget_s` 时兜底失效**~~ **已修（0.27.0）** | `A.Tick` 的兜底要求 `budget_s ~= nil`，旧客户端不发就完全不兜底 | 真机那条 137 秒的命令里确实没有 `budget_s` 字段。已改成默认 45 秒也兜底 |

### 4.2 guide 一致性审计结论（STABILITY-01）

**指南确实会进模型上下文**（有代码证据）：

| 文件 | 是否被代码读取 | 是否进模型上下文 | 使用场景 |
|---|---|---|---|
| `guide/攻略.md` | ✅ `lib/tools.js` → `BUNDLED_GUIDES.main` | ✅ **每次都进**：`lib/index.js` 的 `buildInstructions()` 把 `RULES + 「## 游戏常识」+ 主攻略全文` 拼进 `instructions`，F8 与 MCP 各一处（`index.js` 的两处 `instructions:`） | 系统提示词 |
| `guide/生存.md` / `战斗.md` / `烹饪.md` | ✅ 同上（`BUNDLED_GUIDES.survive/fight/cook`） | ⏳ 仅当模型调 `get_guide` 时进 | 按需读的攻略 |
| Lua 侧（`DontStarveWhaleSurvivor/scripts/whale/*.lua`） | ❌ **不读任何 `.md`** | ❌ | — |

所以四篇里"看起来能被调用"的动作名都改了：详见 `REFACTOR_AUDIT.md` 之外的本阶段提交
（`docs(STABILITY-01)`）。改法只动"可调用语法"，**游戏知识一条没删**（四篇篇幅只增不减）。

---

## 6. 未完成的工作（及其归属）

### 6.1 关于 M3–M6

**本仓库不存在 M3–M6 阶段**，也没有任何规划文档。按项目纪律，没有实际代码与验证的阶段**不写进历史成果**。

### 6.2 能力缺口（来自 `archive/legacy/audit-2026-11-12-100days.md`，按"不做就死"排序）

**当时列出的 P0，已经补掉的：** `pickup` 暴露（M2.1）、动作结果校验（M2.0）、
保命反射层（`reflex.lua`）、模块版本号对齐、位置 `(x,0)` 串位 bug。
**仍然缺的：**

| 优先级 | 缺什么 | 为什么重要 |
|---|---|---|
| P0 | 续火 / 加柴（给模型用的 `add_fuel`） | 火堆灭了 = 黑暗 = 查理打死你 |
| P0 | 回血手段（药膏/腺体/蜂蜜药膏） | 现在只能靠 reflex 自己吃，模型无法主动回血 |
| P0 | 死亡处理 / 复活（重生石、生命护符、肉块雕像） | 100 天里必然会死至少一次，现在一死等于这局结束 |
| P1 | 容器存/取（箱子、冰箱） | 15 格背包，囤不了 20 天物资 |
| P1 | 锅的完整流程（等熟 → 取出） | 现在放进去就取不出来（僵尸食物占着锅） |
| P1 | 通用交互原语 `interact` | 农场、鸟笼、晾肉架、蜂箱、科技站、帐篷全靠它 |
| P1 | 配方查询（能做什么/缺什么/科技等级） | 现在靠模型猜 prefab 名，猜错就白跑 |
| P1 | 世界导航（biome 质心、地标、方向） | 12 格以外全黑，走不远 |
| P1 | 威胁预警（猎犬波、巨鹿、青蛙雨、满月、自燃） | 100 天全靠"提前准备" |
| P1 | 季节倒计时（还有几天入冬/入夏） | 不知道死线就永远在赶死线 |
| P2 | 会话预算、自动续玩、行动历史、长期记忆按存档、成本可见、复盘日志 | 长跑的工程能力，见审计 §3 P2 |

### 6.3 工程债（本次没处理，记录在案）

1. 结果文件单槽（见 §5 #1）。
2. `lib/tools.js` 里 `WORK_TOOLS` / `until_gone` 分支现在**永远不会命中**（动作没开放），
   保留是为了不动执行器逻辑；重新开放采集动作时直接填回来。
3. Lua 的 `actions.lua` 有 28 个 `JOBS`，其中 24 个不对模型开放——它们是**动作储备**，不是死代码
   （`reflex`/`macros` 会用其中 4 个）。
4. ~~攻略正文与现有能力不一致~~ —— **STABILITY-01 已修**（见 §4.2）。
5. **HUD 写入的 `EPERM`**（见 §5 #11）：根因像是 temp→rename 时被外部抢占，真要修得加重试/退避，
   属于桥的范围，本阶段只记录。
6. **`m2_0_3_verify_move.mjs` 的 ⑤-3 采样太粗**（见 §5 #12）：建议以后改成 `verify_stop.mjs` 那样的
   逐帧去重采样，否则会周期性假报"换手后角色还在走"。本阶段**未改**。
7. `.runtime/` 里还留着历次真机验证的原始输出（未入库）；如果要长期留证，应该挑出关键几份
   **单独入库并标明证据等级**（真机/沙箱不能混），而不是整目录搬进来。

---

## 7. 当前开发优先级（建议）

> **提交纪律（用户 2026-11-14 明确要求，必须遵守）**：
> **只有功能在真机实测确认完成后才能 `git commit`。**
> 单测全绿、代码写完、沙箱推演都不算数 —— 未验证的改动一律留在工作区（可有 `git add`，但不得 commit）。
> 真机确认的判据：加载对应版本后，用真实游戏状态 / server_log / 结果回执看到预期结果，
> 且连续观察中没有相反证据。未经真机确认就提交的提交，应主动软回退到工作区。
>
> 本阶段 0.36.1（GiveItem 参数修复）、0.36.2（P1 抢占预判）、0.37.0（黄昏不举/入夜才举）
> 及 RF-36..40 的改动先按此规则 `git reset --soft 2314d41` 拆回工作区；
> **0.37.0 真机连续活过三夜、0 死亡确认后（见 §4.6.14），一次性提交。**

1. **不要急着加新动作**。先把「死亡/复活」和「续火/回血」补上——这三件事不做，任何长跑都会断。
2. 每次开放新动作，**必须同时**：加白名单（dispatcher）+ 加工具定义 + 加 Lua guard 分支 +
   加结果核对 + 加测试（`tool-parity` 会盯着白名单一致性）。
3. 保持"一个动作一个试点"的节奏（M2.1、M2.3 都这么做的），不要一次开放一批。
4. 单槽结果文件若要改，属于**桥的协议变更**，必须同时改 Lua 与 Node，并补跨进程测试——不要顺手改。
