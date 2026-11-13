// M1.4 收尾：scan.duration_ms 计时精度（0.13.4）
//
// 真机现象：0.13.3 及以前 duration_ms 恒为 0 —— 因为用的是秒级时间戳 ×1000 再取整。
// 0.13.4 改为：优先 os.clock()（亚毫秒），退回 TheSim:GetRealTime()（毫秒），两者都不可用 → null。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

/** clockMode: "os" | "realtime" | "broken" | "none" | "mixed" */
const STUB_BASE = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利", EVERGREEN = "常青树" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.FOODTYPE = { ROUGHAGE = "ROUGHAGE", SEEDS = "SEEDS", GEARS = "GEARS", VEGGIE = "VEGGIE" }
GLOBAL.ACTIONS = { CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, DIG = { id = "DIG" }, HAMMER = { id = "HAMMER" } }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "sess-T" end }
GLOBAL.TheShard = { GetShardId = function() return "1" end }
NOW = 1000
CLOCK = 0        -- os.clock 的假实现（秒）
RT_MS = 5000     -- GetRealTime 的假实现（毫秒）
NEARBY = {}
FAIL_SCAN = false
GLOBAL.TheSim = { GetTime = function() return nil end,
                  FindEntities = function() if FAIL_SCAN then error("boom") end return NEARBY end }
function mkent(opts)
    local e = { prefab = opts.prefab or "evergreen", GUID = opts.guid or 1, tags = {}, components = {},
                Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end } }
    e.IsValid = function() return true end
    e.HasTag = function(self, tag) if tag == "INLIMBO" then return false end return self.tags[tag] == true end
    if opts.work ~= nil then e.components.workable = { action = { id = opts.work } } end
    return e
end
PLAYER = mkent({ prefab = "warly", guid = 999 })
PLAYER.userid = "KU_t"
PLAYER.components.inventory = { GetNumSlots = function() return 15 end, GetItemInSlot = function() return nil end,
                                GetEquippedItem = function() return nil end }
GLOBAL.AllPlayers = { PLAYER }
GLOBAL.TheWorld = { state = { cycles = 1, phase = "day", season = "autumn", temperature = 20 },
                    HasTag = function() return false end, ismastersim = true }
GLOBAL.setmetatable = setmetatable
GLOBAL.getmetatable = getmetatable
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.io = nil
pcall = nil
tonumber = nil
error = nil
os = nil
io = nil
`

function clockCode(mode) {
  switch (mode) {
    case 'os':
      return `
        GLOBAL.os = { time = function() return 1794500000 end,
                      clock = function() CLOCK = CLOCK + 0.0007 return CLOCK end }
        GLOBAL.TheSim.GetRealTime = function() return RT_MS end
      `
    case 'realtime':
      return `
        GLOBAL.os = { time = function() return 1794500000 end }
        GLOBAL.TheSim.GetRealTime = function() RT_MS = RT_MS + 3 return RT_MS end
      `
    case 'broken':
      return `
        GLOBAL.os = { time = function() return 1794500000 end,
                      clock = function() return "not-a-number" end }
        GLOBAL.TheSim.GetRealTime = function() return 0/0 end
      `
    case 'mixed':
      // 第一次走 os.clock，第二次 os.clock 抛错 → 源不一致，应判为不可用
      return `
        GLOBAL.os = { time = function() return 1794500000 end,
                      clock = function() CLOCK = CLOCK + 1 if CLOCK > 1 then error("boom") end return CLOCK end }
        GLOBAL.TheSim.GetRealTime = function() RT_MS = RT_MS + 5 return RT_MS end
      `
    default:
      return `
        GLOBAL.os = { time = function() return 1794500000 end }
      `
  }
}

async function newVm(mode) {
  const fengari = await import('fengari')
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
  const run = (code) => {
    const st = lauxlib.luaL_dostring(L, to_luastring(code))
    if (st !== lua.LUA_OK) throw new Error('Lua 出错：' + fail())
  }
  const get = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try {
      return to_jsstring(lua.lua_tostring(L, -1))
    } catch {
      return ''
    }
  }
  run(STUB_BASE)
  run(clockCode(mode))
  run('Whale = { verbose = false, version = "0.13.4" }')
  for (const name of ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'observe']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', name + '.lua'), 'utf8'))
  }
  run('Whale.config.build(function(k) if k == "scan_radius" then return 16 end if k == "scan_seconds" then return 4 end return nil end)')
  run('NEARBY = { mkent({ prefab = "evergreen", x = 4, z = 0, guid = 1, work = "CHOP" }) }')
  const observe = () => {
    run('local a = Whale.actor.get_actor() local d = Whale.observe.BuildData(a, { seq = 0, now = NOW }) OUT = Whale.json.encode(d.nearby)')
    return JSON.parse(get('OUT'))
  }
  return { run, get, observe }
}

test('计时-1 os.clock 可用：记录亚毫秒耗时（1 位小数，不再是 0）', async () => {
  const env = await newVm('os')
  const nearby = env.observe()
  assert.equal(nearby.scan.duration_source, 'os.clock')
  assert.equal(typeof nearby.scan.duration_ms, 'number')
  assert.ok(nearby.scan.duration_ms > 0, '亚毫秒也要有值，实际：' + nearby.scan.duration_ms)
  assert.equal(nearby.scan.duration_ms, 0.7, '两次 clock 各前进 0.7ms → 0.7ms')
})

test('计时-2 只有 GetRealTime：按毫秒算', async () => {
  const env = await newVm('realtime')
  const nearby = env.observe()
  assert.equal(nearby.scan.duration_source, 'realtime')
  assert.equal(nearby.scan.duration_ms, 3, '两次调用各 +3ms')
})

test('计时-3 两个时钟都不可用：duration_ms 为 null，不伪装成 0，快照仍正常', async () => {
  const env = await newVm('none')
  const nearby = env.observe()
  assert.equal(nearby.status, 'ok', '计时失败不该拖垮快照')
  assert.ok(nearby.scan.duration_ms == null, '计时不可用时应为 null/缺席')
  assert.equal(nearby.scan.duration_source, 'unavailable')
})

test('计时-4 时钟返回异常值：不污染状态', async () => {
  const env = await newVm('broken')
  const nearby = env.observe()
  assert.equal(nearby.status, 'ok')
  assert.ok(nearby.scan.duration_ms == null, '计时不可用时应为 null/缺席')
  assert.equal(nearby.scan.duration_source, 'unavailable')
})

test('计时-5 两次调用时钟源不一致：判为不可用（不给出错误差值）', async () => {
  const env = await newVm('mixed')
  const nearby = env.observe()
  assert.equal(nearby.status, 'ok')
  assert.ok(nearby.scan.duration_ms == null, '混用两个时钟源算出来的差值没有意义')
  assert.equal(nearby.scan.duration_source, 'unavailable')
})

test('计时-6 扫描失败：status=error 且不写假耗时', async () => {
  const env = await newVm('os')
  env.run('FAIL_SCAN = true')
  const nearby = env.observe()
  assert.equal(nearby.status, 'error')
  assert.ok(nearby.scan.duration_ms == null, '计时不可用时应为 null/缺席')
  assert.equal(nearby.scan.duration_source, 'unavailable')
})

test('计时-7 复用快照：沿用原来的耗时，不虚构新的一次扫描', async () => {
  const env = await newVm('os')
  const first = env.observe()
  env.run('NOW = NOW + 1') // 未到 scan_seconds，应复用
  const reused = env.observe()
  assert.equal(reused.scan.reused, true)
  assert.equal(reused.snapshot_id, first.snapshot_id)
  assert.equal(reused.scan.duration_ms ?? null, first.scan.duration_ms ?? null, '复用不该产生新的耗时')
  assert.equal(reused.scan.duration_source, first.scan.duration_source)
})
