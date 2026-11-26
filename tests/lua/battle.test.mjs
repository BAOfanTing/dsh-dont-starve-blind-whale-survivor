// R8.5：battle.lua **真实 Lua 测试**（通过 fengari 加载生产代码）
//
// 旧版本这里用一份 JS 手写的假状态机（B 对象）来"测战斗"，它既不加载 battle.lua、
// 也不跑真实状态迁移 —— 测试全绿却证明不了真机行为（任务书 §八 明确点名）。
// 现在全部改成加载真实 modules，直接驱动 Whale.actions / Whale.battle。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLuaEnv, scenario, attacker, tick } from '../helpers/lua-harness.mjs'

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

// ── R8.5 真机发现：战斗会话必须能自己收尾，不能永久悬挂 ──
test('BATTLE-LUA-08：单场战斗超过硬上限会自己收尾（battle_timeout）', async () => {
  const env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wilson', ghostlybond: false }))
  env.run(`
    SPIDER = ${attacker('spider', 8, 0, { hp: 5000 })}
    NEARBY = { SPIDER }
    Whale.actions.Start("fight_spider", {}, "defense", { target = SPIDER, is_defense = true, budget_s = 600 })
    Whale.actions.Tick()
    NOW = NOW + 50          -- 超过 MAX_SESSION_S(45)
    Whale.actions.Tick()
    JOB = Whale.job ~= nil and tostring(Whale.job.name) or "none"
    SESSION = tostring(Whale.battle.GetSession() ~= nil)
    LAST = tostring(REPORTS[#REPORTS] ~= nil and REPORTS[#REPORTS].text or "")
  `)
  assert.equal(env.global('JOB'), 'none', '超时后 job 必须结束')
  assert.equal(env.global('SESSION'), 'false', '战斗会话必须一起清理，不能永久悬挂')
  assert.match(env.global('LAST'), /battle_timeout/)
})

test('BATTLE-LUA-09：伴生主战连续无伤害会中止（companion_stalled，阿比盖尔跑出防御范围）', async () => {
  const env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: ['abigail_flower'], summoned: true, withGhost: true }))
  env.run(`
    SPIDER = ${attacker('spider', 8, 0, { hp: 5000 })}
    NEARBY = { SPIDER }
    Whale.battle.StartDefense(PLAYER, SPIDER)
    -- 推进到伴生主战（ATTACK）
    for i = 1, 4 do NOW = NOW + 0.2; Whale.actions.Tick() end
    LED = tostring(Whale.battle.GetSession() ~= nil and Whale.battle.GetSession().companion_led or false)
    -- 连续 10 秒没有任何伤害
    NOW = NOW + 10
    Whale.actions.Tick()
    JOB = Whale.job ~= nil and tostring(Whale.job.name) or "none"
    SESSION = tostring(Whale.battle.GetSession() ~= nil)
    LAST = tostring(REPORTS[#REPORTS] ~= nil and REPORTS[#REPORTS].text or "")
  `)
  assert.equal(env.global('LED'), 'true', '应已进入伴生主战')
  assert.equal(env.global('JOB'), 'none')
  assert.equal(env.global('SESSION'), 'false')
  assert.match(env.global('LAST'), /companion_stalled/)
})

test('BATTLE-LUA-10：A.Tick 预算判失败时会显式收尾战斗会话（budget_exceeded）', async () => {
  const env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wilson', ghostlybond: false }))
  env.run(`
    SPIDER = ${attacker('spider', 8, 0, { hp: 5000 })}
    NEARBY = { SPIDER }
    Whale.actions.Start("fight_spider", {}, "defense", { target = SPIDER, is_defense = true, budget_s = 1 })
    Whale.actions.Tick()
    NOW = NOW + 3
    Whale.actions.Tick()
    JOB = Whale.job ~= nil and tostring(Whale.job.name) or "none"
    SESSION = tostring(Whale.battle.GetSession() ~= nil)
    LAST = tostring(REPORTS[#REPORTS] ~= nil and REPORTS[#REPORTS].text or "")
  `)
  assert.equal(env.global('JOB'), 'none')
  assert.equal(env.global('SESSION'), 'false', '预算失败也必须把战斗会话收尾，否则 InCombat() 永久为真')
  assert.match(env.global('LAST'), /budget_exceeded/)
})

// ── R8.5 真机 bug：Cleanup 的作用域（必须清掉真正的 local defense） ──
test('BATTLE-LUA-11：Cleanup 能清掉 DefenseStatus（防 local/global 作用域回归）', async () => {
  const env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: ['abigail_flower'], summoned: true, withGhost: true }))
  env.run(`
    SPIDER = ${attacker('spider', 8, 0)}
    NEARBY = { SPIDER }
    ST = tostring(Whale.battle.StartDefense(PLAYER, SPIDER))
    BEFORE = tostring(Whale.battle.DefenseStatus() ~= nil)
    Whale.battle.Cleanup()
    AFTER = tostring(Whale.battle.DefenseStatus() ~= nil)
  `)
  assert.equal(env.global('ST'), 'engaged')
  assert.equal(env.global('BEFORE'), 'true', '开战后防御状态必须可见')
  assert.equal(env.global('AFTER'), 'false',
    'Cleanup 必须清掉真正的防御会话（历史 bug：Cleanup 引用的是全局 defense，永远清不掉）')
})

test('BATTLE-LUA-12：防御 job 消失后 DefenseStatus 自愈为 nil；停手中止后有冷却', async () => {
  const env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: ['abigail_flower'], summoned: true, withGhost: true }))
  env.run(`
    SPIDER = ${attacker('spider', 8, 0, { hp: 5000 })}
    NEARBY = { SPIDER }
    -- ① 自愈：job 被外部清掉（模拟预算/被抢）后，DefenseStatus 必须返回 nil
    Whale.battle.StartDefense(PLAYER, SPIDER)
    Whale.job = nil
    HEAL1 = tostring(Whale.battle.DefenseStatus() ~= nil)
  `)
  assert.equal(env.global('HEAL1'), 'false', '没有 job 时防御状态必须自愈，否则 Reflex 永远不敢逃跑')

  env.run(`
    -- ② 停手守卫触发后要有冷却，不能立刻又开一场
    Whale.battle.StartDefense(PLAYER, SPIDER)
    for i = 1, 4 do NOW = NOW + 0.2; Whale.actions.Tick() end
    NOW = NOW + 10
    Whale.actions.Tick()          -- companion_stalled
    STALLED = tostring(Whale.job == nil)
    retry = Whale.battle.StartDefense(PLAYER, SPIDER)
    RETRY = tostring(retry)
  `)
  assert.equal(env.global('STALLED'), 'true', '停手后 job 必须结束')
  assert.equal(env.global('RETRY'), 'rejected', '停手中止后必须进入冷却，不能立刻重开')
})

// ── R8.5.6：温蒂"拿长矛也打" ──
test('BATTLE-LUA-13：有武器时温蒂参与输出；没武器时仍只站位不近战', async () => {
  // ① 有长矛 → companion_led 仍为真，同时 wendy_melee=true 并真的发出玩家 ATTACK
  let env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: ['abigail_flower'], summoned: true, withGhost: true }))
  env.run(`
    SPEAR = mkitem("spear", 1, { weapon = { damage = 34 } })
    PLAYER.components.inventory:Equip(SPEAR)
    SPIDER = ${attacker('spider', 6, 0, { hp: 500 })}
    NEARBY = { SPIDER }
    Whale.battle.StartDefense(PLAYER, SPIDER)
    for i = 1, 8 do NOW = NOW + 0.3; Whale.actions.Tick() end
    local s = Whale.battle.GetSession()
    LED = tostring(s ~= nil and s.companion_led or false)
    MELEE = tostring(s ~= nil and s.wendy_melee or false)
    PLAYER_ATTACKS = 0
    for _, ba in ipairs(PUSHES) do
        if ba.action == GLOBAL.ACTIONS.ATTACK and ba.doer == PLAYER then PLAYER_ATTACKS = PLAYER_ATTACKS + 1 end
    end
  `)
  assert.equal(env.global('LED'), 'true', '伴生主战仍然成立')
  assert.equal(env.global('MELEE'), 'true', '有长矛时温蒂应允许参与输出')
  assert.ok(Number(env.global('PLAYER_ATTACKS')) >= 1, '温蒂必须真的用长矛发出 ATTACK')

  // ② 没有武器（空手/火把）→ 仍然只站位，不近战
  env = createLuaEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: ['abigail_flower'], summoned: true, withGhost: true }))
  env.run(`
    SPIDER2 = ${attacker('spider', 6, 0, { hp: 500 })}
    NEARBY = { SPIDER2 }
    Whale.battle.StartDefense(PLAYER, SPIDER2)
    for i = 1, 8 do NOW = NOW + 0.3; Whale.actions.Tick() end
    local s2 = Whale.battle.GetSession()
    MELEE2 = tostring(s2 ~= nil and s2.wendy_melee or false)
    ATK2 = 0
    for _, ba in ipairs(PUSHES) do
        if ba.action == GLOBAL.ACTIONS.ATTACK and ba.doer == PLAYER then ATK2 = ATK2 + 1 end
    end
  `)
  assert.equal(env.global('MELEE2'), 'false', '没有武器时不能贴脸近战')
  assert.equal(env.global('ATK2'), '0', '没有武器时温蒂不得发出 ATTACK')
})
