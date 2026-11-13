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

## 8. 信任边界（继承）

- 能写 `Cluster_N/<分片>/save/whale_lease.json` 的人就能改控制权（文件系统权限范畴）；
- 模组沙箱 `GLOBAL.io == nil`，Lua 只走持久化字符串通道读权威租约；
- MCP 身份是**服务实例级**，不是连接级。

## 9. 没做的事（按任务书要求）

不开放：砍树、挖矿、采集作物、制作、建造、开容器、用物品、战斗、逃跑策略、宏动作、自主生存循环。
没有新增 Node 服务、没有第二套状态文件/GameActions/实体引用。
