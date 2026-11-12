// Phase 5 M5 · 进食 / 制作 / 建造 Lua 沙箱测试
//
// 覆盖：eat/craft/build 映射、配方与食物白名单、**人工确认程序层强制**、
//       进食饥饿差核验、制作成品清点、营火 fire 标签核验。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const STUB = `
CLOCK = 1000
POSTS = {}
GLOBAL = {}
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.os = { time = function() return CLOCK end }
GLOBAL.TheSim = { GetRealTime = function() return CLOCK * 1000 end }
GLOBAL.TheWorld = { ismastersim = true, HasTag = function() return false end }
GLOBAL.AllPlayers = {}
GLOBAL.ACTIONS = { EAT = {}, CHOP = {}, MINE = {}, PICKUP = {}, PICK = {}, HARVEST = {} }
GLOBAL.EQUIPSLOTS = { HANDS = 'hands' }
GLOBAL.AllRecipes = {}

ITEMS = {}
EQUIPPED = nil
HUNGER = 100
FIRE = nil
function make_inventory()
  return {
    ForEachItem = function(self, fn)
      for _, it in ipairs(ITEMS) do
        fn({ prefab = it.prefab, components = { stackable = { StackSize = function() return it.n end } } })
      end
    end,
    GetEquippedItem = function(self, slot) return EQUIPPED end,
  }
end

BWS = { json = { decode = function() return DECODED end } }
BWS2 = {
    connection = { protocolVersion = function() return "1.0" end, session = function() return "S1" end,
                   isServerSide = function() return true end },
    config = { get = function() return { token = "T" } end },
    http = { post = function(path, body, cb)
        POSTS[#POSTS + 1] = { path = path, body = body }
        if path == "/api/v1/control/assert" then cb({ ok = true, status = 200, body = "{}" }) end
    end },
    json = { decode = function() return DECODED end },
}
DECODED = { allowed = true, code = "OK", message = "ok" }
REPORTS = {}
function report(commandId, status, result, err, startedMs)
    REPORTS[#REPORTS + 1] = { id = commandId, status = status, result = result, error = err }
end

Whale = {
    util = {
        player = function() return PLAYER end,
        pos = function() return 10, 0, 20 end,
        log = function() end,
        find_nearest = function(p, radius, musttags, canttags, filter)
            if FIRE ~= nil and filter ~= nil then
                local ok, hit = pcall(filter, FIRE)
                if ok and hit then return FIRE end
            end
            return nil
        end,
    },
    actions = {
        Start = function(name, args) STARTED = { name = name, args = args }; return true, nil end,
        Current = function() return CURRENT, CURRENT_ARGS end,
        Known = function() return { "build", "craft", "eat", "make_fire" } end,
    },
    bridge = { Report = function(ok, text)
        if BWS2.actionExecutor ~= nil and BWS2.actionExecutor.onActionReport ~= nil then
            pcall(BWS2.actionExecutor.onActionReport, ok, text, nil)
        end
    end },
}
STARTED = nil
CURRENT = nil
CURRENT_ARGS = nil
PLAYER = {
    components = {
        health = { IsDead = function() return false end },
        locomotor = { Stop = function() end },
        inventory = nil,
        hunger = { current = 100, max = 200 },
    },
    HasTag = function() return false end, ClearBufferedAction = function() end,
}
`

function load(fengari) {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, label = 'lua') => {
    const st = lauxlib.luaL_dostring(L, to_luastring(code))
    if (st !== lua.LUA_OK) {
      let m = ''
      try { m = to_jsstring(lua.lua_tostring(L, -1)) } catch {}
      throw new Error(`${label}: ${m}`)
    }
  }
  run(STUB, '假环境')
  run(readFileSync(join(MOD, 'scripts', 'main', 'action_executor.lua'), 'utf8'), 'action_executor.lua')
  return { run }
}

const cmd = (type, params) => `{ id = "c1", type = "${type}",
  params = { controller_id = "C1", session_id = "S1" ${params} } }`

test('M5：eat_item 映射到 eat；不传 item 时交给游戏自动挑食物', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    CURRENT = 'eat'
    BWS2.actionExecutor.execute(${cmd('eat_item', ', confirmed = true')}, report)
    assert(STARTED ~= nil, '应启动')
    assert(STARTED.name == 'eat')
    assert(STARTED.args.item == nil, '不传 item 应让游戏自己挑')
    assert(REPORTS[1].status == 'EXECUTING')
  `)
})

test('M5：eat_item 指定食物走白名单，白名单外被拒', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    CURRENT = 'eat'
    BWS2.actionExecutor.execute(${cmd('eat_item', ', item = "berries", confirmed = true')}, report)
    assert(STARTED.args.item == 'berries')
  `)
  const { run: run2 } = load(fengari)
  run2(`
    BWS2.actionExecutor.execute(${cmd('eat_item', ', item = "goldnugget", confirmed = true')}, report)
    assert(STARTED == nil, '不该启动')
    assert(string.find(REPORTS[1].error, 'invalid_item', 1, true) ~= nil)
  `)
})

test('M5：craft_item 配方白名单（axe/pickaxe/torch/campfire）', async () => {
  const fengari = await import('fengari')
  for (const r of ['axe', 'pickaxe', 'torch', 'campfire']) {
    const { run } = load(fengari)
    run(`
      CURRENT = 'craft'
      BWS2.actionExecutor.execute(${cmd('craft_item', `, recipe = "${r}", confirmed = true`)}, report)
      assert(STARTED.name == 'craft', '应映射到 craft')
      assert(STARTED.args.recipe == '${r}')
    `)
  }
  const { run: bad } = load(fengari)
  bad(`
    BWS2.actionExecutor.execute(${cmd('craft_item', ', recipe = "goldnugget", confirmed = true')}, report)
    assert(STARTED == nil)
    assert(string.find(REPORTS[1].error, 'invalid_recipe', 1, true) ~= nil)
  `)
})

test('M5：craft count 上限 3', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    CURRENT = 'craft'
    BWS2.actionExecutor.execute(${cmd('craft_item', ', recipe = "axe", count = 99, confirmed = true')}, report)
    assert(STARTED.args.count == 3, '应夹到 3，实际 ' .. tostring(STARTED.args.count))
  `)
})

test('M5：eat/craft/build 都需人工确认（程序层强制）', async () => {
  const fengari = await import('fengari')
  for (const [type, extra] of [
    ['eat_item', ''],
    ['craft_item', ', recipe = "axe"'],
    ['build_campfire', ''],
    ['build_structure', ', recipe = "campfire"'],
  ]) {
    const { run } = load(fengari)
    run(`
      BWS2.actionExecutor.execute(${cmd(type, extra)}, report)
      assert(STARTED == nil, '${type} 未确认不该启动')
      assert(string.find(REPORTS[1].error, 'confirmation_required', 1, true) ~= nil,
        '${type} 应报 confirmation_required，实际 ' .. tostring(REPORTS[1].error))
    `)
  }
})

test('M5：build_campfire 默认配方 campfire，映射到 make_fire', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    CURRENT = 'make_fire'
    BWS2.actionExecutor.execute(${cmd('build_campfire', ', confirmed = true')}, report)
    assert(STARTED.name == 'make_fire')
    assert(STARTED.args.recipe == 'campfire', '默认应是 campfire')
  `)
})

test('M5：build_structure 配方白名单只有 campfire', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    CURRENT = 'build'
    BWS2.actionExecutor.execute(${cmd('build_structure', ', recipe = "campfire", confirmed = true')}, report)
    assert(STARTED.name == 'build')
  `)
  const { run: bad } = load(fengari)
  bad(`
    BWS2.actionExecutor.execute(${cmd('build_structure', ', recipe = "wall_stone", confirmed = true')}, report)
    assert(STARTED == nil, '白名单外配方应被拒')
    assert(string.find(REPORTS[1].error, 'invalid_recipe', 1, true) ~= nil)
  `)
})

test('M5：进食完成后 verify 带饥饿前后差（真核验）', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    PLAYER.components.hunger = { current = 100, max = 200 }
    ITEMS = { { prefab = 'berries', n = 1 } }
    PLAYER.components.inventory = make_inventory()
    CURRENT = 'eat'
    BWS2.actionExecutor.execute(${cmd('eat_item', ', item = "berries", confirmed = true')}, report)
    -- 模拟吃完：饥饿从 100 涨到 125
    PLAYER.components.hunger.current = 125
    Whale.bridge.Report(true, '吃了 浆果，饥饿 +25')
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    local v = REPORTS[2].result.verify
    assert(v ~= nil, 'SUCCEEDED 应带 verify')
    assert(v.hunger_before == 100, '记录前值，实际 ' .. tostring(v.hunger_before))
    assert(v.hunger_after == 125)
    assert(v.hunger_delta == 25, 'delta 应为 25，实际 ' .. tostring(v.hunger_delta))
    assert(v.confirmed_gain == true)
  `)
})

test('M5：进食没涨饥饿时 confirmed_gain=false（不假装吃到）', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    PLAYER.components.hunger = { current = 100, max = 200 }
    ITEMS = { { prefab = 'berries', n = 1 } }
    PLAYER.components.inventory = make_inventory()
    CURRENT = 'eat'
    BWS2.actionExecutor.execute(${cmd('eat_item', ', confirmed = true')}, report)
    PLAYER.components.hunger.current = 100   -- 没变
    Whale.bridge.Report(true, '吃了 浆果')
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    local v = REPORTS[2].result.verify
    assert(v.hunger_delta == 0)
    assert(v.confirmed_gain == false, '饥饿没涨必须如实标 false')
  `)
})

test('M5：制作完成后 verify 清点背包成品', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    ITEMS = {}
    PLAYER.components.inventory = make_inventory()
    CURRENT = 'craft'
    BWS2.actionExecutor.execute(${cmd('craft_item', ', recipe = "axe", count = 1, confirmed = true')}, report)
    -- 模拟做完：背包多了一把斧头
    ITEMS = { { prefab = 'axe', n = 1 } }
    Whale.bridge.Report(true, '做了 1 个 axe')
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    local v = REPORTS[2].result.verify
    assert(v.gained.axe == 1, '应清点到 axe +1，实际 ' .. tostring(v.gained.axe))
    assert(v.confirmed_gain == true)
  `)
})

test('M5：营火核验 —— 附近有 fire 实体才算成功', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    FIRE = { HasTag = function(self, tag) return tag == 'fire' end }
    CURRENT = 'make_fire'
    BWS2.actionExecutor.execute(${cmd('build_campfire', ', confirmed = true')}, report)
    Whale.bridge.Report(true, '摆了营火，火已经生起来了')
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    local v = REPORTS[2].result.verify
    assert(v.fire_found == true, '应核验到 fire')
    assert(v.confirmed_gain == true)
  `)
  const { run: noFire } = load(fengari)
  noFire(`
    FIRE = nil
    CURRENT = 'make_fire'
    BWS2.actionExecutor.execute(${cmd('build_campfire', ', confirmed = true')}, report)
    Whale.bridge.Report(true, '摆了营火')
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    local v = REPORTS[2].result.verify
    assert(v.fire_found == false, '没火必须如实标 false')
    assert(v.confirmed_gain == false)
  `)
})

test('M5：status() 暴露 12 个写动作（M2 2 + M3 2 + M4 4 + M5 4）', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    local s = BWS2.actionExecutor.status()
    assert(#s.known_actions == 13, '写动作应 13 个（Phase 6 加了 heal_self），实际 ' .. tostring(#s.known_actions))
    for _, k in ipairs({ 'eat_item', 'craft_item', 'build_structure', 'build_campfire' }) do
      assert(s.write_actions[k] == true, k .. ' 应标为写动作')
    end
  `)
})

test('M5 回归：best_food 不选零/负收益的"食物"（真机踩到把树枝当饭吃）', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    -- 背包里只有树枝：DST 里 twigs 有 edible 但 hungervalue = 0
    ITEMS = { { prefab = 'twigs', n = 4, hungervalue = 0 } }
    PLAYER.components.inventory = {
      ForEachItem = function(self, fn)
        for _, it in ipairs(ITEMS) do
          fn({ prefab = it.prefab,
               components = { stackable = { StackSize = function() return it.n end },
                              edible = { hungervalue = it.hungervalue, healthvalue = 0 } } })
        end
      end,
      GetEquippedItem = function() return nil end,
    }
    CURRENT = 'eat'
    BWS2.actionExecutor.execute({ id = 'c1', type = 'eat_item',
      params = { controller_id = 'C1', session_id = 'S1', confirmed = true } }, report)
    -- 动作层应该自己失败：没有正收益食物
    Whale.bridge.Report(false, '背包里没有能吃的东西')
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    assert(REPORTS[2].status == 'FAILED', '没有真食物时应 FAILED，实际 ' .. tostring(REPORTS[2].status))
    assert(string.find(tostring(REPORTS[2].error), '没有能吃', 1, true) ~= nil,
      '应如实说没有能吃的东西，实际 ' .. tostring(REPORTS[2].error))
  `)
})
