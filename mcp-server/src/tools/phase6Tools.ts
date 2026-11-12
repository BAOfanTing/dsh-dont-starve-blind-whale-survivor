// Phase 6 · MCP 工具（威胁 / 战斗 / 规避 / 季节 / Boss / 仲裁）
//
// 九个只读 + 七个写（另加一个全局优先级查询）：
//   get_threat_assessment       威胁分析（0~100 评分 + 因素明细 + 每个敌人的档案）
//   get_combat_readiness        战斗准备度（逐项检查 + 阻断项）
//   get_combat_status           战斗状态（Node 视图 + Lua 执行器真实状态）
//   get_combat_recommendation   战斗决策（ENGAGE / PREPARE / EVADE / RETREAT）
//   evaluate_combat_target      针对某个目标评估"能不能打"
//   get_escape_options          危险规避选项
//   get_seasonal_readiness      四季准备度 + 计划
//   get_environment_hazards     环境危险（黑暗/低温/高温/潮湿/火/雷雨）
//   get_boss_readiness          Boss 识别 + 战前准备报告
//   get_survival_priority       全局仲裁（P0~P5）
//   start_combat / retreat_from_combat / evade_threat / abort_combat
//   prepare_for_season / recover_after_combat
//
// 统一的规矩（和 Phase 5 的写工具一致）：
//   · 先查控制权（程序层，不靠提示词），没有 lease 一律拒绝；
//   · 需要人工确认的动作必须显式 `confirmed: true`；
//   · 没有实际数据支持时返回 NOT_IMPLEMENTED / DATA_UNAVAILABLE，**不编数据**。

import { z } from 'zod'
import type { ToolContext, ToolDefinition, ToolResult } from './definitions.js'
import { errorResult } from './definitions.js'
import { ToolError } from '../schemas/errors.js'
import { asDict, freshnessLine, freshnessOf, type Dict } from './snapshot.js'
import { buildContext } from '../survival/context.js'
import { assessThreat } from '../survival/threat.js'
import { assessReadiness, decideCombat } from '../survival/combat.js'
import { planEscape } from '../survival/escape.js'
import { assessSeason } from '../survival/season.js'
import { assessBossReadiness } from '../survival/boss.js'
import { arbitrate, isToolAllowed } from '../survival/decision.js'
import { createCombatController, type CombatController } from '../survival/combatController.js'
import { autoEngageList, getEnemyProfile, isBossPrefab } from '../survival/profiles.js'
import type { SurvivalContext } from '../survival/types.js'

// ───────────────────────── 公共件 ─────────────────────────

interface ContextBundle {
  snapshot: Dict
  freshness: ReturnType<typeof freshnessOf>
  context: SurvivalContext
}

async function readContext(ctx: ToolContext): Promise<ContextBundle> {
  const read = await ctx.client.readSnapshot()
  const snapshot = asDict(read.game.snapshot)
  if (snapshot === null) {
    throw new ToolError('GAME_DISCONNECTED', 'Bridge 里没有可用的游戏快照', {
      hint: '游戏没进世界 / 模组未启用 / 游戏被暂停；先看 get_bridge_status',
      detail: { session_id: read.game.session.session_id, stale_reason: read.staleReason },
    })
  }
  const freshness = freshnessOf(read)
  ctx.events.observe(snapshot, { stale: read.stale, staleReason: read.staleReason })
  const context = buildContext(snapshot, {
    freshnessLine: freshnessLine(freshness),
    sessionId: read.game.session.session_id,
  })
  return { snapshot, freshness, context }
}

function text(lines: string[], structured: Dict): ToolResult {
  return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: structured }
}

async function controlStatus(ctx: ToolContext): Promise<{
  holder: string | null
  sessionId: string
  leaseValid: boolean
  canExecute: boolean
  mode: string
  emergency: boolean
}> {
  const response = await ctx.client.controlStatus()
  const control = (response.data.control ?? {}) as Record<string, unknown>
  const mode = String(control.mode ?? 'UNKNOWN')
  const holder = control.holder === null || control.holder === undefined ? null : String(control.holder)
  const sessionId = typeof control.session_id === 'string' ? control.session_id : ''
  const emergency = control.emergency_stop === true || mode === 'EMERGENCY_STOP'
  const expiresAt = typeof control.lease_expires_at === 'number' ? control.lease_expires_at : null
  const leaseValid = expiresAt !== null && Date.now() < expiresAt
  const canExecute = holder !== null && leaseValid && !emergency && mode !== 'MANUAL' && mode !== 'PAUSED'
  return { holder, sessionId, leaseValid, canExecute, mode, emergency }
}

async function requireControl(ctx: ToolContext) {
  const status = await controlStatus(ctx)
  if (status.emergency) throw new ToolError('SESSION_INVALID', '紧急停止中，所有动作被拒', { hint: '先清除紧急停止' })
  if (status.mode === 'MANUAL') throw new ToolError('SESSION_INVALID', '人工接管中，AI 不能执行动作')
  if (status.mode === 'PAUSED') throw new ToolError('SESSION_INVALID', 'AI 已暂停')
  if (status.holder === null) throw new ToolError('SESSION_INVALID', '没有控制器持有写权限', { hint: '先由人通过 Survival Controller 授予控制权' })
  if (!status.leaseValid) throw new ToolError('SESSION_INVALID', '控制权 lease 已过期', { hint: '重新申请或续约控制权' })
  return status
}

/** 写动作门禁：仲裁层不允许的工具直接拒（硬性规则在程序层） */
async function requirePriorityAllows(ctx: ToolContext, tool: string): Promise<void> {
  const { context } = await readContext(ctx)
  const threat = assessThreat(context)
  const readiness = assessReadiness(context)
  const escape = planEscape(context)
  const season = assessSeason(context)
  const decision = arbitrate({ ctx: context, threat, readiness, escape, season })
  const verdict = isToolAllowed(decision, tool)
  if (!verdict.allowed) throw new ToolError('INVALID_ARGUMENT', verdict.reason, { hint: '先处理更高优先级的生存问题（get_survival_priority 看原因）' })
}

async function enqueue(ctx: ToolContext, type: string, params: Record<string, unknown>) {
  const control = await requireControl(ctx)
  const response = await ctx.client.enqueueCommand(type, params, {
    shard: 'master',
    controllerId: control.holder ?? undefined,
    sessionId: control.sessionId,
  })
  const command = (response.data as { command?: { id?: string; status?: string } } | null)?.command
  if (command?.id === undefined) {
    throw new ToolError('INTERNAL_ERROR', 'Bridge 没有返回 command_id', { detail: response.data })
  }
  return { commandId: command.id, status: command.status ?? 'QUEUED', control }
}

// ───────────────────────── 战斗控制器（进程内单例） ─────────────────────────

const controllers = new WeakMap<object, CombatController>()

function controllerFor(ctx: ToolContext): CombatController {
  const existing = controllers.get(ctx.client)
  if (existing !== undefined) return existing
  const controller = createCombatController({
    enqueue: async (type, params) => {
      const result = await enqueue(ctx, type, params)
      return { commandId: result.commandId, status: result.status }
    },
    readLuaStatus: async () => {
      try {
        const command = await ctx.client.runCommand('get_combat_status', {}, { timeoutMs: 6000 })
        const result = command.result
        return asDict(result)
      } catch {
        return null
      }
    },
  })
  controllers.set(ctx.client, controller)
  return controller
}

function requireConfirmed(args: { confirmed?: boolean }, name: string): void {
  if (args.confirmed !== true) {
    throw new ToolError('INVALID_ARGUMENT', `${name} 需要人工确认：请让用户明确同意后再传 confirmed=true`, {
      hint: '任务书 §12：普通敌人战斗第一版使用 SUPERVISED_COMBAT，Boss 战必须人工确认。程序层强制。',
    })
  }
}

const shardSchema = z.string().min(1).max(32).optional()

// ───────────────────────── 只读工具 ─────────────────────────

function threatTools(): ToolDefinition[] {
  return [
    {
      name: 'get_threat_assessment',
      title: '威胁分析',
      description:
        '把附近敌人、距离、追击状态、敌人数量、玩家生命/装备、环境、逃跑难度综合成 0~100 的威胁评分，' +
        '并给出每个因素的贡献（可审计）与每个敌人的战术档案（威胁等级/攻击距离/特殊能力/建议策略/撤退条件）。' +
        '没有档案的生物按"保守避战"处理。数据不足时 data_ok=false，此时**不应**进入战斗。',
      schema: z.object({
        include_factors: z.boolean().default(true).describe('是否输出每个因素的明细（默认 true）'),
        include_targets: z.boolean().default(true).describe('是否输出每个敌人的档案视图（默认 true）'),
        shard: shardSchema,
      }),
      readOnly: true,
      milestone: 'Phase6-M1',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { include_factors?: boolean; include_targets?: boolean; shard?: string }
        const { context, freshness } = await readContext(ctx)
        const threat = assessThreat(context)
        const lines = [
          freshnessLine(freshness),
          `威胁评分：${threat.score}/100（${threat.level}）→ 建议：${threat.recommended}`,
          `活跃敌人 ${threat.hostile_count} 个（追击 ${threat.chasing_count}，正在出手 ${threat.attacking_count}）` +
            (context.nearestThreatDistance !== null ? `，最近 ${context.nearestThreatDistance} 格` : ''),
          threat.data_ok ? '数据：足够评估' : `数据：不足以评估（quality=${threat.data_quality}）—— 不要据此进入战斗`,
          ...threat.reasons.map((reason) => `· ${reason}`),
        ]
        if (args.include_factors !== false) {
          lines.push('评分明细：')
          for (const factor of threat.factors) {
            lines.push(`  ${factor.label} ${(factor.value * 100).toFixed(0)}% × 权重 ${factor.weight} = ${factor.contribution} 分｜${factor.reason}`)
          }
        }
        if (args.include_targets !== false && threat.targets.length > 0) {
          lines.push('敌人档案：')
          for (const target of threat.targets.slice(0, 8)) {
            lines.push(
              `  ${target.name}(${target.prefab}) 距离 ${target.distance ?? '?'} 格，血量 ${target.hp_percent ?? '?'}%，` +
                `威胁等级 ${target.profile_threat_level}/5，攻击距离 ${target.effective.attack_range} 格，` +
                `单体危险 ${target.danger}/100，自动交战${target.auto_engage_allowed ? '允许' : '禁止'}` +
                (target.targeting_player === true ? '，正在追我' : ''),
            )
            if (target.retreat_conditions.length > 0) lines.push(`    撤退条件：${target.retreat_conditions.join('；')}`)
          }
        }
        return text(lines, {
          ok: true,
          freshness,
          data_ok: threat.data_ok,
          score: threat.score,
          level: threat.level,
          recommended: threat.recommended,
          hostile_count: threat.hostile_count,
          chasing_count: threat.chasing_count,
          attacking_count: threat.attacking_count,
          boss_present: threat.boss_present,
          unknown_enemies: threat.unknown_enemies,
          reasons: threat.reasons,
          factors: args.include_factors === false ? [] : threat.factors,
          targets: args.include_targets === false ? [] : threat.targets,
          config: threat.config,
          data_quality: threat.data_quality,
        })
      },
    },
    {
      name: 'get_combat_readiness',
      title: '战斗准备度',
      description:
        '逐项检查能不能打：生命、饥饿、理智、体温、武器、护甲、装备状态、治疗物品、食物、光源、敌人数量、数据可信度，' +
        '外加战斗区域与撤退路线评估。返回 ready / blockers（阻断项）/ score / 每项明细。',
      schema: z.object({ shard: shardSchema }),
      readOnly: true,
      milestone: 'Phase6-M3',
      handler: async (rawArgs, ctx) => {
        const { context, freshness } = await readContext(ctx)
        const readiness = assessReadiness(context)
        const escape = planEscape(context)
        const lines = [
          freshnessLine(freshness),
          `准备度：${readiness.score}/100，${readiness.ready ? '硬性条件齐全' : `不能打（缺：${readiness.blockers.join('、')}）`}`,
          ...readiness.checks.map((check) => `  ${check.ok ? '✓' : check.severity === 'blocker' ? '✗' : '!'} ${check.label}：${check.detail}`),
          `战斗区域：地形数据不可得（${readiness.battle_area.note}）${readiness.battle_area.hazards.length > 0 ? `；已知危险：${readiness.battle_area.hazards.join('、')}` : ''}`,
          `撤退路线：${readiness.retreat_route.available ? `有（往 ${readiness.retreat_route.direction?.x},${readiness.retreat_route.direction?.z}）` : '没有可用方向'}；${escape.best !== null ? `首选规避：${escape.best.reason}` : ''}`,
        ]
        return text(lines, {
          ok: true,
          freshness,
          ready: readiness.ready,
          score: readiness.score,
          blockers: readiness.blockers,
          warnings: readiness.warnings,
          checks: readiness.checks,
          weapon: readiness.weapon,
          armor: readiness.armor,
          healing: readiness.healing,
          food: readiness.food,
          light: readiness.light,
          battle_area: readiness.battle_area,
          retreat_route: readiness.retreat_route,
        })
      },
    },
    {
      name: 'get_combat_status',
      title: '战斗状态',
      description:
        '战斗执行器状态：9 态状态机（IDLE/ASSESSING/PREPARING/ENGAGING/EVADING/RETREATING/RECOVERING/COMPLETE/ABORTED）、' +
        '当前目标、命中数、受伤、装备变化、以及游戏里真实战斗 API 的可用性探测。Node 侧状态机与 Lua 执行器状态分别给出。',
      schema: z.object({}),
      readOnly: true,
      milestone: 'Phase6-M4',
      handler: async (_rawArgs, ctx) => {
        const controller = controllerFor(ctx)
        const status = await controller.status()
        const lua = status.lua_status
        const lines = [
          `Node 侧状态机：${status.node_view.state}${status.node_view.active ? '（进行中）' : ''}`,
          `Lua 执行器：${status.lua_available ? String(lua?.state ?? '?') : '拿不到（游戏未连接/未暂停？）'}`,
        ]
        if (lua !== null) {
          lines.push(
            `  目标 ${String(lua.target ?? '无')}，命中 ${String(lua.hits ?? 0)} 次，闪避 ${String(lua.dodges ?? 0)} 次，距离 ${String(lua.target_distance ?? '?')} 格`,
            `  生命 ${String(lua.hp_percent ?? '?')}%（起始 ${String(lua.hp_start ?? '?')}%），装备警告：${JSON.stringify(lua.equipment_warnings ?? [])}`,
            `  攻击 API：${JSON.stringify(lua.api ?? {})}`,
          )
        }
        lines.push(`执行器锁：${status.node_view.lock_holder ?? '无'}`)
        return text(lines, { ok: true, ...status })
      },
    },
    {
      name: 'get_combat_recommendation',
      title: '战斗建议',
      description:
        '四种基本决策：ENGAGE（打）/ PREPARE（先准备）/ EVADE（避开）/ RETREAT（撤）。' +
        '结合威胁评分、准备度、动态生命阈值（随敌人强度/追击数/护甲浮动，不是固定阈值）与全局优先级给出结论 + 理由 + 开打前置条件。' +
        '第一版政策：SUPERVISED_COMBAT（必须人工确认），Boss 一律需人工监督。',
      schema: z.object({
        target_prefab: z.string().min(1).max(64).optional().describe('可选：专门评估某个敌人（prefab）'),
        shard: shardSchema,
      }),
      readOnly: true,
      milestone: 'Phase6-M2',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { target_prefab?: string; shard?: string }
        const { context, freshness } = await readContext(ctx)
        const threat = assessThreat(context)
        const readiness = assessReadiness(context)
        const escape = planEscape(context)
        const season = assessSeason(context)
        const luaStatus = await controllerFor(ctx).status().catch(() => null)
        const engaged = luaStatus !== null && luaStatus.lua_status !== null
          ? ['ASSESSING', 'PREPARING', 'ENGAGING', 'EVADING', 'RETREATING', 'RECOVERING'].includes(String(luaStatus.lua_status.state))
          : false
        const decision = decideCombat({
          ctx: context,
          threat,
          readiness,
          engaged,
          target_prefab: args.target_prefab ?? null,
        })
        const arbitration = arbitrate({ ctx: context, threat, readiness, escape, season })
        const lines = [
          freshnessLine(freshness),
          `决策：${decision.decision}（把握 ${decision.confidence}/100）`,
          `政策：${decision.policy.mode}，需人工确认=${decision.policy.requires_confirmation}，可自动执行=${decision.policy.auto_executable}`,
          `动态生命阈值：${decision.hp_threshold}%（威胁 ${decision.threat_score}/100，准备度 ${decision.readiness_score}/100）`,
          `全局优先级：${arbitration.priority} ${arbitration.priority_label} → ${arbitration.action}`,
          ...decision.reasons.map((reason) => `· ${reason}`),
          decision.blockers.length > 0 ? `阻断项：${decision.blockers.join('、')}` : '阻断项：无',
          decision.preconditions.length > 0 ? `前置条件：${decision.preconditions.join('；')}` : '前置条件：无',
          decision.target !== null ? `目标：${decision.target.name}(${decision.target.prefab}) 距离 ${decision.target.distance ?? '?'} 格` : '目标：无',
          `下一步：${arbitration.next_steps.join(' / ')}`,
        ]
        return text(lines, {
          ok: true,
          freshness,
          decision,
          arbitration,
          threat: { score: threat.score, level: threat.level, data_ok: threat.data_ok },
          readiness: { ready: readiness.ready, score: readiness.score, blockers: readiness.blockers },
        })
      },
    },
    {
      name: 'evaluate_combat_target',
      title: '评估交战目标',
      description:
        '针对一个具体目标回答"能不能打"：是否有验证档案、威胁等级、实际攻击范围/伤害（运行时优先）、单体危险度、' +
        '是否在自动交战白名单、按当前状态该 ENGAGE 还是先 PREPARE/EVADE，以及开打需要的确认与参数。',
      schema: z.object({
        target_prefab: z.string().min(1).max(64).describe('要评估的目标 prefab（例如 hound / spider）'),
        shard: shardSchema,
      }),
      readOnly: true,
      milestone: 'Phase6-M2',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { target_prefab: string; shard?: string }
        const { context, freshness } = await readContext(ctx)
        const threat = assessThreat(context)
        const readiness = assessReadiness(context)
        const target = threat.targets.find((entry) => entry.prefab === args.target_prefab) ?? null
        const profile = getEnemyProfile(args.target_prefab)
        const boss = isBossPrefab(args.target_prefab)
        const decision = decideCombat({ ctx: context, threat, readiness, target_prefab: args.target_prefab })

        const allowed = !boss && profile.auto_engage_allowed && threat.data_ok
        const lines = [
          freshnessLine(freshness),
          `目标 ${profile.name}(${profile.prefab})：${boss ? 'Boss（只能人工监督）' : profile.verified ? '有验证档案' : '**没有档案**（保守避战）'}`,
          `档案：威胁等级 ${profile.threat_level}/5，攻击距离 ${profile.attack_range} 格，出手间隔 ${profile.attack_period}s，单次 ${profile.damage} 伤害，类型 ${profile.combat_profile}`,
          target === null
            ? '该目标当前不在视野内（只能按档案评估）'
            : `实时：距离 ${target.distance ?? '?'} 格，血量 ${target.hp_percent ?? '?'}%，单体危险 ${target.danger}/100；实际攻击距离 ${target.effective.attack_range} 格（来源 ${target.effective.source}）`,
          `自动交战白名单：${profile.auto_engage_allowed ? '在' : '不在'}（白名单：${autoEngageList().join('/')}）`,
          `结论：${decision.decision}（${allowed && decision.decision === 'ENGAGE' ? '可以申请人工监督战斗' : decision.decision === 'ENGAGE' ? '需人工确认才可以打' : '现在不要打'}）`,
          ...(target?.special_abilities.length ? [`特殊能力：${target.special_abilities.join('；')}`] : []),
          ...(target?.retreat_conditions.length ? [`撤退条件：${target.retreat_conditions.join('；')}`] : []),
        ]
        return text(lines, {
          ok: true,
          freshness,
          target_prefab: args.target_prefab,
          profile,
          live: target,
          in_whitelist: profile.auto_engage_allowed,
          boss,
          decision,
          can_start_combat: allowed && decision.decision === 'ENGAGE',
          requires_confirmation: true,
        })
      },
    },
    {
      name: 'get_escape_options',
      title: '危险规避选项',
      description:
        '独立于战斗的危险规避：敌群撤退、Boss 避战、黑夜无光、低温、高温、火灾、闪电降雨。' +
        '给出排序后的选项（含建议方向、建议动作、风险），并说明是否应该中断当前采集/探索任务。' +
        '注意：没有地形数据，方向只是"背离威胁的合向量"，实际绕障碍由游戏寻路负责。',
      schema: z.object({
        camp_x: z.number().int().min(-10000).max(10000).optional().describe('可选：营地格子 x'),
        camp_z: z.number().int().min(-10000).max(10000).optional().describe('可选：营地格子 z'),
        flee_distance_tiles: z.number().int().min(4).max(30).default(12).describe('逃生距离（格）'),
        shard: shardSchema,
      }),
      readOnly: true,
      milestone: 'Phase6-M2',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { camp_x?: number; camp_z?: number; flee_distance_tiles?: number; shard?: string }
        const { context, freshness } = await readContext(ctx)
        const camp = args.camp_x !== undefined && args.camp_z !== undefined ? { x: args.camp_x, z: args.camp_z } : null
        const plan = planEscape(context, { camp, flee_distance_tiles: args.flee_distance_tiles })
        const lines = [
          freshnessLine(freshness),
          `形势：敌人 ${plan.situation.hostile_count} 个（追击 ${plan.situation.chasing_count}），最近 ${plan.situation.nearest_distance ?? '?'} 格；` +
            `${plan.situation.is_night ? '夜间' : '白天'}${plan.situation.in_light === false ? '、**不在光照内**' : ''}，体温 ${plan.situation.player_temperature ?? '?'}℃，潮湿 ${plan.situation.wetness ?? '?'}%`,
          `是否需要中断当前任务：${plan.interrupt_current_task ? '是（先处理危险）' : '否'}`,
          ...plan.options.map((option) => `[${option.urgency}] ${option.kind}（优先级 ${option.priority}）：${option.reason}` +
            (option.direction !== null ? ` → 往 (${option.direction.x},${option.direction.z})` : '') +
            (option.actions.length > 0 ? `｜建议动作：${option.actions.join(' / ')}` : '') +
            `｜可自动=${option.auto_allowed}`),
          ...plan.notes.map((note) => `注：${note}`),
        ]
        return text(lines, { ok: true, freshness, ...plan })
      },
    },
    {
      name: 'get_seasonal_readiness',
      title: '季节准备度',
      description:
        '按当前真实季节给出准备清单与计划（秋：基地/木料/食物/保暖/保温石/武器护甲；冬：体温/保暖/燃料/食物/Boss 风险；' +
        '春：潮湿/防雨/理智/落雷/青蛙雨；夏：防暑/降温/闷烧/野火/基地防火）。季节与剩余天数全部读游戏状态，' +
        '拿不到时 confidence=unreliable 并明确说明预测不可靠。',
      schema: z.object({ shard: shardSchema }),
      readOnly: true,
      milestone: 'Phase6-M5',
      handler: async (rawArgs, ctx) => {
        const { context, freshness } = await readContext(ctx)
        const season = assessSeason(context)
        const lines = [
          freshnessLine(freshness),
          `季节：${season.season}（来源 ${season.data_source}），第 ${season.day ?? '?'} 天，本季已过 ${season.elapsed_days_in_season ?? '?'} 天，剩 ${season.remaining_days_in_season ?? '?'} 天`,
          `预测可信度：${season.confidence} —— ${season.prediction_note}`,
          `准备度：${season.score}/100，${season.ready ? '关键项齐全' : '有关键项缺失'}`,
          ...season.checks.map((check) => `  ${check.ok === null ? '?' : check.ok ? '✓' : '✗'} [P${check.priority}] ${check.label}：${check.detail}`),
          '准备计划：',
          ...season.plan.map((step, index) => `  ${index + 1}. [P${step.priority}] ${step.step}（工具 ${step.tool}）—— ${step.why}`),
          ...season.warnings.map((warning) => `⚠️ ${warning}`),
        ]
        return text(lines, { ok: true, freshness, ...season })
      },
    },
    {
      name: 'get_environment_hazards',
      title: '环境危险',
      description:
        '只看环境（不看敌人）：黑暗、低温、高温、潮湿、火灾风险、雷雨、理智、季节极端天气。' +
        '每一项都给出读数与严重度，并说明判定依据。数据缺失的项如实标注 unknown。',
      schema: z.object({ shard: shardSchema }),
      readOnly: true,
      milestone: 'Phase6-M2',
      handler: async (rawArgs, ctx) => {
        const { context, freshness } = await readContext(ctx)
        const temp = context.player.temperature
        const night = context.world.isNight === true
        const inLight = context.environment.inLight
        const wet = context.player.wetnessPercent
        const nearestFireFuel = context.environment.fires.length > 0
          ? Math.min(...context.environment.fires.map((fire) => fire.fuelPercent ?? 100))
          : null

        const hazards: Array<{ key: string; label: string; severity: 'critical' | 'high' | 'medium' | 'low' | 'unknown'; detail: string }> = []
        hazards.push({
          key: 'darkness',
          label: '黑暗',
          severity: night ? (inLight === false ? 'critical' : inLight === true ? 'low' : 'unknown') : 'low',
          detail: !night ? '白天，无黑暗风险' : inLight === null ? '夜间，但拿不到光照状态' : inLight ? '夜间，在光照内' : '夜间且不在光照内（极其危险）',
        })
        hazards.push({
          key: 'cold',
          label: '低温',
          severity: temp === null ? 'unknown' : temp <= 0 ? 'critical' : temp <= 8 ? 'high' : 'low',
          detail: temp === null ? '拿不到体温' : `体温 ${temp}℃（≤0 冻伤，≤8 偏冷）`,
        })
        hazards.push({
          key: 'heat',
          label: '高温',
          severity: temp === null ? 'unknown' : temp >= 65 ? 'critical' : temp >= 50 ? 'high' : 'low',
          detail: temp === null ? '拿不到体温' : `体温 ${temp}℃（≥65 过热）`,
        })
        hazards.push({
          key: 'wetness',
          label: '潮湿',
          severity: wet === null ? 'unknown' : wet >= 50 ? 'high' : wet >= 30 ? 'medium' : 'low',
          detail: wet === null ? '拿不到潮湿值' : `潮湿 ${wet}%（≥50 明显掉温）`,
        })
        hazards.push({
          key: 'fire',
          label: '火源',
          severity: nearestFireFuel === null ? 'unknown' : nearestFireFuel < 15 ? 'high' : nearestFireFuel < 35 ? 'medium' : 'low',
          detail: nearestFireFuel === null
            ? '8 格内没有火堆（夜里要自己生一个）'
            : `8 格内火堆燃料最低 ${nearestFireFuel}%（<15% 快灭了）`,
        })
        hazards.push({
          key: 'lightning_rain',
          label: '雷雨',
          severity: context.world.isRaining === true ? (context.world.season === 'spring' || context.world.season === 'SPRING' ? 'high' : 'medium') : 'low',
          detail: context.world.isRaining === true ? '正在下雨（春季雷雨会落雷、浇灭火堆）' : '没有下雨',
        })
        const sanity = context.player.sanityPercent
        hazards.push({
          key: 'sanity',
          label: '理智',
          severity: sanity === null ? 'unknown' : sanity <= 15 ? 'critical' : sanity <= 30 ? 'high' : 'low',
          detail: sanity === null ? '拿不到理智值' : `理智 ${sanity}%`,
        })

        const worst = hazards.reduce((acc, hazard) => {
          const order = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 }
          return order[hazard.severity] > order[acc.severity] ? hazard : acc
        }, hazards[0] as (typeof hazards)[number])

        const lines = [
          freshnessLine(freshness),
          `最严重的环境危险：${worst.label}（${worst.severity}）—— ${worst.detail}`,
          ...hazards.map((hazard) => `  [${hazard.severity}] ${hazard.label}：${hazard.detail}`),
          `季节：${context.world.season ?? '未知'}，气温 ${context.world.temperature ?? '?'}℃，降雪 ${context.world.isSnowing === true ? '是' : '否'}`,
        ]
        return text(lines, { ok: true, freshness, hazards, worst, season: context.world.season, data_quality: context.dataQuality })
      },
    },
    {
      name: 'get_boss_readiness',
      title: 'Boss 战准备',
      description:
        '识别第一批 Boss（Deerclops/Bearger/Moose-Goose/Antlion/Bee Queen/Dragonfly 等），给出生命/位置/行为状态、' +
        '玩家装备与治疗准备度、战斗区域与撤离路线评估，输出 OBSERVE / PREPARE / AVOID / SUPERVISED_COMBAT 与一份战斗准备报告。' +
        '本阶段不自动开 Boss 战：requires_human_confirmation 恒为 true。',
      schema: z.object({
        target_prefab: z.string().min(1).max(64).optional().describe('可选：只评估某个 Boss（不在附近也能查档案）'),
        shard: shardSchema,
      }),
      readOnly: true,
      milestone: 'Phase6-M6',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { target_prefab?: string; shard?: string }
        const { context, freshness } = await readContext(ctx)
        const boss = assessBossReadiness(context, { target_prefab: args.target_prefab ?? null })
        const lines = [freshnessLine(freshness), ...boss.report, ...boss.notes.map((note) => `注：${note}`)]
        return text(lines, { ok: true, freshness, ...boss })
      },
    },
    {
      name: 'get_survival_priority',
      title: '生存优先级仲裁',
      description:
        '全局决策仲裁：P0 紧急生存 / P1 立即避险 / P2 进食治疗保暖降温 / P3 季节准备 / P4 普通发展 / P5 探索与 Boss。' +
        '返回当前优先级、建议动作、是否应中断当前任务、以及这一档优先级下允许与禁止的写动作工具。' +
        '硬性安全规则在这里（程序层），不依赖提示词。',
      schema: z.object({ shard: shardSchema }),
      readOnly: true,
      milestone: 'Phase6-M7',
      handler: async (rawArgs, ctx) => {
        const { context, freshness } = await readContext(ctx)
        const threat = assessThreat(context)
        const readiness = assessReadiness(context)
        const escape = planEscape(context)
        const season = assessSeason(context)
        const decision = arbitrate({ ctx: context, threat, readiness, escape, season })
        const lines = [
          freshnessLine(freshness),
          `优先级：${decision.priority} ${decision.priority_label} → ${decision.action}`,
          `中断当前任务：${decision.interrupt_current_task ? '是' : '否'}`,
          ...decision.reasons.map((reason) => `· ${reason}`),
          `允许的写动作：${decision.allowed_write_tools.length === 0 ? '（无）' : decision.allowed_write_tools.join(' / ')}`,
          ...(decision.blocked_write_tools.length > 0
            ? [`被禁止：${decision.blocked_write_tools.slice(0, 8).map((entry) => `${entry.tool}（${entry.reason}）`).join('；')}`]
            : []),
          ...(decision.safety_rules.length > 0 ? [`触发的硬性规则：${decision.safety_rules.join('；')}`] : []),
          `下一步：${decision.next_steps.join(' / ')}`,
        ]
        return text(lines, { ok: true, freshness, ...decision })
      },
    },
  ]
}

// ───────────────────────── 写工具 ─────────────────────────

function combatWriteTools(): ToolDefinition[] {
  return [
    {
      name: 'start_combat',
      title: '开始战斗（人工监督）',
      description:
        '对白名单内的普通敌人发起 SUPERVISED_COMBAT。必须显式 confirmed=true，且必须先有控制权。' +
        '程序层会再查一遍：目标是否在自动交战白名单、是否 Boss（Boss 一律拒绝）、决策是否为 ENGAGE。' +
        '战斗由 Lua 执行器以 0.1 秒 tick 做 Kiting（原生 combat:TryAttack / locomotor，不用 ForceAttack）；' +
        '生命低于动态阈值、被围攻、控制权被撤销、紧急停止都会让其自动脱离。',
      schema: z.object({
        target_prefab: z
          .enum(autoEngageList() as [string, ...string[]])
          .optional()
          .describe(`要打的目标（白名单：${autoEngageList().join('/')}）；不传则打最近的合法目标`),
        radius: z.number().int().min(2).max(20).default(12).describe('搜索半径（格）'),
        max_duration_s: z.number().int().min(5).max(180).default(45).describe('最长战斗时长（秒）'),
        retreat_hp_percent: z.number().int().min(10).max(80).default(30).describe('生命低于该百分比自动脱离'),
        kite_distance: z.number().min(1.5).max(6).default(3).describe('风筝保持距离（格）'),
        confirmed: z.boolean().default(false).describe('人工确认。必须为 true 才会执行'),
      }),
      readOnly: false,
      milestone: 'Phase6-M4',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as {
          target_prefab?: string
          radius?: number
          max_duration_s?: number
          retreat_hp_percent?: number
          kite_distance?: number
          confirmed?: boolean
        }
        requireConfirmed(args, 'start_combat')
        // 控制权先查：紧急停止/人工接管的拒绝优先级高于一切业务判断
        const control = await requireControl(ctx)
        await requirePriorityAllows(ctx, 'start_combat')
        const { context } = await readContext(ctx)
        const threat = assessThreat(context)
        const readiness = assessReadiness(context)
        const decision = decideCombat({
          ctx: context,
          threat,
          readiness,
          target_prefab: args.target_prefab ?? null,
        })
        const controller = controllerFor(ctx)
        const result = await controller.start({
          playerId: context.sessionId ?? 'unknown',
          targetPrefab: args.target_prefab ?? null,
          confirmed: true,
          decision,
          params: {
            radius: args.radius,
            max_duration_s: args.max_duration_s,
            retreat_hp_percent: args.retreat_hp_percent,
            kite_distance: args.kite_distance,
          },
          control: {
            holder: control.holder,
            leaseValid: control.leaseValid,
            canExecute: control.canExecute,
            sessionId: control.sessionId,
          },
        })
        if (!result.ok) {
          return errorResult({
            code: result.code === 'CONTROL_REQUIRED' ? 'SESSION_INVALID' : 'INVALID_ARGUMENT',
            message: result.message ?? '战斗没能开始',
            hint: '用 get_combat_recommendation 看为什么被拒绝',
            detail: { decision: decision.decision, blockers: decision.blockers },
          })
        }
        const payload = {
          ok: true,
          command_id: result.commandId,
          combat_state: decision.decision,
          policy: decision.policy,
          target: decision.target,
          hp_threshold: decision.hp_threshold,
          note: '战斗已下发（EXECUTING）。用 get_combat_status 看进度；abort_combat 可随时中止。',
        }
        return text([
          `已进入 SUPERVISED_COMBAT：${decision.target?.name ?? '最近目标'}（command=${result.commandId}）`,
          `自动脱离阈值：生命 ${decision.hp_threshold}%；最长 ${args.max_duration_s ?? 45} 秒`,
          '用 get_combat_status 查进度，abort_combat 随时中止。',
        ], payload)
      },
    },
    {
      name: 'retreat_from_combat',
      title: '撤退',
      description:
        '脱离当前战斗并背离威胁跑开。明确授权后可自动执行（不需要 confirmed），但必须有控制权。' +
        'Lua 侧会走 RETREATING 状态，直到距离 ≥8 格或超时，然后自动结算。',
      schema: z.object({
        radius: z.number().int().min(2).max(20).default(12).describe('搜索半径（格）'),
        max_duration_s: z.number().int().min(5).max(180).default(30).describe('最长撤离时长（秒）'),
      }),
      readOnly: false,
      milestone: 'Phase6-M2',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { radius?: number; max_duration_s?: number }
        const control = await requireControl(ctx)
        await requirePriorityAllows(ctx, 'retreat_from_combat')
        const { context } = await readContext(ctx)
        const controller = controllerFor(ctx)
        const result = await controller.retreat(context.sessionId ?? 'unknown', {
          holder: control.holder,
          leaseValid: control.leaseValid,
          canExecute: control.canExecute,
          sessionId: control.sessionId,
        }, { radius: args.radius, max_duration_s: args.max_duration_s })
        if (!result.ok) {
          return errorResult({ code: 'SESSION_INVALID', message: result.message ?? '撤退没能下发' })
        }
        return text(
          [`已下发撤退（command=${result.commandId}）：背离威胁方向跑，跑够 8 格或超时后自动结算。`],
          { ok: true, command_id: result.commandId, combat_state: result.state },
        )
      },
    },
    {
      name: 'evade_threat',
      title: '躲避威胁',
      description:
        '不接战、直接拉开距离（用于群体敌人/Boss/不想打的时候）。明确授权后可自动执行，但必须有控制权。' +
        'Lua 侧进入 EVADING 状态，背离最近威胁跑指定距离。',
      schema: z.object({
        radius: z.number().int().min(2).max(20).default(12).describe('搜索半径（格）'),
        distance: z.number().int().min(4).max(30).default(10).describe('要拉开多少格'),
        max_duration_s: z.number().int().min(5).max(180).default(20).describe('最长躲避时长（秒）'),
        target_prefab: z.string().min(1).max(64).optional().describe('可选：指定躲谁（只认白名单内的敌人）'),
      }),
      readOnly: false,
      milestone: 'Phase6-M2',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { radius?: number; distance?: number; max_duration_s?: number; target_prefab?: string }
        const control = await requireControl(ctx)
        await requirePriorityAllows(ctx, 'evade_threat')
        const { context } = await readContext(ctx)
        const controller = controllerFor(ctx)
        const result = await controller.evade(context.sessionId ?? 'unknown', {
          holder: control.holder,
          leaseValid: control.leaseValid,
          canExecute: control.canExecute,
          sessionId: control.sessionId,
        }, {
          radius: args.radius,
          distance: args.distance,
          max_duration_s: args.max_duration_s,
          ...(args.target_prefab === undefined ? {} : { target_prefab: args.target_prefab }),
        })
        if (!result.ok) {
          return errorResult({ code: result.code === 'COMBAT_BUSY' ? 'INVALID_ARGUMENT' : 'SESSION_INVALID', message: result.message ?? '躲避没能下发' })
        }
        return text(
          [`已下发躲避（command=${result.commandId}）：背离威胁 ${args.distance ?? 10} 格。`],
          { ok: true, command_id: result.commandId, combat_state: result.state },
        )
      },
    },
    {
      name: 'abort_combat',
      title: '中止战斗',
      description:
        '立刻停止战斗（停止移动、清空缓冲动作、状态机转 ABORTED）。紧急停止永远最高优先级：' +
        '即使没有控制权也会先把 Node 侧状态清干净，并明确告诉你去游戏里按 F7。',
      schema: z.object({}),
      readOnly: false,
      milestone: 'Phase6-M4',
      handler: async (_rawArgs, ctx) => {
        const control = await controlStatus(ctx)
        const { context } = await readContext(ctx)
        const controller = controllerFor(ctx)
        const result = await controller.abort(context.sessionId ?? 'unknown', {
          holder: control.holder,
          leaseValid: control.leaseValid,
          canExecute: control.canExecute,
          sessionId: control.sessionId,
        })
        if (!result.ok) {
          return text(
            [`Node 侧战斗状态已清理（ABORTED）。${result.message ?? ''}`, '游戏里请按 F7 或调 stop 命令立即停手。'],
            { ok: true, node_aborted: true, game_aborted: false, reason: result.code },
          )
        }
        return text(
          [`已下发中止（command=${result.commandId}）：战斗停止，角色停下。`],
          { ok: true, command_id: result.commandId, combat_state: result.state },
        )
      },
    },
  ]
}

function survivalWriteTools(): ToolDefinition[] {
  return [
    {
      name: 'prepare_for_season',
      title: '季节准备',
      description:
        '按当前真实季节生成准备计划；execute=true 时可以把"机械那一半"交给任务链执行（autumn_prep/winter_prep/spring_prep/summer_prep：' +
        '采草、砍木、捡木、做火把/斧头、生营火、进食）。需要人工确认，且必须有控制权。' +
        '季节专属细节（保暖帽/保温石/雨伞/降温石）不在任务链里，按返回的计划用 craft_item 单独执行。',
      schema: z.object({
        season: z.enum(['AUTUMN', 'WINTER', 'SPRING', 'SUMMER']).optional().describe('可选：指定要按哪一季准备（默认当前季节）'),
        execute: z.boolean().default(false).describe('是否真的启动任务链执行（false = 只给计划）'),
        confirmed: z.boolean().default(false).describe('人工确认。执行时必须为 true'),
      }),
      readOnly: false,
      milestone: 'Phase6-M5',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { season?: string; execute?: boolean; confirmed?: boolean }
        const { context, freshness } = await readContext(ctx)
        const season = assessSeason(context)
        const targetSeason = args.season ?? (season.season === 'UNKNOWN' ? null : season.season)
        const taskName = targetSeason === null ? null : {
          AUTUMN: 'autumn_prep',
          WINTER: 'winter_prep',
          SPRING: 'spring_prep',
          SUMMER: 'summer_prep',
        }[targetSeason] ?? null

        if (args.execute !== true) {
          return text(
            [
              freshnessLine(freshness),
              `季节：${season.season}（可信度 ${season.confidence}），准备度 ${season.score}/100`,
              `计划（未执行，execute=false）：`,
              ...season.plan.map((step, index) => `  ${index + 1}. ${step.step}（${step.tool}）`),
              taskName === null ? '季节未知：先确认季节再谈执行' : `如需执行任务链：prepare_for_season(season="${targetSeason}", execute=true, confirmed=true)`,
            ],
            { ok: true, freshness, executed: false, season, candidate_task: taskName },
          )
        }

        requireConfirmed(args, 'prepare_for_season')
        if (taskName === null) {
          throw new ToolError('INVALID_ARGUMENT', '季节未知，无法选择准备任务链：请先确认季节或显式传 season', {
            hint: '用 get_world_status 看季节',
          })
        }
        await requireControl(ctx)
        await requirePriorityAllows(ctx, 'prepare_for_season')
        const enqueued = await enqueue(ctx, 'start_task', { task: taskName })
        return text(
          [
            `已启动季节准备任务链 ${taskName}（command=${enqueued.commandId}）`,
            `计划要点：${season.plan.slice(0, 3).map((step) => step.step).join('；')}`,
            '用 get_task_status 查进度；出现危险时用 stop_task / retreat_from_combat 打断。',
          ],
          {
            ok: true,
            executed: true,
            command_id: enqueued.commandId,
            task: taskName,
            season,
            note: '任务链只做采草/砍木/生火/进食这类机械步骤；保暖装备等配方请单独 craft_item',
          },
        )
      },
    },
    {
      name: 'recover_after_combat',
      title: '战后恢复',
      description:
        '战斗结束后按顺序处理：先治疗（有治疗物品就走原生 HEAL 动作），再补饥饿，最后检查装备是否要补。' +
        '需要人工确认且有控制权。每一步都会真实下发命令并返回 command_id；没有可做的事就如实说"不需要"。',
      schema: z.object({
        confirmed: z.boolean().default(false).describe('人工确认。必须为 true 才会执行'),
      }),
      readOnly: false,
      milestone: 'Phase6-M4',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { confirmed?: boolean }
        requireConfirmed(args, 'recover_after_combat')
        await requireControl(ctx)
        await requirePriorityAllows(ctx, 'recover_after_combat')
        const { context, freshness } = await readContext(ctx)
        const readiness = assessReadiness(context)
        const hp = context.player.healthPercent ?? 100
        const hunger = context.player.hungerPercent ?? 100

        const steps: Array<{ action: string; command_id: string; why: string }> = []
        if (hp < 60 && readiness.healing.known) {
          const heal = await enqueue(ctx, 'heal_self', {})
          steps.push({ action: 'heal_self', command_id: heal.commandId, why: `生命 ${hp}% < 60%：先治疗` })
        } else if (hunger < 40) {
          const eat = await enqueue(ctx, 'eat_item', { confirmed: true })
          steps.push({ action: 'eat_item', command_id: eat.commandId, why: `饥饿 ${hunger}% 偏低：先吃点` })
        } else if (context.equipment.body === null && context.equipment.head === null) {
          steps.push({ action: 'equip_item(需要人工指定物品)', command_id: '-', why: '身上没有护甲，建议穿一件' })
        }

        const lines = [
          freshnessLine(freshness),
          `战后状态：生命 ${hp}% 饥饿 ${hunger}% 理智 ${context.player.sanityPercent ?? '?'}%`,
          steps.length === 0 ? '不需要自动恢复：状态还算健康（≥60% 生命、≥40% 饥饿）' : `已下发 ${steps.length} 个恢复动作：`,
          ...steps.map((step) => `  ${step.action}（command=${step.command_id}）—— ${step.why}`),
          readiness.healing.items.length > 0 ? `治疗物品：${readiness.healing.items.join('/')}（合计约 ${readiness.healing.total_hp} 点）` : '背包没有已知治疗物品',
        ]
        return text(lines, { ok: true, freshness, steps, hp, hunger, healing: readiness.healing })
      },
    },
  ]
}

export function createPhase6Tools(): ToolDefinition[] {
  return [...threatTools(), ...combatWriteTools(), ...survivalWriteTools()]
}
