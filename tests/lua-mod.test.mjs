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
                   PICK = act("PICK"), PICKUP = act("PICKUP"), HARVEST = act("HARVEST"), ATTACK = act("ATTACK"),
                   EAT = act("EAT"), COOK = act("COOK"), SLEEPIN = act("SLEEPIN"), DROP = act("DROP"),
                   ADDFUEL = act("ADDFUEL"), HEAL = act("HEAL") }
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
  for (const name of ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'observe', 'actions']) {
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
    assert(data.day == 3, "天数不对（cycles=2 时人看到的是第 3 天，和 A 栈观察器同一口径）")
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

test('位置行和坐标数据对得上（不能把 y 当成 z）', async () => {
  // 真机 bug（2026-11-12 审计）：observe 里写的是 U.tile_of(U.pos(p))，
  // U.pos 返回 (x,y,z)，于是 y（离地高度≈0）被当成 z —— 位置永远显示 (x,0)。
  const fengari = await import('fengari')
  const { runFile } = loadMod(fengari)

  runFile(`
    local player = GLOBAL.AllPlayers[1]
    local text, data = Whale.observe.Build(player)
    assert(data.x == 12 and data.z == 45,
        "格子坐标不对：" .. tostring(data.x) .. "," .. tostring(data.z))
    local want = "位置：(" .. data.x .. "," .. data.z .. ")"
    assert(string.find(text, want, 1, true) ~= nil,
        "位置行应该是「" .. want .. "」，实际：\\n" .. text)
  `)
})

test('捡东西：地上掉的东西能用 pickup 捡起来（不然砍树拿不到木头）', async () => {
  const fengari = await import('fengari')
  const { runFile, run, global } = loadMod(fengari)

  run(`
    local log = {
        prefab = "log",
        components = { inventoryitem = { owner = nil } },
        IsValid = function(self) return true end,
        HasTag = function(self, tag) return false end,
        Transform = { GetWorldPosition = function() return 12 * 4 + 4, 0, 45 * 4 + 4 end },
    }
    NEARBY = { log }
  `, '在地上放一根木头')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    local started, err = Whale.actions.Start("pickup", { item = "log", count = 2 })
    assert(started == true, "捡东西应该能开始：" .. tostring(err))
    Whale.actions.Tick()
    assert(PUSHED ~= nil, "应该把动作推给游戏了")
    assert(PUSHED.action.id == "PICKUP", "动作类型不对：" .. tostring(PUSHED.action.id))
    assert(PUSHED.target.prefab == "log", "目标不是地上的木头：" .. tostring(PUSHED.target.prefab))
    BUFFERED = PUSHED
    Whale.actions.Tick()
    NEARBY = {}          -- 捡走了，地上没东西了
    BUFFERED = nil
    Whale.actions.Tick()
    Whale.actions.Tick()
    assert(REPORTED ~= nil and REPORTED.ok == true,
        "应该报告成功，实际：" .. tostring(REPORTED and REPORTED.text))
    assert(Whale.job == nil, "捡完以后不该还挂着任务")
    OUT_TEXT = REPORTED.text
  `)
  assert.match(global('OUT_TEXT'), /捡了 1 个/)
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

test('引擎连砍（一直忙）时，砍倒一棵也要算数并停下来（真机砍了 16 棵才停）', async () => {
  const fengari = await import('fengari')
  const { runFile, global } = loadMod(fengari)

  runFile(`
    Whale.bridge = {
      Report = function(ok, text, id) REPORTED = { ok = ok, text = text, id = id } end,
      WriteState = function() end,
    }
    local tree = nil
    for _, e in ipairs(NEARBY) do
      if e.prefab == "evergreen" then tree = e end
    end
    assert(tree ~= nil, "假环境里应该有一棵树")

    Whale.actions.Start("chop", { count = 1, until_gone = true }, "cmd-A")
    Whale.actions.Tick()
    assert(PUSHED ~= nil and PUSHED.target == tree, "应该推砍树动作")
    -- 引擎"按住动作键"连砍：人物一直 busy，走不到 done_count 那条分支
    BUFFERED = PUSHED
    Whale.actions.Tick()
    Whale.actions.Tick()
    assert(REPORTED == nil, "树还没倒，不该报结果")
    -- 树被砍倒：workable 从 CHOP 变成 DIG（树桩）
    tree.components.workable.action = GLOBAL.ACTIONS.DIG
    tree.components.workable.workleft = 0
    Whale.actions.Tick()
    assert(REPORTED ~= nil and REPORTED.ok == true,
        "砍倒一棵就该报成功，实际：" .. tostring(REPORTED and REPORTED.text))
    assert(string.find(REPORTED.text, "干倒", 1, true) ~= nil,
        "结果里应该说清砍倒了几个：" .. REPORTED.text)
    assert(Whale.job == nil, "count=1 砍倒一棵就该停，实际还在干")
    OUT_TEXT = REPORTED.text
    OUT_ID = REPORTED.id
  `)
  assert.match(global('OUT_TEXT'), /干倒/)
  assert.equal(global('OUT_ID'), 'cmd-A')
})

test('连砍卡住时有总时长出口（不能无限砍下去）', async () => {
  const fengari = await import('fengari')
  const { runFile, run } = loadMod(fengari)

  runFile(`
    -- U.now() 会优先用 TheSim:GetTime()，但它要求 > 0；所以先把假时钟拨离 0，
    -- 否则会掉到 os.time() 那条兜底上，时间基准变了就测不出超时。
    NOW = 1000
    Whale.bridge = {
      Report = function(ok, text, id) REPORTED = { ok = ok, text = text, id = id } end,
      WriteState = function() end,
    }
    Whale.actions.Start("chop", { count = 5, until_gone = true, timeout = 10 }, "cmd-T")
    Whale.actions.Tick()
    BUFFERED = PUSHED
    Whale.actions.Tick()
    NOW = 1060                -- 一直砍不下去，时间过去 60 秒
    Whale.actions.Tick()
    assert(REPORTED ~= nil and REPORTED.ok == false,
        "超时应该老实报失败，实际：" .. tostring(REPORTED and REPORTED.text))
    assert(string.find(REPORTED.text, "超时", 1, true) ~= nil, "要说清是超时：" .. REPORTED.text)
    assert(Whale.job == nil, "超时后要停手")
  `)
  run('BUFFERED = nil', '收拾')
})

test('打断旧动作时，失败要回给「旧」指令，不能挂在新指令头上', async () => {
  const fengari = await import('fengari')
  const { runFile, global } = loadMod(fengari)

  runFile(`
    REPORTS = {}
    Whale.bridge = {
      Report = function(ok, text, id) REPORTS[#REPORTS + 1] = { ok = ok, text = text, id = id } end,
      WriteState = function() end,
    }
    Whale.actions.Start("chop", { count = 1 }, "cmd-OLD")
    Whale.actions.Tick()
    Whale.actions.Start("pickup", { item = "log", count = 1 }, "cmd-NEW")
    assert(#REPORTS >= 1, "旧动作被打断要有个交代")
    assert(REPORTS[1].id == "cmd-OLD",
        "打断的失败必须回给旧指令，实际挂在：" .. tostring(REPORTS[1].id))
    OUT_TEXT = REPORTS[1].text
  `)
  assert.match(global('OUT_TEXT'), /打断/)
})

test('走路时会通知玩家自己的客户端一起走（不然客户端只看到平移，没有动画）', async () => {
  const fengari = await import('fengari')
  const { runFile, run, global } = loadMod(fengari)

  run(`
    SENT = {}
    GLOBAL.GetClientModRPC = function(mod, name) return "rpc:" .. tostring(name) end
    GLOBAL.SendModRPCToClient = function(rpc, userid, a, b, c)
        SENT[#SENT + 1] = { rpc = rpc, userid = userid, a = a, b = b, c = c }
    end
  `, '装上 RPC 桩')

  runFile(`
    local p = GLOBAL.AllPlayers[1]
    p.userid = "KU_123"
    Whale.bridge = {
      Report = function(ok, text, id) REPORTED = { ok = ok, text = text, id = id } end,
      WriteState = function() end,
    }
    -- move_to 会调 walk_to → 服务端走 + 通知客户端
    Whale.actions.Start("move_to", { x = 20, z = 30 }, "cmd-M")
    Whale.actions.Tick()
    assert(#SENT >= 1, "应该给客户端发了 RPC，实际一条都没发")
    local msg = SENT[1]
    assert(msg.rpc == "rpc:walkto", "RPC 名字不对：" .. tostring(msg.rpc))
    assert(msg.userid == "KU_123", "应该只发给这个玩家：" .. tostring(msg.userid))
    OUT_X, OUT_Z, OUT_RUN = msg.a, msg.b, msg.c
    -- 停下时也要通知，不然客户端会一直跑
    Whale.actions.Start("stop", {}, "cmd-S")
    Whale.actions.Tick()
    local stopped = false
    for _, m in ipairs(SENT) do
        if m.rpc == "rpc:walkstop" then stopped = true end
    end
    assert(stopped, "停手时应该通知客户端停下来")
  `)
  // 目标格子 (20,30) 的中心 = 20*4+2, 30*4+2
  assert.equal(Number(global('OUT_X')), 82)
  assert.equal(Number(global('OUT_Z')), 122)
  assert.equal(Number(global('OUT_RUN')), 1, '默认应该是跑（run=1）')
})

test('动作"走过去"那一段不发 walkto：客户端和服务端不能各有一份移动意图', async () => {
  // 真机踩到：动作也通知客户端走 → 客户端把人拖到树上了，服务端 busy 一直 false
  // → chop 报「推不动」。那一段的动画改由客户端的 WatchServerMove 补。
  const fengari = await import('fengari')
  const { runFile, run } = loadMod(fengari)

  run(`
    SENT = {}
    GLOBAL.GetClientModRPC = function(mod, name) return "rpc:" .. tostring(name) end
    GLOBAL.SendModRPCToClient = function(rpc, userid, a, b, c)
        SENT[#SENT + 1] = { rpc = rpc, userid = userid, a = a, b = b, c = c }
    end
  `, '装上 RPC 桩')

  runFile(`
    local p = GLOBAL.AllPlayers[1]
    p.userid = "KU_9"
    Whale.bridge = {
      Report = function(ok, text, id) REPORTED = { ok = ok, text = text, id = id } end,
      WriteState = function() end,
    }
    Whale.actions.Start("chop", { count = 1, until_gone = true }, "cmd-C")
    Whale.actions.Tick()
    assert(PUSHED ~= nil, "应该推了砍树动作")
    for _, m in ipairs(SENT) do
        assert(m.rpc ~= "rpc:walkto", "动作接近目标时不该发 walkto（会和引擎抢移动）")
    end
    -- 心跳也只应该伺候纯走路任务
    assert(Whale.actions.refresh_client_walk(false) == false, "chop 期间的心跳应该什么都不做")
  `)
})

test('走路时每秒补一次"要去哪"，客户端先停下也能跟上', async () => {
  const fengari = await import('fengari')
  const { runFile, run, global } = loadMod(fengari)

  run(`
    SENT = {}
    GLOBAL.GetClientModRPC = function(mod, name) return "rpc:" .. tostring(name) end
    GLOBAL.SendModRPCToClient = function(rpc, userid, a, b, c)
        SENT[#SENT + 1] = { rpc = rpc, userid = userid, a = a, b = b, c = c }
    end
  `, '装上 RPC 桩')

  runFile(`
    local p = GLOBAL.AllPlayers[1]
    p.userid = "KU_9"
    local loco = p.components.locomotor
    -- 假 locomotor：正在往 (100,0,200) 走
    loco.WantsToMoveForward = function() return true end
    loco.WantsToRun = function() return true end
    loco.dest = { GetPoint = function() return 100, 0, 200 end }

    Whale.bridge = { Report = function() end, WriteState = function() end }
    -- 心跳只伺候"纯走路"的任务
    Whale.actions.Start("move_to", { x = 25, z = 50 }, "cmd-H")

    -- 心跳按 tick 计数，每 5 次发一次
    for i = 1, 5 do Whale.actions.refresh_client_walk(false) end
    assert(#SENT >= 1, "走了 5 个 tick 应该补发一次，实际没有")
    OUT_X, OUT_Z = SENT[#SENT].a, SENT[#SENT].b
  `)
  assert.equal(Number(global('OUT_X')), 100)
  assert.equal(Number(global('OUT_Z')), 200)
})

test('添柴：往烧着的火里扔燃料，回来报燃料百分比变化', async () => {
  const fengari = await import('fengari')
  const { runFile, run, global } = loadMod(fengari)

  run(`
    -- 一堆烧到 40% 的火（fuelpct 用闭包，方便中途改）
    local fuelpct = 0.4
    local fire = {
        prefab = "firepit",
        components = { fueled = {
            GetPercent = function() return fuelpct end,
            IsEmpty = function() return false end,
        } },
        IsValid = function() return true end,
        HasTag = function(self, tag) return tag == "fire" end,
        Transform = { GetWorldPosition = function() return 12 * 4 + 6, 0, 45 * 4 + 2 end },
    }
    FIRE = fire
    SET_FIRE_PCT = function(v) fuelpct = v end
    NEARBY = { fire }
    -- 背包里放一块木头（燃料值 4）
    local log = {
        prefab = "log",
        components = { fuel = { fuelvalue = 4 } },
        IsValid = function() return true end,
        HasTag = function() return false end,
        Transform = { GetWorldPosition = function() return 0, 0, 0 end },
    }
    GLOBAL.AllPlayers[1].components.inventory._items[3] = log
  `, '摆一堆火和一块木头')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text, id) REPORTED = { ok = ok, text = text, id = id } end,
      WriteState = function() end,
    }
    Whale.actions.Start("add_fuel", {}, "cmd-F")
    Whale.actions.Tick()
    assert(PUSHED ~= nil, "应该往火里推 ADDFUEL")
    assert(PUSHED.action.id == "ADDFUEL", "动作类型不对：" .. tostring(PUSHED.action.id))
    assert(PUSHED.target ~= nil and PUSHED.target.prefab == "firepit", "目标应该是那堆火")
    assert(PUSHED.invobject ~= nil and PUSHED.invobject.prefab == "log", "应该拿木头当柴")
    -- 火被添柴后到 80%
    SET_FIRE_PCT(0.8)
    Whale.actions.Tick()
    assert(REPORTED ~= nil and REPORTED.ok == true, "应该报成功：" .. tostring(REPORTED and REPORTED.text))
    OUT_TEXT = REPORTED.text
  `)
  assert.match(global('OUT_TEXT'), /40% → 80%/)
})

test('回血：有治疗物品就走 HEAL，指自己；没有就吃东西', async () => {
  const fengari = await import('fengari')
  const { runFile, run, global } = loadMod(fengari)

  run(`
    local salve = {
        prefab = "healing_salve",
        components = { healer = {} },
        IsValid = function() return true end,
        HasTag = function() return false end,
        Transform = { GetWorldPosition = function() return 0, 0, 0 end },
    }
    local p = GLOBAL.AllPlayers[1]
    p.components.inventory._items[3] = salve
  `, '背包里放一瓶药膏')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text, id) REPORTED = { ok = ok, text = text, id = id } end,
      WriteState = function() end,
    }
    local p = GLOBAL.AllPlayers[1]
    Whale.actions.Start("heal", {}, "cmd-H")
    Whale.actions.Tick()
    assert(PUSHED ~= nil, "应该推治疗动作")
    assert(PUSHED.action.id == "HEAL", "治疗物品应该走 HEAL，实际：" .. tostring(PUSHED.action.id))
    assert(PUSHED.target == p, "HEAL 的目标应该是自己")
    assert(PUSHED.invobject.prefab == "healing_salve", "应该用药膏")
    -- 回血 20
    p.components.health.currenthealth = 65
    Whale.actions.Tick()
    assert(REPORTED ~= nil and REPORTED.ok == true, "应该报成功：" .. tostring(REPORTED and REPORTED.text))
    OUT_TEXT = REPORTED.text
  `)
  assert.match(global('OUT_TEXT'), /生命 45 → 65/)
})

test('结果带背包净变化（verify）：只说"干了 N 下"模型会编造', async () => {
  const fengari = await import('fengari')
  const { runFile, global } = loadMod(fengari)

  runFile(`
    Whale.bridge = {
      Report = function(ok, text, id) REPORTED = { ok = ok, text = text, id = id } end,
      WriteState = function() end,
    }
    Whale.actions.Start("say", { text = "hi" }, "cmd-V")
    -- 动作过程中背包多了两根木头
    local inv = GLOBAL.AllPlayers[1].components.inventory
    inv._items[3] = {
        prefab = "log",
        components = { stackable = { StackSize = function() return 2 end } },
        IsValid = function() return true end,
        HasTag = function() return false end,
        Transform = { GetWorldPosition = function() return 0, 0, 0 end },
    }
    Whale.actions.Tick()
    assert(REPORTED ~= nil and REPORTED.ok == true, "应该报成功")
    OUT_TEXT = REPORTED.text
  `)
  assert.match(global('OUT_TEXT'), /背包：log\+2/)
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
CPOSTS = {}
function AddClassPostConstruct(name, fn) CPOSTS[#CPOSTS + 1] = name end
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
    -- M1.0：模块数从 28 降到 8（A 栈的 19 个 + bws_config 已于 SURVIVAL-07 彻底删除）
    -- 用「相对顺序」断言：以后再加模块不用改一串下标
    local function idx(name)
        for i, v in ipairs(MODIMPORTS) do
            if v == name then return i end
        end
        return nil
    end
    assert(MODIMPORTS[1] == "scripts/whale/json.lua", "第一个应该是 json.lua")
    -- M1.0 收敛：只允许 B 栈（scripts/whale）这一条链
    for _, name in ipairs({
        "scripts/whale/json.lua", "scripts/whale/util.lua", "scripts/whale/observe.lua", "scripts/whale/actions.lua",
        "scripts/whale/macros.lua", "scripts/whale/reflex.lua", "scripts/whale/bridge.lua", "scripts/whale/hud.lua",
        -- M1.1：配置出口 + 观察对象唯一入口
        "scripts/whale/config.lua", "scripts/whale/actor.lua",
        -- M1.4：附近实体结构化（独立模块）
        "scripts/whale/nearby.lua",
        -- M2.0：动作安全底座（Lua 侧最终授权者）
        "scripts/whale/guard.lua",
    }) do
        assert(idx(name) ~= nil, "少了 modimport：" .. name)
    end
    -- 防回归：A 栈（scripts/main）已于 SURVIVAL-07 彻底删除，绝不能再被 modimport 回来。
    -- 要恢复某一段（比如 M4 的战斗 Kiting），必须单独评估、单独加载，不能整条链一起起。
    for _, name in ipairs(MODIMPORTS) do
        assert(not string.find(name, "scripts/main/", 1, true), "A 栈模块又进了运行链：" .. name)
        assert(name ~= "bws_config.lua", "bws_config.lua（A 栈的 token 文件）不该再加载")
    end
    assert(#MODIMPORTS == 18, "只该 modimport 18 个 B 栈模块（SURVIVAL-01 起多了 gather/eat/craft/equip rules），实际 " .. #MODIMPORTS)
    assert(idx("scripts/whale/util.lua") < idx("scripts/whale/config.lua"), "config 要在 util 之后")
assert(idx("scripts/whale/util.lua") < idx("scripts/whale/pickuprules.lua"), "pickuprules 要在 util 之后")
assert(idx("scripts/whale/pickuprules.lua") < idx("scripts/whale/nearby.lua"), "pickuprules 必须在 nearby 之前（观察侧要用）")
assert(idx("scripts/whale/harvestrules.lua") < idx("scripts/whale/nearby.lua"), "harvestrules 必须在 nearby 之前（观察侧要用）")
assert(idx("scripts/whale/harvestrules.lua") < idx("scripts/whale/guard.lua"), "harvestrules 必须在 guard 之前（执行侧要用）")
assert(idx("scripts/whale/pickuprules.lua") < idx("scripts/whale/guard.lua"), "pickuprules 必须在 guard 之前（执行侧要用）")
    assert(idx("scripts/whale/config.lua") < idx("scripts/whale/actor.lua"), "actor 要在 config 之后")
    assert(idx("scripts/whale/actor.lua") < idx("scripts/whale/observe.lua"), "观察器要在 Actor Provider 之后")
    assert(idx("scripts/whale/nearby.lua") < idx("scripts/whale/observe.lua"), "附近实体模块要在观察器之前")
    assert(idx("scripts/whale/nearby.lua") < idx("scripts/whale/guard.lua"), "guard 要用 nearby")
    assert(idx("scripts/whale/guard.lua") < idx("scripts/whale/bridge.lua"), "文件桥要用 guard")
    assert(idx("scripts/whale/util.lua") < idx("scripts/whale/observe.lua"), "util 要在观察之前")
    assert(idx("scripts/whale/observe.lua") < idx("scripts/whale/actions.lua"), "观察要在动作之前")
    assert(idx("scripts/whale/actions.lua") < idx("scripts/whale/macros.lua"), "宏要加载在动作之后")
    assert(idx("scripts/whale/macros.lua") < idx("scripts/whale/bridge.lua"), "宏要在文件桥之前")
    assert(idx("scripts/whale/reflex.lua") < idx("scripts/whale/bridge.lua"), "反射层要在文件桥之前")
    assert(idx("scripts/whale/hud.lua") == #MODIMPORTS, "hud 要最后")
    assert(#POSTINITS == 3, "应该有 3 个 postinit，实际 " .. #POSTINITS)
    assert(CPOSTS[1] == "screens/playerhud", "应该往玩家 HUD 上挂小窗")
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
test('HUD 模块能在沙箱里加载，F8 会写出开关', async () => {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const fail = () => {
    try {
      return to_jsstring(lua.lua_tostring(L, -1))
    } catch {
      return ''
    }
  }
  const prelude = `
GLOBAL = { KEY_F7 = 288, KEY_F8 = 289, ANCHOR_LEFT = 0, ANCHOR_MIDDLE = 2, ANCHOR_TOP = 3,
           DEFAULTFONT = "opensans", SCALEMODE_PROPORTIONAL = 1 }
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.os = os
GLOBAL.io = nil
GLOBAL.TheSim = { SetPersistentString = function(self, name, text, enc) WRITTEN[name] = text end,
                  GetPersistentString = function(self, name, cb) cb(false, nil) end }
GLOBAL.ThePlayer = { components = {} }
WRITTEN = {}
KEYHANDLERS = {}
GLOBAL.TheInput = { AddKeyHandler = function(self, fn) KEYHANDLERS[#KEYHANDLERS + 1] = fn end }
local function fakewidget() return { SetPosition = function() end, SetSize = function() end, SetTint = function() end,
    SetString = function() end, SetHAlign = function() end, SetVAlign = function() end, SetColour = function() end,
    SetHAnchor = function() end, SetVAnchor = function() end, SetScaleMode = function() end,
    AddChild = function(self, c) return c end, Kill = function() end } end
package.loaded["widgets/widget"] = function() return setmetatable({}, { __call = function() return fakewidget() end }) end
package.loaded["widgets/text"] = function() return setmetatable({}, { __call = function() return fakewidget() end }) end
package.loaded["widgets/image"] = function() return setmetatable({}, { __call = function() return fakewidget() end }) end
Whale = { files = {}, util = { log = function() end } }
`
  let status = lauxlib.luaL_dostring(L, to_luastring(prelude))
  assert.equal(status, lua.LUA_OK, '前置环境出错：' + fail())
  // 沙箱：裸 pcall/tonumber/error 是 nil
  status = lauxlib.luaL_dostring(L, to_luastring('pcall = nil\ntonumber = nil\nerror = nil\nos = nil\nio = nil'))
  assert.equal(status, lua.LUA_OK, '没法模拟沙箱：' + fail())

  const json = readFileSync(join(MOD, 'scripts', 'whale', 'json.lua'), 'utf8')
  status = lauxlib.luaL_dostring(L, to_luastring(json))
  assert.equal(status, lua.LUA_OK, 'json.lua 加载失败：' + fail())
  const hud = readFileSync(join(MOD, 'scripts', 'whale', 'hud.lua'), 'utf8')
  status = lauxlib.luaL_dostring(L, to_luastring(hud))
  assert.equal(status, lua.LUA_OK, 'hud.lua 加载失败（游戏里会看不到小窗）：' + fail())

  lauxlib.luaL_loadstring(L, to_luastring(`
    assert(Whale.hud ~= nil, "hud 模块没装上")
    assert(type(Whale.hud.BindKeys) == "function", "少了 BindKeys")
    assert(type(Whale.hud.Attach) == "function", "少了 Attach")
    Whale.hud.BindKeys()
    assert(#KEYHANDLERS == 1, "应该绑一个按键处理器，实际 " .. #KEYHANDLERS)
    -- 按 F8：应该写出一份 "让 AI 开始玩" 的开关
    KEYHANDLERS[1](GLOBAL.KEY_F8, true)
    local raw = WRITTEN["whale_toggle.json"]
    assert(raw ~= nil, "F8 应该写出开关文件")
    local data = Whale.json.decode(raw)
    assert(data.ai == true, "F8 应该把 ai 打开")
    -- 再按一次：关掉
    KEYHANDLERS[1](GLOBAL.KEY_F8, true)
    local data2 = Whale.json.decode(WRITTEN["whale_toggle.json"])
    assert(data2.ai == false, "再按一次应该关掉")
    -- 按 F7：停手
    KEYHANDLERS[1](GLOBAL.KEY_F7, true)
    local data3 = Whale.json.decode(WRITTEN["whale_toggle.json"])
    assert(data3.stop == true and data3.ai == false, "F7 应该是停手")
    -- 服务端挪人时的"补动画"判定（纯视觉，不参与移动）
    assert(type(Whale.hud.anim_for) == "function", "少了 anim_for")
    assert(Whale.hud.anim_for(8, true) == nil, "自己在走的时候别插手，交给状态机")
    assert(Whale.hud.anim_for(8, false) == "run_loop", "服务端在挪我，应该自己播跑步")
    assert(Whale.hud.anim_for(0.1, false) == "idle_loop", "停下了就应该回 idle")
    assert(Whale.hud.anim_for(nil, false) == "idle_loop", "还测不出速度时按停着算")
    OUT = "ok"
  `))
  assert.equal(lua.lua_pcall(L, 0, 0, 0), lua.LUA_OK, 'HUD 行为不对：' + fail())
})

// ═══════════ OBSERVATION-02：Nearby 编号复用 + gather_area 接近距离 ═══════════

/**
 * 造一个最小可用实体。
 * 注意 pickable 必须带 caninteractwith = true —— harvestrules.IsReady 会读它
 * （scripts/whale/harvestrules.lua:134），少了就判 target_not_harvestable。
 */
const ENT_HELPER = `
function mkent(prefab, guid, x, z, ready)
    local e = { prefab = prefab, GUID = guid, components = {}, _x = x, _z = z }
    function e:IsValid() return true end
    function e:IsInLimbo() return false end
    function e:HasTag(t) return false end
    function e:GetDistanceSqToInst(o) local dx, dz = e._x - o._x, e._z - o._z; return dx * dx + dz * dz end
    e.Transform = { GetWorldPosition = function() return e._x, 0, e._z end }
    e.components.pickable = {
        caninteractwith = true,
        CanBePicked = function() return ready ~= false end,
        IsStuck = function() return false end,
        IsBarren = function() return false end,
    }
    return e
end
`

test('OBS2-1：附近内容没变 → Nearby 快照 ID 复用（否则模型手里的 #N 必然过期）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  run(`
    ACTOR = mkent("wilson", 1, 0, 0)
    BUSH = mkent("berrybush", 2, 20, 0)
    NEARBY = { BUSH }
  `, '放一丛浆果')

  runFile(`
    local opts = { radius = 16, scan_seconds = 1, max_total = 60, max_per_bucket = 12, force = true }
    ID_A = Whale.nearby.Observe(ACTOR, {}, 1, opts).snapshot_id
    ID_B = Whale.nearby.Observe(ACTOR, {}, 1.5, opts).snapshot_id
    ID_C = Whale.nearby.Observe(ACTOR, {}, 5, opts).snapshot_id
  `)
  const a = global('ID_A')
  assert.ok(a, '应该拿到 snapshot_id')
  assert.equal(global('ID_B'), a, '内容没变时第二次必须复用同一个 id（真机就栽在这）')
  assert.equal(global('ID_C'), a, '第三次也一样')
})

test('OBS2-2：附近内容变了 → 换新编号（stale_snapshot 没有被放宽）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  run(`
    ACTOR = mkent("wilson", 1, 0, 0)
    BUSH = mkent("berrybush", 2, 20, 0)
    BUSH2 = mkent("berrybush", 3, 24, 0)
    NEARBY = { BUSH }
  `, '一丛浆果')

  runFile(`
    local opts = { radius = 16, scan_seconds = 1, max_total = 60, max_per_bucket = 12, force = true }
    ID_1 = Whale.nearby.Observe(ACTOR, {}, 1, opts).snapshot_id
    NEARBY = { BUSH, BUSH2 }        -- 多了一丛：编号必须换
    ID_2 = Whale.nearby.Observe(ACTOR, {}, 2, opts).snapshot_id
    local ent, why = Whale.nearby.Resolve(ID_1, "#1")
    OLD_WHY = why
  `)
  assert.notEqual(global('ID_2'), global('ID_1'), '内容变了必须换编号')
  assert.equal(global('OLD_WHY'), 'stale_snapshot', '旧编号必须失效（fail-closed 没变）')
})

test('OBS2-3：实体只是移动了 → 也换新编号（位置进了指纹）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  run(`
    ACTOR = mkent("wilson", 1, 0, 0)
    BUSH = mkent("berrybush", 2, 20, 0)
    NEARBY = { BUSH }
  `, '一丛浆果')

  runFile(`
    local opts = { radius = 16, scan_seconds = 1, max_total = 60, max_per_bucket = 12, force = true }
    ID_1 = Whale.nearby.Observe(ACTOR, {}, 1, opts).snapshot_id
    BUSH._x = BUSH._x + 8          -- 挪了 2 格
    ID_2 = Whale.nearby.Observe(ACTOR, {}, 2, opts).snapshot_id
  `)
  assert.notEqual(global('ID_2'), global('ID_1'), '位置变了必须换编号（引用的是"那一格的东西"）')
})

test('OBS2-4：gather_area 目标太远时先走过去，不许隔着老远推动作', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  // 玩家在 (12*4+2, 45*4+2)；把这丛浆果放到 20 格（80 单位）之外
  run(`
    FAR = mkent("berrybush", 77, 12 * 4 + 2 + 80, 45 * 4 + 2)
    NEARBY = { FAR }
  `, '远处放一丛浆果')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    PUSHED = nil
    MOVED_TO = nil
    local ctx = { survival_area = true, radius = 12, limit = 3 }
    local started, err = Whale.actions.Start("gather_area", { radius = 12, limit = 3 }, "c-far", ctx)
    assert(started == true, "应该能开始：" .. tostring(err))
    Whale.actions.Tick()
    -- 注意：fengari 的 global() 读 Lua 布尔拿到的不一定是 JS 布尔，统一转成字符串比
    OUT_NO_PUSH = tostring(PUSHED == nil)   -- 关键：不许推
    OUT_MOVED = tostring(MOVED_TO ~= nil)   -- 应该去走
    OUT_HAS_JOB = tostring(Whale.job ~= nil)

  `)
  assert.equal(global('OUT_NO_PUSH'), 'true', '离 20 格远时不该推动作（真机就是这么砍空气的）')
  assert.equal(global('OUT_MOVED'), 'true', '应该往目标走（GoToPoint）')
  assert.equal(global('OUT_HAS_JOB'), 'true', '任务应该还挂着')
})

test('OBS2-5：gather_area 一个都没采到 → 报失败，不许报"做完了"', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  run(`
    -- 就在脚边，但"现在不能采"（CanBePicked=false → not_ready）
    BUSH = mkent("berrybush", 5, 12 * 4 + 2 + 4, 45 * 4 + 2, false)
    NEARBY = { BUSH }
  `, '放一丛没成熟的浆果')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    PUSHED = nil
    local ctx = { survival_area = true, radius = 12, limit = 3 }
    Whale.actions.Start("gather_area", { radius = 12, limit = 3 }, "c-none", ctx)
    for i = 1, 30 do
        if Whale.job == nil then break end
        Whale.actions.Tick()
    end
    OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok == true)
    OUT_TEXT = REPORTED ~= nil and REPORTED.text or ""
    OUT_NO_PUSH = tostring(PUSHED == nil)
  `)
  assert.equal(global('OUT_OK'), 'false', '一个都没采到必须是失败（不能让 dispatcher 报"做完了但没核对上"）')
  assert.equal(global('OUT_NO_PUSH'), 'true', '没成熟的东西不该被推去采')
  const text = String(global('OUT_TEXT'))
  assert.match(text, /采了 0 个/, '失败文案要说清采了 0 个')
  assert.match(text, /not_ready|没成熟|够不着/, `失败文案要讲原因，实际：${text}`)
})

// ═══════════ SURVIVAL-08：recipes 崩溃 + 多步动作超预算 ═══════════

test('S8-1：recipes 不再崩（真机是 U.g 不存在 → attempt to call field g）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  run('NEARBY = {}', '附近空')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    -- 假 builder 默认没有 CanBuild（真机有）；这里补上，让"能做/差材料"两条路都走到
    local p = GLOBAL.AllPlayers[1]
    p.components.builder.CanBuild = function(self, name) return name == "torch" end
    local ctx = { limit = 10 }
    local started, err = Whale.actions.Start("recipes", { limit = 10 }, "c-recipes", ctx)
    assert(started == true, "recipes 应该能开始：" .. tostring(err))
    for i = 1, 10 do
        if Whale.job == nil then break end
        Whale.actions.Tick()
    end
    OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok == true)
    OUT_TEXT = REPORTED ~= nil and REPORTED.text or ""
  `)
  assert.equal(global('OUT_OK'), 'true', `recipes 不该报错，实际：${global('OUT_TEXT')}`)
  const text = String(global('OUT_TEXT'))
  assert.match(text, /torch/, '应该列出 STUB 里的 torch 配方')
  assert.match(text, /campfire/, '应该列出 campfire')
  assert.match(text, /能做|差材料|科技/, '每条要带状态')
  assert.ok(!/attempt to call/.test(text), '不许再出现 U.g 那种崩溃')
})

test('S8-2：lookup 也不崩，并且会说"还差什么材料"', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  run('NEARBY = {}', '附近空')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    local p = GLOBAL.AllPlayers[1]
    p.components.builder.CanBuild = function(self, name) return false end
    local ctx = { lookup_query = "torch" }
    Whale.actions.Start("lookup", { q = "torch" }, "c-lookup", ctx)
    for i = 1, 10 do
        if Whale.job == nil then break end
        Whale.actions.Tick()
    end
    OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok == true)
    OUT_TEXT = REPORTED ~= nil and REPORTED.text or ""
  `)
  assert.equal(global('OUT_OK'), 'true', `lookup 不该报错，实际：${global('OUT_TEXT')}`)
  const text = String(global('OUT_TEXT'))
  assert.match(text, /torch/, '要提到 torch')
  assert.ok(!/attempt to call/.test(text), '不许出现崩溃')
})

test('S8-3：多步动作超过外层预算 → 自己收尾报 budget_exceeded，不许被砍成 result_timeout', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  // 目标在 20 格外：gather_area 会一直走，不会自然结束
  run(`
    FAR = mkent("berrybush", 91, 12 * 4 + 2 + 80, 45 * 4 + 2)
    NEARBY = { FAR }
  `, '远处放一丛浆果')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    PUSHED = nil
    -- 注意：U.now() 只在 TheSim:GetTime() > 0 时才用它（否则回退到系统时钟）。
    -- 所以先把 NOW 设成正数，后面推进它才有效 —— 否则测的是墙钟、推进 NOW 毫无作用。
    NOW = 100
    -- 外层只给 1 秒预算（真机是 120 秒外层 / 240 秒内层，必然被砍）
    local ctx = { survival_area = true, radius = 12, limit = 3, budget_s = 1 }
    Whale.actions.Start("gather_area", { radius = 12, limit = 3 }, "c-budget", ctx)
    Whale.actions.Tick()          -- start → next → 走路
    OUT_STILL_RUNNING = tostring(Whale.job ~= nil)
    NOW = NOW + 5                 -- 假装过了 5 秒（超过 1 秒预算）
    Whale.actions.Tick()          -- 这次必须被预算兜底截住
    OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok == true)
    OUT_TEXT = REPORTED ~= nil and REPORTED.text or ""
    OUT_JOB_CLEARED = tostring(Whale.job == nil)
  `)
  assert.equal(global('OUT_STILL_RUNNING'), 'true', '第一步应该还在跑（走路中）')
  assert.equal(global('OUT_OK'), 'false', '超预算必须报失败，不能报成功')
  const text = String(global('OUT_TEXT'))
  assert.match(text, /budget_exceeded/, `要说清是超预算，实际：${text}`)
  assert.match(text, /上限 1 秒/, '要报出预算是多少')
  assert.equal(global('OUT_JOB_CLEARED'), 'true', '报完必须把任务清掉，不能挂着')
})

test('S8-4：预算够用时不该误伤（正常做完就是成功）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  // 脚边一丛成熟浆果：一次就能采完
  run(`
    NEAR = mkent("berrybush", 92, 12 * 4 + 2 + 4, 45 * 4 + 2)
    NEAR.components.pickable.CanBePicked = function() return true end
    NEAR.components.pickable.Pick = function() end
    NEARBY = { NEAR }
  `, '脚边放一丛成熟浆果')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    PUSHED = nil
    local ctx = { survival_area = true, radius = 12, limit = 1, budget_s = 60 }
    Whale.actions.Start("gather_area", { radius = 12, limit = 1 }, "c-ok", ctx)
    for i = 1, 40 do
        if Whale.job == nil then break end
        Whale.actions.Tick()
        -- 采完之后 CanBePicked 变 false（模拟真机），推进状态机
        if BUFFERED ~= nil or PUSHED ~= nil then
            NEAR.components.pickable.CanBePicked = function() return false end
        end
    end
    OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok == true)
    OUT_TEXT = REPORTED ~= nil and REPORTED.text or ""
  `)
  const text = String(global('OUT_TEXT'))
  assert.ok(!/budget_exceeded/.test(text), `预算充足时不该报超预算，实际：${text}`)
  // ★ 这几条是补上的：原来只查"不是超预算"，结果漏掉了真机的崩溃
  //   （current 存了候选表 → cur:IsValid() → attempt to call method 'IsValid'）
  assert.equal(global('OUT_OK'), 'true', `脚边有成熟浆果时必须采成功，实际：${text}`)
  assert.match(text, /采了 [1-9]/, `要真的采到，实际：${text}`)
  assert.ok(!/attempt to call/.test(text), `不许出 Lua 崩溃，实际：${text}`)
  assert.ok(!/动作出错/.test(text), `不许报"动作出错"，实际：${text}`)
})

test('S8-5：目标就在脚边（不走 walking 直接 acting）也不能崩 —— 真机 Cluster_1 的崩溃点', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  // 距离 1 格（4 单位）：远小于 APPROACH_UNITS(6.4) → next 直接进 acting
  run(`
    NEAR = mkent("berrybush", 93, 12 * 4 + 2 + 4, 45 * 4 + 2)
    NEAR.components.pickable.CanBePicked = function() return true end
    NEARBY = { NEAR }
  `, '脚边 1 格放一丛成熟浆果')

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    PUSHED = nil
    local ctx = { survival_area = true, radius = 12, limit = 1, budget_s = 60 }
    Whale.actions.Start("gather_area", { radius = 12, limit = 1 }, "c-near", ctx)
    local pushed_once = false
    for i = 1, 40 do
        if Whale.job == nil then break end
        Whale.actions.Tick()
        if PUSHED ~= nil and not pushed_once then
            pushed_once = true
            PUSHED_TARGET_OK = tostring(PUSHED.target ~= nil and PUSHED.target.prefab == "berrybush")
            -- 采成功：CanBePicked 翻成 false
            NEAR.components.pickable.CanBePicked = function() return false end
        end
    end
    OUT_OK = tostring(REPORTED ~= nil and REPORTED.ok == true)
    OUT_TEXT = REPORTED ~= nil and REPORTED.text or ""
    OUT_PUSHED = tostring(pushed_once)
  `)
  assert.equal(global('OUT_PUSHED'), 'true', '应该真的推了 PICK 动作')
  assert.equal(global('PUSHED_TARGET_OK'), 'true', '推的动作目标要对着那丛浆果')
  assert.equal(global('OUT_OK'), 'true', `不该崩、应该采成功，实际：${global('OUT_TEXT')}`)
  assert.ok(!/attempt to call/.test(String(global('OUT_TEXT'))), '不许出 IsValid 那类崩溃')
})
