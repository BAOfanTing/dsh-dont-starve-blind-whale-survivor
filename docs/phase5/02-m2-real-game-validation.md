# Phase 5 M2 · 真实游戏内移动验证报告

> 这次是**真机验证**：游戏世界实际运行、新版 mod 已加载、`move_to` 真的让角色移动了。
> 并在此过程中发现并修复了一个真实 bug（动作命令未绑定 shard，caves 取走导致 no_player）。

## 0. 环境与部署（实际执行）

诊断阶段发现：6 个 `dontstarve_dedicated_server` 进程全是**僵尸**
（CPU=0、内存 0-1MB、无 10998/10999 监听、无日志、父进程已退出），
Bridge 里的数据是旧快照。经用户确认后执行：

1. **备份 + 重装 mod**：旧版备份到 `E:\Temp\bws-mod-backup-124114`；
   新版 `DontStarveWhaleSurvivor` 同步到
   `E:\SteamLibrary\steamapps\common\Don't Starve Together\mods\DontStarveWhaleSurvivor`，
   `bws_config.lua`（含 token）保留。
   校验：`action_executor.lua` 新装、`commands.lua`/`modmain.lua` 与仓库 MD5 一致。
2. **替换 Bridge**：停掉旧版 PID 41248，从新仓库绝对路径启动 M2 新版
   （`control/status` HTTP 200）。
3. **用户在 DSH 界面重启世界**（我不手工拼含 `-token` 的集群启动参数）。

重启后会话：
```
session=415D5404A43C3FE2-master-1794458939 shard=master
alive=True stale=False age=164ms 心跳距 2254ms
玩家=WX-78(wx78) hp=100% hunger=97.3% 第1天 day autumn
位置=(79,12) x=318 z=50  附近实体 31 个
```

## 1. 冒烟：证明新版 mod 真的加载了

```
POST /api/v1/commands/enqueue  { type:"get_movement_status" }
→ SUCCEEDED
  result={"ok":true,"moving":false,"counts":{"started":0,"denied":0,"failed":0,"accepted":0}}
```

这正是 M2 新增的 `action_executor.movementStatus()` 的输出 —— 旧版 mod 只会返回
`unsupported_command`。**命令通道 + 新版 Lua 模块在真实游戏里打通了**。

## 2. 真实移动（第一组：2 格）

```
起点: tile(79,12) x=318 z=50   WX-78 满状态
控制权: acquire ok=true holder=M2_LIVE_C1 → Bridge holder=M2_LIVE_C1
入队 move_to(x=81,z=12,timeout=30) → HTTP 200 cmd_mwd2pl1q_o
回执 SUCCEEDED {"accepted":true,"running":true,"action":"move_to","job":"move_to"}
```

t+2s 时坐标还没变（我一度以为失败），但随后 `get_movement_status` 的真实回执：

```json
{
  "ok": true,
  "last_move": { "action":"move_to", "target":{"x":81,"z":12},
                 "command_id":"cmd_mwd2pl1q_o", "started_at":1794459259 },
  "player_pos": { "x":326.0246, "z":50 },
  "counts": { "started":1, "accepted":1, "denied":0, "failed":0 },
  "moving": false
}
```

`Bridge /api/v1/state` 同步显示 `位置=(81,12) x=326.02 z=50`。
x 从 318 → 326.02（+8 世界单位 = 2 格，DST `U.TILE=4`），`moving=false` 表示已到达。

## 3. 真实移动（第二组：4 格，逐秒跟踪）

```
起点 (81,12) x=326.02
  t+2s  (81,12) x=326.02   cmd=SUCCEEDED
  t+4s  (83,12) x=334.42   ← 角色正在走
  t+6s  (85,12) x=342.00   ← 到达目标
```

`movementStatus` 终态：
```json
{"ok":true,"last_move":{"action":"move_to","target":{"x":85,"z":12},
 "command_id":"cmd_mwd2r397_q","started_at":1794459329},
 "player_pos":{"x":341.9981,"z":49.9997},
 "counts":{"started":2,"accepted":2,"denied":0,"failed":0},"moving":false}
```

**结论：任务书「所有 API 必须通过当前游戏构建版本实际验证」这一条，对移动动作已补上。**
`locomotor:GoToPoint` 在当前构建生效，到达判定（`tile_away <= 1.2`）正确，
`Whale.actions.Tick()` 由 `bridge.lua` 的 0.2s `server_tick` 正常驱动。

## 4. 跨层安全（真实游戏 + 真实 Bridge）

| 场景 | 实际结果 |
|---|---|
| 无控制权入队 `move_to` | `403 CONTROL_NOT_HELD: 没有控制器持有写权限` |
| Lua 二次校验 C1 / OTHER / 只读 | `allowed=true` / `CONTROL_NOT_HELD` / `allowed=true` |
| 紧急停止后入队 | `403 EMERGENCY_STOP: 紧急停止中，所有动作被拒` |
| Controller → Bridge 同步 | `sync_count=4 last_error=null`，holder/lease 一致 |
| 真实 Bridge 重启后状态恢复 | 从落盘恢复（临时端口联调已验证） |

## 5. 真实发现并修复的 bug：动作命令没绑定 shard

**现象**：`stop_movement` 回执
```
FAILED  err=player_not_ready: no_player
session=40E41CA5D4EB88A7-caves-1794458940
```

**根因**：动作命令入队时 `shard=null`，`CommandQueue.poll` 的过滤是
`command.shard === null || command.shard === shard` —— 于是 **caves 分片也把动作取走了**，
而 caves 上没有主玩家，`Whale.util.player()` 返回 nil → `player_not_ready: no_player`。
（前面的 `move_to` 恰好被 master 取走，所以成功，掩盖了这个问题。）

**修复**（`game-bridge/src/routes.ts`）：动作命令入队时若未指定 shard，强制 `shard='master'`。
加了回归测试 `M2 回归：动作命令自动绑定 master 分片`：
模拟 caves poll 取不到 `move_to`、master poll 取得到。

## 6. 未完成 / 失败原因（如实）

1. **`stop_movement` 的真实游戏回执没拿到成功结果** —— 修复 shard 绑定后我重启了 Bridge，
   但游戏心跳随后断了（`connected=False`），两条命令停在 QUEUED。
   shard 修复本身已由单元测试验证，但**修复后的 stop 在真实游戏里没跑成**。
   不再反复重启打断用户环境，留到下次会话恢复后补测。
2. **动作最终成败回执链路仍不完整**（M2 报告 §6 第 4 条未解决）：
   现在启动成功立即回 `SUCCEEDED(accepted:true, running:true)`，真正的 done/fail 由
   `Whale.actions.Tick()` 经**文件桥**上报，没接回 Phase 2 HTTP 命令通道。
   `get_movement_status` 能查进度，但 Bridge 命令记录不会自动从"运行中"变终态。
   M3 必须补，否则破坏 `NEEDS_RECONCILIATION` 语义。
3. **Bridge 重启会丢会话记账** —— 游戏端需要重新连上；本次重启后没有自动恢复。
   这是 Phase 2 既有行为，不在 M2 改动范围，但做真实联调时要注意。
4. **DST 脚本源码仍没拿到**（`data/databundles` 打包），无法静态核对 `locomotor` 签名；
   但已在真实游戏里跑通，等于用行为验证了 API 有效性。
5. **`move_to_target` 未实现**（留到 M3 采集时带出）。
6. **Controller HTTP 门面仍无认证**（M1 遗留，M3 前必须补）。
7. **控制权变更未联动取消 Bridge 队列里已入队命令**（M2 报告 §6 第 7 条未解决）。

## 7. 最终状态与测试

控制权已清回 `SUPERVISED / holder=null / emergency=false`，避免残留影响后续操作。
运行中的 Bridge 是带 shard 修复的新版（PID 36824）。

| 套件 | 用例 | 结果 |
|---|---|---|
| Lua/插件 | 119 | 全过 |
| Phase 1 Bridge | 22 | 全过 |
| Phase 2 Bridge | **53**（+1 shard 回归） | 全过 |
| Phase 3 MCP | 68 | 全过 |
| Phase 4 Agent | 110 | 全过 |
| survival | 48 | 全过 |
| **合计** | **420** | **全过** |

## 8. 验证脚本（会真实调用，需环境就绪）

```powershell
cd survival
# 冒烟：新版 mod 是否加载（只读）
# 真实跨层控制权（连 18788）
node test/real-bridge-m2.mjs
# 真实移动 2 格
node test/real-move.mjs
# 真实移动 4 格 + 越权 + stop + 紧急停止
node test/real-move2.mjs
```

这些脚本会**真的移动角色**，只在需要真机验证时手工运行，不进自动测试套件。
