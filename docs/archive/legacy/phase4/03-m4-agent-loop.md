# Phase 4 · M4：Agent Loop + Task Planner + Risk Assessor

> 结论：Agent Loop 跑通**真实多轮工具调用**（3 轮 / 4 次真实 MCP 调用 / 52ms / 4920 token），
> Risk Assessor 与 Task Planner 用真实游戏数据产出**可解释的**风险等级与分优先级计划。
> 26 个 M4 测试全过，agent 总计 **64 个测试全过**。

## 1. 新增文件

| 文件 | 内容 |
|---|---|
| `agent/src/runtime/agentLoop.ts` | Agent Loop：多轮工具调用、上限控制、reasoning_content 保留、事件回调 |
| `agent/src/runtime/riskAssessor.ts` | Risk Assessor：8 类风险因素、4 个等级、阈值可配置/可按角色覆盖 |
| `agent/src/runtime/taskPlanner.ts` | Task Planner：4 层目标（紧急/短期/中期/长期）+ 5 级优先级 + 理由与依据 |
| `agent/test/m4.test.ts` | 26 个用例 |
| `agent/test/demo-m4.mjs` | 真实链路演示（真实 MCP + 会调工具的假模型） |

## 2. Agent Loop 的三条硬约束

### ① reasoning_content 必须完整保留（DeepSeek 硬要求）

```ts
messages.push({
  role: 'assistant',
  content: response.content,
  reasoningContent: response.reasoningContent,   // ← 漏了这个，DeepSeek 带 tools 时直接 400
  ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
})
```

工具结果也保留 `tool_call_id`：

```ts
messages.push(toToolMessage(outcome.result))   // { role:'tool', content, toolCallId, name }
```

有测试专门验证：第 2 次请求的历史里必须能找到带 `reasoningContent` 的 assistant 消息，且 `tool_call_id` 正确。

### ② 循环必须有上限

| 限制 | 默认 | 行为 |
|---|---|---|
| `maxRounds` | 4 | 达到就终止，返回 `max_rounds` + 已执行的工具列表 |
| `maxToolCallsPerRound` | 4 | 超出部分不执行，并**告知模型**"还有 N 个未执行" |
| `agentTimeoutMs` | 60000 | 每轮开始前检查总耗时 |
| `toolTimeoutMs` | 15000 | 由 McpClient 内部生效 |

**到限制不假装完成**：`stopReason` 明确是 `max_rounds` / `agent_timeout`，`reply` 里写清"未能得出最终结论"。

### ③ 工具调用不重试

LLM 请求重试是幂等的，但工具调用**语义上不幂等**（即使本阶段只读）。所以 `executeToolCall` 里没有任何重试逻辑。

## 3. 停止原因（7 种，全部有明确语义）

| stopReason | 含义 |
|---|---|
| `final_answer` | 模型给出最终答复（正常结束） |
| `max_rounds` | 达到轮次上限 |
| `max_tool_calls` | （预留：单轮调用超限时配合使用） |
| `agent_timeout` | 总耗时超限 |
| `provider_error` | 模型调用失败（附错误码） |
| `no_tools_available` | 没有任何可用工具（不请求模型，直接说明） |
| `cancelled` | 被 signal 中止（`/api/agent/cancel` 用） |

## 4. Risk Assessor：综合评估，阈值可配

### 8 类风险因素

| 因素 | 等级判定 |
|---|---|
| 死亡 / 幽灵 | 直接 **CRITICAL**（权重 1） |
| 生命 | ≤危殆线 CRITICAL / ≤危险线 HIGH / ≤70% MEDIUM |
| 饥饿 | ≤危殆线 CRITICAL / ≤危险线 HIGH / ≤50% MEDIUM |
| 理智 | ≤危殆线 HIGH / ≤危险线 MEDIUM |
| 体温 | ≤过冷线 或 ≥过热线 → HIGH |
| 夜晚无光源 | **CRITICAL**（饥荒核心机制：黑暗直接掉血） |
| 黄昏无光源 | HIGH |
| 敌对生物 | ≥危殆数量 CRITICAL / ≥危险数量 HIGH / >0 MEDIUM |
| 食物储备 | 无食物 + 饥饿偏低 → CRITICAL/HIGH |

### 阈值不写死（任务书 §10 明确要求）

```ts
export const DEFAULT_THRESHOLDS: RiskThresholds = {
  healthLow: 50, healthCritical: 25,
  hungerLow: 30, hungerCritical: 15,
  sanityLow: 30, sanityCritical: 15,
  temperatureCold: 5, temperatureHot: 40,
  hostileHigh: 2, hostileCritical: 4,
}
```

- 注释里明确写：**这只是保守起点，不是"通用死亡线"**
- 支持 `thresholds` 参数覆盖
- 支持 `profile: { prefab, thresholds }` 按角色覆盖（不同角色饥饿/理智上限不同）
- 输出里带 `thresholds`，可审计

### 数据过期必须标注

```ts
staleNote: stale ? '数据已过期，以上结论基于最后一次已知状态，不代表当前' : null
```

## 5. Task Planner：4 层目标 + 5 级优先级

| Horizon | 含义 | 典型步骤 |
|---|---|---|
| `immediate` | 紧急生存 | 复活、做火把、脱离战斗、回血 |
| `short` | 短期 | 进食、采集食物、恢复理智、取暖/降温 |
| `mid` | 中期 | 采集基础资源、季节准备 |
| `long` | 长期 | 规划基地位置 |

每一步都有：`action`（做什么）、`reason`（为什么）、`evidence`（依据哪条数据）、`urgent`（是否要命）、`priority`（1~5）。

**排序**：horizon 优先 → priority → 原始顺序；`order` 连续编号。

## 6. 真实链路演示（真实 MCP + 会调工具的假模型）

```
=== 准备 ===
  MCP 工具：12 个；适配：12 个

=== 跑 Agent Loop ===
  第 1 轮开始
    模型返回：toolCalls=get_player_status,get_world_status
    工具完成：get_player_status ok=true 22ms
    工具完成：get_world_status ok=true 2ms
  第 2 轮开始
    模型返回：toolCalls=get_nearby_threats,get_nearby_resources
    工具完成：get_nearby_threats ok=true 2ms
    工具完成：get_nearby_resources ok=true 2ms
  第 3 轮开始
    模型返回：toolCalls=无

=== 结果 ===
  stopReason: final_answer
  rounds: 3  工具调用: 4  耗时: 52ms
  token: prompt=4700 completion=220 total=4920
  最终答复: 我查到了这些数据：… 综合来看目前没有立即致命的威胁，建议先补食物再考虑过夜。
```

**关键**：4 次工具调用都是**真实打到 MCP Server → Bridge → 游戏数据**（22ms/2ms/2ms/2ms），不是 mock。

## 7. 真实数据上的 Risk + Planner

```
=== Risk + Planner（用真实数据）===
  风险等级: CRITICAL
  摘要: CRITICAL（1 项危急、1 项高危）：玩家处于幽灵状态、生命值、附近敌对生物
  ⚠️ 数据已过期，以上结论基于最后一次已知状态，不代表当前
  因素:
    [CRITICAL] 玩家处于幽灵状态: 需要复活（否则无法正常生存）
    [HIGH] 生命值: 33.3%（危险线 50% / 危殆线 25%）
    [MEDIUM] 附近敌对生物: 1 个，最近 1.3 格
    [LOW] 饥饿: 66.7%
    [LOW] 理智: 50%

  计划（共 4 步，紧急 2 项）:
    ⚠️ 数据已过期，计划基于最后一次已知状态，执行前请重新查询
    风险等级：CRITICAL
    有 2 件紧急事项要立刻处理，其中最高优先级：作为幽灵去找复活方式（复活台 / 肉块雕像 / 队友）
    1. 【紧急】[紧急生存/优先级最高] 作为幽灵去找复活方式
       理由：幽灵状态无法进食与战斗
       依据：玩家处于幽灵状态
    2. [紧急生存/优先级高] 保持距离，评估是否要绕开
       依据：1 个敌对，最近：南瓜灯（1.3 格）
    3. [短期/优先级高] 扩大搜索范围找食物来源
```

## 8. 演示中发现并修掉的两个逻辑问题

### ① headline 与紧急项矛盾

**现象**：计划里有 `urgent: true` 的步骤，但 headline 却说"当前没有紧急威胁"。

**根因**：headline 只看 `urgentCount > 0`，但有些 `immediate` 步骤的 `urgent` 是 false（例如"保持距离"）。

**修复**：改成 `urgentCount > 0 || immediateCount > 0`，两者任一非零就说"有紧急事项"。

### ② 幽灵状态没进计划第一步

**现象**：Risk 判了 CRITICAL（幽灵状态），但 Plan 的第 1 步是"保持距离"。

**根因**：demo 里传给 `buildPlan` 的 `player` 对象漏了 `isGhost` 字段。

**修复**：demo 补上 `isGhost`/`dead`；并加了一条测试专门守护"幽灵状态 → 计划第一步是复活 + headline 必须说紧急"。

## 9. 测试（26 个用例）

**Agent Loop（12 个）**：
```
✔ 无工具调用 → 一轮出最终答复
✔ 多轮工具调用（要工具 → 执行 → 喂回 → 出答复）
✔ reasoning_content 必须进历史（DeepSeek 带 tools 时强制要求）
✔ 达到轮次上限 → 终止并报告（不假装完成）
✔ 单轮工具调用超上限 → 截断并提示模型
✔ Provider 报错 → provider_error，不继续循环
✔ 没有可用工具 → no_tools_available，不假装能查
✔ 工具执行失败 → 结果喂回模型（模型能看到错误）
✔ system prompt 注入 + 历史保留
✔ 事件回调按顺序发出（round/tool/stop）
✔ 默认限制符合任务书（4 轮 / 4 调用 / 15s / 60s）
```

**Risk Assessor（7 个）**：低风险、夜晚无光源 CRITICAL、幽灵 CRITICAL、饥饿分级、阈值可配、按角色覆盖、过期标注、阈值透出。

**Task Planner（7 个）**：夜晚无光源第一步做火把、饥饿低优先采集、威胁优先级、秋季剩 3 天准备过冬、步骤有序、renderPlan 含理由依据、过期提示、幽灵状态第一步复活。

## 10. 全量测试

| 套件 | 用例 | 结果 |
|---|---|---|
| agent（M1 + M2 + M3 + M4） | **64** | 全过 |

## 11. 未完成项

1. **没有接真实模型**：本机无 Key，Loop 用的是"会按脚本调工具的假模型"。**真实模型的工具选择质量未验证**。
2. **没有接角色 Prompt**：M5 才写小鲸鱼的系统提示词（现在 demo 里只有一句占位）。
3. **没有上下文管理**：M5 做 session/conversation/裁剪。
4. **没有 HTTP API**：M6。
5. **Planner 没有用 LLM**：目前是纯规则（可解释、可测），M5 可以考虑"规则给骨架 + LLM 补细节"。
6. **Risk 的食物/光源判定是启发式**：靠 `hasFood`/`hasLight` 布尔值，实际应该从背包物品列表推断（M5 补）。

## 12. 风险

1. **真实模型可能不按预期调工具**：比如该查数据却直接编答案。M5 的 System Prompt 必须明确"未查询的数据不能编造"，但**提示词不是安全边界**，最终还得靠 M6 的只读白名单兜底。
2. **4 轮上限对复杂问题可能不够**：真实模型有时需要 5~6 轮。已可配置，但要注意总 token 成本。
3. **`maxToolCallsPerRound` 截断会让模型困惑**：我加了系统提示告知，但真实模型可能仍反复请求被截断的工具。
4. **Risk 阈值仍是经验值**：即使可配置，默认值未必适合所有角色/难度。
5. **南瓜灯被算成威胁**：这是旧快照（Phase 2 M5 修正前的数据），不是新 bug；但说明**数据新鲜度真的会影响判断**，`stale` 标注必须一路传到用户。

## 13. 下一步（M5）

角色 Prompt + 上下文管理 + 安全系统：
- 小鲸鱼的角色设定与游戏规则 Prompt（任务书 §11 的 8 条铁律）；
- Context Manager：session_id / conversation_id / 消息历史 / 上下文裁剪 / 会话重置；
- Read Only Guard 在 Prompt 层再加一道（程序层 M3 已有）。
