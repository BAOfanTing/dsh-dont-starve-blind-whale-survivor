// Phase 5 M2 · Lua ActionExecutor 沙箱测试
//
// 用 fengari 在真 Lua 虚拟机里跑 action_executor.lua，验证：
//   ① 固定白名单（未知动作/任意函数名被拒）
//   ② 服务端权威（非 ismastersim 拒绝）
//   ③ 控制权二次校验（Bridge 不授权就拒绝，绝不"乐观放行"）
//   ④ 玩家状态检查（死亡/幽灵拒绝）
//   ⑤ move_to 参数校验
//   ⑥ 校验通过才调 Whale.actions.Start()
//   ⑦ get_movement_status 只读、不碰游戏
//
// 注意：这是**沙箱单元测试**，不是真实游戏内验证（游戏未运行）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const STUB = `
GLOBAL = {}
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.os = { time = function() return NOW end }
GLOBAL.TheWorld = { ismastersim = true }
GLOBAL.TheSim = { GetRealTime = function() return NOW * 1000 end }
GLOBAL.Vector3 = function(x, y, z) return { x = x, y = y, z = z } end
GLOBAL.BufferedAction = function() return {} end
GLOBAL.ACTIONS = {}
GLOBAL.EQUIPSLOTS = { HANDS = "hands" }
NOW = 0
GLOBAL.AllPlayers = {}

-- 假 Whale.actions（不动游戏，只记录 Start 调用）
Whale = {
    util = {
        player = function() return PLAYER end,
        pos = function(p) if p == nil then return nil end return 10, 0, 20 end,
    },
    actions = {
        Start = function(name, args)
            STARTED = { name = name, args = args }
            return true, nil
        end,
        Current = function() return CURRENT_NAME, CURRENT_ARGS end,
    },
    bridge = { Report = function(ok, text) REPORTED = { ok = ok, text = text } end },
}
STARTED = nil
CURRENT_NAME = nil
CURRENT_ARGS = nil
REPORTED = nil
PLAYER = { components = { health = { IsDead = function() return false end } }, HasTag = function() return false end }

-- 假 BWS2 依赖
BWS = { json = { decode = function(s) return DECODED_BODY end } }
BWS2 = {
    connection = { protocolVersion = function() return "1.0" end, session = function() return "S1" end },
    config = { get = function() return { token = "T" } end },
    json = { decode = function(s) return DECODED_BODY end },
    http = {
        post = function(path, body, cb)
            LAST_POST = { path = path, body = body }
            if POST_IMMEDIATE ~= false then cb(POST_RESPONSE) end
        end,
    },
}
DECODED_BODY = nil
POST_RESPONSE = { ok = true, body = "{}" }
POST_IMMEDIATE = true
LAST_POST = nil
REPORTS = {}
function report(commandId, status, result, err, startedMs)
    REPORTS[#REPORTS + 1] = { id = commandId, status = status, result = result, error = err }
end
`

function load(fengari, extra = '') {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, label = 'lua') => {
    const status = lauxlib.luaL_dostring(L, to_luastring(code))
    if (status !== lua.LUA_OK) {
      let message = ''
      try { message = to_jsstring(lua.lua_tostring(L, -1)) } catch {}
      throw new Error(`${label} 运行失败：${message}`)
    }
  }
  run(STUB, '假游戏环境')
  run(readFileSync(join(MOD, 'scripts', 'main', 'action_executor.lua'), 'utf8'), 'action_executor.lua')
  if (extra.length > 0) run(extra, '额外设置')
  const get = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' }
  }
  const call = (expr) => {
    run(`RESULT = (function() ${expr} end)()`)
    return get('RESULT')
  }
  return { run, get, call }
}

/** 让 Bridge 的 assert 返回 allowed=true */
const allow = `POST_RESPONSE = { ok = true, body = "{}" }; DECODED_BODY = { allowed = true, code = "OK", message = "ok" }`

test('M2 Lua：未知动作直接拒绝，绝不执行任意外部字符串', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, allow)
  run(`
    local r = BWS2.actionExecutor.execute({ id = "c1", type = "eval_lua", params = { code = "os.execute(1)" } }, report)
    assert(r.status == "FAILED", "未知动作应失败")
    assert(#REPORTS == 1, "应回报一次失败")
    assert(string.find(REPORTS[1].error, "unknown_action", 1, true) ~= nil, "错误码应是 unknown_action")
    assert(STARTED == nil, "绝不能启动任何动作")
  `)
})

test('M2 Lua：非服务端权威（客户端）拒绝执行', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, `GLOBAL.TheWorld.ismastersim = false; ${allow}`)
  run(`
    local r = BWS2.actionExecutor.execute({ id = "c1", type = "move_to", params = { x = 1, z = 2, controller_id = "C1", session_id = "S1" } }, report)
    assert(r.status == "FAILED")
    assert(string.find(REPORTS[1].error, "not_server_authoritative", 1, true) ~= nil)
    assert(STARTED == nil)
  `)
})

test('M2 Lua：缺控制字段拒绝（不乐观放行）', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, allow)
  run(`
    BWS2.actionExecutor.execute({ id = "c1", type = "move_to", params = { x = 1, z = 2 } }, report)
    assert(string.find(REPORTS[1].error, "missing_control_fields", 1, true) ~= nil)
    assert(LAST_POST == nil, "不该发出控制权校验请求之外的动作")
    assert(STARTED == nil)
  `)
})

test('M2 Lua：Bridge 不可用（assert 请求失败）→ 拒绝执行', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, `POST_RESPONSE = { ok = false, error = "network" }`)
  run(`
    BWS2.actionExecutor.execute({ id = "c1", type = "move_to", params = { x = 1, z = 2, controller_id = "C1", session_id = "S1" } }, report)
    assert(string.find(REPORTS[1].error, "control_assert_unavailable", 1, true) ~= nil)
    assert(STARTED == nil, "Bridge 挂了绝不乐观放行")
  `)
})

test('M2 Lua：控制权未授权（allowed=false）→ 拒绝，带明确错误码', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, `POST_RESPONSE = { ok = true, body = "{}" }; DECODED_BODY = { allowed = false, code = "CONTROL_NOT_HELD", message = "没有控制权" }`)
  run(`
    BWS2.actionExecutor.execute({ id = "c1", type = "move_to", params = { x = 1, z = 2, controller_id = "C1", session_id = "S1" } }, report)
    assert(string.find(REPORTS[1].error, "CONTROL_NOT_HELD", 1, true) ~= nil)
    assert(STARTED == nil)
  `)
})

test('M2 Lua：玩家死亡 / 幽灵状态拒绝', async () => {
  const fengari = await import('fengari')
  const dead = load(fengari, `PLAYER = { components = { health = { IsDead = function() return true end } }, HasTag = function() return false end }; ${allow}`)
  dead.run(`
    BWS2.actionExecutor.execute({ id = "c1", type = "move_to", params = { x = 1, z = 2, controller_id = "C1", session_id = "S1" } }, report)
    assert(string.find(REPORTS[1].error, "player_not_ready", 1, true) ~= nil)
    assert(STARTED == nil)
  `)
  const ghost = load(fengari, `PLAYER = { components = { health = { IsDead = function() return false end } }, HasTag = function() return true end }; ${allow}`)
  ghost.run(`
    BWS2.actionExecutor.execute({ id = "c2", type = "move_to", params = { x = 1, z = 2, controller_id = "C1", session_id = "S1" } }, report)
    assert(string.find(REPORTS[1].error, "player_not_ready", 1, true) ~= nil)
    assert(STARTED == nil)
  `)
})

test('M2 Lua：move_to 参数校验（缺坐标 / 非数字 / 超范围）', async () => {
  const fengari = await import('fengari')
  for (const params of ['{}', '{ x = "abc", z = 2 }', '{ x = 999999, z = 2 }']) {
    const { run } = load(fengari, allow)
    run(`
      BWS2.actionExecutor.execute({ id = "c1", type = "move_to", params = ${params}, controller_id = "C1", session_id = "S1" }, report)
      assert(string.find(REPORTS[1].error, "invalid_argument", 1, true) ~= nil, "应拒绝参数 " .. tostring(${JSON.stringify(params)}))
      assert(STARTED == nil)
    `)
  }
})

test('M2 Lua：校验通过才启动原生 move_to，且回报 EXECUTING（中间态）', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, allow)
  run(`
    local r = BWS2.actionExecutor.execute({ id = "c1", type = "move_to", params = { x = 12, z = 45, controller_id = "C1", session_id = "S1" } }, report)
    assert(STARTED ~= nil, "应启动动作")
    assert(STARTED.name == "move_to", "应映射到 Whale.actions 的 move_to，实际 " .. tostring(STARTED.name))
    assert(STARTED.args.x == 12 and STARTED.args.z == 45)
    assert(LAST_POST.path == "/api/v1/control/assert", "必须先走控制权二次校验")
    assert(#REPORTS == 1, "应回报一次")
    assert(REPORTS[1].status == "EXECUTING", "启动应回中间态 EXECUTING，不是终态 SUCCEEDED")
    assert(REPORTS[1].result.accepted == true and REPORTS[1].result.running == true)
  `)
})

test('M2 Lua：stop_movement 映射到 stop，不执行任意字符串', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, allow)
  run(`
    BWS2.actionExecutor.execute({ id = "c1", type = "stop_movement", params = { controller_id = "C1", session_id = "S1" } }, report)
    assert(STARTED.name == "stop")
    assert(REPORTS[1].result.job == "stop")
    assert(REPORTS[1].status == "EXECUTING")
  `)
})

test('M2 Lua：get_movement_status 只读，不需要控制权，不启动动作', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, `CURRENT_NAME = "move_to"; CURRENT_ARGS = { x = 5 }`)
  run(`
    local s = BWS2.actionExecutor.movementStatus()
    assert(s.ok == true)
    assert(s.moving == true)
    assert(s.current_action == "move_to")
    assert(LAST_POST == nil, "只读查询不该发控制权请求")
    assert(STARTED == nil, "只读查询不该启动动作")
  `)
})

test('M2/M3 Lua：status() 只暴露固定白名单动作', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    local s = BWS2.actionExecutor.status()
    assert(#s.known_actions == 8, "M2(2) + M3(2) + M4(4) 共 8 个写动作，实际 " .. tostring(#s.known_actions))
    -- Known() 按字母序返回
    assert(s.known_actions[1] == "chop_tree")
    assert(s.known_actions[2] == "equip_item")
    assert(s.known_actions[3] == "gather_resource")
    assert(s.known_actions[4] == "mine_rock")
    assert(s.known_actions[5] == "move_to")
    assert(s.known_actions[6] == "move_to_target")
    assert(s.known_actions[7] == "pick_up_item")
    assert(s.known_actions[8] == "stop_movement")
  `)
})
