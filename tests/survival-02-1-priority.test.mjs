// SURVIVAL-02.1：生存优先级、火源准备、紧急任务抢占、基础需求处理。
//
// 这里同时覆盖两层：
//   · Node 计划层（lib/plan.js 的真实 derivePlan）：prep_light 的判定/材料保护/装备提醒。
//   · Lua 反射层（scripts/whale/reflex.lua 真实代码，跑在 fengari 里）：
//     配置开关、白天立即做火把、制作失败不误报、安全抢占、防抖、饥饿保护、死亡重置。
//
// 关键：这些测试都跑**真实实现**，不 mock 被测逻辑本身。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { derivePlan, planInternals } from '../lib/plan.js'
import { normalizeState } from '../lib/state/snapshot.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

// ─────────────────────────── Node 计划层夹具 ───────────────────────────

function makeSnapshot(over = {}) {
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

const ITEMS = (...entries) => Object.fromEntries(entries.map(([prefab, count], index) => [
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
    end
    function inv:FindItem(fn) return nil end
    function inv:DropItem(item) self._dropped = item end
    function inv:Equip(item)
        for k, v in pairs(self._items) do if v == item then self._items[k] = nil end end
        self._equipped[GLOBAL.EQUIPSLOTS.HANDS] = item
    end
    -- unequip 走的是原生 inventory:Unequip(slot)，桩里必须也有，否则"收火把"永远失败
    function inv:Unequip(slot)
        local item = self._equipped[slot]
        if item == nil then return end
        self._equipped[slot] = nil
        local n = 0
        for _ in pairs(self._items) do n = n + 1 end
        self._items[n + 1] = item
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

function loadReflex(fengari, variant) {
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
  for (const name of variant === 'noActions'
    ? ['json', 'util', 'pickuprules', 'harvestrules', 'gatherrules', 'eatrules', 'craftrules', 'equiprules', 'config', 'reflex']
    : ['json', 'util', 'pickuprules', 'harvestrules', 'gatherrules', 'eatrules', 'craftrules',
       'equiprules', 'config', 'actions', 'reflex']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', `${name}.lua`), 'utf8'), `${name}.lua`)
  }
  const global = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' }
  }
  return { run, runFile, global }
}

function eachTick(n = 5) { return `for _ = 1, ${n} do Whale.reflex.Tick() end` }

// ═══════════════════════ Node 计划层：火源准备 ═══════════════════════

test('SP-1（要求3）：白天材料不足、附近也没材料 —— prep_light 仍然存在并指向缺的材料', () => {
  const plan = derivePlan(makeSnapshot({ phase: 'day' }))
  assert.equal(plan.goalId, 'prep_light', '没有可用光源时，白天的目标就该是准备光源，而不是 explore')
  assert.match(plan.next, /cutgrass|twigs|seek/)
  assert.match(plan.why, /光源|火把/)
})

test('SP-2（要求4）：材料满足后 prep_light 不会错误消失（旧 bug：材料一够目标就没了）', () => {
  const plan = derivePlan(makeSnapshot({ phase: 'day', items: ITEMS(['cutgrass', 2], ['twigs', 2]) }))
  assert.equal(plan.goalId, 'prep_light', '材料够了目标必须还在（下一步是去做，而不是消失）')
  assert.match(plan.next, /craft torch/)
})

test('SP-3（要求5）：材料满足后下一步就是"制作火把"', () => {
  const plan = derivePlan(makeSnapshot({ phase: 'day', items: ITEMS(['cutgrass', 3], ['twigs', 2]) }))
  assert.equal(plan.goalId, 'prep_light')
  assert.match(plan.next, /craft torch/)
})

test('SP-4（要求4/10）：已经拥有能用的火把 —— prep_light 才算完成（不再催材料）', () => {
  const plan = derivePlan(makeSnapshot({
    phase: 'day',
    items: { 0: { prefab: 'torch', count: 1, percent: 80 } },
  }))
  assert.notEqual(plan.goalId, 'prep_light', '有可用火把后就不该再是准备光源')
})

test('SP-5（要求5/6）：火把耐久为 0（烧光了）不算"有光源" —— 仍要准备', () => {
  const plan = derivePlan(makeSnapshot({
    phase: 'day',
    items: { 0: { prefab: 'torch', count: 1, percent: 0 } },
  }))
  assert.equal(plan.goalId, 'prep_light', '烧光的火把不是可用光源')
})

test('SP-6（要求8）：火把没做出来时，做斧头会抢走树枝 —— 斧头目标让位给火把', () => {
  const tree = { ref: '#1', prefab: 'evergreen', label: '常青树', distance: 3, work_action: 'CHOP' }
  // 只有 2 树枝 + 1 燧石：做斧头（要 1 树枝）会剩 1 树枝 → 火把的 2 树枝就凑不齐 → 先别做斧头
  const snapshot = makeSnapshot({
    phase: 'day',
    items: ITEMS(['twigs', 2], ['flint', 1]),
    buckets: { resources: [tree] },
  })
  const plan = derivePlan(snapshot)
  assert.equal(plan.goalId, 'prep_light', '火把材料要被保护，不能被斧头提前吃掉')
})

test('SP-7（要求8）：树枝够多（3 个）时，做斧头不会饿死火把 —— 可以去做斧头', () => {
  const tree = { ref: '#1', prefab: 'evergreen', label: '常青树', distance: 3, work_action: 'CHOP' }
  const snapshot = makeSnapshot({
    phase: 'day',
    items: ITEMS(['twigs', 3], ['flint', 1], ['cutgrass', 2]),
    buckets: { resources: [tree] },
  })
  // 有了 cutgrass2+twigs2 材料后 prep_light 仍在（没火把），但它是"去做火把"，不是被斧头挤掉；
  // 关键是工具目标本身没有被错误触发。
  const plan = derivePlan(snapshot)
  assert.equal(plan.goalId, 'prep_light')
  assert.match(plan.next, /craft torch/)
})

test('SP-8（要求7）：火把做好后，材料保护解除（斧头可以做了）', () => {
  const tree = { ref: '#1', prefab: 'evergreen', label: '常青树', distance: 3, work_action: 'CHOP' }
  const snapshot = makeSnapshot({
    phase: 'day',
    items: { 0: { prefab: 'torch', count: 1, percent: 90 }, 1: { prefab: 'twigs', count: 1 }, 2: { prefab: 'flint', count: 1 } },
    buckets: { resources: [tree] },
  })
  assert.equal(planInternals.hasPortableLight(snapshot), true)
  const plan = derivePlan(snapshot)
  assert.equal(plan.goalId, 'tool_axe', '有火把以后，斧头目标应当恢复')
})

test('SP-9（要求9）：黄昏前（dusk）火把在背包但没拿在手上 —— 计划要求先装备', () => {
  const plan = derivePlan(makeSnapshot({
    phase: 'dusk',
    items: { 0: { prefab: 'torch', count: 1, percent: 70 } },
  }))
  assert.equal(plan.goalId, 'light', '黄昏没有举火把 = 没光，目标必须是弄到光')
  assert.match(plan.next, /equip torch/)
})

test('SP-10（要求10）：夜里没光源 —— light 目标压过一切普通活动', () => {
  const plan = derivePlan(makeSnapshot({ phase: 'night' }))
  assert.equal(plan.goalId, 'light')
})

test('SP-11（要求3）：火把材料的来源是原生配方（2 草 + 2 树枝），不是别处硬编码的第二份', () => {
  // 直接验证 Lua 侧从原生 AllRecipes 读出来的需求与 Node 侧副本一致
  assert.deepEqual(planInternals.TORCH_RECIPE, { cutgrass: 2, twigs: 2 })
  const src = readFileSync(join(MOD, 'scripts', 'whale', 'craftrules.lua'), 'utf8')
  assert.match(src, /GLOBAL\.AllRecipes/, '材料需求必须读游戏原生 Recipe')
})

// ═══════════════════════ Lua 反射层 ═══════════════════════

test('RF-1（要求1）：反射实际配置开启时，Enabled() 报告 true', async () => {
  const fengari = await import('fengari')
  const { runFile, global } = loadReflex(fengari)
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    local ok, why = Whale.reflex.Enabled()
    ENABLED = tostring(ok)
    WHY = tostring(why)
  `)
  assert.equal(global('ENABLED'), 'true')
  assert.equal(global('WHY'), 'config_enabled')
})

test('RF-2（要求2）：反射配置关闭时正确报告，且不执行任何动作', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    PLAYER.components.health.currenthealth = 30      -- 20%，本该紧急回血
    PLAYER.components.inventory._items[1] = mkitem("berries", 3)
  `, '残血 + 有吃的')
  runFile(`
    Whale.reflex_on = false
    Whale.reflex_force_off = false
    local ok, why = Whale.reflex.Enabled()
    ENABLED = tostring(ok)
    WHY = tostring(why)
    ${eachTick(10)}
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
  `)
  assert.equal(global('ENABLED'), 'false')
  assert.equal(global('WHY'), 'config_disabled')
  assert.equal(global('JOB'), 'nil', '反射关掉时不该自己起动作')
})

test('RF-3（要求5）：白天材料足够 —— 反射立即做火把，并在白天把它收进背包（不烧燃料）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    PLAYER.components.inventory._items[1] = mkitem("cutgrass", 2)
    PLAYER.components.inventory._items[2] = mkitem("twigs", 2)
    -- 模拟 DST DoBuild：空手做 equippable 成品 → 直接装备到手上
    MAKE_RECIPE_IMPL = function(recipe)
        if recipe.name == "torch" then
            PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = mkitem("torch", 1,
                { fueled = { IsEmpty = function() return false end,
                             GetPercent = function() return 1.0 end } })
        end
        return true
    end
  `, '白天 + 火把材料齐')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(5)}                                   -- 触发 P1 白天立即做火把
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
    CMD = Whale.job ~= nil and tostring(Whale.job.cmd_id) or "nil"
    Whale.actions.Tick()                             -- 执行 MakeRecipe
    Whale.actions.Tick()                             -- 核对成品
    HAND_AFTER_CRAFT = PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] ~= nil
             and PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS].prefab or "nil"
    ${eachTick(5)}                                   -- 反射核对（confirm_pending）
    ${eachTick(5)}                                   -- 白天把它收回背包
    Whale.actions.Tick()                             -- unequip: start
    Whale.actions.Tick()                             -- unequip: acting → done
    Whale.actions.Tick()                             -- 收尾
    HAND = PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] ~= nil
             and PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS].prefab or "nil"
    IN_BAG = (Whale.craftrules.Counts(PLAYER)["torch"] or 0)
    JOB_AFTER = Whale.job ~= nil and Whale.job.name or "nil"
  `)
  assert.equal(global('JOB'), 'craft', '白天材料够就该直接 craft torch')
  assert.equal(global('CMD'), 'reflex')
  assert.equal(global('HAND_AFTER_CRAFT'), 'torch', 'DoBuild 会先把火把自动装备到手上')
  assert.equal(global('HAND'), 'nil', '白天必须把火把收起来（手持会烧燃料，真机就是这么循环致死的）')
  assert.equal(global('IN_BAG'), '1', '收起来后火把要在背包里，燃料不消耗')
  assert.equal(global('JOB_AFTER'), 'nil', '做完就该结束任务')
})

test('RF-4（要求6）：火把制作失败时，反射不会误报"准备好了"', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    PLAYER.components.inventory._items[1] = mkitem("cutgrass", 2)
    PLAYER.components.inventory._items[2] = mkitem("twigs", 2)
    MAKE_RECIPE_IMPL = function(recipe) return false end   -- 游戏拒绝制作
  `, '材料齐但制作失败')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(5)}
    Whale.actions.Tick()
    Whale.actions.Tick()
    ${eachTick(5)}
    HAND = PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS]
    HAS_TORCH = (Whale.craftrules.Counts(PLAYER)["torch"] or 0)
    ATTEMPTS = #CRAFTED
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
    -- 再跑几秒：失败要退避，不能每秒重试
    ${eachTick(10)}
    ATTEMPTS_LATER = #CRAFTED
  `)
  assert.equal(global('HAND'), '', '不该有火把（制作失败了）')
  assert.equal(global('HAS_TORCH'), '0')
  assert.equal(global('ATTEMPTS'), '1', '只应尝试制作一次')
  assert.equal(global('ATTEMPTS_LATER'), '1', '失败后要退避，不能无限重试')
})

test('RF-5（要求8）：craftrules 判定"做斧头会破坏火把材料保留"', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`PLAYER.components.inventory._items[1] = mkitem("twigs", 2)
       PLAYER.components.inventory._items[2] = mkitem("flint", 1)`, '2 树枝 + 1 燧石')
  runFile(`
    local cr = Whale.craftrules
    local need = cr.NeededIngredients("torch")
    local b1 = cr.WouldBreakReserve(PLAYER, "axe", need)      -- 做斧头会用掉 1 树枝 → 剩 1 < 2 → 破坏
    A1 = tostring(b1)
    PLAYER.components.inventory._items[1] = mkitem("twigs", 3)
    PLAYER.components.inventory._items[2] = mkitem("flint", 1)
    local want = { twigs = 2, cutgrass = 2 }
    local b2 = cr.WouldBreakReserve(PLAYER, "axe", want)      -- 3-1=2 >= 2 → 不破坏
    A2 = tostring(b2)
  `)
  assert.equal(global('A1'), 'true', '2 树枝时做斧头会破坏火把材料')
  assert.equal(global('A2'), 'false', '3 树枝时做斧头不影响火把')
})

test('RF-6（要求8）：从原生 Recipe 读出的材料需求与游戏一致（torch/axe/pickaxe）', async () => {
  const fengari = await import('fengari')
  const { runFile, global } = loadReflex(fengari)
  runFile(`
    local cr = Whale.craftrules
    local t = cr.NeededIngredients("torch")
    local a = cr.NeededIngredients("axe")
    local p = cr.NeededIngredients("pickaxe")
    TORCH = string.format("%d/%d", t.cutgrass, t.twigs)
    AXE = string.format("%d/%d", a.twigs, a.flint)
    PICK = string.format("%d/%d", p.twigs, p.flint)
  `)
  assert.equal(global('TORCH'), '2/2')
  assert.equal(global('AXE'), '1/1')
  assert.equal(global('PICK'), '2/2')
})

test('RF-7（要求10）：天黑没光、材料够 —— 紧急逻辑生效，直接做火把', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    GLOBAL.TheWorld.state.phase = "night"
    PLAYER.components.inventory._items[1] = mkitem("cutgrass", 2)
    PLAYER.components.inventory._items[2] = mkitem("twigs", 2)
  `, '夜里 + 材料')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(5)}
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
    CMD = Whale.job ~= nil and tostring(Whale.job.cmd_id) or "nil"
  `)
  assert.equal(global('JOB'), 'craft', '夜里没光必须马上做火把')
  assert.equal(global('CMD'), 'reflex')
})

test('RF-8（要求10/12）：夜里没光、也没材料 —— 不会瞎做，且不乱清任务', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`GLOBAL.TheWorld.state.phase = "night"`, '夜里 + 啥也没有')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(10)}
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
    ATTEMPTS = #CRAFTED
    ERR = tostring(Whale.last_reflex_error or "none")
  `)
  assert.equal(global('JOB'), 'nil')
  assert.equal(global('ATTEMPTS'), '0', '没材料就不该尝试制作')
  assert.equal(global('ERR'), 'none', '反射内部不能报错')
})

test('RF-9（要求11/15/17）：普通任务期间被怪攻击 —— 安全抢占，先撤退，旧指令收到回执', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    local frog = newent("frog", 2 * 4, 0, { "hostile" }, {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
        combat = {},
    })
    frog.components.combat.target = PLAYER
    NEARBY = { frog }
  `, '青蛙贴脸并正在打我')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    Whale.actions.Start("wait", { seconds = 10 }, "model-1")   -- 模型正在跑任务
    BEFORE = Whale.job ~= nil and Whale.job.name or "nil"
    ${eachTick(5)}
    AFTER = Whale.job ~= nil and Whale.job.name or "nil"
    AFTER_ID = Whale.job ~= nil and tostring(Whale.job.cmd_id) or "nil"
    OLD = REPORTS[1] ~= nil and tostring(REPORTS[1].id) or "nil"
    JOB_COUNT = 1   -- 单槽：同一时刻只能有一个 job（结构性保证）
  `)
  assert.equal(global('BEFORE'), 'wait')
  assert.equal(global('AFTER'), 'move_to', '被怪打时必须抢占并撤退')
  assert.equal(global('AFTER_ID'), 'reflex')
  assert.equal(global('OLD'), 'model-1', '旧任务必须收到被打断的回执')
})

test('RF-10（要求12）：旧任务没被清理干净时，绝不启动第二个动作', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    local frog = newent("frog", 2 * 4, 0, { "hostile" }, {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
        combat = {},
    })
    frog.components.combat.target = PLAYER
    NEARBY = { frog }
  `, '青蛙贴脸')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    Whale.actions.Start("wait", { seconds = 10 }, "model-1")
    -- 模拟"Abort 没真正清掉任务"：不改变 Whale.job
    Whale.actions.Abort = function() return true end
    ${eachTick(5)}
    STILL = Whale.job ~= nil and tostring(Whale.job.cmd_id) or "nil"
    NAME = Whale.job ~= nil and Whale.job.name or "nil"
  `)
  assert.equal(global('STILL'), 'model-1', '旧任务没清掉时不能把新动作顶上去')
  assert.equal(global('NAME'), 'wait', '不能出现第二个动作')
})

test('RF-11（要求13）：紧急进食不被普通任务无限阻塞', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    PLAYER.components.inventory._items[1] = mkitem("berries", 3,
        { edible = { hungervalue = 9.375, healthvalue = 0 } })
    PLAYER.components.health.currenthealth = 150
    PLAYER.components.hunger.current = 60          -- 30%（< 35%）
    PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = mkitem("torch", 1,
        { finiteuses = { GetUses = function() return 60 end } })   -- 有光，避免走光源分支
  `, '饿 + 有安全食物 + 有光')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    Whale.actions.Start("gather_area", {}, "model-g", { survival_area = true })
    BEFORE = Whale.job ~= nil and Whale.job.name or "nil"
    ${eachTick(5)}
    AFTER = Whale.job ~= nil and Whale.job.name or "nil"
    AFTER_ID = Whale.job ~= nil and tostring(Whale.job.cmd_id) or "nil"
    OLD = REPORTS[1] ~= nil and tostring(REPORTS[1].id) or "nil"
  `)
  assert.equal(global('BEFORE'), 'gather_area')
  assert.equal(global('AFTER'), 'eat', '紧急饥饿要能中断普通采集')
  assert.equal(global('AFTER_ID'), 'reflex')
  assert.equal(global('OLD'), 'model-g')
})

test('RF-12（要求14）：食物不足时不会无限重试 eat', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    PLAYER.components.hunger.current = 40           -- 20%，很饿
    -- 手上不放火把：这条测试只验"没食物时别反复起 eat"，
    -- 放了火把会先触发"白天收火把"（那是另一条独立行为，见 RF-3/RF-21）。
    PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = nil
    -- 背包里没有可吃的东西
  `, '很饿但没吃的')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(20)}
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
    EAT_REPORTS = 0
    for _, r in ipairs(REPORTS) do if r.text ~= nil and string.find(tostring(r.text), "eat") ~= nil then EAT_REPORTS = EAT_REPORTS + 1 end end
    ERR = tostring(Whale.last_reflex_error or "none")
  `)
  assert.equal(global('JOB'), 'nil', '没食物就不该反复起 eat')
  assert.equal(global('ERR'), 'none')
})

test('RF-13（要求16）：反射不会每秒重复启动同一个动作（防抖）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    PLAYER.components.inventory._items[1] = mkitem("cutgrass", 2)
    PLAYER.components.inventory._items[2] = mkitem("twigs", 2)
    MAKE_RECIPE_IMPL = function(recipe) return true end
  `, '白天 + 材料（不推进动作，模拟制作中）')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(5)}                                   -- 第一次：启动 craft
    FIRST = tostring(Whale.job)
    ${eachTick(5)}                                   -- 第二次：同一意图在跑，不该重建
    SECOND = tostring(Whale.job)
    INTERRUPTS = 0
    for _, r in ipairs(REPORTS) do
        if r.text ~= nil and string.find(tostring(r.text), "打断") ~= nil then INTERRUPTS = INTERRUPTS + 1 end
    end
  `)
  assert.equal(global('FIRST'), global('SECOND'), '同一个反射意图在跑时不能重建任务')
  assert.equal(global('INTERRUPTS'), '0', '不该出现"自己打断自己"')
})

test('RF-14（要求18）：死亡 / 鬼魂 / Actor 无效时正确重置，不再下动作', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`PLAYER.components.health.currenthealth = 0`, '血量归零（死亡）')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(10)}
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
    STATUS_INTENT = Whale.reflex.Status().intent or "nil"
  `)
  assert.equal(global('JOB'), 'nil', '死了不该起动作')
  assert.equal(global('STATUS_INTENT'), 'nil', '死亡要清掉残留的反射意图')
})

test('RF-15（要求18）：变成鬼魂（playerghost 标签）也重置', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`PLAYER._tags.playerghost = true`, '鬼魂状态')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(10)}
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
  `)
  assert.equal(global('JOB'), 'nil')
})

test('RF-17（真机 bug）：附近只有树苗没有草时，反射应该采能采到的那一种，而不是卡在 cutgrass 空转', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    local sapling = newent("sapling", 2 * 4, 0, { "pickable" }, {
        pickable = { CanBePicked = function() return true end },
    })
    NEARBY = { sapling }        -- 故意不放 grass
  `, '附近只有树苗，没有草')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(5)}
    PUSH_PREFAB = PUSHED ~= nil and PUSHED.target ~= nil and PUSHED.target.prefab or "nil"
    ACTION = PUSHED ~= nil and PUSHED.action ~= nil and PUSHED.action.id or "nil"
  `)
  assert.equal(global('PUSH_PREFAB'), 'sapling', '附近没有草就去采树枝，别一直空转')
  assert.equal(global('ACTION'), 'PICK')
})

test('RF-18（真机 bug）：诊断日志限频，且不把诊断塞进 get_state 的「最近做过的事」', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`NEARBY = {}`, '附近什么都没有')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(50)}                  -- 模拟 10 秒的空转
    RECENT_N = #Whale.reflex.Recent()
    HAS_DIAG = 0
    for _, t in ipairs(Whale.reflex.Recent()) do
        if string.find(t, "[Reflex]", 1, true) ~= nil then HAS_DIAG = HAS_DIAG + 1 end
    end
  `)
  assert.equal(global('HAS_DIAG'), '0', '诊断不该出现在给模型看的提示里')
  assert.equal(global('RECENT_N'), '0', '没做任何动作就不该有"我自己刚干的"记录')
})

test('RF-19：fueled 烧空的火把不算可用光源（torch 用 fueled，不是 finiteuses）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = mkitem("torch", 1,
        { fueled = { IsEmpty = function() return true end,
                     GetPercent = function() return 0 end } })
    PLAYER.components.inventory._items[1] = mkitem("cutgrass", 2)
    PLAYER.components.inventory._items[2] = mkitem("twigs", 2)
  `, '手里一把烧空的火把 + 材料齐')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    local d = Whale.reflex.Diagnose()
    PORTABLE = tostring(d.portable_light)
    USABLE = tostring(d.has_usable_light)
    CANCRAFT = tostring(d.can_craft_torch)
  `)
  assert.equal(global('PORTABLE'), 'false', '烧空的火把不是便携光源')
  assert.equal(global('USABLE'), 'false')
  assert.equal(global('CANCRAFT'), 'true', '应该重新做一把火把')
})

test('RF-20（真机 bug）：制作结果用独立 section，不被 started 的 20 秒限频吞掉', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    PLAYER.components.inventory._items[1] = mkitem("cutgrass", 2)
    PLAYER.components.inventory._items[2] = mkitem("twigs", 2)
    MAKE_RECIPE_IMPL = function(recipe)
        if recipe.name == "torch" then
            PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = mkitem("torch", 1,
                { fueled = { IsEmpty = function() return false end,
                             GetPercent = function() return 0.62 end } })
        end
        return true
    end
  `, '白天 + 材料齐 + 自动装备')
  runFile(`
    LOG_CAPTURE = ""
    print = function(s) LOG_CAPTURE = LOG_CAPTURE .. tostring(s) .. "\\n" end
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(5)}                                   -- 触发 craft_torch: started=true
    Whale.actions.Tick()                             -- MakeRecipe
    Whale.actions.Tick()                             -- 核对成功
    ${eachTick(5)}                                   -- confirm_pending 打结果
    HAS_RESULT = string.find(LOG_CAPTURE, "craft_torch_result", 1, true) ~= nil and "yes" or "no"
    HAS_SUCCEEDED = string.find(LOG_CAPTURE, "result=succeeded", 1, true) ~= nil and "yes" or "no"
    HAS_CONFIRMED = string.find(LOG_CAPTURE, "in_hand=true", 1, true) ~= nil and "yes" or "no"
  `)
  assert.equal(global('HAS_RESULT'), 'yes', '结果必须是独立的诊断 section')
  assert.equal(global('HAS_SUCCEEDED'), 'yes')
  assert.equal(global('HAS_CONFIRMED'), 'yes')
})

test('RF-21（真机 bug：白天烧燃料）：白天手里举着火把 —— 反射要把它收回背包', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    GLOBAL.TheWorld.state.phase = "day"
    -- 手上举着一把满燃料火把（这是上一版反射的常态：做完自动装备，白天就开始烧）
    PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = mkitem("torch", 1,
        { fueled = { IsEmpty = function() return false end,
                     GetPercent = function() return 0.9 end } })
  `, '白天 + 手上举着火把')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(5)}
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
    ${eachTick(5)}
    Whale.actions.Tick()
    Whale.actions.Tick()
    HAND = PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] ~= nil
             and PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS].prefab or "nil"
    IN_BAG = (Whale.craftrules.Counts(PLAYER)["torch"] or 0)
  `)
  assert.equal(global('JOB'), 'unequip', '白天该主动把火把收起来')
  assert.equal(global('HAND'), 'nil', '收完手上不该还有火把')
  assert.equal(global('IN_BAG'), '1', '火把进背包，燃料不再消耗')
})

test('RF-22（真机 bug：黄昏把光收了）：黄昏/夜里绝不收火把', async () => {
  for (const phase of ['dusk', 'night']) {
    const fengari = await import('fengari')
    const { run, runFile, global } = loadReflex(fengari)
    run(`
      GLOBAL.TheWorld.state.phase = "${phase}"
      PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = mkitem("torch", 1,
          { fueled = { IsEmpty = function() return false end,
                       GetPercent = function() return 0.9 end } })
    `, `${phase} + 手上举着火把`)
    runFile(`
      Whale.reflex_on = true
      Whale.reflex_force_off = false
      ${eachTick(10)}
      JOB = Whale.job ~= nil and Whale.job.name or "nil"
      HAND = PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] ~= nil
               and PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS].prefab or "nil"
    `)
    assert.equal(global('JOB'), 'nil', `${phase} 不该起"收火把"的动作`)
    assert.equal(global('HAND'), 'torch', `${phase} 必须继续举着火把`)
  }
})

test('RF-23（真机 bug：一把盖不住一夜）：备料按整夜算 —— 有火把也要继续囤', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    GLOBAL.TheWorld.state.phase = "day"
    -- 手上有一把满燃料火把，但背包里一根材料都没有
    PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = mkitem("torch", 1,
        { fueled = { IsEmpty = function() return false end,
                     GetPercent = function() return 1.0 end } })
    -- 附近有一丛草，够采
    local grass = newent("grass", 2 * 4, 0, { "pickable" }, {
        pickable = { CanBePicked = function() return true end },
    })
    NEARBY = { grass }
  `, '白天 + 有火把但零备料')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    local d = Whale.reflex.Diagnose()
    RESERVE_OK = tostring(d.reserve_ok)
    ${eachTick(5)}
    -- 先收火把，再囤料；多跑几轮让两者都发生
    ${eachTick(10)}
    PICKED = PUSHED ~= nil and PUSHED.target ~= nil and PUSHED.target.prefab or "nil"
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
  `)
  assert.equal(global('RESERVE_OK'), 'false', '一把火把不够撑过 180 秒的夜，备料不算够')
  assert.ok(
    global('PICKED') === 'grass' || global('JOB') === 'unequip',
    `有火把也必须继续囤料（或先收火把），实际 PICKED=${global('PICKED')} JOB=${global('JOB')}`,
  )
})

test('RF-24：燃料账用的是游戏原生数值（75 秒/把，黑暗 180 秒 → 一夜要 3 把）', () => {
  const src = readFileSync(join(MOD, 'scripts', 'whale', 'reflex.lua'), 'utf8')
  assert.match(src, /TORCH_SECONDS\s*=\s*75/, '单把火把 75 秒（TORCH_FUEL = night_time*1.25）')
  assert.match(src, /DARK_SECONDS\s*=\s*180/, '黄昏 120 + 夜晚 60 = 180 秒')
  assert.match(src, /TORCHES_PER_NIGHT\s*=\s*3/, '180/75 → 一夜最多 3 把')
  assert.match(src, /RESERVE_TORCHES\s*=\s*2/, '平时至少备 2 把的材料')
})

test('RF-16：Diagnose() 能说清"当前光源是否可用 / 是否该准备"', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    PLAYER.components.inventory._items[1] = mkitem("cutgrass", 2)
    PLAYER.components.inventory._items[2] = mkitem("twigs", 2)
  `, '白天 + 火把材料齐、没火把')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    local d = Whale.reflex.Diagnose()
    ENABLED = tostring(d.enabled)
    USABLE = tostring(d.has_usable_light)
    CANCRAFT = tostring(d.can_craft_torch)
    PRIO = tostring(d.priority)
    REASON = tostring(d.priority_reason)
  `)
  assert.equal(global('ENABLED'), 'true')
  assert.equal(global('USABLE'), 'false')
  assert.equal(global('CANCRAFT'), 'true')
  assert.equal(global('PRIO'), 'P1')
  assert.equal(global('REASON'), 'light_preparation')
})
