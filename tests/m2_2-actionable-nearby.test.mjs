// M2.2 Actionable Nearby：可行动目标观察与优先级
//
// 证据类型：UNIT（fengari 假游戏 + 真实 nearby.lua/pickuprules.lua；Node 侧用真实 snapshot.js）
// 覆盖：新桶 / 候选判定 / 食物分类修复 / 排序 / 上限 / 截断 / 引用 / Delta / 跨桶转换 /
//       观察-执行一致 / Node 兼容与 fallback
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nearbyLines } from '../lib/state/snapshot.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = {
    WARLY = "沃利", SPIDER = "蜘蛛", BERRYBUSH = "浆果丛", EVERGREEN = "常青树",
    ROCK = "石头", CHEST = "箱子", FIREPIT = "火坑", PIGMAN = "猪人", LOG = "木头",
    CARROT = "胡萝卜", TWIGS = "树枝", CUTGRASS = "草", FLINT = "燧石", BERRIES = "浆果",
} }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.FOODTYPE = { GENERIC = "GENERIC", MEAT = "MEAT", VEGGIE = "VEGGIE", INSECT = "INSECT",
                    GOODIES = "GOODIES", MONSTER = "MONSTER", HORRIBLE = "HORRIBLE",
                    ELEMENTAL = "ELEMENTAL", ROUGHAGE = "ROUGHAGE", SEEDS = "SEEDS",
                    GEARS = "GEARS", WOOD = "WOOD", NITRE = "NITRE", BERRY = "BERRY" }
GLOBAL.ACTIONS = { CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, DIG = { id = "DIG" },
                   HAMMER = { id = "HAMMER" }, PICK = { id = "PICK" }, PICKUP = { id = "PICKUP" },
                   HARVEST = { id = "HARVEST" } }
GLOBAL.TheNet = { GetSessionIdentifier = function() return SESSION end }
GLOBAL.TheShard = { GetShardId = function() return SHARD end }

NOW = 1000
SESSION = "sess-A"
SHARD = "Master"
NEARBY = {}
FAIL_SCAN = false
MAX_TOTAL = 60
MAX_PER = 12
GLOBAL.TheSim = {
    GetTime = function() return NOW end,
    GetRealTime = function() return NOW * 1000 end,
    FindEntities = function() if FAIL_SCAN then error("boom") end return NEARBY end,
}

-- 假实体：opts = { prefab, x, z, guid, valid, limbo, tags, hp, work, harvestable,
--                  item, canbepickedup, owner, stack, edible, edible_type, container, prototyper, fuel }
function mkent(opts)
    opts = opts or {}
    local ent = {
        prefab = opts.prefab or "thing",
        GUID = opts.guid or 1,
        valid = opts.valid ~= false,
        limbo = opts.limbo == true,
        tags = opts.tags or {},
        components = {},
        Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end },
    }
    ent.IsValid = function(self) return self.valid end
    ent.IsInLimbo = function(self) return self.limbo end
    ent.HasTag = function(self, tag)
        if tag == "INLIMBO" then return self.limbo end
        return self.tags[tag] == true
    end
    if opts.hp ~= nil then
        ent.components.health = { currenthealth = opts.hp, maxhealth = opts.maxhp or opts.hp,
                                  IsDead = function(self) return self.currenthealth <= 0 end }
    end
    if opts.work ~= nil then ent.components.workable = { action = { id = opts.work } } end
    if opts.harvestable then
        ent.components.harvestable = { CanBeHarvested = function() return opts.harvestable_ready ~= false end }
    end
    if opts.item then
        ent.components.inventoryitem = {
            owner = opts.owner or nil,
            canbepickedup = opts.canbepickedup ~= false,
        }
        if opts.stack ~= nil then
            ent.components.stackable = { StackSize = function() return opts.stack end }
        end
    end
    if opts.edible then ent.components.edible = { foodtype = opts.edible_type or "VEGGIE" } end
    -- M2.3：可收获对象要能被 HarvestRules 识别（原生 pickable 组件 + CanBePicked）
    if opts.pickable then
        ent.components.pickable = {
            canbepicked = opts.pickable_ready ~= false,
            cycles_left = opts.cycles_left or 3,
            product = opts.product or nil,
            caninteractwith = true,
            CanBePicked = function(self) return self.canbepicked end,
            IsBarren = function(self) return (self.cycles_left or 1) == 0 end,
            IsStuck = function(self) return false end,
        }
    end
    if opts.container then
        ent.components.container = { IsOpen = function() return opts.container_open == true end }
    end
    if opts.prototyper then ent.components.prototyper = {} end
    if opts.fuel ~= nil then ent.components.fueled = { GetPercent = function() return opts.fuel end } end
    return ent
end

function mkplayer(opts)
    opts = opts or {}
    local p = mkent({ prefab = "warly", x = opts.x or 0, z = opts.z or 0, guid = 999,
                      tags = { player = true }, hp = opts.hp or 150, maxhp = 150 })
    p.userid = "KU_test"
    p.components.inventory = {
        GetNumSlots = function() return 15 end,
        GetItemInSlot = function() return nil end,
        GetEquippedItem = function() return nil end,
        CanAcceptCount = function() return 9 end,
    }
    return p
end

PLAYER = mkplayer({ x = 0, z = 0 })
GLOBAL.AllPlayers = { PLAYER }
GLOBAL.TheWorld = { state = { cycles = 2, phase = "day", season = "autumn", temperature = 20 },
                    HasTag = function() return false end, ismastersim = true }
GLOBAL.setmetatable = setmetatable
GLOBAL.getmetatable = getmetatable
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.os = { time = function() return 1794500000 end, clock = function() return 0 end }
GLOBAL.io = nil
pcall = nil
tonumber = nil
error = nil
os = nil
io = nil
`

async function load({ withGuard = false } = {}) {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const fail = () => { try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' } }
  const run = (code, what) => {
    const st = lauxlib.luaL_dostring(L, to_luastring(code))
    if (st !== lua.LUA_OK) throw new Error(`${what} 出错：${fail()}`)
  }
  const get = (name) => { lua.lua_getglobal(L, to_luastring(name)); try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' } }
  run(STUB, '假游戏')
  run('Whale = { verbose = false, version = "0.16.0" }', 'Whale')
  const mods = ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'observe']
  if (withGuard) mods.push('guard')
  for (const n of mods) run(readFileSync(join(MOD, 'scripts', 'whale', n + '.lua'), 'utf8'), n + '.lua')
  const CONFIG_CODE = `Whale.config.build(function(k)
        if k == "scan_radius" then return 16 end
        if k == "scan_seconds" then return 4 end
        if k == "observe_interval" then return 2 end
        if k == "state_interval" then return 1 end
        if k == "nearby_max_total" then return MAX_TOTAL end
        if k == "nearby_max_per_bucket" then return MAX_PER end
        return nil
      end)`
  run(CONFIG_CODE, '配置')

  const observe = () => {
    run(`
      local actor = Whale.actor.get_actor()
      local text, data = Whale.observe.Build(actor)
      OUT_NEARBY = Whale.json.encode(data.nearby)
      OUT_TEXT = text
    `, '观察')
    return { nearby: JSON.parse(get('OUT_NEARBY')), text: get('OUT_TEXT') }
  }
  const flat = (nearby) => {
    const out = []
    for (const key of Object.keys(nearby.buckets ?? {})) for (const it of nearby.buckets[key]) out.push({ ...it, bucket: key })
    return out
  }
  // 上限来自"构建后的配置"，改完全局必须重新 build 才生效
  const setCaps = (total, per) => {
    run('MAX_TOTAL = ' + total + '; MAX_PER = ' + per, '上限')
    run(CONFIG_CODE, '重建配置')
  }
  return { run, get, observe, flat, setCaps }
}

const whitelisted = (ent) => ent.item && ent.canbepickedup !== false && !ent.owner

// ═══════════════════════ 桶结构 / 候选判定 ═══════════════════════

test('M2.2-01 九桶齐全（M2.3 加了 harvestables）：pickupables 排在 threats 之后、food 之前；空场景不报错', async () => {
  const env = await load()
  env.run('NEARBY = {}', '空场景')
  const { nearby } = env.observe()
  // JSON 键序是 Lua 哈希表顺序，不保证稳定（消费方按 BUCKET_LABELS/N.BUCKETS 走）
  const keys = Object.keys(nearby.buckets).sort()
  assert.deepEqual(keys, ['containers', 'creatures', 'food', 'harvestables', 'other', 'pickupables', 'resources', 'structures', 'threats'].sort())
  for (const k of keys) assert.deepEqual(nearby.buckets[k], [], `${k} 应该是空数组`)
  assert.equal(nearby.status, 'empty')
  assert.equal(nearby.total_found, 0)
  assert.equal(nearby.truncated, false)
})

test('M2.2-02 白名单三件都进 pickupables，字段齐全（ref/prefab/category/label/distance/item_kind/position）', async () => {
  const env = await load()
  env.run(`NEARBY = {
    mkent({ prefab = "twigs", guid = 11, x = 8, z = 0, item = true, canbepickedup = true, stack = 3 }),
    mkent({ prefab = "cutgrass", guid = 12, x = 16, z = 0, item = true, canbepickedup = true }),
    mkent({ prefab = "flint", guid = 13, x = 24, z = 0, item = true, canbepickedup = true, edible = true, edible_type = "ELEMENTAL" }),
  }`, '三件物品')
  const { nearby } = env.observe()
  const flat = env.flat
  const picks = nearby.buckets.pickupables
  assert.equal(picks.length, 3, '三件都该进 pickupables')
  assert.deepEqual(picks.map((p) => p.prefab).sort(), ['cutgrass', 'flint', 'twigs'])
  for (const p of picks) {
    assert.equal(p.category, 'pickupables')
    assert.match(p.ref, /^#\d+$/)
    assert.equal(typeof p.label, 'string')
    assert.equal(typeof p.distance, 'number')
    assert.ok(p.position && typeof p.position.x === 'number')
    assert.equal(p.item_kind, 'resources', '原本是资源语义')
  }
  // 不再出现在原来的桶里
  assert.equal(nearby.buckets.resources.length, 0)
  assert.equal(nearby.buckets.food.length, 0)
})

test('M2.2-03 一个实体只进一个桶（按 GUID 计数，不重复）', async () => {
  const env = await load()
  env.run(`NEARBY = {
    mkent({ prefab = "twigs", guid = 21, x = 8, z = 0, item = true, canbepickedup = true }),
    mkent({ prefab = "evergreen", guid = 22, x = 16, z = 0, work = "CHOP" }),
    mkent({ prefab = "spider", guid = 23, x = 24, z = 0, hp = 25, tags = { hostile = true } }),
    mkent({ prefab = "grass", guid = 24, x = 32, z = 0, tags = { pickable = true } }),
  }`, '混杂')
  const { nearby } = env.observe()
  const flat = env.flat
  const refs = flat(nearby).map((e) => e.ref)
  assert.equal(new Set(refs).size, refs.length, 'ref 不能重复')
  assert.equal(flat(nearby).length, nearby.total_returned, '每个实体只出现一次')
  const byPrefab = Object.fromEntries(flat(nearby).map((e) => [e.prefab, e.bucket]))
  assert.equal(byPrefab.twigs, 'pickupables')
  assert.equal(byPrefab.evergreen, 'resources')
  assert.equal(byPrefab.spider, 'threats')
  assert.equal(byPrefab.grass, 'resources')
})

test('M2.2-04 flint 不再进 food（ELEMENTAL 不是玩家食物），而是进 pickupables', async () => {
  const env = await load()
  env.run(`NEARBY = { mkent({ prefab = "flint", guid = 31, x = 8, z = 0, item = true,
                              canbepickedup = true, edible = true, edible_type = "ELEMENTAL" }) }`, 'flint')
  const { nearby } = env.observe()
  const flat = env.flat
  assert.equal(nearby.buckets.food.length, 0, 'flint 绝不能进 food')
  assert.equal(nearby.buckets.pickupables.length, 1)
  assert.equal(flat(nearby)[0].item_kind, 'resources')
  assert.equal(flat(nearby)[0].edible, undefined, '既然不是玩家食物，就不该标 edible')
})

test('M2.2-05 真食物仍然进 food（落地的 VEGGIE、可采的浆果丛）', async () => {
  const env = await load()
  env.run(`NEARBY = {
    mkent({ prefab = "berries", guid = 41, x = 8, z = 0, item = true, edible = true, edible_type = "VEGGIE" }),
    -- M2.3：浆果丛是批准的可收获对象（带原生 pickable 组件）⇒ 进 harvestables，item_kind 保留 food 语义
    mkent({ prefab = "berrybush", guid = 42, x = 16, z = 0, tags = { pickable = true }, pickable = true, product = "berries" }),
    -- 胡萝卜不在 M2.3 白名单里 ⇒ 仍然留在 food
    mkent({ prefab = "carrot_planted", guid = 43, x = 24, z = 0, tags = { pickable = true } }),
  }`, '食物')
  const { nearby } = env.observe()
  const foodPrefabs = nearby.buckets.food.map((f) => f.prefab).sort()
  assert.deepEqual(foodPrefabs, ['berries', 'carrot_planted'], '食物桶仍然认得真食物（浆果丛已归入可收获桶）')
  assert.equal(nearby.buckets.pickupables.length, 0, 'berries 不在拾取白名单里')
  assert.deepEqual(nearby.buckets.harvestables.map((h) => h.prefab), ['berrybush'], 'M2.3：浆果丛进可收获桶')
  assert.equal(nearby.buckets.harvestables[0].item_kind, 'food', '语义仍然是食物来源')
})

test('M2.2-06 树枝(ROUGHAGE)/种子(SEEDS)/齿轮(GEARS)/木头(WOOD) 都不算食物', async () => {
  const env = await load()
  env.run(`NEARBY = {
    mkent({ prefab = "log", guid = 51, x = 8, z = 0, item = true, edible = true, edible_type = "WOOD" }),
    mkent({ prefab = "seeds", guid = 52, x = 16, z = 0, item = true, edible = true, edible_type = "SEEDS" }),
    mkent({ prefab = "gears", guid = 53, x = 24, z = 0, item = true, edible = true, edible_type = "GEARS" }),
    mkent({ prefab = "nitre", guid = 54, x = 32, z = 0, item = true, edible = true, edible_type = "NITRE" }),
    mkent({ prefab = "twigs", guid = 55, x = 40, z = 0, item = true, canbepickedup = true, edible = true, edible_type = "ROUGHAGE" }),
  }`, '非食物')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.food.length, 0, '这些都不该进 food')
  // 白名单里的 twigs 仍然进 pickupables；其余落回 resources
  assert.equal(nearby.buckets.pickupables.length, 1)
  assert.equal(nearby.buckets.pickupables[0].prefab, 'twigs')
  assert.equal(nearby.buckets.resources.length, 4)
})

test('M2.2-07 树/岩石/生物/建筑/南瓜灯都不进 pickupables', async () => {
  const env = await load()
  env.run(`NEARBY = {
    mkent({ prefab = "evergreen", guid = 61, x = 8, z = 0, work = "CHOP" }),
    mkent({ prefab = "rock1", guid = 62, x = 16, z = 0, work = "MINE" }),
    mkent({ prefab = "spider", guid = 63, x = 24, z = 0, hp = 25, tags = { hostile = true } }),
    mkent({ prefab = "pumpkin_lantern", guid = 64, x = 32, z = 0, tags = { light = true }, fuel = 0.5 }),
    mkent({ prefab = "chest", guid = 65, x = 40, z = 0, container = true }),
    mkent({ prefab = "robin", guid = 66, x = 48, z = 0, hp = 25, tags = { animal = true }, item = true }),
  }`, '不可拾取')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.pickupables.length, 0)
  assert.equal(nearby.buckets.threats.length, 1)
})

test('M2.2-08 候选判定不含距离限制：8 格外的燧石照样进 pickupables（AI 可以先去靠近）', async () => {
  const env = await load()
  env.run(`NEARBY = { mkent({ prefab = "flint", guid = 71, x = 8 * 4, z = 0, item = true, canbepickedup = true }) }`, '远处燧石')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.pickupables.length, 1, '远也必须能被看见')
  assert.equal(nearby.buckets.pickupables[0].distance, 8)
})

test('M2.2-09 不是候选的三种情况：已被别人拿着 / canbepickedup=false / 不在白名单', async () => {
  const env = await load()
  env.run(`NEARBY = {
    mkent({ prefab = "flint", guid = 81, x = 8, z = 0, item = true, canbepickedup = true, owner = PLAYER }),
    mkent({ prefab = "twigs", guid = 82, x = 16, z = 0, item = true, canbepickedup = false }),
    mkent({ prefab = "goldnugget", guid = 83, x = 24, z = 0, item = true, canbepickedup = true }),
  }`, '非候选')
  const { nearby } = env.observe()
  const flat = env.flat
  assert.equal(nearby.buckets.pickupables.length, 0, '这三种都不是候选')
  const byPrefab = Object.fromEntries(flat(nearby).map((e) => [e.prefab, e.bucket]))
  // 被玩家拿着的物品：真机里会因进 limbo 被扫描直接过滤掉；万一漏进来，
  // 也绝不能是拾取候选（它既不是"地上的资源"，也不该被捡 —— 落到 other 是兜底行为）
  assert.equal(byPrefab.flint, 'other')
  assert.equal(byPrefab.twigs, 'resources')
  assert.equal(byPrefab.goldnugget, 'resources')
})

test('M2.2-10 limbo / 失效实体不进任何桶（扫描层就过滤）', async () => {
  const env = await load()
  env.run(`NEARBY = {
    mkent({ prefab = "twigs", guid = 91, x = 8, z = 0, item = true, canbepickedup = true, limbo = true }),
    mkent({ prefab = "flint", guid = 92, x = 16, z = 0, item = true, canbepickedup = true, valid = false }),
  }`, 'limbo')
  const { nearby } = env.observe()
  assert.equal(nearby.total_found, 0)
  assert.equal(nearby.buckets.pickupables.length, 0)
  assert.equal(nearby.status, 'empty')
})

// ═══════════════════════ 排序 / 上限 / 截断 ═══════════════════════

test('M2.2-11 pickupables 桶内按距离升序（确定性）', async () => {
  const env = await load()
  env.run(`NEARBY = {
    mkent({ prefab = "flint", guid = 101, x = 40, z = 0, item = true, canbepickedup = true }),
    mkent({ prefab = "twigs", guid = 102, x = 8, z = 0, item = true, canbepickedup = true }),
    mkent({ prefab = "cutgrass", guid = 103, x = 24, z = 0, item = true, canbepickedup = true }),
  }`, '排序')
  const { nearby } = env.observe()
  const ds = nearby.buckets.pickupables.map((p) => p.distance)
  assert.deepEqual(ds, [...ds].sort((a, b) => a - b), '必须按距离升序')
  assert.deepEqual(nearby.buckets.pickupables.map((p) => p.prefab), ['twigs', 'cutgrass', 'flint'])
})

test('M2.2-12 pickupables 不会再被植物挤掉：12 个草 + 1 个燧石，燧石必须拿到 #N', async () => {
  const env = await load()
  const grasses = Array.from({ length: 12 }, (_, i) =>
    `mkent({ prefab = "grass", guid = ${200 + i}, x = ${8 + i * 4}, z = 0, tags = { pickable = true } })`).join(',\n    ')
  env.run(`NEARBY = {
    ${grasses},
    mkent({ prefab = "flint", guid = 250, x = 8 * 4 + 2, z = 0, item = true, canbepickedup = true }),
  }`, '拥挤')
  const { nearby } = env.observe()
  const flat = env.flat
  assert.equal(nearby.buckets.pickupables.length, 1, '燧石必须有位置')
  const flint = flat(nearby).find((e) => e.prefab === 'flint')
  assert.ok(flint && /^#\d+$/.test(flint.ref), '燧石必须拿到 #N')
  assert.equal(nearby.buckets.resources.length, 12, '植物仍然照常返回（到单桶上限）')
  assert.equal(nearby.truncated, false, '总数没超上限')
})

test('M2.2-13 pickupables 单桶上限 12：超出的不给 ref，但计数如实', async () => {
  const env = await load()
  const items = Array.from({ length: 15 }, (_, i) =>
    `mkent({ prefab = "twigs", guid = ${300 + i}, x = ${8 + i * 4}, z = 0, item = true, canbepickedup = true })`).join(',\n    ')
  env.run(`NEARBY = {\n    ${items}\n  }`, '15 个树枝')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.pickupables.length, 12, '单桶上限 12')
  assert.equal(nearby.total_found, 15)
  assert.equal(nearby.total_returned, 12)
  assert.equal(nearby.truncated, true, '必须如实标记被截断')
  assert.equal(nearby.delta.not_returned_count, 3, '3 个没进返回列表')
})

test('M2.2-14 总量上限仍然生效（max_total=10），且桶内不超单桶上限', async () => {
  const env = await load()
  env.setCaps(10, 12)
  const ents = []
  for (let i = 0; i < 8; i++) ents.push(`mkent({ prefab = "twigs", guid = ${400 + i}, x = ${8 + i * 4}, z = 0, item = true, canbepickedup = true })`)
  for (let i = 0; i < 8; i++) ents.push(`mkent({ prefab = "grass", guid = ${420 + i}, x = ${8 + i * 4}, z = 8, tags = { pickable = true } })`)
  env.run(`NEARBY = {\n    ${ents.join(',\n    ')}\n  }`, '总量')
  const { nearby } = env.observe()
  assert.equal(nearby.max_total, 10)
  assert.ok(nearby.total_returned <= 10, '不能超过总量上限')
  assert.ok(nearby.buckets.pickupables.length <= 12)
  assert.equal(nearby.truncated, true)
})

test('M2.2-15 威胁优先级不受影响：威胁先占名额，pickupables 不会把它挤掉', async () => {
  const env = await load()
  env.setCaps(10, 12)
  env.run(`NEARBY = {
    mkent({ prefab = "spider", guid = 501, x = 30, z = 0, hp = 25, tags = { hostile = true } }),
    mkent({ prefab = "twigs", guid = 502, x = 8, z = 0, item = true, canbepickedup = true }),
    mkent({ prefab = "flint", guid = 503, x = 12, z = 0, item = true, canbepickedup = true }),
  }`, '威胁优先')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.threats.length, 1, '威胁必须在')
  assert.equal(nearby.buckets.pickupables.length, 2, '可拾取物也在')
  assert.ok(nearby.buckets.threats[0].ref < nearby.buckets.pickupables[0].ref, '威胁编号更靠前')
})

// ═══════════════════════ 引用 ═══════════════════════

test('M2.2-16 ref 全局唯一且连续（跨八个桶）', async () => {
  const env = await load()
  env.run(`NEARBY = {
    mkent({ prefab = "spider", guid = 601, x = 8, z = 0, hp = 25, tags = { hostile = true } }),
    mkent({ prefab = "twigs", guid = 602, x = 12, z = 0, item = true, canbepickedup = true }),
    mkent({ prefab = "berries", guid = 603, x = 16, z = 0, item = true, edible = true, edible_type = "VEGGIE" }),
    mkent({ prefab = "evergreen", guid = 604, x = 20, z = 0, work = "CHOP" }),
    mkent({ prefab = "chest", guid = 605, x = 24, z = 0, container = true }),
    mkent({ prefab = "firepit", guid = 606, x = 28, z = 0, tags = { structure = true } }),
    mkent({ prefab = "robin", guid = 607, x = 32, z = 0, hp = 25, tags = { animal = true } }),
  }`, '八桶')
  const { nearby } = env.observe()
  const flat = env.flat
  const refs = flat(nearby).map((e) => e.ref)
  assert.deepEqual(refs, refs.map((_, i) => '#' + (i + 1)), 'ref 必须从 #1 连续编号')
  assert.equal(new Set(refs).size, refs.length)
})

test('M2.2-17 编号复用：内容没变就沿用旧编号；内容一变旧 ref 立刻失效', async () => {
  const env = await load()
  const flat = env.flat
  env.run('NEARBY = { mkent({ prefab = "twigs", guid = 701, x = 8, z = 0, item = true, canbepickedup = true }) }', '首次')
  const first = env.observe()
  const reused = env.observe()
  assert.equal(reused.nearby.snapshot_id, first.nearby.snapshot_id, '缓存窗口内应复用')
  assert.equal(reused.nearby.scan.reused, true)
  assert.deepEqual(
    Object.fromEntries(flat(reused.nearby).map((e) => [e.prefab, e.ref])),
    Object.fromEntries(flat(first.nearby).map((e) => [e.prefab, e.ref])),
    'reused 不能重新编号',
  )

  // OBSERVATION-02：时间前进、但东西没变 → 沿用同一个编号。
  // 旧契约是"时间一到就换编号"；真机上模型思考 3~5 秒，回来时编号已经换了两轮，
  // 于是 15 步里 5 次 stale_snapshot（session-403656e9）。复用编号才是对的：
  // 引用绑的是"那一格的那个实体"，实体在、位置没变，引用就仍然有效。
  env.run('NOW = NOW + 30', '时间前进')
  const second = env.observe()
  assert.equal(second.nearby.snapshot_id, first.nearby.snapshot_id,
    '内容没变时不该换编号（换了就等于把模型手里的 #N 作废）')
  env.run(`local ent, why = Whale.nearby.Resolve("${first.nearby.snapshot_id}", "#1")
            OUT_SAME = tostring(ent ~= nil) .. "|" .. tostring(why)`, '引用仍然有效')
  assert.match(env.get('OUT_SAME'), /^true\|/, '内容没变时旧引用必须仍然解析得到：' + env.get('OUT_SAME'))

  // 内容一变（多一个实体）→ 必须换编号，旧引用立刻失效（fail-closed 没变）
  // 先让缓存过期，否则 observe 会直接复用上一个结果、根本不会重扫（看不到新实体）
  env.run('NOW = NOW + 30', '再等一会儿')
  env.run('NEARBY = { mkent({ prefab = "twigs", guid = 701, x = 8, z = 0, item = true, canbepickedup = true }), mkent({ prefab = "flint", guid = 702, x = 12, z = 0, item = true, canbepickedup = true }) }', '多一样东西')
  const third = env.observe()
  assert.notEqual(third.nearby.snapshot_id, first.nearby.snapshot_id, '内容变了必须换新 snapshot_id')
  env.run(`local ent, why = Whale.nearby.Resolve("${first.nearby.snapshot_id}", "#1")
            OUT_RESOLVE = tostring(ent) .. "|" .. tostring(why)`, '旧引用')
  const resolved = env.get('OUT_RESOLVE')
  assert.match(resolved, /^nil\|/, '内容变了以后旧快照的引用必须解析不到：' + resolved)
})

// ═══════════════════════ Delta ═══════════════════════

test('M2.2-18 Delta：同一实体 resources → pickupables，只报 category changed（不报 added/removed）', async () => {
  const env = await load()
  // 第一次：flint 被别人拿着 → resources
  env.run(`NEARBY = { mkent({ prefab = "flint", guid = 801, x = 8, z = 0, item = true,
                              canbepickedup = false }) }`, '第一次（还捡不起来）')
  const first = env.observe()
  assert.equal(first.nearby.buckets.resources.length, 1)
  assert.equal(first.nearby.buckets.pickupables.length, 0)
  // 第二次：同一 GUID，掉在地上 → pickupables
  env.run('NOW = NOW + 30', '时间前进')
  env.run(`NEARBY = { mkent({ prefab = "flint", guid = 801, x = 8, z = 0, item = true,
                              canbepickedup = true }) }`, '第二次')
  const second = env.observe()
  assert.equal(second.nearby.buckets.pickupables.length, 1)
  assert.equal(second.nearby.delta.added_count, 0, '不能因为换了桶就当新增')
  assert.equal(second.nearby.delta.removed_count, 0, '不能因为换了桶就当消失')
  assert.ok(second.nearby.delta.changed_count >= 1, '要报分类变化')
  const ch = second.nearby.delta.changed[0]
  assert.deepEqual(ch.fields.category, { from: 'resources', to: 'pickupables' })
})

test('M2.2-19 Delta：pickupables 新增 / 消失都能正确报出来', async () => {
  const env = await load()
  env.run('NEARBY = { mkent({ prefab = "spider", guid = 901, x = 8, z = 0, hp = 25, tags = { hostile = true } }) }', '基线')
  env.observe()
  env.run('NOW = NOW + 30', '时间前进')
  env.run(`NEARBY = {
    mkent({ prefab = "spider", guid = 901, x = 8, z = 0, hp = 25, tags = { hostile = true } }),
    mkent({ prefab = "twigs", guid = 902, x = 12, z = 0, item = true, canbepickedup = true }),
  }`, '多了一个树枝')
  const second = env.observe()
  assert.equal(second.nearby.delta.added_count, 1)
  assert.equal(second.nearby.delta.added[0].prefab, 'twigs')
  env.run('NOW = NOW + 30', '时间前进')
  env.run('NEARBY = { mkent({ prefab = "spider", guid = 901, x = 8, z = 0, hp = 25, tags = { hostile = true } }) }', '树枝没了')
  const third = env.observe()
  assert.equal(third.nearby.delta.removed_count, 1)
  assert.equal(third.nearby.delta.removed[0].prefab, 'twigs')
})

test('M2.2-20 Delta：被截断（没进返回列表）的实体不会被误报 removed；not_returned 没有 ref', async () => {
  const env = await load()
  const many = Array.from({ length: 15 }, (_, i) =>
    `mkent({ prefab = "twigs", guid = ${1000 + i}, x = ${8 + i * 4}, z = 0, item = true, canbepickedup = true })`).join(',\n    ')
  env.run(`NEARBY = {\n    ${many}\n  }`, '第一次 15 个')
  env.observe()
  env.run('NOW = NOW + 30', '时间前进')
  env.run(`NEARBY = {\n    ${many}\n  }`, '第二次同样 15 个')
  const second = env.observe()
  assert.equal(second.nearby.buckets.pickupables.length, 12)
  assert.equal(second.nearby.delta.removed_count, 0, '被截断 ≠ 消失')
  assert.equal(second.nearby.delta.added_count, 0, '一直在的不能算新增')
  assert.equal(second.nearby.delta.not_returned_count, 3)
  const nr = second.nearby.delta.not_returned ?? []
  assert.equal(nr.length, 3)
  for (const e of nr) assert.equal(e.ref, undefined, 'not_returned 不能带当前 ref')
})

// ═══════════════════════ 观察-执行一致 ═══════════════════════

test('M2.2-21 guard 与 Observer 共用同一份白名单（同一张表，不是复制）', async () => {
  const env = await load({ withGuard: true })
  env.run(`OUT_SAME = tostring(Whale.guard.PICKUP_PREFABS == Whale.pickuprules.PREFABS)
            OUT_LIST = table.concat(Whale.pickuprules.PrefabList(), ",")
            OUT_MAX = tostring(Whale.guard.PICKUP_MAX_TILES)`, '一致性')
  assert.equal(env.get('OUT_SAME'), 'true', '必须是同一张表（杜绝两份规则漂移）')
  assert.equal(env.get('OUT_LIST'), 'cutgrass,flint,twigs', '白名单保持不扩')
  assert.equal(env.get('OUT_MAX'), '2.5', '执行距离上限仍在执行侧')
})

test('M2.2-22 候选判定与执行侧拒绝原因一致（树两边都是 prefab_not_allowed）', async () => {
  const env = await load({ withGuard: true })
  env.run(`local ok1, why1 = Whale.pickuprules.IsCandidate(mkent({ prefab = "evergreen", guid = 1, x = 0, z = 0, work = "CHOP" }))
            local ok2, why2 = Whale.pickuprules.IsCandidate(mkent({ prefab = "flint", guid = 2, x = 0, z = 0, item = true, canbepickedup = true }))
            local ok3, why3 = Whale.pickuprules.IsCandidate(mkent({ prefab = "twigs", guid = 3, x = 0, z = 0, item = true, canbepickedup = false }))
            local ok4, why4 = Whale.pickuprules.IsCandidate(mkent({ prefab = "flint", guid = 4, x = 0, z = 0, item = true, canbepickedup = true, limbo = true }))
            OUT = tostring(ok1).."|"..tostring(why1)..";"..tostring(ok2).."|"..tostring(why2)..";"
                  ..tostring(ok3).."|"..tostring(why3)..";"..tostring(ok4).."|"..tostring(why4)`, '候选原因')
  assert.equal(env.get('OUT'), 'false|prefab_not_allowed;true|nil;false|target_not_pickable;false|in_limbo')
})

// ═══════════════════════ Node 兼容 / fallback ═══════════════════════

test('M2.2-23 Node：nearbyLines 能渲染 pickupables，并保留 item_kind 语义', () => {
  const lines = nearbyLines({
    status: 'ok', radius: 16, total_returned: 2, total_found: 2, truncated: false,
    buckets: {
      threats: [],
      pickupables: [
        { ref: '#1', prefab: 'flint', category: 'pickupables', item_kind: 'resources', label: '燧石', distance: 0.9, position: { x: -20, z: 51 } },
        { ref: '#2', prefab: 'twigs', category: 'pickupables', item_kind: 'resources', label: '树枝', distance: 1.5, position: { x: -19, z: 51 }, stack_size: 3 },
      ],
      food: [], resources: [], containers: [], structures: [], creatures: [], other: [],
    },
  })
  const text = lines.join('\n')
  assert.match(text, /可拾取物：/)
  assert.match(text, /#1 燧石/)
  assert.match(text, /#2 树枝/)
  assert.match(text, /×3/, '堆叠数要显示')
})

test('M2.2-24 Node：旧七桶快照仍能渲染（向后兼容，不报错、不丢数据）', () => {
  const lines = nearbyLines({
    status: 'ok', radius: 16, total_returned: 2, total_found: 2, truncated: false,
    buckets: {
      threats: [], food: [],
      resources: [{ ref: '#1', prefab: 'flint', category: 'resources', label: '燧石', distance: 0.9 }],
      containers: [], structures: [], creatures: [], other: [],
    },
  })
  const text = lines.join('\n')
  assert.match(text, /资源：#1 燧石/, '老结构照常渲染')
  assert.doesNotMatch(text, /可拾取物：/, '没有这个桶就不该凭空出现')
})

test('M2.2-25 Node：未知桶名透传（新 Lua + 旧 Node 也不丢数据）', () => {
  const lines = nearbyLines({
    status: 'ok', radius: 16, total_returned: 1, total_found: 1, truncated: false,
    buckets: { threats: [], food: [], resources: [], containers: [], structures: [], creatures: [], other: [],
               mystery_bucket: [{ ref: '#1', prefab: 'thing', label: '神秘', distance: 1 }] },
  })
  assert.match(lines.join('\n'), /mystery_bucket：#1 神秘/)
})

test('M2.2-26 Node：八桶都在时按固定顺序渲染（威胁 → 可拾取物 → 食物 → 资源）', () => {
  const mk = (ref, prefab, label, d) => ({ ref, prefab, label, distance: d })
  const text = nearbyLines({
    status: 'ok', radius: 16, total_returned: 4, total_found: 4, truncated: false,
    buckets: {
      threats: [mk('#1', 'spider', '蜘蛛', 4)],
      pickupables: [mk('#2', 'flint', '燧石', 0.9)],
      food: [mk('#3', 'berries', '浆果', 3)],
      resources: [mk('#4', 'evergreen', '常青树', 5)],
      containers: [], structures: [], creatures: [], other: [],
    },
  })
  const order = ['威胁：', '可拾取物：', '食物：', '资源：'].map((t) => text.findIndex((l) => l.includes(t)))
  assert.ok(order.every((i) => i >= 0), '四类都要在：' + JSON.stringify(order))
  assert.deepEqual(order, [...order].sort((a, b) => a - b), '顺序必须固定')
})


// ═══════════════════════ 与 M2.1 Pickup 的集成（新桶不能把执行链打断） ═══════════════════════

test('M2.2-27 pickup 的核对逻辑能从 pickupables 桶解析 #N（新桶不会打断执行链）', async () => {
  const { ACTION_SPECS } = await import('../lib/dispatcher.js')
  const before = {
    nearby: {
      snapshot_id: 'r1-n9',
      buckets: {
        threats: [],
        pickupables: [{ ref: '#1', prefab: 'flint', label: '燧石', distance: 0.9, item_kind: 'resources' }],
        food: [], resources: [], containers: [], structures: [], creatures: [], other: [],
      },
    },
    player: { inventory: { used: 0, items: [] } },
  }
  const after = { ...before, player: { inventory: { used: 1, items: [{ prefab: 'flint', count: 1 }] } } }
  const v = ACTION_SPECS.pickup.verify(before, after, { target_ref: '#1' })
  assert.equal(v.ok, true, '必须能从 pickupables 桶里找到目标 prefab')
  assert.equal(v.prefab, 'flint')
  // 背包没变就不能算成功（不能因为"目标在 pickupables 里"就放行）
  const nochange = ACTION_SPECS.pickup.verify(before, before, { target_ref: '#1' })
  assert.equal(nochange.ok, false)
  assert.equal(nochange.reason, 'inventory_unchanged')
})

test('M2.2-28 出现在 pickupables 里 ≠ 跳过执行侧校验（白名单/距离/背包仍在 guard 里判）', async () => {
  const env = await load({ withGuard: true })
  // 远处（8 格）的燧石：观察侧是候选，执行侧应当 out_of_range
  env.run(`NEARBY = { mkent({ prefab = "flint", guid = 999, x = 8 * 4, z = 0, item = true, canbepickedup = true }) }`, '远处燧石')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.pickupables.length, 1, '观察侧不限距离')
  const d = nearby.buckets.pickupables[0].distance
  assert.ok(d > 2.5, '确实超出执行距离')
  // 执行侧的上限仍然独立存在（不是从观察结果里读的）
  env.run('OUT_MAX = tostring(Whale.guard.PICKUP_MAX_TILES)', '执行上限')
  assert.equal(env.get('OUT_MAX'), '2.5')
})


test('M2.2-29 文本渲染顺序由 N.BUCKETS 决定（威胁 → 可拾取物 → 食物 → 资源）', async () => {
  const env = await load()
  env.run(`NEARBY = {
    mkent({ prefab = "spider", guid = 1, x = 16, z = 0, hp = 25, tags = { hostile = true } }),
    mkent({ prefab = "flint", guid = 2, x = 8, z = 0, item = true, canbepickedup = true }),
    mkent({ prefab = "berries", guid = 3, x = 24, z = 0, item = true, edible = true, edible_type = "VEGGIE" }),
    mkent({ prefab = "evergreen", guid = 4, x = 32, z = 0, work = "CHOP" }),
  }`, '四类')
  const { text } = env.observe()
  const at = (label) => text.indexOf(label + '：')
  const order = ['威胁', '可拾取物', '食物', '资源'].map(at)
  assert.ok(order.every((i) => i >= 0), '四段都该出现：' + JSON.stringify(order) + '\n' + text)
  assert.deepEqual(order, [...order].sort((a, b) => a - b), '文本顺序必须是设计顺序\n' + text)
  assert.match(text, /可拾取物：#\d+ 燧石/)
})
