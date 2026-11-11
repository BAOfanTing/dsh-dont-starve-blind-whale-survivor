// 用「假游戏」在真 Lua 虚拟机里跑模组的观察/动作/结果
//
// 这一层最值钱：observe.lua（观察）和 actions.lua（动作）里的空指针、API 名字写错，
// 只有真跑一遍才看得出来；而本地没有饥荒，所以用 fengari + 一套 GLOBAL 假实现顶上。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

/** 假的 GLOBAL：只实现模组真的用到的那部分 API。 */
const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = {
    NAMES = { BERRYBUSH = "浆果丛", EVERGREEN = "常青树", ROCK1 = "巨石", SPIDER = "蜘蛛", LOG = "木头",
              BERRIES = "浆果", AXE = "斧头", TORCH = "火把", CAMPFIRE = "营火", WILSON = "威尔逊",
              FIREPIT = "火坑" },
    CHARACTER_NAMES = { WILSON = "威尔逊" },
}
GLOBAL.EQUIPSLOTS = { HANDS = "hands", BODY = "body", HEAD = "head" }
local function act(id) return { id = id } end
GLOBAL.ACTIONS = { CHOP = act("CHOP"), MINE = act("MINE"), DIG = act("DIG"), HAMMER = act("HAMMER"),
                   PICK = act("PICK"), HARVEST = act("HARVEST"), ATTACK = act("ATTACK"), EAT = act("EAT"),
                   COOK = act("COOK"), SLEEPIN = act("SLEEPIN"), DROP = act("DROP") }
GLOBAL.Vector3 = function(x, y, z) return { x = x, y = y, z = z } end
GLOBAL.BufferedAction = function(doer, target, action, invobject, pos)
    return { doer = doer, target = target, action = action, invobject = invobject, pos = pos }
end
GLOBAL.TheNet = { Announce = function(self, text) ANNOUNCED = text end }
GLOBAL.SetServerPaused = function(v) PAUSED = v end

NOW = 0
NEARBY = {}
ANNOUNCED = nil
BUFFERED = nil
PUSHED = nil
PAUSED = nil
WRITTEN = {}

GLOBAL.TheSim = {
    GetTime = function() return NOW end,
    FindEntities = function(self, x, y, z, r, musttags, canttags, mustoneoftags) return NEARBY end,
    SetPersistentString = function(self, name, text) WRITTEN[name] = text end,
    GetPersistentString = function(self, name, cb) cb(false, nil) end,
}
GLOBAL.TheWorld = {
    ismastersim = true,
    state = { cycles = 2, phase = "day", season = "autumn", temperature = 14 },
    HasTag = function(self, tag) return false end,
    DoPeriodicTask = function(self, interval, fn) PERIODIC = fn end,
    Map = { CanDeployRecipeAtPoint = function(self, pt, recipe, rot) return recipe ~= nil and recipe.place_ok ~= false end },
}
GLOBAL.AllRecipes = {
    torch = { name = "torch", product = "torch" },
    campfire = { name = "campfire", product = "campfire", placer = "campfire_placer" },
}
CRAFTED = {}

-- ── 实体 ──
local function newent(prefab, x, z, tags, comps)
    local e = { prefab = prefab, components = comps or {}, _tags = {}, _x = x or 0, _z = z or 0 }
    for _, t in ipairs(tags or {}) do e._tags[t] = true end
    function e:IsValid() return true end
    function e:HasTag(tag) return self._tags[tag] == true end
    function e:GetPosition() return { x = self._x, y = 0, z = self._z } end
    function e:GetDistanceSqToInst(other)
        local dx, dz = self._x - other._x, self._z - other._z
        return dx * dx + dz * dz
    end
    e.Transform = { GetWorldPosition = function() return e._x, 0, e._z end }
    return e
end

-- ── 玩家 ──
local function newinventory(items, equipped)
    local inv = { _items = items or {}, _equipped = equipped or {} }
    function inv:GetNumSlots() return 15 end
    function inv:GetItemInSlot(slot) return self._items[slot] end
    function inv:GetEquippedItem(slot) return self._equipped[slot] end
    function inv:ForEachItem(fn)
        for _, item in pairs(self._items) do fn(item) end
        for _, item in pairs(self._equipped) do fn(item) end
    end
    function inv:FindItem(fn) return nil end
    function inv:DropItem(item) self._dropped = item end
    function inv:Equip(item) self._equipped[GLOBAL.EQUIPSLOTS.HANDS] = item end
    function inv:IsFull() return false end
    return inv
end

local function makeplayer()
    local p = newent("wilson", 12 * 4 + 2, 45 * 4 + 2, { "player" }, {
        health = { currenthealth = 45, maxhealth = 150,
                   GetPercent = function(self) return self.currenthealth / self.maxhealth end,
                   IsDead = function() return false end },
        hunger = { current = 120, max = 150, GetPercent = function(self) return self.current / self.max end },
        sanity = { current = 200, max = 200, GetPercent = function(self) return self.current / self.max end },
        temperature = { GetCurrent = function() return 12 end },
        moisture = { GetMoisture = function() return 0 end },
        locomotor = {
            IsMoving = function() return false end,
            Stop = function() end,
            GoToPoint = function(self, pt) MOVED_TO = pt end,
            PushAction = function(self, ba) PUSHED = ba end,
        },
        talker = { Say = function(self, text) ANNOUNCED = text end },
        builder = {
            KnowsRecipe = function(self, recipe) return recipe ~= nil and recipe.known ~= false end,
            HasIngredients = function(self, recipe) return recipe ~= nil and recipe.materials ~= false end,
            MakeRecipe = function(self, recipe, pt, rot, skin)
                CRAFTED[#CRAFTED + 1] = { name = recipe.name, pt = pt }
                BUFFERED = { action = { id = "BUILD" } }
                return true
            end,
        },
        inventory = newinventory({
            [1] = newent("berries", 0, 0, {}, {
                edible = { foodtype = "VEGGIE", hungervalue = 9.375 },
                stackable = { StackSize = function() return 6 end },
                perishable = { GetPercent = function() return 0.9 end },
            }),
            [2] = newent("axe", 0, 0, {}, {
                tool = { CanDoAction = function(self, action) return action.id == "CHOP" end },
                finiteuses = { GetUses = function() return 40 end, total = 50 },
            }),
        }, {
            [GLOBAL.EQUIPSLOTS.HANDS] = newent("torch", 0, 0, { "light" }, {
                finiteuses = { GetUses = function() return 30 end, total = 60 },
            }),
        }),
    })
    function p:GetBufferedAction() return BUFFERED end
    p.sg = { HasStateTag = function(self, tag) return true end }
    function p:ClearBufferedAction() BUFFERED = nil end
    return p
end

PLAYER = makeplayer()
GLOBAL.AllPlayers = { [1] = PLAYER }

-- ── 世界里的东西 ──
NEARBY = {
    newent("berrybush", 13 * 4 + 2, 44 * 4 + 2, { "pickable" }, {
        pickable = { CanBePicked = function() return true end },
    }),
    newent("evergreen", 15 * 4 + 2, 43 * 4 + 2, {}, {
        workable = { action = GLOBAL.ACTIONS.CHOP, workleft = 10 },
    }),
    newent("spider", 18 * 4 + 2, 42 * 4 + 2, { "hostile" }, {
        health = { currenthealth = 25, maxhealth = 25, IsDead = function() return false end },
        combat = {},
    }),
    newent("firepit", 12 * 4 + 6, 46 * 4 + 2, { "fire", "structure" }, {
        fueled = { GetPercent = function() return 0.6 end, IsEmpty = function() return false end },
    }),
}

-- 模拟饥荒的模组沙箱：这些名字在 mod 环境里是 nil（0.1.0 用了 pcall，游戏启动就崩），
-- 模组只能从 GLOBAL 里拿。把它们置 nil，就能在本地复现这类错误。
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

function loadMod(fengari) {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code, what) => {
    const status = lauxlib.luaL_dostring(L, to_luastring(code))
    if (status !== lua.LUA_OK) {
      let message = ''
      try {
        message = to_jsstring(lua.lua_tostring(L, -1))
      } catch {}
      throw new Error(`${what} 出错：${message}`)
    }
  }
  const runFile = (code) => {
    lauxlib.luaL_loadstring(L, to_luastring(code))
    const status = lua.lua_pcall(L, 0, 0, 0)
    if (status !== lua.LUA_OK) {
      let message = ''
      try {
        message = to_jsstring(lua.lua_tostring(L, -1))
      } catch {}
      throw new Error(`运行失败：${message}`)
    }
  }
  run(STUB, '假游戏环境')
  run('Whale = { verbose = false, version = "0.1.0", files = {} }', 'Whale 表')
  run(FILES, '文件名')
  for (const name of ['json', 'util', 'observe', 'actions']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', `${name}.lua`), 'utf8'), `${name}.lua`)
  }
  const global = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try {
      return to_jsstring(lua.lua_tostring(L, -1))
    } catch {
      return ''
    }
  }
  return { run, runFile, global }
}

test('模组能在假游戏里加载，状态文字说得清楚', async () => {
  const fengari = await import('fengari')
  const { runFile, global } = loadMod(fengari)

  runFile(`
    local player = GLOBAL.AllPlayers[1]
    local text, data = Whale.observe.Build(player)
    assert(data.ready == true, "应该能读到玩家")
    assert(data.x == 12 and data.z == 45, "格子坐标不对：" .. tostring(data.x) .. "," .. tostring(data.z))
    assert(data.day == 2, "天数不对")
    for _, want in ipairs({
        "第3天", "白天", "秋季", "威尔逊", "生命 45/150", "饥饿 120/150",
        "背包", "浆果 ×6", "斧头", "火把", "(13,44)", "常青树", "蜘蛛", "25/25血", "燃料 60%",
    }) do
        assert(string.find(text, want, 1, true) ~= nil, "状态里应该有「" .. want .. "」，实际：\\n" .. text)
    end
    assert(string.find(text, "注意", 1, true) ~= nil, "血只剩 30%，应该有提醒：" .. text)
    assert(string.find(text, "血只剩 30%", 1, true) ~= nil, "提醒里应该写清血量：\\n" .. text)
    OUT = text
  `)
  const text = global('OUT')
  assert.match(text, /第3天/)
  assert.match(text, /你的位置|位置：/)
})

test('砍树：自动拿斧头、把动作推给游戏、做完报结果', async () => {
  const fengari = await import('fengari')
  const { runFile, global } = loadMod(fengari)

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    local ok, err = Whale.actions.Start("chop", { count = 1 })
    assert(ok == true, "砍树应该能开始：" .. tostring(err))
    Whale.actions.Tick()
    assert(PUSHED ~= nil, "应该把动作推给游戏了")
    assert(PUSHED.action.id == "CHOP", "动作类型不对：" .. tostring(PUSHED.action.id))
    assert(PUSHED.target.prefab == "evergreen", "目标不是树：" .. tostring(PUSHED.target.prefab))
    assert(PUSHED.invobject ~= nil and PUSHED.invobject.prefab == "axe",
        "应该自动拿上斧头，实际：" .. tostring(PUSHED.invobject and PUSHED.invobject.prefab))
    -- 模拟游戏：先忙着，然后闲下来（砍完了）
    BUFFERED = PUSHED
    Whale.actions.Tick()
    BUFFERED = nil
    Whale.actions.Tick()
    Whale.actions.Tick()
    assert(REPORTED ~= nil and REPORTED.ok == true, "应该报告成功，实际：" .. tostring(REPORTED and REPORTED.text))
    assert(Whale.job == nil, "干完以后不该还挂着任务")
    OUT_TEXT = REPORTED.text
  `)
  assert.match(global('OUT_TEXT'), /干了 1 次/)
})

test('附近什么都没有时老实说做不了', async () => {
  const fengari = await import('fengari')
  const { runFile, run, global } = loadMod(fengari)

  run('NEARBY = {}', '清空周围')
  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    Whale.actions.Start("chop", {})
    Whale.actions.Tick()
    assert(REPORTED ~= nil and REPORTED.ok == false, "应该报告失败")
    OUT_TEXT = REPORTED.text
  `)
  assert.match(global('OUT_TEXT'), /没有能砍的东西/)
})

test('不认识的动作会给出能用的动作列表', async () => {
  const fengari = await import('fengari')
  const { runFile, global } = loadMod(fengari)
  runFile(`
    local ok, err = Whale.actions.Start("fly_to_the_moon", {})
    assert(ok == false, "不认识的动作不该开始")
    ERR = err
  `)
  const text = global('ERR')
  assert.match(text, /没有这个动作/)
  assert.match(text, /chop/)
})

test('文件桥写的状态能被外面的 JSON.parse 读（格式对得上）', async () => {
  const fengari = await import('fengari')
  const { runFile, global, run } = loadMod(fengari)
  // 把 bridge.lua 也加载进来（前面只加载到 actions）
  run(readFileSync(join(MOD, 'scripts', 'whale', 'bridge.lua'), 'utf8'), 'bridge.lua')
  runFile(`
    Whale.bridge.WriteState(true)
    -- io 通道在虚拟机里没有，只会有持久化字符串通道
    RAW = WRITTEN["whale_state.json"]
    assert(RAW ~= nil, "应该写进持久化字符串")
  `)
  const raw = global('RAW')
  const state = JSON.parse(raw)
  assert.equal(state.v, 1)
  assert.equal(state.ready, true)
  assert.match(state.text, /威尔逊/)
  assert.equal(state.data.x, 12)
  assert.equal(state.data.z, 45)
})

test('modmain.lua 能在沙箱里加载（0.1.0 就是这里崩的）', async () => {
  const fengari = await import('fengari')
  const { lua, lauxlib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  fengari.lualib.luaL_openlibs(L)
  const fail = () => {
    try {
      return to_jsstring(lua.lua_tostring(L, -1))
    } catch {
      return ''
    }
  }
  // 假环境：只有沙箱给的那几个函数 + modutil 装的那几个
  const prelude = `
GLOBAL = {}
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.os = os
GLOBAL.io = nil
env = { GetModConfigData = function(key) return nil end }
MODIMPORTS = {}
POSTINITS = {}
function modimport(name) MODIMPORTS[#MODIMPORTS + 1] = name end
function AddGamePostInit(fn) POSTINITS[#POSTINITS + 1] = fn end
function AddPlayerPostInit(fn) POSTINITS[#POSTINITS + 1] = fn end
`
  let status = lauxlib.luaL_dostring(L, to_luastring(prelude))
  assert.equal(status, lua.LUA_OK, '前置环境出错：' + fail())
  // 沙箱模拟：裸 pcall/tonumber/error 是 nil
  status = lauxlib.luaL_dostring(L, to_luastring('pcall = nil\ntonumber = nil\nerror = nil\n'))
  assert.equal(status, lua.LUA_OK, '没法模拟沙箱：' + fail())

  const source = readFileSync(join(MOD, 'modmain.lua'), 'utf8')
  status = lauxlib.luaL_dostring(L, to_luastring(source))
  assert.equal(status, lua.LUA_OK, 'modmain.lua 加载失败（游戏里就是这句会让启动崩溃）：' + fail())

  lauxlib.luaL_loadstring(L, to_luastring(`
    assert(#MODIMPORTS == 5, "应该 modimport 了 5 个模块，实际 " .. #MODIMPORTS)
    assert(MODIMPORTS[1] == "scripts/whale/json.lua", "第一个应该是 json.lua")
    assert(#POSTINITS == 3, "应该有 3 个 postinit，实际 " .. #POSTINITS)
    assert(Whale.files.state == "whale_state.json", "文件名表没装上")
    assert(Whale.interval == 1, "配置默认值不对")
    assert(Whale.version ~= nil, "版本号没写")
  `))
  assert.equal(lua.lua_pcall(L, 0, 0, 0), lua.LUA_OK, 'modmain 加载后状态不对：' + fail())
})

test('每个模块都从 GLOBAL 里取沙箱没有的函数', () => {
  for (const name of ['json', 'util', 'observe', 'actions', 'bridge']) {
    const text = readFileSync(join(MOD, 'scripts', 'whale', `${name}.lua`), 'utf8')
    assert.match(text, /local pcall = GLOBAL\.pcall/, `${name}.lua 少了沙箱兼容头（pcall）`)
    assert.match(text, /local tonumber = GLOBAL\.tonumber/, `${name}.lua 少了沙箱兼容头（tonumber）`)
  }
  const modmain = readFileSync(join(MOD, 'modmain.lua'), 'utf8')
  assert.match(modmain, /local pcall = GLOBAL\.pcall/, 'modmain.lua 少了沙箱兼容头（pcall）')
  assert.doesNotMatch(modmain, /GLOBAL\.GetModConfigData/, 'GetModConfigData 在 mod 环境里，不在 GLOBAL 上')
})


test('做东西：服务端必须走 builder:MakeRecipe（MakeRecipeFromMenu 在服务端不干活）', async () => {
  const fengari = await import('fengari')
  const { runFile, run, global } = loadMod(fengari)
  run('CRAFTED = {}', '清空记录')
  runFile(`
    Whale.bridge = { Report = function(ok, text) REPORTED = { ok = ok, text = text } end, WriteState = function() end }
    Whale.actions.Start("craft", { recipe = "torch", count = 2 })
    BUFFERED = nil
    Whale.actions.Tick()                       -- 开始做第一个
    assert(#CRAFTED == 1 and CRAFTED[1].name == "torch", "应该做了第一个火把")
    assert(CRAFTED[1].pt == nil, "放背包里的东西不该带位置")
    Whale.actions.Tick()                       -- 手上忙着
    assert(#CRAFTED == 1, "忙着的时候不该又开始做一个")
    BUFFERED = nil                             -- 模拟做完了
    Whale.actions.Tick()                       -- 接着做第二个
    assert(#CRAFTED == 2, "应该做第二个，实际 " .. #CRAFTED)
    BUFFERED = nil
    Whale.actions.Tick()                       -- 收尾
    assert(REPORTED ~= nil and REPORTED.ok == true, "应该报告成功：" .. tostring(REPORTED and REPORTED.text))
    OUT_TEXT = REPORTED.text
  `)
  assert.match(global('OUT_TEXT'), /做了 2 个 torch/)
})

test('摆建筑：挑一块放得下的地，位置交给 MakeRecipe', async () => {
  const fengari = await import('fengari')
  const { runFile, run, global } = loadMod(fengari)
  run('CRAFTED = {}', '清空记录')
  runFile(`
    Whale.bridge = { Report = function(ok, text) REPORTED = { ok = ok, text = text } end, WriteState = function() end }
    Whale.actions.Start("build", { recipe = "campfire" })
    BUFFERED = nil
    Whale.actions.Tick()                       -- 找地方 + 走过去
    Whale.actions.Tick()                       -- 摆
    assert(#CRAFTED == 1, "应该调用一次 MakeRecipe，实际 " .. #CRAFTED)
    assert(CRAFTED[1].pt ~= nil, "摆地上的东西应该带坐标")
    BUFFERED = nil
    Whale.actions.Tick()
    assert(REPORTED ~= nil and REPORTED.ok == true, "应该报告成功：" .. tostring(REPORTED and REPORTED.text))
    OUT_TEXT = REPORTED.text
  `)
  assert.match(global('OUT_TEXT'), /摆了 campfire/)
})

test('材料不够会直接说，不会瞎做', async () => {
  const fengari = await import('fengari')
  const { runFile, global } = loadMod(fengari)
  runFile(`
    Whale.bridge = { Report = function(ok, text) REPORTED = { ok = ok, text = text } end, WriteState = function() end }
    GLOBAL.AllRecipes.spear = { name = "spear", product = "spear", materials = false }
    Whale.actions.Start("craft", { recipe = "spear" })
    Whale.actions.Tick()
    assert(REPORTED.ok == false, "材料不够应该失败")
    OUT_TEXT = REPORTED.text
  `)
  assert.match(global('OUT_TEXT'), /材料不够/)
})