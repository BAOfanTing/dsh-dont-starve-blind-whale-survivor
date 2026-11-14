# 当前状态

> 最后更新：SURVIVAL-01（四个基础生存动作：gather / eat / craft / equip）｜**以代码和真实运行状态为准**，不凭计划推断。

---

## 1. 版本

| 位置 | 版本 | 含义 |
|---|---|---|
| `DontStarveWhaleSurvivor/modinfo.lua` | **0.19.0** | **游戏内 Lua 模组的版本**。每改一次模组 Lua（哪怕只是注释）就升一位。 |
| `package.json` | **0.9.2** | **DSH 插件（Node 侧）的版本**。跟着插件功能走。 |

两个版本号**故意不同步**，它们描述的是两个交付物：
模组装进游戏 `mods/`，插件装进 DSH。给 AI 看的状态里报的是**模组版本**（`0.17.2`）。
判断"磁盘上的模组装没装进游戏"请看 `install-mod.mjs` 的输出（`installedVersion`）。

> 历史遗留：`package.json` 长期停在 0.9.x，模组已经到 0.17.x。M2.2.1 决定**不建同步机制**，
> 只在这里说清两者含义，避免下一个人误以为版本号写错了。

---

## 2. 现在能做什么

### 2.1 模型可见的工具（13 个）

> 分类：`get_state` / `get_guide` = **只读**；`update_notes` = **本地写入**（会覆盖写笔记文件）；
> `move_to` / `stop` / `pickup` / `harvest` / `gather` / `eat` / `craft` / `equip` = **游戏动作**。

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

**未开放**（Lua 里有实现、但 guard 不放行、工具表也不暴露）：
`chop / mine / hammer / dig / attack / pick / cook / build / make_fire / add_fuel / heal / drop /
sleep / say / wait / act / list_actions / list_recipes / store / take / go_to`
以及全部宏（`gather / chop_until / cook_meal / night_watch`）。

### 2.2 非模型能力（仍然在跑）

- **F8 内置 AI**：在游戏里按 F8，用插件里的 API Key 自己玩（和 MCP 共用同一套工具定义与链路）。
- **HUD**：游戏内显示 AI 的状态与最近动作。
- **reflex（保命反射）**：血少、入夜没光、火要灭、被贴脸时自己动手（`heal`/`craft torch`/`add_fuel`/后撤）。
  **只在没有任务在跑时插手**；它占用 Actor 时模型的动作会收到 `actor_busy`（正常现象，先 `stop` 再试）。
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

---

## 4. 验证等级（严格区分，别混）

| 级别 | 含义 | 现在的覆盖 |
|---|---|---|
| **STATIC** | 只读代码/文档，没有执行 | 各阶段审计报告的结论部分 |
| **UNIT** | 单进程单测（Node 测试 + fengari Lua 沙箱 + 假游戏） | **479 项全绿**；覆盖工具表一致性、guard、dispatcher、lease、nearby、pickup、harvest |
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
| `eat` | `BufferedAction(ACTIONS.EAT)` | 13 种基础食物（**不含** monstermeat / rot） | `food_not_allowed` / `not_in_inventory` / `no_food` / `not_hungry` | 饥饿 +>0.5 / 该食物 -N |
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

1. **不要急着加新动作**。先把「死亡/复活」和「续火/回血」补上——这三件事不做，任何长跑都会断。
2. 每次开放新动作，**必须同时**：加白名单（dispatcher）+ 加工具定义 + 加 Lua guard 分支 +
   加结果核对 + 加测试（`tool-parity` 会盯着白名单一致性）。
3. 保持"一个动作一个试点"的节奏（M2.1、M2.3 都这么做的），不要一次开放一批。
4. 单槽结果文件若要改，属于**桥的协议变更**，必须同时改 Lua 与 Node，并补跨进程测试——不要顺手改。