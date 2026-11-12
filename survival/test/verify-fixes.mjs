// Phase 5 M2 · 两个阻塞项修复的真机验证
//
// 验证 A（net.lua 自愈）：游戏连上后，故意重启 Bridge，观察游戏是否**自动**恢复
//   心跳 / telemetry / 命令轮询（之前每次重启都会永久断掉，命令永远 QUEUED）。
// 验证 B（动作终态回执）：move_to 后命令应从 EXECUTING 走到 SUCCEEDED/FAILED，
//   而不是启动即终态；并核对最终结果带真实位移/失败原因。
//
// 脚本自己会重启 Bridge（用仓库里已编译的新版），跑完把控制权清干净。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const TOKEN = readFileSync(join(REPO, '.runtime', 'token.txt'), 'utf8').trim()
const BRIDGE = 'http://127.0.0.1:18788'
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
const post = async (path, body) => {
  const r = await fetch(BRIDGE + path, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}) })
  return { status: r.status, json: await r.json() }
}
const get = async (path) => {
  const r = await fetch(BRIDGE + path, { headers: H })
  return { status: r.status, json: await r.json() }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cmdStatus = async (id) => {
  const all = await get('/api/v1/commands')
  return (all.json.commands ?? []).find((c) => c.id === id)
}
const waitCmd = async (id, seconds = 15) => {
  for (let i = 0; i < seconds * 2; i += 1) {
    const r = await cmdStatus(id)
    if (r && !['QUEUED', 'DELIVERED', 'EXECUTING'].includes(r.status)) return r
    await sleep(500)
  }
  return await cmdStatus(id)
}
const bridgeStatus = async () => (await get('/api/v1/bridge/status')).json.bridge

console.log('=== ① 等游戏会话连上（最多 90 秒）===')
let ready = false
for (let i = 0; i < 45; i += 1) {
  try {
    const s = await get('/api/v1/state')
    const b = await bridgeStatus()
    if (i % 5 === 0) console.log(`  t+${i * 2}s alive=${s.json.session?.alive} connected=${b?.connected} stale=${s.json.stale}`)
    if (s.json.session?.alive === true && s.json.stale === false && b?.connected === true) { ready = true; break }
  } catch {}
  await sleep(2000)
}
if (!ready) { console.log('  ❌ 游戏没连上，终止'); process.exit(1) }
const s0 = await get('/api/v1/state')
console.log(`  就绪: session=${s0.json.session?.session_id} 玩家=${s0.json.snapshot?.player?.name} 位置=(${s0.json.snapshot?.player?.position?.tile_x},${s0.json.snapshot?.player?.position?.tile_z})`)

console.log('\n=== ② 故意重启 Bridge（这是之前导致通道永久断掉的操作）===')
try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-NetTCPConnection -LocalPort 18788 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`
  ], { encoding: 'utf8' })
  console.log('  已停旧 Bridge')
} catch (e) { console.log('  停旧 Bridge 出错（继续）:', String(e).slice(0, 120)) }
await sleep(1200)
const { spawn } = await import('node:child_process')
const child = spawn('E:\\APP\\node.js\\node.exe', [join(REPO, 'game-bridge', 'dist', 'src', 'index.js')], {
  cwd: join(REPO, 'game-bridge'),
  env: { ...process.env, BWS_TOKEN: TOKEN, BWS_PORT: '18788', BWS_HOST: '127.0.0.1', NODE_ENV: 'development' },
  detached: true, stdio: 'ignore',
})
child.unref()
console.log(`  新 Bridge PID=${child.pid}`)

console.log('\n=== ③ 观察 net.keepAlive 是否自动恢复（最多 40 秒）===')
let recovered = false
for (let i = 0; i < 20; i += 1) {
  await sleep(2000)
  try {
    const b = await bridgeStatus()
    const s = await get('/api/v1/state')
    if (i % 2 === 0) console.log(`  t+${(i + 1) * 2}s connected=${b?.connected} alive=${s.json.session?.alive} stale=${s.json.stale} 心跳距=${b?.last_heartbeat_ago_ms}ms`)
    if (b?.connected === true && s.json.session?.alive === true && s.json.stale === false) { recovered = true; break }
  } catch {}
}
console.log(`  自愈结果: ${recovered ? '✅ 自动恢复（之前会永久断）' : '❌ 未恢复'}`)
if (!recovered) { console.log('  终止后续动作验证'); process.exit(2) }

console.log('\n=== ④ 授权控制权 ===')
const lease = Date.now() + 120000
const sync = await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: 'FIX_C1', session_id: 'S1',
  lease_expires_at: lease, emergency_stop: false, reason: '两个修复的真机验证',
})
console.log(`  sync HTTP ${sync.status} holder=${sync.json.control?.holder}`)

console.log('\n=== ⑤ 下发 move_to，验证完整回执链路（EXECUTING → 终态）===')
const pos = (await get('/api/v1/state')).json.snapshot.player.position
const tx = Math.round(pos.x / 4) + 2
const tz = Math.round(pos.z / 4)
console.log(`  起点 (${pos.tile_x},${pos.tile_z}) → 目标 (${tx},${tz})`)
const enq = await post('/api/v1/commands/enqueue', {
  type: 'move_to', controller_id: 'FIX_C1', session_id: 'S1',
  params: { x: tx, z: tz, timeout: 25 },
})
console.log(`  enqueue HTTP ${enq.status} id=${enq.json.command?.id}`)
const id = enq.json.command?.id

// 先等 3 秒看是不是 EXECUTING（中间态）
await sleep(3000)
const mid = await cmdStatus(id)
console.log(`  t+3s 状态=${mid?.status} result=${JSON.stringify(mid?.result).slice(0, 200)}`)

// 再等终态
const final = await waitCmd(id, 20)
console.log(`  终态=${final?.status} result=${JSON.stringify(final?.result).slice(0, 350)} err=${final?.error ?? '-'}`)

const pos2 = (await get('/api/v1/state')).json.snapshot.player.position
console.log(`  终点 (${pos2.tile_x},${pos2.tile_z}) x=${pos2.x} 位移=${pos.x !== pos2.x || pos.z !== pos2.z}`)

console.log('\n=== ⑥ 清理 ===')
await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: null, session_id: null, lease_expires_at: null,
  emergency_stop: false, reason: '收尾',
})
const c = await get('/api/v1/control/status')
console.log(`  最终 control: mode=${c.json.control?.mode} holder=${c.json.control?.holder}`)
console.log('\n=== 完成 ===')
