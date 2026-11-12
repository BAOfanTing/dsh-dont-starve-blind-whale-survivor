// Phase 5 M3 · 基础资源采集系统 Lua 沙箱测试
//
// 覆盖：资源白名单（拒绝任意 prefab 名）、参数夹取、参数规范化（映射到 pick/go_to）、
//       probe_game_actions 只读探测、采集完成终态回执带真实文本。
// 复用 phase5-m2-fixes.test.mjs 的假环境（这里重新搭一份简化的，避免跨文件耦合）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const STUB = `
CLOCK = 1000
POSTS = {}
GLOBAL = {}
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.os = { time = function() return CLOCK end }
GLOBAL.TheSim = { GetRealTime = function() return CLOCK * 1000 end }
GLOBAL.TheWorld = { ismastersim = true, HasTag = function() return false end }
GLOBAL.AllPlayers = {}
-- 真实游戏里的 ACTIONS 未知，这里模拟"PICKUP 不存在"的场景
GLOBAL.ACTIONS = { PICK = {}, HARVEST = {}, CHOP = {}, MINE = {}, DIG = {}, EAT = {} }

BWS = { json = { decode = function(s) return DECODED end } }
BWS2 = {
    connection = { protocolVersion = function() return "1.0" end, session = function() return "S1" end,
                   isServerSide = function() return true end },
    config = { get = function() return { token = "T" } end },
    http = { post = function(path, body, cb)
        POSTS[#POSTS + 1] = { path = path, body = body }
        if path == "/api/v1/control/assert" then cb({ ok = true, status = 200, body = "{}" }) end
    end },
    json = { decode = function(s) return DECODED end },
}
DECODED = { allowed = true, code = "OK", message = "ok" }
REPORTS = {}
function report(commandId, status, result, err, startedMs)
    REPORTS[#REPORTS + 1] = { id = commandId, status = status, result = result, error = err }
end

Whale = {
    util = { player = function() return PLAYER end, pos = function(p) if p == nil then return nil end return 10, 0, 20 end,
             log = function() end },
    actions = {
        Start = function(name, args) STARTED = { name = name, args = args }; return true, nil end,
        Current = function() return CURRENT, CURRENT_ARGS end,
        Known = function() return { "chop", "go_to", "mine", "pick", "stop" } end,
    },
    bridge = { Report = function(ok, text)
        if BWS2.actionExecutor ~= nil and BWS2.actionExecutor.onActionReport ~= nil then
            pcall(BWS2.actionExecutor.onActionReport, ok, text, nil)
        end
    end },
}
STARTED = nil
CURRENT = nil
CURRENT_ARGS = nil
PLAYER = { components = { health = { IsDead = function() return false end }, locomotor = { Stop = function() end } },
           HasTag = function() return false end, ClearBufferedAction = function() end }
`

function load(fengari) {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, label = 'lua') => {
    const st = lauxlib.luaL_dostring(L, to_luastring(code))
    if (st !== lua.LUA_OK) {
      let m = ''
      try { m = to_jsstring(lua.lua_tostring(L, -1)) } catch {}
      throw new Error(`${label}: ${m}`)
    }
  }
  run(STUB, '假环境')
  run(readFileSync(join(MOD, 'scripts', 'main', 'action_executor.lua'), 'utf8'), 'action_executor.lua')
  return { run }
}

const cmd = (resource, extra = {}) => `{
  id = "c1", type = "gather_resource",
  params = { resource = ${resource}, count = 3, radius = 8,
             controller_id = "C1", session_id = "S1" ${Object.entries(extra).map(([k, v]) => `, ${k} = ${v}`).join('')} }
}`

test('M3：gather_resource 映射到 pick，参数规范化（resource→target，count/radius 夹取）', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    CURRENT = "pick"
    BWS2.actionExecutor.execute(${cmd('"twigs"')}, report)
    assert(STARTED ~= nil, "应启动动作")
    assert(STARTED.name == "pick", "gather_resource 应映射到 pick，实际 " .. tostring(STARTED.name))
    assert(STARTED.args.target == "twigs", "resource 应转成游戏实体名 twigs")
    assert(STARTED.args.count == 3)
    assert(STARTED.args.radius == 8)
    assert(REPORTS[1].status == "EXECUTING", "启动回 EXECUTING")
    assert(REPORTS[1].result.args.target == "twigs", "EXECUTING 回执应带规范化参数")
  `)
})

test('M3：grass / berries 也在白名单，且映射到正确实体名', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    CURRENT = "pick"
    BWS2.actionExecutor.execute(${cmd('"grass"')}, report)
    assert(STARTED.args.target == "grass")
  `)
  const { run: run2 } = load(fengari)
  run2(`
    CURRENT = "pick"
    BWS2.actionExecutor.execute(${cmd('"berries"')}, report)
    assert(STARTED.args.target == "berrybush", "berries 应映射到 berrybush")
  `)
})

test('M3：任意 prefab 名 / 未列出的资源一律拒绝（不执行任意字符串）', async () => {
  const fengari = await import('fengari')
  for (const bad of ['"spider"', '"deerclops"', '"firepit"', 'nil', '123']) {
    const { run } = load(fengari)
    run(`
      BWS2.actionExecutor.execute(${cmd(bad)}, report)
      assert(STARTED == nil, "非法资源不该启动动作: " .. tostring(${bad}))
      assert(REPORTS[1].status == "FAILED")
      assert(string.find(REPORTS[1].error, "invalid_argument", 1, true) ~= nil)
    `)
  }
})

test('M3：count / radius 超出范围被夹取，不会让模型传极大值', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    CURRENT = "pick"
    BWS2.actionExecutor.execute(${cmd('"twigs"', { count: '999', radius: '9999' })}, report)
    assert(STARTED.args.count == 10, "count 应夹到 10，实际 " .. tostring(STARTED.args.count))
    assert(STARTED.args.radius == 20, "radius 应夹到 20，实际 " .. tostring(STARTED.args.radius))
  `)
  const { run: run2 } = load(fengari)
  run2(`
    CURRENT = "pick"
    BWS2.actionExecutor.execute(${cmd('"twigs"', { count: '0', radius: '0' })}, report)
    assert(STARTED.args.count == 1, "count 下限 1")
    assert(STARTED.args.radius == 2, "radius 下限 2")
  `)
})

test('M3：move_to_target 映射到 go_to，同样走资源白名单', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    CURRENT = "go_to"
    BWS2.actionExecutor.execute({
      id = "c1", type = "move_to_target",
      params = { resource = "grass", radius = 6, controller_id = "C1", session_id = "S1" }
    }, report)
    assert(STARTED.name == "go_to")
    assert(STARTED.args.target == "grass")
    assert(STARTED.args.radius == 6)
    BWS2.actionExecutor.execute({
      id = "c2", type = "move_to_target",
      params = { resource = "spider", controller_id = "C1", session_id = "S1" }
    }, report)
    assert(#REPORTS == 2, "非法目标应被拒")
    assert(REPORTS[2].status == "FAILED")
  `)
})

test('M3：probe_game_actions 只读，报告 ACTIONS 可用性与资源白名单', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    local r = BWS2.actionExecutor.probeGameActions()
    assert(r.ok == true)
    assert(r.actions.PICK == true)
    assert(r.actions.HARVEST == true)
    assert(r.actions.PICKUP == false, "这个假环境里 PICKUP 不存在，应如实报告")
    assert(r.pickup_supported == false)
    assert(#r.gather_targets == 3, "白名单 3 个资源")
    assert(r.gather_targets[1] == "berries" and r.gather_targets[2] == "grass" and r.gather_targets[3] == "twigs")
    assert(#r.jobs == 5, "应列出 Whale.actions.Known() 的 JOBS")
    assert(#POSTS == 0, "只读探测不该发任何 HTTP 请求")
    assert(CURRENT == nil, "只读探测不该启动动作")
  `)
})

test('M3：采集完成终态回执带真实数量文本与规范化参数', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    CURRENT = "pick"
    BWS2.actionExecutor.execute(${cmd('"twigs"')}, report)
    -- 模拟 Whale.actions.Tick 完成：Report(true, "采了 3 次")
    Whale.bridge.Report(true, "采了 3 次")
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    assert(#REPORTS == 2, "EXECUTING + 终态")
    assert(REPORTS[2].status == "SUCCEEDED")
    assert(REPORTS[2].result.completed == true)
    assert(REPORTS[2].result.text == "采了 3 次", "应带回游戏内真实数量文本")
    assert(REPORTS[2].result.args.target == "twigs")
    assert(REPORTS[2].result.args.count == 3)
  `)
})

test('M3：附近没资源时补发 FAILED 并带真实原因', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    CURRENT = "pick"
    BWS2.actionExecutor.execute(${cmd('"berries"')}, report)
    Whale.bridge.Report(false, "附近 8 格里没有能采的东西")
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    assert(REPORTS[2].status == "FAILED")
    assert(string.find(REPORTS[2].error, "没有能采的", 1, true) ~= nil)
    assert(REPORTS[2].result.args.target == "berrybush")
  `)
})

test('M3：status() 暴露 4 个写动作与 3 个资源白名单', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari)
  run(`
    local s = BWS2.actionExecutor.status()
    assert(#s.known_actions == 4, "写动作 4 个")
    assert(s.write_actions.gather_resource == true)
    assert(s.write_actions.move_to_target == true)
  `)
})
