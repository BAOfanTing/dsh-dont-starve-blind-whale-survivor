// M2.0：Lua 侧安全校验（Whale.guard）—— M2.0.2 改为以权威租约文件为唯一依据
//
// 全部是沙箱（fengari）+ 假游戏，属于 UNIT，**不是** DST 真机；
// 真机手工检查表当时在 M2_0_2（已在 SURVIVAL-07 随 docs/archive 删除，git 历史可找回）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authority, command, luaIoFiles } from './helpers.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利", EVERGREEN = "常青树" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.FOODTYPE = { ROUGHAGE = "ROUGHAGE", SEEDS = "SEEDS", GEARS = "GEARS", VEGGIE = "VEGGIE" }
GLOBAL.ACTIONS = { CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, DIG = { id = "DIG" }, HAMMER = { id = "HAMMER" } }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "sess-R" end }
GLOBAL.TheShard = { GetShardId = function() return "1" end }
NOW = 1000
NOW_MS = 1794500000000
NEARBY = {}
GLOBAL.TheSim = { GetTime = function() return NOW end, GetRealTime = function() return NOW * 1000 end,
                  FindEntities = function() return NEARBY end }
function mkent(opts)
    local e = { prefab = opts.prefab or "evergreen", GUID = opts.guid or 1, tags = opts.tags or {},
                components = {}, valid = opts.valid ~= false,
                Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end } }
    e.IsValid = function(self) return self.valid end
    e.HasTag = function(self, tag) if tag == "INLIMBO" then return self.limbo == true end return self.tags[tag] == true end
    if opts.hp ~= nil then e.components.health = { currenthealth = opts.hp, maxhealth = opts.hp, IsDead = function(self) return self.currenthealth <= 0 end } end
    if opts.work ~= nil then e.components.workable = { action = { id = opts.work } } end
    return e
end
function mkplaya(opts)
    opts = opts or {}
    local p = mkent({ prefab = "warly", guid = 999, tags = { player = true }, hp = opts.hp or 100 })
    p.userid = "KU_r"
    p.ghost = opts.ghost == true
    p.components.inventory = { GetNumSlots = function() return 15 end, GetItemInSlot = function() return nil end,
                               GetEquippedItem = function() return nil end }
    if opts.locomotor ~= false then p.components.locomotor = {} end
    local old = p.HasTag
    p.HasTag = function(self, tag)
        if tag == "playerghost" then return self.ghost end
        return old(self, tag)
    end
    return p
end
PLAYER = mkplaya()
GLOBAL.AllPlayers = { PLAYER }
WORLD = { state = { cycles = 1, phase = "day", season = "autumn", temperature = 20 },
          HasTag = function() return false end, ismastersim = true }
GLOBAL.TheWorld = WORLD
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

async function load(files = { 'whale_io_lease.json': authority() }) {
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
  const luaStr = (s) => `[==[${s}]==]`
  const setAuthority = (filesMap) => run(luaIoFiles(filesMap))
  const setCommand = (cmd) => run(`CMD = Whale.json.decode(${luaStr(JSON.stringify(cmd))})`)
  const validate = () => {
    run('local ok, why = Whale.guard.validate(CMD); OUT = tostring(ok) .. "|" .. tostring(why)')
    return get('OUT')
  }

  run(STUB)
  run(luaIoFiles(files))
  run('Whale = { verbose = false, version = "0.14.1" }')
  for (const name of ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'guard', 'observe', 'actions', 'macros', 'bridge']) {
    if (name === 'actions') {
      for (const sub of ['core', 'movement', 'gathering', 'combat', 'survival', 'crafting', 'interaction']) {
        run(readFileSync(join(MOD, 'scripts', 'whale', 'actions', sub + '.lua'), 'utf8'))
      }
    }
    run(readFileSync(join(MOD, 'scripts', 'whale', name + '.lua'), 'utf8'))
  }
  run('Whale.config.build(function(k) if k == "scan_radius" then return 16 end if k == "scan_seconds" then return 4 end return nil end)')
  // 固定运行实例号（salt 随机的部分），让权威租约/命令/Lua 三方一致
  run('Whale.nearby.runtime_id = function() return "r1794500000-0001" end')
  const reset = () => run('Whale.guard.reset(); Whale.guard.forget_ids(); Whale.nearby.Reset()')
  return { run, get, reset, setAuthority, setCommand, validate }
}

const A = authority()
const cmd = (over = {}, a = A) => command(a, over)

async function check(commandObj, files = { 'whale_io_lease.json': authority() }) {
  const env = await load(files)
  env.reset()
  env.setCommand(commandObj)
  return env.validate()
}

async function expectReject(commandObj, reason, files) {
  const out = await check(commandObj, files)
  assert.equal(out, `false|${reason}`, `期望拒绝 ${reason}，实际：${out}`)
}

// ─────────────────────────── 权威租约 / 协议 ───────────────────────────

for (const explicit of [false, true]) {
  for (const scenario of ['healing', 'no_healing', 'healthy']) {
    test(`guard-eat：满饥饿 ${scenario}、指定食物=${explicit}`, async () => {
      const env = await load()
      env.run(readFileSync(join(MOD, 'scripts', 'whale', 'eatrules.lua'), 'utf8'))
      env.reset()
      env.run(`
        PLAYER.components.hunger = { current = 100, max = 100, GetPercent = function() return 1 end }
        PLAYER.components.health.currenthealth = ${scenario === 'healthy' ? 100 : 15}
        local food = mkent({ prefab = "${scenario === 'no_healing' ? 'berries' : 'carrot'}" })
        food.components.edible = { healthvalue = ${scenario === 'no_healing' ? 0 : 1}, hungervalue = 12.5 }
        PLAYER.components.inventory.ForEachItem = function(self, fn) fn(food) end
      `)
      env.setCommand(cmd({ action: 'eat', args: explicit ? { food: scenario === 'no_healing' ? 'berries' : 'carrot' } : {} }))
      assert.equal(env.validate(), scenario === 'healing' ? 'true|nil' : 'false|not_hungry')
    })
  }
}

for (const item of ['lantern', 'minerhat', 'monstermeat']) {
  test(`guard-equip：便携光源白名单 ${item}`, async () => {
    const env = await load()
    env.run(readFileSync(join(MOD, 'scripts', 'whale', 'equiprules.lua'), 'utf8'))
    env.reset()
    env.run(`
      local item = mkent({ prefab = "${item}" })
      item.components.inventoryitem = {}
      PLAYER.components.inventory.ForEachItem = function(self, fn) fn(item) end
    `)
    env.setCommand(cmd({ action: 'equip', args: { item } }))
    assert.equal(env.validate(), item === 'monstermeat' ? 'false|item_not_equippable' : 'true|nil')
  })
}

test('guard-1 合法命令通过（权威租约齐全且精确匹配）', async () => {
  assert.equal(await check(cmd()), 'true|nil')
})

test('guard-2 协议版本不对 → bad_protocol', () => expectReject(cmd({ protocol_version: 2 }), 'bad_protocol'))
test('guard-3 没有 command_id → missing_command_id', () => expectReject(cmd({ command_id: '' }), 'missing_command_id'))
// SURVIVAL-06：build 已开放，换成确实不存在的动作名
test('guard-4 动作不在白名单 → action_not_allowed', () => expectReject(cmd({ action: 'night_watch' }), 'action_not_allowed'))
test('guard-5 命令过期 → command_expired', () => expectReject(cmd({ expires_at: 1 }), 'command_expired'))
test('guard-6 没有有效期 → missing_expiry', () => expectReject(cmd({ expires_at: null }), 'missing_expiry'))

test('guard-7 权威文件不存在 → authority_unavailable（fail-closed）', () =>
  expectReject(cmd(), 'authority_unavailable', {}))
test('guard-8 权威文件损坏 → authority_corrupt', () =>
  expectReject(cmd(), 'authority_corrupt', { 'whale_io_lease.json': '{broken' }))
test('guard-9 权威文件 schema 不对 → authority_schema_mismatch', () =>
  expectReject(cmd(), 'authority_schema_mismatch', { 'whale_io_lease.json': authority({ schema: 'wrong/1' }) }))
test('guard-10 权威文件缺 generation → authority_corrupt', () =>
  expectReject(cmd(), 'authority_corrupt', { 'whale_io_lease.json': (() => { const a = authority(); delete a.generation; return a })() }))

// ─────────────────────────── generation 精确相等 ───────────────────────────

test('guard-11 旧 generation → stale_generation（换手后旧命令必拒）', () =>
  expectReject(cmd({ lease_generation: 11 }), 'stale_generation'))
test('guard-12 未来 generation → future_generation（伪造被拒、不污染状态）', () =>
  expectReject(cmd({ lease_generation: 999 }), 'future_generation'))
test('guard-13 缺 generation → missing_generation', () =>
  expectReject(cmd({ lease_generation: null }), 'missing_generation'))
test('guard-14 generation 非整数 → bad_generation', () =>
  expectReject(cmd({ lease_generation: 12.5 }), 'bad_generation'))

// ─────────────────────────── 身份 / 环境 ───────────────────────────

test('guard-15 authority_epoch 不匹配 → authority_epoch_mismatch', () =>
  expectReject(cmd({ authority_epoch: 'epoch-OLD' }), 'authority_epoch_mismatch'))
test('guard-16 lease_id 不匹配 → stale_lease', () =>
  expectReject(cmd({ lease_id: 'lease-OLD' }), 'stale_lease'))
test('guard-17 owner_type 不匹配 → wrong_owner', () =>
  expectReject(cmd({ owner_type: 'mcp_client' }), 'wrong_owner'))
test('guard-18 owner_instance_id 不匹配 → wrong_instance', () =>
  expectReject(cmd({ owner_instance_id: 'instance-B' }), 'wrong_instance'))
test('guard-19 runtime 不匹配 → runtime_mismatch', () =>
  expectReject(cmd({ runtime_id: 'r-old-0001' }), 'runtime_mismatch'))
test('guard-20 session 不匹配 → session_mismatch', () =>
  expectReject(cmd({ session_id: 'sess-OTHER' }), 'session_mismatch'))
test('guard-21 shard 不匹配 → shard_mismatch', () =>
  expectReject(cmd({ shard_id: '2' }), 'shard_mismatch'))
test('guard-22 actor 不匹配 → actor_mismatch', () =>
  expectReject(cmd({ actor_id: 'player:KU_other' }), 'actor_mismatch'))

// ─────────────────────────── 角色 ───────────────────────────

test('guard-23 角色是 ghost → actor_is_ghost', async () => {
  const env = await load()
  env.reset()
  env.setCommand(cmd())
  env.run('PLAYER.ghost = true')
  assert.equal(env.validate(), 'false|actor_is_ghost')
})

test('guard-24 角色死亡 → actor_dead', async () => {
  const env = await load()
  env.reset()
  env.setCommand(cmd())
  env.run('PLAYER.components.health.currenthealth = 0')
  assert.equal(env.validate(), 'false|actor_dead')
})

test('guard-25 观察兜底到非玩家实体 → actor_not_player', async () => {
  const env = await load()
  env.reset()
  env.setCommand(cmd())
  env.run('GLOBAL.AllPlayers = { mkent({ prefab = "spider", guid = 5, tags = { hostile = true }, hp = 25 }) }')
  assert.equal(env.validate(), 'false|actor_not_player')
})

test('guard-26 非权威环境 → not_authoritative', async () => {
  const env = await load()
  env.reset()
  env.setCommand(cmd())
  env.run('WORLD.ismastersim = false')
  assert.equal(env.validate(), 'false|not_authoritative')
})

test('guard-27 缺组件 → missing_component:locomotor', async () => {
  const env = await load()
  env.reset()
  env.setCommand(cmd())
  env.run('PLAYER.components.locomotor = nil')
  assert.equal(env.validate(), 'false|missing_component:locomotor')
})

// ─────────────────────────── 参数 ───────────────────────────

test('guard-28 未知参数 → unknown_arg', () => expectReject(cmd({ args: { x: 1, z: 2, fly: true } }), 'unknown_arg:fly'))
test('guard-29 缺必填 → missing_arg', () => expectReject(cmd({ args: { x: 1 } }), 'missing_arg:z'))
test('guard-30 NaN → nan（Lua 侧真实 NaN，不走 JSON 序列化）', async () => {
  const env = await load()
  env.reset()
  env.setCommand(cmd({ args: { x: 1, z: 1 } }))
  env.run('CMD.args.x = 0/0')
  assert.equal(env.validate(), 'false|nan:x')
})
test('guard-31 无穷 → infinite（Lua 侧真实 math.huge）', async () => {
  const env = await load()
  env.reset()
  env.setCommand(cmd({ args: { x: 1, z: 1 } }))
  env.run('CMD.args.x = math.huge')
  assert.equal(env.validate(), 'false|infinite:x')
})
test('guard-32 超范围 → out_of_range', () => expectReject(cmd({ args: { x: 99999, z: 1 } }), 'out_of_range:x'))
test('guard-33 非整数 → not_integer', () => expectReject(cmd({ args: { x: 1.5, z: 1 } }), 'not_integer:x'))
test('guard-34 类型错误 → bad_type', () => expectReject(cmd({ args: { x: '3', z: 1 } }), 'bad_type:x'))

// ─────────────────────────── revoking / 去重 ───────────────────────────

test('guard-35 revoking 状态：拒绝所有动作', () =>
  expectReject(cmd(), 'authority_revoking', { 'whale_io_lease.json': authority({ status: 'revoking', generation: 13 }) }))

test('guard-36 重复 command_id → duplicate_command（accept 只记去重）', async () => {
  const env = await load()
  env.reset()
  env.setCommand(cmd())
  assert.equal(env.validate(), 'true|nil')
  env.run('Whale.guard.accept(CMD)')
  assert.equal(env.validate(), 'false|duplicate_command')
})

// ─────────────────────────── 目标引用 #N ───────────────────────────

test('guard-37 目标解析：当前快照 #1 可用；旧快照/未知/失效/limbo/分类/距离 全拒', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = { mkent({ prefab = "evergreen", x = 4, z = 0, guid = 11, work = "CHOP" }) }')
  env.run(`
    local actor = Whale.actor.get_actor()
    local data = Whale.observe.BuildData(actor, { seq = 1, now = NOW })
    SNAP = data.nearby.snapshot_id
  `)
  const cases = [
    [`local e,w = Whale.guard.resolve_target(SNAP, "#1", { category = "resources", max_distance = 30 }) OUT = e ~= nil and ("ok:" .. e.prefab) or ("reject:" .. tostring(w))`, 'ok:evergreen'],
    [`local e,w = Whale.guard.resolve_target("r-other-0001-n1", "#1") OUT = e ~= nil and "hit" or ("reject:" .. tostring(w))`, 'reject:stale_snapshot'],
    [`local e,w = Whale.guard.resolve_target(SNAP, "#9") OUT = e ~= nil and "hit" or ("reject:" .. tostring(w))`, 'reject:unknown_ref'],
    [`local e,w = Whale.guard.resolve_target(SNAP, "1") OUT = e ~= nil and "hit" or ("reject:" .. tostring(w))`, 'reject:bad_ref'],
    [`local e,w = Whale.guard.resolve_target(SNAP, "#1", { category = "threats" }) OUT = e ~= nil and "hit" or ("reject:" .. tostring(w))`, 'reject:wrong_category'],
    [`local e,w = Whale.guard.resolve_target(SNAP, "#1", { category = "resources", max_distance = 0.1 }) OUT = e ~= nil and "hit" or ("reject:" .. tostring(w))`, 'reject:out_of_range'],
  ]
  for (const [code, expected] of cases) {
    env.run(code)
    assert.equal(env.get('OUT'), expected)
  }
})

test('guard-38 目标实体失效 / 进 limbo → entity_gone / in_limbo', async () => {
  const mk = async (mutate) => {
    const env = await load()
    env.reset()
    env.run('TARGET = mkent({ prefab = "evergreen", x = 4, z = 0, guid = 12, work = "CHOP" }); NEARBY = { TARGET }')
    env.run(`
      local actor = Whale.actor.get_actor()
      local data = Whale.observe.BuildData(actor, { seq = 1, now = NOW })
      SNAP = data.nearby.snapshot_id
    `)
    env.run(mutate)
    env.run('local e,w = Whale.guard.resolve_target(SNAP, "#1") OUT = e ~= nil and "hit" or ("reject:" .. tostring(w))')
    return env.get('OUT')
  }
  assert.equal(await mk('TARGET.valid = false'), 'reject:entity_gone')
  assert.equal(await mk('TARGET.limbo = true'), 'reject:in_limbo')
})
