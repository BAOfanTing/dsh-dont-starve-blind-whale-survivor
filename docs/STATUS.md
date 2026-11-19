# 当前状态

> 最后更新：PHASE-R 治理阶段 (插件 0.12.0 / 模组 0.41.0)｜完成 Task Board 与 Skill Executor 架构收敛 (Phase R.2)｜完成 World Memory schema 规范与自愈升级 (Phase R.3)｜完成 Planner 决策仲裁与 plan.js 纯粹化 (Phase R.4)｜完成 Task 身份与技能实例生命周期重构 (Phase R.6)｜**完成自主执行运行时集成 (Phase R.7)**｜全量自动化测试 **979/979 全部通过** (0 失败、0 跳过)｜**以代码和真实运行状态为准**，不凭计划推断。

---

## 1. 版本

| 位置 | 版本 | 含义 |
|---|---|---|
| `DontStarveWhaleSurvivor/modinfo.lua` | **0.41.0** | **游戏内 Lua 模组的版本**。每改一次模组 Lua 就升一位。 |
| `package.json` | **0.12.0** | **DSH 插件（Node 侧）的版本**。跟着插件功能走。 |

两个版本号描述两个交付物：模组装进游戏 `mods/`，插件装进 DSH。给 AI 报告的状态以模组版本为准。

---

## 1.5 TARGET-REFRESH 改了什么（本轮）

真机日志 `latestLogs/session.txt`（94 次工具调用）暴露出四类系统性问题，本轮逐一修掉：

| 问题 | 日志证据 | 修法 |
|---|---|---|
| **目标引用过期** | 23 次 `pickup` + 3 次 `chop` + 2 次 `harvest` = `stale_snapshot`；模型连续 23 次拿同一个 `#1` 配一个**往上猜**的 snapshot_id（n217→n220→…→n420） | ① `pickup_nearest` / `pickup_food` / `harvest_nearest` / `chop_nearest` / `mine_nearest`：只说**固定枚举** `target_kind`，Lua 在执行那一刻重新找目标；② 稳定句柄 `target_handle`（不含 GUID，跨扫描有效，过期即拒）；③ 连续两次同一个旧引用 → **熔断**（不再发到游戏）+ 替代方案 |
| **食物救援失败** | Reflex 吃掉胡萝卜后模型继续 `eat carrot` → `not_in_inventory`；`green_mushroom` 被当可食物品 → `food_not_allowed`；自动进食 `no_food` | 失败回执改为返回**当前真实背包**与正确 prefab 名；`pickup_food` 实时搜地面白名单食物；`harvest_nearest` 只采**成熟**植株；生蘑菇仍不在 AUTO_SAFE |
| **第一阶段科技缺失** | `craft rope` → `recipe_not_allowed` | 开放 rope / boards / backpack / spear / armorwood（**两边同时**，材料读原版 `AllRecipes`，科技由游戏 `KnowsRecipe` 判）；`build` 删掉"材料变少就算成功"的弱证据 |
| **旧世界记忆串味** | 笔记里基地 `(21,-81)`，角色实际 `(-21,-5)` | 笔记按 `world_key`（cluster + shard）分文件；换世界显式提示并归档旧坐标；`plan` 换世界必重推 |

**没有做**（任务书明确禁止）：放宽 `stale_snapshot`、允许旧 `#N`、自动 `+1`、盲用同编号实体、暴露 GUID、
缩短模型思考时间当根本方案、加 Prompt 长度掩盖系统错误。
**没有动的安全边界**：Control Lease、Lua Guard、Dispatcher 唯一出口、ACK/Handover、单角色活动任务约束。

详见 [TARGET-REFRESH.md](TARGET-REFRESH.md)。

### 1.6 真机跑出来才发现、已经修掉的三个问题

单测全绿不等于真机没问题。这轮在真实世界里跑验收时抓到三个"只有真机才暴露"的缺陷：

| 问题 | 症状 | 修法 |
|---|---|---|
| `eatrules.lua` 少了 `local tonumber = GLOBAL.tonumber` | 模组沙箱里 `tonumber` 是 nil → `DiagnoseHint` 一被调用就抛错；而它在 `guard.validate` 的 eat 分支里、**外层没有 pcall**，会把整条命令处理打断 | 补上沙箱头。这个坑是本轮新写的 fengari 夹具（把 `pcall/tonumber/error/os/io` 置 nil）抓出来的 |
| `gather` 类目标（草丛/树苗/花）不发句柄 | 工具说明写着"也可以用 target_handle"，但句柄只覆盖 harvest 类 → 模型永远拿不到草丛的句柄，典型的说明书漂移 | `T.WorthHandle = MatchesAny or IsGatherable`；句柄只表示"目标还在"，成熟度仍由 guard 现判 |
| `verify-live.mjs` 的 `authorityDirs` 传了字符串数组 | `LeaseManager._persistAll` 要 `{dir, channel}`，传字符串会 `writeFileSync(undefined)` → 验收脚本永远 `authority_write_failed` | 传 `bridge.leaseDirs()` 原对象；"拿租约"改成有界重试 + 用游戏写的 ACK 完成换手，跑完释放 |

第一条尤其值得记：**它会让 `eat` 失败时的整条回执链断掉**（模型什么也收不到），
正是本轮要修的那类"失败时不给有效信息"的问题。

### 1.7 科学机器整链（0.39.3）

用户要求"测试造出科学机器"。补测时又抓出三个真问题：

| 问题 | 症状 | 修法 |
|---|---|---|
| `build` 的 `recipe` 没有 enum | `build {"recipe":"goldenaxe"}` 在 Node 侧被放过（只在 verify/Lua 里拦），白烧一次调用 | `BUILDABLE_RECIPES` 锁进 `enum`，和 `craft` 一致 |
| `build` 缺料只回"材料不够" | 真机 `build sciencemachine` → 「ingredients_missing: 材料不够」，模型不知道差 goldnugget 还是 rocks | 改走 `craftrules.MissingIngredients(p, **原生名 researchlab**)` → 「goldnugget 0/1, log 0/4, rocks 0/4」 |
| `prefab` 正则挡住数字 | 真机 `probe {"prefab":"rock1"}` → `bad_format:prefab`；石头真名就是 `rock1`/`rock2` | Node 与 Lua 两侧的 prefab/item/food/recipe 正则都放开数字（`^[a-z0-9_]{1,32}$`）；`target_kind` 仍严格（我们自己的枚举） |

> 第二个的坑在**别名**：`craftrules` 的表键是原生名 `researchlab`，传模型说的 `sciencemachine`
> 会查不到配方、反而退化成"材料不够" —— 测试 SM-7 就是盯这个。

新增 `tests/science-chain.test.mjs`（9 例）：`build sciencemachine` → `researchlab` 别名解析、
建造**必须有建筑实体**、缺料逐个报、科技锁优先于材料、prefab 名允许数字。

### 1.8 真机把科学机器造出来了（0.40.2）—— 又抓出五个问题

用户要求"造个绳子 / 造出科学机器"。这条链走通的过程中，真机暴露了五个只有实机才会出现的问题：

| # | 问题 | 症状 | 修法 |
|---|---|---|---|
| 1 | **连砍只砍一下** | `chop_nearest` 干等 120 秒 → `result_timeout`。`work_by_ref`（chop/mine 走的新路径）在 start 只 push 一次就干等，而树要 4~5 下才倒 | 把 `job_work` 已验证的机制搬过去：`hold_control` 连砍 + 复用同一个 `BufferedAction` 每 0.4 秒主动重推 + 及时松手 + 数砍几下（>40 报"工具太弱"） |
| 2 | **树倒了却报"推不动"** | 树砍倒、木头都掉在地上，回执却 `推不动 常青树…可能工具不对` | `work_done` 原来只看 `workleft <= 0`；真机树倒后是**变树桩**（`workable.action` CHOP→DIG）。改成 action 和 workleft **两个都看**（`job_work` 一直如此） |
| 3 | **木头永远捡不起来** | 用户原话："你能把树砍了啊，就是没捡木头"。`log` 不在 `pickuprules.PREFABS` 里，`pickup`/`pickup_nearest(log)` 全被拒 | 拾取白名单补上砍/挖产物：`log`/`rocks`/`goldnugget`/`nitre`/`charcoal`/`pinecone`/`acorn`（Node 侧 `GROUND_PICKUP_PREFABS` 同步） |
| 4 | **挖矿产物不捡** | 岩石挖碎 → `挖了 岩石` 但 rocks/flint/nitre 全躺地上 | 岩石一碎实体就 `IsValid()=false`，`work_by_ref` 开头"目标没了→done"**直接跳过 loot**。把 loot 抽成 `work_loot_step`，并在函数**最开头**先处理 `j.step == "loot"` |
| 5 | **科技判定自相矛盾** | 机器造好、人站 0.7 格，`craft rope` 报 `recipe_locked`；同一角色 `lookup rope` 却说「现在就能做」 | `lookup` 用 `builder:CanBuild`（认身边科学机器的临时科技），`guard` 用 `builder:KnowsRecipe`（**不认**，`_tempbonus` 靠玩家 controller 刷新）。统一改 `CanBuild`，并**先判材料再判科技**（否则 `CanBuild` 含材料，缺 1 燧石会被误报成科技锁），再加 `prototyper` 兜底 |

另外两个顺带修的：

- **`equip` 报 `hand_unchanged` 极具误导性**：它既可能是幂等成功（本来就拿着）也可能是真失败。真机踩到：报了这个之后下一步 `move_to` 被 `dark_no_light` 拒（手其实是空的）。改成幂等成功放行、真失败报 `equip_failed`。
- **自动暂停已删除**：AI 思考时暂停世界会让刚下发的动作等不到 tick → `result_timeout`。现在 `setPause()` 只负责解除残留暂停，暂停交给玩家按 ESC。配置项 `freezeTime`/`idleSeconds` 标为已废弃。
- **`work` 距离阈值统一为 2.5 格**：以前 `targetrules` 写 6、`guard` 写 6、执行层要贴脸，模型会看到"找到了却做不了"。真机还出现"站在矿旁边 1.8 格被拒"。三处统一（原生 CHOP/MINE 的 `arrivedist` 允许引擎自己补最后一小步）。
- **科学机器材料说明写错了**：Lua 注释和 `tools.js` 都写"4 木板"，原版是 **log 4**（`boards` 本身要 `TECH.SCIENCE_ONE`，得先有机器 → 死循环）。已改，并有测试 SM-10 盯着。

**真机验收结果（0.40.0）**：

```
craft axe                    ✅ 做好了 斧头，已自动拿在手里
chop_nearest tree ×2         ✅ 砍了 桦栗树（acorn+1，log+3）/ 砍了 常青树（log+2，pinecone+1）
craft pickaxe                ✅ 做好了 镐
mine_nearest gold_vein       ✅ 挖了 岩石（flint+1，goldnugget+1，rocks+3）  ← 产物自动进包
mine_nearest ordinary_rock   ✅ 挖了 岩石（flint+1，nitre+1，rocks+3）
build sciencemachine         ✅ 把 sciencemachine 放下了（goldnugget-1，log-4，rocks-4）
probe researchlab            ✅ 20 格内有 1 个 researchlab：(47,-40) 0格  ← 建筑真的在世界里
```

`craft rope` 的修复（问题 5）在 **0.40.2**，需要重新读档才生效 —— 待复验。

测试从 799 → **824**（新增 `chop-chain` 11 例、`science-chain` 14 例等）。

### 1.9 帐篷链 + sleep（0.41.0）

用户要求"造出帐篷睡觉"。真机一查，卡点**不在游戏里，在三处白名单**：

| 层 | 文件 | 原来的上限 |
|---|---|---|
| 工具 enum | `lib/tools.js` | `build` 只有 7 个（campfire…researchlab），`craft` 只有 9 个 |
| 插件校验 | `lib/actions/specs/crafting.js` | `BUILDABLE_RECIPES` / `RECIPE_WHITELIST` 同上 |
| 游戏内 Lua | `guard.lua` 的 `BUILD_OK`、`actions/crafting.lua` 的 `BUILD_ALLOWED`、`craftrules.lua` 的 `C.RECIPES` | 同上 |

于是 `build tent` 在 Node 侧就被 `bad_value:recipe` 拒掉 —— 材料攒得再多也走不到游戏里。
另外 `sleep` 一直没接上工具表（`JOBS.sleep` 在 `survival.lua` 里早就写好了：找附近
`components.sleepingbag` 的实体/背包睡袋 → `ACTIONS.SLEEPIN`），所以"造好帐篷也睡不进去"。

本轮开放（三层同时改，测试 `recipe-parity` / `science-chain` / `tool-parity` 盯一致性）：

```
build  sciencemachine          4 log + 4 rocks + 1 goldnugget
craft  boards ×4 cutstone ×2 transistor ×2     ← 要站在科学机器旁边
build  researchlab2（炼金引擎）  boards 4 + cutstone 2 + transistor 2
craft  rope ×3 twigs ×4                        ← 要站在炼金引擎旁边
build  tent（帐篷）             silk 6 + twigs 4 + rope 3
sleep                          在帐篷/睡袋里睡一觉（回血回理智）
```

- 别名：`alchemyengine` → `researchlab2`（`core.lua` / `crafting.lua` 的 `RECIPE_ALIASES` 同步）。
- 科技提示按阶段分流：新增 `craftrules.TechHint`，`SCIENCE_TWO` 会提示"先造炼金引擎"，
  不再是笼统的"还没解锁"。
- `sleep` 的核对**不看 Lua 回执**：要么血/理智真的涨了，要么时间真的往前走了（跨时段/跨天）。
- `silk` 只能打蜘蛛掉；`seek spiderden` 找巢。
- 生存优先与角色特异性优化：沃尔夫冈饥饿阈值前移（55%提前进食、70%断粮强制存粮）；断粮且饥饿下降时强行拦截砍树敲矿，转为寻食；foodSource 较远目标给出 `move_to` 坐标提示；Reflex 寻粮与采花检索半径扩大至 16 格。

**未做**：`pick` / `heal` / `make_fire` 仍未开放；帐篷的多人/耐久语义没有额外处理（原生 `sleepingbag` 自己管）。

### 1.10 层级规划 + 家园系统（插件 0.12.0）

把"每轮临时决定下一步"升级为「长期阶段 → 中期任务看板 → 短期原子动作」三层；最优先解决"材料齐全就地建科学机器"与"没有明确家园"。

| 模块 | 职责 | 关键点 |
|---|---|---|
| `lib/planner/world-memory.js` | 按 `world_key` 落盘记忆（营地/家/阶段/看板/里程碑/已知建筑/危险区/近期失败） | 复用 `sanitizeWorldKey`；换世界不继承旧 home |
| `lib/planner/task-board.js` | 任务状态机（pending/ready/in_progress/done/blocked/failed/cancelled）、依赖 DAG、attempts+冷却、合并保活 | 完成必须有**证据**（快照核对），失败不无限重试 |
| `lib/planner/base-site-planner.js` | 多指标候选营地评分（安全/资源/食物/空间/交通/连通近似/危险惩罚） | 只用已观察数据；信息不足→要求探索；危险区不选 |
| `lib/planner/development-stages.js` | 阶段 0..6 完成条件（快照+记忆） | 完成才推进；已完成不重开 |
| `lib/planner/survival-priority.js` | P0..P4 生存级别；P0/P1 时普通任务让位 | 长期目标保留，不丢 |
| `lib/skills/establish-home.js` · `gather-resources.js` | 把"建家/缺料"展开成任务 | 只产出任务，不直接下动作 |
| `lib/planner/planner-core.js` | 编排：读记忆→定阶段→刷看板→评审→给下一步；`guardBuild()` 家园门槛 | `get_state` 追加「发展阶段/任务看板」 |

**家园规则**：`camp_site`（选址坐标）≠ `home`（真实建筑锚点 `building:<prefab>@x,z`）。
流程：勘察选址 → 前往 → 建第一座科学机器 → 用观测到的建筑坐标设家 → 后续基地建筑必须在锚点半径内。
`executeTool('build')` 在有 planner 时前置 `guardBuild`：开局生存阶段（`not_ready_stage`）/ 未选址（`no_camp_site`）/
没到营地（`not_at_camp`）/ 没家（`no_home`）/ 超出家范围（`out_of_home_range`）一律拒绝 —— **不再可能"材料够就地在脚下建机器"**。
营地（camp_site）**只在进入建立家园阶段（Stage≥1）后才落定**，且选址对"脚下 1.5 格内"的候选加惩罚，避免把营地定在出生点原地。

**边界**：不改 Lua、不新增执行通道，所有动作仍过 dispatcher/guard；`plan.js` 删除了 `build_science_machine` 目标（就地在脚下建）。
**Phase F（真机验收）待做**：全新世界活过首夜→选址→建家→科技→第 3/5/10 天，需在游戏内实际跑，不用模拟冒充。

---

## 2. 现在能做什么

### 2.1 模型可见的工具（42 个 = 4 本地 + 38 动作）

> 权威清单：`lib/actions/specs/*.js` 的 `ACTION_SPECS`。`OPEN_ACTIONS`、`TOOLS`、`RULES` 均从它派生，有 `tool-parity` / `prompt-parity` 测试保障。

| 工具 | 类型 | 说明 |
|---|---|---|
| `get_state` | 只读 | 时间/位置/三维/背包/附近/威胁/注意/需求提示；`format=json` 给结构化数据 |
| `get_guide` | 只读 | 攻略四篇：主攻略 / 生存 / 战斗 / 烹饪（玩家可覆盖） |
| `update_notes` | **本地写入** | 写长期笔记（**按世界分开存**），下次 `get_state` 显示在最前 |
| `run_skill` | **本地编排** | ★ **执行复合技能**（survival_stabilize / establish_home / gather_resources）：每次推进一个有界步骤，内部仍走唯一 dispatcher；技能实例持久化、可恢复、不重复建 |
| `pickup_nearest` | 动作 R2 | ★ **不会过期**：捡最近的一类地面材料（flint/twigs/cutgrass/log/rocks/goldnugget/charcoal/petals） |
| `pickup_food` | 动作 R2 | ★ **不会过期**：实时搜并捡地上的**安全**食物（生蘑菇不算） |
| `harvest_nearest` | 动作 R2 | ★ **不会过期**：采最近**已成熟**的食物植株（未成熟自动跳过） |
| `chop_nearest` | 动作 R2 | ★ **不会过期**：砍最近的树（自动装斧头） |
| `mine_nearest` | 动作 R2 | ★ **不会过期**：挖最近的石头（ordinary_rock / gold_vein，自动装镐） |
| `move_to` | 动作 R1 | 走到格子坐标，自动绕障，报告还差几格 |
| `stop` | 动作 R1 | 立刻停下 |
| `pickup` | 动作 R2 | 捡地上的材料/全部基础与熟食食物（`#N`+快照，或稳定句柄） |
| `harvest` | 动作 R2 | 采摘成熟食物植物（`#N`+快照，或稳定句柄） |
| `gather` | 动作 R2 | 采草丛 `grass`、树苗 `sapling`、花 `flower` |
| `eat` | 动作 R1 | 吃背包里**此刻真实存在**的白名单食物（不填 = 服务端挑最该吃的） |
| `craft` | 动作 R2 | `torch`/`axe`/`pickaxe`/`flowerhat` + **第一阶段科技** `rope`/`boards`/`backpack`/`spear`/`armorwood`/`cutstone`/`transistor` |
| `equip` | 动作 R1 | 把 `torch` / `axe` / `pickaxe` 等拿在手里 |
| `gather_area` | 动作 R2 | 一次采完附近能采的草/树苗/浆果/胡萝卜 |
| `seek` | 动作 R2 | 8 方向 × 多环走出去找东西，只报位置、不自动动手 |
| `chop` / `mine` / `dig` / `hammer` | 动作 R2 | 砍树 / 挖矿 / 铲草皮树桩 / 拆建筑（需要对应工具） |
| `attack` / `kill` | 动作 R2 | 打几下 / 打到死 |
| `wait` / `drop` | 动作 R1 | 等一会儿 / 丢背包里的东西 |
| `sleep` | 动作 R2 | 在帐篷/睡袋里睡觉（**不用引用**，服务端在 radius 内找最近的帐篷；核对以血/理智上涨或时间真的前进为准） |
| `unequip` / `fuel` / `use` / `inspect` / `say` | 动作 R1/R2 | 脱装备 / 添柴 / 通用交互 / 查目标详情 / 聊天 |
| `container_take` / `container_put` / `give` / `cook` | 动作 R2 | 容器取放 / 给予 / 锅料理 |
| `build` / `recipes` / `lookup` / `probe` | 动作 R2/R1 | 摆建筑（白名单 10 种：营火/火坑/箱子/锅/科学机器/炼金引擎/帐篷等，**必须看到建筑实体才算成功**）/ 查配方 / 查资料 / 探附近 |

### 2.2 非模型能力（系统底座）

- **保命反射（Reflex，默认开）**：
  - **职责收窄**：聚焦于现在就会死的 5 件事（逃跑、光照、进食、回血、理智）。
  - **原生能力复用**：光照用引擎真实读数（`native.IsLit` / `native.FindLitSource`）、逃跑避障角度复用原版 `RunAway:GetRunAngle`、采集统一走原生 `ACTIONS.PICK`。
  - **紧急需求上报**：反射自己解决不了的危险（如天黑无料做光、饿极无粮可采）上报为结构化需求 `Needs()`，在 `get_state` 明确提示。
  - **安全抢占与单槽保护**：仅 P0/P1 可中断普通任务，中断走唯一取消路径 `A.Abort`，确认清理干净后才启动新动作。
- **计划层（Plan）**：从快照推导当前唯一目标并保持稳定，模型按建议行动，减少每轮从头规划开销。
- **层级规划层（Planner）**：长期阶段（0..6）+ 中期任务看板（依赖/证据/重试冷却）+ 家园选址与建造约束；`get_state` 末尾输出「发展阶段/任务看板/下一步」，记忆按 `world_key` 隔离并落盘。P0/P1 生存事件让普通任务暂停但不丢长期目标。
- **统一决策仲裁器（Decision Arbiter，Phase G）**：把「生存规则引擎（`plan.js`）」与「发展阶段/任务看板（`planner-core`）」收敛成**唯一 decision**；`get_state` 文本与 JSON 都只从它派生（兼容字段 `plan`/`development` 也来自同一 decision），不再出现两套互相独立的下一步。
- **技能执行器（Skill Executor，Phase G）**：`lib/skills/skill-executor.js` 真正驱动多步骤技能，每次 `run_skill` 推进一个有界步骤、串行走 dispatcher、以快照证据（非 ok=true）判定步骤完成；技能实例存 `world memory`，支持启动/暂停/恢复/取消/失败恢复，且同一角色同一时刻只有一个技能在跑（新技能会暂停旧技能并保留进度）。
- **Control Lease（控制租约）**：跨进程与 F8 互斥，换手严格等待旧持有者交回 `job_cleared` ACK。
- **Lua Guard**：Node 端校验过的每一条约束，游戏内部重新做一次防御校验，杜绝非法注入。

---

## 3. 历史里程碑概述

| 阶段 | 核心成果 | 证据类型 |
|---|---|---|
| **M0 ~ M1.4** | 确定 B 栈架构，确立 Actor Provider、结构化 nearby、`#N` 实体引用与 Delta 差量 | UNIT + RUNTIME |
| **M2.0 ~ M2.0.3** | 实现 Action Dispatcher、Control Lease 租约握手与换手 ACK 验证 | UNIT + RUNTIME |
| **M2.1 ~ M2.3** | 实现 `#N` 驱动的 `pickup`、`harvest`（试点普通浆果丛），首创观察-执行共享白名单 | UNIT + RUNTIME |
| **SURVIVAL-01 ~ 06** | 基础生存链闭环：采草/采枝/做斧镐火把/穿脱/进食/范围采集/工具交互/建筑/容器/烹饪 | UNIT + RUNTIME |
| **NATIVE-REUSE** | 复用原版照明/逃跑避障/玩家挥砍逻辑；收窄 Reflex 为 5 项生死职责并引入紧急需求上报 | UNIT (722/722) |
| **FOOD-EXPANSION (0.38.1)** | 修复 Reflex 下发 `ACTIONS.PICK`（解决采浆果死锁）；开放胡萝卜苗/多汁浆果/蘑菇采摘及地面全食物拾取 | UNIT (727/727) |
| **BUGFIX-BUILD-PROBE (0.38.2)** | 修复 `probe` 坐标 z 轴被多返回值截断（恒为 0）；修复 `build`/`lookup` 别名（chest→treasurechest，sciencemachine→researchlab）；修复 `build_by_ctx` 缺少材料时的 `table.concat` 崩溃 | UNIT (730/730) + RUNTIME |
| **TARGET-REFRESH (0.39.0)** | 实时目标选择（5 动作 + 固定枚举）、稳定句柄、stale 熔断、食物救援链、第一阶段科技、笔记按世界隔离 | UNIT + INTEGRATION；**RUNTIME 已在真机验收**：确定性场景 12/12 通过、实时目标选择 stale=0、句柄按白名单发放 |

---

## 4. 关键技术复盘与真实验证结论

### 4.1 致死链与真实死因分析

1. **黑暗致死链的真实机制**：
   - 游戏原生配置包含 `TUNING.NONLETHAL_DARKNESS=true`（查理最多打到 20% 残血）。
   - 真实死亡链：**夜间无光 → 理智暴跌归零 → 刷出爬行恐惧/尖喙暗影怪 → 残血被暗影怪补刀**。
   - 结论：**防黑暗伤害的本质是保住理智**，必须夜间有光与及时采花补理智双管齐下。

2. **Reflex 行为边界**：
   - **黄昏不举火把、入夜才举**：黄昏自然光足够，手持火把会白白烧光 75 秒耐久。
   - **材料保护**：火把未完成且无可用光源时，保留 2 草 + 2 树枝底线，不被斧头等工具抢走。
   - **不可解决不上锁**：附近无材料/无食物时，不再每 5 秒抢占打断模型，而是如实生成 Need 让模型走远探索。

3. **原生动作与组件坑位**：
   - `ACTIONS.PICK` 对应 `components.pickable`（草、树苗、浆果丛、地里胡萝卜全部走它）。
   - `ACTIONS.HARVEST` 对应 `components.crop` / `components.harvestable`（农田、蜂箱、干燥架、烹饪锅出锅走它）。
   - `inst:IsInLight()` 是权威玩家光照判断，不能按没有被实际写入的 `lightsource` 标签猜。

---

## 5. 当前已知问题与工程约束

| # | 问题/约束 | 影响 | 当前应对/机制 |
|---|---|---|---|
| 1 | **结果文件单槽通道** | Reflex 汇报偶发覆盖动作回执 | 桥的既有设计，模型以 `get_state` 观察最新游戏事实为准 |
| 2 | **Reflex 独占 Actor** | 偶发返回 `actor_busy` | 正常现象（单一角色不可同时并发动作），先 `stop` 再行动 |
| 3 | **原生拾取距离限制** | 约 1 格物理范围，偶发 `out_of_range` | 保持原生距离不伪造；`pickup_nearest` 会直接告诉你"最近的在多远、哪个格子"，先 `move_to` |
| 4 | **单桶最多 12 条/总数 60 条** | 极密集区域实体被截断 | 属于帧体积控制，移动后换帧重新观察 |
| 5 | **笔记跨世界隔离** | （已修）~~`notes.md` 跨存档共享~~ | TARGET-REFRESH：笔记按 `world_key` 分文件；换世界显式提示并归档旧坐标 |
| 6 | **句柄的存活窗口** | 目标离开 16 格扫描半径后句柄失效 | 这是刻意的（失败要安全）：句柄只在"目标还在附近"时有效；走远后重新 `get_state` 即可 |
| 7 | **`#N` 仍然会过期** | 拿 `#N` 动手依然可能 `stale_snapshot` | 这是设计而非 bug：`#N` 只保证"这一帧内有效"。要跨帧请用 `target_kind` 或 `target_handle`；猜 `snapshot_id` 会被熔断 |

---

## 6. 后续演进建议

1. **补足关键自保动作**：开放主动加柴（`fuel`）与主动上药（`heal`）的高层模型工具联动。
2. **坚持端到端真机验收纪律**：只有经过本地真机加载与日志观测验证的完整闭环，才进行 git 提交与版本定型。
3. **严格遵守架构边界**：任何新增功能必须通过 Dispatcher、Control Lease 与 Lua Guard，绝不建立第二通信通道。

---

## 7. Phase G：统一规划决策 + 模块化 Skill Executor（本轮）

> 目标：解决"两个规划器同时工作"，并把只产出任务建议的 Skills 升级为**真正执行多步骤工作流**的技能系统。
> 证据类型：**UNIT（真实实现 + 合成可变世界 + 假 dispatcher）**；全量测试 **914/914 通过**。真机（真实游戏）验收仍未冒充，见 §7.5。

### 7.1 G1 统一决策出口（Decision Arbiter）
- 新增 `lib/planner/decision-arbiter.js`：`arbitrate(snapshot,{devPlan,survivalPlan})` → 唯一 `decision`（world_key / current_stage / primary_goal / current_task / current_skill / decision_reason / priority / next_action / blocked_tasks / completion）。
  - P0/P1 生存 → 下一步取自 `plan.js` 的生存规则引擎（保命规则**全部保留**）。
  - P2/P3 → 取自 `planner-core` 任务看板的唯一 `nextTask` + `nextHint`。
  - P3/P4 兜底 → 规则引擎（覆盖开局生存、存粮、探索）。
- `tools.js#getState`：装配 `planner` 时文本只渲染**一个** `## 当前计划（统一决策）`（含 发展阶段/主目标/任务/Skill/下一步/进度/阻塞/完成条件）；JSON 增加 `decision`，兼容字段 `plan`/`development` 均由同一 decision 派生（不再二次规划）。未装配 planner（单元测试）时退回旧 `renderPlan`，行为不变。
- 旧 `plan.js` **未删除**：GOALS 生存规则继续作为生存/兜底下一步的来源；已由 Planner/TaskBoard 接管的建造目标（`build_science_machine`）保持不变（早已移除）。

### 7.2 G2 Skill Executor 框架
- `lib/skills/skill-registry.js`：技能自注册/校验；`lib/skills/skill-executor.js`：增量执行器。
- 每步流程：检查前置 → 选原子动作 → **串行**过 dispatcher → **重读快照** → `step.isDone()` 验证 → 记录进度 → 下一步。
- 关键性质：`ok=true` 不算完成（必须快照证据）；中断后跳过已完成步骤（不重放）；失败有次数上限与每步调用预算；同一技能重复启动=恢复；同一时刻只有一个技能 in_progress。
- 实例持久化在 `world memory.skill_instances`（按世界隔离），`tasks → skill instance → step → action → verified → 回写`。

### 7.3 G3/G4 三个可用技能
- `survival_stabilize`：light → food → tools（沃尔夫冈用角色相关饥饿阈值；死亡/危险区交给 Reflex）。
- `establish_home`：检查已有家→勘察→选址（复用 base-site-planner）→前往（主选不可达切备选）→收料（复用 gather 动作）→建科学机器→设家（`recordHomeFromSnapshot` 真实锚点）。**建造必须看到建筑真实出现**。
- `gather_resources`：按真实缺口采集；中间产物依赖（缺 boards 先补 log 再 craft，不会一直砍树）；超出预算失败。

### 7.4 G5 集成与日志
- `run_skill` 作为**本地工具**暴露（`TOOLS` 42 个 = 4 本地 + 38 动作）；内部仍走唯一 dispatcher，并对 `build` 复用 `guardBuild` 家乡门槛。
- F8（`agent.js`→`callTool`→`runTool`）与 DSH（`mcp-server`→`executeTool`→`runTool`）**共用同一 `ctx.planner` 与同一 dispatcher 链**，`run_skill` 两者都能用。
- 日志统一：`[PLANNER] DECISION/GOAL_SELECTED/TASK_SELECTED/TASK_BLOCKED`（decision 输出）与 `[SKILL] START/RESUME/STEP_START/ACTION_DISPATCH/STEP_VERIFIED/STEP_FAILED/PAUSED/FINISHED`（executor 输出），均带 world_key / task_id / skill_id / step_id / 进度 / 结果。

### 7.5 验收边界（诚实标注）
- 自动化覆盖：决策唯一性、生存优先于建家、build/采集/gather 的真实证据核对、备用营地切换、已有家不重建、单角色单技能、中断不重放、失败上限、`get_state` 单一出口与 JSON 派生一致 —— 全部在 `tests/skill-executor.test.mjs` 用**合成可变世界**验证。
- **真机（真实游戏）验收仍未在自动化里冒充**：全新世界从出生→稳定生存→选址→建家→发展这条闭环，需要在游戏内实际跑并看日志确认（Phase F 纪律不变）。

---

## 8. Phase R：架构治理与收敛阶段 (Repository Stabilization & Architecture Governance)

> 目标：停止无序新增功能，完成全仓库架构与代码审计，建立统一架构基线与重构路线图，并完成高价值缺陷的精准修复。

### 8.1 六份权威审计报告交付 (`docs/audit/`)
1. `docs/audit/CODEBASE_INVENTORY.md`：覆盖 Node 插件、Lua 模组、测试与工具的完整模块清单，明确职责、调用方、被调用方与状态（active/legacy/duplicate/dead/incomplete）。
2. `docs/audit/CALL_GRAPH.md`：绘制从输入层 (MCP/F8) 到 Dispatcher、Lua Guard、Actions/Battle 的端到端调用图与数据流。
3. `docs/audit/DUPLICATE_LOGIC.md`：深度剖析 `plan.js` 与 `planner`、`establish-home` 与 `establish-home-skill` 等 7 处核心重复系统。
4. `docs/audit/ACTION_REGISTRY.md`：建立 38 个原子动作 + 4 个本地工具的权威全量矩阵，完成十大检查项审计。
5. `docs/audit/DOCUMENT_CONFLICTS.md`：全面梳理 README、ARCHITECTURE、STATUS 之间的版本、工具数、测试数差异。
6. `docs/audit/REFACTOR_ROADMAP.md`：确立未来收敛阶段路线图，并起草 `ARCHITECTURE.md` 目标架构草案。

### 8.2 Phase R.1 阶段门禁修复：打通技能参数传递 (Skill Args Passing)
- **问题**：`SkillExecutor` 和 `run_skill` 此前无法接收动态参数，导致 `gather_resources` 技能只能依赖写死的默认 `CORE_RECIPE`，无法为建造炼金引擎、帐篷等高级建筑收集材料。
- **修复**：
  - `SkillExecutor.run(skillId, skillArgs)` 支持传入 `skill_args` 并持久化至 `instance.data.skill_args`，恢复执行时保持不丢。
  - `tools.js#runSkillTool` 完整透传 `input.skill_args`，并在 `run_skill` 的 `inputSchema` 中正式声明 `skill_args` 字段。
  - `gather-resources-skill.js` 支持直接消费 `target_items` 字典或解析 `recipe` 配方名称（如 `"researchlab2"`）。
- **验证**：新增 `GATHER-SKILL-3`, `GATHER-SKILL-4`, `GATHER-SKILL-5` 三例针对性测试，全量测试 **921/921 全绿**。

### 8.3 Phase R.2 架构收敛：Task Board 与 Skill Executor 职责收敛 (Orchestrator Convergence)
- **目标**：彻底解决 Task Board 和 Skill Executor 的职责重复，让整个项目只有一套复合任务执行状态机。
- **改动**：
  1. 新增 `lib/planner/task-skill-orchestrator.js`，实现 `TaskSkillOrchestrator`，作为 Task Board 与 Skill Executor 的权威连接器；
  2. 明确四大核心职责划分：
     - **Planner**：负责发展阶段、长期目标、任务生成、优先级与策略；
     - **Task Board**：负责任务注册、依赖、优先级、状态、完成条件与阻塞/失败记录，不再维护复合技能的内部步骤；
     - **Skill Executor**：统一管理技能实例、步骤状态机、原子动作派发、真实证据核验与有界重试；
     - **TaskSkillOrchestrator**：获取唯一主任务、传递 `task.skill_id` 与 `task.skill_args`、处理生存紧急暂停与恢复、单步推进技能并将状态回写 Task Board；
  3. 统一任务数据结构：支持 `id`, `title`, `status`, `priority`, `skill_id`, `skill_args`, `depends_on`, `completion_evidence`, `blocked_reason`, `attempts`, `progress`；
  4. 重构建家与资源采集任务：
     - `establish-home.js` 统一承载复合建家技能（勘察选址、前往营地、收集材料、建造科技机器、设家与真实核验），`establish-home-adapter.js` 保留看板任务生成；
     - `gather-resources.js` 统一承载复合资源采集技能（背包与装备数量核算、缺口计算、中间产物依赖、原子动作派发、真实核对），`gather-resources-adapter.js` 保留看板任务生成；
     - 消除重复业务描述，提供向后兼容导出垫片；
  5. 统一执行入口与实例共享：
     - `get_state` 保持纯只读观察与决策；
     - `run_skill` 与自动调度共享同一个 `SkillExecutor` 实例；
  6. Reflex 抢占与恢复：
     - 紧急避险时安全暂停普通技能并保留进度；
     - 危险解除后恢复执行未完成步骤，跳过已完成步骤；
  7. 标准化日志输出：
     - 规范 `[TASK]`, `[ORCHESTRATOR]`, `[SKILL]` 三层日志，包含 `world_key`, `task_id`, `skill_id`, `step_id`, `status`, `reason`；
  8. 测试覆盖：新增 `tests/task-skill-orchestrator.test.mjs`，包含 14 项完整集成验证。
- **验证**：全量测试 **939/939 全部通过**（无失败、无跳过）。

### 8.4 Phase R.3 记忆规范：World Memory Schema 统一与数据自愈升级 (World Memory Governance)
- **目标**：规范 `world-memory.js` 的持久化字段契约，支持结构自愈升级与容错。
- **改动**：
  1. `emptyMemory` 补齐全部契约字段：`schema` (`bws.world-memory/1`)、`worldKey`、`task_board`、`skill_instances`、`explored_regions`、`known_resources` 等；
  2. 实现 `SUPPORTED_SCHEMAS`、`validateMemory` 与 `migrateMemory`，平滑兼容旧版本数据并防御性清洗异常浮点与越界字段；
  3. `store.load` 自动检测旧版本数据并在内存升级后落盘自愈。
- **验证**：新增 `WM-11`、`WM-12` 两项测试，测试集达到 **941/941 全绿**。

### 8.5 Phase R.4 规则收敛：Planner 决策仲裁与 plan.js 纯粹化 (Planner Core Pureification)
- **目标**：彻底理清 Planner Core、Decision Arbiter 与旧 `plan.js` 的边界重叠。
- **改动**：
  1. 梳理 Decision Arbiter 优先级梯队：P0/P1 生存绝对抢占，P2/P3 驱动 Task Board 阶段任务，P3/P4 执行日常与探索兜底；
  2. 收敛 `lib/plan.js` 为纯生存应急引擎，移除过时的制造与采集规则（移交 Task Board）；
  3. `get_state` 在装配 planner 时统一输出单一 `## 当前计划（统一决策）`。
- **验证**：新增 `PLAN-R4-1`、`PLAN-R4-2` 两项测试，测试集达到 **943/943 全绿**。

### 8.6 Phase R.6 实例生命周期：Task ID 与 Skill Instance ID 彻底分离 (Task Identity & Instance Lifecycle)
- **目标**：修复 Phase R.2 遗留的 Task Board、TaskSkillOrchestrator、Skill Executor 之间的实例身份共享、失败不能真实重试、参数串扰与并发互斥缺陷。
- **核心改动**：
  1. **Task ID 与 Skill Instance ID 彻底分离**：
     - `memory.skill_instances[instance_id]` 作为唯一物理持久化存储，内存根节点维护 `active_skill_instance_id`；
     - 实例包含 `instance_id`、`task_id`、`skill_id`、`skill_args`、`status`、`step_index`、`attempts`、`step_attempts`、`step_calls`、`calls`、`data`、`created_at`、`updated_at`、`failed_at`、`completed_at`；
     - 引入 Proxy 包装层 `wrapSkillInstances`，无损兼容按 `memory.skill_instances[skillId]` 访问当前活动实例，平滑支持旧版内存迁移；
     - 不同任务即使绑定相同技能（如连续三个 gather 任务），强制创建独立 `instance_id`，各实例独立拥有 `skill_args`，互不污染与继承。
  2. **失败重试真实执行**：
     - 任务执行失败时记录失败原因与 `failed_at`，旧实例作为审计历史保留在内存中；
     - Task Board 进入 cooldown 冷却期，任务状态临时置为 `blocked`；
     - 冷却结束后恢复 `ready`；再次被 Orchestrator 调度时，SkillExecutor 为该任务创建全新 `instance_id`，重新读取最新快照，真实调用 Dispatcher 下发动作（断言动作调用计数 > 0），杜绝直接返回 failed 或盲目重放动作；达到 `MAX_ATTEMPTS` 后才永久标记为 `failed`。
  3. **调度边界与互斥保障**：
     - 严格保证同一时刻只有一个活动实例控制角色控制权（启动新实例自动将旧实例置为 `paused`）；
     - 手动 `run_skill` 支持显式 `task_id`，缺省默认为 `manual:${skillId}`，与自动任务完全隔离；手动调用抢占角色结束后，后续自动调度能够安全恢复原自动任务的旧实例；
     - `get_state` 保持纯只读，绝不下发任何动作指令；
     - 跨世界实例严格物理隔离，切换世界后绝不恢复其它世界的实例。
  4. **快照事实凭证**：
     - 任务完成必须有对应目标的真实快照证据（物品数量增加、建筑真实存在、坐标到达），绝不轻信 `ok: true` 或复用历史 completed 状态。
- **测试覆盖**：
  - 新增 `tests/task-instance-lifecycle.test.mjs`，包含 LIFECYCLE-01 至 LIFECYCLE-16 全部 16 个生命周期场景以及 1 个完整端到端三资源串行任务测试（`LIFECYCLE-INTEGRATION`：缺木头×4、石头×4、金块×1 串行真实执行并依赖快照证据依次完成）。
  - 全量自动化测试达到 **959/959 全部通过**（959 pass, 0 fail, 0 skipped）。
- **真机验收纪律说明**：
  - 本次全量测试 959/959 通过属于**自动化测试（单元/合成世界集成）**通过；
  - 真实游戏（DST 联机版真机）运行仍需在游戏内挂载模组并实机观测日志（真机验收记录以真机日志证据为准，不冒充真实游戏通过）。
