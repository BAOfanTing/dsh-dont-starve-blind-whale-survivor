// Delta 截断修复的"修复前 / 修复后"对比（沙箱，只读）
//
// 用法：
//   node tools/m14-delta-compare.mjs                       # 用 git 里的上一个版本当"修复前"
//   node tools/m14-delta-compare.mjs --before <path>       # 指定"修复前"的 nearby.lua
//
// 场景（与审计探针 A 相同）：4 棵树、单桶上限 3。
//   第 1 次扫描：返回最近 3 棵（guid 1/2/3），guid 4 被挤出窗口
//   第 2 次扫描：4 棵树一棵没少，只是 guid 1 走远 → guid 4 进窗、guid 1 出窗
// 修复前：把"出窗"的 guid 1 报成 removed（误报）
// 修复后：removed=0，改用 not_returned 表达
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const args = process.argv.slice(2)
const argOf = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : null
}

let tmpDir = null
let beforePath = argOf('before')
if (!beforePath) {
  tmpDir = mkdtempSync(join(tmpdir(), 'bws-delta-before-'))
  beforePath = join(tmpDir, 'nearby-before.lua')
  // 用 git 历史里的版本（M1.4 验收提交）当"修复前"
  const raw = execFileSync('git', ['show', '1751858:DontStarveWhaleSurvivor/scripts/whale/nearby.lua'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  writeFileSync(beforePath, raw, 'utf8')
}

const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利", EVERGREEN = "常青树" } }
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
    local e = { prefab = opts.prefab or "evergreen", GUID = opts.guid, tags = {}, components = {},
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

async function runScenario(nearbyPath) {
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
  for (const name of ['json', 'util', 'config', 'actor']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', name + '.lua'), 'utf8'))
  }
  run(readFileSync(nearbyPath, 'utf8'))
  run(readFileSync(join(MOD, 'scripts', 'whale', 'observe.lua'), 'utf8'))
  run(`Whale.config.build(function(k)
    if k == "scan_radius" then return 16 end
    if k == "scan_seconds" then return 4 end
    if k == "nearby_max_total" then return 60 end
    if k == "nearby_max_per_bucket" then return 3 end
    return nil
  end)`)

  const observe = () => {
    run('local a = Whale.actor.get_actor() local d = Whale.observe.BuildData(a, { seq = 0, now = NOW }) TEXT = (function() return Whale.observe.Render(d) end)() OUT = Whale.json.encode(d.nearby)')
    return { nearby: JSON.parse(get('OUT')), text: get('TEXT') }
  }

  // 第一帧：4 棵树，距离 1..4 格
  run(`
    NEARBY = {}
    for i = 1, 4 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = i, work = "CHOP", hp = 100 })
    end
  `)
  const first = observe()

  // 第二帧：一棵没少，只是 guid 1 走到 10 格外
  run(`
    NOW = NOW + 5
    NEARBY = {}
    NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = 40, z = 0, guid = 1, work = "CHOP", hp = 100 })
    for i = 2, 4 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = i, work = "CHOP", hp = 100 })
    end
  `)
  const second = observe()

  return { first: first.nearby, second: second.nearby, text: second.text }
}

const before = await runScenario(beforePath)
const after = await runScenario(join(MOD, 'scripts', 'whale', 'nearby.lua'))

const pick = (n) => ({
  status: n.delta.status,
  added: n.delta.added_count,
  removed: n.delta.removed_count,
  changed: n.delta.changed_count,
  notReturned: n.delta.not_returned_count ?? null,
  removedDetail: (n.delta.removed ?? []).map((x) => `${x.previous_ref ?? '?'}:${x.prefab}`),
})

console.log('=== 场景：4 棵树、单桶 3；第二帧一棵没少，只是第 1 棵走远 ===\n')
console.log('修复前（1751858 = 0.13.2）：')
console.log('  第 1 帧 total_found=' + before.first.total_found + ' returned=' + before.first.total_returned + ' delta=' + before.first.delta.status)
console.log('  第 2 帧 delta=' + JSON.stringify(pick(before.second)))
console.log('修复后（当前工作区 = 0.13.3）：')
console.log('  第 1 帧 total_found=' + after.first.total_found + ' returned=' + after.first.total_returned + ' delta=' + after.first.delta.status)
console.log('  第 2 帧 delta=' + JSON.stringify(pick(after.second)))

console.log('\n=== 第 2 帧文本（修复后）===')
console.log(after.text)

const verdict = {
  beforeFalseRemoval: before.second.delta.removed_count > 0,
  afterFalseRemoval: after.second.delta.removed_count > 0,
  afterNotReturned: after.second.delta.not_returned_count ?? null,
}
console.log('\n=== 结论 ===')
console.log(`修复前是否误报 removed：${verdict.beforeFalseRemoval ? '是（缺陷）' : '否'}`)
console.log(`修复后是否误报 removed：${verdict.afterFalseRemoval ? '是（仍未修好）' : '否（已修好）'}`)
console.log(`修复后 not_returned_count：${verdict.afterNotReturned}`)

if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
