// M1.2 回归测试：真机冒烟过程中发现的两个「只影响文案」的小问题
//
// 1) 附近实体为空时，文本会误报「附近：暂时读不到（legacy）」——
//    status=legacy 只是说明"这套还是旧扫描"，不是故障；空就是"没什么值得注意的"。
// 2) 状态文件刚写出来（<2 秒）时，开头会多一句「文件 0 秒前写过」，属于噪音。
//
// 两个都在 tools/m12-roundtrip.mjs 的管线自检里暴露，修完在这里钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { freshnessLine, normalizeState, STATE_SCHEMA } from '../lib/state/snapshot.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const STUB = `
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

async function loadLua() {
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
  run('Whale = { verbose = false, version = "0.12.0" }', 'Whale')
  for (const name of ['json', 'util', 'config', 'actor', 'nearby', 'observe']) {
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
  const env = await loadLua()
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
  const env = await loadLua()
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
