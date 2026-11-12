// M1.4 验收探针（沙箱，只读，不碰游戏）：把两个"审查疑点"变成可复现的实验。
//
// 用法：node tools/m14-audit-probes.mjs
//
// 探针 A：Delta 是否把"被截断挤出窗口"的实体误报成 removed？
// 探针 B：snapshot_id 在"模块重新加载 / 游戏重启"后是否会与上一次运行撞号、从而让旧 #N 解析到新实体？
//
// 两个探针都用 fake 一场假游戏，只跑模组真实的 nearby.lua / observe.lua 代码；不启动 DST。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利", EVERGREEN = "常青树", SPIDER = "蜘蛛", TWIGGYTREE = "多枝树" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.FOODTYPE = { ROUGHAGE = "ROUGHAGE", SEEDS = "SEEDS", GEARS = "GEARS", VEGGIE = "VEGGIE" }
GLOBAL.ACTIONS = { CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, DIG = { id = "DIG" }, HAMMER = { id = "HAMMER" } }
GLOBAL.TheNet = { GetSessionIdentifier = function() return SESSION end }
GLOBAL.TheShard = { GetShardId = function() return SHARD end }
NOW = 1000
SESSION = "sess-SAME"
SHARD = "1"
NEARBY = {}
GLOBAL.TheSim = {
    GetTime = function() return NOW end,
    GetRealTime = function() return NOW * 1000 end,
    FindEntities = function() return NEARBY end,
}
function mkent(opts)
    local e = { prefab = opts.prefab or "thing", GUID = opts.guid or 1, tags = opts.tags or {}, components = {},
                Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end } }
    e.IsValid = function() return true end
    e.HasTag = function(self, tag) if tag == "INLIMBO" then return false end return self.tags[tag] == true end
    if opts.hp ~= nil then e.components.health = { currenthealth = opts.hp, maxhealth = opts.hp, IsDead = function() return false end } end
    if opts.work ~= nil then e.components.workable = { action = { id = opts.work } } end
    return e
end
function mkplayer()
    local p = mkent({ prefab = "warly", guid = 999, x = 0, z = 0, tags = { player = true }, hp = 150 })
    p.userid = "KU_probe"
    p.components.inventory = {
        GetNumSlots = function() return 15 end,
        GetItemInSlot = function() return nil end,
        GetEquippedItem = function() return nil end,
    }
    return p
end
PLAYER = mkplayer()
GLOBAL.AllPlayers = { PLAYER }
GLOBAL.TheWorld = { state = { cycles = 3, phase = "day", season = "autumn", temperature = 20 },
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
  const run = (code, what = 'code') => {
    const st = lauxlib.luaL_dostring(L, to_luastring(code))
    if (st !== lua.LUA_OK) throw new Error(`${what} 出错：${fail()}`)
  }
  const get = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try {
      return to_jsstring(lua.lua_tostring(L, -1))
    } catch {
      return ''
    }
  }
  run(STUB, '假游戏')
  run('Whale = { verbose = false, version = "0.13.1" }', 'Whale')
  run(`Whale.files = { state = "whale_state.json", io_state = "whale_io_state.json", cmd = "whale_cmd.json",
        io_cmd = "whale_io_cmd.json", result = "whale_result.json", io_result = "whale_io_result.json",
        settings = "whale_settings.json", io_settings = "whale_io_settings.json",
        pause = "whale_pause.json", io_pause = "whale_io_pause.json" }`, '文件名')
  for (const name of ['json', 'util', 'config', 'actor', 'nearby', 'observe']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', `${name}.lua`), 'utf8'), `${name}.lua`)
  }
  return { run, get }
}

const configure = (env, { maxTotal = 60, maxPerBucket = 12, radius = 16, scanSeconds = 4 } = {}) => {
  env.run(`Whale.config.build(function(k)
    if k == "scan_radius" then return ${radius} end
    if k == "scan_seconds" then return ${scanSeconds} end
    if k == "observe_interval" then return 2 end
    if k == "state_interval" then return 1 end
    if k == "nearby_max_total" then return ${maxTotal} end
    if k == "nearby_max_per_bucket" then return ${maxPerBucket} end
    return nil
  end)`, '配置')
}

const observe = (env) => {
  env.run(`
    local actor = Whale.actor.get_actor()
    local data = Whale.observe.BuildData(actor, { seq = 0, now = NOW })
    OUT = Whale.json.encode({ nearby = data.nearby })
  `, '观察')
  return JSON.parse(env.get('OUT')).nearby
}

// ─────────────────────────────────────────────────────────────
// 探针 A：截断挤出 ≠ 实体消失
// ─────────────────────────────────────────────────────────────
console.log('=== 探针 A：Delta 会不会把"被截断挤出"误报成 removed ===')

const envA = await newVm()
configure(envA, { maxPerBucket: 3 }) // 单桶只留 3 个，方便复现

// 第一帧：4 棵树，距离 1..4 → 只返回最近 3 棵（guid 1,2,3；guid 4 被单桶上限挤出）
envA.run(`
  NEARBY = {}
  for i = 1, 4 do
    NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = i, work = "CHOP", hp = 100 })
  end
`, '四棵树')
const a1 = observe(envA)
console.log('第 1 次扫描：returned=', a1.total_returned, 'found=', a1.total_found,
  'refs=', Object.values(a1.buckets.resources).flat().map((x) => x.ref).join(','),
  'delta=', a1.delta.status)

// 第二帧：**同一棵树都没消失**，只是离得最近的那棵（guid 1）往远处走了，被挤出的 guid 4 反而进了窗口
envA.run(`
  NOW = NOW + 5
  NEARBY = {}
  NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = 40, z = 0, guid = 1, work = "CHOP", hp = 100 }) -- 走到 10 格外
  for i = 2, 4 do
    NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = i, work = "CHOP", hp = 100 })
  end
`, '同一批树，只是排序变了')
const a2 = observe(envA)
console.log('第 2 次扫描：removed_count=', a2.delta.removed_count,
  'removed=', JSON.stringify(a2.delta.removed),
  'added=', JSON.stringify(a2.delta.added))
console.log('→ 世界里 4 棵树**一棵都没少**（guid 1 只是远了点、guid 2/3/4 都在）；')
console.log('  但 delta 把"没进返回窗口"的那棵报成了 removed：', a2.delta.removed.map((x) => x.prefab).join(',') || '（无）')

// ─────────────────────────────────────────────────────────────
// 探针 B：snapshot_id 跨运行实例是否撞号
// ─────────────────────────────────────────────────────────────
console.log('\n=== 探针 B：模块重新加载（≈游戏重启）后 snapshot_id 是否撞号 ===')

const vm1 = await newVm()
configure(vm1)
vm1.run('NEARBY = { mkent({ prefab = "spider", x = 8, z = 0, guid = 111, tags = { hostile = true }, hp = 25 }) }', '运行实例 1 的蜘蛛')
const b1 = observe(vm1)
const snap1 = b1.snapshot_id
const refs1 = Object.values(b1.buckets.threats).flat().map((x) => `${x.ref}:${x.prefab}`)
console.log(`运行实例 1：snapshot_id=${snap1} refs=${refs1.join(',')} session=${'sess-SAME'}`)

// 模拟"游戏重启"：换一个全新的 Lua 状态（模块从头加载，scan_seq 归零），世界里换成另一只怪
const vm2 = await newVm()
configure(vm2)
vm2.run('NEARBY = { mkent({ prefab = "evergreen", x = 12, z = 0, guid = 222, work = "CHOP", hp = 100 }) }', '运行实例 2 的树')
const b2 = observe(vm2)
const snap2 = b2.snapshot_id
const refs2 = Object.values(b2.buckets.resources).flat().map((x) => `${x.ref}:${x.prefab}`)
console.log(`运行实例 2：snapshot_id=${snap2} refs=${refs2.join(',')}`)
console.log(`→ 两次运行的 snapshot_id 相同？${snap1 === snap2 ? '是（撞号）' : '否'}`)

// 关键：新实例会不会接受"上一次运行"的引用？
vm2.run(`
  OLD_SNAP = "${snap1}"
  local ent, why = Whale.nearby.Resolve(OLD_SNAP, "#1")
  if ent == nil then
    OUT_RESOLVE = "拒绝：" .. tostring(why)
  else
    OUT_RESOLVE = "解析成功 → " .. tostring(ent.prefab)
  end
`, '用旧运行实例的快照号去解析')
console.log(`用运行实例 1 的 (snapshot_id=${snap1}, ref=#1) 在运行实例 2 里解析：${vm2.get('OUT_RESOLVE')}`)
console.log('→ 因为 snapshot_id 每运行只从 n1 开始、且 session_id 跨重启不变，旧引用会在新实例里"恰好命中"另一个实体。')

console.log('\n结论：')
console.log('A) Delta 基于**截断后的返回集合**比较 → 被截断/排序挤出窗口的实体会被报成 removed（误报）。')
console.log('B) 【0.13.2 已修】snapshot_id 带运行实例号 → 旧运行实例的 #N 被 Resolve() 以 stale_snapshot 拒绝。')
