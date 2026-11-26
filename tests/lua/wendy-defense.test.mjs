// R8.5：温蒂伴生战斗闭环 —— **真实 Lua 集成测试**（fengari 加载生产代码，不做 JS 模拟状态机）
//
// 覆盖任务书 §八 的 TEST-01 ~ TEST-10：
//   TEST-01 有花 + 普通蜘蛛攻击 → 召唤交出 → 伴生防御 → 温蒂不近战
//   TEST-02 有花 + 蜘蛛战士 → 召唤 → 保守策略（不误判普通蜘蛛）→ 低血撤退
//   TEST-03 有花 + 单只青蛙 → 召唤 → 伴生主战 → 青蛙死亡
//   TEST-04 有花 + 三只青蛙 → 按"真实攻击者"计数、伴生健康时允许受控群战；伴生低血立即撤退
//   TEST-05 无花 + 青蛙 → 不假装召唤 → 原有安全撤退
//   TEST-06 召唤失败/超时 → 明确失败、不重复 CASTSUMMON、允许安全恢复
//   TEST-07 Reflex flee → Defense 受控交接（旧 job 清理、无并发 BufferedAction）
//   TEST-08 青蛙击落阿比盖尔之花 → 状态识别 + 既有 pickup 通道回收
//   TEST-09 阿比盖尔死亡/过远 → can_assist=false、不再抑制 Reflex、不再假装伴生战斗
//   TEST-10 其他角色（威尔逊）回归：不受温蒂专用策略影响
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLuaEnv, scenario, attacker, tick } from '../helpers/lua-harness.mjs'

const loadEnv = createLuaEnv

// ═══════════════════ TEST-01：普通蜘蛛 ═══════════════════
test('TEST-01：温蒂有花遭普通蜘蛛攻击 → 召唤交接 → 伴生主战、本体不近战', async () => {
  const env = loadEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: ['abigail_flower'] }))
  env.run(`
    local spider = ${attacker('spider', 8, 0, { hp: 100 })}
    NEARBY = { spider }
  `, '放一只普通蜘蛛（2 格）')

  // 第一次 reflex：应该启动 summon_companion（cmd_id=defense），而不是 flee
  env.run(tick(5), '跑 5 tick')
  env.run(`JOB1 = Whale.job ~= nil and (Whale.job.name .. "/" .. tostring(Whale.job.cmd_id)) or "none"`)
  assert.equal(env.global('JOB1'), 'summon_companion/defense',
    '应通过既有 summon_companion job 交接，而不是 flee 或直推 CASTSUMMON')

  // 推进：CASTSUMMON 被推下去 → 假游戏里阿比盖尔出现 → job done
  env.run(tick(10), '推进召唤')
  env.run(`
    SUMMONED = tostring(PLAYER.components.ghostlybond.summoned)
    CAST_N = 0
    for _, ba in ipairs(PUSHES) do
        if ba.action == GLOBAL.ACTIONS.CASTSUMMON then CAST_N = CAST_N + 1 end
    end
  `)
  assert.equal(env.global('SUMMONED'), 'true', '阿比盖尔必须真的出现（ghostlybond.summoned）')
  assert.equal(env.global('CAST_N'), '1', '只允许一次 CASTSUMMON（不重复召唤）')

  // 下一次 reflex：应进入 fight_spider 伴生防御
  env.run(tick(5), '进入防御')
  env.run(`
    JOB2 = Whale.job ~= nil and (Whale.job.name .. "/" .. tostring(Whale.job.cmd_id)) or "none"
    LED = tostring(Whale.battle.GetSession() ~= nil and Whale.battle.GetSession().companion_led or false)
  `)
  assert.equal(env.global('JOB2'), 'fight_spider/defense', '应启动受控防御战斗')
  assert.equal(env.global('LED'), 'true', '温蒂应切到"伴生主战"模式')

  // 模拟阿比盖尔输出：目标掉血 → 最终死亡
  env.run(`
    local s = Whale.battle.GetSession()
    local spider = s ~= nil and s.target or nil
    for i = 1, 40 do
        if spider ~= nil then
            spider.components.health.currenthealth = math.max(0, (spider.components.health.currenthealth or 0) - 10)
            if spider.components.combat ~= nil then spider.components.combat.target = ABIGAIL end
        end
        NOW = NOW + 0.5
        Whale.actions.Tick()
        if Whale.job == nil then break end
    end
  `, '让阿比盖尔把蜘蛛打死')

  env.run(`
    ATTACK_N = 0
    for _, ba in ipairs(PUSHES) do
        if ba.action == GLOBAL.ACTIONS.ATTACK then ATTACK_N = ATTACK_N + 1 end
    end
    FIN = REPORTS[#REPORTS] ~= nil and tostring(REPORTS[#REPORTS].text) or ""
  `)
  assert.equal(env.global('ATTACK_N'), '0',
    '温蒂在伴生主战时绝不能自己调用 ACTIONS.ATTACK（avoid_melee 必须真正落地）')
  assert.match(env.global('FIN'), /阿比盖尔打倒/, '结算必须如实说明是阿比盖尔打死的')
})

// ═══════════════════ TEST-02：蜘蛛战士 ═══════════════════
test('TEST-02：温蒂有花被蜘蛛战士攻击 → 先召唤、用保守策略、低血正常撤退', async () => {
  const env = loadEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: ['abigail_flower'] }))
  env.run(`
    local warrior = ${attacker('spider_warrior', 8, 0, { hp: 200, tags: '{"hostile","monster","spider"}' })}
    NEARBY = { warrior }
  `, '放一只蜘蛛战士')

  env.run(tick(5), '第一次 reflex')
  env.run(`JOB1 = Whale.job ~= nil and Whale.job.name or "none"`)
  assert.equal(env.global('JOB1'), 'summon_companion', '仍应先召唤')

  env.run(tick(10), '完成召唤')
  env.run(tick(5), '进入防御')
  env.run(`
    JOB2 = Whale.job ~= nil and Whale.job.name or "none"
    SNAME = "none"
    local s = Whale.battle.GetSession()
    if s ~= nil and s.strategy ~= nil then SNAME = s.strategy.name end
  `)
  assert.equal(env.global('JOB2'), 'fight_spider')
  assert.equal(env.global('SNAME'), 'spider_warrior', '不能把蜘蛛战士误判成普通蜘蛛')

  // 低血：战斗必须中止（交给 Reflex 撤退），且 job 必须清掉
  env.run(`
    PLAYER.components.health.currenthealth = 20   -- ~13%
    NOW = NOW + 1
    Whale.actions.Tick()
    LOW_JOB = Whale.job ~= nil and tostring(Whale.job.name) or "none"
    LOW_REASON = tostring(REPORTS[#REPORTS] ~= nil and REPORTS[#REPORTS].text or "")
  `)
  assert.equal(env.global('LOW_JOB'), 'none', '低血必须中止战斗并让出控制权')
  assert.match(env.global('LOW_REASON'), /low_health|outnumbered|emergency|companion_unavailable/)
})

// ═══════════════════ TEST-03：单只青蛙 ═══════════════════
test('TEST-03：温蒂有花被单只青蛙攻击 → 召唤 → 伴生有效防御 → 青蛙死亡', async () => {
  const env = loadEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: ['abigail_flower'] }))
  env.run(`
    local frog = ${attacker('frog', 6, 0, { hp: 100 })}
    NEARBY = { frog }
  `, '放一只青蛙（1.5 格内）')

  env.run(tick(5), '第一次 reflex')
  env.run(`JOB1 = Whale.job ~= nil and Whale.job.name or "none"`)
  assert.equal(env.global('JOB1'), 'summon_companion', '青蛙也应先召唤，而不是无条件逃跑')

  env.run(tick(10), '完成召唤')
  env.run(tick(5), '进入防御')
  env.run(`
    JOB2 = Whale.job ~= nil and Whale.job.name or "none"
    SNAME = "none"
    local s = Whale.battle.GetSession()
    if s ~= nil and s.strategy ~= nil then SNAME = s.strategy.name end
  `)
  assert.equal(env.global('JOB2'), 'fight_spider', 'Reflex 不再无条件逃跑')
  assert.equal(env.global('SNAME'), 'frog', '青蛙必须进入受控防御策略')

  env.run(`
    local s = Whale.battle.GetSession()
    local frog = s ~= nil and s.target or nil
    for i = 1, 40 do
        if frog ~= nil then
            frog.components.health.currenthealth = math.max(0, (frog.components.health.currenthealth or 0) - 25)
            if frog.components.combat ~= nil then frog.components.combat.target = ABIGAIL end
        end
        NOW = NOW + 0.5
        Whale.actions.Tick()
        if Whale.job == nil then break end
    end
    ATTACK_N = 0
    for _, ba in ipairs(PUSHES) do
        if ba.action == GLOBAL.ACTIONS.ATTACK then ATTACK_N = ATTACK_N + 1 end
    end
  `, '让阿比盖尔打死青蛙')
  assert.equal(env.global('ATTACK_N'), '0', '温蒂不会自己硬砍青蛙')
})

// ═══════════════════ TEST-04：三只青蛙 ═══════════════════
test('TEST-04：温蒂有花、三只青蛙都在攻击 → 按真实攻击者计数、受控群战；伴生低血立即撤退', async () => {
  const env = loadEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: ['abigail_flower'], summoned: true, withGhost: true, ghostX: 4 }))
  env.run(`
    NEARBY = {
        ${attacker('frog', 6, 0)}, ${attacker('frog', 9, 2)}, ${attacker('frog', 10, -3)},
    }
  `, '三只青蛙，全部把温蒂当目标')

  env.run(tick(5), '第一次 reflex（已有阿比盖尔可协助）')
  env.run('Whale.actions.Tick()', '让战斗会话初始化')
  env.run(`
    JOB = Whale.job ~= nil and Whale.job.name or "none"
    GRP = "none"
    local s = Whale.battle.GetSession()
    if s ~= nil then GRP = tostring(s.companion_led) end
  `)
  assert.equal(env.global('JOB'), 'fight_spider', '阿比盖尔健康时可协助 → 不应无条件逃跑')
  assert.equal(env.global('GRP'), 'true', '三只青蛙也应进入受控群战')

  // 阿比盖尔血量掉到 15% → 立刻回退保命（不再抑制 Reflex）
  env.run(`
    ABIGAIL.components.health.currenthealth = 20
    NOW = NOW + 1
    Whale.actions.Tick()
    Whale.reflex.Tick()
  `)
  // 再跑几 tick，必须最终由 Reflex 接管撤退
  env.run(tick(10), '继续跑')
  env.run(`FINAL = Whale.job ~= nil and (Whale.job.name .. "/" .. tostring(Whale.job.cmd_id)) or "none"`)
  assert.equal(env.global('FINAL'), 'move_to/reflex', '伴生无法承受群攻时必须由 Reflex 接管撤退')
})

// ═══════════════════ TEST-05：无花 ═══════════════════
test('TEST-05：温蒂无花遇青蛙 → 不假装能召唤 → 原有安全撤退', async () => {
  const env = loadEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: [] }))
  env.run(`
    local frog = ${attacker('frog', 6, 0)}
    NEARBY = { frog }
  `, '无花的温蒂遇到青蛙')

  env.run(tick(5), '第一次 reflex')
  env.run(`
    JOB = Whale.job ~= nil and (Whale.job.name .. "/" .. tostring(Whale.job.cmd_id)) or "none"
    CAN_SUMMON = tostring(Whale.character.GetCompanionState(PLAYER).can_summon)
    CAST_N = 0
    for _, ba in ipairs(PUSHES) do
        if ba.action == GLOBAL.ACTIONS.CASTSUMMON then CAST_N = CAST_N + 1 end
    end
  `)
  assert.equal(env.global('CAN_SUMMON'), 'false', '没有花就不能召唤')
  assert.equal(env.global('CAST_N'), '0', '绝不能凭空 CASTSUMMON')
  assert.equal(env.global('JOB'), 'move_to/reflex', '无伴生可用时必须执行原来的安全撤退')
})

// ═══════════════════ TEST-06：召唤失败/超时 ═══════════════════
test('TEST-06：召唤失败/超时 → 明确失败、不重复 CASTSUMMON、允许安全恢复', async () => {
  const env = loadEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: ['abigail_flower'] }))
  // 覆盖召唤实现：永远不出现（模拟被中断/失败）
  env.run('SUMMON_IMPL = function() end', '召唤永远失败')
  env.run(`
    local spider = ${attacker('spider', 8, 0)}
    NEARBY = { spider }
  `, '蜘蛛攻击')

  env.run(tick(5), '启动召唤交接')
  env.run(`JOB1 = Whale.job ~= nil and Whale.job.name or "none"`)
  assert.equal(env.global('JOB1'), 'summon_companion')

  // 先推进一帧让 job 进入 acting（CASTSUMMON 已推下），再让时间越过 5 秒超时
  env.run('Whale.actions.Tick()', '进入 acting')
  env.run(`
    NOW = NOW + 6
    Whale.actions.Tick()
    JOB2 = Whale.job ~= nil and tostring(Whale.job.name) or "none"
    LAST = tostring(REPORTS[#REPORTS] ~= nil and REPORTS[#REPORTS].text or "")
  `)
  assert.equal(env.global('JOB2'), 'none', '超时后 job 必须结束，不能挂着')
  assert.match(env.global('LAST'), /summon_timeout|summon_succeeded/, '必须给出明确的失败原因')

  // 再跑一段：不允许重复 CASTSUMMON（冷却期内）
  env.run(tick(15), '冷却期内继续跑')
  env.run(`
    CAST_N = 0
    for _, ba in ipairs(PUSHES) do
        if ba.action == GLOBAL.ACTIONS.CASTSUMMON then CAST_N = CAST_N + 1 end
    end
  `)
  assert.equal(env.global('CAST_N'), '1', '失败后不允许无限重试（冷却期内只允许 1 次）')
})

// ═══════════════════ TEST-07：flee → defense 交接 ═══════════════════
test('TEST-07：Reflex flee → Defense 受控交接（旧 job 清理 / 无并发 BufferedAction）', async () => {
  const env = loadEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: ['abigail_flower'] }))
  env.run(`
    -- 手工制造一个"正在逃跑"的 Reflex job（这正是真机上卡住的现场）
    Whale.actions.Start("move_to", { x = 40, z = 40 }, "reflex", { flee = true })
    Whale.job.reflex_key = "flee"
    BUFFERED = { action = GLOBAL.ACTIONS.PICKUP }   -- 旧 BufferedAction 还在
    OLD = Whale.job.name
  `, 'Reflex flee 正在跑')

  // 防御交接：必须允许，并显式清掉旧 job / 旧 BufferedAction
  env.run(`
    local ok, why = Whale.actions.Start("summon_companion", {}, "defense", {})
    OK = tostring(ok)
    WHY = tostring(why)
    NEWJOB = Whale.job ~= nil and (Whale.job.name .. "/" .. tostring(Whale.job.cmd_id)) or "none"
  `)
  assert.equal(env.global('OK'), 'true', '防御交接必须允许打断 Reflex flee（否则永远接不上）')
  assert.equal(env.global('NEWJOB'), 'summon_companion/defense')
  env.run(`BUF = tostring(BUFFERED ~= nil)`)
  assert.equal(env.global('BUF'), 'false', '交接后不能残留旧 BufferedAction（禁止并发）')

  // 反向：Reflex 照明不允许被防御打断
  env.run(`
    Whale.actions.Abort("test")
    Whale.actions.Start("equip", { item = "torch" }, "reflex")
    Whale.job.reflex_key = "light"
    local ok2, why2 = Whale.actions.Start("summon_companion", {}, "defense", {})
    OK2 = tostring(ok2)
    WHY2 = tostring(why2)
    KEPT = Whale.job ~= nil and Whale.job.name or "none"
  `, 'Reflex 照明中')
  assert.equal(env.global('OK2'), 'false', '黑暗照明优先级不允许被防御打断')
  assert.equal(env.global('WHY2'), 'light_priority')
  assert.equal(env.global('KEPT'), 'equip', '原来的保命 job 必须保持')
})

// ═══════════════════ TEST-08：花朵被击落 ═══════════════════
test('TEST-08：青蛙击落阿比盖尔之花 → 状态识别 + 既有 pickup 通道回收', async () => {
  const env = loadEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wendy', items: [] }))   // 花已经不在背包
  env.run(`
    FLOWER = newent("abigail_flower", 8, 0, { "abigail_flower" }, {
        inventoryitem = { owner = nil, canbepickedup = true },
        burnable = {},
    })
    NEARBY = { FLOWER }
  `, '地上一朵阿比盖尔之花')

  env.run(`
    local comp = Whale.character.GetCompanionState(PLAYER)
    HAS = tostring(comp.has_flower)
    CAND = tostring(Whale.pickuprules.IsCandidate(FLOWER, PLAYER))
    FOUND = tostring(Whale.character.FindDroppedFlower(PLAYER, 16) ~= nil)
  `)
  assert.equal(env.global('HAS'), 'false', '花朵已掉落时绝不能报 still_has_flower')
  assert.equal(env.global('CAND'), 'true', '掉落的花必须是合法拾取候选（观察-执行一致）')
  assert.equal(env.global('FOUND'), 'true', '必须能识别地上的花')

  // 空闲且无威胁 → Reflex 走既有 pickup 通道回收
  env.run(tick(5), '空闲回收')
  env.run(`JOB = Whale.job ~= nil and Whale.job.name or "none"`)
  assert.equal(env.global('JOB'), 'pickup', '必须用既有 pickup 动作回收花朵')
})

// ═══════════════════ TEST-09：阿比盖尔失效 ═══════════════════
test('TEST-09：阿比盖尔死亡/过远 → can_assist=false、停止抑制 Reflex、可安全重新召唤', async () => {
  const env = loadEnv(await import('fengari'))
  // 阿比盖尔"已召唤但远在 100 世界单位外"（远超防御范围）
  env.run(scenario({
    prefab: 'wendy', items: ['abigail_flower'],
    summoned: true, withGhost: true, ghostX: 400,
  }))
  env.run(`
    local frog = ${attacker('frog', 6, 0)}
    NEARBY = { frog }
    ASSIST = tostring(Whale.character.GetCompanionState(PLAYER).can_assist)
  `)
  assert.equal(env.global('ASSIST'), 'false', '距离过远不能算"可协助"')

  env.run(tick(5), '过远时第一次 reflex')
  env.run(`JOB = Whale.job ~= nil and (Whale.job.name .. "/" .. tostring(Whale.job.cmd_id)) or "none"`)
  assert.equal(env.global('JOB'), 'move_to/reflex', '伴生无法协助时必须恢复安全撤退')

  // 阿比盖尔死亡 → 也不再"假装伴生战斗有效"
  env.run(`
    ABIGAIL.components.health.currenthealth = 0
    ASSIST2 = tostring(Whale.character.GetCompanionState(PLAYER).can_assist)
    SUPPRESS = tostring(Whale.battle.ShouldSuppressReflex(PLAYER, NEARBY[1]))
  `)
  assert.equal(env.global('ASSIST2'), 'false', '阿比盖尔死亡后 can_assist=false')
  assert.equal(env.global('SUPPRESS'), 'false', '没有受控战斗时不得抑制 Reflex')

  // 死亡后（Recall 回花）→ 可重新召唤
  env.run(`
    PLAYER.components.ghostlybond.ghost = nil
    PLAYER.components.ghostlybond.summoned = false
    PLAYER.components.ghostlybond.notsummoned = true
    PLAYER.components.inventory:GiveItem(mkitem("abigail_flower", 1))
    local c = Whale.character.GetCompanionState(PLAYER)
    CAN2 = tostring(c.can_summon)
  `)
  assert.equal(env.global('CAN2'), 'true', '阿比盖尔消失后、有花时应允许重新召唤')
})

// ═══════════════════ TEST-10：其他角色回归 ═══════════════════
test('TEST-10：威尔逊等无伴生角色不受温蒂专用策略影响（仍是自主战斗）', async () => {
  const env = loadEnv(await import('fengari'))
  env.run(scenario({ prefab: 'wilson', items: [], ghostlybond: false }))
  env.run(`
    local frog = ${attacker('frog', 6, 0)}
    NEARBY = { frog }
  `, '威尔逊遇到青蛙')

  env.run(tick(5), '第一次 reflex')
  env.run(`
    JOB = Whale.job ~= nil and (Whale.job.name .. "/" .. tostring(Whale.job.cmd_id)) or "none"
    LED = tostring(Whale.battle.GetSession() ~= nil and Whale.battle.GetSession().companion_led or false)
    COMP = tostring(Whale.character.GetCompanionState(PLAYER).unknown)
  `)
  assert.equal(env.global('JOB'), 'fight_spider/defense', '通用角色也应进入受控防御（不是 flee）')
  assert.equal(env.global('LED'), 'false', '通用角色没有伴生，绝不能切伴生主战')
  assert.equal(env.global('COMP'), 'true', '没有 ghostlybond 时伴生状态必须是 unknown')

  // 通用角色正常挥砍
  env.run(`
    for i = 1, 6 do NOW = NOW + 0.5; Whale.actions.Tick() end
    ATTACK_N = 0
    for _, ba in ipairs(PUSHES) do
        if ba.action == GLOBAL.ACTIONS.ATTACK then ATTACK_N = ATTACK_N + 1 end
    end
  `)
  assert.ok(Number(env.global('ATTACK_N')) >= 1, '通用角色应保留原有的自主近战能力')
})
