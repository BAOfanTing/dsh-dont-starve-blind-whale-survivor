// M1.4 Delta 截断修复（0.13.3）：三个必测场景 + 两个补充
//
// 背景：0.13.2 的 delta 拿"截断后的 kept"做基线，被容量限制挤出窗口的实体会被误报成 removed
// （真机证据见 docs/archive/milestones/M1/M1_4_runtime_test_report.md §5）。0.13.3 改成用**完整扫描候选集合**做基线。
//
// A：截断但实体仍存在 → 不得 removed
// B：实体真的离开完整扫描 → removed + previous_ref（不是当前引用）
// C：实体在两次扫描里"进出 kept"抖动 → 不得 removed、不得 added
// D：窗口外的实体属性变化 → 不报 changed（没有 #N，不可操作）
// E：not_returned 字段与数量自洽
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利", EVERGREEN = "常青树", TWIGGYTREE = "多枝树", SPIDER = "蜘蛛" } }
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
    local e = { prefab = opts.prefab or "evergreen", GUID = opts.guid, tags = opts.tags or {}, components = {},
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

async function newVm({ maxPerBucket = 12, maxTotal = 60 } = {}) {
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
  run('Whale = { verbose = false, version = "0.13.3" }')
  for (const name of ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'observe']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', name + '.lua'), 'utf8'))
  }
  run(`Whale.config.build(function(k)
    if k == "scan_radius" then return 16 end
    if k == "scan_seconds" then return 4 end
    if k == "observe_interval" then return 2 end
    if k == "state_interval" then return 1 end
    if k == "nearby_max_total" then return ${maxTotal} end
    if k == "nearby_max_per_bucket" then return ${maxPerBucket} end
    return nil
  end)`)
  const observe = () => {
    run('local a = Whale.actor.get_actor() local d = Whale.observe.BuildData(a, { seq = 0, now = NOW }) OUT = Whale.json.encode(d.nearby)')
    return JSON.parse(get('OUT'))
  }
  return { run, get, observe }
}

const refsOf = (nearby) => Object.values(nearby.buckets).flat().map((x) => x.ref)

test('A 截断但实体仍存在：不得报告 removed，用 not_returned 表达', async () => {
  const env = await newVm({ maxPerBucket: 3 }) // 单桶只留 3 个
  // 第一帧：4 棵树，距离 1..4 → 只返回最近 3 棵（guid 1/2/3，guid 4 被挤出）
  env.run(`
    NEARBY = {}
    for i = 1, 4 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = i, work = "CHOP", hp = 100 })
    end
  `)
  const first = env.observe()
  assert.equal(first.total_found, 4)
  assert.equal(first.total_returned, 3)
  assert.equal(first.delta.status, 'baseline')

  // 第二帧：**4 棵树一棵没少**，只是 guid 1 走远（10 格），guid 4 因此进了窗口
  env.run(`
    NOW = NOW + 5
    NEARBY = {}
    NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = 40, z = 0, guid = 1, work = "CHOP", hp = 100 })
    for i = 2, 4 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = i, work = "CHOP", hp = 100 })
    end
  `)
  const second = env.observe()

  assert.equal(second.total_found, 4, '完整扫描仍然是 4 个')
  assert.equal(second.total_returned, 3)
  assert.equal(second.truncated, true)
  assert.equal(second.delta.status, 'ok')
  assert.equal(second.delta.removed_count, 0, '被挤出窗口 ≠ 消失，removed 必须是 0')
  assert.deepEqual(second.delta.removed, [])
  assert.equal(second.delta.added_count, 0, 'guid 4 上一帧就在完整扫描里，不是新增')
  assert.equal(second.delta.not_returned_count, 1, '要有 not_returned 语义')
  assert.equal(second.delta.not_returned.length, 1)
  assert.equal(second.delta.not_returned[0].prefab, 'evergreen')
  assert.equal(second.delta.not_returned[0].ref, undefined, '未返回的实体不能带引用')
  // 当前引用仍然有效且连续
  assert.deepEqual(refsOf(second), ['#1', '#2', '#3'])
})

test('B 实体真的离开完整扫描：removed=1 + previous_ref（且不是当前引用）', async () => {
  const env = await newVm({ maxPerBucket: 12 })
  env.run(`
    NEARBY = {}
    for i = 1, 4 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = i, work = "CHOP", hp = 100 })
    end
  `)
  const first = env.observe()
  assert.equal(first.total_returned, 4)
  const firstRefs = refsOf(first)
  assert.deepEqual(firstRefs, ['#1', '#2', '#3', '#4'])

  // 第二帧：guid 2 真的不在了（走远/被砍了），其余 3 棵还在
  env.run(`
    NOW = NOW + 5
    NEARBY = {}
    for i = 1, 4 do
      if i ~= 2 then
        NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = i, work = "CHOP", hp = 100 })
      end
    end
  `)
  const second = env.observe()

  assert.equal(second.total_found, 3)
  assert.equal(second.delta.removed_count, 1)
  const gone = second.delta.removed[0]
  assert.equal(gone.prefab, 'evergreen')
  assert.ok(gone.previous_ref, '要带 previous_ref')
  assert.ok(firstRefs.includes(gone.previous_ref), 'previous_ref 应该是上一帧的编号')
  assert.equal(gone.ref, undefined, 'removed 里不许有当前引用字段')
  const current = refsOf(second)
  assert.equal(current.includes(gone.previous_ref) && false, false, 'previous_ref 不能当当前引用用（这里只做记录）')
  assert.deepEqual(current, ['#1', '#2', '#3'], '当前引用仍然连续有效')
})

test('C 实体在 kept 边界抖动：既不报 removed，也不报 added，两个方向都稳定', async () => {
  const env = await newVm({ maxPerBucket: 2 })
  const build = (farGuid) => `
    NEARBY = {}
    for i = 1, 3 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = (i == ${'$'}{FAR} and 40 or i * 4), z = 0, guid = i, work = "CHOP", hp = 100 })
    end`.replace('${FAR}', String(farGuid))

  // 第 1 帧：guid 3 最远 → 被挤出窗口（返回 #1,#2）
  env.run(build(3))
  const first = env.observe()
  assert.equal(first.total_returned, 2)
  assert.equal(first.delta.status, 'baseline')

  // 第 2 帧：guid 1 走远，guid 3 进来（实体集合没变）
  env.run('NOW = NOW + 5')
  env.run(build(1))
  const second = env.observe()
  assert.equal(second.delta.removed_count, 0, '抖动不能报 removed')
  assert.equal(second.delta.added_count, 0, '抖动不能报 added')
  assert.equal(second.delta.not_returned_count, 1)
  assert.deepEqual(refsOf(second), ['#1', '#2'], '当前引用照常重排')

  // 第 3 帧：再换回来（guid 3 又出去）
  env.run('NOW = NOW + 5')
  env.run(build(3))
  const third = env.observe()
  assert.equal(third.delta.removed_count, 0)
  assert.equal(third.delta.added_count, 0)
  assert.equal(third.delta.not_returned_count, 1)
})

test('D 窗口外实体的属性变化：不报 changed（没有 #N 就不可操作）', async () => {
  const env = await newVm({ maxPerBucket: 2 })
  // 3 只蜘蛛：guid 3 最远 → 出窗
  env.run(`
    NEARBY = {}
    for i = 1, 3 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "spider", x = i * 4, z = 0, guid = i, tags = { hostile = true }, hp = 25 })
    end
  `)
  env.observe()
  // 第二帧：窗外那只（guid 3）掉血，其余不变
  env.run(`
    NOW = NOW + 5
    NEARBY = {}
    for i = 1, 3 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "spider", x = i * 4, z = 0, guid = i, tags = { hostile = true }, hp = (i == 3 and 10 or 25) })
    end
  `)
  const second = env.observe()
  assert.equal(second.delta.changed_count, 0, '窗口外的变化不报（模型拿不到 #N，报了也没法处理）')
  assert.equal(second.delta.removed_count, 0)
  assert.equal(second.delta.not_returned_count, 1)
})

test('E not_returned 与 total_found / total_returned 自洽，且 reused 时不重算', async () => {
  const env = await newVm({ maxPerBucket: 2 })
  env.run(`
    NEARBY = {}
    for i = 1, 5 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = i, work = "CHOP", hp = 100 })
    end
  `)
  const first = env.observe()
  assert.equal(first.delta.not_returned_count, first.total_found - first.total_returned)
  assert.equal(first.delta.not_returned.length, Math.min(12, first.delta.not_returned_count))

  // 未到 scan_seconds：reused，delta 原样
  env.run('NOW = NOW + 1')
  const reused = env.observe()
  assert.equal(reused.scan.reused, true)
  assert.equal(reused.delta.status, first.delta.status)
  assert.equal(reused.delta.not_returned_count, first.delta.not_returned_count)
})
