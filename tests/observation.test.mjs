// 统一状态观察与快照测试（包含 Actor Provider、快照归一化、快照 ID 渲染、观察节流与参数归一化）
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
import { executeTool, readSnapshot, TOOLS } from '../lib/tools.js'
import { AiRunner } from '../lib/agent.js'
import { createDispatcher, ACTION_SPECS, normalizeArgs, validateArgs } from '../lib/dispatcher.js'
import { nearbyLines } from '../lib/state/snapshot.js'
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
  // SURVIVAL-07：归档的 A 栈代码已**彻底删除**（GitHub 有历史，需要时 git checkout 找回）。
  // 这条断言从"归档目录还在"改成"归档目录已经不在" —— 意图没变（证明 A 栈不在运行链里），
  // 而且更强：现在连"某处误加载归档代码"都不可能发生了。
  assert.equal(existsSync(join(ROOT, 'archive', 'phase-a')), false, 'A 栈归档目录应该已经彻底删除')

  // 观察器不许自己去找玩家：只允许通过 Whale.actor 拿
  const observe = readFileSync(join(MOD, 'scripts', 'whale', 'observe.lua'), 'utf8')
  assert.ok(!/ThePlayer/.test(observe), 'observe.lua 里不许出现 ThePlayer')
  assert.ok(!/AllPlayers/.test(observe), 'observe.lua 里不许自己遍历 AllPlayers（那是 Actor Provider 的事）')
})


// ─────────────────────────── 回归测试与文本修整 ───────────────────────────
// M1.2 回归测试：真机冒烟过程中发现的两个「只影响文案」的小问题
//
// 1) 附近实体为空时，文本会误报「附近：暂时读不到（legacy）」——
//    status=legacy 只是说明"这套还是旧扫描"，不是故障；空就是"没什么值得注意的"。
// 2) 状态文件刚写出来（<2 秒）时，开头会多一句「文件 0 秒前写过」，属于噪音。
//
// 两个都在 tools/m12-roundtrip.mjs 的管线自检里暴露，修完在这里钉住。



const STUB_REG = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利", SPIDER = "蜘蛛" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.ACTIONS = {}
GLOBAL.TheNet = { GetSessionIdentifier = function() return "sess-x" end }
GLOBAL.TheShard = { GetShardId = function() return "Master" end }
GLOBAL.TheSim = { GetTime = function() return 100 end, GetRealTime = function() return 100000 end,
                  FindEntities = function() return {} end }
NOW = 100
local player = { prefab = "warly", GUID = 7, userid = "", components = {}, tags = { player = true },
                 Transform = { GetWorldPosition = function() return 48, 0, 180 end } }
player.IsValid = function() return true end
player.HasTag = function(_, tag) if tag == "playerghost" or tag == "INLIMBO" then return false end return player.tags[tag] == true end
player.components.health = { currenthealth = 100, maxhealth = 150, IsDead = function() return false end }
player.components.inventory = {
    GetNumSlots = function() return 15 end,
    GetItemInSlot = function() return nil end,
    GetEquippedItem = function() return nil end,
}
GLOBAL.AllPlayers = { player }
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

async function loadRegLua() {
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
  run(STUB_REG, '假游戏')
  run('Whale = { verbose = false, version = "0.12.0" }', 'Whale')
  for (const name of ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'observe']) {
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
  return { run, get }
}

test('M1.2-回归1 附近为空（legacy 且无桶）→ 说"没什么值得注意的"，不能说"读不到"', async () => {
  const env = await loadRegLua()
  env.run(`
    local actor = Whale.actor.get_actor()
    local text, data = Whale.observe.Build(actor)
    assert(data.nearby.status == "empty", "空扫描要标 empty（不是 error），实际：" .. tostring(data.nearby.status))
    assert(data.nearby.total_returned == 0, "这里应该没有实体")
    assert(data.nearby.delta.status == "baseline", "第一次扫描的 delta 应该是 baseline")
    OUT = text
  `, '附近为空')
  const text = env.get('OUT')
  assert.match(text, /没什么值得注意的/, '应该说没什么东西：\n' + text)
  assert.doesNotMatch(text, /暂时读不到/, 'legacy 不是故障，不能说读不到：\n' + text)
})

test('M1.2-回归2 扫描出错（status=error）才说"读不到"', async () => {
  const env = await loadRegLua()
  env.run(`
    local actor = Whale.actor.get_actor()
    local text, data = Whale.observe.Build(actor)
    -- 直接把 nearby 换成出错形态，验证渲染分支
    data.nearby = { status = "error", radius = 16, scan_seconds = 4, error = "find_entities_failed" }
    OUT = Whale.observe.Render(data)
  `, '扫描出错')
  assert.match(env.get('OUT'), /暂时读不到（扫描出错/)
})

test('M1.2-回归3 文件刚写完（<2 秒）时不再啰嗦"文件 0 秒前写过"', () => {
  const raw = {
    v: 1,
    seq: 1,
    t: 1,
    mod: '0.12.1',
    ready: true,
    text: '# 快照 s1 · 第1天 · 白天 · 秋季 · 20° · 状态 ok\n你：沃利',
    data: {
      schema: STATE_SCHEMA,
      identity: { session_id: 's', cluster_id: null, cluster_id_source: 'unavailable', shard_id: 'Master' },
      actor: { actor_id: 'entity:warly:7', actor_id_kind: 'transient', actor_type: 'player', prefab: 'warly',
               name: '沃利', valid: true, alive: true, is_ghost: false, missing_components: [], tile_x: 12, tile_z: 45 },
      player: {},
      world: { day: 1, phase: 'day', season: 'autumn' },
      warnings: [],
      nearby: { status: 'legacy', radius: 16, buckets: [] },
      observer: { snapshot_id: 's1', sequence: 1, timestamp: 1, sampled_at: 1, sample_age_ms: 0,
                  reused: false, status: 'ok', errors: [], unavailable_fields: [] },
    },
  }
  const fresh = normalizeState(raw, { ageMs: 300 })
  assert.equal(fresh.stale, false)
  assert.equal(freshnessLine(fresh), '', '刚写完不该有任何前缀')

  const old = normalizeState(raw, { ageMs: 8000 })
  assert.match(freshnessLine(old), /8 秒前写过/, '过了 2 秒还是要提示')
})


// ─────────────────────────── 快照 ID 可见性 ───────────────────────────
// M2.2.2 / P1：Nearby 快照 ID 的可见性
//
// 背景（AGENT-01 真机抓到）：get_state 文本第一行是「状态快照序列号 s1650」，
// 而 pickup/harvest 要的是 nearby 的扫描 id（r…-n365）。文本里从来只出现前者，
// 于是真实模型照抄 s1650 → 必然 stale_snapshot。
//
// 这些测试从**真实构造的 snapshot 对象**出发检查最终输出，不靠硬编码整段文本。


const SEQ_ID = 's1650'
const NEARBY_ID = 'r1794565044-5047-n365'

/** 造一份真实形状的状态文件（observer 给状态序列号，nearby 给自己的扫描 id） */
function makeState({ nearbyId = NEARBY_ID, nearbyStatus = 'ok', withItems = true } = {}) {
  return {
    ok: true,
    status: 'ok',
    seq: 1650,
    mod: '0.17.2',
    data: {
      schema: 'bws.state/1',
      identity: { session_id: 'S1', shard_id: '1' },
      observer: {
        snapshot_id: SEQ_ID, sequence: 1650, status: 'ok',
        timestamp: 1, sampled_at: 1, sample_age_ms: 0,
      },
      actor: {
        valid: true, actor_id: 'player:X', actor_type: 'player', prefab: 'wolfgang',
        name: '沃尔夫冈', alive: true, is_ghost: false,
        tile_x: -22, tile_z: 32, x: -88, y: 0, z: 128,
      },
      player: {
        inventory: { used: 0, items: {}, slots: 15, is_full: false },
        health: { current: 150, max: 200, percent: 75 },
        hunger: { current: 100, max: 200, percent: 50 },
        sanity: { current: 120, max: 200, percent: 60 },
      },
      world: { day: 3, phase: 'day', phase_name: '白天', season_name: '秋季', status: 'ok', world_temperature: 22 },
      nearby: {
        status: nearbyStatus,
        snapshot_id: nearbyStatus === 'error' ? undefined : nearbyId,
        radius: 16,
        max_total: 60,
        max_per_bucket: 12,
        total_found: withItems ? 3 : 0,
        total_returned: withItems ? 3 : 0,
        truncated: false,
        scan: { reused: false, age_ms: 0 },
        buckets: withItems
          ? {
              threats: [],
              pickupables: [{ ref: '#1', prefab: 'flint', label: '燧石', position: { x: -20, z: 30 }, distance: 2.1, item_kind: 'resources' }],
              harvestables: [{ ref: '#2', prefab: 'berrybush', label: '浆果丛', position: { x: -19, z: 31 }, distance: 3.4, harvest_ready: true, is_harvestable: true }],
              food: [],
              resources: [],
              containers: [],
              structures: [],
              creatures: [],
              other: [],
            }
          : {},
        delta: { status: 'ok', added: [], removed: [], changed: [] },
      },
    },
  }
}

const render = (state) => {
  const snap = normalizeState(state, { ageMs: 0 })
  // 走产品真实路径：有 Lua 文本就用 Lua 的，没有才用 Node 兜底。
  // 这里没有 text，所以走 renderFallbackText（Node 兜底渲染）。
  return { snap, text: snap.text || renderFallbackText(snap) }
}

test('P1-1：get_state 文本里必须出现真实的 nearby.snapshot_id', () => {
  const { snap, text } = render(makeState())
  assert.equal(snap.nearby?.snapshot_id, NEARBY_ID, '归一化后应保留 nearby 的扫描 id')
  assert.ok(text.includes(NEARBY_ID), `文本里没出现 nearby.snapshot_id：\n${text}`)
})

test('P1-2：状态序列号和 Nearby 快照 ID 的标签必须明确不同', () => {
  const { text } = render(makeState())
  assert.ok(text.includes('状态快照序列号'), '应该有「状态快照序列号」这个标签')
  assert.ok(text.includes(SEQ_ID), '应该出现状态序列号本身')
  assert.ok(text.includes('Nearby 快照 ID'), '应该有「Nearby 快照 ID」这个标签')
  // 两个标签不能是同一个说法
  assert.notEqual(text.indexOf('状态快照序列号'), text.indexOf('Nearby 快照 ID'))
})

test('P1-3：#N 目标与 nearby.snapshot_id 属于同一份快照（引用行紧跟在 id 之后）', () => {
  const { snap, text } = render(makeState())
  const refs = [...(snap.nearby?.buckets?.pickupables ?? []), ...(snap.nearby?.buckets?.harvestables ?? [])].map((i) => i.ref)
  assert.deepEqual(refs.sort(), ['#1', '#2'])
  for (const ref of refs) assert.ok(text.includes(ref), `文本里应该有 ${ref}`)
  // 「以上 #N 引用属于 Nearby 快照 ID」这行必须同时点出 id，且出现在桶之后
  const marker = text.indexOf('以上 #N 引用属于 Nearby 快照 ID')
  assert.ok(marker > 0, '应该有一行说明这些 #N 属于哪份快照')
  assert.ok(text.slice(marker).includes(NEARBY_ID), '说明行里必须带 id')
  assert.ok(marker > text.indexOf('#1 '), '说明行要在引用之后')
})

test('P1-4：目标更新（新扫描）后输出新的 id，旧 id 不再出现', () => {
  const old = render(makeState({ nearbyId: 'r1-0001-n5' }))
  assert.ok(old.text.includes('r1-0001-n5'))
  const fresh = render(makeState({ nearbyId: 'r1-0001-n6' }))
  assert.ok(fresh.text.includes('r1-0001-n6'), '应该出现新 id')
  assert.ok(!fresh.text.includes('r1-0001-n5'), '不该残留旧 id')
})

test('P1-5：Nearby 不可用（error）时不输出任何历史 id', () => {
  const { text } = render(makeState({ nearbyStatus: 'error', withItems: false }))
  assert.ok(/暂时读不到/.test(text), '应该明确说读不到')
  assert.ok(!text.includes(NEARBY_ID), 'error 时绝不能回显历史 id')
  assert.ok(!/Nearby 快照 ID/.test(text), 'error 时不该出现 Nearby 快照 ID 标签')
})

test('P1-6：pickup 的 snapshot_id 说明必须点明"不是状态序列号"', () => {
  const tool = TOOLS.find((t) => t.name === 'pickup')
  assert.ok(tool, '缺 pickup 工具')
  const desc = String(tool.inputSchema?.properties?.snapshot_id?.description ?? '')
  assert.ok(desc.includes('Nearby 快照 ID'), '要说明填的是 Nearby 快照 ID')
  assert.ok(desc.includes('状态快照序列号'), '要提醒别填状态快照序列号')
  assert.ok(/stale_snapshot/.test(desc), '要说明填错的后果')
  assert.deepEqual(tool.inputSchema.required, ['target_ref', 'snapshot_id'], '必填项不变')
})

test('P1-7：harvest 的 snapshot_id 说明必须点明"不是状态序列号"', () => {
  const tool = TOOLS.find((t) => t.name === 'harvest')
  assert.ok(tool, '缺 harvest 工具')
  const desc = String(tool.inputSchema?.properties?.snapshot_id?.description ?? '')
  assert.ok(desc.includes('Nearby 快照 ID'), '要说明填的是 Nearby 快照 ID')
  assert.ok(desc.includes('状态快照序列号'), '要提醒别填状态快照序列号')
  assert.ok(/stale_snapshot/.test(desc), '要说明填错的后果')
  assert.deepEqual(tool.inputSchema.required, ['target_ref', 'snapshot_id'], '必填项不变')
})

test('P1-8：旧的状态序列号不能被当成 nearby.snapshot_id（JSON 里两个字段分开）', () => {
  const { snap } = render(makeState())
  const payload = toJsonPayload(snap)
  assert.equal(payload.snapshot_id, SEQ_ID, '顶层 snapshot_id 仍是状态序列号')
  assert.equal(payload.nearby?.snapshot_id, NEARBY_ID, 'nearby.snapshot_id 是扫描 id')
  assert.notEqual(payload.snapshot_id, payload.nearby?.snapshot_id, '两个 id 必须不同')
})

test('P1-9：nearbyLines 在无 id 时不伪造 id（防御）', () => {
  const lines = nearbyLines({
    status: 'ok', radius: 16, total_found: 1, total_returned: 1, truncated: false,
    buckets: { pickupables: [{ ref: '#1', prefab: 'flint', label: '燧石', position: { x: 0, z: 0 }, distance: 1 }] },
  })
  const joined = lines.join('\n')
  assert.ok(!/Nearby 快照 ID/.test(joined), '没有 id 就不该编一个出来')
  assert.ok(joined.includes('#1'), '但引用要照常显示')
})


// ─────────────────────────── 观察节流与执行一致性 ───────────────────────────
// OBSERVATION-01：观察节流 + 动作结果复用 + 批量中断 + JSON 合法性
//
// 这些测试跑**真实的 AiRunner / dispatcher / get_state 实现**（不 mock 关键逻辑），
// 用假的 bridge / callTool 提供可控的输入，验证行为而不是搜索 prompt 字符串。


// ── 假 bridge：一份可控的状态文件 ──
function makeBridge(over = {}) {
  const raw = {
    data: {
      schema: 'bws.state/1',
      observer: { snapshot_id: 's10', sequence: 10, status: 'ok', timestamp: 1, sampled_at: 1, sample_age_ms: 0 },
      actor: {
        valid: true, actor_id: 'player:X', actor_type: 'player', prefab: 'wolfgang', name: '沃尔夫冈',
        alive: true, is_ghost: false, tile_x: 1, tile_z: 2, x: 4, y: 0, z: 8, ...(over.actor ?? {}),
      },
      player: {
        inventory: { used: 0, items: {}, slots: 15, is_full: false, ...(over.inventory ?? {}) },
        hunger: { current: 100, max: 200, percent: 50, ...(over.hunger ?? {}) },
        health: { current: 200, max: 200, percent: 100 },
        sanity: { current: 200, max: 200, percent: 100 },
        equipment: { worn: {}, slots: {} },
      },
      world: { day: 1, phase: 'day', phase_name: '白天', season_name: '秋季', status: 'ok', world_temperature: 20 },
      nearby: {
        status: 'ok', snapshot_id: 'r1-n2', radius: 16, max_total: 60, max_per_bucket: 12,
        total_found: 1, total_returned: 1, truncated: false, scan: { reused: false, age_ms: 0 },
        buckets: { harvestables: [{ ref: '#1', prefab: 'grass', label: '草', position: { x: 1, z: 2 }, distance: 0.5, harvest_ready: true }] },
        delta: { status: 'ok', added: [], removed: [], changed: [] },
      },
      ...(over.data ?? {}),
    },
  }
  const ageMs = over.ageMs ?? 0
  return {
    raw,
    readState: () => ({ json: raw, ageMs, mtimeMs: Date.now() - ageMs, path: 'fake.json' }),
    leaseDirs: () => [],
    readLeaseAck: () => null,
    call: async () => ({ ok: true, text: '好了' }),
    status: () => ({ connected: true }),
  }
}

/** 一个能驱动 AiRunner 的假模型：按脚本返回 toolCalls；脚本用尽后返回"没有动作"让 Agent 停下 */
function makeModel(script) {
  let i = 0
  return async () => {
    if (i >= script.length) return { content: '(想完了)', toolCalls: [], rawToolCalls: [] }
    const step = script[i]
    i++
    const calls = typeof step === 'function' ? step(i) : step
    return { content: '', toolCalls: calls.map((c, k) => ({ id: `c${i}_${k}`, name: c.name, args: c.args ?? {} })), rawToolCalls: calls }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 跑一小段 AiRunner，收集每次 callTool 的名字 */
async function runAgent({ bridge, script, maxMs = 1200, callToolImpl }) {
  const calls = []
  const runner = new AiRunner({
    log: () => {},
    bridge,
    chatFn: makeModel(script),
    settings: () => ({ apiKey: 'x', baseUrl: 'http://x', model: 'm', maxTokens: 64 }),
    instructions: () => '规则',
    toolList: () => [],
    callTool: async (name, args) => {
      calls.push(name)
      if (callToolImpl) return callToolImpl(name, args)
      return name === 'get_state' ? '状态文本' : 'ok'
    },
    onStatus: () => {},
  })
  runner.start()
  // 等它自己停下（脚本用尽 → 退避 → 连续没有动作 → 自己 stop），最多等 maxMs
  const deadline = Date.now() + maxMs
  while (runner.running && Date.now() < deadline) await sleep(50)
  if (runner.running) runner.stop('test')
  await sleep(150)
  return { calls, runner, stats: runner.observeStats?.() }
}

test('OBS-1：Agent 启动时必须先读一次完整状态', async () => {
  const bridge = makeBridge()
  const { calls } = await runAgent({
    bridge,
    script: [[{ name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } }]],
    maxMs: 800,
  })
  assert.equal(calls[0], 'get_state', `第一次调用必须是 get_state，实际 ${calls[0]}`)
})

test('OBS-20：首次和失败后自动观察都保留结构化 get_state 的正文', { timeout: 3000 }, async (t) => {
  const prompts = []
  const done = Promise.withResolvers()
  let observations = 0
  const runner = new AiRunner({
    bridge: makeBridge(),
    settings: () => ({ apiKey: 'x', model: 'm' }),
    instructions: () => '规则',
    toolList: () => [],
    callTool: async (name) => name === 'get_state'
      ? { text: `真实状态正文 ${++observations}`, outcome: null }
      : { text: '失败：not_ready', outcome: { status: 'failed' } },
    chatFn: async (config, messages) => {
      prompts.push(messages.at(-1).content)
      if (prompts.length === 2) {
        runner.stop('test')
        done.resolve()
      }
      return { content: '', toolCalls: [{ id: 'g1', name: 'gather', args: {} }], rawToolCalls: [] }
    },
  })
  t.after(() => runner.stop('test cleanup'))
  runner.start()
  await done.promise
  assert.match(prompts[0], /真实状态正文 1/)
  assert.match(prompts[1], /真实状态正文 2/)
  assert.doesNotMatch(prompts.join('\n'), /\[object Object\]/)
})

test('OBS-21：模型主动观察后，背包记忆由最新快照覆盖', { timeout: 3000 }, async (t) => {
  const bridge = makeBridge({ inventory: { items: [{ prefab: 'berries', count: 5 }] } })
  const prompts = []
  const done = Promise.withResolvers()
  let observations = 0
  const runner = new AiRunner({
    bridge,
    settings: () => ({ apiKey: 'x', model: 'm' }),
    instructions: () => '规则',
    toolList: () => [],
    callTool: async () => {
      if (++observations === 2) bridge.raw.data.player.inventory.items = [{ prefab: 'carrot', count: 2 }]
      return { text: '最新背包', outcome: null }
    },
    chatFn: async (config, messages) => {
      prompts.push(messages.at(-1).content)
      if (prompts.length === 2) {
        runner.stop('test')
        done.resolve()
      }
      return { content: '', toolCalls: [{ id: 's1', name: 'get_state', args: {} }], rawToolCalls: [] }
    },
  })
  t.after(() => runner.stop('test cleanup'))
  runner.start()
  await done.promise
  assert.match(prompts[1], /已知背包（来自已核对的结果）：carrot×2/)
  assert.doesNotMatch(prompts[1], /berries×5/)
  assert.equal(observations, 2)
})

test('OBS-2：后续轮次不再无条件自动 get_state（动作成功后复用结果）', async () => {
  const bridge = makeBridge()
  // 连续三步都成功；观察窗口 10 秒 / 3 次改动，短时间内不该反复观察
  const { calls } = await runAgent({
    bridge,
    script: [
      [{ name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } }],
      [{ name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } }],
      [{ name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } }],
    ],
    maxMs: 6000,
  })
  const getStates = calls.filter((c) => c === 'get_state').length
  const actions = calls.filter((c) => c !== 'get_state').length
  assert.ok(actions >= 2, `应该至少执行 2 个动作，实际 ${actions}`)
  assert.ok(getStates <= 2, `get_state 不该每轮都来（实际 ${getStates} 次，调用序列 ${calls.join(',')}）`)
})

test('OBS-3：动作结果不确定（unknown/unverified）后必须重新观察', async () => {
  const bridge = makeBridge()
  const { calls } = await runAgent({
    bridge,
    script: [
      [{ name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } }],
      [{ name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } }],
    ],
    callToolImpl: (name) => (name === 'get_state' ? '状态文本' : '结果未知（result_timeout），先 get_state 看看'),
    maxMs: 1200,
  })
  // 第一个动作 → unknown → 下一轮必须先 get_state 再动作
  const idx = calls.indexOf('gather')
  assert.ok(idx >= 0, '应该执行过 gather')
  const after = calls.slice(idx + 1)
  assert.equal(after[0], 'get_state', `unknown 之后应该先重新观察，实际 ${JSON.stringify(after)}`)
})

test('OBS-4：状态过期（暂停/退出）时不请求模型，只等', async () => {
  const bridge = makeBridge({ ageMs: 60_000 }) // 60 秒前写的 → stale
  const { calls } = await runAgent({
    bridge,
    script: [[{ name: 'gather', args: {} }]],
    maxMs: 1200,
  })
  assert.deepEqual(calls, [], `状态过期时不该调用任何工具，实际 ${JSON.stringify(calls)}`)
})

test('OBS-5：同一响应里前一个动作失败 → 后续动作不执行，并如实告知未执行', async () => {
  const bridge = makeBridge()
  const seen = []
  const results = []
  const runner = new AiRunner({
    log: () => {},
    bridge,
    settings: () => ({ apiKey: 'x', baseUrl: 'http://x', model: 'm', maxTokens: 64 }),
    instructions: () => '规则',
    toolList: () => [],
    callTool: async (name, args) => {
      seen.push(name)
      const text = name === 'get_state' ? '状态' : (name === 'gather' ? '失败：拒绝：not_ready（not_ready）' : 'ok')
      results.push(text)
      return text
    },
    onStatus: () => {},
  })
  // 一个响应里三个动作：gather 失败 → 后面两个不该跑
  let turn = 0
  runner.chatFn = async () => {
    if (turn++ > 0) return { content: '(完)', toolCalls: [], rawToolCalls: [] }
    return {
      content: '',
      toolCalls: [
        { id: 'a', name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } },
        { id: 'b', name: 'pickup', args: { target_ref: '#2', snapshot_id: 'r1-n2' } },
        { id: 'c', name: 'craft', args: { recipe: 'axe' } },
      ],
      rawToolCalls: [],
    }
  }
  runner.start()
  {
    const deadline = Date.now() + 4000
    while (runner.running && Date.now() < deadline) await sleep(50)
    if (runner.running) runner.stop('test')
    await sleep(150)
  }
  assert.ok(seen.includes('gather'), '第一个动作应该执行')
  assert.ok(!seen.includes('pickup'), `gather 失败后 pickup 不该执行，实际 ${JSON.stringify(seen)}`)
  assert.ok(!seen.includes('craft'), `gather 失败后 craft 不该执行，实际 ${JSON.stringify(seen)}`)
})

test('OBS-6：前一个成功 → 后续动作继续执行', async () => {
  const bridge = makeBridge()
  const seen = []
  const runner = new AiRunner({
    log: () => {},
    bridge,
    settings: () => ({ apiKey: 'x', baseUrl: 'http://x', model: 'm', maxTokens: 64 }),
    instructions: () => '规则',
    toolList: () => [],
    callTool: async (name) => { seen.push(name); return name === 'get_state' ? '状态' : '采了 草（cutgrass+1）' },
    onStatus: () => {},
  })
  let turn2 = 0
  runner.chatFn = async () => {
    if (turn2++ > 0) return { content: '(完)', toolCalls: [], rawToolCalls: [] }
    return {
      content: '',
      toolCalls: [
        { id: 'a', name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } },
        { id: 'b', name: 'gather', args: { target_ref: '#2', snapshot_id: 'r1-n2' } },
      ],
      rawToolCalls: [],
    }
  }
  runner.start()
  {
    const deadline = Date.now() + 4000
    while (runner.running && Date.now() < deadline) await sleep(50)
    if (runner.running) runner.stop('test')
    await sleep(150)
  }
  assert.ok(seen.filter((n) => n === 'gather').length >= 2, `两个 gather 都该执行，实际 ${JSON.stringify(seen)}`)
})

// ── dispatcher：核对结果要带回给模型 ──

function makeDispatcher(over = {}) {
  const bridge = makeBridge(over)
  const control = {
    validate: () => ({ ok: true, lease: { owner_type: 'system', owner_instance_id: 'i', authority_epoch: 'e', generation: 1, lease_id: 'l', expires_at: Date.now() + 30000 } }),
    readAuthority: () => ({ status: 'active' }),
    completeHandover: () => ({ ok: true }),
  }
  const dispatcher = createDispatcher({
    bridge,
    control,
    readSnapshot: () => normalizeState(bridge.readState().json, { ageMs: 0 }),
    log: () => {},
    readLeaseAck: () => null,
  })
  return { bridge, dispatcher }
}

test('OBS-18：动作成功后，下一轮提示里要带"已知背包"（来自已核对结果，模型不必再观察）', async () => {
  const bridge = makeBridge()
  const prompts = []
  let turn = 0
  const runner = new AiRunner({
    log: () => {}, bridge,
    chatFn: async (cfg, messages) => {
      turn++
      prompts.push(messages[messages.length - 1]?.content ?? '')
      if (turn === 1) return { content: '', toolCalls: [{ id: 'a', name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } }], rawToolCalls: [] }
      return { content: '(完)', toolCalls: [], rawToolCalls: [] }
    },
    settings: () => ({ apiKey: 'x', baseUrl: 'http://x', model: 'm', maxTokens: 64 }),
    instructions: () => '规则', toolList: () => [],
    // 新契约：动作工具返回 { text, outcome }，背包记忆只认 outcome.verified
    callTool: async (name) => (name === 'get_state'
      ? '状态'
      : {
        text: '采了 草\n【已核对】cutgrass +1',
        outcome: { status: 'succeeded', verified: { product: 'cutgrass', gained: 1 } },
      }),
    onStatus: () => {},
  })
  runner.start()
  { const d = Date.now() + 4000; while (runner.running && Date.now() < d) await sleep(50); if (runner.running) runner.stop('t'); await sleep(150) }
  assert.ok(prompts.length >= 2, `至少两轮，实际 ${prompts.length}`)
  assert.match(prompts[1], /已知背包（来自已核对的结果）：cutgrass×1/, `第 2 轮要带已知背包，实际：${prompts[1]}`)
})

test('OBS-19：已知背包只认"已核对"的数据（失败回执不改记忆）', async () => {
  const bridge = makeBridge()
  const prompts = []
  let turn = 0
  const runner = new AiRunner({
    log: () => {}, bridge,
    chatFn: async (cfg, messages) => {
      turn++
      prompts.push(messages[messages.length - 1]?.content ?? '')
      if (turn === 1) return { content: '', toolCalls: [{ id: 'a', name: 'gather', args: { target_ref: '#1', snapshot_id: 'r1-n2' } }], rawToolCalls: [] }
      return { content: '(完)', toolCalls: [], rawToolCalls: [] }
    },
    settings: () => ({ apiKey: 'x', baseUrl: 'http://x', model: 'm', maxTokens: 64 }),
    instructions: () => '规则', toolList: () => [],
    // 失败回执：没有结构化核对结果，不该产生任何"已知背包"
    callTool: async (name) => name === 'get_state' ? '状态' : '失败：拒绝：not_ready（not_ready）',
    onStatus: () => {},
  })
  runner.start()
  { const d = Date.now() + 4000; while (runner.running && Date.now() < d) await sleep(50); if (runner.running) runner.stop('t'); await sleep(150) }
  // 失败会触发重新观察，所以提示里应该是"看状态"而不是"已知背包"
  const joined = prompts.join('\n')
  assert.ok(!/已知背包（来自已核对的结果）：cutgrass/.test(joined), '失败回执不能凭空产生背包记忆')
})

test('OBS-7：动作成功后 describe 要带上已核对的变化（不是只回一句"完成"）', async () => {
  const { dispatcher } = makeDispatcher()
  // 直接造一个 succeeded 结果走 describe
  const text = dispatcher.describe({
    status: 'succeeded',
    message: '采了 草（cutgrass+1）',
    verified: { product: 'cutgrass', gained: 1 },
  })
  assert.match(text, /cutgrass \+1/, `describe 应该写出已核对的变化，实际：${text}`)
  assert.match(text, /已核对/)
})

test('OBS-8：craft 的 describe 要写出成品与材料消耗', async () => {
  const { dispatcher } = makeDispatcher()
  const text = dispatcher.describe({ status: 'succeeded', message: '做好了 斧头（axe+1）', verified: { made: 1 } })
  assert.match(text, /成品 \+1/, `实际：${text}`)
})

test('OBS-16：craft 的核对要认"做好后自动装备"（torch 是 equippable，DoBuild 会直接拿在手里）', async () => {
  const { dispatcher } = makeDispatcher()
  const spec = dispatcher.specs.craft
  const before = { player: { inventory: { items: [{ prefab: 'cutgrass', count: 2 }, { prefab: 'twigs', count: 2 }] }, equipment: { worn: {} } } }
  const after = { player: { inventory: { items: [] }, equipment: { worn: { hands: 'torch' } } } }
  const v = spec.verify(before, after, { recipe: 'torch' })
  assert.equal(v.ok, true, '做好了并自动装备也算成功（不能只查背包）')
  assert.equal(v.how, 'auto_equipped')
  assert.equal(v.hand, 'torch')
  const text = dispatcher.describe({ status: 'succeeded', message: '做好了 火把（torch+1）', verified: v })
  assert.match(text, /已自动拿在手里/, `describe 要说明自动装备，实际：${text}`)
})

test('OBS-17：craft 什么都没发生时仍然判失败（不能因为加了自动装备就放松）', async () => {
  const { dispatcher } = makeDispatcher()
  const spec = dispatcher.specs.craft
  const before = { player: { inventory: { items: [{ prefab: 'twigs', count: 2 }] }, equipment: { worn: {} } } }
  const after = { player: { inventory: { items: [] }, equipment: { worn: {} } } } // 材料没了、成品也没有
  const v = spec.verify(before, after, { recipe: 'axe' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'craft_not_in_inventory')
})

test('OBS-14：move_to 的回执必须带"现在位置"，否则模型只能再观察一次', async () => {
  const { dispatcher } = makeDispatcher()
  const text = dispatcher.describe({
    status: 'succeeded',
    message: '走到了 (-19,33) 附近（还差 1.2 格）',
    verified: { pos: { x: -19, z: 33 }, dist: 1.2, from: { x: -22, z: 32 } },
  })
  assert.match(text, /现在位置 \(-19,33\)/, `回执要写出实际位置，实际：${text}`)
  assert.match(text, /距目标 1\.2 格/, '要写出距目标多远')
  assert.match(text, /-22,32 → -19,33/, '要写出从哪走到哪')
})

test('OBS-15：move_to 的 verify 真的会带 pos/dist（不是只在 describe 里编）', async () => {
  const { dispatcher } = makeDispatcher()
  const spec = dispatcher.specs.move_to
  const before = { actor: { tileX: -22, tileZ: 32 } }
  const after = { actor: { tileX: -19, tileZ: 33 } }
  const v = spec.verify(before, after, { x: -19, z: 33 })
  assert.equal(v.ok, true)
  assert.deepEqual(v.pos, { x: -19, z: 33 })
  assert.ok(Math.abs(v.dist - 0) < 0.01, `距离应该是 0，实际 ${v.dist}`)
  assert.deepEqual(v.from, { x: -22, z: 32 })
})

test('OBS-9：unknown 的 describe 必须明确"不要当成功"', async () => {
  const { dispatcher } = makeDispatcher()
  const text = dispatcher.describe({ status: 'unknown', reason: 'result_timeout', message: '' })
  assert.match(text, /不确定|不要当成功/, `实际：${text}`)
})

// ── JSON 输出 ──

test('OBS-10：get_state format=json 必须是纯 JSON（笔记在 notes 字段里）', async () => {
  const bridge = makeBridge()
  const ctx = {
    bridge,
    notes: { read: () => '历史笔记：上次死在 (-45,54)', write: () => {} },
    extraInstructions: '先建家',
    guides: {},
  }
  const text = await executeTool('get_state', { format: 'json' }, ctx)
  assert.ok(text.trim().startsWith('{'), `JSON 必须以 { 开头，实际开头：${text.slice(0, 40)}`)
  const parsed = JSON.parse(text) // 不能抛
  assert.equal(parsed.notes?.is_historical, true, '笔记要标成历史')
  assert.match(String(parsed.notes?.content), /上次死在/)
  assert.equal(parsed.player_instructions, '先建家')
  assert.equal(parsed.snapshot_id, 's10')
  assert.equal(parsed.nearby?.snapshot_id, 'r1-n2')
})

test('OBS-11：没有笔记时 JSON 里不该出现 notes 字段（但仍然是合法 JSON）', async () => {
  const bridge = makeBridge()
  const text = await executeTool('get_state', { format: 'json' }, { bridge, notes: { read: () => '', write: () => {} }, guides: {} })
  const parsed = JSON.parse(text)
  assert.equal(parsed.notes, undefined)
  assert.ok(parsed.ok !== undefined)
})

test('OBS-12：文本模式仍然正常（笔记在最前面、状态正文在）', async () => {
  const bridge = makeBridge()
  const text = await executeTool('get_state', {}, {
    bridge,
    notes: { read: () => '我的笔记：家在 (-22,32)', write: () => {} },
    guides: {},
  })
  assert.match(text, /我的笔记：家在/, '文本模式要显示笔记')
  assert.match(text, /状态快照序列号|快照/, '文本模式要有状态头')
  assert.ok(!text.trim().startsWith('{'), '文本模式不该是 JSON')
})

test('OBS-13：三个入口（RULES / Gateway / get_state 描述）的观察规则一致', async () => {
  const { RULES, TOOLS } = await import('../lib/tools.js')
  const gs = TOOLS.find((t) => t.name === 'get_state')
  // 三处都不能再出现"每次行动前"这种强制要求
  assert.ok(!/每次行动前先调 get_state/.test(RULES), 'RULES 不该保留旧的强制观察')
  assert.ok(!/每个动作前后都该先看这个/.test(gs.description), 'get_state 描述不该保留旧的强制观察')
  // 三处都应该表达"开始时一次 + 按需刷新"
  assert.match(RULES, /任务开始时/)
  assert.match(gs.description, /任务开始时|一次就够/)
})


// ─────────────────────────── 动作参数归一化 ───────────────────────────
// OBSERVATION-02：参数归一化
//
// 真机会话 session-403656e9 里，模型把 target_ref 传成 `15`（数字）和 `"15"`（忘了 #），
// 被硬拒成 bad_type / bad_format，白烧 3 次调用。
//
// 归一化只做**纯格式**处理（补 # 号 / 去空白），**不放宽安全**：
// 归一之后照样要过 snapshot_id 校验和 Lua 的 Resolve。


test('OBS2-6：target_ref 的数字/裸数字/带空格都能归一成 #N', () => {
  const spec = ACTION_SPECS.pickup
  for (const [input, want] of [
    [15, '#15'],
    ['15', '#15'],
    ['#15', '#15'],
    [' #15 ', '#15'],
    [15.9, '#15'],
    ['#007', '#7'],   // 去前导零，规范化
  ]) {
    const out = normalizeArgs(spec, { target_ref: input, snapshot_id: 'r1-n2' })
    assert.equal(out.target_ref, want, `${JSON.stringify(input)} 应该归一成 ${want}`)
    assert.equal(validateArgs(spec, out).ok, true, `${JSON.stringify(input)} 归一后应该通过校验`)
  }
})

test('OBS2-7：归一化不放宽安全 —— 非法值仍然被拒', () => {
  const spec = ACTION_SPECS.pickup
  for (const bad of ['abc', '#abc', -1, 0, '1; rm -rf /', 'x'.repeat(40), '#12x']) {
    const out = normalizeArgs(spec, { target_ref: bad, snapshot_id: 'r1-n2' })
    const checked = validateArgs(spec, out)
    assert.equal(checked.ok, false, `${JSON.stringify(bad)} 不该通过（实际 ${checked.reason}）`)
  }
  // 缺 snapshot_id 仍然拒
  assert.equal(validateArgs(spec, normalizeArgs(spec, { target_ref: '#1' })).ok, false)
})

test('OBS2-8：归一化只碰 target_ref 和去空白，不动别的字段', () => {
  const spec = ACTION_SPECS.craft
  const out = normalizeArgs(spec, { recipe: '  axe  ' })
  assert.equal(out.recipe, 'axe', '字符串字段应该去掉首尾空白')
  assert.equal(validateArgs(spec, out).ok, true)

  // 数字字段原样保留
  const moveSpec = ACTION_SPECS.move_to
  const moved = normalizeArgs(moveSpec, { x: 12.5, z: -3 })
  assert.equal(moved.x, 12.5)
  assert.equal(moved.z, -3)
})

test('OBS2-9：未知字段不会被归一化悄悄放进来', () => {
  const spec = ACTION_SPECS.pickup
  const out = normalizeArgs(spec, { target_ref: 1, snapshot_id: 'r1-n2', guid: 'evil', x: 5 })
  assert.equal(out.guid, 'evil', '归一化不做白名单（白名单由 validateArgs 负责）')
  const checked = validateArgs(spec, out)
  assert.equal(checked.ok, false)
  assert.match(checked.reason, /unknown_arg/, `应该报未知参数，实际 ${checked.reason}`)
})

test('OBS2-10：走完整 executeTool 时，模型传数字 target_ref 也能正常下发', async () => {
  const commands = []
  const bridge = {
    readState: () => ({ json: { data: {
      schema: 'bws.state/1',
      observer: { snapshot_id: 's1', sequence: 1, status: 'ok' },
      actor: { valid: true, actor_type: 'player', prefab: 'wilson', name: 'w', alive: true, is_ghost: false, tile_x: 1, tile_z: 2 },
      player: { inventory: { used: 0, items: {}, slots: 15 } },
      world: { day: 1, phase_name: '白天', status: 'ok' },
      nearby: { status: 'ok', snapshot_id: 'r1-n2', radius: 16, buckets: { pickupables: [{ ref: '#1', prefab: 'flint', position: { x: 1, z: 2 }, distance: 0.5 }] } },
    } }, ageMs: 0, mtimeMs: Date.now() }),
    call: async (action, args) => { commands.push({ action, args }); return { ok: true, text: '捡了 flint×1' } },
    leaseDirs: () => [],
    readLeaseAck: () => null,
  }
  const control = {
    validate: () => ({ ok: true, lease: { owner_type: 'system', owner_instance_id: 'i', authority_epoch: 'e', generation: 1, lease_id: 'l', expires_at: Date.now() + 30000 } }),
    readAuthority: () => ({ status: 'active' }),
    completeHandover: () => ({ ok: true }),
  }
  const text = await executeTool('pickup', { target_ref: 1, snapshot_id: 'r1-n2' }, {
    bridge, control, owner: 'system', ownerInstanceId: 'i', notes: { read: () => '', write: () => {} }, guides: {},
  })
  assert.equal(commands.length, 1, `应该下发了 1 条命令，实际 ${commands.length}（回执：${text}）`)
  assert.equal(commands[0].args.target_ref, '#1', '下发到游戏的必须是补好 # 的引用')
})

