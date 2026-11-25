// R8.5：battle.lua **真实 Lua 测试**（通过 fengari 加载生产代码）
//
// 旧版本这里用一份 JS 手写的假状态机（B 对象）来"测战斗"，它既不加载 battle.lua、
// 也不跑真实状态迁移 —— 测试全绿却证明不了真机行为（任务书 §八 明确点名）。
// 现在全部改成加载真实 modules，直接驱动 Whale.actions / Whale.battle。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLuaEnv, scenario, attacker, tick } from './helpers/lua-harness.mjs'

// ── 策略表 / Boss 黑名单 ──
test('BATTLE-LUA-01：策略表覆盖蜘蛛/蜘蛛战士/猎犬/青蛙，Boss 一律禁止自动战斗', async () => {
  const env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wilson', ghostlybond: false }))
  env.run(`
    local B = Whale.battle
    local keys = {}
    for k in pairs(B.STRATEGIES) do keys[#keys + 1] = k end
    table.sort(keys)
    STRATS = table.concat(keys, ",")
    FROG_OK = tostring(B.STRATEGIES.frog ~= nil and B.STRATEGIES.frog.supported == true)
    FROG_DROPS = tostring(B.STRATEGIES.frog ~= nil and B.STRATEGIES.frog.drops_items == true)
    QUEEN = tostring(B.BOSS_PREFABS.spiderqueen == true)
    DEER = tostring(B.BOSS_PREFABS.deerclops == true)
    LOOT = tostring(B.STRATEGIES ~= nil)
  `)
  assert.equal(env.global('STRATS'), 'firehound,frog,hound,icehound,spider,spider_warrior')
  assert.equal(env.global('FROG_OK'), 'true', '青蛙必须进入受控防御策略表')
  assert.equal(env.global('FROG_DROPS'), 'true', '青蛙策略必须标记"会击落背包物品"')
  assert.equal(env.global('QUEEN'), 'true', '蜘蛛女王必须在 Boss 黑名单')
  assert.equal(env.global('DEER'), 'true', '巨鹿必须在 Boss 黑名单')
})

// ── 状态机：PREPARE→APPROACH→WAIT_ATTACK→ATTACK，击杀后 VERIFY→LOOT→FINISH ──
test('BATTLE-LUA-02：真实状态机推进并在目标死亡后正常结算', async () => {
  const env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wilson', ghostlybond: false }))
  env.run(`
    SPIDER = ${attacker('spider', 8, 0, { hp: 100 })}
    NEARBY = { SPIDER }
    Whale.actions.Start("fight_spider", {}, "defense", { target = SPIDER, is_defense = true })
  `)

  const seen = new Set()
  for (let i = 0; i < 8; i++) {
    env.run('NOW = NOW + 0.5; Whale.actions.Tick()')
    env.run('S = tostring(Whale.battle.GetState())')
    seen.add(env.global('S'))
  }
  assert.ok(seen.has('ATTACK'), `必须真实进入 ATTACK 阶段（实际：${[...seen].join(',')}）`)
  env.run(`
    ATTACK_N = 0
    for _, ba in ipairs(PUSHES) do
        if ba.action == GLOBAL.ACTIONS.ATTACK then ATTACK_N = ATTACK_N + 1 end
    end
  `)
  assert.ok(Number(env.global('ATTACK_N')) >= 1, '非伴生角色应真的挥砍（ACTIONS.ATTACK）')

  // 目标死亡 → 结算
  env.run(`
    SPIDER.components.health.currenthealth = 0
    for i = 1, 10 do
        NOW = NOW + 0.5
        Whale.actions.Tick()
        if Whale.job == nil then break end
    end
    JOB = Whale.job ~= nil and tostring(Whale.job.name) or "none"
    LAST = tostring(REPORTS[#REPORTS] ~= nil and REPORTS[#REPORTS].text or "")
    OK = tostring(REPORTS[#REPORTS] ~= nil and REPORTS[#REPORTS].ok or false)
  `)
  assert.equal(env.global('JOB'), 'none', '击杀后 job 必须结束')
  assert.match(env.global('LAST'), /打倒了/)
  assert.equal(env.global('OK'), 'true')
})

// ── 残血守卫 ──
test('BATTLE-LUA-03：自身血量 <25% 时立即中止战斗（不继续硬拼）', async () => {
  const env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wilson', hp: 20, ghostlybond: false }))
  env.run(`
    SPIDER = ${attacker('spider', 8, 0)}
    NEARBY = { SPIDER }
    Whale.actions.Start("fight_spider", {}, "defense", { target = SPIDER, is_defense = true })
    Whale.actions.Tick()
    LAST = tostring(REPORTS[#REPORTS] ~= nil and REPORTS[#REPORTS].text or "")
    JOB = Whale.job ~= nil and tostring(Whale.job.name) or "none"
  `)
  assert.equal(env.global('JOB'), 'none')
  assert.match(env.global('LAST'), /low_health/)
})

// ── 不支持的目标 / Boss ──
test('BATTLE-LUA-04：不支持的目标与 Boss 都不会被自动交战', async () => {
  const env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wilson', ghostlybond: false }))
  env.run(`
    BEEF = newent("beefalo", 8, 0, { "animal" }, {
        health = { currenthealth = 200, maxhealth = 200, IsDead = function() return false end },
    })
    NEARBY = { BEEF }
    Whale.actions.Start("fight_spider", {}, "defense", { target = BEEF, is_defense = true })
    Whale.actions.Tick()
    R1 = tostring(REPORTS[#REPORTS] ~= nil and REPORTS[#REPORTS].text or "")
  `)
  assert.match(env.global('R1'), /unsupported_enemy/)

  env.run(`
    QUEEN = newent("spiderqueen", 8, 0, { "monster" }, {
        health = { currenthealth = 1000, maxhealth = 1000, IsDead = function() return false end },
    })
    NEARBY = { QUEEN }
    Whale.actions.Start("fight_spider", {}, "defense", { target = QUEEN, is_defense = true })
    Whale.actions.Tick()
    R2 = tostring(REPORTS[#REPORTS] ~= nil and REPORTS[#REPORTS].text or "")
  `)
  assert.match(env.global('R2'), /boss_forbidden/)
})

// ── StartDefense 三种返回 ──
test('BATTLE-LUA-05：StartDefense 对 无花温蒂 / 有花温蒂 / 通用角色 给出正确状态', async () => {
  // 无花温蒂：rejected（必须回退撤退）
  let env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: [] }))
  env.run(`
    SPIDER = ${attacker('spider', 8, 0)}
    NEARBY = { SPIDER }
    S1 = Whale.battle.StartDefense(PLAYER, SPIDER)
  `)
  assert.equal(env.global('S1'), 'rejected')

  // 有花温蒂：summoning（走既有 summon_companion job）
  env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: ['abigail_flower'] }))
  env.run(`
    SPIDER = ${attacker('spider', 8, 0)}
    NEARBY = { SPIDER }
    S2 = Whale.battle.StartDefense(PLAYER, SPIDER)
    J2 = Whale.job ~= nil and (Whale.job.name .. "/" .. tostring(Whale.job.cmd_id)) or "none"
  `)
  assert.equal(env.global('S2'), 'summoning')
  assert.equal(env.global('J2'), 'summon_companion/defense')

  // 通用角色：engaged
  env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wilson', ghostlybond: false }))
  env.run(`
    SPIDER = ${attacker('spider', 8, 0)}
    NEARBY = { SPIDER }
    S3 = Whale.battle.StartDefense(PLAYER, SPIDER)
    J3 = Whale.job ~= nil and Whale.job.name or "none"
  `)
  assert.equal(env.global('S3'), 'engaged')
  assert.equal(env.global('J3'), 'fight_spider')
})

// ── 群体容忍：只按"真的在打温蒂"的数量，且有硬上限 ──
test('BATTLE-LUA-06：群体容忍按真实攻击者数量判定（伴生健康 ≤3，伴生虚弱拒绝）', async () => {
  const env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: ['abigail_flower'], summoned: true, withGhost: true }))
  env.run(`
    NEARBY = { ${attacker('frog', 6, 0)}, ${attacker('frog', 9, 2)} }
    OK2, WHY2 = Whale.battle.CanTolerateGroup(PLAYER, 2)
    NEARBY = { ${attacker('frog', 6, 0)}, ${attacker('frog', 9, 2)},
               ${attacker('frog', 10, -3)}, ${attacker('frog', 11, 1)} }
    OK4, WHY4 = Whale.battle.CanTolerateGroup(PLAYER, 4)
    ABIGAIL.components.health.currenthealth = 20
    OK_WEAK, WHY_WEAK = Whale.battle.CanTolerateGroup(PLAYER, 2)
    T2 = tostring(OK2) .. "/" .. tostring(WHY2)
    T4 = tostring(OK4) .. "/" .. tostring(WHY4)
    TW = tostring(OK_WEAK) .. "/" .. tostring(WHY_WEAK)
  `)
  assert.equal(env.global('T2'), 'true/companion_supported')
  assert.equal(env.global('T4'), 'false/too_many_attackers', '超过 3 只必须强制撤退')
  assert.equal(env.global('TW'), 'false/companion_low_health')
})

// ── ShouldSuppressReflex ──
test('BATTLE-LUA-07：没有受控战斗时不抑制 Reflex；受控单怪交战时才抑制', async () => {
  const env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: ['abigail_flower'], summoned: true, withGhost: true }))
  env.run(`
    SPIDER = ${attacker('spider', 8, 0)}
    NEARBY = { SPIDER }
    A1 = tostring(Whale.battle.ShouldSuppressReflex(PLAYER, SPIDER))
    local st = Whale.battle.StartDefense(PLAYER, SPIDER)
    Whale.actions.Tick()
    A2 = tostring(Whale.battle.ShouldSuppressReflex(PLAYER, SPIDER))
    OWNER = tostring(Whale.battle.DefenseStatus() ~= nil)
    START = tostring(st)
  `)
  assert.equal(env.global('A1'), 'false', '没有开战就抑制 Reflex = 让角色站桩挨打')
  assert.equal(env.global('A2'), 'true', '受控交战时应抑制普通逃跑')
  assert.equal(env.global('OWNER'), 'true', '防御会话状态必须可见（可观测性）')
  assert.equal(env.global('START'), 'engaged', '伴生可协助时应直接进入防御')
})
