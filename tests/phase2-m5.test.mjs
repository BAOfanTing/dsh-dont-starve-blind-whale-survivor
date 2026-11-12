// Phase 2 · M5 回归：断线恢复时游戏端的关键不变量
//
// 重点：Bridge 掉线期间，游戏端必须**保持记账**（sequence 不前进、ack id 不清零），
// 恢复后从原处继续 —— 否则 Bridge 侧会把这些当成新数据/新命令，幂等就破了。
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
QUERIES = {}
REPLIES = {}
REPLY_INDEX = 0
CLOCK = 1000

GLOBAL = {}
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.next = next
GLOBAL.io = nil
GLOBAL.os = { time = function() return CLOCK end }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "SESSION_A" end }

local player = { prefab = "wilson" }
function player:IsValid() return true end
player.Transform = { GetWorldPosition = function() return 40, 0, -56 end }
player.components = {
    health = { GetPercent = function() return 1 end, IsDead = function() return false end },
    hunger = { GetPercent = function() return 0.5 end },
    sanity = { GetPercent = function() return 0.8 end },
}
GLOBAL.AllPlayers = { KU = player }

GLOBAL.TheWorld = {
    ismastersim = true,
    HasTag = function() return false end,
    DoPeriodicTask = function(self, s, fn) local t = { fn = fn, Cancel = function() end }; return t end,
    DoTaskInTime = function(self, s, fn) local t = {}; function t:Cancel() end; return t end,
}
GLOBAL.TheSim = {
    GetRealTime = function() return CLOCK * 1000 end,
    GetTick = function() return 100 end,
    QueryServer = function(self, url, cb, method, body)
        QUERIES[#QUERIES + 1] = { url = url, method = method, body = body }
        REPLY_INDEX = REPLY_INDEX + 1
        local reply = REPLIES[REPLY_INDEX] or REPLIES[#REPLIES]
        if reply == nil then
            -- 默认：连不上（模拟 Bridge 宕机）
            cb(nil, false, 0)
            return
        end
        if reply.delay ~= true then cb(reply.body, reply.ok, reply.status) end
    end,
}

BWS = {}
BWS.player_observer = { Observe = function() return { valid = true, prefab = "wilson" } end }
BWS.inventory_observer = { Observe = function() return { slots = 15, used = 0, items = {} } end }
BWS.world_observer = { Observe = function() return { cycles = 0, day = 1 } end }
BWS.entity_observer = { Observe = function() return { returned = 0, entities = {} } end }
BWS.serializer = {
    GameState = function(meta, sections)
        return { schema_version = "1", tick = meta.tick, player = sections.player, world = sections.world }
    end,
}

BWS_CONFIG = {
    baseUrl = "http://127.0.0.1:18788",
    token = "TOKEN_OK",
    heartbeatSeconds = 3,
    pollSeconds = 1,
    telemetryRetrySeconds = 2,
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
  'scripts/main/heartbeat.lua',
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

const META = '{ schema_version="1", tick=1, interval=2, errors=0, player_count=1, observer_version="0.3.0", side="server", shard="master", session="S1", t=1794410000, rt=42.5, sim_tick=600 }'

test('断线期间：telemetry sequence 不前进，恢复后从原 sequence 继续', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)

  // 先成功一次（sequence 1 → 2）
  t.run(`REPLIES = { { ok = true, status = 200, body = '{"success":true,"acknowledged_sequence":1}' } }`)
  t.run(`BWS2.telemetry.submit(${META}, { world = { day = 1 } }, nil)`)
  assert.equal(t.json('BWS2.telemetry.status()').sequence, 2)

  // Bridge 宕机：连续 3 次失败（默认桩：连不上）
  t.run(`REPLIES = {}`)
  for (let i = 0; i < 3; i += 1) {
    t.run(`CLOCK = CLOCK + 10; BWS2.telemetry.submit(${META}, { world = { day = ${i + 2} } }, nil)`)
  }
  const down = t.json('BWS2.telemetry.status()')
  assert.equal(down.sequence, 2, '断线期间 sequence 不能前进')
  assert.ok(down.failed >= 1)
  assert.equal(down.has_pending, true, '要留着待发数据')

  // Bridge 恢复
  t.run(`REPLIES = { { ok = true, status = 200, body = '{"success":true,"acknowledged_sequence":2}' } }`)
  t.run('CLOCK = CLOCK + 60; BWS2.telemetry.flushIfPending()')
  const up = t.json('BWS2.telemetry.status()')
  assert.equal(up.sequence, 3, '恢复后用原 sequence 发出去，成功后才 +1')

  // 验请求体里的 sequence 序列
  t.run(`SEQ = ""; for i = 1, #QUERIES do local s = string.match(QUERIES[i].body, '"sequence":(%d+)'); SEQ = SEQ .. tostring(s) .. "," end`)
  const seqs = t.global('SEQ')
  assert.match(seqs, /^1,2,2,2,2,/, '第一次 1，成功重试后都是 2（不跳号不重置）：' + seqs)
})

test('断线恢复后：poll 仍带上次执行完的 last_acknowledged_id（不清零）', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)

  // 1) 成功轮询并执行一条 ping
  t.run(`REPLIES = {
    { ok = true, status = 200, body = '{"success":true,"command":{"id":"cmd_A","type":"ping","params":{}}}' },
    { ok = true, status = 200, body = '{"success":true}' },
  }`)
  t.run('BWS2.commands.poll(true)')
  assert.equal(t.json('BWS2.commands.status()').last_acknowledged_id, 'cmd_A')

  // 2) Bridge 宕机期间的轮询全失败
  t.run('REPLIES = {}')
  t.run('CLOCK = CLOCK + 10; BWS2.commands.poll(true)')
  assert.ok(t.json('BWS2.commands.status()').poll_fail >= 1)
  assert.equal(t.json('BWS2.commands.status()').last_acknowledged_id, 'cmd_A', '宕机不能把 ack id 清零')

  // 3) 恢复后再轮询：请求体里必须带 cmd_A
  t.run(`REPLIES = { { ok = true, status = 200, body = '{"success":true,"command":null}' } }`)
  t.run('CLOCK = CLOCK + 60; BWS2.commands.poll(true)')
  t.run(`
    local idx = #QUERIES
    local body = QUERIES[idx].body
    local ok, decoded = GLOBAL.pcall(BWS.json.decode, body)
    ACK = tostring(ok and decoded.last_acknowledged_id or 'nil')
  `)
  assert.equal(t.global('ACK'), 'cmd_A', '恢复后的 poll 要带上次执行完的命令 id')
})

test('断线恢复后：心跳重新把连接拉回 online，且之后不再刷 WARN 级重试', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)

  t.run(`REPLIES = {}`) // 宕机
  t.run('BWS2.heartbeat.send(nil)')
  t.run('BWS2.heartbeat.send(nil)')
  assert.equal(t.json('BWS2.connection.status()').state, 'degraded')
  assert.equal(t.json('BWS2.connection.status()').backoff_factor, 2)

  t.run(`REPLIES = { { ok = true, status = 200, body = '{"success":true}' } }`) // 恢复
  t.run('BWS2.heartbeat.send(nil)')
  const status = t.json('BWS2.connection.status()')
  assert.equal(status.state, 'online')
  assert.equal(status.backoff_factor, 1, '成功后退避重置')
  assert.equal(status.consecutive_failures, 0)
})
