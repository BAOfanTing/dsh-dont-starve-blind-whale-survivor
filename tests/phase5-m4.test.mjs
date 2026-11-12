// Phase 5 M4 · 工具使用系统 Lua 沙箱测试
//
// 覆盖：equip/chop/mine/pickup 映射、装备与目标白名单、**人工确认程序层强制**、
//       掉落物清点（背包前后差）、装备核验、三路互守（KeepAlive 存在且可调用）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')
const LEGACY_HOME = join(ROOT, 'archive', 'phase-a')

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
GLOBAL.ACTIONS = { PICK = {}, HARVEST = {}, CHOP = {}, MINE = {}, DIG = {}, EAT = {}, PICKUP = {} }
GLOBAL.EQUIPSLOTS = { HANDS = 'hands' }

-- 假背包：ITEMS = { {prefab='log', n=2}, ... }
ITEMS = {}
EQUIPPED = nil
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
    util = { player = function() return PLAYER end, pos = function() return 10, 0, 20 end, log = function() end },
    actions = {
        Start = function(name, args) STARTED = { name = name, args = args }; return true, nil end,
        Current = function() return CURRENT, CURRENT_ARGS end,
        Known = function() return { "chop", "equip", "go_to", "mine", "pick", "pickup", "stop" } end,
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
    components = { health = { IsDead = function() return false end }, locomotor = { Stop = function() end },
                  inventory = nil },
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
  run(readFileSync(join(LEGACY_HOME, 'scripts', 'main', 'action_executor.lua'), 'utf8'), 'action_executor.lua')
  return { run }
}

const cmd = (type, params) => `{ id = "c1", type = "${type}",
  params = { controller_id = "C1", session_id = "S1" ${params} } }`

test('M4：equip_item 映射到 equip，item 走白名单', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    ITEMS = { { prefab = 'axe', n = 1 } }
    CURRENT = 'equip'
    BWS2.actionExecutor.execute(${cmd('equip_item', ', item = "axe"')}, report)
    assert(STARTED ~= nil, '应启动')
    assert(STARTED.name == 'equip')
    assert(STARTED.args.item == 'axe')
    assert(REPORTS[1].status == 'EXECUTING')
  `)
})

test('M4：equip_item 拒绝白名单外的物品（不许装备任意东西）', async () => {
  const fengari = await import('fengari')
  for (const bad of ['"spear"', '"nightsword"', '"armorwood"']) {
    const { run } = load(fengari)
    run(`
      BWS2.actionExecutor.execute(${cmd('equip_item', `, item = ${bad}`)}, report)
      assert(STARTED == nil, '不该启动')
      assert(REPORTS[1].status == 'FAILED')
      assert(string.find(REPORTS[1].error, 'invalid_argument', 1, true) ~= nil)
    `)
  }
})

test('M4：chop_tree / mine_rock 未确认 → confirmation_required（程序层强制）', async () => {
  const fengari = await import('fengari')
  for (const type of ['chop_tree', 'mine_rock']) {
    const { run } = load(fengari)
    run(`
      BWS2.actionExecutor.execute(${cmd(type, ', count = 1')}, report)
      assert(STARTED == nil, '${type} 未确认不该启动')
      assert(REPORTS[1].status == 'FAILED')
      assert(string.find(REPORTS[1].error, 'confirmation_required', 1, true) ~= nil,
        '应报 confirmation_required，实际 ' .. tostring(REPORTS[1].error))
    `)
  }
})

test('M4：chop_tree / mine_rock 确认后正常启动', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    CURRENT = 'chop'
    BWS2.actionExecutor.execute(${cmd('chop_tree', ', count = 2, radius = 10, confirmed = true')}, report)
    assert(STARTED.name == 'chop')
    assert(STARTED.args.count == 2 and STARTED.args.radius == 10)
  `)
  const { run: run2 } = load(fengari)
  run2(`
    CURRENT = 'mine'
    BWS2.actionExecutor.execute(${cmd('mine_rock', ', count = 1, confirmed = true')}, report)
    assert(STARTED.name == 'mine')
  `)
})

test('M4：chop/mine 目标白名单（chop 不认 rock，mine 不认 tree）', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    BWS2.actionExecutor.execute(${cmd('chop_tree', ', target = "rock1", confirmed = true')}, report)
    assert(STARTED == nil)
    assert(string.find(REPORTS[1].error, 'invalid_target', 1, true) ~= nil)
  `)
  const { run: run2 } = load(fengari)
  run2(`
    BWS2.actionExecutor.execute(${cmd('mine_rock', ', target = "evergreen", confirmed = true')}, report)
    assert(STARTED == nil)
    assert(string.find(REPORTS[1].error, 'invalid_target', 1, true) ~= nil)
  `)
})

test('M4：chop/mine count 上限 5（比采集更严）', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    CURRENT = 'chop'
    BWS2.actionExecutor.execute(${cmd('chop_tree', ', count = 99, confirmed = true')}, report)
    assert(STARTED.args.count == 5, '应夹到 5，实际 ' .. tostring(STARTED.args.count))
  `)
})

test('M4：pick_up_item 映射到 pickup，item 走白名单', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    CURRENT = 'pickup'
    BWS2.actionExecutor.execute(${cmd('pick_up_item', ', item = "flint", count = 3')}, report)
    assert(STARTED.name == 'pickup')
    assert(STARTED.args.item == 'flint')
    assert(STARTED.args.count == 3)
  `)
  const { run: run2 } = load(fengari)
  run2(`
    BWS2.actionExecutor.execute(${cmd('pick_up_item', ', item = "goldnugget"')}, report)
    assert(STARTED == nil, '白名单外物品应被拒')
    assert(string.find(REPORTS[1].error, 'invalid_argument', 1, true) ~= nil)
  `)
})

test('M4：砍树完成后清点背包，verify.gained 记录实际获得数量', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    ITEMS = {}
    PLAYER.components.inventory = make_inventory()
    CURRENT = 'chop'
    BWS2.actionExecutor.execute(${cmd('chop_tree', ', count = 1, confirmed = true')}, report)
    -- 模拟砍完：背包多了 2 个 log、1 个 twigs
    ITEMS = { { prefab = 'log', n = 2 }, { prefab = 'twigs', n = 1 } }
    Whale.bridge.Report(true, '连着干了 1 次')
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    assert(#REPORTS == 2, 'EXECUTING + 终态')
    assert(REPORTS[2].status == 'SUCCEEDED')
    local v = REPORTS[2].result.verify
    assert(v ~= nil, 'SUCCEEDED 应带 verify')
    assert(v.gained.log == 2, 'log +2，实际 ' .. tostring(v.gained.log))
    assert(v.gained.twigs == 1)
    assert(v.confirmed_gain == true)
  `)
})

test('M4：采矿完成后 verify.gained 记录 rocks/flint', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    ITEMS = {}
    PLAYER.components.inventory = make_inventory()
    CURRENT = 'mine'
    BWS2.actionExecutor.execute(${cmd('mine_rock', ', count = 1, confirmed = true')}, report)
    ITEMS = { { prefab = 'rocks', n = 3 }, { prefab = 'flint', n = 1 } }
    Whale.bridge.Report(true, '连着干了 1 次')
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    local v = REPORTS[2].result.verify
    assert(v.gained.rocks == 3, 'rocks +3，实际 ' .. tostring(v.gained.rocks))
    assert(v.gained.flint == 1)
  `)
})

test('M4：装备完成后核验手上实际装备的 prefab', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    ITEMS = { { prefab = 'axe', n = 1 } }
    PLAYER.components.inventory = make_inventory()
    EQUIPPED = nil
    CURRENT = 'equip'
    BWS2.actionExecutor.execute(${cmd('equip_item', ', item = "axe"')}, report)
    EQUIPPED = { prefab = 'axe' }
    Whale.bridge.Report(true, '把 斧头 拿在手里了')
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    local v = REPORTS[2].result.verify
    assert(v.equipped == 'axe', '实际装备 ' .. tostring(v.equipped))
    assert(v.requested == 'axe')
    assert(v.confirmed_gain == true)
  `)
})

test('M4：装备失败时 verify.confirmed_gain=false（不假装成功）', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    ITEMS = { { prefab = 'axe', n = 1 } }
    PLAYER.components.inventory = make_inventory()
    EQUIPPED = { prefab = 'torch' }   -- 手上其实是火把
    CURRENT = 'equip'
    BWS2.actionExecutor.execute(${cmd('equip_item', ', item = "axe"')}, report)
    Whale.bridge.Report(true, '把 斧头 拿在手里了')
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    local v = REPORTS[2].result.verify
    assert(v.equipped == 'torch')
    assert(v.confirmed_gain == false, '核验不一致必须如实标 false')
  `)
})

test('M4：status() 暴露 8 个写动作（M2 2 + M3 2 + M4 4）', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    local s = BWS2.actionExecutor.status()
    assert(#s.known_actions == 13, '写动作应 13 个（Phase 6 加了 heal_self），实际 ' .. tostring(#s.known_actions))
    for _, k in ipairs({ 'equip_item', 'chop_tree', 'mine_rock', 'pick_up_item' }) do
      assert(s.write_actions[k] == true, k .. ' 应标为写动作')
    end
  `)
})

test('M4：三路互守 —— 归档后的 A 栈互守保留，B 栈不再依赖 A 栈', async () => {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, label) => {
    const st = lauxlib.luaL_dostring(L, to_luastring(code))
    if (st !== lua.LUA_OK) {
      let m = ''
      try { m = to_jsstring(lua.lua_tostring(L, -1)) } catch {}
      throw new Error(`${label}: ${m}`)
    }
  }
  // 只检查源码里三处互守调用是否都接上了（避免搭整套文件桥+观察器 stub）
  const net = readFileSync(join(LEGACY_HOME, 'scripts', 'main', 'net.lua'), 'utf8')
  const obs = readFileSync(join(LEGACY_HOME, 'scripts', 'main', 'observer_manager.lua'), 'utf8')
  const brg = readFileSync(join(MOD, 'scripts', 'whale', 'bridge.lua'), 'utf8')
  // 归档的 A 栈自己那套互守原样保留（将来要复活某一段时还能用）
  assert.match(net, /function N\.keepAlive/, 'net.lua 应有 keepAlive')
  assert.match(obs, /function O\.KeepAlive/, 'observer_manager.lua 应有 KeepAlive')
  assert.match(obs, /Whale\.bridge\.KeepAlive/, '观察器应反向守护文件桥')
  assert.match(brg, /function B\.KeepAlive/, 'bridge.lua 应有 KeepAlive')
  // M1.0 收敛后的新事实：B 栈（scripts/whale）不再引用 A 栈的全局（BWS/BWS2），
  // 否则两条链又会互相拉起，谁都能对同一个角色下发动作。
  assert.doesNotMatch(brg, /BWS2\.net\.keepAlive/, 'M1.0 之后文件桥不该再拉 A 栈的 net')
  assert.doesNotMatch(brg, /BWS\.observer\.KeepAlive/, 'M1.0 之后文件桥不该再拉 A 栈的观察器')
  assert.doesNotMatch(brg, /BWS2/, 'M1.0 之后文件桥里不该出现 BWS2')
  assert.ok(true)
})
