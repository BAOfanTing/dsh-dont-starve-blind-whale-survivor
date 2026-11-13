// M2.1 Pickup：Lua 侧（guard 目标校验 + pickup_by_ref 执行与结果核对）
//
// 证据类型：UNIT（fengari 沙箱 + 真实 guard.lua/actions.lua，假游戏实体）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authority, command, luaIoFiles } from './helpers-m2.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')
const RUNTIME = 'r1794500000-0001'

const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.FOODTYPE = { ROUGHAGE = "ROUGHAGE", SEEDS = "SEEDS", GEARS = "GEARS", VEGGIE = "VEGGIE" }
GLOBAL.ACTIONS = { CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, DIG = { id = "DIG" }, HAMMER = { id = "HAMMER" },
                   PICKUP = { id = "PICKUP" } }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "sess-R" end }
GLOBAL.TheShard = { GetShardId = function() return "1" end }
NOW = 1000
NOW_MS = 1794500000000
NEARBY = {}
PUSHED = {}
GLOBAL.TheSim = { GetTime = function() return NOW end, GetRealTime = function() return NOW * 1000 end,
                  FindEntities = function() return NEARBY end }

--- 假物品：inventoryitem + stackable，参数控制能否被捡
function mkitem(opts)
    opts = opts or {}
    local e = { prefab = opts.prefab or "twigs", GUID = opts.guid or 1, tags = opts.tags or {},
                components = {}, valid = opts.valid ~= false, limbo = opts.limbo == true,
                parent = opts.parent or nil,
                Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end } }
    e.IsValid = function(self) return self.valid end
    e.IsInLimbo = function(self) return self.limbo == true end
    e.GetPosition = function(self) return { x = opts.x or 0, y = 0, z = opts.z or 0 } end
    e.GetParent = function(self) return self.parent end
    e.HasTag = function(self, tag) if tag == "INLIMBO" then return self.limbo end return self.tags[tag] == true end
    e.components.inventoryitem = {
        canbepickedup = opts.canbepickedup ~= false,
        owner = opts.owner or nil,
    }
    if opts.stack ~= nil then
        e.components.stackable = { StackSize = function() return opts.stack end }
    end
    return e
end

function mkplaya(opts)
    opts = opts or {}
    local items = opts.items or {}
    local p = { prefab = "warly", GUID = 999, tags = { player = true }, components = {} }
    p.userid = "KU_r"
    p.parent = nil
    p.IsValid = function() return true end
    p.GetParent = function() return p.parent end
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
        CanAcceptCount = function(self, item, maxcount) return opts.can_accept ~= false and 99 or 0 end,
        ForEachItem = function(self, fn) for _, it in ipairs(items) do fn(it) end end,
    }
    return p
end
PLAYER = mkplaya()
GLOBAL.AllPlayers = { PLAYER }
GLOBAL.TheWorld = { state = { cycles = 1, phase = "day", season = "autumn", temperature = 20 },
                    HasTag = function() return false end, ismastersim = true }
GLOBAL.setmetatable = setmetatable
GLOBAL.getmetatable = getmetatable
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.os = { time = function() return math.floor(NOW_MS / 1000) end, clock = function() return 0 end }
-- BufferedAction：只要记录参数，执行由测试手动模拟
GLOBAL.BufferedAction = function(doer, target, action) return { doer = doer, target = target, action = action } end
pcall = nil
tonumber = nil
error = nil
os = nil
io = nil
`

async function load({ items = [], files } = {}) {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code) => {
    const st = lauxlib.luaL_dostring(L, to_luastring(code))
    if (st !== lua.LUA_OK) {
      let m = ''
      try { m = lua.lua_tojsstring(L, -1) ?? '' } catch (e) { m = 'decode-fail:' + e.message }
      throw new Error('Lua[' + lua.lua_type(L, -1) + ']: ' + m)
    }
  }
  const get = (n) => { lua.lua_getglobal(L, to_luastring(n)); try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' } }
  run(STUB)
  run(luaIoFiles(files ?? { 'whale_io_lease.json': authority({ runtime_id: RUNTIME }) }))
  run('Whale = { verbose = false, version = "0.15.0", files = { lease = "whale_lease.json", io_lease = "whale_io_lease.json", lease_ack = "whale_lease_ack.json", io_lease_ack = "whale_io_lease_ack.json" } }')
  for (const n of ['json', 'util', 'pickuprules', 'config', 'actor', 'nearby', 'guard', 'observe', 'actions', 'macros', 'bridge']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', n + '.lua'), 'utf8'))
  }
  run('Whale.config.build(function(k) if k == "scan_radius" then return 16 end if k == "scan_seconds" then return 4 end return nil end)')
  run(`Whale.nearby.runtime_id = function() return "${RUNTIME}" end`)
  // 记录动作回执（真实 bridge 会写到 result 文件，单测里只需要看 ok/text）
  run('LAST_REPORT_OK = nil; LAST_REPORT_TEXT = nil')
  run('Whale.bridge.Report = function(ok, text, id) LAST_REPORT_OK = ok and true or false; LAST_REPORT_TEXT = tostring(text or "") end')
  if (items.length > 0) {
    run('STACK_N = ' + Number(items[0].count ?? 1))
    run('ITEMS = {}')
    for (const it of items) {
      run('ITEMS[#ITEMS + 1] = { prefab = ' + JSON.stringify(it.prefab) +
        ', components = { stackable = { StackSize = function() return STACK_N end } } }')
    }
    run('PLAYER.components.inventory.ForEachItem = function(self, fn) for _, it in ipairs(ITEMS) do fn(it) end end')
  }
  const A = authority({ runtime_id: RUNTIME })
  const setCmd = (c) => run(`CMD = Whale.json.decode([==[${JSON.stringify(c)}]==])`)
  const validate = () => {
    run('local ok, why, detail = Whale.guard.validate(CMD); OUT = tostring(ok) .. "|" .. tostring(why) .. "|" .. tostring(detail ~= nil and detail.target ~= nil)')
    return get('OUT')
  }
  return { run, get, setCmd, validate, A }
}

const AUTH = authority({ runtime_id: RUNTIME })
const pickupCmd = (over = {}) => command(AUTH, {
  action: 'pickup',
  args: { target_ref: '#1', snapshot_id: 'SNAP' },
  ...over,
})

/** 造一个当前 nearby 快照（返回 snapshot_id） */
async function withNearby(entFn, opts = {}) {
  const env = await load(opts)
  env.run(`
    NEARBY = { ${entFn} }
    do
      local actor = Whale.actor.get_actor()
      local data = Whale.observe.BuildData(actor, { seq = 1, now = NOW })
      SNAP = data.nearby.snapshot_id
    end
  `)
  return env
}

// ─────────────────────────── guard：目标与前置条件 ───────────────────────────

test('pickup-L1 白名单内的普通物品（twigs，1 格内）→ 通过并带出已解析实体', async () => {
  const env = await withNearby('mkitem({ prefab = "twigs", x = 4, z = 0, guid = 11 })')
  env.setCmd(pickupCmd({ args: { target_ref: '#1', snapshot_id: null } }))
  env.run('CMD.args.snapshot_id = SNAP')
  assert.equal(env.validate(), 'true|nil|true')
})

test('pickup-L2 树 / 建筑类 prefab → prefab_not_allowed', async () => {
  const env = await withNearby('mkitem({ prefab = "evergreen", x = 4, z = 0, guid = 12 })')
  env.setCmd(pickupCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  assert.equal(env.validate(), 'false|prefab_not_allowed|false')
})

test('pickup-L3 没有 inventoryitem 的实体 → target_not_pickable', async () => {
  const env = await withNearby('mkitem({ prefab = "twigs", x = 4, z = 0, guid = 13 })')
  env.run('NEARBY[1].components.inventoryitem = nil')
  env.setCmd(pickupCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  assert.equal(env.validate(), 'false|target_not_pickable|false')
})

test('pickup-L4 canbepickedup=false / 已被别人持有 → target_not_pickable', async () => {
  const a = await withNearby('mkitem({ prefab = "twigs", x = 4, z = 0, guid = 14, canbepickedup = false })')
  a.setCmd(pickupCmd())
  a.run('CMD.args.snapshot_id = SNAP')
  assert.equal(a.validate(), 'false|target_not_pickable|false')

  const b = await withNearby('mkitem({ prefab = "twigs", x = 4, z = 0, guid = 15, owner = PLAYER })')
  b.setCmd(pickupCmd())
  b.run('CMD.args.snapshot_id = SNAP')
  assert.equal(b.validate(), 'false|target_not_pickable|false')
})

test('pickup-L5 超出 2.5 格 → out_of_range（绝不靠"走过去"兜底）', async () => {
  const env = await withNearby('mkitem({ prefab = "twigs", x = 20, z = 0, guid = 16 })')
  env.setCmd(pickupCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  assert.equal(env.validate(), 'false|out_of_range|false')
})

test('pickup-L6 实体失效 / 进 limbo / 引用不存在 → entity_gone / in_limbo / unknown_ref', async () => {
  const gone = await withNearby('mkitem({ prefab = "twigs", x = 4, z = 0, guid = 17 })')
  gone.run('NEARBY[1].valid = false')
  gone.setCmd(pickupCmd())
  gone.run('CMD.args.snapshot_id = SNAP')
  assert.equal(gone.validate(), 'false|entity_gone|false')

  const limbo = await withNearby('mkitem({ prefab = "twigs", x = 4, z = 0, guid = 18, limbo = true })')
  limbo.setCmd(pickupCmd())
  limbo.run('CMD.args.snapshot_id = SNAP')
  // INLIMBO 的实体会被 nearby 扫描直接过滤掉，所以这里通常是 unknown_ref（也是拒绝）
  assert.match(limbo.validate(), /^false\|(in_limbo|entity_gone|unknown_ref)\|false$/)

  const missing = await withNearby('mkitem({ prefab = "twigs", x = 4, z = 0, guid = 19 })')
  missing.setCmd(pickupCmd({ args: { target_ref: '#9', snapshot_id: null } }))
  missing.run('CMD.args.snapshot_id = SNAP')
  assert.equal(missing.validate(), 'false|unknown_ref|false')
})

test('pickup-L7 旧快照 / 参数格式错 / 缺 snapshot_id → 全拒', async () => {
  const env = await withNearby('mkitem({ prefab = "twigs", x = 4, z = 0, guid = 20 })')
  // 旧快照
  env.setCmd(pickupCmd({ args: { target_ref: '#1', snapshot_id: 'r-other-0001-n1' } }))
  assert.equal(env.validate(), 'false|stale_snapshot|false')
  // 格式错
  env.setCmd(pickupCmd({ args: { target_ref: '1', snapshot_id: 'x' } }))
  assert.equal(env.validate(), 'false|bad_format:target_ref|false')
  // 缺字段
  env.setCmd(pickupCmd({ args: { target_ref: '#1' } }))
  assert.equal(env.validate(), 'false|missing_arg:snapshot_id|false')
})

test('pickup-L8 角色忙碌（已有 job）→ actor_busy，不执行', async () => {
  const env = await withNearby('mkitem({ prefab = "twigs", x = 4, z = 0, guid = 21 })')
  env.run('Whale.job = { name = "move_to", step = "walk", data = {} }')
  env.setCmd(pickupCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  assert.equal(env.validate(), 'false|actor_busy|false')
})

test('pickup-L9 非白名单的同类物品（石头 inv_rocks 未启用）→ prefab_not_allowed', async () => {
  const env = await withNearby('mkitem({ prefab = "inv_rocks", x = 4, z = 0, guid = 22 })')
  env.setCmd(pickupCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  assert.equal(env.validate(), 'false|prefab_not_allowed|false')
})

// ─────────────────────────── 执行与结果核对 ───────────────────────────

test('pickup-L10 执行：目标进背包（parent=玩家）→ done，回执含物品名', async () => {
  const env = await withNearby('mkitem({ prefab = "twigs", x = 4, z = 0, guid = 30 })', { items: [] })
  env.setCmd(pickupCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  assert.equal(env.validate(), 'true|nil|true')
  // 模拟引擎：push 了 BufferedAction(PICKUP)，然后目标被挂到玩家身上
  env.run(`
    local ok, why, detail = Whale.guard.validate(CMD)
    Whale.guard.accept(CMD)
    TARGET = detail.target
    STARTED = Whale.actions.Start("pickup", CMD.args, CMD.command_id, { target = TARGET })
    STARTED_OK = tostring(STARTED)
    V_OK = tostring(ok) .. "|" .. tostring(why)
    Whale.actions.Tick()           -- 第一次 Tick 才会 push BufferedAction
    STEP1 = tostring(Whale.job ~= nil and Whale.job.step or "nil")
    PUSHED_COUNT = #PUSHED
    TARGET.parent = PLAYER
    TICK_RESULT = Whale.job ~= nil and "job-alive" or "job-done"
  `)
  assert.equal(env.get('STARTED_OK'), 'true', 'actions.Start 应成功')
  assert.equal(env.get('PUSHED_COUNT'), '1', '必须恰好提交一次原生 BufferedAction')
  const step = env.get('STEP1')
  assert.equal(step, 'acting', '第一步应处于 acting（push 后等引擎执行）')
  // 再 Tick 一次 → done（背包核对通过）
  env.run('local a = Whale.actions.Tick(); OUT2 = tostring(Whale.job == nil)')
  assert.equal(env.get('OUT2'), 'true', 'done 之后 job 应被清空')
})

test('pickup-L11 执行：目标消失且背包数量增加（堆叠合并）→ 也判成功', async () => {
  const env = await withNearby('mkitem({ prefab = "twigs", x = 4, z = 0, guid = 31 })', {
    items: [{ prefab: 'twigs', count: 3 }],
  })
  env.setCmd(pickupCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  env.run(`
    local ok, why, detail = Whale.guard.validate(CMD)
    Whale.guard.accept(CMD)
    TARGET = detail.target
    Whale.actions.Start("pickup", CMD.args, CMD.command_id, { target = TARGET })
    Whale.actions.Tick()          -- start → acting
    -- 模拟堆叠合并：目标被销毁，背包里 twigs 从 3 变 4
    TARGET.valid = false
    STACK_N = 4          -- 模拟原生堆叠：3 → 4
    Whale.actions.Tick()
    DONE = tostring(Whale.job == nil)
  `)
  assert.equal(env.get('DONE'), 'true')
})

test('pickup-L12 执行：目标一直在地上（捡不动）→ 超时后 fail，不谎报成功', async () => {
  const env = await withNearby('mkitem({ prefab = "twigs", x = 4, z = 0, guid = 32 })', { items: [] })
  env.setCmd(pickupCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  env.run(`
    local ok, why, detail = Whale.guard.validate(CMD)
    Whale.guard.accept(CMD)
    TARGET = detail.target
    Whale.actions.Start("pickup", CMD.args, CMD.command_id, { target = TARGET })
    Whale.actions.Tick()
    NOW = NOW + 10           -- 超过 6 秒超时
    Whale.actions.Tick()
    DONE = tostring(Whale.job == nil)
  `)
  assert.equal(env.get('DONE'), 'true')
  // 回执应是失败（results 里的最后一次 Report）
  env.run('OUT = tostring(LAST_REPORT_OK) .. "|" .. tostring(LAST_REPORT_TEXT)')
  const out = env.get('OUT')
  assert.match(out, /^false\|/, '必须是 ok=false：' + out)
  assert.match(out, /pickup_failed|地上/, '原因要说清：' + out)
})

test('pickup-L13 目标不是白名单时不会提交 BufferedAction（零副作用）', async () => {
  const env = await withNearby('mkitem({ prefab = "evergreen", x = 4, z = 0, guid = 33 })')
  env.setCmd(pickupCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  env.run(`
    local ok, why, detail = Whale.guard.validate(CMD)
    OUT_WHY = tostring(why)
    PUSHED_TOTAL = #PUSHED
    STARTED = tostring(ok)
  `)
  assert.equal(env.get('PUSHED_TOTAL'), '0', '被拒时不能有任何动作提交')
  assert.equal(env.get('STARTED'), 'false', '被拒时不能启动动作：' + env.get('OUT_WHY'))
})


test('pickup-L14 真机回归：捡起后目标进 limbo 且 parent=玩家 → 必须判成功（不能报 in_limbo）', async () => {
  const env = await withNearby('mkitem({ prefab = "twigs", x = 4, z = 0, guid = 40 })', { items: [] })
  env.setCmd(pickupCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  env.run(`
    local ok, why, detail = Whale.guard.validate(CMD)
    Whale.guard.accept(CMD)
    TARGET = detail.target
    Whale.actions.Start("pickup", CMD.args, CMD.command_id, { target = TARGET })
    Whale.actions.Tick()                 -- start -> acting（提交 BufferedAction）
    -- 模拟 DST：物品进背包后处于 limbo，但 parent 已经是玩家
    TARGET.limbo = true
    TARGET.parent = PLAYER
    Whale.actions.Tick()
    DONE = tostring(Whale.job == nil)
  `)
  assert.equal(env.get('DONE'), 'true', '必须判成功并结束任务')
  env.run('OUT = tostring(LAST_REPORT_OK) .. "|" .. tostring(LAST_REPORT_TEXT)')
  const out = env.get('OUT')
  assert.match(out, /^true\|/, '回执必须是成功：' + out)
  assert.match(out, /捡起了/, '文案要说捡到了什么：' + out)
})


test('pickup-L15 背包接收不了（原生 CanAcceptCount<=0）→ inventory_full，且不提交动作', async () => {
  const env = await withNearby('mkitem({ prefab = "twigs", x = 4, z = 0, guid = 50 })')
  env.run('PLAYER.components.inventory.CanAcceptCount = function() return 0 end')
  env.setCmd(pickupCmd())
  env.run('CMD.args.snapshot_id = SNAP')
  assert.equal(env.validate(), 'false|inventory_full|false')
  env.run('PUSHED_TOTAL = #PUSHED')
  assert.equal(env.get('PUSHED_TOTAL'), '0', '背包满时不能提交任何动作')
})
