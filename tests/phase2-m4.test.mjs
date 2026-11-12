// Phase 2 · M4 回归：游戏端命令轮询 + 执行 + 回执（模拟饥荒沙箱 + strict.lua）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const PRELUDE = `
CAPTURED = {}
QUERIES = {}
REPLIES = {}
REPLY_INDEX = 0
TASKS = {}
CLOCK = 1000

GLOBAL = {}
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.next = next
GLOBAL.io = nil
GLOBAL.os = { time = function() return CLOCK end }

GLOBAL.TheNet = { GetSessionIdentifier = function() return "SESSION_A" end }

local player = { prefab = "willow" }
function player:IsValid() return true end
player.Transform = { GetWorldPosition = function() return 40.5, 0, -56.25 end }
player.components = {
    health = { GetPercent = function() return 0.9 end, IsDead = function() return false end },
    hunger = { GetPercent = function() return 0.5 end },
    sanity = { GetPercent = function() return 0.75 end },
}
GLOBAL.AllPlayers = { KU = player }

GLOBAL.TheWorld = {
    ismastersim = true,
    HasTag = function(self, tag) return tag == "cave" end,
    DoPeriodicTask = function(self, seconds, fn)
        TASKS[#TASKS + 1] = { seconds = seconds, fn = fn, Cancel = function() end }
        return TASKS[#TASKS]
    end,
    DoTaskInTime = function(self, seconds, fn) local t = {}; function t:Cancel() end; return t end,
}

GLOBAL.TheSim = {
    GetRealTime = function() return CLOCK * 1000 end,
    GetTick = function() return 100 end,
    QueryServer = function(self, url, cb, method, body)
        QUERIES[#QUERIES + 1] = { url = url, method = method, body = body }
        REPLY_INDEX = REPLY_INDEX + 1
        local reply = REPLIES[REPLY_INDEX] or REPLIES[#REPLIES] or { ok = true, status = 200, body = '{"success":true,"command":null}' }
        if reply.delay ~= true then cb(reply.body, reply.ok, reply.status) end
    end,
}

-- Phase 1 的观察器与序列化器（桩：只要形状对）
BWS = {}
BWS.player_observer = { Observe = function() return { valid = true, prefab = "willow", name = "威尔逊" } end }
BWS.inventory_observer = { Observe = function() return { slots = 15, used = 1, items = { { prefab = "axe", count = 1 } } } end }
BWS.world_observer = { Observe = function() return { cycles = 1, day = 2, phase = "day" } end }
BWS.entity_observer = { Observe = function() return { radius_tiles = 12, returned = 3, entities = { { prefab = "evergreen" } } } end }
BWS.serializer = {
    GameState = function(meta, sections)
        return {
            schema_version = "1", tick = meta.tick, session = meta.session, side = meta.side,
            shard = meta.shard, timestamp = { unix = meta.t, real_s = meta.rt },
            player = sections.player, inventory = sections.inventory, world = sections.world,
        }
    end,
}

BWS_CONFIG = {
    baseUrl = "http://127.0.0.1:18788",
    token = "TOKEN_OK",
    heartbeatSeconds = 3,
    pollSeconds = 1,
    maxPayloadBytes = 64 * 1024,
}

setmetatable(GLOBAL, {
    __index = function(_, key)
        error("strict: 读取了不存在的全局变量 '" .. tostring(key) .. "'", 2)
    end,
})

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
  'scripts/main/config.lua',
  'scripts/main/http_client.lua',
  'scripts/main/connection.lua',
  'scripts/main/telemetry.lua',
  'scripts/main/commands.lua',
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
  const global = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    const top = lua.lua_gettop(L)
    try {
      return lua.lua_tojsstring(L, -1) ?? ''
    }
    catch {
      return ''
    }
    finally {
      lua.lua_settop(L, top - 1)
    }
  }
  const json = (code, outVar = 'OUT') => {
    run(`${outVar} = BWS.json.encode(${code})`)
    return JSON.parse(global(outVar))
  }
  return { run, global, json }
}

const pollWith = (command) =>
  `REPLIES = { { ok = true, status = 200, body = BWS.json.encode({ success = true, command = ${command} }) }, { ok = true, status = 200, body = '{"success":true}' } }`

test('ping：轮询到命令 → 执行 → 回执 message = "Pong from DST"', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(pollWith(`{ id = "cmd_1", type = "ping", params = {} }`))
  t.run('BWS2.commands.poll(true)')

  // 第 1 个请求是 poll，第 2 个是 result
  t.run('OUT1 = QUERIES[1].url .. "|" .. QUERIES[1].method')
  assert.equal(t.global('OUT1'), 'http://127.0.0.1:18788/api/v1/commands/poll|POST')

  t.run('OUT2 = QUERIES[2].url')
  assert.equal(t.global('OUT2'), 'http://127.0.0.1:18788/api/v1/commands/result')

  const report = t.json('BWS.json.decode(QUERIES[2].body)')
  assert.equal(report.command_id, 'cmd_1')
  assert.equal(report.status, 'SUCCEEDED')
  assert.equal(report.result.message, 'Pong from DST')
  assert.equal(report.token, 'TOKEN_OK', '回执必须带 token')
  assert.equal(report.session_id, 'SESSION_A-caves-1000')
  assert.ok(typeof report.execution_time === 'number')

  const status = t.json('BWS2.commands.status()')
  assert.equal(status.succeeded, 1)
  assert.equal(status.last_acknowledged_id, 'cmd_1')
})

test('echo：原样返回传入的 params', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(pollWith(`{ id = "cmd_2", type = "echo", params = { text = "大肥鱼", n = 7, nested = { a = 1 } } }`))
  t.run('BWS2.commands.poll(true)')
  const report = t.json('BWS.json.decode(QUERIES[2].body)')
  assert.equal(report.status, 'SUCCEEDED')
  assert.deepEqual(report.result.echo, { text: '大肥鱼', n: 7, nested: { a: 1 } })
  assert.deepEqual(report.result.received_keys.sort(), ['n', 'nested', 'text'])
})

test('get_state：返回真实状态（player/inventory/world），默认不带 nearby', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(pollWith(`{ id = "cmd_3", type = "get_state", params = {} }`))
  t.run('BWS2.commands.poll(true)')
  const report = t.json('BWS.json.decode(QUERIES[2].body)')
  assert.equal(report.status, 'SUCCEEDED')
  assert.equal(report.result.player.prefab, 'willow')
  assert.equal(report.result.world.day, 2)
  assert.equal(report.result.nearby, undefined, '默认不带 nearby（Lua nil 在 JSON 里就是缺字段）')
})

test('get_state：include_nearby=true 时带附近实体', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(pollWith(`{ id = "cmd_4", type = "get_state", params = { include_nearby = true } }`))
  t.run('BWS2.commands.poll(true)')
  const report = t.json('BWS.json.decode(QUERIES[2].body)')
  assert.equal(report.result.nearby.returned, 3)
})

test('refresh_state：立刻重新采集一次', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(pollWith(`{ id = "cmd_5", type = "refresh_state", params = {} }`))
  t.run('BWS2.commands.poll(true)')
  const report = t.json('BWS.json.decode(QUERIES[2].body)')
  assert.equal(report.status, 'SUCCEEDED')
  assert.equal(report.result.refreshed, true)
  assert.ok(typeof report.result.tick === 'number')
  assert.equal(report.result.nearby_returned, 3)
})

test('白名单外命令：判 FAILED + unsupported_command（绝不执行）', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(pollWith(`{ id = "cmd_6", type = "eval_lua", params = {} }`))
  t.run('BWS2.commands.poll(true)')
  const report = t.json('BWS.json.decode(QUERIES[2].body)')
  assert.equal(report.status, 'FAILED')
  assert.match(String(report.error), /unsupported_command/)
  assert.equal(t.json('BWS2.commands.status()').unsupported, 1)
})

test('同一条命令重投：不重复执行，回执标 duplicate', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`REPLIES = {
    { ok = true, status = 200, body = '{"success":true,"command":{"id":"cmd_7","type":"ping","params":{}}}' },
    { ok = true, status = 200, body = '{"success":true}' },
    { ok = true, status = 200, body = '{"success":true,"command":{"id":"cmd_7","type":"ping","params":{}}}' },
    { ok = true, status = 200, body = '{"success":true}' },
  }`)
  t.run('BWS2.commands.poll(true)')
  t.run('CLOCK = CLOCK + 2; BWS2.commands.poll(true)')
  const status = t.json('BWS2.commands.status()')
  assert.equal(status.received, 2, '收到两次')
  assert.equal(status.duplicated, 1, '第二次判重复')
  assert.equal(status.succeeded, 2, '两次都回了执（第二次是 duplicate 回执）')
  // 第二次回执内容
  const second = t.json('BWS.json.decode(QUERIES[4].body)')
  assert.equal(second.result.duplicate, true)
  assert.equal(second.result.skipped, true)
})

test('竞态保护：poll 在飞时不会并发再发一次', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`REPLIES = { { ok = true, status = 200, body = '{"success":true,"command":null}', delay = true } }`)
  t.run('BWS2.commands.poll(true); BWS2.commands.poll(true)')
  t.run('QN = tostring(#QUERIES)')
  assert.equal(t.global('QN'), '1', '只应发出一次 poll')
})

test('轮询失败：进退避，不会每秒猛敲', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`REPLIES = { { ok = false, status = 0, body = '' } }`)
  t.run('BWS2.commands.poll(true)')
  assert.equal(t.json('BWS2.commands.status()').poll_fail, 1)
  t.run('CLOCK = CLOCK + 1; BWS2.commands.poll(false)')
  t.run('QN = tostring(#QUERIES)')
  assert.equal(t.global('QN'), '1', '退避期内不该再敲')
  t.run(`REPLIES = { { ok = true, status = 200, body = '{"success":true,"command":null}' } }`)
  t.run('CLOCK = CLOCK + 30; BWS2.commands.poll(false)')
  t.run('QN2 = tostring(#QUERIES)')
  assert.equal(t.global('QN2'), '2', '退避到期后恢复轮询')
})

test('客户端（非服务端）不轮询命令', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run('GLOBAL.TheWorld.ismastersim = false')
  t.run(pollWith(`{ id = "cmd_8", type = "ping", params = {} }`))
  t.run('BWS2.commands.poll(true)')
  t.run('QN = tostring(#QUERIES)')
  assert.equal(t.global('QN'), '0', '客户端不该轮询命令')
})
