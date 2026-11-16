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
  for (const name of ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'guard', 'observe', 'actions', 'macros', 'bridge']) {
    if (name === 'actions') {
      for (const sub of ['core', 'movement', 'gathering', 'combat', 'survival', 'crafting', 'interaction']) {
        run(readFileSync(join(MOD, 'scripts', 'whale', 'actions', sub + '.lua'), 'utf8'))
      }
    }
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
    assert.equal(c.completeHandover(null).reason, 'handover_ack_missing')
    assert.equal(c.readAuthority().status, 'revoking')
    // 下一次调用读到 Lua 的 ack → active
    const fresh = c.readAuthority()
    const done = c.completeHandover({ authority_epoch: fresh.authority_epoch, generation: fresh.generation, runtime_id: fresh.runtime_id, lease_id: fresh.lease_id, job_cleared: true, acked_at: Date.now() })
    assert.equal(done.ok, true)
    assert.equal(done.lease.status, 'active')
    assert.equal(c.validate('mcp_client', { ownerInstanceId: 'mcp', env: ENV }).reason, 'wrong_owner')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ack-5 静态检查：MCP/F8 都通过 acquireWithWait 反复收敛 revoking（不只 acquire 那一刻）', () => {
  const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  // M2.2.2/P2：收敛逻辑从调用点搬进了 control.acquireWithWait（每轮都尝试 completeHandover），
  // 所以这里检查"两处都用 acquireWithWait 且都传了 readAck"，而不是旧的行内写法。
  const waits = src.split('acquireWithWait(').length - 1
  assert.ok(waits >= 2, `MCP 与 F8 两处都要走有限等待，实际 ${waits}`)
  const acks = src.split('readAck:').length - 1
  assert.ok(acks >= 2, `两处都要把 readLeaseAck 传进去，实际 ${acks}`)
  assert.ok(src.includes('bridge.readLeaseAck'), '用 readLeaseAck 拿确认')

  // 并且确认收敛动作确实还在实现里（不能被搬丢了）
  const ctl = readFileSync(join(ROOT, 'lib', 'control.js'), 'utf8')
  assert.ok(ctl.includes('completeHandover(readAck())'), 'acquireWithWait 内部每轮都要尝试用 ACK 收尾')
  assert.ok(ctl.includes('acquireWithWait('), 'LeaseManager 要提供有限等待版本')
})


test('ack-6 json.lua 能编码墙钟毫秒（>2^31），不能用 %d 溢出成 INT32_MIN', async () => {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const run = (c) => {
    const st = lauxlib.luaL_dostring(L, to_luastring(c))
    if (st !== lua.LUA_OK) {
      let m = ''
      try { m = to_jsstring(lua.lua_tostring(L, -1)) } catch {}
      throw new Error('Lua: ' + m)
    }
  }
  const get = (n) => { lua.lua_getglobal(L, to_luastring(n)); try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' } }
  run('GLOBAL = { pcall = pcall, tonumber = tonumber, error = error, setmetatable = setmetatable, getmetatable = getmetatable }')
  run('Whale = { verbose = false }')
  run(readFileSync(join(MOD, 'scripts', 'whale', 'json.lua'), 'utf8'))
  run('OUT = Whale.json.encode({ acked_at = 1794551954000, gen = 12, ratio = 0.5 })')
  const out = JSON.parse(get('OUT'))
  assert.equal(out.acked_at, 1794551954000, '墙钟毫秒必须原样编码（%d 会溢出成 -2147483648）')
  assert.equal(out.gen, 12)
  assert.equal(out.ratio, 0.5)
})

test('ack-7 静态检查：json.lua 不用 %d 编整数', () => {
  const src = readFileSync(join(MOD, 'scripts', 'whale', 'json.lua'), 'utf8')
  assert.ok(!/string\.format\('%d'/.test(src), '整数编码不能用 %d（Lua 5.1 只认 int32）')
  assert.ok(src.includes("string.format('%.0f'"), '应该用 %.0f')
})


test('ack-8 released 之后重新获取：直接 active（不走 revoking，否则 MCP 每次调用都会被自己挡住）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-released-'))
  const file = join(dir, 'm2-control.json')
  const ENV = { runtimeId: 'r1', sessionId: 's', shardId: '1', actorId: 'player:x' }
  try {
    const c = new LeaseManager({ file, now: () => 1000 })
    const a1 = c.acquire('mcp_client', ENV, { ownerInstanceId: 'mcp' })
    assert.equal(a1.lease.status, 'active')
    c.release('mcp_client', { ownerInstanceId: 'mcp' })
    assert.equal(c.readAuthority().status, 'released')
    const a2 = c.acquire('mcp_client', ENV, { ownerInstanceId: 'mcp' })
    assert.equal(a2.ok, true)
    assert.equal(a2.handover, false, 'released 不是换手')
    assert.equal(a2.reason, 'reacquired_after_release')
    assert.equal(a2.lease.status, 'active', '必须直接 active，不能是 revoking')
    assert.equal(a2.lease.generation, a1.lease.generation + 1, '仍然要换代')
    // 立刻就能用（不需要 Lua 确认）
    assert.equal(c.validate('mcp_client', { ownerInstanceId: 'mcp', env: ENV }).ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
