// M1.4：附近实体结构化观察的测试
//
// 用 fengari 真跑模组的 nearby/observe 代码（假 GLOBAL，但走的是真正会进游戏的逻辑）。
// 这些全部是 UNIT（沙箱），**不是** DST 真机；真机结果见 docs/M1_2_runtime_test_report.md 与
// tools/m12-watch.mjs 的采样。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeState, toJsonPayload, STATE_SCHEMA } from '../lib/state/snapshot.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

// ─────────────────────────── 假游戏 ───────────────────────────

const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = {
    WARLY = "沃利", SPIDER = "蜘蛛", SPIDER_WARRIOR = "蜘蛛战士", BERRYBUSH = "浆果丛",
    EVERGREEN = "常青树", ROCK = "石头", CHEST = "箱子", FIREPIT = "火坑", PIGMAN = "猪人",
    LOG = "木头", CARROT = "胡萝卜",
} }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.FOODTYPE = { GENERIC = "GENERIC", MEAT = "MEAT", VEGGIE = "VEGGIE", INSECT = "INSECT",
                    GOODIES = "GOODIES", ELEMENTAL = "ELEMENTAL", ROUGHAGE = "ROUGHAGE",
                    SEEDS = "SEEDS", GEARS = "GEARS" }
GLOBAL.ACTIONS = { CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, DIG = { id = "DIG" }, HAMMER = { id = "HAMMER" },
                   PICK = { id = "PICK" }, PICKUP = { id = "PICKUP" }, HARVEST = { id = "HARVEST" } }
GLOBAL.TheNet = { GetSessionIdentifier = function() return SESSION end }
GLOBAL.TheShard = { GetShardId = function() return SHARD end }

NOW = 1000
SESSION = "sess-A"
SHARD = "Master"
NEARBY = {}
FAIL_SCAN = false
GLOBAL.TheSim = {
    GetTime = function() return NOW end,
    GetRealTime = function() return NOW * 1000 end,
    FindEntities = function() if FAIL_SCAN then error("boom") end return NEARBY end,
}

-- 造一个假实体：opts = { prefab, x, z, guid, valid, tags = {}, hp, maxhp, work, harvestable,
--                        item, stack, edible, container, combat_target, fuel, prototyper }
function mkent(opts)
    opts = opts or {}
    local ent = {
        prefab = opts.prefab or "thing",
        GUID = opts.guid or 1,
        valid = opts.valid ~= false,
        tags = opts.tags or {},
        components = {},
        Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end },
    }
    ent.IsValid = function(self) return self.valid end
    ent.HasTag = function(self, tag)
        if tag == "INLIMBO" then return false end
        return self.tags[tag] == true
    end
    if opts.hp ~= nil then
        ent.components.health = { currenthealth = opts.hp, maxhealth = opts.maxhp or opts.hp,
                                  IsDead = function(self) return self.currenthealth <= 0 end }
    end
    if opts.work ~= nil then
        ent.components.workable = { action = { id = opts.work } }
    end
    if opts.harvestable then
        ent.components.harvestable = { CanBeHarvested = function() return opts.harvestable_ready ~= false end }
    end
    if opts.item then
        ent.components.inventoryitem = { owner = nil }
        if opts.stack ~= nil then
            ent.components.stackable = { StackSize = function() return opts.stack end }
        end
    end
    if opts.edible then ent.components.edible = { foodtype = opts.edible_type or "VEGGIE" } end
    if opts.container then
        ent.components.container = { IsOpen = function() return opts.container_open == true end }
    end
    if opts.combat_target ~= nil then
        ent.components.combat = { target = opts.combat_target }
    end
    if opts.fuel ~= nil then
        ent.components.fueled = { GetPercent = function() return opts.fuel end }
    end
    if opts.prototyper then ent.components.prototyper = {} end
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
GLOBAL.os = { time = function() return 1794500000 end }
GLOBAL.io = nil
pcall = nil
tonumber = nil
error = nil
os = nil
io = nil
`

async function load() {
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
  const run = (code, what) => {
    const status = lauxlib.luaL_dostring(L, to_luastring(code))
    if (status !== lua.LUA_OK) throw new Error(`${what} 出错：${fail()}`)
  }
  run(STUB, '假游戏')
  run('Whale = { verbose = false, version = "0.13.0" }', 'Whale')
  run(`Whale.files = { state = "whale_state.json", io_state = "whale_io_state.json",
                       cmd = "whale_cmd.json", io_cmd = "whale_io_cmd.json",
                       result = "whale_result.json", io_result = "whale_io_result.json",
                       settings = "whale_settings.json", io_settings = "whale_io_settings.json",
                       pause = "whale_pause.json", io_pause = "whale_io_pause.json" }`, '文件名')
  for (const name of ['json', 'util', 'config', 'actor', 'nearby', 'observe']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', `${name}.lua`), 'utf8'), `${name}.lua`)
  }
  run(`Whale.config.build(function(k)
        if k == "scan_radius" then return 16 end
        if k == "scan_seconds" then return 4 end
        if k == "observe_interval" then return 2 end
        if k == "state_interval" then return 1 end
        if k == "nearby_max_total" then return 60 end
        if k == "nearby_max_per_bucket" then return 12 end
        return nil
      end)`, '配置')
  const get = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try {
      return to_jsstring(lua.lua_tostring(L, -1))
    } catch {
      return ''
    }
  }
  const reset = () => run('Whale.nearby.Reset()', '重置 nearby')
  const observe = () => {
    run(`
      local actor = Whale.actor.get_actor()
      local text, data = Whale.observe.Build(actor)
      OUT_TEXT = text
      OUT_NEARBY = Whale.json.encode(data.nearby)
      OUT_SNAPSHOT = data.observer.snapshot_id
      OUT_DELTA = Whale.json.encode(data.nearby ~= nil and data.nearby.delta or {})
    `, '观察')
    const nearby = JSON.parse(get('OUT_NEARBY'))
    return {
      text: get('OUT_TEXT'),
      nearby,
      snapshot: get('OUT_SNAPSHOT'),
      delta: JSON.parse(get('OUT_DELTA')),
    }
  }
  return { run, get, reset, observe }
}

const refsOf = (nearby) => {
  const out = []
  for (const key of Object.keys(nearby.buckets ?? {})) {
    for (const item of nearby.buckets[key]) out.push(item.ref)
  }
  return out
}
const flat = (nearby) => {
  const out = []
  for (const key of Object.keys(nearby.buckets ?? {})) {
    for (const item of nearby.buckets[key]) out.push({ ...item, bucket: key })
  }
  return out
}

// ─────────────────────────── Schema / 空结果 / 错误 ───────────────────────────

test('M1.4-01 附近为空：status=empty、各桶为空、delta=baseline、不是错误', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = {}', '清空附近')
  const { nearby, text } = env.observe()
  assert.equal(nearby.status, 'empty')
  assert.equal(nearby.schema, 'bws.nearby/1')
  assert.equal(nearby.total_found, 0)
  assert.equal(nearby.total_returned, 0)
  assert.equal(nearby.truncated, false)
  assert.equal(nearby.delta.status, 'baseline')
  for (const key of ['threats', 'food', 'resources', 'containers', 'structures', 'creatures', 'other']) {
    assert.ok(Array.isArray(nearby.buckets[key]), `桶 ${key} 必须是数组`)
    assert.equal(nearby.buckets[key].length, 0)
  }
  assert.match(text, /没什么值得注意的/)
})

test('M1.4-02 扫描失败：status=error、带 error 码，和"空"能区分', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = {}; FAIL_SCAN = true', '让扫描失败')
  const { nearby, text } = env.observe()
  assert.equal(nearby.status, 'error')
  assert.ok(nearby.error, '要有 error 码')
  assert.notEqual(nearby.status, 'empty')
  assert.match(text, /暂时读不到/)
  env.run('FAIL_SCAN = false', '恢复')
})

test('M1.4-03 单个实体：字段齐全（ref/prefab/category/label/distance/position）', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = { mkent({ prefab = "evergreen", x = 20, z = 8, guid = 11, tags = { tree = true }, work = "CHOP", hp = 100 }) }', '一棵树')
  const { nearby } = env.observe()
  assert.equal(nearby.total_returned, 1)
  const item = nearby.buckets.resources[0]
  assert.equal(item.ref, '#1')
  assert.equal(item.prefab, 'evergreen')
  assert.equal(item.category, 'resources')
  assert.equal(item.label, '常青树')
  assert.equal(item.position.x, 5)
  assert.equal(item.position.z, 2)
  assert.equal(item.distance, 5.4)
  assert.equal(item.is_workable, true)
  assert.equal(item.work_action, 'CHOP')
  assert.equal(item.guid, undefined, '不许把 GUID 发给模型')
})

// ─────────────────────────── 分类 ───────────────────────────

test('M1.4-04 分类：威胁/食物/资源/容器/建筑/生物，各归其桶且只出现一次', async () => {
  const env = await load()
  env.reset()
  env.run(`
    NEARBY = {
      mkent({ prefab = "spider", x = 8, z = 0, guid = 1, tags = { hostile = true }, hp = 25 }),
      mkent({ prefab = "berrybush", x = 12, z = 0, guid = 2, tags = { pickable = true } }),
      mkent({ prefab = "evergreen", x = 16, z = 0, guid = 3, work = "CHOP", hp = 100 }),
      mkent({ prefab = "chest", x = 20, z = 0, guid = 4, tags = { structure = true }, container = true }),
      mkent({ prefab = "firepit", x = 24, z = 0, guid = 5, tags = { fire = true }, fuel = 0.6 }),
      mkent({ prefab = "pigman", x = 28, z = 0, guid = 6, hp = 100, combat_target = false }),
      mkent({ prefab = "fx_thing", x = 2, z = 0, guid = 7 }),  -- 没有观察价值 → 进不来
    }
  `, '六类实体')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.threats.length, 1)
  assert.equal(nearby.buckets.threats[0].prefab, 'spider')
  assert.equal(nearby.buckets.food.length, 1)
  assert.equal(nearby.buckets.food[0].prefab, 'berrybush')
  assert.equal(nearby.buckets.resources.length, 1)
  assert.equal(nearby.buckets.resources[0].prefab, 'evergreen')
  assert.equal(nearby.buckets.containers.length, 1)
  assert.equal(nearby.buckets.containers[0].prefab, 'chest')
  assert.equal(nearby.buckets.structures.length, 1)
  assert.equal(nearby.buckets.structures[0].prefab, 'firepit')
  assert.equal(nearby.buckets.structures[0].fuel_percent, 60)
  assert.equal(nearby.buckets.creatures.length, 1)
  assert.equal(nearby.buckets.creatures[0].prefab, 'pigman')
  assert.equal(nearby.total_returned, 6, 'fx 这类没观察价值的实体不该进来')

  const all = flat(nearby)
  assert.equal(new Set(all.map((x) => x.ref)).size, all.length, '引用必须唯一')
  const guids = all.map((x) => x.prefab)
  assert.equal(new Set(guids).size, guids.length, '同一实体不该出现在两个桶')
})

test('M1.4-05 分类不看 prefab 名字：叫 spider 但没有 hostile/combat 的不算威胁', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = { mkent({ prefab = "spider", x = 8, z = 0, guid = 1 }) }', '假蜘蛛')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.threats.length, 0, '没有 hostile 标签/战斗组件就不能算威胁')
  assert.equal(nearby.total_returned, 0, '它也没有任何可观察组件 → 不进桶')
})

test('M1.4-06 玩家自己不会出现在 nearby；无效实体被跳过', async () => {
  const env = await load()
  env.reset()
  env.run(`
    NEARBY = {
      PLAYER,
      mkent({ prefab = "evergreen", x = 16, z = 0, guid = 3, work = "CHOP", hp = 100 }),
      mkent({ prefab = "rock", x = 20, z = 0, guid = 4, valid = false, work = "MINE" }),
    }
  `, '含玩家与无效实体')
  const { nearby } = env.observe()
  assert.equal(nearby.total_returned, 1)
  assert.equal(nearby.buckets.resources[0].prefab, 'evergreen')
})

test('M1.4-07 只靠 tag 的实体也能观察（组件缺失不崩）', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = { mkent({ prefab = "berrybush", x = 4, z = 0, guid = 2, tags = { pickable = true } }) }', '只有 tag')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.food.length, 1, '浆果丛按"采下来是食物"归到 food')
  assert.equal(nearby.buckets.food[0].health, undefined)
})

// ─────────────────────────── 排序 / 上限 / 截断 ───────────────────────────

test('M1.4-08 桶优先级 + 桶内按距离升序（确定性）', async () => {
  const env = await load()
  env.reset()
  env.run(`
    NEARBY = {
      mkent({ prefab = "evergreen", x = 4, z = 0, guid = 3, work = "CHOP", hp = 100 }),
      mkent({ prefab = "spider", x = 40, z = 0, guid = 1, tags = { hostile = true }, hp = 25 }),
      mkent({ prefab = "spider", x = 8, z = 0, guid = 2, tags = { hostile = true }, hp = 25 }),
    }
  `, '优先级')
  const { nearby } = env.observe()
  const refs = refsOf(nearby)
  assert.deepEqual(refs, ['#1', '#2', '#3'])
  assert.equal(nearby.buckets.threats[0].distance, 2, '近的威胁先')
  assert.equal(nearby.buckets.threats[1].distance, 10)
  assert.equal(nearby.buckets.resources[0].distance, 1, '资源排在威胁之后')
})

test('M1.4-09 单桶上限：超过 OBSERVER_NEARBY_MAX_PER_BUCKET 的按距离截断', async () => {
  const env = await load()
  env.reset()
  env.run(`
    NEARBY = {}
    for i = 1, 20 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "berrybush", x = i * 4, z = 0, guid = 100 + i, tags = { pickable = true } })
    end
  `, '20 丛浆果')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.food.length, 12, '单桶默认上限 12')
  assert.equal(nearby.total_found, 20)
  assert.equal(nearby.total_returned, 12)
  assert.equal(nearby.truncated, true)
  assert.equal(nearby.buckets.food[11].distance, 12, '留下的是最近的 12 个')
})

test('M1.4-10 总量上限：超过 OBSERVER_NEARBY_MAX_TOTAL 时截断并如实标记', async () => {
  const env = await load()
  env.reset()
  env.run(`
    Whale.config.build(function(k)
      if k == "nearby_max_total" then return 10 end
      if k == "nearby_max_per_bucket" then return 50 end
      if k == "scan_radius" then return 16 end
      if k == "scan_seconds" then return 4 end
      return nil
    end)
    NEARBY = {}
    for i = 1, 30 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = 200 + i, work = "CHOP", hp = 100 })
    end
  `, '30 棵树 / 总量 10')
  const { nearby } = env.observe()
  assert.equal(nearby.total_returned, 10)
  assert.equal(nearby.total_found, 30)
  assert.equal(nearby.truncated, true)
  assert.equal(nearby.max_total, 10)
  assert.equal(refsOf(nearby).length, 10)
})

test('M1.4-11 引用：编号连续、唯一、在截断之后分配', async () => {
  const env = await load()
  env.reset()
  env.run(`
    NEARBY = {}
    for i = 1, 15 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = 300 + i, work = "CHOP", hp = 100 })
    end
  `, '15 棵树')
  const { nearby } = env.observe()
  const refs = refsOf(nearby)
  assert.equal(refs.length, 12)
  refs.forEach((ref, index) => assert.equal(ref, `#${index + 1}`, '必须从 #1 连续编号'))
})

// ─────────────────────────── 文本 / JSON 一致 ───────────────────────────

test('M1.4-12 文本用的是同一份结构化数据（引用、桶名、截断提示都对得上）', async () => {
  const env = await load()
  env.reset()
  env.run(`
    Whale.config.build(function(k)
      if k == "nearby_max_total" then return 10 end   -- 配置下限是 10（见 config.lua 的 RANGES）
      if k == "nearby_max_per_bucket" then return 12 end
      if k == "scan_radius" then return 16 end
      if k == "scan_seconds" then return 4 end
      return nil
    end)
    NEARBY = {}
    for i = 1, 12 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = 500 + i, work = "CHOP", hp = 100 })
    end
  `, '截断场景')
  const { nearby, text } = env.observe()
  assert.equal(nearby.total_returned, 10)
  assert.equal(nearby.total_found, 12)
  assert.match(text, /只显示 10\/12 个/)
  assert.match(text, /资源：#1 常青树/)
  assert.doesNotMatch(text, /#11/, '被截断的实体不该出现在文本里')
})

// ─────────────────────────── 缓存复用 ───────────────────────────

test('M1.4-13 扫描未到期：scan.reused=true，引用与 snapshot_id 都不变', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = { mkent({ prefab = "spider", x = 8, z = 0, guid = 1, tags = { hostile = true }, hp = 25 }) }', '一只蜘蛛')
  const first = env.observe()
  assert.equal(first.nearby.scan.reused, false)
  const firstSnapshot = first.nearby.snapshot_id
  const firstRef = first.nearby.buckets.threats[0].ref

  env.run('NOW = NOW + 1', '过 1 秒（< scan_seconds=4）')
  const second = env.observe()
  assert.equal(second.nearby.scan.reused, true, '未到期应该复用')
  assert.equal(second.nearby.snapshot_id, firstSnapshot, '复用不能换扫描快照号')
  assert.equal(second.nearby.buckets.threats[0].ref, firstRef, '复用不能重新编号')
  assert.equal(second.nearby.delta.status, first.nearby.delta.status, '复用不重新算 delta')
  assert.ok(second.nearby.scan.age_ms >= 1000)
})

test('M1.4-14 扫描到期：重新扫描、换新 snapshot_id、引用从 #1 重新分配', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = { mkent({ prefab = "spider", x = 8, z = 0, guid = 1, tags = { hostile = true }, hp = 25 }) }', '一只蜘蛛')
  const first = env.observe()
  env.run('NOW = NOW + 5', '过 5 秒（> scan_seconds）')
  env.run('NEARBY = { mkent({ prefab = "evergreen", x = 4, z = 0, guid = 2, work = "CHOP", hp = 100 }) }', '换成树')
  const second = env.observe()
  assert.equal(second.nearby.scan.reused, false)
  assert.notEqual(second.nearby.snapshot_id, first.nearby.snapshot_id, '新扫描要有新快照号')
  assert.equal(second.nearby.buckets.resources[0].ref, '#1', '新快照从 #1 开始')
})

// ─────────────────────────── Delta ───────────────────────────

test('M1.4-15 Delta：新增 / 消失 / 变化 都能准确描述', async () => {
  const env = await load()
  env.reset()
  // 第一次：蜘蛛(25血) + 浆果丛
  env.run(`
    NEARBY = {
      mkent({ prefab = "spider", x = 8, z = 0, guid = 1, tags = { hostile = true }, hp = 25 }),
      mkent({ prefab = "berrybush", x = 12, z = 0, guid = 2, tags = { pickable = true } }),
    }
  `, '基线')
  const first = env.observe()
  assert.equal(first.nearby.delta.status, 'baseline', '第一次没有基线')
  assert.equal(first.nearby.delta.added_count, 0)

  // 第二次：蜘蛛掉血到 10、浆果丛没了、多了一棵树
  env.run('NOW = NOW + 5', '过 5 秒')
  env.run(`
    NEARBY = {
      mkent({ prefab = "spider", x = 8, z = 0, guid = 1, tags = { hostile = true }, hp = 10 }),
      mkent({ prefab = "evergreen", x = 4, z = 0, guid = 3, work = "CHOP", hp = 100 }),
    }
  `, '变化后')
  const second = env.observe()
  const delta = second.nearby.delta
  assert.equal(delta.status, 'ok')
  assert.equal(delta.added_count, 1, '新增一棵树')
  assert.equal(delta.added[0].prefab, 'evergreen')
  assert.equal(delta.removed_count, 1, '浆果丛消失了')
  assert.equal(delta.removed[0].prefab, 'berrybush')
  assert.ok(delta.removed[0].previous_ref, '消失的实体要带旧快照的引用')
  assert.equal(delta.changed_count, 1, '蜘蛛血量变了')
  assert.equal(delta.changed[0].prefab, 'spider')
  assert.deepEqual(delta.changed[0].fields.health, { from: 25, to: 10 })
})

test('M1.4-16 没有实质变化时，不会制造 Delta 噪声', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = { mkent({ prefab = "spider", x = 8, z = 0, guid = 1, tags = { hostile = true }, hp = 25 }) }', '基线')
  env.observe()
  env.run('NOW = NOW + 5', '过 5 秒')
  const second = env.observe()
  assert.equal(second.nearby.delta.status, 'ok')
  assert.equal(second.nearby.delta.added_count, 0)
  assert.equal(second.nearby.delta.removed_count, 0)
  assert.equal(second.nearby.delta.changed_count, 0)
  assert.doesNotMatch(second.text, /变化：/, '没有变化就不该出现变化行')
})

test('M1.4-17 Session 变化：Delta 重建基线（不跨 Session 比较）', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = { mkent({ prefab = "spider", x = 8, z = 0, guid = 1, tags = { hostile = true }, hp = 25 }) }', '基线')
  env.observe()
  env.run('NOW = NOW + 5; SESSION = "sess-B"; Whale.actor.reset()', '换 Session')
  env.run('NEARBY = { mkent({ prefab = "evergreen", x = 4, z = 0, guid = 2, work = "CHOP", hp = 100 }) }', '换了世界')
  const second = env.observe()
  assert.equal(second.nearby.delta.status, 'baseline', '换 Session 必须重建基线')
  assert.equal(second.nearby.delta.added_count, 0, '不能把新世界的东西报成新增')
})

test('M1.4-18 Shard 变化：同样重建基线', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = { mkent({ prefab = "spider", x = 8, z = 0, guid = 1, tags = { hostile = true }, hp = 25 }) }', '基线')
  env.observe()
  env.run('NOW = NOW + 5; SHARD = "Caves"; Whale.actor.reset()', '换分片')
  env.run('NEARBY = { mkent({ prefab = "rock", x = 4, z = 0, guid = 3, work = "MINE" }) }', '洞穴里')
  const second = env.observe()
  assert.equal(second.nearby.delta.status, 'baseline')
})

test('M1.4-19 扫描失败后：下一份基线重建，不把失败当作"全消失"', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = { mkent({ prefab = "spider", x = 8, z = 0, guid = 1, tags = { hostile = true }, hp = 25 }) }', '基线')
  env.observe()
  env.run('NOW = NOW + 5; FAIL_SCAN = true', '让扫描失败')
  const failed = env.observe()
  assert.equal(failed.nearby.status, 'error')

  env.run('NOW = NOW + 5; FAIL_SCAN = false', '恢复')
  env.run('NEARBY = { mkent({ prefab = "spider", x = 8, z = 0, guid = 1, tags = { hostile = true }, hp = 25 }) }', '同一只蜘蛛')
  const third = env.observe()
  assert.equal(third.nearby.delta.status, 'baseline', '失败之后要重建基线')
  assert.equal(third.nearby.delta.removed_count, 0)
})

// ─────────────────────────── 引用解析（给 M2 用）───────────────────────────

test('M1.4-20 Resolve()：当前快照能解析、旧快照与未知引用会被拒绝', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = { mkent({ prefab = "spider", x = 8, z = 0, guid = 1, tags = { hostile = true }, hp = 25 }) }', '一只蜘蛛')
  env.run(`
    local actor = Whale.actor.get_actor()
    local data = Whale.observe.BuildData(actor, { seq = 1, now = NOW })
    SNAP = data.nearby.snapshot_id
    local ent, why = Whale.nearby.Resolve(SNAP, "#1")
    assert(ent ~= nil, "当前快照应该能解析 #1：" .. tostring(why))
    local none, why2 = Whale.nearby.Resolve(SNAP, "#9")
    assert(none == nil and why2 == "unknown_ref", "未知引用要拒绝，实际：" .. tostring(why2))
    local old, why3 = Whale.nearby.Resolve("n999", "#1")
    assert(old == nil and why3 == "stale_snapshot", "旧快照号要拒绝，实际：" .. tostring(why3))
    OUT = why2 .. "|" .. why3
  `, '解析引用')
  assert.equal(env.get('OUT'), 'unknown_ref|stale_snapshot')
})

// ─────────────────────────── 性能 / 体积 ───────────────────────────

test('M1.4-21 性能与体积：60 个实体时 JSON 体积与耗时都在预算内', async () => {
  const env = await load()
  env.reset()
  env.run(`
    Whale.config.build(function(k)
      if k == "nearby_max_total" then return 60 end
      if k == "nearby_max_per_bucket" then return 50 end  -- 放开单桶上限，专门测总量
      if k == "scan_radius" then return 16 end
      if k == "scan_seconds" then return 4 end
      return nil
    end)
    NEARBY = {}
    for i = 1, 30 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "spider", x = i * 4, z = 0, guid = 1000 + i, tags = { hostile = true }, hp = 25 })
    end
    for i = 1, 30 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 4, guid = 2000 + i, work = "CHOP", hp = 100 })
    end
  `, '60 个实体')
  const started = Date.now()
  const { nearby } = env.observe()
  const elapsed = Date.now() - started
  const bytes = Buffer.byteLength(JSON.stringify(nearby), 'utf8')
  assert.equal(nearby.total_returned, 60)
  assert.ok(bytes < 12000, `60 个实体的 nearby JSON 应该 < 12KB，实际 ${bytes} 字节`)
  assert.ok(elapsed < 1500, `沙箱里一次观察应该很快，实际 ${elapsed}ms`)
  assert.ok(nearby.scan.duration_ms !== undefined, '要记录扫描耗时')
  console.log(`  [perf] 60 实体：JSON ${bytes} 字节，观察 ${elapsed}ms，scan ${nearby.scan.duration_ms}ms`)
})

// ─────────────────────────── Node 侧兼容 ───────────────────────────

test('M1.4-22 Node 归一化：buckets / refs / delta 原样保留，不被重新生成', () => {
  const near = {
    status: 'ok',
    schema: 'bws.nearby/1',
    snapshot_id: 'n7',
    radius: 16,
    scan_seconds: 4,
    cached: false,
    max_total: 60,
    max_per_bucket: 12,
    total_found: 3,
    total_returned: 2,
    truncated: true,
    scan: { reused: false, timestamp: 1000, age_ms: 0, duration_ms: 2 },
    buckets: {
      threats: [{ ref: '#1', prefab: 'spider', category: 'threats', label: '蜘蛛', distance: 2.1,
                  position: { x: 2, z: 0 }, is_alive: true, health: 25, max_health: 25 }],
      food: [], resources: [], containers: [], structures: [], creatures: [], other: [],
    },
    delta: { status: 'ok', added_count: 1, removed_count: 0, changed_count: 0,
             added: [{ ref: '#1', prefab: 'spider', label: '蜘蛛', category: 'threats' }],
             removed: [], changed: [] },
  }
  const raw = {
    v: 1, seq: 7, t: 1, mod: '0.13.0', ready: true, text: '# 快照 s7',
    data: {
      schema: STATE_SCHEMA,
      identity: { session_id: 's', cluster_id: null, cluster_id_source: 'unavailable', shard_id: 'Master' },
      actor: { actor_id: 'player:KU_x', actor_id_kind: 'stable', actor_type: 'player', prefab: 'warly',
               name: '沃利', valid: true, alive: true, is_ghost: false, missing_components: [], tile_x: 0, tile_z: 0 },
      player: {}, world: { day: 1 }, warnings: [], nearby: near,
      observer: { snapshot_id: 's7', sequence: 7, timestamp: 1, sampled_at: 1, sample_age_ms: 0,
                  reused: false, status: 'ok', errors: [], unavailable_fields: [] },
    },
  }
  const snapshot = normalizeState(raw, { ageMs: 100 })
  assert.deepEqual(snapshot.nearby, near, 'nearby 必须原样透传')
  const payload = toJsonPayload(snapshot)
  assert.equal(payload.nearby.buckets.threats[0].ref, '#1')
  assert.equal(payload.nearby.delta.added[0].ref, '#1')
  assert.equal(payload.nearby.snapshot_id, 'n7')
  assert.equal(payload.nearby.truncated, true)
})

// ─────────────────────────── 真机暴露的分类回归（2026-11-12 实机采样）───────────────────────────
//
// 实机样本里发现三个错判，根因都来自《饥荒》自己的组件定义（不是我们的假数据能猜到的）：
//   · twigs 真的带 edible（foodtype=ROUGHAGE）→ 以前被判成 food
//   · 红雀(crow) 带 inventoryitem + health + combat      → 以前被判成 resources
//   · 南瓜灯(pumpkin_lantern) 带 inventoryitem + health + light → 以前被判成 resources

test('M1.4-23 真机回归：树枝（edible 但 foodtype=ROUGHAGE）算资源，不算食物', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = { mkent({ prefab = "twigs", x = 8, z = 0, guid = 1, item = true, stack = 3, edible = true, edible_type = "ROUGHAGE" }) }', '地上的树枝')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.food.length, 0, '树枝是材料/燃料，别喂给 AI 当食物')
  assert.equal(nearby.buckets.resources.length, 1)
  assert.equal(nearby.buckets.resources[0].stack_size, 3)
  assert.equal(nearby.buckets.resources[0].edible, undefined, '不该标成可食用')
})

test('M1.4-24 真机回归：种子（foodtype=SEEDS）算资源', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = { mkent({ prefab = "seeds", x = 4, z = 0, guid = 2, item = true, edible = true, edible_type = "SEEDS" }) }', '种子')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.food.length, 0)
  assert.equal(nearby.buckets.resources.length, 1)
})

test('M1.4-25 真机回归：地上的真食物（VEGGIE）仍是食物', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = { mkent({ prefab = "carrot", x = 4, z = 0, guid = 3, item = true, edible = true, edible_type = "VEGGIE" }) }', '地上的胡萝卜')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.food.length, 1)
  assert.equal(nearby.buckets.food[0].edible, true)
})

test('M1.4-26 真机回归：红雀（有 health+combat+inventoryitem）算生物，不算掉落物', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = { mkent({ prefab = "crow", x = 8, z = 0, guid = 4, hp = 25, item = true, tags = { bird = true, smallcreature = true } }) }', '一只红雀')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.resources.length, 0, '活物不该被当成地上的资源')
  assert.equal(nearby.buckets.creatures.length, 1)
  assert.equal(nearby.buckets.creatures[0].prefab, 'crow')
})

test('M1.4-27 真机回归：南瓜灯（有 health+light+inventoryitem）算建筑（光源），不算资源', async () => {
  const env = await load()
  env.reset()
  env.run('NEARBY = { mkent({ prefab = "pumpkin_lantern", x = 4, z = 0, guid = 5, hp = 20, item = true, tags = { light = true, veggie = true } }) }', '南瓜灯')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.resources.length, 0)
  assert.equal(nearby.buckets.structures.length, 1)
  assert.equal(nearby.buckets.structures[0].prefab, 'pumpkin_lantern')
})
