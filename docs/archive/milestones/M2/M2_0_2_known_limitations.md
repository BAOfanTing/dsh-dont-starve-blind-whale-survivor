# M2.0.2 · 已知限制与未验证边界

> 诚实清单：**代码级修复完成（378/378 UNIT/STATIC），但不等于完整安全验收通过。**

---

## 1. 真机（最大缺口）

| 项 | 状态 | 说明 |
|---|---|---|
| 0.14.1 载入真实 DST 世界 | ✅ 已观察（Cluster_2，状态文件 mod=0.14.1） | 但暴露通道缺陷；0.14.2 修复后需重进世界 |
| 0.14.2 真机核心链路（stop / 精确 reason / revoking / ack / fail-closed） | ✅ **PASS（第二轮）** | 见 `docs/M2_0_2_runtime_probe_round2.md` |
| 0.14.3 健壮性修复真机 | **NOT_RUN** | 需再重进一次世界 |
| F8 → MCP 真机换手 | ✅ **PASS（第三轮）** | 用产品 `apply()` 启动 18090，真实 HTTP `tools/call`；旧 MCP 命令被 `authority_revoking` 拒，收敛后新租约 active。见 `docs/M2_0_2_runtime_probe_round3.md` |
| MCP → F8 真机换手 | ✅ **PASS（第三轮）** | 同上（另一控制主体为同协议独立 LeaseManager，未启动 F8 AI 循环） |
| 旧命令换手后到达（真机） | ✅ **PASS（第二/三轮）** | `stale_generation` / `authority_revoking` / `wrong_owner` |
| revoking → `A.Abort` → ack → active 的真实时序 | ✅ **PASS（第二轮）** | Lua 写出 ack（job_cleared=true），Node 校验后 active |
| 租约过期 / 游戏重启 / 文件缺失真机 | **NOT_RUN** | 见 `docs/M2_0_2_runtime_manual_checklist.md` |

**没有用 Fengari / Mock / 独立 Node 进程冒充 DST 真机结论。**

---

## 2. 身份粒度

- `owner_instance_id` 在 `lib/index.js` 的 `apply()` 里生成，是**进程内稳定 UUID**。
- **F8 AI 循环未启动**（第三轮）：换手测试的"另一控制主体"是同协议、同权威租约文件的独立 `LeaseManager`（`owner_type=f8_agent`）。按 F8 会真的让模型自主玩游戏，未获授权，因此没有启动。
- **MCP 是服务实例级身份**：`lib/mcp-server.js` 不区分单个 TCP 连接/会话，两个 MCP 客户端连同一个服务进程会共享同一个 `owner_instance_id`。本轮**没有**实现连接级隔离，也不声称实现了。
  - 若要连接级：需要 MCP 层把每个 `initialize`/session 映射成独立 id 并传给 dispatcher（M2.1 之后再说）。
- F8 是"每个插件进程一个实例"；如果将来真跑两个独立插件进程，各自会生成不同 UUID ✓。
- 模型**不能**通过 Function Calling 指定 `owner_instance_id`（命令字段取自权威租约，B-5 静态钉住）。

---

## 3. 两阶段换手的严格边界

- `revoking` 期间 Lua 拒所有新动作、Node `validate` 也拒；但：
  1. Lua 只在 `server_tick`（0.2s）或收到命令时才观察 revoking，**不是事件驱动即时**。窗口内旧命令若已被 `validate` 通过并进入 `actions.Start`，理论上仍可能开始执行（C-11 验证的是 validate 阶段重读；`actions.Start` 之后没有第二次权威检查）。
  2. `Whale.actions.Abort()` 是既有已验证的安全停止（`locomotor:Stop` + `ClearBufferedAction`），但**没有逐一验证所有长动作**（`sleep`、4 个宏、跨 tick 的 `move_to`）能否瞬时中断。确认文件里的 `job_cleared` 只是写确认那一刻的 `Whale.job == nil` 快照，不保证动作内部没有后续效果。
  3. 因此本实现是**保守版**：宁可保持 `revoking` 拒绝一切，也不超时自动放行。要"严格即时 fencing"需要在 `A.Tick()` 每一步重新核对权威 generation——本轮没改动作执行器（禁止大规模重构）。
- `completeHandover()` 只校验 `epoch + generation + runtime_id`，**没有校验 `job_cleared`**；如果 Lua 写的确认里 `job_cleared=false`，Node 仍会放行。理由：本轮开放的动作只有 `move_to`/`stop`，Abort 后风险可控；M2.1 开放长动作前必须把 `job_cleared` 纳入校验。

---

## 4. 文件桥与平台

- **③-5 已真机确认（M2.0.3）**：Lua 只读 `Cluster_N/<分片>/save/whale_lease.json` 这一份。
  篡改 bin64/bin 的副本完全无效（安全）；但反过来，**能写 save 目录该文件的人就能直接改控制权** ——
  `authority_epoch`/`runtime_id` 只挡"换手前的旧命令"，挡不住"本地进程改写权威文件"。
  这是文件桥架构的固有边界（文件系统权限范畴），不在本架构能防的范围内。
- **真机已证：DST 模组沙箱 `GLOBAL.io == nil`**，Lua 只走 `TheSim:GetPersistentString` 持久化字符串通道。
  0.14.1 曾因用 `io.open` 读权威文件导致**所有命令（含合法命令）被 `authority_unavailable` 拒绝**。
  0.14.2 改为：`bridge.lua` 每 tick 用 `ps_read(FILES.lease)` 读权威文件 → 严格解析 → 写入
  `Whale.authority_cache`（带时间戳）；`guard.validate()` 只用**≤5 秒的新鲜缓存**，io 仅作沙箱兜底。
  Node 写的带 KLEI 头普通文件能被 `GetPersistentString` 读到（命令通道已长期验证）。
  - 详见 `docs/M2_0_2_runtime_probe_round1.md`。
  - **0.14.2 的 ps 缓存路径已在真机复验通过**（第二轮：T2 成功、T8 缓存过期 fail-closed）。
- Windows `renameSync` 覆盖已验证于 Node 单测；真实游戏进程同时 holding 文件时的行为未验证。
- 锁用 `process.kill(pid, 0)` 判活 + 5s TTL。**Windows PID 复用**可能导致保守 `lock_busy`（宁可拒绝，不误抢）。

---

## 5. 协议与兼容

- 旧格式命令（缺 `authority_epoch` / `lease_id` / `owner_type` / `owner_instance_id`）**一律拒绝**，没有兼容回退（任务书要求）。
- `.runtime/m2-control.json` 若是 M2.0 的旧结构（无 `schema`/`authority_epoch`），`isVerifiableAuthority()` 判不可用 → 换新 epoch 重建；旧命令带旧 epoch 全拒。
- `whale_cmd.json` / `whale_result.json` 结构未变，只增字段；M1.4 Observer、F8/MCP 共用 `readSnapshot()` 未动。

---

## 6. 本轮明确没做的事

- 没开放任何新动作（白名单仍是 `move_to`、`stop`）。
- 没进 M2.1、没做采集/战斗/制作/建造、没写自动生存循环。
- 没新增 Node 微服务、没有第二套 Control Lease、没有绕过 Dispatcher 的路径。
- 没改 `m12-watch.mjs`、没改用户存档、没改 API Key / 模型默认配置、没改 `modsettings.lua`。
- 没删除或跳过任何既有测试（354 → 378）。

---

## 7. 放行建议

- **M2.0 安全底座：代码级可验收**（A/B/C 全部反转断言通过、378/378）。
- **M2.1 仍建议暂缓**，直到：
  1. 按 `docs/M2_0_2_runtime_manual_checklist.md` 完成至少一次 F8→MCP 与 MCP→F8 真机换手；
  2. 场景 C（旧命令换手后到达）真机确认 `stale_generation`；
  3. 决定是否在 `A.Tick()` 里加"每 tick 复核权威 generation"（严格即时 fencing）；
  4. 把 `job_cleared` 纳入 `completeHandover`（开放长动作前）。
