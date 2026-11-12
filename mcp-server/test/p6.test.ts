// Phase 6 · 决策层与 MCP 工具单测
//
// 覆盖：威胁评分（可解释 + 硬规则）、准备度、四种战斗决策、动态生命阈值、
//       9 态状态机（合法/非法迁移、单执行者）、规避选项、季节准备、Boss 准备、
//       全局仲裁（P0~P5 硬规则 + 工具门禁）、战斗控制器的程序层拒绝路径、
//       以及 16 个新工具的参数 Schema 与"无确认/无控制权一律拒绝"。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assessThreat, DEFAULT_THREAT_CONFIG } from '../src/survival/threat.js'
import { assessReadiness, decideCombat, dynamicHpThreshold, DEFAULT_COMBAT_CONFIG } from '../src/survival/combat.js'
import { COMBAT_STATES, CombatLock, CombatStateMachine, IllegalTransitionError, canTransition } from '../src/survival/combatState.js'
import { planEscape, isImminentDanger } from '../src/survival/escape.js'
import { assessSeason, detectSeason } from '../src/survival/season.js'
import { assessBossReadiness } from '../src/survival/boss.js'
import { arbitrate, isToolAllowed } from '../src/survival/decision.js'
import { createCombatController } from '../src/survival/combatController.js'
import { autoEngageList, bossList, getEnemyProfile, isBossPrefab, UNKNOWN_ENEMY } from '../src/survival/profiles.js'
import { createPhase6Tools } from '../src/tools/phase6Tools.js'
import { createToolDefinitions, runTool, type ToolContext } from '../src/tools/definitions.js'
import type { SurvivalContext, ThreatEntity } from '../src/survival/types.js'

// ───────────────────────── 测试夹具 ─────────────────────────

function threat(overrides: Partial<ThreatEntity> = {}): ThreatEntity {
  return {
    prefab: 'hound',
    name: '猎犬',
    distance: 6,
    tile_x: 10,
    tile_z: 10,
    hp: 100,
    is_boss: false,
    targeting_player: false,
    attacking: false,
    can_attack_player: false,
    attack_range: 2,
    attack_period: 2,
    attack_damage: 20,
    sleeping: false,
    source: 'threat_block',
    ...overrides,
  }
}

function context(overrides: {
  threats?: ThreatEntity[]
  hp?: number | null
  hunger?: number | null
  sanity?: number | null
  temperature?: number
  hands?: string | null
  body?: string | null
  head?: string | null
  items?: Array<{ prefab: string; count?: number }>
  isNight?: boolean
  inLight?: boolean | null
  season?: string
  remaining?: number | null
  wetness?: number
  isRaining?: boolean
  dataQuality?: SurvivalContext['dataQuality']
} = {}): SurvivalContext {
  const items = (overrides.items ?? []).map((item) => ({
    prefab: item.prefab,
    name: null,
    count: item.count ?? 1,
    freshness: null,
    fuel: null,
    armor: null,
    usesLeft: null,
  }))
  const threats = overrides.threats ?? []
  const nearest = threats.reduce<number | null>((acc, entry) => {
    if (entry.distance === null) return acc
    return acc === null ? entry.distance : Math.min(acc, entry.distance)
  }, null)
  return {
    player: {
      healthPercent: overrides.hp === undefined ? 100 : overrides.hp,
      hungerPercent: overrides.hunger === undefined ? 80 : overrides.hunger,
      sanityPercent: overrides.sanity === undefined ? 90 : overrides.sanity,
      temperature: overrides.temperature ?? 20,
      wetnessPercent: overrides.wetness ?? 0,
      dead: false,
      isGhost: false,
      tile: { x: 10, z: 10 },
      worldPosition: { x: 40, z: 40 },
      prefab: 'wilson',
    },
    equipment: {
      hands: overrides.hands === null ? null : { prefab: overrides.hands ?? 'spear', armorPercent: null, usesLeft: 100 },
      body: overrides.body === null ? null : { prefab: overrides.body ?? 'armorwood', armorPercent: 90, usesLeft: null },
      head: overrides.head === null ? null : { prefab: overrides.head ?? 'footballhelmet', armorPercent: 90, usesLeft: null },
    },
    inventory: items,
    world: {
      season: overrides.season ?? 'autumn',
      day: 12,
      elapsedDaysInSeason: 8,
      remainingDaysInSeason: overrides.remaining === undefined ? 12 : overrides.remaining,
      isDay: !(overrides.isNight ?? false),
      isDusk: false,
      isNight: overrides.isNight ?? false,
      temperature: 20,
      isRaining: overrides.isRaining ?? false,
      isSnowing: false,
      wetness: 0,
      seasonFlags: { autumn: null, winter: null, spring: null, summer: null },
    },
    environment: {
      lightSources: overrides.inLight === false ? 0 : 2,
      inLight: overrides.inLight === undefined ? true : overrides.inLight,
      fires: [],
      shard: 'master',
    },
    threats,
    threatsMeta: {
      available: true,
      hostileCount: threats.length,
      chasingCount: threats.filter((entry) => entry.targeting_player === true).length,
      attackingCount: threats.filter((entry) => entry.attacking === true).length,
      bossCount: threats.filter((entry) => entry.is_boss).length,
      scannedRadiusTiles: 16,
      scannedAtTick: 100,
      source: 'threat_block',
    },
    nearestThreatDistance: nearest,
    nearbyStructures: 5,
    dataQuality: overrides.dataQuality ?? 'verified',
    freshnessLine: '数据新鲜（约 1 秒前采集）',
    sessionId: 'S1',
    shard: 'master',
  }
}

// ───────────────────────── 档案 ─────────────────────────

test('P6-M1：敌人档案覆盖自动交战白名单，未验证生物默认保守避战', () => {
  const auto = autoEngageList()
  assert.ok(auto.includes('hound'), '猎犬应在自动白名单')
  assert.ok(!auto.includes('tentacle'), '触手不该自动交战（需要精细走位）')
  const unknown = getEnemyProfile('some_new_mob')
  assert.equal(unknown.verified, false)
  assert.equal(unknown.auto_engage_allowed, false)
  assert.equal(unknown.recommended_strategy, UNKNOWN_ENEMY.recommended_strategy)
  assert.equal(bossList().length, 12, '第一批 Boss 档案 12 条')
  assert.ok(isBossPrefab('deerclops'))
  assert.ok(!isBossPrefab('hound'))
})

// ───────────────────────── 威胁评分 ─────────────────────────

test('P6-M1：没有敌人 → 威胁接近 0；一只猎犬贴身追击 → 中高威胁', () => {
  const calm = assessThreat(context())
  assert.ok(calm.score < 10, `没有敌人时评分应很低，实际 ${calm.score}`)
  assert.equal(calm.level, 'none')
  assert.equal(calm.recommended, 'ignore')

  const chased = assessThreat(context({ threats: [threat({ distance: 2, targeting_player: true, attacking: true })] }))
  assert.ok(chased.score >= DEFAULT_THREAT_CONFIG.thresholds.medium, `贴身追击应 ≥ medium，实际 ${chased.score}`)
  assert.equal(chased.chasing_count, 1)
  assert.equal(chased.attacking_count, 1)
})

test('P6-M1：评分可解释（每个因素的 value×weight=contribution），权重可配', () => {
  const ctx = context({ threats: [threat({ distance: 4 })] })
  const base = assessThreat(ctx)
  assert.equal(base.factors.length, 8, '八个因素（能力/距离/追击/数量/生命/装备/环境/逃跑难度）')
  const sum = base.factors.reduce((acc, factor) => acc + factor.contribution, 0)
  assert.ok(Math.abs(sum - base.score) < 1, `贡献之和应等于评分（${sum} vs ${base.score}）`)
  for (const factor of base.factors) assert.ok(factor.reason.length > 0, `${factor.key} 要有理由`)

  const heaved = assessThreat(ctx, { weights: { capability: 0.9, proximity: 0.01, chasing: 0.02, count: 0.01, player_health: 0.02, equipment: 0.01, environment: 0.01, escape_difficulty: 0.02 } })
  assert.equal(heaved.config.weights.capability, 0.9, '权重应可配置并回显')
})

test('P6-M1：Boss 在场 → 硬规则把评分抬到 ≥85 且建议避战', () => {
  const ctx = context({ threats: [threat({ prefab: 'deerclops', is_boss: true, distance: 8 })] })
  const result = assessThreat(ctx)
  assert.ok(result.score >= 85, `Boss 评分应 ≥85，实际 ${result.score}`)
  assert.equal(result.boss_present, true)
  assert.equal(result.recommended, 'retreat', 'Boss 在场属于 critical → 撤退建议')
  assert.ok(result.reasons.some((reason) => reason.includes('Boss')))
})

test('P6-M1：未验证生物 → 不给自动交战，且理由里点名', () => {
  const ctx = context({ threats: [threat({ prefab: 'mystery_beast', distance: 5 })] })
  const result = assessThreat(ctx)
  assert.deepEqual(result.unknown_enemies, ['mystery_beast'])
  assert.equal(result.targets[0]?.auto_engage_allowed, false)
  assert.ok(result.reasons.some((reason) => reason.includes('没有验证档案')))
})

test('P6-M1：数据不足（拿不到生命值）→ data_ok=false，建议 monitor', () => {
  const ctx = context({ hp: null, threats: [threat()] })
  const result = assessThreat(ctx)
  assert.equal(result.data_ok, false)
  assert.equal(result.recommended, 'monitor')
})

// ───────────────────────── 准备度 ─────────────────────────

test('P6-M3：空手无甲无药 → 阻断项齐全；齐装 → 准备完毕', () => {
  // 背包非空才能判定"确实没有治疗物品"（完全空的背包 = 数据不可确认，只算 warning）
  const bare = assessReadiness(context({ hands: null, body: null, head: null, items: [{ prefab: 'log', count: 5 }] }))
  assert.equal(bare.ready, false)
  assert.ok(bare.blockers.includes('武器'))
  assert.ok(bare.blockers.includes('护甲'))
  assert.ok(bare.blockers.includes('治疗物品'))

  const armed = assessReadiness(context({
    items: [{ prefab: 'healingsalve', count: 3 }, { prefab: 'cookedmeat', count: 2 }],
  }))
  assert.equal(armed.ready, true, `齐装应 ready，阻断项=${armed.blockers.join(',')}`)
  assert.ok(armed.score >= 80)
  assert.equal(armed.battle_area.terrain_known, false)
  assert.equal(armed.retreat_route.available, true)
})

test('P6-M3：夜间不在光里 → 光源是阻断项；天黑有火就不算', () => {
  const dark = assessReadiness(context({ isNight: true, inLight: false }))
  assert.ok(dark.blockers.includes('光源'))
  const lit = assessReadiness(context({ isNight: true, inLight: true }))
  assert.ok(!lit.blockers.includes('光源'))
})

// ───────────────────────── 战斗决策 ─────────────────────────

test('P6-M2：生命低于阈值 → RETREAT/EVADE；阈值随威胁与护甲浮动（不是固定值）', () => {
  const ctx = context({ hp: 20, threats: [threat({ distance: 3, targeting_player: true })] })
  const readiness = assessReadiness(ctx)
  const threatResult = assessThreat(ctx)
  const decision = decideCombat({ ctx, threat: threatResult, readiness })
  assert.equal(decision.decision, 'EVADE')
  assert.ok(decision.reasons.some((reason) => reason.includes('动态阈值')))

  const lowThreat = assessThreat(context({ threats: [threat({ prefab: 'mosquito', distance: 8 })] }))
  const lowReadiness = assessReadiness(context({ threats: [threat({ prefab: 'mosquito', distance: 8 })] }))
  const t1 = dynamicHpThreshold(lowThreat, lowReadiness, DEFAULT_COMBAT_CONFIG)
  const highThreat = assessThreat(context({ threats: [threat({ prefab: 'tallbird', distance: 3, targeting_player: true })] }))
  const t2 = dynamicHpThreshold(highThreat, lowReadiness, DEFAULT_COMBAT_CONFIG)
  assert.ok(t2 > t1, `强敌阈值应更高（${t2} vs ${t1}）`)
})

test('P6-M2：准备不足 → PREPARE，并把阻断项当前置条件', () => {
  const ctx = context({ hands: null, body: null, head: null, items: [], threats: [threat({ distance: 5 })] })
  const decision = decideCombat({ ctx, threat: assessThreat(ctx), readiness: assessReadiness(ctx) })
  assert.equal(decision.decision, 'PREPARE')
  assert.ok(decision.preconditions.length > 0)
})

test('P6-M2：准备齐全 → ENGAGE，但政策是 SUPERVISED_COMBAT 且不可自动执行', () => {
  const ctx = context({
    items: [{ prefab: 'healingsalve', count: 3 }, { prefab: 'cookedmeat', count: 2 }],
    threats: [threat({ distance: 5 })],
  })
  const decision = decideCombat({ ctx, threat: assessThreat(ctx), readiness: assessReadiness(ctx) })
  assert.equal(decision.decision, 'ENGAGE')
  assert.equal(decision.policy.mode, 'SUPERVISED_COMBAT')
  assert.equal(decision.policy.requires_confirmation, true)
  assert.equal(decision.policy.auto_executable, false)
  assert.ok(decision.preconditions.some((item) => item.includes('confirmed=true')))
})

test('P6-M2：被围攻超过上限 → 撤退/规避；数据不足 → 拒绝战斗', () => {
  const group = context({
    items: [{ prefab: 'healingsalve', count: 3 }, { prefab: 'cookedmeat', count: 2 }],
    threats: [1, 2, 3, 4].map((index) => threat({ distance: 3 + index, targeting_player: true })),
  })
  const grouped = decideCombat({ ctx: group, threat: assessThreat(group), readiness: assessReadiness(group) })
  assert.equal(grouped.decision, 'EVADE')

  const blind = context({ hp: null, threats: [threat({ distance: 4 })] })
  const blindDecision = decideCombat({ ctx: blind, threat: assessThreat(blind), readiness: assessReadiness(blind) })
  assert.equal(blindDecision.decision, 'RETREAT')
  assert.ok(blindDecision.reasons.some((reason) => reason.includes('数据不足')))
})

test('P6-M2：Boss 在场且没指定目标 → 一律 RETREAT（不主动开 Boss 战）', () => {
  const ctx = context({
    items: [{ prefab: 'healingsalve', count: 9 }, { prefab: 'cookedmeat', count: 4 }],
    threats: [threat({ prefab: 'bearger', is_boss: true, distance: 6 })],
  })
  const decision = decideCombat({ ctx, threat: assessThreat(ctx), readiness: assessReadiness(ctx) })
  assert.equal(decision.decision, 'RETREAT')
  assert.equal(decision.policy.boss, true)
})

// ───────────────────────── 状态机 ─────────────────────────

test('P6-M4：9 态状态机合法/非法迁移 + 单执行者', () => {
  assert.equal(COMBAT_STATES.length, 9)
  assert.ok(canTransition('IDLE', 'ASSESSING'))
  assert.ok(!canTransition('IDLE', 'COMPLETE'))
  assert.ok(!canTransition('COMPLETE', 'ENGAGING'))

  const machine = new CombatStateMachine('player-1', () => 1000)
  machine.begin()
  assert.equal(machine.state, 'ASSESSING')
  assert.throws(() => machine.begin(), /只允许一个战斗执行器/)
  machine.transition('PREPARING', 'ok')
  machine.transition('ENGAGING', 'ok')
  assert.throws(() => machine.transition('ASSESSING', 'back'), IllegalTransitionError)
  machine.abort('test')
  assert.equal(machine.state, 'ABORTED')
  assert.equal(machine.isActive(), false)
  machine.resetToIdle('ack')
  assert.equal(machine.state, 'IDLE')
  assert.ok(machine.getHistory().length >= 4)

  const lock = new CombatLock()
  assert.equal(lock.acquire('p1', 'combat').ok, true)
  assert.equal(lock.acquire('p2', 'combat').ok, false)
  lock.release('p1')
  assert.equal(lock.getHolder(), null)
})

// ───────────────────────── 规避 ─────────────────────────

test('P6-M2：黑夜无光 → P0 点灯选项排第一，且建议中断当前任务', () => {
  const plan = planEscape(context({ isNight: true, inLight: false }))
  assert.equal(plan.best?.kind, 'darkness_light')
  assert.equal(plan.best?.urgency, 'P0')
  assert.equal(plan.interrupt_current_task, true)
  assert.equal(plan.best?.auto_allowed, false, '点灯要动背包，必须人工确认')
})

test('P6-M2：敌群 → 有撤退方向、可自动执行；没危险 → none', () => {
  const plan = planEscape(context({
    threats: [
      threat({ distance: 5, tile_x: 20, tile_z: 10, targeting_player: true }),
      threat({ distance: 6, tile_x: 22, tile_z: 10, targeting_player: true }),
      threat({ distance: 7, tile_x: 24, tile_z: 10 }),
    ],
  }))
  const groupOption = plan.options.find((option) => option.kind === 'evade_group')
  assert.ok(groupOption !== undefined, '三个敌人应给群体规避选项')
  assert.equal(groupOption?.auto_allowed, true)
  assert.ok(plan.best?.direction !== null)
  assert.ok((plan.best?.direction?.x ?? 10) < 10, '敌人都在东边，应往西跑')

  const calm = planEscape(context())
  assert.equal(calm.best?.kind, 'none')
  assert.equal(calm.interrupt_current_task, false)
  assert.equal(isImminentDanger(context()).danger, false)
})

test('P6-M2：低温/高温/潮湿/雷雨都会出现在环境选项里', () => {
  const cold = planEscape(context({ temperature: -3 }))
  assert.ok(cold.options.some((option) => option.kind === 'cold'))
  const hot = planEscape(context({ temperature: 72 }))
  assert.ok(hot.options.some((option) => option.kind === 'heat'))
  const rainy = planEscape(context({ isRaining: true, wetness: 60 }))
  assert.ok(rainy.options.some((option) => option.kind === 'lightning_rain'))
})

// ───────────────────────── 季节 ─────────────────────────

test('P6-M5：季节来自世界状态；拿不到剩余天数必须报"不可靠"', () => {
  assert.equal(detectSeason(context({ season: 'WINTER' }).world).season, 'WINTER')
  const winter = assessSeason(context({ season: 'winter', remaining: 4 }))
  assert.equal(winter.season, 'WINTER')
  assert.equal(winter.confidence, 'verified')
  assert.ok(winter.checks.some((check) => check.key === 'insulation'))
  assert.ok(winter.plan.length >= 4)

  const noDays = assessSeason(context({ season: 'winter', remaining: null }))
  assert.equal(noDays.confidence, 'predicted')
  assert.ok(noDays.prediction_note.includes('剩余天数'))
  assert.ok(noDays.warnings.some((warning) => warning.includes('不可靠')))

  const unknown = assessSeason({ ...context(), world: { ...context().world, season: null } })
  assert.equal(unknown.season, 'UNKNOWN')
  assert.equal(unknown.confidence, 'unreliable')
})

test('P6-M5：四季各有专属检查与计划（春=防雨/夏=防暑/秋=保暖/冬=体温）', () => {
  const spring = assessSeason(context({ season: 'spring' }))
  assert.ok(spring.checks.some((check) => check.key === 'rain_gear'))
  const summer = assessSeason(context({ season: 'summer', temperature: 70 }))
  assert.ok(summer.checks.some((check) => check.key === 'summer_gear'))
  const autumn = assessSeason(context({ season: 'autumn' }))
  assert.ok(autumn.checks.some((check) => check.key === 'thermal_stone'))
  const winter = assessSeason(context({ season: 'winter' }))
  assert.ok(winter.checks.some((check) => check.key === 'body_temp'))
  assert.ok(winter.warnings.some((warning) => warning.includes('巨鹿')))
})

// ───────────────────────── Boss ─────────────────────────

test('P6-M6：没 Boss → OBSERVE；发现了但不ready → AVOID/PREPARE；ready → SUPERVISED_COMBAT', () => {
  const none = assessBossReadiness(context())
  assert.equal(none.recommendation, 'OBSERVE')
  assert.equal(none.requires_human_confirmation, true)

  const weak = assessBossReadiness(context({
    hands: null,
    body: null,
    head: null,
    items: [],
    threats: [threat({ prefab: 'deerclops', is_boss: true, distance: 8, targeting_player: true })],
  }))
  assert.equal(weak.boss_detected, true)
  assert.equal(weak.recommendation, 'AVOID')
  assert.equal(weak.ready, false)

  const strong = assessBossReadiness(context({
    items: [{ prefab: 'healingsalve', count: 5 }, { prefab: 'cookedmeat', count: 3 }],
    threats: [threat({ prefab: 'deerclops', is_boss: true, distance: 20 })],
  }))
  assert.equal(strong.recommendation, 'SUPERVISED_COMBAT')
  assert.ok(strong.report.length >= 5, '要有战斗准备报告')
  assert.equal(strong.requires_human_confirmation, true)
})

test('P6-M6：指定一个不在附近的 Boss → 仍能出档案评估（识别不等于在场）', () => {
  const result = assessBossReadiness(context(), { target_prefab: 'dragonfly' })
  assert.equal(result.boss_detected, false)
  assert.equal(result.boss?.prefab, 'dragonfly')
  assert.equal(result.recommendation, 'OBSERVE')
})

test('P6-M6：未知 prefab 的"Boss" → 一律 AVOID', () => {
  const result = assessBossReadiness(context(), { target_prefab: 'ancient_horror' })
  assert.equal(result.recommendation, 'AVOID')
  assert.equal(result.requires_human_confirmation, true)
})

// ───────────────────────── 全局仲裁 ─────────────────────────

test('P6-M7：P0 濒死 → 只允许治疗/撤离，采集与探索被禁止', () => {
  const ctx = context({ hp: 18, threats: [threat({ distance: 3, targeting_player: true })] })
  const decision = arbitrate({
    ctx,
    threat: assessThreat(ctx),
    readiness: assessReadiness(ctx),
    escape: planEscape(ctx),
    season: assessSeason(ctx),
  })
  assert.equal(decision.priority, 'P0')
  assert.equal(decision.action, 'HEAL')
  assert.equal(decision.interrupt_current_task, true)
  assert.ok(decision.allowed_write_tools.includes('recover_after_combat'))
  assert.equal(isToolAllowed(decision, 'gather_resource').allowed, false)
  assert.equal(isToolAllowed(decision, 'start_combat').allowed, false)
  assert.equal(isToolAllowed(decision, 'get_threat_assessment').allowed, true, '只读工具永远允许')
})

test('P6-M7：黑夜无光 → P0 LIGHT；状态良好 → P5 全开', () => {
  const dark = context({ isNight: true, inLight: false })
  const darkDecision = arbitrate({
    ctx: dark,
    threat: assessThreat(dark),
    readiness: assessReadiness(dark),
    escape: planEscape(dark),
    season: assessSeason(dark),
  })
  assert.equal(darkDecision.priority, 'P0')
  assert.equal(darkDecision.action, 'LIGHT')
  assert.equal(isToolAllowed(darkDecision, 'chop_tree').allowed, false)

  const fine = context({ items: [{ prefab: 'healingsalve', count: 2 }, { prefab: 'cookedmeat', count: 3 }, { prefab: 'log', count: 8 }, { prefab: 'winter_hat', count: 1 }, { prefab: 'heatrock', count: 1 }, { prefab: 'torch', count: 1 }, { prefab: 'cutgrass', count: 8 }] })
  const fineDecision = arbitrate({
    ctx: fine,
    threat: assessThreat(fine),
    readiness: assessReadiness(fine),
    escape: planEscape(fine),
    season: assessSeason(fine),
  })
  assert.ok(['P3', 'P5'].includes(fineDecision.priority), `健康状态应为 P3/P5，实际 ${fineDecision.priority}`)
  assert.equal(isToolAllowed(fineDecision, 'chop_tree').allowed, true)
})

// ───────────────────────── 战斗控制器（程序层拒绝路径） ─────────────────────────

function fakeController() {
  const enqueued: Array<{ type: string; params: Record<string, unknown> }> = []
  const controller = createCombatController({
    enqueue: async (type, params) => {
      enqueued.push({ type, params })
      return { commandId: `cmd_${enqueued.length}`, status: 'QUEUED' }
    },
    readLuaStatus: async () => null,
  })
  return { controller, enqueued }
}

const OK_CONTROL = { holder: 'C1', leaseValid: true, canExecute: true, sessionId: 'S1' }

test('P6-M4：控制器程序层拒绝 —— 没确认 / 没控制权 / 决策不是 ENGAGE / Boss / 未验证', async () => {
  const ctx = context({ items: [{ prefab: 'healingsalve', count: 3 }, { prefab: 'cookedmeat', count: 2 }] })
  const decision = decideCombat({ ctx, threat: assessThreat(ctx), readiness: assessReadiness(ctx) })
  assert.equal(decision.decision, 'ENGAGE')

  const attempt = async (patch: Record<string, unknown>) => {
    const { controller } = fakeController()
    return controller.start({
      playerId: 'p1',
      targetPrefab: 'hound',
      confirmed: true,
      decision,
      control: OK_CONTROL,
      ...patch,
    } as Parameters<typeof controller.start>[0])
  }

  assert.equal((await attempt({ confirmed: false })).code, 'confirmation_required')
  assert.equal((await attempt({ control: { ...OK_CONTROL, canExecute: false } })).code, 'CONTROL_REQUIRED')
  assert.equal((await attempt({ decision: null })).code, 'DECISION_REQUIRED')
  assert.equal((await attempt({ decision: { ...decision, decision: 'PREPARE' } })).code, 'DECISION_PREPARE')
  assert.equal((await attempt({ targetPrefab: 'deerclops' })).code, 'BOSS_REQUIRES_SUPERVISION')
  assert.equal((await attempt({ targetPrefab: 'tentacle' })).code, 'UNVERIFIED_ENEMY')
})

test('P6-M4：控制器成功路径 → 下发 start_combat 且带 confirmed=true；第二个战斗被拒', async () => {
  const ctx = context({ items: [{ prefab: 'healingsalve', count: 3 }, { prefab: 'cookedmeat', count: 2 }] })
  const decision = decideCombat({ ctx, threat: assessThreat(ctx), readiness: assessReadiness(ctx) })
  const { controller, enqueued } = fakeController()
  const first = await controller.start({
    playerId: 'p1',
    targetPrefab: 'hound',
    confirmed: true,
    decision,
    control: OK_CONTROL,
  })
  assert.equal(first.ok, true)
  assert.equal(first.state, 'ASSESSING')
  assert.equal(enqueued[0]?.type, 'start_combat')
  assert.equal(enqueued[0]?.params.confirmed, true)

  const second = await controller.start({
    playerId: 'p1',
    targetPrefab: 'hound',
    confirmed: true,
    decision,
    control: OK_CONTROL,
  })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'COMBAT_BUSY')

  const aborted = await controller.abort('p1', OK_CONTROL)
  assert.equal(aborted.ok, true)
  assert.equal(controller.view.state, 'ABORTED')
})

// ───────────────────────── MCP 工具层 ─────────────────────────

function snapshotFrom(ctx: SurvivalContext): Record<string, unknown> {
  return {
    player: {
      valid: true,
      prefab: 'wilson',
      position: { x: 40, y: 0, z: 40, tile_x: ctx.player.tile?.x ?? 10, tile_z: ctx.player.tile?.z ?? 10 },
      health: { current: 100, max: 100, percent: ctx.player.healthPercent, dead: false },
      hunger: { current: 100, max: 150, percent: ctx.player.hungerPercent },
      sanity: { current: 100, max: 200, percent: ctx.player.sanityPercent },
      temperature: { current: ctx.player.temperature },
      moisture: { percent: ctx.player.wetnessPercent },
      is_ghost: false,
    },
    inventory: {
      slots: 15,
      used: ctx.inventory.length,
      items: ctx.inventory.map((item, index) => ({
        prefab: item.prefab,
        name: null,
        count: item.count,
        slot: index + 1,
      })),
      equipment: {
        hands: ctx.equipment.hands === null ? undefined : { prefab: ctx.equipment.hands.prefab, uses_left: 100 },
        body: ctx.equipment.body === null ? undefined : { prefab: ctx.equipment.body.prefab, armor: 90 },
        head: ctx.equipment.head === null ? undefined : { prefab: ctx.equipment.head.prefab, armor: 90 },
      },
    },
    world: {
      season: ctx.world.season,
      day: ctx.world.day,
      elapsed_days_in_season: ctx.world.elapsedDaysInSeason,
      remaining_days_in_season: ctx.world.remainingDaysInSeason,
      is_day: ctx.world.isDay,
      is_night: ctx.world.isNight,
      temperature: ctx.world.temperature,
      weather: { is_raining: ctx.world.isRaining, wetness: ctx.world.wetness },
    },
    threats: {
      radius_tiles: 16,
      hostile_count: ctx.threats.length,
      chasing_count: ctx.threats.filter((entry) => entry.targeting_player === true).length,
      attacking_count: ctx.threats.filter((entry) => entry.attacking === true).length,
      boss_count: ctx.threats.filter((entry) => entry.is_boss).length,
      scanned_at_tick: 100,
      threats: ctx.threats.map((entry) => ({
        prefab: entry.prefab,
        name: entry.name,
        distance: entry.distance,
        tile_x: entry.tile_x,
        tile_z: entry.tile_z,
        hp: entry.hp,
        is_boss: entry.is_boss,
        targeting_player: entry.targeting_player,
        attacking: entry.attacking,
        attack_range: entry.attack_range,
        attack_period: entry.attack_period,
        attack_damage: entry.attack_damage,
        sleeping: entry.sleeping,
      })),
    },
    environment: { light_sources_within_8: ctx.environment.lightSources, in_light: ctx.environment.inLight, nearby_fires: [] },
    nearby: { radius_tiles: 16, scanned: 10, returned: 5, truncated: false, entities: [] },
  }
}

function mockContext(options: {
  ctx: SurvivalContext
  control?: { mode: string; holder: string | null; lease_expires_at: number | null; emergency_stop: boolean; session_id: string }
  onEnqueue?: (type: string, params: Record<string, unknown>) => void
}): ToolContext {
  const snapshot = snapshotFrom(options.ctx)
  const control = options.control ?? {
    mode: 'SUPERVISED',
    holder: 'C1',
    lease_expires_at: Date.now() + 60_000,
    emergency_stop: false,
    session_id: 'S1',
  }
  const client = {
    url: 'http://127.0.0.1:1',
    hasToken: () => true,
    invalidate: () => {},
    getJson: async () => ({ status: 200, data: {}, elapsedMs: 1 }),
    postJson: async () => ({ status: 200, data: {}, elapsedMs: 1 }),
    health: async () => ({ status: 200, data: { ok: true }, elapsedMs: 1 }),
    status: async () => ({ status: 200, data: { bridge: {} }, elapsedMs: 1 }),
    controlStatus: async () => ({ status: 200, data: { control }, elapsedMs: 1 }),
    readSnapshot: async () => ({
      game: {
        session: { session_id: 'S1', shard: 'master', game_version: 'release', alive: true, reconnects: 0, heartbeats: 10, acknowledged_sequence: 10, duplicates: 0, gaps: 0, player_status: null },
        snapshot,
        snapshot_at: Date.now() - 500,
        snapshot_age_ms: 500,
        stale: false,
        stale_reason: null,
        stale_after_ms: 8000,
        other_sessions: 0,
        server_time: Date.now(),
      },
      fromCache: false,
      ageMs: 500,
      stale: false,
      staleReason: null,
    }),
    readFreshSnapshot: async () => {
      throw new Error('not used')
    },
    enqueueCommand: async (type: string, params: Record<string, unknown>) => {
      options.onEnqueue?.(type, params)
      return { status: 200, data: { command: { id: `cmd_${type}`, type, status: 'QUEUED' } }, elapsedMs: 1 }
    },
    getCommand: async () => ({ status: 'SUCCEEDED' }),
    runCommand: async () => ({ status: 'SUCCEEDED', result: { state: 'IDLE' } }),
  }
  return {
    client: client as unknown as ToolContext['client'],
    config: { token: 'T', bridgeUrl: 'http://127.0.0.1:1' } as unknown as ToolContext['config'],
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as ToolContext['logger'],
    events: { observe: () => {} } as unknown as ToolContext['events'],
  }
}

test('P6：MCP 注册了 16 个 Phase 6 工具，总数 43，名字不重复', () => {
  const all = createToolDefinitions()
  assert.equal(all.length, 43)
  const phase6 = createPhase6Tools().map((tool) => tool.name)
  assert.equal(phase6.length, 16)
  assert.deepEqual(
    phase6.slice().sort(),
    [
      'abort_combat',
      'evade_threat',
      'evaluate_combat_target',
      'get_boss_readiness',
      'get_combat_readiness',
      'get_combat_recommendation',
      'get_combat_status',
      'get_environment_hazards',
      'get_escape_options',
      'get_seasonal_readiness',
      'get_survival_priority',
      'get_threat_assessment',
      'prepare_for_season',
      'recover_after_combat',
      'retreat_from_combat',
      'start_combat',
    ],
  )
  const writeTools = createPhase6Tools().filter((tool) => !tool.readOnly).map((tool) => tool.name).sort()
  assert.deepEqual(writeTools, ['abort_combat', 'evade_threat', 'prepare_for_season', 'recover_after_combat', 'retreat_from_combat', 'start_combat'])
  const names = new Set(all.map((tool) => tool.name))
  assert.equal(names.size, 43)
})

test('P6：威胁/准备/建议等只读工具能真的跑通并给出结构化输出', async () => {
  const ctx = context({ threats: [threat({ distance: 4, targeting_player: true })] })
  const toolCtx = mockContext({ ctx })
  const tools = new Map(createPhase6Tools().map((tool) => [tool.name, tool]))

  const assessment = await runTool(tools.get('get_threat_assessment')!, {}, toolCtx)
  assert.equal(assessment.isError, undefined)
  assert.equal((assessment.structuredContent as { ok: boolean }).ok, true)
  assert.ok(Number((assessment.structuredContent as { score: number }).score) > 0)

  const readiness = await runTool(tools.get('get_combat_readiness')!, {}, toolCtx)
  assert.equal((readiness.structuredContent as { ready: boolean }).ready, true, '默认夹具武器护甲齐全、生命满格')

  const recommendation = await runTool(tools.get('get_combat_recommendation')!, {}, toolCtx)
  assert.ok(['ENGAGE', 'PREPARE', 'EVADE', 'RETREAT'].includes(String((recommendation.structuredContent as { decision: { decision: string } }).decision.decision)))

  const escape = await runTool(tools.get('get_escape_options')!, {}, toolCtx)
  assert.ok(Array.isArray((escape.structuredContent as { options: unknown[] }).options))

  const season = await runTool(tools.get('get_seasonal_readiness')!, {}, toolCtx)
  assert.equal((season.structuredContent as { season: string }).season, 'AUTUMN')

  const hazards = await runTool(tools.get('get_environment_hazards')!, {}, toolCtx)
  assert.ok(Array.isArray((hazards.structuredContent as { hazards: unknown[] }).hazards))

  const boss = await runTool(tools.get('get_boss_readiness')!, {}, toolCtx)
  assert.equal((boss.structuredContent as { recommendation: string }).recommendation, 'OBSERVE')

  const priority = await runTool(tools.get('get_survival_priority')!, {}, toolCtx)
  assert.ok(String((priority.structuredContent as { priority: string }).priority).startsWith('P'))

  const combatStatus = await runTool(tools.get('get_combat_status')!, {}, toolCtx)
  assert.equal((combatStatus.structuredContent as { lua_available: boolean }).lua_available, true)

  const target = await runTool(tools.get('evaluate_combat_target')!, { target_prefab: 'hound' }, toolCtx)
  assert.equal((target.structuredContent as { in_whitelist: boolean }).in_whitelist, true)
})

test('P6：写工具的程序层门禁 —— 没确认 / 没控制权一律拒绝', async () => {
  const ctx = context({ items: [{ prefab: 'healingsalve', count: 3 }, { prefab: 'cookedmeat', count: 2 }], threats: [threat({ distance: 5 })] })
  const tools = new Map(createPhase6Tools().map((tool) => [tool.name, tool]))

  const noConfirm = await runTool(tools.get('start_combat')!, {}, mockContext({ ctx }))
  assert.equal(noConfirm.isError, true)
  assert.match(String(noConfirm.content[0]?.text), /confirmed/)

  const noControl = await runTool(tools.get('retreat_from_combat')!, {}, mockContext({
    ctx,
    control: { mode: 'SUPERVISED', holder: null, lease_expires_at: null, emergency_stop: false, session_id: '' },
  }))
  assert.equal(noControl.isError, true)
  assert.match(String(noControl.content[0]?.text), /控制器持有写权限/)

  const emergency = await runTool(tools.get('evade_threat')!, {}, mockContext({
    ctx,
    control: { mode: 'EMERGENCY_STOP', holder: 'C1', lease_expires_at: Date.now() + 60_000, emergency_stop: true, session_id: 'S1' },
  }))
  assert.equal(emergency.isError, true)
  assert.match(String(emergency.content[0]?.text), /紧急停止/)

  const planOnly = await runTool(tools.get('prepare_for_season')!, {}, mockContext({ ctx }))
  assert.equal((planOnly.structuredContent as { executed: boolean }).executed, false, 'execute=false 时只给计划')
})

test('P6：start_combat 走通全流程（确认 + 决策 ENGAGE + 控制权）→ 真的下发命令', async () => {
  // 季节准备也要齐全：否则仲裁会按 P3 挡住"开新战线"（开始战斗）
  const ctx = context({
    items: [
      { prefab: 'healingsalve', count: 3 },
      { prefab: 'cookedmeat', count: 3 },
      { prefab: 'berries', count: 4 },
      { prefab: 'log', count: 8 },
      { prefab: 'cutgrass', count: 8 },
      { prefab: 'torch', count: 1 },
    ],
    threats: [threat({ distance: 5 })],
  })
  const enqueued: Array<{ type: string; params: Record<string, unknown> }> = []
  const toolCtx = mockContext({ ctx, onEnqueue: (type, params) => enqueued.push({ type, params }) })
  const tools = new Map(createPhase6Tools().map((tool) => [tool.name, tool]))
  const result = await runTool(tools.get('start_combat')!, { confirmed: true, target_prefab: 'hound' }, toolCtx)
  assert.equal(result.isError, undefined, String(result.content[0]?.text))
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0]?.type, 'start_combat')
  assert.equal(enqueued[0]?.params.confirmed, true)
})
