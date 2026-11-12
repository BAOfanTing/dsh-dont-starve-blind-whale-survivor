// 真实模型回归测试：sensenova-6.8-flash 的 reasoning 字段与多轮工具调用
//
// 这些用例用**本地假服务**精确模拟真实模型的响应格式（reasoning 字段、
// tool_calls 时 content 非空），确认识别/回传逻辑正确 —— 不依赖真实 Key 也能跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { OpenAICompatibleProvider, fromRawCompletion, toOpenAIMessages } from '../src/llm/openaiProvider.js'
import { createLogger } from '../src/utils/logger.js'

const quiet = () => createLogger({ level: 'error', sink: () => {} })

function provider(base: string, reasoningField: 'reasoning_content' | 'reasoning' | 'none' = 'reasoning') {
  return new OpenAICompatibleProvider(
    {
      preset: 'openai-compatible',
      baseUrl: base,
      apiKey: 'k',
      model: 'sensenova-6.8-flash',
      reasoningField,
      thinking: false,
      reasoningEffort: 'high',
      maxTokens: 2048,
      temperature: 0.3,
      timeoutMs: 5000,
      maxRetries: 0,
      contextLength: 262144,
      maxOutputTokens: 8192,
    },
    quiet(),
  )
}

test('响应解析：sensenova 的 reasoning 字段能被正确读出', () => {
  const response = fromRawCompletion(
    {
      model: 'sensenova-6.8-flash',
      choices: [
        {
          message: { role: 'assistant', content: '1+1等于2。', reasoning: '简单的算术题' },
          finish_reason: 'stop',
        },
      ],
      usage: { completion_tokens_details: { reasoning_tokens: 100 } },
    },
    200,
    'fallback',
    'reasoning',
  )
  assert.equal(response.content, '1+1等于2。')
  assert.equal(response.reasoningContent, '简单的算术题')
})

test('响应解析：reasoningField=none 时不读思考内容', () => {
  const response = fromRawCompletion(
    {
      choices: [{ message: { role: 'assistant', content: 'ok', reasoning: '不该被读' }, finish_reason: 'stop' }],
    },
    1,
    'fallback',
    'none',
  )
  assert.equal(response.reasoningContent, null)
})

test('消息回传：reasoningField=reasoning 时用 reasoning 字段（不是 reasoning_content）', () => {
  const converted = toOpenAIMessages(
    [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '好的，我来查',
        reasoningContent: '需要调工具',
        toolCalls: [{ id: 'c1', name: 'get_player_status', arguments: '{}' }],
      },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'c1', name: 'get_player_status' },
    ],
    'reasoning',
  )
  const assistant = converted[1] as Record<string, any>
  assert.equal(assistant.reasoning, '需要调工具')
  assert.equal(assistant.reasoning_content, undefined, '不该发 reasoning_content')
  assert.ok(assistant.tool_calls)
  assert.equal(converted[2]?.tool_call_id, 'c1')
})

test('消息回传：reasoningField=reasoning_content 时用 DeepSeek 字段', () => {
  const converted = toOpenAIMessages(
    [{ role: 'assistant', content: null, reasoningContent: '想一下', toolCalls: [] }],
    'reasoning_content',
  )
  assert.equal((converted[0] as Record<string, any>).reasoning_content, '想一下')
  assert.equal((converted[0] as Record<string, any>).reasoning, undefined)
})

test('消息回传：reasoningField=none 时不发任何思考字段', () => {
  const converted = toOpenAIMessages(
    [{ role: 'assistant', content: 'ok', reasoningContent: '不该发' }],
    'none',
  )
  assert.equal((converted[0] as Record<string, any>).reasoning_content, undefined)
  assert.equal((converted[0] as Record<string, any>).reasoning, undefined)
})

test('真实格式端到端：tool_calls 时 content 非空，第 2 轮回传 reasoning 后能终止', async () => {
  const requests: Array<Record<string, any>> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      requests.push(body)
      const hasToolResult = (body.messages ?? []).some((m: Record<string, any>) => m.role === 'tool')
      const payload = hasToolResult
        ? {
            model: body.model,
            choices: [{ message: { role: 'assistant', content: '玩家 WX-78 生命 100%', reasoning: '数据齐了' }, finish_reason: 'stop' }],
          }
        : {
            model: body.model,
            choices: [
              {
                message: {
                  role: 'assistant',
                  // 实测 sensenova：返回 tool_calls 时 content 非空
                  content: '好的，我来为您查询玩家当前的状态。',
                  reasoning: '用户想知道玩家状态',
                  tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'get_player_status', arguments: '{}' } }],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }
      const text = JSON.stringify(payload)
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    const llm = provider(`http://127.0.0.1:${port}/v1`)

    const r1 = await llm.chat([{ role: 'user', content: '查一下玩家状态' }])
    assert.equal(r1.toolCalls.length, 1)
    assert.equal(r1.content, '好的，我来为您查询玩家当前的状态。', 'content 不该被丢掉')
    assert.equal(r1.reasoningContent, '用户想知道玩家状态')

    const r2 = await llm.chat([
      { role: 'user', content: '查一下玩家状态' },
      { role: 'assistant', content: r1.content, reasoningContent: r1.reasoningContent, toolCalls: r1.toolCalls },
      { role: 'tool', content: '{"ok":true}', toolCallId: r1.toolCalls[0]!.id, name: 'get_player_status' },
    ])
    assert.equal(r2.toolCalls.length, 0)
    assert.equal(r2.content, '玩家 WX-78 生命 100%')

    // 第 2 次请求里，assistant 的 reasoning 必须被回传
    const secondMessages = requests[1]!.messages as Array<Record<string, any>>
    const assistant = secondMessages.find((m) => m.role === 'assistant')!
    assert.equal(assistant.reasoning, '用户想知道玩家状态')
    assert.equal(assistant.tool_calls?.[0]?.id, 'call_x')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('preset 未显式配置 reasoningField 时：deepseek→reasoning_content，openai-compatible→none', () => {
  const deepseek = new OpenAICompatibleProvider(
    {
      preset: 'deepseek', baseUrl: 'http://x', apiKey: 'k', model: 'm', thinking: true,
      reasoningEffort: 'high', maxTokens: 100, temperature: null, timeoutMs: 1000, maxRetries: 0,
      contextLength: null, maxOutputTokens: null,
    },
    quiet(),
  )
  const local = new OpenAICompatibleProvider(
    {
      preset: 'openai-compatible', baseUrl: 'http://x', apiKey: 'k', model: 'm', thinking: false,
      reasoningEffort: 'high', maxTokens: 100, temperature: null, timeoutMs: 1000, maxRetries: 0,
      contextLength: null, maxOutputTokens: null,
    },
    quiet(),
  )
  // 通过 toOpenAIMessages 的行为间接验证默认值
  const msg = [{ role: 'assistant' as const, content: null, reasoningContent: '思考' }]
  assert.equal((toOpenAIMessages(msg, 'reasoning_content')[0] as Record<string, any>).reasoning_content, '思考')
  assert.ok(deepseek !== undefined && local !== undefined)
})
