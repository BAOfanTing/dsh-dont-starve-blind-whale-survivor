// R8.5 测试夹具：通过 fengari 加载**真实生产 Lua 模块**（不做 JS 模拟状态机）。
//
// 为什么抽出来：R8.5 需要"真实 Lua 执行逻辑"的集成测试；battle / reflex / character
// 共用同一套假游戏环境。如果每个测试文件各抄一份 STUB，漂移会很快出现
// （过去就踩到过"测试桩和真实 API 不一致 → 测试全绿但真机失败"）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const MOD = join(ROOT, 'DontStarveWhaleSurvivor', 'scripts', 'whale')

export const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = {
    TORCH="火把", AXE="斧头", PICKAXE="镐", LOG="木头", CUTGRASS="采下的草", TWIGS="树枝",
    FLINT="燧石", ROCK="石头", FROG="青蛙", SPIDER="蜘蛛", SPIDER_WARRIOR="蜘蛛战士",
    ABIGAIL_FLOWER="阿比盖尔之花", ABIGAIL="阿比盖尔", WILSON="威尔逊", WENDY="温蒂",
    HOUND="猎犬", FLOWER="花",
}, CHARACTER_NAMES = { WILSON = "威尔逊", WENDY = "温蒂" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", BODY = "body", HEAD = "head" }
GLOBAL.TUNING = {
    ABIGAIL_DEFENSIVE_MAX_FOLLOW = 5,
    ABIGAIL_COMBAT_TARGET_DISTANCE = 15,
    ABIGAIL_HEALTH_LEVEL1 = 150, ABIGAIL_HEALTH_LEVEL2 = 300, ABIGAIL_HEALTH_LEVEL3 = 600,
    ABIGAIL_SPEED = 5,
    WENDY_HEALTH = 150, WENDY_HUNGER = 150, WENDY_SANITY = 200,
    WENDY_SANITY_MULT = 0.75, WENDY_DAMAGE_MULT = 0.75,
    FROG_HEALTH = 100, FROG_DAMAGE = 10, FROG_ATTACK_PERIOD = 1, FROG_TARGET_DIST = 4,
    WILSON_ATTACK_PERIOD = 0.4,
}
GLOBAL.DEGREES = math.pi / 180
-- fengari 是 Lua 5.3：没有 math.atan2；battle.lua 的老兜底会用到它，补一个等价实现
if math.atan2 == nil and math.atan ~= nil then
    math.atan2 = function(y, x) return math.atan(y, x) end
end

local function act(id) return { id = id } end
GLOBAL.ACTIONS = { CHOP=act("CHOP"), MINE=act("MINE"), DIG=act("DIG"), HAMMER=act("HAMMER"),
    PICK=act("PICK"), PICKUP=act("PICKUP"), HARVEST=act("HARVEST"), ATTACK=act("ATTACK"),
    EAT=act("EAT"), COOK=act("COOK"), SLEEPIN=act("SLEEPIN"), DROP=act("DROP"),
    ADDFUEL=act("ADDFUEL"), HEAL=act("HEAL"), EQUIP=act("EQUIP"), BUILD=act("BUILD"),
    CASTSUMMON=act("CASTSUMMON"), CASTUNSUMMON=act("CASTUNSUMMON"), UNEQUIP=act("UNEQUIP") }
GLOBAL.Vector3 = function(x, y, z) return { x = x, y = y, z = z } end
GLOBAL.BufferedAction = function(doer, target, action, invobject, pos)
    return { doer = doer, target = target, action = action, invobject = invobject, pos = pos }
end
GLOBAL.TheNet = { Announce = function() end, GetPVPEnabled = function() return false end }
GLOBAL.SetServerPaused = function() end

NOW = 1000
GLOBAL.GetTime = function() return NOW end
NEARBY = {}
PUSHES = {}
BUFFERED = nil
CRAFTED = {}
SUMMON_IMPL = nil
GUID_SEQ = 0
function nextguid() GUID_SEQ = GUID_SEQ + 1; return GUID_SEQ end

GLOBAL.TheSim = {
    GetTime = function() return NOW end,
    GetLightAtPoint = function() return 1 end,
    FindEntities = function(self, x, y, z, r, musttags, canttags, mustoneoftags)
        local out = {}
        for _, e in ipairs(NEARBY) do
            local ok = true
            if musttags ~= nil then
                for _, t in ipairs(musttags) do
                    if not e:HasTag(t) then ok = false end
                end
            end
            if ok and canttags ~= nil then
                for _, t in ipairs(canttags) do
                    if e:HasTag(t) then ok = false end
                end
            end
            if ok and mustoneoftags ~= nil then
                local any = false
                for _, t in ipairs(mustoneoftags) do
                    if e:HasTag(t) then any = true end
                end
                if not any then ok = false end
            end
            if ok and r ~= nil then
                local ex, _, ez = e.Transform.GetWorldPosition()
                local dx, dz = (ex or 0) - x, (ez or 0) - z
                if dx * dx + dz * dz > r * r then ok = false end
            end
            if ok then out[#out + 1] = e end
        end
        return out
    end,
    SetPersistentString = function() end,
    GetPersistentString = function() end,
}
GLOBAL.TheWorld = {
    ismastersim = true,
    state = { cycles = 1, phase = "day", season = "autumn", temperature = 20, isnight = false, isday = true },
    HasTag = function() return false end,
    DoPeriodicTask = function() end,
    DoTaskInTime = function() end,
    Map = {
        CanDeployRecipeAtPoint = function() return true end,
        IsPassableAtPoint = function() return true end,
        IsAboveGroundAtPoint = function() return true end,
    },
}

GLOBAL.AllRecipes = {
    torch = { name = "torch", product = "torch",
              ingredients = { { type = "cutgrass", amount = 2 }, { type = "twigs", amount = 2 } } },
    campfire = { name = "campfire", product = "campfire", placer = "campfire_placer",
                 ingredients = { { type = "cutgrass", amount = 3 }, { type = "log", amount = 2 } } },
    firepit = { name = "firepit", product = "firepit", placer = "firepit_placer",
                ingredients = { { type = "log", amount = 2 }, { type = "rocks", amount = 12 } } },
}

function newent(prefab, x, z, tags, comps)
    local e = { prefab = prefab, components = comps or {}, _tags = {}, _x = x or 0, _z = z or 0 }
    e.GUID = nextguid()
    for _, t in ipairs(tags or {}) do e._tags[t] = true end
    function e:IsValid() return true end
    function e:HasTag(tag) return self._tags[tag] == true end
    function e:GetPosition() return { x = self._x, y = 0, z = self._z } end
    e.Transform = { GetWorldPosition = function() return e._x, 0, e._z end }
    e.sg = { HasStateTag = function(self2, tag) return tag ~= "attack" end }
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
    item.GUID = nextguid()
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
    end
    function inv:FindItem(fn)
        for _, item in pairs(self._items) do if item ~= nil and fn(item) then return item end end
        for _, item in pairs(self._equipped) do if item ~= nil and fn(item) then return item end end
        return nil
    end
    function inv:CanAcceptCount() return 1 end
    function inv:DropItem(item) self._dropped = item end
    function inv:Equip(item)
        for k, v in pairs(self._items) do if v == item then self._items[k] = nil end end
        self._equipped[GLOBAL.EQUIPSLOTS.HANDS] = item
    end
    function inv:Unequip(slot)
        local item = self._equipped[slot]
        if item == nil then return nil end
        self._equipped[slot] = nil
        return item
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

function makeghost(opts)
    opts = opts or {}
    local g = newent("abigail", opts.x or 0, opts.z or 0, { "abigail", "character", "ghost" }, {})
    g._tags.INLIMBO = opts.inlimbo == true
    g._tags.noauradamage = true
    g.components.health = {
        currenthealth = opts.hp_current or 150,
        maxhealth = 150,
        GetPercent = function(self) return (self.currenthealth or 0) / (self.maxhealth or 150) end,
        IsDead = function(self) return (self.currenthealth or 0) <= 0 end,
    }
    g.components.combat = { target = opts.target }
    return g
end

function makeplayer(prefab, opts)
    opts = opts or {}
    local p = newent(prefab or "wendy", opts.x or 0, opts.z or 0, { "player" }, {})
    p.components.health = {
        currenthealth = opts.hp or 150, maxhealth = 150,
        GetPercent = function(self) return self.currenthealth / self.maxhealth end,
        IsDead = function(self) return self.currenthealth <= 0 end,
    }
    p.components.hunger = { current = 150, max = 200,
        GetPercent = function(self) return self.current / self.max end }
    p.components.sanity = { current = 200, max = 200,
        GetPercent = function(self) return self.current / self.max end }
    p.components.temperature = { GetCurrent = function() return 20 end }
    p.components.moisture = { GetMoisture = function() return 0 end }
    p.components.combat = { target = nil, lastdoattacktime = 0,
        InCooldown = function() return false end }
    p.components.locomotor = {
        IsMoving = function() return false end,
        Stop = function() end,
        Clear = function(self) self.bufferedaction = nil end,
        GoToPoint = function(self, pt) self.dest = pt end,
        PushAction = function(self, ba)
            self:Clear()
            self.bufferedaction = ba
            BUFFERED = ba
            PUSHES[#PUSHES + 1] = ba
            if ba ~= nil and ba.action == GLOBAL.ACTIONS.CASTSUMMON and SUMMON_IMPL ~= nil then
                SUMMON_IMPL(ba)
            end
        end,
        WantsToMoveForward = function() return false end,
        WantsToRun = function() return false end,
    }
    p.components.talker = { Say = function() end }
    p.components.builder = {
        KnowsRecipe = function() return true end,
        HasIngredients = function() return true end,
        MakeRecipe = function(self, recipe) CRAFTED[#CRAFTED + 1] = recipe.name; return true end,
    }
    p.components.inventory = newinventory(opts.items or {}, opts.equipped or {})
    function p:IsInLight() return true end
    function p:GetBufferedAction() return BUFFERED end
    function p:ClearBufferedAction() BUFFERED = nil end
    p.sg = { HasStateTag = function(self2, tag) return tag == "idle" end }
    -- 温蒂：ghostlybond 契约。notsummoned=true 表示"有花但还没召唤"。
    if opts.ghostlybond ~= false then
        p.components.ghostlybond = {
            bonded = true,
            bondlevel = opts.bondlevel or 1,
            summoned = opts.summoned == true,
            notsummoned = opts.summoned ~= true,
            ghost = opts.ghost,
        }
    end
    return p
end

-- 模组沙箱约定：这些全局由游戏注入，模块统一从 GLOBAL 取。
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.os = os
GLOBAL.setmetatable = setmetatable
GLOBAL.getmetatable = getmetatable
`

const FILES = `Whale.files = {
    state = "whale_state.json", io_state = "whale_io_state.json",
    cmd = "whale_cmd.json", io_cmd = "whale_io_cmd.json",
    result = "whale_result.json", io_result = "whale_io_result.json",
    settings = "whale_settings.json", io_settings = "whale_io_settings.json",
    pause = "whale_pause.json", io_pause = "whale_io_pause.json",
}`

const LOAD_ORDER = [
  'json', 'util', 'pickuprules', 'harvestrules', 'gatherrules', 'eatrules', 'craftrules',
  'equiprules', 'config', 'native', 'targetrules',
  'character/base-profile', 'character/profiles/wendy', 'character/profile-registry',
  'character/companion',
]

const ACTION_FILES = ['core', 'movement', 'gathering', 'work', 'combat', 'survival', 'crafting', 'interaction']

/** 建一个加载了全部生产 Lua 模块的 fengari 环境。 */
export function createLuaEnv(fengari) {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, what) => {
    const status = lauxlib.luaL_dostring(L, to_luastring(code))
    if (status !== lua.LUA_OK) {
      let message = ''
      try { message = to_jsstring(lua.lua_tostring(L, -1)) } catch {}
      throw new Error(`${what || 'chunk'} 出错：${message}`)
    }
  }
  const loadFile = (rel) => run(readFileSync(join(MOD, `${rel}.lua`), 'utf8'), `${rel}.lua`)
  const global = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' } finally {
      // 必须弹出：fengari 的 Lua 栈很小，每次 getglobal 不 pop 会栈溢出
      lua.lua_pop(L, 1)
    }
  }

  run(STUB, '假游戏环境')
  run('Whale = { verbose = false, version = "test-r85", files = {} }', 'Whale 表')
  run(FILES, '文件名')
  run(`
    REPORTS = {}
    Whale.bridge = {
        Report = function(ok, text, id, reason)
            REPORTS[#REPORTS + 1] = { ok = ok, text = text, id = id, reason = reason }
        end,
        WriteState = function() end,
        LocalActionsFrozen = function() return false end,
    }
  `, '文件桥桩')

  for (const name of LOAD_ORDER) loadFile(name)
  for (const sub of ACTION_FILES) loadFile(`actions/${sub}`)
  loadFile('battle')
  loadFile('reflex')
  return { run, global }
}

/** 每次测试前把全局状态清干净（等价于"新开一局"）。 */
export const RESET = `
NEARBY = {}
PUSHES = {}
BUFFERED = nil
CRAFTED = {}
SUMMON_IMPL = nil
GLOBAL.TheWorld.state.phase = "day"
GLOBAL.GetTime = function() return NOW end
Whale.job = nil
Whale.battle.Cleanup()
Whale.battle.AbortDefense("test_reset")
Whale.reflex_on = true
Whale.reflex_force_off = false
PLAYER = nil
ABIGAIL = nil
`

/** 建一局：温蒂（或指定角色）+ 可选召唤状态。 */
export function scenario({ prefab = 'wendy', hp = 150, items = [], summoned = false, withGhost = false, ghostX = 0, ghostZ = 0, ghostHp = 150, ghostlybond = true } = {}) {
  const itemLines = items.map((x) => `mkitem("${x}", 1)`).join(', ')
  return `
    ${RESET}
    ABIGAIL = ${withGhost ? `makeghost({ x = ${ghostX}, z = ${ghostZ}, hp_current = ${ghostHp} })` : 'nil'}
    PLAYER = makeplayer("${prefab}", { hp = ${hp}, items = { ${itemLines} },
        summoned = ${summoned ? 'true' : 'false'}, ghost = ABIGAIL,
        ghostlybond = ${ghostlybond ? 'true' : 'false'} })
    GLOBAL.AllPlayers = { [1] = PLAYER }
    -- 让 CASTSUMMON 在真实游戏里"推下去就召唤出来"的行为可被测试驱动
    SUMMON_IMPL = function(ba)
        if PLAYER.components.ghostlybond ~= nil then
            PLAYER.components.ghostlybond.summoned = true
            PLAYER.components.ghostlybond.notsummoned = false
            ABIGAIL = makeghost({ x = 0, z = 0 })
            PLAYER.components.ghostlybond.ghost = ABIGAIL
        end
    end
  `
}

/** 一只会打玩家的敌人 */
export function attacker(prefab, x, z, opts = {}) {
  const tags = opts.tags ?? (prefab === 'frog' ? '{"hostile","animal","prey","frog"}' : '{"hostile","monster","spider"}')
  return `
    newent("${prefab}", ${x}, ${z}, ${tags}, {
        health = { currenthealth = ${opts.hp ?? 100}, maxhealth = ${opts.hp ?? 100},
                   IsDead = function(self) return (self.currenthealth or 0) <= 0 end },
        combat = { target = PLAYER, CanTarget = function() return true end },
    })
  `
}

export function tick(n) { return `for _ = 1, ${n} do Whale.actions.Tick(); Whale.reflex.Tick() end` }
