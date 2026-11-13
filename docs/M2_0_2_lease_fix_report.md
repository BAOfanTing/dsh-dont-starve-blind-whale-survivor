# M2.0.2 · Control Lease 跨进程安全加固报告

> 基线：0.14.0 / `8e8d394`，354/354 → **0.14.1，378/378**
> 性质：只修安全底座；**没有开放新动作、没有进入 M2.1**。
> 对应审计：`docs/M2_0_1_lease_security_audit.md`

---

## 0. 放行判断

| 验收条件 | 结果 |
|---|---|
| 两个独立 Node 进程不能同时获得同一个有效租约 | ✅ A-1/A-5（`lock_busy` 或 `revoking`，只有一个 active） |
| 不同 owner 实例不能互相续租或释放 | ✅ B-1/B-2/B-3 |
| Node 的 authority 文件是 Lua 执行时唯一可信租约来源 | ✅ guard 每次 validate 重读，失败即拒 |
| Lua 精确核对 generation | ✅ 精确相等，小→`stale_generation`，大→`future_generation` |
| Lua 核对 owner_type / owner_instance_id | ✅ `wrong_owner` / `wrong_instance` |
| 伪造未来 generation 被拒绝 | ✅ C-3，且不污染任何状态 |
| authority 文件缺失/损坏 fail-closed | ✅ C-6/C-7 |
| 旧命令在换手后到达必须拒绝 | ✅ **C-1（关键时序）/C-10/C-11** |
| generation 只由 LeaseManager 管理 | ✅ `accept()` 不再抬高世代 |
| 游戏重启后旧命令不能执行 | ✅ runtime_id + epoch 双重 |
| 长时间动作不在新 owner 获权后继续持有 Actor | ✅ 两阶段 revoking + `A.Abort`（见 §5 限制） |
| 原有 TTL / 环境隔离保持正确 | ✅ D-1/D-2/D-3/D-4 |
| A/B/C 漏洞复现断言全部改为安全断言 | ✅ 16 条反转 + 12 条新增 |
| 全量测试通过 | ✅ 378/378 |

**但：真机换手未跑 → 完整安全验收标记为「代码级通过 / 真机 BLOCKED」，见 §7。**

---

## 1. 三个问题的根因与修复

### A 跨进程租约竞争（`lib/control.js`）

| | 修复前 | 修复后 |
|---|---|---|
| 读取 | 构造时 `_load()` 一次，之后用内存副本 | **每次操作在锁内 `this._readFile()` 重新读盘** |
| 互斥 | 无（只有 tmp+rename 原子写） | **`openSync(lockFile,'wx')` O_EXCL 跨进程锁**；所有 acquire/renew/release/invalidate/completeHandover 都在锁内 |
| 写 | 直接覆盖 | `writeAtomic`（同目录 tmp + rename）；**写失败 → 返回 `authority_write_failed`，不报告成功** |
| 崩溃 | 靠 TTL | 锁带 `pid/nonce/expires_at`；过期且进程已死才允许 `rename` 到唯一退休名（只有一个进程能抢到清理权）；PID 存活绝不抢占 |
| 释放 | 无保护 | 只删 `nonce` 匹配的锁 |

实测（A-1，两个真进程）：一个 `authority_rebuilt/active`，另一个 `lock_busy`；最多一个 active，generation 不重复。

### B owner 身份粒度

租约新增 `owner_type + owner_instance_id`（`lib/control.js`）。
- `acquire/renew/release/validate` 都要求**两者同时匹配**；不同实例 → 换代 + `revoking`，不同实例释放 → `wrong_owner_instance`。
- `lib/index.js` 在 `apply()` 里生成 4 个进程内稳定 UUID（F8/MCP/manual/system），**不由模型提供**。MCP 为服务实例级身份（见限制 §7）。
- 命令信封里的 `owner_instance_id` 取自权威租约（`dispatcher.js`），不取 `args`。

### C Lua Generation Fencing（`scripts/whale/guard.lua`）

- **权威租约文件**：`bws.control-lease/1`，由 LeaseManager 唯一写入；Lua 只读。字段：
  `status / authority_epoch / generation / owner_type / owner_instance_id / lease_id / runtime_id / session_id / shard_id / actor_id / acquired_at / expires_at / previous_owner_*`。
- `G.read_authority()` 每次 `validate()` **重新读**（`io.open` 两个文件名：`whale_io_lease.json`、`whale_lease.json`，都支持 KLEI 头），解析后逐字段严格校验；任何缺失/损坏/schema 不符 → `authority_unavailable` / `authority_corrupt` / `authority_schema_mismatch`（fail-closed）。
- `validate()` 精确核对（按此顺序）：`authority_epoch` → **generation 精确相等** → `lease_id` → `owner_type` → `owner_instance_id` → `lease_expires_at` → 参数/组件/环境。
  - 小 → `stale_generation`；大 → `future_generation`；非整数 → `bad_generation`；缺 → `missing_generation`。
  - `status=revoking` → `authority_revoking`；非 active → `stale_lease`；过期 → `lease_expired`。
- **移除本地世代授权**：`lease_state.generation` 只作诊断；`accept()` 只记 `command_id` 去重 + 诊断信息，绝不因看见更大数字抬升世代。
- **关键时序 C-1 已反转为拒绝**：F8 gen=12 写入命令 A 未处理 → MCP 换手 gen=13 但不发命令 → Lua 读旧 A → `false|authority_revoking`；换手完成后 → `false|stale_generation`。

---

## 2. authority 文件协议与文件桥边界

| 项 | 实现 |
|---|---|
| 唯一写入者 | Node `LeaseManager`（`_persistAll`），Lua **只读** |
| 主文件 | `.runtime/m2-control.json`（Node 侧真值，锁内原子替换） |
| Lua 可读副本 | 由 `bridge.leaseDirs()` 给出的目录：`whale_io_lease.json`（纯 JSON）+ `whale_lease.json`（persist 通道带 KLEI 头） |
| 文件桥目录 | `commandDirs()` + 所有 io 通道目录（含 `<游戏目录>/bin64`）；`locate()` 已验证真实存在 |
| 半截 JSON | 写入用 `writeAtomic`（同卷 tmp+rename），读者只会看到完整版本 |
| 缺失/解析失败 | Node `isVerifiableAuthority()` 判不可用；Lua `parse_authority()` 拒绝，**不回退本地世代** |
| 丢失后重建 | Node 生成**新 `authority_epoch`** 并从 generation=1 重建；旧命令带旧 epoch → 拒；Lua 在文件缺失期间一律拒绝（D-4） |
| 游戏重启 | 命令 `runtime_id` 与 Lua `nearby.runtime_id()` 不符 → `runtime_mismatch`；epoch 也随重建变化 |
| 第二个状态写入者 | 无。Lua 只额外写 `whale_lease_ack.json`（换手确认，不是权威状态） |

Windows 注意：临时文件与目标**同目录**（`writeAtomic` 已实现），`renameSync` 覆盖同卷目标；写失败即拒绝。

---

## 3. generation / lease_id / epoch 机制

- `generation`：**只由 LeaseManager 在锁内**管理。换手（不同实例/过期/环境变化/force）→ `fresh.generation + 1`；同一实例有效续租 → 不变。
- `lease_id`：每次新租约换一个 UUID；命令必须精确匹配，防止"同代不同租约"的旧命令。
- `authority_epoch`：权威状态生命周期标识。文件丢失重建时换新；命令必须匹配。旧 epoch 的命令在新权威下永不接受。
- 命令字段全部由 dispatcher 从**刚读出的权威记录**生成：`lease_generation / owner_type / owner_instance_id / authority_epoch / lease_id / runtime_id / session_id / shard_id / actor_id / created_at / expires_at`（TTL 8s）。
- Lua 侧**没有**任何"见过的最高世代"授权逻辑。

---

## 4. 文件锁设计（`lib/control.js`）

```
openSync(lockFile,'wx')  ── 成功 → 写 {owner_type, owner_instance_id, pid, nonce, acquired_at, expires_at}
                         └─ EEXIST → 读锁；未过期 或 pid 仍存活 → lock_busy
                                    过期且 pid 已死 → rename 到唯一 .retired-<nonce>（原子抢清理权）→ 重试一次
锁内：_readFile() → 决策 → _persistAll(record) → 释放（校验 nonce）
```

- 锁 TTL 5s；`process.kill(pid,0)` 判活（Windows 可用）。
- 不无条件删除别人的锁（A-7）；活锁不可抢（A-8）；过期死锁可恢复（A-3）。
- **已知限制**：Windows PID 可能被复用；若"旧 pid 恰好复用给活进程"，会保守返回 `lock_busy`（宁可拒绝，不误抢）。

---

## 5. 换手与撤销（两阶段）

```
Node acquire(不同实例/force)
  → 原子发布 status="revoking"（generation+1，带 previous_owner_*）
  → 此期间：Lua guard 拒绝所有新动作；Node validate 返回 authority_revoking
Lua bridge.server_tick 的 poll_lease()（每 0.2s）
  → 读到 revoking → Whale.actions.Abort("控制权换手")（已验证的安全停止，停 locomotor + ClearBufferedAction）
  → 写 whale_lease_ack.json：{epoch, generation, runtime_id, acked_at, job_cleared}
Node dispatcher（每次动作前）/ index（F8、MCP、F7）
  → completeHandover(bridge.readLeaseAck())
  → epoch+generation+runtime 三者匹配才发布 status="active"
  → 拿不到/不匹配 → 保持 revoking，**绝不超时后自动放行**
```

`guard.validate()` 在看到 revoking 时也会触发一次 ack 写入（不等命令以外的时间）。
命令在换手窗口内到达：Lua 读到的权威是 revoking 或新 gen → 必拒（C-1/C-10/C-11）。

---

## 6. 修改文件清单

| 文件 | 改动 |
|---|---|
| `lib/control.js` | 重写：O_EXCL 锁、锁内重读、owner 实例身份、权威协议、revoking/completeHandover、fail-closed 写失败 |
| `lib/bridge.js` | `LEASE_NAMES`/`LEASE_ACK_NAMES`、`leaseDirs()`、`readLeaseAck()`（两通道） |
| `lib/dispatcher.js` | 每次 dispatch 重新读权威、`completeHandover`、信封新增 5 个权威字段、新拒绝原因 |
| `lib/tools.js` | dispatcher 传 `authorityDirs()`（惰性）与 `ownerInstanceId`、`readLeaseAck` |
| `lib/index.js` | 4 个进程内稳定实例 id；F8/MCP/F7 的 acquire/renew/release/确认接线；换手中不 release |
| `scripts/whale/guard.lua` | 权威文件读取与严格校验、精确 generation、去本地世代授权、新拒绝码 |
| `scripts/whale/bridge.lua` | `B.WriteLeaseAck()` + `poll_lease()`（revoking → Abort + 确认） |
| `DontStarveWhaleSurvivor/modmain.lua` | 新增 4 个文件名 + 版本 0.14.1 |
| `DontStarveWhaleSurvivor/modinfo.lua` | 版本 0.14.1 |
| 测试 | `tests/m2_0_1_lease_security.test.mjs`（28）、`tests/m2-lua-guard.test.mjs`（38）、`tests/m2-control-dispatcher.test.mjs`（20）、`tests/helpers-m2.mjs`、`tests/mcp.test.mjs`、`tools/m2_0_1-lease-worker.mjs` |

---

## 7. 已知限制（详见 `docs/M2_0_2_known_limitations.md`）

1. **真机换手未验证**：游戏客户端本轮没在跑、`18090` 未监听。所有证据是 UNIT（真进程 + fengari）/ STATIC。F8→MCP、MCP→F8 真机测试 **BLOCKED**，需按 `docs/M2_0_2_runtime_manual_checklist.md` 执行。
2. **MCP 身份是服务实例级**：`lib/mcp-server.js` 不区分 TCP 连接，因此两个 MCP 客户端在同一服务进程内共享一个 `owner_instance_id`。已如实记录，不声称连接级隔离。
3. **两阶段换手的严格边界**：Lua 只在 `server_tick`（0.2s）或收到命令时观察 revoking；`A.Abort` 是既有安全停止，能停 locomotor/BufferedAction，但**没有验证过所有长动作（如 sleep、宏）能否瞬时中断**。确认文件里的 `job_cleared` 是当时快照，不保证动作内部无后续效果。这是保守设计（宁可拒绝）。
4. **Lua 读权威走 `io.open`**：依赖 Node 把副本写进游戏工作目录可读的位置（已通过 `leaseDirs()` 覆盖命令目录 + io 目录，并在 `.runtime/m202-bridge-check.mjs` 做过文件桥集成检查）。持久化字符串通道只作备用副本，Lua 未走异步 `GetPersistentString` 读取。
5. **PID 复用**（§4）：保守拒绝，可能短时需等待锁过期。
6. **命令与 authority 不是同一次原子写**：Lua 每次读的是"当前权威"，换手瞬间靠 revoking + 精确 generation 兜底；不存在"读到旧 authority 后新租约生效却仍放行"的窗口，因为 `actions.Start` 前必须重新通过 validate（validate 每次重读文件）。
