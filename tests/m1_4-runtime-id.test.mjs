// M1.4 验收发现的安全回归：运行实例隔离
//
// 真机上观察到的两个事实：
//   1. session_id 跨"重启游戏"不变（两次采样都是 5F056B29DE65C542）；
//   2. scan_seq 每次运行都从 1 开始。
// 所以如果 snapshot_id 只有 "n1"，重启后的新实例会产出同样的 "n1"，
// 上一次运行的 (#1, n1) 就会被解析成新实例里的**另一个实体**。
// 0.13.2 起 snapshot_id = "<运行实例号>-n<序号>"，Resolve() 只认当前实例。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利", SPIDER = "蜘蛛", EVERGREEN = "常青树" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.FOODTYPE = { ROUGHAGE = "ROUGHAGE", SEEDS = "SEEDS", GEARS = "GEARS", VEGGIE = "VEGGIE" }
GLOBAL.ACTIONS = { CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, DIG = { id = "DIG" }, HAMMER = { id = "HAMMER" } }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "sess-SAME" end }
GLOBAL.TheShard = { GetShardId = function() return "1" end }
NOW = 1000
NEARBY = {}
GLOBAL.TheSim = { GetTime = function() return NOW end, GetRealTime = function() return NOW * 1000 end,
                  FindEntities = function() return NEARBY end }
function mkent(opts)
    local e = { prefab = opts.prefab, GUID = opts.guid or 1, tags = opts.tags or {}, components = {},
                Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end } }
    e.IsValid = function() return true end
    e.HasTag = function(self, tag) if tag == "INLIMBO" then return false end return self.tags[tag] == true end
    if opts.hp ~= nil then e.components.health = { currenthealth = opts.hp, maxhealth = opts.hp, IsDead = function() return false end } end
    if opts.work ~= nil then e.components.workable = { action = { id = opts.work } } end
    return e
end
PLAYER = mkent({ prefab = "warly", guid = 999, tags = { player = true }, hp = 150 })
PLAYER.userid = "KU_probe"
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
GLOBAL.os = { time = function() return 1794500000 end }
GLOBAL.io = nil
pcall = nil
tonumber = nil
error = nil
os = nil
io = nil
`

async function newVm() {
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
  run(STUB)
  run('Whale = { verbose = false, version = "0.13.2" }')
  for (const name of ['json', 'util', 'config', 'actor', 'nearby', 'observe']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', name + '.lua'), 'utf8'))
  }
  run('Whale.config.build(function(k) if k == "scan_radius" then return 16 end if k == "scan_seconds" then return 4 end return nil end)')
  const observe = () => {
    run('local a = Whale.actor.get_actor() local d = Whale.observe.BuildData(a, { seq = 0, now = NOW }) OUT = Whale.json.encode(d.nearby)')
    return JSON.parse(get('OUT'))
  }
  return { run, get, observe }
}

test('运行实例隔离：snapshot_id 带实例号，且旧实例的引用会被拒绝', async () => {
  const first = await newVm()
  first.run('NEARBY = { mkent({ prefab = "spider", x = 8, z = 0, guid = 1, tags = { hostile = true }, hp = 25 }) }')
  const one = first.observe()

  assert.match(one.runtime_id ?? '', /^r\d+-\d{4}$/, '要有运行实例号')
  assert.equal(
    one.snapshot_id.indexOf(one.runtime_id + '-n'),
    0,
    'snapshot_id 必须以运行实例号开头，实际：' + one.snapshot_id,
  )

  // 同一实例内能解析
  first.run('local ent, why = Whale.nearby.Resolve("' + one.snapshot_id + '", "#1") OUT = ent ~= nil and ("ok:" .. ent.prefab) or ("reject:" .. tostring(why))')
  assert.equal(first.get('OUT'), 'ok:spider', '同实例内应该能解析')

  // 模拟"游戏重启"：全新 Lua 实例（session 相同，世界里换成另一只东西）
  const second = await newVm()
  second.run('NEARBY = { mkent({ prefab = "evergreen", x = 12, z = 0, guid = 2, work = "CHOP", hp = 100 }) }')
  const two = second.observe()
  assert.notEqual(two.snapshot_id, one.snapshot_id, '两个运行实例的快照号不能相同')

  // 拿上一个实例的快照号来解析 → 必须 stale_snapshot，不能命中 evergreen
  second.run('local ent, why = Whale.nearby.Resolve("' + one.snapshot_id + '", "#1") OUT = ent ~= nil and ("hit:" .. ent.prefab) or ("reject:" .. tostring(why))')
  assert.equal(second.get('OUT'), 'reject:stale_snapshot', '旧实例的引用必须被拒绝，实际：' + second.get('OUT'))
})

test('运行实例隔离：同一实例内两次扫描的引用互不串（旧扫描号也拒绝）', async () => {
  const env = await newVm()
  env.run('NEARBY = { mkent({ prefab = "spider", x = 8, z = 0, guid = 1, tags = { hostile = true }, hp = 25 }) }')
  const first = env.observe()
  env.run('NOW = NOW + 10')
  env.run('NEARBY = { mkent({ prefab = "evergreen", x = 12, z = 0, guid = 2, work = "CHOP", hp = 100 }) }')
  const second = env.observe()

  assert.notEqual(first.snapshot_id, second.snapshot_id, '新扫描要换快照号')
  env.run('local ent, why = Whale.nearby.Resolve("' + first.snapshot_id + '", "#1") OUT = ent ~= nil and ("hit:" .. ent.prefab) or ("reject:" .. tostring(why))')
  assert.equal(env.get('OUT'), 'reject:stale_snapshot', '旧扫描号不该还能解析')
})
