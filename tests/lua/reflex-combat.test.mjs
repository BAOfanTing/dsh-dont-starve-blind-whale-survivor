// 本地反射层装备校验、战斗撤退与近战响应测试
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { derivePlan } from '../../lib/plan.js'
import { loadReflex, eachTick } from '../helpers/reflex-harness.mjs'

// ═══════════════════════ SURVIVAL-03：真机第 2 夜致死链（REFLEX=false 时模型干等到死） ═══════════════════════

const TORCH = `mkitem("torch", 1, { inventoryitem = {}, fueled = { IsEmpty = function() return false end,
                                            GetPercent = function() return 0.9 end } })`

test('SV3-1：equiprules.HandItem 只靠 GLOBAL.EQUIPSLOTS 也能认出手上的火把（真机误报"装备栏没有变化"）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = ${TORCH}`, '手上有火把')
  runFile(`
    BARE = tostring(EQUIPSLOTS)
    local h = Whale.equiprules.HandItem(PLAYER)
    HAND = h ~= nil and h.prefab or "nil"
  `)
  assert.equal(global('BARE'), 'nil', '沙箱必须和模组环境一样没有裸 EQUIPSLOTS')
  assert.equal(global('HAND'), 'torch')
})

test('SV3-2：equip torch 成功后回执"拿在手里了"，不再 10 秒后误报失败', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`PLAYER.components.inventory._items[1] = ${TORCH}`, '背包有火把')
  runFile(`
    Whale.reflex_on = false
    Whale.actions.Start("equip", { item = "torch" }, "model-eq", { survival_equip = true, item = "torch" })
    Whale.actions.Tick()
    Whale.actions.Tick()
    R = REPORTS[#REPORTS]
    OK = R ~= nil and tostring(R.ok) or "nil"
    TEXT = R ~= nil and tostring(R.text) or "nil"
  `)
  assert.equal(global('OK'), 'true', global('TEXT'))
  assert.match(global('TEXT'), /拿在手里/)
})

test('夜里没光 + 背包有火把 —— wait 立刻失败并提示 equip torch（反射关着也不能干等）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    GLOBAL.TheWorld.state.phase = "night"
    PLAYER.components.inventory._items[1] = ${TORCH}
  `, '夜里 + 背包有火把 + 手上空')
  runFile(`
    Whale.reflex_on = false
    Whale.actions.Start("wait", { seconds = 30 }, "model-wait")
    Whale.actions.Tick()
    R = REPORTS[#REPORTS]
    ID = R ~= nil and tostring(R.id) or "nil"
    OK = R ~= nil and tostring(R.ok) or "nil"
    TEXT = R ~= nil and tostring(R.text) or "nil"
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
  `)
  assert.equal(global('ID'), 'model-wait')
  assert.equal(global('OK'), 'false')
  assert.match(global('TEXT'), /dark_no_light.*equip torch/)
  assert.equal(global('JOB'), 'nil')
})

test('夜里手上有火把 —— wait 照常等', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    GLOBAL.TheWorld.state.phase = "night"
    PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = ${TORCH}
  `, '夜里 + 举着火把')
  runFile(`
    Whale.reflex_on = false
    Whale.actions.Start("wait", { seconds = 30 }, "model-wait")
    Whale.actions.Tick()
    NOW = NOW + 5
    Whale.actions.Tick()
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
    N = tostring(#REPORTS)
  `)
  assert.equal(global('JOB'), 'wait')
  assert.equal(global('N'), '0')
})

test('等待跨入夜晚或手持火把烧完，下一次 tick 立即中断', async () => {
  const fengari = await import('fengari')
  for (const transition of ['nightfall', 'fuel_empty']) {
    const { run, runFile, global } = loadReflex(fengari)
    run(transition === 'nightfall'
      ? 'GLOBAL.TheWorld.state.phase = "dusk"'
      : `GLOBAL.TheWorld.state.phase = "night"
         PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = ${TORCH}`, transition)
    runFile(`
      Whale.reflex_on = false
      Whale.actions.Start("wait", { seconds = 30 }, "transition-wait")
      Whale.actions.Tick()
      BEFORE = Whale.job ~= nil and Whale.job.name or "nil"
      GLOBAL.TheWorld.state.phase = "night"
      local hand = PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS]
      if hand ~= nil then hand.components.fueled.IsEmpty = function() return true end end
      NOW = NOW + 1
      Whale.actions.Tick()
      R = REPORTS[#REPORTS]
      OK = R ~= nil and tostring(R.ok) or "nil"
      TEXT = R ~= nil and tostring(R.text) or "nil"
      AFTER = Whale.job ~= nil and Whale.job.name or "nil"
    `)
    assert.equal(global('BEFORE'), 'wait', transition)
    assert.equal(global('OK'), 'false', transition)
    assert.match(global('TEXT'), /dark_no_light/)
    assert.equal(global('AFTER'), 'nil', transition)
  }
})

test('等的时候掉血 —— wait 提前结束', async () => {
  const fengari = await import('fengari')
  const { runFile, global } = loadReflex(fengari)
  runFile(`
    Whale.reflex_on = false
    Whale.actions.Start("wait", { seconds = 30 }, "model-wait")
    Whale.actions.Tick()
    PLAYER.components.health.currenthealth = 100
    NOW = NOW + 1
    Whale.actions.Tick()
    R = REPORTS[#REPORTS]
    OK = R ~= nil and tostring(R.ok) or "nil"
    TEXT = R ~= nil and tostring(R.text) or "nil"
  `)
  assert.equal(global('OK'), 'false')
  assert.match(global('TEXT'), /took_damage/)
})

const LOGIC_SETUP = `
Whale.reflex_on = true
Whale.reflex_force_off = false
PLAYER.sg.HasStateTag = function(self, tag) return tag == "idle" end
PLAYER.IsInLight = function() return false end
local loco = PLAYER.components.locomotor
loco.Stop = function(self) self.dest = nil end
loco.Clear = function(self) self.dest = nil; self.bufferedaction = nil end
loco.GoToPoint = function(self, pt) self.dest = pt; MOVED_TO = pt end
loco.PushAction = function(self, ba) self:Clear(); self.bufferedaction = ba; PUSHED = ba end
function safefood(prefab, health)
    return mkitem(prefab, 1, { edible = { hungervalue = 12.5, healthvalue = health } })
end
`

for (const illuminated of [false, true]) {
  test(`LOGIC-1：附近有火但实际照明=${illuminated}，反射和等待使用真实光照`, async () => {
    const env = loadReflex(await import('fengari'))
    env.run(LOGIC_SETUP)
    env.run(`
      GLOBAL.TheWorld.state.phase = "night"
      PLAYER.IsInLight = function() return ${illuminated} end
      PLAYER.components.inventory._items = { ${TORCH} }
      NEARBY = { newent("campfire", 24, 0, { "light" }, {
          fueled = { IsEmpty = function() return false end } }) }
      assert(Whale.reflex.Diagnose().has_usable_light == ${illuminated})
      assert((Whale.reflex.DarkNoLight(PLAYER) == nil) == ${illuminated})
      Whale.actions.Start("wait", { seconds = 30 }, "wait-light")
      Whale.actions.Tick()
      ${illuminated ? 'assert(Whale.job ~= nil and #REPORTS == 0)' : `
      assert(Whale.job == nil and REPORTS[1].ok == false)
      assert(string.find(REPORTS[1].text, "dark_no_light", 1, true))
      ${eachTick()}
      assert(Whale.job ~= nil and Whale.job.name == "equip")
      `}
    `)
  })
}

for (const hunger of [150, 200]) {
  for (const healthValue of [0, 1]) {
    test(`LOGIC-2：回血食物 health=${healthValue}、饥饿=${hunger} 时只做有效抢占`, async () => {
      const env = loadReflex(await import('fengari'))
      env.run(LOGIC_SETUP)
      env.run(`
        PLAYER.components.health.currenthealth = 15
        PLAYER.components.hunger.current = ${hunger}
        PLAYER.components.inventory._items = {
            ${TORCH}, safefood("${healthValue ? 'carrot' : 'berries'}", ${healthValue}),
            mkitem("cutgrass", 6), mkitem("twigs", 6) }
        Whale.actions.Start("seek", {}, "model-seek", { survival_seek = true, prefab = "flint" })
        ${eachTick(10)}
        ${healthValue ? `
        assert(Whale.job ~= nil and Whale.job.name == "eat", "回血必须真的发起进食")
        assert(#REPORTS == 1 and REPORTS[1].id == "model-seek")
        Whale.actions.Tick()
        assert(PUSHED.invobject.prefab == "carrot")
        ` : `
        assert(Whale.job ~= nil and Whale.job.cmd_id == "model-seek", "零回血食物不许抢占")
        assert(#REPORTS == 0)
        `}
        assert(Whale.last_reflex_error == nil)
      `)
    })
  }
}

for (const mode of ['auto', 'explicit', 'healing']) {
  test(`LOGIC-3：吃掉最后一份食物后正确核验（${mode}）`, async () => {
    const env = loadReflex(await import('fengari'))
    env.run(LOGIC_SETUP)
    env.run(`
      PLAYER.components.inventory._items = { safefood("carrot", 1) }
      ${mode === 'healing' ? 'PLAYER.components.hunger.current = 200; PLAYER.components.health.currenthealth = 15' : ''}
      Whale.actions.Start("eat", {}, "eat-last", { survival_eat = true,
          ${mode === 'explicit' ? 'food = "carrot"' : ''} })
      Whale.actions.Tick()
      assert(PUSHED.action.id == "EAT")
      PLAYER.components.inventory._items = {}
      ${mode === 'healing' ? 'PLAYER.components.health.currenthealth = 16' : 'PLAYER.components.hunger.current = 162.5'}
      PLAYER.components.locomotor:Clear()
      NOW = NOW + 1
      Whale.actions.Tick()
      assert(#REPORTS == 1 and REPORTS[1].ok == true, REPORTS[1] and REPORTS[1].text)
      assert(Whale.job == nil)
    `)
  })
}

test('LOGIC-3：食物没消耗、饥饿没上涨时不能误报成功', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    PLAYER.components.inventory._items = { safefood("carrot", 1) }
    Whale.actions.Start("eat", {}, "eat-noop", { survival_eat = true })
    Whale.actions.Tick()
    PLAYER.components.locomotor:Clear()
    NOW = NOW + 21
    Whale.actions.Tick()
    assert(#REPORTS == 1 and REPORTS[1].ok == false)
    assert(string.find(REPORTS[1].text, "eat_failed", 1, true))
  `)
})

for (const cancel of ['abort', 'replace', 'stop', 'budget']) {
  test(`LOGIC-4：${cancel} 清空玩家和移动组件两处队列`, async () => {
    const env = loadReflex(await import('fengari'))
    env.run(LOGIC_SETUP)
    env.run(`
      Whale.actions.Start("wait", { seconds = 30 }, "old")
      Whale.actions.Tick()
      PLAYER.components.locomotor.bufferedaction = { action = GLOBAL.ACTIONS.PICK }
      BUFFERED = { action = GLOBAL.ACTIONS.PICK }
      ${cancel === 'abort' ? 'Whale.actions.Abort("cancel")' : cancel === 'replace'
        ? 'Whale.actions.Start("wait", { seconds = 10 }, "new")' : cancel === 'stop'
          ? 'Whale.actions.Start("stop", {}, "stop"); Whale.actions.Tick()'
          : 'Whale.job.t0 = NOW - 999; Whale.actions.Tick()'}
      assert(PLAYER:GetBufferedAction() == nil, "玩家队列必须清空")
      assert(PLAYER.components.locomotor.bufferedaction == nil, "移动组件队列必须清空")
      assert(PLAYER.components.locomotor.dest == nil, "服务端移动必须停止")
    `)
  })
}

for (const prefab of ['lantern', 'minerhat']) {
  test(`LOGIC-5：夜间装备背包实际拥有的 ${prefab}，不寻找不存在的火把`, async () => {
    const env = loadReflex(await import('fengari'))
    env.run(LOGIC_SETUP)
    env.run(`
      GLOBAL.TheWorld.state.phase = "night"
      local inv = PLAYER.components.inventory
      local slot = "${prefab === 'minerhat' ? 'head' : 'hands'}"
      inv._items = { mkitem("${prefab}", 1, { fueled = {
          IsEmpty = function() return false end, GetPercent = function() return 1 end } }) }
      inv.Equip = function(self, item) self._items = {}; self._equipped[slot] = item end
      PLAYER.IsInLight = function() return inv:GetEquippedItem(slot) ~= nil end
      ${eachTick()}
      assert(Whale.job ~= nil and Whale.job.name == "equip")
      assert(Whale.job.args.item == "${prefab}")
      Whale.actions.Tick()
      assert(inv:GetEquippedItem(slot).prefab == "${prefab}")
      assert(REPORTS[1].ok == true)
      NOW = NOW + 7
      ${eachTick()}
      assert(Whale.job == nil, "已经有光不能反复抢占")
      assert(Whale.reflex.Diagnose().has_usable_light == true)
    `)
  })
}

for (const item of ['lantern', 'minerhat']) {
  test(`LOGIC-5：外部 equip ${item} 按真实槽位核验`, async () => {
    const env = loadReflex(await import('fengari'))
    env.run(LOGIC_SETUP)
    env.run(`
      local inv = PLAYER.components.inventory
      local slot = "${item === 'minerhat' ? 'head' : 'hands'}"
      inv._items = { mkitem("${item}", 1, { inventoryitem = {} }) }
      inv.Equip = function(self, item) self._items = {}; self._equipped[slot] = item end
      Whale.actions.Start("equip", { item = "${item}" }, "external-equip", { survival_equip = true, item = "${item}" })
      Whale.actions.Tick()
      Whale.actions.Tick()
      assert(REPORTS[1] ~= nil and REPORTS[1].ok == true)
      assert(inv:GetEquippedItem(slot).prefab == "${item}")
    `)
  })
}

test('LOGIC-5：耗尽的提灯不阻止制作火把', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "night"
    PLAYER.components.inventory._items = {
        mkitem("lantern", 1, { fueled = { IsEmpty = function() return true end } }),
        mkitem("cutgrass", 2), mkitem("twigs", 2) }
    ${eachTick()}
    assert(Whale.job ~= nil and Whale.job.name == "craft")
  `)
})

test('LOGIC-6：seek 原地扫描找不到时正常返回、不移动', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    PLAYER._x = 0; PLAYER._z = 0
    NEARBY = {}
    MOVED_TO = nil
    Whale.actions.Start("seek", {}, "seek-end", { survival_seek = true, prefab = "flint", max_tiles = 10 })
    Whale.actions.Tick()
    assert(#REPORTS == 1 and REPORTS[1].ok == false)
    assert(string.find(REPORTS[1].text, "没看到 flint", 1, true), REPORTS[1].text)
    assert(MOVED_TO == nil, "seek 不应再绕圈走动")
    assert(PLAYER.components.locomotor.dest == nil)
  `)
})

test('LOGIC-7：seek 原地扫描遵守 max_tiles（4 格找不到、40 格能找到），且不移动', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    PLAYER._x = 0; PLAYER._z = 0
    NEARBY = { newent("flint", 80, 0, {}) }  -- 80 世界单位 = 20 格
    MOVED_TO = nil
    REPORTS = {}
    Whale.actions.Start("seek", {}, "s4", { survival_seek = true, prefab = "flint", max_tiles = 4 })
    Whale.actions.Tick()
    assert(REPORTS[1] ~= nil and REPORTS[1].ok == false, "4 格内不应找到 20 格外的 flint")
    REPORTS = {}
    Whale.actions.Start("seek", {}, "s40", { survival_seek = true, prefab = "flint", max_tiles = 40 })
    Whale.actions.Tick()
    assert(REPORTS[1] ~= nil and REPORTS[1].ok == true, "40 格内应找到")
    assert(string.find(REPORTS[1].text, "flint", 1, true))
    assert(MOVED_TO == nil, "seek 不应走动")
    assert(PLAYER.components.locomotor.dest == nil)
  `)
})

// ─────────────────────────── REFLEX-FIX-02 专项验证（12 项测试）───────────────────────────

test('FIX-02-1：饥饿 70/200，正在采矿，不触发紧急抢占', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    PLAYER.components.hunger.current = 70
    PLAYER.components.health.currenthealth = 150
    PLAYER.components.inventory._items = { safefood("berries", 0) }
    Whale.actions.Start("mine", {}, "model-mine", { survival_work = true, action = "MINE" })
    ${eachTick(5)}
    assert(Whale.job ~= nil and Whale.job.cmd_id == "model-mine", "70/200 普通饥饿绝不打断采矿")
    local needs = Whale.reflex.Needs()
    local has_food_need = false
    for _, n in ipairs(needs) do if n.kind == "food" then has_food_need = true end end
    assert(has_food_need == true, "普通饥饿必须上报需求给 Plan")
  `)
})

test('FIX-02-2：饥饿真正达到紧急程度（40/200），背包有食物，允许进食一次', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    PLAYER.components.hunger.current = 40
    PLAYER.components.inventory._items = { safefood("berries", 0) }
    Whale.actions.Start("gather_area", {}, "model-g", { survival_area = true })
    ${eachTick(5)}
    assert(Whale.job ~= nil and Whale.job.name == "eat", "真正紧急时允许进食抢占")
    assert(Whale.job.cmd_id == "reflex")
  `)
})

test('FIX-02-3：饥饿恢复后进入冷却防抖，不重复进食', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    PLAYER.components.hunger.current = 40
    PLAYER.components.inventory._items = { safefood("berries", 0) }
    ${eachTick(5)}
    assert(Whale.job ~= nil and Whale.job.name == "eat")
    Whale.actions.Tick()
    PLAYER.components.hunger.current = 75
    Whale.actions.Tick()
    ${eachTick(5)}
    assert(Whale.job == nil, "饥饿恢复后不能重复发起进食")
  `)
})

test('FIX-02-4：白天正在装备长矛，Reflex 不允许收起或替换手持物品', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "day"
    local inv = PLAYER.components.inventory
    inv._equipped[GLOBAL.EQUIPSLOTS.HANDS] = mkitem("spear", 1, { equippable = { equipslot = "hands" }, inventoryitem = {} })
    Whale.actions.Start("equip", { item = "spear" }, "model-equip")
    ${eachTick(10)}
    assert(Whale.job ~= nil and Whale.job.cmd_id == "model-equip", "装备长矛期间 Reflex 绝不抢占")
    assert(inv._equipped[GLOBAL.EQUIPSLOTS.HANDS].prefab == "spear", "长矛仍在手上")
  `)
})

test('FIX-02-5：夜晚没有光源，背包有火炬，紧急装备成功', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "night"
    PLAYER.IsInLight = function() return false end
    PLAYER.components.inventory._items = { ${TORCH} }
    ${eachTick(5)}
    assert(Whale.job ~= nil and Whale.job.name == "equip" and Whale.job.cmd_id == "reflex")
    assert(Whale.job.args.item == "torch")
  `)
})

test('FIX-02-6：夜晚没有火炬但有制作材料，按紧急流程制作照明', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "night"
    PLAYER.IsInLight = function() return false end
    PLAYER.components.inventory._items = { mkitem("cutgrass", 2), mkitem("twigs", 2) }
    ${eachTick(5)}
    assert(Whale.job ~= nil and Whale.job.name == "craft" and Whale.job.cmd_id == "reflex")
    assert(Whale.job.args.recipe == "torch")
  `)
})

test('FIX-02-7：遭遇攻击时动态评估多个方向，避开危险和失败点', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    local spider = newent("spider", 4 * 4, 0, { "hostile" }, {
        combat = { target = PLAYER },
        health = { IsDead = function() return false end, currenthealth = 100 },
    })
    NEARBY = { spider }
    ${eachTick(5)}
    assert(Whale.job ~= nil and Whale.job.name == "move_to" and Whale.job.cmd_id == "reflex")
    assert(Whale.job.args.x < 0, "逃跑方向选择背离敌人的安全方向")
    local dz = Whale.reflex.DangerZones()
    assert(#dz > 0, "逃生必须生成短期危险区域记录")
  `)
})

test('FIX-02-8：逃生目标点失败冷却后，不再向同一个不可达坐标重复移动', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    local spider = newent("spider", 4 * 4, 0, { "hostile" }, {
        combat = { target = PLAYER },
        health = { IsDead = function() return false end, currenthealth = 100 },
    })
    NEARBY = { spider }
    ${eachTick(5)}
    local first_x, first_z = Whale.job.args.x, Whale.job.args.z
    Whale.actions.Abort("failed_move")
    ${eachTick(5)}
    ${eachTick(5)}
    if Whale.job ~= nil and Whale.job.name == "move_to" then
        local key1 = first_x .. "_" .. first_z
        local key2 = Whale.job.args.x .. "_" .. Whale.job.args.z
        assert(key1 ~= key2, "相同失败逃生坐标的重复尝试次数必须为 0")
    end
  `)
})

test('FIX-02-9：脱离危险后，主 Plan 记录危险区域且不立即返回原危险目标', async () => {
  const { derivePlan } = await import('../../lib/plan.js')
  const snapshot = {
    schema: 'bws.state/1',
    status: 'ok',
    player: { health: { percent: 80, current: 80, max: 100 }, hunger: { percent: 80, current: 160, max: 200 } },
    actor: { tileX: 0, tileZ: 0, alive: true, valid: true },
    world: { phase: 'day', day: 2 },
    dangerZones: [{ x: 5, z: 0, radius: 10, source: 'spiderden', ageS: 5, ttlS: 55 }],
    nearby: {
      buckets: {
        harvestables: [
          { prefab: 'berrybush', x: 5, z: 0, distance: 5, harvest_ready: true },
          { prefab: 'berrybush', x: -15, z: 0, distance: 15, harvest_ready: true },
        ],
        threats: [],
      },
    },
  }
  const plan = derivePlan(snapshot)
  assert.equal(!plan.next.includes('距 5 格'), true, 'Plan 自动避开处于危险区域内的目标')
})

test('FIX-02-10：死亡后只触发一次 RESET，停止普通动作调度', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    PLAYER.components.health.currenthealth = 0
    RESET_COUNT = 0
    print = function(s)
        local str = tostring(s)
        if string.find(str, "reset", 1, true) and string.find(str, "reason=dead", 1, true) then
            RESET_COUNT = RESET_COUNT + 1
        end
    end
    ${eachTick(20)}
    assert(RESET_COUNT == 1, "死亡状态每秒不能重复 RESET，必须只触发 1 次，实际是: " .. tostring(RESET_COUNT))
    assert(Whale.job == nil, "死亡后停止普通动作调度")
  `)
})

test('FIX-02-11：Lua 计时逻辑在 os=nil 环境下安全运行无报错', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.os = nil
    local ok, err = GLOBAL.pcall(function()
        Whale.util.now()
        Whale.reflex.Tick()
    end)
    assert(ok == true, "os 为 nil 时不抛异常: " .. tostring(err))
    assert(Whale.last_reflex_error == nil, "reflex 内部无 os nil 错误")
  `)
})

test('FIX-02-12：spear 装备能够通过正确的组件和白名单检查', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    local spear = mkitem("spear", 1, {
        inventoryitem = {},
        equippable = {
            equipslot = GLOBAL.EQUIPSLOTS.HANDS,
            CanBeEquippedBy = function(self, p) return true end
        }
    })
    local ok_p, err_p = Whale.equiprules.IsAllowedPrefab("spear")
    assert(ok_p == true, "spear 必须在装备白名单中")
    local ok_e, err_e = Whale.equiprules.IsEquippable(spear, PLAYER)
    assert(ok_e == true, "带 equippable 的 spear 必须判定为可装备")
    assert(Whale.equiprules.SlotFor("spear") == GLOBAL.EQUIPSLOTS.HANDS, "spear 槽位判定为 hands")
  `)
})

test('FIX-02-13：主动战斗任务（kill/attack）在血量>=50%时不被 under_attack 逃跑打断，残血时恢复逃跑', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "day"
    PLAYER.components.health.currenthealth = 120
    PLAYER.components.health.maxhealth = 150 -- 80% HP

    -- 创建一只攻击玩家的蜘蛛
    local spider = newent("spider", 2, 0, { "hostile", "monster", "spider" }, {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
        combat = { target = PLAYER },
    })
    NEARBY = { spider }

    -- 模拟模型发起的 kill 任务
    Whale.actions.Start("kill", {}, "model_cmd_kill_1")

    -- 跑反射 5 ticks（≈1 秒节流）
    NOW = NOW + 2
    ${eachTick(5)}

    -- 验证：战斗任务未被中断，没有触发逃跑
    assert(Whale.job ~= nil and Whale.job.name == "kill", "血量充足时主动战斗任务不应被打断")

    -- 现在玩家掉血到 40% (< 50%)
    PLAYER.components.health.currenthealth = 60
    NOW = NOW + 2
    ${eachTick(5)}

    -- 验证：血量不足 50% 时触发逃跑，战斗任务被抢占中断
    assert(Whale.job == nil or Whale.job.cmd_id == "reflex", "血量低于 50% 时应触发紧急避险")
  `)
})

// ─────── 真机回归（session 8fab0944 第 3 天）：打建筑被围殴不能算"正在战斗" ───────
//
// 现象：温蒂被指令去打蜘蛛巢（hi0，250 血），攻击惊动了 3 只守卫蜘蛛。
//       血量从 150 被打到 33（22%）—— 全程反射都没让她撤，
//       因为旧逻辑只看 job.name 是 attack/kill + 血 >= 50%，完全不看打的是谁。

test('FIX-02-14：攻击的是建筑、却被守卫怪围殴 —— 必须立刻撤退（不能算主动交战）', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "day"
    PLAYER.components.health.currenthealth = 140   -- 93%：血量充足，旧逻辑一定不撤
    PLAYER.components.health.maxhealth = 150

    -- 被攻击的目标：蜘蛛巢（结构，不追人）
    local den = newent("spiderden", 0, 0, { "hostile", "structure", "spiderden" }, {
        health = { currenthealth = 250, maxhealth = 250, IsDead = function() return false end },
    })
    -- 3 只正在打玩家的守卫蜘蛛
    local guards = {}
    for i = 1, 3 do
        guards[i] = newent("spider", 2, 0, { "hostile", "monster", "spider" }, {
            health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
            combat = { target = PLAYER },
        })
    end
    NEARBY = { den, guards[1], guards[2], guards[3] }

    -- 模型正在打那个巢（ctx.target = den），不是打蜘蛛
    Whale.actions.Start("attack", {}, "model_cmd_den", { target = den, times = 5 })

    NOW = NOW + 2
    ${eachTick(5)}

    -- 必须中断攻击、转为逃跑
    assert(Whale.job == nil or Whale.job.cmd_id == "reflex",
        "打建筑时被守卫怪围殴必须中断，实际 job=" .. tostring(Whale.job and Whale.job.name))
  `)
})

test('FIX-02-15：一对一打怪（目标就是攻击者）时，血量充足仍保持主动交战', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "day"
    PLAYER.components.health.currenthealth = 120   -- 80%
    PLAYER.components.health.maxhealth = 150

    local spider = newent("spider", 2, 0, { "hostile", "monster", "spider" }, {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
        combat = { target = PLAYER },
    })
    NEARBY = { spider }

    -- 目标就是这只蜘蛛：这是真正的"主动交战"
    Whale.actions.Start("kill", {}, "model_cmd_spider", { target = spider })

    NOW = NOW + 2
    ${eachTick(5)}

    assert(Whale.job ~= nil and Whale.job.name == "kill",
        "一对一主动交战不该被撤退打断，实际 job=" .. tostring(Whale.job and Whale.job.name))
  `)
})

test('FIX-02-16：目标本身正在攻击我（哪怕旁边还有别的蜘蛛）→ 仍算主动交战，不打断', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "day"
    PLAYER.components.health.currenthealth = 120   -- 80%
    PLAYER.components.health.maxhealth = 150

    local a = newent("spider", 2, 0, { "hostile", "monster", "spider" }, {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
        combat = { target = PLAYER },
    })
    local b = newent("spider", -2, 0, { "hostile", "monster", "spider" }, {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
        combat = { target = PLAYER },
    })
    NEARBY = { a, b }

    -- 打的就是正在咬我的 a：这是正常战斗，不该被打断
    Whale.actions.Start("kill", {}, "model_cmd_a", { target = a })

    NOW = NOW + 2
    ${eachTick(5)}

    assert(Whale.job ~= nil and Whale.job.name == "kill",
        "打的是正在攻击我的蜘蛛时不该撤退，实际 job=" .. tostring(Whale.job and Whale.job.name))
  `)
})

test('FIX-02-17：目标是个不会打人的活物（比如打中立建筑/巢）→ 被真怪攻击时必须撤', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "day"
    PLAYER.components.health.currenthealth = 140   -- 93%：血量充足
    PLAYER.components.health.maxhealth = 150

    -- 打的是一棵树（有 health 但不会攻击玩家）
    local tree = newent("evergreen", 1, 0, { "tree" }, {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
    })
    -- 一只正在咬我的蜘蛛
    local spider = newent("spider", -2, 0, { "hostile", "monster", "spider" }, {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
        combat = { target = PLAYER },
    })
    NEARBY = { tree, spider }

    Whale.actions.Start("attack", {}, "model_cmd_tree", { target = tree, times = 3 })

    NOW = NOW + 2
    ${eachTick(5)}

    assert(Whale.job == nil or Whale.job.cmd_id == "reflex",
        "打不会还手的目标时被怪咬，必须优先逃跑，实际 job=" .. tostring(Whale.job and Whale.job.name))
  `)
})


// ═══════════════════════ R8.1：本地生存大脑（换手冻结 / 温度方向 / 日常维护） ═══════════════════════

const R81_SETUP = `
  NEARBY = {}
  PLAYER.components.health.currenthealth = 150
  PLAYER.components.health.maxhealth = 150
  PLAYER.components.hunger.current = 150
  PLAYER.components.hunger.max = 200
  PLAYER.components.sanity.current = 200
  PLAYER.components.sanity.max = 200
  PLAYER.components.temperature = { GetCurrent = function() return 20 end }
  PLAYER.components.inventory._items = {}
  PLAYER.components.inventory._equipped = {}
  PUSHED = nil
  MOVED_TO = nil
  BUFFERED = nil
  Whale.job = nil
  Whale.reflex_on = true
  Whale.reflex_force_off = false
  GLOBAL.TheWorld.state.phase = "day"
  GLOBAL.TheWorld.state.temperature = 20
`
const PUT_TORCH = 'PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = mkitem("torch", 1, { fueled = { IsEmpty = function() return false end, GetPercent = function() return 0.9 end } })'

test('revoking 冻结期间 Reflex 不启动任何新动作；A.Start(reflex) 直接拒绝；解冻后恢复', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run(PUT_TORCH, '有火把避免走造光分支')
  run('Whale.bridge.LocalActionsFrozen = function() return FROZEN == true end; FROZEN = true', '冻结钩子')
  runFile('local ok = Whale.actions.Start("move_to", { x = 3, z = 3 }, "reflex"); BLK = ok and "no" or "yes"')
  assert.equal(global('BLK'), 'yes', '冻结期间 A.Start(reflex) 必须返回失败')
  run(eachTick(10), '冻结下跑 10 tick')
  runFile('FZP = (PUSHED ~= nil or Whale.job ~= nil) and "yes" or "no"')
  assert.equal(global('FZP'), 'no', '冻结期间不得启动任何反射动作')
  run('FROZEN = false', '解冻')
  run('GLOBAL.TheWorld.state.phase = "night"', '改夜间避免白天收火把干扰')
  run('PLAYER.components.sanity.current = 60', '理智低')
  run('NEARBY = { newent("flower", 2, 0, {}) }', '近处有花')
  run(eachTick(10), '解冻后跑 10 tick')
  runFile('UFZ = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.notEqual(global('UFZ'), 'none', '解冻后反射应能重新启动维护动作')
})

test('过热（>65）绝不向火堆移动（只上报）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('GLOBAL.TheWorld.state.phase = "night"', '夜间+火把避免白天收火把')
  run(PUT_TORCH, '有火把')
  run('NEARBY = { newent("campfire", 2, 0, {"fire"}, { fueled = { IsEmpty = function() return false end, GetPercent = function() return 0.9 end } }) }', '近处火堆')
  run('PLAYER.components.temperature = { GetCurrent = function() return 80 end }', '过热 80')
  run(eachTick(10), '跑 10 tick')
  runFile('HOT_MOVED = ((MOVED_TO ~= nil) or (Whale.job ~= nil and Whale.job.name == "move_to")) and "yes" or "no"')
  runFile('HOT_JOB = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.equal(global('HOT_MOVED'), 'no', '过热时不得向火堆移动')
  assert.equal(global('HOT_JOB'), 'none', '过热时不应启动任何动作（只上报）')
})

test('过冷（<5）会靠近点燃的热源', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('GLOBAL.TheWorld.state.phase = "night"', '夜间+火把')
  run(PUT_TORCH, '有火把避免造光')
  run('NEARBY = { newent("campfire", 2, 0, {"fire"}, { fueled = { IsEmpty = function() return false end, GetPercent = function() return 0.9 end } }) }', '近处点燃火堆')
  run('PLAYER.components.temperature = { GetCurrent = function() return -5 end }', '过冷 -5')
  run(eachTick(10), '跑 10 tick')
  runFile('COLD_JOB = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.equal(global('COLD_JOB'), 'move_to', '过冷时应当 move_to 热源')
})

test('低理智 + 近处有花 → 空闲时采集（P2）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('GLOBAL.TheWorld.state.phase = "night"', '夜间避免收火把')
  run(PUT_TORCH, '有火把')
  run('PLAYER.components.sanity.current = 60', '理智低 30%')
  run('NEARBY = { newent("flower", 2, 0, {}) }', '近处有花')
  run(eachTick(10), '跑 10 tick')
  runFile('SAN_JOB = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.equal(global('SAN_JOB'), 'gather', '低理智空闲且有近花时应 gather 采花')
})

test('低理智但附近没有花 → 不无目标漫游', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('GLOBAL.TheWorld.state.phase = "night"', '夜间避免收火把')
  run(PUT_TORCH, '有火把')
  run('PLAYER.components.sanity.current = 60', '理智低')
  run('NEARBY = {}', '附近无花')
  run(eachTick(10), '跑 10 tick')
  runFile('NOFLOWER_JOB = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.equal(global('NOFLOWER_JOB'), 'none', '附近无花时不得启动漫游/采集')
})

test('没有安全食物时不执行 eat', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('GLOBAL.TheWorld.state.phase = "night"', '夜间避免收火把')
  run(PUT_TORCH, '有火把')
  run('PLAYER.components.hunger.current = 80', '饥饿 40%')
  run('PLAYER.components.inventory._items[1] = mkitem("monstermeat", 2)', '只有怪物肉（不安全）')
  run(eachTick(10), '跑 10 tick')
  runFile('FOOD_JOB = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.notEqual(global('FOOD_JOB'), 'eat', '没有安全食物时绝不能 eat')
})

test('P2 维护（理智采花）不得抢占正在进行的模型任务', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('GLOBAL.TheWorld.state.phase = "night"', '夜间避免收火把')
  run(PUT_TORCH, '有火把')
  run('PLAYER.components.sanity.current = 60', '理智低')
  run('NEARBY = { newent("flower", 2, 0, {}) }', '近处有花')
  runFile('Whale.actions.Start("move_to", { x = 50, z = 50 }, "mcp_client")')
  run(eachTick(10), '跑 10 tick')
  runFile('KEEP_JOB = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.equal(global('KEEP_JOB'), 'move_to', 'P2 理智维护不得抢占模型任务')
})

test('P0 紧急（夜间无光）仍可抢占模型任务', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('GLOBAL.TheWorld.state.phase = "night"', '入夜')
  run('PLAYER.components.inventory._items[1] = mkitem("cutgrass", 2); PLAYER.components.inventory._items[2] = mkitem("twigs", 2)', '火把材料够')
  runFile('Whale.actions.Start("move_to", { x = 50, z = 50 }, "mcp_client")')
  run(eachTick(10), '跑 10 tick')
  runFile('P0_JOB = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.notEqual(global('P0_JOB'), 'move_to', 'P0 夜间无光应抢占模型任务（job 应变为造光相关）')
})

test('火源低于阈值（白天<20%）→ 空闲时启动一次 add_fuel', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('NEARBY = { newent("campfire", 2, 0, {"fire"}, { fueled = { IsEmpty = function() return false end, GetPercent = function() return 0.1 end } }) }', '低燃料火堆')
  run('PLAYER.components.inventory._items[1] = mkitem("log", 5)', '背包有木头')
  run(eachTick(10), '跑 10 tick')
  runFile('FUEL_JOB = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.equal(global('FUEL_JOB'), 'add_fuel', '白天低燃料空闲时应启动 add_fuel')
})

test('燃料状态未更新 → 冷却期内不会连续重复添柴', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('NEARBY = { newent("campfire", 2, 0, {"fire"}, { fueled = { IsEmpty = function() return false end, GetPercent = function() return 0.1 end } }) }', '低燃料火堆')
  run('PLAYER.components.inventory._items[1] = mkitem("log", 5)', '背包有木头')
  run(eachTick(10), '启动 add_fuel')
  // 推进核心动作两次：start→acting→done（燃料百分比桩不变=未更新）
  run('if Whale.job ~= nil then Whale.actions.Tick(); Whale.actions.Tick() end', '把这次添柴跑完（燃料未涨）')
  run(eachTick(20), '继续跑反射')
  runFile('FUEL2 = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.notEqual(global('FUEL2'), 'add_fuel', '燃料没更新时不得连续重复添柴')
})

