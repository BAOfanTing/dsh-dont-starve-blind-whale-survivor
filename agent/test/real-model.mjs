// 真实模型端到端验证：sensenova-6.8-flash（DSH 里的 "rrx" Provider）
//
// 用真实模型跑完整 Agent：真实 MCP 工具 + 真实 LLM + 真实多轮工具调用。
// API Key 从 DSH 凭据库读取（只在本进程内存使用，不打印、不落盘）。
//
// 需要：Bridge 在 18788 跑着（游戏开不开都行，开着能看到新鲜数据）。
import { readFileSync } from 'node:fs'
import { loadConfig } from '../dist/src/config.js'
import { Agent } from '../dist/src/runtime/agent.js'
import { createLogger } from '../dist/src/utils/logger.js'
import { OpenAICompatibleProvider } from '../dist/src/llm/openaiProvider.js'

// ── 从 DSH 凭据读 RRX_API_KEY ──
const creds = readFileSync('C:/Users/BAOfanTing/.dsh/.credentials.yaml', 'utf8')
const match = creds.match(/^\s*RRX_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m)
if (!match) {
  console.error('未找到 RRX_API_KEY')
  process.exit(1)
}
const API_KEY = match[1]
console.log(`已从 DSH 凭据库读取 key（长度 ${API_KEY.length}，不打印明文）`)

const BASE_URL = 'https://token.sensenova.cn/v1'
const MODEL = 'sensenova-6.8-flash'

const config = {
  ...loadConfig({ BWS_TOKEN: readFileSync('../.runtime/token.txt', 'utf8').trim() }),
  mcpTransport: 'stdio',
  mcpStdioCommand: process.execPath,
  mcpStdioArgs: ['../mcp-server/dist/src/index.js'],
  token: readFileSync('../.runtime/token.txt', 'utf8').trim(),
  llmPreset: 'openai-compatible',
  llmBaseUrl: BASE_URL,
  llmApiKey: API_KEY,
  llmModel: MODEL,
  llmThinking: false,
  llmReasoningField: 'reasoning',   // 实测：这个模型用 reasoning 而不是 reasoning_content
  llmMaxTokens: 2048,                // 思考型模型，token 太小会只够思考不够回答
  llmTimeoutMs: 90000,
  llmMaxRetries: 1,
}

const logger = createLogger({ level: 'warn', secrets: [API_KEY, config.token] })
const provider = new OpenAICompatibleProvider({
  preset: 'openai-compatible',
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  model: MODEL,
  reasoningField: 'reasoning',
  thinking: false,
  reasoningEffort: 'high',
  maxTokens: 2048,
  temperature: 0.3,
  timeoutMs: 90000,
  maxRetries: 1,
  contextLength: 262144,
  maxOutputTokens: 8192,
}, logger)

// ── ① Provider 健康检查与能力探测 ──
console.log('\n=== ① Provider 健康检查 ===')
const health = await provider.healthCheck()
console.log(`   state=${health.state}  message=${health.message}`)
const info = await provider.getModelInfo()
console.log(`   model=${info.model}  supportsToolCalls=${info.supportsToolCalls}`)
const probe = await provider.probeToolCalls()
console.log(`   function calling 实测: ${probe.supported} — ${probe.detail.slice(0, 120)}`)

if (health.state !== 'ok') {
  console.error('Provider 不可用，终止')
  process.exit(1)
}

// ── ② 完整 Agent ──
console.log('\n=== ② 完整 Agent（真实 MCP + 真实模型）===')
const agent = new Agent(config, logger, { provider, limits: { maxRounds: 4, maxToolCallsPerRound: 4, agentTimeoutMs: 120000 } })
const status = await agent.connect()
console.log(`   ready=${status.ready}  工具=${status.tools.adapted} 个`)

const questions = [
  '用一句话说，你现在能查到我的哪些信息？',
  '帮我看看现在玩家的生命和饥饿是多少？请查真实数据。',
]

for (const question of questions) {
  console.log(`\n   ── 用户: ${question}`)
  const result = await agent.chat(question, {
    sessionId: 'real-model-test',
    conversationId: 'chat-1',
    onEvent: (event) => {
      if (event.type === 'llm_response') {
        console.log(`      [第${event.round}轮] 模型返回: toolCalls=${event.toolNames.join(',') || '无'} (${event.elapsedMs}ms)`)
      }
      if (event.type === 'tool_end') {
        console.log(`      [第${event.round}轮] 工具完成: ${event.name} ok=${event.ok} ${event.elapsedMs}ms`)
      }
    },
  })
  console.log(`   stopReason=${result.stopReason}  rounds=${result.rounds}  工具=${result.toolCalls.length}  耗时=${result.elapsedMs}ms`)
  console.log(`   token: prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens}`)
  console.log(`   回答: ${result.reply.slice(0, 400)}`)
  if (result.guardNote) console.log(`   guard: ${result.guardNote}`)
}

// ── ③ 上下文保留 ──
console.log('\n=== ③ 上下文 ===')
const history = agent.context.history('real-model-test', 'chat-1')
console.log(`   消息数=${history.length}`)
for (const m of history) console.log(`     ${m.role}: ${String(m.content).slice(0, 60)}`)

// ── ④ 风险评估（真实数据）──
console.log('\n=== ④ 风险评估 + 计划（真实数据）===')
const assessed = await agent.chat('我现在的生存风险有多高？', {
  sessionId: 'real-model-test',
  conversationId: 'assess',
  withAssessment: true,
})
if (assessed.risk) {
  console.log(`   风险等级: ${assessed.risk.level}`)
  console.log(`   摘要: ${assessed.risk.summary.slice(0, 200)}`)
  if (assessed.risk.staleNote) console.log(`   ⚠️ ${assessed.risk.staleNote}`)
  console.log(`   计划 ${assessed.plan?.steps.length ?? 0} 步，前 3 步:`)
  for (const step of (assessed.plan?.steps ?? []).slice(0, 3)) {
    console.log(`     ${step.order}. [${step.horizon}] ${step.action}`)
  }
}

await agent.disconnect()
console.log('\n=== 完成 ===')
