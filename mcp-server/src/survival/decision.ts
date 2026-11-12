// Phase 6 · Survival Decision Engine（全局决策仲裁器）
//
// 任务书 §10：
//   P0 紧急生存 / P1 立即避险 / P2 进食·治疗·保暖·降温 / P3 季节准备 /
//   P4 普通发展 / P5 探索与 Boss 挑战
//   并且「硬性安全规则放在程序层，不能只依赖 System Prompt」。
//
// 这里就是那层程序层：所有写动作工具在真正下发前都会问一次 `isToolAllowed()`。
// 规则写死在下表里，权重可调但"P0 一律不许采集/探索"这种事不可配置 —— 那是安全底线。

import type { ThreatAssessment } from './threat.js'
import type { CombatReadiness } from './combat.js'
import type { EscapePlan } from './escape.js'
import type { SeasonalReadiness } from './season.js'
import type { SurvivalContext } from './types.js'

export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5'

export const PRIORITY_LABELS: Readonly<Record<Priority, string>> = Object.freeze({
  P0: '紧急生存',
  P1: '立即避险',
  P2: '进食 / 治疗 / 保暖 / 降温',
  P3: '季节准备',
  P4: '普通发展',
  P5: '探索与 Boss 挑战',
})

export type DecisionAction =
  | 'STOP_ALL'
  | 'RETREAT'
  | 'EVADE'
  | 'LIGHT'
  | 'HEAL'
  | 'EAT'
  | 'WARM_OR_COOL'
  | 'PREPARE_SEASON'
  | 'DEVELOP'
  | 'EXPLORE'

/** 工具分组（写动作工具都在这三组里） */
export const COMBAT_WRITE_TOOLS: readonly string[] = ['start_combat', 'retreat_from_combat', 'evade_threat', 'abort_combat']
export const SURVIVAL_WRITE_TOOLS: readonly string[] = ['eat_item', 'craft_item', 'build_campfire', 'build_structure', 'equip_item', 'prepare_for_season', 'recover_after_combat']
export const TASK_WRITE_TOOLS: readonly string[] = ['gather_resource', 'chop_tree', 'mine_rock', 'pick_up_item', 'move_to_target', 'start_task', 'stop_task']

export const TOOL_GROUPS: Readonly<Record<'combat_write' | 'survival_write' | 'task_write', readonly string[]>> = Object.freeze({
  combat_write: COMBAT_WRITE_TOOLS,
  survival_write: SURVIVAL_WRITE_TOOLS,
  task_write: TASK_WRITE_TOOLS,
})

export interface ArbitrationInput {
  ctx: SurvivalContext
  threat: ThreatAssessment
  readiness: CombatReadiness
  escape: EscapePlan
  season: SeasonalReadiness
  /** 当前是否有任务在跑（任务链名） */
  currentTask?: string | null
}

export interface ArbitrationDecision {
  priority: Priority
  priority_label: string
  action: DecisionAction
  reasons: string[]
  /** 是否应当中断当前普通任务（采集/探索） */
  interrupt_current_task: boolean
  /** 这一档优先级下**允许**调用的写动作工具 */
  allowed_write_tools: string[]
  /** 明确禁止的写动作工具（附原因） */
  blocked_write_tools: Array<{ tool: string; reason: string }>
  next_steps: string[]
  requires_human_confirmation: boolean
  /** 触发了哪些硬性安全规则（审计用） */
  safety_rules: string[]
  /** 只读工具永远允许（不看优先级） */
  read_only_always_allowed: true
}

function allWriteTools(): string[] {
  return [...TOOL_GROUPS.combat_write, ...TOOL_GROUPS.survival_write, ...TOOL_GROUPS.task_write]
}

function blockAllExcept(allowed: string[], reason: string): Array<{ tool: string; reason: string }> {
  return allWriteTools()
    .filter((tool) => !allowed.includes(tool))
    .map((tool) => ({ tool, reason }))
}

export function arbitrate(input: ArbitrationInput): ArbitrationDecision {
  const { ctx, threat, readiness, escape, season } = input
  const reasons: string[] = []
  const safetyRules: string[] = []
  const nextSteps: string[] = []

  const hp = ctx.player.healthPercent
  const hunger = ctx.player.hungerPercent
  const sanity = ctx.player.sanityPercent
  const temp = ctx.player.temperature
  const darkness = ctx.world.isNight === true && ctx.environment.inLight === false
  const freezing = temp !== null && temp <= 0
  const overheating = temp !== null && temp >= 65
  const starving = hunger !== null && hunger <= 15
  const imminent = escape.situation.chasing_count > 0 && (escape.situation.nearest_distance ?? 99) <= 3
  const dying = hp !== null && hp <= 25

  const finish = (
    priority: Priority,
    action: DecisionAction,
    allowed: string[],
    blockReason: string,
    opts: { interrupt?: boolean; confirm?: boolean } = {},
  ): ArbitrationDecision => ({
    priority,
    priority_label: PRIORITY_LABELS[priority],
    action,
    reasons,
    interrupt_current_task: opts.interrupt ?? (priority === 'P0' || priority === 'P1'),
    allowed_write_tools: allowed,
    blocked_write_tools: blockAllExcept(allowed, blockReason),
    next_steps: nextSteps,
    requires_human_confirmation: opts.confirm ?? true,
    safety_rules: safetyRules,
    read_only_always_allowed: true,
  })

  // ───────── P0：紧急生存 ─────────
  if (ctx.player.dead || ctx.player.isGhost) {
    reasons.push('角色已死亡/幽灵状态：所有自动行为立即停止，等玩家复活或人工接管')
    safetyRules.push('P0-死亡：禁止一切写动作')
    nextSteps.push('调 get_game_status 确认状态', '等人工接管')
    return finish('P0', 'STOP_ALL', [], '角色已死亡：禁止一切写动作', { interrupt: true, confirm: false })
  }
  if (dying) {
    reasons.push(`生命 ${hp}% ≤ 25%：先保命`)
    safetyRules.push('P0-濒死：只允许治疗/进食/撤退/中止')
    nextSteps.push('recover_after_combat 或 eat_item（需确认）', '有敌人立即 retreat_from_combat')
    return finish('P0', 'HEAL', ['recover_after_combat', 'eat_item', 'retreat_from_combat', 'abort_combat', 'evade_threat', 'stop_task'], '生命过低：必须先治疗/撤离，禁止采集与探索')
  }
  if (darkness) {
    reasons.push('夜间且不在光照内：暗影生物会直接致命')
    safetyRules.push('P0-黑暗：只允许点灯/撤离/就地取材（砍树挖矿这种慢活禁止）')
    // 真机发现（2026-11-12）：原来这里把 gather 也禁了 —— 结果"没材料 → 不能采 → 永远点不上灯"
    // 死锁。采草/捡树枝是点灯的前置，必须放行；慢动作（砍树/挖矿）夜里确实危险，继续禁。
    nextSteps.push('就地采草/捡树枝 → craft_item(torch)（2 草 2 枝）', '有现成的火把/灯笼就 equip_item', '材料不够就往火堆或基地走（move_to_target）')
    return finish('P0', 'LIGHT',
      ['craft_item', 'build_campfire', 'equip_item', 'eat_item', 'gather_resource', 'pick_up_item', 'move_to_target',
        'recover_after_combat', 'retreat_from_combat', 'evade_threat', 'abort_combat', 'stop_task'],
      '黑夜无光：必须先解决光源；砍树/挖矿这类慢活禁止，采草/捡树枝可以（点灯前置）')
  }
  if (freezing || overheating) {
    reasons.push(`体温 ${temp}℃：${freezing ? '过冷' : '过热'}会持续掉血`)
    safetyRules.push('P0-极端体温：只允许保暖/降温/建火')
    nextSteps.push(freezing ? '靠近火堆 / build_campfire / 穿保暖装备' : '降温：遮阳/冰火堆/去阴凉处')
    return finish('P0', 'WARM_OR_COOL', ['craft_item', 'build_campfire', 'equip_item', 'eat_item', 'retreat_from_combat', 'abort_combat', 'evade_threat', 'stop_task'], '极端体温：先解决体温问题')
  }
  if (imminent) {
    reasons.push(`有 ${escape.situation.chasing_count} 个敌人在 ${escape.situation.nearest_distance} 格内追击`)
    safetyRules.push('P0-贴身威胁：先脱离，禁止采集')
    nextSteps.push('retreat_from_combat 或 evade_threat（明确授权后可自动执行）')
    return finish('P0', 'RETREAT', ['retreat_from_combat', 'evade_threat', 'abort_combat', 'eat_item', 'equip_item', 'stop_task'], '被敌人贴身追击：必须先脱离接触')
  }
  if (starving) {
    reasons.push(`饥饿 ${hunger}% ≤ 15%：快饿死了`)
    safetyRules.push('P0-饥饿：只允许进食')
    nextSteps.push('eat_item（需确认）')
    return finish('P0', 'EAT', ['eat_item', 'recover_after_combat', 'retreat_from_combat', 'abort_combat', 'evade_threat', 'stop_task'], '极度饥饿：先吃东西')
  }

  // ───────── P1：立即避险 ─────────
  if (threat.level === 'critical' || (threat.boss_present && (ctx.nearestThreatDistance ?? 99) <= 12)) {
    reasons.push(`威胁等级 ${threat.level}（评分 ${threat.score}/100）：${threat.reasons[0] ?? ''}`)
    safetyRules.push('P1-高危威胁：禁止开战与采集，优先躲避')
    nextSteps.push(escape.best?.actions.join(' / ') ?? 'retreat_from_combat')
    return finish('P1', escape.situation.chasing_count > 0 ? 'RETREAT' : 'EVADE',
      ['retreat_from_combat', 'evade_threat', 'abort_combat', 'eat_item', 'equip_item', 'stop_task'], '高危威胁：只能躲避/撤离')
  }
  if (threat.level === 'high') {
    reasons.push(`威胁等级 high（评分 ${threat.score}/100）：先拉开距离再看要不要打`)
    safetyRules.push('P1-高威胁：不开自动战斗')
    nextSteps.push('get_combat_recommendation → 决定 ENGAGE/PREPARE/EVADE/RETREAT')
    return finish('P1', 'EVADE', ['retreat_from_combat', 'evade_threat', 'abort_combat', 'eat_item', 'craft_item', 'equip_item', 'stop_task'], '高威胁：先避险，不允许采集/砍矿')
  }

  // ───────── P2：进食 / 治疗 / 保暖 / 降温 / 备光 ─────────
  // 真机发现（2026-11-12）：黄昏时只判 is_night，结果"天要黑了"这条没有进优先级，
  // 等到真黑了才 P0 —— 那时角色已经在挨打了。黄昏没光就提前一档处理。
  if (ctx.world.isDusk === true && ctx.environment.inLight === false) {
    reasons.push('黄昏且不在光照内：入夜就没光了（这是 P0「黑暗」的前一步）')
    safetyRules.push('P2-黄昏备光：先解决光源，别开新战线')
    nextSteps.push('craft_item(torch)（2 草 2 枝）/ build_campfire（3 草 2 木）/ 往火堆或基地走')
    return finish('P2', 'LIGHT',
      ['craft_item', 'build_campfire', 'equip_item', 'eat_item', 'gather_resource', 'pick_up_item', 'move_to_target',
        'recover_after_combat', 'abort_combat', 'retreat_from_combat', 'evade_threat', 'stop_task'],
      '黄昏要点灯：先备光源，不要探索/开新战线')
  }
  if (hunger !== null && hunger <= 30) {
    reasons.push(`饥饿 ${hunger}% 偏低`)
    safetyRules.push('P2-低饥饿：允许进食/采集，禁止开战')
    nextSteps.push('eat_item 或 gather_resource 找食物')
    return finish('P2', 'EAT', ['eat_item', 'gather_resource', 'pick_up_item', 'craft_item', 'equip_item', 'build_campfire', 'recover_after_combat', 'abort_combat', 'retreat_from_combat', 'evade_threat', 'stop_task'], '状态不佳：先解决吃喝')
  }
  if (sanity !== null && sanity <= 20) {
    reasons.push(`理智 ${sanity}% 偏低`)
    safetyRules.push('P2-低理智：避免战斗')
    nextSteps.push('远离怪物/吃熟食/天亮后再说')
    return finish('P2', 'EAT', ['eat_item', 'craft_item', 'equip_item', 'gather_resource', 'build_campfire', 'abort_combat', 'retreat_from_combat', 'evade_threat', 'stop_task'], '理智过低：避免一切战斗')
  }
  const wet = ctx.player.wetnessPercent
  if ((wet !== null && wet >= 50) || (temp !== null && temp <= 8)) {
    reasons.push(`潮湿 ${wet ?? '?'}% / 体温 ${temp ?? '?'}℃：容易掉温生病`)
    nextSteps.push('craft_item(umbrella/rainhat) / 靠近火堆')
    return finish('P2', 'WARM_OR_COOL', ['craft_item', 'build_campfire', 'equip_item', 'eat_item', 'gather_resource', 'pick_up_item', 'abort_combat'], '需要先处理潮湿/低温')
  }

  // ───────── P3：季节准备 ─────────
  if (!season.ready) {
    const missing = season.checks.filter((check) => check.ok === false).map((check) => check.label)
    reasons.push(`${season.season} 季准备度 ${season.score}/100，缺：${missing.slice(0, 4).join('、') || '—'}`)
    nextSteps.push(...season.plan.slice(0, 3).map((step) => `${step.step}（${step.tool}）`))
    return finish('P3', 'PREPARE_SEASON',
      ['craft_item', 'build_campfire', 'build_structure', 'equip_item', 'eat_item', 'recover_after_combat',
        'gather_resource', 'chop_tree', 'mine_rock', 'pick_up_item', 'move_to_target',
        // 防御性动作永远允许：季节没准备好不代表不能跑、不能停药
        'retreat_from_combat', 'evade_threat', 'abort_combat', 'stop_task'],
      '季节准备不足：先补齐季节物资，不要探索/开新战线（撤退/中止/治疗类动作不受限）')
  }

  // ───────── P4：普通发展 ─────────
  if (threat.level === 'medium') {
    reasons.push(`威胁中等（${threat.score}/100）：可以打但要先按建议准备`)
    nextSteps.push('get_combat_readiness 看缺什么 → 补齐后再 decide')
    return finish('P4', 'DEVELOP',
      ['craft_item', 'equip_item', 'eat_item', 'gather_resource', 'chop_tree', 'mine_rock', 'pick_up_item', 'move_to_target', 'build_campfire', 'start_task', 'stop_task', 'recover_after_combat', 'abort_combat', 'retreat_from_combat', 'evade_threat',
        // 中等威胁下"打不打"由战斗决策 + 人工确认决定，不在这里一刀切
        'start_combat'],
      '中等威胁：允许发展与采集（开战仍必须人工确认）')
  }

  reasons.push(`状态正常（生命 ${hp ?? '?'}%、威胁 ${threat.score}/100 ${threat.level}、${season.season} 准备度 ${season.score}/100）`)
  nextSteps.push('继续当前任务；想打怪先 evaluate_combat_target → get_combat_readiness')
  const all = allWriteTools()
  return finish('P5', input.currentTask !== null && input.currentTask !== undefined ? 'DEVELOP' : 'EXPLORE', all, '没有限制')
}

/** 工具门禁：写动作工具在下发前必须过这一关 */
export function isToolAllowed(
  decision: ArbitrationDecision,
  tool: string,
): { allowed: boolean; reason: string } {
  const isWrite = allWriteTools().includes(tool)
  if (!isWrite) return { allowed: true, reason: '只读工具不受优先级限制' }
  const blocked = decision.blocked_write_tools.find((entry) => entry.tool === tool)
  if (blocked !== undefined) {
    return {
      allowed: false,
      reason: `当前优先级 ${decision.priority}（${decision.priority_label}）不允许 ${tool}：${blocked.reason}`,
    }
  }
  return { allowed: true, reason: '优先级允许' }
}
