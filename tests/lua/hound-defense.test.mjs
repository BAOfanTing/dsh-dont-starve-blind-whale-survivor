import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { survivalLevel, P1 } from '../../lib/planner/survival-priority.js'
import { derivePlan } from '../../lib/plan.js'
import { survivalStabilize } from '../../lib/skills/survival-stabilize.js'
import { arbitrate } from '../../lib/planner/decision-arbiter.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

test('HD-1: battle.lua 敌人策略注册表扩展支持蜘蛛战士、野狗、冰狗、火狗', () => {
  const battleLua = readFileSync(join(MOD, 'scripts', 'whale', 'battle.lua'), 'utf8')
  assert.match(battleLua, /hound\s*=\s*\{/)
  assert.match(battleLua, /icehound\s*=\s*\{/)
  assert.match(battleLua, /firehound\s*=\s*\{/)
  assert.match(battleLua, /spider_warrior\s*=\s*\{/)

  // 验证关键战术参数
  assert.match(battleLua, /fast_chaser\s*=\s*true/)
  assert.match(battleLua, /on_death_effect\s*=\s*"fire_explosion"/)
  assert.match(battleLua, /on_death_effect\s*=\s*"freeze"/)
})

test('HD-2: battle.lua 战利品优先级包含狗牙、红宝石、蓝宝石', () => {
  const battleLua = readFileSync(join(MOD, 'scripts', 'whale', 'battle.lua'), 'utf8')
  assert.match(battleLua, /houndstooth\s*=\s*1/)
  assert.match(battleLua, /redgem\s*=/)
  assert.match(battleLua, /bluegem\s*=/)
})

test('HD-3: battle.lua 导出 StartDefense 并包含温蒂召唤与迎击协调', () => {
  const battleLua = readFileSync(join(MOD, 'scripts', 'whale', 'battle.lua'), 'utf8')
  assert.match(battleLua, /function B\.StartDefense\(p,\s*attacker\)/)
  assert.match(battleLua, /DEFENSE_SUMMON_COMPANION/)
  assert.match(battleLua, /DEFENSE_ENGAGE/)
  assert.match(battleLua, /fire_wait_start/) // 火狗爆炸防范
})

test('HD-4: reflex.lua 与战斗系统协同：受控敌人来袭且非残血时启动主动防御并抑制自杀逃跑', () => {
  const reflexLua = readFileSync(join(MOD, 'scripts', 'whale', 'reflex.lua'), 'utf8')
  // R8.5：不再只对 fast_chaser(猎犬) 生效，而是"战术表里 supported 的任何敌人"（含蜘蛛/青蛙）
  assert.match(reflexLua, /strategy_supported/)
  assert.match(reflexLua, /B\.STRATEGIES\[attacker\.prefab\]/)
  assert.match(reflexLua, /B\.StartDefense\(p,\s*attacker\)/)
  assert.match(reflexLua, /hp\s*>=\s*0\.25/)
  assert.match(reflexLua, /suppress_flee\s*=\s*true/)
})

test('HD-5: survival-priority.js 在野狗贴脸时识别为 P0 retreat 且标记 is_hound', () => {
  const snapshot = {
    actor: { valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0 },
    player: {
      health: { current: 100, max: 100, percent: 100 },
      hunger: { current: 80, max: 100, percent: 80 },
      sanity: { current: 100, max: 100, percent: 100 },
    },
    nearby: {
      buckets: {
        threats: [
          { prefab: 'hound', label: '猎犬', distance: 5 },
        ],
      },
    },
  }
  const level = survivalLevel(snapshot)
  assert.equal(level.level, 0)
  assert.equal(level.key, 'retreat')
  assert.equal(level.is_hound, true)
  assert.equal(level.blocking, true)
})

test('HD-6: plan.js 与 decision-arbiter 在野狗来袭时给出迎击与伴生召唤指引', () => {
  const snapshot = {
    character: { id: 'wendy', display_name: '温蒂' },
    actor: { prefab: 'wendy', valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0 },
    companion: { present: false, can_summon: true },
    player: {
      health: { current: 100, max: 100, percent: 100 },
      hunger: { current: 80, max: 100, percent: 80 },
      sanity: { current: 100, max: 100, percent: 100 },
    },
    nearby: {
      snapshot_id: 's456',
      buckets: {
        threats: [
          { prefab: 'hound', label: '猎犬', distance: 4, ref: '#1', handle: 'h1' },
        ],
      },
    },
  }
  const plan = derivePlan(snapshot)
  assert.equal(plan.goalId, 'retreat')
  assert.match(plan.title, /野狗来袭/)
  assert.match(plan.next, /summon_companion/)

  const decision = arbitrate(snapshot, { survivalPlan: plan })
  assert.equal(decision.priority, 'P0')
  assert.equal(decision.current_skill.id, 'survival_stabilize')
})

test('HD-7: survival_stabilize 技能包含 hound_defense 步骤', () => {
  const step = survivalStabilize.steps.find((s) => s.id === 'hound_defense')
  assert.ok(step, 'survivalStabilize 必须包含 hound_defense 步骤')

  const ctxWendy = {
    snapshot: {
      actor: { prefab: 'wendy' },
      character: { id: 'wendy' },
      companion: { present: false, can_summon: true },
      nearby: {
        snapshot_id: 's789',
        buckets: {
          threats: [{ prefab: 'hound', distance: 4, ref: '#1', handle: 'h1' }],
        },
      },
    },
  }
  assert.equal(step.isDone(ctxWendy), false)
  const actWendy = step.nextAction(ctxWendy)
  assert.equal(actWendy.tool, 'summon_companion')

  const ctxEngage = {
    snapshot: {
      actor: { prefab: 'wendy' },
      character: { id: 'wendy' },
      companion: { present: true },
      nearby: {
        snapshot_id: 's789',
        buckets: {
          threats: [{ prefab: 'hound', distance: 4, ref: '#1', handle: 'h1' }],
        },
      },
    },
  }
  const actEngage = step.nextAction(ctxEngage)
  assert.equal(actEngage.tool, 'fight_spider')
  assert.equal(actEngage.args.target_handle, 'h1')
})
