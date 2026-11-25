# 变更日志 (Changelog)

所有关键架构演进与版本改动均记录于此。

---

## [Phase R8.5] - 2026-11-25

### 温蒂伴生战斗闭环：蜘蛛 / 青蛙防御与阿比盖尔主动参战 (Wendy Companion Defense)

真机问题：温蒂背包有阿比盖尔之花却一直没召唤；青蛙靠近时 Lua Reflex 反复 flee（生命 150→130）；
三只青蛙时 `advance_task` 被 `reflex_active` 阻断；花朵被青蛙命中击落在地面 `(25,-58)` 后无法捡回。

- **Reflex → Battle 接线**：`reflex.lua` 不再只对猎犬启动防御，改为"`B.STRATEGIES` 里 supported 的
  任何敌人"（含普通蜘蛛 / 蜘蛛战士 / 新增青蛙）都先尝试 `B.StartDefense`；召唤交接有界（8 秒或血量 <35%
  立即回退逃跑），绝不永久禁用 flee。
- **抢占矩阵（P0）**：`actions/core.lua` 新增唯一判定 `A.may_preempt()` 与 `A.DEFENSE_ID="defense"`：
  只有"防御交接"能打断 Reflex flee（且黑暗照明 / 回血优先 / 召唤进行中一律拒绝），
  其余非 defense 指令对 Reflex 的保护**一条没放宽**；交接时显式清空旧 job + BufferedAction。
- **统一召唤入口**：`battle.lua` `StartDefense` 不再自己 `BufferedAction(CASTSUMMON)`，改为
  `A.Start("summon_companion", {}, "defense")`，复用 `JOBS.summon_companion` 的契约检查 / 花朵检查 /
  `summon_succeeded` 核验 / `summon_timeout`；失败带 20 秒退避，禁止无限重试。
- **真正落实 avoid_melee**：`battle.lua` ATTACK 阶段在伴生可协助时**绝不**调用玩家 `ACTIONS.ATTACK`，
  改为位置维持 + 监控；战斗有效性以"目标血量下降"为证据（`companion_hits`），结算如实写"阿比盖尔打倒了 X"。
- **青蛙策略**：新增 `STRATEGIES.frog`（100 血 / 攻速 1s / 会击落背包物品 / 会被同伴共享目标），
  不复用蜘蛛的 2 连击；群体容忍改为只统计"真的在打温蒂"的敌人，伴生健康时允许 ≤3 只受控群战，
  超过 3 只 / 伴生 <40% / 自身 <50% 立即回退保命。
- **伴生状态可核验**：`companion.lua` 补 `guid / target_guid / distance_tiles / defensive_range`；
  协助半径修正为 `ABIGAIL_DEFENSIVE_MAX_FOLLOW × 2`（原实现误乘 4）；新增 `FindDroppedFlower()`。
- **花朵保护与回收**：`pickuprules` 允许拾取 `abigail_flower`；`targetrules` + Node `target-kinds`
  新增 `abigail_flower` kind（同一套 target-kind / Guard / Dispatcher 流程，未新开通道）；
  `guard.lua` 禁止 AI 主动 `drop/fuel/add_fuel` 阿比盖尔之花（`critical_item_protected`）；
  Reflex 空闲时走既有 `pickup` 回收并核验背包。
- **可观测性**：`[BATTLE] DEFENSE_CANDIDATE / DEFENSE_HANDOFF / DEFENSE_ENGAGE / DEFENSE_ABORT /
  COMPANION_TARGET / COMPANION_GROUP_ENGAGE / REFLEX_SUPPRESSED`，`[COMPANION] SUMMON_STARTED /
  SUMMON_SUCCEEDED / SUMMON_FAILED / FLOWER_DROPPED / FLOWER_RECOVERED`、`[ACTIONS][PREEMPT]`（限频）。
- **构建标识**：`modinfo` 0.41.2 → **0.41.3**；新增 `Whale.build = "0.41.3+r8.5-wendy-defense"`，
  加载时打印 `[BUILD] ...`，状态文件透传 `build` 字段（`get_state` 也会显示），
  用于确认"游戏实际加载的是哪一份源码"。
- **测试**：新增 `tests/helpers/lua-harness.mjs`（fengari 统一加载生产 Lua）；新增
  `tests/r85-wendy-defense.test.mjs` TEST-01~10（真实 Lua）；**重写** `tests/battle.test.mjs`
  （旧版是 JS 手写假状态机）；`wendy-companion` 增 WC-8/9/10；同步 `hound-defense` HD-4 与 `nearby` 白名单。
- **真机验收（2026-11-25 第 1 天，青蛙战）**：确认 `[BUILD] 0.41.3+r8.5-wendy-defense` 已加载；
  `SUMMON_STARTED reason=proactive` 证明提前召唤生效；青蛙战时 `DEFENSE_ENGAGE` → `companion_led=true` →
  `REFLEX_SUPPRESSED` → `COMPANION_TARGET hits=1 hp=85`，两只青蛙被阿比盖尔打死、温蒂只掉 10 血且**没有玩家 ATTACK**；
  花朵被击落后用既有 `pickup_nearest` 成功捡回。
- **真机缺陷修复**：战斗 job 被 `A.Tick` 的 `budget_exceeded` 结束时，`battle` 会话不会收尾
  （日志只剩每秒 `REFLEX_SUPPRESSED`、`active_target` 悬挂）。修复：`core.A.Tick` 对 `fight_spider`
  显式 `Whale.battle.Abort("budget_exceeded")`；`battle.lua` 增加 `MAX_SESSION_S=45` 硬上限与
  `STALL_ABORT_S=8`（伴生主战连续无伤害 → `companion_stalled`）。新增 `BATTLE-LUA-08/09/10`。
  **需重新读档生效**。
- 说明：`npm test` 只证明源码逻辑；真实游戏场景 A（普通蜘蛛）与 C/D（伴生失效、危险中断）仍待补，
  记录见 `docs/R8.5-WENDY-DEFENSE.md` §7。

---

## [Phase R8.4] - 2026-11-24

### Autopilot 高层任务驱动与原子工具收口 (Autopilot High-level Task Drive & Atomic Tool Isolation)

最终标准：**Autopilot 模式下模型只负责制定和监督高层目标，`advance_task` 负责驱动现有任务执行系统，底层原子动作仍由 `SkillExecutor` 和 `Dispatcher` 安全执行。**

- **工具隔离（模型层）**：`lib/tools.js` 新增 `AUTOPILOT_TOOL_WHITELIST`（`advance_task / get_state / get_guide / update_notes / stop`）与 `isToolAllowedInMode()`；`toolList(mode)` 对 Autopilot 只返回这 5 个高层接口，Assisted/Manual 返回完整工具集（原子动作 + `run_skill` + `advance_task`）。未知/非法模式安全回退为 Autopilot 白名单（不再意外放开全部工具）。
- **入口纵深防御**：`executeTool` 在进入任何 `dispatcher` 之前加一道闸门——Autopilot 下直调原子动作 / `run_skill` 会被固定文案拒绝：`Autopilot 模式下不允许模型直接调用原子动作，请使用 advance_task 推进当前 Task Board 任务。`；`stop` 始终可用。该闸门**只作用于模型直调层**，`SkillExecutor → Dispatcher` 的内部派发（internal）不经过 `executeTool`，因此绝不会误伤内部执行链。
- **提示词分离**：`lib/index.js` 的 `buildInstructions(guides, mode)` 改为模式感知——Autopilot 使用新的 `AUTOPILOT_RULES`（复用 `RULES` 的共享生存常识/MCP 说明，只把开头原子动作手册换成"高层任务驱动"：开局 `get_state` 一次 → 反复 `advance_task`（max_steps 默认 8）→ 读回执 `stop_reason` 决策）；删除"拥有完整原子动作工具集""任务看板只是建议"等冲突文案；Assisted/Manual 保留原完整动作手册 `RULES`。
- **入口统一**：F8（`AiRunner`）、MCP（`tools/list` / `initialize` / `tools/call`）、DSH gateway（`help` / dst 工具）全部经 `toolsForExecutionMode(config)` 与 `buildInstructions(guidesOf(config), mode)` 解析，提示词 / 工具列表 / 服务端权限三者由构造方式保证一致。
- **advance_task 审计**：确认 `WorldRuntimeManager.advanceTask()` 多动作循环有界（动作预算 ≤10，总 tick ≤ `预算×3+10`，`REPEAT_FAIL_LIMIT=3`），每 tick 至多下发一个原子动作，`AbortController` 全链路可中断；`revive / reflex / survival / unknown / blocked` 由 `TickOnce` 原样上报；结构化报告含 `world_key / task_id / skill_id / instance_id / step / actions_executed(每动作 status+verified) / budget_used / budget_remaining / stop_reason / failed_action`。日志上模型层 `advance_task` 调用与内部 `[AUTOPILOT] STEP_DISPATCHED` 原子派发分开可辨。
- **测试**：新增 `tests/r84-autopilot-isolation.test.mjs`（TEST-01~TEST-10：工具裁剪 / 非法模式回退 / 拒绝文案 / 提示词分离 / 入口统一 / 内部执行链不被误伤）；更新 `tests/autopilot-runtime.test.mjs`（AUTOPILOT-01/02）、`tests/mcp-dynamic-tools.test.mjs`（MCP-01/05）、`tests/r74-agent-parity.test.mjs`（D1/D3）到 R8.4 契约。Node 侧改动，不涉及模组 Lua。

---

## [Phase R.7.4.2] - 2026-11-21

### 内置 AI 无动作：Autopilot 提示词与工具列表不一致 (Autopilot Prompt Parity)
- 真机日志 `latestLogs/session.txt`：F8 内置 AI 每轮 `THINK ... 动作数=0`、`toolCalls: []`，只回自然语言，6 次后 `idle_give_up`，角色没有任何动作；
- 根因：Autopilot 模式下 F8 实际只暴露 `advance_task / get_state / get_guide / update_notes / stop`，但系统提示词仍是"直接调用 `move_to / harvest_nearest` 等 40 个原子动作"的手册 → 模型按提示去调**本模式未开放**的动作，一个都调不出来；
- 修复：`lib/index.js` 新增模式感知的 `buildInstructions(guides, mode)` 与 `AUTOPILOT_RULES`：Autopilot 明确"**只能通过调用工具行动**、用 `advance_task` 推进任务、不要调底层原子动作"，可用工具清单从 `toolList('autopilot')` 动态生成；Assisted/Manual 仍保留完整动作手册；F8 与 DSH 都按当前 `executionMode` 生成提示词（提示词 / 工具列表 / 服务端权限三者一致）；
- `lib/agent.js`：模型首次"无 tool call"时给出一次**接口层纠偏**（列出当前可用工具并要求调用 `advance_task`），不自动执行游戏动作、不绕过 `runTool()`；
- 更新测试 `tests/r74-agent-parity.test.mjs`（新增 D3：Autopilot 提示词一致性；强化 E1：空转纠偏提示）；Node 侧改动，不涉及模组 Lua，模组版本保持 0.41.1。

### 走位→采集之间的数秒空转排查与优化 (Inter-action Idle)
- 真机日志（`session.jsonl` 结构化时延）拆分：`move_to` 动作本身 `ms=5141`（真实走路），走到后到下一次 `harvest_nearest` 之间约 **4.3s** 是**模型的一整轮推理**（`THINK ~4-6s`）；因 `freezeTime=false`（世界不暂停），角色在这段时间站着不动，看起来就是"走到物资前停好几秒才捡"；
- 放大因素：保命反射抢吃导致 `target_gone` / `not_in_inventory` 反复重试，叠加更多空转；
- 优化：`lib/tools.js` 的 RULES 鼓励把**确定性的连续步骤放同一条回复里一起发**（例如先 `move_to` 再 `harvest_nearest/pickup_nearest/gather_area`），系统按序执行，省掉两步之间的模型空转；`#N + snapshot_id` 的动作不跨步连发（移动后快照失效）；
- 说明：Autopilot（`advance_task`）本就在一次调用内连续执行多个原子动作、无逐步模型空转，是"自己玩"最顺的模式；Assisted 模式下按此提示词可显著减少停顿。

---

## [Phase R.7.4.1] - 2026-11-21

### 游戏内小窗（HUD）位置与 F8 文案治理 (HUD Placement & F8 Feedback)
- 小窗从屏幕左侧移到**右上角**（`ANCHOR_RIGHT` / `ANCHOR_TOP`），避免与左侧原生 UI（背包/状态/徽标）重叠导致文字被盖住、左半截被裁；
- 面板高度随行数变化时重新把 root 居中，保证右上角内边距恒定；
- 修复 F8 切换后"状态与提示语相反"（想开始却显示"先停下"）：切换后进入 2 秒乐观窗口，标题/提示以本地刚按下的意图为准，不再被插件回写的旧 HUD 文本覆盖；提示语与实际意图严格对应（开始 ↔ 先停下）；
- 插件侧 HUD 文本截断长回执（session/world_key 等），提示行改为 `F8 开始/停止 · F7 显隐`；
- 模组版本 `0.41.0 → 0.41.1`；`tests/lua-mod.test.mjs` 的 HUD 断言更新为右上角锚定语义（保留测试，改为校验 `ANCHOR_RIGHT/TOP` 与面板不越界）。

---

## [Phase R.7.4] - 2026-11-21

### 统一任务执行核心可靠性与 F8 / DSH 接入一致性治理 (Shared Execution Reliability & Agent Parity)

本阶段第一原则：**游戏逻辑只有一套**，不允许 F8 专属或 DSH 专属的游戏策略。F8 与 DSH 只在"模型请求协议 / tool call 解析 / 调用方身份 / Control Lease"上不同，最终都必须汇入同一套 Planner / Runtime / Executor / Dispatcher。

- **P0: 采集距离与 Lua 搜索半径不一致 (Gather Range Consistency)**:
  - `lib/skills/skill-utils.js` 的 `MATERIAL_SPEC` 曾把 `twigs / cutgrass / petals` 写成 `range: Infinity`，而 Lua `gather_area` 默认只在 8 格内搜索；
  - 后果：JS 认为 20 格外的草可采 → 直接 `gather_area` → Lua 找不到 → `rejected` → 上层原地重试；
  - 修复：把"发现范围 / 交互范围 / 采集搜索半径"三个概念拆开，新增命名常量 `LUA_GATHER_SEARCH_RADIUS (8)`、`PICKUP_INTERACTION_RANGE (2.5)`、`WORK_NEAREST_RANGE (6)`，并在注释里标明权威来源是 `gathering.lua`；资源超出搜索半径一律先 `move_to`，到达后由执行器重新读快照再采集；
  - 新增测试 `tests/r74-gather-range.test.mjs`（含 Lua↔JS 半径一致性断言，杜绝再次写成 Infinity）。
- **P0: 紧急生存任务状态传播 (Emergency Status Propagation)**:
  - `lib/planner/task-skill-orchestrator.js` 之前把 `survival_stabilize` 除 `completed / reflex_active` 以外的所有结果都包装成 `survival_in_progress`；
  - 修复：新增 `classifyExecutorStatus()` 明确映射 `completed / reflex_active / blocked / failed / unknown / awaiting_reconciliation / cancelled / timeout / running`，`blocked/failed/unknown/cancelled/awaiting_reconciliation` 原样上报并保留底层 `reason / instance_id / step`，绝不伪装成"仍在执行"。
- **P0: advance_task 重复失败动作保护 (Repeated Failed Action Guard)**:
  - `lib/planner/world-runtime-manager.js` 的 `advanceTask()` 之前把 `rejected` 也当成一次普通动作计入预算，真机出现一整轮 10 次 `gather_area → rejected`、角色原地不动；
  - 修复：明确动作预算计数定义，并对"同一目标+同一动作连续失败 / 连续无进展"设硬上限（连续 3 次即停，`stop_reason = 'repeated_failed_action'`），报告里附 `failed_action` 与 `repeated_failed_action` 字段；`rejected` 不再被视为有效进展。
- **P0: Task Board blocked 状态生命周期 (Blocked Lifecycle)**:
  - `lib/planner/task-board.js` 之前当任务"只写 `blocked_reason`、没写 `blocked_kind`"时，`evaluateBoard()` 会把它无条件重置为 `ready`，形成 `ready→执行→blocked→ready` 无限横跳；
  - 修复：新增统一写入入口 `blockTask()`（结构化 `blocked_kind / blocked_reason`，可带退避 `retryAfterMs`，`attempts` 到 `MAX_ATTEMPTS` 升级为 `failed`）；`evaluateBoard()` 对 `blocked` 任务只有在「依赖满足 / 退避到点 / 显式 resolved / checkPreconditions 通过」时才恢复，`unknown_outcome / cancelled` 为永久保护；
  - Orchestrator 的 blocked/failed/unknown/cancelled/timeout 全部改为结构化回写，不再散落直接赋值。
- **P1: F8 与 DSH 工具列表模式一致 (Tool List Parity)**:
  - `lib/index.js` 之前把裸函数 `toolList` 传给 `AiRunner`，`this.toolList()` 无参调用永远回退 `autopilot`，导致 F8 在 Assisted/Manual 下只看到 Autopilot 工具；
  - 修复：新增 `toolsForExecutionMode(config)`，F8 与 DSH 两个入口都通过它按当前 `executionMode` 解析工具表（构造上保证一致）；新增 `tests/r74-agent-parity.test.mjs` 覆盖三种模式与源码回归守卫。
- **P1: F8 无 tool call 诊断与有界重试 (No-tool-call Governance)**:
  - `lib/agent.js` 对"模型只回自然语言、没有 tool call"的情况补充 `NO_TOOL_CALL` 诊断日志（步骤 / 调用数 / 重试次数 / 内容摘要）与会话日志；不把自然语言当成动作已执行；`IDLE_GIVE_UP` 有界，达到上限主动停止；
  - 未新增任何"仅对 F8 生效"的隐藏自动执行 fallback，未在 AiRunner 内绕过 `runTool()` 直连 Dispatcher/Lua。
- **P1: 夜间照明判断 (Night Lighting)**:
  - `lib/skills/skill-utils.js` / `lib/planner/survival-priority.js` 明确区分 `player.in_light`（实际光照）、附近光源、背包便携光源、手上/头上光源：**背包里带火把不等于玩家被照亮**；只有 `player.in_light` 或手上/头上可用光源才算安全，否则夜间触发 P0 并优先 `equip`；
  - 白天/黄昏的备光由 `lib/plan.js` 的 `prep_light` 目标负责（材料充足但未成光源时仍提示制作），夜间由 `light` 目标负责，避免黄昏就点火把烧燃料。
- **测试与验证**:
  - 新增 `tests/r74-gather-range.test.mjs`、`tests/r74-emergency-status.test.mjs`、`tests/r74-blocked-lifecycle.test.mjs`、`tests/r74-agent-parity.test.mjs`，覆盖任务书要求的回归测试 A / B / C / D / E / F；
  - 保留 R.7.3 全部执行安全机制（owner 身份传播、Control Lease、Lua Guard、Stop 取消与隔离、unknown/awaiting_reconciliation 保护、过期快照与目标保护、Dispatcher 唯一出口）。

---

## [Phase R.7.3] - 2026-11-20

### 复合执行链控制权与运行时可靠性治理 (Runtime Execution Integrity & Control Ownership)
- **P0: 复合技能控制权身份透传 (Control Ownership Propagation)**:
  - 修复复合技能调度链（`advance_task` / `run_skill` -> `WorldRuntime` -> `TaskSkillOrchestrator` -> `SkillExecutor` -> `Dispatcher` -> `LeaseManager` -> `GameBridge`）中控制权身份丢失的问题；
  - 严格以每次调用的调用参数形式向下传递 `{ owner, ownerInstanceId }`，严禁在 `WorldRuntime` 单例内部使用可变对象级状态存储调用者身份，防止并发调用间身份串用；
  - 确保下发至 Lua 的命令信封（`envelope`）中完整包含 `requested_by`、`owner_type`、`owner_instance_id`，MCP 客户端以 `mcp_client` 身份下发，内置 AI 以 `f8_agent` 身份下发，系统自主调度以 `system` 身份下发。
- **P0/P1: 终态 `unknown` 保护与对账防重发防激活 (Terminal State Protection & Anti-Replay)**:
  - 将 `unknown` 明确纳入任务与技能实例终态保护集合（与 `completed`, `failed`, `cancelled` 并列）；
  - `activeInstanceForTask`、`instanceOf` 以及 `SkillExecutor.run()` 识别 `unknown` 实例后拒绝重置为 `in_progress`，拒绝重新 dispatch 原子动作，直接返回 `{ status: 'blocked', reason: 'task_outcome_unknown' }`；
  - `TaskSkillOrchestrator.tickOnce` 与 `executeTask` 识别 `unknown` 结果后将 Task Board 看板对应任务置为 `blocked` (`blocked_reason = 'task_outcome_unknown'`) 并持久化；
  - 新增显式人工对账解决机制 `resolveUnknownTask(taskId, { instanceId, commandId, resolution, evidence })`，严格校验 `commandId` 与 `instanceId` 匹配性，支持 `'completed'`, `'abandoned'`, `'unexecuted'` 三种显式闭环。
- **P0/P1: `unverified` 状态与对账闭环 (Unverified Handling & Reconciliation)**:
  - 严格区分 `unverified` 与普通单步失败：当游戏返回 ok 但快照核验未通过时（`outcome.status === 'unverified'`），绝不作为普通失败立即重发新动作，而是进入 `awaiting_reconciliation`；
  - 在后续轮次中比对最新快照：若快照中观察到真实生效证据（如背包物品增加、位置到位、建筑出现），立即推进完成并不重复下发；若 3 次对账预算耗尽仍未证实，转为受保护的终态 `unknown`。
- **P0/P1: Stop 取消闭环与过期命令围栏 (Stop Cancellation Closed-Loop & Quarantine Fencing)**:
  - 在 `GameBridge` 中为 HTTP 待提取队列注册 `signal` 取消监听器，当命令在下发前已被取消或排队期间收到 abort 信号时，立即从 `pendingHttpCommands` 队列中剔除，防止其被 Lua 模组在下一次轮询中执行；
  - `WorldRuntime.stop()` 强化锁协调超时处理：当持有锁的执行线程在超时时间内未能退出并释放锁时，激活 `quarantined = true` 与 `cancelRequested = true` 隔离屏障，彻底阻断任何后续新任务的执行；直至持有者在 `finally` 中真实释放锁后，才自愈解除隔离；
  - 在 Lua 端 `actions.Start('stop')` 验证闭环：当下发 stop 动作时，立即调用 `stop_actions(p)` 打断在行动作并向 Bridge 报告前置任务被打断失败，随后在下一 tick 完成 `stop` 并上报；若在行动作为 Reflex 保命动作，则严格拒绝打断，保证 Reflex 保命优先权。
- **P1: 32格雷达、资源过期与食物效用对齐**:
  - `known_resources` 补齐时间戳、状态（`observed`, `verified`, `inaccessible`）、`confidence` 与失败次数；
  - `explore-utils.js` 引入 `recordResourceFailure` 失败反向传播，对超过 300 秒未验证或确认不可达的资源进行剔除；
  - 食物决策层完善负面 Sanity 过滤与饱食度 0 过滤，生肉/青蛙腿等扣脑残食物在 Sanity 模式下严格拒绝（返回 -9999），无饱食度花瓣在饥饿模式下严格拒绝。
- **测试与验证**:
  - 全量自动化测试达到 **1057/1057 全部通过** (0 失败、0 跳过、0 错误)，较上阶段净增 21 个高覆盖率专项测试用例。

---

## [Phase R.7.2] - 2026-11-20

### 执行安全与生存稳定性收尾 (Execution Safety & Survival Stability Closing)
- **动作与移动平滑度优化（Issue 1 & 2）**：
  - **位移到达判定阈值收紧**：将 `movement.lua` 中 `move_to` 默认到达判定从 0.8 格收紧至 0.35 格（约 1.4 世界单位），进入原生拾取/采摘臂展范围 (< 1.5 单位)，彻底解决角色跑至附近骤停、紧接着再次起步走位才采/捡的断层问题；同步收紧障碍重试停靠距离（0.8 格）与 `go_to`（0.5 格）；
  - **采集动画打断防重推保护**：重构 `gathering.lua` 中 `gather_area` 的 `is_acting` 判定，新增 `locomotor.bufferedaction` 与 stategraph `doing` 状态标签感知；将重推窗口从 0.8s 延长并严格限制在非执行状态（`not is_acting and waited > 2.5`），彻底根除采摘动画刚播放即被自我重推打断、导致必须做两次动作才采下物品的严重冲突。
- **ISSUE-01: Stop 与 Runtime Mutex 安全协调机制**：
  - `WorldRuntime` 引入递增 `generation` 与 `lockOwnerId` 锁所有权体系，确保锁只能由当前持有者释放，杜绝旧任务 `finally` 误放新任务锁；
  - `stop()` 升级为原子协调流程：标记 `cancelRequested`，清空排队任务，通过 `AbortController` 向全链路（Runtime -> Orchestrator -> SkillExecutor -> Dispatcher -> Bridge）广播取消信号；
  - 下发底层的 `stop` 动作，严格保护 Lua 侧 Reflex 保命抢占（Reflex 正在执行时普通动作与 stop 均不可中断保命行为）；
  - 定义严格的 Stop 状态（`not_started`, `cancel_requested`, `in_flight`, `cancelled`, `completed`, `unknown`），超时必须如实返回 `unknown`，不得伪装成功。
- **ISSUE-02: `unknown` 结果对账与防重复执行**：
  - 当底层动作返回 `unknown` 或 `result_timeout` 时，实例进入 `awaiting_reconciliation` 状态，完整保留 `command_id`、`tool`、`args`、`issued_at` 等身份；
  - 严禁在结果未定时重复下发具有副作用的动作（如 `build`, `craft`, `eat`, `pickup`, `harvest`, `chop`, `mine`）；
  - 下一轮推进时优先通过新鲜快照与真实证据进行对账（如建筑是否生成、物品是否入包、血量/饥饿是否变化）；3 次对账仍无法确认时才进入终态 `unknown` 并上报。
- **ISSUE-03: `seek` 寻食预算全链路贯穿**：
  - 将 `plan.budget_s: 15` 从 Plan -> SkillExecutor -> WorldRuntime -> Dispatcher -> Bridge -> Lua Envelope 完整透传；
  - Dispatcher 动态根据 `budget_s` 计算有效超时时间（`budget_s * 1000 + 15000` 缓冲），杜绝上层先于游戏执行超时的截断问题。
- **ISSUE-04: 食物需求分类与精确评估 (Hunger / Health / Sanity)**：
  - 食物选择器严格区分 `hunger`、`health`、`sanity` 需求，饥饿模式下严格过滤饱食度为 0 的物品（如花瓣 `petals`），杜绝误吃花瓣充饥；
  - 综合考量营养缺口匹配度与新鲜度（`freshness * 50`），并与 Lua 模组 `eatrules.lua` 逻辑严格对齐。
- **ISSUE-05: 食物目标熔断器安全恢复机制**：
  - 区分暂时性失败（`reflex_active`、`actor_busy`、`result_timeout`、`awaiting_reconciliation` 不计入熔断）与永久性失效（`target_gone` 直接注销）；
  - 移除失败次数永久拉黑，熔断锁定状态随冷却时间自然到期恢复；
  - 实现定时清理器 `purgeExpiredFailures()`，设置 120 秒 TTL 并将失败记录上限限制为 50 条，避免内存泄漏。
- **ISSUE-06: MCP 工具列表动态变更推送与模式切换**：
  - 实现客户端 SSE 列表变更通知 `notifications/tools/list_changed`（`listChanged: true`）；
  - 模式切换后即时向客户端广播工具刷新通知，服务端 `executeTool` 保持同步拦截。
- **测试与验证**：
  - 新增 6 大核心测试套件（`tests/stop-mutex-concurrency.test.mjs`、`tests/unknown-reconciliation.test.mjs`、`tests/seek-budget-propagation.test.mjs`、`tests/food-effects-decision.test.mjs`、`tests/food-circuit-breaker-recovery.test.mjs`、`tests/mcp-dynamic-tools.test.mjs`），共 42 例新增专项测试。
  - 全量自动化测试达到 **1028/1028 全部通过**（1028 pass, 0 fail, 0 skipped）。

---

## [Phase R.7] - 2026-11-20

### 自主任务执行运行时集成与治理：WorldRuntime、advance_task 与生存紧急仲裁 (Autopilot Runtime Integration)
- **WorldRuntimeManager 与权威执行上下文**：
  - 新增 `lib/planner/world-runtime-manager.js`，管理世界级权威上下文与并发互斥锁（Mutex），同 `world_key` 共享单例 Runtime，杜绝跨世界记忆与执行串扰。
  - 接入 `advance_task` MCP 工具，打通 LLM -> `advance_task` -> `WorldRuntime` -> `Orchestrator.tick()` -> `SkillExecutor` -> `Dispatcher` 完整调度链路。
  - 支持多步骤动作连续预算调度（`budget_used` / `budget_remaining`），返回包含真实快照证据、执行轨迹与生存警报的结构化核验报告。
- **生存紧急仲裁与 Reflex 协作调度**：
  - 在 `lib/planner/task-skill-orchestrator.js` 中完善 P0/P1 生存危机（饥饿、黑夜无光、低血、Reflex 逃脱）仲裁逻辑。
  - 当触发危机时自动挂起（`paused`）当前任务实例，内部调度 `survival_stabilize` 或让位 `lua_reflex`；危机解除后无缝恢复原任务实例与上下文（保持相同的 `instance_id` 与参数，不重复重放动作）。
- **结构识别与 Prefab 规范化**：
  - 新增 `lib/planner/prefab-utils.js`，统一科技建筑与基础容器（`sciencemachine`/`researchlab`、`alchemyengine`/`researchlab2`、`chest`/`treasurechest`）的别名映射与 `matchStructure` 判定，彻底解决逻辑配方名与游戏原生 Prefab 之间的不一致问题。
- **安全食物选择器与熔断机制**：
  - 新增 `lib/skills/food-candidate-selector.js`，严格过滤危险食物并基于新鲜度和饱食度智能排序，增加连续采集/进食失败的熔断器保护，避免陷入无限尝试死循环。
- **运行模式控制与 stop 应急工具**：
  - 实现 Autopilot / Assisted / Manual 三种运行模式，动态过滤 `tools/list` 并通过 `executeTool` 服务端进行严格权限拦截，防止模型绕过看板调用底层原子指令。
  - 新增 `stop` 应急工具，支持最高优先级主动打断当前运行中的任务与底层 Dispatcher 命令。
- **测试与验证**：
  - 新增 4 个核心测试套件（`tests/advance-task-budget.test.mjs`、`tests/emergency-survival-orchestration.test.mjs`、`tests/food-candidate-circuit-breaker.test.mjs`、`tests/prefab-structure-identification.test.mjs`），并全面适配生命周期与调度器断言。
  - 全量自动化测试达到 **986/986 全部通过**（986 pass, 0 fail, 0 skipped）。

---

## [Phase R.6] - 2026-11-19

### 实例身份与生命周期：Task ID 与 Skill Instance ID 分离与真实重试 (Task Identity & Instance Lifecycle)
- **Task ID 与 Skill Instance ID 彻底分离**：
  - `lib/planner/world-memory.js`：将 `skill_instances` 从以 `skill_id` 为键升级为以 `instance_id` 为全局物理唯一键，根节点增加 `active_skill_instance_id`。通过 Proxy 包装层 `wrapSkillInstances` 保持向后兼容老代码对活动实例的直接读取。
  - `lib/skills/skill-executor.js`：`newInstance()` 生成具有唯一性的 `instance_id`，并记录 `task_id`、`skill_id`、`skill_args`、`status`、`step_index`、`step_attempts`、`step_calls`、`created_at`、`updated_at`、`failed_at`、`completed_at`。
  - 同一技能类型的多个不同任务（如 `gather_log`、`gather_rocks`、`gather_goldnugget`）各自绑定独立 `instance_id`，参数相互隔离，彻底根除跨任务串实例、串参数问题。
- **失败重试真实执行**：
  - 任务失败时保留失败原因与历史实例，不再覆盖旧实例。
  - 任务进入看板冷却，冷却期满后 Orchestrator 针对该任务分配全新 `instance_id` 重新调度，保留原 `skill_args`。
  - 重新读取最新快照，真实调用 Dispatcher 下发动作（调用计数 > 0），杜绝直接返回 failed 或重放历史动作。
  - 达到最大尝试次数（`MAX_ATTEMPTS`）后任务正式进入永久 `failed`。
- **调度边界与互斥保障**：
  - 单角色单活动实例互斥：`#pauseOthers()` 保证全系统同一时刻只有一个活动实例控制角色。
  - `run_skill` 支持显式 `task_id`，缺省默认为 `manual:${skillId}`，与自动调度实例彻底隔离。手动操作结束后，自动调度可安全恢复原自动任务。
  - `get_state` 绝对保持只读，不产生任何动作下发副作用。
  - 跨世界实例严格物理隔离，切换世界后绝不恢复其它世界的实例。
- **测试与验证**：
  - 新增 `tests/task-instance-lifecycle.test.mjs`，包含 LIFECYCLE-01 至 LIFECYCLE-16 全部 16 个场景以及 LIFECYCLE-INTEGRATION 三资源连续采集集成验证。
  - 全量自动化测试达到 **959/959 全部通过**（959 pass, 0 fail, 0 skipped）。

---

## [Phase R.4] - 2026-11-19

### 决策收敛：Planner 决策仲裁与 plan.js 纯粹化 (Planner Core Pureification)
- **仲裁梯队明确**：
  - P0/P1 生存绝对抢占，优先使用生存规则引擎保障角色安全。
  - P2/P3 统一驱动 Task Board 阶段任务。
  - P3/P4 负责开局基本生存、存粮与探索兜底。
- **plan.js 纯粹化**：
  - 移除中长期建造与高级装备制造规则，全面移交 Task Board。
  - `get_state` 纯只读渲染单一统一决策计划块。
- **测试与验证**：
  - 新增 `PLAN-R4-1`、`PLAN-R4-2`，全量测试达 943 项全绿。

---

## [Phase R.3] - 2026-11-19

### 记忆规范与自愈：World Memory Schema 统一与版本自愈升级 (World Memory Governance)
- **Schema 统一与校验**：
  - `emptyMemory` 显式补齐所有持久化契约字段：`schema` (`bws.world-memory/1`)、`worldKey`、`camp_site`、`backup_site`、`home_building_id`、`home_anchor`、`current_stage`、`current_goal`、`active_skill_id`、`task_board`、`skill_instances`、`explored_regions`、`known_resources`、`completed_milestones`、`blocked_tasks`、`danger_zones`、`known_buildings`、`recent_failures`、`updatedAt`。
  - 新增 `SUPPORTED_SCHEMAS` 与 `validateMemory(memory)`，提供完整的结构有效性与字段类型校验。
- **平滑升级与数据自愈**：
  - 新增 `migrateMemory(raw, targetSchema)`，平滑支持旧版本与未标记 schema 的旧世界记忆数据升级为 `bws.world-memory/1`（记录 `_migrated_from`）。
  - 对 NaN / 非法浮点数坐标、超出范围的 stage、异常的数组/对象结构进行防御性自愈清洗，杜绝记忆被脏数据破坏或整份丢失。
  - `createWorldMemoryStore#load` 读到旧格式或自愈后自动落盘升级。
- **测试与验证**：
  - 在 `tests/world-memory.test.mjs` 中新增 `WM-11`（校验与迁移自愈）与 `WM-12`（读取旧文件落盘自愈）。
  - 全量回归测试从 939 增至 941 项全绿。

---

## [Phase R.2] - 2026-11-19

### 架构收敛：Task Board 与 Skill Executor 架构收敛 (Orchestrator Convergence)
- **新增模块**：
  - `lib/planner/task-skill-orchestrator.js`：实现 `TaskSkillOrchestrator`，作为 Task Board 与 Skill Executor 的权威调度器。
  - `tests/task-skill-orchestrator.test.mjs`：新增 14 项完整端到端测试，覆盖任务启动、参数传递、实例恢复、防重复、单技能互斥、生存抢占与恢复、完成/失败记录、世界隔离、步骤防重放、`get_state` 纯读与状态一致性。
- **重构与收敛**：
  - 明确四大系统边界：Planner（阶段/目标/策略）、Task Board（任务注册/依赖/优先级/状态/证据）、Skill Executor（实例状态机/步骤原子动作/真实快照核验）、Orchestrator（桥接调度）。
  - 收敛建家任务定义：`lib/skills/establish-home.js` 统一维护 `establishHome` 复合技能，`establish-home-adapter.js` 保留看板任务适配。
  - 收敛资源采集任务定义：`lib/skills/gather-resources.js` 统一维护 `gatherResources` 复合技能，`gather-resources-adapter.js` 保留看板任务适配。
  - 任务数据结构统一：支持 `id`, `title`, `status`, `priority`, `skill_id`, `skill_args`, `depends_on`, `completion_evidence`, `blocked_reason`, `attempts`, `progress`。
  - 实例共享：`run_skill` 与自动调度共享同一个 `SkillExecutor` 实例。
  - 日志规范化：统一三层日志 `[TASK]`, `[ORCHESTRATOR]`, `[SKILL]`。
- **文档更新**：
  - 更新 `docs/ARCHITECTURE.md`、`docs/STATUS.md`、`docs/archive/audit/REFACTOR_ROADMAP.md`（将 ISSUE-01 与 ISSUE-02 标记为已解决）。
- **测试指标**：
  - 全量 939 项单元与集成测试 100% 通过（0 失败、0 跳过）。

---

## [Phase R.1] - 2026-11-19

### 缺陷修复：打通技能参数传递 (Skill Args Passing)
- **修复**：
  - `lib/skills/skill-executor.js` 支持在 `run()` 时传入 `skill_args` 并持久化到 `inst.data.skill_args`。
  - `lib/tools.js` 在 `run_skill` 工具中正式声明 `skill_args` 输入字段并完整透传。
  - `lib/skills/gather-resources.js` 优先使用动态传入的目标物品和配方。
- **测试**：
  - 新增 `GATHER-SKILL-3`, `GATHER-SKILL-4`, `GATHER-SKILL-5` 测试。
