# M2.0.1 · Control Lease 跨进程安全补充审计

> 基线：0.14.0 / `f287947`，338 测试通过 → 本轮新增 16 个复现测试后 **354 / 354**
> 性质：**只审查与复现，未修改任何生产代码**（任务书第八节要求）。
> 复现代码：`tests/m2_0_1_lease_security.test.mjs` + `tools/m2_0_1-lease-worker.mjs`（独立 Node 进程竞争）
> 证据分级：`UNIT`（真进程 / fengari）、`STATIC`（读代码）、`NOT_RUN`（真机）

---

## 0. 结论先行

| 问题 | 结论 | 严重度 | 是否阻塞 M2.1 |
|---|---|---|---|
| **A 跨进程 acquire 原子互斥** | **不存在**。两个独立进程同时 acquire 会**都成功**、拿到**同一个 generation**、文件被后写覆盖 | 高 | **是** |
| **B owner 身份粒度** | 只有类型名，两个 MCP / 两个 F8 实例被当成同一持有者 → 续租不换代 | 高 | **是** |
| **C Lua Generation Fencing** | **存在关键时间窗漏洞**：换手到 gen=13 但 Lua 没见过 13 时，已写文件的旧命令 gen=12 会被执行；且可用任意大数字污染最高世代；不核对持有者 | **最高** | **是（必须先修）** |
| **D 租约过期 / 单位** | 过期重取会换代、环境变化会换代、ms 单位一致 —— 这部分**是对的** | — | 否 |

**总判断：M2.0 的租约在「同一 Node 进程内」可用；在「不同进程」或「换手与旧命令到达之间」不安全。建议暂不进入 M2.1。**

> 当前环境事实（`STATIC`/系统检查）：游戏客户端**没在跑**、`127.0.0.1:18090` **未监听**、`.runtime/m2-control.json` 不存在。
> 所以"F8 进程 + MCP 进程 + 真实游戏"的三方真机验证标 **NOT_RUN**；本轮 A 的并发证据来自**两个真正独立的 Node 进程**（不是 Promise 模拟）。

---

## 1. 真实调用链（先对齐，不靠函数名猜）

```
[F8] lib/index.js:304  control.acquire('f8_agent', leaseEnv())
     └─ lib/tools.js executeTool → dispatcherFor(ctx) → createDispatcher({ control })
          └─ dispatcher.js:154  control.validate(owner, { env })      ← 只传 env，不传 generation
               └─ dispatcher.js:175  lease_generation = lease.generation（取"本进程内存里的租约"）
                    └─ bridge.call(..., { envelope }) → whale_cmd.json

[MCP] lib/index.js:352  control.acquire('mcp_client', leaseEnv())
       └─ 同一个 control（同一进程时）/ 或另一个 LeaseManager（另一进程）
       └─ finally: control.release('mcp_client')

[Lua] bridge.lua:196 handle_command → guard.validate(cmd) → guard.accept(cmd) → actions.Start
      guard.lua:181  lease_state = { generation = 0, ... }   ← 模块级 local，只在 accept() 里抬高
      guard.lua:267  if gen < lease_state.generation then 拒绝
      guard.lua:294  accept: if gen > lease_state.generation then 记下来
```

---

## 2. 问题 A：跨进程租约竞争（`lib/control.js`）

### 2.1 逐条回答

| 问题 | 答案 | 代码位置 |
|---|---|---|
| acquire 是否读取当前租约？ | **只读构造时的内存副本**。`_load()` 只在 `constructor`（L53）调用一次；`acquire()` 里用的是 `this.lease`（L119），**没有重新读盘** | L47-54 / L116-119 |
| 是否判断 owner/generation/expiresAt？ | 是（内存内）：L135-144 判断 owner 与过期，generation 在 L126/149/162 递增 | — |
| 是否 read-check-write？ | 是，但**只读内存，不读文件**；跨进程没有一致性 | L116-168 |
| 写入是否仅 tmp + rename？ | **是**：`_persist()` = `writeFileSync(tmp)` + `renameSync`（L67-77）。atomic rename **只保证文件内容不撕裂，不保证 acquire 互斥** | L67-77 |
| 是否有独立跨进程锁 / CAS？ | **没有**。审计测试 A-4 扫描 `flock/lockfile/O_EXCL/CAS/mkdirSync(lock)` 全部 0 命中 | — |
| 几乎同时 acquire 会怎样？ | 两个进程各自从"空"开始，都走 `existing == null` 分支 → 都返回 `{ok:true, generation:1}`；文件最终只剩后写那个 | A-1 |
| 两个进程是否可能都成功？ | **是**（实测） | A-1 |
| 是否可能拿到相同 generation？ | **是**（实测都是 1） | A-1 |
| 是否发生后写覆盖先写？ | **是**（实测最终 `owner=mcp_client`，而 f8_agent 进程也认为自己持有） | A-1 |
| 崩溃后能否恢复？ | **能**：靠 TTL 过期自然恢复，不靠锁。A-3 验证过期后重取 generation=2、`reason=expired_reacquired` | A-3 |

### 2.2 复现（两个独立 Node 进程，`A-1` 原始输出）

```
进程 A (f8_agent):   {ok:true, reason:"acquired", generation:1}
进程 B (mcp_client): {ok:true, reason:"acquired", generation:1}
最终文件: {"owner":"mcp_client","generation":1,...}
```

另一个更隐蔽的场景（A-2）：进程 P1 acquire 写盘后，**已经存在的** P2 实例（构造更早）内存里仍是旧状态 → P2 acquire 也成功、generation 仍是 1。即"新建实例才看得见别人的写入"。

### 2.3 安全影响

- 两个进程都自认为持有控制权，都会通过 `dispatcher.validate`（各自内存）→ **两条命令都会写进 `whale_cmd.json`**；Lua 只看 generation 且两者都是 1，无法区分 → 都可能执行。
- 恰好命中任务书"同一时刻只有一个客户端拥有控制权"的反面。

---

## 3. 问题 B：owner 身份粒度

### 3.1 事实

`OWNERS = ['f8_agent','mcp_client','manual_test','system']`（`control.js:19`）；租约里只有 `owner` 字符串（B-4 断言没有 `instanceId`）。
`acquire()` 判定"同一持有者"靠 `existing.owner === owner`（L136）→ 只看类型。

| 场景 | 实测结果 | 用例 |
|---|---|---|
| 两个不同 MCP 客户端（都是 `mcp_client`） | 第二个 `renewed`、generation 不变、都"持有" | B-1 |
| 两个不同 F8 Agent 实例（都是 `f8_agent`） | 同上 | B-2 |
| 同一客户端在有效期内续租 | `renewed`、generation 不变（**符合预期**） | lease-2（M2.0 既有） |
| 同一客户端过期后重取 | generation +1、`expired_reacquired`（**符合预期**） | B-3 |
| 不同 owner 换手（force） | generation +1（**符合预期**） | lease-4 / D-2 |

### 3.2 结论与最小方案

需要 `owner_type + owner_instance_id`。建议（不改架构，只改租约结构 + 比较规则）：

1. `acquire(owner, env, { ownerInstanceId })`：租约写入 `ownerType` 与 `ownerInstanceId`；`dispatcher`/`index.js` 传入每进程稳定的 id（F8 用 `randomUUID()` 保存在进程启动时；MCP 用连接 id / 进程 id）。
2. "续租"条件从 `existing.owner === owner` 收紧为
   `existing.ownerType === ownerType && existing.ownerInstanceId === ownerInstanceId && !expired`。
3. 其余任何情况（不同实例、过期、环境变化、force）都视为**新租约** → generation +1。
4. `validate()` 同样按 (type, instanceId) 校验；`release()` 只有同一实例能放。
5. 兼容影响：现有 `OWNERS` 字符串仍可作为 `ownerType` 保留；旧 `.runtime/m2-control.json`（无 instanceId）在加载时应视为"未知持有者"，下次 acquire 走新租约分支（generation +1）。

---

## 4. 问题 C：Lua Generation Fencing（最严重）

### 4.1 逐条回答

| 问题 | 答案 | 位置 |
|---|---|---|
| highest_seen_generation 保存在哪 | `local lease_state = {generation=0,...}` —— **Lua 模块级 local 变量，只在内存里** | guard.lua:181 |
| Lua 重启后是否重新初始化 | **是，归零**。`G.reset()` 也会清零（L187-189）。跨运行实例靠 `runtime_id` 校验挡住旧命令（guard.lua:238-242，已由 M2.0 的 guard-12 覆盖） | — |
| 是否只在 accept() 后更新 | **是**（L292-299）。`validate()` 不更新；只有命令被接受并即将执行时才 `accept()` | bridge.lua:224 |
| 换手能否立即使"已写入但未执行"的旧命令失效 | **不能**。这正是 C-1 | — |
| Node 是否向 Lua 提供独立当前有效 generation | **没有**。只在命令信封里带 `lease_generation`；Lua 不读任何租约文件（C-4） | dispatcher.js:175 / bridge.lua |
| Lua 是否能核对当前租约持有者 | **不能**。`requested_by` 只被 `accept()` 记下来（L296），`validate()` 从不用它；C-5 实测"另一个 owner 用同一代发命令"照样通过 | — |
| gen=13 已在 Node 生效、Lua 只见过 12，旧命令 12 能否执行 | **能** —— 见 4.2 | C-1 |
| 能否用更大的无效 generation 污染最高世代 | **能**：`gen=999` 直接被接受并把 `lease_state.generation` 抬到 999，之后所有正常命令都被判 `stale_generation` | C-3 |

### 4.2 关键时序复现（任务书指定，C-1）

```
1. F8 获取 generation=12
2. F8 写入 command A（whale_cmd.json），Lua 尚未处理
3. MCP 获取 generation=13（Node 侧已生效），但 MCP 先不发任何动作
4. Lua 读取旧 command A
```

实测结果：

```
validate(cmdA, gen=12) → 'true|nil'      ★ 旧命令被执行
lease_state().generation → 0             （Lua 甚至没见过任何世代，因为 A 只是 validate 未 accept）
```

原因：`guard.lua:267` 只做 `gen < lease_state.generation`。Lua 从未收到 gen=13 的命令 → 最高世代仍是 12（甚至 0）→ 12 不小于它 → 放行。
M2.0 的 `guard-8b` 只覆盖"先执行 13、再执行 12"的较弱场景（C-2 复现为拒绝），**没有覆盖换手与旧命令到达之间的窗口**。

补充：`commandTtlMs=8s` < `lease TTL=30s`（D-3）。旧命令在 8 秒内是有效的；而 8 秒窗口足够一条移动命令被 Lua 轮询到（轮询 0.3s）。

### 4.3 安全影响 / 是否阻塞

- 换手后旧持有者的**已下发命令仍可作用于角色**，与"同一时刻只有一个控制主体"直接冲突；M2.1 若开放采集/战斗，这个窗口会放大成真实资源损失/误伤。
- **阻塞 M2.1**。

### 4.4 最小修复方案（等确认后单独实施）

不重写 Control Lease，只补"权威租约状态"这一条数据通路，复用已有文件桥与运行目录：

1. **Node 侧**：`LeaseManager` 每次 acquire / renew / release / invalidate / 过期检测时，把当前权威租约（含 `generation`、`ownerType+ownerInstanceId`、`expiresAt`、`env`）写到**同一个共享运行目录**下的独立文件（例如 `.runtime/m2-control.json` 本身即可，但必须让 Lua 能读到——见 2）。
2. **Lua 侧读取权威 generation**：让 Lua 每隔一个 tick（或在处理命令前）读到一个"当前有效 generation + 持有者"的**小文件**，写入位置必须是 Lua 能 `io.open` 的地方（现有文件桥已验证：`bin64/whale_io_*.json` 或存档目录的持久化字符串）。新增一个只读通道文件（例如 `whale_lease.json`）——**不新增第二个状态写入者**：仍由 Node 的 LeaseManager 写、Lua 只读。
3. `guard.validate(cmd)` 改为：
   - 先读权威文件；读得到就用 `cmd.lease_generation ~= authority.generation` 直接拒（`stale_generation`）；**不再只比"见过的最高世代"**；
   - 持有者 `(type, instanceId)` 必须与权威租约一致（`wrong_holder`）；
   - 权威租约已过期、或 `runtime/session/shard/actor` 与命令不一致 → 拒；
   - `gen > authority.generation` 一律拒（**堵死 C-3 伪造**）。
   - 权威文件不可读时 **fail-closed**：拒绝所有动作（兼容性影响：Node 插件未运行时动作全拒；这正是"宁可拒绝"）。
4. `accept()` 不再抬高 generation（世代只由权威租约决定），只记 command_id 去重。
5. 回归测试：C-1 时序（必须变 `false|stale_generation`）、C-3（伪造被拒）、C-5（非持有者被拒）、A-1（跨进程互斥）、B-1/B-2（不同实例换代）。

> 兼容影响（任务书要求记录）：新增只读权威文件后，若插件没运行 / 文件被删，Lua 拒绝全部动作（fail-closed）。F8 与 MCP 仍走同一 Dispatcher；命令协议加 `owner_instance_id` 字段，旧命令缺该字段 → 拒绝。

---

## 5. 问题 D：租约过期与时间单位

| 检查 | 结果 | 用例 |
|---|---|---|
| TTL：租约 30s / 命令 8s | `DEFAULT_TTL_MS=30000`、`commandTtlMs=8000`，都是毫秒 | D-1 / D-3 |
| Node 时间 | `Date.now()` → ms（`acquiredAt/expiresAt/created_at/expires_at`） | D-1（STATIC） |
| Lua 时间 | `os.time() * 1000.0` → ms（`guard.clock_ms()`）；修复过 32 位整数溢出 | D-1 |
| 同一 owner 续租 | generation 不变（**正确**） | lease-2 |
| 同一 owner 过期重取 | generation +1、`expired_reacquired`（**正确**） | B-3 / D-2 |
| 不同 owner 换手 | generation +1（**正确**） | lease-4 / D-2 |
| runtime/session/shard/actor 变化 | 租约作废并换代（**正确**） | D-2 / guard-10..13 |
| 命令过期 | `command_expired`（**正确**） | guard-5 / D-3 |

**D 没有发现新问题**。唯一需要继承到修复方案里的约束：权威租约文件里的 `expiresAt` 与命令的 `expires_at` 必须继续用同一墙钟毫秒坐标系。

---

## 6. 测试覆盖（本轮新增 16 例）

| 要求 | 用例 | 类型 |
|---|---|---|
| 两个独立 Node 进程同时 acquire | A-1（`execFile` 起两个真进程） | UNIT |
| 已有进程看不到别人写入 | A-2 | UNIT |
| 崩溃后 TTL 恢复 | A-3 | UNIT |
| 无锁 / 无 CAS（静态） | A-4 | STATIC |
| 两个 MCP client_id 竞争 | B-1 | UNIT |
| 两个 F8 instance_id 竞争 | B-2 | UNIT |
| 同实例有效续租不换代 | B-3 / 既有 lease-2 | UNIT |
| 同实例过期重取换代 | B-3 / D-2 | UNIT |
| 不同 owner 换代 | D-2 / 既有 lease-4 | UNIT |
| **gen=12 旧命令先写、gen=13 已生效但 Lua 未见过** | **C-1** | UNIT（fengari） |
| Lua 从未见过 13 时旧命令也必须拒 | C-1（当前是**失败**：仍执行） | UNIT |
| 伪造更大 generation 污染 | C-3 | UNIT |
| 非当前持有者发命令 | C-5 | UNIT |
| Lua 不读权威租约 / 不核对 owner | C-4 / C-5 | STATIC + UNIT |
| runtime/session/shard/actor 变化作废 | D-2 / 既有 guard-10..13 | UNIT |
| 锁持有进程异常退出恢复 | A-3 | UNIT |

> 这些测试**断言的是"当前（有缺陷的）行为"**，所以全部通过；它们的价值是把漏洞固定成可复现事实。修复后这些断言必须同步改成期望的拒绝结果（届时会变红，正好当回归护栏）。

**全量：338 → 354 / 354 通过，无跳过、无删除既有测试。**

---

## 7. 发现清单（按优先级）

| # | 位置 | 问题 | 影响 | 阻塞 M2.1 | 最小修复 |
|---|---|---|---|---|---|
| P0 | `guard.lua:267`、`bridge.lua:224` | 换手后旧命令仍执行（Lua 只比"见过的最高世代"） | 旧持有者能继续操作角色 | **是** | §4.4：Lua 读权威租约文件，fail-closed |
| P0 | `guard.lua:294` | 任意大 generation 可污染 | 之后所有命令被拒（DoS）/ 伪造换手 | **是** | 世代只来自权威文件，`gen > authority` 拒 |
| P1 | `control.js:116-168` | acquire 无跨进程互斥 / 不重读盘 | 双进程都成功、同 generation、后写覆盖 | **是** | O_EXCL 锁文件（带 owner+pid+过期）或基于租约文件的 CAS（读当前 → 校验 `generation` 未变 → 写）；TTL 自动解锁防死锁 |
| P1 | `control.js:19/136` | owner 只有类型名 | 两个 MCP / 两个 F8 实例互认 | **是** | `ownerType + ownerInstanceId` |
| P2 | `control.js:204-213` | `validate()` 不接收 generation（dispatcher 也不传） | Node 侧无法发现"自己已被换手" | 否（随 P0/P1 一起修） | validate 传 generation + instanceId |
| P2 | `index.js:352-356` | MCP `acquire` 成功即 `release`，F8 未续租到下一轮前存在空窗 | 短暂无主（不是安全问题，但影响可用性） | 否 | 记录即可 |

---

## 8. 是否允许进入 M2.1

**不建议，标记 BLOCKED**，理由：

1. C-1 是**已复现的换手窗口漏洞**：M2.1 会开放采集/交互类动作（R2），旧命令在换手后仍作用于角色 → 真实资源/战斗风险。
2. A-1 是**已复现的跨进程互斥失效**；M2.1 若允许外部 MCP 进程接入，会直接踩中。
3. B-1/B-2 让"同一时刻一个控制主体"在多客户端下不成立。
4. 当前 D（过期/单位）是正确的，不需要改。

**放行条件**（等确认后再单独实施，任务书第九节）：完成 §4.4 与 §3.2、A 的最小修复，并把 C-1/C-3/C-5、A-1、B-1/B-2 改成"必须拒绝"的回归断言；真机在独立测试世界里按 `docs/M2_runtime_manual_checklist.md` 重跑换手场景后，再开 M2.1。

---

## 9. 本轮边界（透明记录）

- **没有修改生产代码**：只新增 `tests/m2_0_1_lease_security.test.mjs` + `tools/m2_0_1-lease-worker.mjs`（复现工具）。
- **没有新增 Node 服务、没有开放新动作、没有改 `.runtime/m2-control.json`**（本轮它不存在）。
- **真机 NOT_RUN**：游戏客户端没在跑、MCP 端口 18090 未监听；跨进程证据来自两个真实独立 Node 进程的竞争（不是 Promise）。
- 未用 fengari / Mock 冒充 DST 真机结论。
