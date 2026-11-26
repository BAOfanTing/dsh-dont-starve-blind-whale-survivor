// stop-lua-integration.test.mjs
// Phase R.7.3: Lua 端 actions.Start('stop') 打断在行任务与 Reflex 保护集成测试

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const STUB = `
GLOBAL = {}
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.os = os
GLOBAL.io = io
GLOBAL.STRINGS = {
    NAMES = { BERRYBUSH = "浆果丛", EVERGREEN = "常青树", ROCK1 = "巨石", SPIDER = "蜘蛛", LOG = "木头" },
    CHARACTER_NAMES = { WILSON = "威尔逊" },
}
GLOBAL.EQUIPSLOTS = { HANDS = "hands", BODY = "body", HEAD = "head" }
local function act(id) return { id = id } end
GLOBAL.ACTIONS = { CHOP = act("CHOP"), MINE = act("MINE"), DIG = act("DIG"), HAMMER = act("HAMMER"),
                   PICK = act("PICK"), PICKUP = act("PICKUP"), HARVEST = act("HARVEST"), ATTACK = act("ATTACK"),
                   EAT = act("EAT"), COOK = act("COOK"), SLEEPIN = act("SLEEPIN"), DROP = act("DROP"),
                   ADDFUEL = act("ADDFUEL"), HEAL = act("HEAL") }
GLOBAL.Vector3 = function(x, y, z) return { x = x, y = y, z = z } end
GLOBAL.BufferedAction = function(doer, target, action, invobject, pos)
    return { doer = doer, target = target, action = action, invobject = invobject, pos = pos }
end
GLOBAL.TheNet = { Announce = function(self, text) end }
GLOBAL.SetServerPaused = function(v) end

NOW = 0
GLOBAL.TheSim = {
    GetTime = function() return NOW end,
    FindEntities = function() return {} end,
    SetPersistentString = function() end,
    GetPersistentString = function(self, name, cb) cb(false, nil) end,
}
GLOBAL.TheWorld = {
    ismastersim = true,
    state = { cycles = 1, phase = "day", season = "autumn", temperature = 14 },
    HasTag = function() return false end,
    DoPeriodicTask = function(self, interval, fn) end,
    Map = { CanDeployRecipeAtPoint = function() return true end },
}
GLOBAL.AllRecipes = {}

local function makeplayer()
    local p = {
        prefab = "wilson",
        _x = 0, _z = 0,
        components = {
            health = { currenthealth = 100, maxhealth = 150, GetPercent = function() return 1 end, IsDead = function() return false end },
            hunger = { current = 100, max = 150, GetPercent = function() return 1 end },
            sanity = { current = 100, max = 200, GetPercent = function() return 1 end },
            temperature = { GetCurrent = function() return 15 end },
            moisture = { GetMoisture = function() return 0 end },
            locomotor = {
                IsMoving = function() return true end,
                Stop = function() LOCO_STOPPED = true end,
                Clear = function() LOCO_CLEARED = true end,
                GoToPoint = function(self, pt) end,
            },
            inventory = {
                GetNumSlots = function() return 15 end,
                GetItemInSlot = function() return nil end,
                GetEquippedItem = function() return nil end,
                ForEachItem = function() end,
            },
        },
        Transform = { GetWorldPosition = function() return 0, 0, 0 end },
        ClearBufferedAction = function() ACTION_CLEARED = true end,
        GetBufferedAction = function() return nil end,
        IsValid = function() return true end,
        HasTag = function() return false end,
        GetPosition = function() return { x = 0, y = 0, z = 0 } end,
    }
    return p
end

PLAYER = makeplayer()
GLOBAL.ThePlayer = PLAYER
GLOBAL.AllPlayers = { [1] = PLAYER }
`

const FILES = `
Whale.files = {
    cmd = "whale_cmd.txt",
    cmd_io = "whale_cmd_io.txt",
    res = "whale_res.json",
    res_io = "whale_res_io.json",
    status = "whale_status.json",
    lease = "whale_lease.json",
}
`

function loadMod(fengari) {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, what) => {
    const status = lauxlib.luaL_dostring(L, to_luastring(code))
    if (status !== lua.LUA_OK) {
      let message = ''
      try {
        message = to_jsstring(lua.lua_tostring(L, -1))
      } catch {}
      throw new Error(`${what} 出错：${message}`)
    }
  }
  run(STUB, '假游戏环境')
  run('Whale = { verbose = false, version = "0.1.0", files = {} }', 'Whale 表')
  run(FILES, '文件名')
  for (const name of [
    'json', 'util', 'pickuprules', 'harvestrules', 'eatrules', 'craftrules', 'equiprules',
    'config', 'actor', 'nearby', 'observe', 'native', 'actions', 'guard_specs', 'guard', 'bridge',
  ]) {
    if (name === 'actions') {
      for (const sub of ['core', 'movement', 'gathering', 'work', 'combat', 'survival', 'crafting', 'interaction']) {
        run(readFileSync(join(MOD, 'scripts', 'whale', 'actions', `${sub}.lua`), 'utf8'), `actions/${sub}.lua`)
      }
    }
    run(readFileSync(join(MOD, 'scripts', 'whale', `${name}.lua`), 'utf8'), `${name}.lua`)
  }
  const global = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try {
      return to_jsstring(lua.lua_tostring(L, -1))
    } catch {
      return ''
    }
  }
  return { run, global, L, fengari }
}

test('STOP-LUA-01: Whale.actions.Start("stop") 打断在行普通动作并向 bridge 发出被新指令打断回执', async () => {
  const fengari = await import('fengari')
  const { run, global } = loadMod(fengari)

  run(`
    REPORTS = {}
    Whale.bridge.Report = function(ok, text, cmd_id)
        table.insert(REPORTS, { ok = ok, text = text, cmd_id = cmd_id })
    end

    -- 启动一个在行动作 move_to
    local startOk, startErr = Whale.actions.Start("move_to", { x = 20, z = 20 }, "cmd_move_prev")
    assert(startOk, "move_to 应该成功启动: " .. tostring(startErr))

    -- 此时下发 stop 动作
    local stopOk, stopErr = Whale.actions.Start("stop", {}, "cmd_stop_1")
    assert(stopOk, "stop 应该成功启动并打断上一任务")
  `)

  // 检查在行动作被打断的回执已发出
  run(`
    assert(#REPORTS == 1, "应该立即向 Bridge 报告前置任务被打断")
    local rep1 = REPORTS[1]
    assert(rep1.ok == false, "前置任务应该为失败")
    assert(rep1.cmd_id == "cmd_move_prev", "被打断任务的 cmd_id 应为 cmd_move_prev")
    assert(string.find(rep1.text, "被新指令打断"), "文本应包含打断说明")
  `)

  // 执行 Tick 推进 stop 动作完成
  run(`
    Whale.actions.Tick()
    assert(#REPORTS == 2, "Tick 应该完成 stop 动作并上报")
    local rep2 = REPORTS[2]
    assert(rep2.ok == true, "stop 动作应该成功")
    assert(rep2.cmd_id == "cmd_stop_1", "stop 动作的 cmd_id 应为 cmd_stop_1")
    assert(rep2.text == "停下了", "stop 动作回执应为停下了")
  `)
})

test('STOP-LUA-02: 当处于 Reflex 保命状态时，stop 指令被拒绝，Reflex 不被打断', async () => {
  const fengari = await import('fengari')
  const { run } = loadMod(fengari)

  run(`
    REPORTS = {}
    Whale.bridge.Report = function(ok, text, cmd_id)
        table.insert(REPORTS, { ok = ok, text = text, cmd_id = cmd_id })
    end

    -- 启动一个紧急 Reflex 保命动作
    local reflexOk = Whale.actions.Start("move_to", { x = 5, z = 5 }, "reflex")
    assert(reflexOk, "Reflex 动作应该成功启动")

    -- 尝试以普通 stop 打断 Reflex
    local stopOk, stopErr = Whale.actions.Start("stop", {}, "cmd_stop_user")
    assert(stopOk == false, "处于 Reflex 状态时普通 stop 必须被拒绝")
    assert(string.find(stopErr, "reflex_active"), "错误信息必须标明 reflex_active")

    -- 确认当前任务依然是 Reflex
    assert(Whale.job ~= nil and Whale.job.cmd_id == "reflex", "当前在行动作依然是 Reflex")
    assert(#REPORTS == 0, "被拒绝的 stop 绝不能上报打断原有任务")
  `)
})

test('STOP-LUA-03（D9）：换手(revoking)时必须真正 Abort 当前游戏动作，而不只是写 ack', async () => {
  const fengari = await import('fengari')
  const { run, global } = loadMod(fengari)
  run(`
    REPORTS = {}
    ACKED = false
    Whale.bridge.Report = function(ok, text, cmd_id) table.insert(REPORTS, { ok = ok, text = text, cmd_id = cmd_id }) end
    Whale.bridge.WriteLeaseAck = function() ACKED = true end
    assert(Whale.actions.Start("move_to", { x = 20, z = 20 }, "cmd_prev"), "启动 move_to")
    Whale.guard.read_authority = function() return { status = "revoking", authority_epoch = "e1", generation = 2, lease_id = "l1", runtime_id = "r1", expires_at = (os.time() * 1000.0) + 60000 } end
    local ok, why = Whale.guard.validate({ protocol_version = 1, command_id = "cmd_new", action = "move_to", args = { x = 1, z = 1 }, expires_at = (os.time() * 1000.0) + 60000 })
    RET_OK = tostring(ok)
    RET_WHY = tostring(why)
  `)
  assert.equal(global('RET_OK'), 'false')
  assert.match(global('RET_WHY'), /authority_revoking/)
  run('assert(Whale.job == nil, "换手时必须已 Abort 掉旧 job")')
  run('assert(ACKED == true, "换手仍要写 lease ack")')
  run('assert(#REPORTS >= 1, "Abort 应为旧 cmd 报一条被打断回执")')
})
