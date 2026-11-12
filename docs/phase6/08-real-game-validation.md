# Phase 6 · 真机验证（脚本已备好，**本轮未执行**）

> **如实声明**：本轮开发期间 DST 进程没有运行
> （`/api/v1/bridge/status` → `connected=false`，`last_heartbeat_ago_ms≈2376298`，
> 没有 `dontstarve_steam` 进程）。所以 Phase 6 的**真机验证没有做**，
> 只有沙箱（fengari 真 Lua）+ 逻辑单测 + 契约测试。
>
> 下面写清：怎么验、验什么、预期看到什么、以及哪些结论现在**还不能**下。

## 1. 验证前的准备（已完成的自动化部分）

| 步骤 | 状态 |
|---|---|
| 新模组文件已装进游戏 `mods/DontStarveWhaleSurvivor`（v0.10.0） | ✅ `node tools/install-mod.mjs` 输出 `installedVersion: 0.10.0` |
| `scripts/main/threat_observer.lua` / `combat_executor.lua` 已在 `mods` 目录里 | ✅ 已列目录确认 |
| Bridge / MCP Server / Agent 三个进程在跑（18788 / 8790 / 8791） | ✅ |
| 验证脚本 `survival/test/p6-combat.mjs` | ✅ 已写好（只读 + 可选真实战斗） |

## 2. 跑之前必须做的事

1. **打开《饥荒联机版》，读档进入世界**（模组要在模组列表里启用）。
2. **关掉暂停菜单 / 地图**。Phase 5 的结论：DST 暂停时引擎不触发 `DoPeriodicTask`，
   所有 Lua 周期任务（观察器、命令轮询）都会停 → Bridge 判超时 → 什么都下发不下去。
3. **先让世界跑十几秒**，等观察器把 `threats` / `environment` 段推上来。

## 3. 只读验证（不需要授权，建议先跑）

```powershell
cd E:\Cache\XinLuguWuyu\dsh-dont-starve-blind-whale-survivor
node survival/test/p6-combat.mjs
```

它依次检查：

| 步骤 | 检查内容 | 预期 |
|---|---|---|
| ① | 等游戏连上 | `session=… 玩家=… 位置=(x,z)` |
| ② | 快照里有 `threats` 段 | `✅ 快照里有 threats 段`；并打印 `敌对 N 个，追击 d，出手 a，Boss b` |
| ② | 最近敌人的字段是真实数字 | `✅ 敌人距离是真实数字`、`✅ 敌人是否追击玩家有字段` |
| ② | 快照里有 `environment` 段 | `✅`；打印季节/剩余天数/夜/有光/体温 |
| ③ | `get_combat_status` 能执行 | `state=IDLE`、`API:{...}` |
| ③ | 战斗 API 探测 | `✅ 玩家 combat 组件可读`、`✅ locomotor:GoToPoint 可用`、`✅ 至少有原生攻击路径` |
| ④ | `probe_combat_api` 逐项 | 打印 `try_attack / can_attack / get_attack_range / actions_attack / buffered_action / locomotor_goto` |

**这一步能回答的关键问题**（现在还是未知）：

- 本机构建上 `combat:TryAttack` 到底在不在？
- `ent.sg:HasStateTag("attack")` 在敌人身上是否可用（决定 "dodge" 能否触发）？
- `ent.Light:IsEnabled()` 能否用来判断光照（决定"黑暗"危险是否可靠）？
- `TheWorld.state.remainingdaysinseason` 有没有值（决定季节预测是不是 `verified`）？

## 4. 真实战斗验证（会真的打怪，需要人授权）

```powershell
node survival/test/p6-combat.mjs --combat                 # 打最近的合法白名单敌人
node survival/test/p6-combat.mjs --combat --target hound   # 指定猎犬
```

脚本会：
1. `POST /api/v1/control/sync` 拿 120 秒 SUPERVISED 控制权；
2. 下发 `start_combat{confirmed:true, radius:12}`；
3. 每 1.5 秒查一次 `get_combat_status`，打印 `状态 / 命中数 / 距离 / 生命`；
4. 不管结果如何都 `abort_combat` + 清控制权。

**预期（成功的样子）**：

```
下发 start_combat：已接受
  result={"accepted":true,"action":"start_combat","combat_state":"ASSESSING","target":"hound",...}
  t+1.5s 状态=ENGAGING 命中=1 距离=1.8 生命=100%
  t+3.0s 状态=ENGAGING 命中=3 距离=2.1 生命=92%
  ...
收尾：abort_combat 已停止
```

**验收点**：

| 项 | 预期 |
|---|---|
| 真的进入战斗 | 状态从 `ASSESSING → PREPARING → ENGAGING` |
| 真的有攻击 | `hits` 增长；敌人血量下降（`target_hp`） |
| 真的会风筝 | `dodges` 增长，`target_distance` 在 1.5~3 格之间来回 |
| 装备监控 | `equipment.{hands,body,head}` 有内容；受伤时 `min_hp` 下降 |
| 能中止 | `abort_combat` 后状态 `ABORTED`，角色停下 |
| 能自动撤退 | 打到生命 <30% 时自己进 `RETREATING`（可以用低血量角色试） |

**不能下的结论（在没有真机结果之前）**：

- ❌ 不能说"Kiting 在真机上有效"；
- ❌ 不能说"0.55 秒 backoff 是最优"；
- ❌ 不能说"技能取消/打断的处理和手玩一致"。

## 5. 若真机失败，最可能的三个原因（排查优先级）

1. **`combat:TryAttack` 在服务端受限**（返回 false 或抛错）：
   → 看 `get_combat_status` 的 `last_attack_error`；备选路径是 `BufferedAction(ATTACK)`，
   若两条都不行，`start_combat` 会直接 `attack_api_unavailable` 失败（不会硬来）。
2. **`sg:HasStateTag("attack")` 在敌人身上不可用**：
   → 表现为 `dodges` 一直是 0、挨打次数变多；不影响能否打死，但 Kiting 退化成"贴脸互殴"。
3. **观察器 tick 被游戏暂停/卡住**：
   → `get_combat_status` 一直拿不到 → 先确认游戏没暂停（Phase 5 的老坑）。

## 6. 附：本轮能做的等价替代验证（已做）

| 项目 | 替代手段 | 结果 |
|---|---|---|
| Lua 模块能在真 Lua 里跑 | fengari 加载真文件 + 假游戏对象 | ✅ 12 个用例 |
| 战斗状态机迁移 | 两侧单元测试 | ✅ |
| 白名单/Boss/确认/单执行者 | 沙箱 + Node 层双测 | ✅ |
| 数据链路（快照 → 决策） | 用**真实游戏的历史快照结构**造夹具 | ✅ |
| 模组版本/文件安装 | `install-mod.mjs` + 列目录 | ✅ |

**这些都不能替代真机验证**，只是把真机失败的概率压低。
