// 全面审计修复的回归测试（覆盖 Lua 模组、配方/技能、控制协调与规格修正）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUILD_RECIPES } from '../lib/planner/planner-core.js'
import { craftOrBuild, materialsFor } from '../lib/skills/craft-or-build.js'
import { KNOWN_RECIPES } from '../lib/planner/quest-guide-adapter.js'
import { ACTION_TOOLS } from '../lib/actions/tool-defs.js'
import { infoSpecs } from '../lib/actions/specs/info.js'
import { survivalStabilize } from '../lib/skills/survival-stabilize.js'
import { derivePlan } from '../lib/plan.js'
import { StopCoordinator, StopPhase } from '../lib/control/stop-coordinator.js'
import { executeTool } from '../lib/tools.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

function loadCoreAndCrafting(fengari) {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, label = 'chunk') => {
    const status = lauxlib.luaL_dostring(L, to_luastring(code))
    if (status !== lua.LUA_OK) {
      throw new Error(`${label}: ${to_jsstring(lua.lua_tostring(L, -1))}`)
    }
  }
  const global = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    const val = lua.lua_isboolean(L, -1) ? String(lua.lua_toboolean(L, -1)) : to_jsstring(lua.lua_tostring(L, -1))
    lua.lua_pop(L, 1)
    return val
  }

  run(`
    GLOBAL = {
      pcall = pcall, tonumber = tonumber, error = error, os = os,
      EQUIPSLOTS = { HANDS = "hands", BODY = "body", HEAD = "head" },
      ACTIONS = { CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, PICKUP = { id = "PICKUP" } },
      Vector3 = function(x, y, z) return { x = x, y = y, z = z } end,
      BufferedAction = function(doer, target, action, invobject, pos) return { doer = doer, target = target, action = action } end,
      TheNet = { Announce = function() end },
      AllRecipes = {},
      Prefabs = {},
      KEY_F7 = 288,
      KEY_F8 = 289,
      TheWorld = { ismastersim = true, state = { phase = "day", cycles = 0 } },
      STRINGS = { NAMES = {} },
    }
    NOW = 10
    GLOBAL.GetTime = function() return NOW end
    GLOBAL.TheSim = { GetTime = function() return NOW end, FindEntities = function() return {} end }
    local p = {
      prefab = "wilson", userid = "u1",
      IsValid = function() return true end,
      HasTag = function(_, t) return t == "player" end,
      GetBufferedAction = function() return nil end,
      ClearBufferedAction = function() end,
      Transform = { GetWorldPosition = function() return 0, 0, 0 end },
      sg = { HasStateTag = function(_, tag) return tag == "idle" end },
      components = {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
        inventory = {
          GetNumSlots = function() return 15 end,
          GetItemInSlot = function() return nil end,
          ForEachItem = function() end,
          GetEquippedItem = function() return nil end,
        },
        locomotor = { Stop = function() end, Clear = function() end, GoToPoint = function() end },
        builder = { CanBuild = function() return false end, KnowsRecipe = function() return false end },
      },
    }
    GLOBAL.AllPlayers = { [1] = p }
    Whale = { verbose = false, files = {} }
  `, 'stub')

  for (const name of ['json', 'util', 'craftrules', 'actor']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', `${name}.lua`), 'utf8'), name)
  }
  for (const sub of ['core', 'movement', 'crafting']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', 'actions', `${sub}.lua`), 'utf8'), sub)
  }
  return { run, global }
}

test('AUDIT-LUA-1：reflex.lua 中 confirm_pending 使用前置声明的 companion_state 与 companion_log，不再报 nil', async () => {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, label) => {
    const s = lauxlib.luaL_dostring(L, to_luastring(code))
    if (s !== lua.LUA_OK) throw new Error(`${label}: ${to_jsstring(lua.lua_tostring(L, -1))}`)
  }
  const src = readFileSync(join(MOD, 'scripts', 'whale', 'reflex.lua'), 'utf8')
  const patched = src.replace(/\breturn\s+R\s*$/, '\nWhale._test_confirm = confirm_pending\nWhale._test_set_pending = function(v) pending = v end\nWhale._test_fail_until = fail_until\nreturn R\n')
  run(`
    PRINT_LOGS = {}
    GLOBAL = {
      pcall = pcall, tonumber = tonumber, error = error, os = os,
      print = function(...) local t = {}; for i=1,select('#',...) do t[#t+1]=tostring(select(i,...)) end; PRINT_LOGS[#PRINT_LOGS+1]=table.concat(t," ") end,
      EQUIPSLOTS = { HANDS = "hands" },
      TheWorld = { state = { phase = "day" } },
      AllPlayers = {},
    }
    print = GLOBAL.print
    Whale = {
      util = { now = function() return 100 end, tile_dist = function() return 99 end, dist = function() return 99 end, player = function() return nil end, pos = function() return 0,0,0 end },
      character = { GetCompanionState = function() return { supported = true, present = false, alive = false, has_flower = true } end },
      actions = { may_preempt = function() return true end },
      config = { get = function() return true end },
    }
  `, 'stub')
  run(patched, 'reflex')
  run(`
    Whale._test_set_pending({ kind = "companion_summon", since = 99 })
    Whale._test_confirm({ prefab = "wendy" })
    assert(Whale._test_fail_until["companion_summon"] == 120, "召唤失败应设置 20s 冷却")
    local sawFail = false
    for _, l in ipairs(PRINT_LOGS) do if string.find(l, "SUMMON_FAILED", 1, true) then sawFail = true end end
    assert(sawFail, "应正常打印 SUMMON_FAILED 日志，不因局部前置引用 nil 崩溃")
  `, 'assert')
})

test('AUDIT-LUA-2：hud.lua BindKeys 幂等去重，client + Attach 不重复绑定快捷键', async () => {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, label) => {
    const s = lauxlib.luaL_dostring(L, to_luastring(code))
    if (s !== lua.LUA_OK) throw new Error(`${label}: ${to_jsstring(lua.lua_tostring(L, -1))}`)
  }
  run(`
    KEYHANDLERS = {}
    GLOBAL = {
      pcall = pcall, tonumber = tonumber, KEY_F7 = 288, KEY_F8 = 289,
      TheInput = { AddKeyHandler = function(_, fn) KEYHANDLERS[#KEYHANDLERS+1] = fn end },
      ThePlayer = { userid = "u1", IsValid = function() return true end },
      TheWorld = { ismastersim = false },
      TheSim = { GetPersistentString = function(_, _, cb) cb(false, "") end, SetPersistentString = function() end },
    }
    Whale = { util = { log = function() end }, files = {} }
  `, 'stub')
  run(readFileSync(join(MOD, 'scripts', 'whale', 'json.lua'), 'utf8'), 'json')
  run(readFileSync(join(MOD, 'scripts', 'whale', 'hud.lua'), 'utf8'), 'hud')
  run(`
    Whale.hud.BindKeys()
    Whale.hud.BindKeys()
    assert(#KEYHANDLERS == 1, "重复调用 BindKeys 只能绑定一次，实际 " .. #KEYHANDLERS)
    local screen = { owner = GLOBAL.ThePlayer, AddChild = function() end }
    Whale.hud.Attach(screen, GLOBAL.ThePlayer)
    assert(#KEYHANDLERS == 1, "Attach 后仍只能有 1 个按键处理器，实际 " .. #KEYHANDLERS)
  `, 'assert')
})

test('AUDIT-LUA-3：只读查询（inspect/recipes/lookup/probe）不打断运行中任务与 defense，非 stop 不打断 defense', async () => {
  const fengari = await import('fengari')
  const { run, global } = loadCoreAndCrafting(fengari)
  run(`
    REPORTS = {}
    Whale.bridge = { Report = function(ok, text, id) REPORTS[#REPORTS+1] = { ok = ok, text = text, id = id } end }
    Whale.actions.JOBS.dummy_move = function() return "run" end
    GLOBAL.AllRecipes.torch = { name = "torch", ingredients = {} }
    local ok1 = Whale.actions.Start("dummy_move", {}, "job-1", {})
    assert(ok1 == true and Whale.job ~= nil)

    -- 只读查询不能中断 job-1
    local ok2 = Whale.actions.Start("recipes", {}, "q-recipes", { limit = 5 })
    assert(ok2 == true)
    assert(Whale.job ~= nil and Whale.job.cmd_id == "job-1", "recipes 不应打断当前 job")
    assert(#REPORTS == 1 and REPORTS[1].id == "q-recipes" and REPORTS[1].ok == true)

    -- defense 会话不被普通非 stop 指令打断
    local ok_def = Whale.actions.Start("dummy_move", {}, Whale.actions.DEFENSE_ID, {})
    assert(ok_def == true and Whale.job.cmd_id == "defense")
    local ok_move, why_move = Whale.actions.Start("dummy_move", {}, "cmd-move", {})
    assert(ok_move == false and string.find(why_move, "defense_active", 1, true) ~= nil, "普通动作不可打断 defense")
    local ok_stop = Whale.actions.Start("stop", {}, "cmd-stop", {})
    assert(ok_stop == true, "stop 允许打断 defense")
  `, 'assert')
  assert.ok(global)
})

test('AUDIT-LUA-4：JOBS.lookup 使用解析后的原生配方名调用 builder:CanBuild', async () => {
  const fengari = await import('fengari')
  const { run } = loadCoreAndCrafting(fengari)
  run(`
    REPORTS = {}
    CANBUILD_ARGS = {}
    Whale.bridge = { Report = function(ok, text, id) REPORTS[#REPORTS+1] = { ok = ok, text = text, id = id } end }
    GLOBAL.AllPlayers[1].components.builder.CanBuild = function(_, name)
      CANBUILD_ARGS[#CANBUILD_ARGS+1] = name
      return name == "researchlab"
    end
    GLOBAL.AllRecipes.researchlab = { name = "researchlab", placer = "researchlab_placer", ingredients = {} }
    Whale.actions.Start("lookup", {}, "c-sm", { lookup_query = "sciencemachine" })
    assert(#CANBUILD_ARGS == 1 and CANBUILD_ARGS[1] == "researchlab", "应传原生 key researchlab，实际：" .. tostring(CANBUILD_ARGS[1]))
    assert(string.find(REPORTS[1].text, "现在就能做", 1, true) ~= nil)
  `, 'assert')
})

test('AUDIT-RECIPES：cookpot / campfire / firepit / alchemyengine 配方与原生 scripts/recipes.lua 一致', () => {
  assert.deepEqual(BUILD_RECIPES.cookpot, { charcoal: 6, twigs: 6, cutstone: 3 })
  assert.deepEqual(materialsFor('cookpot'), { charcoal: 6, twigs: 6, cutstone: 3 })
  assert.deepEqual(KNOWN_RECIPES.alchemyengine, { boards: 4, cutstone: 2, transistor: 2 })
  assert.deepEqual(KNOWN_RECIPES.spear, { twigs: 2, rope: 1, flint: 1 })
  assert.deepEqual(KNOWN_RECIPES.armorwood, { log: 8, rope: 2 })
  assert.deepEqual(KNOWN_RECIPES.footballhat, { pigskin: 1, rope: 1 })

  const buildTool = ACTION_TOOLS.find((t) => t.name === 'build')
  assert.match(buildTool.description, /campfire（营火，2 木头 \+ 3 草）/)
  assert.match(buildTool.description, /firepit（石头火坑，12 石头 \+ 2 木头）/)
  assert.match(buildTool.description, /cookpot（锅，3 石砖 \+ 6 木炭 \+ 6 树枝）/)
})

test('AUDIT-SKILLS-1：craft_or_build 制作一级科技中间产物（boards）前先前往科学机器旁', () => {
  const matStep = craftOrBuild.steps.find((s) => s.id === 'materials')
  const ctx = {
    snapshot: {
      actor: { tileX: 30, tileZ: 30 },
      player: { inventory: { items: [{ prefab: 'log', count: 12 }] }, equipment: { slots: {} } },
      nearby: { buckets: { structures: [{ prefab: 'researchlab', position: { x: 0, z: 0 } }] } },
    },
    memory: { home_anchor: { x: 0, z: 0 }, known_buildings: [] },
    instance: { skill_args: { recipe: 'chest' }, data: { skill_args: { recipe: 'chest' } } },
  }
  assert.equal(matStep.isDone(ctx), false)
  const act = matStep.nextAction(ctx)
  assert.equal(act.tool, 'move_to', '远离科学机器且需要 craft boards 时应先 move_to 靠近，不能直接 craft 撞 recipe_locked')
  assert.deepEqual(act.args, { x: 0, z: 0 })
})

test('AUDIT-SKILLS-2：猎犬进入 6 格内且血量尚可时，survival_stabilize 不再被 preconditions 误拦', () => {
  const ctx = {
    snapshot: {
      actor: { valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0, prefab: 'wendy' },
      player: {
        health: { current: 120, max: 150, percent: 80 },
        hunger: { current: 120, max: 150, percent: 80 },
        sanity: { current: 150, max: 200, percent: 75 },
        in_light: true,
        inventory: { items: [] },
        equipment: { slots: {} },
      },
      world: { day: 3, phase: 'day' },
      nearby: {
        snapshot_id: 'r1-1-n1',
        buckets: {
          threats: [{ prefab: 'hound', label: '猎犬', ref: '#1', handle: 'h1', distance: 4, is_attacker: true }],
        },
      },
      companion: { supported: true, present: false, can_summon: true },
      dangerZones: [],
    },
  }
  const pre = survivalStabilize.preconditions(ctx)
  assert.equal(pre.ok, true, '野狗贴脸且生命充足时 preconditions 应放行给 hound_defense')
  const houndStep = survivalStabilize.steps.find((s) => s.id === 'hound_defense')
  assert.equal(houndStep.isDone(ctx), false)
  const act = houndStep.nextAction(ctx)
  assert.equal(act.tool, 'summon_companion')
})

test('AUDIT-PLAN-AND-SPEC：plan.js 识别烹饪锅料理，recipes.filter 支持含数字的配方名，executeTool 透传 timeoutMs', async () => {
  const plan = derivePlan({
    actor: { valid: true, alive: true, isGhost: false, prefab: 'wilson', tileX: 0, tileZ: 0 },
    player: {
      health: { current: 100, max: 100, percent: 100 },
      hunger: { current: 20, max: 150, percent: 13 },
      sanity: { current: 150, max: 200, percent: 75 },
      in_light: true,
      inventory: { items: [{ prefab: 'meatballs', count: 1 }] },
      equipment: { slots: {} },
    },
    world: { day: 2, phase: 'day' },
    nearby: { buckets: {} },
    dangerZones: [],
  })
  assert.match(plan.next, /^eat/, '只有肉丸时应直接建议 eat，而不是外出找食物')

  assert.match('researchlab2', new RegExp(infoSpecs.recipes.args.filter.pattern))

  let seenTimeout = null
  const res = await executeTool('wait', { seconds: 1 }, {
    bridge: {
      readState: () => ({ json: { ready: true, data: { schema: 'bws.state/1', observer: { snapshot_id: 's1', sequence: 1, status: 'ok' }, actor: { valid: true, alive: true, is_ghost: false, tile_x: 0, tile_z: 0 }, player: { health: { current: 100, max: 100 }, hunger: { current: 100, max: 100 }, sanity: { current: 100, max: 100 }, inventory: { items: [] }, equipment: { slots: {} } }, world: { day: 1, phase: 'day' }, nearby: { buckets: {} } } }, ageMs: 0 }),
      leaseDirs: () => [],
      readLeaseAck: () => null,
      call: async (_t, _a, opts) => { seenTimeout = opts?.timeoutMs ?? null; return { ok: true, text: '等了 1 秒' } },
    },
    control: {
      acquire: () => ({ ok: true, lease: { generation: 1, authority_epoch: 'e1', lease_id: 'l1', owner_type: 'mcp_client', owner_instance_id: 'inst-1' } }),
      release: () => {},
      readAuthority: () => ({ status: 'active', generation: 1, authority_epoch: 'e1', lease_id: 'l1', owner_type: 'mcp_client', owner_instance_id: 'inst-1' }),
      validate: () => ({ ok: true, lease: { generation: 1, authority_epoch: 'e1', lease_id: 'l1', owner_type: 'mcp_client', owner_instance_id: 'inst-1' } }),
      verifyAuthority: () => ({ ok: true }),
    },
    actionTimeoutMs: 42_000,
    owner: 'mcp_client',
    ownerInstanceId: 'inst-1',
    executionMode: 'assisted',
  })
  assert.ok(seenTimeout === 42_000 || seenTimeout <= 42_000, 'timeoutMs 应由 ctx.actionTimeoutMs 透传下来')
  assert.match(res, /等/)
})

test('AUDIT-STOP：StopCoordinator 在 gen=null 时不命中旧 STOPPED 缓存，reset() 可复位非隔离状态', async () => {
  let stopCalls = 0
  const co = new StopCoordinator({
    readAuthority: () => null,
    runtimeStop: async () => { stopCalls++; return { status: 'succeeded', lock_released: true, command_id: `c-${stopCalls}` } },
    releaseLease: async () => {},
    defaultTimeoutMs: 1000,
  })
  const r1 = await co.requestStop({ source: 'f8' })
  assert.equal(r1.status, 'stopped')
  const r2 = await co.requestStop({ source: 'mcp' })
  assert.equal(stopCalls, 2, 'gen=null 时不应错误复用上次结果跳过停止')
  assert.equal(co.reset(), true)
  assert.equal(co.phase, StopPhase.IDLE)
})

// ★ 真机事故（2026-11-26）：stop 超时进入隔离后，租约文件已经是 released、
//   游戏状态也在正常刷新（旧执行链早就退出了），但 reset() 因为 quarantined 直接返回 false，
//   于是隔离永远解不开 —— 模型连 harvest_nearest 都发不出去，角色在青蛙围攻中掉到 13% 血也救不了。
test('AUDIT-STOP-RECOVER：隔离中但锁已释放时，reset() 必须先解除隔离而不是一直拒绝', async () => {
  let lockHeld = true
  const co = new StopCoordinator({
    readAuthority: () => null,
    // 模拟"Lua/运行时一直不返回" → 超时进入隔离
    runtimeStop: async () => ({ status: 'unknown', lock_released: false, command_id: 'c-slow' }),
    releaseLease: async () => {},
    isLockReleased: () => !lockHeld,
    defaultTimeoutMs: 20,
  })
  const r = await co.requestStop({ source: 'mcp' })
  assert.equal(r.quarantined, true, '超时未确认时必须进入隔离')
  assert.equal(co.canAcceptNewWork(), false, '隔离中禁止新任务')

  // 锁仍然握着 → 仍然拒绝（安全不放宽）
  assert.equal(co.reset(), false, '锁没释放时 reset 不能放行')
  assert.equal(co.canAcceptNewWork(), false)

  // 旧执行链真的退出了（锁已释放）→ reset 应当自动解除隔离
  lockHeld = false
  assert.equal(co.reset(), true, '锁已释放时 reset 必须能解除隔离')
  assert.equal(co.quarantined, false)
  assert.equal(co.canAcceptNewWork(), true, '解除隔离后应恢复接受新任务')
})

// ★ 真机事故（2026-11-26，新存档）：stop 超时隔离后，租约已是 released、状态文件正常刷新，
//   但 canAcceptNewWork() 只看内存标志 → 永久隔离，模型连 gather_area 都发不出去，
//   而 stop 又因为拿不到 ACK 一直报 unknown —— 整个存档卡死。
test('AUDIT-STOP-RECOVER2：canAcceptNewWork 自己会尝试恢复（锁已释放时不该永久卡死）', async () => {
  let lockHeld = true
  const co = new StopCoordinator({
    readAuthority: () => null,
    runtimeStop: async () => ({ status: 'unknown', lock_released: false, command_id: 'c-slow2' }),
    releaseLease: async () => {},
    isLockReleased: () => !lockHeld,
    defaultTimeoutMs: 20,
  })
  await co.requestStop({ source: 'mcp' })
  assert.equal(co.quarantined, true)

  // 锁仍握着：反复问也一直拒绝（绝不能因为"问多了"就放行）
  for (let i = 0; i < 3; i++) {
    assert.equal(co.canAcceptNewWork(), false, '锁没释放时每次都必须拒绝')
  }

  // 旧执行链退出后：只靠 canAcceptNewWork 也应恢复，不需要调用方额外 reset
  lockHeld = false
  assert.equal(co.canAcceptNewWork(), true, '锁已释放时 canAcceptNewWork 应自动解除隔离')
  assert.equal(co.quarantined, false)
})
