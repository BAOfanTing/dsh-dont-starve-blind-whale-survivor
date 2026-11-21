// M2.3 Harvest：原生采集（试点 = 成熟浆果丛，底层 ACTIONS.PICK）
//
// 证据类型：UNIT（fengari 假游戏 + 真实 harvestrules/nearby/guard/actions；Node 侧真实 dispatcher）
// 覆盖：候选/成熟/距离/执行/结果核对/Schema/Observer 字段/租约换手加固
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authority, command, luaIoFiles } from './helpers.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')
const RUNTIME = 'r1794500000-0001'

const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利", BERRYBUSH = "浆果丛", EVERGREEN = "常青树" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.FOODTYPE = { GENERIC = "GENERIC", MEAT = "MEAT", VEGGIE = "VEGGIE", ELEMENTAL = "ELEMENTAL",
                    ROUGHAGE = "ROUGHAGE", SEEDS = "SEEDS", GEARS = "GEARS", WOOD = "WOOD",
                    NITRE = "NITRE", INSECT = "INSECT", GOODIES = "GOODIES", MONSTER = "MONSTER",
                    HORRIBLE = "HORRIBLE", BERRY = "BERRY", RAW = "RAW", BURNT = "BURNT" }
GLOBAL.ACTIONS = { PICK = { id = "PICK" }, HARVEST = { id = "HARVEST" }, CHOP = { id = "CHOP" },
                   DIG = { id = "DIG" }, PICKUP = { id = "PICKUP" } }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "sess-R" end }
GLOBAL.TheShard = { GetShardId = function() return "1" end }

NOW = 1000
NOW_MS = 1794500000000
NEARBY = {}
PUSHED = {}
GLOBAL.TheSim = { GetTime = function() return NOW end, GetRealTime = function() return NOW * 1000 end,
                  FindEntities = function() return NEARBY end }

--- 假可收获对象（默认是"已成熟的普通浆果丛"）
function mkbush(opts)
    opts = opts or {}
    local e = {
        prefab = opts.prefab or "berrybush",
        GUID = opts.guid or 1,
        valid = opts.valid ~= false,
        limbo = opts.limbo == true,
        stuck = opts.stuck == true,
        tags = opts.tags or { pickable = true },
        components = {},
    }
    e.IsValid = function(self) return self.valid end
    e.IsInLimbo = function(self) return self.limbo end
    e.GetParent = function(self) return nil end
    e.HasTag = function(self, tag) if tag == "INLIMBO" then return self.limbo end return self.tags[tag] == true end
    e.Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end }
    e.GetPosition = function(self) return { x = opts.x or 0, y = 0, z = opts.z or 0 } end
    e.GetPhysicsRadius = function(self) return opts.radius or 0.1 end
    if opts.pickable ~= false then
        e.components.pickable = {
            canbepicked = opts.ready ~= false,
            cycles_left = opts.cycles or 3,
            product = opts.product or "berries",
            caninteractwith = opts.interactable ~= false,
            CanBePicked = function(self) return self.canbepicked end,
            IsBarren = function(self) return (self.cycles_left or 1) == 0 end,
            IsStuck = function(self) return e.stuck == true end,
        }
    end
    if opts.workable then e.components.workable = { action = { id = "DIG" } } end
    return e
end

GLOBAL.mkbush = mkbush

function mkplaya(opts)
    opts = opts or {}
    local items = opts.items or {}
    local p = { prefab = "warly", GUID = 999, tags = { player = true }, components = {} }
    p.userid = "KU_r"
    p.IsValid = function() return true end
    p.IsInLimbo = function() return false end
    p.GetParent = function() return nil end
    p.HasTag = function(self, tag) if tag == "playerghost" then return false end return self.tags[tag] == true end
    p.Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end }
    p.GetPosition = function() return { x = opts.x or 0, y = 0, z = opts.z or 0 } end
    p.components.health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end }
    p.components.locomotor = {
        Stop = function() end,
        PushAction = function(self, ba, run) PUSHED[#PUSHED + 1] = ba end,
        WantsToMoveForward = function() return false end,
    }
    p.components.inventory = {
        GetNumSlots = function() return 15 end,
        GetItemInSlot = function() return nil end,
        GetEquippedItem = function() return nil end,
        GetNumFreeSlot = function() return 15 end,
        CanAcceptCount = function() return 99 end,
        ForEachItem = function(self, fn) for _, it in ipairs(items) do fn(it) end end,
    }
    return p
end
PLAYER = mkplaya()
GLOBAL.AllPlayers = { PLAYER }
GLOBAL.TheWorld = { state = { cycles = 1, phase = "day", season = "autumn", temperature = 20 },
                    HasTag = function() return false end, ismastersim = true }
GLOBAL.BufferedAction = function(doer, target, action) return { doer = doer, target = target, action = action } end
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

async function load({ withGuard = false, withActions = false } = {}) {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib, to_luastring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, what) => {
    const st = lauxlib.luaL_dostring(L, to_luastring(code))
    if (st !== lua.LUA_OK) {
      let m = ''
      try { m = lua.lua_tojsstring(L, -1) ?? '' } catch {}
      throw new Error(`${what} 出错：${m}`)
    }
  }
  const get = (n) => { lua.lua_getglobal(L, to_luastring(n)); try { return lua.lua_tojsstring(L, -1) } catch { return '' } }
  run(STUB, '假游戏')
  run(`GLOBAL.io = nil
      IO_FILES = {}
      GLOBAL.io = { open = function(name, mode)
          local t = IO_FILES[name]
          if t == nil then return nil end
          return { read = function() return t end, close = function() return true end }
      end }`, 'io 桩')
  run(luaIoFiles({ 'whale_io_lease.json': authority({ runtime_id: RUNTIME }) }), '租约文件')
  run('Whale = { verbose = false, version = "0.17.0", files = { lease = "whale_lease.json", io_lease = "whale_io_lease.json", lease_ack = "whale_lease_ack.json", io_lease_ack = "whale_io_lease_ack.json" } }', 'Whale')
  const mods = ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'observe']
  if (withGuard || withActions) mods.push('guard_specs', 'guard', 'actions', 'macros', 'bridge')
  for (const n of mods) {
    if (n === 'actions') {
      for (const sub of ['core', 'movement', 'gathering', 'combat', 'survival', 'crafting', 'interaction']) {
        run(readFileSync(join(MOD, 'scripts', 'whale', 'actions', `${sub}.lua`), 'utf8'), `actions/${sub}.lua`)
      }
    }
    run(readFileSync(join(MOD, 'scripts', 'whale', n + '.lua'), 'utf8'), n + '.lua')
  }
  run(`Whale.config.build(function(k)
        if k == "scan_radius" then return 16 end
        if k == "scan_seconds" then return 4 end
        if k == "observe_interval" then return 2 end
        if k == "state_interval" then return 1 end
        if k == "nearby_max_total" then return 60 end
        if k == "nearby_max_per_bucket" then return 12 end
        return nil
      end)`, '配置')
  run(`Whale.nearby.runtime_id = function() return "${RUNTIME}" end`, 'runtime_id')
  if (withActions) {
    run('LAST_REPORT_OK = nil; LAST_REPORT_TEXT = nil', 'report 桩')
    run('Whale.bridge.Report = function(ok, text, id) LAST_REPORT_OK = ok and true or false; LAST_REPORT_TEXT = tostring(text or "") end', 'report')
  }
  const setCmd = (c) => run(`CMD = Whale.json.decode([==[${JSON.stringify(c)}]==])`, 'CMD')
  const validate = () => {
    run('local ok, why, detail = Whale.guard.validate(CMD); OUT = tostring(ok) .. "|" .. tostring(why) .. "|" .. tostring(detail ~= nil and detail.target ~= nil)')
    return get('OUT')
  }
  const observe = () => {
    run(`local actor = Whale.actor.get_actor()
         local text, data = Whale.observe.Build(actor)
         OUT_NEARBY = Whale.json.encode(data.nearby)`, '观察')
    return JSON.parse(get('OUT_NEARBY'))
  }
  return { run, get, setCmd, validate, observe }
}

const AUTH = authority({ runtime_id: RUNTIME })
const harvestCmd = (over = {}) => command(AUTH, {
  action: 'harvest',
  args: { target_ref: '#1', snapshot_id: 'SNAP' },
  ...over,
})

/** 造一个"当前快照里有一株成熟浆果丛"的场景 */
async function withBush(bushLua, opts = {}) {
  const env = await load(opts)
  env.run(`NEARBY = { ${bushLua} }
    do
      local actor = Whale.actor.get_actor()
      local data = Whale.observe.BuildData(actor, { seq = 1, now = NOW })
      SNAP = data.nearby.snapshot_id
    end`, 'nearby')
  return env
}

const READY_BUSH = 'mkbush({ prefab = "berrybush", x = 3, z = 0, guid = 11 })'

// ═══════════════════════ 1. HarvestRules：候选资格 ═══════════════════════

test('harvest-01 候选：批准的食物植物（浆果丛/多汁浆果/胡萝卜等）通过；树/岩石/草/其他一律 prefab_not_allowed', async () => {
  const env = await load()
  env.run(`OUT = ""
    local function t(e)
      local ok, why = Whale.harvestrules.IsCandidate(e)
      OUT = OUT .. tostring(ok) .. "|" .. tostring(why) .. ";"
    end
    t(mkbush({ prefab = "berrybush" }))
    t(mkbush({ prefab = "berrybush2" }))
    t(mkbush({ prefab = "berrybush_juicy" }))
    t(mkbush({ prefab = "evergreen", tags = {} }))
    t(mkbush({ prefab = "rock1", tags = {} }))
    t(mkbush({ prefab = "grass" }))
    t(mkbush({ prefab = "carrot_planted" }))
    t(mkbush({ prefab = "beebox" }))`, '候选')
  assert.equal(env.get('OUT'),
    'true|nil;true|nil;true|nil;false|prefab_not_allowed;false|prefab_not_allowed;false|prefab_not_allowed;true|nil;false|prefab_not_allowed;')
})

test('harvest-02 候选：缺组件 / 着火 / 炽热 / 失效 / limbo 各自的原因', async () => {
  const env = await load()
  env.run(`OUT = ""
    local function t(e)
      local ok, why = Whale.harvestrules.IsCandidate(e)
      OUT = OUT .. tostring(why) .. ";"
    end
    t(mkbush({ pickable = false }))                                  -- 没有 pickable 组件
    -- ★ 真机发现：pickable 标签 == "现在能采"，被采过就没有标签了。
    --   所以"没标签"不等于"不是候选"，只等于"现在不能采"（IsReady 的事）。
    --   这里只验证它不是 target_not_harvestable（具体的候选/成熟结果见下方断言）。
    t(mkbush({ tags = { pickable = true, fire = true } }))            -- 着火
    t(mkbush({ tags = { pickable = true, intense = true } }))         -- 炽热
    t(mkbush({ valid = false }))                                     -- 实体失效
    t(mkbush({ limbo = true }))                                      -- limbo`, '候选原因')
  assert.equal(env.get('OUT'),
    'target_not_harvestable;target_not_harvestable;target_not_harvestable;entity_gone;in_limbo;')
})

test('harvest-03 IsReady 与 IsCandidate 分离：Candidate=true 但未成熟 → not_ready', async () => {
  const env = await load()
  env.run(`OUT = ""
    local function t(e)
      local c = Whale.harvestrules.IsCandidate(e)
      local r, why = Whale.harvestrules.IsReady(e)
      OUT = OUT .. tostring(c) .. "/" .. tostring(r) .. "|" .. tostring(why) .. ";"
    end
    t(mkbush({ ready = true }))                    -- 成熟
    t(mkbush({ ready = false }))                   -- 未成熟
    t(mkbush({ cycles = 0 }))                      -- 次数用尽
    t(mkbush({ stuck = true }))                    -- 卡住
    t(mkbush({ interactable = false }))            -- 不可交互
    t(mkbush({ prefab = "grass" }))                -- 不是候选`, 'ready')
  assert.equal(env.get('OUT'),
    'true/true|nil;true/false|not_ready;true/false|already_harvested;true/false|target_busy;true/false|target_not_harvestable;false/false|prefab_not_allowed;')
})

test('harvest-04 距离：照抄原生 PickRangeCheck（物理半径 + 4 世界单位）', async () => {
  const env = await load()
  env.run(`OUT = ""
    -- 半径 0.1 → 上限 4.1 世界单位（≈1.03 格）
    local bush = mkbush({ x = 4.0, z = 0 })
    local ok, limit, dist = Whale.harvestrules.InNativeRange(PLAYER, bush)
    OUT = tostring(ok) .. "|" .. tostring(limit) .. "|" .. tostring(math.floor(dist * 100 + 0.5) / 100)
    -- 超出一点点就该拒
    local far = mkbush({ x = 4.2, z = 0 })
    local ok2 = Whale.harvestrules.InNativeRange(PLAYER, far)
    -- 半径大的目标允许更近之外的距离
    local big = mkbush({ x = 4.5, z = 0, radius = 1.0 })
    local ok3, limit3 = Whale.harvestrules.InNativeRange(PLAYER, big)
    OUT = OUT .. ";" .. tostring(ok2) .. ";" .. tostring(ok3) .. "|" .. tostring(limit3)`, '距离')
  assert.equal(env.get('OUT'), 'true|4.1|4.0;false;true|5.0')
})

test('harvest-05 读状态：只读原生真实字段，不造百分比', async () => {
  const env = await load()
  env.run(`local st = Whale.harvestrules.ReadState(mkbush({ ready = true, cycles = 7, product = "berries" }))
    OUT = tostring(st.can_be_picked) .. "|" .. tostring(st.cycles_left) .. "|" .. tostring(st.product)
          .. "|" .. tostring(st.is_stuck)
          .. "|" .. tostring(Whale.harvestrules.PrefabList()[1]) .. "," .. tostring(Whale.harvestrules.PrefabList()[2])
          .. "|" .. tostring(Whale.harvestrules.ProductOf(mkbush({ prefab = "berrybush" })))`, '状态')
  assert.equal(env.get('OUT'), 'true|7|berries|false|berrybush,berrybush2|berries')
})

// ═══════════════════════ 2. Observer：harvestables 桶 ═══════════════════════

test('harvest-06 观察：成熟浆果丛进 harvestables，带 is_harvestable / harvest_ready / cycles_left / product', async () => {
  const env = await withBush(READY_BUSH)
  const n = env.observe()
  const list = n.buckets.harvestables
  assert.equal(list.length, 1)
  assert.equal(list[0].prefab, 'berrybush')
  assert.equal(list[0].category, 'harvestables')
  assert.equal(list[0].item_kind, 'food', '语义仍然是食物来源')
  assert.equal(list[0].is_harvestable, true)
  assert.equal(list[0].harvest_ready, true)
  assert.equal(list[0].cycles_left, 3)
  assert.equal(list[0].product, 'berries')
  assert.equal(n.buckets.food.length, 0, '不该同时出现在 food')
})

test('harvest-07 观察：未成熟的对象也在桶里，但 harvest_ready=false（观察不限成熟度）', async () => {
  const env = await withBush('mkbush({ prefab = "berrybush", x = 3, z = 0, guid = 12, ready = false })')
  const n = env.observe()
  assert.equal(n.buckets.harvestables.length, 1, '未成熟也要能被看见')
  assert.equal(n.buckets.harvestables[0].harvest_ready, false)
})

test('harvest-08 观察：远处（8 格）的成熟浆果丛照样可见（观察 ≠ 执行距离）', async () => {
  const env = await withBush('mkbush({ prefab = "berrybush", x = 8 * 4, z = 0, guid = 13 })')
  const n = env.observe()
  assert.equal(n.buckets.harvestables.length, 1)
  assert.equal(n.buckets.harvestables[0].distance, 8)
})

test('harvest-09 观察：ref 全局唯一、九桶齐全、一个实体只进一个桶', async () => {
  const env = await withBush(`mkbush({ prefab = "berrybush", x = 3, z = 0, guid = 21 }),
    mkbush({ prefab = "evergreen", x = 8, z = 0, guid = 22, tags = {}, pickable = false })`)
  const n = env.observe()
  const refs = []
  for (const list of Object.values(n.buckets)) for (const it of list) refs.push(it.ref)
  assert.equal(new Set(refs).size, refs.length, 'ref 不能重复')
  assert.equal(Object.keys(n.buckets).length, 9, '九桶')
  const bush = n.buckets.harvestables[0]
  assert.ok(bush && bush.ref, '浆果丛必须拿到 ref')
})

// ═══════════════════════ 3. Guard：执行前重新校验 ═══════════════════════

test('harvest-10 guard：成熟 + 在原生距离内 → 通过并带出实体', async () => {
  const env = await withBush(READY_BUSH, { withGuard: true })
  env.setCmd(harvestCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  assert.equal(env.validate(), 'true|nil|true')
})

test('harvest-11 guard：未成熟 → not_ready（即使快照里看得见）', async () => {
  const env = await withBush('mkbush({ prefab = "berrybush", x = 3, z = 0, guid = 31, ready = false })', { withGuard: true })
  env.setCmd(harvestCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  assert.equal(env.validate(), 'false|not_ready|false')
})

test('harvest-12 guard：次数用尽 / 卡住 → already_harvested / target_busy', async () => {
  const a = await withBush('mkbush({ prefab = "berrybush", x = 3, z = 0, guid = 32, cycles = 0 })', { withGuard: true })
  a.setCmd(harvestCmd())
  a.run('CMD.args.snapshot_id = SNAP')
  assert.equal(a.validate(), 'false|already_harvested|false')

  const b = await withBush('mkbush({ prefab = "berrybush", x = 3, z = 0, guid = 33, stuck = true })', { withGuard: true })
  b.setCmd(harvestCmd())
  b.run('CMD.args.snapshot_id = SNAP')
  assert.equal(b.validate(), 'false|target_busy|false')
})

test('harvest-13 guard：超出原生距离 → out_of_range（且绝不自动靠近）', async () => {
  const env = await withBush('mkbush({ prefab = "berrybush", x = 5 * 4, z = 0, guid = 34 })', { withGuard: true })
  env.setCmd(harvestCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  assert.equal(env.validate(), 'false|out_of_range|false')
})

test('harvest-14 guard：非白名单目标 / 旧快照 / 参数错 → 全拒', async () => {
  const env = await withBush('mkbush({ prefab = "evergreen", x = 3, z = 0, guid = 35, tags = {}, pickable = false, workable = true })', { withGuard: true })
  env.setCmd(harvestCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  assert.equal(env.validate(), 'false|prefab_not_allowed|false')

  const e2 = await withBush(READY_BUSH, { withGuard: true })
  e2.setCmd(harvestCmd({ args: { target_ref: '#1', snapshot_id: 'r-other-0000-n1' } }))
  assert.equal(e2.validate(), 'false|stale_snapshot|false')

  const e3 = await withBush(READY_BUSH, { withGuard: true })
  e3.setCmd(harvestCmd({ args: { target_ref: '1', snapshot_id: 'x' } }))
  assert.equal(e3.validate(), 'false|bad_format:target_ref|false')

  const e4 = await withBush(READY_BUSH, { withGuard: true })
  e4.setCmd(harvestCmd({ args: { target_ref: '#1' } }))
  assert.equal(e4.validate(), 'false|missing_arg:snapshot_id|false')
})

test('harvest-15 guard：Actor 忙碌 → actor_busy；没有控制权 → control_denied', async () => {
  const env = await withBush(READY_BUSH, { withGuard: true })
  env.run('Whale.job = { name = "move_to", step = "walk", data = {} }')
  env.setCmd(harvestCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  assert.equal(env.validate(), 'false|actor_busy|false')

  const e2 = await withBush(READY_BUSH, { withGuard: true })
  e2.setCmd(harvestCmd({ owner_type: 'mcp_client' }))
  e2.run('CMD.args.snapshot_id = SNAP')
  assert.equal(e2.validate(), 'false|wrong_owner|false')
})

test('harvest-16 观察与执行共用同一份规则（同一张表 + 同一函数）', async () => {
  const env = await load({ withGuard: true })
  env.run(`OUT = tostring(Whale.guard.ACTIONS.harvest ~= nil)
      .. "|" .. tostring(Whale.harvestrules.PrefabList()[1]) .. "," .. tostring(Whale.harvestrules.PrefabList()[2])
      .. "|" .. tostring(Whale.harvestrules.NATIVE_RANGE_BASE)`, '一致')
  assert.equal(env.get('OUT'), 'true|berrybush,berrybush2|4')
})

// ═══════════════════════ 4. 执行与结果核对 ═══════════════════════

test('harvest-17 执行：canbepicked 由 true 翻转 false + 背包浆果 +1 → done', async () => {
  const env = await withBush(READY_BUSH, { withActions: true })
  env.setCmd(harvestCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  assert.equal(env.validate(), 'true|nil|true')
  env.run(`
    local ok, why, detail = Whale.guard.validate(CMD)
    Whale.guard.accept(CMD)
    TARGET = detail.target
    STARTED_OK = tostring(Whale.actions.Start("harvest", CMD.args, CMD.command_id, { target = TARGET }))
    Whale.actions.Tick()                 -- start → acting（提交 BufferedAction）
    PUSHED_COUNT = #PUSHED
    PUSHED_ACTION = PUSHED[1] ~= nil and PUSHED[1].action.id or "?"
    -- 模拟引擎执行原生 PICK：canbepicked 翻 false，产物进背包
    TARGET.components.pickable.canbepicked = false
    ITEMS = { { prefab = "berries", components = { stackable = { StackSize = function() return 1 end } } } }
    PLAYER.components.inventory.ForEachItem = function(self, fn) for _, it in ipairs(ITEMS) do fn(it) end end
    Whale.actions.Tick()
    DONE = tostring(Whale.job == nil)
  `)
  assert.equal(env.get('STARTED_OK'), 'true')
  assert.equal(env.get('PUSHED_COUNT'), '1', '必须恰好提交一次原生动作')
  assert.equal(env.get('PUSHED_ACTION'), 'PICK', '底层必须是原生 ACTIONS.PICK')
  assert.equal(env.get('DONE'), 'true')
  env.run('OUT = tostring(LAST_REPORT_OK) .. "|" .. tostring(LAST_REPORT_TEXT)')
  const out = env.get('OUT')
  assert.match(out, /^true\|/, '必须是成功：' + out)
  assert.match(out, /采下了/, out)
  assert.match(out, /berries\+1/, '要说清产物进了背包：' + out)
})

test('harvest-18 执行：状态翻转但产物没进背包（背包满会落地）→ 仍然成功，但说清"没进背包"', async () => {
  const env = await withBush(READY_BUSH, { withActions: true })
  env.setCmd(harvestCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  env.run(`
    local ok, why, detail = Whale.guard.validate(CMD)
    Whale.guard.accept(CMD)
    local T = detail.target
    Whale.actions.Start("harvest", CMD.args, CMD.command_id, { target = T })
    Whale.actions.Tick()
    T.components.pickable.canbepicked = false     -- 采到了
    Whale.actions.Tick()                          -- 但背包里没有 berries
    DONE = tostring(Whale.job == nil)
  `)
  assert.equal(env.get('DONE'), 'true')
  env.run('OUT = tostring(LAST_REPORT_OK) .. "|" .. tostring(LAST_REPORT_TEXT)')
  const out = env.get('OUT')
  assert.match(out, /^true\|/, '收获成功就该报成功：' + out)
  assert.match(out, /没进背包|掉在地上/, '必须区分"入包"与"落地"：' + out)
})

test('harvest-19 执行：原生动作没生效（状态一直不变）→ 超时后 fail，不谎报成功', async () => {
  const env = await withBush(READY_BUSH, { withActions: true })
  env.setCmd(harvestCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  env.run(`
    local ok, why, detail = Whale.guard.validate(CMD)
    Whale.guard.accept(CMD)
    local T = detail.target
    Whale.actions.Start("harvest", CMD.args, CMD.command_id, { target = T })
    Whale.actions.Tick()
    NOW = NOW + 10
    Whale.actions.Tick()
    DONE = tostring(Whale.job == nil)
  `)
  assert.equal(env.get('DONE'), 'true')
  env.run('OUT = tostring(LAST_REPORT_OK) .. "|" .. tostring(LAST_REPORT_TEXT)')
  const out = env.get('OUT')
  assert.match(out, /^false\|/, '不能谎报成功：' + out)
  assert.match(out, /harvest_failed/, out)
})

test('harvest-20 执行：没有 #N（没有 ctx.target）时绝不会去采浆果丛', async () => {
  const env = await withBush(READY_BUSH, { withActions: true })
  // 故意不带 ctx.target：只给了 args（模型也拿不到别的入口）
  env.run(`Whale.actions.Start("harvest", { target_ref = "#1" }, "cid")
    Whale.actions.Tick()
    OUT = tostring(#PUSHED) .. "|" .. tostring(LAST_REPORT_OK) .. "|" .. tostring(LAST_REPORT_TEXT)`, '无目标')
  const out = env.get('OUT')
  assert.match(out, /^0\|false\|/, '不能提交任何原生动作，且必须失败：' + out)
  // 浆果丛状态没被碰过
  env.run('OUT2 = tostring(NEARBY[1].components.pickable.canbepicked)')
  assert.equal(env.get('OUT2'), 'true', '目标必须原封不动')
  // 单独验证：真没有目标时（ctx 有但为 nil）也走不了 ctx 路径
  env.run('OUT3 = tostring(Whale.harvestrules.IsReady(NEARBY[1]))')
  assert.equal(env.get('OUT3'), 'true')
})

// ═══════════════════════ 5. Node：Schema / 工具 / 核对 ═══════════════════════

test('harvest-21 Node 工具：harvest 已注册，参数只有 target_ref + snapshot_id，描述讲清限制', async () => {
  const { TOOLS, ACTION_NAMES } = await import('../lib/tools.js')
  const { OPEN_ACTIONS, ACTION_SPECS } = await import('../lib/dispatcher.js')
  assert.ok(OPEN_ACTIONS.includes('harvest'))
  assert.ok(ACTION_NAMES.has('harvest'), 'F8/MCP 共用同一份工具表')
  const tool = TOOLS.find((t) => t.name === 'harvest')
  assert.deepEqual(tool.inputSchema.required, ['target_ref', 'snapshot_id'])
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['snapshot_id', 'target_handle', 'target_ref'])
  assert.equal(ACTION_SPECS.harvest.riskLevel, 'R2')
  for (const w of ['浆果丛', '成熟', 'snapshot_id', 'out_of_range', 'not_ready', '不会', 'pickup']) {
    assert.ok(tool.description.includes(w), `描述里必须提到 ${w}`)
  }
  assert.doesNotMatch(tool.description, /收获附近资源/, '不能写含糊描述')
})

test('harvest-22 Node Schema：缺参/坏格式/伪造字段一律在动作发生前拒绝', async () => {
  const { ACTION_SPECS, validateArgs } = await import('../lib/dispatcher.js')
  const spec = ACTION_SPECS.harvest
  assert.equal(validateArgs(spec, { target_ref: '#3', snapshot_id: 'r1-n9' }).ok, true)
  const bad = [
    [{ snapshot_id: 'x' }, 'missing_arg:target_ref'],
    [{ target_ref: '#3' }, 'missing_arg:snapshot_id'],
    [{ target_ref: '3', snapshot_id: 'x' }, 'bad_format:target_ref'],
    [{ target_ref: '#3', snapshot_id: '' }, 'empty_string:snapshot_id'],
    [{ target_ref: 3, snapshot_id: 'x' }, 'bad_type:target_ref'],
  ]
  for (const [args, reason] of bad) {
    const r = validateArgs(spec, args)
    assert.equal(r.ok, false, JSON.stringify(args))
    assert.equal(r.reason, reason, JSON.stringify(args))
  }
  for (const extra of [{ guid: 1 }, { prefab: 'berrybush' }, { x: 1 }, { owner_instance_id: 'x' },
                       { lease_generation: 2 }, { authority_epoch: 'e' }, { lua: 'os.execute("x")' }]) {
    const r = validateArgs(spec, { target_ref: '#3', snapshot_id: 'r1-n9', ...extra })
    assert.equal(r.ok, false)
    assert.match(r.reason, /^unknown_arg:/)
  }
})

test('harvest-23 Node 核对：产物进背包 → 通过；状态翻转 → 通过；都没变 → unverified', async () => {
  const { ACTION_SPECS } = await import('../lib/dispatcher.js')
  const before = {
    nearby: {
      snapshot_id: 'r1-n9',
      buckets: {
        threats: [], pickupables: [],
        harvestables: [{ ref: '#2', prefab: 'berrybush', label: '浆果丛', distance: 0.8,
                         position: { x: 3, z: 0 }, is_harvestable: true, harvest_ready: true,
                         product: 'berries', cycles_left: 3, item_kind: 'food' }],
        food: [], resources: [], containers: [], structures: [], creatures: [], other: [],
      },
    },
    player: { inventory: { used: 0, items: [] } },
  }
  const withBerries = { ...before, player: { inventory: { used: 1, items: [{ prefab: 'berries', count: 1 }] } } }
  const flipped = {
    ...before,
    nearby: { ...before.nearby, buckets: { ...before.nearby.buckets, harvestables: [{ ...before.nearby.buckets.harvestables[0], ref: '#3', harvest_ready: false }] } },
  }
  const v1 = ACTION_SPECS.harvest.verify(before, withBerries, { target_ref: '#2' })
  assert.equal(v1.ok, true)
  assert.equal(v1.how, 'inventory')
  assert.equal(v1.gained, 1)
  const v2 = ACTION_SPECS.harvest.verify(before, flipped, { target_ref: '#2' })
  assert.equal(v2.ok, true)
  assert.equal(v2.how, 'state_flipped', 'ref 会变，必须靠 prefab+位置认实体')
  const v3 = ACTION_SPECS.harvest.verify(before, before, { target_ref: '#2' })
  assert.equal(v3.ok, false)
  assert.equal(v3.reason, 'harvest_state_unchanged')
  assert.equal(ACTION_SPECS.harvest.verify(before, withBerries, { target_ref: '#9' }).reason, 'unknown_ref')
})

test('harvest-24 Node：旧快照会被 stale_snapshot 拒绝，且不写命令', async () => {
  const { LeaseManager } = await import('../lib/control.js')
  const { createDispatcher } = await import('../lib/dispatcher.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: pjoin } = await import('node:path')
  const dir = mkdtempSync(pjoin(tmpdir(), 'bws-m23-'))
  const ENV = { runtimeId: 'r1', sessionId: 's', shardId: '1', actorId: 'player:KU_r' }
  const control = new LeaseManager({ file: pjoin(dir, 'm2-control.json'), now: () => Date.now() })
  control.acquire('f8_agent', ENV, { ownerInstanceId: 'inst-A' })
  let calls = 0
  const snap = {
    stale: false,
    actor: { actorId: 'player:KU_r', valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0 },
    identity: { sessionId: 's', shardId: '1' },
    nearby: { runtime_id: 'r1', snapshot_id: 'r1-n5', status: 'ok', buckets: { threats: [], pickupables: [], harvestables: [{ ref: '#1', prefab: 'berrybush', harvest_ready: true, position: { x: 3, z: 0 }, product: 'berries' }], food: [], resources: [], containers: [], structures: [], creatures: [], other: [] } },
    player: { inventory: { used: 0, items: [] } },
  }
  const d = createDispatcher({
    bridge: { call: async () => { calls++; return { ok: true, text: '采下了 浆果丛' } } },
    control,
    readSnapshot: () => snap,
    now: () => Date.now(),
  })
  try {
    const r = await d.dispatch({ tool: 'harvest', args: { target_ref: '#1', snapshot_id: 'r1-n4' }, owner: 'f8_agent', ownerInstanceId: 'inst-A' })
    assert.equal(r.status, 'rejected')
    assert.equal(r.reason, 'stale_snapshot')
    assert.equal(calls, 0, '被拒时不能写命令')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ═══════════════════════ 6. 租约换手加固（M2.3 修的 P0） ═══════════════════════

test('harvest-25 换手必须拿到 job_cleared === true：缺字段/false/非布尔一律保持 revoking', async () => {
  const { LeaseManager } = await import('../lib/control.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: pjoin } = await import('node:path')
  const dir = mkdtempSync(pjoin(tmpdir(), 'bws-m23-lease-'))
  const ENV = { runtimeId: 'r1', sessionId: 's', shardId: '1', actorId: 'player:KU_r' }
  try {
    const c = new LeaseManager({ file: pjoin(dir, 'm2-control.json'), now: () => Date.now() })
    c.acquire('f8_agent', ENV, { ownerInstanceId: 'inst-A' })
    c.acquire('mcp_client', ENV, { ownerInstanceId: 'inst-B' })   // 触发 revoking
    const fresh = c.readAuthority()
    assert.equal(fresh.status, 'revoking')
    const base = { authority_epoch: fresh.authority_epoch, generation: fresh.generation, runtime_id: fresh.runtime_id, lease_id: fresh.lease_id }
    // 缺 job_cleared
    assert.equal(c.completeHandover({ ...base, acked_at: Date.now() }).reason, 'handover_job_not_cleared')
    // job_cleared = false（旧动作还在跑）
    assert.equal(c.completeHandover({ ...base, job_cleared: false, acked_at: Date.now() }).reason, 'handover_job_not_cleared')
    // 非布尔
    assert.equal(c.completeHandover({ ...base, job_cleared: 'true', acked_at: Date.now() }).reason, 'handover_job_not_cleared')
    // 缺 lease_id
    assert.equal(c.completeHandover({ authority_epoch: base.authority_epoch, generation: base.generation, runtime_id: base.runtime_id, job_cleared: true, acked_at: Date.now() }).reason, 'handover_ack_lease_id_missing')
    // lease_id 不匹配
    assert.equal(c.completeHandover({ ...base, lease_id: 'other-lease', job_cleared: true, acked_at: Date.now() }).reason, 'handover_ack_lease_id_mismatch')
    // 没有时间戳
    assert.equal(c.completeHandover({ ...base, job_cleared: true }).reason, 'handover_ack_no_timestamp')
    // 太旧（重放旧确认）：既早于本次换手、也太老，两个拒绝原因都合法
    assert.match(c.completeHandover({ ...base, job_cleared: true, acked_at: Date.now() - 60000 }).reason, /^handover_ack_(stale|expired)$/)
    // 仍然 revoking（fail-closed）
    assert.equal(c.readAuthority().status, 'revoking', '任何一条不满足都必须保持 revoking')
    // 合法确认才放行
    assert.equal(c.completeHandover({ ...base, job_cleared: true, acked_at: Date.now() }).ok, true)
    assert.equal(c.readAuthority().status, 'active')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('harvest-26 Lua 的 ack 确实带 job_cleared / lease_id / acked_at', () => {
  const src = readFileSync(join(MOD, 'scripts', 'whale', 'bridge.lua'), 'utf8')
  assert.match(src, /job_cleared = \(Whale == nil or Whale\.job == nil\)/)
  assert.match(src, /lease_id = authority\.lease_id/)
  assert.match(src, /acked_at = os\.time\(\) \* 1000\.0/)
  // Abort 必须真的把 BufferAction 清掉（换手后不能继续产生未授权副作用）
  const acts = readFileSync(join(MOD, 'scripts', 'whale', 'actions', 'core.lua'), 'utf8')
  assert.match(acts, /function A\.Abort/)
  const abortBody = acts.slice(acts.indexOf('function A.Abort'), acts.indexOf('function A.Abort') + 900)
  assert.match(abortBody, /stop_actions\(p\)/, 'Abort 必须走统一的停止清理')
  const stopBody = acts.slice(acts.indexOf('local function stop_actions'), acts.indexOf('local function stop_actions') + 300)
  assert.match(stopBody, /loco:Stop\(\)/, '必须停下移动')
  assert.match(stopBody, /loco:Clear\(\)/, '必须清掉 locomotor 队列里的动作')
  assert.match(stopBody, /ClearBufferedAction/, '必须清掉挂起的动作')
})

// ═══════════════════════ 7. 回归 ═══════════════════════

test('harvest-27 Harvest 与 Pickup 边界：不自动接续、不换目标、不共用 command', async () => {
  const acts = readFileSync(join(MOD, 'scripts', 'whale', 'actions', 'gathering.lua'), 'utf8')
  const harvestJob = acts.slice(acts.indexOf('local function harvest_by_ref'), acts.indexOf('JOBS.pickup = function'))
  assert.ok(harvestJob.length > 200)
  assert.doesNotMatch(harvestJob, /ACTIONS\.PICKUP/, 'harvest 里不能顺手捡东西')
  assert.doesNotMatch(harvestJob, /find_all|find_by_name/, '不能按 prefab 找替代目标')
  assert.match(harvestJob, /ACTIONS\.PICK/, '底层必须是原生 PICK')
  // pickup 也没被改动成"采完自动捡"
  const pickupJob = acts.slice(acts.indexOf('local function pickup_by_ref'), acts.indexOf('--- M2.3'))
  assert.doesNotMatch(pickupJob, /ACTIONS\.PICK\b/, 'pickup 里不能顺手采')
})

test('harvest-28 回归：move_to / stop / pickup 语义未变，白名单只多了一个 harvest', async () => {
  const { OPEN_ACTIONS, ACTION_SPECS, validateArgs } = await import('../lib/dispatcher.js')
  assert.deepEqual(OPEN_ACTIONS.slice().sort(), ['attack', 'build', 'chop', 'chop_nearest', 'container_put', 'container_take', 'cook', 'craft', 'dig', 'drop', 'eat', 'equip', 'fight_spider', 'fuel', 'gather', 'gather_area', 'give', 'hammer', 'harvest', 'harvest_nearest', 'inspect', 'kill', 'lookup', 'mine', 'mine_nearest', 'move_to', 'pickup', 'pickup_food', 'pickup_nearest', 'probe', 'recipes', 'say', 'seek', 'sleep', 'stop', 'unequip', 'use', 'wait'])
  assert.equal(validateArgs(ACTION_SPECS.move_to, { x: 1, z: 2 }).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.stop, {}).ok, true)
  // OBSERVATION-02：引用 1 起
  assert.deepEqual(ACTION_SPECS.pickup.args.target_ref.pattern, '^#[1-9][0-9]{0,3}$')
  assert.equal(validateArgs(ACTION_SPECS.pickup, { target_ref: '#0', snapshot_id: 's' }).ok, false, '#0 要拒')
  assert.equal(ACTION_SPECS.harvest.requiresSnapshot, true)
})


test('harvest-29 真机回归：被采过的浆果丛（pickable 标签已被移除）仍是候选、Ready=false、且出现在可收获桶', async () => {
  const env = await load()
  // 模拟真机：Pick() 之后 canbepicked=false，组件把 pickable 标签摘掉
  env.run(`PICKED = mkbush({ prefab = "berrybush", guid = 77, x = 3, z = 0, ready = false, tags = {} })
    local ok_c, why_c = Whale.harvestrules.IsCandidate(PICKED)
    local ok_r, why_r = Whale.harvestrules.IsReady(PICKED)
    OUT = tostring(ok_c) .. "|" .. tostring(why_c) .. ";" .. tostring(ok_r) .. "|" .. tostring(why_r)
          .. ";" .. tostring(Whale.harvestrules.ReadState(PICKED).can_be_picked)`, '被采过')
  assert.equal(env.get('OUT'), 'true|nil;false|not_ready;false', '候选成立、但不成熟')
})

test('harvest-30 被采过的浆果丛必须仍然出现在 harvestables（harvest_ready=false），不能掉进 resources', async () => {
  const env = await withBush('mkbush({ prefab = "berrybush", x = 3, z = 0, guid = 78, ready = false, tags = {} })')
  const n = env.observe()
  assert.equal(n.buckets.harvestables.length, 1, '不成熟也要能被看见（否则模型以为这株不存在）')
  assert.equal(n.buckets.harvestables[0].harvest_ready, false)
  assert.equal(n.buckets.resources.length, 0, '不该因为丢标签就掉进 resources')
})
