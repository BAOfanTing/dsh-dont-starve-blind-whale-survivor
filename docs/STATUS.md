# 当前状态

> 最后更新：TARGET-REFRESH (Mod 0.39.0 / 插件 0.10.0)｜修复目标引用过期（23 次 stale_snapshot）与食物获取阻塞｜新增实时目标选择 + 稳定句柄 + 熔断 + 第一阶段科技 + 世界观记忆隔离｜**以代码和真实运行状态为准**，不凭计划推断。

---

## 1. 版本

| 位置 | 版本 | 含义 |
|---|---|---|
| `DontStarveWhaleSurvivor/modinfo.lua` | **0.40.2** | **游戏内 Lua 模组的版本**。每改一次模组 Lua 就升一位。 |
| `package.json` | **0.10.0** | **DSH 插件（Node 侧）的版本**。跟着插件功能走。 |

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

---

## 2. 现在能做什么

### 2.1 模型可见的工具（39 个 = 3 本地 + 36 动作）

> 权威清单：`lib/actions/specs/*.js` 的 `ACTION_SPECS`。`OPEN_ACTIONS`、`TOOLS`、`RULES` 均从它派生，有 `tool-parity` / `prompt-parity` 测试保障。

| 工具 | 类型 | 说明 |
|---|---|---|
| `get_state` | 只读 | 时间/位置/三维/背包/附近/威胁/注意/需求提示；`format=json` 给结构化数据 |
| `get_guide` | 只读 | 攻略四篇：主攻略 / 生存 / 战斗 / 烹饪（玩家可覆盖） |
| `update_notes` | **本地写入** | 写长期笔记（**按世界分开存**），下次 `get_state` 显示在最前 |
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
| `craft` | 动作 R2 | `torch`/`axe`/`pickaxe`/`flowerhat` + **第一阶段科技** `rope`/`boards`/`backpack`/`spear`/`armorwood` |
| `equip` | 动作 R1 | 把 `torch` / `axe` / `pickaxe` 等拿在手里 |
| `gather_area` | 动作 R2 | 一次采完附近能采的草/树苗/浆果/胡萝卜 |
| `seek` | 动作 R2 | 8 方向 × 多环走出去找东西，只报位置、不自动动手 |
| `chop` / `mine` / `dig` / `hammer` | 动作 R2 | 砍树 / 挖矿 / 铲草皮树桩 / 拆建筑（需要对应工具） |
| `attack` / `kill` | 动作 R2 | 打几下 / 打到死 |
| `wait` / `drop` | 动作 R1 | 等一会儿 / 丢背包里的东西 |
| `unequip` / `fuel` / `use` / `inspect` / `say` | 动作 R1/R2 | 脱装备 / 添柴 / 通用交互 / 查目标详情 / 聊天 |
| `container_take` / `container_put` / `give` / `cook` | 动作 R2 | 容器取放 / 给予 / 锅料理 |
| `build` / `recipes` / `lookup` / `probe` | 动作 R2/R1 | 摆建筑（白名单 5 种，**必须看到建筑实体才算成功**）/ 查配方 / 查资料 / 探附近 |

### 2.2 非模型能力（系统底座）

- **保命反射（Reflex，默认开）**：
  - **职责收窄**：聚焦于现在就会死的 5 件事（逃跑、光照、进食、回血、理智）。
  - **原生能力复用**：光照用引擎真实读数（`native.IsLit` / `native.FindLitSource`）、逃跑避障角度复用原版 `RunAway:GetRunAngle`、采集统一走原生 `ACTIONS.PICK`。
  - **紧急需求上报**：反射自己解决不了的危险（如天黑无料做光、饿极无粮可采）上报为结构化需求 `Needs()`，在 `get_state` 明确提示。
  - **安全抢占与单槽保护**：仅 P0/P1 可中断普通任务，中断走唯一取消路径 `A.Abort`，确认清理干净后才启动新动作。
- **计划层（Plan）**：从快照推导当前唯一目标并保持稳定，模型按建议行动，减少每轮从头规划开销。
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
