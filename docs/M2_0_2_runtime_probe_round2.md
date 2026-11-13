# M2.0.2 真机验证记录 · 第二轮（0.14.2 核心链路通过 + 发现 2 个健壮性问题）

> 时间：2026-11-13 14:03–14:10（Asia/Shanghai）
> 环境：用户重进世界后，真实 DST 客户端 PID 32652，`Cluster_2/Master`，**内存 mod=0.14.2**
> 授权：用户「游戏开了，测试吧」
> 探针：`tools/m2_0_2_runtime_probe.mjs`（只用 `stop`，不改世界状态；走产品 `GameBridge` + `LeaseManager`）

---

## 1. 重进后的环境

| 项 | 值 |
|---|---|
| 游戏进程 | PID 32652，14:01:14 启动 |
| 状态文件 | `Cluster_2/Master/save/whale_state.json` 年龄 0s，持续写盘 |
| **内存版本** | `mod=0.14.2` ✅（证明 0.14.2 的 ps 缓存通道已加载） |
| runtime_id | `r1794549722-5374`（新运行实例；上一轮是 `r1794548114-5689`） |
| session / shard / actor | `63E379F1B94C51A3` / `1` / `player:KU_dsu8_vGS` |
| 角色 | `valid=true, alive=true, isGhost=false`，坐标 `(-22, 32)`（已复活） |
| nearby | `status=ok, found=130, returned=36` |
| MCP 18090 | 未监听 → F8↔MCP 网络换手仍 BLOCKED |

---

## 2. 完整探针结果（改进后探针，清掉旧命令文件 + 开局清 ack + T8 等 6s）

| 步骤 | 期望 | **实测（0.14.2 真机）** |
|---|---|---|
| T1 无权威文件（旧格式命令） | 拒绝 | ✅ `authority_unavailable` |
| 发布 active 租约 gen=1 | 文件写全 | ✅ `authority_rebuilt`，6 份副本完整 |
| **T2 合法命令（active）** | **成功** | ✅ **`ok=true, text="停下了"`** ★ |
| T3 旧 generation | 拒绝 | ✅ `stale_generation` |
| T4 伪造 gen=999 | 拒绝 | ✅ `future_generation` |
| T5 错误 owner_instance_id | 拒绝 | ✅ `wrong_instance` |
| T6 换手 revoking 期间旧命令 | 拒绝 | ✅ `authority_revoking` |
| T7 换手后旧持有者命令 | 拒绝 | ✅ `authority_revoking`（保持 revoking，见 §4） |
| T8 删除权威文件 + 等 6s | 拒绝 | ✅ `authority_unavailable`（ps 缓存过期后 fail-closed） |
| 角色坐标 before/after | 不变 | ✅ `(-22,32)` → `(-22,32)` |

**结论：0.14.1 的通道缺陷已修好。真机上精确 generation / owner_instance / epoch / revoking / 缓存过期全部按预期工作，合法命令能执行，且从未误执行一次动作。**

---

## 3. 两阶段换手（真机）

```
[换手] acquire: handover_revoking gen=2 status=revoking
[换手] Lua 确认: {schema:"bws.control-lease-ack/1", generation:2,
                 authority_epoch:"1e974380-...", runtime_id:"r1794549722-5374",
                 job_cleared:true, acked_at:-2147483648}
[换手] completeHandover: handover_completed status=active   ← 第一轮探针
```

- ✅ Lua 确实通过 `ps_read` 观察到 `revoking`，调用既有 `A.Abort` 停旧动作，写出 `whale_lease_ack.json`（`job_cleared=true`）。
- ✅ Node 校验 `epoch + generation + runtime_id` 后才发布 `active`。
- ✅ T6 期间所有动作被拒。
- 另一轮里残留了**旧 epoch 的 ack**，Node 正确返回 `handover_ack_invalid` 并**保持 revoking**（T7 = `authority_revoking`）——证明"拿不到有效确认绝不自动放行"真机有效。

---

## 4. 本轮新发现的两个健壮性问题（已修为 0.14.3，待重进复验）

### 问题 1：`poll_command` 每 0.3s 重读同一个命令文件
- 第一轮 T2 得到 `duplicate_command`：Lua 不删 `whale_cmd.json`，0.3s 后把同一条命令又读了一遍。
- 0.14.3 恢复 `if id == last_cmd_id then return end` 单槽去重（M2.0 改成 guard 32 条去重时删掉了）。
- 探针也改进：每条命令写入前清掉两个通道的旧命令文件。

### 问题 2：ack 只按 `generation` 去重 + `acked_at` 32 位溢出
- `acked_at = -2147483648`：Lua `os.time() * 1000` 整数溢出（和 M1.4 `now_ms` 同源）→ 改 `* 1000.0`。
- 同一 Lua VM 里 `last_ack_generation == 2` 会阻止新 epoch 但同 generation 的确认写出 → 换手可能永远卡在 revoking（fail-closed 但功能不可用）。
- 0.14.3：去重键改 `authority_epoch + ":" + generation`，ack 带 `lease_id`；Node `completeHandover` 增加 `lease_id` 校验。
- 新增回归 `tests/m2_0_2_lease_ack.test.mjs`（3 例）：同键只确认一次 / 新 epoch 同 generation 必须写新确认 / 静态检查。

---

## 5. 版本与测试

| 项 | 值 |
|---|---|
| 磁盘已装（本轮开始） | 0.14.2 |
| 修复后已装 | **0.14.3**（19 文件，guard/bridge 就位） |
| 内存版本（当前） | **0.14.2**（这两个修复还没进内存） |
| 全量单测 | 384 → **387 / 387** |
| Lua→Node 管线 | 32 / 32 |
| 工作区 | 已提交干净 |

---

## 6. 验收状态（如实）

| 验收项 | 状态 |
|---|---|
| 真机只读取样 / 0.14.2 加载 | ✅ PASS |
| 真机合法命令执行（stop） | ✅ PASS |
| 真机精确 reason（stale/future/wrong_instance/revoking） | ✅ PASS |
| 真机 fail-closed（无文件 / 缓存过期） | ✅ PASS |
| 真机 C-1 时序（旧命令换手后到达） | ✅ PASS（T3/T6/T7 证明旧世代与 revoking 都被拒） |
| 真机 revoking → A.Abort → ack → active | ✅ PASS（第一轮；第二轮因残留 ack 保持 revoking，属正确 fail-closed） |
| 角色未被误操作 | ✅ 坐标不变 |
| F8→MCP / MCP→F8 **网络**换手 | **BLOCKED**（18090 未监听） |
| 0.14.3 的两个健壮性修复真机 | **NOT_RUN**（需再重进一次世界） |
| `move_to` 真实位移 | **NOT_RUN**（未授权移动角色，全程只用 stop） |

---

## 7. 下一步

1. **再重进一次世界**，让 0.14.3 的 Lua 进内存（状态文件 `mod=0.14.3`）。
2. 我会重跑探针，重点确认：T2 不再 `duplicate_command`、ack 的 `acked_at` 是正常毫秒、干净换手能 `handover_completed`。
3. 若要验 F8↔MCP 网络换手，请启动 DSH 插件的 MCP 服务（18090）。
4. 若要验 `move_to` 位移，请明确授权（会移动角色）。

> 全程没有用 Fengari / Mock 冒充真机结论；上面 ✅ 都来自真实 DST 的 `whale_result.json` 回执与状态文件。
