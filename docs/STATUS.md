# 当前状态

> 最后更新：M2.2.1（全项目瘦身）｜**以代码和真实运行状态为准**，不凭计划推断。

---

## 1. 版本

| 位置 | 版本 | 含义 |
|---|---|---|
| `DontStarveWhaleSurvivor/modinfo.lua` | **0.17.2** | **游戏内 Lua 模组的版本**。每改一次模组 Lua（哪怕只是注释）就升一位。 |
| `package.json` | **0.9.2** | **DSH 插件（Node 侧）的版本**。跟着插件功能走。 |

两个版本号**故意不同步**，它们描述的是两个交付物：
模组装进游戏 `mods/`，插件装进 DSH。给 AI 看的状态里报的是**模组版本**（`0.17.2`）。
判断"磁盘上的模组装没装进游戏"请看 `install-mod.mjs` 的输出（`installedVersion`）。

> 历史遗留：`package.json` 长期停在 0.9.x，模组已经到 0.17.x。M2.2.1 决定**不建同步机制**，
> 只在这里说清两者含义，避免下一个人误以为版本号写错了。

---

## 2. 现在能做什么

### 2.1 模型可见的工具（7 个）

| 工具 | 类型 | 说明 |
|---|---|---|
| `get_state` | 只读 | 时间/位置/三维/背包/附近/威胁；`format=json` 给结构化数据 |
| `get_guide` | 只读 | 攻略四篇：主攻略 / 生存 / 战斗 / 烹饪（玩家可覆盖） |
| `update_notes` | 只读 | 长期笔记，下次 `get_state` 显示在最前 |
| `move_to` | 动作 R1 | 走到格子坐标，自动绕障，报告还差几格 |
| `stop` | 动作 R1 | 立刻停下 |
| `pickup` | 动作 R2 | 捡地上的树枝/草/燧石（`#N` + `snapshot_id`，不自动走） |
| `harvest` | 动作 R2 | 采成熟浆果丛（`berrybush`/`berrybush2`，不自动走、不自动捡） |

**未开放**（Lua 里有实现、但 guard 不放行、工具表也不暴露）：
`chop / mine / hammer / dig / attack / pick / eat / cook / craft / build / make_fire / add_fuel /
heal / equip / drop / sleep / say / wait / act / list_actions / list_recipes / store / take / go_to`
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

---

## 4. 验证等级（严格区分，别混）

| 级别 | 含义 | 现在的覆盖 |
|---|---|---|
| **STATIC** | 只读代码/文档，没有执行 | 各阶段审计报告的结论部分 |
| **UNIT** | 单进程单测（Node 测试 + fengari Lua 沙箱 + 假游戏） | **479 项全绿**；覆盖工具表一致性、guard、dispatcher、lease、nearby、pickup、harvest |
| **RUNTIME** | 真实游戏在跑，模组在游戏里执行 | M1.2 / M1.4 / M2.0.2 探测 / M2.0.3 / M2.1 / M2.2 / M2.3（**各自阶段当时跑的**） |
| **END_TO_END** | 模型 → MCP → 命令 → 游戏动作 → 结果 → 模型，完整链路 | M2.1/M2.2/M2.3 的真机验证脚本走过这条链路；**没有**用真实 LLM 做长跑 |

⚠️ **M2.2.1 这次只复跑了 UNIT（479/479）**。真实游戏验证（RUNTIME / END_TO_END）在本次瘦身中
**没有执行**（`NOT_RUN`）—— 因为本次只动了文档、工具表定义和注释，没有改执行链、校验或 Lua 逻辑。
上一节表里的 RUNTIME 结论属于**当时那个版本**（0.17.1 及更早），不能当作 0.17.2 的成绩。

---

## 5. 已知问题（都会真实影响体验）

| # | 问题 | 影响 | 现状 |
|---|---|---|---|
| 1 | **结果文件是单槽** | reflex 的报告可能覆盖动作回执 → `unknown / result_timeout` | 桥的既有设计（M1 起），未改；模型应先 `get_state` 看真实状态 |
| 2 | **reflex 会占用 Actor** | 动作返回 `actor_busy` | 正常（一个角色同时只允许一个动作）；先 `stop` 再重试 |
| 3 | **原生拾取距离 ≈1.03 格 ≈ `move_to` 到点容差** | 第一次 `harvest` 常回 `out_of_range`，要走两次才进得去 | 不放宽原生距离；文档已写明"再靠近一点再试" |
| 4 | `harvest` 只支持 `berrybush`/`berrybush2` | 草、树苗、蘑菇、农田都不能采 | 试点阶段的刻意限制 |
| 5 | 成熟判据只有布尔 | 没有"还剩几秒成熟" | `pickable:CanBePicked()` 就是布尔 |
| 6 | 每桶最多 12 条、总数 60 | 附近东西多时会被截断（文本标 `×N`） | 需要"找更远的"就得先移动 |
| 7 | 状态最多 1 秒旧 | 快速移动后 `#N` 可能已失效 | 引用只在当前 `snapshot_id` 内有效，这是设计 |
| 8 | **`m2_1_verify_pickup.mjs` 不支持 `--bridgeDir`** | 自动定位可能选到旧分片（过期的 `Cluster_1`） | 跑前先确认 `whale_state.json` 的 mtime；优先用支持 `--bridgeDir` 的脚本 |
| 9 | `guide/*.md` 仍描述历史动作 | 模型读攻略会看到 `chop`/`mine`/`pick` 等**已不开放**的动作名 | **NEEDS_REVIEW**：本阶段没改攻略正文（属内容，不属于链接修复） |
| 10 | 世界内版本要重读才更新 | 状态文件里还是旧版本号，直到重进世界 | 升级模组后需重新读档（行为不受影响时除外） |

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
4. 攻略正文与现有能力不一致（见 §5 #9）。

---

## 7. 当前开发优先级（建议）

1. **不要急着加新动作**。先把「死亡/复活」和「续火/回血」补上——这三件事不做，任何长跑都会断。
2. 每次开放新动作，**必须同时**：加白名单（dispatcher）+ 加工具定义 + 加 Lua guard 分支 +
   加结果核对 + 加测试（`tool-parity` 会盯着白名单一致性）。
3. 保持"一个动作一个试点"的节奏（M2.1、M2.3 都这么做的），不要一次开放一批。
4. 单槽结果文件若要改，属于**桥的协议变更**，必须同时改 Lua 与 Node，并补跨进程测试——不要顺手改。