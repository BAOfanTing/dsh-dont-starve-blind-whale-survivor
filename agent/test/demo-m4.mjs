// M4 真实链路演示：Agent Loop 端到端
//
// 组成：
//   · 真实 MCP Client（stdio 连 Phase 3 Server）
//   · 真实 ToolAdapter（12 个只读工具 + 白名单 + 校验）
//   · 假模型服务（会真的按顺序调工具：先查玩家 → 再查世界 → 最后总结）
//
// 这个演示证明：模型要工具 → Agent 校验并执行 → 结果喂回 → 模型继续 → 出最终答复，
// 全链路真的跑通，而且 reasoning_content 与 tool_call_id 都正确保留。
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { McpClient } from '../dist/src/mcp/client.js'
import { ToolAdapter } from '../dist/src/mcp/toolAdapter.js'
import { AgentLoop } from '../dist/src/runtime/agentLoop.js'
import { assessRisk } from '../dist/src/runtime/riskAssessor.js'
import { buildPlan, renderPlan } from '../dist/src/runtime/taskPlanner.js'
import { OpenAICompatibleProvider } from '../dist/src/llm/openaiProvider.js'
import { loadConfig } from '../dist/src/config.js'
import { createLogger } from '../dist/src/utils/logger.js'

const token = readFileSync('../.runtime/token.txt', 'utf8').trim()

// ── 假模型：按"已收到几个 tool 结果"决定下一步动作 ──
const fakeModel = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    const messages = body.messages ?? []
    const toolResults = messages.filter((message) => message.role === 'tool')

    let payload
    if (toolResults.length === 0) {
      payload = {
        model: body.model,
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: '先看玩家状态和世界状态，再决定要不要看威胁',
            tool_calls: [
              { id: 'call_player', type: 'function', function: { name: 'get_player_status', arguments: '{}' } },
              { id: 'call_world', type: 'function', function: { name: 'get_world_status', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 800, completion_tokens: 60, total_tokens: 860 },
      }
    } else if (toolResults.length === 2) {
      payload = {
        model: body.model,
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: '玩家和世界都查到了，再看附近威胁与资源',
            tool_calls: [
              { id: 'call_threats', type: 'function', function: { name: 'get_nearby_threats', arguments: '{}' } },
              { id: 'call_res', type: 'function', function: { name: 'get_nearby_resources', arguments: '{"limit":5}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1500, completion_tokens: 60, total_tokens: 1560 },
      }
    } else {
      const digest = toolResults.map((message) => `${message.name}=${String(message.content).slice(0, 60)}`).join(' | ')
      payload = {
        model: body.model,
        choices: [{
          message: {
            role: 'assistant',
            content: `我查到了这些数据：${digest}。综合来看目前没有立即致命的威胁，建议先补食物再考虑过夜。`,
            reasoning_content: '数据齐了，可以总结',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 2400, completion_tokens: 100, total_tokens: 2500 },
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

// ── 真实 MCP ──
const config = {
  ...loadConfig({ BWS_TOKEN: token }),
  mcpTransport: 'stdio',
  mcpStdioCommand: process.execPath,
  mcpStdioArgs: ['../mcp-server/dist/src/index.js'],
  token,
}
const client = new McpClient(config, logger)
await client.connect()
const adapter = new ToolAdapter(client, logger)
const adapted = adapter.refresh()
console.log(`=== 准备 ===`)
console.log(`  MCP 工具：${client.listTools().length} 个；适配：${adapted.adapted} 个`)

const provider = new OpenAICompatibleProvider({
  preset: 'openai-compatible',
  baseUrl: `http://127.0.0.1:${modelPort}/v1`,
  apiKey: 'fake',
  model: 'fake-model',
  thinking: false,
  reasoningEffort: 'high',
  maxTokens: 1024,
  temperature: 0.3,
  timeoutMs: 10000,
  maxRetries: 0,
  contextLength: 32000,
  maxOutputTokens: 4096,
}, logger)

const loop = new AgentLoop(provider, adapter, logger, { limits: { maxRounds: 4, maxToolCallsPerRound: 4 } })

console.log(`\n=== 跑 Agent Loop ===`)
const events = []
const result = await loop.run([], '帮我看看现在危不危险，要不要准备过夜？', {
  systemPrompt: '你是小鲸鱼，只能只读查询，不能修改游戏。',
  onEvent: (event) => {
    if (event.type === 'round_start') events.push(`  第 ${event.round} 轮开始`)
    if (event.type === 'llm_response') events.push(`    模型返回：toolCalls=${event.toolNames.join(',') || '无'}`)
    if (event.type === 'tool_end') events.push(`    工具完成：${event.name} ok=${event.ok} ${event.elapsedMs}ms`)
  },
})
for (const line of events) console.log(line)

console.log(`\n=== 结果 ===`)
console.log(`  stopReason: ${result.stopReason}`)
console.log(`  rounds: ${result.rounds}  工具调用: ${result.toolCalls.length}  耗时: ${result.elapsedMs}ms`)
console.log(`  token: prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens} total=${result.usage.totalTokens}`)
console.log(`  最终答复: ${result.reply}`)
console.log(`\n  工具调用明细:`)
for (const trace of result.toolCalls) {
  console.log(`    [第${trace.round}轮] ${trace.name} ok=${trace.ok} ${trace.elapsedMs}ms -> ${trace.resultPreview.slice(0, 80)}`)
}

// ── 用真实数据跑 Risk + Planner ──
console.log(`\n=== Risk + Planner（用真实数据）===`)
const playerCall = result.toolCalls.find((trace) => trace.name === 'get_player_status')
if (playerCall !== undefined) {
  const playerData = await adapter.executeToolCall({ id: 'p', name: 'get_player_status', arguments: '{}' })
  const worldData = await adapter.executeToolCall({ id: 'w', name: 'get_world_status', arguments: '{}' })
  const threatData = await adapter.executeToolCall({ id: 't', name: 'get_nearby_threats', arguments: '{}' })

  const p = playerData.structured
  const w = worldData.structured
  const t = threatData.structured
  const freshness = p?.freshness ?? {}
  const risk = assessRisk({
    player: p?.player ? {
      prefab: p.player.prefab,
      isGhost: p.player.is_ghost,
      healthPercent: p.player.health?.percent,
      hungerPercent: p.player.hunger?.percent,
      sanityPercent: p.player.sanity?.percent,
      temperature: p.player.temperature,
      dead: p.player.health?.dead,
    } : null,
    world: w?.world ? {
      phase: w.world.phase,
      day: w.world.day,
      season: w.world.season,
      remainingDaysInSeason: w.world.remaining_days_in_season,
    } : null,
    threats: t ? { hostileCount: t.hostile_count, nearestDistance: t.nearest?.distance } : null,
    stale: freshness.stale === true,
  })
  console.log(`  风险等级: ${risk.level}`)
  console.log(`  摘要: ${risk.summary}`)
  if (risk.staleNote) console.log(`  ⚠️ ${risk.staleNote}`)
  console.log(`  因素:`)
  for (const factor of risk.factors.slice(0, 5)) {
    console.log(`    [${factor.level}] ${factor.label}: ${factor.detail}`)
  }

  const plan = buildPlan({
    risk,
    player: p?.player ? { prefab: p.player.prefab, healthPercent: p.player.health?.percent, hungerPercent: p.player.hunger?.percent, sanityPercent: p.player.sanity?.percent, temperature: p.player.temperature, isGhost: p.player.is_ghost, dead: p.player.health?.dead } : null,
    world: w?.world ? { phase: w.world.phase, day: w.world.day, season: w.world.season, remainingDaysInSeason: w.world.remaining_days_in_season } : null,
    threats: t ? { hostileCount: t.hostile_count, nearestName: t.nearest?.name, nearestDistance: t.nearest?.distance } : null,
    inventory: { hasLight: false, hasFood: false },
    stale: freshness.stale === true,
  })
  console.log(`\n  计划（共 ${plan.steps.length} 步，紧急 ${plan.summary.immediate} 项）:`)
  console.log(renderPlan(plan).split('\n').map((line) => '    ' + line).join('\n'))
} else {
  console.log('  玩家数据未取到，跳过 Risk/Planner')
}

await client.disconnect()
fakeModel.close()
