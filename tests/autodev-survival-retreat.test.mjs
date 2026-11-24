// 回归测试：危险区「0 动作死锁」修复。
// 背景（真机实测）：角色只是"处于已知危险区"（最近威胁在 6+ 格外、并无贴脸攻击）时，
// 旧逻辑在 task-skill-orchestrator 里只要 survival.key==='retreat' 就 return reflex_active（0 动作），
// 而 Lua Reflex 只对贴脸攻击反应 → 角色永远不动、等死。
// 修复：只有 attack(attacker) 或 reflex 真 active 才让位；单纯 zone 由 survival_stabilize 的
// leave_zone 步骤主动 move_to 撤离。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { survivalLevel, dangerZoneEscapeTarget, inDangerZone } from '../lib/planner/survival-priority.js'
import { survivalStabilize } from '../lib/skills/survival-stabilize.js'
import { TaskSkillOrchestrator } from '../lib/planner/task-skill-orchestrator.js'

function makeSnap(over = {}) {
  const base = {
    actor: { valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0, prefab: 'wendy' },
    player: {
      health: { current: 150, max: 150, percent: 100 },
      hunger: { current: 150, max: 150, percent: 100 },
      sanity: { current: 200, max: 200, percent: 100 },
      inventory: { items: [] },
      equipment: { slots: {} },
      in_light: true,
    },
    world: { phase: 'day' },
    nearby: { buckets: { threats: [], harvestables: [], resources: [], pickupables: [] } },
    dangerZones: [],
  }
  return { ...base, ...over }
}

test('SURV-RETREAT-1：处于危险区 → survivalLevel 标记 zone:true（retreat）', () => {
  const s = makeSnap({ dangerZones: [{ x: 0, z: 0, radius: 12, source: 'spiderden' }] })
  assert.equal(inDangerZone(s), true)
  const lv = survivalLevel(s)
  assert.equal(lv.key, 'retreat')
  assert.equal(lv.zone, true)
  assert.equal(lv.blocking, true)
})

test('SURV-RETREAT-2：dangerZoneEscapeTarget 给出半径外、远离圆心的目标', () => {
  const s = makeSnap({ actor: { ...makeSnap().actor, tileX: 3, tileZ: 0 }, dangerZones: [{ x: 0, z: 0, radius: 12 }] })
  const t = dangerZoneEscapeTarget(s, 8)
  assert.ok(t && typeof t.x === 'number')
  assert.ok(Math.hypot(t.x - 0, t.z - 0) >= 12, `目标应在半径外，实际 ${JSON.stringify(t)}`)
  assert.ok(t.x > 3, '应朝背离圆心方向（+x）')
})

test('SURV-RETREAT-3：危险区时 preconditions 允许自救（不再交给 Reflex）；贴脸攻击才拒绝', () => {
  const zone = makeSnap({ dangerZones: [{ x: 0, z: 0, radius: 12 }] })
  assert.equal(survivalStabilize.preconditions({ snapshot: zone }).ok, true)

  const attacker = makeSnap({
    actor: { ...makeSnap().actor, tileX: 0, tileZ: 0 },
    player: { ...makeSnap().player, health: { current: 40, max: 150, percent: 27 } },
    nearby: { buckets: { threats: [{ prefab: 'spider', label: '蜘蛛', distance: 2 }], harvestables: [], resources: [], pickupables: [] } },
  })
  const pre = survivalStabilize.preconditions({ snapshot: attacker })
  assert.equal(pre.ok, false)
  assert.match(pre.reason, /Reflex/)
})

test('SURV-RETREAT-4：survival_stabilize 首步为 leave_zone，危险区时产出 move_to 撤离', () => {
  assert.equal(survivalStabilize.steps[0].id, 'leave_zone')
  const inZone = makeSnap({ dangerZones: [{ x: 0, z: 0, radius: 12 }] })
  assert.equal(survivalStabilize.steps[0].isDone({ snapshot: inZone }), false)
  const act = survivalStabilize.steps[0].nextAction({ snapshot: inZone })
  assert.equal(act.tool, 'move_to')
  assert.ok(Math.hypot(act.args.x, act.args.z) >= 12)
  // 出了危险区这一步就完成
  const outZone = makeSnap({ dangerZones: [{ x: 0, z: 0, radius: 12 }], actor: { ...makeSnap().actor, tileX: 40, tileZ: 0 } })
  assert.equal(survivalStabilize.steps[0].isDone({ snapshot: outZone }), true)
})

test('SURV-RETREAT-5：orchestrator 在“仅危险区”时不再返回 reflex_active，而是执行 survival_stabilize', async () => {
  const zoneSnap = makeSnap({ dangerZones: [{ x: 0, z: 0, radius: 12 }] })
  const ran = []
  const fakeExecutor = {
    activeInstance: () => null,
    pause: () => {},
    run: async (skillId) => {
      ran.push(skillId)
      return { status: 'in_progress', action: { tool: 'move_to', args: { x: 20, z: 0 } }, step: 'leave_zone', instance_id: 'i1' }
    },
  }
  const orch = new TaskSkillOrchestrator({ memory: {}, readSnapshot: () => zoneSnap, dispatch: async () => ({}), executor: fakeExecutor })
  const res = await orch.tickOnce({})
  assert.notEqual(res.status, 'reflex_active', '仅危险区不应再空转等 Reflex')
  assert.equal(ran[0], 'survival_stabilize', '应主动跑自救技能')
  assert.equal(res.status, 'survival_in_progress')
  assert.equal(res.action.tool, 'move_to')
})

test('SURV-RETREAT-6：真被贴脸攻击 + 低血 → 仍让位 Lua Reflex（reflex_active）', async () => {
  const attackerSnap = makeSnap({
    player: { ...makeSnap().player, health: { current: 40, max: 150, percent: 27 } },
    nearby: { buckets: { threats: [{ prefab: 'spider', label: '蜘蛛', distance: 2 }], harvestables: [], resources: [], pickupables: [] } },
  })
  const orch = new TaskSkillOrchestrator({
    memory: {}, readSnapshot: () => attackerSnap, dispatch: async () => ({}),
    executor: { activeInstance: () => null, pause: () => {}, run: async () => ({ status: 'in_progress' }) },
  })
  const res = await orch.tickOnce({})
  assert.equal(res.status, 'reflex_active')
  assert.equal(res.reflex_active, true)
})
