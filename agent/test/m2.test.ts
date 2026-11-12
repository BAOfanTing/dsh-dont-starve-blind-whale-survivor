// M2 测试：LLM Provider（用假 OpenAI 兼容服务器，覆盖各种真实场景）
//
// 为什么要假服务器：没有 API Key，但**协议行为必须真实验证** ——
// tool_calls 解析、reasoning_content 回传、400/429/超时/不支持 function calling 的处理，
// 这些都能在本地假服务器上精确构造。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { OpenAICompatibleProvider, fromRawCompletion, toOpenAIMessages } from '../src/llm/openaiProvider.js'
import { ProviderError, type LLMMessage } from '../src/llm/types.js'
import { createLogger } from '../src/utils/logger.js'

const quiet = () => createLogger({ level: 'error', sink: () => {} })

interface FakeServer {
  base: string
  requests: Array<Record<string, any>>
  close: () => Promise<void>
  setHandler: (handler: (body: Record<string, any>, index: number) => { status: number; body: unknown } | 'hang') => void
}

async function startFake(): Promise<FakeServer> {
  const requests: Array<Record<string, any>> = []
  let handler: (body: Record<string, any>, index: number) => { status: number; body: unknown } | 'hang' = () => ({
    status: 200,
    body: { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] },
  })
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>
      requests.push(body)
      const result = handler(body, requests.length - 1)
      if (result === 'hang') return // 永不响应，用于超时测试
      const text = JSON.stringify(result.body)
      res.writeHead(result.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    setHandler: (next) => {
      handler = next
    },
  }
}

function provider(base: string, overrides: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) {
  return new OpenAICompatibleProvider(
    {
      preset: 'deepseek',
      baseUrl: base,
      apiKey: 'test-key',
      model: 'deepseek-flash',
      thinking: true,
      reasoningEffort: 'high',
      maxTokens: 1024,
      temperature: null,
      timeoutMs: 3000,
      maxRetries: 0,
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      ...overrides,
    },
    quiet(),
  )
}

test('消息转换：assistant 保留 reasoning_content 与 tool_calls；tool 带 tool_call_id', () => {
  const messages: LLMMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: null,
      reasoningContent: '我想查一下状态',
      toolCalls: [{ id: 'call_1', name: 'get_player_status', arguments: '{}' }],
    },
    { role: 'tool', content: '{"ok":true}', toolCallId: 'call_1', name: 'get_player_status' },
  ]
  const converted = toOpenAIMessages(messages)
  assert.equal(converted[0]?.role, 'system')
  const assistant = converted[2] as Record<string, any>
  assert.equal(assistant.reasoning_content, '我想查一下状态', 'reasoning_content 必须保留（DeepSeek 带 tools 时要求回传）')
  assert.equal(assistant.tool_calls[0].id, 'call_1')
  assert.equal(assistant.tool_calls[0].function.name, 'get_player_status')
  const tool = converted[3] as Record<string, any>
  assert.equal(tool.tool_call_id, 'call_1', 'tool 消息必须带 tool_call_id')
})

test('响应解析：content / reasoning_content / tool_calls / usage', () => {
  const response = fromRawCompletion(
    {
      model: 'deepseek-flash',
      choices: [
        {
          message: {
            role: 'assistant',
            content: '我来看看',
            reasoning_content: '用户想知道玩家状态',
            tool_calls: [
              { id: 'call_abc', type: 'function', function: { name: 'get_player_status', arguments: '{"x":1}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 64 },
    },
    123,
    'fallback',
  )
  assert.equal(response.content, '我来看看')
  assert.equal(response.reasoningContent, '用户想知道玩家状态')
  assert.equal(response.toolCalls.length, 1)
  assert.equal(response.toolCalls[0]?.id, 'call_abc')
  assert.equal(response.toolCalls[0]?.arguments, '{"x":1}')
  assert.equal(response.finishReason, 'tool_calls')
  assert.equal(response.usage.cachedTokens, 64)
  assert.equal(response.elapsedMs, 123)
})

test('chat：DeepSeek preset 把 thinking 放进 extra_body，且 thinking 模式不发 temperature', async () => {
  const fake = await startFake()
  try {
    const llm = provider(fake.base, { temperature: 0.7 })
    await llm.chat([{ role: 'user', content: 'hi' }], { thinking: true })
    const body = fake.requests[0]!
    assert.deepEqual(body.extra_body, { thinking: { type: 'enabled' } }, 'thinking 必须走 extra_body')
    assert.equal(body.reasoning_effort, 'high')
    assert.equal(body.temperature, undefined, 'thinking 模式不该发 temperature（官方不支持）')
    assert.equal(body.model, 'deepseek-flash')
  } finally {
    await fake.close()
  }
})

test('chat：非 thinking 模式才发 temperature', async () => {
  const fake = await startFake()
  try {
    const llm = provider(fake.base, { temperature: 0.3 })
    await llm.chat([{ role: 'user', content: 'hi' }], { thinking: false })
    const body = fake.requests[0]!
    assert.deepEqual(body.extra_body, { thinking: { type: 'disabled' } })
    assert.equal(body.temperature, 0.3)
    assert.equal(body.reasoning_effort, undefined)
  } finally {
    await fake.close()
  }
})

test('chat：tools + tool_choice=required 在 DeepSeek 下降级成 auto（不兼容 required）', async () => {
  const fake = await startFake()
  try {
    const llm = provider(fake.base)
    await llm.chat([{ role: 'user', content: 'hi' }], {
      tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object', properties: {} } } }],
      toolChoice: 'required',
    })
    assert.equal(fake.requests[0]!.tool_choice, 'auto', 'DeepSeek thinking 只支持 auto/none')
  } finally {
    await fake.close()
  }
})

test('chat：openai-compatible preset 不发 extra_body（本地服务通常不认）', async () => {
  const fake = await startFake()
  try {
    const llm = provider(fake.base, { preset: 'openai-compatible' })
    await llm.chat([{ role: 'user', content: 'hi' }])
    const body = fake.requests[0]!
    assert.equal(body.extra_body, undefined)
    assert.equal(body.reasoning_effort, undefined)
  } finally {
    await fake.close()
  }
})

test('错误分类：401 / 429 / 404 / 500 / 400（工具不支持）', async () => {
  const fake = await startFake()
  try {
    const cases: Array<[number, unknown, string]> = [
      [401, { error: { message: 'invalid key' } }, 'UNAUTHORIZED'],
      [429, { error: { message: 'rate limited' } }, 'RATE_LIMITED'],
      [404, { error: { message: 'model not found' } }, 'MODEL_NOT_FOUND'],
      [500, { error: { message: 'boom' } }, 'SERVER_ERROR'],
      [400, { error: { message: 'tools are not supported by this model' } }, 'TOOL_CALLS_UNSUPPORTED'],
      [400, { error: { message: 'reasoning_content is required' } }, 'BAD_REQUEST'],
    ]
    for (const [status, body, expected] of cases) {
      fake.setHandler(() => ({ status, body }))
      const llm = provider(fake.base)
      await assert.rejects(
        () => llm.chat([{ role: 'user', content: 'hi' }]),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError)
          assert.equal(error.code, expected, `status=${status} 应映射成 ${expected}，实际 ${error.code}`)
          return true
        },
      )
    }
  } finally {
    await fake.close()
  }
})

test('超时：服务不响应 → TIMEOUT 且 retryable', async () => {
  const fake = await startFake()
  try {
    fake.setHandler(() => 'hang')
    const llm = provider(fake.base, { timeoutMs: 200, maxRetries: 0 })
    await assert.rejects(
      () => llm.chat([{ role: 'user', content: 'hi' }]),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.equal(error.code, 'TIMEOUT')
        assert.equal(error.retryable, true)
        return true
      },
    )
  } finally {
    await fake.close()
  }
})

test('重试：429 后第二次成功（指数退避）', async () => {
  const fake = await startFake()
  try {
    fake.setHandler((_body, index) =>
      index === 0
        ? { status: 429, body: { error: { message: 'slow down' } } }
        : { status: 200, body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } },
    )
    const llm = provider(fake.base, { maxRetries: 2 })
    const response = await llm.chat([{ role: 'user', content: 'hi' }])
    assert.equal(response.content, 'ok')
    assert.equal(fake.requests.length, 2, '应重试一次')
  } finally {
    await fake.close()
  }
})

test('连不上服务 → NETWORK_ERROR', async () => {
  const fake = await startFake()
  const base = fake.base
  await fake.close()
  const llm = provider(base, { maxRetries: 0 })
  await assert.rejects(
    () => llm.chat([{ role: 'user', content: 'hi' }]),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.equal(error.code, 'NETWORK_ERROR')
      return true
    },
  )
})

test('probeToolCalls：模型返回 tool_calls → 判定支持', async () => {
  const fake = await startFake()
  try {
    fake.setHandler(() => ({
      status: 200,
      body: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping_tool', arguments: '{"echo":"ok"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    }))
    const llm = provider(fake.base)
    const result = await llm.probeToolCalls()
    assert.equal(result.supported, true, result.detail)
    const info = await llm.getModelInfo()
    assert.equal(info.supportsToolCalls, true, '实测结论要反映到 getModelInfo')
  } finally {
    await fake.close()
  }
})

test('probeToolCalls：模型只回文本不调工具 → 判定不支持（不假装成功）', async () => {
  const fake = await startFake()
  try {
    fake.setHandler(() => ({
      status: 200,
      body: { choices: [{ message: { role: 'assistant', content: '我不会调用工具' }, finish_reason: 'stop' }] },
    }))
    const llm = provider(fake.base)
    const result = await llm.probeToolCalls()
    assert.equal(result.supported, false)
    assert.match(result.detail, /没有返回 tool_calls/)
    const info = await llm.getModelInfo()
    assert.equal(info.supportsToolCalls, false)
  } finally {
    await fake.close()
  }
})

test('probeToolCalls：服务明确报错"不支持 tools" → 判定不支持并带原因', async () => {
  const fake = await startFake()
  try {
    fake.setHandler(() => ({ status: 400, body: { error: { message: 'tools are not supported' } } }))
    const llm = provider(fake.base)
    const result = await llm.probeToolCalls()
    assert.equal(result.supported, false)
    assert.match(result.detail, /TOOL_CALLS_UNSUPPORTED/)
  } finally {
    await fake.close()
  }
})

test('healthCheck：正常 / 缺 Key / 鉴权失败 三种状态', async () => {
  const fake = await startFake()
  try {
    const ok = provider(fake.base)
    const okHealth = await ok.healthCheck()
    assert.equal(okHealth.state, 'ok')
    assert.ok(okHealth.latencyMs !== null)

    const noKey = provider(fake.base, { apiKey: '' })
    const noKeyHealth = await noKey.healthCheck()
    assert.equal(noKeyHealth.state, 'misconfigured')
    assert.match(noKeyHealth.message, /API Key/)

    fake.setHandler(() => ({ status: 401, body: { error: { message: 'bad key' } } }))
    const badKey = provider(fake.base)
    const badHealth = await badKey.healthCheck()
    assert.equal(badHealth.state, 'misconfigured')
  } finally {
    await fake.close()
  }
})

test('healthCheck：服务不可用 → unavailable', async () => {
  const fake = await startFake()
  const base = fake.base
  await fake.close()
  const llm = provider(base, { maxRetries: 0 })
  const health = await llm.healthCheck()
  assert.equal(health.state, 'unavailable')
})

test('真实 DeepSeek 端点：无 Key 时明确报 MISSING_API_KEY（不静默）', async () => {
  const llm = provider('https://api.deepseek.com', { apiKey: '' })
  await assert.rejects(
    () => llm.chat([{ role: 'user', content: 'hi' }]),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.equal(error.code, 'MISSING_API_KEY')
      return true
    },
  )
})
