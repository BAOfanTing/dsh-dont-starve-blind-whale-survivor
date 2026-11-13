# M2.3 · 已知限制

> 版本 0.17.0。**只读事实，不美化。**

---

## 1. 只支持一种目标类型

`berrybush` / `berrybush2`（普通浆果丛）。
其他一切（含 `berrybush_juicy`、草、树苗、胡萝卜、蘑菇、农田作物、锅/晾肉架/蜂箱、树/岩石/冰/建筑/生物）
都是 `prefab_not_allowed`。这不是缺陷，是"没批准就不放行"。

## 2. 工具名 vs 原生动作名

工具叫 `harvest`（任务书指定），但本试点**底层走原生 `ACTIONS.PICK`**。
原生 `ACTIONS.HARVEST`（crop / harvestable / stewer / dryer / occupiable 那一类）**本阶段不开放**。
将来若要支持农田或晾肉架，需要另开一个候选类型并复用同一套 `HarvestRules` 思路。

## 3. 距离很紧（≈1.03 格）

原生规则是 `目标物理半径 + 4` 世界单位；浆果丛物理半径 0.1 ⇒ 4.1 世界单位 ≈ **1.03 格**。
比 pickup 的 2.5 格紧得多，**必须站得很近**。
`harvest` 不会自动靠近 —— 远了直接 `out_of_range`，要靠近请先 `move_to`。

## 4. 成熟判据只有布尔

原生只给 `CanBePicked()`（真/假），**没有**"还差几秒成熟"的接口。
所以观察里只有 `harvest_ready`（+ `cycles_left`），**不提供百分比或倒计时**（不伪造）。

## 5. 产物只有一种走向可确认

普通浆果丛的产物 `berries` **直接进背包**。
背包满时原生 `GiveItem` 会把物品丢回地面 ⇒ 回执会说"没进背包，应该掉在地上了"，
但**不保证**能立刻在附近看到它（地面物品可能被 `pickupables` 的桶上限挤掉）。

## 6. `harvestables` 只有 12 个名额

复用全局单桶上限 12、总量 60。
同一片区超过 12 株浆果丛时，多出来的拿不到 `#N`（会计入 `total_found`/`not_returned_count`，
文本会提示"本桶已满"）。**没有**为它单独加配置项。

## 7. 真机样本依赖重进世界

Lua 改了就必须重载；0.16.0 的世界里没有 `harvestables` 桶。
脚本已就绪，会把没观察到的项标成 `NOT_OBSERVED`。

## 8. 换手期间的行为只在 UNIT 层验证过

`job_cleared === true` 的强制、`A.Abort` 清 buffered action、ACK 时效 —— 都有单元测试和源码断言，
但"**harvest 执行到一半发起换手**"这个时序场景**尚未在真机复现**（属于 NOT_TESTED）。

## 9. `unknown` 的恢复流程靠人/模型

命令发出去但回执丢失时返回 `unknown`，**不自动重试**。
恢复靠"先 `get_state` 看目标 `harvest_ready` 是否已翻转"，这一步目前是提示，不是自动化。

## 10. 本次顺带修的安全缺口说明了历史欠账

`completeHandover` 此前不校验 `job_cleared`、`lease_id` 可选（M2.0.1 审计的 P0）。
**pickup（M2.1）是在缺这条保护的情况下开放的**。
现在补上了，但历史阶段"在缺少该保护下完成的真机验证"这一事实仍需如实记录。

## 11. 本阶段明确没做的（按任务书要求）

不新增第二个工具注册中心；不新增控制入口；不砍树/挖矿/凿冰/破坏建筑/捕猎/战斗；
不自动连续采集、不采集多个目标、不自主循环；
不把 harvest 和 pickup 合成宏；不按 prefab 找替代目标；
不改 Pickup 白名单；不改 Control Lease 架构；不改用户存档；不改 API Key / 模型配置；
不改归档 A 栈；不改 `m12-watch.mjs`；不做第二次 `FindEntities`。
