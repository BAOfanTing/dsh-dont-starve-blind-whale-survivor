// TARGET-REFRESH 的公用测试夹具：真 Lua（fengari）+ 假游戏实体。
//
// 为什么单独一个文件：实时目标选择（targetrules）、稳定句柄、食物救援链三组测试
// 都需要"能造熔石/树/石头/浆果丛/蘑菇/玩家"的假世界 + 完整的模组加载链。
// 各写一份会漂，所以集中在这里。
//
// 证据类型：INTEGRATION（fengari 沙箱 + 真实 nearby/targetrules/guard/actions + 假实体）。
// 它**不能**证明真机行为（真实组件、真实动画、真实 FindEntities）—— 那些只能在 RUNTIME 里验。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authority, command, luaIoFiles } from './helpers.mjs'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const MOD = join(ROOT, 'DontStarveWhaleSurvivor')
export const RUNTIME = 'r1794500000-0001'
export const ACTOR_ID = 'player:KU_t'
export const NOW_MS = 1794500000000

/** 权威租约（和假玩家的 userid / session / shard 对齐，否则 guard 会报 actor_mismatch） */
export const testAuthority = (over = {}) => authority({
  runtime_id: RUNTIME,
  session_id: 'sess-T',
  shard_id: '1',
  actor_id: ACTOR_ID,
  ...over,
})

/** 模组加载顺序（和 modmain.lua 一致；targetrules 在 eatrules 之后、craftrules 之前） */
const MODULE_ORDER = [
  'json', 'util', 'pickuprules', 'harvestrules', 'gatherrules', 'eatrules', 'targetrules',
  'craftrules', 'equiprules', 'config', 'actor', 'nearby', 'guard_specs', 'guard', 'observe',
  'actions', 'macros', 'bridge',
]

const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
-- hold_control（"按住动作键"连砍）需要它；真机里是 GLOBAL.CONTROL_ACTION
GLOBAL.CONTROL_ACTION = "ACTION"
GLOBAL.FOODTYPE = { ROUGHAGE = "ROUGHAGE", SEEDS = "SEEDS", GEARS = "GEARS", VEGGIE = "VEGGIE" }
GLOBAL.ACTIONS = {
  CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, DIG = { id = "DIG" }, HAMMER = { id = "HAMMER" },
  PICK = { id = "PICK" }, PICKUP = { id = "PICKUP" }, HARVEST = { id = "HARVEST" },
  ATTACK = { id = "ATTACK" },
}
GLOBAL.TheNet = { GetSessionIdentifier = function() return "sess-T" end,
                  GetClusterID = function() return "cluster-A" end }
GLOBAL.TheShard = { GetShardId = function() return "1" end }
NOW = 1000
NOW_MS = ${NOW_MS}
WORLD = {}          -- 假世界里现有的所有实体（FindEntities 直接返回它）
PUSHED = {}
GLOBAL.AllRecipes = {
  torch = { name = "torch", level = 0, ingredients = { { type = "cutgrass", amount = 2 }, { type = "twigs", amount = 2 } } },
  axe = { name = "axe", level = 0, ingredients = { { type = "twigs", amount = 1 }, { type = "flint", amount = 1 } } },
  rope = { name = "rope", level = 1, ingredients = { { type = "cutgrass", amount = 3 } } },
  armorwood = { name = "armorwood", level = 1, ingredients = { { type = "log", amount = 8 }, { type = "rope", amount = 2 } } },
  -- 科学机器：原生配方名是 researchlab（模型说的是 sciencemachine，别名在 core.lua）
  researchlab = { name = "researchlab", level = 0, placer = "researchlab_placer",
                  ingredients = { { type = "goldnugget", amount = 1 }, { type = "log", amount = 4 }, { type = "rocks", amount = 4 } } },
  campfire = { name = "campfire", level = 0, placer = "campfire_placer",
               ingredients = { { type = "cutgrass", amount = 3 }, { type = "log", amount = 2 } } },
}
GLOBAL.TECH = { NONE = 0, SCIENCE_ONE = 1, SCIENCE_TWO = 2 }
-- Vector3：build_by_ctx 用 Vector3(x,0,z) 指定放点；沙箱里它是 GLOBAL 上的
GLOBAL.Vector3 = function(x, y, z) return { x = x or 0, y = y or 0, z = z or 0 } end
GLOBAL.IsCharacterIngredient = function() return false end
GLOBAL.IsTechIngredient = function() return false end
GLOBAL.TheSim = { GetTime = function() return NOW end, GetRealTime = function() return NOW * 1000 end,
                  FindEntities = function(self, x, y, z, r, musttags, canttags, mustoneoftags)
                      local out = {}
                      for _, e in ipairs(WORLD) do
                          local ex, _, ez = e.Transform:GetWorldPosition()
                          local dx, dz = ex - x, ez - z
                          if dx * dx + dz * dz <= r * r then
                              local skip = false
                              for _, t in ipairs(canttags or {}) do
                                  if e:HasTag(t) then skip = true end
                              end
                              if not skip then out[#out + 1] = e end
                          end
                      end
                      return out
                  end }

--- 假实体：一个通用的 inst，按 opts 决定它有什么组件
function mkent(opts)
    opts = opts or {}
    local e = {
        prefab = opts.prefab or "twigs",
        GUID = opts.guid or 1,
        tags = opts.tags or {},
        components = {},
        valid = opts.valid ~= false,
        limbo = opts.limbo == true,
        parent = opts.parent or nil,
        Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end },
    }
    e.IsValid = function(self) return self.valid end
    e.IsInLimbo = function(self) return self.limbo == true end
    e.GetParent = function(self) return self.parent end
    e.HasTag = function(self, tag) if tag == "INLIMBO" then return self.limbo end return self.tags[tag] == true end
    e.GetPosition = function(self) return { x = opts.x or 0, y = 0, z = opts.z or 0 } end

    if opts.pickup then
        e.components.inventoryitem = {
            canbepickedup = opts.canbepickedup ~= false,
            owner = opts.owner or nil,
        }
        if opts.stack ~= nil then
            e.components.stackable = { StackSize = function() return opts.stack end }
        end
    end
    if opts.edible then
        e.components.edible = { foodtype = "VEGGIE",
                                hungervalue = opts.hunger or 12.5, healthvalue = opts.health or 0 }
    end
    if opts.work then
        e.components.workable = {
            action = { id = opts.work },
            workleft = opts.workleft == nil and 3 or opts.workleft,
        }
    end
    if opts.pickable then
        local ready = opts.ready ~= false
        e.components.pickable = {
            canbepicked = ready,
            caninteractwith = true,
            product = opts.product or "berries",
            cycles_left = opts.cycles or 3,
            CanBePicked = function() return ready end,
            IsStuck = function() return false end,
            IsBarren = function() return false end,
        }
        if ready then e.tags.pickable = true end
    end
    if opts.health ~= nil then
        e.components.health = { currenthealth = opts.health, maxhealth = opts.maxhealth or opts.health,
                                IsDead = function() return false end }
    end
    return e
end

function mkplaya(opts)
    opts = opts or {}
    local items = opts.items or {}
    local p = { prefab = "warly", GUID = 999, tags = { player = true }, components = {} }
    p.userid = "KU_t"
    p.parent = nil
    p.IsValid = function() return true end
    p.GetParent = function() return p.parent end
    p.HasTag = function(self, tag) if tag == "playerghost" then return false end return self.tags[tag] == true end
    p.Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end }
    p.GetPosition = function() return { x = opts.x or 0, y = 0, z = opts.z or 0 } end
    -- busy(p) 会问这几个：GetBufferedAction / sg:HasStateTag / ClearBufferedAction
    p.buffered_action = nil
    p.GetBufferedAction = function(self) return self.buffered_action end
    p.ClearBufferedAction = function(self) self.buffered_action = nil end
    p.sg = { HasStateTag = function(_, tag) return tag == "idle" end }
    p.components.health = { currenthealth = opts.hp or 200, maxhealth = 200, IsDead = function() return false end }
    p.components.hunger = { current = opts.hunger or 100, max = 200, GetPercent = function() return (opts.hunger or 100) / 200 end }
    p.components.builder = {
        KnowsRecipe = function(self, rec) return true end,
        MakeRecipe = function() return true end,
    }
    -- HasIngredients / CanBuild 默认**不装** —— 这样 craftrules.CanCraftNow 会走
    -- "CanBuild 不可用 → 退回 KnowsRecipe" 的兜底分支，和真机上的老构建一致。
    -- 需要精确模拟"KnowsRecipe 不认科学机器、CanBuild 认"时，用 canBuild 选项单独装。
    p.components.locomotor = {
        Stop = function() end,
        PushAction = function(self, ba) PUSHED[#PUSHED + 1] = ba end,
        WantsToMoveForward = function() return false end,
    }
    p.components.inventory = {
        GetNumSlots = function() return 15 end,
        GetItemInSlot = function() return nil end,
        GetEquippedItem = function() return nil end,
        GetNumFreeSlot = function() return 15 end,
        CanAcceptCount = function() return 99 end,
        ForEachItem = function(self, fn) for _, it in ipairs(ITEMS) do fn(it) end end,
    }
    return p
end
ITEMS = {}
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
GLOBAL.BufferedAction = function(doer, target, action) return { doer = doer, target = target, action = action, options = {} } end
pcall = nil
tonumber = nil
error = nil
os = nil
io = nil
`

/**
 * 造一个背包物品。
 * eatrules / guard 会调 item:IsValid()，DiagnoseHint 也会 —— 少了它会静默变成"背包是空的"。
 */
export const itemLua = (prefab, { count = 1, edible = false, hunger = 12.5, health = 0 } = {}) =>
  `(function() local it = { prefab = ${JSON.stringify(prefab)}, components = { `
  + `stackable = { StackSize = function() return ${count} end }`
  + (edible
    ? `, edible = { foodtype = "VEGGIE", hungervalue = ${hunger}, healthvalue = ${health} }`
    : '')
  + ` } } `
  + `it.IsValid = function() return true end `
  + `it.IsInLimbo = function() return false end `
  + `it.HasTag = function() return false end `
  + `return it end)()`

/**
 * 加载模组（真 Lua 沙箱）。
 * @param {object} opts
 * @param {string[]} opts.entities  追加到假世界里的实体（Lua 源码片段）
 * @param {string[]} opts.items     背包里的物品（Lua 源码片段；可用 itemLua 生成）
 * @param {boolean|null} opts.canBuild  装一个 `builder:CanBuild(name)` 桩：
 *        true/false 直接返回该值；不传则不装（走 CanCraftNow 的 KnowsRecipe 兜底）。
 *        真机形态是 `knowsRecipe:false, canBuild:true` —— KnowsRecipe 不认身边的科学机器，
 *        而 CanBuild 认（含临时科技加成）。
 */
export async function loadTargets({ entities = [], items = [], knowsRecipe = true, canBuild = null, preload = '' } = {}) {
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
  const get = (n) => {
    lua.lua_getglobal(L, to_luastring(n))
    try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' }
  }
  run(STUB)
  run(luaIoFiles({ 'whale_io_lease.json': testAuthority() }))
  // ★ preload：在**模块加载之前**执行。
  //   为什么需要：gathering.lua 在文件顶部就 `local BufferedAction = GLOBAL.BufferedAction`、
  //   `local push = A.push`、`local hold_control = A.hold_control` 把这些函数捕获成 upvalue。
  //   加载之后再改 GLOBAL / A 是无效的 —— 想观察"砍了几下"必须在这里挂钩子。
  if (preload) run(preload)
  run('Whale = { verbose = false, version = "0.39.0", '
    + 'files = { lease = "whale_lease.json", io_lease = "whale_io_lease.json", '
    + 'lease_ack = "whale_lease_ack.json", io_lease_ack = "whale_io_lease_ack.json" } }')
  for (const n of MODULE_ORDER) {
    if (n === 'actions') {
      for (const sub of ['core', 'movement', 'gathering', 'work', 'combat', 'survival', 'crafting', 'interaction']) {
        run(readFileSync(join(MOD, 'scripts', 'whale', 'actions', sub + '.lua'), 'utf8'))
      }
    }
    run(readFileSync(join(MOD, 'scripts', 'whale', n + '.lua'), 'utf8'))
  }
  run('Whale.config.build(function(k) if k == "scan_radius" then return 16 end if k == "scan_seconds" then return 4 end return nil end)')
  run(`Whale.nearby.runtime_id = function() return "${RUNTIME}" end`)
  run('LAST_REPORT_OK = nil; LAST_REPORT_TEXT = nil; LAST_REPORT_REASON = nil')
  run('Whale.bridge.Report = function(ok, text, id, reason) LAST_REPORT_OK = ok and true or false; '
    + 'LAST_REPORT_TEXT = tostring(text or ""); LAST_REPORT_REASON = reason end')
  if (knowsRecipe === false) {
    run('PLAYER.components.builder.KnowsRecipe = function() return false end')
  }
  if (canBuild === true || canBuild === false) {
    // 真机形态：KnowsRecipe 说不认识、CanBuild 说能做（它算上了身边科学机器的临时科技）
    run(`PLAYER.components.builder.CanBuild = function() return ${canBuild} end`)
  }
  if (items.length > 0) {
    run('ITEMS = { ' + items.join(', ') + ' }')
  }
  if (entities.length > 0) {
    run('WORLD = { ' + entities.join(', ') + ' }')
  }
  /** 换一批实体（模拟世界变化：东西出现/消失/被拿走） */
  const setWorld = (list) => run('WORLD = { ' + list.join(', ') + ' }')
  /**
   * 重新扫一帧。
   * ★ 必须把 NOW 往前推（> scan_seconds=4）：nearby 有扫描缓存，同一时刻重复调用会直接复用，
   *   那样就测不出"多次扫描之间句柄是否稳定"。
   */
  const buildNearby = ({ advance = 5, seq = 1 } = {}) => {
    run(`NOW = NOW + ${advance}`)
    run(`
      do
        local actor = Whale.actor.get_actor()
        local data = Whale.observe.BuildData(actor, { seq = ${seq}, now = NOW })
        SNAP = data.nearby.snapshot_id
        BUCKETS = data.nearby.buckets
        HANDLES = {}
        for k, list in pairs(data.nearby.buckets) do
          for _, it in ipairs(list) do
            if it.handle ~= nil then HANDLES[it.prefab] = it.handle end
          end
        end
      end
    `)
    return get('SNAP')
  }
  const setCmd = (c) => run(`CMD = Whale.json.decode([==[${JSON.stringify(c)}]==])`)
  /** 跑 guard.validate，返回 "ok|why|hasTarget|hint|prefab|guid" */
  const validate = () => {
    run('local ok, why, detail = Whale.guard.validate(CMD)\n'
      + 'local t = detail ~= nil and detail.target or nil\n'
      + 'OUT = tostring(ok) .. "|" .. tostring(why) .. "|" .. tostring(t ~= nil) '
      + '.. "|" .. tostring(detail ~= nil and detail.hint or "") '
      + '.. "|" .. tostring(t ~= nil and t.prefab or "") '
      + '.. "|" .. tostring(t ~= nil and t.GUID or "")')
    return get('OUT')
  }
  const AUTH = testAuthority()
  const cmd = (over = {}) => command(AUTH, {
    action: 'pickup',
    args: { target_ref: '#1', snapshot_id: 'SNAP' },
    ...over,
  })
  return {
    run, get, buildNearby, setWorld, setCmd, validate, cmd, AUTH,
    report: () => ({ ok: get('LAST_REPORT_OK'), text: get('LAST_REPORT_TEXT'), reason: get('LAST_REPORT_REASON') }),
    snap: () => get('SNAP'),
    /** 取某个 prefab 在当前快照里的句柄 */
    handleOf: (prefab) => {
      run(`OUT = HANDLES[${JSON.stringify(prefab)}] or "nil"`)
      return get('OUT')
    },
  }
}

/** 常用假实体的 Lua 源码片段 */
export const ents = {
  flint: (o = {}) => `mkent({ prefab = "flint", guid = ${o.guid ?? 11}, x = ${o.x ?? 4}, z = ${o.z ?? 0}, pickup = true })`,
  twigs: (o = {}) => `mkent({ prefab = "twigs", guid = ${o.guid ?? 12}, x = ${o.x ?? 4}, z = ${o.z ?? 0}, pickup = true })`,
  pumpkin: (o = {}) => `mkent({ prefab = "pumpkin", guid = ${o.guid ?? 13}, x = ${o.x ?? 4}, z = ${o.z ?? 2}, pickup = true, edible = true, hunger = 25 })`,
  berriesJuicy: (o = {}) => `mkent({ prefab = "berries_juicy", guid = ${o.guid ?? 14}, x = ${o.x ?? 8}, z = ${o.z ?? 0}, pickup = true, edible = true, hunger = 12.5 })`,
  carrot: (o = {}) => `mkent({ prefab = "carrot", guid = ${o.guid ?? 15}, x = ${o.x ?? 4}, z = ${o.z ?? -4}, pickup = true, edible = true, hunger = 12.5 })`,
  redCap: (o = {}) => `mkent({ prefab = "red_cap", guid = ${o.guid ?? 16}, x = ${o.x ?? 4}, z = ${o.z ?? 4}, pickup = true, edible = true, hunger = 12.5, health = -20 })`,
  tree: (o = {}) => `mkent({ prefab = "evergreen", guid = ${o.guid ?? 21}, x = ${o.x ?? 8}, z = ${o.z ?? 4}, work = "CHOP" })`,
  rock: (o = {}) => `mkent({ prefab = "rock1", guid = ${o.guid ?? 22}, x = ${o.x ?? 8}, z = ${o.z ?? -4}, work = "MINE" })`,
  goldVein: (o = {}) => `mkent({ prefab = "rock2", guid = ${o.guid ?? 23}, x = ${o.x ?? 12}, z = ${o.z ?? -4}, work = "MINE" })`,
  rockIce: (o = {}) => `mkent({ prefab = "rock_ice", guid = ${o.guid ?? 24}, x = ${o.x ?? 12}, z = ${o.z ?? 4}, work = "MINE" })`,
  berrybush: (o = {}) => `mkent({ prefab = "berrybush", guid = ${o.guid ?? 31}, x = ${o.x ?? 2}, z = ${o.z ?? 2}, pickable = true, ready = ${o.ready !== false}, product = "berries" })`,
  berrybushJuicy: (o = {}) => `mkent({ prefab = "berrybush_juicy", guid = ${o.guid ?? 32}, x = ${o.x ?? 2}, z = ${o.z ?? -2}, pickable = true, ready = ${o.ready !== false}, product = "berries_juicy" })`,
  carrotPlanted: (o = {}) => `mkent({ prefab = "carrot_planted", guid = ${o.guid ?? 33}, x = ${o.x ?? 4}, z = ${o.z ?? 0}, pickable = true, ready = ${o.ready !== false}, product = "carrot" })`,
  greenMushroom: (o = {}) => `mkent({ prefab = "green_mushroom", guid = ${o.guid ?? 34}, x = ${o.x ?? 6}, z = ${o.z ?? 6}, pickable = true, ready = ${o.ready !== false}, product = "green_cap" })`,
}
