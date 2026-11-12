// Phase 1 / 里程碑 3+4：player_observer / inventory_observer / world_observer / 组装后的 state
// 做法和里程碑 2 一样：真 Lua 虚拟机 + 饥荒沙箱规则（把 pcall/tonumber/next/os/io 置 nil）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')
const LEGACY_HOME = join(ROOT, 'archive', 'phase-a')

const PRELUDE = `
CAPTURED = {}
PERIODIC = nil
PERIOD_INTERVAL = nil

GLOBAL = {}
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.next = next
GLOBAL.io = nil
GLOBAL.os = { time = function() return 1794410000 end }
GLOBAL.TheSim = { GetRealTime = function() return 42500 end, GetTick = function() return 12345 end }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "S1" end }
GLOBAL.STRINGS = {
    NAMES = { AXE = "斧头", BERRIES = "浆果", WILLOW = "薇洛" },
    CHARACTER_NAMES = { WILLOW = "薇洛" },
}
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }

-- ── 假物品 ──
local function item(prefab, comps)
    local it = { prefab = prefab, components = comps or {} }
    function it:IsValid() return true end
    return it
end

local axe = item("axe", {
    finiteuses = { total = 50, GetUses = function(self) return 40 end },
})
local berries = item("berries", {
    stackable = { StackSize = function(self) return 6 end },
    perishable = { GetPercent = function(self) return 0.9 end },
})
local torch = item("torch", {
    finiteuses = { total = 60, GetUses = function(self) return 30 end },
})

-- ── 假背包 ──
local function inventory(slots, equipped)
    local inv = { _slots = slots, _equipped = equipped }
    function inv:GetNumSlots() return 15 end
    function inv:GetItemInSlot(slot) return self._slots[slot] end
    function inv:GetEquippedItem(eslot) return self._equipped[eslot] end
    function inv:IsFull() return false end
    return inv
end

-- ── 假玩家 ──
local player = {
    prefab = "willow",
    GUID = 100234,
    userid = "KU_ABC",
    components = {
        health = {
            currenthealth = 120, maxhealth = 150,
            GetPercent = function(self) return self.currenthealth / self.maxhealth end,
            IsDead = function(self) return false end,
        },
        hunger = { current = 100, max = 150, GetPercent = function(self) return self.current / self.max end },
        sanity = { current = 180, max = 200, GetPercent = function(self) return self.current / self.max end },
        temperature = { GetCurrent = function(self) return 21.34 end },
        moisture = {
            GetMoisture = function(self) return 7.5 end,
            GetMoisturePercent = function(self) return 0.075 end,
        },
        inventory = inventory({ [1] = axe, [2] = berries, [4] = axe }, { hands = torch }),
    },
}
function player:IsValid() return true end
function player:HasTag(tag) return tag == "player" end
player.Transform = { GetWorldPosition = function(self) return 48.5, 0, 180.25 end }

GLOBAL.AllPlayers = { ["KU_ABC"] = player }

GLOBAL.TheWorld = {
    prefab = "forest",
    ismastersim = true,
    state = {
        cycles = 4,
        phase = "day",
        isday = true, isdusk = false, isnight = false,
        season = "autumn",
        isautumn = true, iswinter = false, isspring = false, issummer = false,
        elapseddaysinseason = 4, remainingdaysinseason = 16, seasonprogress = 0.2,
        temperature = 22.6,
        time = 0.25, timeinphase = 0.5,
        israining = false, precipitation = 0, precipitationrate = 0.5,
        wetness = 0, iswet = false,
        issnowing = false, snowlevel = 0, issnowcovered = false,
        isacidraining = false,
        moonphase = "quarter", isfullmoon = false, isnewmoon = false, iswaxingmoon = true,
    },
    HasTag = function(self, tag) return false end,
    DoPeriodicTask = function(self, interval, fn)
        PERIODIC = fn
        PERIOD_INTERVAL = interval
    end,
}

env = { GetModConfigData = function(key) if key == "OBSERVER_INTERVAL" then return 1 end end }
modname = "BlindWhaleSurvivor"
print = function(text) CAPTURED[#CAPTURED + 1] = text end

-- 模拟沙箱
pcall = nil
tonumber = nil
error = nil
next = nil
os = nil
io = nil
`

const FILES = [
    'scripts/main/json_encoder.lua',
    'scripts/main/player_observer.lua',
    'scripts/main/inventory_observer.lua',
    'scripts/main/world_observer.lua',
    'scripts/main/state_serializer.lua',
    'scripts/main/observer_manager.lua',
]

function load(fengari) {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const fail = () => {
    try {
      return to_jsstring(lua.lua_tostring(L, -1))
    } catch {
      return ''
    }
  }
  let status = lauxlib.luaL_dostring(L, to_luastring(PRELUDE))
  assert.equal(status, lua.LUA_OK, '前置环境出错：' + fail())
  for (const file of FILES) {
    status = lauxlib.luaL_dostring(L, to_luastring(readFileSync(join(LEGACY_HOME, file), 'utf8')))
    assert.equal(status, lua.LUA_OK, `${file} 加载失败：` + fail())
  }
  const run = (code) => {
    status = lauxlib.luaL_dostring(L, to_luastring(code))
    assert.equal(status, lua.LUA_OK, '运行出错：' + fail())
  }
  // 读一个 Lua 全局变量：读完必须把栈上的值弹掉，否则连续读第二个会拿到空串
  const global = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    const top = lua.lua_gettop(L)
    try {
      return lua.lua_tojsstring(L, -1) ?? ''
    } catch {
      return ''
    } finally {
      lua.lua_settop(L, top - 1)
    }
  }
  const json = (luaCode, outVar = 'OUT') => {
    run(`${outVar} = BWS.json.encode(${luaCode})`)
    return JSON.parse(global(outVar))
  }
  const lines = () => {
    run('CAPN = #CAPTURED')
    const total = Number(global('CAPN')) || 0
    const out = []
    for (let i = 1; i <= total; i += 1) {
      run(`CAPITEM = CAPTURED[${i}]`)
      const line = global('CAPITEM')
      assert.ok(line.startsWith('[BWS] '), '日志行必须以 [BWS] 开头：' + line)
      try {
        out.push(JSON.parse(line.slice('[BWS] '.length)))
      } catch (error) {
        throw new Error('日志里的 JSON 解析失败：' + line)
      }
    }
    return out
  }

  return { run, global, json, lines, fail }
}

test('player_observer：身份/坐标/三围/体温/潮湿都对得上', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run('P = BWS.player_observer.Observe(GLOBAL.AllPlayers["KU_ABC"], "server")')
  const p = t.json('P')

  assert.equal(p.valid, true)
  assert.equal(p.prefab, 'willow')
  assert.equal(p.name, '薇洛')          // STRINGS.CHARACTER_NAMES
  assert.equal(p.guid, 100234)
  assert.equal(p.userid, 'KU_ABC')
  assert.equal(p.is_ghost, false)

  assert.deepEqual(p.position, { x: 48.5, y: 0, z: 180.25, tile_x: 12, tile_z: 45 })
  assert.deepEqual(p.health, { current: 120, max: 150, percent: 80, dead: false })
  assert.deepEqual(p.hunger, { current: 100, max: 150, percent: 66.7 })
  assert.deepEqual(p.sanity, { current: 180, max: 200, percent: 90 })
  assert.deepEqual(p.temperature, { current: 21.3 })
  assert.deepEqual(p.moisture, { value: 7.5, percent: 7.5 })
})

test('player_observer：无效实体 / 客户端侧 都拒绝观察', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run('R1, E1 = BWS.player_observer.Observe(nil, "server")')
  t.run('R2, E2 = BWS.player_observer.Observe(GLOBAL.AllPlayers["KU_ABC"], "client")')
  t.run('GLOBAL.AllPlayers["KU_ABC"].IsValid = function() return false end')
  t.run('R3, E3 = BWS.player_observer.Observe(GLOBAL.AllPlayers["KU_ABC"], "server")')
  t.run('OUT3 = tostring(E1) .. "|" .. tostring(E2) .. "|" .. tostring(E3)')
  assert.equal(t.global('OUT3'), 'no_player|not_server_side|player_invalid')
})

test('inventory_observer：格子内容、数量、耐久、新鲜度、装备', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run('I = BWS.inventory_observer.Observe(GLOBAL.AllPlayers["KU_ABC"])')
  const inv = t.json('I')

  assert.equal(inv.slots, 15)
  assert.equal(inv.used, 3)
  assert.equal(inv.is_full, false)
  assert.equal(inv.items.length, 3)

  const [first, second, third] = inv.items
  assert.equal(first.slot, 1)
  assert.equal(first.prefab, 'axe')
  assert.equal(first.name, '斧头')
  assert.equal(first.count, 1)
  assert.equal(first.uses_left, 40)
  assert.equal(first.uses_max, 50)

  assert.equal(second.slot, 2)
  assert.equal(second.prefab, 'berries')
  assert.equal(second.name, '浆果')
  assert.equal(second.count, 6)
  assert.equal(second.freshness, 90)

  assert.equal(third.slot, 4)

  assert.equal(inv.equipment.hands.prefab, 'torch')
  assert.equal(inv.equipment.hands.uses_left, 30)
  assert.equal(inv.equipment.hands.uses_max, 60)
  assert.equal(inv.equipment.head, undefined, '没戴东西就不该有这个键')
})

test('world_observer：天数/昼夜/季节/天气/月亮，day = cycles + 1', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run('W = BWS.world_observer.Observe()')
  const w = t.json('W')

  assert.equal(w.prefab, 'forest')
  assert.equal(w.shard, 'master')
  assert.equal(w.cycles, 4)
  assert.equal(w.day, 5, 'cycles=4 时玩家看到的是第 5 天')
  assert.equal(w.phase, 'day')
  assert.equal(w.is_day, true)
  assert.equal(w.is_dusk, false, 'false 也要写出来，不能因为假值丢掉')
  assert.equal(w.is_night, false)
  assert.equal(w.season, 'autumn')
  assert.equal(w.is_autumn, true)
  assert.equal(w.elapsed_days_in_season, 4)
  assert.equal(w.remaining_days_in_season, 16)
  assert.equal(w.season_progress, 0.2)
  assert.equal(w.temperature, 22.6)
  assert.deepEqual(w.time, { of_day: 0.25, in_phase: 0.5 })
  assert.equal(w.weather.is_raining, false)
  assert.equal(w.weather.is_snowing, false)
  assert.equal(w.weather.wetness, 0)
  assert.equal(w.moon.phase, 'quarter')
  assert.equal(w.moon.is_full_moon, false)
  assert.equal(w.cave, undefined, '地面分片不该出现洞穴字段')
})

test('world_observer：洞穴分片才带 cave 字段', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`
    GLOBAL.TheWorld.state.cavephase = "night"
    GLOBAL.TheWorld.state.iscaveday = false
    GLOBAL.TheWorld.state.iscavedusk = false
    GLOBAL.TheWorld.state.iscavenight = true
    GLOBAL.TheWorld.state.cavemoonphase = "full"
    GLOBAL.TheWorld.HasTag = function(self, tag) return tag == "cave" end
    W = BWS.world_observer.Observe()
  `)
  const w = t.json('W')
  assert.equal(w.shard, 'caves')
  assert.equal(w.cave.phase, 'night')
  assert.equal(w.cave.is_night, true)
  assert.equal(w.cave.moon_phase, 'full')
})

test('state：一条日志带齐 session/player/inventory/world/observer', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run('BWS.observer.Start(); PERIODIC()')
  const all = t.lines()
  assert.equal(all.length, 2, '一条 boot + 一条 state')

  const boot = all[0]
  assert.equal(boot.type, 'boot')
  assert.equal(boot.side, 'server')
  assert.equal(boot.shard, 'master')
  assert.equal(boot.players.count, 1)

  const state = all[1]
  assert.equal(state.type, 'state')
  assert.equal(state.schema_version, '1')
  assert.equal(state.session, 'S1')
  assert.equal(state.t, 1794410000)
  assert.equal(state.rt, 42.5)
  assert.equal(state.sim_tick, 12345)
  assert.equal(state.side, 'server')

  assert.equal(state.player.prefab, 'willow')
  assert.equal(state.inventory.used, 3)
  assert.equal(state.world.day, 5)

  assert.equal(state.observer.interval, 1)
  assert.equal(state.observer.tick, 1)
  assert.equal(state.observer.errors, 0)
  assert.equal(state.observer.players.count, 1)
  assert.equal(state.observer.problems, undefined, '一切正常时不该有 problems')
})

test('state：没有玩家时给出 problems.player，其它部分照常输出', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run('GLOBAL.AllPlayers = {}')
  t.run('BWS.observer.Start(); PERIODIC()')
  const state = t.lines()[1]
  assert.equal(state.player, undefined)
  assert.equal(state.inventory, undefined)
  assert.equal(state.observer.problems.player, 'no_player')
  assert.equal(state.observer.players.count, 0)
  assert.equal(state.world.day, 5, '世界部分不该受影响')
})
