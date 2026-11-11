// Phase 1 / 里程碑 5：附近实体扫描（分类 / 距离 / 上限 / 缓存周期）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const PRELUDE = `
CAPTURED = {}
PERIODIC = nil
PERIOD_INTERVAL = nil
FIND_CALLS = 0
NEARBY_ENTS = {}

GLOBAL = {}
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.next = next
GLOBAL.io = nil
GLOBAL.os = { time = function() return 1794410000 end }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "S1" end }
GLOBAL.STRINGS = { NAMES = { EVERGREEN = "常青树", ROCK1 = "巨石", BERRYBUSH = "浆果丛",
                             SPIDER = "蜘蛛", LOG = "木头", CHEST = "箱子", WILLOW = "薇洛" },
                   CHARACTER_NAMES = { WILLOW = "薇洛" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.TheSim = {
    GetRealTime = function() return 42500 end,
    GetTick = function() return 12345 end,
    FindEntities = function(self, x, y, z, radius, must, cant, oneof)
        FIND_CALLS = FIND_CALLS + 1
        LAST_RADIUS = radius
        return NEARBY_ENTS
    end,
}

local function acting(id) return { id = id } end
-- 让 workable.action.id 和游戏里一致
WORKABLE = { CHOP = acting("CHOP"), MINE = acting("MINE"), DIG = acting("DIG"), HAMMER = acting("HAMMER") }

function ent(prefab, x, z, tags, comps, valid)
    local e = { prefab = prefab, components = comps or {}, _tags = {}, _x = x, _z = z, _valid = valid ~= false }
    for _, tag in ipairs(tags or {}) do e._tags[tag] = true end
    function e:IsValid() return self._valid end
    function e:HasTag(tag) return self._tags[tag] == true end
    e.Transform = { GetWorldPosition = function() return e._x, 0, e._z end }
    return e
end

PLAYER = ent("willow", 40, 40, { "player" }, {
    health = { currenthealth = 150, maxhealth = 150, GetPercent = function() return 1 end, IsDead = function() return false end },
    hunger = { current = 150, max = 150, GetPercent = function() return 1 end },
    sanity = { current = 120, max = 120, GetPercent = function() return 1 end },
    temperature = { GetCurrent = function() return 20 end },
    moisture = { GetMoisture = function() return 0 end, GetMoisturePercent = function() return 0 end },
    inventory = {
        GetNumSlots = function() return 15 end,
        GetItemInSlot = function() return nil end,
        GetEquippedItem = function() return nil end,
        IsFull = function() return false end,
    },
})
GLOBAL.AllPlayers = { ["KU_1"] = PLAYER }

GLOBAL.TheWorld = {
    prefab = "world",
    ismastersim = true,
    state = { cycles = 1, phase = "day", isday = true, season = "autumn", temperature = 20 },
    HasTag = function(self, tag) return false end,
    DoPeriodicTask = function(self, interval, fn) PERIODIC = fn; PERIOD_INTERVAL = interval end,
}

-- 附近的东西：树×3、石头、浆果丛、蜘蛛、地上的木头、箱子、一个无效实体、一个不关心的特效
local bush = ent("berrybush", 44, 40, { "pickable" }, { pickable = {} })
NEARBY_ENTS = {
    PLAYER,                                                   -- 自己：不该出现在结果里
    ent("evergreen", 56, 40, {}, { workable = { action = WORKABLE.CHOP, workleft = 7 } }),
    ent("evergreen", 60, 40, {}, { workable = { action = WORKABLE.CHOP, workleft = 7 } }),
    ent("evergreen", 64, 40, {}, { workable = { action = WORKABLE.CHOP, workleft = 7 } }),
    ent("rock1", 40, 56, {}, { workable = { action = WORKABLE.MINE, workleft = 9 } }),
    bush,
    ent("berrybush", 40, 60, { "pickable", "barren" }, { pickable = {} }),   -- 采空了：不算
    ent("spider", 48, 48, { "hostile", "monster" }, {
        health = { GetPercent = function() return 0.75 end, IsDead = function() return false end },
        combat = {},
    }),
    ent("log", 42, 42, {}, { inventoryitem = { owner = nil } }),
    ent("chest", 36, 36, { "structure" }, {}),
    ent("evergreen", 100, 100, {}, {}, false),                 -- 无效实体：跳过
    ent("fx_thing", 41, 41, {}, {}),                           -- 不认识的：跳过
}

env = { GetModConfigData = function(key)
    if key == "OBSERVER_INTERVAL" then return 1 end
    if key == "OBSERVER_SCAN_RADIUS" then return 16 end
    if key == "OBSERVER_SCAN_SECONDS" then return 4 end
end }
modname = "BlindWhaleSurvivor"
print = function(text) CAPTURED[#CAPTURED + 1] = text end

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
  'scripts/main/entity_observer.lua',
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
    status = lauxlib.luaL_dostring(L, to_luastring(readFileSync(join(MOD, file), 'utf8')))
    assert.equal(status, lua.LUA_OK, `${file} 加载失败：` + fail())
  }
  const run = (code) => {
    status = lauxlib.luaL_dostring(L, to_luastring(code))
    assert.equal(status, lua.LUA_OK, '运行出错：' + fail())
  }
  // 读全局变量：读完必须弹栈，否则连续读第二个会拿到空串
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
      out.push(JSON.parse(line.slice('[BWS] '.length)))
    }
    return out
  }
  return { run, global, json, lines }
}

test('实体扫描：分类、距离、玩家自己排除、无效实体过滤', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run('N = BWS.entity_observer.Observe(GLOBAL.AllPlayers["KU_1"], { radius_tiles = 16 })')
  const nearby = t.json('N')

  assert.equal(nearby.radius_tiles, 16)
  assert.equal(nearby.scanned, 12, 'FindEntities 返回了多少个就记多少个')
  assert.equal(nearby.truncated, false)

  const byPrefab = {}
  for (const e of nearby.entities) {
    if (!byPrefab[e.prefab]) byPrefab[e.prefab] = []
    byPrefab[e.prefab].push(e)
  }
  assert.ok(!nearby.entities.some((e) => e.prefab === 'willow'), '玩家自己不该出现在附近列表里')
  assert.ok(!nearby.entities.some((e) => e.prefab === 'fx_thing'), '不认识的实体跳过')
  assert.equal(byPrefab.evergreen.length, 3, '无效的那棵树被过滤掉，剩 3 棵')
  assert.equal(byPrefab.berrybush.length, 1, 'barren 的浆果丛不算能采')

  const tree = byPrefab.evergreen[0]
  assert.equal(tree.category, 'tree')
  assert.equal(tree.name, '常青树')
  assert.equal(tree.work_left, 7)
  assert.equal(tree.tile_x, 14) // 56/4
  assert.equal(tree.tile_z, 10) // 40/4
  assert.equal(tree.distance, 4) // (56-40)/4

  const rock = byPrefab.rock1[0]
  assert.equal(rock.category, 'rock')
  assert.equal(rock.name, '巨石')

  const spider = byPrefab.spider[0]
  assert.equal(spider.category, 'hostile')
  assert.equal(spider.hp, 75, '敌对单位带上血量百分比')

  const log = byPrefab.log[0]
  assert.equal(log.category, 'item')
  assert.equal(log.name, '木头')

  const chest = byPrefab.chest[0]
  assert.equal(chest.category, 'structure')
  assert.equal(chest.name, '箱子')

  assert.deepEqual(nearby.counts, { tree: 3, rock: 1, harvestable: 1, hostile: 1, item: 1, structure: 1 })
})

test('实体扫描：半径和数量上限都会夹住，truncated 标出来', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run('N = BWS.entity_observer.Observe(GLOBAL.AllPlayers["KU_1"], { radius_tiles = 999, max_entities = 2, per_category = 1 })')
  const nearby = t.json('N')
  assert.equal(nearby.radius_tiles, 40, '半径上限 40 格')
  assert.ok(nearby.entities.length <= 2, 'max_entities 生效')
  assert.equal(nearby.truncated, true, '被截断要标出来')
  const categories = nearby.entities.map((e) => e.category)
  assert.equal(new Set(categories).size, categories.length, '每类只留 1 个（per_category = 1）')
})

test('实体扫描：FindEntities 的半径按“格 × 4”传', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run('BWS.entity_observer.Observe(GLOBAL.AllPlayers["KU_1"], { radius_tiles = 10 })')
  t.run('RAD = tostring(LAST_RADIUS)')
  assert.equal(t.global('RAD'), '40', '10 格 = 40 世界单位')
})

test('nearby 是独立记录，按扫描间隔刷新（不每帧扫）', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run('BWS.observer.Start()')
  // interval=1s，scan_seconds=4 → 每 4 个周期扫一次
  t.run('PERIODIC()')
  t.run('F1 = tostring(FIND_CALLS)')
  t.run('PERIODIC(); PERIODIC()')
  t.run('F2 = tostring(FIND_CALLS)')
  t.run('PERIODIC(); PERIODIC()')
  t.run('F3 = tostring(FIND_CALLS)')

  assert.equal(t.global('F1'), '1', '第一周期就该扫一次')
  assert.equal(t.global('F2'), '1', '接下来两周期用缓存，不该再扫')
  assert.equal(t.global('F3'), '2', '第 5 个周期（1+4）再扫一次')

  const all = t.lines()
  const states = all.filter((r) => r.type === 'state')
  const nearbys = all.filter((r) => r.type === 'nearby')
  assert.ok(states.length >= 5)
  assert.equal(nearbys.length, states.length, '每个周期都发一条 nearby（内容是缓存）')
  assert.ok(!('entities' in states[0]), 'state 记录里不该塞实体（日志有长度上限）')

  const ticks = nearbys.map((r) => r.scanned_at_tick)
  assert.deepEqual(ticks.slice(0, 5), [1, 1, 1, 1, 5], '只有第 1、5 周期真正重扫')
  assert.equal(nearbys[0].returned, 8)
  assert.equal(nearbys[0].radius_tiles, 16)
  assert.equal(states[0].observer.errors, 0)
})

test('分类优先级：能采的优先于“能铲”，建筑不算生物', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`
    NEARBY_ENTS = {
        -- 草：既能采（pickable）也能用铲子挖（workable DIG）
        ent("grass", 44, 40, { "pickable" }, { pickable = {}, workable = { action = WORKABLE.DIG, workleft = 1 } }),
        -- 南瓜灯这种：有 health + combat，但它是建筑
        ent("pumpkin_lantern", 48, 40, { "structure" }, {
            health = { GetPercent = function() return 1 end, IsDead = function() return false end },
            combat = {},
        }),
        -- 真正的敌人
        ent("spider", 52, 40, { "hostile", "monster" }, {
            health = { GetPercent = function() return 0.5 end, IsDead = function() return false end },
            combat = {},
        }),
    }
  `)
  t.run('N = BWS.entity_observer.Observe(GLOBAL.AllPlayers["KU_1"], { radius_tiles = 16 })')
  const nearby = t.json('N')
  const byPrefab = {}
  for (const e of nearby.entities) {
    if (!byPrefab[e.prefab]) byPrefab[e.prefab] = []
    byPrefab[e.prefab].push(e)
  }
  assert.equal(byPrefab.grass[0].category, 'harvestable', '草应该算“能采”，不是“能铲”')
  assert.equal(byPrefab.pumpkin_lantern[0].category, 'structure', '有血有战斗组件的建筑也不该算生物')
  assert.equal(byPrefab.spider[0].category, 'hostile')
})

test('记录长度有预算：太长就裁实体并标 trimmed，不会写出被日志截断的半截 JSON', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  // 造一个 prefab 名超长的树：不裁剪的话这条记录必然超过日志上限
  t.run(`
    NEARBY_ENTS = {
        ent("evergreen", 44, 40, {}, { workable = { action = WORKABLE.CHOP, workleft = 1 } }),
        ent(string.rep("x", 4000), 48, 40, {}, { workable = { action = WORKABLE.CHOP, workleft = 1 } }),
    }
  `)
  t.run('BWS.observer.Start(); PERIODIC()')

  const records = t.lines()
  const nearby = records.find((r) => r.type === 'nearby')
  assert.ok(nearby, '应该有一条 nearby 记录')
  assert.equal(nearby.trimmed, true, '超预算时要标 trimmed')
  assert.ok(nearby.returned < 2, '那条超长实体应该被裁掉')

  // 关键：每条日志记录本身都不能超过游戏的截断阈值（实测 3913 字符就开始断）
  const all = t.lines()
  for (const record of all) {
    const text = JSON.stringify(record)
    assert.ok(text.length < 3800, '记录长度 ' + text.length + ' 接近日志截断点')
  }
})
