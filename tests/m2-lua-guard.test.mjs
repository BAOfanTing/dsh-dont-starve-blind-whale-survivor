// M2.0：Lua 侧安全校验（Whale.guard）——动作执行前的最后一道闸
//
// 全部是沙箱（fengari）+ 假游戏，属于 UNIT；真机验证见 docs/M2_runtime_manual_checklist.md。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利", EVERGREEN = "常青树" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.FOODTYPE = { ROUGHAGE = "ROUGHAGE", SEEDS = "SEEDS", GEARS = "GEARS", VEGGIE = "VEGGIE" }
GLOBAL.ACTIONS = { CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, DIG = { id = "DIG" }, HAMMER = { id = "HAMMER" } }
GLOBAL.TheNet = { GetSessionIdentifier = function() return SESSION end }
GLOBAL.TheShard = { GetShardId = function() return SHARD end }
NOW = 1000
SESSION = "sess-A"
SHARD = "1"
NOW_MS = 1794500000000     -- 墙钟毫秒（guard 的过期判断用它）
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
    local p = mkent({ prefab = "warly", guid = 999, tags = { player = true }, hp = opts.hp or 100, x = 0, z = 0 })
    p.userid = opts.userid or "KU_p"
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
GLOBAL.io = nil
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
  run('Whale = { verbose = false, version = "0.14.0" }')
  for (const name of ['json', 'util', 'config', 'actor', 'nearby', 'guard', 'observe']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', name + '.lua'), 'utf8'))
  }
  run('Whale.config.build(function(k) if k == "scan_radius" then return 16 end if k == "scan_seconds" then return 4 end return nil end)')
  const reset = () => run('Whale.guard.reset(); Whale.guard.forget_ids(); Whale.nearby.Reset()')
  /** 造一条命令（默认合法） */
  const cmd = (over = '') => `
    CMD = {
      protocol_version = 1,
      command_id = "cmd-1",
      action = "move_to",
      args = { x = 3, z = 4 },
      requested_by = "f8_agent",
      lease_generation = 1,
      lease_expires_at = NOW_MS + 30000,
      runtime_id = Whale.nearby.runtime_id(),
      session_id = SESSION,
      shard_id = SHARD,
      actor_id = "player:KU_p",
      snapshot_id = nil,
      created_at = NOW_MS,
      expires_at = NOW_MS + 8000,
    }
    ${over}
  `
  const validate = () => {
    run('local ok, why = Whale.guard.validate(CMD); OUT = tostring(ok) .. "|" .. tostring(why)')
    return get('OUT')
  }
  return { run, get, reset, cmd, validate, observeCmd: cmd }
}

const expectReject = async (over, reason) => {
  const env = await load()
  env.reset()
  env.run(env.cmd(over))
  const out = env.validate()
  assert.equal(out, `false|${reason}`, `期望拒绝 ${reason}，实际：${out}`)
}

const expectPass = async (over = '') => {
  const env = await load()
  env.reset()
  env.run(env.cmd(over))
  const out = env.validate()
  assert.equal(out, 'true|nil', '应该通过，实际：' + out)
  return env
}

// ─────────────────────────── 协议 / 白名单 / 过期 ───────────────────────────

test('guard-1 合法命令通过', async () => {
  await expectPass()
})

test('guard-2 协议版本不对 → bad_protocol', () => expectReject('CMD.protocol_version = 2', 'bad_protocol'))
test('guard-3 没有 command_id → missing_command_id', () => expectReject('CMD.command_id = nil', 'missing_command_id'))
test('guard-4 动作不在白名单 → action_not_allowed', () => expectReject('CMD.action = "chop"', 'action_not_allowed'))
test('guard-5 命令过期 → command_expired', () => expectReject('CMD.expires_at = NOW_MS - 1', 'command_expired'))
test('guard-6 没有有效期 → missing_expiry', () => expectReject('CMD.expires_at = nil', 'missing_expiry'))
test('guard-7 没有租约世代 → missing_generation', () => expectReject('CMD.lease_generation = nil', 'missing_generation'))
// 上面那条需要先抬世代，单独写：
test('guard-8b 低世代命令被拒绝（generation fencing）', async () => {
  const env = await load()
  env.reset()
  env.run(env.cmd('CMD.lease_generation = 5'))
  assert.equal(env.validate(), 'true|nil')
  env.run('Whale.guard.accept(CMD)')
  env.run('CMD2 = { protocol_version = 1, command_id = "cmd-old", action = "move_to", args = { x = 1, z = 1 }, lease_generation = 4, expires_at = NOW_MS + 8000 }')
  env.run('local ok, why = Whale.guard.validate(CMD2); OUT = tostring(ok) .. "|" .. tostring(why)')
  assert.equal(env.get('OUT'), 'false|stale_generation', '旧世代必须拒绝')
})

test('guard-9 重复 command_id → duplicate_command（不重复执行）', async () => {
  const env = await load()
  env.reset()
  env.run(env.cmd())
  assert.equal(env.validate(), 'true|nil')
  env.run('Whale.guard.accept(CMD)')
  env.run('local ok, why = Whale.guard.validate(CMD); OUT = tostring(ok) .. "|" .. tostring(why)')
  assert.equal(env.get('OUT'), 'false|duplicate_command')
})

// ─────────────────────────── 环境 / 角色 ───────────────────────────

test('guard-10 session 不匹配 → session_mismatch', () => expectReject('CMD.session_id = "sess-OTHER"', 'session_mismatch'))
test('guard-11 shard 不匹配 → shard_mismatch', () => expectReject('CMD.shard_id = "2"', 'shard_mismatch'))
test('guard-12 runtime 不匹配（游戏重启）→ runtime_mismatch', () => expectReject('CMD.runtime_id = "r-old-0001"', 'runtime_mismatch'))
test('guard-13 actor 不匹配 → actor_mismatch', () => expectReject('CMD.actor_id = "player:KU_other"', 'actor_mismatch'))

test('guard-14 角色是 ghost → actor_is_ghost，且不执行', async () => {
  const env = await load()
  env.reset()
  env.run('PLAYER.ghost = true')
  env.run(env.cmd())
  assert.equal(env.validate(), 'false|actor_is_ghost')
})

test('guard-15 角色死亡 → actor_dead', async () => {
  const env = await load()
  env.reset()
  env.run('PLAYER.components.health.currenthealth = 0')
  env.run(env.cmd())
  assert.equal(env.validate(), 'false|actor_dead')
})

test('guard-16 观察兜底到非玩家实体时，绝不允许执行动作', async () => {
  const env = await load()
  env.reset()
  // 玩家不在，只剩一只"有效实体"——Actor Provider 会兜底选它（为了观察）
  env.run('GLOBAL.AllPlayers = { mkent({ prefab = "spider", guid = 5, tags = { hostile = true }, hp = 25 }) }')
  env.run(env.cmd())
  assert.equal(env.validate(), 'false|actor_not_player', '兜底实体不能当可操作角色')
})

test('guard-17 世界不是权威模拟端 → not_authoritative', async () => {
  const env = await load()
  env.reset()
  env.run('WORLD.ismastersim = false')
  env.run(env.cmd())
  assert.equal(env.validate(), 'false|not_authoritative')
})

test('guard-18 缺组件（没有 locomotor）→ missing_component:locomotor', async () => {
  const env = await load()
  env.reset()
  env.run('PLAYER.components.locomotor = nil')
  env.run(env.cmd())
  assert.equal(env.validate(), 'false|missing_component:locomotor')
})

// ─────────────────────────── 参数 ───────────────────────────

test('guard-19 未知参数 → unknown_arg', () => expectReject('CMD.args = { x = 1, z = 2, fly = true }', 'unknown_arg:fly'))
test('guard-20 缺必填 → missing_arg', () => expectReject('CMD.args = { x = 1 }', 'missing_arg:z'))
test('guard-21 NaN → nan', () => expectReject('CMD.args = { x = 0/0, z = 1 }', 'nan:x'))
test('guard-22 无穷 → infinite', () => expectReject('CMD.args = { x = math.huge, z = 1 }', 'infinite:x'))
test('guard-23 超范围 → out_of_range', () => expectReject('CMD.args = { x = 99999, z = 1 }', 'out_of_range:x'))
test('guard-24 非整数坐标 → not_integer', () => expectReject('CMD.args = { x = 1.5, z = 1 }', 'not_integer:x'))
test('guard-25 类型错误 → bad_type', () => expectReject('CMD.args = { x = "3", z = 1 }', 'bad_type:x'))

// ─────────────────────────── 目标引用 #N ───────────────────────────

test('guard-26 目标解析：当前快照的 #1 能解析；旧快照 / 未知 / 失效 / limbo 都拒绝', async () => {
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
    assert.equal(env.get('OUT'), expected, `期望 ${expected}`)
  }
})

test('guard-27 目标实体失效 / 进 limbo → entity_gone / in_limbo', async () => {
  const env = await load()
  env.reset()
  env.run('TARGET = mkent({ prefab = "evergreen", x = 4, z = 0, guid = 12, work = "CHOP" }); NEARBY = { TARGET }')
  env.run(`
    local actor = Whale.actor.get_actor()
    local data = Whale.observe.BuildData(actor, { seq = 1, now = NOW })
    SNAP = data.nearby.snapshot_id
  `)
  env.run('TARGET.valid = false')
  env.run('local e,w = Whale.guard.resolve_target(SNAP, "#1") OUT = e ~= nil and "hit" or ("reject:" .. tostring(w))')
  assert.equal(env.get('OUT'), 'reject:entity_gone')

  const env2 = await load()
  env2.reset()
  env2.run('TARGET = mkent({ prefab = "evergreen", x = 4, z = 0, guid = 13, work = "CHOP" }); NEARBY = { TARGET }')
  env2.run(`
    local actor = Whale.actor.get_actor()
    local data = Whale.observe.BuildData(actor, { seq = 1, now = NOW })
    SNAP = data.nearby.snapshot_id
  `)
  env2.run('TARGET.limbo = true')
  env2.run('local e,w = Whale.guard.resolve_target(SNAP, "#1") OUT = e ~= nil and "hit" or ("reject:" .. tostring(w))')
  assert.equal(env2.get('OUT'), 'reject:in_limbo')
})
