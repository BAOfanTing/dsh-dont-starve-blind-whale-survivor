# 系统调用图与数据流审计报告 (Call Graph & Execution Chains)

> 生成时间：2026-11-19
> 审计分支：`stabilize/architecture-baseline`
> 审计目标：全景梳理从入口调用到游戏内执行与状态核对的完整执行链路，识别断链与旁路分支。

---

## 一、系统总体架构分层调用拓扑

```
[外部输入层]
  ├─ MCP Client (DSH / WorkBuddy / Claude Code)
  │    │ HTTP (Streamable HTTP / SSE)
  │    ▼
  │  lib/mcp-server.js ──┐
  │                      │
  ├─ 游戏内热键 F8       │
  │    │ In-Game F8      │
  │    ▼                 ▼
  │  lib/agent.js ───► lib/index.js (runTool)
  │                      │
  └──────────────────────┴────────────────┐
                                          ▼
                                   lib/tools.js (executeTool)
                                          │
            ┌─────────────────────────────┼────────────────────────────┐
            ▼                             ▼                            ▼
      [只读/本地工具]               [复合技能入口]               [原子动作分发]
      · get_state                  · run_skill                  · move_to / chop_nearest ...
      · get_guide                         │                            │
      · update_notes                      ▼                            ▼
            │                   lib/skills/skill-executor.js    lib/dispatcher.js (唯一动作出口)
            │                             │                            │
            │                             │ (逐步派发原子动作)          │ 1. 参数归一化与校验
            │                             └───────────────────────────►│ 2. 注入 Control Lease
            │                                                          │ 3. 跨通道写命令
            │                                                          │
            │                                                          ▼
            │                                             lib/bridge.js (文件通道 / HTTP 通道)
            │                                                          │
            │══════════════════════════════════════════════════════════╪═════════════════════════════════
            │                                                          │ 跨进程 IPC (JSON 桥)
            │                                                          ▼
            │                                             DontStarveWhaleSurvivor/
            │                                             scripts/whale/bridge.lua
            │                                                          │
            │                                                          ▼
            │                                             scripts/whale/guard.lua (第二道安全闸)
            │                                             · 白名单校验
            │                                             · 租约时代 (generation) 验证
            │                                             · 目标有效性实时复核
            │                                                          │
            │                                                          ▼
            │                                             scripts/whale/actions/core.lua (A.Start)
            │                                                          │
            │                                 ┌────────────────────────┴──────────────────────┐
            │                                 ▼                                               ▼
            │                      scripts/whale/actions/*.lua                     scripts/whale/battle.lua
            │                      (movement / gathering / combat / ...)           (战术风筝子系统)
            │                                 │                                               │
            │                                 └────────────────────────┬──────────────────────┘
            │                                                          ▼
            │                                             DST 原生组件 (locomotor / BufferedAction)
            │                                                          │
            │                                                          ▼
            │                                             scripts/whale/bridge.lua
            │                                             (写回 whale_result.json)
            │                                                          │
            │══════════════════════════════════════════════════════════╪═════════════════════════════════
            │                                                          ▼
            │                                             lib/dispatcher.js
            │                                             (前后真实快照证据核对 verify)
            ▼                                                          ▼
   lib/state/snapshot.js ◄─────────────────────────────────────────────┘
   (更新归一化快照)
```

---

## 二、详细执行链分析 (Execution Chains)

### 1. 状态感知与决策流 (Perception & Decision Chain)

```
[调用方请求 get_state]
   │
   ▼
lib/tools.js: getState()
   │
   ├─► lib/tools.js: readSnapshot(ctx)
   │     └─► lib/state/snapshot.js: normalizeState(rawJson)
   │
   ├─► lib/plan.js: derivePlan(snapshot, ctx.lastPlan)
   │     └─► 执行旧版生存规则引擎 (GOALS 一维优先级匹配，推导保命/基础采集动作)
   │
   ├─► lib/planner/planner-core.js: planner.plan(snapshot)
   │     ├─► lib/planner/world-memory.js: 读当前世界记忆 (world_key 隔离)
   │     ├─► lib/planner/development-stages.js: 评估当前阶段 Stage 0~6
   │     ├─► lib/planner/base-site-planner.js: 评分候选营地 (主选+备选)
   │     ├─► lib/planner/task-board.js: 刷新中期任务看板 (依赖 DAG 评审)
   │     └─► 记录真实出现的建筑为家锚点 (recordHomeFromSnapshot)
   │
   ├─► lib/planner/decision-arbiter.js: arbitrate(snapshot, { devPlan, survivalPlan })
   │     │
   │     ├─► 判断 P0/P1 生存紧急 (survival-priority.js)
   │     │     └─► 若阻塞：优先级强行切为 P0/P1，主任务保留，下一步输出保命建议 (指向 survival_stabilize)
   │     │
   │     ├─► 判断发展阶段核心任务
   │     │     └─► 若无生存阻断：提取看板最优 Ready 任务，映射到技能 (TASK_SKILL) 与完成条件
   │     │
   │     └─► 兜底模式：暂无待执行任务时退回生存规则引擎
   │
   └─► 渲染唯一决策输出：renderDecision(decision, devPlan)
```

### 2. 原子动作分发与双闸核验流 (Action Dispatch & Dual-Guard Chain)

```
[调用方/技能下发原子动作 (如 chop_nearest)]
   │
   ▼
lib/tools.js: executeTool(name, args, ctx)
   │
   ├─► [家园门槛拦截] 若动作是 build：调用 ctx.planner.guardBuild(recipe, snapshot)
   │     └─► 未选址 / 未到营地 / 无家 / 超出锚点范围 ──► 直接拒绝 (REJECTED，不写桥)
   │
   ▼
lib/dispatcher.js: dispatcher.dispatch({ tool, args, owner })
   │
   ├─► 1. 参数归一化与白名单校验 (validateArgs against ACTION_SPECS)
   ├─► 2. 控制权租约校验 (control.requireActiveLease()，防多实例冲突)
   ├─► 3. 封装标准信封：{ protocol: 1, command_id, action, args, lease_id, generation, ... }
   │
   ▼
lib/bridge.js: writeCmd(cmd) ──► 写入游戏工作区 whale_cmd.json (或 HTTP exchange)
   │
   ▼ (进入游戏 Lua 模组)
scripts/whale/bridge.lua: Tick()
   │
   ▼
scripts/whale/guard.lua: guard.validate(cmd, authority)
   │
   ├─► 1. 角色有效性校验 (actor.lua: 本机实体、活着、非幽灵)
   ├─► 2. 租约时效与世代代际复核 (authority.generation == cmd.generation)
   ├─► 3. G.ACTIONS 严格白名单与参数模式匹配
   ├─► 4. 目标实体解析 (ResolveTarget: 复核句柄或 #N 引用是否存在、距离、成熟度)
   │
   ▼
scripts/whale/actions/core.lua: A.Start(cmd.action, cmd.args, cmd.ctx)
   │
   ▼
scripts/whale/actions/*.lua (对应领域 JOBS 处理函数)
   │
   └─► 装配 DST 原生 BufferedAction 并推入 locomotor:PushAction(act, true)
```

### 3. 复合技能增量执行流 (Skill Execution Chain)

```
[调用方/自动化下发 run_skill {"skill_id": "establish_home"}]
   │
   ▼
lib/tools.js: runSkillTool(input, ctx)
   │
   ▼
lib/skills/skill-executor.js: SkillExecutor.run(skillId)
   │
   ├─► 1. 单角色单技能互斥：若有其他 in_progress 技能，先将其 pauseOthers()
   ├─► 2. 生存紧急抢占：检查 survivalLevel(snapshot)，若触发 P0/P1 危险，立即暂停本技能
   ├─► 3. 检查前置条件：skill.preconditions(ctx)
   ├─► 4. 遍历 steps：调用 step.isDone(ctx) 跳过已完成步骤（中断后绝不重放动作）
   ├─► 5. 获取当前步动作：plan = step.nextAction(ctx, inst)
   │
   ▼
[派发单步原子动作] ──► 内部调用 opts.dispatch(plan.tool, plan.args) ──► 走唯一 Dispatcher
   │
   ▼
[重新采样快照] ──► readSnapshot() 重新读取最新真实世界事实
   │
   ▼
[真实证据判定] ──► step.isDone(afterCtx)
   │
   ├─► 验证通过 ──► step_index + 1，清空重试计数，持久化写入 memory.skill_instances
   └─► 验证未通过 ──► 记录 attempt，若超预算则标记 failed/blocked
```

### 4. 紧急保命反射与战术战斗流 (Reflex & Combat Chain)

```
[DST 游戏引擎帧循环 (TheWorld:DoPeriodicTask)]
   │
   ├─► scripts/whale/reflex.lua: ReflexTick()
   │     │
   │     ├─► P0: 绝对黑暗且无光源 ──► 零延迟点燃火把 / 佩戴手持光源 (A.Start("reflex"))
   │     ├─► P0: 遭受攻击 / 威胁生物贴脸 ──► 原版 native.RunAway 计算向量，A.Abort() 强行打断当前任务，瞬发后撤逃生
   │     └─► P1: 饥饿见底且背包有现成安全食物 ──► 瞬发啃一口保命
   │
   └─► scripts/whale/battle.lua: BattleDirector (仅在调用 fight_spider 时激活)
         │
         ▼
       战术风筝有限状态机 (IDLE -> APPROACH -> LURE -> WAIT_ATTACK -> ATTACK -> RETREAT -> LOOT)
         │
         ├─► 普通蜘蛛：打二撤一 (Swings=2, Retreat=3.0格)
         ├─► 掉落物安全拾取：白名单优先拾取蜘蛛丝 (silk)
         └─► 协同机制：若玩家血量低于 25% 或多怪围攻 ──► 触发 EMERGENCY，主动让位给 Reflex 逃跑
```

---

## 三、调用链断裂与孤岛模块审计

1. **`DontStarveWhaleSurvivor/scripts/whale/chores.lua` 调用链断裂**：
   - **现状**：内部注册了 `stock_light_materials`, `chore_stock_light`, `chore_fuel`, `chore_forage`, `chore_pick_flowers`, `chore_stow_light` 等 6 个动作。
   - **问题**：Node.js 侧 `ACTION_SPECS` 完全未包含这些动作，`tools.js` 未暴露，`planner-core.js` 与 `plan.js` 从不发起这些调度。代码处于完全孤岛状态。

2. **`lib/skills/establish-home.js` 与 `lib/skills/gather-resources.js` 旁路重复**：
   - **现状**：`planner-core.js` 目前调用 `establishHomeTasks` 生成看板任务，内部调用 `expandGatherTasks`。
   - **问题**：这些生成出来的 Task 只有静态描述，其内部定义的步骤与真正的可执行技能 `establish-home-skill.js` / `gather-resources-skill.js` 存在两套平行的状态核对逻辑。
