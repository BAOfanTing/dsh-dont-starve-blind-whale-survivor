// Phase 6 性能测量：决策链路单次/1000 次耗时
import { assessThreat } from '../mcp-server/dist/src/survival/threat.js'
import { assessReadiness, decideCombat } from '../mcp-server/dist/src/survival/combat.js'
import { planEscape } from '../mcp-server/dist/src/survival/escape.js'
import { assessSeason } from '../mcp-server/dist/src/survival/season.js'
import { assessBossReadiness } from '../mcp-server/dist/src/survival/boss.js'
import { arbitrate } from '../mcp-server/dist/src/survival/decision.js'
import { buildContext } from '../mcp-server/dist/src/survival/context.js'

const snapshot = {
  player: {
    valid: true, prefab: 'wilson',
    position: { x: 40, y: 0, z: 40, tile_x: 10, tile_z: 10 },
    health: { current: 120, max: 150, percent: 80, dead: false },
    hunger: { current: 100, max: 150, percent: 66 },
    sanity: { current: 150, max: 200, percent: 75 },
    temperature: { current: 18 }, moisture: { percent: 5 }, is_ghost: false,
  },
  inventory: {
    slots: 15, used: 8,
    items: [
      { prefab: 'spear', count: 1, slot: 1 }, { prefab: 'log', count: 9, slot: 2 },
      { prefab: 'cutgrass', count: 7, slot: 3 }, { prefab: 'healingsalve', count: 2, slot: 4 },
      { prefab: 'cookedmeat', count: 3, slot: 5 }, { prefab: 'winter_hat', count: 1, slot: 6 },
      { prefab: 'heatrock', count: 1, slot: 7 }, { prefab: 'torch', count: 1, slot: 8 },
    ],
    equipment: { hands: { prefab: 'spear', uses_left: 100 }, body: { prefab: 'armorwood', armor: 88 }, head: { prefab: 'footballhelmet', armor: 80 } },
  },
  world: {
    season: 'autumn', day: 12, elapsed_days_in_season: 8, remaining_days_in_season: 12,
    is_day: true, is_night: false, temperature: 18, weather: { is_raining: false, wetness: 0 },
  },
  threats: {
    radius_tiles: 16, hostile_count: 6, chasing_count: 2, attacking_count: 1, boss_count: 0, scanned_at_tick: 200,
    threats: Array.from({ length: 6 }, (_, index) => ({
      prefab: index % 2 === 0 ? 'hound' : 'spider', name: '猎犬', distance: 3 + index,
      tile_x: 10 + index, tile_z: 10 + index, hp: 80, is_boss: false,
      targeting_player: index < 2, attacking: index === 0, attack_range: 2, attack_period: 2, attack_damage: 20, sleeping: false,
    })),
  },
  environment: { light_sources_within_8: 2, in_light: true, nearby_fires: [] },
  nearby: { radius_tiles: 16, scanned: 40, returned: 20, truncated: false, entities: [] },
}

function time(label, fn, iterations = 1000) {
  for (let index = 0; index < 100; index += 1) fn() // warmup
  const started = process.hrtime.bigint()
  for (let index = 0; index < iterations; index += 1) fn()
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  const perCallUs = (elapsedMs / iterations) * 1000
  console.log(`${label.padEnd(34)} ${iterations} 次 ${elapsedMs.toFixed(1)}ms → 单次 ${perCallUs.toFixed(1)}µs`)
  return perCallUs
}

const ctx = buildContext(snapshot)
time('buildContext（快照→上下文）', () => buildContext(snapshot))
time('assessThreat（威胁评分）', () => assessThreat(ctx))
time('assessReadiness（准备度）', () => assessReadiness(ctx))
time('decideCombat（四选一决策）', () => {
  const threat = assessThreat(ctx)
  decideCombat({ ctx, threat, readiness: assessReadiness(ctx) })
})
time('planEscape（规避选项）', () => planEscape(ctx))
time('assessSeason（季节准备）', () => assessSeason(ctx))
time('assessBossReadiness（Boss）', () => assessBossReadiness(ctx))
time('arbitrate（全局仲裁）', () => {
  arbitrate({ ctx, threat: assessThreat(ctx), readiness: assessReadiness(ctx), escape: planEscape(ctx), season: assessSeason(ctx) })
}, 500)

// 一次"完整一轮"（AI 每一步都会跑的那套）
const full = time('完整一轮（威胁+准备+规避+季节+仲裁）', () => {
  const threat = assessThreat(ctx)
  const readiness = assessReadiness(ctx)
  const escape = planEscape(ctx)
  const season = assessSeason(ctx)
  arbitrate({ ctx, threat, readiness, escape, season })
}, 500)
console.log(`\n结论：一轮完整决策约 ${(full / 1000).toFixed(2)} ms（Node 侧，不含 Bridge 往返与模型推理）`)
