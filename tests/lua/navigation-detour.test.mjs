// NAV-DETOUR: 海边绕行拐点算法测试 (line_passable & Coastline Detour)
// 验证沿线探水 (每 2 格采样一次) 与切线拐点试探 (±45°, ±90°)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const STUB = `
GLOBAL = {
    pcall = pcall,
    tonumber = tonumber,
    error = error,
    type = type,
    string = string,
    table = table,
    math = math,
    os = { time = function() return 1000 end },
    io = nil,
    GetTime = function() return 1000 end,
    TheSim = {
        GetTime = function() return 1000 end,
        GetRealTime = function() return 1000000 end,
        FindEntities = function() return {} end,
    },
    TheWorld = {
        Map = nil,
        state = { phase = "day", isday = true },
    },
    ACTIONS = {
        WALKTO = { id = "WALKTO" },
    },
    EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" },
    Vector3 = function(x, y, z) return { x = x or 0, y = y or 0, z = z or 0 } end,
    BufferedAction = function(doer, target, act) return { doer = doer, target = target, action = act } end,
    AllPlayers = {},
}

function newent(prefab, x, z)
    local e = {
        prefab = prefab or "test",
        Transform = {
            GetWorldPosition = function() return x or 0, 0, z or 0 end,
        },
        components = {},
    }
    function e:IsValid() return true end
    function e:HasTag() return false end
    return e
end

function makeplayer(px, pz)
    local p = newent("wilson", px or 0, pz or 0)
    p.userid = "KU_TEST"
    p.components = {
        locomotor = {
            GoToPoint = function(self, pt) GOTO_PT = pt end,
            Stop = function() end,
            Clear = function() end,
            WantsToMoveForward = function() return true end,
        },
    }
    function p:GetBufferedAction() return nil end
    function p:ClearBufferedAction() end
    p.sg = { HasStateTag = function(self, tag) return tag == "idle" end }
    return p
end

SENT_RPCS = {}
function SendModRPCToClient(rpc, userid, a, b, c)
    SENT_RPCS[#SENT_RPCS + 1] = { rpc = rpc, userid = userid, a = a, b = b, c = c }
end
function GetClientModRPC(mod, name)
    return "rpc:" .. tostring(name)
end
`

function loadNavigationMod(fengari) {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)

  const run = (code, what) => {
    const status = lauxlib.luaL_dostring(L, to_luastring(code))
    if (status !== lua.LUA_OK) {
      let message = ''
      try { message = to_jsstring(lua.lua_tostring(L, -1)) } catch {}
      throw new Error(`${what} 出错：${message}`)
    }
  }

  const runFile = (code) => {
    lauxlib.luaL_loadstring(L, to_luastring(code))
    const status = lua.lua_pcall(L, 0, 0, 0)
    if (status !== lua.LUA_OK) {
      let message = ''
      try { message = to_jsstring(lua.lua_tostring(L, -1)) } catch {}
      throw new Error(`运行失败：${message}`)
    }
  }

  run(STUB, '基础桩')
  run('Whale = { verbose = false, version = "test", files = {} }', 'Whale 表')
  run(`
    Whale.bridge = { Report = function(ok, text, id) REPORTED = { ok = ok, text = text, id = id } end,
                     WriteState = function() end }
    REPORTED = nil
  `, 'Bridge桩')

  // 加载 util
  run(readFileSync(join(MOD, 'scripts', 'whale', 'util.lua'), 'utf8'), 'util.lua')

  // 加载 actions/core
  run(readFileSync(join(MOD, 'scripts', 'whale', 'actions', 'core.lua'), 'utf8'), 'actions/core.lua')

  // 加载 actions/movement
  run(readFileSync(join(MOD, 'scripts', 'whale', 'actions', 'movement.lua'), 'utf8'), 'actions/movement.lua')

  const global = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' }
  }

  return { L, run, runFile, global }
}

test('NAV-1: is_passable 默认兜底与地图查询', async () => {
  const fengari = await import('fengari')
  const { runFile, global } = loadNavigationMod(fengari)

  runFile(`
    -- 1. 无地图桩时默认通过
    local p1 = Whale.util.is_passable(10, 20)
    assert(p1 == true, "无 TheWorld.Map 时应默认返回 true 兼容旧测试")

    -- 2. 挂载 Map 桩
    GLOBAL.TheWorld.Map = {
        IsPassableAtPoint = function(self, x, y, z, allow_water, exclude_boats)
            -- 模拟 (10, 0) 为水，其他为陆地
            if x >= 8 and x <= 12 and z >= -2 and z <= 2 then
                return false
            end
            return true
        end
    }

    local land = Whale.util.is_passable(0, 0)
    local water = Whale.util.is_passable(10, 0)
    assert(land == true, "陆地坐标应返回 true")
    assert(water == false, "海洋/水面坐标应返回 false")
  `)
})

test('NAV-2: line_passable 连线探水采样与参数兼容', async () => {
  const fengari = await import('fengari')
  const { runFile } = loadNavigationMod(fengari)

  runFile(`
    -- 设置一块阻挡水域：x in [16, 24], z in [-10, 10]
    SAMPLES = {}
    GLOBAL.TheWorld.Map = {
        IsPassableAtPoint = function(self, x, y, z)
            table.insert(SAMPLES, { x = x, z = z })
            if x >= 16 and x <= 24 and z >= -10 and z <= 10 then
                return false
            end
            return true
        end
    }

    -- 1. 直线全为陆地 (z = 20)
    SAMPLES = {}
    local clear = Whale.util.line_passable(0, 20, 40, 20)
    assert(clear == true, "无水障碍直线应通过")
    -- 40 单位跨度，每 8 单位采样一次 (i=1..steps)，至少采样 4 次
    assert(#SAMPLES >= 4, "每 2 格 (8单位) 必须采样一次，实际采样点数：" .. tostring(#SAMPLES))

    -- 2. 直线穿过水域 (z = 0, 从 0 到 40 穿过 x=16..24)
    local blocked = Whale.util.line_passable(0, 0, 40, 0)
    assert(blocked == false, "途经水域的连线应返回 false")

    -- 3. 起点或终点在水中
    local bad_start = Whale.util.line_passable(20, 0, 40, 20)
    assert(bad_start == false, "起点在水中应返回 false")
    local bad_end = Whale.util.line_passable(0, 20, 20, 0)
    assert(bad_end == false, "终点在水中应返回 false")

    -- 4. 支持表对象传参
    local obj_clear = Whale.util.line_passable({ x = 0, z = 20 }, { x = 40, z = 20 })
    assert(obj_clear == true, "支持 {x, z} 表参数")
    local obj_blocked = Whale.util.line_passable({ x = 0, z = 0 }, { x = 40, z = 0 })
    assert(obj_blocked == false, "支持 {x, z} 表参数探水阻挡")
  `)
})

test('NAV-3: find_coastline_detour 左右45°/90°切线拐点试探', async () => {
  const fengari = await import('fengari')
  const { runFile } = loadNavigationMod(fengari)

  runFile(`
    -- 模拟地形：
    -- 玩家在 (0, 0)，终点在 (40, 0)
    -- 水域横在 x in [8, 32], z in [-50, 10] (海湾切入，导致向负方向-45°/-90°都是海)
    -- 但正方向 z > 10 为陆地
    GLOBAL.TheWorld.Map = {
        IsPassableAtPoint = function(self, x, y, z)
            -- 水湾区域
            if x >= 8 and x <= 32 and z <= 10 then
                return false
            end
            -- 其余为陆地
            return true
        end
    }

    -- 确认直接连线被阻挡
    assert(Whale.util.line_passable(0, 0, 40, 0) == false, "直连目标必须有水")

    -- 调用切线拐点探测
    local detour = Whale.util.find_coastline_detour(0, 0, 40, 0)
    assert(detour ~= nil, "必须找到绕行拐点")

    -- 验证拐点合法性
    assert(detour.wz > 10, "必须选择陆地侧拐点 (z > 10)，实际 wz=" .. tostring(detour.wz))
    assert(Whale.util.is_passable(detour.wx, detour.wz) == true, "拐点必须在可行走陆地上")
    assert(Whale.util.line_passable(0, 0, detour.wx, detour.wz) == true, "玩家到拐点的连线必须无水")
    assert(detour.tx ~= nil and detour.tz ~= nil, "必须包含对应格子坐标")
  `)
})

test('NAV-4: move_to 遇到前方海域自动切入 walk_waypoint 并在到达拐点后直奔终点', async () => {
  const fengari = await import('fengari')
  const { runFile } = loadNavigationMod(fengari)

  runFile(`
    local p = makeplayer(0, 0)
    GLOBAL.AllPlayers = { p }

    -- 水域阻挡正前方 x in [10, 30], z in [-10, 10]
    -- 正上方 z > 10 是陆地
    GLOBAL.TheWorld.Map = {
        IsPassableAtPoint = function(self, x, y, z)
            if x >= 10 and x <= 30 and z >= -10 and z <= 10 then
                return false
            end
            return true
        end
    }

    -- 目标在 (10, 0) 格子，对应世界坐标 (42, 2)
    local job = {
        args = { x = 10, z = 0 },
        step = "start",
        data = {},
        t0 = 1000,
    }

    -- 第 1 次 Tick：起手探水发现前方有水，应找到拐点并切换为 walk_waypoint
    local status, msg = Whale.actions.JOBS.move_to(job, p)
    assert(status == "run", "动作应继续运行")
    assert(job.step == "walk_waypoint", "发现水阻挡应切换至 walk_waypoint，实际 step=" .. tostring(job.step))
    assert(job.data.waypoint ~= nil, "必须记录绕行拐点数据")

    -- 模拟玩家向拐点移动并到达拐点
    p.Transform.GetWorldPosition = function()
        return job.data.waypoint.wx, 0, job.data.waypoint.wz
    end

    -- 第 2 次 Tick：到达拐点，此时拐点到目标 (42, 2) 连线无水，应切回 walk 直奔目标
    status, msg = Whale.actions.JOBS.move_to(job, p)
    assert(status == "run", "动作应继续运行")
    assert(job.step == "walk", "到达拐点且连线畅通后应切回 walk 直奔终点，实际 step=" .. tostring(job.step))
    assert(job.data.waypoint == nil, "拐点数据应重置")
  `)
})

test('NAV-5: move_to 目标在海里立即快速失败', async () => {
  const fengari = await import('fengari')
  const { runFile } = loadNavigationMod(fengari)

  runFile(`
    local p = makeplayer(0, 0)
    GLOBAL.AllPlayers = { p }

    -- (10, 10) 格子是海洋
    GLOBAL.TheWorld.Map = {
        IsPassableAtPoint = function(self, x, y, z)
            if x >= 36 and x <= 44 and z >= 36 and z <= 44 then
                return false
            end
            return true
        end
    }

    local job = {
        args = { x = 10, z = 10 },
        step = "start",
        data = {},
        t0 = 1000,
    }

    local status, msg = Whale.actions.JOBS.move_to(job, p)
    assert(status == "fail", "目标在水里必须立即判失败")
    assert(string.find(msg, "海里") or string.find(msg, "水里") or string.find(msg, "不可达"),
        "必须给出明确的不可达/海里原因，实际 msg=" .. tostring(msg))
  `)
})

test('NAV-6: move_to 行走途中卡在水边自动触发切线拐点脱困', async () => {
  const fengari = await import('fengari')
  const { runFile } = loadNavigationMod(fengari)

  runFile(`
    local p = makeplayer(0, 0)
    GLOBAL.AllPlayers = { p }

    -- 模拟水域阻挡
    GLOBAL.TheWorld.Map = {
        IsPassableAtPoint = function(self, x, y, z)
            if x >= 10 and x <= 30 and z >= -10 and z <= 10 then
                return false
            end
            return true
        end
    }

    -- 假设起始由于某些原因直接处于 walk (例如无水起手或旧状态)
    local job = {
        args = { x = 10, z = 0 },
        step = "walk",
        data = {
            lastcheck = 990, -- 触发 2 秒检查
            retry = 0,
            last_px = 5,
            last_pz = 0,
        },
        t0 = 990,
    }

    -- 角色停在 (5, 0)，距离上一次几乎未移动 (moved < 0.15)
    p.Transform.GetWorldPosition = function() return 5.05, 0, 0 end

    local status, msg = Whale.actions.JOBS.move_to(job, p)
    assert(status == "run", "脱困试探应继续运行")
    assert(job.step == "walk_waypoint", "卡在水边应自动探测拐点切换为 walk_waypoint，实际 step=" .. tostring(job.step))
    assert(job.data.waypoint ~= nil, "必须生成脱困拐点")
  `)
})
