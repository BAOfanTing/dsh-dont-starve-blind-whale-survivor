# Phase 2 · M5：连接恢复 + 命令幂等

> 结论：**Bridge 重启/断线后，游戏端自动接上，sequence 与 ack 记账不丢、幂等不破、旧命令不重放。**
> 真实演练三项全过：断线 40 秒恢复、会话丢失判 unknown_completion、命令 TTL 过期。
> 关键实测：**连续两次重启 Bridge 后，ack 从 116 一路涨到 221，`duplicates` 仍然是 0。**

## 1. 新增/修改

| 文件 | 内容 |
|---|---|
| `game-bridge/src/persist.ts` | 新增：状态落盘/读取（原子写 tmp→rename、带 `version`、坏文件不炸） |
| `game-bridge/src/session.ts` | 新增 `export()` / `restore()`；恢复时把 `lastHeartbeatAt` 重置为 now，并新增 `restored` / `reconnects` 计数 |
| `game-bridge/src/commands.ts` | 新增 `export()` / `restore()`（含 id 计数器续接）；新增 `normalizeResult()` |
| `game-bridge/src/config.ts` | 新增 `stateFile`（默认 `.runtime/bridge-state.json`）、`saveIntervalMs`（默认 5s） |
| `game-bridge/src/index.ts` | 启动时恢复 → 定时落盘（5s，unref）+ 退出时落盘；版本 0.2.0-m5 |
| `game-bridge/src/routes.ts` | status 的 sessions 输出补 `restored` / `reconnects` |
| `DontStarveWhaleSurvivor/scripts/main/entity_observer.lua` | 顺带修正：带 `inventoryitem` 的实体不再判成生物（南瓜灯误判） |
| `tests/phase2-m5.test.mjs`、`game-bridge/test/m5.test.ts` | 新增 3 + 8 个用例 |

## 2. 三个关键设计决策

### ① 为什么恢复时把 `lastHeartbeatAt` 设成 now

Bridge 刚起来时，落盘里的心跳时间当然是"过去"的。如果按原值判定，恢复出来的会话**立刻算超时**，
它手上 `DELIVERED` 的命令会马上被判 `unknown_completion` —— 而游戏其实活得好好的，只是还没发出一次心跳。

所以恢复时乐观地把心跳时间设为 now，给游戏端一个 10 秒的窗口：
- 游戏端在窗口内回来了 → 记一次 `reconnects`，sequence 从原处继续；
- 真的没回来 → 10 秒后自然超时，那时再 reap 才是对的。

### ② 为什么 `DELIVERED` 的命令不自动重放

任务书要求"对于游戏进程重启，需要明确处理未知完成状态，不能盲目重新执行旧命令"。
所以恢复后保持原状态，等轮询侧按"会话是否还活着"决定：

```lua
-- 恢复后 3 秒内游戏回来 → 这条命令会被**同一条 id** 重投（游戏端按 id 去重，不会执行两次）
-- 游戏一直不回来 → 会话心跳超时 → reapSession() → FAILED + unknown_completion + note=session_lost
```

万一只是回执丢了、命令其实执行完了 → 迟到的回执仍然接受，标 `late: true` 并修正状态。

### ③ 为什么 sequence 记账必须落盘

如果 Bridge 重启后 `acknowledgedSequence` 归零，游戏端继续用旧 sequence 推数据时会被当成"新数据"，
**幂等就破了，同一份状态会被重复入库**。所以 sequence 记账跟会话一起落盘，重启后 `sequence <= ack` 仍判 duplicate。

## 3. 真实演练（都在本机实际跑，不是模拟）

### 演练 A：Bridge 断线 40 秒

```
杀掉 Bridge（PID 43540），等 40 秒（游戏一直在跑）
重启日志：INFO 已恢复上次的状态 {"sessions":2,"commands":0,"queued_commands":0,"saved_at":1794410466792}
断线前 ack = 116  →  恢复后 ack = 119（继续涨，不是从 0 重来）
跳号 gaps = 2（断线期间游戏端丢掉的采样，如实记录）
重复 duplicates = 0
```

### 演练 B：会话丢失 → 命令判 unknown_completion（不重放）

```
1) 入队 get_state 并投递给 ghost-session-master-1 → get_state/DELIVERED
2) 让该会话心跳超时（等 12 秒 > 10 秒阈值）
3) 新会话 fresh-session-master-1 轮询 → 拿到 null（**旧命令没有被重放** ✅）
4) 旧命令状态：FAILED / error=unknown_completion / note=session_lost ✅
```

### 演练 C：命令没人取 → TTL 到期

```
1) 入队 ping，shard=nobody-polls-this-shard（没有会话会去取）
2) 等 65 秒
3) 状态：EXPIRED / error=expired ✅
```

### 演练 D：连续两次重启后幂等完好

```
INFO 已恢复上次的状态 {"sessions":4,"commands":2,"queued_commands":0}
会话 26FA…-master-1794410203  心跳 72  ack=221  重复=0  跳号=3  重连=2  分片=master
会话 5664…-caves-1794410205   心跳 73  ack=218  重复=0  跳号=3  重连=2  分片=caves
```

`重连=2` 对应两次重启；**ack 一路涨到 221 而 duplicates 仍是 0** —— 这就是 M5 要证明的东西。

## 4. 顺带修的一个数据准确性问题

演练日志里发现新世界把「南瓜灯」归成了 `creature`。查游戏源码：

```
scripts/prefabs/pumpkin_lantern.lua:201  inst:AddTag("veggie")
scripts/prefabs/pumpkin_lantern.lua:202  inst:AddTag("light")
脚本组件：inspectable / inventoryitem / combat / health / lootdropper / perishable
```

它**有 `combat` + `health`，但没有 `structure` 标签**，所以旧规则（combat+health 且非 structure → 生物）误判。
修正：**带 `inventoryitem` 的实体一律不算生物**（可放置/可捡起的都是物品），归到 `item`。
已加回归用例（南瓜灯 → `item`，真怪物仍 `hostile`）。模组版本 0.9.1。

## 5. 已知限制

1. **状态文件含玩家快照**（`latest` 字段），明文放在 `.runtime/bridge-state.json`（已 gitignore）。
   本机工具场景可接受；若要分发需要脱敏或加密。
2. **不做多 Bridge 并发**：两个 Bridge 同时跑会互相覆盖同一个状态文件（当前假设单实例）。
3. **reap 只看心跳**：会话心跳超时即认为它的未回执命令状态未知。极端情况下（网络抖动但游戏还在执行）会误判，
   由"迟到回执"机制兜底修正。
4. **命令队列上限 100 / TTL 60s** 是写死的默认值（构造参数可调，但没有对外配置项）。

## 6. 测试

| 套件 | 用例数 | 本轮新增 |
|---|---|---|
| game-bridge（M1+M3+M4+M5） | 36 | 8（落盘/恢复/幂等/归一化/id 续接） |
| Lua / 插件侧 | 108 | 3（M5 不变量）+ 1（南瓜灯分类） |
| Phase 1 Bridge | 22 | 0 |
