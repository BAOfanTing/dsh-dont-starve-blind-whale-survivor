// M2.0.2 · 跨进程 / owner 粒度 / generation fencing 修复后的安全回归测试
//
// 这些用例在 M2.0.1 里是"证明漏洞存在"的复现；本轮全部**反转成安全断言**并补充新场景。
// 证据类型：UNIT（真实独立 Node 进程 + fengari 沙箱）；真机结论见 docs/M2_0_2_security_test_report.md
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { LeaseManager, isVerifiableAuthority } from '../lib/control.js'
import { authority, command, luaIoFiles } from './helpers-m2.mjs'

const execFileAsync = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKER = join(ROOT, 'tools', 'm2_0_1-lease-worker.mjs')
const ENV = { runtimeId: 'r-repro-0001', sessionId: 'sess-R', shardId: '1', actorId: 'player:KU_r' }

function runWorker(file, owner, instanceId, startAt, force = '') {
  return execFileAsync(process.execPath, [WORKER, file, owner, instanceId, String(startAt), force], { cwd: ROOT, timeout: 15000 })
    .then(({ stdout }) => JSON.parse(stdout.trim()))
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
  for (const name of ['json', 'util', 'config', 'actor', 'nearby', 'guard', 'observe', 'actions', 'macros', 'bridge']) {
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
    assert.equal(c.completeHandover(null).reason, 'handover_ack_invalid')
    assert.equal(c.readAuthority().status, 'revoking', '拿不到确认绝不自动放行')
    // 确认不匹配也不能完成
    assert.equal(c.completeHandover({ authority_epoch: 'wrong', generation: 2, runtime_id: 'r-repro-0001' }).reason, 'handover_ack_invalid')
    // 有效确认 → active
    const fresh = c.readAuthority()
    const done = c.completeHandover({ authority_epoch: fresh.authority_epoch, generation: fresh.generation, runtime_id: fresh.runtime_id })
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
