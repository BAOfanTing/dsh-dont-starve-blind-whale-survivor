# Phase 6 · Advanced Survival Intelligence 总览

> 这一阶段给「大肥鱼」装上**认识危险、评估危险、躲避危险、最后才战胜危险**的那一层。
>
> 一句话结论：**六大模块 + 14 个 MCP 工具 + 1 个全局仲裁器全部实现，559 个测试全过**
> （Lua/插件 209 / MCP Server 126 / Game Bridge 56 / Agent 120 / Survival 48）。
> **Node 侧决策链路单轮 0.013 ms**。真机验证脚本已备好（`survival/test/p6-combat.mjs`），
> 但**本轮没有游戏进程在跑**，真机部分**尚未执行** —— 见 [`08-real-game-validation.md`](./08-real-game-validation.md)。

## 1. 前置阶段审计（不假设，逐项实测）

先跑了一遍全部前置测试，再读代码确认勾挂点。

### 1.1 实测测试结果（Phase 6 改动之前）

| 套件 | 命令 | 结果 |
|---|---|---|
| Lua / DSH 插件 | `node --test "tests/*.test.mjs"` | **209 全过** |
| Phase 2 Game Bridge | `cd game-bridge && npm test` | **56 全过** |
| Phase 3 MCP Server | `cd mcp-server && npm test` | **108 全过**（Phase 6 后 126） |
| Phase 4/5 Agent | `cd agent && npm test` | **120 全过** |
| Phase 5 Controller | `cd survival && npm test` | **48 全过** |

### 1.2 任务书要求重点检查的六项（以代码 + 报告为准）

| # | 项目 | 结论 | 依据 |
|---|---|---|---|
| 1 | Lua 原生动作执行 | ✅ 可用 | `action_executor.lua` 只用 `Whale.actions`（`BufferedAction` + `locomotor:PushAction`），Phase 5 M2 真机验证过位移 `(-82,70) → (-79,71)` |
| 2 | Action 生命周期 | ✅ 可用 | 启动回 `EXECUTING`（中间态），完成/失败用**同一 command_id** 补发终态；`unknown_completion` 表示"结果未知且禁止重放" |
| 3 | 状态反馈 | ✅ 可用 | 快照带 `timestamp/session/shard/tick`，`stale` 与 `stale_reason` 直传 MCP 层；`verify` 字段用真实差值核验（饥饿/背包/火焰） |
| 4 | 控制权管理 | ✅ 可用 | Bridge 持久化权威副本 `/api/v1/control/*`；MCP 每个写工具 `requireControl()`；Lua 每个动作前 `POST /control/assert` 二次校验 |
| 5 | 紧急停止 | ✅ 可用（本阶段加强） | Bridge `EMERGENCY_STOP` 拒绝一切；**Phase 6 新增**：战斗期间每 2 秒在线复核控制权，被撤销立刻停手 |
| 6 | MCP 写操作权限 | ✅ 可用 | 控制权 + `confirmed=true` 双闸；`read`/`supervised` 两档白名单；`FORBIDDEN_TOOL_PATTERNS` 挡 `attack/drop/kill/teleport/exec/shell/lua` |
| 7 | Agent 多步骤任务 | ✅ 可用（有限） | M7 联合测试真机通过（观察→查控制权→采集→查结果→汇报）；已知短板：不会"结果不够就补采" |

### 1.3 如实指出的依赖缺陷（会影响 Phase 6 的部分）

1. **Phase 5 从未碰过战斗 API**。`combat:TryAttack` / `CanAttack` / `GetAttackRange` 在
   本仓库里**没有任何真机验证记录**。Phase 6 因此：
   - 所有战斗 API 都走 `C.ProbeApi()` 逐项探测（`probe_combat_api` 命令可随时查）；
   - `TryAttack` 不可用时退回 `BufferedAction(ATTACK)`；
   - 两条都不可用 → **直接拒绝启动战斗**，绝不 ForceAttack。
2. **控制权被撤销时，Bridge 队列里已入队的命令不会自动取消**（Phase 5 M1/M2 遗留）。
   Phase 6 的对策是"执行侧自守"：战斗状态机每 2 秒自己重新 assert 一次，被拒就停手。
   普通原子动作仍是老问题（长动作跑完为止）。
3. **`unknown_completion` / `action_timeout` 分支只有沙箱验证**（Phase 5 遗留）。
   Phase 6 的战斗结算沿用同一套 `settle()`，没有新增真机证据。
4. **没有地形/可通行性数据**。Escape Planner 只能给"背离威胁的合向量"，实际绕障碍靠游戏寻路。
   文档与工具输出里都明确写了这一条，不假装有寻路规划能力。
5. **游戏未运行**（本轮开发时 `connected=false`，最后心跳 200 万毫秒前）。
   真机验证脚本已备好，未执行。

**没有阻塞性缺陷。** 上述 1~4 都是"限制"而不是"坏了"，Phase 6 的设计按其做了保守处理。

## 2. 架构：谁负责什么

```
        LLM（规划，秒级）                     程序层（硬规则）
   ┌──────────────────────┐        ┌──────────────────────────────┐
   │ 看：get_threat_assessment│      │ Survival Decision Engine     │
   │     get_combat_readiness │ ───▶│  P0~P5 仲裁 + 工具门禁        │
   │     get_escape_options   │      │  （HP/黑暗/体温/围攻=硬规则） │
   │ 决定：get_combat_recommendation │ ├── Threat Analyzer（评分）   │
   │ 做：start_combat → 确认  │      │ ├── Combat Planner（4 选 1）  │
   └──────────┬───────────┘        │ ├── Combat State Machine      │
              │ MCP 工具              │ └── Combat Lock（单执行者）   │
              ▼                     └──────────────┬───────────────┘
   ┌──────────────────────┐                       │ 命令（controller/session）
   │ MCP Server（43 工具） │ ──────────────────────┘
   └──────────┬───────────┘
              ▼ HTTP
   ┌──────────────────────┐      ┌─────────────────────────────────┐
   │ Game Bridge（28 命令）│ ───▶ │ Lua：combat_executor（0.1s tick）│
   │ 控制权 / 队列 / 状态  │      │  原生 combat:TryAttack          │
   └──────────────────────┘      │  locomotor:GoToPoint（Kiting）   │
                                 └─────────────────────────────────┘
```

**关键分工**（任务书 §2）：LLM 只做"打不打、打谁、什么时候撤"；高频（0.1 秒级）的走位与出手
全在 Lua；硬性安全规则（HP 阈值、黑暗、体温、围攻、白名单、Boss 拦截）全在程序层。

## 3. 模块与文件清单

### 3.1 Lua（`DontStarveWhaleSurvivor/scripts/main/`）

| 文件 | 状态 | 作用 |
|---|---|---|
| `threat_observer.lua` | **新增** | 威胁扫描（敌人/距离/追击/出手/攻击距离周期伤害）+ 环境读数（光照/体温/季节/火堆） |
| `combat_executor.lua` | **新增** | 9 态战斗状态机 + Kiting（0.1s tick）+ 白名单/Boss 硬拦 + 单执行者 + 2s 控制权复核 |
| `observer_manager.lua` | 修改 | 每轮扫描威胁与环境、塞进 sections；Tick 里驱动 `combat.Drive()` |
| `state_serializer.lua` | 修改 | `GameState` 增加 `threats` / `environment` 段 |
| `commands.lua` | 修改 | 新增 6 个命令白名单（战斗 4 + 状态 1 + 探测 1）+ `heal_self`；`get_combat_status` / `probe_combat_api` 只读实现 |
| `action_executor.lua` | 修改 | 战斗命令转交 `BWS2.combat`；战斗中拒绝插原子动作（单执行者）；`heal_self` → `JOBS.heal`；治疗用生命差核验 |
| `task_runner.lua` | 修改 | 新增四季准备任务链 `autumn_prep` / `winter_prep` / `spring_prep` / `summer_prep` |
| `modmain.lua` | 修改 | 加载两个新模块；玩家死亡时 `combat.ForceStop` |

### 3.2 Node（`mcp-server/src/`）

| 文件 | 状态 | 作用 |
|---|---|---|
| `survival/profiles.ts` | **新增** | 敌人战术档案（含 `auto_engage_allowed`）+ Boss 档案（12 条） |
| `survival/types.ts` | **新增** | 决策层共享类型（全部允许 null，缺数据不猜） |
| `survival/context.ts` | **新增** | 唯一解析原始快照的地方；威胁段缺失时降级到 `nearby.hostile` 并标注 |
| `survival/threat.ts` | **新增** | 0~100 威胁评分（8 个可配权重因素 + 硬规则） |
| `survival/combat.ts` | **新增** | 准备度逐项检查 + ENGAGE/PREPARE/EVADE/RETREAT 决策 + 动态 HP 阈值 |
| `survival/combatState.ts` | **新增** | 9 态状态机 + 合法迁移表 + `CombatLock`（单执行者） |
| `survival/combatController.ts` | **新增** | Node 侧编排：确认/控制权/决策/白名单/Boss 五道程序层闸门 |
| `survival/escape.ts` | **新增** | 七类危险的规避选项 + 逃跑方向（合向量）+ 是否中断任务 |
| `survival/season.ts` | **新增** | 四季准备度与计划，季节/剩余天数全读游戏；拿不到就报 `unreliable` |
| `survival/boss.ts` | **新增** | Boss 识别 + 准备报告 + OBSERVE/PREPARE/AVOID/SUPERVISED_COMBAT |
| `survival/decision.ts` | **新增** | 全局仲裁 P0~P5 + `isToolAllowed()` 程序层工具门禁 |
| `tools/phase6Tools.ts` | **新增** | 16 个 MCP 工具（10 只读 + 6 写） |
| `tools/definitions.ts` | 修改 | 注册 Phase 6 工具（27 → 43） |

### 3.3 其它

| 文件 | 状态 | 作用 |
|---|---|---|
| `game-bridge/src/commands.ts` | 修改 | 命令白名单 21 → 28（战斗 4 + 只读 2 + 治疗 1） |
| `agent/src/mcp/toolAdapter.ts` | 修改 | 只读白名单 15 → 25，写白名单 12 → 18 |
| `tests/phase6-lua.test.mjs` | **新增** | 12 个 Lua 沙箱用例（威胁观察器 / 战斗执行器 / 两侧白名单一致） |
| `mcp-server/test/p6.test.ts` | **新增** | 30 个决策层 + 工具层用例 |
| `survival/test/p6-combat.mjs` | **新增** | 真机验证脚本（只读验证 + 可选真实战斗） |
| `tools/bench-phase6.mjs` | **新增** | 决策链路性能测量 |

## 4. 测试总表（Phase 6 完成后）

| 套件 | 用例数 | 结果 |
|---|---|---|
| Lua / DSH 插件 | 209 | 全过 |
| MCP Server（含 Phase 6 的 30 个） | 126 | 全过 |
| Game Bridge | 56 | 全过 |
| Agent | 120 | 全过 |
| Survival Controller | 48 | 全过 |
| **合计** | **559** | **全过** |

> 契约变更（有意为之，已同步到旧测试）：MCP 工具 27 → 43；Bridge 命令 21 → 28；
> Agent 只读 15 → 25 / 写 12 → 18；Lua 写动作 12 → 13（`heal_self`）；
> `modmain` modimport 25 → 27；模组版本 0.9.2 → 0.10.0。

## 5. 各里程碑文档

| 里程碑 | 文档 | 一句话 |
|---|---|---|
| M1 | [01-m1-threat-analyzer.md](./01-m1-threat-analyzer.md) | 认得出危险，说得出为什么危险 |
| M2 | [02-m2-escape-planner.md](./02-m2-escape-planner.md) | 知道往哪跑、什么时候该跑 |
| M3 | [03-m3-combat-readiness.md](./03-m3-combat-readiness.md) | 打得过吗？逐项算，不是一个血量阈值 |
| M4 | [04-m4-combat-kiting.md](./04-m4-combat-kiting.md) | 用原生动作打，会风筝，会自己撤 |
| M5 | [05-m5-season-manager.md](./05-m5-season-manager.md) | 四季准备清单，季节读游戏不写死 |
| M6 | [06-m6-boss-planner.md](./06-m6-boss-planner.md) | 认出 Boss，只避战和准备，不自动开打 |
| M7 | [07-m7-decision-engine.md](./07-m7-decision-engine.md) | P0~P5 仲裁 + 14 个 MCP 工具 + 性能 |
| 真机 | [08-real-game-validation.md](./08-real-game-validation.md) | 脚本、预期、以及**尚未执行**的如实说明 |
