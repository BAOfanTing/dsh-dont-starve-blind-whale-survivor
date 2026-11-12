// M1.2 数据管线自检：让**真实的 0.12.0 Lua 代码**在 fengari 里生成状态文件内容，
// 再交给**真实的 Node 读取代码**解析，验证「Lua 写 → 文件 → Node 读」这条链在新格式下是通的。
//
// 这不是真机测试（游戏没开），是**管线自检**：把所有真实代码都跑一遍，只把游戏 API 换成假数据。
// 证据类型在报告里标 UNIT(管线)；真机结论请看 tools/m12-watch.mjs 的采样。
//
// 用法：node tools/m12-roundtrip.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GameBridge, withKleiHeader } from '../lib/bridge.js'
import { executeTool, readSnapshot } from '../lib/tools.js'
import { toJsonPayload } from '../lib/state/snapshot.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')
const OUT_DIR = join(ROOT, 'tests', 'artifacts', 'M1_2')

const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利", SPIDER = "蜘蛛", EVERGREEN = "常青树", LOG = "木头",
                             CUTGRASS = "草", TWIGS = "树枝", AXE = "斧头", TORCH = "火把", CAMPFIRE = "营火" },
                   CHARACTER_NAMES = { WARLY = "沃利" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
local function act(id) return { id = id } end
GLOBAL.ACTIONS = { CHOP = act("CHOP"), MINE = act("MINE"), DIG = act("DIG"), HAMMER = act("HAMMER"),
                   PICK = act("PICK"), PICKUP = act("PICKUP"), HARVEST = act("HARVEST"), ATTACK = act("ATTACK"),
                   EAT = act("EAT"), COOK = act("COOK"), SLEEPIN = act("SLEEPIN"), DROP = act("DROP"),
                   ADDFUEL = act("ADDFUEL"), HEAL = act("HEAL") }
GLOBAL.Vector3 = function(x, y, z) return { x = x, y = y, z = z } end
GLOBAL.BufferedAction = function(doer, target, action) return { doer = doer, target = target, action = action } end
GLOBAL.TheNet = { GetSessionIdentifier = function() return "sess-M12-0001" end,
                  GetUserID = function() return "KU_m12" end }
GLOBAL.TheShard = { GetShardId = function() return "Master" end }

WRITTEN = {}
NEARBY = {}
GLOBAL.TheSim = {
    GetTime = function() return NOW end,
    GetRealTime = function() return NOW * 1000 end,
    FindEntities = function() return NEARBY end,
    SetPersistentString = function(_, name, text) WRITTEN[name] = text end,
    GetPersistentString = function(_, name, cb) cb(false, nil) end,
}
NOW = 1000

-- 一个"看起来像真的"的玩家：有背包、有装备、有饥饿/理智/体温
local items = {
    { prefab = "axe", name = "斧头", uses = 80 },
    { prefab = "cutgrass", name = "草", count = 8 },
    { prefab = "twigs", name = "树枝", count = 5 },
}
local function mkitem(t)
    local item = { prefab = t.prefab, name = t.name }
    if t.count ~= nil then item.components = { stackable = { StackSize = function() return t.count end } } end
    if t.uses ~= nil then item.components = item.components or {}
        item.components.finiteuses = { GetUses = function() return t.uses end, total = 100 } end
    return item
end

local player = {
    prefab = "warly", GUID = 5001, userid = "KU_m12",
    components = {}, tags = { player = true },
    Transform = { GetWorldPosition = function() return 48, 0, 180 end },
}
player.IsValid = function(self) return true end
player.HasTag = function(self, tag)
    if tag == "playerghost" or tag == "INLIMBO" then return false end
    return self.tags[tag] == true
end
player.components.health = { currenthealth = 132, maxhealth = 150, IsDead = function() return false end }
player.components.hunger = { current = 118, max = 150 }
player.components.sanity = { current = 176, max = 200 }
player.components.temperature = { GetCurrent = function() return 21.5 end }
player.components.moisture = { GetMoisture = function() return 0 end }
player.components.inventory = {
    GetNumSlots = function() return 15 end,
    GetItemInSlot = function(_, slot)
        if slot == 1 then return mkitem(items[1]) end
        if slot == 2 then return mkitem(items[2]) end
        if slot == 3 then return mkitem(items[3]) end
        return nil
    end,
    GetEquippedItem = function(_, slot)
        if slot == "hands" then return mkitem(items[1]) end
        return nil
    end,
}
GLOBAL.AllPlayers = { player }
GLOBAL.TheWorld = {
    state = { cycles = 4, phase = "dusk", season = "autumn", temperature = 12, israining = false },
    ismastersim = true,
    HasTag = function(self, tag) return false end,
    meta = { clock = { length_of_day = 480, length_of_dusk = 240, length_of_night = 240, total_day_time = 960 } },
    DoPeriodicTask = function() return { Cancel = function() end } end,
}

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

async function main() {
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
  const modVersion = readFileSync(join(MOD, 'modinfo.lua'), 'utf8').match(/version\s*=\s*"([^"]+)"/)[1]
  run(`Whale = { verbose = false, version = "${modVersion}" }`, 'Whale 表')
  run(`Whale.files = { state = "whale_state.json", io_state = "whale_io_state.json",
                       cmd = "whale_cmd.json", io_cmd = "whale_io_cmd.json",
                       result = "whale_result.json", io_result = "whale_io_result.json",
                       settings = "whale_settings.json", io_settings = "whale_io_settings.json",
                       pause = "whale_pause.json", io_pause = "whale_io_pause.json" }`, '文件名表')
  for (const name of ['json', 'util', 'config', 'actor', 'nearby', 'observe', 'bridge']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', `${name}.lua`), 'utf8'), `${name}.lua`)
  }
  // 配置：用 modinfo 的默认值
  run(`Whale.config.build(function(key)
        if key == "state_interval" then return 1 end
        if key == "observe_interval" then return 2 end
        if key == "scan_radius" then return 16 end
        if key == "scan_seconds" then return 4 end
        return nil
       end)`, '配置')

  // 让真实的 bridge.lua 生成状态文件内容（两条通道都走，io 为 nil 时只走持久化字符串）
  run('Whale.bridge.WriteState(true)', '写状态')
  run('PAYLOAD = WRITTEN["whale_state.json"]', '取回写入内容')
  lua.lua_getglobal(L, to_luastring('PAYLOAD'))
  const payload = to_jsstring(lua.lua_tostring(L, -1))
  if (!payload || payload.length < 50) throw new Error('Lua 没写出状态内容')

  // ── Node 侧：按真实读法解析 ──
  const dir = mkdtempSync(join(tmpdir(), 'bws-m12-roundtrip-'))
  try {
    writeFileSync(join(dir, 'whale_state.json'), withKleiHeader(payload), 'utf8')
    const bridge = new GameBridge({ bridgeDir: dir, lockDir: true, pollMs: 5 })
    const ctx = { bridge, log: () => {} }

    const snapshot = readSnapshot(ctx)
    const text = await executeTool('get_state', {}, ctx)
    const json = JSON.parse(await executeTool('get_state', { format: 'json' }, ctx))

    // 逐项比对：Lua 写的 → Node 读到的
    const checks = []
    const check = (name, actual, expected) => {
      const ok = JSON.stringify(actual) === JSON.stringify(expected)
      checks.push({ name, ok, actual, expected })
    }

    check('schema', snapshot.schema, 'bws.state/1')
    check('status', snapshot.status, 'ok')
    check('session_id', snapshot.identity.sessionId, 'sess-M12-0001')
    check('shard_id', snapshot.identity.shardId, 'Master')
    check('cluster_id', snapshot.identity.clusterId, null)
    check('cluster_id_source', snapshot.identity.clusterIdSource, 'unavailable')
    check('actor_id', snapshot.actor?.actorId, 'player:KU_m12')
    check('actor_id_kind', snapshot.actor?.actorIdKind, 'stable')
    check('actor_type', snapshot.actor?.actorType, 'player')
    check('prefab', snapshot.actor?.prefab, 'warly')
    check('actor tile', [snapshot.actor?.tileX, snapshot.actor?.tileZ], [12, 45])
    check('health', [snapshot.player?.health?.current, snapshot.player?.health?.max], [132, 150])
    check('hunger', [snapshot.player?.hunger?.current, snapshot.player?.hunger?.max], [118, 150])
    check('sanity', [snapshot.player?.sanity?.current, snapshot.player?.sanity?.max], [176, 200])
    check('temperature', snapshot.player?.temperature?.value, 21.5)
    check('inventory used', snapshot.player?.inventory?.used, 3)
    check('inventory slots', snapshot.player?.inventory?.slots, 15)
    check('hands', snapshot.player?.equipment?.slots?.hands?.prefab, 'axe')
    check('world day (cycles+1)', snapshot.world?.day, 5)
    check('world phase', snapshot.world?.phase, 'dusk')
    check('world season', snapshot.world?.season, 'autumn')
    check('world temp', snapshot.world?.world_temperature, 12)
    check('nearby radius', snapshot.nearby?.radius, 16)
    check('nearby status (空场景)', snapshot.nearby?.status, 'empty')
    check('nearby schema', snapshot.nearby?.schema, 'bws.nearby/1')
    check('nearby delta baseline', snapshot.nearby?.delta?.status, 'baseline')
    check('unavailable has weather?', snapshot.unavailableFields.includes('world.world_configuration'), false)
    check('textSource', snapshot.textSource, 'lua')
    check('text has actor name', text.includes('沃利'), true)
    check('text has position', text.includes('位置：(12,45)'), true)
    check('json round-trip actor', json.actor.actor_id, 'player:KU_m12')
    check('json keeps unavailable_fields', Array.isArray(json.observer.unavailable_fields), true)

    const failed = checks.filter((c) => !c.ok)
    const result = {
      at: new Date().toISOString(),
      luaPayloadBytes: payload.length,
      payloadHead: payload.slice(0, 400),
      checks,
      failed: failed.length,
      renderedText: text,
      jsonPayload: toJsonPayload(snapshot),
    }
    mkdirSync(OUT_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    writeFileSync(join(OUT_DIR, `roundtrip-${stamp}.json`), JSON.stringify(result, null, 1), 'utf8')

    console.log(`Lua 写出的 payload：${payload.length} 字节`)
    console.log(`检查项：${checks.length}，失败：${failed.length}`)
    for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.ok ? '' : ` → 实际 ${JSON.stringify(c.actual)}，期望 ${JSON.stringify(c.expected)}`}`)
    console.log('\n--- Node 从 Lua 数据渲染出的文本 ---')
    console.log(text.split('\n').slice(0, 12).join('\n'))
    if (failed.length > 0) process.exitCode = 1
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('管线自检失败：', error)
  process.exitCode = 1
})
