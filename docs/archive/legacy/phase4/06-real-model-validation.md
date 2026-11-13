# 真实模型验证：sensenova-6.8-flash（DSH 的 "rrx" Provider）

> 这是 Phase 4 收尾后，用**真实 LLM + 真实 MCP 工具**跑完整 Agent 的验证（游戏未开、旧快照）。
> 真实模型推理这条空白在这里补上；**新鲜游戏数据**的验证见 `07-fresh-data-validation.md`。

## 1. 配置来源（以 DSH 现有配置为准，不是猜的）

从 `C:\Users\BAOfanTing\.dsh\profiles\desktop\cordis.patch.yml` 读到：

```yaml
rrx:
  displayName: rrx
  apiKeyEnv: RRX_API_KEY
  api: openai-completions
  baseURL: https://token.sensenova.cn/v1
  models:
    - id: sensenova-6.8-flash
      name: sensenova-6.8-flash
      contextWindow: 262144
```

API Key 从 `C:\Users\BAOfanTing\.dsh\.credentials.yaml` 的 `refs.RRX_API_KEY` 读取，
**只在测试进程内存中使用，不打印、不落盘、不进仓库**。

```powershell
cd agent
node test/real-model.mjs
```

## 2. 实测发现的三个「与 DeepSeek 不同」（重要）

| # | 差异 | 影响 | 处理 |
|---|---|---|---|
| 1 | 思考内容在 **`reasoning`** 字段，不是 `reasoning_content` | 用 DeepSeek 的解析方式会丢掉全部思考内容 | 新增 `reasoningField` 配置（`reasoning_content` / `reasoning` / `none`），消息回传与响应解析都按它走 |
| 2 | **返回 `tool_calls` 时 `content` 非空**（"好的，我来为您查询…"） | 原代码没丢它，但之前假模型给的是 null，没验证过非空场景 | 加测试守护：`content` 必须原样保留进 assistant 消息 |
| 3 | **思考型模型很吃 token**：`max_tokens=64` 时 64 个 token 全用在 `reasoning_tokens`，`content` 为空 | 会误判成"模型没回答" | 配置提到 2048；报告里写明这是模型特性，不是 bug |

第 2 轮把 `reasoning` 原样回传后，模型正确终止（`finish_reason: stop`）并给出最终答复 —— 多轮工具调用链路真实可用。

## 3. 真实端点逐步验证

```
① 普通对话 HTTP 200
   message 字段: role, content, reasoning
   content: "1+1等于2。"
   reasoning: 用户希望我用一句中文回答…（思考内容）
   finish_reason: stop
   usage: completion_tokens=215, reasoning_tokens=207

② 工具定义传入 → 模型返回 tool_calls
   HTTP 200  finish_reason: tool_calls
   tool_calls: [{"id":"call_3ce61fb2dd074445b675493f",
                 "function":{"name":"get_player_status","arguments":"{}"}}]
   content: "好的，我来为您查询玩家当前的状态。"     ← 非空
   reasoning 长度: 150

③ 多轮：工具结果回传
   HTTP 200  finish_reason: stop
   tool_calls(第二轮): null
   content: "根据查询结果，玩家 WX-78 的当前状态如下：- 生命值：100%…"
```

## 4. 完整 Agent（真实 MCP + 真实模型）

```
=== Provider 健康检查 ===
   state=ok  模型可用（sensenova-6.8-flash，3533ms）
   model=sensenova-6.8-flash  supportsToolCalls=true
   function calling 实测: true — 模型返回了 1 个 tool_call

=== 完整 Agent（真实 MCP + 真实模型）===
   ready=true  工具=12 个

── 用户: 用一句话说，你现在能查到我的哪些信息？
   [第1轮] 模型返回: toolCalls=无 (6344ms)
   stopReason=final_answer  rounds=1  耗时=6345ms
   回答: 一句话：我能查到你的生命/饥饿/理智等身体状态、背包与装备、
        所处的天数季节天气、附近有哪些资源和敌对生物、周围像不像个基地，
        以及最近发生的受伤/换季/遇敌等事件——但只能看，不能替你操作游戏。

── 用户: 帮我看看现在玩家的生命和饥饿是多少？请查真实数据。
   [第1轮] 模型返回: toolCalls=get_player_status (3574ms)
   [第1轮] 工具完成: get_player_status ok=true 20ms
   [第2轮] 模型返回: toolCalls=无 (10393ms)
   stopReason=final_answer  rounds=2  工具=1  耗时=13988ms
   token: prompt=7135 completion=360
   回答: 先说结论：数据查到了，但这份是过期快照，不代表你当前的真实状态，
        而且里面有个需要你注意的情况。
        依据（来自最后一次已知快照，已标记 stale，心跳超时，
        距今约 11.5 小时未更新，会话已断开）：
        - 生命：50 / 150（33.3%）
        - 饥饿：100 / 150（66.7%）
        - 角色是威尔逊，is_ghost = true（已变成幽灵），位置 master 分片 (-118, 18)
        建议（按优先级）：
        1. 这份数据太旧了，我先尝试刷新一次…
        2. 如果"幽灵状态"是真实的，说明角色已经死亡、需要复活…
        3. 会话当前显示已断开（session_alive=false）…

=== 上下文 ===
   消息数=4（两轮 user + assistant 都保留）

=== 风险评估 + 计划（真实数据）===
   风险等级: CRITICAL
   摘要: CRITICAL（1 项危急、1 项高危）：玩家处于幽灵状态、生命值、附近敌对生物
   ⚠️ 数据已过期，以上结论基于最后一次已知状态，不代表当前
   计划 5 步，第 1 步: 作为幽灵去找复活方式
```

## 5. 这次验证证明了什么

**M5 的 8 条铁律在真实模型上确实生效了**（不是只在提示词里写着）：

| 铁律 | 真实模型表现 |
|---|---|
| 1 未查询不编造 | 第 2 问主动调了 `get_player_status`，没凭空报数值 |
| 2 数据过期必须说明 | **主动**识别出 `stale`、心跳超时、距今 11.5 小时、会话断开 |
| 3 不知道必须承认 | "不代表你当前的真实状态"、"如果…是真实的" |
| 4 计划不能说成已执行 | "我先尝试刷新一次"、"建议…"，没有"我已经帮你…" |
| 8 不能执行游戏修改 | 第 1 问主动补了"只能看，不能替你操作游戏" |

模型还展现了**超出脚本的推理**：注意到 `is_ghost=true` 比生命数值更紧急，把它排到建议第 2 条并解释原因。

## 6. 代码改动

| 文件 | 改动 |
|---|---|
| `agent/src/llm/openaiProvider.ts` | 新增 `ReasoningField` 类型与 `reasoningField` 配置；`toOpenAIMessages` / `fromRawCompletion` 按字段名读写；`RawChoice` 补 `reasoning`；usage 补 `completion_tokens_details` |
| `agent/src/llm/types.ts` | `LLMUsage` 补 `reasoningTokens` |
| `agent/src/config.ts` | 新增 `llmReasoningField`（`BWS_LLM_REASONING_FIELD`），默认按 preset 推断：`deepseek→reasoning_content`、`openai-compatible→none` |
| `agent/src/llm/factory.ts` | 透传 `reasoningField` |
| `agent/test/real-model-regression.test.ts` | **新增 7 个用例**（不依赖真实 Key）：reasoning 字段读写、none 模式、`content` 非空场景、第 2 轮回传后终止、preset 默认值 |
| `agent/test/real-model.mjs` | 真实模型端到端脚本（需 DSH 凭据） |

## 7. 测试

| 套件 | 用例 | 结果 |
|---|---|---|
| agent（M1–M6 + 真实模型回归） | **108** | 全过 |
| 全项目合计 | **342** | 全过 |

`real-model.mjs` 是手工验证脚本（会真实调用付费 API，不进自动测试套件）。

## 8. 仍未验证（如实保留）

1. **真实新鲜游戏数据**：本次游戏未运行，Bridge 里是 11.5 小时前的旧快照。
   模型虽然正确识别并标注了 `stale`，但「Agent 基于当前实时状态回答」没跑过。
2. **DeepSeek 官方端点**：仍然没有官方 Key。`reasoning_content` 分支只按官方文档实现 + 假服务器验证。
3. **长时间/多轮压测**：只跑了两轮对话，没测 12 轮上下文裁剪在真实模型上的表现。
4. **并发**：没测多个会话同时打真实模型。

## 9. 配置速查（复现这次验证）

```powershell
$env:BWS_LLM_PRESET='openai-compatible'
$env:BWS_LLM_BASE_URL='https://token.sensenova.cn/v1'
$env:BWS_LLM_MODEL='sensenova-6.8-flash'
$env:BWS_LLM_REASONING_FIELD='reasoning'   # 关键
$env:BWS_LLM_MAX_TOKENS='2048'             # 思考型模型别给太小
$env:BWS_LLM_API_KEY='<从 DSH .credentials.yaml 的 refs.RRX_API_KEY 读取>'

cd agent
node test/real-model.mjs
```
