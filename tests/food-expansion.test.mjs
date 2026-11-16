// 验证"把现在能吃的都开放了"与"修复 reflex.lua 的 push_harvest 下发 ACTIONS.PICK"
//
// 覆盖：
//   1. reflex.lua push_harvest 必须下发 ACTIONS.PICK（与 actions.lua 一致，非 ACTIONS.HARVEST）
//   2. harvestrules 放行 carrot_planted、berrybush_juicy、三种蘑菇
//   3. pickuprules 放行所有基础与熟食食物（meat/froglegs/fish 等）
//   4. reflex 在周围有成熟 carrot_planted 时能正确定位并采集
//   5. plan.js 在有成熟 carrot_planted 时能规划 harvest
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fengari from 'fengari'

import { derivePlan } from '../lib/plan.js'
import { normalizeState } from '../lib/state/snapshot.js'

const { lua, lauxlib, lualib } = fengari
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

function createLuaEnv() {
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)

  function run(code, chunkName = 'test') {
    const okLoad = lauxlib.luaL_loadbuffer(L, fengari.to_luastring(code), null, fengari.to_luastring(chunkName))
    if (okLoad !== lua.LUA_OK) {
      const err = lua.lua_tojsstring(L, -1)
      lua.lua_pop(L, 1)
      throw new Error(`Lua load error [${chunkName}]: ${err}`)
    }
    const okCall = lua.lua_pcall(L, 0, lua.LUA_MULTRET, 0)
    if (okCall !== lua.LUA_OK) {
      const err = lua.lua_tojsstring(L, -1)
      lua.lua_pop(L, 1)
      throw new Error(`Lua run error [${chunkName}]: ${err}`)
    }
  }

  function get(varName) {
    lua.lua_getglobal(L, fengari.to_luastring(varName))
    const val = lua.lua_tojsstring(L, -1)
    lua.lua_pop(L, 1)
    return val
  }

  // 基础沙箱与桩
  run(`
    GLOBAL = {}
    GLOBAL.pcall = pcall
    GLOBAL.type = type
    GLOBAL.tostring = tostring
    GLOBAL.tonumber = tonumber
    GLOBAL.math = math
    GLOBAL.string = string
    GLOBAL.table = table
    GLOBAL.pairs = pairs
    GLOBAL.ipairs = ipairs
    GLOBAL.ACTIONS = {
      PICK = { id = "PICK" },
      HARVEST = { id = "HARVEST" },
      PICKUP = { id = "PICKUP" },
    }
    GLOBAL.BufferedAction = function(doer, target, action, invobject)
      return { doer = doer, target = target, action = action, invobject = invobject }
    end
    TheSim = {
      GetTime = function() return 100 end,
      GetRealTime = function() return 100000 end,
    }
    Whale = {}
  `)

  // 加载模块
  for (const mod of ['util', 'pickuprules', 'harvestrules', 'gatherrules', 'eatrules', 'native', 'actions', 'reflex']) {
    if (mod === 'actions') {
      for (const sub of ['core', 'movement', 'gathering', 'combat', 'survival', 'crafting', 'interaction']) {
        const subSrc = readFileSync(join(MOD, `scripts/whale/actions/${sub}.lua`), 'utf8')
        run(subSrc, `actions/${sub}`)
      }
    }
    const src = readFileSync(join(MOD, `scripts/whale/${mod}.lua`), 'utf8')
    run(src, mod)
  }

  return { run, get }
}

test('FE-1 reflex 源码静态检查：push_harvest 必须下发 GLOBAL.ACTIONS.PICK', () => {
  const reflexSrc = readFileSync(join(MOD, 'scripts/whale/reflex.lua'), 'utf8')
  const start = reflexSrc.indexOf('local function push_harvest(p, ent)')
  assert.ok(start > 0, '必须定义 push_harvest')
  const end = reflexSrc.indexOf('local function push_pickup', start)
  assert.ok(end > start, '必须定义 push_pickup')
  const fnBody = reflexSrc.slice(start, end)
  assert.match(fnBody, /GLOBAL\.ACTIONS\.PICK\b/, 'push_harvest 必须使用 ACTIONS.PICK')
  assert.doesNotMatch(fnBody, /GLOBAL\.ACTIONS\.HARVEST\b/, 'push_harvest 绝不能使用 ACTIONS.HARVEST')
})

test('FE-2 harvestrules 必须放行 carrot_planted、berrybush_juicy 与蘑菇', () => {
  const env = createLuaEnv()
  env.run(`
    local e_carrot = {
      prefab = "carrot_planted",
      valid = true,
      IsValid = function() return true end,
      IsInLimbo = function() return false end,
      HasTag = function() return false end,
      components = {
        pickable = {
          canbepicked = true,
          caninteractwith = true,
          CanBePicked = function() return true end,
          IsStuck = function() return false end,
          IsBarren = function() return false end,
          product = "carrot",
        }
      }
    }
    local ok, why = Whale.harvestrules.IsCandidate(e_carrot)
    local ready, rwhy = Whale.harvestrules.IsReady(e_carrot)
    local prod = Whale.harvestrules.ProductOf(e_carrot)
    RES_CARROT = tostring(ok) .. "|" .. tostring(ready) .. "|" .. tostring(prod)
  `)
  assert.equal(env.get('RES_CARROT'), 'true|true|carrot')

  // 多汁浆果与蘑菇
  env.run(`
    local list = Whale.harvestrules.PrefabList()
    PREFABS_STR = table.concat(list, ",")
  `)
  const prefabs = env.get('PREFABS_STR').split(',')
  for (const want of ['berrybush', 'berrybush2', 'berrybush_juicy', 'carrot_planted', 'red_mushroom', 'green_mushroom', 'blue_mushroom']) {
    assert.ok(prefabs.includes(want), `harvestrules 白名单必须包含 ${want}`)
  }
})

test('FE-3 pickuprules 必须放行所有基础与熟食食物（肉/蛙腿/鱼/熟肉等）', () => {
  const env = createLuaEnv()
  env.run(`
    local list = Whale.pickuprules.PrefabList()
    PICKUP_PREFABS = table.concat(list, ",")
  `)
  const pickupList = env.get('PICKUP_PREFABS').split(',')
  const foodsToTest = [
    'carrot', 'berries', 'berries_juicy',
    'meat', 'smallmeat', 'froglegs', 'fish',
    'meat_cooked', 'smallmeat_cooked', 'froglegs_cooked', 'fish_cooked',
    'honey', 'red_cap', 'blue_cap', 'green_cap',
  ]
  for (const f of foodsToTest) {
    assert.ok(pickupList.includes(f), `pickuprules 必须放行食物掉落物 ${f}`)
  }
})

test('FE-4 reflex 在周围只有成熟 carrot_planted 时，forage 能正确采集', () => {
  const env = createLuaEnv()
  env.run(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    Whale.config = { Get = function(k) return true end }
    Whale.bridge = { Report = function() end, WriteState = function() end }

    LAST_PUSHED = nil
    Whale.actions.push = function(p, ba)
      LAST_PUSHED = ba
      return true
    end

    local fake_carrot = {
      prefab = "carrot_planted",
      valid = true,
      Transform = {
        GetWorldPosition = function() return 2, 0, 2 end
      },
      IsValid = function() return true end,
      IsInLimbo = function() return false end,
      HasTag = function() return false end,
      components = {
        pickable = {
          canbepicked = true,
          caninteractwith = true,
          CanBePicked = function() return true end,
          IsStuck = function() return false end,
          IsBarren = function() return false end,
          product = "carrot",
        }
      }
    }

    GLOBAL.TheSim = {
      FindEntities = function(self, x, y, z, radius)
        return { fake_carrot }
      end
    }

    GLOBAL.TheWorld = { state = { phase = "day" } }
    Whale.craftrules = {
      NeededIngredients = function() return { cutgrass = 2, twigs = 2 } end,
      Counts = function() return { torch = 1, cutgrass = 10, twigs = 10 } end,
      HasIngredients = function() return true end,
    }
    local fake_torch = {
      prefab = "torch",
      valid = true,
      IsValid = function() return true end,
      components = {
        fueled = { IsEmpty = function() return false end, GetPercent = function() return 1 end }
      }
    }
    local player = {
      valid = true,
      IsValid = function() return true end,
      HasTag = function() return false end,
      IsInLight = function() return true end,
      GetBufferedAction = function() return nil end,
      Transform = {
        GetWorldPosition = function() return 0, 0, 0 end
      },
      components = {
        hunger = { GetPercent = function() return 0.4 end },
        health = { GetPercent = function() return 1 end, IsDead = function() return false end },
        inventory = {
          GetEquippedItem = function(self, slot) return nil end,
          ForEachItem = function(self, fn)
            local cb = type(fn) == "function" and fn or (type(self) == "function" and self or nil)
            if cb then cb(fake_torch) end
          end,
          FindItems = function(self, fn) return { fake_torch } end,
        }
      }
    }
    GLOBAL.AllPlayers = { [1] = player }
    GLOBAL.ThePlayer = player

    -- 触发反射 Tick（跑 5 次驱动一个 tick 循环）
    for i = 1, 5 do
      Whale.reflex.Tick()
    end

    ACT_ID = (LAST_PUSHED and LAST_PUSHED.action and LAST_PUSHED.action.id) or "none"
    TGT_PREFAB = (LAST_PUSHED and LAST_PUSHED.target and LAST_PUSHED.target.prefab) or "none"
  `)
  assert.equal(env.get('ACT_ID'), 'PICK', '反射采集必须下发 ACTIONS.PICK')
  assert.equal(env.get('TGT_PREFAB'), 'carrot_planted', '反射采集目标必须是 carrot_planted')
})

test('FE-5 plan.js 能够在 harvestables 中识别并推荐采摘 carrot_planted', () => {
  const raw = {
    data: {
      schema: 'bws.state/1',
      observer: { snapshot_id: 's20', sequence: 20, status: 'ok', timestamp: 1, sampled_at: 1, sample_age_ms: 0 },
      actor: { valid: true, actor_id: 'p:1', alive: true, is_ghost: false, tile_x: 0, tile_z: 0, x: 0, y: 0, z: 0 },
      player: {
        health: { current: 100, max: 100, percent: 100 },
        hunger: { current: 30, max: 200, percent: 15 },
        sanity: { current: 200, max: 200, percent: 100 },
        inventory: { items: {}, slots: 15, is_full: false },
        equipment: { slots: {}, worn: [] },
      },
      world: { day: 1, phase: 'day', phase_name: '白天', season: 'autumn', season_name: '秋季' },
      nearby: {
        runtime_id: 'rt1',
        snapshot_id: 'r1-n1',
        status: 'ok',
        radius: 16,
        buckets: {
          harvestables: [
            { ref: '#1', prefab: 'carrot_planted', label: '胡萝卜', product: 'carrot', distance: 4, harvest_ready: true },
          ],
        },
      },
    },
  }
  const snapshot = normalizeState(raw, { ageMs: 0 })
  const plan = derivePlan(snapshot)
  assert.equal(plan.goalId, 'eat', '饥饿危急下目标为 eat')
  // TARGET-REFRESH：不再建议"harvest #1 + snapshot_id"（模型思考 30~60 秒后必然过期），
  // 改成只描述**类别**的实时动作 —— 服务端在动手那一刻重新找最近的目标。
  assert.match(plan.next, /harvest_nearest target_kind=carrot_plant/, 'next 必须引导去采胡萝卜植株（不依赖 #N）')
  assert.doesNotMatch(plan.next, /snapshot_id=/, '不能再把会过期的 snapshot_id 写进建议里')
})
