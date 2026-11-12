# Phase 4 · M2：接入 LLM Provider（DeepSeek 官方 + 本地 OpenAI 兼容）

> 结论：Provider 层完成，**一份实现同时服务 DeepSeek 官方 API 与本地 OpenAI 兼容模型**，
> 16 个测试全过，并跑通了**真实的多轮工具调用**（模型要数据 → 喂工具结果 → 模型给最终答复）。
>
> **如实说明**：本机没有 DeepSeek API Key，也没有本地模型服务在跑，
> 所以对**真实 DeepSeek 端点**只验证到"无 Key 时明确报错"，**没有验证过真实推理**。
> 协议行为（tool_calls / reasoning_content / 各类错误）全部用假服务器精确验证过。

## 1. 官方文档依据（不是凭印象）

查了 DeepSeek 官方文档（`api-docs.deepseek.com`）：

| 项 | 官方说明 |
|---|---|
| 模型名 | **`deepseek-flash`**、**`deepseek-v4-pro`**（`deepseek-v4-flash` 等旧名已退役但仍接受） |
| thinking 开关 | `extra_body: {"thinking": {"type": "enabled"/"disabled"}}`，**默认 enabled** |
| 思考强度 | `reasoning_effort: low/high/max`（默认 high；`medium` 映射到 high） |
| **关键约束** | 带 `tools` 的请求**必须把历史 `reasoning_content` 完整传回**，否则 **400** |
| thinking 限制 | **不支持** `temperature` / `presence_penalty` / `frequency_penalty` |
| tool_choice | thinking 模式下用 `auto`；`none` 可禁用工具调用 |
| 上下文 / 输出 | 1M / 最大 384K |

## 2. 新增文件

| 文件 | 内容 |
|---|---|
| `agent/src/llm/types.ts` | 统一接口：`LLMMessage` / `LLMToolDefinition` / `LLMResponse` / `ModelInfo` / `ProviderHealth` / `ProviderError`（10 个错误码） |
| `agent/src/llm/openaiProvider.ts` | OpenAI 兼容 Provider 实现（DeepSeek + 本地共用），含消息/响应双向转换、错误分类、重试、超时、`probeToolCalls()` |
| `agent/src/llm/factory.ts` | 按配置创建 Provider |
| `agent/src/config.ts` | 新增 12 个 LLM 配置项（全部可环境变量覆盖，**模型名不写死**） |
| `agent/src/index.ts` | `--llm` 模式：健康检查 + 模型信息 + function calling 实测 + 普通对话 |
| `agent/test/m2.test.ts` | 16 个用例 |
| `agent/test/demo-m2.mjs` | 多轮工具调用真实链路演示 |

## 3. 关键实现

### 3.1 一份实现，两种 preset

| 差异点 | `preset: 'deepseek'` | `preset: 'openai-compatible'` |
|---|---|---|
| thinking 开关 | `extra_body.thinking` + `reasoning_effort` | 不发（本地服务通常不认） |
| temperature | thinking 模式下**不发**（官方不支持） | 照发 |
| tool_choice=required | 降级成 `auto`（thinking 不兼容 required） | 原样发 |
| reasoning_content | 有就回传（带 tools 时 DeepSeek 强制要求） | 有就回传（无害） |

### 3.2 reasoning_content 的正确处理

```ts
// 内部消息 → OpenAI 格式
if (message.role === 'assistant') {
  if (message.reasoningContent != null) base.reasoning_content = message.reasoningContent
  if (message.toolCalls?.length) base.tool_calls = [...]
}
if (message.role === 'tool') {
  base.tool_call_id = message.toolCallId   // 必须保留，否则模型无法关联
}
```

### 3.3 Function Calling **实测**（不假设）

任务书要求"不得假设所有 OpenAI 兼容接口都完整支持 Function Calling"。所以：

```ts
async probeToolCalls(): Promise<{ supported: boolean; detail: string }> {
  // 用一个极小的 ping_tool 发真实请求，看模型是否返回 tool_calls
  // 三种结果都如实返回：返回了 tool_call / 只回文本 / 明确报错
}
```

结论会写进 `getModelInfo().supportsToolCalls`（**实测值**，不是配置声明）。

### 3.4 错误分类（10 个码）

| 码 | 触发 | 可重试 |
|---|---|---|
| `MISSING_API_KEY` | DeepSeek 没配 Key | 否 |
| `UNAUTHORIZED` | 401/403 | 否 |
| `RATE_LIMITED` | 429 | **是** |
| `MODEL_NOT_FOUND` | 404 | 否 |
| `TOOL_CALLS_UNSUPPORTED` | 400 且消息含 tool/function + not support | 否 |
| `BAD_REQUEST` | 其它 400（如 reasoning_content 没回传） | 否 |
| `TIMEOUT` | AbortController 超时 | **是** |
| `NETWORK_ERROR` | 连不上 | **是** |
| `SERVER_ERROR` | 5xx | **是** |
| `BAD_RESPONSE` | 非法 JSON / 无 choices | 否 |

可重试的会指数退避（250ms → 500ms → 1s，上限 2s）。

## 4. 实际运行结果

### 4.1 DeepSeek 官方端点（无 Key，真实网络）

```
=== Provider 健康 === {"state":"misconfigured","message":"没有 API Key（DeepSeek 必须配）","latency_ms":null}
=== 模型信息 === {"provider":"deepseek","model":"deepseek-flash","supports_tool_calls":false,"supports_thinking":true}
=== Function Calling 实测 === {"supported":false,"detail":"MISSING_API_KEY: DeepSeek 需要 API Key"}
=== 普通对话 === {"ok":false,"error":"DeepSeek 需要 API Key"}
ERROR Provider 不可用，M2 未通过
ERROR 排查建议 {"key":"没有 API Key：设置 DEEPSEEK_API_KEY", "local":"本地模型：BWS_LLM_PRESET=openai-compatible ..."}
```

**如实报错，没有假装成功。**

### 4.2 本地 OpenAI 兼容（服务不存在）

```
=== Provider 健康 === {"state":"unavailable","message":"连不上模型服务：fetch failed","latency_ms":32}
=== Function Calling 实测 === {"supported":false,"detail":"NETWORK_ERROR: 连不上模型服务：fetch failed"}
```

### 4.3 会真调工具的假服务（多轮工具调用，M2 核心验收）

```
=== ① 健康检查 ===
  state=ok message=模型可用（local-demo-model，19ms）

=== ② Function Calling 实测 ===
  supported=true detail=模型返回了 1 个 tool_call

=== ③ 多轮工具调用 ===
  第 1 轮：finish=tool_calls toolCalls=1 reasoning=用户问玩家状态，我应该先调 get_player_statu
    模型要调：get_player_status
  第 2 轮：finish=stop toolCalls=0
  最终答复：根据工具返回的数据：{"ok":true,"player":{"name":"WX-78","health":{"percent":100}}} —— 玩家目前状态正常。
  usage: prompt=200 completion=40 total=240

=== ④ 模型信息 ===
  {"provider":"openai-compatible","model":"local-demo-model","supportsToolCalls":true,
   "supportsThinking":false,"contextLength":8192,"maxOutputTokens":2048}
```

这证明了：**Provider 层能正确处理"模型要工具 → 我们喂结果 → 模型继续"的完整往返**，包括 `reasoning_content` 与 `tool_call_id` 的保留。

## 5. 测试（16 个用例）

```
✔ 消息转换：assistant 保留 reasoning_content 与 tool_calls；tool 带 tool_call_id
✔ 响应解析：content / reasoning_content / tool_calls / usage
✔ chat：DeepSeek preset 把 thinking 放进 extra_body，且 thinking 模式不发 temperature
✔ chat：非 thinking 模式才发 temperature
✔ chat：tools + tool_choice=required 在 DeepSeek 下降级成 auto
✔ chat：openai-compatible preset 不发 extra_body
✔ 错误分类：401 / 429 / 404 / 500 / 400（工具不支持）
✔ 超时：服务不响应 → TIMEOUT 且 retryable
✔ 重试：429 后第二次成功（指数退避）
✔ 连不上服务 → NETWORK_ERROR
✔ probeToolCalls：模型返回 tool_calls → 判定支持
✔ probeToolCalls：模型只回文本不调工具 → 判定不支持（不假装成功）
✔ probeToolCalls：服务明确报错"不支持 tools" → 判定不支持并带原因
✔ healthCheck：正常 / 缺 Key / 鉴权失败 三种状态
✔ healthCheck：服务不可用 → unavailable
✔ 真实 DeepSeek 端点：无 Key 时明确报 MISSING_API_KEY（不静默）
# tests 16 / pass 16
```

## 6. 配置（全部环境变量，模型名不写死）

| 变量 | 默认 | 说明 |
|---|---|---|
| `BWS_LLM_PRESET` | `deepseek` | `deepseek` 或 `openai-compatible` |
| `BWS_LLM_BASE_URL` | `https://api.deepseek.com` | 本地示例：`http://127.0.0.1:8000/v1` |
| `BWS_LLM_API_KEY` / `DEEPSEEK_API_KEY` | 空 | DeepSeek 必填 |
| `BWS_LLM_MODEL` | `deepseek-flash` | **任意模型名**，不写死 |
| `BWS_LLM_THINKING` | `true` | 仅 deepseek 生效 |
| `BWS_LLM_REASONING_EFFORT` | `high` | `low` / `high` / `max` |
| `BWS_LLM_MAX_TOKENS` | `2048` | |
| `BWS_LLM_TEMPERATURE` | 不设 | thinking 模式会被忽略 |
| `BWS_LLM_TIMEOUT_MS` | `60000` | |
| `BWS_LLM_MAX_RETRIES` | `2` | |
| `BWS_LLM_CONTEXT_LENGTH` / `MAX_OUTPUT_TOKENS` | 不设 | 仅用于 ModelInfo 展示 |

## 7. 运行方式

```powershell
cd agent
npm run build

# 探测 LLM（M2）
$env:DEEPSEEK_API_KEY='sk-...'          # 有 Key 才测得了真实推理
node dist/src/index.js --llm

# 或者本地模型
$env:BWS_LLM_PRESET='openai-compatible'
$env:BWS_LLM_BASE_URL='http://127.0.0.1:8000/v1'
$env:BWS_LLM_MODEL='qwen2.5-7b-instruct'
node dist/src/index.js --llm

# 多轮工具调用演示（不需要任何 Key）
node test/demo-m2.mjs
```

## 8. 未完成项

1. **没有真实 DeepSeek 推理验证**：本机无 Key。所有 DeepSeek 特有行为（thinking 默认开、reasoning_content 强制回传）只按官方文档实现 + 假服务器验证，**未对真实端点跑过**。
2. **没有流式输出**：`stream: false`，M6 的 API 若要 SSE 推送需要补。
3. **没有本地模型实测**：本机没有 ollama/vLLM 在跑，`probeToolCalls` 的"支持"分支用假服务器验证。
4. **没有 token 计数校准**：直接透传 `usage`，没做本地估算。
5. **没有多 Provider 同时挂载**：一次只用一个 Provider（任务书没要求多路）。

## 9. 风险

1. **DeepSeek `reasoning_content` 回传是最容易踩的坑**：漏传直接 400。已在 `toOpenAIMessages` 里处理，但 M4 的 Agent Loop 必须保证**每一轮**都把 assistant 的 reasoning_content 存进历史（我在类型里强制了 `reasoningContent` 字段）。
2. **thinking 模式下 temperature 被忽略**：如果上层指望调温度控制输出，会失效（官方行为，已在代码里注释）。
3. **本地模型可能"假支持" function calling**：返回 200 但不给 tool_calls。`probeToolCalls` 会判成 false，但 M4 的 Agent Loop 还要处理"模型该调工具却不调"的情况（重试或直接答复）。
4. **重试可能与 tool_calls 重复执行冲突**：LLM 请求重试是安全的（幂等），但 M4 里**工具调用绝不能重试**（会重复执行游戏命令）。

## 10. 下一步（M3）

MCP Tool Schema → Function Calling 格式转换：
- 工具名/描述/JSON Schema/必填参数映射；
- 参数约束保留（enum/min/max）；
- 工具白名单（只读 12 个）；
- 模型给的 `arguments` 必须 `JSON.parse` + Schema 校验后才能执行；
- 工具结果 → `role: tool` 消息（保留 `tool_call_id`）。
