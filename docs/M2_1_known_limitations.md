# M2.1 · 已知限制

> 版本 0.15.0。**只读事实，不美化。**

---

## 1. 白名单只有三个 prefab

`twigs` / `cutgrass` / `flint`（依据本机 `scripts.zip` 核实都有 `inventoryitem`）。

- **`inv_rocks` 未启用**：本构建里石头物品的真名是 `inv_rocks`（`rocks.lua` 是巨石的脚本）。
  需要再验证它的掉落形态（挖矿产出到底是 `inv_rocks` 还是别的）之后才考虑加入。
- 任何其他物品（含 `goldnugget`、`rope`、`silk`、食物等）当前都会返回 `prefab_not_allowed`。
  这不是缺陷，是"没核实过就不放行"。

## 2. 距离上限 2.5 格（自己定的）

- DST 服务端 `ACTIONS.PICKUP.fn` **完全不检查距离**，所以必须由我们限制；
- 2.5 格是保守取值（客户端选目标的实际可用范围通常 2~3 格）；
- 超出直接 `out_of_range`，**不会自动走过去** —— 要靠近请先 `move_to`。

## 3. 不做自动寻路 / 不自动靠近

`pickup` 只提交 `BufferedAction(PICKUP)`，不调 `GoToPoint`，也不通知客户端走路。
好处是"绝不因为捡东西而把角色带到别处"；代价是离得远就得手动 `move_to`。

## 4. 一个 Actor 一次只能一个动作

已有 job 时 `pickup` 直接 `actor_busy`，**不会静默打断** `move_to`。
（`stop` 仍是显式中断动作。）

## 5. 结果核对依赖状态文件（有 ~1s 延迟）

- Node 侧核对靠"下一帧 `whale_state.json`"，最多轮询 3 秒；
- 如果游戏卡顿/暂停导致状态文件不刷新，会返回 `unverified` 而不是 `succeeded`；
- **宁可 unverified，也不谎报成功**。

## 6. 堆叠合并时拿不到精确"本次数量"

目标被合并进已有堆时，原实体直接失效，读不到这次捡了几个。
所以 `picked_count` 只在能确定时给出；否则用 `gained`（背包该 prefab 总量差）表达。

## 7. 真机验证状态

- **已完成（RUNTIME）**：新 MCP 注册了 pickup、Node 层放行、角色不合法时正确拒绝、**零副作用**。
- **未完成（NOT_RUN/BLOCKED）**：正常拾取、不该捡、背包满、距离 —— 因为世界还停在 0.14.4、
  角色是 ghost、附近没有白名单物品。
- `Fengari`/假 bridge 的通过项一律只算 `UNIT`，**不冒充真机**。

## 7.1 真机首轮（0.15.0）发现的另一个缺陷：released 被当成换手

MCP 每次 `tools/call` 都是 `acquire → 执行 → release`；0.15.0 的 `acquire` 把
`status=released` 也当成"要换手"，于是发布 `revoking` 等 Lua 确认，
**这次调用自己就被 `authority_revoking` 挡住了**（真机表现：move_to 直接 control_denied）。

已修（0.15.1，`lib/control.js`）：**上一任主动 release 时没有"正在跑的动作"要撤销**，
直接发新 generation 的 `active`；只有"从活着的持有者手里抢（force/不同实例）"和"过期"才走 revoking。
回归用例 `ack-8`。

## 7.2 真机发现：桶容量会把地面物品截掉（**影响 pickup 可用性**）

真机样本（0.15.1）：`total_found=108 / total_returned=25 / not_returned=83`，
`resources` 桶 12/12 全被植物占满（grass×6、sapling、rock1、rabbithole×2、flower）。

后果：地面上的树枝/燧石如果排不进最近的 12 个 resources，就**没有 `#N`**，
模型看不到、也就无法拾取。这不是 pickup 的 bug，是 M1.4 的桶容量与 M2.1 引用机制的交互问题。

可行的缓解（都超出 M2.1 范围，未实施）：
1. 给"可拾取物品"单独的桶或优先级（改 Observer）；
2. 增加 `pickup_nearest`（按白名单在附近找最近可拾取物），但这与"禁止 prefab 搜索"冲突，需要单独批准；
3. 使用侧规避：站到物品 2.5 格内，让它成为最近的 resources 之一（本次真机就是这么过的）。

## 7.3 真机发现：燧石被分到 `food` 桶

真机里 `flint` 出现在 `food` 桶（且带 `edible: true`）。拾取不受影响（白名单按 prefab 判定），
但分类不准确 —— 属于 M1.4 分类问题，记录待修，不在 M2.1 范围。

## 7.4 背包满（D）尚未真机验证

0.15.2 已加回原生 `Inventory:CanAcceptCount` 预判（`inventory_full`），
但只在 UNIT（pickup-L15）里验证过；真机"塞满背包再捡"**未执行**。

## 8. 信任边界（继承）

- 能写 `Cluster_N/<分片>/save/whale_lease.json` 的人就能改控制权（文件系统权限范畴）；
- 模组沙箱 `GLOBAL.io == nil`，Lua 只走持久化字符串通道读权威租约；
- MCP 身份是**服务实例级**，不是连接级。

## 9. 没做的事（按任务书要求）

不开放：砍树、挖矿、采集作物、制作、建造、开容器、用物品、战斗、逃跑策略、宏动作、自主生存循环。
没有新增 Node 服务、没有第二套状态文件/GameActions/实体引用。
