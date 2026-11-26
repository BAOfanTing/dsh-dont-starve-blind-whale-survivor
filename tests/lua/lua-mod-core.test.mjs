// Lua 模组核心加载、观察状态构建、动作通道与 HUD 集成测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { MOD, loadMod, ENT_HELPER } from '../helpers/lua-mod-harness.mjs'

for (const inLight of [false, true, null]) {
  test(`观察光照：in_light=${inLight} 不被附近光源猜测替代`, async () => {
    const env = loadMod(await import('fengari'))
    env.run(`PLAYER.IsInLight = ${inLight === null ? 'nil' : `function() return ${inLight} end`}`)
    env.runFile('OUT = Whale.json.encode(Whale.observe.BuildData(PLAYER, { seq = 1, now = 1000 }))')
    const data = JSON.parse(env.global('OUT'))
    assert.equal(data.player.in_light, inLight ?? undefined)
    assert.equal(data.observer.unavailable_fields.includes('player.in_light'), inLight === null)
    const { normalizeState, toJsonPayload } = await import('../../lib/state/snapshot.js')
    const snapshot = normalizeState({ data }, { ageMs: 0 })
    assert.equal(toJsonPayload(snapshot).player.in_light, inLight ?? undefined)
  })
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
        -- guard 的白名单规格（必须先于 guard 加载）
        "scripts/whale/guard_specs.lua",
        -- M2.0：动作安全底座（Lua 侧最终授权者）
        "scripts/whale/guard.lua",
        -- R8.2：角色 Profile（温蒂首发）
        "scripts/whale/character/base-profile.lua",
        "scripts/whale/character/profiles/wendy.lua",
        "scripts/whale/character/profile-registry.lua",
        "scripts/whale/character/companion.lua",
    }) do
        assert(idx(name) ~= nil, "少了 modimport：" .. name)
    end
    -- 防回归：A 栈（scripts/main）已于 SURVIVAL-07 彻底删除，绝不能再被 modimport 回来。
    -- 要恢复某一段（比如 M4 的战斗 Kiting），必须单独评估、单独加载，不能整条链一起起。
    for _, name in ipairs(MODIMPORTS) do
        assert(not string.find(name, "scripts/main/", 1, true), "A 栈模块又进了运行链：" .. name)
        assert(name ~= "bws_config.lua", "bws_config.lua（A 栈的 token 文件）不该再加载")
    end
    assert(#MODIMPORTS == 26, "只该 modimport 26 个 B 栈模块（R8.2 +4 角色模块），实际 " .. #MODIMPORTS)
    assert(idx("scripts/whale/util.lua") < idx("scripts/whale/config.lua"), "config 要在 util 之后")
assert(idx("scripts/whale/util.lua") < idx("scripts/whale/pickuprules.lua"), "pickuprules 要在 util 之后")
assert(idx("scripts/whale/pickuprules.lua") < idx("scripts/whale/nearby.lua"), "pickuprules 必须在 nearby 之前（观察侧要用）")
assert(idx("scripts/whale/harvestrules.lua") < idx("scripts/whale/nearby.lua"), "harvestrules 必须在 nearby 之前（观察侧要用）")
assert(idx("scripts/whale/harvestrules.lua") < idx("scripts/whale/guard.lua"), "harvestrules 必须在 guard 之前（执行侧要用）")
assert(idx("scripts/whale/guard_specs.lua") < idx("scripts/whale/guard.lua"), "guard_specs 必须在 guard 之前（guard 要读它）")
assert(idx("scripts/whale/pickuprules.lua") < idx("scripts/whale/guard.lua"), "pickuprules 必须在 guard 之前（执行侧要用）")
-- TARGET-REFRESH：targetrules 依赖 pickuprules/harvestrules/eatrules，且 nearby/guard 都要用它
assert(idx("scripts/whale/eatrules.lua") < idx("scripts/whale/targetrules.lua"), "targetrules 要在 eatrules 之后（用 AUTO_SAFE）")
assert(idx("scripts/whale/harvestrules.lua") < idx("scripts/whale/targetrules.lua"), "targetrules 要用 harvestrules")
assert(idx("scripts/whale/pickuprules.lua") < idx("scripts/whale/targetrules.lua"), "targetrules 要用 pickuprules")
assert(idx("scripts/whale/targetrules.lua") < idx("scripts/whale/nearby.lua"), "targetrules 必须在 nearby 之前（渲染句柄）")
assert(idx("scripts/whale/targetrules.lua") < idx("scripts/whale/guard.lua"), "targetrules 必须在 guard 之前（实时选目标）")
    assert(idx("scripts/whale/config.lua") < idx("scripts/whale/actor.lua"), "actor 要在 config 之后")
    assert(idx("scripts/whale/actor.lua") < idx("scripts/whale/observe.lua"), "观察器要在 Actor Provider 之后")
    assert(idx("scripts/whale/actor.lua") < idx("scripts/whale/character/base-profile.lua"), "角色 Profile 要在 actor 之后")
    assert(idx("scripts/whale/character/base-profile.lua") < idx("scripts/whale/character/profiles/wendy.lua"), "wendy 要在 base 之后")
    assert(idx("scripts/whale/character/profiles/wendy.lua") < idx("scripts/whale/character/profile-registry.lua"), "registry 要在 wendy 之后")
    assert(idx("scripts/whale/character/profile-registry.lua") < idx("scripts/whale/character/companion.lua"), "companion 要在 registry 之后")
    assert(idx("scripts/whale/character/companion.lua") < idx("scripts/whale/nearby.lua"), "角色模块要在 nearby 之前")
    assert(idx("scripts/whale/character/companion.lua") < idx("scripts/whale/battle.lua"), "角色模块要在 battle 之前")
    assert(idx("scripts/whale/nearby.lua") < idx("scripts/whale/observe.lua"), "附近实体模块要在观察器之前")
    assert(idx("scripts/whale/nearby.lua") < idx("scripts/whale/guard.lua"), "guard 要用 nearby")
    assert(idx("scripts/whale/guard.lua") < idx("scripts/whale/bridge.lua"), "文件桥要用 guard")
    assert(idx("scripts/whale/util.lua") < idx("scripts/whale/observe.lua"), "util 要在观察之前")
    assert(idx("scripts/whale/observe.lua") < idx("scripts/whale/native.lua"), "native 要在 observe 之后（它用 Whale.util / 附近实体）")
    assert(idx("scripts/whale/native.lua") < idx("scripts/whale/actions.lua"), "native 要在 actions 之前（玩家攻击走它）")
    assert(idx("scripts/whale/native.lua") < idx("scripts/whale/reflex.lua"), "native 要在 reflex 之前（照明/逃跑走它）")
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

test('做火把：自动装备到手上必须算成功，不能说“成品消失”', async () => {
  const fengari = await import('fengari')
  const { runFile, global } = loadMod(fengari)

  runFile(`
    Whale.bridge = {
      Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
      WriteState = function() end,
    }
    Whale.craftrules.MissingIngredients = function() return nil end
    local inv = PLAYER.components.inventory
    inv._equipped[GLOBAL.EQUIPSLOTS.HANDS] = nil
    -- 模拟 DST 原生 DoBuild：空手做 equippable 成品时直接装备，不放进背包。
    PLAYER.components.builder.MakeRecipe = function(self, recipe, pt, rot, skin)
        CRAFTED[#CRAFTED + 1] = { name = recipe.name, pt = pt }
        inv._equipped[GLOBAL.EQUIPSLOTS.HANDS] = { prefab = "torch", components = {} }
        BUFFERED = { action = { id = "BUILD" } }
        return true
    end
    Whale.actions.Start("craft", { recipe = "torch" }, "cmd-1",
        { survival_craft = true, recipe = "torch" })
    BUFFERED = nil
    Whale.actions.Tick()          -- MakeRecipe：火把直接上手
    BUFFERED = nil
    Whale.actions.Tick()          -- 核对：背包没多，但手上多了 torch
    assert(REPORTED ~= nil and REPORTED.ok == true,
        "自动装备必须算成功，实际：" .. tostring(REPORTED and REPORTED.text))
    assert(string.find(REPORTED.text, "自动拿在手里", 1, true) ~= nil,
        "回执要明确告诉模型成品在手上：" .. REPORTED.text)
    OUT_TEXT = REPORTED.text
  `)
  assert.match(global('OUT_TEXT'), /torch/)
})

test('吃：自动挑食物跳过生蘑菇/怪物肉，手动仍可指定红蘑菇', async () => {
  const fengari = await import('fengari')
  const { runFile, global } = loadMod(fengari)

  runFile(`
    local function food(prefab, hunger)
        return {
            prefab = prefab,
            components = { edible = { hungervalue = hunger, healthvalue = 0 } },
            IsValid = function(self) return true end,
        }
    end
    local inv = {
        items = {
            food("green_cap", 12.5),      -- 生绿蘑菇：-50 理智，自动挑时必须跳过
            food("red_cap", 12.5),        -- 生红蘑菇：-20 血
            food("monstermeat", 25),      -- 怪物肉：掉理智/血
            food("berries", 9.375),
        },
    }
    function inv:ForEachItem(fn)
        for _, item in pairs(self.items) do fn(item) end
    end
    local best = Whale.eatrules.PickBest(inv)
    BEST = best ~= nil and best.prefab or "nil"
    MANUAL_RED = tostring(select(1, Whale.eatrules.IsAllowedPrefab("red_cap")))
    COOKED_OK = tostring(select(1, Whale.eatrules.IsAllowedPrefab("meat_cooked")))
    local function food2(prefab, hunger, health)
        return { prefab = prefab, components = { edible = { hungervalue = hunger, healthvalue = health } },
                 IsValid = function(self) return true end }
    end
    local inv2 = { items = { food2("berries", 9.375, 0), food2("meat_cooked", 25, 20) } }
    function inv2:ForEachItem(fn) for _, item in pairs(self.items) do fn(item) end end
    BEST_HEALING = Whale.eatrules.PickBest(inv2).prefab
  `)
  assert.equal(global('BEST'), 'berries', '自动进食只能从 AUTO_SAFE 里挑，不能选生蘑菇/怪物肉')
  assert.equal(global('MANUAL_RED'), 'true', '手动 eat red_cap 仍然可以（但不会自动挑）')
  assert.equal(global('COOKED_OK'), 'true', '烤过的食物必须能吃（否则 AI 烤完等于白烤）')
  assert.equal(global('BEST_HEALING'), 'meat_cooked', '有熟肉时应该优先吃回血多的')
})

test('reflex：血少时自动进食走安全白名单，不碰怪物肉/生蘑菇', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(readFileSync(join(MOD, 'scripts', 'whale', 'reflex.lua'), 'utf8'), 'reflex.lua')

  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    Whale.bridge = {
        Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
        WriteState = function() end,
    }
    local function fakefood(prefab, hunger)
        return {
            prefab = prefab,
            components = { edible = { hungervalue = hunger, healthvalue = 0 } },
            IsValid = function(self) return true end,
        }
    end
    local inv = PLAYER.components.inventory
    inv._items[3] = fakefood("green_cap", 12.5)
    inv._items[4] = fakefood("monstermeat", 25)
    inv._items[5] = fakefood("carrot", 12.5)
    inv._items[5].components.edible.healthvalue = 1
    PLAYER.components.health.currenthealth = 30   -- 20%：触发 reflex_heal
    for _ = 1, 5 do Whale.reflex.Tick() end           -- 内部 1 秒节流（每 5 次 tick）
    JOB_NAME = Whale.job ~= nil and Whale.job.name or "nil"
    Whale.actions.Tick()                               -- 真正挑食物并推 EAT
    PICKED = PUSHED ~= nil and PUSHED.invobject and PUSHED.invobject.prefab or "nil"
  `)
  assert.equal(global('JOB_NAME'), 'eat', '血少且没有治疗物品时应该启动安全进食')
  assert.equal(global('PICKED'), 'carrot', '回血进食必须跳过零回血食物、生绿蘑菇和怪物肉')
})

test('reflex：已放置的南瓜灯即使还带 inventoryitem 也算光源', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(readFileSync(join(MOD, 'scripts', 'whale', 'reflex.lua'), 'utf8'), 'reflex.lua')

  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    Whale.bridge = {
        Report = function(ok, text) REPORTED = { ok = ok, text = text } end,
        WriteState = function() end,
    }
    GLOBAL.TheWorld.state.phase = "night"
    PLAYER.components.health.currenthealth = 150
    PLAYER.components.hunger.current = 150
    PLAYER.components.sanity.current = 200
    local inv = PLAYER.components.inventory
    inv._equipped = {}
    inv._items[1] = {
        prefab = "torch",
        components = {},
        IsValid = function() return true end,
    }
    local lantern = {
        prefab = "pumpkin_lantern",
        components = { inventoryitem = {}, light = {} },
        _x = PLAYER._x + 4 * 4,
        _z = PLAYER._z,
        Transform = { GetWorldPosition = function(self)
            return PLAYER._x + 4 * 4, 0, PLAYER._z
        end },
        IsValid = function() return true end,
        HasTag = function(self, tag) return tag == "light" end,
    }
    NEARBY = { lantern }
    PLAYER.IsInLight = function() return true end
    for _ = 1, 5 do Whale.reflex.Tick() end
    EQUIPPED = inv:GetEquippedItem(GLOBAL.EQUIPSLOTS.HANDS) ~= nil and "yes" or "no"
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
  `)

  assert.equal(global('EQUIPPED'), 'no', '有南瓜灯时不该再掏火把')
  assert.equal(global('JOB'), 'nil', '有南瓜灯时不该启动做火把/营火任务')
})

test('reflex：正在被怪打时，打断模型任务先撤（不再等任务跑完）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(readFileSync(join(MOD, 'scripts', 'whale', 'reflex.lua'), 'utf8'), 'reflex.lua')

  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    Whale.bridge = {
        Report = function(ok, text, id) REPORTED = { ok = ok, text = text, id = id } end,
        WriteState = function() end,
    }
    -- 模型正在跑一个低价值任务
    Whale.actions.Start("wait", { seconds = 10 }, "model-1")
    BEFORE = Whale.job ~= nil and Whale.job.name or "nil"
    -- 一只青蛙贴脸，而且 combat.target 指向我们（血还很足，靠"正在被打"触发）
    local foe = NEARBY[3]
    foe._x = PLAYER._x + 2 * 4
    foe._z = PLAYER._z
    foe.components.combat.target = PLAYER
    PLAYER.components.health.currenthealth = 120
    CRIT = tostring(Whale.reflex.CriticalDanger(PLAYER))
    for _ = 1, 5 do Whale.reflex.Tick() end
    AFTER = Whale.job ~= nil and Whale.job.name or "nil"
    AFTER_ID = Whale.job ~= nil and tostring(Whale.job.cmd_id) or "nil"
    OLD_CMD = REPORTED ~= nil and tostring(REPORTED.id) or "nil"
    ERR = tostring(Whale.last_reflex_error or "none")
  `)

  assert.equal(global('BEFORE'), 'wait', '前提：模型任务在跑')
  assert.equal(global('CRIT'), 'true', '青蛙贴着并且 target=我，应该判成危险')
  assert.equal(global('ERR'), 'none', '反射层内部不能报错')
  assert.equal(global('AFTER'), 'move_to', '正在被打时反射层应该抢占并起一个撤离')
  assert.equal(global('AFTER_ID'), 'reflex', '撤离必须是反射层发起的')
  assert.equal(global('OLD_CMD'), 'model-1', '旧任务必须收到回执（不能悄悄消失）')
})

test('gather_area：正在被怪打时立刻停（不许站着把一片采完）', async () => {
  const fengari = await import('fengari')
  const { runFile, global } = loadMod(fengari)

  runFile(`
    Whale.bridge = { Report = function(ok, text) REPORTED = { ok = ok, text = text } end, WriteState = function() end }
    local foe = NEARBY[3]
    foe._x = PLAYER._x + 2 * 4
    foe._z = PLAYER._z
    foe.components.combat.target = PLAYER
    Whale.actions.Start("gather_area", {}, "cmd-area", { survival_area = true })
    Whale.actions.Tick()
    OUT_JOB = Whale.job ~= nil and Whale.job.name or "nil"
    OUT_TEXT = REPORTED ~= nil and tostring(REPORTED.text) or ""
  `)

  assert.equal(global('OUT_JOB'), 'nil', '被怪打时 gather_area 必须结束')
  assert.match(global('OUT_TEXT'), /有怪在打我/)
})

test('gather_area：默认范围/数量收小（8 格 / 8 个），否则一轮能拖好几分钟', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadMod(fengari)
  run(ENT_HELPER, '实体辅助')
  run('NEARBY = { mkent("berrybush", 2, PLAYER._x + 8, PLAYER._z) }', '一丛可采浆果')

  runFile(`
    Whale.bridge = { Report = function(ok, text) REPORTED = { ok = ok, text = text } end, WriteState = function() end }
    Whale.actions.Start("gather_area", {}, "cmd-area-2", { survival_area = true })
    Whale.actions.Tick()
    OUT_RADIUS = tostring(Whale.job ~= nil and Whale.job.data.radius or "nil")
    OUT_LIMIT = tostring(Whale.job ~= nil and Whale.job.data.limit or "nil")
    OUT_WHY = REPORTED ~= nil and tostring(REPORTED.text) or "none"
  `)

  assert.equal(global('OUT_RADIUS'), '8', '默认半径必须是 8 格（' + global('OUT_WHY') + '）')
  assert.equal(global('OUT_LIMIT'), '8', '默认上限必须是 8 个')
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
GLOBAL = { KEY_F7 = 288, KEY_F8 = 289, ANCHOR_LEFT = 0, ANCHOR_RIGHT = 1, ANCHOR_MIDDLE = 2,
           ANCHOR_TOP = 3, ANCHOR_BOTTOM = 4,
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
local function fakewidget()
    local widget = { _pos = nil, _visible = true }
    function widget:SetPosition(x, y, z) self._pos = { x, y, z } end
    widget.Show = function(self) self._visible = true end
    widget.Hide = function(self) self._visible = false end
    widget.SetSize = function() end
    widget.SetTint = function() end
    widget.SetString = function() end
    widget.SetHAlign = function() end
    widget.SetVAlign = function() end
    widget.SetRegionSize = function(self, w, h) self._region = { w, h } end
    widget.SetColour = function() end
    widget.SetHAnchor = function(self, a) self._hAnchor = a end
    widget.SetVAnchor = function(self, a) self._vAnchor = a end
    widget.SetScaleMode = function() end
    widget.AddChild = function(self, child) self.child = child return child end
    widget.Kill = function() end
    return widget
end
-- 注意：require 对 package.loaded 里已有的值会直接返回，不会把它当 loader 调用。
-- 所以这里必须放**可调用表**本身，不能放返回可调用表的函数。
package.loaded["widgets/widget"] = setmetatable({}, { __call = function() return fakewidget() end })
package.loaded["widgets/text"] = setmetatable({}, { __call = function() return fakewidget() end })
package.loaded["widgets/image"] = setmetatable({}, { __call = function() return fakewidget() end })
LOGS = {}
Whale = { files = {}, util = { log = function(msg) LOGS[#LOGS + 1] = tostring(msg) end } }
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
    -- F7 只管小窗：挂载前按也不能写 AI 开关，更不能停 AI
    KEYHANDLERS[1](GLOBAL.KEY_F7, true)
    assert(WRITTEN["whale_toggle.json"] == nil, "F7 不能写 whale_toggle.json（它只开关小窗）")
    assert(Whale.hud.Status().visible == false, "F7 应该把小窗隐藏")
    -- 再按一次恢复显示
    KEYHANDLERS[1](GLOBAL.KEY_F7, true)
    assert(Whale.hud.Status().visible == true, "F7 再按一次应该重新显示")
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
    -- F7 不能改变 F8 写下的 AI 状态
    local before_f7 = WRITTEN["whale_toggle.json"]
    KEYHANDLERS[1](GLOBAL.KEY_F7, true)
    assert(WRITTEN["whale_toggle.json"] == before_f7, "F7 不能改 AI 开关")
    KEYHANDLERS[1](GLOBAL.KEY_F7, true)   -- 再按一次恢复显示（给后面的挂载断言用）
    -- 服务端挪人时的"补动画"判定（纯视觉，不参与移动）
    assert(type(Whale.hud.anim_for) == "function", "少了 anim_for")
    assert(Whale.hud.anim_for(8, true) == nil, "自己在走的时候别插手，交给状态机")
    assert(Whale.hud.anim_for(8, false) == "run_loop", "服务端在挪我，应该自己播跑步")
    assert(Whale.hud.anim_for(0.1, false) == "idle_loop", "停下了就应该回 idle")
    assert(Whale.hud.anim_for(nil, false) == "idle_loop", "还测不出速度时按停着算")
    -- 挂上去之后必须落在**屏幕右上角**：锚在右/上边，root 原点在右边缘左侧。
    -- 面板宽度 330，中心距右边缘 MARGIN+165；面板右边缘 = 右边界 - MARGIN 仍在屏内。
    local screen = { AddChild = function(self, child) self.child = child end, owner = nil }
    local player = { DoPeriodicTask = function() end }
    screen.owner = player
    player.HUD = screen
    GLOBAL.ThePlayer = player
    -- 第一次 PlayerHud 还没准备好：挂载失败不能把 HUD 永久判死。
    local not_ready = { AddChild = function() error("playerhud not ready") end }
    assert(Whale.hud.Attach(not_ready, player) == false, "第一次挂不上应该返回 false")
    assert(Whale.hud.Status().attached == false, "失败后不能假装已挂上")
    -- 屏幕就绪后从 player.HUD 重试，必须能成功。
    assert(Whale.hud.AttachFromPlayer(player) == true, "PlayerHud 就绪后必须能重试挂上")
    assert(screen.child ~= nil, "HUD 根节点必须挂到 PlayerHud 屏幕上；日志：" .. table.concat(LOGS, " | "))
    assert(player.child == nil, "HUD 不能挂到玩家实体上（那样画面上看不到）")
    assert(screen.child._pos ~= nil, "HUD 根节点没设置位置")
    assert(screen.child.child._region ~= nil and screen.child.child._region[1] > 0,
        "文字必须设置 region size，否则 SetHAlign(LEFT) 不生效，左半截会被裁掉")
    local root_x = screen.child._pos[1]
    assert(screen.child._hAnchor == GLOBAL.ANCHOR_RIGHT, "HUD 必须锚在屏幕右侧（右上角布局）")
    assert(screen.child._vAnchor == GLOBAL.ANCHOR_TOP, "HUD 必须锚在屏幕顶部（右上角布局）")
    assert(root_x < 0, "右上角布局下 root 原点应在右边缘左侧（x 为负），x=" .. tostring(root_x))
    assert(root_x + 165 <= 0, "面板右边缘不能超出屏幕右边缘：x=" .. tostring(root_x))
    assert(screen.child._visible == true, "挂上后小窗默认应该可见")
    KEYHANDLERS[1](GLOBAL.KEY_F7, true)
    assert(screen.child._visible == false, "F7 应该真的隐藏 HUD 根节点")
    KEYHANDLERS[1](GLOBAL.KEY_F7, true)
    assert(screen.child._visible == true, "再按 F7 应该把 HUD 重新显示出来")
    OUT = "ok"
  `))
  assert.equal(lua.lua_pcall(L, 0, 0, 0), lua.LUA_OK, 'HUD 行为不对：' + fail())
})

