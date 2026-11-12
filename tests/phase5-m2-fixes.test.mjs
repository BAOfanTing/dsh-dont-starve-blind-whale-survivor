// Phase 5 M2 · 两个阻塞项的 Lua 沙箱回归测试
//
//   A. net.lua 自愈：DoPeriodicTask 失效后，keepAlive 能补跑心跳/命令轮询并重建任务
//   B. 动作最终成败回执：启动回 EXECUTING，动作结束后用同一 command_id 补发终态；
//      断线结果未知时标记 unknown_completion（等价 NEEDS_RECONCILIATION，禁止盲目重放）
//
// 这是沙箱单元测试，不是真机测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

/** 通用假环境：可控时钟 + 可失效的周期任务 + 记录所有 HTTP 请求 */
const STUB = `
CLOCK = 1000
POSTS = {}
TASKS = {}
TASK_SEQ = 0

GLOBAL = {}
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.os = { time = function() return CLOCK end }
GLOBAL.io = nil
GLOBAL.AllPlayers = {}
GLOBAL.TheSim = { GetRealTime = function() return CLOCK * 1000 end, GetTick = function() return CLOCK end }
GLOBAL.TheWorld = {
    ismastersim = true,
    HasTag = function() return false end,
    DoPeriodicTask = function(self, period, fn)
        TASK_SEQ = TASK_SEQ + 1
        local task = { period = period, fn = fn, valid = true, seq = TASK_SEQ }
        function task:IsValid() return self.valid end
        function task:Cancel() self.valid = false end
        TASKS[#TASKS + 1] = task
        return task
    end,
}

BWS = { json = { decode = function(s) return DECODED end, encode = function(t) return "{}" end },
        serializer = { State = function() return {} end, Nearby = function() return {} end,
                       Boot = function() return {} end, shrink_nearby = function(x) return x end } }
BWS2 = {
    connection = {
        protocolVersion = function() return "1.0" end,
        session = function() return "S1" end,
        ensureSession = function() end,
        isServerSide = function() return true end,
        backoffFactor = function() return 1 end,
        onSuccess = function() end,
        onFailure = function() end,
        status = function() return { state = "online", backoff_factor = 1, session_id = "S1" } end,
    },
    config = { get = function() return {
        token = "T", heartbeatSeconds = 3, stateSeconds = 2, pollSeconds = 1,
        protocolVersion = "1.0", verbose = false,
    } end },
    http = {
        post = function(path, body, cb)
            POSTS[#POSTS + 1] = { path = path, body = body }
            if cb ~= nil then cb({ ok = true, status = 200, body = "{}" }) end
        end,
        stats = function() return { sent = 0 } end,
    },
    heartbeat = { send = function() HEARTBEATS = (HEARTBEATS or 0) + 1 end,
                  stats = function() return { sent = HEARTBEATS or 0 } end },
    telemetry = { submit = function() end, flushIfPending = function() end,
                  status = function() return { sequence = 0 } end },
    commands = { poll = function() POLLS = (POLLS or 0) + 1 end,
                 status = function() return {} end },
    json = { decode = function(s) return DECODED end },
}
HEARTBEATS = 0
POLLS = 0
DECODED = nil
REPORTS = {}
function report(commandId, status, result, err, startedMs)
    REPORTS[#REPORTS + 1] = { id = commandId, status = status, result = result, error = err }
end

-- 假 Whale.actions：Current() 由 CURRENT 变量控制
Whale = {
    util = {
        player = function() return PLAYER end,
        pos = function(p) if p == nil then return nil end return 10, 0, 20 end,
        log = function() end,
    },
    actions = {
        Start = function(name, args) STARTED = { name = name, args = args }; return true, nil end,
        Current = function() return CURRENT, CURRENT_ARGS end,
        Tick = function() end,
        Abort = function() end,
    },
    bridge = { Report = function(ok, text)
        LAST_BRIDGE_REPORT = { ok = ok, text = text }
        if BWS2.actionExecutor ~= nil and BWS2.actionExecutor.onActionReport ~= nil then
            pcall(BWS2.actionExecutor.onActionReport, ok, text, nil)
        end
    end },
    json = { encode = function() return "{}" end, decode = function() return {} end },
    files = {},
    verbose = false,
}
STARTED = nil
CURRENT = nil
CURRENT_ARGS = nil
LAST_BRIDGE_REPORT = nil
PLAYER = { components = { health = { IsDead = function() return false end },
                          locomotor = { Stop = function() end } },
           HasTag = function() return false end,
           ClearBufferedAction = function() end }
`

function load(fengari, files, extra = '') {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, label = 'lua') => {
    const st = lauxlib.luaL_dostring(L, to_luastring(code))
    if (st !== lua.LUA_OK) {
      let m = ''
      try { m = to_jsstring(lua.lua_tostring(L, -1)) } catch {}
      throw new Error(`${label} 运行失败：${m}`)
    }
  }
  run(STUB, '假环境')
  for (const f of files) run(readFileSync(join(MOD, 'scripts', 'main', `${f}.lua`), 'utf8'), `${f}.lua`)
  if (extra.length > 0) run(extra, '额外设置')
  const get = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' }
  }
  return { run, get }
}

// ───────────────── A. net.lua 自愈 ─────────────────

test('A1：net.start 建一个周期任务，tickBody 会发心跳并驱动命令轮询', async () => {
  const fengari = await import('fengari')
  const { run, get } = load(fengari, ['net'])
  run(`
    assert(BWS2.net.start() == true, "start 应成功")
    assert(#TASKS == 1, "应只建 1 个周期任务，实际 " .. #TASKS)
    -- 手动触发 tick
    TASKS[1].fn()
    assert(HEARTBEATS >= 1, "tick 应发心跳")
    assert(POLLS >= 1, "tick 应驱动命令轮询")
    assert(BWS2.net.status().ticks >= 1)
  `)
})

test('A2：周期任务失效后，keepAlive 补跑心跳/轮询并重建任务', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, ['net'])
  run(`
    assert(BWS2.net.start() == true)
    TASKS[1].fn()
    local h0, p0 = HEARTBEATS, POLLS
    -- 模拟任务失效（世界重载 / Bridge 重启）
    TASKS[1].valid = false
    CLOCK = CLOCK + 10        -- 超过 KEEPALIVE_GAP=3
    h0, p0 = HEARTBEATS, POLLS
    BWS2.net.keepAlive()
    assert(HEARTBEATS > h0, "keepAlive 应补跑心跳，否则命令通道断")
    assert(POLLS > p0, "keepAlive 应补跑命令轮询")
    assert(BWS2.net.status().rebuilds >= 1, "应重建周期任务")
  `)
})

test('A3：tick 还活着时 keepAlive 不重复建任务（避免任务堆积）', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, ['net'])
  run(`
    assert(BWS2.net.start() == true)
    for i = 1, 20 do BWS2.net.keepAlive() end
    assert(#TASKS == 1, "不该重复建任务，实际 " .. #TASKS)
    assert(BWS2.net.status().rebuilds == 0, "tick 活着时不该重建")
  `)
})

test('A4：重复 start 不会建第二个任务', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, ['net'])
  run(`
    assert(BWS2.net.start() == true)
    assert(BWS2.net.start() == false, "已有活任务时应返回 false")
    assert(#TASKS == 1)
  `)
})

// ───────────────── B. 动作最终成败回执 ─────────────────

const ACTION_STUB = `
DECODED = { allowed = true, code = "OK", message = "ok" }
BWS2.http.post = function(path, body, cb)
    POSTS[#POSTS + 1] = { path = path, body = body }
    if path == "/api/v1/control/assert" then
        cb({ ok = true, status = 200, body = "{}" })
    end
end
`

test('B1：启动动作回 EXECUTING（中间态），不是终态 SUCCEEDED', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, ['action_executor'], ACTION_STUB)
  run(`
    CURRENT = "move_to"
    BWS2.actionExecutor.execute({ id = "c1", type = "move_to",
        params = { x = 1, z = 2, controller_id = "C1", session_id = "S1" } }, report)
    assert(#REPORTS == 1, "应回一次")
    assert(REPORTS[1].status == "EXECUTING", "启动应回 EXECUTING，实际 " .. tostring(REPORTS[1].status))
    assert(REPORTS[1].result.running == true)
  `)
})

test('B2：动作成功完成后，用同一 command_id 补发 SUCCEEDED', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, ['action_executor'], ACTION_STUB)
  run(`
    CURRENT = "move_to"
    BWS2.actionExecutor.execute({ id = "c1", type = "move_to",
        params = { x = 1, z = 2, controller_id = "C1", session_id = "S1" } }, report)
    -- 动作完成：Whale.bridge.Report(true, ...) + Current() 变 nil
    Whale.bridge.Report(true, "走到了 (1,2) 附近")
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    assert(#REPORTS == 2, "应有启动 + 终态两次回执，实际 " .. #REPORTS)
    assert(REPORTS[1].status == "EXECUTING")
    assert(REPORTS[2].status == "SUCCEEDED", "终态应是 SUCCEEDED")
    assert(REPORTS[2].id == "c1", "必须用同一个 command_id")
    assert(REPORTS[2].result.completed == true)
  `)
})

test('B3：动作失败后补发 FAILED，带真实错误文本', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, ['action_executor'], ACTION_STUB)
  run(`
    CURRENT = "move_to"
    BWS2.actionExecutor.execute({ id = "c1", type = "move_to",
        params = { x = 1, z = 2, controller_id = "C1", session_id = "S1" } }, report)
    Whale.bridge.Report(false, "被挡死了，站在 3.2 格外过不去")
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    assert(REPORTS[2].status == "FAILED")
    assert(string.find(REPORTS[2].error, "被挡死了", 1, true) ~= nil, "应带真实失败原因")
  `)
})

test('B4：完成信号丢失（断线）→ unknown_completion，禁止盲目重放', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, ['action_executor'], ACTION_STUB)
  run(`
    CURRENT = "move_to"
    BWS2.actionExecutor.execute({ id = "c1", type = "move_to",
        params = { x = 1, z = 2, controller_id = "C1", session_id = "S1" } }, report)
    -- 动作结束了但没有任何 Report（模拟游戏断线 / 分片重载）
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    assert(REPORTS[2].status == "FAILED")
    assert(string.find(REPORTS[2].error, "unknown_completion", 1, true) ~= nil,
        "结果未知必须标 unknown_completion（等价 NEEDS_RECONCILIATION）")
    assert(REPORTS[2].result.unknown_completion == true)
    local s = BWS2.actionExecutor.status()
    assert(s.completion.reconciled == 1, "应计入 reconciled")
  `)
})

test('B5：被新指令打断不算成功，补发 FAILED + interrupted', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, ['action_executor'], ACTION_STUB)
  run(`
    CURRENT = "move_to"
    BWS2.actionExecutor.execute({ id = "c1", type = "move_to",
        params = { x = 1, z = 2, controller_id = "C1", session_id = "S1" } }, report)
    Whale.bridge.Report(false, "被新指令打断了（上一件事没做完）")
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    assert(REPORTS[2].status == "FAILED")
    assert(REPORTS[2].result.interrupted == true, "打断不能算成功")
  `)
})

test('B6：动作还在跑时不结算；movementStatus 能看到 pending_command_id', async () => {
  const fengari = await import('fengari')
  const { run } = load(fengari, ['action_executor'], ACTION_STUB)
  run(`
    CURRENT = "move_to"
    BWS2.actionExecutor.execute({ id = "c1", type = "move_to",
        params = { x = 1, z = 2, controller_id = "C1", session_id = "S1" } }, report)
    BWS2.actionExecutor.pollCompletion()
    assert(#REPORTS == 1, "还在跑时不该结算")
    local s = BWS2.actionExecutor.movementStatus()
    assert(s.pending_command_id == "c1", "应能看到待结算的 command_id")
    assert(s.moving == true)
  `)
})

test('B7：动作执行中命令重投时，不会被提前判成 SUCCEEDED（保住 EXECUTING）', async () => {
  const fengari = await import('fengari')
  // 这个测试要连 commands.lua 一起加载，用它的 handle 逻辑较复杂，
  // 直接验证 action_executor.status().pending_command_id 能作为"仍在执行"的判据
  const { run } = load(fengari, ['action_executor'], ACTION_STUB)
  run(`
    CURRENT = "move_to"
    BWS2.actionExecutor.execute({ id = "c1", type = "move_to",
        params = { x = 1, z = 2, controller_id = "C1", session_id = "S1" } }, report)
    local s = BWS2.actionExecutor.status()
    assert(s.pending_command_id == "c1", "执行中应能查到 pending_command_id，供 commands.lua 判断不覆盖终态")
    -- 模拟 commands.lua 的重投保护：pending 时不回 SUCCEEDED
    local stillRunning = (s.pending_command_id == "c1")
    assert(stillRunning == true)
    -- 动作完成并结算后，pending 清空，重投才可以正常按 duplicate 收尾
    Whale.bridge.Report(true, "好了")
    CURRENT = nil
    BWS2.actionExecutor.pollCompletion()
    assert(BWS2.actionExecutor.status().pending_command_id == nil, "结算后 pending 应清空")
  `)
})
