# M2.0 · 真机手动验证清单（给你照着做）

> 目的：用真实游戏验证「统一动作执行 + 控制权租约 + Lua 最终校验」这一套。
> 前提：本阶段只开放 **R1** 动作（`move_to`、`stop`），不会采集/战斗/建造。
> 安全：**用独立测试世界**，不要用重要存档；不要按 F8（避免整段自主循环）。
> 我这边没有替你执行任何会改变世界状态的动作。

---

## 0. 准备

| 项 | 检查 |
|---|---|
| 版本 | 源码与已装都应是 **0.14.0**（`mods/DontStarveWhaleSurvivor/modinfo.lua`） |
| 游戏 | build 762172；**客户端与服务器端模组都重新加载过**（改过 Lua，必须重进世界） |
| 世界 | 独立测试世界；洞穴可关；先站到空旷处（避免一移动就被怪追） |
| MCP（可选） | 需要验 MCP 侧时，确认 `http://127.0.0.1:18090/status` 有响应 |
| 命令 | 全部是只读采样或"只动一小步"的动作；不要连续发命令 |

---

## 1. 确认加载的是 0.14.0（只读）

```powershell
node tools/m14-watch.mjs --seconds 10
```

看 `.md` 里的 `schema/textSource/status`，以及 `tests/artifacts/M1_4/*.json` 里 `data.mod`。
状态文件 `whale_state.json` 的 `mod` 字段应变成 `0.14.0`（否则说明世界没重载）。

---

## 2. 验 Actor 与租约（只读 + 一次小移动）

1. 游戏里按 **F8 一下再按一下**（开→关）。目的是让插件走一次 `control.acquire('f8_agent')`；
   预期：小窗提示正常，`.runtime/m2-control.json` 出现 `{"owner":"f8_agent","generation":1,…}`。
2. 在 DSH 里让 AI 调一次 `get_state`：应正常返回（只读不受租约影响）。

---

## 3. 验一条真实动作（**会真的移动角色**，请确认后再做）

在 DSH 会话里说：

> 用 move_to 走到你右边 3 格的位置

预期（缺一不可）：

| 预期 | 怎么看 |
|---|---|
| 命令带信封 | `whale_cmd.json` 里出现 `protocol_version/command_id/lease_generation/runtime_id/session_id/shard_id/actor_id/expires_at` |
| 角色真的走了 | `get_state` 里 `位置` 变了（`move_to` 核对通过才报成功） |
| 结果是 `succeeded` | 工具返回里没有"失败/未知/没核对上" |
| 没有重复执行 | 日志里同一条 `command_id` 只执行一次 |

然后说：

> stop

预期：立刻停手；结果成功。

---

## 4. 验拒绝路径（这些都应该**被拒**，且角色不动）

| 说法 | 预期返回 |
|---|---|
| 砍旁边那棵树 | `失败：M2.0 还没开放这个动作（只开放：move_to、stop）（action_not_allowed）` |
| move_to 走到 (99999, 0) | `失败：参数不合法：out_of_range:x（…）` |
| move_to 参数里塞个 `fly:true` | `失败：参数不合法：unknown_arg:fly` |

> 关键：**这三条一条命令都不该出现在 `whale_cmd.json` 里**（可以对着文件时间戳看）。

---

## 5. 验 F8 与 MCP 互斥（可选，需要 MCP 在跑）

1. 按 F8 让内置 AI 开始（它会持有租约）。
2. 在 DSH 里让 AI 调 `move_to`。
3. 预期：返回 **控制权冲突**（`control_denied`，附当前持有者），`whale_cmd.json` 不新增。
4. 按 F7（人工接管）：预期租约换代到 `manual_test`，F8 立刻停手。
5. 再让 DSH 调 `move_to`：现在应归 `manual_test` 持有——**此时 DSH 仍会被拒**（它不是 `manual_test`）。
   如果想让 DSH 拿回控制权：等 30 秒租约过期，或重启插件。

---

## 6. 验游戏重启安全性（可选）

1. 拿到一次 `move_to` 的命令 JSON（`whale_cmd.json` 复制一份到别处）。
2. 退出世界 → 重新进。
3. 把那份旧命令写回 `whale_cmd.json`（或让 Node 重发旧信封）。
4. 预期：Lua 拒绝 `runtime_mismatch`（`runtime_id` 变了），角色不动。

---

## 7. 把结果发我

把下面三样贴回来即可：

```powershell
# 1) 最近一帧状态（含 mod 版本）
Get-Content "$env:USERPROFILE\OneDrive\文档\Klei\DoNotStarveTogether\893016408\Cluster_1\Master\save\whale_state.json" | Select-Object -Last 1

# 2) 最后一次命令/结果
Get-Content "$env:USERPROFILE\OneDrive\文档\Klei\DoNotStarveTogether\893016408\Cluster_1\Master\save\whale_cmd.json" -ErrorAction SilentlyContinue
Get-Content "$env:USERPROFILE\OneDrive\文档\Klei\DoNotStarveTogether\893016408\Cluster_1\Master\save\whale_result.json" -ErrorAction SilentlyContinue

# 3) 租约文件
Get-Content .runtime\m2-control.json -ErrorAction SilentlyContinue
```

---

## 8. 已知会看到的现象（不是 bug）

1. **F8 与 DSH 不能同时操作**：这是设计。后到者会拿到 `control_denied`。
2. **`manual_test`（F7）会占着控制权 30 秒**：等它过期，或者重启插件。
3. **只开放两个动作**：其它动作的返回就是"还没开放"，不是坏了。
4. **改过 Lua 必须重进世界**：内存里的旧脚本不会自己更新。
