// M2.0.2 真机修复回归：Lua 权威租约走持久化字符串通道（不是 io.open）
//
// 真机发现：DST 模组沙箱 GLOBAL.io == nil（bin64 里没有 Lua 写的
// whale_io_state.json / whale_io_result.json），只有 TheSim:GetPersistentString 双向可用。
// 所以 bridge.lua 每 tick 用 ps_read 读权威文件并缓存，guard.validate 用新鲜缓存。
//
// 证据类型：UNIT（fengari），不是 DST 真机。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authority, command, luaIoFiles } from './helpers-m2.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.FOODTYPE = { ROUGHAGE = "ROUGHAGE", SEEDS = "SEEDS", GEARS = "GEARS", VEGGIE = "VEGGIE" }
GLOBAL.ACTIONS = { CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, DIG = { id = "DIG" }, HAMMER = { id = "HAMMER" } }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "sess-R" end }
GLOBAL.TheShard = { GetShardId = function() return "1" end }
NOW = 1000
NOW_MS = 1794500000000
NEARBY = {}
PS_TEXT = nil     -- GetPersistentString 会回调这个文本（带 KLEI 头）
PS_CALLS = 0
GLOBAL.TheSim = {
    GetTime = function() return NOW end, GetRealTime = function() return NOW * 1000 end,
    FindEntities = function() return NEARBY end,
    SetPersistentString = function(name, text, cb) return true end,
    GetPersistentString = function(name, cb)
        PS_CALLS = PS_CALLS + 1
        if PS_TEXT ~= nil then cb(true, PS_TEXT) else cb(false, nil) end
    end,
}
function mkent(opts)
    local e = { prefab = opts.prefab or "evergreen", GUID = opts.guid or 1, tags = opts.tags or {}, components = {},
                Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end } }
    e.IsValid = function() return true end
    e.HasTag = function(self, tag) if tag == "INLIMBO" then return false end if tag == "playerghost" then return false end return self.tags[tag] == true end
    if opts.hp ~= nil then e.components.health = { currenthealth = opts.hp, maxhealth = opts.hp, IsDead = function() return false end } end
    return e
end
PLAYER = mkent({ prefab = "warly", guid = 999, tags = { player = true }, hp = 100 })
PLAYER.userid = "KU_r"
PLAYER.components.inventory = { GetNumSlots = function() return 15 end, GetItemInSlot = function() return nil end,
                               GetEquippedItem = function() return nil end }
PLAYER.components.locomotor = {}
GLOBAL.AllPlayers = { PLAYER }
GLOBAL.TheWorld = { state = { cycles = 1, phase = "day", season = "autumn", temperature = 20 },
                    HasTag = function() return false end, ismastersim = true }
GLOBAL.setmetatable = setmetatable
GLOBAL.getmetatable = getmetatable
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.os = { time = function() return math.floor(NOW_MS / 1000) end, clock = function() return 0 end }
pcall = nil
tonumber = nil
error = nil
os = nil
io = nil
`

async function load() {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code) => {
    const st = lauxlib.luaL_dostring(L, to_luastring(code))
    if (st !== lua.LUA_OK) {
      let m = ''
      try { m = to_jsstring(lua.lua_tostring(L, -1)) } catch {}
      throw new Error('Lua: ' + m)
    }
  }
  const get = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' }
  }
  const setCmd = (c) => run(`CMD = Whale.json.decode([==[${JSON.stringify(c)}]==])`)
  const validate = () => {
    run('local ok, why = Whale.guard.validate(CMD); OUT = tostring(ok) .. "|" .. tostring(why)')
    return get('OUT')
  }
  run(STUB)
  run(luaIoFiles({})) // 没有 io 文件：模拟真机 GLOBAL.io == nil 的情况
  run('Whale = { verbose = false, version = "0.14.2", files = { lease = "whale_lease.json", io_lease = "whale_io_lease.json" } }')
  for (const name of ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'guard', 'observe', 'actions', 'macros', 'bridge']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', name + '.lua'), 'utf8'))
  }
  run('Whale.config.build(function(k) if k == "scan_radius" then return 16 end return nil end)')
  run('Whale.nearby.runtime_id = function() return "r1794500000-0001" end')
  return { run, get, setCmd, validate }
}

const A = authority({ runtime_id: 'r1794500000-0001' })
const withHeader = (o) => `KLEI     1 ${JSON.stringify(o)}`

test('通道-1 真机形态：没有 io 文件、PS_TEXT 有权威租约 → 通过缓存放行', async () => {
  const env = await load()
  env.run(`PS_TEXT = ${JSON.stringify(withHeader(A))}`)
  // 模拟 bridge.lua 的 poll_authority：ps_read → parse → 缓存
  env.run(`
    Whale.bridge.poll_authority_for_test = function()
      local text = PS_TEXT
      local a = Whale.guard.parse_authority(text)
      Whale.authority_cache = { data = a, at = GLOBAL.os.time() }
    end
  `)
  env.run('Whale.bridge.poll_authority_for_test()')
  env.setCmd(command(A))
  assert.equal(env.validate(), 'true|nil', 'ps 缓存生效，合法命令通过')
})

test('通道-2 缓存过期（>5s）→ authority_unavailable（fail-closed）', async () => {
  const env = await load()
  env.run(`PS_TEXT = ${JSON.stringify(withHeader(A))}`)
  env.run(`
    local a = Whale.guard.parse_authority(PS_TEXT)
    Whale.authority_cache = { data = a, at = GLOBAL.os.time() - 6 }
  `)
  env.setCmd(command(A))
  assert.equal(env.validate(), 'false|authority_unavailable')
})

test('通道-3 缓存里是 revoking → 拒绝所有动作', async () => {
  const env = await load()
  env.run(`PS_TEXT = ${JSON.stringify(withHeader(authority({ ...A, status: 'revoking', generation: 13 })))}`)
  env.run(`Whale.authority_cache = { data = Whale.guard.parse_authority(PS_TEXT), at = GLOBAL.os.time() }`)
  env.setCmd(command(A))
  assert.equal(env.validate(), 'false|authority_revoking')
})

test('通道-4 缓存里的权威与命令不匹配 → 精确拒绝', async () => {
  const env = await load()
  env.run(`PS_TEXT = ${JSON.stringify(withHeader(authority({ ...A, generation: 13, lease_id: 'B' })))}`)
  env.run(`Whale.authority_cache = { data = Whale.guard.parse_authority(PS_TEXT), at = GLOBAL.os.time() }`)
  env.setCmd(command(A))
  assert.equal(env.validate(), 'false|stale_generation', '旧 generation 优先于 lease_id 判定')
})

test('通道-5 静态检查：bridge.lua 用 ps_read 读权威租约并缓存', () => {
  const bridge = readFileSync(join(MOD, 'scripts', 'whale', 'bridge.lua'), 'utf8')
  const guard = readFileSync(join(MOD, 'scripts', 'whale', 'guard.lua'), 'utf8')
  assert.ok(bridge.includes('ps_read(FILES.lease'), '走持久化字符串通道')
  assert.ok(/authority_cache\s*=\s*\{\s*data\s*=\s*a\s*,\s*at\s*=\s*os\.time\(\)\s*\}/.test(bridge), '写缓存带时间戳')
  assert.ok(bridge.includes('step("读权威租约", poll_authority)'), '每 tick 刷新')
  assert.ok(guard.includes('function cached_authority()'), 'guard 用缓存')
  assert.ok(guard.includes('G.AUTHORITY_CACHE_MAX_AGE = 5'), '缓存有新鲜度上限')
})

test('通道-6 io 兜底仍可用（沙箱/将来 io 可用时）', async () => {
  const env = await load()
  env.run(luaIoFiles({ 'whale_io_lease.json': A }))
  env.setCmd(command(A))
  assert.equal(env.validate(), 'true|nil')
})
