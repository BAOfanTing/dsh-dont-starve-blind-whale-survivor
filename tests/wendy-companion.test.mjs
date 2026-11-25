import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTION_SPECS, OPEN_ACTIONS, validateArgs } from '../lib/dispatcher.js'
import { TOOLS } from '../lib/tools.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

test('WC-1: summon_companion 在工具表与 dispatcher 白名单中对齐', () => {
  assert.ok(OPEN_ACTIONS.includes('summon_companion'), 'OPEN_ACTIONS 必须包含 summon_companion')
  const tool = TOOLS.find((t) => t.name === 'summon_companion')
  assert.ok(tool, 'TOOLS 必须包含 summon_companion 工具')
  assert.equal(tool.name, 'summon_companion')
})

test('WC-2: summon_companion 规格与参数校验', () => {
  const spec = ACTION_SPECS.summon_companion
  assert.ok(spec, 'ACTION_SPECS 必须包含 summon_companion')
  assert.equal(spec.riskLevel, 'R1')
  assert.equal(spec.category, 'combat')
  assert.equal(spec.requiresSnapshot, false)
  const val = validateArgs(spec, {})
  assert.equal(val.ok, true, '空参数校验必须通过')
  const valBad = validateArgs(spec, { extra: 'bad' })
  assert.equal(valBad.ok, false, '多余参数必须被拒')
})

test('WC-3: summon_companion verify 核验伴生生物成功出现', () => {
  const spec = ACTION_SPECS.summon_companion
  const before = {
    companion: { present: false, alive: false },
  }
  const afterSuccess = {
    companion: { present: true, alive: true },
  }
  const v1 = spec.verify(before, afterSuccess)
  assert.equal(v1.ok, true)
  assert.equal(v1.how, 'companion_summoned')

  const afterFail = {
    companion: { present: false, alive: false },
  }
  const v2 = spec.verify(before, afterFail)
  assert.equal(v2.ok, false)
  assert.equal(v2.reason, 'companion_not_summoned')
})

test('WC-4: guard_specs.lua 包含 summon_companion 规则', () => {
  const guardSpecsLua = readFileSync(join(MOD, 'scripts', 'whale', 'guard_specs.lua'), 'utf8')
  assert.match(guardSpecsLua, /summon_companion\s*=\s*\{/)
  assert.match(guardSpecsLua, /risk\s*=\s*"R1"/)
})

test('WC-5: guard.lua 对 summon_companion 进行前置条件校验（花朵/角色契约/未召唤）', () => {
  const guardLua = readFileSync(join(MOD, 'scripts', 'whale', 'guard.lua'), 'utf8')
  assert.match(guardLua, /action\s*==\s*"summon_companion"/)
  assert.match(guardLua, /ghostlybond/)
  assert.match(guardLua, /already_summoned/)
  assert.match(guardLua, /flower_not_in_inventory/)
})

test('WC-6: companion.lua 正确识别未召唤状态与花朵持有', () => {
  const companionLua = readFileSync(join(MOD, 'scripts', 'whale', 'character', 'companion.lua'), 'utf8')
  assert.match(companionLua, /st\.has_flower\s*=/)
  assert.match(companionLua, /st\.can_summon\s*=/)
  assert.match(companionLua, /abigail_flower/)
})

test('WC-7: profiles/wendy.lua 包含主动召唤判定 ShouldSummonCompanion', () => {
  const wendyLua = readFileSync(join(MOD, 'scripts', 'whale', 'character', 'profiles', 'wendy.lua'), 'utf8')
  assert.match(wendyLua, /function w\.ShouldSummonCompanion/)
  assert.match(wendyLua, /st\.can_summon\s*==\s*true/)
  assert.match(wendyLua, /should_summon/)
})

// ── R8.5：真实 Lua 行为（不再只是源码字符串断言） ──
test('WC-8: 真实 Lua —— 协助距离以 ABIGAIL_DEFENSIVE_MAX_FOLLOW 为准（近=true/远=false）', async () => {
  const { createLuaEnv, scenario } = await import('./helpers/lua-harness.mjs')
  const env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', summoned: true, withGhost: true, ghostX: 8 }))
  env.run('NEAR = tostring(Whale.character.GetCompanionState(PLAYER).can_assist)')
  assert.equal(env.global('NEAR'), 'true', '2 世界单位（半格）内必须可协助')

  env.run(`
    ABIGAIL.Transform.GetWorldPosition = function() return 400, 0, 0 end
    FAR = tostring(Whale.character.GetCompanionState(PLAYER).can_assist)
    RANGE = tostring(Whale.character.ABIGAIL_ASSIST_MAX_DIST)
  `)
  assert.equal(env.global('FAR'), 'false', '远到 100 格时绝不能报可协助')
  assert.equal(env.global('RANGE'), '10', '协助半径 = ABIGAIL_DEFENSIVE_MAX_FOLLOW(5) × 2 = 10 世界单位')
})

test('WC-9: 真实 Lua —— FindDroppedFlower 只认"没人拿、不在 limbo"的地面花', async () => {
  const { createLuaEnv, scenario } = await import('./helpers/lua-harness.mjs')
  const env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: [] }))
  env.run(`
    GROUND = newent("abigail_flower", 8, 0, { "abigail_flower" },
        { inventoryitem = { owner = nil, canbepickedup = true } })
    HELD = newent("abigail_flower", 4, 0, { "abigail_flower" },
        { inventoryitem = { owner = PLAYER, canbepickedup = true } })
    LIMBO = newent("abigail_flower", 2, 0, { "abigail_flower" },
        { inventoryitem = { owner = nil, canbepickedup = true } })
    LIMBO._tags.INLIMBO = true
    NEARBY = { HELD, LIMBO, GROUND }
    local found = Whale.character.FindDroppedFlower(PLAYER, 16)
    FOUND_OK = tostring(found == GROUND)
    NONE = "x"
  `)
  assert.equal(env.global('FOUND_OK'), 'true', '必须跳过被别人持有的、以及处于 limbo 的花')
})

test('WC-10: guard.lua 保护阿比盖尔之花，禁止 AI 主动丢弃/当燃料', () => {
  const guardLua = readFileSync(join(MOD, 'scripts', 'whale', 'guard.lua'), 'utf8')
  assert.match(guardLua, /critical_item_protected/)
  assert.match(guardLua, /action == "drop" or action == "fuel" or action == "add_fuel"/)
  assert.match(guardLua, /want == "abigail_flower"/)
})
