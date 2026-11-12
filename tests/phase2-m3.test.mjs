// Phase 2 · M3 回归：connection / heartbeat / telemetry / net 四个模块（模拟饥荒沙箱）
//
// 重点验证：
//   · 心跳包字段齐全；
//   · telemetry 的 sequence 只在成功后递增，失败保持同一个 sequence 重试（配合 Bridge 幂等）；
//   · 同一时刻只有一个 telemetry 在飞（飞的时候新样本只覆盖 pending，并计入 dropped）；
//   · net 只创建**一个**周期任务（start 两次不会重复建）；
//   · 大包会先削 nearby.entities、再丢整段 nearby。
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
REPLIES = {}       -- 依次消费的应答 { ok, status, body }
REPLY_INDEX = 0
TASKS = {}         -- DoPeriodicTask 创建记录
TIMERS = {}        -- DoTaskInTime 记录
CLOCK = 1000       -- 秒

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
function player:HasTag() return false end
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
        TASKS[#TASKS + 1] = { seconds = seconds, fn = fn, canceled = false, Cancel = function(self_) self_.canceled = true end }
        return TASKS[#TASKS]
    end,
    DoTaskInTime = function(self, seconds, fn)
        TIMERS[#TIMERS + 1] = fn
        local task = {}
        function task:Cancel() end
        return task
    end,
}

GLOBAL.TheSim = {
    GetRealTime = function() return 42500 end,
    QueryServer = function(self, url, cb, method, body)
        QUERIES[#QUERIES + 1] = { url = url, method = method, body = body }
        REPLY_INDEX = REPLY_INDEX + 1
        -- 用完就用最后一个（测试里每次 phase 前会重新赋值 REPLIES）
        local reply = REPLIES[REPLY_INDEX] or REPLIES[#REPLIES] or { ok = true, status = 200, body = '{"success":true,"acknowledged_sequence":1}' }
        if reply.delay ~= true then
            cb(reply.body, reply.ok, reply.status)
        end
    end,
}

BWS_CONFIG = {
    baseUrl = "http://127.0.0.1:18788",
    token = "TOKEN_OK",
    probe = false,
    heartbeatSeconds = 3,
    stateSeconds = 2,
    httpTimeoutSeconds = 10,
    maxPayloadBytes = 64 * 1024,
}

-- 模拟 DST 的 scripts/strict.lua：读不存在的全局名 → 直接报错（不是返回 nil）
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
  'scripts/main/state_serializer.lua',
  'scripts/main/config.lua',
  'scripts/main/http_client.lua',
  'scripts/main/connection.lua',
  'scripts/main/heartbeat.lua',
  'scripts/main/telemetry.lua',
  'scripts/main/net.lua',
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
    assert.equal(status, lua.LUA_OK, `${file} 在沙箱里加载失败：` + fail())
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
    finally {
      lua.lua_settop(L, top - 1)
    }
  }
  const json = (luaCode, outVar = 'OUT') => {
    run(`${outVar} = BWS.json.encode(${luaCode})`)
    return JSON.parse(global(outVar))
  }
  return { run, global, json }
}

const META = `{
  schema_version = "1", tick = 1, interval = 2, errors = 0, player_count = 1,
  observer_version = "0.3.0", side = "server", shard = "caves",
  session = "S1", t = 1794410000, rt = 42.5, sim_tick = 600,
}`

test('connection：session_id 带分片与启动时间；状态机与退避', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`SID = BWS2.connection.session()`)
  assert.match(t.global('SID'), /^SESSION_A-caves-\d+$/, 'session_id 应该是 会话-分片-时间')

  t.run(`BWS2.connection.onSuccess("heartbeat")`)
  t.run(`S1 = BWS2.connection.status().state`)
  assert.equal(t.global('S1'), 'online')

  t.run(`BWS2.connection.onFailure("heartbeat", "transport_failed")`)
  t.run(`BWS2.connection.onFailure("heartbeat", "transport_failed")`)
  const status = t.json('BWS2.connection.status()')
  assert.equal(status.state, 'degraded', '连续失败两次进 degraded')
  assert.equal(status.backoff_factor, 2, '失败 2 次 → 退避 2 倍')
  assert.equal(status.counters.heartbeat_ok, 1)
  assert.equal(status.counters.heartbeat_fail, 2)

  t.run(`BWS2.connection.onFailure("heartbeat", "x"); BWS2.connection.onFailure("heartbeat", "x"); BWS2.connection.onFailure("heartbeat", "x")`)
  assert.equal(t.json('BWS2.connection.status()').backoff_factor, 8, '退避封顶 8 倍')
})

test('heartbeat：请求体字段齐全（session/玩家状态/版本）', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`HP = BWS2.heartbeat.build(GLOBAL.AllPlayers["KU"])`)
  const payload = t.json('HP')
  assert.equal(payload.protocol_version, '1.0')
  assert.equal(payload.token, 'TOKEN_OK')
  assert.match(String(payload.session_id), /^SESSION_A-caves-/)
  assert.ok(typeof payload.timestamp === 'number')
  assert.equal(payload.player_status.present, true)
  assert.equal(payload.player_status.prefab, 'willow')
  assert.equal(payload.player_status.health_percent, 90)
  assert.equal(payload.player_status.hunger_percent, 50)
  assert.equal(payload.player_status.sanity_percent, 75)
  assert.equal(payload.player_status.tile_x, 10) // 40.5/4
  assert.equal(payload.player_status.tile_z, -15) // -56.25/4 → floor = -15
  assert.ok(typeof payload.game_version === 'string')
  assert.equal(payload.shard, 'caves', '请求体要带分片名（TheWorld 打了 cave 标签）')
})

test('heartbeat：发出去走 POST /api/v1/heartbeat，成功即 online', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`BWS2.heartbeat.send(GLOBAL.AllPlayers["KU"])`)
  t.run(`Q = QUERIES[1]; OUTS = tostring(Q.method) .. "|" .. Q.url`)
  assert.equal(t.global('OUTS'), 'POST|http://127.0.0.1:18788/api/v1/heartbeat')
  assert.equal(t.json('BWS2.connection.status()').state, 'online')
})

test('telemetry：sequence 成功后递增；失败保持同一 sequence 且不丢数据', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  // 第一次：成功（ack=1）
  t.run(`REPLIES = { { ok = true, status = 200, body = '{"success":true,"acknowledged_sequence":1}' } }`)
  t.run(`BWS2.telemetry.submit(${META}, { world = { day = 2 } }, nil)`)
  assert.equal(t.json('BWS2.telemetry.status()').sequence, 2, '成功后 sequence +1')
  assert.equal(t.json('BWS2.telemetry.status()').acknowledged_sequence, 1)

  // 第二次：失败 —— sequence 不能前进，pending 保留
  t.run(`REPLIES = { { ok = false, status = 500, body = '{}' } }`)
  t.run(`BWS2.telemetry.submit(${META}, { world = { day = 3 } }, nil)`)
  let status = t.json('BWS2.telemetry.status()')
  assert.equal(status.sequence, 2, '失败后 sequence 不变')
  assert.equal(status.has_pending, true, '失败后要留着 pending 重试')
  assert.equal(status.failed, 1)

  // 第三次：等过退避时间后重试成功
  t.run(`REPLIES = { { ok = true, status = 200, body = '{"success":true,"acknowledged_sequence":2}' } }`)
  t.run('CLOCK = CLOCK + 30; BWS2.telemetry.flushIfPending()')
  status = t.json('BWS2.telemetry.status()')
  assert.equal(status.sequence, 3)
  assert.equal(status.has_pending, false)
  assert.equal(status.ok, 2)

  // 请求体里必须有 token（漏过一次，导致 152 次 401）
  t.run(`
    local ok_decode, decoded = GLOBAL.pcall(BWS.json.decode, QUERIES[1].body)
    HAS_TOKEN = tostring(ok_decode and type(decoded) == 'table' and decoded.token == 'TOKEN_OK')
  `)
  assert.equal(t.global('HAS_TOKEN'), 'true', 'telemetry 请求体必须带 token')

  // 检查发出去的三个请求的 sequence 序列：1, 2(失败重试也是 2), 2 → 第 3 个成功后变 3
  t.run(`OUTS = ""; for i = 1, #QUERIES do local b = QUERIES[i].body; local s = string.match(b, '"sequence":(%d+)'); OUTS = OUTS .. tostring(s) .. "," end`)
  assert.equal(t.global('OUTS'), '1,2,2,')
})

test('telemetry：同一个请求在飞时，新样本只覆盖 pending 并计入 dropped', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`REPLIES = { { ok = true, status = 200, body = '{"success":true,"acknowledged_sequence":1}', delay = true } }`)
  t.run(`BWS2.telemetry.submit(${META}, { world = { day = 2 } }, nil)`)
  t.run(`BWS2.telemetry.submit(${META}, { world = { day = 3 } }, nil)`)
  t.run(`BWS2.telemetry.submit(${META}, { world = { day = 4 } }, nil)`)
  const status = t.json('BWS2.telemetry.status()')
  assert.equal(status.in_flight, true, '第一个还在飞')
  assert.equal(status.dropped, 1, 'pending 被新样本覆盖才算 dropped')
  t.run(`BWS2.telemetry.submit(${META}, { world = { day = 5 } }, nil)`)
  assert.equal(t.json('BWS2.telemetry.status()').dropped, 2)
})

test('telemetry：大包先削 nearby.entities，再超就丢整段 nearby', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  // 造 900 个实体（约 90KB），肯定超过 64KB
  t.run(`
    local entities = {}
    for i = 1, 900 do
        entities[i] = { prefab = "evergreen", name = "常青树", category = "tree", tile_x = i, tile_z = i, distance = i / 2, work_left = 10 }
    end
    NEARBY = { radius_tiles = 16, scanned = 400, returned = 900, counts = { tree = 900 }, entities = entities }
    REPLIES = { { ok = true, status = 200, body = '{"success":true,"acknowledged_sequence":1}' } }
    BWS2.telemetry.submit(${META}, { world = { day = 2 } }, NEARBY)
  `)
  const sent = t.global('QUERIES[1].body')
  assert.ok(sent.length < 64 * 1024, `请求体应被压到 64KB 内，实际 ${sent.length}`)
  const status = t.json('BWS2.telemetry.status()')
  assert.ok(status.trimmed >= 1, '应记录裁剪次数')
})

test('net：只创建一个周期任务（start 两次不会重复建）', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`A = BWS2.net.start(); B = BWS2.net.start(); OUTS = tostring(A) .. "|" .. tostring(B) .. "|" .. tostring(#TASKS)`)
  assert.equal(t.global('OUTS'), 'true|false|1', '第二次 start 应返回 false 且没有新任务')
  t.run(`TASKS[1].fn()`)
  const queries = t.run
  t.run('OUTS2 = tostring(#QUERIES)')
  assert.ok(Number(t.global('OUTS2')) === 1, '第一次 tick 应该发一次心跳')
})

test('net：网络断了会进 degraded，恢复后回 online', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`BWS2.net.start()`)
  // 连续失败（心跳）
  t.run(`REPLIES = { { ok = false, status = 0, body = '' }, { ok = false, status = 0, body = '' } }`)
  t.run(`CLOCK = CLOCK + 5; TASKS[1].fn()`)
  t.run(`CLOCK = CLOCK + 5; TASKS[1].fn()`)
  assert.equal(t.json('BWS2.connection.status()').state, 'degraded')
  t.run(`REPLIES = { { ok = true, status = 200, body = '{}' } }`)
  t.run(`CLOCK = CLOCK + 30; TASKS[1].fn()`)
  assert.equal(t.json('BWS2.connection.status()').state, 'online')
})

test('strict.lua 行为验证：读不存在的全局会报错，gameVersion 不会因此崩溃', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  // 1) 证明沙箱严到"读不存在的全局名就报错"
  t.run('OK_READ, ERR_READ = GLOBAL.pcall(function() return GLOBAL.SOME_NONEXISTENT_GLOBAL end)')
  t.run('OUTS = tostring(OK_READ) .. "|" .. tostring(ERR_READ ~= nil)')
  assert.equal(t.global('OUTS'), 'false|true', 'strict 模拟没生效')

  // 2) 证明 gameVersion 在这种环境里也不炸（旧写法 GLOBAL[name] 就在这里崩过）
  t.run('HP = BWS2.heartbeat.build(nil)')
  const payload = t.json('HP')
  assert.equal(payload.game_version, 'unknown', '拿不到版本号就老实写 unknown')
  assert.equal(payload.player_status.present, false, 'player 为 nil 时也要能构造心跳')
})

test('net tick 出错被隔离（不会把分片拖崩）', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run('BWS2.net.start()')
  // 让心跳构造过程抛错（模拟任意未知 bug）
  t.run('BWS2.heartbeat.send = function() error("故意抛错") end')
  t.run('CLOCK = CLOCK + 10; TASKS[1].fn()')   // 不抛出去
  t.run('OUTS = "survived"')
  assert.equal(t.global('OUTS'), 'survived')
  t.run('ERRLOG = ""; for i = 1, #CAPTURED do if string.find(CAPTURED[i], "net tick 出错", 1, true) then ERRLOG = CAPTURED[i] end end')
  assert.match(t.global('ERRLOG'), /net tick 出错/)
})

test('telemetry：4xx 视为永久错误，不重试（并计入 rejected）', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`REPLIES = { { ok = false, status = 401, body = '{"success":false}' } }`)
  t.run(`BWS2.telemetry.submit(${META}, { world = { day = 2 } }, nil)`)
  let status = t.json('BWS2.telemetry.status()')
  assert.equal(status.rejected, 1, '应记为被拒绝')
  assert.equal(status.has_pending, false, '4xx 后不该留着 pending')
  assert.equal(status.sequence, 1, '被拒绝时 sequence 不前进')

  // 再 flush 也不会重发
  t.run('CLOCK = CLOCK + 60; BWS2.telemetry.flushIfPending()')
  t.run('QN = tostring(#QUERIES)')
  assert.equal(t.global('QN'), '1', '4xx 之后不应再重试')
})

test('telemetry：瞬时失败（连不上）后要等退避到期才重试', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`REPLIES = { { ok = false, status = 0, body = '' } }`)
  t.run(`BWS2.telemetry.submit(${META}, { world = { day = 2 } }, nil)`)
  assert.equal(t.json('BWS2.telemetry.status()').has_pending, true, '瞬时失败要保留数据')

  t.run('BWS2.telemetry.flushIfPending()')
  t.run('QN1 = tostring(#QUERIES)')
  assert.equal(t.global('QN1'), '1', '退避期内不能重发')

  t.run(`REPLIES = { { ok = true, status = 200, body = '{"success":true,"acknowledged_sequence":1}' } }`)
  t.run('CLOCK = CLOCK + 60; BWS2.telemetry.flushIfPending()')
  t.run('QN2 = tostring(#QUERIES)')
  assert.equal(t.global('QN2'), '2', '退避到期后应重试')
  assert.equal(t.json('BWS2.telemetry.status()').sequence, 2)
})

test('telemetry：客户端（ismastersim=false）不推送', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run('GLOBAL.TheWorld.ismastersim = false')
  t.run(`BWS2.telemetry.submit(${META}, { world = { day = 2 } }, nil)`)
  t.run('QN = tostring(#QUERIES)')
  assert.equal(t.global('QN'), '0', '客户端不该发 telemetry')
  assert.equal(t.json('BWS2.telemetry.status()').sequence, 1)
})
