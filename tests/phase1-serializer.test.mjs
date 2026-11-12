// Phase 1 / 里程碑 6：state_serializer + JSON Schema 契约校验
//
// 两层验证：
//   1. 序列化器本身（每种记录的字段、预算裁剪、超长放弃）；
//   2. 用 ajv 拿 schema/state.schema.json 校验「真实跑出来的记录」和「合并后的 GameState」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')
const LEGACY_HOME = join(ROOT, 'archive', 'phase-a')
const SCHEMA_PATH = join(ROOT, 'schema', 'state.schema.json')

const PRELUDE = `
CAPTURED = {}
GLOBAL = {}
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.next = next
GLOBAL.os = { time = function() return 1794410000 end }
GLOBAL.TheSim = { GetRealTime = function() return 42500 end, GetTick = function() return 12345 end }
GLOBAL.TheWorld = { prefab = "world", state = { cycles = 1 } }
BWS = { tag = "[BWS]" }
print = function(text) CAPTURED[#CAPTURED + 1] = text end
pcall = nil
tonumber = nil
error = nil
next = nil
os = nil
io = nil
`

const FILES = ['scripts/main/json_encoder.lua', 'scripts/main/state_serializer.lua']

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
  const global = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    const top = lua.lua_gettop(L)
    try {
      return lua.lua_tojsstring(L, -1) ?? ''
    } catch {
      return ''
    }
  }
  const json = (luaCode, outVar = 'OUT') => {
    run(`${outVar} = BWS.json.encode(${luaCode})`)
    return JSON.parse(global(outVar))
  }
  const captured = () => {
    run('CAPN = #CAPTURED')
    const total = Number(global('CAPN')) || 0
    const out = []
    for (let i = 1; i <= total; i += 1) {
      run(`CAPITEM = CAPTURED[${i}]`)
      const line = global('CAPITEM')
      assert.ok(line.startsWith('[BWS] '), '日志行必须以 [BWS] 开头')
      out.push(JSON.parse(line.slice('[BWS] '.length)))
    }
    return out
  }
  return { run, global, json, captured }
}

/** ajv：strict 关掉（我们用了 const，draft-07 里合法但 ajv 的 strictTypes 会唠叨） */
async function validator() {
  const { default: Ajv } = await import('ajv')
  const ajv = new Ajv({ strict: false, allErrors: true })
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
  return {
    wire: ajv.compile(schema),
    gameState: ajv.compile({ $ref: '#/$defs/GameState', $defs: schema.$defs }),
  }
}

const HEADER = `{
  schema_version = "1", side = "server", shard = "master", session = "S1",
  t = 1794410000, rt = 42.5, sim_tick = 12345, tick = 7,
  interval = 2, errors = 0, player_count = 1, observer_version = "0.3.0",
}`

test('schema 文件本身是合法 JSON，并且能编译', async () => {
  const { wire, gameState } = await validator()
  assert.ok(wire)
  assert.ok(gameState)
})

test('serializer：boot / state / nearby 三种记录的字段都对', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`
    M = ${HEADER}
    BOOT = BWS.serializer.Boot(M, { mod = "BlindWhaleSurvivor", ismastersim = true, interval = 2, player_count = 1 })
    STATE = BWS.serializer.State(M, {
        player = { valid = true, prefab = "willow" },
        inventory = { slots = 15, used = 0, items = {} },
        world = { prefab = "world", shard = "master", cycles = 1, day = 2, phase = "day", season = "autumn" },
    })
    NEARBY = BWS.serializer.Nearby(M, {
        radius_tiles = 16, scanned = 12, returned = 2, truncated = false, scanned_at_tick = 5,
        counts = { tree = 1, item = 1 },
        entities = {
            { prefab = "evergreen", name = "常青树", category = "tree", tile_x = 3, tile_z = 4, distance = 1.5, work_left = 10 },
            { prefab = "log", name = "木头", category = "item", tile_x = 3, tile_z = 5, distance = 2 },
        },
    })
  `)
  const boot = t.json('BOOT')
  assert.equal(boot.type, 'boot')
  assert.equal(boot.mod, 'BlindWhaleSurvivor')
  assert.equal(boot.ismastersim, true)
  assert.equal(boot.players.count, 1)
  assert.equal(boot.schema_version, '1')
  assert.equal(boot.sim_tick, 12345)
  assert.ok(!('entities' in boot))

  const state = t.json('STATE')
  assert.equal(state.type, 'state')
  assert.equal(state.tick, 7)
  assert.equal(state.player.prefab, 'willow')
  assert.equal(state.observer.interval, 2)
  assert.equal(state.observer.players.count, 1)
  assert.ok(!('entities' in state), 'state 里不能有实体')

  const nearby = t.json('NEARBY')
  assert.equal(nearby.type, 'nearby')
  assert.equal(nearby.tick, 7)
  assert.equal(nearby.scanned_at_tick, 5)
  assert.equal(nearby.counts.tree, 1)
  assert.equal(nearby.entities.length, 2)
})

test('serializer：超预算时裁实体、标 trimmed，长度守住 MAX_RECORD_CHARS', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`
    M = ${HEADER}
    local entities = {}
    for i = 1, 60 do
        entities[i] = { prefab = "evergreen", name = "常青树", category = "tree",
                        tile_x = i, tile_z = i, distance = i / 2, work_left = 10 }
    end
    REC = BWS.serializer.Nearby(M, { radius_tiles = 16, scanned = 200, returned = 60,
        truncated = true, scanned_at_tick = 7, counts = { tree = 60 }, entities = entities })
    local ok = BWS.serializer.Emit(REC, BWS.serializer.shrink_nearby)
    OKS = tostring(ok)
    MAX = tostring(BWS.serializer.MAX_RECORD_CHARS)
    LEN = tostring(#BWS.json.encode(REC))
  `)
  assert.equal(t.global('OKS'), 'true', 'Emit 应该成功')
  const record = t.captured().at(-1)
  assert.equal(record.trimmed, true, '被裁剪要标 trimmed')
  assert.ok(record.returned < 60, 'returned 应该是裁剪后的条数')
  assert.equal(record.entities.length, record.returned)
  assert.ok(Number(t.global('LEN')) <= Number(t.global('MAX')), '记录长度必须守住预算')
})

test('serializer：穷尽手段仍超长时放弃输出并给出原因', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`
    M = ${HEADER}
    M.problems = { player = string.rep("x", 5000) }
    REC = BWS.serializer.State(M, {})
    local ok, reason = BWS.serializer.Emit(REC)
    OKS = tostring(ok)
    REASON = tostring(reason)
  `)
  assert.equal(t.global('OKS'), 'false', '超长应该放弃而不是写出半截 JSON')
  assert.match(t.global('REASON'), /too_long/)
})

test('真实记录通过 schema 校验（boot / state / nearby + 合并后的 GameState）', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  const { wire, gameState } = await validator()

  t.run(`
    M = ${HEADER}
    GLOBAL.AllPlayers = nil
    local entities = {
        { prefab = "evergreen", name = "常青树", category = "tree", tile_x = 3, tile_z = 4, distance = 1.5, work_left = 10 },
        { prefab = "spider", name = "蜘蛛", category = "hostile", tile_x = 5, tile_z = 4, distance = 2.5, hp = 75 },
        { prefab = "log", name = "木头", category = "item", tile_x = 3, tile_z = 5, distance = 2 },
    }
    local nearby = { radius_tiles = 16, scanned = 30, returned = 3, truncated = false,
                     scanned_at_tick = 7, counts = { tree = 1, hostile = 1, item = 1 }, entities = entities }

    BWS.serializer.Emit(BWS.serializer.Boot(M, { mod = "BlindWhaleSurvivor", ismastersim = true, interval = 2, player_count = 1 }))
    BWS.serializer.Emit(BWS.serializer.State(M, {
        player = {
            valid = true, prefab = "willow", name = "薇洛", guid = 116828, userid = "KU_1", is_ghost = false,
            position = { x = 13.81, y = 0, z = -56.46, tile_x = 3, tile_z = -15 },
            health = { current = 150, max = 150, percent = 100, dead = false },
            hunger = { current = 64.5, max = 150, percent = 43 },
            sanity = { current = 103, max = 120, percent = 85.8 },
            temperature = { current = 30.5 },
            moisture = { value = 0, percent = 0 },
        },
        inventory = {
            slots = 15, used = 1, is_full = false,
            items = { { slot = 1, prefab = "lighter", name = "薇洛的打火机", count = 1, fuel = 96.7 } },
            equipment = { hands = { prefab = "lighter", name = "薇洛的打火机", count = 1, fuel = 96.7 } },
        },
        world = {
            prefab = "world", shard = "master", cycles = 1, day = 2, phase = "day",
            is_day = true, is_dusk = false, is_night = false,
            season = "autumn", is_autumn = true, temperature = 29.5,
            elapsed_days_in_season = 1, remaining_days_in_season = 19, season_progress = 0.525,
            time = { of_day = 0.14, in_phase = 0.28 },
            weather = { is_raining = false, wetness = 0 },
            moon = { phase = "quarter", is_full_moon = false },
        },
    }))
    BWS.serializer.Emit(BWS.serializer.Nearby(M, nearby), BWS.serializer.shrink_nearby)
    MERGED = BWS.serializer.GameState(M, {
        player = { valid = true, prefab = "willow" },
        inventory = { slots = 15, used = 0, items = {} },
        world = { cycles = 1, day = 2, phase = "day", season = "autumn" },
        nearby = nearby,
    })
  `)

  const records = t.captured()
  assert.equal(records.length, 3, '应该是 1 boot + 1 state + 1 nearby')
  assert.deepEqual(records.map((r) => r.type), ['boot', 'state', 'nearby'])

  for (const record of records) {
    const ok = wire(record)
    assert.ok(ok, `schema 校验失败（${record.type}）：` + JSON.stringify(wire.errors))
  }

  const merged = t.json('MERGED')
  const mergedOk = gameState(merged)
  assert.ok(mergedOk, 'GameState 校验失败：' + JSON.stringify(gameState.errors))
  assert.equal(merged.timestamp.unix, 1794410000)
  assert.equal(merged.timestamp.real_s, 42.5)
  assert.equal(merged.timestamp.sim_tick, 12345)
  assert.equal(merged.session, 'S1')
  assert.equal(merged.nearby.entities.length, 3)
  assert.equal(merged.observer.players.count, 1)
})
