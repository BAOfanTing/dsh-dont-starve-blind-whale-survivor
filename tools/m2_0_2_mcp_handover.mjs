// M2.0.2 真机：MCP 网络入口 ↔ 另一控制主体（f8_agent 身份）的换手验证
//
// 真实部分：MCP 服务是产品 apply() 启动的 HTTP 服务（18090），tools/call 走真实 executeTool → dispatcher。
// 模拟部分：F8 侧不启动 AI 循环（会真的让模型自主玩游戏），改用**同一协议、同一权威租约文件**
//           的另一个 LeaseManager 实例以 f8_agent 身份抢租约。
// 标注：MCP 网络端真实；F8 入口为「同协议独立控制主体」，不是 F8 按键启动的 AI 循环。
import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { GameBridge, stripKleiHeader } from '../lib/bridge.js'
import { LeaseManager, envFingerprintOf } from '../lib/control.js'
import { normalizeState } from '../lib/state/snapshot.js'

const MCP = 'http://127.0.0.1:18090/mcp'
const ROOT = process.cwd()

async function rpc(method, params) {
  const r = await fetch(MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await r.text()
  const raw = text.includes('data:')
    ? text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
    : text
  return { http: r.status, body: JSON.parse(raw) }
}

async function mcpCall(name, args) {
  const out = await rpc('tools/call', { name, arguments: args })
  return (out.body.result?.content ?? []).map((c) => c.text).join('\n') || JSON.stringify(out.body.error ?? {})
}

const bridge = new GameBridge({ log: () => {} })
const state = bridge.readState()
const snap = normalizeState(state.json, { ageMs: state.ageMs })
const env = envFingerprintOf(snap)
console.log('环境:', JSON.stringify(env), '| mod:', state.json.mod, '| actor:', snap.actor?.actorId, '| alive:', snap.actor?.alive)

const authorityFile = `${ROOT}/.runtime/m2-control.json`
const dirs = bridge.leaseDirs()

/** 清掉残留 ack，避免旧 epoch 的确认干扰 */
function cleanAcks() {
  for (const { dir } of dirs) {
    for (const name of ['whale_lease_ack.json', 'whale_io_lease_ack.json']) {
      try { unlinkSync(`${dir}/${name}`) } catch {}
    }
  }
}

/** 用另一个 LeaseManager 以 f8_agent 身份抢租约（模拟另一个控制进程） */
function f8Acquire(label) {
  const c = new LeaseManager({ file: authorityFile, authorityDirs: () => dirs, now: () => Date.now(), ownerInstanceId: 'f8-sim-instance' })
  return c.acquire('f8_agent', env, { ownerInstanceId: 'f8-sim-instance' })
}

/** 等 Lua 写出有效 ack 并让 MCP 侧完成换手（MCP 内部每次 dispatch 会尝试 completeHandover） */
async function waitAck(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ack = bridge.readLeaseAck()
    if (ack) return ack
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

const results = []
const record = (label, value) => { results.push({ label, value }); console.log(`[${label}] ${String(value).slice(0, 200)}`) }

cleanAcks()
// 清掉上一轮残留的 revoking 权威状态，从干净状态开始
for (const { dir } of dirs) {
  for (const name of ['whale_lease.json', 'whale_io_lease.json']) {
    try { unlinkSync(`${dir}/${name}`) } catch {}
  }
}
try { unlinkSync(authorityFile) } catch {}

// ── 1) MCP 首次动作：自动 acquire('mcp_client')，应能执行 stop ──
record('A1 MCP 首次 stop', await mcpCall('stop', {}))

// ── 2) 另一控制主体（f8_agent）抢租约 → 应进入 revoking 且换代 ──
const handover1 = f8Acquire('F8 抢占')
record('A2 f8_agent 抢租约', JSON.stringify({ ok: handover1.ok, reason: handover1.reason, gen: handover1.lease?.generation, status: handover1.lease?.status }))
const ack1 = await waitAck()
record('A3 Lua 换手确认', ack1 ? JSON.stringify(ack1) : '（没读到）')

// ── 3) MCP 再发动作：租约已被抢走 → 必须明确拒绝，且命令不进游戏 ──
const cmdBefore = await mcpCall('get_state', { format: 'json' })
record('A4 MCP 再次 stop（应 control_denied）', await mcpCall('stop', {}))

// ── 4) 让 MCP 重新拿回控制权（新 acquire → 新 generation）──
// MCP 的 acquire 在每次 tools/call 里发生；先让另一个主体释放再调
const c2 = new LeaseManager({ file: authorityFile, authorityDirs: () => dirs, now: () => Date.now(), ownerInstanceId: 'f8-sim-instance' })
c2.release('f8_agent', { ownerInstanceId: 'f8-sim-instance' })
cleanAcks()
record('A5 MCP 重新 stop（第一次可能仍在等待确认）', await mcpCall('stop', {}))
await new Promise((r) => setTimeout(r, 800))
record('A5b MCP 再 stop（应完成换手并成功）', await mcpCall('stop', {}))
const ack2 = await waitAck()
record('A6 新确认', ack2 ? JSON.stringify(ack2) : '（没读到）')

// ── 5) 检查最终权威状态 ──
const final = new LeaseManager({ file: authorityFile, now: () => Date.now() }).readAuthority()
record('A7 最终权威', JSON.stringify({ status: final?.status, gen: final?.generation, owner: final?.owner_type, instance: final?.owner_instance_id, epoch: final?.authority_epoch }))

// ── 6) 角色坐标（确认没有误操作）──
const s2 = bridge.readState()
const n2 = normalizeState(s2.json, { ageMs: s2.ageMs })
record('A8 角色坐标', JSON.stringify({ tileX: n2.actor?.tileX, tileZ: n2.actor?.tileZ }))

console.log('\n=== 汇总 ===')
for (const r of results) console.log(`${r.label}: ${String(r.value).slice(0, 160)}`)
