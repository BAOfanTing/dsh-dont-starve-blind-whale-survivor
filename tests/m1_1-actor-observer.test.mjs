// M1.1：Actor Provider + 统一 get_state 的测试
//
// 分两类，别混：
//   【Lua/沙箱】用 fengari 真跑模组源码 —— 证明"读字段/挑人/缺字段处理"这些逻辑对；
//               但它**不能**证明游戏里的 API 真的这样返回（那是真机测试的事）。
//   【Node】真读文件 + 真跑归一化/工具分发 —— 证明 F8 与 MCP 拿到的是同一份快照。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Ajv from 'ajv'

import { GameBridge, withKleiHeader } from '../lib/bridge.js'
import { executeTool, readSnapshot } from '../lib/tools.js'
import {
  normalizeState,
  freshnessLine,
  renderFallbackText,
  toJsonPayload,
  STALE_MS,
  STATE_SCHEMA,
} from '../lib/state/snapshot.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

// ─────────────────────────── Lua 沙箱 ───────────────────────────

const STUB = `
GLOBAL = {}

GLOBAL.STRINGS = { NAMES = { WARLY = "沃利", SPIDER = "蜘蛛", EVERGREEN = "常青树", LOG = "木头", AXE = "斧头", TORCH = "火把" },
                   CHARACTER_NAMES = { WARLY = "沃利" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
local function act(id) return { id = id } end
GLOBAL.ACTIONS = { CHOP = act("CHOP"), MINE = act("MINE"), DIG = act("DIG"), HAMMER = act("HAMMER"),
                   PICK = act("PICK"), PICKUP = act("PICKUP"), HARVEST = act("HARVEST"), ATTACK = act("ATTACK"),
                   EAT = act("EAT"), COOK = act("COOK"), SLEEPIN = act("SLEEPIN"), DROP = act("DROP"),
                   ADDFUEL = act("ADDFUEL"), HEAL = act("HEAL") }
GLOBAL.Vector3 = function(x, y, z) return { x = x, y = y, z = z } end
GLOBAL.BufferedAction = function(doer, target, action, invobject, pos)
    return { doer = doer, target = target, action = action, invobject = invobject, pos = pos }
end
GLOBAL.TheNet = {
    GetSessionIdentifier = function() return SESSION end,
    GetUserID = function() return "KU_test" end,
}
GLOBAL.TheShard = { GetShardId = function() return SHARD end }
GLOBAL.TheSim = {
    GetTime = function() return NOW end,
    GetRealTime = function() return NOW * 1000 end,
    FindEntities = function() return {} end,
    SetPersistentString = function() end,
    GetPersistentString = function() end,
}

NOW = 100
SESSION = "sess-1"
SHARD = "Master"
ALL = {}
WORLD = { HasTag = function(self, tag) return false end,
          state = { cycles = 4, phase = "dusk", season = "autumn", temperature = 12 } }
GLOBAL.AllPlayers = ALL
GLOBAL.TheWorld = WORLD

-- 换一批玩家（测试里用：直接给 GLOBAL.AllPlayers 换表）
function set_players(list)
    ALL = list
    GLOBAL.AllPlayers = list
end

-- 造一个假玩家
function mkplayer(opts)
    opts = opts or {}
    local p = {
        prefab = opts.prefab or "warly",
        name = opts.name,
        GUID = opts.guid or 1001,
        userid = opts.userid,
        valid = opts.valid ~= false,
        ghost = opts.ghost == true,
        tags = opts.tags or { player = true },
        components = {},
        Transform = { GetWorldPosition = function() return opts.x or 48, 0, opts.z or 180 end },
    }
    p.IsValid = function(self) return self.valid end
    p.HasTag = function(self, tag)
        if tag == "playerghost" then return self.ghost end
        if tag == "INLIMBO" then return false end
        return self.tags ~= nil and self.tags[tag] == true
    end
    p.components.health = { currenthealth = opts.hp or 150, maxhealth = opts.maxhp or 150,
                            IsDead = function(self) return (self.currenthealth or 0) <= 0 end }
    if opts.inventory ~= false then
        p.components.inventory = {
            GetNumSlots = function() return 15 end,
            GetItemInSlot = function(_, slot) return nil end,
            GetEquippedItem = function(_, slot) return nil end,
        }
    end
    if opts.hunger ~= false then
        p.components.hunger = { current = opts.hunger or 120, max = 150 }
    end
    if opts.sanity ~= false then
        p.components.sanity = { current = opts.sanity or 180, max = 200 }
    end
    if opts.temperature ~= false then
        p.components.temperature = { GetCurrent = function() return opts.temp or 12 end }
    end
    if opts.moisture == true then
        p.components.moisture = { GetMoisture = function() return 0 end }
    end
    return p
end

GLOBAL.setmetatable = setmetatable
GLOBAL.getmetatable = getmetatable
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.os = { time = function() return 1700000000 end }
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

function loadLua(fengari, { modules = ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'observe'] } = {}) {
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
  run(`Whale = { verbose = false, version = "0.11.0" }`, 'Whale 表')
  run(FILES, '文件名表')
  for (const name of modules) {
    run(readFileSync(join(MOD, 'scripts', 'whale', `${name}.lua`), 'utf8'), `${name}.lua`)
  }
  const get = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try {
      return to_jsstring(lua.lua_tostring(L, -1))
    } catch {
      return ''
    }
  }
  return { run, get, L, fengari, fail }
}

// ─────────────────────────── Lua：Actor Provider ───────────────────────────

test('M1.1-1 正常获取 Actor：有 userid 的玩家 → 稳定 actor_id', async () => {
  const env = loadLua(await import('fengari'))
  env.run(`
    set_players({ mkplayer({ x = 48, z = 180, userid = "KU_abc" }) })
    local actor, why = Whale.actor.get_actor()
    assert(actor ~= nil, "应该挑到一个玩家：" .. tostring(why))
    local info = Whale.actor.get_actor_info(actor)
    assert(info.actor_type == "player", "类型应该是 player")
    assert(info.actor_id == "player:KU_abc", "actor_id 应该稳定：" .. tostring(info.actor_id))
    assert(info.actor_id_kind == "stable", "有 userid 时不该是 transient")
    assert(info.prefab == "warly" and info.name == "沃利", "prefab/名字不对")
    assert(info.tile_x == 12 and info.tile_z == 45, "格子坐标不对：" .. tostring(info.tile_x) .. "," .. tostring(info.tile_z))
    assert(info.alive == true and info.valid == true, "应该是活着且有效")
    OUT = info.actor_id
  `, '获取 actor')
  assert.equal(env.get('OUT'), 'player:KU_abc')
})

test('M1.1-2 Actor 不存在：没有玩家 → (nil, no_player)，快照 status=no_actor', async () => {
  const env = loadLua(await import('fengari'))
  env.run(`
    set_players({})
    local actor, why = Whale.actor.get_actor()
    assert(actor == nil, "不该挑到人")
    assert(why == "no_player", "原因应该是 no_player，实际：" .. tostring(why))
    local text, data = Whale.observe.Build(nil)
    assert(data.observer.status == "no_actor", "快照状态应该是 no_actor，实际：" .. tostring(data.observer.status))
    assert(data.actor == nil, "没有 actor 时 actor 必须为 nil（不能编）")
    assert(#data.observer.errors >= 1, "要说明为什么没有观察对象")
    OUT = text
  `, '没有玩家')
  assert.match(env.get('OUT'), /没有可观察的角色/)
})

test('M1.1-3 Actor 已失效：IsValid=false 的不算观察对象', async () => {
  const env = loadLua(await import('fengari'))
  env.run(`
    local dead_entity = mkplayer({ valid = false })
    local ok, why = Whale.actor.is_valid(dead_entity)
    assert(ok == false, "IsValid=false 应该是无效")
    assert(why == "invalid", "原因应该是 invalid，实际：" .. tostring(why))
    ALL = { dead_entity }
    local actor, reason = Whale.actor.get_actor()
    assert(actor == nil, "失效实体不该被挑中")
    assert(reason == "no_player", "原因：" .. tostring(reason))
    local info = Whale.actor.get_actor_info(dead_entity)
    assert(info == nil, "失效实体不该给出 info")
    OUT = "ok"
  `, '失效实体')
  assert.equal(env.get('OUT'), 'ok')
})

test('M1.1-4 Actor 死亡：仍然可观察，但 alive=false / dead=true', async () => {
  const env = loadLua(await import('fengari'))
  env.run(`
    set_players({ mkplayer({ hp = 0 }) })
    local actor = Whale.actor.get_actor()
    local info = Whale.actor.get_actor_info(actor)
    assert(info.valid == true, "死的实体仍然是有效实体（否则看不到死没死）")
    assert(info.alive == false, "alive 应该是 false")
    local text, data = Whale.observe.Build(actor)
    assert(data.actor.alive == false and data.dead == true, "data.dead 应该是 true")
    assert(data.observer.status == "ok", "死亡不该让快照变成 error")
    OUT = text
  `, '死亡')
  assert.match(env.get('OUT'), /你已经死了/)
})

test('M1.1-5 组件缺失：没有 hunger/sanity → 记进 unavailable，不填 0', async () => {
  const env = loadLua(await import('fengari'))
  env.run(`
    set_players({ mkplayer({ hunger = false, sanity = false }) })
    local actor = Whale.actor.get_actor()
    local info = Whale.actor.get_actor_info(actor)
    assert(#info.missing_components == 0, "hunger/sanity 不是必需组件，不该算 missing：" .. table.concat(info.missing_components, ","))
    local text, data = Whale.observe.Build(actor)
    assert(data.player.hunger == nil, "读不到就该是 nil，不能是 0")
    assert(data.player.sanity == nil, "同上")
    local joined = table.concat(data.observer.unavailable_fields, ",")
    assert(string.find(joined, "player.hunger", 1, true) ~= nil, "要记 player.hunger：" .. joined)
    assert(string.find(joined, "player.sanity", 1, true) ~= nil, "要记 player.sanity：" .. joined)
    OUT = joined
  `, '组件缺失')
  assert.match(env.get('OUT'), /player\.hunger/)
})

test('M1.1-6 必需组件缺失：没有 inventory → 明确报出来', async () => {
  const env = loadLua(await import('fengari'))
  env.run(`
    local p = mkplayer({ inventory = false })
    local missing = Whale.actor.missing_components(p)
    assert(#missing == 1 and missing[1] == "inventory", "应该报缺 inventory")
    ALL = { p }
    local text, data = Whale.observe.Build(p)
    assert(data.player.inventory == nil, "没有背包组件就没有 inventory")
    local joined = table.concat(data.observer.unavailable_fields, ",")
    assert(string.find(joined, "actor.component.inventory", 1, true) ~= nil, "要记 actor.component.inventory：" .. joined)
    OUT = "ok"
  `, '缺 inventory')
  assert.equal(env.get('OUT'), 'ok')
})

test('M1.1-7 玩家属性缺失：没有 temperature/moisture → unavailable', async () => {
  const env = loadLua(await import('fengari'))
  env.run(`
    set_players({ mkplayer({ temperature = false, moisture = false }) })
    local actor = Whale.actor.get_actor()
    local text, data = Whale.observe.Build(actor)
    assert(data.player.temperature == nil and data.player.wetness == nil, "读不到就该缺字段")
    local joined = table.concat(data.observer.unavailable_fields, ",")
    assert(string.find(joined, "player.temperature", 1, true) ~= nil, joined)
    assert(string.find(joined, "player.wetness", 1, true) ~= nil, joined)
    OUT = joined
  `, '属性缺失')
  assert.match(env.get('OUT'), /player\.wetness/)
})

test('M1.1-8 背包为空 + 装备为空：文本说"空""空手"，数据 used=0', async () => {
  const env = loadLua(await import('fengari'))
  env.run(`
    set_players({ mkplayer({}) })
    local actor = Whale.actor.get_actor()
    local text, data = Whale.observe.Build(actor)
    assert(data.player.inventory.used == 0, "空背包 used 应该是 0")
    assert(data.player.inventory.is_full == false, "空背包不该是满的")
    assert(#data.player.inventory.items == 0, "不该有物品")
    assert(data.player.equipment.slots.hands == nil, "手上应该是空的")
    assert(#data.player.equipment.worn == 0, "不该有穿戴")
    OUT = text
  `, '空背包')
  assert.match(env.get('OUT'), /背包（0\/15 格）：空/)
  assert.match(env.get('OUT'), /手持：空手/)
})

test('M1.1-9 世界状态不可用：TheWorld 没了 → world.status=unavailable', async () => {
  const env = loadLua(await import('fengari'))
  env.run(`
    set_players({ mkplayer({}) })
    GLOBAL.TheWorld = nil
    local actor = Whale.actor.get_actor()
    local text, data = Whale.observe.Build(actor)
    assert(data.world.status == "unavailable", "世界读不到要标 unavailable，实际：" .. tostring(data.world.status))
    assert(data.world.day == nil, "读不到就不该有 day")
    local joined = table.concat(data.observer.unavailable_fields, ",")
    assert(string.find(joined, "world", 1, true) ~= nil, joined)
    GLOBAL.TheWorld = WORLD
    OUT = "ok"
  `, '世界不可用')
  assert.equal(env.get('OUT'), 'ok')
})

test('M1.1-10 身份：session / shard 各自独立，cluster 读不到就显式标 unavailable', async () => {
  const env = loadLua(await import('fengari'))
  env.run(`
    SESSION = "sess-AAA"
    SHARD = "Caves"
    Whale.actor.reset()
    local id = Whale.actor.get_identity(100)
    assert(id.session_id == "sess-AAA", "session 不对：" .. tostring(id.session_id))
    assert(id.shard_id == "Caves", "shard 不对：" .. tostring(id.shard_id))
    assert(id.cluster_id == nil, "没有 GetClusterID 时 cluster_id 必须是 nil（不能拿 session 冒充）")
    assert(id.cluster_id_source == "unavailable", "来源要标 unavailable，实际：" .. tostring(id.cluster_id_source))

    -- 有 GetClusterID 的构建里应该用上它
    GLOBAL.TheNet.GetClusterID = function() return "Cluster_9" end
    Whale.actor.reset()
    local id2 = Whale.actor.get_identity(200)
    assert(id2.cluster_id == "Cluster_9", "应该取到集群 ID")
    assert(id2.cluster_id_source == "the_net", "来源应该是 the_net")
    GLOBAL.TheNet.GetClusterID = nil
    OUT = id2.shard_id .. "|" .. id2.cluster_id
  `, '身份')
  assert.equal(env.get('OUT'), 'Caves|Cluster_9')
})

test('M1.1-11 Session 变化：缓存过期后会换成新的 session', async () => {
  const env = loadLua(await import('fengari'))
  env.run(`
    SESSION = "sess-1"
    Whale.actor.reset()
    local first = Whale.actor.get_identity(1000)
    assert(first.session_id == "sess-1", "第一次应该是 sess-1")

    SESSION = "sess-2"
    local cached = Whale.actor.get_identity(1010)   -- 10 秒后：还在 60 秒缓存里
    assert(cached.session_id == "sess-1", "缓存期内应该还是旧值（省开销）")

    local refreshed = Whale.actor.get_identity(1100) -- 100 秒后：过期
    assert(refreshed.session_id == "sess-2", "缓存过期后必须换成新的，实际：" .. tostring(refreshed.session_id))
    OUT = refreshed.session_id
  `, 'session 变化')
  assert.equal(env.get('OUT'), 'sess-2')
})

test('M1.1-12 配置绑定：OBSERVER_SCAN_RADIUS 真的影响扫描半径，且越界会被夹住', async () => {
  const env = loadLua(await import('fengari'))
  env.run(`
    local values = Whale.config.build(function(key)
        if key == "scan_radius" then return 99 end      -- 越界
        if key == "observe_interval" then return "abc" end -- 不是数字
        return nil
    end)
    assert(values.scan_radius == 40, "99 应该被夹到 40，实际 " .. tostring(values.scan_radius))
    assert(values.observe_interval == 2, "不是数字应该用默认 2，实际 " .. tostring(values.observe_interval))

    set_players({ mkplayer({}) })
    local actor = Whale.actor.get_actor()
    local text, data = Whale.observe.Build(actor)
    assert(data.nearby.radius == 40, "扫描半径应该来自配置，实际：" .. tostring(data.nearby.radius))
    -- OBSERVATION-01：默认扫描缓存从 4 秒降到 1 秒（快照要跟得上模型的思考时间）
    assert(data.nearby.scan_seconds == 1, "扫描间隔应该是默认 1，实际：" .. tostring(data.nearby.scan_seconds))
    OUT = tostring(data.nearby.radius)
  `, '配置绑定')
  assert.equal(env.get('OUT'), '40')
})

// ─────────────────────────── Node：统一快照 ───────────────────────────

function makeCtx(dir) {
  const bridge = new GameBridge({ bridgeDir: dir, lockDir: true, pollMs: 5 })
  return { bridge, log: () => {} }
}

function writeState(dir, payload) {
  writeFileSync(join(dir, 'whale_state.json'), withKleiHeader(JSON.stringify(payload)), 'utf8')
}

function newPayload(overrides = {}) {
  return {
    v: 1,
    seq: 7,
    t: 1794493552,
    mod: '0.11.0',
    ready: true,
    text: '# 快照 s7 · 第5天 · 黄昏 · 秋季 · 12° · 状态 ok\n你：沃利  生命 80/150\n位置：(12,45)',
    data: {
      schema: STATE_SCHEMA,
      identity: { session_id: 'sess-1', cluster_id: null, cluster_id_source: 'unavailable', shard_id: 'Master' },
      actor: {
        actor_id: 'player:KU_abc', actor_id_kind: 'stable', actor_type: 'player',
        prefab: 'warly', name: '沃利', valid: true, alive: true, is_ghost: false,
        missing_components: [], tile_x: 12, tile_z: 45, x: 48, y: 0, z: 180,
      },
      player: {
        health: { current: 80, max: 150, percent: 53 },
        hunger: { current: 120, max: 150, percent: 80 },
        sanity: { current: 180, max: 200, percent: 90 },
        temperature: { value: 12 },
        equipment: { slots: { hands: null, head: null, body: null }, worn: [] },
        inventory: { slots: 15, used: 0, is_full: false, items: [] },
      },
      world: { day: 5, season: 'autumn', season_name: '秋季', phase: 'dusk', phase_name: '黄昏', weather: {}, is_cave: false },
      warnings: [],
      nearby: { status: 'legacy', radius: 16, buckets: [] },
      observer: {
        snapshot_id: 's7', sequence: 7, timestamp: 1794493552, sampled_at: 1794493552,
        sample_age_ms: 0, reused: false, status: 'ok', errors: [], unavailable_fields: [],
      },
      players: 1, tick: 35, mastersim: true,
    },
    ...overrides,
  }
}

test('M1.1-13 JSON Schema：快照数据结构合法（字段齐全、类型正确）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-m11-schema-'))
  try {
    writeState(dir, newPayload())
    const ctx = makeCtx(dir)
    const snapshot = readSnapshot(ctx)
    const payload = toJsonPayload(snapshot)

    const schema = {
      type: 'object',
      required: ['ok', 'schema', 'status', 'snapshot_id', 'sequence', 'identity', 'actor', 'player', 'world', 'observer'],
      properties: {
        ok: { type: 'boolean' },
        schema: { const: STATE_SCHEMA },
        status: { type: 'string' },
        snapshot_id: { type: 'string' },
        sequence: { type: 'number' },
        identity: {
          type: 'object',
          required: ['session_id', 'cluster_id', 'cluster_id_source', 'shard_id'],
          properties: {
            session_id: { type: ['string', 'null'] },
            cluster_id: { type: ['string', 'null'] },
            cluster_id_source: { type: 'string' },
            shard_id: { type: ['string', 'null'] },
          },
        },
        actor: {
          type: 'object',
          required: ['actor_id', 'actor_id_kind', 'actor_type', 'valid', 'alive'],
          properties: {
            actor_id: { type: ['string', 'null'] },
            actor_id_kind: { enum: ['stable', 'transient', 'unknown'] },
            actor_type: { type: 'string' },
            valid: { type: 'boolean' },
            alive: { type: 'boolean' },
          },
        },
        player: {
          type: 'object',
          properties: {
            health: { type: ['object', 'null'] },
            inventory: {
              type: 'object',
              required: ['slots', 'used'],
              properties: { slots: { type: 'number' }, used: { type: 'number' } },
            },
          },
        },
        world: { type: 'object', properties: { day: { type: ['number', 'null'] } } },
        observer: {
          type: 'object',
          required: ['status', 'errors', 'unavailable_fields'],
          properties: {
            status: { type: 'string' },
            age_ms: { type: ['number', 'null'] },
            errors: { type: 'array' },
            unavailable_fields: { type: 'array' },
          },
        },
      },
    }
    const ajv = new Ajv({ strict: false })
    const validate = ajv.compile(schema)
    const ok = validate(payload)
    assert.ok(ok, 'JSON 不符合 schema：' + JSON.stringify(validate.errors, null, 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M1.1-14 快照过期：文件 20 秒没写 → stale，并在文本前提示', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-m11-stale-'))
  try {
    writeState(dir, newPayload())
    const ctx = makeCtx(dir)
    const fresh = normalizeState(JSON.parse(readFileSync(join(dir, 'whale_state.json'), 'utf8').replace(/^KLEI\s+\d+\s*/, '')), {
      ageMs: 500,
    })
    assert.equal(fresh.stale, false, '0.5 秒前写过不该算过期')

    const stale = normalizeState(JSON.parse(readFileSync(join(dir, 'whale_state.json'), 'utf8').replace(/^KLEI\s+\d+\s*/, '')), {
      ageMs: STALE_MS + 5000,
    })
    assert.equal(stale.stale, true, '20 秒前写过应该算过期')
    assert.match(freshnessLine(stale), /暂停|过期/)

    // get_state 文本里也要体现（F8 和 MCP 都会看到同一句）。
    // M1.2：以前这里靠"文件 0 秒前写过"这句噪音碰巧通过；现在新鲜文件不啰嗦了，
    // 所以把文件 mtime 真的往回拨 20 秒，走真实读取路径验证过期提示。
    const statePath = join(dir, 'whale_state.json')
    const past = new Date(Date.now() - (STALE_MS + 5000))
    utimesSync(statePath, past, past)
    const text = await executeTool('get_state', {}, ctx)
    assert.match(text, /状态已经 (\d+ 秒没更新|过期)/, '过期文件必须提示：' + text)
    assert.match(text, /秒前写过/, '过期时要说明多久没更新：' + text)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M1.1-15 双分片：Master 与 Caves 的 identity 各自独立，命令只发给有玩家的那片', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bws-m11-shard-'))
  try {
    const master = join(root, 'Master', 'save')
    const caves = join(root, 'Caves', 'save')
    mkdirSync(master, { recursive: true })
    mkdirSync(caves, { recursive: true })

    const base = newPayload()
    const masterPayload = JSON.parse(JSON.stringify(base))
    const cavesPayload = JSON.parse(JSON.stringify(base))
    cavesPayload.data.identity.shard_id = 'Caves'
    cavesPayload.data.players = 0
    cavesPayload.data.ready = false
    cavesPayload.ready = false

    writeState(master, masterPayload)
    writeState(caves, cavesPayload)

    const bridge = new GameBridge({ bridgeDir: master, lockDir: true, pollMs: 5 })
    // 故意把洞穴那份排在前面，逼实现按「里面有没有人」判断，而不是按扫描顺序
    bridge.locate = () => [
      { dir: caves, channel: 'persist' },
      { dir: master, channel: 'persist' },
    ]

    const state = bridge.readState()
    assert.ok(state, '应该读到状态')
    const snapshot = normalizeState(state.json, { ageMs: state.ageMs, path: state.path })
    assert.equal(state.dir, master, '有玩家、ready 的那片应该赢')
    assert.equal(snapshot.identity.shardId, 'Master')
    assert.equal(snapshot.players, 1)

    // Caves 那份的 shard 字段本身是对的（不是被改写，而是各自独立）
    const cavesRaw = JSON.parse(readFileSync(join(caves, 'whale_state.json'), 'utf8').replace(/^KLEI\s+\d+\s*/, ''))
    assert.equal(cavesRaw.data.identity.shard_id, 'Caves')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('M1.1-16 F8 与 MCP 读到同一份快照：两个入口返回完全一致的文本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-m11-same-'))
  try {
    writeState(dir, newPayload())
    const ctx = makeCtx(dir)

    // MCP 那条路：mcp-server.js 的 tools/call → executeTool
    const viaMcp = await executeTool('get_state', {}, ctx)
    // F8 那条路：lib/agent.js 的 callTool → 同一个 executeTool
    const callTool = (name, args) => executeTool(name, args, ctx)
    const viaAgent = await callTool('get_state', {})

    assert.equal(viaMcp, viaAgent, 'F8 和 MCP 必须拿到同一份快照')

    // 两者都来自同一个 readSnapshot()（没有第二份拼接逻辑）
    const snapshot = readSnapshot(ctx)
    assert.equal(snapshot.snapshotId, 's7')
    assert.ok(viaMcp.includes(snapshot.text.split('\n')[0]), '返回的文本里应该有 Lua 渲染的快照头')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M1.1-17 老格式文件仍能读：没有 data.schema 时用 legacy 文本并标注', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-m11-legacy-'))
  try {
    writeState(dir, { v: 1, seq: 3, t: 1794493000, mod: '0.10.0', ready: true, text: '# 旧格式状态\n你：沃利' })
    const ctx = makeCtx(dir)
    const snapshot = readSnapshot(ctx)
    assert.equal(snapshot.schema, 'legacy')
    assert.equal(snapshot.textSource, 'legacy')
    assert.ok(snapshot.errors.some((line) => line.includes('老格式')), '要明确标出这是老格式')
    const text = await executeTool('get_state', {}, ctx)
    assert.match(text, /旧格式状态/, '老文本要原样给模型')
    assert.match(renderFallbackText(snapshot), /现在没有可观察的角色/, '没有 actor 时兜底文本要说明')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M1.1-18 get_state format=json：返回结构化数据而不是文本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-m11-json-'))
  try {
    writeState(dir, newPayload())
    const ctx = makeCtx(dir)
    const raw = await executeTool('get_state', { format: 'json' }, ctx)
    const parsed = JSON.parse(raw)
    assert.equal(parsed.schema, STATE_SCHEMA)
    assert.equal(parsed.actor.actor_id, 'player:KU_abc')
    assert.equal(parsed.player.health.current, 80)
    assert.equal(parsed.world.day, 5)
    assert.equal(parsed.identity.shard_id, 'Master')
    assert.equal(parsed.observer.sequence, 7)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M1.1-19 归档的 A 栈没有被重新加载（运行链干净）', () => {
  const modmain = readFileSync(join(MOD, 'modmain.lua'), 'utf8')
  const imports = [...modmain.matchAll(/^\s*modimport\(\s*"([^"]+)"\s*\)/gm)].map((m) => m[1])
  assert.ok(imports.length > 0, 'modmain 应该还有 modimport')
  for (const name of imports) {
    assert.ok(!name.startsWith('scripts/main/'), 'A 栈模块又进了运行链：' + name)
  }
  assert.ok(!imports.includes('bws_config.lua'), 'bws_config.lua 不该加载')
  assert.equal(existsSync(join(MOD, 'scripts', 'main')), false, 'scripts/main 应该已经归档（不在模组目录里）')
  assert.equal(existsSync(join(ROOT, 'archive', 'phase-a', 'scripts', 'main')), true, '归档目录应该存在')

  // 观察器不许自己去找玩家：只允许通过 Whale.actor 拿
  const observe = readFileSync(join(MOD, 'scripts', 'whale', 'observe.lua'), 'utf8')
  assert.ok(!/ThePlayer/.test(observe), 'observe.lua 里不许出现 ThePlayer')
  assert.ok(!/AllPlayers/.test(observe), 'observe.lua 里不许自己遍历 AllPlayers（那是 Actor Provider 的事）')
})
