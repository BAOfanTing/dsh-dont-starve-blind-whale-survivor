// M2.0.1 · 跨进程 / owner 粒度 / generation fencing 复现测试（审查用，不修代码）
//
// 证据类型：UNIT（独立 Node 进程 + fengari 沙箱）；真机结论见 docs/M2_0_1_lease_security_audit.md
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { LeaseManager } from '../lib/control.js'

const execFileAsync = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKER = join(ROOT, 'tools', 'm2_0_1-lease-worker.mjs')
const ENV = { runtimeId: 'r-repro-0001', sessionId: 'sess-R', shardId: '1', actorId: 'player:KU_r' }

function runWorker(file, owner, startAt, force = '') {
  return execFileAsync(process.execPath, [WORKER, file, owner, String(startAt), force], { cwd: ROOT, timeout: 15000 })
    .then(({ stdout }) => JSON.parse(stdout.trim()))
}

// ─────────────────────────── 问题 A：跨进程 ───────────────────────────

test('A-1 两个独立 Node 进程同时 acquire（不同 owner）→ 都成功、generation 相同、文件被后写覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-lease-race-'))
  const file = join(dir, 'm2-control.json')
  const startAt = Date.now() + 300
  try {
    const [a, b] = await Promise.all([
      runWorker(file, 'f8_agent', startAt),
      runWorker(file, 'mcp_client', startAt),
    ])
    // 记录事实（不预设结果，用断言钉住"缺陷确实存在"）
    assert.equal(a.ok, true, '进程 A 会认为自己拿到了租约')
    assert.equal(b.ok, true, '进程 B 也认为自己拿到了租约 —— 互斥失效')
    assert.equal(a.generation, b.generation, '两个进程拿到了同一个 generation')
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.generation, a.generation)
    assert.ok(
      onDisk.owner === 'f8_agent' || onDisk.owner === 'mcp_client',
      '文件里只剩一个 owner（后写覆盖先写），但两个进程都以为自己是持有者',
    )
    console.log('  [A-1] 双进程结果:', JSON.stringify({ a, b, onDisk }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A-2 一个进程写入租约后，另一个进程新建 LeaseManager 才看得见；已有实例看不到别人的更新', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-lease-stale-'))
  const file = join(dir, 'm2-control.json')
  try {
    const p1 = new LeaseManager({ file, now: () => 1000, ttlMs: 30000 })
    const p2 = new LeaseManager({ file, now: () => 1000, ttlMs: 30000 })
    p1.acquire('f8_agent', ENV) // 文件里 generation=1, owner=f8_agent
    const r = p2.acquire('mcp_client', ENV) // p2 的内存里仍是它构造时看到的（空）
    assert.equal(r.ok, true, 'p2 基于旧内存快照，认为自己也拿到了控制权')
    assert.equal(r.lease.generation, 1, 'generation 没有递增（各自从空算起）')
    console.log('  [A-2] p2 结果:', JSON.stringify(r), '| 磁盘:', readFileSync(file, 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A-3 崩溃恢复：租约落盘、进程挂掉后靠 TTL 过期自然恢复；但 generation 不会被真正"锁"住', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-lease-crash-'))
  const file = join(dir, 'm2-control.json')
  try {
    const now = { value: 1000 }
    const p1 = new LeaseManager({ file, now: () => now.value, ttlMs: 1000 })
    p1.acquire('f8_agent', ENV)
    // 模拟 p1 进程崩溃：没有 release
    now.value = 5000
    const p2 = new LeaseManager({ file, now: () => now.value, ttlMs: 1000 })
    const r = p2.acquire('mcp_client', ENV)
    assert.equal(r.ok, true)
    assert.equal(r.lease.generation, 2, '过期后重新获取会 +1（这一点是对的）')
    assert.equal(r.reason, 'expired_reacquired')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A-4 锁文件/原子 CAS 是否存在（静态事实）', () => {
  const src = readFileSync(join(ROOT, 'lib', 'control.js'), 'utf8')
  assert.ok(src.includes('renameSync'), '只有 tmp+rename 的原子写')
  assert.ok(!/flock|lockfile|mkdirSync\(.*lock|O_EXCL|compare-and-swap|CAS/.test(src), '没有任何独立跨进程锁 / CAS')
  assert.ok(!/this\._load\(\)/.test(src.slice(src.indexOf('acquire(owner')).slice(0, 1200)), 'acquire 里没有重新读盘')
})

// ─────────────────────────── 问题 B：owner 粒度 ───────────────────────────

test('B-1 两个不同的 MCP 客户端（同为 mcp_client）被当成同一持有者 → 续租而非拒绝', () => {
  const c = new LeaseManager({ file: '', now: () => 1000 })
  c.acquire('mcp_client', ENV) // 客户端 #1
  const r = c.acquire('mcp_client', ENV) // 客户端 #2（不同实例）
  assert.equal(r.ok, true, '第二个 MCP 客户端也拿到了"控制权"')
  assert.equal(r.reason, 'renewed', '被当作续租，generation 不变')
  assert.equal(r.lease.generation, 1)
})

test('B-2 两个不同的 F8 Agent 实例（同为 f8_agent）同理', () => {
  const c = new LeaseManager({ file: '', now: () => 1000 })
  c.acquire('f8_agent', ENV)
  const r = c.acquire('f8_agent', ENV)
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'renewed')
})

test('B-3 同一 owner 过期后重取 → generation +1（这一点是对的）', () => {
  const now = { value: 1000 }
  const c = new LeaseManager({ file: '', now: () => now.value, ttlMs: 1000 })
  c.acquire('f8_agent', ENV)
  now.value = 5000
  const r = c.acquire('f8_agent', ENV)
  assert.equal(r.ok, true)
  assert.equal(r.lease.generation, 2)
  assert.equal(r.reason, 'expired_reacquired')
})

test('B-4 当前租约结构里没有 instance_id（静态事实）', () => {
  const c = new LeaseManager({ file: '', now: () => 1000 })
  const l = c.acquire('mcp_client', ENV).lease
  assert.equal(l.owner, 'mcp_client')
  assert.equal(l.instanceId, undefined, '没有实例标识')
  assert.equal(l.owner_instance_id, undefined, '没有实例标识')
})

// ─────────────────────────── 问题 C：Lua fencing 时序 ───────────────────────────

// 用 fengari 真跑 guard.lua；STUB 来自 m2-lua-guard.test.mjs
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
GLOBAL.io = nil
pcall = nil tonumber = nil error = nil os = nil io = nil
`

async function guardVm() {
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
  run('Whale = { verbose = false, version = "0.14.0" }')
  for (const name of ['json', 'util', 'config', 'actor', 'nearby', 'guard', 'observe']) {
    run(readFileSync(join(ROOT, 'DontStarveWhaleSurvivor', 'scripts', 'whale', name + '.lua'), 'utf8'))
  }
  run('Whale.config.build(function(k) if k == "scan_radius" then return 16 end return nil end)')
  const cmd = (gen, id) => `
    CMD = {
      protocol_version = 1, command_id = "${id}", action = "move_to", args = { x = 3, z = 4 },
      requested_by = "f8_agent", lease_generation = ${gen}, lease_expires_at = NOW_MS + 30000,
      runtime_id = Whale.nearby.runtime_id(), session_id = "sess-R", shard_id = "1",
      actor_id = "player:KU_r", created_at = NOW_MS, expires_at = NOW_MS + 8000,
    }`
  const validate = () => {
    run('local ok, why = Whale.guard.validate(CMD); OUT = tostring(ok) .. "|" .. tostring(why)')
    return get('OUT')
  }
  return { run, get, cmd, validate }
}

test('C-1 关键时序：gen=13 已在 Node 生效但 Lua 只见过 12 → 旧命令 A(12) 仍被执行', async () => {
  const env = await guardVm()
  env.run('Whale.guard.reset(); Whale.guard.forget_ids()')

  // 1) F8 拿 gen=12，写入 command A，但**还没被 Lua 处理**
  env.run(env.cmd(12, 'cmd-A'))
  assert.equal(env.validate(), 'true|nil', '命令 A 本身合法')

  // 2) MCP 换手拿到 gen=13（Node 侧），但 MCP **先不发动作** → Lua 没有任何机会看到 13
  //    （这里刻意不调用 accept(13)）

  // 3) Lua 现在读取旧 command A
  assert.equal(env.validate(), 'true|nil', '★ 漏洞：旧 generation 命令被执行（Lua 只比较"见过的最高世代" 12）')
  env.run('OUT2 = tostring(Whale.guard.lease_state().generation)')
  assert.equal(env.get('OUT2'), '0', 'Lua 甚至还没见过任何世代（因为 A 只是 validate 未 accept）')
})

test('C-2 只要 Lua 先见过 13，12 就会被拒（现有测试只覆盖这个较弱场景）', async () => {
  const env = await guardVm()
  env.run('Whale.guard.reset(); Whale.guard.forget_ids()')
  env.run(env.cmd(13, 'cmd-new'))
  assert.equal(env.validate(), 'true|nil')
  env.run('Whale.guard.accept(CMD)')
  env.run(env.cmd(12, 'cmd-old'))
  assert.equal(env.validate(), 'false|stale_generation')
})

test('C-3 伪造一个更大的 generation 能污染 Lua 的最高世代（无权威来源核对）', async () => {
  const env = await guardVm()
  env.run('Whale.guard.reset(); Whale.guard.forget_ids()')
  env.run(env.cmd(999, 'cmd-forged'))
  assert.equal(env.validate(), 'true|nil', 'gen=999 被接受')
  env.run('Whale.guard.accept(CMD)')
  env.run('OUT = tostring(Whale.guard.lease_state().generation)')
  assert.equal(env.get('OUT'), '999', '最高世代被污染；之后所有正常命令都会被拒')
})

test('C-4 Node 是否向 Lua 提供独立的当前有效 generation / holder 文件（静态事实）', () => {
  const bridgeLua = readFileSync(join(ROOT, 'DontStarveWhaleSurvivor', 'scripts', 'whale', 'bridge.lua'), 'utf8')
  const dispatcherSrc = readFileSync(join(ROOT, 'lib', 'dispatcher.js'), 'utf8')
  const controlSrc = readFileSync(join(ROOT, 'lib', 'control.js'), 'utf8')
  assert.ok(!/lease.*file|control.*json|generation.*file/i.test(bridgeLua), 'Lua 不读任何租约文件')
  assert.ok(!/writeFileSync/.test(controlSrc.replace(/import[\s\S]*?from 'node:fs'\n/, '')) || true) // 只做记录
  assert.ok(dispatcherSrc.includes('lease_generation: lease.generation'), '只在命令里带 generation')
  // lease 文件只由 LeaseManager 写，Lua 不消费
  assert.ok(!/m2-control/.test(bridgeLua), 'bridge.lua 不知道租约文件')
})

test('C-5 非当前持有者的命令：Lua 只看 generation，不核对 owner', async () => {
  const env = await guardVm()
  env.run('Whale.guard.reset(); Whale.guard.forget_ids()')
  env.run(env.cmd(13, 'cmd-new'))
  env.run('CMD.requested_by = "mcp_client"')
  assert.equal(env.validate(), 'true|nil')
  env.run('Whale.guard.accept(CMD)')
  // 之后另一个 owner 用同一代发命令，Lua 不会拒绝（只要 gen 不小于最高世代）
  env.run(env.cmd(13, 'cmd-other'))
  env.run('CMD.requested_by = "f8_agent"')
  assert.equal(env.validate(), 'true|nil', 'Lua 不核对"当前持有者是谁"')
})

// ─────────────────────────── 问题 D：过期 / 环境 ───────────────────────────

test('D-1 单位一致性：Node Date.now() 与 Lua os.time()*1000 都是墙钟毫秒', async () => {
  const env = await guardVm()
  env.run('OUT = tostring(Whale.guard.clock_ms())')
  const luaNow = Number(env.get('OUT'))
  const nodeNow = Date.now()
  // 沙箱里 NOW_MS 是固定的 1794500000000（对应 2026-11），与真实 Date.now() 不同数量级也正常
  assert.ok(Number.isFinite(luaNow))
  assert.ok(Number.isFinite(nodeNow))
  const src = readFileSync(join(ROOT, 'DontStarveWhaleSurvivor', 'scripts', 'whale', 'guard.lua'), 'utf8')
  assert.ok(src.includes('1000.0'), 'Lua 用 os.time()*1000.0 → 毫秒')
  assert.ok(readFileSync(join(ROOT, 'lib', 'control.js'), 'utf8').includes('expiresAt: now + this.ttlMs'))
  assert.ok(readFileSync(join(ROOT, 'lib', 'dispatcher.js'), 'utf8').includes('expires_at: createdAt + commandTtlMs'))
})

test('D-2 租约过期后同 owner 重取换代；runtime/session/shard/actor 变化也换代', () => {
  const now = { value: 1000 }
  const c = new LeaseManager({ file: '', now: () => now.value, ttlMs: 1000 })
  c.acquire('f8_agent', ENV)
  now.value = 5000
  const r = c.acquire('f8_agent', ENV)
  assert.equal(r.lease.generation, 2)

  for (const patch of [{ runtimeId: 'r-new' }, { sessionId: 'sess-B' }, { shardId: '2' }, { actorId: 'player:KU_y' }]) {
    const fresh = new LeaseManager({ file: '', now: () => 1000 })
    fresh.acquire('f8_agent', ENV)
    const rr = fresh.acquire('f8_agent', { ...ENV, ...patch })
    assert.equal(rr.lease.generation, 2, JSON.stringify(patch))
  }
})

test('D-3 命令 TTL(8s) < 租约 TTL(30s)：换手后旧命令最迟 8 秒失效，但 8 秒内仍可执行', async () => {
  const env = await guardVm()
  env.run('Whale.guard.reset(); Whale.guard.forget_ids()')
  env.run(env.cmd(12, 'cmd-A'))
  env.run('CMD.expires_at = NOW_MS + 8000')
  assert.equal(env.validate(), 'true|nil', '8 秒内的旧命令会执行（C-1 的窗口期）')
  env.run('CMD.expires_at = NOW_MS - 1')
  assert.equal(env.validate(), 'false|command_expired')
})
