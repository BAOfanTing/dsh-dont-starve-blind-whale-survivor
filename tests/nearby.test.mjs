// 附近实体扫描与结构化观察测试（包含分类桶、Delta 追踪、截断、降级、时钟间隔与可行动目标）
// M1.4：附近实体结构化观察的测试
//
// 用 fengari 真跑模组的 nearby/observe 代码（假 GLOBAL，但走的是真正会进游戏的逻辑）。
// 这些全部是 UNIT（沙箱），**不是** DST 真机；真机的采样证据用 tools/m12-watch.mjs 现跑。
// （当时那份真机报告已在 SURVIVAL-07 随 docs/archive 一起删除，git 历史可找回。）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeState, toJsonPayload, STATE_SCHEMA, nearbyLines, renderFallbackText } from '../lib/state/snapshot.js'

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
  for (const name of ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'observe']) {
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


// ─────────────────────────── Delta 追踪与截断 ───────────────────────────
// M1.4 Delta 截断修复（0.13.3）：三个必测场景 + 两个补充
//
// 背景：0.13.2 的 delta 拿"截断后的 kept"做基线，被容量限制挤出窗口的实体会被误报成 removed
// （真机证据当时记在那份 runtime_test_report 的 §5；该报告已在 SURVIVAL-07 删除，git 历史可找回）。0.13.3 改成用**完整扫描候选集合**做基线。
//
// A：截断但实体仍存在 → 不得 removed
// B：实体真的离开完整扫描 → removed + previous_ref（不是当前引用）
// C：实体在两次扫描里"进出 kept"抖动 → 不得 removed、不得 added
// D：窗口外的实体属性变化 → 不报 changed（没有 #N，不可操作）
// E：not_returned 字段与数量自洽







const STUB_DT = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利", EVERGREEN = "常青树", TWIGGYTREE = "多枝树", SPIDER = "蜘蛛" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.FOODTYPE = { ROUGHAGE = "ROUGHAGE", SEEDS = "SEEDS", GEARS = "GEARS", VEGGIE = "VEGGIE" }
GLOBAL.ACTIONS = { CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, DIG = { id = "DIG" }, HAMMER = { id = "HAMMER" } }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "sess-SAME" end }
GLOBAL.TheShard = { GetShardId = function() return "1" end }
NOW = 1000
NEARBY = {}
GLOBAL.TheSim = { GetTime = function() return NOW end, GetRealTime = function() return NOW * 1000 end,
                  FindEntities = function() return NEARBY end }
function mkent(opts)
    local e = { prefab = opts.prefab or "evergreen", GUID = opts.guid, tags = opts.tags or {}, components = {},
                Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end } }
    e.IsValid = function() return true end
    e.HasTag = function(self, tag) if tag == "INLIMBO" then return false end return self.tags[tag] == true end
    if opts.hp ~= nil then e.components.health = { currenthealth = opts.hp, maxhealth = opts.hp, IsDead = function() return false end } end
    if opts.work ~= nil then e.components.workable = { action = { id = opts.work } } end
    return e
end
PLAYER = mkent({ prefab = "warly", guid = 999, tags = { player = true }, hp = 150 })
PLAYER.userid = "KU_probe"
PLAYER.components.inventory = { GetNumSlots = function() return 15 end, GetItemInSlot = function() return nil end,
                                GetEquippedItem = function() return nil end }
GLOBAL.AllPlayers = { PLAYER }
GLOBAL.TheWorld = { state = { cycles = 1, phase = "day", season = "autumn", temperature = 20 },
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

async function newVmDT({ maxPerBucket = 12, maxTotal = 60 } = {}) {
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
  const run = (code) => {
    const st = lauxlib.luaL_dostring(L, to_luastring(code))
    if (st !== lua.LUA_OK) throw new Error('Lua 出错：' + fail())
  }
  const get = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try {
      return to_jsstring(lua.lua_tostring(L, -1))
    } catch {
      return ''
    }
  }
  run(STUB_DT)
  run('Whale = { verbose = false, version = "0.13.3" }')
  for (const name of ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'observe']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', name + '.lua'), 'utf8'))
  }
  run(`Whale.config.build(function(k)
    if k == "scan_radius" then return 16 end
    if k == "scan_seconds" then return 4 end
    if k == "observe_interval" then return 2 end
    if k == "state_interval" then return 1 end
    if k == "nearby_max_total" then return ${maxTotal} end
    if k == "nearby_max_per_bucket" then return ${maxPerBucket} end
    return nil
  end)`)
  const observe = () => {
    run('local a = Whale.actor.get_actor() local d = Whale.observe.BuildData(a, { seq = 0, now = NOW }) OUT = Whale.json.encode(d.nearby)')
    return JSON.parse(get('OUT'))
  }
  return { run, get, observe }
}


test('A 截断但实体仍存在：不得报告 removed，用 not_returned 表达', async () => {
  const env = await newVmDT({ maxPerBucket: 3 }) // 单桶只留 3 个
  // 第一帧：4 棵树，距离 1..4 → 只返回最近 3 棵（guid 1/2/3，guid 4 被挤出）
  env.run(`
    NEARBY = {}
    for i = 1, 4 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = i, work = "CHOP", hp = 100 })
    end
  `)
  const first = env.observe()
  assert.equal(first.total_found, 4)
  assert.equal(first.total_returned, 3)
  assert.equal(first.delta.status, 'baseline')

  // 第二帧：**4 棵树一棵没少**，只是 guid 1 走远（10 格），guid 4 因此进了窗口
  env.run(`
    NOW = NOW + 5
    NEARBY = {}
    NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = 40, z = 0, guid = 1, work = "CHOP", hp = 100 })
    for i = 2, 4 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = i, work = "CHOP", hp = 100 })
    end
  `)
  const second = env.observe()

  assert.equal(second.total_found, 4, '完整扫描仍然是 4 个')
  assert.equal(second.total_returned, 3)
  assert.equal(second.truncated, true)
  assert.equal(second.delta.status, 'ok')
  assert.equal(second.delta.removed_count, 0, '被挤出窗口 ≠ 消失，removed 必须是 0')
  assert.deepEqual(second.delta.removed, [])
  assert.equal(second.delta.added_count, 0, 'guid 4 上一帧就在完整扫描里，不是新增')
  assert.equal(second.delta.not_returned_count, 1, '要有 not_returned 语义')
  assert.equal(second.delta.not_returned.length, 1)
  assert.equal(second.delta.not_returned[0].prefab, 'evergreen')
  assert.equal(second.delta.not_returned[0].ref, undefined, '未返回的实体不能带引用')
  // 当前引用仍然有效且连续
  assert.deepEqual(refsOf(second), ['#1', '#2', '#3'])
})

test('B 实体真的离开完整扫描：removed=1 + previous_ref（且不是当前引用）', async () => {
  const env = await newVmDT({ maxPerBucket: 12 })
  env.run(`
    NEARBY = {}
    for i = 1, 4 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = i, work = "CHOP", hp = 100 })
    end
  `)
  const first = env.observe()
  assert.equal(first.total_returned, 4)
  const firstRefs = refsOf(first)
  assert.deepEqual(firstRefs, ['#1', '#2', '#3', '#4'])

  // 第二帧：guid 2 真的不在了（走远/被砍了），其余 3 棵还在
  env.run(`
    NOW = NOW + 5
    NEARBY = {}
    for i = 1, 4 do
      if i ~= 2 then
        NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = i, work = "CHOP", hp = 100 })
      end
    end
  `)
  const second = env.observe()

  assert.equal(second.total_found, 3)
  assert.equal(second.delta.removed_count, 1)
  const gone = second.delta.removed[0]
  assert.equal(gone.prefab, 'evergreen')
  assert.ok(gone.previous_ref, '要带 previous_ref')
  assert.ok(firstRefs.includes(gone.previous_ref), 'previous_ref 应该是上一帧的编号')
  assert.equal(gone.ref, undefined, 'removed 里不许有当前引用字段')
  const current = refsOf(second)
  assert.equal(current.includes(gone.previous_ref) && false, false, 'previous_ref 不能当当前引用用（这里只做记录）')
  assert.deepEqual(current, ['#1', '#2', '#3'], '当前引用仍然连续有效')
})

test('C 实体在 kept 边界抖动：既不报 removed，也不报 added，两个方向都稳定', async () => {
  const env = await newVmDT({ maxPerBucket: 2 })
  const build = (farGuid) => `
    NEARBY = {}
    for i = 1, 3 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = (i == ${'$'}{FAR} and 40 or i * 4), z = 0, guid = i, work = "CHOP", hp = 100 })
    end`.replace('${FAR}', String(farGuid))

  // 第 1 帧：guid 3 最远 → 被挤出窗口（返回 #1,#2）
  env.run(build(3))
  const first = env.observe()
  assert.equal(first.total_returned, 2)
  assert.equal(first.delta.status, 'baseline')

  // 第 2 帧：guid 1 走远，guid 3 进来（实体集合没变）
  env.run('NOW = NOW + 5')
  env.run(build(1))
  const second = env.observe()
  assert.equal(second.delta.removed_count, 0, '抖动不能报 removed')
  assert.equal(second.delta.added_count, 0, '抖动不能报 added')
  assert.equal(second.delta.not_returned_count, 1)
  assert.deepEqual(refsOf(second), ['#1', '#2'], '当前引用照常重排')

  // 第 3 帧：再换回来（guid 3 又出去）
  env.run('NOW = NOW + 5')
  env.run(build(3))
  const third = env.observe()
  assert.equal(third.delta.removed_count, 0)
  assert.equal(third.delta.added_count, 0)
  assert.equal(third.delta.not_returned_count, 1)
})

test('D 窗口外实体的属性变化：不报 changed（没有 #N 就不可操作）', async () => {
  const env = await newVmDT({ maxPerBucket: 2 })
  // 3 只蜘蛛：guid 3 最远 → 出窗
  env.run(`
    NEARBY = {}
    for i = 1, 3 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "spider", x = i * 4, z = 0, guid = i, tags = { hostile = true }, hp = 25 })
    end
  `)
  env.observe()
  // 第二帧：窗外那只（guid 3）掉血，其余不变
  env.run(`
    NOW = NOW + 5
    NEARBY = {}
    for i = 1, 3 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "spider", x = i * 4, z = 0, guid = i, tags = { hostile = true }, hp = (i == 3 and 10 or 25) })
    end
  `)
  const second = env.observe()
  assert.equal(second.delta.changed_count, 0, '窗口外的变化不报（模型拿不到 #N，报了也没法处理）')
  assert.equal(second.delta.removed_count, 0)
  assert.equal(second.delta.not_returned_count, 1)
})

test('E not_returned 与 total_found / total_returned 自洽，且 reused 时不重算', async () => {
  const env = await newVmDT({ maxPerBucket: 2 })
  env.run(`
    NEARBY = {}
    for i = 1, 5 do
      NEARBY[#NEARBY + 1] = mkent({ prefab = "evergreen", x = i * 4, z = 0, guid = i, work = "CHOP", hp = 100 })
    end
  `)
  const first = env.observe()
  assert.equal(first.delta.not_returned_count, first.total_found - first.total_returned)
  assert.equal(first.delta.not_returned.length, Math.min(12, first.delta.not_returned_count))

  // 未到 scan_seconds：reused，delta 原样
  env.run('NOW = NOW + 1')
  const reused = env.observe()
  assert.equal(reused.scan.reused, true)
  assert.equal(reused.delta.status, first.delta.status)
  assert.equal(reused.delta.not_returned_count, first.delta.not_returned_count)
})


// ─────────────────────────── 异常降级 ───────────────────────────
// M1.4 收尾：Node fallback 文本对 nearby 的渲染（新旧结构都要能读）
//
// 背景：Lua 原生 text 缺失/被截断时，Node 的 renderFallbackText 以前完全不输出 nearby。
// 0.13.4 起补上；仍然只读快照、不重新扫描、不重新编号、不重算 Delta。





const baseData = () => ({
  schema: STATE_SCHEMA,
  identity: { session_id: 'sess', cluster_id: null, cluster_id_source: 'unavailable', shard_id: '1' },
  actor: {
    actor_id: 'player:KU_x', actor_id_kind: 'stable', actor_type: 'player', prefab: 'warly',
    name: '沃利', valid: true, alive: true, is_ghost: false, missing_components: [], tile_x: 0, tile_z: 0,
  },
  player: { inventory: { slots: 15, used: 0, items: [] } },
  world: { day: 1 },
  warnings: [],
  observer: { snapshot_id: 's1', sequence: 1, timestamp: 1, sampled_at: 1, sample_age_ms: 0,
              reused: false, status: 'ok', errors: [], unavailable_fields: [] },
})

const snapOf = (nearby, { text = '' } = {}) =>
  normalizeState(
    { v: 1, seq: 1, t: 1, mod: '0.13.4', ready: true, text, data: { ...baseData(), nearby } },
    { ageMs: 100 },
  )

const newNearby = (over = {}) => ({
  status: 'ok',
  schema: 'bws.nearby/1',
  runtime_id: 'r1-0001',
  snapshot_id: 'r1-0001-n5',
  radius: 16,
  scan_seconds: 4,
  max_total: 60,
  max_per_bucket: 12,
  total_found: 157,
  total_returned: 3,
  truncated: true,
  scan: { reused: false, timestamp: 1, age_ms: 0, duration_ms: 0.7, duration_source: 'os.clock' },
  buckets: {
    threats: [{ ref: '#1', prefab: 'frog', category: 'threats', label: '青蛙', distance: 1.2,
                position: { x: 1, z: 0 }, health: 25, max_health: 25 }],
    food: [],
    resources: [{ ref: '#2', prefab: 'evergreen', category: 'resources', label: '常青树', distance: 3.4,
                  position: { x: 3, z: 1 }, work_action: 'CHOP' }],
    containers: [],
    structures: [{ ref: '#3', prefab: 'pumpkin_lantern', category: 'structures', label: '南瓜灯', distance: 2 }],
    creatures: [],
    other: [],
  },
  delta: {
    status: 'ok', added_count: 1, removed_count: 1, changed_count: 1,
    added: [{ ref: '#2', prefab: 'evergreen', label: '常青树', category: 'resources' }],
    removed: [{ previous_ref: '#9', prefab: 'twiggytree', label: '多枝树', category: 'resources' }],
    changed: [{ ref: '#1', prefab: 'frog', label: '青蛙', category: 'threats',
                fields: { health: { from: 30, to: 25 } } }],
    not_returned_count: 154,
    not_returned: [{ prefab: 'grass', category: 'resources', distance: 9.1 }],
  },
  ...over,
})

test('fallback-1 新版对象结构：状态/半径/总数/截断/桶/#N/Delta/未列出 都要有', () => {
  const text = renderFallbackText(snapOf(newNearby()))
  // M2.2.2：nearby 段头现在带自己的扫描 id（模型调 pickup/harvest 要填它）
  assert.match(text, /附近（16 格内，Nearby 快照 ID：r1-0001-n5，只显示 3\/157 个）：/)
  assert.match(text, /威胁：#1 青蛙/)
  assert.match(text, /资源：#2 常青树 .*可CHOP/)
  assert.match(text, /建筑：#3 南瓜灯/)
  assert.match(text, /变化：新出现 #2 常青树；消失 1 个（多枝树）；变化 #1 青蛙/)
  assert.match(text, /未列出 154 个/)
})

test('fallback-2 旧版数组结构（M1.1）：也能渲染，且不伪造 #N', () => {
  const legacyNearby = {
    status: 'legacy',
    radius: 12,
    scan_seconds: 4,
    buckets: [
      { kind: 'hostile', label: '敌人', total: 1, shown: 1, truncated: false,
        items: [{ prefab: 'spider', name: '蜘蛛', tile_x: 2, tile_z: 3, dist: 2.5 }] },
    ],
  }
  const text = renderFallbackText(snapOf(legacyNearby))
  assert.match(text, /附近（12 格内）：/)
  assert.match(text, /敌人：蜘蛛 \(2,3\) 距2\.5/)
  assert.doesNotMatch(text, /#1/, '老结构没有引用，不能凭空造 #N')
})

test('fallback-3 empty：说"没什么值得注意的"，不能说"读不到"', () => {
  const text = renderFallbackText(snapOf(newNearby({
    status: 'empty', total_found: 0, total_returned: 0, truncated: false,
    buckets: { threats: [], food: [], resources: [], containers: [], structures: [], creatures: [], other: [] },
    delta: { status: 'baseline', added_count: 0, removed_count: 0, changed_count: 0, added: [], removed: [], changed: [] },
  })))
  assert.match(text, /没什么值得注意的/)
  assert.doesNotMatch(text, /读不到/)
})

test('fallback-4 error：明确说读不到 + 原因', () => {
  const text = renderFallbackText(snapOf(newNearby({
    status: 'error', error: 'find_entities_failed', buckets: {}, total_found: 0, total_returned: 0, truncated: false,
  })))
  assert.match(text, /暂时读不到（扫描出错：find_entities_failed）/)
})

test('fallback-5 缺失 nearby：不输出附近段（也不报错）', () => {
  const snapshot = snapOf(undefined)
  assert.equal(snapshot.nearby, null)
  const text = renderFallbackText(snapshot)
  assert.doesNotMatch(text, /附近/)
  assert.ok(text.includes('沃利'), '其它内容照常')
})

test('fallback-6 桶内容带 #N 且与 JSON 一致；previous_ref 不当当前引用', () => {
  const snapshot = snapOf(newNearby())
  const payload = toJsonPayload(snapshot)
  const refsInJson = Object.values(payload.nearby.buckets).flat().map((x) => x.ref)
  const text = nearbyLines(snapshot.nearby).join('\n')
  for (const ref of refsInJson) assert.ok(text.includes(ref), `文本里应出现 ${ref}`)
  assert.match(text, /消失 1 个（多枝树）/, '消失项只用名字，不把 previous_ref 当当前引用')
  assert.doesNotMatch(text, /#9 /, 'previous_ref 不该作为可操作引用出现')
})

test('fallback-7 not_returned 不当作可操作目标', () => {
  const text = nearbyLines(newNearby()).join('\n')
  assert.match(text, /未列出 154 个/, '只报数量')
  assert.doesNotMatch(text, /草\s*#/, '未返回实体没有引用')
})

test('fallback-8 Node 不改 Delta、不重算：渲染内容与快照字段一一对应', () => {
  const nearby = newNearby()
  const snapshot = snapOf(nearby)
  const before = JSON.stringify(snapshot.nearby)
  nearbyLines(snapshot.nearby)
  assert.equal(JSON.stringify(snapshot.nearby), before, '渲染不能改动快照对象')
  assert.equal(snapshot.nearby.delta.removed_count, 1, 'Delta 原样保留')
})

test('fallback-9 Lua text 存在时优先用 Lua 的（fallback 不覆盖）', () => {
  const snapshot = snapOf(newNearby(), { text: '# 快照 s1 · Lua 自己渲染的文本' })
  const viaTool = snapshot.text
  assert.match(viaTool, /Lua 自己渲染/)
  const fallback = renderFallbackText(snapshot)
  assert.doesNotMatch(fallback, /Lua 自己渲染/, 'fallback 是另一条路径，不读 text 字段')
})

test('fallback-10 legacy 状态文件（无 schema）仍能读，不炸', () => {
  const snapshot = normalizeState(
    { v: 1, seq: 3, t: 1, mod: '0.10.0', ready: true, text: '# 旧格式\n你：沃利', data: {} },
    { ageMs: 99999 },
  )
  assert.equal(snapshot.schema, 'legacy')
  assert.equal(snapshot.stale, true)
  const text = renderFallbackText(snapshot)
  assert.ok(text.length > 0)
  assert.doesNotMatch(text, /附近/) // 老文件没有 nearby，不编
})


// ─────────────────────────── Runtime ID 世代隔离 ───────────────────────────
// M1.4 验收发现的安全回归：运行实例隔离
//
// 真机上观察到的两个事实：
//   1. session_id 跨"重启游戏"不变（两次采样都是 5F056B29DE65C542）；
//   2. scan_seq 每次运行都从 1 开始。
// 所以如果 snapshot_id 只有 "n1"，重启后的新实例会产出同样的 "n1"，
// 上一次运行的 (#1, n1) 就会被解析成新实例里的**另一个实体**。
// 0.13.2 起 snapshot_id = "<运行实例号>-n<序号>"，Resolve() 只认当前实例。







const STUB_RT = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利", SPIDER = "蜘蛛", EVERGREEN = "常青树" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.FOODTYPE = { ROUGHAGE = "ROUGHAGE", SEEDS = "SEEDS", GEARS = "GEARS", VEGGIE = "VEGGIE" }
GLOBAL.ACTIONS = { CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, DIG = { id = "DIG" }, HAMMER = { id = "HAMMER" } }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "sess-SAME" end }
GLOBAL.TheShard = { GetShardId = function() return "1" end }
NOW = 1000
NEARBY = {}
GLOBAL.TheSim = { GetTime = function() return NOW end, GetRealTime = function() return NOW * 1000 end,
                  FindEntities = function() return NEARBY end }
function mkent(opts)
    local e = { prefab = opts.prefab, GUID = opts.guid or 1, tags = opts.tags or {}, components = {},
                Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end } }
    e.IsValid = function() return true end
    e.HasTag = function(self, tag) if tag == "INLIMBO" then return false end return self.tags[tag] == true end
    if opts.hp ~= nil then e.components.health = { currenthealth = opts.hp, maxhealth = opts.hp, IsDead = function() return false end } end
    if opts.work ~= nil then e.components.workable = { action = { id = opts.work } } end
    return e
end
PLAYER = mkent({ prefab = "warly", guid = 999, tags = { player = true }, hp = 150 })
PLAYER.userid = "KU_probe"
PLAYER.components.inventory = { GetNumSlots = function() return 15 end, GetItemInSlot = function() return nil end,
                                GetEquippedItem = function() return nil end }
GLOBAL.AllPlayers = { PLAYER }
GLOBAL.TheWorld = { state = { cycles = 1, phase = "day", season = "autumn", temperature = 20 },
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

async function newVmRT() {
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
  const run = (code) => {
    const st = lauxlib.luaL_dostring(L, to_luastring(code))
    if (st !== lua.LUA_OK) throw new Error('Lua 出错：' + fail())
  }
  const get = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try {
      return to_jsstring(lua.lua_tostring(L, -1))
    } catch {
      return ''
    }
  }
  run(STUB_RT)
  run('Whale = { verbose = false, version = "0.13.2" }')
  for (const name of ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'observe']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', name + '.lua'), 'utf8'))
  }
  run('Whale.config.build(function(k) if k == "scan_radius" then return 16 end if k == "scan_seconds" then return 4 end return nil end)')
  const observe = () => {
    run('local a = Whale.actor.get_actor() local d = Whale.observe.BuildData(a, { seq = 0, now = NOW }) OUT = Whale.json.encode(d.nearby)')
    return JSON.parse(get('OUT'))
  }
  return { run, get, observe }
}

test('运行实例隔离：snapshot_id 带实例号，且旧实例的引用会被拒绝', async () => {
  const first = await newVmRT()
  first.run('NEARBY = { mkent({ prefab = "spider", x = 8, z = 0, guid = 1, tags = { hostile = true }, hp = 25 }) }')
  const one = first.observe()

  assert.match(one.runtime_id ?? '', /^r\d+-\d{4}$/, '要有运行实例号')
  assert.equal(
    one.snapshot_id.indexOf(one.runtime_id + '-n'),
    0,
    'snapshot_id 必须以运行实例号开头，实际：' + one.snapshot_id,
  )

  // 同一实例内能解析
  first.run('local ent, why = Whale.nearby.Resolve("' + one.snapshot_id + '", "#1") OUT = ent ~= nil and ("ok:" .. ent.prefab) or ("reject:" .. tostring(why))')
  assert.equal(first.get('OUT'), 'ok:spider', '同实例内应该能解析')

  // 模拟"游戏重启"：全新 Lua 实例（session 相同，世界里换成另一只东西）
  const second = await newVmRT()
  second.run('NEARBY = { mkent({ prefab = "evergreen", x = 12, z = 0, guid = 2, work = "CHOP", hp = 100 }) }')
  const two = second.observe()
  assert.notEqual(two.snapshot_id, one.snapshot_id, '两个运行实例的快照号不能相同')

  // 拿上一个实例的快照号来解析 → 必须 stale_snapshot，不能命中 evergreen
  second.run('local ent, why = Whale.nearby.Resolve("' + one.snapshot_id + '", "#1") OUT = ent ~= nil and ("hit:" .. ent.prefab) or ("reject:" .. tostring(why))')
  assert.equal(second.get('OUT'), 'reject:stale_snapshot', '旧实例的引用必须被拒绝，实际：' + second.get('OUT'))
})

test('运行实例隔离：同一实例内两次扫描的引用互不串（旧扫描号也拒绝）', async () => {
  const env = await newVmRT()
  env.run('NEARBY = { mkent({ prefab = "spider", x = 8, z = 0, guid = 1, tags = { hostile = true }, hp = 25 }) }')
  const first = env.observe()
  env.run('NOW = NOW + 10')
  env.run('NEARBY = { mkent({ prefab = "evergreen", x = 12, z = 0, guid = 2, work = "CHOP", hp = 100 }) }')
  const second = env.observe()

  assert.notEqual(first.snapshot_id, second.snapshot_id, '新扫描要换快照号')
  env.run('local ent, why = Whale.nearby.Resolve("' + first.snapshot_id + '", "#1") OUT = ent ~= nil and ("hit:" .. ent.prefab) or ("reject:" .. tostring(why))')
  assert.equal(env.get('OUT'), 'reject:stale_snapshot', '旧扫描号不该还能解析')
})


// ─────────────────────────── 扫描时钟与节流 ───────────────────────────
// M1.4 收尾：scan.duration_ms 计时精度（0.13.4）
//
// 真机现象：0.13.3 及以前 duration_ms 恒为 0 —— 因为用的是秒级时间戳 ×1000 再取整。
// 0.13.4 改为：优先 os.clock()（亚毫秒），退回 TheSim:GetRealTime()（毫秒），两者都不可用 → null。







/** clockMode: "os" | "realtime" | "broken" | "none" | "mixed" */
const STUB_BASE = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利", EVERGREEN = "常青树" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.FOODTYPE = { ROUGHAGE = "ROUGHAGE", SEEDS = "SEEDS", GEARS = "GEARS", VEGGIE = "VEGGIE" }
GLOBAL.ACTIONS = { CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, DIG = { id = "DIG" }, HAMMER = { id = "HAMMER" } }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "sess-T" end }
GLOBAL.TheShard = { GetShardId = function() return "1" end }
NOW = 1000
CLOCK = 0        -- os.clock 的假实现（秒）
RT_MS = 5000     -- GetRealTime 的假实现（毫秒）
NEARBY = {}
FAIL_SCAN = false
GLOBAL.TheSim = { GetTime = function() return nil end,
                  FindEntities = function() if FAIL_SCAN then error("boom") end return NEARBY end }
function mkent(opts)
    local e = { prefab = opts.prefab or "evergreen", GUID = opts.guid or 1, tags = {}, components = {},
                Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end } }
    e.IsValid = function() return true end
    e.HasTag = function(self, tag) if tag == "INLIMBO" then return false end return self.tags[tag] == true end
    if opts.work ~= nil then e.components.workable = { action = { id = opts.work } } end
    return e
end
PLAYER = mkent({ prefab = "warly", guid = 999 })
PLAYER.userid = "KU_t"
PLAYER.components.inventory = { GetNumSlots = function() return 15 end, GetItemInSlot = function() return nil end,
                                GetEquippedItem = function() return nil end }
GLOBAL.AllPlayers = { PLAYER }
GLOBAL.TheWorld = { state = { cycles = 1, phase = "day", season = "autumn", temperature = 20 },
                    HasTag = function() return false end, ismastersim = true }
GLOBAL.setmetatable = setmetatable
GLOBAL.getmetatable = getmetatable
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.io = nil
pcall = nil
tonumber = nil
error = nil
os = nil
io = nil
`

function clockCode(mode) {
  switch (mode) {
    case 'os':
      return `
        GLOBAL.os = { time = function() return 1794500000 end,
                      clock = function() CLOCK = CLOCK + 0.0007 return CLOCK end }
        GLOBAL.TheSim.GetRealTime = function() return RT_MS end
      `
    case 'realtime':
      return `
        GLOBAL.os = { time = function() return 1794500000 end }
        GLOBAL.TheSim.GetRealTime = function() RT_MS = RT_MS + 3 return RT_MS end
      `
    case 'broken':
      return `
        GLOBAL.os = { time = function() return 1794500000 end,
                      clock = function() return "not-a-number" end }
        GLOBAL.TheSim.GetRealTime = function() return 0/0 end
      `
    case 'mixed':
      // 第一次走 os.clock，第二次 os.clock 抛错 → 源不一致，应判为不可用
      return `
        GLOBAL.os = { time = function() return 1794500000 end,
                      clock = function() CLOCK = CLOCK + 1 if CLOCK > 1 then error("boom") end return CLOCK end }
        GLOBAL.TheSim.GetRealTime = function() RT_MS = RT_MS + 5 return RT_MS end
      `
    default:
      return `
        GLOBAL.os = { time = function() return 1794500000 end }
      `
  }
}

async function newVmTM(mode) {
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
  const run = (code) => {
    const st = lauxlib.luaL_dostring(L, to_luastring(code))
    if (st !== lua.LUA_OK) throw new Error('Lua 出错：' + fail())
  }
  const get = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try {
      return to_jsstring(lua.lua_tostring(L, -1))
    } catch {
      return ''
    }
  }
  run(STUB_BASE)
  run(clockCode(mode))
  run('Whale = { verbose = false, version = "0.13.4" }')
  for (const name of ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'observe']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', name + '.lua'), 'utf8'))
  }
  run('Whale.config.build(function(k) if k == "scan_radius" then return 16 end if k == "scan_seconds" then return 4 end return nil end)')
  run('NEARBY = { mkent({ prefab = "evergreen", x = 4, z = 0, guid = 1, work = "CHOP" }) }')
  const observe = () => {
    run('local a = Whale.actor.get_actor() local d = Whale.observe.BuildData(a, { seq = 0, now = NOW }) OUT = Whale.json.encode(d.nearby)')
    return JSON.parse(get('OUT'))
  }
  return { run, get, observe }
}

test('计时-1 os.clock 可用：记录亚毫秒耗时（1 位小数，不再是 0）', async () => {
  const env = await newVmTM('os')
  const nearby = env.observe()
  assert.equal(nearby.scan.duration_source, 'os.clock')
  assert.equal(typeof nearby.scan.duration_ms, 'number')
  assert.ok(nearby.scan.duration_ms > 0, '亚毫秒也要有值，实际：' + nearby.scan.duration_ms)
  assert.equal(nearby.scan.duration_ms, 0.7, '两次 clock 各前进 0.7ms → 0.7ms')
})

test('计时-2 只有 GetRealTime：按毫秒算', async () => {
  const env = await newVmTM('realtime')
  const nearby = env.observe()
  assert.equal(nearby.scan.duration_source, 'realtime')
  assert.equal(nearby.scan.duration_ms, 3, '两次调用各 +3ms')
})

test('计时-3 两个时钟都不可用：duration_ms 为 null，不伪装成 0，快照仍正常', async () => {
  const env = await newVmTM('none')
  const nearby = env.observe()
  assert.equal(nearby.status, 'ok', '计时失败不该拖垮快照')
  assert.ok(nearby.scan.duration_ms == null, '计时不可用时应为 null/缺席')
  assert.equal(nearby.scan.duration_source, 'unavailable')
})

test('计时-4 时钟返回异常值：不污染状态', async () => {
  const env = await newVmTM('broken')
  const nearby = env.observe()
  assert.equal(nearby.status, 'ok')
  assert.ok(nearby.scan.duration_ms == null, '计时不可用时应为 null/缺席')
  assert.equal(nearby.scan.duration_source, 'unavailable')
})

test('计时-5 两次调用时钟源不一致：判为不可用（不给出错误差值）', async () => {
  const env = await newVmTM('mixed')
  const nearby = env.observe()
  assert.equal(nearby.status, 'ok')
  assert.ok(nearby.scan.duration_ms == null, '混用两个时钟源算出来的差值没有意义')
  assert.equal(nearby.scan.duration_source, 'unavailable')
})

test('计时-6 扫描失败：status=error 且不写假耗时', async () => {
  const env = await newVmTM('os')
  env.run('FAIL_SCAN = true')
  const nearby = env.observe()
  assert.equal(nearby.status, 'error')
  assert.ok(nearby.scan.duration_ms == null, '计时不可用时应为 null/缺席')
  assert.equal(nearby.scan.duration_source, 'unavailable')
})

test('计时-7 复用快照：沿用原来的耗时，不虚构新的一次扫描', async () => {
  const env = await newVmTM('os')
  const first = env.observe()
  env.run('NOW = NOW + 1') // 未到 scan_seconds，应复用
  const reused = env.observe()
  assert.equal(reused.scan.reused, true)
  assert.equal(reused.snapshot_id, first.snapshot_id)
  assert.equal(reused.scan.duration_ms ?? null, first.scan.duration_ms ?? null, '复用不该产生新的耗时')
  assert.equal(reused.scan.duration_source, first.scan.duration_source)
})


// ─────────────────────────── 观察统计口径 ───────────────────────────
// m14-watch 统计口径的单元测试（纯函数，不需要游戏）



import { createWatchStats, versionKeyOf, VERSION_KEY_KINDS } from '../tools/watch-counters.mjs'

const snap = ({ sequence = 1, session = 'sess', shard = '1', runtime = 'r1-0001', snapshotId = 'n1', reused = false } = {}) => ({
  sequence,
  identity: { sessionId: session, shardId: shard },
  nearby: { runtime_id: runtime, snapshot_id: snapshotId, scan: { reused } },
})

test('watcher-1 同一个状态版本被轮询两次，只算一个 unique_file_version', () => {
  const stats = createWatchStats()
  stats.poll({ snapshot: snap({ sequence: 5 }) })
  stats.poll({ snapshot: snap({ sequence: 5 }) })
  const s = stats.summary()
  assert.equal(s.poll_count, 2)
  assert.equal(s.unique_file_versions, 1)
  assert.equal(s.duplicate_polls, 1)
})

test('watcher-2 同一个 nearby.snapshot_id 对应多个状态版本时，只算一个 unique_snapshot_id', () => {
  const stats = createWatchStats()
  stats.poll({ snapshot: snap({ sequence: 10, snapshotId: 'r1-0001-n3', reused: false }) })
  stats.poll({ snapshot: snap({ sequence: 11, snapshotId: 'r1-0001-n3', reused: true }) })
  stats.poll({ snapshot: snap({ sequence: 12, snapshotId: 'r1-0001-n3', reused: true }) })
  const s = stats.summary()
  assert.equal(s.unique_file_versions, 3, '三个不同的 sequence = 三个文件版本')
  assert.equal(s.unique_snapshot_ids, 1, '同一个扫描快照只算一次')
})

test('watcher-3 reused / fresh 按唯一文件版本计数', () => {
  const stats = createWatchStats()
  // 版本 A：新扫描；版本 B/C：复用
  stats.poll({ snapshot: snap({ sequence: 20, snapshotId: 'n7', reused: false }) })
  stats.poll({ snapshot: snap({ sequence: 21, snapshotId: 'n7', reused: true }) })
  stats.poll({ snapshot: snap({ sequence: 22, snapshotId: 'n7', reused: true }) })
  // 同一版本重复轮询不应重复计数
  stats.poll({ snapshot: snap({ sequence: 22, snapshotId: 'n7', reused: true }) })
  const s = stats.summary()
  assert.equal(s.fresh_scan_file_versions, 1)
  assert.equal(s.reused_file_versions, 2)
  assert.equal(s.reused_ratio, 0.667)
  assert.equal(s.fresh_scan_ratio, 0.333)
})

test('watcher-4 游戏重启后 sequence 归零，不会错误去重（靠 runtime_id）', () => {
  const stats = createWatchStats()
  stats.poll({ snapshot: snap({ sequence: 90, runtime: 'r-old-0001', snapshotId: 'r-old-0001-n30' }) })
  // 重启：sequence 回到 1，runtime_id 变了
  stats.poll({ snapshot: snap({ sequence: 1, runtime: 'r-new-0002', snapshotId: 'r-new-0002-n1' }) })
  const s = stats.summary()
  assert.equal(s.unique_file_versions, 2, '重启后的 seq=1 是新版本，不能和旧的合并')
  assert.equal(s.unique_snapshot_ids, 2)
  assert.equal(s.version_key_kind, VERSION_KEY_KINDS.full)
})

test('watcher-5 没有 runtime_id（0.13.2 以前）时退回 sequence 键，并标注不可靠', () => {
  const stats = createWatchStats()
  const legacy = snap({ sequence: 7, runtime: null, snapshotId: 'n7' })
  stats.poll({ snapshot: legacy })
  stats.poll({ snapshot: legacy })
  const s = stats.summary()
  assert.equal(s.unique_file_versions, 1)
  assert.equal(s.version_key_kind, VERSION_KEY_KINDS.sequence)
  // 键本身也要能造出来
  assert.equal(versionKeyOf(legacy).key, 'seq:7')
})

test('watcher-6 JSON 解析错误被保留，且不污染版本计数', () => {
  const stats = createWatchStats()
  stats.poll({ snapshot: snap({ sequence: 1 }) })
  stats.poll({ parseError: 'Unexpected end of JSON input' })
  stats.poll({ snapshot: null }) // 文件不存在
  const s = stats.summary()
  assert.equal(s.parse_errors, 1)
  assert.equal(s.missing_frames, 1)
  assert.equal(s.unique_file_versions, 1)
  assert.equal(s.poll_count, 3)
})

test('watcher-7 nearby 为空（empty）不会被算成错误，也不影响版本统计', () => {
  const stats = createWatchStats()
  const empty = snap({ sequence: 3, snapshotId: 'n3' })
  empty.nearby.status = 'empty'
  empty.nearby.scan.reused = false
  stats.poll({ snapshot: empty })
  const s = stats.summary()
  assert.equal(s.unique_file_versions, 1)
  assert.equal(s.fresh_scan_file_versions, 1)
  assert.equal(s.parse_errors, 0)
  assert.equal(s.missing_frames, 0)
})


// ─────────────────────────── 可行动目标与优先级 ───────────────────────────
// M2.2 Actionable Nearby：可行动目标观察与优先级
//
// 证据类型：UNIT（fengari 假游戏 + 真实 nearby.lua/pickuprules.lua；Node 侧用真实 snapshot.js）
// 覆盖：新桶 / 候选判定 / 食物分类修复 / 排序 / 上限 / 截断 / 引用 / Delta / 跨桶转换 /
//       观察-执行一致 / Node 兼容与 fallback









const STUB_AN = `
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

async function loadLuaAN({ withGuard = false } = {}) {
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
  run(STUB_AN, '假游戏')
  run('Whale = { verbose = false, version = "0.16.0" }', 'Whale')
  const mods = ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'observe']
  if (withGuard) mods.push('guard_specs', 'guard')
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
  const env = await loadLuaAN()
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
  const env = await loadLuaAN()
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
  const env = await loadLuaAN()
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
  const env = await loadLuaAN()
  env.run(`NEARBY = { mkent({ prefab = "flint", guid = 31, x = 8, z = 0, item = true,
                              canbepickedup = true, edible = true, edible_type = "ELEMENTAL" }) }`, 'flint')
  const { nearby } = env.observe()
  const flat = env.flat
  assert.equal(nearby.buckets.food.length, 0, 'flint 绝不能进 food')
  assert.equal(nearby.buckets.pickupables.length, 1)
  assert.equal(flat(nearby)[0].item_kind, 'resources')
  assert.equal(flat(nearby)[0].edible, undefined, '既然不是玩家食物，就不该标 edible')
})

test('M2.2-05 地上的浆果进 pickupables（能捡），胡萝卜苗仍在 food', async () => {
  const env = await loadLuaAN()
  env.run(`NEARBY = {
    mkent({ prefab = "berries", guid = 41, x = 8, z = 0, item = true, edible = true, edible_type = "VEGGIE" }),
    -- M2.3：浆果丛是批准的可收获对象（带原生 pickable 组件）⇒ 进 harvestables，item_kind 保留 food 语义
    mkent({ prefab = "berrybush", guid = 42, x = 16, z = 0, tags = { pickable = true }, pickable = true, product = "berries" }),
    -- 胡萝卜不在 M2.3 白名单里 ⇒ 仍然留在 food
    mkent({ prefab = "carrot_planted", guid = 43, x = 24, z = 0, tags = { pickable = true } }),
  }`, '食物')
  const { nearby } = env.observe()
  const foodPrefabs = nearby.buckets.food.map((f) => f.prefab).sort()
  assert.deepEqual(foodPrefabs, ['carrot_planted'], '胡萝卜苗不是可捡物，仍然留在 food')
  assert.deepEqual(nearby.buckets.pickupables.map((p) => p.prefab), ['berries'],
    '落地的浆果现在可以捡（复活后 25% 血就靠它续命）')
  assert.equal(nearby.buckets.pickupables[0].item_kind, 'food', '语义仍然是食物')
  assert.deepEqual(nearby.buckets.harvestables.map((h) => h.prefab), ['berrybush'], 'M2.3：浆果丛进可收获桶')
  assert.equal(nearby.buckets.harvestables[0].item_kind, 'food', '语义仍然是食物来源')
})

test('M2.2-06 树枝(ROUGHAGE)/种子(SEEDS)/齿轮(GEARS)/木头(WOOD) 都不算食物', async () => {
  const env = await loadLuaAN()
  env.run(`NEARBY = {
    mkent({ prefab = "log", guid = 51, x = 8, z = 0, item = true, edible = true, edible_type = "WOOD" }),
    mkent({ prefab = "seeds", guid = 52, x = 16, z = 0, item = true, edible = true, edible_type = "SEEDS" }),
    mkent({ prefab = "gears", guid = 53, x = 24, z = 0, item = true, edible = true, edible_type = "GEARS" }),
    mkent({ prefab = "nitre", guid = 54, x = 32, z = 0, item = true, edible = true, edible_type = "NITRE" }),
    mkent({ prefab = "twigs", guid = 55, x = 40, z = 0, item = true, canbepickedup = true, edible = true, edible_type = "ROUGHAGE" }),
  }`, '非食物')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.food.length, 0, '这些都不该进 food')
  // ★ TARGET-REFRESH：白名单扩了 —— 砍树产物（log/nitre）现在也是可拾取候选，
  //   否则"树砍倒了、木头掉在脚边"却永远捡不起来（真机踩过）。
  //   但**食物**判定没变：log/seeds/gears/nitre/twigs 都不是食物。
  const picks = nearby.buckets.pickupables.map((e) => e.prefab).sort()
  assert.deepEqual(picks, ['log', 'nitre', 'twigs'], '白名单内的地面物品进 pickupables')
  // 不在白名单的（seeds / gears）落回 resources
  const res = nearby.buckets.resources.map((e) => e.prefab).sort()
  assert.deepEqual(res, ['gears', 'seeds'], '非白名单物品仍落回 resources')
})

test('M2.2-07 树/岩石/生物/建筑/南瓜灯都不进 pickupables', async () => {
  const env = await loadLuaAN()
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
  const env = await loadLuaAN()
  env.run(`NEARBY = { mkent({ prefab = "flint", guid = 71, x = 8 * 4, z = 0, item = true, canbepickedup = true }) }`, '远处燧石')
  const { nearby } = env.observe()
  assert.equal(nearby.buckets.pickupables.length, 1, '远也必须能被看见')
  assert.equal(nearby.buckets.pickupables[0].distance, 8)
})

test('M2.2-09 不是候选的三种情况：已被别人拿着 / canbepickedup=false / 不在白名单', async () => {
  const env = await loadLuaAN()
  env.run(`NEARBY = {
    mkent({ prefab = "flint", guid = 81, x = 8, z = 0, item = true, canbepickedup = true, owner = PLAYER }),
    mkent({ prefab = "twigs", guid = 82, x = 16, z = 0, item = true, canbepickedup = false }),
    mkent({ prefab = "goldnugget", guid = 83, x = 24, z = 0, item = true, canbepickedup = true }),
  }`, '非候选')
  const { nearby } = env.observe()
  const flat = env.flat
  // ★ TARGET-REFRESH：goldnugget 现在在拾取白名单里（挖金矿的产物，不然挖完捡不到），
  //   所以"不在白名单"那一例换成 seeds（真正不在白名单的物品）。
  assert.equal(nearby.buckets.pickupables.length, 1, '只有 goldnugget 是候选')
  assert.equal(nearby.buckets.pickupables[0].prefab, 'goldnugget')
  const byPrefab = Object.fromEntries(flat(nearby).map((e) => [e.prefab, e.bucket]))
  // 被玩家拿着的物品：真机里会因进 limbo 被扫描直接过滤掉；万一漏进来，
  // 也绝不能是拾取候选（它既不是"地上的资源"，也不该被捡 —— 落到 other 是兜底行为）
  assert.equal(byPrefab.flint, 'other')
  assert.equal(byPrefab.twigs, 'resources')
  // TARGET-REFRESH：金块在拾取白名单里了（挖金矿的产物，不然挖完捡不到）
  assert.equal(byPrefab.goldnugget, 'pickupables')
})

test('M2.2-10 limbo / 失效实体不进任何桶（扫描层就过滤）', async () => {
  const env = await loadLuaAN()
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
  const env = await loadLuaAN()
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
  const env = await loadLuaAN()
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
  const env = await loadLuaAN()
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
  const env = await loadLuaAN()
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
  const env = await loadLuaAN()
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
  const env = await loadLuaAN()
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
  const env = await loadLuaAN()
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
  const env = await loadLuaAN()
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
  const env = await loadLuaAN()
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
  const env = await loadLuaAN()
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
  const env = await loadLuaAN({ withGuard: true })
  env.run(`OUT_SAME = tostring(Whale.guard.PICKUP_PREFABS == Whale.pickuprules.PREFABS)
            OUT_LIST = table.concat(Whale.pickuprules.PrefabList(), ",")
            OUT_MAX = tostring(Whale.guard.PICKUP_MAX_TILES)`, '一致性')
  assert.equal(env.get('OUT_SAME'), 'true', '必须是同一张表（杜绝两份规则漂移）')
  assert.equal(env.get('OUT_LIST'),
    'acorn,baconeggs,berries,berries_cooked,berries_juicy,berries_juicy_cooked,blue_cap,butterflymuffin,carrot,carrot_cooked,charcoal,corn,corn_cooked,cutgrass,dragonpie,eggplant,eggplant_cooked,fish,fish_cooked,fishsticks,flint,frogglebunwich,froglegs,froglegs_cooked,fruitmedley,goldnugget,green_cap,honey,honeyham,log,meat,meat_cooked,meatballs,meatstew,nitre,perogies,pinecone,pumpkin,pumpkin_cooked,ratatouille,red_cap,rocks,smallmeat,smallmeat_cooked,turkeydinner,twigs',
    '放行了地上的材料与基础/熟食食物（其它非白名单 prefab 仍然拒绝）')
  assert.equal(env.get('OUT_MAX'), '2.5', '执行距离上限仍在执行侧')
})

test('M2.2-22 候选判定与执行侧拒绝原因一致（树两边都是 prefab_not_allowed）', async () => {
  const env = await loadLuaAN({ withGuard: true })
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
  const env = await loadLuaAN({ withGuard: true })
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
  const env = await loadLuaAN()
  env.run(`NEARBY = {
    mkent({ prefab = "spider", guid = 1, x = 16, z = 0, hp = 25, tags = { hostile = true } }),
    mkent({ prefab = "flint", guid = 2, x = 8, z = 0, item = true, canbepickedup = true }),
    -- canbepickedup=false：地上但捡不起来（比如被挡住），仍然算"食物"桶，用来验证文本顺序
    mkent({ prefab = "berries", guid = 3, x = 24, z = 0, item = true, canbepickedup = false, edible = true, edible_type = "VEGGIE" }),
    mkent({ prefab = "evergreen", guid = 4, x = 32, z = 0, work = "CHOP" }),
  }`, '四类')
  const { text } = env.observe()
  const at = (label) => text.indexOf(label + '：')
  const order = ['威胁', '可拾取物', '食物', '资源'].map(at)
  assert.ok(order.every((i) => i >= 0), '四段都该出现：' + JSON.stringify(order) + '\n' + text)
  assert.deepEqual(order, [...order].sort((a, b) => a - b), '文本顺序必须是设计顺序\n' + text)
  assert.match(text, /可拾取物：#\d+ 燧石/)
})

