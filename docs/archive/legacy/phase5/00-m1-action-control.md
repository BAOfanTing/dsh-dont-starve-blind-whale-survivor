# Phase 5 · M1：Action Control 基础设施

> 结论：**Action Protocol / Control Manager / Action Registry / Dry-Run HTTP 门面**全部完成，
> 42 个测试全过，端到端演练通过。M1 **未连接游戏、未调用任何游戏 API、未执行真实动作**。

## 0. 前置阶段依赖检查（以实际代码和实测为准，不假设）

### 0.1 实际跑了一遍全部前置测试

```
Lua/插件        pass 108  fail 0
Phase 1 Bridge  pass 22   fail 0
Phase 2 Bridge  pass 36   fail 0
Phase 3 MCP     pass 68   fail 0
Phase 4 Agent   pass 110  fail 0
合计            pass 344  fail 0
```

### 0.2 读代码确认的挂接点

| 阶段 | 文件 | 关键实现 | 结论 |
|---|---|---|---|
| Phase 2 | `game-bridge/src/commands.ts` | `COMMAND_TYPES = ['ping','echo','get_state','refresh_state']`，7 态状态机（QUEUED/DELIVERED/EXECUTING/SUCCEEDED/FAILED/EXPIRED/CANCELLED），`settle()` 幂等、`reapSession()` 会话丢失判 `unknown_completion` | 可用，但**协议字段与状态数不足**，Phase 5 需扩展（M1 在独立模块做，不改它） |
| Phase 2 | `game-bridge/src/routes.ts` | `/api/v1/commands/{enqueue,poll,result}`、`GET /api/v1/commands`；`enqueue` 白名单拒绝其它 type | 可用 |
| Phase 3 | `mcp-server/src/tools/definitions.ts` | `createToolDefinitions() = [bridgeStatus, ...createReadTools()]`（12 个只读工具） | 可用，M2+ 在此追加动作工具 |
| Phase 3 | `mcp-server/src/server/createServer.ts` | `server.registerTool(...)` + `registerResources/registerPrompts` | 可用 |
| Phase 4 | `agent/src/mcp/toolAdapter.ts` | 白名单 `READ_ONLY_ALLOWLIST`、`parseArguments()` 走 ajv、`executeToolCall()` | 可用，M2+ 需扩白名单 |
| Phase 4 | `agent/src/runtime/agentLoop.ts` | 4 轮上限、`reasoningContent` 保留、工具结果 `role:tool` | 可用 |

### 0.3 如实指出的依赖问题（不伪造成功）

1. **Phase 2 命令协议只支持 4 个测试命令**，`COMMAND_TYPES` 是硬编码白名单。
   Phase 5 的 17 个动作类型不能直接用它下发 —— M1 因此建了**独立的 Action Protocol**，不改 Phase 2（避免破坏已验证的只读链路）。M2 再决定是扩展 Phase 2 还是走新通道。
2. **Phase 2 是 7 态**，Phase 5 要求 9 态（含 `PENDING`/`VALIDATING`/`ACCEPTED`/`RUNNING`/`NEEDS_RECONCILIATION`）。M1 在新模块里补齐。
3. **Phase 3/4 全链路是只读的**（MCP 12 工具 + Agent 白名单）。Phase 5 的动作工具必须新增，并且**不能绕过** Phase 4 的 `ToolAdapter` 校验。
4. **游戏当前没在运行**（`alive=False stale=True`，快照是旧的）。M1 是 dry-run，不依赖游戏 —— 符合任务书"M1 不允许执行真实动作"。

**没有阻塞 M1 的依赖缺失。**

## 1. 新增文件

```
survival/
├─ package.json / tsconfig.json
├─ src/
│  ├─ protocol.ts          Action Protocol：9 态、5 控制模式、17 动作白名单、命令解析
│  ├─ controlManager.ts    Control Manager：Lease / 人工接管 / 暂停 / 紧急停止
│  ├─ actionRegistry.ts    Action Registry：幂等 / 状态机 / 取消 / 超时 / 需协调 / dry-run
│  └─ controllerApi.ts     Dry-Run HTTP 门面（控制面接口）
└─ test/
   ├─ m1.test.ts                  34 个用例
   ├─ controllerApi.test.ts       8 个用例
   ├─ demo-m1.mjs                 纯逻辑演练
   └─ demo-m1-http.mjs            HTTP 端到端演练
```

## 2. Action Protocol（`protocol.ts`）

### 9 态状态机

```
PENDING → VALIDATING → ACCEPTED → RUNNING → SUCCEEDED
   │          │           │          ├→ FAILED / CANCELLED
   │          │           │          └→ NEEDS_RECONCILIATION（执行中失联，结果未知）
   │          │           └→ TIMEOUT / CANCELLED / FAILED
   │          └→ FAILED / CANCELLED / TIMEOUT
   └→ CANCELLED / FAILED / TIMEOUT
TIMEOUT → NEEDS_RECONCILIATION
NEEDS_RECONCILIATION → SUCCEEDED / FAILED / CANCELLED（人工核对后结案，**不是重跑**）
```

`canTransition()` 在程序层拒绝非法迁移（终态不能重跑、不能跳过校验直接成功、执行中失联不能直接标 TIMEOUT）。

### 命令字段（任务书 §6 全部覆盖）

`command_id` / `action_id` / `idempotency_key` / `session_id` / `controller_id` / `created_at` / `expires_at` / `expected_state_sequence` / `action_type` / `payload` / `dry_run`
`parseActionCommand()` 校验必填、长度、类型、未知动作直接 `UNKNOWN_ACTION` 拒绝（不让外部传任意 ACTIONS 名或代码）。

### 白名单与安全分级

- **17 个动作类型**登记（移动 4 / 采集 3 / 工具 3 / 生存 4 / 管理 3）
- `CONFIRMATION_REQUIRED`：`chop_tree`/`mine_rock`/`eat_item`/`craft_item`/`build_structure`/`build_campfire` 需人工确认
- `READ_ONLY_ACTIONS`：`get_movement_status`/`get_action_status`/`get_control_status` 不需要写权限

## 3. Control Manager（`controlManager.ts`）

| 方法 | 行为 |
|---|---|
| `acquireControl` | SUPERVISED 默认；同一时间只允许一个 holder；人工可抢占；MANUAL/PAUSED/EMERGENCY 下拒绝 AI |
| `releaseControl` | 只有 holder 本人或人工能释放 |
| `renewControl` | 必须持有效 lease；续约时长 = 初始 lease 时长（语义稳定）；过期需重新申请 |
| `assertCanExecute` | 执行前程序层校验：紧急停止 > 模式 > holder > session > lease 有效期；只读查询豁免写权限 |
| `takeManualControl` / `releaseManualControl` | 人工接管优先级最高，立即撤销 AI lease；释放后回 SUPERVISED（不自动回 AUTONOMOUS） |
| `pause` / `resume` | 暂停拒绝执行；resume 回到 SUPERVISED |
| `enableAutonomous` | 受限自主必须**显式**开启 |
| `emergencyStop` / `clearEmergencyStop` | 同步立即生效、撤销 lease、拒绝一切（连只读也拒）；清除后回 SUPERVISED |
| `getControlStatus` / `getHistory` | 状态与完整变更审计 |

**Lease 带过期时间**，控制权切换时通过 `setPendingActionCounter()` 联动 ActionRegistry 统计并取消旧控制器未完成任务。

## 4. Action Registry（`actionRegistry.ts`）

| 能力 | 实现 |
|---|---|
| 命令唯一性 | `action_id` 唯一，重复直接 `DUPLICATE` |
| 幂等去重 | `idempotency_key` 命中 → 返回首次记录，`duplicate=true`，**不新增、不重复执行** |
| 权限校验 | `submit()` 调 `control.assertCanExecute()`，程序层拒绝（不靠提示词） |
| 强制 dry-run | `forceDryRun=true` 时即使外部传 `dry_run=false` 也改成 true；非 dry-run 执行明确 `NOT_IMPLEMENTED` |
| 人工确认 | 需确认动作未确认时**停在 VALIDATING**（不判 FAILED，确认后可续跑） |
| 状态机 | `transition()` 带合法性检查 + 完整 `history` 审计 |
| 取消 | 只有 holder/人工能取消；终态不能取消；控制权切换批量取消 |
| 超时 | 未执行的超时 → TIMEOUT；**执行中失联 → NEEDS_RECONCILIATION** |
| 需协调 | `reconcile()`；`isReplayAllowed()` 对 NEEDS_RECONCILIATION **一律返回 false**，禁止盲目重放 |
| 紧急停止 | `emergencyCancelAll()` 同步取消所有非终态，不被队列阻塞 |
| 记录上限 | 500 条，超出按更新时间淘汰 |
| Dry Run | `VALIDATING → ACCEPTED → RUNNING → SUCCEEDED`，结果 `{dry_run:true, executed:false}`，**不调用任何游戏 API** |

## 5. 实际测试日志

### 5.1 单元测试（42 个）

```
✔ Protocol：9 态 + 5 控制模式 + 17 动作白名单
✔ Protocol：状态迁移合法性（终态不能重跑 / 不能跳过校验 / 需协调态不能重跑）
✔ Protocol：parseActionCommand 校验必填字段
✔ Protocol：未知动作直接拒绝（eval_lua 被拒）
✔ Control：默认 SUPERVISED，未申请控制权时拒绝写操作
✔ Control：acquire → 有效 lease → 放行；release → 拒绝
✔ Control：同一时间只允许一个控制器
✔ Control：lease 过期后普通操作被拒，renew 可续期
✔ Control：人工接管优先级最高，撤销 AI lease
✔ Control：PAUSED 拒绝执行，resume 回到 SUPERVISED
✔ Control：AUTONOMOUS 必须显式开启
✔ Control：紧急停止同步生效，撤销 lease 并拒绝一切（连只读也拒）
✔ Control：只读查询不需要写权限
✔ Control：session 不一致被拒
✔ Registry：提交动作（dry-run）→ PENDING
✔ Registry：强制 dry-run
✔ Registry：幂等去重 —— 重复 key 返回首次记录，不新增、不重复执行
✔ Registry：action_id 重复直接失败 / 过期命令 FAILED / 无控制权被拒 / 只读动作豁免
✔ Registry：dry-run 全流程（PENDING→…→SUCCEEDED），executed=false
✔ Registry：需确认动作未确认停在 VALIDATING，确认后 dry-run 可完成
✔ Registry：confirm 后 dry-run 可完成 / 终态不能重复执行
✔ Registry：非 dry_run 真实执行被明确拒绝（M1 不实现）
✔ Registry：取消 / 不能取消别人的 / 终态不能取消
✔ Registry：超时扫描 → TIMEOUT / NEEDS_RECONCILIATION
✔ Registry：断线进入 NEEDS_RECONCILIATION 后禁止盲目重放
✔ Registry：控制权切换时取消旧控制器所有未终结动作
✔ Registry：紧急停止取消所有未终结动作
✔ Registry：状态迁移审计历史完整 / stats 正确
✔ HTTP：/health、未获控制权 409、acquire→submit→dry-run→查询完整审计
✔ HTTP：重复 key 不新增记录 / 控制权切换与紧急停止 / 需确认动作 / 坏 JSON / 未知动作 / 取消 / 404
# tests 42 / pass 42 / fail 0
```

### 5.2 HTTP 端到端演练（`demo-m1-http.mjs` 真实起服务）

```
① GET /health → {"ok":true,"service":"blind-whale-survivor-controller","mode":"SUPERVISED","dry_run_only":true}
② 未获控制权提交动作 → 409 CONTROL_NOT_HELD 没有控制器持有写权限
③ acquire → lease {controller_id:"C1",session_id:"S1",mode:"SUPERVISED",expires_at:…+30s}
④ 提交采集10树枝 → PENDING（需确认:false）
   dry-run → SUCCEEDED  结果 {"dry_run":true,"executed":false,"action_type":"gather_resource"}
   迁移: PENDING → VALIDATING → ACCEPTED → RUNNING → SUCCEEDED
⑤ 重复 idempotency_key → duplicate:true 指向 a1（未新增记录）
⑥ 砍树（需确认）未确认 → VALIDATING CONTROL_MODE_DENIED
   confirm 后 → SUCCEEDED，迁移完整
⑦ emergency-stop → mode=EMERGENCY_STOP，取消 1 个未终结动作
   停止后提交 → EMERGENCY_STOP；clear → SUPERVISED
⑧ 执行记录：5 条全部 dry_run=true，SUCCEEDED 2 / FAILED 2 / CANCELLED 1

验收：全部记录都是 dry_run ✓  没有真实执行 ✓  重复命令未新增记录 ✓  控制权/紧急停止程序层生效 ✓
```

## 6. M1 验收（对照任务书「当前开发任务」12 项）

| # | 要求 | 结果 |
|---|---|---|
| 1 | 检查 Phase 2 命令队列 | ✅ 已读代码 + 实测 36 用例 |
| 2 | 检查 Phase 3 MCP 工具注册 | ✅ 已读代码 + 实测 68 用例 |
| 3 | 检查 Phase 4 Agent 工具调用 | ✅ 已读代码 + 实测 110 用例 |
| 4 | 创建统一 Action Protocol | ✅ 9 态 + 全字段 + 17 白名单 |
| 5 | 建立 Control Manager | ✅ 5 模式 + Lease + 人工接管 + 紧急停止 |
| 6 | 建立 Action Registry | ✅ 幂等/状态机/取消/超时/需协调/审计 |
| 7 | 实现动作权限验证 | ✅ `assertCanExecute` 程序层，submit 强制校验 |
| 8 | 实现人工接管状态 | ✅ MANUAL 最高优先级，撤销 lease |
| 9 | 实现紧急停止接口 | ✅ 同步生效，取消全部非终态，拒绝新提交 |
| 10 | 实现动作执行记录 | ✅ 完整 history + stats + HTTP 查询 |
| 11 | 实现 Dry Run 测试 | ✅ 42 单测 + HTTP 端到端演练，`executed:false` |
| 12 | 验证重复命令不会重复执行 | ✅ 幂等去重，重复 key 不新增记录 |

**M1 不允许执行真实动作** —— 全程未连游戏、未调 Lua、未调 Bridge 写接口。

## 7. 运行方式

```powershell
cd survival
npm install
npm run build
npm test                        # 42 个用例
node test/demo-m1.mjs           # 纯逻辑演练
node test/demo-m1-http.mjs      # HTTP 端到端演练
```

## 8. 未完成 / 风险（如实）

1. **M1 是独立模块**，还没有接入 Phase 3 MCP Server、Phase 4 Agent、Phase 2 Bridge。
   接入是 M2+ 的事，接入前 externals 无法感知控制权 —— 这是**当前最大的架构缺口**。
2. **没有 Lua Action Executor**（任务书 §8）。M1 不碰 Lua，`scripts/actions/` 与 `scripts/validation/` 尚未创建。
3. **没有真实状态前置校验**（玩家是否死亡/忙碌/冻结、目标是否有效、路径可达、工具充足）—— Action Validator（§9）留到 M2+ 结合真实游戏数据实现。
4. **`expected_state_sequence` 目前只校验格式**，没有与真实 `acknowledged_sequence` 比对（需要 Bridge 数据，M2+）。
5. **控制权只在 Node 内存里**，进程重启即丢失；任务书要求「Bridge、MCP Server、Lua 执行端都验证」——目前只在 Controller 一处，M2+ 必须做**跨层一致性**。
6. **没有认证**：HTTP 门面目前是本机 dry-run 调试用，未接 token（`controllerApi.ts` 的 `createController` 没传 token 参数）。正式暴露前必须补。
7. **游戏没在运行**，所以「动作执行记录」是 dry-run 记录，不是游戏侧真实回执。

## 9. 下一步（M2 预告）

角色移动系统。但在动 M2 之前必须先解决 §8 第 1、5 条：
- 把 Control Manager 接到 Phase 3 MCP Server（新增 `get_control_status` 等工具）；
- 把控制权状态持久化到 Bridge，并让 Lua 执行端在**每个动作执行前**再校验一次（跨层一致，不能只信 Node 内存）。
- 然后才研究 `ACTIONS` / `BufferedAction` / `locomotor` 的当前构建版本实际 API。

M1 到此为止，等待确认后再进入 M2。
