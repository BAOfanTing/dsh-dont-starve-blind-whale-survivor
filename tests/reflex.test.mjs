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

test('SP-9（真机 0.37.0 修正）：黄昏仍在光里，不该让模型举火把', () => {
  const plan = derivePlan(makeSnapshot({
    phase: 'dusk',
    items: ITEMS(['torch', 1]),
  }))
  assert.notEqual(plan.goalId, 'light', '黄昏 grue 不攻击，不该进"马上弄到光"')
  assert.doesNotMatch(String(plan.next), /equip torch/, '黄昏别把火把举起来烧燃料，留到入夜')
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
    GLOBAL.TheWorld.state.phase = "night"
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

test('RF-22（真机 0.37.0 修正）：黄昏把火把收回背包留到入夜，夜里绝不收', async () => {
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
      Whale.actions.Tick()
      Whale.actions.Tick()
      Whale.actions.Tick()
      HAND = PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] ~= nil
               and PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS].prefab or "nil"
      IN_BAG = (Whale.craftrules.Counts(PLAYER)["torch"] or 0)
    `)
    if (phase === 'dusk') {
      assert.equal(global('JOB'), 'unequip', '★ 黄昏要收：把 75s 燃料留到真正黑暗的 night')
      assert.equal(global('HAND'), 'nil', '黄昏手上不该有火把')
      assert.equal(global('IN_BAG'), '1', '火把必须进背包备用')
    } else {
      assert.equal(global('JOB'), 'nil', '★ 黑透的夜里绝不能收光')
      assert.equal(global('HAND'), 'torch', '夜里必须继续举着火把')
    }
  }
})

test('RF-40（真机第 14 夜死因）：黄昏不点火把、入夜才举 —— 完整时序', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    -- 黄昏：背包里有一把满燃料火把，手上空
    GLOBAL.TheWorld.state.phase = "dusk"
    PLAYER.components.inventory._items[1] = mkitem("torch", 1,
        { fueled = { IsEmpty = function() return false end,
                     GetPercent = function() return 1.0 end } })
  `, '黄昏 + 背包有火把')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(20)}
    DUSK_JOB = Whale.job ~= nil and Whale.job.name or "nil"
    DUSK_HAND = PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] ~= nil
                and PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS].prefab or "nil"
    DUSK_BAG = (Whale.craftrules.Counts(PLAYER)["torch"] or 0)

    -- 切到黑透的夜里
    GLOBAL.TheWorld.state.phase = "night"
    ${eachTick(20)}
    NIGHT_JOB = Whale.job ~= nil and Whale.job.name or "nil"
    Whale.actions.Tick()
    Whale.actions.Tick()
    NIGHT_HAND = PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] ~= nil
                 and PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS].prefab or "nil"
  `)
  assert.equal(global('DUSK_JOB'), 'nil', '★ 黄昏不该举火把（grue 不攻击，点着纯浪费燃料）')
  assert.equal(global('DUSK_HAND'), 'nil', '黄昏手上空')
  assert.equal(global('DUSK_BAG'), '1', '黄昏火把留在背包')
  assert.equal(global('NIGHT_JOB'), 'equip', '★ 入夜才把背包里的火把举起来')
  assert.equal(global('NIGHT_HAND'), 'torch', '夜里手上有火把 = 有光')
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

test('RF-24：燃料账（真机修正）——只有 night 60s 需要光，一把火把 75s 就够', () => {
  const src = readFileSync(join(MOD, 'scripts', 'whale', 'reflex.lua'), 'utf8')
  assert.match(src, /TORCH_SECONDS\s*=\s*75/, '单把火把 75 秒（TORCH_FUEL = night_time*1.25）')
  assert.match(src, /DUSK_SECONDS\s*=\s*120/, '黄昏 120 秒（仍有自然光）')
  assert.match(src, /NIGHT_SECONDS\s*=\s*60/, '真正黑暗只有 60 秒')
  assert.match(src, /TORCHES_PER_NIGHT\s*=\s*1/, '★ 入夜才点，一把 75s 就够 60s 黑夜')
  assert.match(src, /RESERVE_TORCHES\s*=\s*2/, '平时至少备 2 把的材料')
  assert.match(src, /grue/, '注释要说明 grue 只在完全黑暗时攻击')
})

// ═══════════════════════ 0.34.0：没草时的破局路线 ═══════════════════════

test('SP-12（破局）：没草但有 2 木头 + 12 石头 —— prep_light 指向 build firepit（不用草）', () => {
  const plan = derivePlan(makeSnapshot({
    phase: 'day',
    items: ITEMS(['log', 2], ['rocks', 12]),   // 零 cutgrass、零 twigs
  }))
  assert.equal(plan.goalId, 'prep_light')
  assert.match(plan.next, /build firepit/)
  assert.doesNotMatch(plan.next, /craft torch/, '没草就不该还让模型去做火把')
})

test('SP-13（破局）：夜里没光、没草但有 firepit 材料 —— light 指向 build firepit', () => {
  const plan = derivePlan(makeSnapshot({
    phase: 'night',
    items: ITEMS(['log', 2], ['rocks', 12]),
  }))
  assert.equal(plan.goalId, 'light')
  assert.match(plan.next, /build firepit/)
})

test('SP-14：firepit 材料差一点就不能算"可建"（不能误报准备好了）', () => {
  const p = planInternals.firepitReady
  assert.equal(p(makeSnapshot({ items: ITEMS(['log', 2], ['rocks', 12]) })), true)
  assert.equal(p(makeSnapshot({ items: ITEMS(['log', 2], ['rocks', 11]) })), false)
  assert.equal(p(makeSnapshot({ items: ITEMS(['log', 1], ['rocks', 12]) })), false)
  assert.equal(p(makeSnapshot({ items: ITEMS(['log', 2], ['rocks', 12], ['cutgrass', 2], ['twigs', 2]) })), true)
  assert.deepEqual(planInternals.FIREPIT_RECIPE, { log: 2, rocks: 12 }, '配方与原生 recipes.lua 一致')
})

test('SP-15：火把材料够时仍优先 craft torch（firepit 只是没草时的兜底）', () => {
  const plan = derivePlan(makeSnapshot({
    phase: 'day',
    items: ITEMS(['log', 2], ['rocks', 12], ['cutgrass', 2], ['twigs', 2]),
  }))
  assert.equal(plan.goalId, 'prep_light')
  assert.match(plan.next, /craft torch/)
  assert.doesNotMatch(plan.next, /build firepit/)
})

test('SP-16：附近没草也没火坑材料 —— 仍给 seek，并提示可改走火坑路线', () => {
  const plan = derivePlan(makeSnapshot({ phase: 'day' }))
  assert.equal(plan.goalId, 'prep_light')
  assert.match(plan.next, /seek/)
  assert.match(plan.why, /cutgrass/)
})

test('RF-25（破局）：天黑没光、没草但有 log+rocks —— 反射走 make_fire 建 firepit', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    GLOBAL.TheWorld.state.phase = "night"
    -- 没有 cutgrass / twigs，做不了火把；但有 2 木头 + 12 石头
    PLAYER.components.inventory._items[1] = mkitem("log", 2)
    PLAYER.components.inventory._items[2] = mkitem("rocks", 12)
  `, '夜里 + 无草 + 有火坑材料')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(5)}
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
    RECIPE = Whale.job ~= nil and Whale.job.args ~= nil and tostring(Whale.job.args.recipe) or "nil"
    CMD = Whale.job ~= nil and tostring(Whale.job.cmd_id) or "nil"
  `)
  assert.equal(global('JOB'), 'make_fire', '没草时必须改走"不用草"的固定光源')
  assert.equal(global('RECIPE'), 'firepit')
  assert.equal(global('CMD'), 'reflex')
})



test('RF-27（边界）：夜里 / 有敌人 / 目标太远 —— 都不许主动走远', async () => {
  for (const scenario of ['night', 'enemy', 'too_far']) {
    const fengari = await import('fengari')
    const { run, runFile, global } = loadReflex(fengari)
    const phase = scenario === 'night' ? 'night' : 'day'
    const dist = scenario === 'too_far' ? 26 : 20
    run(`
      GLOBAL.TheWorld.state.phase = "${phase}"
      local grass = newent("grass", ${dist} * 4, 0, { "pickable" }, {
          pickable = { CanBePicked = function() return true end },
      })
      NEARBY = { grass }
      ${scenario === 'enemy' ? `
      local foe = newent("frog", 3 * 4, 0, { "hostile" }, {
          health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
          combat = {},
      })
      NEARBY[#NEARBY + 1] = foe
      ` : ''}
    `, `边界场景 ${scenario}`)
    runFile(`
      Whale.reflex_on = true
      Whale.reflex_force_off = false
      ${eachTick(5)}
      ${eachTick(5)}
      JOB = Whale.job ~= nil and Whale.job.name or "nil"
    `)
    assert.notEqual(global('JOB'), 'move_to', `场景 ${scenario} 不该主动走远找料`)
  }
})



test('RF-29（真机 bug：蜘蛛巢把火把卡在手上）：固定巢穴不该阻止白天收火把', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    GLOBAL.TheWorld.state.phase = "day"
    PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = mkitem("torch", 1,
        { fueled = { IsEmpty = function() return false end,
                     GetPercent = function() return 0.9 end } })
    -- 蜘蛛巢：带 hostile + structure，会刷蜘蛛但自己不会追人
    local nest = newent("spiderden", 5 * 4, 0, { "hostile", "structure" }, {
        health = { currenthealth = 1000, maxhealth = 1000, IsDead = function() return false end },
        combat = {},
    })
    NEARBY = { nest }
  `, '白天 + 手上火把 + 5 格外蜘蛛巢')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(5)}
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
    Whale.actions.Tick()
    Whale.actions.Tick()
    HAND = PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] ~= nil
             and PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS].prefab or "nil"
  `)
  assert.equal(global('JOB'), 'unequip', '固定巢穴不是"会追人的敌人"，不该把收纳挡住')
  assert.equal(global('HAND'), 'nil', '火把必须收进背包，不能举着烧光')
})



test('RF-31（安全不放宽）：真正贴脸的活怪仍阻止白天收火把', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    GLOBAL.TheWorld.state.phase = "day"
    PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = mkitem("torch", 1,
        { fueled = { IsEmpty = function() return false end,
                     GetPercent = function() return 0.9 end } })
    -- 活青蛙（无 structure 标签），3 格贴脸
    local frog = newent("frog", 3 * 4, 0, { "hostile" }, {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
        combat = {},
    })
    NEARBY = { frog }
  `, '白天 + 手上火把 + 贴脸活怪')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(5)}
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
  `)
  assert.notEqual(global('JOB'), 'unequip', '真有活怪贴脸时不能为了收火把而分心')
})

test('RF-32（真机 bug：收纳成功但火把消失）：unequip 后火把必须真的在背包里', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    GLOBAL.TheWorld.state.phase = "day"
    PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = mkitem("torch", 1,
        { fueled = { IsEmpty = function() return false end,
                     GetPercent = function() return 0.9 end },
          inventoryitem = {}, equippable = {} })
  `, '白天 + 手上举着火把')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    ${eachTick(5)}
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
    Whale.actions.Tick()
    Whale.actions.Tick()
    Whale.actions.Tick()
    HAND = PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] ~= nil
             and PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS].prefab or "nil"
    IN_BAG = (Whale.craftrules.Counts(PLAYER)["torch"] or 0)
    RESULT_OK = REPORTS[#REPORTS] ~= nil and tostring(REPORTS[#REPORTS].ok) or "?"
    RESULT_TEXT = REPORTS[#REPORTS] ~= nil and tostring(REPORTS[#REPORTS].text) or "?"
  `)
  assert.equal(global('JOB'), 'unequip')
  assert.equal(global('HAND'), 'nil', '手上应该空了')
  assert.equal(global('IN_BAG'), '1', '★ 火把必须真的进背包，不能"收纳成功但东西没了"')
  assert.equal(global('RESULT_OK'), 'true', '收纳必须报成功')
  assert.match(global('RESULT_TEXT'), /放回背包/)
})

test('RF-33：unequip 只在火把确认进背包后才报成功（不许谎报）', () => {
  const src = readFileSync(join(MOD, 'scripts', 'whale', 'actions', 'survival.lua'), 'utf8')
  assert.match(src, /local ok, item = pcall\(function\(\) return inv:Unequip\(slot\) end\)/, '必须接住 Unequip 的返回值')
  assert.match(src, /inv:GiveItem\(item\)/, '必须显式放回背包（不带 slot，让原生自己找空位）')
  assert.doesNotMatch(src, /inv:GetNextAvailableSlot\(\)/, '★ 不许无参调 GetNextAvailableSlot（原生签名要 item，真机会抛错）')
  assert.match(src, /inv:SetActiveItem\(item\)/, 'GiveItem 失败要有兜底')
  assert.match(src, /in_bag/, '完成前要核对背包里真有这件物品')
  assert.match(src, /unequip_failed: %s 没在背包里/, '核对失败要报失败')
})

test('RF-34（真机 bug：黄昏死锁）：缺火把材料时 P0 不许打断模型的采集', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    GLOBAL.TheWorld.state.phase = "dusk"
    -- 天黑没光、且一点火把材料都没有（缺 twigs），反射帮不上忙
    -- 模型正在采树枝，正是解开死锁的唯一机会
  `, '黄昏 + 零材料')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    Whale.actions.Start("gather_area", {}, "model-gather", { survival_area = true })
    BEFORE = Whale.job ~= nil and tostring(Whale.job.cmd_id) or "nil"
    ${eachTick(5)}
    AFTER = Whale.job ~= nil and tostring(Whale.job.cmd_id) or "nil"
    INTERRUPTED = 0
    for _, r in ipairs(REPORTS) do
        if r.text ~= nil and string.find(tostring(r.text), "打断") ~= nil then INTERRUPTED = INTERRUPTED + 1 end
    end
    ERR = tostring(Whale.last_reflex_error or "none")
  `)
  assert.equal(global('BEFORE'), 'model-gather')
  assert.equal(global('AFTER'), 'model-gather', '★ 反射帮不上忙时绝不能抢占，模型必须能继续采集')
  assert.equal(global('INTERRUPTED'), '0', '不该产生任何"被打断"回执')
  assert.equal(global('ERR'), 'none')
})

test('RF-35：有火把材料时 P0 仍正常抢占（不放宽安全）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    GLOBAL.TheWorld.state.phase = "night"
    PLAYER.components.inventory._items[1] = mkitem("cutgrass", 2)
    PLAYER.components.inventory._items[2] = mkitem("twigs", 2)
  `, '夜里 + 材料齐')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    Whale.actions.Start("wait", { seconds = 10 }, "model-wait")
    ${eachTick(5)}
    AFTER = Whale.job ~= nil and Whale.job.name or "nil"
    ID = Whale.job ~= nil and tostring(Whale.job.cmd_id) or "nil"
  `)
  assert.equal(global('AFTER'), 'craft', '能造火把时必须抢占')
  assert.equal(global('ID'), 'reflex')
})

test('RF-36（端到端全链）：白天做火把 → 收进背包 → 夜里从背包举起来', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    GLOBAL.TheWorld.state.phase = "day"
    PLAYER.components.inventory._items[1] = mkitem("cutgrass", 4)
    PLAYER.components.inventory._items[2] = mkitem("twigs", 4)
    -- DoBuild：空手做 equippable 成品 → 直接装备到手上
    MAKE_RECIPE_IMPL = function(recipe)
        if recipe.name == "torch" then
            PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = mkitem("torch", 1,
                { fueled = { IsEmpty = function() return false end,
                             GetPercent = function() return 1.0 end } })
        end
        return true
    end
  `, '白天 + 材料齐')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false

    -- ① 白天做出火把
    ${eachTick(5)}
    CRAFT_JOB = Whale.job ~= nil and Whale.job.name or "nil"
    Whale.actions.Tick(); Whale.actions.Tick()

    -- ② 反射核对（confirm_pending）并安排收纳
    ${eachTick(5)}
    ${eachTick(5)}
    STOW_JOB = Whale.job ~= nil and Whale.job.name or "nil"
    Whale.actions.Tick(); Whale.actions.Tick(); Whale.actions.Tick()
    HAND_DAY = PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] ~= nil
                and PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS].prefab or "nil"
    BAG_DAY = (Whale.craftrules.Counts(PLAYER)["torch"] or 0)

    -- ③ 夜里：应该把背包里的火把举起来
    GLOBAL.TheWorld.state.phase = "night"
    ${eachTick(5)}
    NIGHT_JOB = Whale.job ~= nil and Whale.job.name or "nil"
    Whale.actions.Tick(); Whale.actions.Tick()
    HAND_NIGHT = PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] ~= nil
                  and PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS].prefab or "nil"
  `)
  assert.equal(global('CRAFT_JOB'), 'craft', '白天材料够就该做火把')
  assert.equal(global('STOW_JOB'), 'unequip', '白天必须把火把收起来')
  assert.equal(global('HAND_DAY'), 'nil', '白天手上不该有火把（会烧燃料）')
  assert.equal(global('BAG_DAY'), '1', '★ 火把必须真的留在背包里')
  assert.equal(global('NIGHT_JOB'), 'equip', '夜里必须把背包里的火把举起来')
  assert.equal(global('HAND_NIGHT'), 'torch', '夜里手上有火把 = 有光')
})

test('RF-37（真机 bug：饥饿死锁）：饥饿见底但背包没食物 —— P1 不许打断模型动作', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    GLOBAL.TheWorld.state.phase = "day"
    -- 饥饿 13%，但背包里只有不能吃的东西
    PLAYER.components.hunger.current = 26          -- 13%（< 35%）
    PLAYER.components.inventory._items[1] = mkitem("cutgrass", 2)
  `, '饥饿 13% + 零食物')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    Whale.actions.Start("gather_area", {}, "model-gather", { survival_area = true })
    BEFORE = Whale.job ~= nil and tostring(Whale.job.cmd_id) or "nil"
    ${eachTick(5)}
    AFTER = Whale.job ~= nil and tostring(Whale.job.cmd_id) or "nil"
    ERR = tostring(Whale.last_reflex_error or "none")
  `)
  assert.equal(global('BEFORE'), 'model-gather')
  assert.equal(global('AFTER'), 'model-gather', '★ 没食物可吃时绝不能抢占，模型必须能继续找吃的')
  assert.equal(global('ERR'), 'none')
})

test('RF-38：饥饿见底且背包有食物 —— P1 正常抢占 eat（安全不放宽）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    GLOBAL.TheWorld.state.phase = "day"
    PLAYER.components.hunger.current = 26          -- 13%（< 35%）
    PLAYER.components.inventory._items[1] = mkitem("berries", 2,
        { edible = { hungervalue = 9.375, healthvalue = 0 } })
  `, '饥饿 13% + 有浆果')
  runFile(`
    Whale.reflex_on = true
    Whale.reflex_force_off = false
    Whale.actions.Start("gather_area", {}, "model-gather", { survival_area = true })
    ${eachTick(5)}
    AFTER = Whale.job ~= nil and Whale.job.name or "nil"
    ID = Whale.job ~= nil and tostring(Whale.job.cmd_id) or "nil"
  `)
  assert.equal(global('AFTER'), 'eat', '有食物时必须抢占进食')
  assert.equal(global('ID'), 'reflex')
})

test('RF-39：温度异常但附近没火 —— 不抢占（和 light/eat 同一规则）', () => {
  const src = readFileSync(join(MOD, 'scripts', 'whale', 'reflex.lua'), 'utf8')
  assert.match(src, /can_run\s*=\s*true/, 'temperature_need 要带 can_run')
  assert.match(src, /if temp ~= nil and temp\.can_run == true then/, 'temperature 抢占前要判 can_run')
  assert.match(src, /function\(\) return food_available\(p\) end/, 'eat 抢占前要判有食物')
  assert.match(src, /function\(\) return heal_available\(p\) end/, 'heal 抢占前要判有药/食物')
  assert.match(src, /action_not_available/, 'canRun 失败要有诊断')
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
  assert.equal(global('USABLE'), 'true', '白天有自然光，但仍需要准备便携光源')
  assert.equal(global('CANCRAFT'), 'true')
  assert.equal(global('PRIO'), 'P1')
  assert.equal(global('REASON'), 'light_preparation')
})

// ═══════════════════════ SURVIVAL-03：真机第 2 夜致死链（REFLEX=false 时模型干等到死） ═══════════════════════

const TORCH = `mkitem("torch", 1, { inventoryitem = {}, fueled = { IsEmpty = function() return false end,
                                            GetPercent = function() return 0.9 end } })`

test('SV3-1：equiprules.HandItem 只靠 GLOBAL.EQUIPSLOTS 也能认出手上的火把（真机误报"装备栏没有变化"）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = ${TORCH}`, '手上有火把')
  runFile(`
    BARE = tostring(EQUIPSLOTS)
    local h = Whale.equiprules.HandItem(PLAYER)
    HAND = h ~= nil and h.prefab or "nil"
  `)
  assert.equal(global('BARE'), 'nil', '沙箱必须和模组环境一样没有裸 EQUIPSLOTS')
  assert.equal(global('HAND'), 'torch')
})

test('SV3-2：equip torch 成功后回执"拿在手里了"，不再 10 秒后误报失败', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`PLAYER.components.inventory._items[1] = ${TORCH}`, '背包有火把')
  runFile(`
    Whale.reflex_on = false
    Whale.actions.Start("equip", { item = "torch" }, "model-eq", { survival_equip = true, item = "torch" })
    Whale.actions.Tick()
    Whale.actions.Tick()
    R = REPORTS[#REPORTS]
    OK = R ~= nil and tostring(R.ok) or "nil"
    TEXT = R ~= nil and tostring(R.text) or "nil"
  `)
  assert.equal(global('OK'), 'true', global('TEXT'))
  assert.match(global('TEXT'), /拿在手里/)
})

test('SV3-3：夜里没光 + 背包有火把 —— wait 立刻失败并提示 equip torch（反射关着也不能干等）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    GLOBAL.TheWorld.state.phase = "night"
    PLAYER.components.inventory._items[1] = ${TORCH}
  `, '夜里 + 背包有火把 + 手上空')
  runFile(`
    Whale.reflex_on = false
    Whale.actions.Start("wait", { seconds = 30 }, "model-wait")
    Whale.actions.Tick()
    R = REPORTS[#REPORTS]
    ID = R ~= nil and tostring(R.id) or "nil"
    OK = R ~= nil and tostring(R.ok) or "nil"
    TEXT = R ~= nil and tostring(R.text) or "nil"
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
  `)
  assert.equal(global('ID'), 'model-wait')
  assert.equal(global('OK'), 'false')
  assert.match(global('TEXT'), /dark_no_light.*equip torch/)
  assert.equal(global('JOB'), 'nil')
})

test('SV3-4：夜里手上有火把 —— wait 照常等', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(`
    GLOBAL.TheWorld.state.phase = "night"
    PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = ${TORCH}
  `, '夜里 + 举着火把')
  runFile(`
    Whale.reflex_on = false
    Whale.actions.Start("wait", { seconds = 30 }, "model-wait")
    Whale.actions.Tick()
    NOW = NOW + 5
    Whale.actions.Tick()
    JOB = Whale.job ~= nil and Whale.job.name or "nil"
    N = tostring(#REPORTS)
  `)
  assert.equal(global('JOB'), 'wait')
  assert.equal(global('N'), '0')
})

test('SV3-6：等待跨入夜晚或手持火把烧完，下一次 tick 立即中断', async () => {
  const fengari = await import('fengari')
  for (const transition of ['nightfall', 'fuel_empty']) {
    const { run, runFile, global } = loadReflex(fengari)
    run(transition === 'nightfall'
      ? 'GLOBAL.TheWorld.state.phase = "dusk"'
      : `GLOBAL.TheWorld.state.phase = "night"
         PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = ${TORCH}`, transition)
    runFile(`
      Whale.reflex_on = false
      Whale.actions.Start("wait", { seconds = 30 }, "transition-wait")
      Whale.actions.Tick()
      BEFORE = Whale.job ~= nil and Whale.job.name or "nil"
      GLOBAL.TheWorld.state.phase = "night"
      local hand = PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS]
      if hand ~= nil then hand.components.fueled.IsEmpty = function() return true end end
      NOW = NOW + 1
      Whale.actions.Tick()
      R = REPORTS[#REPORTS]
      OK = R ~= nil and tostring(R.ok) or "nil"
      TEXT = R ~= nil and tostring(R.text) or "nil"
      AFTER = Whale.job ~= nil and Whale.job.name or "nil"
    `)
    assert.equal(global('BEFORE'), 'wait', transition)
    assert.equal(global('OK'), 'false', transition)
    assert.match(global('TEXT'), /dark_no_light/)
    assert.equal(global('AFTER'), 'nil', transition)
  }
})

test('SV3-5：等的时候掉血 —— wait 提前结束', async () => {
  const fengari = await import('fengari')
  const { runFile, global } = loadReflex(fengari)
  runFile(`
    Whale.reflex_on = false
    Whale.actions.Start("wait", { seconds = 30 }, "model-wait")
    Whale.actions.Tick()
    PLAYER.components.health.currenthealth = 100
    NOW = NOW + 1
    Whale.actions.Tick()
    R = REPORTS[#REPORTS]
    OK = R ~= nil and tostring(R.ok) or "nil"
    TEXT = R ~= nil and tostring(R.text) or "nil"
  `)
  assert.equal(global('OK'), 'false')
  assert.match(global('TEXT'), /took_damage/)
})

const LOGIC_SETUP = `
Whale.reflex_on = true
Whale.reflex_force_off = false
PLAYER.sg.HasStateTag = function(self, tag) return tag == "idle" end
PLAYER.IsInLight = function() return false end
local loco = PLAYER.components.locomotor
loco.Stop = function(self) self.dest = nil end
loco.Clear = function(self) self.dest = nil; self.bufferedaction = nil end
loco.GoToPoint = function(self, pt) self.dest = pt; MOVED_TO = pt end
loco.PushAction = function(self, ba) self:Clear(); self.bufferedaction = ba; PUSHED = ba end
function safefood(prefab, health)
    return mkitem(prefab, 1, { edible = { hungervalue = 12.5, healthvalue = health } })
end
`

for (const illuminated of [false, true]) {
  test(`LOGIC-1：附近有火但实际照明=${illuminated}，反射和等待使用真实光照`, async () => {
    const env = loadReflex(await import('fengari'))
    env.run(LOGIC_SETUP)
    env.run(`
      GLOBAL.TheWorld.state.phase = "night"
      PLAYER.IsInLight = function() return ${illuminated} end
      PLAYER.components.inventory._items = { ${TORCH} }
      NEARBY = { newent("campfire", 24, 0, { "light" }, {
          fueled = { IsEmpty = function() return false end } }) }
      assert(Whale.reflex.Diagnose().has_usable_light == ${illuminated})
      assert((Whale.reflex.DarkNoLight(PLAYER) == nil) == ${illuminated})
      Whale.actions.Start("wait", { seconds = 30 }, "wait-light")
      Whale.actions.Tick()
      ${illuminated ? 'assert(Whale.job ~= nil and #REPORTS == 0)' : `
      assert(Whale.job == nil and REPORTS[1].ok == false)
      assert(string.find(REPORTS[1].text, "dark_no_light", 1, true))
      ${eachTick()}
      assert(Whale.job ~= nil and Whale.job.name == "equip")
      `}
    `)
  })
}

for (const hunger of [150, 200]) {
  for (const healthValue of [0, 1]) {
    test(`LOGIC-2：回血食物 health=${healthValue}、饥饿=${hunger} 时只做有效抢占`, async () => {
      const env = loadReflex(await import('fengari'))
      env.run(LOGIC_SETUP)
      env.run(`
        PLAYER.components.health.currenthealth = 15
        PLAYER.components.hunger.current = ${hunger}
        PLAYER.components.inventory._items = {
            ${TORCH}, safefood("${healthValue ? 'carrot' : 'berries'}", ${healthValue}),
            mkitem("cutgrass", 6), mkitem("twigs", 6) }
        Whale.actions.Start("seek", {}, "model-seek", { survival_seek = true, prefab = "flint" })
        ${eachTick(10)}
        ${healthValue ? `
        assert(Whale.job ~= nil and Whale.job.name == "eat", "回血必须真的发起进食")
        assert(#REPORTS == 1 and REPORTS[1].id == "model-seek")
        Whale.actions.Tick()
        assert(PUSHED.invobject.prefab == "carrot")
        ` : `
        assert(Whale.job ~= nil and Whale.job.cmd_id == "model-seek", "零回血食物不许抢占")
        assert(#REPORTS == 0)
        `}
        assert(Whale.last_reflex_error == nil)
      `)
    })
  }
}

for (const mode of ['auto', 'explicit', 'healing']) {
  test(`LOGIC-3：吃掉最后一份食物后正确核验（${mode}）`, async () => {
    const env = loadReflex(await import('fengari'))
    env.run(LOGIC_SETUP)
    env.run(`
      PLAYER.components.inventory._items = { safefood("carrot", 1) }
      ${mode === 'healing' ? 'PLAYER.components.hunger.current = 200; PLAYER.components.health.currenthealth = 15' : ''}
      Whale.actions.Start("eat", {}, "eat-last", { survival_eat = true,
          ${mode === 'explicit' ? 'food = "carrot"' : ''} })
      Whale.actions.Tick()
      assert(PUSHED.action.id == "EAT")
      PLAYER.components.inventory._items = {}
      ${mode === 'healing' ? 'PLAYER.components.health.currenthealth = 16' : 'PLAYER.components.hunger.current = 162.5'}
      PLAYER.components.locomotor:Clear()
      NOW = NOW + 1
      Whale.actions.Tick()
      assert(#REPORTS == 1 and REPORTS[1].ok == true, REPORTS[1] and REPORTS[1].text)
      assert(Whale.job == nil)
    `)
  })
}

test('LOGIC-3：食物没消耗、饥饿没上涨时不能误报成功', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    PLAYER.components.inventory._items = { safefood("carrot", 1) }
    Whale.actions.Start("eat", {}, "eat-noop", { survival_eat = true })
    Whale.actions.Tick()
    PLAYER.components.locomotor:Clear()
    NOW = NOW + 21
    Whale.actions.Tick()
    assert(#REPORTS == 1 and REPORTS[1].ok == false)
    assert(string.find(REPORTS[1].text, "eat_failed", 1, true))
  `)
})

for (const cancel of ['abort', 'replace', 'stop', 'budget']) {
  test(`LOGIC-4：${cancel} 清空玩家和移动组件两处队列`, async () => {
    const env = loadReflex(await import('fengari'))
    env.run(LOGIC_SETUP)
    env.run(`
      Whale.actions.Start("wait", { seconds = 30 }, "old")
      Whale.actions.Tick()
      PLAYER.components.locomotor.bufferedaction = { action = GLOBAL.ACTIONS.PICK }
      BUFFERED = { action = GLOBAL.ACTIONS.PICK }
      ${cancel === 'abort' ? 'Whale.actions.Abort("cancel")' : cancel === 'replace'
        ? 'Whale.actions.Start("wait", { seconds = 10 }, "new")' : cancel === 'stop'
          ? 'Whale.actions.Start("stop", {}, "stop"); Whale.actions.Tick()'
          : 'Whale.job.t0 = NOW - 999; Whale.actions.Tick()'}
      assert(PLAYER:GetBufferedAction() == nil, "玩家队列必须清空")
      assert(PLAYER.components.locomotor.bufferedaction == nil, "移动组件队列必须清空")
      assert(PLAYER.components.locomotor.dest == nil, "服务端移动必须停止")
    `)
  })
}

for (const prefab of ['lantern', 'minerhat']) {
  test(`LOGIC-5：夜间装备背包实际拥有的 ${prefab}，不寻找不存在的火把`, async () => {
    const env = loadReflex(await import('fengari'))
    env.run(LOGIC_SETUP)
    env.run(`
      GLOBAL.TheWorld.state.phase = "night"
      local inv = PLAYER.components.inventory
      local slot = "${prefab === 'minerhat' ? 'head' : 'hands'}"
      inv._items = { mkitem("${prefab}", 1, { fueled = {
          IsEmpty = function() return false end, GetPercent = function() return 1 end } }) }
      inv.Equip = function(self, item) self._items = {}; self._equipped[slot] = item end
      PLAYER.IsInLight = function() return inv:GetEquippedItem(slot) ~= nil end
      ${eachTick()}
      assert(Whale.job ~= nil and Whale.job.name == "equip")
      assert(Whale.job.args.item == "${prefab}")
      Whale.actions.Tick()
      assert(inv:GetEquippedItem(slot).prefab == "${prefab}")
      assert(REPORTS[1].ok == true)
      NOW = NOW + 7
      ${eachTick()}
      assert(Whale.job == nil, "已经有光不能反复抢占")
      assert(Whale.reflex.Diagnose().has_usable_light == true)
    `)
  })
}

for (const item of ['lantern', 'minerhat']) {
  test(`LOGIC-5：外部 equip ${item} 按真实槽位核验`, async () => {
    const env = loadReflex(await import('fengari'))
    env.run(LOGIC_SETUP)
    env.run(`
      local inv = PLAYER.components.inventory
      local slot = "${item === 'minerhat' ? 'head' : 'hands'}"
      inv._items = { mkitem("${item}", 1, { inventoryitem = {} }) }
      inv.Equip = function(self, item) self._items = {}; self._equipped[slot] = item end
      Whale.actions.Start("equip", { item = "${item}" }, "external-equip", { survival_equip = true, item = "${item}" })
      Whale.actions.Tick()
      Whale.actions.Tick()
      assert(REPORTS[1] ~= nil and REPORTS[1].ok == true)
      assert(inv:GetEquippedItem(slot).prefab == "${item}")
    `)
  })
}

test('LOGIC-5：耗尽的提灯不阻止制作火把', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "night"
    PLAYER.components.inventory._items = {
        mkitem("lantern", 1, { fueled = { IsEmpty = function() return true end } }),
        mkitem("cutgrass", 2), mkitem("twigs", 2) }
    ${eachTick()}
    assert(Whale.job ~= nil and Whale.job.name == "craft")
  `)
})

test('LOGIC-6：seek 原地扫描找不到时正常返回、不移动', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    PLAYER._x = 0; PLAYER._z = 0
    NEARBY = {}
    MOVED_TO = nil
    Whale.actions.Start("seek", {}, "seek-end", { survival_seek = true, prefab = "flint", max_tiles = 10 })
    Whale.actions.Tick()
    assert(#REPORTS == 1 and REPORTS[1].ok == false)
    assert(string.find(REPORTS[1].text, "没看到 flint", 1, true), REPORTS[1].text)
    assert(MOVED_TO == nil, "seek 不应再绕圈走动")
    assert(PLAYER.components.locomotor.dest == nil)
  `)
})

test('LOGIC-7：seek 原地扫描遵守 max_tiles（4 格找不到、40 格能找到），且不移动', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    PLAYER._x = 0; PLAYER._z = 0
    NEARBY = { newent("flint", 80, 0, {}) }  -- 80 世界单位 = 20 格
    MOVED_TO = nil
    REPORTS = {}
    Whale.actions.Start("seek", {}, "s4", { survival_seek = true, prefab = "flint", max_tiles = 4 })
    Whale.actions.Tick()
    assert(REPORTS[1] ~= nil and REPORTS[1].ok == false, "4 格内不应找到 20 格外的 flint")
    REPORTS = {}
    Whale.actions.Start("seek", {}, "s40", { survival_seek = true, prefab = "flint", max_tiles = 40 })
    Whale.actions.Tick()
    assert(REPORTS[1] ~= nil and REPORTS[1].ok == true, "40 格内应找到")
    assert(string.find(REPORTS[1].text, "flint", 1, true))
    assert(MOVED_TO == nil, "seek 不应走动")
    assert(PLAYER.components.locomotor.dest == nil)
  `)
})

// ─────────────────────────── REFLEX-FIX-02 专项验证（12 项测试）───────────────────────────

test('FIX-02-1：饥饿 70/200，正在采矿，不触发紧急抢占', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    PLAYER.components.hunger.current = 70
    PLAYER.components.health.currenthealth = 150
    PLAYER.components.inventory._items = { safefood("berries", 0) }
    Whale.actions.Start("mine", {}, "model-mine", { survival_work = true, action = "MINE" })
    ${eachTick(5)}
    assert(Whale.job ~= nil and Whale.job.cmd_id == "model-mine", "70/200 普通饥饿绝不打断采矿")
    local needs = Whale.reflex.Needs()
    local has_food_need = false
    for _, n in ipairs(needs) do if n.kind == "food" then has_food_need = true end end
    assert(has_food_need == true, "普通饥饿必须上报需求给 Plan")
  `)
})

test('FIX-02-2：饥饿真正达到紧急程度（40/200），背包有食物，允许进食一次', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    PLAYER.components.hunger.current = 40
    PLAYER.components.inventory._items = { safefood("berries", 0) }
    Whale.actions.Start("gather_area", {}, "model-g", { survival_area = true })
    ${eachTick(5)}
    assert(Whale.job ~= nil and Whale.job.name == "eat", "真正紧急时允许进食抢占")
    assert(Whale.job.cmd_id == "reflex")
  `)
})

test('FIX-02-3：饥饿恢复后进入冷却防抖，不重复进食', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    PLAYER.components.hunger.current = 40
    PLAYER.components.inventory._items = { safefood("berries", 0) }
    ${eachTick(5)}
    assert(Whale.job ~= nil and Whale.job.name == "eat")
    Whale.actions.Tick()
    PLAYER.components.hunger.current = 75
    Whale.actions.Tick()
    ${eachTick(5)}
    assert(Whale.job == nil, "饥饿恢复后不能重复发起进食")
  `)
})

test('FIX-02-4：白天正在装备长矛，Reflex 不允许收起或替换手持物品', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "day"
    local inv = PLAYER.components.inventory
    inv._equipped[GLOBAL.EQUIPSLOTS.HANDS] = mkitem("spear", 1, { equippable = { equipslot = "hands" }, inventoryitem = {} })
    Whale.actions.Start("equip", { item = "spear" }, "model-equip")
    ${eachTick(10)}
    assert(Whale.job ~= nil and Whale.job.cmd_id == "model-equip", "装备长矛期间 Reflex 绝不抢占")
    assert(inv._equipped[GLOBAL.EQUIPSLOTS.HANDS].prefab == "spear", "长矛仍在手上")
  `)
})

test('FIX-02-5：夜晚没有光源，背包有火炬，紧急装备成功', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "night"
    PLAYER.IsInLight = function() return false end
    PLAYER.components.inventory._items = { ${TORCH} }
    ${eachTick(5)}
    assert(Whale.job ~= nil and Whale.job.name == "equip" and Whale.job.cmd_id == "reflex")
    assert(Whale.job.args.item == "torch")
  `)
})

test('FIX-02-6：夜晚没有火炬但有制作材料，按紧急流程制作照明', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "night"
    PLAYER.IsInLight = function() return false end
    PLAYER.components.inventory._items = { mkitem("cutgrass", 2), mkitem("twigs", 2) }
    ${eachTick(5)}
    assert(Whale.job ~= nil and Whale.job.name == "craft" and Whale.job.cmd_id == "reflex")
    assert(Whale.job.args.recipe == "torch")
  `)
})

test('FIX-02-7：遭遇攻击时动态评估多个方向，避开危险和失败点', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    local spider = newent("spider", 4 * 4, 0, { "hostile" }, {
        combat = { target = PLAYER },
        health = { IsDead = function() return false end, currenthealth = 100 },
    })
    NEARBY = { spider }
    ${eachTick(5)}
    assert(Whale.job ~= nil and Whale.job.name == "move_to" and Whale.job.cmd_id == "reflex")
    assert(Whale.job.args.x < 0, "逃跑方向选择背离敌人的安全方向")
    local dz = Whale.reflex.DangerZones()
    assert(#dz > 0, "逃生必须生成短期危险区域记录")
  `)
})

test('FIX-02-8：逃生目标点失败冷却后，不再向同一个不可达坐标重复移动', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    local spider = newent("spider", 4 * 4, 0, { "hostile" }, {
        combat = { target = PLAYER },
        health = { IsDead = function() return false end, currenthealth = 100 },
    })
    NEARBY = { spider }
    ${eachTick(5)}
    local first_x, first_z = Whale.job.args.x, Whale.job.args.z
    Whale.actions.Abort("failed_move")
    ${eachTick(5)}
    ${eachTick(5)}
    if Whale.job ~= nil and Whale.job.name == "move_to" then
        local key1 = first_x .. "_" .. first_z
        local key2 = Whale.job.args.x .. "_" .. Whale.job.args.z
        assert(key1 ~= key2, "相同失败逃生坐标的重复尝试次数必须为 0")
    end
  `)
})

test('FIX-02-9：脱离危险后，主 Plan 记录危险区域且不立即返回原危险目标', async () => {
  const { derivePlan } = await import('../lib/plan.js')
  const snapshot = {
    schema: 'bws.state/1',
    status: 'ok',
    player: { health: { percent: 80, current: 80, max: 100 }, hunger: { percent: 80, current: 160, max: 200 } },
    actor: { tileX: 0, tileZ: 0, alive: true, valid: true },
    world: { phase: 'day', day: 2 },
    dangerZones: [{ x: 5, z: 0, radius: 10, source: 'spiderden', ageS: 5, ttlS: 55 }],
    nearby: {
      buckets: {
        harvestables: [
          { prefab: 'berrybush', x: 5, z: 0, distance: 5, harvest_ready: true },
          { prefab: 'berrybush', x: -15, z: 0, distance: 15, harvest_ready: true },
        ],
        threats: [],
      },
    },
  }
  const plan = derivePlan(snapshot)
  assert.equal(!plan.next.includes('距 5 格'), true, 'Plan 自动避开处于危险区域内的目标')
})

test('FIX-02-10：死亡后只触发一次 RESET，停止普通动作调度', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    PLAYER.components.health.currenthealth = 0
    RESET_COUNT = 0
    print = function(s)
        local str = tostring(s)
        if string.find(str, "reset", 1, true) and string.find(str, "reason=dead", 1, true) then
            RESET_COUNT = RESET_COUNT + 1
        end
    end
    ${eachTick(20)}
    assert(RESET_COUNT == 1, "死亡状态每秒不能重复 RESET，必须只触发 1 次，实际是: " .. tostring(RESET_COUNT))
    assert(Whale.job == nil, "死亡后停止普通动作调度")
  `)
})

test('FIX-02-11：Lua 计时逻辑在 os=nil 环境下安全运行无报错', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.os = nil
    local ok, err = GLOBAL.pcall(function()
        Whale.util.now()
        Whale.reflex.Tick()
    end)
    assert(ok == true, "os 为 nil 时不抛异常: " .. tostring(err))
    assert(Whale.last_reflex_error == nil, "reflex 内部无 os nil 错误")
  `)
})

test('FIX-02-12：spear 装备能够通过正确的组件和白名单检查', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    local spear = mkitem("spear", 1, {
        inventoryitem = {},
        equippable = {
            equipslot = GLOBAL.EQUIPSLOTS.HANDS,
            CanBeEquippedBy = function(self, p) return true end
        }
    })
    local ok_p, err_p = Whale.equiprules.IsAllowedPrefab("spear")
    assert(ok_p == true, "spear 必须在装备白名单中")
    local ok_e, err_e = Whale.equiprules.IsEquippable(spear, PLAYER)
    assert(ok_e == true, "带 equippable 的 spear 必须判定为可装备")
    assert(Whale.equiprules.SlotFor("spear") == GLOBAL.EQUIPSLOTS.HANDS, "spear 槽位判定为 hands")
  `)
})

test('FIX-02-13：主动战斗任务（kill/attack）在血量>=50%时不被 under_attack 逃跑打断，残血时恢复逃跑', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "day"
    PLAYER.components.health.currenthealth = 120
    PLAYER.components.health.maxhealth = 150 -- 80% HP

    -- 创建一只攻击玩家的蜘蛛
    local spider = newent("spider", 2, 0, { "hostile", "monster", "spider" }, {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
        combat = { target = PLAYER },
    })
    NEARBY = { spider }

    -- 模拟模型发起的 kill 任务
    Whale.actions.Start("kill", {}, "model_cmd_kill_1")

    -- 跑反射 5 ticks（≈1 秒节流）
    NOW = NOW + 2
    ${eachTick(5)}

    -- 验证：战斗任务未被中断，没有触发逃跑
    assert(Whale.job ~= nil and Whale.job.name == "kill", "血量充足时主动战斗任务不应被打断")

    -- 现在玩家掉血到 40% (< 50%)
    PLAYER.components.health.currenthealth = 60
    NOW = NOW + 2
    ${eachTick(5)}

    -- 验证：血量不足 50% 时触发逃跑，战斗任务被抢占中断
    assert(Whale.job == nil or Whale.job.cmd_id == "reflex", "血量低于 50% 时应触发紧急避险")
  `)
})

// ─────── 真机回归（session 8fab0944 第 3 天）：打建筑被围殴不能算"正在战斗" ───────
//
// 现象：温蒂被指令去打蜘蛛巢（hi0，250 血），攻击惊动了 3 只守卫蜘蛛。
//       血量从 150 被打到 33（22%）—— 全程反射都没让她撤，
//       因为旧逻辑只看 job.name 是 attack/kill + 血 >= 50%，完全不看打的是谁。

test('FIX-02-14：攻击的是建筑、却被守卫怪围殴 —— 必须立刻撤退（不能算主动交战）', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "day"
    PLAYER.components.health.currenthealth = 140   -- 93%：血量充足，旧逻辑一定不撤
    PLAYER.components.health.maxhealth = 150

    -- 被攻击的目标：蜘蛛巢（结构，不追人）
    local den = newent("spiderden", 0, 0, { "hostile", "structure", "spiderden" }, {
        health = { currenthealth = 250, maxhealth = 250, IsDead = function() return false end },
    })
    -- 3 只正在打玩家的守卫蜘蛛
    local guards = {}
    for i = 1, 3 do
        guards[i] = newent("spider", 2, 0, { "hostile", "monster", "spider" }, {
            health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
            combat = { target = PLAYER },
        })
    end
    NEARBY = { den, guards[1], guards[2], guards[3] }

    -- 模型正在打那个巢（ctx.target = den），不是打蜘蛛
    Whale.actions.Start("attack", {}, "model_cmd_den", { target = den, times = 5 })

    NOW = NOW + 2
    ${eachTick(5)}

    -- 必须中断攻击、转为逃跑
    assert(Whale.job == nil or Whale.job.cmd_id == "reflex",
        "打建筑时被守卫怪围殴必须中断，实际 job=" .. tostring(Whale.job and Whale.job.name))
  `)
})

test('FIX-02-15：一对一打怪（目标就是攻击者）时，血量充足仍保持主动交战', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "day"
    PLAYER.components.health.currenthealth = 120   -- 80%
    PLAYER.components.health.maxhealth = 150

    local spider = newent("spider", 2, 0, { "hostile", "monster", "spider" }, {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
        combat = { target = PLAYER },
    })
    NEARBY = { spider }

    -- 目标就是这只蜘蛛：这是真正的"主动交战"
    Whale.actions.Start("kill", {}, "model_cmd_spider", { target = spider })

    NOW = NOW + 2
    ${eachTick(5)}

    assert(Whale.job ~= nil and Whale.job.name == "kill",
        "一对一主动交战不该被撤退打断，实际 job=" .. tostring(Whale.job and Whale.job.name))
  `)
})

test('FIX-02-16：目标本身正在攻击我（哪怕旁边还有别的蜘蛛）→ 仍算主动交战，不打断', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "day"
    PLAYER.components.health.currenthealth = 120   -- 80%
    PLAYER.components.health.maxhealth = 150

    local a = newent("spider", 2, 0, { "hostile", "monster", "spider" }, {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
        combat = { target = PLAYER },
    })
    local b = newent("spider", -2, 0, { "hostile", "monster", "spider" }, {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
        combat = { target = PLAYER },
    })
    NEARBY = { a, b }

    -- 打的就是正在咬我的 a：这是正常战斗，不该被打断
    Whale.actions.Start("kill", {}, "model_cmd_a", { target = a })

    NOW = NOW + 2
    ${eachTick(5)}

    assert(Whale.job ~= nil and Whale.job.name == "kill",
        "打的是正在攻击我的蜘蛛时不该撤退，实际 job=" .. tostring(Whale.job and Whale.job.name))
  `)
})

test('FIX-02-17：目标是个不会打人的活物（比如打中立建筑/巢）→ 被真怪攻击时必须撤', async () => {
  const env = loadReflex(await import('fengari'))
  env.run(LOGIC_SETUP)
  env.run(`
    GLOBAL.TheWorld.state.phase = "day"
    PLAYER.components.health.currenthealth = 140   -- 93%：血量充足
    PLAYER.components.health.maxhealth = 150

    -- 打的是一棵树（有 health 但不会攻击玩家）
    local tree = newent("evergreen", 1, 0, { "tree" }, {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
    })
    -- 一只正在咬我的蜘蛛
    local spider = newent("spider", -2, 0, { "hostile", "monster", "spider" }, {
        health = { currenthealth = 100, maxhealth = 100, IsDead = function() return false end },
        combat = { target = PLAYER },
    })
    NEARBY = { tree, spider }

    Whale.actions.Start("attack", {}, "model_cmd_tree", { target = tree, times = 3 })

    NOW = NOW + 2
    ${eachTick(5)}

    assert(Whale.job == nil or Whale.job.cmd_id == "reflex",
        "打不会还手的目标时被怪咬，必须优先逃跑，实际 job=" .. tostring(Whale.job and Whale.job.name))
  `)
})


// ═══════════════════════ R8.1：本地生存大脑（换手冻结 / 温度方向 / 日常维护） ═══════════════════════

const R81_SETUP = `
  NEARBY = {}
  PLAYER.components.health.currenthealth = 150
  PLAYER.components.health.maxhealth = 150
  PLAYER.components.hunger.current = 150
  PLAYER.components.hunger.max = 200
  PLAYER.components.sanity.current = 200
  PLAYER.components.sanity.max = 200
  PLAYER.components.temperature = { GetCurrent = function() return 20 end }
  PLAYER.components.inventory._items = {}
  PLAYER.components.inventory._equipped = {}
  PUSHED = nil
  MOVED_TO = nil
  BUFFERED = nil
  Whale.job = nil
  Whale.reflex_on = true
  Whale.reflex_force_off = false
  GLOBAL.TheWorld.state.phase = "day"
  GLOBAL.TheWorld.state.temperature = 20
`
const PUT_TORCH = 'PLAYER.components.inventory._equipped[GLOBAL.EQUIPSLOTS.HANDS] = mkitem("torch", 1, { fueled = { IsEmpty = function() return false end, GetPercent = function() return 0.9 end } })'

test('R81-FREEZE-01：revoking 冻结期间 Reflex 不启动任何新动作；A.Start(reflex) 直接拒绝；解冻后恢复', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run(PUT_TORCH, '有火把避免走造光分支')
  run('Whale.bridge.LocalActionsFrozen = function() return FROZEN == true end; FROZEN = true', '冻结钩子')
  runFile('local ok = Whale.actions.Start("move_to", { x = 3, z = 3 }, "reflex"); BLK = ok and "no" or "yes"')
  assert.equal(global('BLK'), 'yes', '冻结期间 A.Start(reflex) 必须返回失败')
  run(eachTick(10), '冻结下跑 10 tick')
  runFile('FZP = (PUSHED ~= nil or Whale.job ~= nil) and "yes" or "no"')
  assert.equal(global('FZP'), 'no', '冻结期间不得启动任何反射动作')
  run('FROZEN = false', '解冻')
  run('GLOBAL.TheWorld.state.phase = "night"', '改夜间避免白天收火把干扰')
  run('PLAYER.components.sanity.current = 60', '理智低')
  run('NEARBY = { newent("flower", 2, 0, {}) }', '近处有花')
  run(eachTick(10), '解冻后跑 10 tick')
  runFile('UFZ = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.notEqual(global('UFZ'), 'none', '解冻后反射应能重新启动维护动作')
})

test('R81-TEMP-01：过热（>65）绝不向火堆移动（只上报）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('GLOBAL.TheWorld.state.phase = "night"', '夜间+火把避免白天收火把')
  run(PUT_TORCH, '有火把')
  run('NEARBY = { newent("campfire", 2, 0, {"fire"}, { fueled = { IsEmpty = function() return false end, GetPercent = function() return 0.9 end } }) }', '近处火堆')
  run('PLAYER.components.temperature = { GetCurrent = function() return 80 end }', '过热 80')
  run(eachTick(10), '跑 10 tick')
  runFile('HOT_MOVED = ((MOVED_TO ~= nil) or (Whale.job ~= nil and Whale.job.name == "move_to")) and "yes" or "no"')
  runFile('HOT_JOB = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.equal(global('HOT_MOVED'), 'no', '过热时不得向火堆移动')
  assert.equal(global('HOT_JOB'), 'none', '过热时不应启动任何动作（只上报）')
})

test('R81-TEMP-02：过冷（<5）会靠近点燃的热源', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('GLOBAL.TheWorld.state.phase = "night"', '夜间+火把')
  run(PUT_TORCH, '有火把避免造光')
  run('NEARBY = { newent("campfire", 2, 0, {"fire"}, { fueled = { IsEmpty = function() return false end, GetPercent = function() return 0.9 end } }) }', '近处点燃火堆')
  run('PLAYER.components.temperature = { GetCurrent = function() return -5 end }', '过冷 -5')
  run(eachTick(10), '跑 10 tick')
  runFile('COLD_JOB = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.equal(global('COLD_JOB'), 'move_to', '过冷时应当 move_to 热源')
})

test('R81-SANITY-01：低理智 + 近处有花 → 空闲时采集（P2）', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('GLOBAL.TheWorld.state.phase = "night"', '夜间避免收火把')
  run(PUT_TORCH, '有火把')
  run('PLAYER.components.sanity.current = 60', '理智低 30%')
  run('NEARBY = { newent("flower", 2, 0, {}) }', '近处有花')
  run(eachTick(10), '跑 10 tick')
  runFile('SAN_JOB = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.equal(global('SAN_JOB'), 'gather', '低理智空闲且有近花时应 gather 采花')
})

test('R81-SANITY-02：低理智但附近没有花 → 不无目标漫游', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('GLOBAL.TheWorld.state.phase = "night"', '夜间避免收火把')
  run(PUT_TORCH, '有火把')
  run('PLAYER.components.sanity.current = 60', '理智低')
  run('NEARBY = {}', '附近无花')
  run(eachTick(10), '跑 10 tick')
  runFile('NOFLOWER_JOB = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.equal(global('NOFLOWER_JOB'), 'none', '附近无花时不得启动漫游/采集')
})

test('R81-FOOD-01：没有安全食物时不执行 eat', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('GLOBAL.TheWorld.state.phase = "night"', '夜间避免收火把')
  run(PUT_TORCH, '有火把')
  run('PLAYER.components.hunger.current = 80', '饥饿 40%')
  run('PLAYER.components.inventory._items[1] = mkitem("monstermeat", 2)', '只有怪物肉（不安全）')
  run(eachTick(10), '跑 10 tick')
  runFile('FOOD_JOB = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.notEqual(global('FOOD_JOB'), 'eat', '没有安全食物时绝不能 eat')
})

test('R81-PREEMPT-01：P2 维护（理智采花）不得抢占正在进行的模型任务', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('GLOBAL.TheWorld.state.phase = "night"', '夜间避免收火把')
  run(PUT_TORCH, '有火把')
  run('PLAYER.components.sanity.current = 60', '理智低')
  run('NEARBY = { newent("flower", 2, 0, {}) }', '近处有花')
  runFile('Whale.actions.Start("move_to", { x = 50, z = 50 }, "mcp_client")')
  run(eachTick(10), '跑 10 tick')
  runFile('KEEP_JOB = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.equal(global('KEEP_JOB'), 'move_to', 'P2 理智维护不得抢占模型任务')
})

test('R81-PREEMPT-02：P0 紧急（夜间无光）仍可抢占模型任务', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('GLOBAL.TheWorld.state.phase = "night"', '入夜')
  run('PLAYER.components.inventory._items[1] = mkitem("cutgrass", 2); PLAYER.components.inventory._items[2] = mkitem("twigs", 2)', '火把材料够')
  runFile('Whale.actions.Start("move_to", { x = 50, z = 50 }, "mcp_client")')
  run(eachTick(10), '跑 10 tick')
  runFile('P0_JOB = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.notEqual(global('P0_JOB'), 'move_to', 'P0 夜间无光应抢占模型任务（job 应变为造光相关）')
})

test('R81-FUEL-01：火源低于阈值（白天<20%）→ 空闲时启动一次 add_fuel', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('NEARBY = { newent("campfire", 2, 0, {"fire"}, { fueled = { IsEmpty = function() return false end, GetPercent = function() return 0.1 end } }) }', '低燃料火堆')
  run('PLAYER.components.inventory._items[1] = mkitem("log", 5)', '背包有木头')
  run(eachTick(10), '跑 10 tick')
  runFile('FUEL_JOB = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.equal(global('FUEL_JOB'), 'add_fuel', '白天低燃料空闲时应启动 add_fuel')
})

test('R81-FUEL-02：燃料状态未更新 → 冷却期内不会连续重复添柴', async () => {
  const fengari = await import('fengari')
  const { run, runFile, global } = loadReflex(fengari)
  run(R81_SETUP, 'setup')
  run('NEARBY = { newent("campfire", 2, 0, {"fire"}, { fueled = { IsEmpty = function() return false end, GetPercent = function() return 0.1 end } }) }', '低燃料火堆')
  run('PLAYER.components.inventory._items[1] = mkitem("log", 5)', '背包有木头')
  run(eachTick(10), '启动 add_fuel')
  // 推进核心动作两次：start→acting→done（燃料百分比桩不变=未更新）
  run('if Whale.job ~= nil then Whale.actions.Tick(); Whale.actions.Tick() end', '把这次添柴跑完（燃料未涨）')
  run(eachTick(20), '继续跑反射')
  runFile('FUEL2 = (Whale.job ~= nil) and tostring(Whale.job.name) or "none"')
  assert.notEqual(global('FUEL2'), 'add_fuel', '燃料没更新时不得连续重复添柴')
})
