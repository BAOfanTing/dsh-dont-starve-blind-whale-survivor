// M2 真实链路演示：用一个"会真的调工具"的本地假模型服务，跑通
//   ① 健康检查 → ② function calling 实测 → ③ 多轮工具调用（模型要数据 → 我们喂 MCP 结果 → 模型给最终答复）
//
// 这个假服务实现了最小可用的 OpenAI 兼容协议（含 tool_calls 与 reasoning_content），
// 用来证明 Provider 层能正确处理真实的多轮工具调用，而不是只能单轮。
import { createServer } from 'node:http'
import { OpenAICompatibleProvider } from '../dist/src/llm/openaiProvider.js'
import { createLogger } from '../dist/src/utils/logger.js'

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') 
    const messages = (body.messages ?? []) 
    const tools = body.tools 
    const turn = {
      hasTools: Array.isArray(tools) && tools.length > 0,
      toolResultSeen: messages.some((message) => message.role === 'tool'),
    }

    let payload
    if (turn.hasTools && !turn.toolResultSeen) {
      // 第 1 轮：模型决定调工具
      payload = {
        model: body.model,
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: '用户问玩家状态，我应该先调 get_player_status',
              tool_calls: [
                { id: 'call_demo_1', type: 'function', function: { name: 'get_player_status', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 },
      }
    } else if (turn.toolResultSeen) {
      // 第 2 轮：拿到工具结果，给最终答复
      const toolMessage = messages.filter((message) => message.role === 'tool').at(-1)
      payload = {
        model: body.model,
        choices: [
          {
            message: {
              role: 'assistant',
              content: `根据工具返回的数据：${String(toolMessage?.content ?? '').slice(0, 80)} —— 玩家目前状态正常。`,
              reasoning_content: '工具结果已拿到，可以总结给用户',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 },
      }
    } else {
      payload = {
        model: body.model,
        choices: [{ message: { role: 'assistant', content: '你好，我是本地模型' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }
    }

    const text = JSON.stringify(payload)
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const baseUrl = `http://127.0.0.1:${port}/v1`

const logger = createLogger({ level: 'info' })
const llm = new OpenAICompatibleProvider(
  {
    preset: 'openai-compatible',
    baseUrl,
    apiKey: 'local-no-auth',
    model: 'local-demo-model',
    thinking: false,
    reasoningEffort: 'high',
    maxTokens: 512,
    temperature: 0.5,
    timeoutMs: 5000,
    maxRetries: 0,
    contextLength: 8192,
    maxOutputTokens: 2048,
  },
  logger,
)

console.log('=== ① 健康检查 ===')
const health = await llm.healthCheck()
console.log(`  state=${health.state} message=${health.message} latency=${health.latencyMs}ms`)

console.log('\n=== ② Function Calling 实测 ===')
const probe = await llm.probeToolCalls()
console.log(`  supported=${probe.supported} detail=${probe.detail}`)

console.log('\n=== ③ 多轮工具调用 ===')
const tools = [
  {
    type: 'function',
    function: {
      name: 'get_player_status',
      description: '查询玩家状态',
      parameters: { type: 'object', properties: {} },
    },
  },
]

const messages = [{ role: 'user', content: '我现在的状态怎么样？' }]
const round1 = await llm.chat(messages, { tools })
console.log(`  第 1 轮：finish=${round1.finishReason} toolCalls=${round1.toolCalls.length} reasoning=${(round1.reasoningContent ?? '').slice(0, 30)}`)
console.log(`    模型要调：${round1.toolCalls.map((call) => call.name).join(', ')}`)

// 保存 assistant 消息（含 reasoning_content 与 tool_calls）—— DeepSeek 带 tools 时必须回传
messages.push({
  role: 'assistant',
  content: round1.content,
  reasoningContent: round1.reasoningContent,
  toolCalls: round1.toolCalls,
})
// 模拟 MCP 工具返回
messages.push({
  role: 'tool',
  content: JSON.stringify({ ok: true, player: { name: 'WX-78', health: { percent: 100 } } }),
  toolCallId: round1.toolCalls[0].id,
  name: round1.toolCalls[0].name,
})

const round2 = await llm.chat(messages, { tools })
console.log(`  第 2 轮：finish=${round2.finishReason} toolCalls=${round2.toolCalls.length}`)
console.log(`  最终答复：${round2.content}`)
console.log(`  usage: prompt=${round2.usage.promptTokens} completion=${round2.usage.completionTokens} total=${round2.usage.totalTokens}`)

console.log('\n=== ④ 模型信息 ===')
console.log(`  ${JSON.stringify(await llm.getModelInfo())}`)

server.close()
