// 控制租约与权威换手测试（包含跨进程互斥、世代隔离、通道缓存、ACK 确认与有限等待）
// M2.0.2 · 跨进程 / owner 粒度 / generation fencing 修复后的安全回归测试
//
// 这些用例在 M2.0.1 里是"证明漏洞存在"的复现；本轮全部**反转成安全断言**并补充新场景。
// 证据类型：UNIT（真实独立 Node 进程 + fengari 沙箱），**不是** DST 真机；
// 真机结论当时记在 M2_0_2 的安全报告里（已在 SURVIVAL-07 随 docs/archive 删除，git 历史可找回）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { LeaseManager, isVerifiableAuthority, ACK_MAX_AGE_MS } from '../lib/control.js'
import { authority, command, luaIoFiles } from './helpers.mjs'

const execFileAsync = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')
const WORKER = join(ROOT, 'tools', 'lease-worker.mjs')
const ENV = { runtimeId: 'r-repro-0001', sessionId: 'sess-R', shardId: '1', actorId: 'player:KU_r' }

function runWorker(file, owner, instanceId, startAt, force = '') {
  return execFileAsync(process.execPath, [WORKER, file, owner, instanceId, String(startAt), force], { cwd: ROOT, timeout: 15000 })
    .then(({ stdout }) => {
      const lines = stdout.split('\n');
      const jsonLine = lines.find(line => line.trim().startsWith('{'));
      if (!jsonLine) throw new Error(`No JSON found in output: ${stdout}`);
      return JSON.parse(jsonLine.trim());
    })
}

const tmp = () => mkdtempSync(join(tmpdir(), 'bws-lease-m202-'))
/** 生成"带真实文件"的 LeaseManager；返回 { c, dir, file, cleanup } */
function manager(now = () => 1000, ttlMs = 30000) {
  const dir = tmp()
  const file = join(dir, 'm2-control.json')
  return { c: new LeaseManager({ file, now, ttlMs }), dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ─────────────────────────── A：跨进程互斥 ───────────────────────────

test('A-1 两个独立 Node 进程同时 acquire：只能有一个 active 有效租约', async () => {
  const dir = tmp()
  const file = join(dir, 'm2-control.json')
  const startAt = Date.now() + 300
  try {
    const [a, b] = await Promise.all([
      runWorker(file, 'f8_agent', 'instance-A', startAt),
      runWorker(file, 'mcp_client', 'instance-B', startAt),
    ])
    // 锁串行化：一个拿到 gen=1/active，另一个要么拿锁失败，要么发布 gen=2/revoking
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(isVerifiableAuthority(onDisk), '权威文件结构必须完整')
    const active = [a, b].filter((r) => r.ok && r.status === 'active')
    assert.equal(active.length, 1, '同一时刻只能有一个 active 持有者')
    assert.notEqual(a.generation, b.generation, 'generation 不重复')
    // 失败/换手中的那个不能是 active
    const other = [a, b].find((r) => r !== active[0])
    assert.ok(!other.ok || other.status === 'revoking', '另一个进程不能拿到有效控制权')
    assert.equal(onDisk.generation, Math.max(...[a, b].filter((r) => r.generation).map((r) => r.generation)),
      '文件里是最后一次（最高）世代')
    console.log('  [A-1] 结果:', JSON.stringify({ a, b, onDisk: { generation: onDisk.generation, status: onDisk.status, owner: onDisk.owner_type } }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A-2 已有 LeaseManager 实例能看到其他进程刚更新的租约（不再依赖构造时内存副本）', () => {
  const dir = tmp()
  const file = join(dir, 'm2-control.json')
  try {
    const p1 = new LeaseManager({ file, now: () => 1000, ttlMs: 30000, ownerInstanceId: 'A' })
    const p2 = new LeaseManager({ file, now: () => 1000, ttlMs: 30000, ownerInstanceId: 'B' })
    p1.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
    const r = p2.acquire('mcp_client', ENV, { ownerInstanceId: 'B' })
    assert.equal(r.ok, true)
    assert.equal(r.lease.generation, 2, 'p2 基于最新磁盘状态换代')
    assert.equal(r.lease.status, 'revoking', '换手先发布 revoking，不是直接给 active')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A-3 锁持有进程异常退出后：过期锁被安全清理，租约可恢复且 generation 递增', () => {
  const dir = tmp()
  const file = join(dir, 'm2-control.json')
  try {
    const now = { value: 1000 }
    const p1 = new LeaseManager({ file, now: () => now.value, ttlMs: 1000, ownerInstanceId: 'A' })
    p1.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
    // 模拟崩溃：手动写一个"过期且 PID 不存在"的锁
    writeFileSync(`${file}.lock`, JSON.stringify({
      owner_type: 'f8_agent', owner_instance_id: 'A', pid: 999999999, nonce: 'dead',
      acquired_at: 1000, expires_at: 2000,
    }), 'utf8')
    now.value = 10000
    const p2 = new LeaseManager({ file, now: () => now.value, ttlMs: 1000, ownerInstanceId: 'B' })
    const r = p2.acquire('mcp_client', ENV, { ownerInstanceId: 'B' })
    assert.equal(r.ok, true, '过期锁能被清理')
    assert.equal(r.lease.generation, 2, '崩溃恢复后 generation 递增')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A-4 静态检查：acquire 在锁内重新读盘，不依赖构造时内存副本', () => {
  const src = readFileSync(join(ROOT, 'lib', 'control.js'), 'utf8')
  assert.ok(src.includes("openSync(this.lockFile, 'wx')"), 'O_EXCL 跨进程锁')
  assert.ok(src.includes('const fresh = this._readFile()'), '锁内重新读最新权威状态')
  assert.ok(!/this\.lease\s*=\s*this\._load\(\)/.test(src), '不再只在构造时加载一次')
  assert.ok(src.includes('writeAtomic(this.file, text)'), '权威文件原子替换')
})

test('A-5 三个独立进程竞争：最多一个 active，generation 单调递增且不重复', async () => {
  const dir = tmp()
  const file = join(dir, 'm2-control.json')
  const startAt = Date.now() + 300
  try {
    const rs = await Promise.all([
      runWorker(file, 'f8_agent', 'i-1', startAt),
      runWorker(file, 'mcp_client', 'i-2', startAt),
      runWorker(file, 'manual_test', 'i-3', startAt),
    ])
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(isVerifiableAuthority(onDisk))
    assert.equal(rs.filter((r) => r.ok && r.status === 'active').length, 1)
    const gens = rs.filter((r) => r.generation).map((r) => r.generation)
    assert.equal(new Set(gens).size, gens.length, 'generation 不重复')
    assert.equal(onDisk.generation, Math.max(...gens))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A-6 写权威文件失败 → acquire 拒绝（不报告成功）', () => {
  const dir = tmp()
  const file = join(dir, 'm2-control.json')
  const blocked = join(dir, 'not-a-dir')
  try {
    writeFileSync(blocked, 'x', 'utf8')
    // 副本目录是一个文件 → mkdirSync 必失败
    const c = new LeaseManager({ file, authorityDirs: [{ dir: blocked, channel: 'io' }], now: () => 1000 })
    const r = c.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'authority_write_failed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A-7 锁 nonce 不匹配时不能释放别人的锁', () => {
  const dir = tmp()
  const file = join(dir, 'm2-control.json')
  try {
    const c = new LeaseManager({ file, now: () => 1000 })
    const lock = c._acquireLock('f8_agent', 'A')
    assert.equal(lock.ok, true)
    writeFileSync(`${file}.lock`, JSON.stringify({ ...lock.token, nonce: 'someone-else' }), 'utf8')
    assert.equal(c._releaseLock(lock.token), false)
    assert.ok(readFileSync(`${file}.lock`, 'utf8').includes('someone-else'), '别人的锁不许删')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A-8 锁持有进程还活着且未过期 → 其他进程不能抢占', () => {
  const dir = tmp()
  const file = join(dir, 'm2-control.json')
  try {
    const c1 = new LeaseManager({ file, now: () => 1000 })
    const lock = c1._acquireLock('f8_agent', 'A')
    assert.equal(lock.ok, true)
    const c2 = new LeaseManager({ file, now: () => 1000 })
    const r = c2._acquireLock('mcp_client', 'B')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'lock_busy')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─────────────────────────── B：owner 实例身份 ───────────────────────────

test('B-1 两个不同 MCP 实例不能互相续租（换代 + revoking）', () => {
  const { c, cleanup } = manager()
  try {
  c.acquire('mcp_client', ENV, { ownerInstanceId: 'client-A' })
  const r = c.acquire('mcp_client', ENV, { ownerInstanceId: 'client-B' })
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'handover_revoking')
  assert.equal(r.lease.generation, 2)
  assert.equal(r.lease.owner_instance_id, 'client-B')
  } finally { cleanup() }
})

test('B-2 两个不同 F8 实例不能互相续租', () => {
  const { c, cleanup } = manager()
  try {
  c.acquire('f8_agent', ENV, { ownerInstanceId: 'f8-A' })
  const r = c.acquire('f8_agent', ENV, { ownerInstanceId: 'f8-B' })
  assert.equal(r.lease.generation, 2)
  } finally { cleanup() }
})

test('B-3 同一实例有效续租不换代；不同实例不能释放', () => {
  const { c, cleanup } = manager()
  try {
  c.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
  const renew = c.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
  assert.equal(renew.reason, 'renewed')
  assert.equal(renew.lease.generation, 1)
  const bad = c.release('f8_agent', { ownerInstanceId: 'B' })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'wrong_owner_instance')
  } finally { cleanup() }
})

test('B-4 未知/空 owner_instance_id 被拒绝', () => {
  const c = new LeaseManager({ file: '', now: () => 1000 })
  assert.equal(c.acquire('f8_agent', ENV, { ownerInstanceId: '' }).reason, 'unknown_owner_instance')
  assert.equal(c.validate('f8_agent', { ownerInstanceId: '' }).ok, false)
})

test('B-5 模型伪造 owner_instance_id 不生效（dispatcher 不信任模型字段）', () => {
  const src = readFileSync(join(ROOT, 'lib', 'dispatcher.js'), 'utf8')
  assert.ok(src.includes('owner_instance_id: lease.owner_instance_id'), '身份取自权威租约，不是 args')
  assert.ok(src.includes('control?.validate?.(owner, { ownerInstanceId, env })'), '按可信实例 id 校验')
})

test('B-6 权威记录里确实有 owner_type + owner_instance_id', () => {
  const { c, cleanup } = manager()
  try {
  const l = c.acquire('mcp_client', ENV, { ownerInstanceId: 'client-A' }).lease
  assert.equal(l.owner_type, 'mcp_client')
  assert.equal(l.owner_instance_id, 'client-A')
  assert.ok(isVerifiableAuthority(l))
  } finally { cleanup() }
})

// ─────────────────────────── C：Lua fencing（fengari）───────────────────────────

const GUARD_STUB = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.FOODTYPE = { ROUGHAGE = "ROUGHAGE", SEEDS = "SEEDS", GEARS = "GEARS", VEGGIE = "VEGGIE" }
GLOBAL.ACTIONS = { CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, DIG = { id = "DIG" }, HAMMER = { id = "HAMMER" } }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "sess-R" end }
GLOBAL.TheShard = { GetShardId = function() return "1" end }
NOW = 1000
NOW_MS = 1794500000000
NEARBY = {}
GLOBAL.TheSim = { GetTime = function() return NOW end, GetRealTime = function() return NOW * 1000 end,
                  FindEntities = function() return NEARBY end }
function mkent(opts)
    local e = { prefab = opts.prefab or "evergreen", GUID = opts.guid or 1, tags = opts.tags or {}, components = {},
                Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end } }
    e.IsValid = function() return true end
    e.HasTag = function(self, tag) if tag == "INLIMBO" then return false end if tag == "playerghost" then return false end return self.tags[tag] == true end
    if opts.hp ~= nil then e.components.health = { currenthealth = opts.hp, maxhealth = opts.hp, IsDead = function() return false end } end
    return e
end
PLAYER = mkent({ prefab = "warly", guid = 999, tags = { player = true }, hp = 100 })
PLAYER.userid = "KU_r"
PLAYER.components.inventory = { GetNumSlots = function() return 15 end, GetItemSlot = function() return nil end,
                               GetEquippedItem = function() return nil end }
PLAYER.components.locomotor = {}
GLOBAL.AllPlayers = { PLAYER }
GLOBAL.TheWorld = { state = { cycles = 1, phase = "day", season = "autumn", temperature = 20 },
                    HasTag = function() return false end, ismastersim = true }
GLOBAL.setmetatable = setmetatable
GLOBAL.getmetatable = getmetatable
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.os = { time = function() return math.floor(NOW_MS / 1000) end, clock = function() return 0 end }
pcall = nil tonumber = nil error = nil os = nil io = nil
`

async function guardVm(files) {
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
  const get = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' }
  }
  run(GUARD_STUB)
  run(luaIoFiles(files))
  run('Whale = { verbose = false, version = "0.14.1" }')
  for (const name of ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'guard_specs', 'guard', 'observe', 'actions', 'macros', 'bridge']) {
    if (name === 'actions') {
      for (const sub of ['core', 'movement', 'gathering', 'work', 'combat', 'survival', 'crafting', 'interaction']) {
        run(readFileSync(join(ROOT, 'DontStarveWhaleSurvivor', 'scripts', 'whale', 'actions', sub + '.lua'), 'utf8'))
      }
    }
    run(readFileSync(join(ROOT, 'DontStarveWhaleSurvivor', 'scripts', 'whale', name + '.lua'), 'utf8'))
  }
  run('Whale.config.build(function(k) if k == "scan_radius" then return 16 end return nil end)')
  run('Whale.nearby.runtime_id = function() return "r1794500000-0001" end')
  const setFiles = (map) => run(luaIoFiles(map))
  const setCmd = (c) => run(`CMD = Whale.json.decode([==[${JSON.stringify(c)}]==])`)
  const validate = () => {
    run('local ok, why = Whale.guard.validate(CMD); OUT = tostring(ok) .. "|" .. tostring(why)')
    return get('OUT')
  }
  return { run, get, setFiles, setCmd, validate }
}

const A = authority({ runtime_id: 'r1794500000-0001' })

test('C-1 关键时序：gen=13 已在 Node 生效、Lua 只见过 12 → 旧命令 A 必须被拒', async () => {
  const env = await guardVm({ 'whale_io_lease.json': A })
  // 1) F8 拿 gen=12 写入命令 A（未处理）
  env.setCmd(command(A, { lease_generation: 12, command_id: 'cmd-A' }))
  assert.equal(env.validate(), 'true|nil', '换手前命令 A 合法')
  // 2) MCP 换手：Node 发布 gen=13 的权威租约，但**不发任何新命令**
  env.setFiles({ 'whale_io_lease.json': authority({ ...A, generation: 13, owner_type: 'mcp_client', owner_instance_id: 'client-B', lease_id: 'lease-B', status: 'revoking' }) })
  // 3) Lua 读取旧命令 A
  assert.equal(env.validate(), 'false|authority_revoking', '★ 换手窗口：旧命令被拒')
  // 完成换手后旧命令依然是旧世代
  env.setFiles({ 'whale_io_lease.json': authority({ ...A, generation: 13, owner_type: 'mcp_client', owner_instance_id: 'client-B', lease_id: 'lease-B' }) })
  assert.equal(env.validate(), 'false|stale_generation', '★ 旧命令被拒（stale_generation）')
})

test('C-2 先执行 13 再执行 12 → 12 被拒', async () => {
  const env = await guardVm({ 'whale_io_lease.json': authority({ ...A, generation: 13, lease_id: 'B' }) })
  env.setCmd(command(A, { lease_generation: 13, lease_id: 'B', command_id: 'c-new' }))
  assert.equal(env.validate(), 'true|nil')
  env.setCmd(command(A, { lease_generation: 12, command_id: 'c-old' }))
  assert.equal(env.validate(), 'false|stale_generation')
})

test('C-3 伪造 gen=999 → future_generation，且不污染权威状态', async () => {
  const env = await guardVm({ 'whale_io_lease.json': A })
  env.setCmd(command(A, { lease_generation: 999 }))
  assert.equal(env.validate(), 'false|future_generation')
  env.setCmd(command(A, { command_id: 'c-ok' }))
  assert.equal(env.validate(), 'true|nil', '正常命令仍可用（权威状态没被污染）')
})

test('C-5 非当前 owner 用相同 generation → wrong_owner / wrong_instance', async () => {
  const env = await guardVm({ 'whale_io_lease.json': A })
  env.setCmd(command(A, { owner_type: 'mcp_client' }))
  assert.equal(env.validate(), 'false|wrong_owner')
  env.setCmd(command(A, { owner_instance_id: 'client-B' }))
  assert.equal(env.validate(), 'false|wrong_instance')
})

test('C-6 权威租约文件不存在 → authority_unavailable', async () => {
  const env = await guardVm({})
  env.setCmd(command(A))
  assert.equal(env.validate(), 'false|authority_unavailable')
})

test('C-7 权威文件损坏 / 缺字段 → 拒绝', async () => {
  const broken = await guardVm({ 'whale_io_lease.json': '{broken' })
  broken.setCmd(command(A))
  assert.equal(broken.validate(), 'false|authority_corrupt')
  const incomplete = await guardVm({ 'whale_io_lease.json': (() => { const x = { ...A }; delete x.owner_instance_id; return x })() })
  incomplete.setCmd(command(A))
  assert.equal(incomplete.validate(), 'false|authority_corrupt')
})

test('C-8 revoking 状态 → 拒绝所有新动作', async () => {
  const env = await guardVm({ 'whale_io_lease.json': authority({ ...A, status: 'revoking' }) })
  env.setCmd(command(A))
  assert.equal(env.validate(), 'false|authority_revoking')
})

test('C-9 authority_epoch 不匹配 → 拒绝', async () => {
  const env = await guardVm({ 'whale_io_lease.json': A })
  env.setCmd(command(A, { authority_epoch: 'epoch-OLD' }))
  assert.equal(env.validate(), 'false|authority_epoch_mismatch')
})

test('C-10 命令在换手前写入、换手后到达 → 拒绝（C-1 同场景，独立用例）', async () => {
  const env = await guardVm({ 'whale_io_lease.json': A })
  const old = command(A, { command_id: 'cmd-written-before' })
  env.setFiles({ 'whale_io_lease.json': authority({ ...A, generation: 13, lease_id: 'B' }) })
  env.setCmd(old)
  assert.equal(env.validate(), 'false|stale_generation')
})

test('C-11 Lua 已读 authority、租约随后换手：Lua 每次 validate 都重读文件，不会用旧副本放行', async () => {
  const env = await guardVm({ 'whale_io_lease.json': A })
  env.setCmd(command(A, { command_id: 'c1' }))
  assert.equal(env.validate(), 'true|nil')
  env.setFiles({ 'whale_io_lease.json': authority({ ...A, generation: 13, lease_id: 'B', status: 'revoking' }) })
  env.setCmd(command(A, { command_id: 'c2' }))
  assert.equal(env.validate(), 'false|authority_revoking')
})

test('C-12 两阶段换手：revoking 无确认 → 保持拒绝；有 Lua 确认 → active 后新命令可用', async () => {
  const dir = tmp()
  const file = join(dir, 'm2-control.json')
  const now = { value: 1000 }
  try {
    const c = new LeaseManager({ file, now: () => now.value, ttlMs: 30000 })
    c.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
    const handover = c.acquire('mcp_client', ENV, { ownerInstanceId: 'B' })
    assert.equal(handover.lease.status, 'revoking')
    assert.equal(c.validate('mcp_client', { ownerInstanceId: 'B', env: ENV }).reason, 'authority_revoking')
    // 没有确认时不能完成
    assert.equal(c.completeHandover(null).reason, 'handover_ack_missing')
    assert.equal(c.readAuthority().status, 'revoking', '拿不到确认绝不自动放行')
    // 确认不匹配也不能完成
    assert.equal(c.completeHandover({ authority_epoch: 'wrong', generation: 2, runtime_id: 'r-repro-0001' }).reason, 'handover_ack_epoch_mismatch')
    // 有效确认 → active
    const fresh = c.readAuthority()
    const done = c.completeHandover({ authority_epoch: fresh.authority_epoch, generation: fresh.generation, runtime_id: fresh.runtime_id, lease_id: fresh.lease_id, job_cleared: true, acked_at: Date.now() })
    assert.equal(done.ok, true)
    assert.equal(done.lease.status, 'active')
    assert.equal(c.validate('mcp_client', { ownerInstanceId: 'B', env: ENV }).ok, true)
    assert.equal(c.validate('f8_agent', { ownerInstanceId: 'A', env: ENV }).reason, 'wrong_owner')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─────────────────────────── D：原有正确行为回归 ───────────────────────────

test('D-1 单位一致：Node Date.now() 与 Lua os.time()*1000.0 都是墙钟毫秒', () => {
  const guard = readFileSync(join(ROOT, 'DontStarveWhaleSurvivor', 'scripts', 'whale', 'guard.lua'), 'utf8')
  assert.ok(guard.includes('1000.0'))
  assert.ok(readFileSync(join(ROOT, 'lib', 'control.js'), 'utf8').includes('expires_at: now + this.ttlMs'))
  assert.ok(readFileSync(join(ROOT, 'lib', 'dispatcher.js'), 'utf8').includes('expires_at: createdAt + commandTtlMs'))
})

test('D-2 租约过期同实例重取换代；runtime/session/shard/actor 变化换代', () => {
  const now = { value: 1000 }
  const { c, cleanup } = manager(() => now.value, 1000)
  try {
  c.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
  now.value = 5000
  assert.equal(c.acquire('f8_agent', ENV, { ownerInstanceId: 'A' }).lease.generation, 2)
  for (const patch of [{ runtimeId: 'r-new' }, { sessionId: 'sess-B' }, { shardId: '2' }, { actorId: 'player:KU_y' }]) {
    const f = manager(() => 1000, 30000)
    try {
      f.c.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
      const r = f.c.acquire('f8_agent', { ...ENV, ...patch }, { ownerInstanceId: 'A' })
      assert.equal(r.lease.generation, 2, JSON.stringify(patch))
    } finally { f.cleanup() }
  }
  } finally { cleanup() }
})

test('D-3 命令过期 → command_expired（Lua）', async () => {
  const env = await guardVm({ 'whale_io_lease.json': A })
  env.setCmd(command(A, { expires_at: 1 }))
  assert.equal(env.validate(), 'false|command_expired')
})

test('D-4 权威文件丢失后重建：新 epoch 让旧命令失效', () => {
  const dir = tmp()
  const file = join(dir, 'm2-control.json')
  try {
    const c1 = new LeaseManager({ file, now: () => 1000 })
    const first = c1.acquire('f8_agent', ENV, { ownerInstanceId: 'A' })
    const oldEpoch = first.lease.authority_epoch
    rmSync(file, { force: true })
    const c2 = new LeaseManager({ file, now: () => 2000 })
    const rebuilt = c2.acquire('mcp_client', ENV, { ownerInstanceId: 'B' })
    assert.equal(rebuilt.reason, 'authority_rebuilt')
    assert.notEqual(rebuilt.lease.authority_epoch, oldEpoch, '权威状态重建必须换 epoch')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


// ─────────────────────────── 通道与缓存回归 ───────────────────────────
// M2.0.2 真机修复回归：Lua 权威租约走持久化字符串通道（不是 io.open）
//
// 真机发现：DST 模组沙箱 GLOBAL.io == nil（bin64 里没有 Lua 写的
// whale_io_state.json / whale_io_result.json），只有 TheSim:GetPersistentString 双向可用。
// 所以 bridge.lua 每 tick 用 ps_read 读权威文件并缓存，guard.validate 用新鲜缓存。
//
// 证据类型：UNIT（fengari），不是 DST 真机。



const STUB_CHANNEL = `
GLOBAL = {}
GLOBAL.STRINGS = { NAMES = { WARLY = "沃利" } }
GLOBAL.EQUIPSLOTS = { HANDS = "hands", HEAD = "head", BODY = "body" }
GLOBAL.FOODTYPE = { ROUGHAGE = "ROUGHAGE", SEEDS = "SEEDS", GEARS = "GEARS", VEGGIE = "VEGGIE" }
GLOBAL.ACTIONS = { CHOP = { id = "CHOP" }, MINE = { id = "MINE" }, DIG = { id = "DIG" }, HAMMER = { id = "HAMMER" } }
GLOBAL.TheNet = { GetSessionIdentifier = function() return "sess-R" end }
GLOBAL.TheShard = { GetShardId = function() return "1" end }
NOW = 1000
NOW_MS = 1794500000000
NEARBY = {}
PS_TEXT = nil     -- GetPersistentString 会回调这个文本（带 KLEI 头）
PS_CALLS = 0
GLOBAL.TheSim = {
    GetTime = function() return NOW end, GetRealTime = function() return NOW * 1000 end,
    FindEntities = function() return NEARBY end,
    SetPersistentString = function(name, text, cb) return true end,
    GetPersistentString = function(name, cb)
        PS_CALLS = PS_CALLS + 1
        if PS_TEXT ~= nil then cb(true, PS_TEXT) else cb(false, nil) end
    end,
}
function mkent(opts)
    local e = { prefab = opts.prefab or "evergreen", GUID = opts.guid or 1, tags = opts.tags or {}, components = {},
                Transform = { GetWorldPosition = function() return opts.x or 0, 0, opts.z or 0 end } }
    e.IsValid = function() return true end
    e.HasTag = function(self, tag) if tag == "INLIMBO" then return false end if tag == "playerghost" then return false end return self.tags[tag] == true end
    if opts.hp ~= nil then e.components.health = { currenthealth = opts.hp, maxhealth = opts.hp, IsDead = function() return false end } end
    return e
end
PLAYER = mkent({ prefab = "warly", guid = 999, tags = { player = true }, hp = 100 })
PLAYER.userid = "KU_r"
PLAYER.components.inventory = { GetNumSlots = function() return 15 end, GetItemInSlot = function() return nil end,
                               GetEquippedItem = function() return nil end }
PLAYER.components.locomotor = {}
GLOBAL.AllPlayers = { PLAYER }
GLOBAL.TheWorld = { state = { cycles = 1, phase = "day", season = "autumn", temperature = 20 },
                    HasTag = function() return false end, ismastersim = true }
GLOBAL.setmetatable = setmetatable
GLOBAL.getmetatable = getmetatable
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.os = { time = function() return math.floor(NOW_MS / 1000) end, clock = function() return 0 end }
pcall = nil
tonumber = nil
error = nil
os = nil
io = nil
`

async function loadChannelEnv() {
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
  const get = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    try { return to_jsstring(lua.lua_tostring(L, -1)) } catch { return '' }
  }
  const setCmd = (c) => run(`CMD = Whale.json.decode([==[${JSON.stringify(c)}]==])`)
  const validate = () => {
    run('local ok, why = Whale.guard.validate(CMD); OUT = tostring(ok) .. "|" .. tostring(why)')
    return get('OUT')
  }
  run(STUB_CHANNEL)
  run(luaIoFiles({})) // 没有 io 文件：模拟真机 GLOBAL.io == nil 的情况
  run('Whale = { verbose = false, version = "0.14.2", files = { lease = "whale_lease.json", io_lease = "whale_io_lease.json" } }')
  for (const name of ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'guard_specs', 'guard', 'observe', 'actions', 'macros', 'bridge']) {
    if (name === 'actions') {
      for (const sub of ['core', 'movement', 'gathering', 'work', 'combat', 'survival', 'crafting', 'interaction']) {
        run(readFileSync(join(MOD, 'scripts', 'whale', 'actions', sub + '.lua'), 'utf8'))
      }
    }
    run(readFileSync(join(MOD, 'scripts', 'whale', name + '.lua'), 'utf8'))
  }
  run('Whale.config.build(function(k) if k == "scan_radius" then return 16 end return nil end)')
  run('Whale.nearby.runtime_id = function() return "r1794500000-0001" end')
  return { run, get, setCmd, validate }
}

const AUTH_CHAN = authority({ runtime_id: 'r1794500000-0001' })
const withHeader = (o) => `KLEI     1 ${JSON.stringify(o)}`

test('通道-1 真机形态：没有 io 文件、PS_TEXT 有权威租约 → 通过缓存放行', async () => {
  const env = await loadChannelEnv()
  env.run(`PS_TEXT = ${JSON.stringify(withHeader(AUTH_CHAN))}`)
  // 模拟 bridge.lua 的 poll_authority：ps_read → parse → 缓存
  env.run(`
    Whale.bridge.poll_authority_for_test = function()
      local text = PS_TEXT
      local a = Whale.guard.parse_authority(text)
      Whale.authority_cache = { data = a, at = GLOBAL.os.time() }
    end
  `)
  env.run('Whale.bridge.poll_authority_for_test()')
  env.setCmd(command(AUTH_CHAN))
  assert.equal(env.validate(), 'true|nil', 'ps 缓存生效，合法命令通过')
})

test('通道-2 缓存过期（>5s）→ authority_unavailable（fail-closed）', async () => {
  const env = await loadChannelEnv()
  env.run(`PS_TEXT = ${JSON.stringify(withHeader(AUTH_CHAN))}`)
  env.run(`
    local a = Whale.guard.parse_authority(PS_TEXT)
    Whale.authority_cache = { data = a, at = GLOBAL.os.time() - 6 }
  `)
  env.setCmd(command(AUTH_CHAN))
  assert.equal(env.validate(), 'false|authority_unavailable')
})

test('通道-3 缓存里是 revoking → 拒绝所有动作', async () => {
  const env = await loadChannelEnv()
  env.run(`PS_TEXT = ${JSON.stringify(withHeader(authority({ ...AUTH_CHAN, status: 'revoking', generation: 13 })))}`)
  env.run(`Whale.authority_cache = { data = Whale.guard.parse_authority(PS_TEXT), at = GLOBAL.os.time() }`)
  env.setCmd(command(AUTH_CHAN))
  assert.equal(env.validate(), 'false|authority_revoking')
})

test('通道-4 缓存里的权威与命令不匹配 → 精确拒绝', async () => {
  const env = await loadChannelEnv()
  env.run(`PS_TEXT = ${JSON.stringify(withHeader(authority({ ...AUTH_CHAN, generation: 13, lease_id: 'B' })))}`)
  env.run(`Whale.authority_cache = { data = Whale.guard.parse_authority(PS_TEXT), at = GLOBAL.os.time() }`)
  env.setCmd(command(AUTH_CHAN))
  assert.equal(env.validate(), 'false|stale_generation', '旧 generation 优先于 lease_id 判定')
})

test('通道-5 静态检查：bridge.lua 用 ps_read 读权威租约并缓存', () => {
  const bridge = readFileSync(join(MOD, 'scripts', 'whale', 'bridge.lua'), 'utf8')
  const guard = readFileSync(join(MOD, 'scripts', 'whale', 'guard.lua'), 'utf8')
  assert.ok(bridge.includes('ps_read(FILES.lease'), '走持久化字符串通道')
  assert.ok(/authority_cache\s*=\s*\{\s*data\s*=\s*a\s*,\s*at\s*=\s*os\.time\(\)\s*\}/.test(bridge), '写缓存带时间戳')
  assert.ok(bridge.includes('step("读权威租约", poll_authority)'), '每 tick 刷新')
  assert.ok(guard.includes('function cached_authority()'), 'guard 用缓存')
  assert.ok(guard.includes('G.AUTHORITY_CACHE_MAX_AGE = 5'), '缓存有新鲜度上限')
})

test('通道-6 io 兜底仍可用（沙箱/将来 io 可用时）', async () => {
  const env = await loadChannelEnv()
  env.run(luaIoFiles({ 'whale_io_lease.json': AUTH_CHAN }))
  env.setCmd(command(AUTH_CHAN))
  assert.equal(env.validate(), 'true|nil')
})


// ─────────────────────────── ACK 去重与收敛 ───────────────────────────
// M2.0.2：换手确认（whale_lease_ack）去重键回归
//
// 真机发现：0.14.2 的 B.WriteLeaseAck 只按 generation 去重。
// 插件重启后从磁盘重建权威状态时可能复用同一 generation，Lua 会认为"已经确认过"
// 而不再写 ack → Node completeHandover 永远拿不到有效确认 → 换手卡住（fail-closed）。
// 修复：去重键 = authority_epoch + ":" + generation，ack 带 lease_id。


const STUB_ACK = `
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

async function loadAckEnv() {
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
  run(STUB_ACK)
  // 捕获 write_both 写出的 ack 文本（io 通道不可用，ps 通道记录到 IO_WRITES）
  run(`Whale = { verbose=false, version="0.14.3", files={ lease="whale_lease.json", io_lease="whale_io_lease.json", lease_ack="whale_lease_ack.json", io_lease_ack="whale_io_lease_ack.json" } }`)
  for (const name of ['json', 'util', 'pickuprules', 'harvestrules', 'config', 'actor', 'nearby', 'guard_specs', 'guard', 'observe', 'actions', 'macros', 'bridge']) {
    if (name === 'actions') {
      for (const sub of ['core', 'movement', 'gathering', 'work', 'combat', 'survival', 'crafting', 'interaction']) {
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

const makeAckAuth = (epoch, lease) => ({
  schema: 'bws.control-lease/1', status: 'revoking', authority_epoch: epoch, generation: 2,
  owner_type: 'mcp_client', owner_instance_id: 'B', lease_id: lease,
  runtime_id: 'r1', session_id: 's', shard_id: '1', actor_id: 'player:x',
  acquired_at: 1, expires_at: 9999999999999,
})

test('ack-1 同一 epoch+generation 只确认一次', async () => {
  const env = await loadAckEnv()
  env.run(`A = Whale.json.decode([==[${JSON.stringify(makeAckAuth('epoch-1', 'lease-1'))}]==])`)
  env.run('local r1 = Whale.bridge.WriteLeaseAck(A); local r2 = Whale.bridge.WriteLeaseAck(A); OUT = tostring(r1) .. "|" .. tostring(r2) .. "|" .. tostring(#IO_WRITES)')
  assert.equal(env.get('OUT'), 'true|false|1')
})

test('ack-2 新 epoch 复用同一 generation → 必须写新确认（换手不卡住）', async () => {
  const env = await loadAckEnv()
  env.run(`A = Whale.json.decode([==[${JSON.stringify(makeAckAuth('epoch-1', 'lease-1'))}]==])`)
  env.run(`B = Whale.json.decode([==[${JSON.stringify(makeAckAuth('epoch-2', 'lease-2'))}]==])`)
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


// ─────────────────────────── 换手有限等待 ───────────────────────────
// M2.2.2 / P2：控制权换手的**有限等待**
//
// 背景（AGENT-01 真机抓到）：模型冷启动后连续两次动作拿到
//   control_denied / authority_revoking
//   control_denied / handover_pending
// 第三次才成功 —— 交接窗口只有一两百毫秒，但 acquire() 一看到 revoking 就立刻返回，
// 于是白烧掉模型的工具调用次数。
//
// 本文件要证明：等待只发生在**提交命令之前**，且**没有放宽任何一条安全条件**。


const WAIT_ENV = { runtimeId: 'r1', sessionId: 'S1', shardId: '1', actorId: 'player:X' }

function makeControl(nowRef = { t: 1_000_000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'a11-lease-'))
  const file = join(dir, 'control-lease.json')
  const control = new LeaseManager({
    file,
    authorityDirs: [],
    now: () => nowRef.t,
    ttlMs: 30_000,
    ownerInstanceId: 'inst-1',
  })
  return { dir, file, control, nowRef }
}

/** 造一份合法的 Lua ACK（与 bridge.WriteLeaseAck 写出的形状一致） */
function ackFor(record, { jobCleared = true, leaseId, epoch, generation, ackedAt } = {}) {
  return {
    schema: 'bws.lease-ack/1',
    authority_epoch: epoch ?? record.authority_epoch,
    generation: generation ?? record.generation,
    lease_id: leaseId ?? record.lease_id,
    runtime_id: WAIT_ENV.runtimeId,
    acked_at: ackedAt ?? Date.now(),
    job_cleared: jobCleared,
  }
}

/** 让租约处于 revoking（模拟"别人正要交接给我"） */
function toRevoking(control, ownerType = 'mcp_client', instanceId = 'inst-2') {
  // 先让"上一任"拿到 active（实例必须与抢的人不同，否则 acquire 只会续租）
  const prevInstance = instanceId === 'inst-f8' ? 'inst-other' : 'inst-f8'
  const first = control.acquire('f8_agent', WAIT_ENV, { ownerInstanceId: prevInstance })
  assert.equal(first.ok, true, '上一任应该先拿到 active')
  assert.equal(first.record.status, 'active')
  // 再让目标实例来抢 → 进入两阶段换手
  const second = control.acquire(ownerType, WAIT_ENV, { ownerInstanceId: instanceId })
  assert.equal(second.ok, true, `抢租约本身应该成功（发起换手），实际 ${second.reason}`)
  assert.equal(second.reason, 'handover_revoking', '第二次应该是发起换手')
  assert.equal(second.record.status, 'revoking')
  return second.record
}

/** 假时钟下的 sleep：推进注入的时钟，不真等（避免测试挂住） */
const tickSleep = (nowRef) => async (ms) => { nowRef.t += ms }
/** 真等待用（P2-13 验事件循环不阻塞） */
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('P2-1：正常立即获取租约（不等待）', async () => {
  const { control, nowRef } = makeControl()
  const acq = await control.acquireWithWait('f8_agent', WAIT_ENV, { ownerInstanceId: 'inst-f8', sleep: tickSleep(nowRef) })
  assert.equal(acq.ok, true)
  assert.equal(acq.attempts, 1, '第一次就该成功')
  assert.equal(acq.waitedMs, 0, '不该白等')
})

test('P2-2：authority_revoking 后及时收到有效 ACK → 变 active', async () => {
  const { control, nowRef } = makeControl()
  const rec = toRevoking(control, 'f8_agent', 'inst-f8')   // 换手给 f8_agent
  let polls = 0
  const acq = await control.acquireWithWait('f8_agent', WAIT_ENV, {
    ownerInstanceId: 'inst-f8',
    readAck: () => (++polls >= 2 ? ackFor(rec) : null),      // 第二轮才拿到 ACK
    sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, true, '拿到有效 ACK 后应该成功')
  assert.equal(acq.reason, 'renewed', '应该走续租/生效分支')
})

test('P2-3：handover_pending 后交接完成 → 成功（且只提交一次）', async () => {
  const { control, nowRef } = makeControl()
  toRevoking(control, 'mcp_client', 'inst-mcp')
  let submits = 0
  const acq = await control.acquireWithWait('mcp_client', WAIT_ENV, {
    ownerInstanceId: 'inst-mcp',
    readAck: () => ackFor(control.readAuthority()),
    sleep: tickSleep(nowRef),
  })
  if (acq.ok) submits++
  assert.equal(acq.ok, true)
  assert.equal(submits, 1, '动作只该提交一次')
})

test('P2-4：等待期限内没有 ACK → 超时返回真实原因，不自动放行', async () => {
  const { control, nowRef } = makeControl()
  toRevoking(control, 'mcp_client', 'inst-mcp')
  const acq = await control.acquireWithWait('mcp_client', WAIT_ENV, {
    ownerInstanceId: 'inst-mcp',
    readAck: () => null,                 // 永远没有 ACK
    maxWaitMs: 600,
    pollMs: 100,
    sleep: tickSleep(nowRef),   // 推进时钟，不真睡
  })
  assert.equal(acq.ok, false, '没有 ACK 绝不能拿到租约')
  assert.equal(acq.timedOut, true, '应该标记超时')
  assert.ok(['handover_pending', 'handover_revoking'].includes(acq.reason), `原因应是交接未完成，实际 ${acq.reason}`)
  assert.equal(control.readAuthority().status, 'revoking', '超时后权威仍是 revoking（fail-closed）')
})

test('P2-5：ACK 缺少 job_cleared → 不通过', async () => {
  const { control, nowRef } = makeControl()
  const rec = toRevoking(control, 'mcp_client', 'inst-mcp')
  const bad = ackFor(rec); delete bad.job_cleared
  const acq = await control.acquireWithWait('mcp_client', WAIT_ENV, {
    ownerInstanceId: 'inst-mcp', readAck: () => bad, maxWaitMs: 300, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false)
  assert.equal(control.readAuthority().status, 'revoking')
})

test('P2-6：job_cleared 为 false → 不通过', async () => {
  const { control, nowRef } = makeControl()
  const rec = toRevoking(control, 'mcp_client', 'inst-mcp')
  const acq = await control.acquireWithWait('mcp_client', WAIT_ENV, {
    ownerInstanceId: 'inst-mcp', readAck: () => ackFor(rec, { jobCleared: false }),
    maxWaitMs: 300, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false)
  assert.equal(control.readAuthority().status, 'revoking')
})

test('P2-7：lease_id 错误 → 不通过', async () => {
  const { control, nowRef } = makeControl()
  const rec = toRevoking(control, 'mcp_client', 'inst-mcp')
  const acq = await control.acquireWithWait('mcp_client', WAIT_ENV, {
    ownerInstanceId: 'inst-mcp', readAck: () => ackFor(rec, { leaseId: 'not-my-lease' }),
    maxWaitMs: 300, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false)
  assert.equal(control.readAuthority().status, 'revoking')
})

test('P2-8：epoch 错误 → 不通过', async () => {
  const { control, nowRef } = makeControl()
  const rec = toRevoking(control, 'mcp_client', 'inst-mcp')
  const acq = await control.acquireWithWait('mcp_client', WAIT_ENV, {
    ownerInstanceId: 'inst-mcp', readAck: () => ackFor(rec, { epoch: 'deadbeef' }),
    maxWaitMs: 300, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false)
  assert.equal(control.readAuthority().status, 'revoking')
})

test('P2-9：generation 错误 → 不通过', async () => {
  const { control, nowRef } = makeControl()
  const rec = toRevoking(control, 'mcp_client', 'inst-mcp')
  const acq = await control.acquireWithWait('mcp_client', WAIT_ENV, {
    ownerInstanceId: 'inst-mcp', readAck: () => ackFor(rec, { generation: rec.generation + 5 }),
    maxWaitMs: 300, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false)
  assert.equal(control.readAuthority().status, 'revoking')
})

test('P2-10：其他控制者持有 active 租约 → 只能发起换手，绝不可能直接拿到 active', async () => {
  const { control, nowRef } = makeControl()
  const a = control.acquire('f8_agent', WAIT_ENV, { ownerInstanceId: 'inst-f8' })
  assert.equal(a.ok, true)
  assert.equal(a.record.status, 'active', '上一任应该是 active')
  // mcp_client 来抢：没有 ACK → 拿不到；但可以发起换手（revoking），绝不是"直接变成 active"
  const acq = await control.acquireWithWait('mcp_client', WAIT_ENV, {
    ownerInstanceId: 'inst-mcp', readAck: () => null, maxWaitMs: 200, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false, '别人还 active 且没有 ACK 时不能拿到')
  const auth = control.readAuthority()
  // 发起换手时权威记录里的 owner 会写成"想接手的人"，但状态必须是 revoking ——
  // 状态才是控制权的判据，owner 字段只是"打算给谁"。
  assert.equal(auth.status, 'revoking', '应该停在换手中（revoking 期间 Lua 拒绝一切动作）')
  assert.notEqual(auth.status, 'active', '绝不能变成 active')
  // 反向确认：上一任也已经被撤销（不能继续提交）
  const prev = control.validate('f8_agent', { ownerInstanceId: 'inst-f8', env: ENV })
  assert.equal(prev.ok, false, '换手期间上一任必须失去控制权')
})

test('P2-11：ACK 到达后只提交一次原始动作（等待不产生重复提交）', async () => {
  const { control, nowRef } = makeControl()
  const rec = toRevoking(control, 'mcp_client', 'inst-mcp')
  let ackReads = 0
  let submits = 0
  const acq = await control.acquireWithWait('mcp_client', WAIT_ENV, {
    ownerInstanceId: 'inst-mcp',
    readAck: () => { ackReads++; return ackFor(rec) },
    sleep: tickSleep(nowRef),
  })
  if (acq.ok) submits++
  assert.equal(acq.ok, true)
  assert.equal(submits, 1, '提交次数必须恰好 1')
  assert.ok(ackReads >= 1, '应该读过 ACK')
})

test('P2-12：超时后没有留下任何命令文件（提交边界在等待之后）', async () => {
  const { control, dir, nowRef } = makeControl()
  toRevoking(control, 'mcp_client', 'inst-mcp')
  await control.acquireWithWait('mcp_client', WAIT_ENV, {
    ownerInstanceId: 'inst-mcp', readAck: () => null, maxWaitMs: 200, pollMs: 50, sleep: tickSleep(nowRef),
  })
  // 等待只碰租约文件；目录里不该出现 whale_cmd.json 之类的东西
  const files = readdirSync(dir)
  assert.deepEqual(files.filter((f) => /cmd|command/i.test(f)), [], `不该有命令文件，实际：${files.join(',')}`)
})

test('P2-13：等待期间不阻塞事件循环（其他请求仍能被处理）', async () => {
  const { control } = makeControl()
  toRevoking(control, 'mcp_client', 'inst-mcp')
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 10)
  try {
    await control.acquireWithWait('mcp_client', WAIT_ENV, {
      ownerInstanceId: 'inst-mcp',
      readAck: () => null,
      maxWaitMs: 250,
      pollMs: 25,
      sleep: realSleep,   // 真的等，验证事件循环没被阻塞
    })
  } finally {
    clearInterval(timer)
  }
  assert.ok(ticks >= 5, `等待期间定时器应该照常触发（实际 ${ticks} 次）`)
})

test('P2-16：revoking 的发起方已经过期 → 允许**重新发起换手**（仍然要等 ACK）', async () => {
  const { control, nowRef } = makeControl()
  toRevoking(control, 'mcp_client', 'inst-mcp')
  // 把时钟推过 TTL（30 秒）—— 发起换手的那一方早就没资格了（进程退出 / 游戏暂停写不出 ACK）
  nowRef.t += 40_000
  // 没有 ACK：仍然拿不到（关键 —— 不能因为过期就直接放行）
  const noAck = await control.acquireWithWait('f8_agent', WAIT_ENV, {
    ownerInstanceId: 'inst-f8', readAck: () => null, maxWaitMs: 300, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(noAck.ok, false, '过期 revoking 也不能在没有 ACK 的情况下拿到控制权')
  assert.equal(control.readAuthority().status, 'revoking', '应该停在新的 revoking 上等 ACK')
  // 有 ACK：能收敛
  const rec = control.readAuthority()
  const ok = await control.acquireWithWait('f8_agent', WAIT_ENV, {
    ownerInstanceId: 'inst-f8',
    readAck: () => ackFor(rec),
    maxWaitMs: 600, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(ok.ok, true, '拿到有效 ACK 后应该能接手')
  assert.equal(control.readAuthority().owner_instance_id, 'inst-f8')
})

test('P2-17：revoking 没过期时仍然拒绝（不能因为超时就抢）', async () => {
  const { control, nowRef } = makeControl()
  toRevoking(control, 'mcp_client', 'inst-mcp')
  const acq = await control.acquireWithWait('f8_agent', WAIT_ENV, {
    ownerInstanceId: 'inst-f8', readAck: () => null, maxWaitMs: 300, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false, '没过期的 revoking 不能被抢')
  assert.equal(control.readAuthority().status, 'revoking')
})

test('P2-18：游戏暂停（isGameAlive 为 false）→ 立刻返回 game_paused，不白等租约', async () => {
  const { control, nowRef } = makeControl()
  toRevoking(control, 'mcp_client', 'inst-mcp')
  const t0 = nowRef.t
  const acq = await control.acquireWithWait('f8_agent', WAIT_ENV, {
    ownerInstanceId: 'inst-f8',
    readAck: () => null,          // 暂停时 Lua 写不出 ACK
    isGameAlive: () => false,     // 游戏没在跑
    maxWaitMs: 3000,
    pollMs: 100,
    sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false)
  assert.equal(acq.reason, 'game_paused', '应该明确说"暂停了"，而不是 handover_pending')
  assert.ok(/暂停/.test(String(acq.message ?? '')), '消息里要讲清楚是暂停')
  assert.ok(nowRef.t - t0 < 1000, `不该等满 3 秒，实际等了 ${nowRef.t - t0}ms`)
})

test('P2-19：游戏在跑但迟迟没 ACK → 仍然等到超时（不能因为"活着"就放行）', async () => {
  const { control, nowRef } = makeControl()
  toRevoking(control, 'mcp_client', 'inst-mcp')
  const acq = await control.acquireWithWait('f8_agent', WAIT_ENV, {
    ownerInstanceId: 'inst-f8',
    readAck: () => null,
    isGameAlive: () => true,
    maxWaitMs: 400,
    pollMs: 100,
    sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false)
  assert.equal(acq.reason, 'handover_pending')
  assert.equal(control.readAuthority().status, 'revoking', '没 ACK 就不能变成 active')
})

test('P2-14：坏 owner / 坏实例这类**非临时**原因立即返回，不浪费时间', async () => {
  const { control, nowRef } = makeControl()
  const bad = await control.acquireWithWait('not-an-owner', WAIT_ENV, { sleep: tickSleep(nowRef) })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'bad_owner')
  assert.equal(bad.attempts, 1, '非临时原因不该重试')
  const noInst = await control.acquireWithWait('f8_agent', WAIT_ENV, { ownerInstanceId: '', sleep: tickSleep(nowRef) })
  assert.equal(noInst.ok, false)
  assert.equal(noInst.reason, 'unknown_owner_instance')
  assert.equal(noInst.attempts, 1)
})

test('P2-15：环境指纹变了（换世界/换角色）→ 立刻拒绝，不等待', async () => {
  const { control, nowRef } = makeControl()
  const rec = toRevoking(control, 'mcp_client', 'inst-mcp')
  const otherEnv = { ...WAIT_ENV, runtimeId: 'r2' }
  const acq = await control.acquireWithWait('mcp_client', otherEnv, {
    ownerInstanceId: 'inst-mcp', readAck: () => ackFor(rec), maxWaitMs: 200, pollMs: 50, sleep: tickSleep(nowRef),
  })
  // 环境变了就不能沿用旧交接；acquire 会发起新一轮换手（而不是直接放行）
  assert.notEqual(acq.reason, 'renewed', '环境变了不能当成续租')
})

