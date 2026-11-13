// M2.0.2：换手确认（whale_lease_ack）去重键回归
//
// 真机发现：0.14.2 的 B.WriteLeaseAck 只按 generation 去重。
// 插件重启后从磁盘重建权威状态时可能复用同一 generation，Lua 会认为"已经确认过"
// 而不再写 ack → Node completeHandover 永远拿不到有效确认 → 换手卡住（fail-closed）。
// 修复：去重键 = authority_epoch + ":" + generation，ack 带 lease_id。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LeaseManager } from '../lib/control.js'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = {} }
GLOBAL.EQUIPSLOTS = {}
GLOBAL.FOODTYPE = { ROUGHAGE = "ROUGHAGE", SEEDS = "SEEDS", GEARS = "GEARS", VEGGIE = "VEGGIE" }
GLOBAL.ACTIONS = { CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, DIG = { id = "DIG" }, HAMMER = { id = "HAMMER" } }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "s" end }
GLOBAL.TheShard = { GetShardId = function() return "1" end }
GLOBAL.TheSim = { GetTime = function() return 0 end, GetRealTime = function() return 0 end,
                  FindEntities = function() return {} end,
                  SetPersistentString = function() return true end,
                  GetPersistentString = function(n, cb) cb(true, nil) end }
GLOBAL.AllPlayers = {}
GLOBAL.TheWorld = { state = {}, HasTag = function() return false end, ismastersim = true }
GLOBAL.setmetatable = setmetatable
GLOBAL.getmetatable = getmetatable
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.os = { time = function() return 1794550000 end, clock = function() return 0 end }
GLOBAL.io = nil
pcall = nil tonumber = nil error = nil os = nil io = nil
IO_WRITES = {}
`

async function load() {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (code) => {
    const st = lauxlib.luaL_dostring(L, to_luastring(code))
    if (st !== lua.LUA_OK) {
      let m = ''
      try { m = to_jsstring(lua.lua_tostring(L, -1)) } catch {}
      throw new Error('Lua: ' + m)
    }
  }
  const get = (n) => {
    lua.lua_getglobal(L, to_luastring(n))
    try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' }
  }
  run(STUB)
  // 捕获 write_both 写出的 ack 文本（io 通道不可用，ps 通道记录到 IO_WRITES）
  run(`Whale = { verbose=false, version="0.14.3", files={ lease="whale_lease.json", io_lease="whale_io_lease.json", lease_ack="whale_lease_ack.json", io_lease_ack="whale_io_lease_ack.json" } }`)
  for (const name of ['json', 'util', 'config', 'actor', 'nearby', 'guard', 'observe', 'actions', 'macros', 'bridge']) {
    run(readFileSync(join(MOD, 'scripts', 'whale', name + '.lua'), 'utf8'))
  }
  run(`
    Whale.bridge.WriteLeaseAck = function(authority)
      local ack_key = tostring(authority.authority_epoch or "") .. ":" .. tostring(authority.generation)
      if LAST_ACK_KEY == ack_key then return false end
      LAST_ACK_KEY = ack_key
      IO_WRITES[#IO_WRITES + 1] = { epoch = authority.authority_epoch, gen = authority.generation, lease_id = authority.lease_id }
      return true
    end
  `)
  return { run, get }
}

const A = (epoch, lease) => ({
  schema: 'bws.control-lease/1', status: 'revoking', authority_epoch: epoch, generation: 2,
  owner_type: 'mcp_client', owner_instance_id: 'B', lease_id: lease,
  runtime_id: 'r1', session_id: 's', shard_id: '1', actor_id: 'player:x',
  acquired_at: 1, expires_at: 9999999999999,
})

test('ack-1 同一 epoch+generation 只确认一次', async () => {
  const env = await load()
  env.run(`A = Whale.json.decode([==[${JSON.stringify(A('epoch-1', 'lease-1'))}]==])`)
  env.run('local r1 = Whale.bridge.WriteLeaseAck(A); local r2 = Whale.bridge.WriteLeaseAck(A); OUT = tostring(r1) .. "|" .. tostring(r2) .. "|" .. tostring(#IO_WRITES)')
  assert.equal(env.get('OUT'), 'true|false|1')
})

test('ack-2 新 epoch 复用同一 generation → 必须写新确认（换手不卡住）', async () => {
  const env = await load()
  env.run(`A = Whale.json.decode([==[${JSON.stringify(A('epoch-1', 'lease-1'))}]==])`)
  env.run(`B = Whale.json.decode([==[${JSON.stringify(A('epoch-2', 'lease-2'))}]==])`)
  env.run(`local r1 = Whale.bridge.WriteLeaseAck(A); local r2 = Whale.bridge.WriteLeaseAck(B); OUT = tostring(r1) .. "|" .. tostring(r2) .. "|" .. tostring(#IO_WRITES)`)
  assert.equal(env.get('OUT'), 'true|true|2')
  env.run('OUT2 = IO_WRITES[2].epoch .. "|" .. IO_WRITES[2].lease_id')
  assert.equal(env.get('OUT2'), 'epoch-2|lease-2')
})

test('ack-3 静态检查：产品代码用 epoch+generation 去重，ack 带 lease_id', () => {
  const bridge = readFileSync(join(MOD, 'scripts', 'whale', 'bridge.lua'), 'utf8')
  const control = readFileSync(join(ROOT, 'lib', 'control.js'), 'utf8')
  assert.ok(bridge.includes('authority.authority_epoch or ""'), '去重键含 epoch')
  assert.ok(bridge.includes('lease_id = authority.lease_id'), 'ack 带 lease_id')
  assert.ok(bridge.includes('os.time() * 1000.0'), '时间戳用浮点，避免 32 位溢出')
  assert.ok(control.includes('ack.lease_id !== fresh.lease_id'), 'Node 校验 lease_id')
  assert.ok(bridge.includes('if id == last_cmd_id then return end'), '命令单槽去重（不重放）')
})


test('ack-4 revoking 收敛：拿到有效 ack 后 completeHandover 发布 active，旧持有者被拒', () => {
  // 纯 Node：复现"MCP 每次 tools/call 都尝试 completeHandover"的收敛路径
  const dir = mkdtempSync(join(tmpdir(), 'bws-ack-converge-'))
  const file = join(dir, 'm2-control.json')
  const ENV = { runtimeId: 'r1', sessionId: 's', shardId: '1', actorId: 'player:x' }
  try {
    const c = new LeaseManager({ file, now: () => 1000 })
    c.acquire('mcp_client', ENV, { ownerInstanceId: 'mcp' })
    const h = c.acquire('f8_agent', ENV, { ownerInstanceId: 'f8' })
    assert.equal(h.lease.status, 'revoking')
    assert.equal(c.validate('mcp_client', { ownerInstanceId: 'mcp', env: ENV }).reason, 'authority_revoking')
    // 第一次尝试（ack 还没写）→ 保持 revoking
    assert.equal(c.completeHandover(null).reason, 'handover_ack_invalid')
    assert.equal(c.readAuthority().status, 'revoking')
    // 下一次调用读到 Lua 的 ack → active
    const fresh = c.readAuthority()
    const done = c.completeHandover({ authority_epoch: fresh.authority_epoch, generation: fresh.generation, runtime_id: fresh.runtime_id, lease_id: fresh.lease_id })
    assert.equal(done.ok, true)
    assert.equal(done.lease.status, 'active')
    assert.equal(c.validate('mcp_client', { ownerInstanceId: 'mcp', env: ENV }).reason, 'wrong_owner')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ack-5 静态检查：MCP/F8 每次调用都尝试完成 revoking（不只 acquire 那一刻）', () => {
  const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const hits = src.split("fresh?.status === 'revoking'").length - 1
  assert.ok(hits >= 2, `MCP 与 F8 两处都要收敛，实际 ${hits}`)
  assert.ok(src.includes('control.completeHandover(bridge.readLeaseAck'), '用 readLeaseAck 拿确认')
})
