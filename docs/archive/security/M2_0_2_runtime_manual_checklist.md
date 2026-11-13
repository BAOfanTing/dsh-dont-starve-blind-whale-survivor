# M2.0.2 · 真机手动验证清单

> 2026-11-13 更新：MCP 服务已用产品 `apply()` 在 18090 启动；第二/三轮真机验证结果见
> `docs/M2_0_2_runtime_probe_round2.md` 与 `docs/M2_0_2_runtime_probe_round3.md`。
>
> 前提：**重进世界**（改过 Lua 才会进内存）。用**独立测试世界**，不要用重要存档。
> 本轮没有替你执行任何会改变世界状态的动作；下面每一步都需要你确认后再做。
> 检查清单：`docs/M2_0_2_known_limitations.md` 里的限制也一起看。

---

## 0. 准备（只读）

```powershell
# 1) 版本（源码 / 已装都应是 0.14.1）
Select-String 'DontStarveWhaleSurvivor\modinfo.lua' -Pattern '^version'
Select-String "E:\SteamLibrary\steamapps\common\Don't Starve Together\mods\DontStarveWhaleSurvivor\modinfo.lua" -Pattern '^version'

# 2) 进世界后，状态文件里的 mod 字段应变成 0.14.1
node tools/m14-watch.mjs --seconds 10
```

**权威租约文件位置**（Node 写、Lua 读）：
- 主文件：仓库 `.runtime/m2-control.json`
- 游戏侧副本：`<存档分片目录>/whale_lease.json`、`whale_io_lease.json`，以及 `<游戏目录>/bin64/whale_io_lease.json`
- Lua 确认：同目录 `whale_lease_ack.json` / `whale_io_lease_ack.json`

> 插件未启动时这些文件可能不存在 → **Lua 会拒绝所有动作**（fail-closed），这是设计。

---

## 1. 确认 F8 与 MCP 共用同一份权威租约（只读 + 一次小动作）

1. 启动 DSH 插件（MCP 服务在 `127.0.0.1:18090`）。
2. 用 MCP 调一次 `get_state`（只读，不看租约也能用）。
3. 让 F8 按一下开、再按一下关（触发 `control.acquire`）。
4. 看 `.runtime/m2-control.json`：应有 `schema=bws.control-lease/1`、`status`、`generation`、`owner_type`、`owner_instance_id`、`authority_epoch`、`lease_id`、`runtime_id/session_id/shard_id/actor_id`、`expires_at`。
5. 对照游戏目录里的 `whale_io_lease.json`：**内容应与主文件一致**（这是 Lua 真正读的那份）。

---

## 2. 场景 A：F8 → MCP 换手（**会移动角色，确认后做**）

1. 按 **F8** 让内置 AI 开始（记下当前 `generation`，例如 12）。
2. 让 AI 执行一次 `move_to` 到旁边 3 格：预期 `成功`；`whale_cmd.json` 里应带
   `owner_type / owner_instance_id / authority_epoch / lease_id / lease_generation=12 / runtime_id / session_id / shard_id / actor_id / expires_at`。
3. **换手**：从 MCP/DSH 侧请求一次 `stop`，触发 `acquire('mcp_client')`。
4. 预期（缺一不可）：
   - 权威租约先变成 `status="revoking"`、`generation=13`、`previous_owner_type="f8_agent"`。
   - 游戏侧 `whale_lease_ack.json` 出现（Lua 停掉旧动作后写的确认），含相同 `authority_epoch / generation / runtime_id`。
   - 确认后才变 `status="active"`、`owner_type="mcp_client"`。
   - 若一直没出确认文件：租约保持 `revoking`，**所有动作被拒**（不要手动改文件强行放行）。
5. 此时再用 F8 发任何动作：预期 `失败：没有有效控制权：wrong_owner（control_denied）`，且 `whale_cmd.json` 不新增。

---

## 3. 场景 B：MCP → F8 换手

1. 在 MCP 持有 `active` 时按 **F8**。
2. 预期：F8 的 `acquire` 发布 `revoking`（generation+1），等 Lua 确认后才 active；期间 MCP 的动作被拒。
3. 确认后 MCP 再发动作：预期 `control_denied`。

---

## 4. 场景 C：旧命令在换手之后到达（**关键**）

1. 让 F8 生成一条 `move_to` 命令，但在发出前**先复制** `whale_cmd.json` 到别处（或用 F8 暂停世界让 Lua 慢一点读）。
2. 完成 F8→MCP 换手（generation 13）。
3. 把那条旧命令写回 `whale_cmd.json`。
4. 预期：`whale_result.json` 里 `ok=false`、`reason=stale_generation`（或 `authority_revoking`），**角色不动**。
5. 如果 Lua 还没读到 revoking/新租约就执行了旧命令：立刻停手，把结果发我（这是必须修的窗口）。

---

## 5. 场景 D：租约过期

1. 让 F8 或 MCP 拿到租约后，停止插件/不发动作 **超过 30 秒**。
2. 再发动作：预期 `lease_expired`（Lua）/ `control_denied`（Node）。
3. 重新获取：预期 `generation` 递增、`lease_id` 变化、**新 epoch 不变**（除非文件丢失）。

---

## 6. 场景 E：游戏重启

1. 记下当前 `authority_epoch` / `generation` / `runtime_id`。
2. 退出世界 → 重新进（Lua 重载，runtime_id 变）。
3. 拿重启前的旧命令写回 `whale_cmd.json`。
4. 预期：`runtime_mismatch`（或 `authority_epoch_mismatch`），角色不动。
5. 新世界重新获取租约后，检查 `runtime_id` 已更新。

---

## 7. 场景 F：权威文件缺失 / 损坏 / MCP 未启动

| 操作 | 预期 |
|---|---|
| 临时把 `whale_io_lease.json` 改名为 `.bak`（两个文件都移走） | 所有动作 `authority_unavailable`，角色不动 |
| 往文件里写半截 JSON | `authority_corrupt` |
| 关掉 DSH 插件（MCP 服务不启动） | 不再更新权威文件；过期后 Lua 拒所有动作（fail-closed） |
| 把主文件 `m2-control.json` 删掉后让插件重新获取 | 新 `authority_epoch`；旧 epoch 的命令全部失效 |

> 做完请把文件改回来（或重启插件重新发布租约）。

---

## 8. 把结果发我

```powershell
# 权威状态
Get-Content .runtime\m2-control.json
Get-Content "C:\Users\BAOfanTing\OneDrive\文档\Klei\DoNotStarveTogether\893016408\Cluster_1\Master\save\whale_io_lease.json"

# 命令 / 结果 / 确认
Get-Content "C:\Users\BAOfanTing\OneDrive\文档\Klei\DoNotStarveTogether\893016408\Cluster_1\Master\save\whale_cmd.json"
Get-Content "C:\Users\BAOfanTing\OneDrive\文档\Klei\DoNotStarveTogether\893016408\Cluster_1\Master\save\whale_result.json"
Get-Content "C:\Users\BAOfanTing\OneDrive\文档\Klei\DoNotStarveTogether\893016408\Cluster_1\Master\save\whale_io_lease_ack.json" -ErrorAction SilentlyContinue

# 文件桥是否还活着
node tools/m14-watch.mjs --seconds 10
```

重点请贴：**场景 A/B 的换手前后 `generation`/`status`/ack**、**场景 C 的 `reason`**、以及有没有任何一次"角色不该动却动了"。

---

## 9. 安全提示

- 不要连续发命令；每一步等 `whale_result.json` 出来。
- 不要按 F8 跑完整自主循环；只做单个动作验证。
- 不要手动编辑权威租约文件去"放行"（会破坏 fail-closed 的意义）。
- 若任一步出现"旧命令被执行"，立即停止并把文件发我。
