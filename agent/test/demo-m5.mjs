// M5 端到端演示：完整 Agent（角色 Prompt + 上下文 + 只读守卫 + Loop + Risk/Planner）
//
// 真实 MCP + 会调工具的假模型，验证：
//   ① 写操作意图被程序层识别并前置说明
//   ② 只读查询正常走完整 Loop
//   ③ 多轮对话上下文保留
//   ④ 风险评估 + 计划用真实数据
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { Agent } from '../dist/src/runtime/agent.js'
import { loadConfig } from '../dist/src/config.js'
import { createLogger } from '../dist/src/utils/logger.js'

const token = readFileSync('../.runtime/token.txt', 'utf8').trim()

// ── 假模型：根据用户问题决定调什么工具 ──
const fakeModel = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    const messages = body.messages ?? []
    const toolResults = messages.filter((message) => message.role === 'tool')
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')
    const question = String(lastUser?.content ?? '')

    let payload
    if (toolResults.length === 0) {
      // 第一轮：根据问题挑工具
      const wanted = []
      if (/状态|生命|饥饿|怎么样|危不危险/.test(question)) wanted.push({ name: 'get_player_status', args: '{}' })
      if (/天|季节|白天|夜晚|什么时候/.test(question)) wanted.push({ name: 'get_world_status', args: '{}' })
      if (/背包|东西|物品/.test(question)) wanted.push({ name: 'get_inventory', args: '{}' })
      if (/危险|怪|威胁/.test(question)) wanted.push({ name: 'get_nearby_threats', args: '{}' })
      if (wanted.length === 0) wanted.push({ name: 'get_game_status', args: '{}' })

      payload = {
        model: body.model,
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: `用户问的是"${question.slice(0, 20)}"，我需要查 ${wanted.map((w) => w.name).join('、')}`,
            tool_calls: wanted.map((w, index) => ({
              id: `call_${index + 1}`,
              type: 'function',
              function: { name: w.name, arguments: w.args },
            })),
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1200, completion_tokens: 50, total_tokens: 1250 },
      }
    } else {
      // 第二轮：总结
      const digest = toolResults.map((message) => `${message.name}`).join('、')
      payload = {
        model: body.model,
        choices: [{
          message: {
            role: 'assistant',
            content: `我查了 ${digest}。${toolResults.some((message) => String(message.content).includes('"stale":true')) ? '注意：这些数据已经过期，是最后一次已知状态。' : ''}根据查到的信息，目前没有立即致命的危险，但建议留意饥饿与天黑时间。`,
            reasoning_content: '数据齐了，可以总结',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 2000, completion_tokens: 80, total_tokens: 2080 },
      }
    }

    const text = JSON.stringify(payload)
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  })
})

await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve))
const modelPort = fakeModel.address().port

const logger = createLogger({ level: 'warn' })
const config = {
  ...loadConfig({ BWS_TOKEN: token }),
  mcpTransport: 'stdio',
  mcpStdioCommand: process.execPath,
  mcpStdioArgs: ['../mcp-server/dist/src/index.js'],
  token,
  llmPreset: 'openai-compatible',
  llmBaseUrl: `http://127.0.0.1:${modelPort}/v1`,
  llmApiKey: 'fake',
  llmModel: 'fake-model',
  llmThinking: false,
  llmTimeoutMs: 10000,
  llmMaxRetries: 0,
}

const agent = new Agent(config, logger, { limits: { maxRounds: 4, maxToolCallsPerRound: 4 } })
const status = await agent.connect()
console.log('=== Agent 就绪 ===')
console.log(`  ready=${status.ready} 工具=${status.tools.adapted} 个  provider=${status.provider.model}`)
console.log(`  MCP: ${status.mcp.state}  会话数: ${status.context.conversations}`)
console.log(`  限制: ${JSON.stringify(status.limits)}`)

// ① 写操作意图
console.log('\n=== ① 写操作意图（程序层拦截）===')
const writeAttempt = await agent.chat('帮我把那棵树砍了', { sessionId: 'demo', conversationId: 'write-test' })
console.log(`  stopReason=${writeAttempt.stopReason}`)
console.log(`  guardNote: ${writeAttempt.guardNote}`)
console.log(`  完整回答（前 2 行）:`)
for (const line of writeAttempt.reply.split('\n').slice(0, 2)) console.log(`    ${line}`)

// ② 只读查询（完整 Loop）
console.log('\n=== ② 只读查询（完整 Loop）===')
const query = await agent.chat('我现在状态怎么样？附近危险吗？', { sessionId: 'demo', conversationId: 'chat-1' })
console.log(`  stopReason=${query.stopReason} rounds=${query.rounds} 工具调用=${query.toolCalls.length} 耗时=${query.elapsedMs}ms`)
for (const trace of query.toolCalls) console.log(`    [第${trace.round}轮] ${trace.name} ok=${trace.ok} ${trace.elapsedMs}ms`)
console.log(`  回答: ${query.reply.slice(0, 160)}`)

// ③ 多轮上下文
console.log('\n=== ③ 多轮上下文 ===')
const followUp = await agent.chat('那我要不要准备过夜？', { sessionId: 'demo', conversationId: 'chat-1' })
console.log(`  第二轮 rounds=${followUp.rounds} 工具=${followUp.toolCalls.length}`)
const history = agent.context.history('demo', 'chat-1')
console.log(`  上下文消息数: ${history.length}（应含前一轮的 user + assistant）`)
console.log(`  历史: ${history.map((m) => `${m.role}:${String(m.content).slice(0, 20)}`).join(' | ')}`)

// ④ 风险评估 + 计划
console.log('\n=== ④ 风险评估 + 计划（真实数据）===')
const assessed = await agent.chat('给我一份生存报告', { sessionId: 'demo', conversationId: 'assess', withAssessment: true })
if (assessed.risk !== undefined) {
  console.log(`  风险等级: ${assessed.risk.level}`)
  console.log(`  摘要: ${assessed.risk.summary}`)
  if (assessed.risk.staleNote) console.log(`  ⚠️ ${assessed.risk.staleNote}`)
  console.log(`  计划 ${assessed.plan?.steps.length ?? 0} 步:`)
  for (const step of (assessed.plan?.steps ?? []).slice(0, 4)) {
    console.log(`    ${step.order}. [${step.horizon}/${step.urgent ? '紧急' : '常规'}] ${step.action}`)
    console.log(`       依据: ${step.evidence}`)
  }
} else {
  console.log('  风险评估未返回（数据不可用）')
}

// ⑤ 会话重置
console.log('\n=== ⑤ 会话重置 ===')
agent.reset('demo', 'chat-1')
console.log(`  重置后消息数: ${agent.context.history('demo', 'chat-1').length}`)
console.log(`  最终状态: ${JSON.stringify(agent.context.stats())}`)

await agent.disconnect()
fakeModel.close()
