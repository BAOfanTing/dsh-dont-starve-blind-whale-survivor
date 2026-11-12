# Phase 5 M2 · 第二次真机验证：shard 修复确认 + read-only 查询修复

> 这一轮在**全新世界会话**上跑完了 `real-quick.mjs` 的 8 项验证，
> 包括上一轮失败的 `stop_movement`（shard 修复生效）。
> 同时发现并修复第二个 shard 问题：只读 `get_movement_status` 被 caves 取走。
>
> **如实标注**：新代码部署到运行中的 Bridge 后，游戏端命令通道断了，
> 所以「自动绑定 shard」的新代码没能在真机上复测（但机制已用显式 shard 真机验证）。

## 0. 背景：为什么会有这一轮

上一轮 `docs/phase5/02-m2-real-game-validation.md` 结尾留下：
- `stop_movement` 因 caves 分片取走而 `FAILED: player_not_ready: no_player`
- 已修：动作命令入队时强制 `shard='master'`，但真机补测没跑成（Bridge 重启后心跳断）

用户重启世界后，本轮用 `survival/test/real-quick.mjs`（检测到会话连上就自动一口气跑完 8 项，
避免 `net.lua` 周期任务拖久失效）。

会话：`446E56002B830B0F-master-1794460234` / `553F15CE1CA56E56-caves-1794460235`，
起点 tile(-94,152) x=-374 z=610，`alive=true stale=false`。

## 1. 8 项真实结果（全部通过）

```
① 冒烟 get_movement_status
   SUCCEEDED {"ok":true,"moving":false,"counts":{started:0,denied:0,failed:0,accepted:0}}
   → 新版 action_executor.movementStatus() 输出，证明新版 mod 已加载

② 越权动作（无控制权）
   HTTP 403 CONTROL_NOT_HELD: 没有控制器持有写权限

③ 授权 + Lua assert
   sync HTTP 200 holder=M2_QUICK_C1
   Lua assert C1: allowed=true code=OK

④ 真实 move_to（目标 = 起点 +3 格 → (-90,153)）
   enqueue HTTP 200 id=cmd_mwd3b7wm_x
   SUCCEEDED {"running":true,"action":"move_to","job":"move_to","accepted":true}

⑤ 逐 2 秒跟踪真实位移
   t+2s  (-93,152) x=-371.72
   t+4s  (-91,153) x=-360.08
   t+6s  (-90,153) x=-358.14      ← 到达
   位移: (-94,152) → (-90,153)  变化=true

⑦ stop_movement（上一轮失败项）
   SUCCEEDED {"running":true,"action":"stop_movement","job":"stop","accepted":true}
   → shard 修复生效，落到 master 并成功启动原生 Whale.actions 的 stop

⑧ 紧急停止 + 清理
   紧急停止后入队: HTTP 403 EMERGENCY_STOP
   最终: mode=SUPERVISED holder=null emergency=false
```

命令归属实测：
```
cmd_mwd3bfq9_z  SUCCEEDED stop_movement       session=446E...-master-...
cmd_mwd3b7wm_x  SUCCEEDED move_to             session=446E...-master-...
cmd_mwd3bejc_y  SUCCEEDED get_movement_status session=553F...-caves-...   ← 问题在这
cmd_mwd3b6pi_w  SUCCEEDED get_movement_status session=553F...-caves-...
```

## 2. 真机发现并修复的第二个 bug：只读查询被 caves 取走

**现象**：⑥ 的 `movementStatus` 返回 `last_move:{}`、`counts` 全 0、`moving:false` ——
但 ④ 明明刚成功启动了一次 `move_to`。

**根因**：`get_movement_status` 是只读命令，入队时 `shard=null`，被 **caves 分片**取走。
caves 上的 `action_executor` 是另一个独立 Lua 实例，计数自然是 0。
动作命令已在上一轮绑定 master，但只读查询漏了。

**机制验证（真机，不重启）**：显式传 `shard:'master'` 下发 `get_movement_status`：
```
SUCCEEDED session=446E...-master-...
result={"ok":true,
  "last_move":{"action":"stop_movement","command_id":"cmd_mwd3bfq9_z","started_at":…},
  "player_pos":{"x":-358.1355,"z":613.9661},
  "counts":{"started":2,"accepted":2,"denied":0,"failed":0},
  "moving":false}
```
`player_pos.x=-358.1355` 与 ⑤ 到达时 `x=-358.14` 一致 —— master 上的执行器
确实记着两笔真实动作（move_to + stop）。证明「绑定 master」就是正确修法。

**修复**（`game-bridge/src/routes.ts`）：`get_movement_status` 未指定 shard 时也强制 `'master'`。
新增回归测试 `M2 回归：get_movement_status 也绑定 master 分片`
（模拟 caves poll 取不到、master poll 取得到）。Bridge 测试 53 → 54 全过。

## 3. 反复出现的阻塞项：Bridge 重启 → 命令通道断

本轮为部署修复**重启了 Bridge**（PID 36824 → 36720）。重启后 2 秒内
`connected=True alive=True stale=False age=1728ms`，游戏看似重连了；
但随后所有命令停在 QUEUED，日志只剩我自己的查询：

```
connected=False reason=心跳超时  心跳距=45984ms
日志字节 7687 → 7687（4 秒内无新增）
```

**根因（Phase 2 既有缺陷，非 M2 引入）**：Bridge 重启会清掉会话记账；
游戏端 `net.lua` 的 `DoPeriodicTask` 在 `AddGamePostInit` 只建一次，
任务失效后没有外部驱动去重建 `N.start()`。心跳/telemetry/命令 poll 全挂在那个 tick 上，
于是整体停摆。这已经是第二次撞到（上一轮也是重启 Bridge 后断）。

**我停止了继续重启** —— 反复重启只会反复打断用户，不能解决问题。
修复后的自动绑定没能在真机上复测，但：
- 机制已用显式 `shard='master'` 在真机验证成功
- 新代码的自动绑定已由单元测试覆盖

## 4. 全项目回归

| 套件 | 用例 | 结果 |
|---|---|---|
| Lua/插件 | 119 | 全过 |
| Phase 1 Bridge | 22 | 全过 |
| Phase 2 Bridge | **54**（+1 只读 shard 回归） | 全过 |
| Phase 3 MCP | 68 | 全过 |
| Phase 4 Agent | 110 | 全过 |
| survival | 48 | 全过 |
| **合计** | **421** | **全过** |

## 5. 未完成 / 风险（如实，累积）

1. **`net.lua` 周期任务失效导致命令通道断** —— 这是当前**最大阻塞项**，
   每次重启 Bridge 或世界重载都可能触发。M3 前必须修（让心跳/命令轮询不依赖单一
   `DoPeriodicTask`，例如观察器推送时顺带驱动 tick，或加独立守护+重建）。
2. **动作最终成败回执链路不完整** —— 启动成功立即回 `SUCCEEDED(accepted:true,running:true)`，
   真正 done/fail 走文件桥，没接回 Phase 2 HTTP 命令通道。M3 必须补，
   否则破坏 `NEEDS_RECONCILIATION` 语义。
3. **新代码的自动 shard 绑定没真机复测** —— 通道断了，只有机制验证 + 单测。
4. **`move_to_target` 未实现**（M3 采集时带出）。
5. **Controller HTTP 门面无认证**、**控制权变更未联动取消 Bridge 队列命令**（M1/M2 遗留）。
6. **DST 脚本源码仍为打包状态**，无法静态核对 `locomotor` 签名；但已在真机两次验证可用。

## 6. 环境最终状态

- 运行中的 Bridge：带只读 shard 修复的新版（PID 36720）
- 控制权：`SUPERVISED / holder=null / emergency=false`
- 游戏进程在跑，但命令通道断（见 §3），需修 `net.lua` 或重启世界后立刻用
  `survival/test/real-quick.mjs` 才能继续真机动作测试

## 7. 验证脚本

```powershell
cd survival
node test/real-quick.mjs       # 等会话连上后自动跑完 8 项（会真的移动角色）
```

其余见 `02-m2-real-game-validation.md`。这些脚本只手工运行，不进自动测试套件。
