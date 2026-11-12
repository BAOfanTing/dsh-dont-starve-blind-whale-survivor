// M4 测试：Agent Loop（多轮工具调用 / 上限 / reasoning_content 保留）+ Risk + Planner
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop, DEFAULT_LIMITS } from '../src/runtime/agentLoop.js'
import { assessRisk, DEFAULT_THRESHOLDS } from '../src/runtime/riskAssessor.js'
import { buildPlan, renderPlan } from '../src/runtime/taskPlanner.js'
import type { LLMChatOptions, LLMMessage, LLMProvider, LLMResponse } from '../src/llm/types.js'
import { ProviderError } from '../src/llm/types.js'
import type { ToolAdapter, ToolCallOutcome } from '../src/mcp/toolAdapter.js'
import { createLogger } from '../src/utils/logger.js'

const quiet = () => createLogger({ level: 'error', sink: () => {} })

/** 可编排的假 Provider：按脚本依次返回响应 */
class ScriptedProvider implements LLMProvider {
  readonly calls: Array<{ messages: LLMMessage[]; options: LLMChatOptions }> = []
  constructor(private readonly script: Array<LLMResponse | Error>) {}

  async chat(messages: LLMMessage[], options: LLMChatOptions = {}): Promise<LLMResponse> {
    this.calls.push({ messages: [...messages], options })
    const next = this.script.shift()
    if (next === undefined) throw new Error('ScriptedProvider: 脚本用完了')
    if (next instanceof Error) throw next
    return next
  }

  async getModelInfo() {
    return {
      provider: 'scripted',
      model: 'scripted',
      baseUrl: 'scripted',
      supportsToolCalls: true,
      supportsThinking: true,
      contextLength: null,
      maxOutputTokens: null,
    }
  }

  async healthCheck() {
    return { state: 'ok' as const, message: 'ok', latencyMs: 1, checkedAt: Date.now() }
  }
}

function makeResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: '好的',
    reasoningContent: null,
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: null, reasoningTokens: null },
    model: 'scripted',
    elapsedMs: 5,
    ...overrides,
  }
}

/** 假 ToolAdapter：只记录被调了什么 */
function makeAdapter(options: { failTools?: string[]; resultText?: string } = {}): {
  adapter: ToolAdapter
  executed: Array<{ name: string; args: string }>
} {
  const executed: Array<{ name: string; args: string }> = []
  const adapter = {
    toolDefinitions: () => [
      { type: 'function' as const, function: { name: 'get_player_status', description: 'd', parameters: { type: 'object', properties: {} } } },
      { type: 'function' as const, function: { name: 'get_world_status', description: 'd', parameters: { type: 'object', properties: {} } } },
    ],
    executeToolCall: async (call: { id: string; name: string; arguments: string }): Promise<ToolCallOutcome> => {
      executed.push({ name: call.name, args: call.arguments })
      const shouldFail = options.failTools?.includes(call.name) === true
      return {
        toolCallId: call.id,
        name: call.name,
        ok: !shouldFail,
        content: shouldFail ? '[TOOL_CALL_FAILED] boom' : (options.resultText ?? '{"ok":true,"player":{"name":"WX-78"}}'),
        structured: shouldFail ? { ok: false } : { ok: true },
        elapsedMs: 3,
        ...(shouldFail ? { errorCode: 'TOOL_CALL_FAILED' } : {}),
      }
    },
  } as unknown as ToolAdapter
  return { adapter, executed }
}

// ───────────────────────── Agent Loop ─────────────────────────

test('Loop：无工具调用 → 一轮出最终答复', async () => {
  const provider = new ScriptedProvider([makeResponse({ content: '玩家状态正常' })])
  const { adapter, executed } = makeAdapter()
  const loop = new AgentLoop(provider, adapter, quiet())
  const result = await loop.run([], '我怎么样？')
  assert.equal(result.stopReason, 'final_answer')
  assert.equal(result.reply, '玩家状态正常')
  assert.equal(result.rounds, 1)
  assert.equal(executed.length, 0)
  assert.equal(result.toolCalls.length, 0)
})

test('Loop：多轮工具调用（要工具 → 执行 → 喂回 → 出答复）', async () => {
  const provider = new ScriptedProvider([
    makeResponse({
      content: null,
      reasoningContent: '需要先查玩家状态',
      toolCalls: [{ id: 'call_1', name: 'get_player_status', arguments: '{}' }],
      finishReason: 'tool_calls',
    }),
    makeResponse({ content: '玩家是 WX-78，状态正常' }),
  ])
  const { adapter, executed } = makeAdapter()
  const loop = new AgentLoop(provider, adapter, quiet())
  const result = await loop.run([], '我怎么样？')

  assert.equal(result.stopReason, 'final_answer')
  assert.equal(result.rounds, 2)
  assert.equal(result.reply, '玩家是 WX-78，状态正常')
  assert.equal(executed.length, 1)
  assert.equal(executed[0]?.name, 'get_player_status')
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0]?.ok, true)
  assert.equal(result.usage.totalTokens, 30, '两轮 token 应累加')
})

test('Loop：reasoning_content 必须进历史（DeepSeek 带 tools 时强制要求）', async () => {
  const provider = new ScriptedProvider([
    makeResponse({
      content: null,
      reasoningContent: '先查玩家',
      toolCalls: [{ id: 'call_1', name: 'get_player_status', arguments: '{}' }],
      finishReason: 'tool_calls',
    }),
    makeResponse({ content: '完成' }),
  ])
  const { adapter } = makeAdapter()
  const loop = new AgentLoop(provider, adapter, quiet())
  await loop.run([], 'q')

  // 第 2 次请求的历史里，必须能找到带 reasoning_content 的 assistant 消息
  const secondCall = provider.calls[1]!
  const assistant = secondCall.messages.find((message) => message.role === 'assistant')
  assert.ok(assistant, '第 2 次请求应包含 assistant 消息')
  assert.equal(assistant.reasoningContent, '先查玩家', 'reasoning_content 必须保留')
  assert.equal(assistant.toolCalls?.length, 1, 'tool_calls 必须保留')
  assert.equal(assistant.toolCalls?.[0]?.id, 'call_1')

  // 工具结果消息必须带 toolCallId
  const toolMessage = secondCall.messages.find((message) => message.role === 'tool')
  assert.ok(toolMessage)
  assert.equal(toolMessage.toolCallId, 'call_1', 'tool 消息必须带 tool_call_id')
  assert.equal(toolMessage.name, 'get_player_status')
})

test('Loop：达到轮次上限 → 终止并报告（不假装完成）', async () => {
  const provider = new ScriptedProvider([
    makeResponse({ toolCalls: [{ id: 'c1', name: 'get_player_status', arguments: '{}' }], finishReason: 'tool_calls' }),
    makeResponse({ toolCalls: [{ id: 'c2', name: 'get_world_status', arguments: '{}' }], finishReason: 'tool_calls' }),
    makeResponse({ toolCalls: [{ id: 'c3', name: 'get_player_status', arguments: '{}' }], finishReason: 'tool_calls' }),
  ])
  const { adapter } = makeAdapter()
  const loop = new AgentLoop(provider, adapter, quiet(), { limits: { maxRounds: 3 } })
  const result = await loop.run([], '一直查')
  assert.equal(result.stopReason, 'max_rounds')
  assert.match(result.reply, /最大轮次限制/)
  assert.equal(result.rounds, 3)
  assert.equal(result.toolCalls.length, 3)
})

test('Loop：单轮工具调用超上限 → 截断并提示模型', async () => {
  const provider = new ScriptedProvider([
    makeResponse({
      toolCalls: [
        { id: 'c1', name: 'get_player_status', arguments: '{}' },
        { id: 'c2', name: 'get_world_status', arguments: '{}' },
        { id: 'c3', name: 'get_player_status', arguments: '{}' },
      ],
      finishReason: 'tool_calls',
    }),
    makeResponse({ content: '完成' }),
  ])
  const { adapter, executed } = makeAdapter()
  const loop = new AgentLoop(provider, adapter, quiet(), { limits: { maxToolCallsPerRound: 2 } })
  const result = await loop.run([], 'q')
  assert.equal(executed.length, 2, '只该执行 2 个')
  assert.equal(result.toolCalls.length, 2)
  // 第 2 次请求里应有"还有 1 个未执行"的提示
  const secondCall = provider.calls[1]!
  const hint = secondCall.messages.find((message) => message.role === 'user' && message.content?.includes('未执行'))
  assert.ok(hint, '应告知模型有调用被丢弃')
})

test('Loop：Provider 报错 → provider_error，不继续循环', async () => {
  const provider = new ScriptedProvider([new ProviderError('RATE_LIMITED', '被限流', undefined, true)])
  const { adapter } = makeAdapter()
  const loop = new AgentLoop(provider, adapter, quiet())
  const result = await loop.run([], 'q')
  assert.equal(result.stopReason, 'provider_error')
  assert.equal(result.errorCode, 'RATE_LIMITED')
  assert.match(result.reply, /RATE_LIMITED/)
  assert.equal(result.rounds, 1)
})

test('Loop：没有可用工具 → no_tools_available，不假装能查', async () => {
  const provider = new ScriptedProvider([makeResponse({ content: '不该走到这' })])
  const emptyAdapter = { toolDefinitions: () => [], executeToolCall: async () => { throw new Error('不该调用') } } as unknown as ToolAdapter
  const loop = new AgentLoop(provider, emptyAdapter, quiet())
  const result = await loop.run([], 'q')
  assert.equal(result.stopReason, 'no_tools_available')
  assert.match(result.reply, /没有可用的只读工具/)
  assert.equal(provider.calls.length, 0, '没有工具就不该请求模型')
})

test('Loop：工具执行失败 → 结果喂回模型（模型能看到错误）', async () => {
  const provider = new ScriptedProvider([
    makeResponse({ toolCalls: [{ id: 'c1', name: 'get_player_status', arguments: '{}' }], finishReason: 'tool_calls' }),
    makeResponse({ content: '查询失败了' }),
  ])
  const { adapter } = makeAdapter({ failTools: ['get_player_status'] })
  const loop = new AgentLoop(provider, adapter, quiet())
  const result = await loop.run([], 'q')
  assert.equal(result.toolCalls[0]?.ok, false)
  assert.equal(result.toolCalls[0]?.errorCode, 'TOOL_CALL_FAILED')
  const secondCall = provider.calls[1]!
  const toolMessage = secondCall.messages.find((message) => message.role === 'tool')
  assert.match(String(toolMessage?.content), /TOOL_CALL_FAILED/)
})

test('Loop：system prompt 注入 + 历史保留', async () => {
  const provider = new ScriptedProvider([makeResponse({ content: 'ok' })])
  const { adapter } = makeAdapter()
  const loop = new AgentLoop(provider, adapter, quiet())
  const history: LLMMessage[] = [
    { role: 'user', content: '之前的问题' },
    { role: 'assistant', content: '之前的回答' },
  ]
  await loop.run(history, '新问题', { systemPrompt: '你是小鲸鱼' })
  const sent = provider.calls[0]!.messages
  assert.equal(sent[0]?.role, 'system')
  assert.equal(sent[0]?.content, '你是小鲸鱼')
  assert.equal(sent[1]?.content, '之前的问题')
  assert.equal(sent[3]?.content, '新问题')
})

test('Loop：事件回调按顺序发出（round/tool/stop）', async () => {
  const provider = new ScriptedProvider([
    makeResponse({ toolCalls: [{ id: 'c1', name: 'get_player_status', arguments: '{}' }], finishReason: 'tool_calls' }),
    makeResponse({ content: 'done' }),
  ])
  const { adapter } = makeAdapter()
  const loop = new AgentLoop(provider, adapter, quiet())
  const events: string[] = []
  await loop.run([], 'q', { onEvent: (event) => events.push(event.type) })
  assert.deepEqual(events, ['round_start', 'llm_response', 'tool_start', 'tool_end', 'round_start', 'llm_response', 'stop'])
})

test('Loop：默认限制符合任务书（4 轮 / 4 调用 / 15s / 60s）', () => {
  assert.equal(DEFAULT_LIMITS.maxRounds, 4)
  assert.equal(DEFAULT_LIMITS.maxToolCallsPerRound, 4)
  assert.equal(DEFAULT_LIMITS.toolTimeoutMs, 15000)
  assert.equal(DEFAULT_LIMITS.agentTimeoutMs, 60000)
})

// ───────────────────────── Risk Assessor ─────────────────────────

test('Risk：低风险（满血满饥饿有光源）', () => {
  const assessment = assessRisk({
    player: { healthPercent: 100, hungerPercent: 90, sanityPercent: 90, temperature: 25 },
    world: { phase: 'day', season: 'autumn' },
    threats: { hostileCount: 0 },
    inventory: { hasLight: true, hasFood: true },
  })
  assert.equal(assessment.level, 'LOW')
  assert.equal(assessment.factors.filter((factor) => factor.level === 'CRITICAL').length, 0)
})

test('Risk：夜晚无光源 → CRITICAL（饥荒核心机制）', () => {
  const assessment = assessRisk({
    player: { healthPercent: 100, hungerPercent: 90 },
    world: { phase: 'night' },
    inventory: { hasLight: false },
  })
  assert.equal(assessment.level, 'CRITICAL')
  const factor = assessment.factors.find((item) => item.key === 'darkness')
  assert.ok(factor)
  assert.equal(factor.level, 'CRITICAL')
})

test('Risk：幽灵状态 → CRITICAL', () => {
  const assessment = assessRisk({ player: { isGhost: true, healthPercent: 0, hungerPercent: 50 } })
  assert.equal(assessment.level, 'CRITICAL')
  assert.ok(assessment.factors.some((factor) => factor.key === 'death'))
})

test('Risk：饥饿 10% → CRITICAL，饥饿 20% → HIGH', () => {
  const critical = assessRisk({ player: { healthPercent: 100, hungerPercent: 10 } })
  assert.equal(critical.level, 'CRITICAL')
  const high = assessRisk({ player: { healthPercent: 100, hungerPercent: 20 } })
  assert.equal(high.level, 'HIGH')
})

test('Risk：阈值可配置（不把默认值当通用死亡线）', () => {
  // 用更严的阈值：饥饿 40% 就算 HIGH
  const strict = assessRisk(
    { player: { healthPercent: 100, hungerPercent: 40 } },
    { thresholds: { hungerLow: 45 } },
  )
  assert.equal(strict.level, 'HIGH', '自定义阈值应生效')

  // 按角色覆盖
  const perCharacter = assessRisk(
    { player: { prefab: 'wx78', healthPercent: 100, hungerPercent: 25 } },
    { profile: { prefab: 'wx78', thresholds: { hungerLow: 20, hungerCritical: 10 } } },
  )
  assert.equal(perCharacter.level, 'MEDIUM', 'WX-78 阈值下 25% 只是 MEDIUM')
})

test('Risk：数据过期时明确标注', () => {
  const assessment = assessRisk({ player: { healthPercent: 50 }, stale: true })
  assert.equal(assessment.stale, true)
  assert.match(String(assessment.staleNote), /不代表当前/)
})

test('Risk：阈值在输出里透出（可审计）', () => {
  const assessment = assessRisk({ player: { healthPercent: 50 } })
  assert.equal(assessment.thresholds.healthLow, DEFAULT_THRESHOLDS.healthLow)
})

// ───────────────────────── Task Planner ─────────────────────────

test('Plan：夜晚无光源 → 第一条就是做火把', () => {
  const risk = assessRisk({ player: { healthPercent: 100, hungerPercent: 80 }, world: { phase: 'dusk' }, inventory: { hasLight: false } })
  const plan = buildPlan({
    risk,
    player: { healthPercent: 100, hungerPercent: 80 },
    world: { phase: 'dusk', day: 3, season: 'autumn', remainingDaysInSeason: 15 },
    inventory: { hasLight: false, hasFood: true },
  })
  assert.equal(plan.steps[0]?.horizon, 'immediate')
  assert.equal(plan.steps[0]?.urgent, true)
  assert.match(plan.steps[0]?.action ?? '', /火把|营火/)
  assert.match(plan.headline, /紧急/)
})

test('Plan：饥饿低 + 无食物 → 短期优先级高', () => {
  const risk = assessRisk({ player: { healthPercent: 100, hungerPercent: 12 }, inventory: { hasFood: false } })
  const plan = buildPlan({
    risk,
    player: { healthPercent: 100, hungerPercent: 12 },
    world: { phase: 'day', day: 5, season: 'autumn' },
    inventory: { hasFood: false },
    resources: { harvestable: 3 },
  })
  const hungerStep = plan.steps.find((step) => step.action.includes('食物') || step.action.includes('采集'))
  assert.ok(hungerStep, '应有食物相关步骤')
  assert.equal(hungerStep?.urgent, true)
  assert.ok((hungerStep?.priority ?? 5) <= 2)
})

test('Plan：威胁存在 → immediate 优先级 1 或 2', () => {
  const risk = assessRisk({ player: { healthPercent: 100, hungerPercent: 80 }, threats: { hostileCount: 5 } })
  const plan = buildPlan({
    risk,
    player: { healthPercent: 100, hungerPercent: 80 },
    threats: { hostileCount: 5, nearestName: '蜘蛛', nearestDistance: 2.3 },
    world: { phase: 'day', season: 'autumn' },
  })
  const threatStep = plan.steps.find((step) => step.action.includes('逃跑') || step.action.includes('距离'))
  assert.ok(threatStep)
  assert.equal(threatStep?.horizon, 'immediate')
  assert.match(threatStep?.evidence ?? '', /蜘蛛/)
})

test('Plan：秋季剩 3 天 → 提示准备过冬', () => {
  const risk = assessRisk({ player: { healthPercent: 100, hungerPercent: 80 }, world: { season: 'autumn' } })
  const plan = buildPlan({
    risk,
    player: { healthPercent: 100, hungerPercent: 80 },
    world: { phase: 'day', day: 18, season: 'autumn', remainingDaysInSeason: 3 },
  })
  const winterStep = plan.steps.find((step) => step.action.includes('过冬'))
  assert.ok(winterStep, '应提示准备过冬')
  assert.equal(winterStep?.horizon, 'mid')
})

test('Plan：步骤有序（immediate → short → mid → long）且 order 连续', () => {
  const risk = assessRisk({
    player: { healthPercent: 20, hungerPercent: 10, sanityPercent: 10, temperature: 0 },
    world: { phase: 'night', season: 'winter', remainingDaysInSeason: 2 },
    threats: { hostileCount: 3 },
    inventory: { hasLight: false, hasFood: false },
  })
  const plan = buildPlan({
    risk,
    player: { healthPercent: 20, hungerPercent: 10, sanityPercent: 10, temperature: 0 },
    world: { phase: 'night', day: 10, season: 'winter', remainingDaysInSeason: 2 },
    threats: { hostileCount: 3 },
    inventory: { hasLight: false, hasFood: false },
  })
  const horizonOrder = { immediate: 0, short: 1, mid: 2, long: 3 }
  for (let i = 1; i < plan.steps.length; i += 1) {
    const prev = plan.steps[i - 1]!
    const curr = plan.steps[i]!
    assert.ok(horizonOrder[prev.horizon] <= horizonOrder[curr.horizon], `第 ${i} 步 horizon 顺序错`)
    assert.equal(curr.order, prev.order + 1, 'order 应连续')
  }
  assert.ok(plan.summary.immediate > 0)
})

test('Plan：renderPlan 输出包含理由与依据', () => {
  const risk = assessRisk({ player: { healthPercent: 30, hungerPercent: 20 }, world: { phase: 'night' }, inventory: { hasLight: false } })
  const plan = buildPlan({
    risk,
    player: { healthPercent: 30, hungerPercent: 20 },
    world: { phase: 'night', day: 2, season: 'autumn' },
    inventory: { hasLight: false, hasFood: false },
  })
  const text = renderPlan(plan)
  assert.match(text, /风险等级/)
  assert.match(text, /理由：/)
  assert.match(text, /依据：/)
  assert.match(text, /【紧急】/)
})

test('Plan：数据过期时提示重新查询', () => {
  const risk = assessRisk({ player: { healthPercent: 50 }, stale: true })
  const plan = buildPlan({ risk, player: { healthPercent: 50 }, stale: true })
  assert.match(String(plan.staleNote), /数据已过期/)
  assert.match(renderPlan(plan), /⚠️/)
})

test('Plan：幽灵状态 → 计划第一步是复活，headline 必须说紧急', () => {
  const risk = assessRisk({ player: { isGhost: true, healthPercent: 0, hungerPercent: 60 } })
  const plan = buildPlan({
    risk,
    player: { isGhost: true, healthPercent: 0, hungerPercent: 60 },
    world: { phase: 'day', day: 3, season: 'autumn' },
  })
  assert.equal(plan.steps[0]?.horizon, 'immediate')
  assert.match(plan.steps[0]?.action ?? '', /复活/)
  assert.match(plan.headline, /紧急/, 'headline 必须与紧急项一致，不能说"没有紧急威胁"')
  assert.equal(plan.summary.immediate >= 1, true)
})
