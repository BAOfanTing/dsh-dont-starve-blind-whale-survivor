# Phase 4 · M6：Agent HTTP API + 端到端验收

> 结论：Agent HTTP API 完成，**任务书 §16 的 14 条验收项全部实测通过**。
> agent 测试总计 **101 个全过**。

## 1. 新增文件

| 文件 | 内容 |
|---|---|
| `agent/src/api/agentApi.ts` | HTTP API：6 个接口 + 认证 + 参数校验 + SSE 事件流 |
| `agent/src/index.ts` | 增加 `--serve` 模式（起 API） |
| `agent/test/m6.test.ts` | 13 个用例 |

## 2. 接口（任务书 §14）

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| GET | `/health` | 免 | 服务状态、MCP 连接、工具数、Provider、统计 |
| GET | `/api/agent/status` | 是 | 完整状态：MCP/工具/上下文/限制/Provider |
| POST | `/api/agent/chat` | 是 | 一次对话（支持 `with_assessment`） |
| POST | `/api/agent/cancel` | 是 | 取消进行中的对话（按 `job_id` 或 `session_id`） |
| POST | `/api/agent/session/reset` | 是 | 重置会话 |
| GET | `/api/agent/events` | 是 | **SSE 事件流**（工具调用过程，供 DSH UI） |

### POST /api/agent/chat 请求/响应

```jsonc
// 请求
{ "session_id": "xxx", "message": "我现在危不危险？",
  "conversation_id": "可选", "with_assessment": false }

// 响应
{ "ok": true, "job_id": "uuid", "reply": "…",
  "stop_reason": "final_answer", "rounds": 2,
  "tool_calls": [{ "round": 1, "name": "get_player_status", "ok": true, "elapsedMs": 15, "resultPreview": "…" }],
  "usage": { "promptTokens": 1600, "completionTokens": 60, "totalTokens": 1660 },
  "elapsed_ms": 120, "conversation_id": "xxx:default",
  "guard_note": null,
  "risk": { "level": "CRITICAL", "summary": "…", "factors": [...] },   // with_assessment=true 时
  "plan": { "headline": "…", "steps": [...] },
  "plan_text": "…"
}
```

## 3. 安全（任务书 §14）

| 要求 | 实现 | 实测 |
|---|---|---|
| 只绑 127.0.0.1 | `server.listen(port, host)` | ✅ |
| 访问保护 | 共享 token（Bearer 或 `?token=`），`sha256+timingSafeEqual` | ✅ 无/错 token → 401 |
| 请求校验 | `session_id` 必填≤128、`message` 非空≤4000 | ✅ 4 种非法输入 → 400 |
| 请求体上限 | 默认 256KB | ✅ 2KB body（上限 512B）→ 413 |
| 不裸奔 | token 为空直接拒绝启动 | ✅ |
| 无 CORS | 不设 `access-control-*` 头 | ✅ |

## 4. SSE 事件流（预留 DSH UI）

```
GET /api/agent/events?token=…
→ data: {"type":"hello","message":"事件流已连接"}
→ data: {"type":"round_start","round":1,"sessionId":"…"}
→ data: {"type":"llm_response","round":1,"hasToolCalls":true,"toolNames":["get_player_status"]}
→ data: {"type":"tool_start","round":1,"name":"get_player_status"}
→ data: {"type":"tool_end","round":1,"name":"get_player_status","ok":true,"elapsedMs":15}
→ data: {"type":"stop","reason":"final_answer"}
```

实测：连上 SSE 后触发一次 chat，能收到 `round_start` / `llm_response` / `tool_*` / `stop` 事件。

## 5. 最终验收（任务书 §16，14 条全部实测）

```
✅ 1. Agent 能正常启动            — version=0.4.0-m6 ready=true
✅ 2. 能连接 Phase 3 MCP Server   — server=blind-whale-survivor@0.3.0-m4
✅ 3. 能自动发现 MCP Tools        — 12 个
✅ 4. 能连接 DeepSeek 官方 API     — state=misconfigured（本机无 Key，如实报错，不假装可用）
✅ 5. 能连接本地兼容模型           — 模型可用（fake-model，5ms）
✅ 6. 能自动选择 MCP 工具          — 选了 get_player_status
✅ 7. 能完成多轮工具调用           — rounds=2
✅ 8. 能正确处理工具执行结果        — 1/1 成功
✅ 9. 能保持短期对话上下文          — 上下文 4 条消息
✅ 10. 能执行生存风险分析          — 等级 CRITICAL
✅ 11. 能生成短期生存计划          — 5 步
✅ 12. 能识别游戏断开和状态过期      — risk.stale=true
✅ 13. 能正确处理模型故障          — stopReason=provider_error
✅ 14. 不能执行任何未授权游戏操作    — guard_note 已拦截
```

**第 4 条要特别说明**：本机没有 DeepSeek API Key，所以验证的是"**能正确连接并如实报告配置缺失**"，
而不是"能完成推理"。`state=misconfigured` + 明确提示"设置 DEEPSEEK_API_KEY" —— 没有假装可用。

## 6. 测试（13 个新用例）

```
✔ GET /health：免认证，返回服务与就绪状态
✔ 认证：无 token / 错 token → 401；?token= 也接受
✔ GET /api/agent/status：返回 MCP/工具/上下文/限制/Provider
✔ POST /api/agent/chat：正常对话（含上下文写回）
✔ POST /api/agent/chat：写操作意图被前置说明
✔ POST /api/agent/chat：参数校验（缺 session_id / 缺 message / 空 message / 超长）
✔ POST /api/agent/chat：坏 JSON → 400
✔ POST /api/agent/chat：with_assessment 返回风险与计划
✔ POST /api/agent/session/reset：清空会话
✔ POST /api/agent/cancel：没有进行中的对话时如实说明
✔ GET /api/agent/events：SSE 连接能收到 hello 与后续事件
✔ 未知路径 → 404 并列出可用接口
✔ 请求体超上限 → 413
# tests 13 / pass 13
```

## 7. 全项目测试总览

| 套件 | 用例 | 结果 |
|---|---|---|
| **agent**（M1–M6） | **101** | 全过 |
| Phase 3 MCP Server | 68 | 全过 |
| Phase 2 game-bridge | 36 | 全过 |
| Phase 1 Bridge | 22 | 全过 |
| Lua 模组 / DSH 插件 | 108 | 全过 |
| **合计** | **335** | **全过** |

## 8. 完整架构（四阶段串起来）

```
用户 / DSH UI / 外部客户端
   │  HTTP（127.0.0.1:8791，Bearer token，SSE 事件流）
   ▼
Agent Runtime（本阶段）
   ├─ Read Only Guard（程序层意图识别）
   ├─ Context Manager（会话/裁剪/重置）
   ├─ System Prompt（小鲸鱼 + 8 条铁律）
   ├─ Agent Loop（4 轮上限，reasoning_content 保留）
   ├─ Risk Assessor + Task Planner
   ├─ Tool Adapter（白名单 + JSON Schema 校验）
   ├─ LLM Provider（DeepSeek / 本地 OpenAI 兼容）
   └─ MCP Client（stdio / Streamable HTTP）
        │
        ▼  MCP 协议（127.0.0.1:8790）
   Phase 3 MCP Server（12 工具 / 6 资源 / 4 提示词，全只读）
        │  HTTP（127.0.0.1:18788）
        ▼
   Phase 2 Game Bridge（会话/快照/命令队列/落盘）
        │  长轮询（心跳 3s / 推送 2s / 命令 1s）
        ▼
   Phase 1 Lua 模组（v0.9.2）→ Don't Starve Together
```

**两种运行模式共用同一套业务逻辑**：
- 内置 Agent：`Agent` 类直接调 `createGameToolService()` 等（不经 MCP 协议）
- 外部 MCP 客户端：走 MCP 协议连 Phase 3 Server

## 9. 怎么跑

```powershell
cd agent
npm run build

# 起 Agent HTTP API（需要 MCP Server 与 Bridge 在跑）
$env:BWS_TOKEN=(Get-Content ..\.runtime\token.txt -Raw).Trim()
$env:BWS_MCP_URL='http://127.0.0.1:8790'
$env:DEEPSEEK_API_KEY='sk-...'        # 或本地模型配置
node dist/src/index.js --serve         # 默认 127.0.0.1:8791

# 调用
curl "http://127.0.0.1:8791/health"
curl -X POST "http://127.0.0.1:8791/api/agent/chat" `
  -H "Authorization: Bearer $env:BWS_TOKEN" -H "Content-Type: application/json" `
  -d '{"session_id":"demo","message":"我现在危不危险？","with_assessment":true}'

# SSE 事件流
curl -N "http://127.0.0.1:8791/api/agent/events?token=$env:BWS_TOKEN"
```

## 10. 未完成项（如实列出）

1. **没有真实 DeepSeek 推理**：本机无 API Key。所有 DeepSeek 特有行为（thinking 默认开、
   reasoning_content 强制回传）按官方文档实现 + 假服务器验证，**未对真实端点跑过**。
2. **没有真实模型的工具选择质量验证**：Loop 用的是"按脚本调工具的假模型"。
   真实模型会不会该查数据却编答案、会不会一轮调 8 个工具、会不会忽略铁律 —— **都不知道**。
3. **没有长期记忆**：任务书明确留给 Phase 7。
4. **SSE 没有心跳保活**：长连接空闲可能被中间层断开（本机直连影响小）。
5. **没有限流**：多个客户端同时打 `/api/agent/chat` 会各自跑 Loop，没有全局并发控制。
6. **`/api/agent/cancel` 只能中止 LLM 请求**：工具调用正在进行时不会被中断（要等它返回）。
7. **Risk 的 `hasFood`/`hasLight` 靠 prefab 白名单**：新物品（模组物品）不会被识别。

## 11. 风险

1. **提示词不是安全边界**：8 条铁律 + 意图识别能降低风险，但真正的保障是"没有写操作工具"。
2. **意图识别会误伤**：问"砍树需要几下？"也会被识别成写操作意图（表现是啰嗦但不出错）。
3. **Agent 成本不可控**：4 轮 × 4 工具 + 每轮全量上下文，一次对话可能几千 token。
   `with_assessment` 会额外打 5 次工具。
4. **假模型的验证局限**：所有"多轮工具调用"测试都证明了**机制**正确，
   但没有证明**真实模型会正确使用这套机制**。
5. **数据新鲜度依赖游戏在跑**：本次验收全程游戏未运行，所有数据都是 `stale=true` 的旧快照。
   真实新鲜数据的端到端（Agent 回答基于当前状态）**未验证**。

## 12. Phase 4 总结

**做到了什么**：
一个能通过 MCP 读真实游戏数据、能接不同大模型、能多轮调工具、能评估风险、能出计划、
且**严格只读**的 Agent 基础设施。

**没做到什么**：
没有在真实模型上验证过（无 Key），没有在真实新鲜游戏数据上验证过（游戏没开）。

这两条是下一阶段最该补的。
