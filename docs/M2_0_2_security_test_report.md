# M2.0.2 · 安全修复测试报告

> 基线：`8e8d394`，354/354 → **378/378**（+24 个净新增用例；既有测试无删除、无跳过）
> 命令：`node --test --test-force-exit "tests/*.test.mjs"`
> 证据类型：**UNIT**（真实独立 Node 进程 / fengari 沙箱 / 临时文件）、**STATIC**（读源码）、**NOT_RUN**（真机）
> 关键：**M2.0.1 的 16 条"证明漏洞存在"断言已全部反转为"必须拒绝/必须互斥"的安全断言。**

---

## 1. 数量

| 阶段 | tests | pass | fail |
|---|---|---|---|
| M2.0.1 基线 | 354 | 354 | 0 |
| M2.0.2 修复后 | **378** | **378** | 0 |

| 文件 | 例数 | 变化 |
|---|---|---|
| `tests/m2_0_1_lease_security.test.mjs` | 16 → **29** | 16 条反转 + 13 条新增（A-5/A-6/A-7/A-8、B-4/B-5/B-6、C-6/C-7/C-8/C-9/C-10/C-11/C-12、D-4） |
| `tests/m2-lua-guard.test.mjs` | 27 → **38** | 全部改为"权威租约文件"驱动；新增 11 条权威/generation/身份检查 |
| `tests/m2-control-dispatcher.test.mjs` | 20 | 全部改用真实临时租约文件 + 实例 id + 新信封字段 |
| `tests/helpers-m2.mjs` | — | 新增：权威记录工厂、Lua `io.open` 假文件、命令信封工厂 |
| 其它 | — | `mcp.test.mjs` 租约文件/实例 id、`plugin.test.mjs` 惰性目录、`tool-parity`/`tool-parity`/`lua-mod` 保持 |

---

## 2. A 组：跨进程互斥（逐条）

| 用例 | 修复前 | 修复后（本轮） |
|---|---|---|
| **A-1** 两个独立 Node 进程同时 acquire | 都成功、同 generation | ✅ 一个 active、另一个 `lock_busy` 或 `revoking`；generation 不重复；文件结构完整（A-1 实测输出已打印） |
| **A-2** 已存在实例看不到别人的更新 | 基于旧内存副本也成功 | ✅ p2 读到最新磁盘状态 → generation=2 / `revoking` |
| **A-3** 崩溃后恢复 | TTL 恢复但无锁 | ✅ 过期死锁（PID 不存在）被清理；generation 递增 |
| **A-4** 静态检查 | 无锁/CAS、只在构造时读 | ✅ `'wx'` 锁、锁内 `_readFile()`、原子写均存在 |
| A-5 三个进程竞争 | — | ✅ 最多一个 active，generation 单调不重复 |
| A-6 写权威文件失败 | — | ✅ 返回 `authority_write_failed`，不报告成功 |
| A-7 释放锁 nonce 不匹配 | — | ✅ 拒绝删除别人的锁 |
| A-8 活锁不可抢 | — | ✅ `lock_busy` |

> A-1/A-5 用的是 `tools/m2_0_1-lease-worker.mjs` 启动的**真实独立 Node 进程**（`execFile` + 共同起始时间），不是 Promise 模拟。

---

## 3. B 组：owner 实例身份

| 用例 | 修复前 | 修复后 |
|---|---|---|
| **B-1** 两个 MCP 实例 | `renewed`（互认） | ✅ `handover_revoking` + generation 2 |
| **B-2** 两个 F8 实例 | 同上 | ✅ 换代 |
| **B-3** 同实例续租/不同实例释放 | 混在一起 | ✅ 续租不换代；不同实例释放 → `wrong_owner_instance` |
| B-4 空实例 id | — | ✅ `unknown_owner_instance` |
| B-5 模型伪造实例 id | — | ✅ STATIC：身份取自权威租约，不取自 args |
| B-6 租约结构 | 只有 owner | ✅ 含 `owner_type + owner_instance_id`，`isVerifiableAuthority()` 通过 |

D-2 同时验证：同实例过期重取换代、runtime/session/shard/actor 变化换代。

---

## 4. C 组：Lua Generation Fencing（逐条，fengari 真实 guard.lua）

| 用例 | 修复前 | 修复后 |
|---|---|---|
| **C-1 关键时序**（gen12 命令 A 未处理 → gen13 换手不发命令 → Lua 读 A） | `true\|nil`（执行！） | ✅ `false\|authority_revoking` → 换手完成后 `false\|stale_generation` |
| C-2 先 13 后 12 | 拒 | ✅ `false\|stale_generation` |
| **C-3** 伪造 gen=999 | 接受并污染最高世代 | ✅ `false\|future_generation`，之后正常命令仍可用（未污染） |
| **C-5** 非当前 owner 同代 | 放行 | ✅ `false\|wrong_owner` / `false\|wrong_instance` |
| C-6 权威文件不存在 | 回退本地世代 | ✅ `false\|authority_unavailable` |
| C-7 文件损坏 / 缺字段 | — | ✅ `false\|authority_corrupt` |
| C-8 `status=revoking` | 无此状态 | ✅ `false\|authority_revoking` |
| C-9 epoch 不匹配 | 无此字段 | ✅ `false\|authority_epoch_mismatch` |
| C-10 换手前写入、换手后到达 | — | ✅ `false\|stale_generation` |
| C-11 Lua 已读 authority 后换手 | — | ✅ 每次 validate 重读文件 → `false\|authority_revoking`（不用旧副本） |
| C-12 两阶段确认 | — | ✅ 无确认/错确认保持 `revoking`；有效确认后 active，旧 owner 被拒 |
| guard-1..38（另一文件） | 旧世代逻辑 | ✅ 权威文件驱动；新增 generation 精确相等/epoch/lease_id/owner/instance/revoking/损坏等 11 条 |

---

## 5. D 组：原有正确行为回归

| 用例 | 结果 |
|---|---|
| D-1 单位一致（Node `Date.now()` / Lua `os.time()*1000.0`） | ✅ |
| D-2 过期重取换代、环境指纹变化换代 | ✅ |
| D-3 命令过期 `command_expired` | ✅ |
| D-4 权威文件丢失重建 → 新 epoch 让旧命令失效 | ✅ |
| 既有 291 例（M1.4 + M2.0） | ✅ 全过 |
| Lua→Node 管线自检 | ✅ 32/32 |

---

## 6. 文件桥集成检查（UNIT，非真机）

`.runtime/m202-bridge-check.mjs`（临时脚本）：用真实 `GameBridge` + 临时桥目录，
`LeaseManager` 写入后确认 `whale_io_lease.json` / `whale_lease.json` / `m2-control.json`
三份都是完整 `bws.control-lease/1`；`bridge.readLeaseAck()` 能读到 Lua 风格的确认文件。
→ 证明 Node 写、Lua 可读路径在同一目录体系内，且不会出现半截 JSON。

---

## 7. 真机状态（如实）

| 项 | 状态 | 证据 |
|---|---|---|
| 0.14.1 加载进真实世界 | **NOT_RUN** | 游戏客户端本轮没在跑；改过 Lua 必须重进世界 |
| F8 → MCP 真机换手 | **BLOCKED** | `127.0.0.1:18090` 未监听（插件 MCP 服务未启动） |
| MCP → F8 真机换手 | **BLOCKED** | 同上 |
| 旧命令换手后到达（真机） | **NOT_RUN** | 需要真机按清单执行 |
| 租约过期 / 游戏重启 / 文件缺失（真机） | **NOT_RUN** | 同上 |
| 动作执行结果核对 | **NOT_RUN** | 未执行任何会改变世界状态的动作 |

> 所有通过项均为 UNIT/STATIC。**没有用 Mock/Fengari 宣称 DST 真机通过。**

---

## 8. 结论

- A/B/C 三个已复现漏洞在代码层面全部修复，并有反转后的安全断言逐条钉住。
- 354/354 不是验收条件；**C-1 从 `true|nil` 变成 `false|stale_generation`** 才是本轮最关键的证据。
- 全量 378/378、管线 32/32、0.14.1 已安装（19 个文件，guard.lua/bridge.lua 就位）。
- **完整安全验收仍待真机换手测试**（清单见 `docs/M2_0_2_runtime_manual_checklist.md`）。
