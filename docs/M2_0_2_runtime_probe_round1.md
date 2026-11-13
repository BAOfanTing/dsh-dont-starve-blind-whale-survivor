# M2.0.2 真机验证记录 · 第一轮（发现通道缺陷）

> 时间：2026-11-13 13:44–13:52（Asia/Shanghai）
> 环境：真实 DST 客户端 PID 33296、Cluster_2/Master、0.14.1 内存中、有玩家
> 授权：用户「游戏开了，你测试吧」
> 结论：**真机暴露了一个必须修的设计缺陷（Lua 权威租约读取通道），已修复为 0.14.2，但需重进世界复验。**

---

## 1. 环境事实（RUNTIME）

| 项 | 值 |
|---|---|
| 游戏进程 | `dontstarve_steam_x64` PID 33296，13:29:46 启动 |
| 活动分片 | `Cluster_2/Master/save`（`Cluster_1` 是旧存档，13:28 后不再更新） |
| 状态文件 | `whale_state.json` 持续写盘（年龄 0s） |
| 内存版本 | `mod=0.14.1`（状态文件里的 mod 字段） |
| 磁盘已装 | 先 0.14.1，修复后 **0.14.2** |
| runtime_id | `r1794548114-5689`（nearby 快照 n36 → n183） |
| session / shard / actor | `63E379F1B94C51A3` / `1` / `player:KU_dsu8_vGS` |
| MCP 端口 18090 | **未监听** → F8↔MCP 网络换手仍 BLOCKED |

---

## 2. 只读取样（T0）

`GameBridge.readState()` 通过产品代码定位到 Cluster_2/Master，`normalizeState()` 得到：
`ready=true, players=1, actor.valid=true, nearby.status=ok, total_found≈141, total_returned≈39`。
→ 0.14.1 的 Observer / 文件桥在读侧正常。

---

## 3. 真机安全探针（`tools/m2_0_2_runtime_probe.mjs`，全部只发 `stop`）

**设计**：只用 `stop`（不移动、不改世界状态），走产品 `GameBridge.writeToAll` + `LeaseManager` 发布权威租约。
角色坐标 before/after 都是 `(-22, 32)`，**没有变化**。

| 步骤 | 期望 | 实测 |
|---|---|---|
| T1 无权威文件（旧格式命令） | 拒绝 | ✅ `authority_unavailable` |
| 发布 active 租约（gen=1） | 文件写全 | ✅ 6 份副本都是完整 `bws.control-lease/1` |
| T2 合法命令（active） | **成功** | ❌ `authority_unavailable` |
| T3 旧 generation | `stale_generation` | ❌ `authority_unavailable` |
| T4 伪造 gen=999 | `future_generation` | ❌ `authority_unavailable` |
| T5 错误实例 | `wrong_instance` | ❌ `authority_unavailable` |
| T6 revoking 期间旧命令 | `authority_revoking` | ❌ `authority_unavailable` |
| T7 换手后旧持有者命令 | 拒绝 | ❌ `authority_unavailable` |
| T8 权威文件缺失 | 拒绝 | ✅ `authority_unavailable` |

**全部命令都被拒（fail-closed 生效，没有一次误执行）**，但合法命令也被拒 → 功能不可用。

---

## 4. 根因（RUNTIME + STATIC）

我原本让 `guard.read_authority()` 用 `GLOBAL.io.open("whale_io_lease.json","r")`。
真机证据表明 **DST 模组沙箱里 `GLOBAL.io == nil`**：

| 文件 | 是否存在 | 谁写的 |
|---|---|---|
| `save/whale_state.json`、`save/whale_result.json` | ✅ | **Lua**（`TheSim:SetPersistentString`） |
| `bin64/whale_io_state.json`、`bin64/whale_io_result.json` | ❌ **不存在** | Lua 从不写 io 通道 |
| `bin64/whale_io_cmd.json`、`whale_io_hud.json`、`whale_io_settings.json` | ✅ | **Node**（`GameBridge.writeToAll`） |
| `save/whale_cmd.json`（带 KLEI 头） | ✅ 且被 Lua 读到 | Node 写 → `GetPersistentString` 读 |

→ Lua 与 Node 之间**唯一双向验证过的通道是持久化字符串**（`SetPersistentString` / `GetPersistentString`）。
Node 写的带 KLEI 头普通文件能被 `GetPersistentString` 读到（命令通道就是这么工作的）。
io 通道是 Node 单方面写，Lua 读不到。

我漏看了 `bridge.lua` 里 `local io = GLOBAL.io` 的 `io_write` 一直在静默返回 false（`if io == nil ... return false`），
却误把 bin64 里 Node 写的 io 文件当成了"Lua 也能 io.open"的证据。这是本轮最关键的教训。

---

## 5. 修复（0.14.2，已装盘）

| 文件 | 改动 |
|---|---|
| `scripts/whale/bridge.lua` | 新增 `poll_authority()`：每 tick 用 `ps_read(FILES.lease)` 读权威文件（带 KLEI 头），用 `Whale.guard.parse_authority` 严格解析后写 `Whale.authority_cache = {data, at=os.time()}`；`poll_lease()` 改用缓存判断 revoking |
| `scripts/whale/guard.lua` | 暴露 `G.parse_authority`；`read_authority()` 优先读**新鲜缓存**（≤5s，过期即 fail-closed），io 仅作沙箱兜底 |
| 版本 | 0.14.1 → **0.14.2**（modinfo + modmain），`node tools/install-mod.mjs` 已重装（19 文件） |

**为什么缓存是安全的**：缓存由 Lua 自己每 0.2s 从权威文件刷新，Node 无法伪造；超过 5 秒没刷新就拒一切动作；
`guard.validate()` 每次都检查新鲜度。换手后最多一个 tick 就能看到新权威。

**新增回归测试**（`tests/m2_0_2_authority_channel.test.mjs`，6 例）：
ps 缓存放行 / 缓存过期 fail-closed / revoking 拒绝 / 缓存与命令不匹配精确拒绝 /
静态检查 ps_read 接线 / io 兜底仍可用。全量 **378 → 384 / 384**。

---

## 6. 本轮状态（如实）

| 验收项 | 状态 |
|---|---|
| 真机只读取样 | ✅ PASS |
| 真机 fail-closed（无文件/旧命令/换手） | ✅ PASS（8 条命令全被拒，角色没动） |
| 真机合法命令能执行 | ❌ **FAIL（0.14.1 通道缺陷）** → 已修为 0.14.2，**待重进世界复验** |
| 真机 C-1 时序（旧命令换手后到达） | **BLOCKED**（Lua 读不到权威，所有命令都是 `authority_unavailable`，无法区分原因） |
| F8→MCP / MCP→F8 网络换手 | **BLOCKED**（18090 未监听） |
| 两阶段 revoking → ack → active 真机 | **BLOCKED**（Lua 读不到 revoking，没写 ack） |

> **没有用 Fengari / Mock 冒充真机通过。** 上面"✅"的都是真实 DST 文件桥与真实 Lua 回执。

---

## 7. 下一步（需要你）

1. **退出世界 → 重新进入**（或重启客户端），让 0.14.2 的 Lua 进内存。
   判断依据：新状态文件里 `mod=0.14.2`。
2. 告诉我一声，我立刻重跑 `tools/m2_0_2_runtime_probe.mjs`，重点看：
   - T2 合法 `stop` 是否变成成功；
   - T3/T4/T5/T6/T7 是否给出**精确 reason**（而不是清一色 `authority_unavailable`）；
   - `whale_lease_ack.json` 是否由 Lua 写出、Node 能否 `completeHandover`。
3. 若要测 F8↔MCP 网络换手，请把 DSH 插件的 MCP 服务开起来（18090）。
4. 若要测 `move_to` 真实位移，请明确说一声（会移动角色）。

> 当前角色状态：`alive=false`（第2天黄昏，自然死亡，与本轮探针无关——全程只发 `stop` 且从未成功执行）。
> 复验前建议先复活/换个角色，否则 `actor_dead` 会让 T2 拒绝（这是**正确**行为，但会混淆判断）。
