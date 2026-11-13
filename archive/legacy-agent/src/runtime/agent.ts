// Agent 门面（M5）：把 M1~M4 的所有部件串成一个可用的 Agent
//
// 组装顺序：
//   McpClient → ToolAdapter → (SystemPrompt + Context + Risk/Planner) → AgentLoop
//
// 对外只暴露 chat() / reset() / status()，M6 的 HTTP API 直接调这三个。

import { McpClient } from '../mcp/client.js'
import { ToolAdapter } from '../mcp/toolAdapter.js'
import { createProvider } from '../llm/factory.js'
import type { LLMProvider } from '../llm/types.js'
import { AgentLoop, type AgentLoopLimits, type AgentRunResult, type AgentEvent } from '../runtime/agentLoop.js'
import { assessRisk, type RiskAssessment } from '../runtime/riskAssessor.js'
import { buildPlan, renderPlan, type SurvivalPlan } from '../runtime/taskPlanner.js'
import { buildSystemPrompt } from '../prompts/systemPrompt.js'
import { ContextManager, type ContextLimits, type Conversation } from '../context/contextManager.js'
import { guardUserIntent, guardToolName, READ_ONLY_REMINDER } from '../safety/readOnlyGuard.js'
import { isWriteTool } from '../mcp/toolAdapter.js'
import type { WriteGuard } from '../runtime/agentLoop.js'
import type { AgentConfig } from '../config.js'
import type { Logger } from '../utils/logger.js'

export interface AgentChatOptions {
  sessionId: string
  conversationId?: string
  /** 中止信号 */
  signal?: AbortSignal
  /** 事件回调（M6 用来做 SSE 推送） */
  onEvent?: (event: AgentEvent) => void
  /** 是否在回答后附带风险与计划（默认 false，避免每次都跑） */
  withAssessment?: boolean
}

export interface AgentChatResult {
  reply: string
  stopReason: AgentRunResult['stopReason']
  stopDetail: string | null
  rounds: number
  toolCalls: AgentRunResult['toolCalls']
  usage: AgentRunResult['usage']
  elapsedMs: number
  conversationId: string
  /** 写操作意图被识别时的说明（会被前置到回答里） */
  guardNote: string | null
  /** 可选：风险评估与计划 */
  risk?: RiskAssessment
  plan?: SurvivalPlan
  planText?: string
}

export interface AgentStatus {
  ready: boolean
  mcp: ReturnType<McpClient['status']>
  tools: { adapted: number; names: string[]; stats: ReturnType<ToolAdapter['adapterStats']> }
  context: ReturnType<ContextManager['stats']>
  limits: AgentLoopLimits
  provider: { preset: string; model: string; baseUrl: string; hasApiKey: boolean }
}

export class Agent {
  private readonly provider: LLMProvider
  readonly mcp: McpClient
  readonly adapter: ToolAdapter
  readonly context: ContextManager
  private readonly loop: AgentLoop
  private readonly limits: AgentLoopLimits

  constructor(
    private readonly config: AgentConfig,
    private readonly logger: Logger,
    options: { limits?: Partial<AgentLoopLimits>; contextLimits?: Partial<ContextLimits>; provider?: LLMProvider } = {},
  ) {
    this.provider = options.provider ?? createProvider(config, logger)
    this.mcp = new McpClient(config, logger)
    this.adapter = new ToolAdapter(this.mcp, logger, { permission: config.toolPermission })
    this.context = new ContextManager({ limits: options.contextLimits })
    this.loop = new AgentLoop(this.provider, this.adapter, logger, {
      limits: options.limits,
      // Phase 5 M7：supervised 档才装写动作守卫（read 档没有写工具，装了也没用）
      writeGuard: config.toolPermission === 'supervised' ? this.buildWriteGuard() : undefined,
    })
    this.limits = this.loop.getLimits()
  }

  /**
   * Phase 5 M7：构造写动作守卫。
   *
   * 每次模型要调写工具时，先用 MCP 的 get_control_status 查一遍：
   *   - mode 必须是 SUPERVISED
   *   - holder 必须非空（有人持有）
   *   - lease 未过期
   *   - emergency_stop 必须为 false
   * 任一不满足就拒绝，并把原因写清楚（而不是让模型自己猜）。
   *
   * 注意：这不是唯一防线。MCP 工具内的 requireControl() 和 Lua 的 control/assert
   * 都会再查一遍 —— 三层都在程序层，不靠提示词。
   */
  private buildWriteGuard(): WriteGuard {
    return {
      isWrite: (name: string) => isWriteTool(name),
      check: async () => {
        try {
          const result = await this.adapter.executeToolCall({
            id: 'write_guard_probe',
            name: 'get_control_status',
            arguments: '{}',
          })
          if (!result.ok) {
            return { allowed: false, message: `读不到控制权状态（${result.errorCode ?? 'unknown'}），为安全起见拒绝执行写动作` }
          }
          const payload = result.content ?? ''
          // get_control_status 返回 JSON 文本；解析失败就保守拒绝
          const jsonStart = payload.indexOf('{')
          const jsonEnd = payload.lastIndexOf('}')
          if (jsonStart < 0 || jsonEnd <= jsonStart) {
            return { allowed: false, message: '控制权状态格式异常，为安全起见拒绝执行写动作' }
          }
          const data = JSON.parse(payload.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>
          const control = (data.control ?? data) as Record<string, unknown>
          const mode = String(control.mode ?? 'UNKNOWN')
          const holder = control.holder
          const emergency = control.emergency_stop === true || mode === 'EMERGENCY_STOP'
          const expiresAt = typeof control.lease_expires_at === 'number' ? control.lease_expires_at : null
          const leaseValid = expiresAt !== null && Date.now() < expiresAt

          if (emergency) return { allowed: false, message: '紧急停止中，不能执行写动作' }
          if (mode === 'MANUAL') return { allowed: false, message: '当前是人工接管模式，AI 不能动手' }
          if (mode === 'PAUSED') return { allowed: false, message: 'AI 已暂停，不能执行写动作' }
          if (mode !== 'SUPERVISED') return { allowed: false, message: `当前模式是 ${mode}，只有 SUPERVISED 才能执行写动作` }
          if (holder === null || holder === undefined || holder === '') {
            return { allowed: false, message: '现在没有控制器持有写权限 —— 需要主人先在 Survival Controller 里授予控制权' }
          }
          if (!leaseValid) return { allowed: false, message: '控制权 lease 已过期 —— 需要主人重新授予' }
          return { allowed: true, message: `ok（holder=${String(holder)}）` }
        } catch (error) {
          return { allowed: false, message: `控制权检查出错：${String((error as Error)?.message ?? error)}，为安全起见拒绝` }
        }
      },
    }
  }

  /** 连接 MCP 并适配工具（幂等） */
  async connect(): Promise<AgentStatus> {
    if (this.mcp.status().state !== 'connected') {
      await this.mcp.connect()
    }
    this.adapter.refresh()
    this.logger.info('Agent 就绪', {
      tools: this.adapter.names().length,
      provider: this.config.llmPreset,
      model: this.config.llmModel,
    })
    return this.status()
  }

  async disconnect(): Promise<void> {
    await this.mcp.disconnect()
  }

  status(): AgentStatus {
    return {
      ready: this.mcp.status().state === 'connected' && this.adapter.names().length > 0,
      mcp: this.mcp.status(),
      tools: {
        adapted: this.adapter.names().length,
        names: this.adapter.names(),
        stats: this.adapter.adapterStats(),
      },
      context: this.context.stats(),
      limits: this.limits,
      provider: {
        preset: this.config.llmPreset,
        model: this.config.llmModel,
        baseUrl: this.config.llmBaseUrl,
        hasApiKey: this.config.llmApiKey.length > 0,
      },
    }
  }

  /** 会话重置 */
  reset(sessionId: string, conversationId?: string): Conversation {
    this.logger.info('会话已重置', { sessionId, conversationId: conversationId ?? '(default)' })
    return this.context.reset(sessionId, conversationId)
  }

  /**
   * 主入口：一次完整对话。
   *
   * 流程：
   *   1. 识别用户输入里的写操作意图（程序层，不靠提示词）
   *   2. 取历史 + 组装 System Prompt
   *   3. 跑 Agent Loop
   *   4. 把结果写回上下文
   *   5. 可选：跑 Risk + Planner
   */
  async chat(userInput: string, options: AgentChatOptions): Promise<AgentChatResult> {
    if (this.mcp.status().state !== 'connected') {
      await this.connect()
    }

    // 1) 写操作意图检测（不是拒绝回答，而是先声明能力边界）
    const intent = guardUserIntent(userInput)
    const guardNote = intent.allowed ? null : intent.message
    if (guardNote !== null) {
      this.logger.warn('识别到写操作意图', { intent: intent.intent })
    }

    // 2) 取历史 + System Prompt
    const history = this.context.history(options.sessionId, options.conversationId)
    const systemPrompt = buildSystemPrompt({
      tools: this.adapter.names().map((name) => {
        const tool = this.adapter.get(name)
        return { name, description: tool?.mcp.description ?? '' }
      }),
      extra: READ_ONLY_REMINDER,
    })

    // 3) 跑 Loop
    const result = await this.loop.run(history, userInput, {
      systemPrompt,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    })

    // 4) 写回上下文：只存 user 与最终的 assistant 文本（工具往返的中间消息不回存，
    //    否则上下文会被工具结果撑爆；需要审计的话用 toolCalls 字段）
    const conversation = this.context.append(options.sessionId, options.conversationId, [
      { role: 'user', content: userInput },
      {
        role: 'assistant',
        content: result.reply,
        // 保留 reasoning 供审计（不展示给用户）
        ...(result.messages.filter((message) => message.role === 'assistant' && message.reasoningContent).at(-1)?.reasoningContent
          ? { reasoningContent: result.messages.filter((message) => message.role === 'assistant').at(-1)?.reasoningContent ?? null }
          : {}),
      },
    ])

    // 5) 可选：风险评估 + 计划
    let risk: RiskAssessment | undefined
    let plan: SurvivalPlan | undefined
    let planText: string | undefined
    if (options.withAssessment === true) {
      const assessment = await this.assess()
      if (assessment !== null) {
        risk = assessment.risk
        plan = assessment.plan
        planText = renderPlan(assessment.plan)
      }
    }

    const reply = guardNote === null ? result.reply : `${guardNote}\n\n${result.reply}`

    return {
      reply,
      stopReason: result.stopReason,
      stopDetail: result.stopDetail,
      rounds: result.rounds,
      toolCalls: result.toolCalls,
      usage: result.usage,
      elapsedMs: result.elapsedMs,
      conversationId: conversation.conversationId,
      guardNote,
      ...(risk === undefined ? {} : { risk }),
      ...(plan === undefined ? {} : { plan }),
      ...(planText === undefined ? {} : { planText }),
    }
  }

  /**
   * 用真实游戏数据做风险评估 + 计划。
   * 拿不到数据时返回 null（不编造）。
   */
  async assess(): Promise<{ risk: RiskAssessment; plan: SurvivalPlan } | null> {
    try {
      const playerResult = await this.adapter.executeToolCall({ id: 'assess_player', name: 'get_player_status', arguments: '{}' })
      const worldResult = await this.adapter.executeToolCall({ id: 'assess_world', name: 'get_world_status', arguments: '{}' })
      const threatResult = await this.adapter.executeToolCall({ id: 'assess_threats', name: 'get_nearby_threats', arguments: '{}' })
      const resourceResult = await this.adapter.executeToolCall({ id: 'assess_resources', name: 'get_nearby_resources', arguments: '{"limit":5}' })
      const inventoryResult = await this.adapter.executeToolCall({ id: 'assess_inventory', name: 'get_inventory', arguments: '{}' })

      const player = playerResult.structured?.player as Record<string, any> | undefined
      const world = worldResult.structured?.world as Record<string, any> | undefined
      const freshness = (playerResult.structured?.freshness ?? worldResult.structured?.freshness) as Record<string, any> | undefined
      const stale = freshness?.stale === true

      if (player === undefined && world === undefined) return null

      const hostileCount = (threatResult.structured?.hostile_count as number | undefined) ?? 0
      const nearest = threatResult.structured?.nearest as Record<string, any> | undefined

      // 从背包推断光源与食物（M4 遗留项，这里补上）
      const items = (inventoryResult.structured?.items as Array<Record<string, any>> | undefined) ?? []
      const itemPrefabs = items.map((item) => String(item.prefab ?? ''))
      const LIGHT_PREFABS = ['torch', 'lantern', 'minerhat', 'pumpkin_lantern', 'campfire', 'firepit']
      const FOOD_PREFABS = ['berries', 'carrot', 'corn', 'pumpkin', 'meat', 'cookedmeat', 'seeds', 'honey', 'dragonfruit', 'red_cap', 'blue_cap', 'green_cap']
      const hasLight = itemPrefabs.some((prefab) => LIGHT_PREFABS.includes(prefab))
      const hasFood = itemPrefabs.some((prefab) => FOOD_PREFABS.includes(prefab))

      const risk = assessRisk({
        player: {
          prefab: player?.prefab ?? null,
          isGhost: player?.is_ghost ?? null,
          healthPercent: player?.health?.percent ?? null,
          hungerPercent: player?.hunger?.percent ?? null,
          sanityPercent: player?.sanity?.percent ?? null,
          temperature: player?.temperature ?? null,
          dead: player?.health?.dead ?? null,
        },
        world: {
          phase: world?.phase ?? null,
          day: world?.day ?? null,
          season: world?.season ?? null,
          remainingDaysInSeason: world?.remaining_days_in_season ?? null,
        },
        threats: { hostileCount, nearestDistance: nearest?.distance ?? null },
        inventory: { hasLight, hasFood, itemCount: items.length },
        stale,
      })

      const plan = buildPlan({
        risk,
        player: {
          prefab: player?.prefab ?? null,
          healthPercent: player?.health?.percent ?? null,
          hungerPercent: player?.hunger?.percent ?? null,
          sanityPercent: player?.sanity?.percent ?? null,
          temperature: player?.temperature ?? null,
          isGhost: player?.is_ghost ?? null,
          dead: player?.health?.dead ?? null,
        },
        world: {
          phase: world?.phase ?? null,
          day: world?.day ?? null,
          season: world?.season ?? null,
          remainingDaysInSeason: world?.remaining_days_in_season ?? null,
        },
        threats: { hostileCount, nearestName: nearest?.name ?? null, nearestDistance: nearest?.distance ?? null },
        inventory: { hasLight, hasFood, itemCount: items.length, items: itemPrefabs },
        resources: {
          harvestable: (resourceResult.structured?.by_category as Record<string, number> | undefined)?.harvestable ?? null,
          tree: (resourceResult.structured?.by_category as Record<string, number> | undefined)?.tree ?? null,
          rock: (resourceResult.structured?.by_category as Record<string, number> | undefined)?.rock ?? null,
          item: (resourceResult.structured?.by_category as Record<string, number> | undefined)?.item ?? null,
        },
        stale,
      })

      return { risk, plan }
    } catch (error) {
      this.logger.warn('风险评估失败（不编造结论）', { error: String((error as Error)?.message ?? error) })
      return null
    }
  }

  /** 检查某个工具名是否允许（给 API 层做二次校验） */
  guardTool(name: string) {
    return guardToolName(name)
  }
}
