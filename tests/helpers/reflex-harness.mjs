// Lua 本地反射层与生存优先级共享测试夹具（fengari 假游戏 + 快照构造器）
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeState } from '../../lib/state/snapshot.js'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

// ─────────────────────────── Node 计划层夹具 ───────────────────────────

export function makeSnapshot(over = {}) {
  const raw = {
    data: {
      schema: 'bws.state/1',
      observer: { snapshot_id: 's10', sequence: 10, status: 'ok', timestamp: 1, sampled_at: 1, sample_age_ms: 0 },
      actor: {
        valid: true, actor_id: 'player:X', actor_type: 'player', prefab: 'wilson', name: '威尔逊',
        alive: true, is_ghost: false, tile_x: 1, tile_z: 2, x: 4, y: 0, z: 8,
        ...(over.actor ?? {}),
      },
      player: {
        health: { current: 100, max: 100, percent: over.health ?? 100 },
        hunger: { current: 100, max: 200, percent: over.hunger ?? 60 },
        sanity: { current: 200, max: 200, percent: over.sanity ?? 90 },
        inventory: { items: over.items ?? {}, slots: 15, is_full: false },
        equipment: over.equipment ?? { slots: {}, worn: [] },
      },
      world: {
        day: over.day ?? 2,
        phase: over.phase ?? 'day',
        phase_name: over.phase === 'night' ? '夜晚' : '白天',
        season: 'autumn',
        season_name: '秋季',
      },
      nearby: { runtime_id: 'rt1', snapshot_id: 'r1-n2', status: 'ok', radius: 16, buckets: over.buckets ?? {} },
    },
  }
  return normalizeState(raw, { ageMs: 0 })
}

export const ITEMS = (...entries) => Object.fromEntries(entries.map(([prefab, count], index) => [
  String(index),
  { prefab, count },
]))

// ─────────────────────────── Lua 反射层夹具 ───────────────────────────

const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = {
    TORCH="火把", AXE="斧头", PICKAXE="镐", LOG="木头", CUTGRASS="采下的草", TWIGS="树枝",
    BERRYBUSH="浆果丛", FROG="青蛙", CRAWLINGHORROR="爬行恐惧", TERRORBEAK="恐怖尖喙",
    CAMPFIRE="营火", FIREPIT="火坑", WILSON="威尔逊", FLOWER="花", SAPLING="树苗", FLINT="燧石",
}, CHARACTER_NAMES = { WILSON = "威尔逊" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", BODY = "body", HEAD = "head" }
local function act(id) return { id = id } end
GLOBAL.ACTIONS = { CHOP=act("CHOP"), MINE=act("MINE"), DIG=act("DIG"), HAMMER=act("HAMMER"),
    PICK=act("PICK"), PICKUP=act("PICKUP"), HARVEST=act("HARVEST"), ATTACK=act("ATTACK"),
    EAT=act("EAT"), COOK=act("COOK"), SLEEPIN=act("SLEEPIN"), DROP=act("DROP"),
    ADDFUEL=act("ADDFUEL"), HEAL=act("HEAL"), EQUIP=act("EQUIP"), BUILD=act("BUILD") }
GLOBAL.Vector3 = function(x, y, z) return { x = x, y = y, z = z } end
GLOBAL.BufferedAction = function(doer, target, action, invobject, pos)
    return { doer = doer, target = target, action = action, invobject = invobject, pos = pos }
end
GLOBAL.TheNet = { Announce = function() end }
GLOBAL.SetServerPaused = function() end

NOW = 1000
NEARBY = {}
CRAFTED = {}
PUSHED = nil
BUFFERED = nil
ANNOUNCED = nil
MAKE_RECIPE_IMPL = nil

GLOBAL.TheSim = {
    GetTime = function() return NOW end,
    FindEntities = function(self, x, y, z, r, musttags, canttags, mustoneoftags)
        local out = {}
        for _, e in ipairs(NEARBY) do
            local ok = true
            if musttags ~= nil then
                for _, t in ipairs(musttags) do
                    if not e:HasTag(t) then ok = false end
                end
            end
            -- 原生 FindEntities 按半径过滤；桩不模拟这一步会让"16 格内找不到"
            -- 误命中 20 格外的目标，有界 seek 就测不出来了
            if ok and r ~= nil then
                local ex, _, ez = e.Transform.GetWorldPosition()
                local dx, dz = (ex or 0) - x, (ez or 0) - z
                if dx * dx + dz * dz > r * r then ok = false end
            end
            if ok then out[#out + 1] = e end
        end
        return out
    end,
    SetPersistentString = function(self, name, text) WRITTEN[name] = text end,
    GetPersistentString = function(self, name, cb) cb(false, nil) end,
}
GLOBAL.TheWorld = {
    ismastersim = true,
    state = { cycles = 1, phase = "day", season = "autumn", temperature = 20 },
    HasTag = function(self, tag) return false end,
    DoPeriodicTask = function(self, interval, fn) PERIODIC = fn end,
    Map = { CanDeployRecipeAtPoint = function() return true end },
}
-- 真实原生配方结构：ingredients = { {type=..., amount=...} }（见游戏 scripts/recipe.lua）
GLOBAL.AllRecipes = {
    torch = { name = "torch", product = "torch",
              ingredients = { { type = "cutgrass", amount = 2 }, { type = "twigs", amount = 2 } } },
    axe = { name = "axe", product = "axe",
            ingredients = { { type = "twigs", amount = 1 }, { type = "flint", amount = 1 } } },
    pickaxe = { name = "pickaxe", product = "pickaxe",
                ingredients = { { type = "twigs", amount = 2 }, { type = "flint", amount = 2 } } },
    campfire = { name = "campfire", product = "campfire", placer = "campfire_placer",
                 ingredients = { { type = "cutgrass", amount = 3 }, { type = "log", amount = 2 } } },
    firepit = { name = "firepit", product = "firepit", placer = "firepit_placer",
                ingredients = { { type = "log", amount = 2 }, { type = "rocks", amount = 12 } } },
}

function newent(prefab, x, z, tags, comps)
    local e = { prefab = prefab, components = comps or {}, _tags = {}, _x = x or 0, _z = z or 0 }
    for _, t in ipairs(tags or {}) do e._tags[t] = true end
    function e:IsValid() return true end
    function e:HasTag(tag) return self._tags[tag] == true end
    function e:GetPosition() return { x = self._x, y = 0, z = self._z } end
    e.Transform = { GetWorldPosition = function() return e._x, 0, e._z end }
    return e
end

function mkitem(prefab, count, extra)
    local item = { prefab = prefab, components = {} }
    if (count or 1) > 1 then
        item.components.stackable = { StackSize = function() return count end }
    end
    if extra ~= nil then
        for k, v in pairs(extra) do item.components[k] = v end
    end
    function item:IsValid() return true end
    function item:HasTag() return false end
    item.Transform = { GetWorldPosition = function() return 0, 0, 0 end }
    return item
end

function newinventory(items, equipped)
    local inv = { _items = items or {}, _equipped = equipped or {} }
    function inv:GetNumSlots() return 15 end
    function inv:GetItemInSlot(slot) return self._items[slot] end
    function inv:GetEquippedItem(slot) return self._equipped[slot] end
    function inv:ForEachItem(fn)
        for _, item in pairs(self._items) do fn(item) end
        for _, item in pairs(self._equipped) do fn(item) end
        if self._active ~= nil then fn(self._active) end
    end
    function inv:SetActiveItem(item) self._active = item end
    function inv:FindItem(fn) return nil end
    function inv:DropItem(item) self._dropped = item end
    function inv:Equip(item)
        for k, v in pairs(self._items) do if v == item then self._items[k] = nil end end
        self._equipped[GLOBAL.EQUIPSLOTS.HANDS] = item
    end
    -- 真机 Inventory:Unequip(slot) 只摘掉 equipslots 并 **return item**，
    -- 不自动放回 itemslots（原版也是调用方自己 GiveItem）。桩必须忠实模拟，
    -- 否则"收纳成功但火把消失"这个 bug 单测永远抓不到。
    function inv:Unequip(slot)
        local item = self._equipped[slot]
        if item == nil then return nil end
        self._equipped[slot] = nil
        return item
    end
    function inv:GetNextAvailableSlot()
        local n = 0
        for _ in pairs(self._items) do n = n + 1 end
        return n + 1
    end
    function inv:GiveItem(item, slot)
        if item == nil then return nil end
        local s = slot
        if s == nil then
            s = 0
            for _ in pairs(self._items) do s = s + 1 end
            s = s + 1
        end
        self._items[s] = item
        return item
    end
    function inv:IsFull() return false end
    return inv
end

function makeplayer()
    local p = newent("wilson", 0, 0, { "player" }, {
        health = { currenthealth = 150, maxhealth = 150,
                   GetPercent = function(self) return self.currenthealth / self.maxhealth end,
                   IsDead = function(self) return self.currenthealth <= 0 end },
        hunger = { current = 150, max = 200, GetPercent = function(self) return self.current / self.max end },
        sanity = { current = 200, max = 200, GetPercent = function(self) return self.current / self.max end },
        temperature = { GetCurrent = function() return 20 end },
        moisture = { GetMoisture = function() return 0 end },
        locomotor = {
            IsMoving = function() return false end,
            Stop = function() end,
            Clear = function(self) self.bufferedaction = nil end,
            GoToPoint = function(self, pt) MOVED_TO = pt end,
            PushAction = function(self, ba) PUSHED = ba end,
            WantsToMoveForward = function() return false end,
            WantsToRun = function() return false end,
        },
        talker = { Say = function(self, text) ANNOUNCED = text end },
        builder = {
            KnowsRecipe = function() return true end,
            HasIngredients = function() return true end,
            MakeRecipe = function(self, recipe, pt, rot, skin)
                CRAFTED[#CRAFTED + 1] = recipe.name
                if MAKE_RECIPE_IMPL ~= nil then return MAKE_RECIPE_IMPL(recipe) end
                return true
            end,
        },
        inventory = newinventory({}, {}),
    })
    function p:IsInLight()
        if GLOBAL.TheWorld.state.phase ~= "night" then return true end
        for _, slot in ipairs({ "hands", "head" }) do
            local item = self.components.inventory:GetEquippedItem(slot)
            if item ~= nil and (item.prefab == "torch" or item.prefab == "lantern" or item.prefab == "minerhat") then
                local fuel = item.components.fueled
                if fuel == nil or not fuel:IsEmpty() then return true end
            end
        end
        return false
    end
    function p:GetBufferedAction() return BUFFERED end
    function p:ClearBufferedAction() BUFFERED = nil end
    p.sg = { HasStateTag = function(self, tag) return true end }
    return p
end

PLAYER = makeplayer()
GLOBAL.AllPlayers = { [1] = PLAYER }

GLOBAL.setmetatable = setmetatable
GLOBAL.getmetatable = getmetatable
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.os = os
GLOBAL.io = nil
pcall = nil
tonumber = nil
error = nil
os = nil
io = nil
`

const FILES = `Whale.files = {
    state = "whale_state.json", io_state = "whale_io_state.json",
    cmd = "whale_cmd.json", io_cmd = "whale_io_cmd.json",
    result = "whale_result.json", io_result = "whale_io_result.json",
    settings = "whale_settings.json", io_settings = "whale_io_settings.json",
    pause = "whale_pause.json", io_pause = "whale_io_pause.json",
}`

export function loadReflex(fengari, variant) {
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
  run(STUB, '假游戏环境')
  run('Whale = { verbose = false, version = "test", files = {} }', 'Whale 表')
  run(FILES, '文件名')
  run(`
    Whale.bridge = { Report = function(ok, text, id) REPORTS[#REPORTS + 1] = { ok = ok, text = text, id = id } end,
                     WriteState = function() end }
    REPORTS = {}
  `, '文件桥桩')
  const mods = variant === 'noActions'
    ? ['json', 'util', 'pickuprules', 'harvestrules', 'gatherrules', 'eatrules', 'craftrules', 'equiprules', 'config', 'native', 'reflex']
    : ['json', 'util', 'pickuprules', 'harvestrules', 'gatherrules', 'eatrules', 'craftrules',
       'equiprules', 'config', 'native', 'actions', 'reflex']
  for (const name of mods) {
    if (name === 'actions') {
      for (const sub of ['core', 'movement', 'gathering', 'work', 'combat', 'survival', 'crafting', 'interaction']) {
        run(readFileSync(join(MOD, 'scripts', 'whale', 'actions', `${sub}.lua`), 'utf8'), `actions/${sub}.lua`)
      }
    }
    run(readFileSync(join(MOD, 'scripts', 'whale', `${name}.lua`), 'utf8'), `${name}.lua`)
  }
  const global = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' }
  }
  return { run, runFile, global }
}

export function eachTick(n = 5) { return `for _ = 1, ${n} do Whale.reflex.Tick() end` }

