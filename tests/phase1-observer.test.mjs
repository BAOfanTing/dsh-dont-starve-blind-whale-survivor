// Phase 1 / 里程碑 2：最小观察器（json_encoder + observer_manager）
// 在真 Lua 虚拟机里、按饥荒沙箱的规则（没有 pcall/tonumber/os/io）跑一遍，
// 检查它打出来的日志行是 "[BWS] " + 合法 JSON，并且字段对得上。
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

GLOBAL = {}
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.io = nil
GLOBAL.os = { time = function() return 1794410000 end }
GLOBAL.TheSim = { GetTime = function() return 12.5 end }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "TESTSESSION" end }

local player = { prefab = "wilson" }
function player:IsValid() return true end

GLOBAL.AllPlayers = { ["KU_1"] = player }
GLOBAL.TheWorld = {
    ismastersim = true,
    state = { cycles = 3, phase = "day", season = "autumn", temperature = 12.5 },
    HasTag = function(self, tag) return false end,
    DoPeriodicTask = function(self, interval, fn)
        PERIODIC = fn
        PERIOD_INTERVAL = interval
    end,
}

env = { GetModConfigData = function(key) if key == "OBSERVER_INTERVAL" then return 1 end end }
modname = "BlindWhaleSurvivor"
print = function(text) CAPTURED[#CAPTURED + 1] = text end

-- 模拟沙箱：裸的这些是 nil
pcall = nil
tonumber = nil
error = nil
os = nil
io = nil
`

function loadObserver(fengari) {
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
  for (const file of ['scripts/main/json_encoder.lua', 'scripts/main/observer_manager.lua']) {
    status = lauxlib.luaL_dostring(L, to_luastring(readFileSync(join(MOD, file), 'utf8')))
    assert.equal(status, lua.LUA_OK, `${file} 加载失败（游戏里会变成 mod 加载失败）：` + fail())
  }
  const run = (code) => {
    status = lauxlib.luaL_dostring(L, to_luastring(code))
    assert.equal(status, lua.LUA_OK, '运行出错：' + fail())
  }
  const global = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try {
      return to_jsstring(lua.lua_tostring(L, -1))
    } catch {
      return ''
    }
  }
  return { run, global, fail }
}

/** 取出 "[BWS] " 之后的 JSON 并解析 */
function parseLines(fengari, { run, global }) {
  run('JUMP = table.concat(CAPTURED, "\\n---\\n")')
  const raw = global('JUMP')
  const lines = raw.split('\n---\n').filter(Boolean)
  return lines.map((line) => {
    assert.ok(line.startsWith('[BWS] '), '日志行必须以 [BWS] 开头，实际：' + line)
    const json = line.slice('[BWS] '.length)
    try {
      return JSON.parse(json)
    } catch (error) {
      throw new Error('日志里的 JSON 解析失败：' + json)
    }
  })
}

test('json_encoder：在沙箱里能编码字符串/数字/布尔/数组/对象', async () => {
  const fengari = await import('fengari')
  const { run, global } = loadObserver(fengari)
  run(`
    OUT = BWS.json.encode({
        s = "带\\"引号\\"和\\n换行",
        n = 12,
        f = 1.25,
        b = false,
        arr = { 1, 2, 3 },
        nested = { a = { b = "c" } },
        nul = nil,
    })
  `)
  const parsed = JSON.parse(global('OUT'))
  assert.equal(parsed.s, '带"引号"和\n换行')
  assert.equal(parsed.n, 12)
  assert.equal(parsed.f, 1.25)
  assert.equal(parsed.b, false)
  assert.deepEqual(parsed.arr, [1, 2, 3])
  assert.equal(parsed.nested.a.b, 'c')
  assert.ok(!('nul' in parsed), 'nil 字段应该直接不出现')
})

test('观察器：Start 打出 boot 行，周期任务打出 heartbeat 行，字段都对', async () => {
  const fengari = await import('fengari')
  const ctx = loadObserver(fengari)
  ctx.run('assert(BWS.observer.Start() == true, "世界已就绪，Start 应该成功")')
  ctx.run('assert(PERIODIC ~= nil, "应该挂了 DoPeriodicTask")')
  ctx.run('assert(PERIOD_INTERVAL == 1, "采样间隔应该读 modinfo 的 1 秒，实际 " .. tostring(PERIOD_INTERVAL))')
  ctx.run('PERIODIC(); PERIODIC()')

  const lines = parseLines(fengari, ctx)
  assert.equal(lines.length, 3, '应该是 1 条 boot + 2 条 heartbeat')
  const [boot, hb1, hb2] = lines

  // boot
  assert.equal(boot.schema_version, '1')
  assert.equal(boot.type, 'boot')
  assert.equal(boot.phase, 1)
  assert.equal(boot.side, 'server')
  assert.equal(boot.shard, 'master')
  assert.equal(boot.mod, 'BlindWhaleSurvivor')
  assert.equal(boot.ismastersim, true)
  assert.equal(boot.interval, 1)
  assert.equal(boot.session, 'TESTSESSION')
  assert.equal(boot.t, 1794410000)
  assert.equal(boot.gt, 12.5)
  assert.equal(boot.players.count, 1)
  assert.equal(boot.players.valid, true)
  assert.equal(boot.players.prefab, 'wilson')
  assert.equal(boot.world.day, 3)
  assert.equal(boot.world.phase, 'day')
  assert.equal(boot.world.season, 'autumn')
  assert.equal(boot.world.temperature, 12.5)

  // heartbeat
  assert.equal(hb1.type, 'heartbeat')
  assert.equal(hb1.tick, 1)
  assert.equal(hb2.tick, 2)
  assert.equal(hb1.errors, 0)
  assert.equal(hb1.interval, 1)
  assert.equal(hb2.players.count, 1)
})

test('观察器：世界还没就绪时 Start 返回 false，不报错', async () => {
  const fengari = await import('fengari')
  const ctx = loadObserver(fengari)
  ctx.run('GLOBAL.TheWorld = nil')
  ctx.run('assert(BWS.observer.Start() == false, "世界没有时应该返回 false")')
  const status = ctx.global('OUT')
  assert.equal(status, '', '不该输出任何东西')
})

test('观察器：玩家集合拿不到时也不崩（players.available=false）', async () => {
  const fengari = await import('fengari')
  const ctx = loadObserver(fengari)
  ctx.run('GLOBAL.AllPlayers = nil')
  ctx.run('BWS.observer.Start(); PERIODIC()')
  const lines = parseLines(fengari, ctx)
  const heartbeat = lines[lines.length - 1]
  assert.equal(heartbeat.type, 'heartbeat')
  assert.equal(heartbeat.players.available, false)
  assert.equal(heartbeat.players.count, -1)
})
