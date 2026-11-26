// 跨文件数据一致性（Single Source of Truth）+ 烹饪锅 4 格原子性 + UI 停用项隐藏 + SkillExecutor->Dispatcher target_handle E2E 测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ALL_KNOWN_RECIPES,
  AUTO_SAFE_FOODS,
  AUTO_SAFE_FOOD_SET,
  BUILD_RECIPES,
  CORE_RECIPE,
  CRAFT_RECIPES,
  CRAFTED_DEPS,
  EDIBLE_HUNGER_FOOD_SET,
  FOOD_EFFECTS,
  HEALING_FOOD_SET,
} from '../lib/game-data/recipes-and-foods.js'
import { RECIPE_WHITELIST } from '../lib/actions/specs/crafting.js'
import { AUTO_SAFE_FOODS as TARGET_KIND_FOODS } from '../lib/actions/target-kinds.js'
import { ACTION_TOOLS } from '../lib/actions/tool-defs.js'
import { BUILD_RECIPES as PLANNER_BUILD_RECIPES, CORE_RECIPE as PLANNER_CORE_RECIPE } from '../lib/planner/planner-core.js'
import { KNOWN_RECIPES, KNOWN_STRUCTURE_RECIPES } from '../lib/planner/quest-guide-adapter.js'
import { CORE_RECIPE as HOME_CORE_RECIPE } from '../lib/skills/establish-home.js'
import { CORE_RECIPE as ADAPTER_CORE_RECIPE } from '../lib/skills/establish-home-adapter.js'
import { materialsFor } from '../lib/skills/craft-or-build.js'
import { CRAFTED_DEPS as UTIL_CRAFTED_DEPS, EDIBLE as UTIL_EDIBLE } from '../lib/skills/skill-utils.js'
import { FOOD_EFFECTS as SELECTOR_FOOD_EFFECTS } from '../lib/skills/food-candidate-selector.js'
import { planInternals } from '../lib/plan.js'
import { buildFields, buildClient } from '../tools/build-client.mjs'
import { createDispatcher } from '../lib/dispatcher.js'
import { SkillExecutor } from '../lib/skills/skill-executor.js'
import { currentConfig, shouldPauseOnThinking } from '../lib/index.js'
import '../lib/skills/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

function parseLuaAutoSafe(text) {
  const block = text.match(/E\.AUTO_SAFE\s*=\s*\{([\s\S]*?)\n\}/)
  assert.ok(block, '解析不到 eatrules.lua 的 E.AUTO_SAFE')
  return [...block[1].matchAll(/^\s*([a-z0-9_]+)\s*=\s*true\s*,/gm)].map((m) => m[1])
}

test('GD-1：食物白名单在 Lua eatrules.lua 与 Node 唯一数据源及各消费模块间完全一致', () => {
  const eatrules = readFileSync(join(MOD, 'scripts', 'whale', 'eatrules.lua'), 'utf8')
  const luaSafe = parseLuaAutoSafe(eatrules)

  assert.deepEqual([...AUTO_SAFE_FOODS].sort(), luaSafe.sort(), 'AUTO_SAFE_FOODS 必须与 eatrules.lua E.AUTO_SAFE 逐条一致')
  assert.deepEqual(TARGET_KIND_FOODS, [...AUTO_SAFE_FOODS])
  assert.deepEqual([...UTIL_EDIBLE].sort(), [...AUTO_SAFE_FOOD_SET].sort())
  assert.equal(SELECTOR_FOOD_EFFECTS, FOOD_EFFECTS)

  for (const prefab of AUTO_SAFE_FOODS) {
    assert.ok(FOOD_EFFECTS[prefab], `FOOD_EFFECTS 缺少安全食物 ${prefab} 的效果定义`)
  }
  // petals / 烤蓝绿蘑菇不回饥饿（且蓝/绿烤蘑菇微扣血），绝不误入饥饿/回血集合
  assert.equal(EDIBLE_HUNGER_FOOD_SET.has('petals'), false)
  assert.equal(EDIBLE_HUNGER_FOOD_SET.has('blue_cap_cooked'), false)
  assert.equal(HEALING_FOOD_SET.has('blue_cap_cooked'), false)
  assert.equal(HEALING_FOOD_SET.has('green_cap_cooked'), false)
  assert.equal(HEALING_FOOD_SET.has('meatballs'), true)
  assert.equal(HEALING_FOOD_SET.has('perogies'), true)
})

test('GD-2：Node 侧全部配方表均引用唯一数据源 recipes-and-foods.js，不存在分叉副本', () => {
  assert.equal(RECIPE_WHITELIST, CRAFT_RECIPES)
  assert.equal(PLANNER_BUILD_RECIPES, BUILD_RECIPES)
  assert.equal(PLANNER_CORE_RECIPE, CORE_RECIPE)
  assert.equal(HOME_CORE_RECIPE, CORE_RECIPE)
  assert.equal(ADAPTER_CORE_RECIPE, CORE_RECIPE)
  assert.equal(UTIL_CRAFTED_DEPS, CRAFTED_DEPS)
  assert.equal(KNOWN_RECIPES, ALL_KNOWN_RECIPES)
  assert.equal(KNOWN_STRUCTURE_RECIPES.firepit, BUILD_RECIPES.firepit)
  assert.equal(KNOWN_STRUCTURE_RECIPES.sciencemachine, BUILD_RECIPES.sciencemachine)

  for (const [name, rec] of Object.entries(BUILD_RECIPES)) {
    assert.deepEqual(materialsFor(name), rec, `craft-or-build 的 ${name} 配方应与 BUILD_RECIPES 一致`)
  }
  assert.equal(planInternals.FIREPIT_RECIPE, BUILD_RECIPES.firepit)
  assert.equal(planInternals.SCIENCE_MACHINE_RECIPE, CORE_RECIPE)
  assert.equal(planInternals.TORCH_RECIPE, CRAFT_RECIPES.torch.ingredients)

  const buildTool = ACTION_TOOLS.find((t) => t.name === 'build')
  assert.match(buildTool.description, /campfire（营火，2 木头 \+ 3 草）/)
  assert.match(buildTool.description, /firepit（石头火坑，12 石头 \+ 2 木头）/)
  assert.match(buildTool.description, /cookpot（锅，3 石砖 \+ 6 木炭 \+ 6 树枝）/)
  assert.match(buildTool.description, /4 log \+ 4 rocks \+ 1 goldnugget/)
  assert.match(buildTool.description, /4 boards \+ 2 cutstone \+ 2 transistor/)
  assert.match(buildTool.description, /6 silk \+ 4 twigs \+ 3 rope/)

  const craftTool = ACTION_TOOLS.find((t) => t.name === 'craft')
  for (const [name, def] of Object.entries(CRAFT_RECIPES)) {
    const line = craftTool.description.split('\n').find((l) => l.includes(`· ${name}`))
    assert.ok(line, `craft 描述缺少 ${name}`)
    for (const [ing, n] of Object.entries(def.ingredients)) {
      assert.ok(line.includes(`${n} ${ing}`), `craft 描述里 ${name} 缺少 "${n} ${ing}"`)
    }
  }
})

test('COOK-ATOMIC-1：cooking pot（cook）不足 4 样食材时不拆包不放锅，返回 need_4_ingredients', async () => {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, label = 'chunk') => {
    const s = lauxlib.luaL_dostring(L, to_luastring(code))
    if (s !== lua.LUA_OK) throw new Error(`${label}: ${to_jsstring(lua.lua_tostring(L, -1))}`)
  }

  run(`
    GLOBAL = {
      pcall = pcall, tonumber = tonumber, error = error, os = os,
      EQUIPSLOTS = { HANDS = "hands", BODY = "body", HEAD = "head" },
      ACTIONS = { COOK = { id = "COOK" } },
      Vector3 = function(x, y, z) return { x = x, y = y, z = z } end,
      BufferedAction = function(doer, target, action) return { doer = doer, target = target, action = action } end,
      TheNet = { Announce = function() end },
      AllRecipes = {}, Prefabs = {}, TheWorld = { ismastersim = true, state = { phase = "day" } },
      STRINGS = { NAMES = { BERRIES = "浆果", MEAT = "肉", COOKPOT = "烹饪锅" } },
      GetTime = function() return 10 end,
      TheSim = { GetTime = function() return 10 end, FindEntities = function() return {} end },
    }
    local function mkStack(prefab, count, tags)
      local item = {
        prefab = prefab,
        _count = count,
        _owner = "player",
        IsValid = function() return true end,
        HasTag = function(_, t) return tags[t] == true end,
      }
      item.components = {
        cookable = {},
        inventoryitem = { RemoveFromOwner = function() item._owner = nil end },
        stackable = {
          StackSize = function() return item._count end,
          Get = function(_, n)
            item._count = item._count - n
            return mkStack(prefab, n, tags)
          end,
        },
      }
      return item
    end
    _mkStack = mkStack
    INV_ITEMS = { mkStack("berries", 2, { veggie = true }) }
    POT_SLOTS = {}
    START_COOKING_CALLED = 0
    local p = {
      prefab = "wilson", userid = "u1",
      IsValid = function() return true end, HasTag = function(_, t) return t == "player" end,
      GetBufferedAction = function() return nil end, ClearBufferedAction = function() end,
      Transform = { GetWorldPosition = function() return 0, 0, 0 end },
      GetPosition = function() return GLOBAL.Vector3(0, 0, 0) end,
      sg = { HasStateTag = function() return true end },
      components = {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
        inventory = {
          GetNumSlots = function() return 15 end,
          GetItemInSlot = function(_, i) return INV_ITEMS[i] end,
          ForEachItem = function(_, fn) for _, it in ipairs(INV_ITEMS) do fn(it) end end,
          GetEquippedItem = function() return nil end,
          GiveItem = function(_, it) INV_ITEMS[#INV_ITEMS+1] = it; return true end,
        },
        locomotor = { Stop = function() end, Clear = function() end },
      },
    }
    POT = {
      prefab = "cookpot",
      IsValid = function() return true end,
      GetPosition = function() return GLOBAL.Vector3(0, 0, 0) end,
      components = {
        container = {
          GetNumSlots = function() return 4 end,
          NumItems = function() return #POT_SLOTS end,
          IsFull = function() return #POT_SLOTS >= 4 end,
          GiveItem = function(_, it) POT_SLOTS[#POT_SLOTS+1] = it; return true end,
          RemoveItem = function(_, it)
            for i, v in ipairs(POT_SLOTS) do if v == it then table.remove(POT_SLOTS, i); break end end
            return it
          end,
        },
        stewer = {
          IsDone = function() return false end,
          IsCooking = function() return START_COOKING_CALLED > 0 and #POT_SLOTS >= 4 end,
          CanCook = function() return #POT_SLOTS >= 4 end,
          StartCooking = function() if #POT_SLOTS >= 4 then START_COOKING_CALLED = START_COOKING_CALLED + 1 end end,
        },
      },
    }
    GLOBAL.AllPlayers = { [1] = p }
    Whale = { verbose = false, files = {} }
  `, 'stub')

  for (const name of ['json', 'util', 'craftrules', 'actor']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', `${name}.lua`), 'utf8'), name)
  }
  for (const sub of ['core', 'crafting']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', 'actions', `${sub}.lua`), 'utf8'), sub)
  }

  run(`
    REPORTS = {}
    Whale.bridge = { Report = function(ok, text, id) REPORTS[#REPORTS+1] = { ok = ok, text = text, id = id } end }
    -- ① 只有 2 个浆果 → 直接 fail，不得放入锅也不得拆包
    Whale.actions.Start("cook", {}, "c-less", { target = POT })
    Whale.actions.Tick()
    assert(REPORTS[1].ok == false, "不足 4 样不能报成功")
    assert(string.find(REPORTS[1].text, "need_4_ingredients", 1, true) ~= nil)
    assert(#POT_SLOTS == 0, "锅内应仍为空")
    assert(INV_ITEMS[1]._count == 2, "原堆叠不应被拆分或扣减")
    assert(START_COOKING_CALLED == 0)

    -- ② 再加 1 个浆果和 1 块肉（共 4 样）→ 自动拆堆叠凑满 4 格并开煮
    INV_ITEMS[1]._count = 3
    INV_ITEMS[2] = _mkStack("meat", 1, { meat = true })
    Whale.actions.Start("cook", {}, "c-full", { target = POT })
    Whale.actions.Tick()
    assert(#POT_SLOTS == 4, "锅内应精确放入 4 样食材，实际：" .. #POT_SLOTS)
    assert(START_COOKING_CALLED == 1, "放满 4 格后应成功触发 StartCooking")

    -- ③ one_unit 内 stackable:StackSize / Get 抛异常时由 pcall 兜底，不崩溃
    Whale.actions.Abort("reset")
    local badItem = _mkStack("berries", 1, { veggie = true })
    local stackCalls = 0
    badItem.components.stackable.StackSize = function()
      stackCalls = stackCalls + 1
      if stackCalls == 4 then error("boom_stack") end
      return 1
    end
    local badSplit = _mkStack("carrot", 2, { veggie = true })
    badSplit.components.stackable.Get = function() error("boom_get") end
    INV_ITEMS = { badItem, _mkStack("corn", 1, { veggie = true }), _mkStack("meat", 1, { meat = true }), badSplit }
    POT_SLOTS = {}
    START_COOKING_CALLED = 0
    local okStart, errStart = Whale.actions.Start("cook", {}, "c-pcall", { target = POT })
    assert(okStart == true, "Start 应成功：" .. tostring(errStart))
    Whale.actions.Tick()
    local lastRep = REPORTS[#REPORTS]
    assert(#POT_SLOTS == 4, "stackable 异常时应安全降级放满 4 格，实际：" .. #POT_SLOTS .. " report=" .. tostring(lastRep and lastRep.text))
  `, 'assert')
})

test('PAUSE-UI-ACTIVE：思考超 5 秒暂停默认开启且 UI 可配置', async () => {
  const defaults = currentConfig({})
  assert.equal(defaults.freezeTime, true)
  assert.equal(defaults.idleSeconds, 5)
  const fields = await buildFields()
  const freeze = fields.find((f) => f.key === 'freezeTime')
  const idle = fields.find((f) => f.key === 'idleSeconds')
  assert.ok(freeze && freeze.hidden !== true, 'freezeTime 应在设置卡片中可见')
  assert.ok(idle && idle.hidden !== true, 'idleSeconds 应在设置卡片中可见')
  assert.equal(idle.min, 1)
})

test('PAUSE-THINKING-NODE：思考超 5 秒才暂停，动作中/超看门狗/关闭开关时不暂停', () => {
  // 1) F8 思考未满 5 秒不暂停；满 5 秒暂停
  assert.equal(shouldPauseOnThinking({ freezeTime: true, idleSeconds: 5, f8Running: true, f8Thinking: true, f8ThinkingMs: 4999 }), false)
  assert.equal(shouldPauseOnThinking({ freezeTime: true, idleSeconds: 5, f8Running: true, f8Thinking: true, f8ThinkingMs: 5000 }), true)
  // 2) 有工具正在执行 / 待发命令时绝不暂停
  assert.equal(shouldPauseOnThinking({ freezeTime: true, idleSeconds: 5, inFlight: 1, f8Running: true, f8Thinking: true, f8ThinkingMs: 9000 }), false)
  assert.equal(shouldPauseOnThinking({ freezeTime: true, idleSeconds: 5, pendingCommands: 1, f8Running: true, f8Thinking: true, f8ThinkingMs: 9000 }), false)
  // 3) DSH 会话等待模型思考满 5 秒暂停；关闭或超过 180s 看门狗不卡死暂停
  const now = 1_000_000
  assert.equal(shouldPauseOnThinking({ freezeTime: true, idleSeconds: 5, dshThinkingSince: now - 4000, now }), false)
  assert.equal(shouldPauseOnThinking({ freezeTime: true, idleSeconds: 5, dshThinkingSince: now - 5500, now }), true)
  assert.equal(shouldPauseOnThinking({ freezeTime: true, idleSeconds: 5, dshThinkingSince: now - 185_000, now }), false)
  assert.equal(shouldPauseOnThinking({ freezeTime: false, idleSeconds: 5, f8Running: true, f8Thinking: true, f8ThinkingMs: 8000 }), false)
})

test('PAUSE-THINKING-LUA：真实 Lua bridge 服务端挂载静态任务防卡死，动作运行中拒绝暂停', async () => {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, label = 'chunk') => {
    const s = lauxlib.luaL_dostring(L, to_luastring(code))
    if (s !== lua.LUA_OK) throw new Error(`${label}: ${to_jsstring(lua.lua_tostring(L, -1))}`)
  }

  run(`
    PAUSED = nil
    STATIC_TASK = nil
    CUR_JOB = nil
    GLOBAL = {
      pcall = pcall, tonumber = tonumber, error = error, os = os, io = io,
      EQUIPSLOTS = { HANDS = "hands", BODY = "body", HEAD = "head" },
      ACTIONS = {}, Vector3 = function(x, y, z) return { x = x, y = y, z = z } end,
      TheNet = { SetAutopaused = function() end },
      SetServerPaused = function(v) PAUSED = v end,
      TheSim = {
        GetTime = function() return 10 end,
        SetPersistentString = function() end,
        GetPersistentString = function(_, _, cb) cb(false, nil) end,
      },
      TheWorld = {
        ismastersim = true,
        DoPeriodicTask = function() return {} end,
        DoStaticPeriodicTask = function(_, interval, fn) STATIC_TASK = { interval = interval, fn = fn }; return STATIC_TASK end,
      },
    }
    Whale = { verbose = false, files = {
      state = "whale_state.json", io_state = "whale_io_state.json",
      cmd = "whale_cmd.json", io_cmd = "whale_io_cmd.json",
      result = "whale_result.json", io_result = "whale_io_result.json",
      settings = "whale_settings.json", io_settings = "whale_io_settings.json",
      pause = "whale_pause.json", io_pause = "whale_io_pause.json",
      http = "whale_http.json", io_http = "whale_io_http.json",
    } }
  `, 'stub')

  for (const name of ['json', 'util']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', `${name}.lua`), 'utf8'), name)
  }
  run(`
    Whale.actor = { get_actor = function() return nil end }
    Whale.observe = { Build = function() return "st", {} end }
    Whale.actions = {
      Current = function() return CUR_JOB end,
      Tick = function() end,
      Start = function() return true end,
    }
  `, 'mocks')
  run(readFileSync(join(MOD, 'scripts', 'whale', 'bridge.lua'), 'utf8'), 'bridge')

  run(`
    Whale.bridge.boot()
    assert(STATIC_TASK ~= nil, "服务端启动必须挂载 DoStaticPeriodicTask 以便暂停时也能轮询解冻")
    assert(PAUSED == false)

    -- 1) 空闲思考时允许暂停
    Whale.bridge.SetPaused(true)
    assert(PAUSED == true and Whale.bridge.IsPausedByUs() == true, "应成功暂停")

    -- 2) 解冻恢复
    Whale.bridge.SetPaused(false)
    assert(PAUSED == false and Whale.bridge.IsPausedByUs() == false, "应成功解冻")

    -- 3) 正在执行动作时绝不允许暂停；若先前已暂停也会被静态轮询立刻解冻
    CUR_JOB = "chop"
    Whale.bridge.SetPaused(true)
    assert(PAUSED == false and Whale.bridge.IsPausedByUs() == false, "有动作在跑时必须拒绝暂停")
  `, 'assert')
})

test('E2E-HANDLE：SkillExecutor -> Dispatcher -> target_handle 在快照帧号推进后仍直接命中并核验成功', async () => {
  let seq = 10
  let sid = 'r1-10-n10'
  let potDone = true
  let meatballsCount = 0

  const makeSnap = () => ({
    schema: 'bws.state/1',
    ok: true,
    status: 'ok',
    sequence: seq,
    ageMs: 0,
    stale: false,
    identity: { worldKey: 'cluster:T/shard:1' },
    observer: { snapshot_id: sid, sequence: seq, status: 'ok' },
    actor: { valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0, prefab: 'wilson' },
    player: {
      health: { current: 100, max: 100, percent: 100 },
      hunger: { current: 120, max: 150, percent: 80 },
      sanity: { current: 150, max: 200, percent: 75 },
      in_light: true,
      inventory: { items: meatballsCount > 0 ? [{ prefab: 'meatballs', count: meatballsCount }] : [] },
      equipment: { slots: {} },
    },
    world: { day: 2, phase: 'day' },
    nearby: {
      snapshot_id: sid,
      buckets: {
        structures: [{
          prefab: 'cookpot',
          ref: '#1',
          handle: 'h42',
          position: { x: 1, z: 0 },
          distance: 1,
          stewer: { cooking: false, done: potDone, product: potDone ? 'meatballs' : null },
        }],
      },
    },
    dangerZones: [],
  })

  const dispatched = []
  const bridge = {
    leaseDirs: () => [],
    readLeaseAck: () => null,
    call: async (tool, args) => {
      dispatched.push({ tool, args })
      assert.equal(tool, 'cook')
      assert.equal(args.target_handle, 'h42', 'args.target_handle 必须透传到 bridge.call')
      // 模拟动作执行成功且进入新一帧快照：即使 snapshot_id 已经变化，因走 target_handle 不触发 stale_snapshot
      potDone = false
      meatballsCount = 1
      seq += 1
      sid = `r1-${seq}-n${seq}`
      return { ok: true, text: '拿出了肉丸' }
    },
  }
  const control = {
    acquire: () => ({ ok: true, lease: { generation: 1, authority_epoch: 'ep1', lease_id: 'ls1', owner_type: 'f8_agent', owner_instance_id: 'inst-1' } }),
    release: () => {},
    readAuthority: () => ({ status: 'active', generation: 1, authority_epoch: 'ep1', lease_id: 'ls1', owner_type: 'f8_agent', owner_instance_id: 'inst-1' }),
    validate: () => ({ ok: true, lease: { generation: 1, authority_epoch: 'ep1', lease_id: 'ls1', owner_type: 'f8_agent', owner_instance_id: 'inst-1' } }),
  }

  const dispatcher = createDispatcher({
    bridge,
    control,
    readSnapshot: () => makeSnap(),
    verifyWaitMs: 0,
  })

  const memory = { skill_instances: {}, danger_zones: [], known_resources: [], explored_regions: [] }
  const exec = new SkillExecutor({
    memory,
    readSnapshot: () => makeSnap(),
    dispatch: (tool, args, opts) => dispatcher.dispatch({ tool, args, ...opts }),
    describe: (o) => dispatcher.describe(o),
  })

  // 第一步：food_production 在 harvest_pot 下发 cook，携带过期也能工作的 target_handle='h42'
  // 故意让 bridge 读取前先推进快照 sid，验证仅凭 target_handle 也能绕过 #N 过期问题
  sid = 'r1-11-n11'
  const res = await exec.run('food_production', { owner: 'f8_agent', ownerInstanceId: 'inst-1' })
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].args.target_handle, 'h42')
  assert.equal(res.action?.args?.target_handle, 'h42')
  assert.equal(res.action?.verified, true)
  assert.equal(meatballsCount, 1)
})
