// Phase 1 / 里程碑 2 回归：只加载 json_encoder + observer_manager（不加载三个观察器）
// 验证：boot/state 两种行都打出来、tick 递增、观察器缺失时降级成 problems 而不是崩掉。
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
GLOBAL.next = next
GLOBAL.io = nil
GLOBAL.os = { time = function() return 1794410000 end }
GLOBAL.TheSim = { GetTime = function() return 12.5 end }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "TESTSESSION" end }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }

local player = { prefab = "wilson" }
function player:IsValid() return true end
GLOBAL.AllPlayers = { ["KU_1"] = player }

GLOBAL.TheWorld = {
    prefab = "forest",
    ismastersim = true,
    state = { cycles = 2, phase = "day", season = "autumn", temperature = 12.5, isday = true },
    HasTag = function(self, tag) return false end,
    DoPeriodicTask = function(self, interval, fn)
        PERIODIC = fn
        PERIOD_INTERVAL = interval
    end,
}

env = { GetModConfigData = function(key) if key == "OBSERVER_INTERVAL" then return 1 end end }
modname = "BlindWhaleSurvivor"
print = function(text) CAPTURED[#CAPTURED + 1] = text end

pcall = nil
tonumber = nil
error = nil
next = nil
os = nil
io = nil
`

function loadM2(fengari) {
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

  return { run, global, lines, fail }
}

test('json_encoder：在沙箱里能编码字符串/数字/布尔/数组/对象', async () => {
  const fengari = await import('fengari')
  const t = loadM2(fengari)
  t.run(`
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
  const parsed = JSON.parse(t.global('OUT'))
  assert.equal(parsed.s, '带"引号"和\n换行')
  assert.equal(parsed.n, 12)
  assert.equal(parsed.f, 1.25)
  assert.equal(parsed.b, false)
  assert.deepEqual(parsed.arr, [1, 2, 3])
  assert.equal(parsed.nested.a.b, 'c')
  assert.ok(!('nul' in parsed), 'nil 字段应该直接不出现')
})

test('观察器：Start 打 boot，周期任务打 state，tick 递增，字段对得上', async () => {
  const fengari = await import('fengari')
  const t = loadM2(fengari)
  t.run('assert(BWS.observer.Start() == true, "世界已就绪，Start 应该成功")')
  t.run('assert(PERIODIC ~= nil, "应该挂了 DoPeriodicTask")')
  t.run('assert(PERIOD_INTERVAL == 1, "采样间隔应读 modinfo 的 1 秒，实际 " .. tostring(PERIOD_INTERVAL))')
  t.run('PERIODIC(); PERIODIC()')

  const all = t.lines()
  assert.equal(all.length, 3, '一条 boot + 两条 state')

  const [boot, s1, s2] = all
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

  assert.equal(s1.type, 'state')
  assert.equal(s1.observer.tick, 1)
  assert.equal(s2.observer.tick, 2)
  assert.equal(s1.observer.interval, 1)
  assert.equal(s1.observer.errors, 0)
  assert.equal(s1.observer.players.count, 1)
  // 这个用例里没加载三个观察器：应该降级成 problems，而不是报错
  assert.equal(s1.observer.problems.player, 'player_unavailable')
  assert.equal(s1.observer.problems.world, 'world_unavailable')
})

test('观察器：世界还没就绪时 Start 返回 false，不输出', async () => {
  const fengari = await import('fengari')
  const t = loadM2(fengari)
  t.run('GLOBAL.TheWorld = nil')
  t.run('assert(BWS.observer.Start() == false, "世界没有时应该返回 false")')
  assert.equal(t.global('OUT'), '')
})

test('观察器：玩家集合缺失时 state 仍然正常输出', async () => {
  const fengari = await import('fengari')
  const t = loadM2(fengari)
  t.run('GLOBAL.AllPlayers = nil')
  t.run('BWS.observer.Start(); PERIODIC()')
  const state = t.lines()[1]
  assert.equal(state.type, 'state')
  assert.equal(state.observer.players.count, -1)
  assert.equal(state.observer.problems.player, 'no_player')
})
