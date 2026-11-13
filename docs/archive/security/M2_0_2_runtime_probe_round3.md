# M2.0.2 真机验证记录 · 第三轮（MCP 网络入口 + 换手）

> 时间：2026-11-13 14:14–14:25（Asia/Shanghai）
> 授权：用户「你直接启动啊；游戏启动了」→ 用产品代码 `apply()` 启动了真实 MCP 服务
> 环境：DST 客户端 PID 25828（14:13 启动）、`Cluster_2/Master`、状态文件 `mod=0.14.3`、角色存活
> 探针：`tools/m2_0_2_mcp_handover.mjs`（真实 HTTP `tools/call`，只发 `stop`）

---

## 1. MCP 服务（我直接启动的）

| 项 | 值 |
|---|---|
| 启动方式 | `node tools/m2_0_2_start_mcp.mjs` → 产品 `apply(ctx, config)` |
| 端口 | `127.0.0.1:18090`，PID 7512 → 修复后重启 PID 11880 |
| `/status` | HTTP 200，**游戏：连着**、桥目录 `Cluster_2/Master/save`、**模组版本 0.14.3** |
| `/mcp tools/list` | HTTP 200，35 个工具，含 `stop` / `get_state` |
| 配置 | `port=18090, autoInstallMod=false, freezeTime=false, presetEnabled/gatewayEnabled=false`（不碰 modsettings.lua、不启 AI 预设） |

---

## 2. 换手实测（真实 MCP HTTP 入口）

| 步骤 | 结果 | 判定 |
|---|---|---|
| **A1** MCP 首次 `stop` | `停下了` | ✅ 真实网络入口 → dispatcher → Lua 全链路 |
| **A2** 另一控制主体（f8_agent 身份）抢租约 | `handover_revoking, gen=2, status=revoking` | ✅ 换代 + 两阶段撤销 |
| **A3** Lua 写确认 | `whale_lease_ack.json`: `job_cleared=true, epoch/generation/runtime/lease_id` 齐全 | ✅ Lua 观察到 revoking 并 `A.Abort` |
| **A4** MCP 再发 `stop` | `失败：没有有效控制权：authority_revoking（control_denied）` | ✅ **互斥生效，旧主体不能继续操作** |
| **A5** MCP 再发（ack 尚未被完整消费） | 仍 `authority_revoking` | ✅ fail-closed |
| **A5b** 收敛后 MCP 再发 | **`停下了`** | ✅ 换手完成 |
| **A7** 最终权威 | `status=active, gen=3, owner=mcp_client, epoch=342c582c…` | ✅ 新租约生效、generation 递增 |
| **A8** 角色坐标 | 见 §4 | — |

**F8↔MCP 互斥与换手：真机通过。** 旧的 `mcp_client` 命令在换手后全部被拒，没有一条进入游戏执行队列。

---

## 3. 本轮发现并修复的产品缺陷

### 换手卡在 revoking（收敛缺失）

`lib/index.js` 的 MCP `executeTool` 原来只在 `acq.handover` 那一刻调用一次 `completeHandover(readLeaseAck())`。
但 **Lua 的 ack 是下一个 tick（0.2s）才写的**，那一刻必然拿不到 → `handover_ack_invalid` → 保持 `revoking`；
之后每次 `tools/call` 的 `acquire` 在 revoking 下返回 `handover_pending`（失败）→ 不再尝试 completeHandover → **永远卡住**。

修复：MCP 与 F8 的每次调用都先检查 `authority.status === 'revoking'`，并尝试用当前 `readLeaseAck()` 完成换手（与 acquire 结果无关）。
真机 A5→A5b 验证了收敛：第一次仍拒绝，第二次 `停下了`，权威变 `active`。

新增回归 `tests/m2_0_2_lease_ack.test.mjs` 的 ack-4 / ack-5（2 例）：
- 纯 Node 复现 revoking → 无 ack 保持 → 有 ack 变 active、旧 owner 被 `wrong_owner` 拒；
- 静态检查 MCP/F8 两处都有收敛逻辑。

全量 **387 → 389 / 389**。

---

## 4. 角色坐标变化（如实说明）

探针前后坐标 `(-22,32)` → `(-24,33)` → `(-16,36)`（持续变化）。
**但本轮所有命令都是 `stop`**，从未发过 `move_to`（`whale_cmd.json` 最后一条是 `action:"stop"`，两个探针脚本里也只有 `stop`）。
变化来自游戏内玩家自然行走 / 模组 `reflex` 反射（`whale_result.json` 里有 `reflex` 的回血提示），**不是探针执行了动作**。
`stop` 本身不产生位移；A1/A5b 的 `停下了` 回执也证明执行的是 stop。

---

## 5. 仍未验证 / 已知边界

| 项 | 状态 | 说明 |
|---|---|---|
| **F8 入口的 AI 循环** | 未启动（有意） | 换手的"另一控制主体"用**同协议、同权威租约文件**的独立 `LeaseManager`（`owner_type=f8_agent`）模拟，不是按 F8 键启动的自主 AI 循环。启动它会真的让模型自主玩游戏，未获授权。 |
| `acked_at=-2147483648` | 已知 | 运行中服务端 Lua 仍是 0.14.2 的 `bridge.lua`（`os.time()*1000` 整数溢出）；磁盘装的 0.14.3 已改 `*1000.0`，但重进世界未让服务端脚本重新加载。仅诊断字段，**不影响安全**（ack 的 epoch/generation/lease_id 全部正确，Node 校验通过）。 |
| `move_to` 真实位移 | **NOT_RUN** | 全程只用 `stop`，未授权移动角色 |
| MCP 连接级身份隔离 | 未实现 | `mcp-server.js` 不区分 TCP 连接，是服务实例级 `owner_instance_id`（已在 `known_limitations` 记录） |
| 游戏重启后旧命令 | 前几轮已验（UNIT + runtime_id 变化） | — |

---

## 6. 当前服务状态

- MCP 服务仍在 18090 运行（PID 11880），是我本轮启动的；如需关闭请告诉我，或直接在任务管理器结束该 Node 进程。
- 权威租约文件目前是 `active, gen=3, mcp_client`；插件运行时会正常续租/过期。

---

## 7. 结论

| 验收条件 | 结果 |
|---|---|
| F8 与 MCP 使用同一执行入口 | ✅ 真实 MCP HTTP → `executeTool` → dispatcher |
| 同一时间只有一个有效控制租约 | ✅ A4 旧主体被拒 |
| Generation Fencing | ✅ gen 1→2→3，旧世代命令全拒 |
| Lua 精确核对 generation/owner/epoch | ✅ 前两轮 8 条探针 + 本轮 A4/A5 |
| 换手后旧命令必拒、新租约才放行 | ✅ A4/A5 → A5b |
| 两阶段 revoking → ack → active | ✅ A3 → A5b → A7 |
| 角色未被探针误操作 | ✅ 只发 stop |
| **F8↔MCP 网络换手** | ✅ **真机通过**（F8 侧为同协议独立控制主体模拟，未启动 AI 循环，见 §5） |

> 没有用 Mock/Fengari 冒充真机：以上 ✅ 全部来自 `http://127.0.0.1:18090/mcp` 的真实 `tools/call` 与 DST 的 `whale_result.json` / 状态文件回执。
