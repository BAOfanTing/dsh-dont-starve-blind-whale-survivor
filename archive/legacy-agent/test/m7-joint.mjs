// Phase 5 M7 · DeepSeek 联合测试（真机）
//
// 流程：授权控制权 → 用 supervised 档启动 Agent → 让 DeepSeek 自己观察并行动
// → 记录它调了哪些工具、说了什么、动作是否真的生效。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKEN = readFileSync(join(HERE, '..', '..', '.runtime', 'token.txt'), 'utf8').trim()
const B = 'http://127.0.0.1:18788'
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
const post = async (p, b) => {
  const r = await fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })
  return { status: r.status, json: await r.json().catch(() => null) }
}
const get = async (p) => ({ json: await (await fetch(B + p, { headers: H })).json().catch(() => null) })

console.log('=== ① 游戏连接检查 ===')
const s = (await get('/api/v1/state')).json
const b = (await get('/api/v1/bridge/status')).json
if (!s?.session?.alive || !b?.bridge?.connected) {
  console.log(`  ❌ 游戏没连上 alive=${s?.session?.alive} connected=${b?.bridge?.connected}`)
  process.exit(1)
}
const p0 = s.snapshot.player
console.log(`  ${p0.name} hp=${p0.health.percent}% hunger=${p0.hunger.percent}% 位置=(${p0.position.tile_x},${p0.position.tile_z}) 第${s.snapshot.world.day}天 ${s.snapshot.world.phase}`)
console.log(`  背包: ${JSON.stringify((Array.isArray(s.snapshot.inventory.items) ? s.snapshot.inventory.items : []).map((i) => `${i.prefab}x${i.count ?? 1}`))}`)

console.log('\n=== ② 授予控制权（模拟"主人同意 AI 动手"）===')
const sync = await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: 'DEEPSEEK_M7', session_id: 'M7S',
  lease_expires_at: Date.now() + 1800000, emergency_stop: false, reason: 'M7 联合测试',
})
console.log(`  sync ${sync.status} holder=${sync.json?.control?.holder} mode=${sync.json?.control?.mode}`)

// 检查 Agent API 是否在跑
console.log('\n=== ③ 检查 Agent HTTP API ===')
let agentOk = false
try {
  const r = await fetch('http://127.0.0.1:8791/health')
  const j = await r.json().catch(() => null)
  console.log(`  Agent API: ${r.status} ${JSON.stringify(j).slice(0, 300)}`)
  agentOk = r.ok
} catch (e) {
  console.log(`  ❌ Agent API 不可达（127.0.0.1:8791）：${String(e).slice(0, 120)}`)
  console.log('  提示：需要先启动 agent（BWS_TOOL_PERMISSION=supervised）')
}

if (!agentOk) {
  console.log('\n=== 结论 ===')
  console.log('  控制权已授予，但 Agent 没在跑。需要：')
  console.log('  1. 启动 Agent：cd agent; $env:BWS_TOOL_PERMISSION="supervised"; node dist/src/index.js')
  console.log('  2. 再跑这个脚本')
  await post('/api/v1/control/sync', {
    mode: 'SUPERVISED', holder: null, session_id: null, lease_expires_at: null,
    emergency_stop: false, reason: 'M7 中止',
  })
  process.exit(2)
}

console.log('\n=== ④ 让 DeepSeek 自己观察 + 行动 ===')
const prompt = [
  '现在是饥荒游戏里的真实场景。请你自己观察并决定做什么：',
  '1. 先查玩家状态、背包、附近有什么；',
  '2. 根据当前处境（血量/饥饿/昼夜/附近资源）决定最该做的事；',
  '3. 如果决定动手，先查控制权，然后用合适的工具执行（写动作要带 confirmed=true）；',
  '4. 执行后看 verify 字段，如实告诉我到底拿到了什么。',
  '请用中文简短汇报，不要编造数据。',
].join('\n')
console.log(`  提问：${prompt.slice(0, 100)}...`)

const t0 = Date.now()
try {
  const r = await fetch('http://127.0.0.1:8791/api/agent/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ session_id: 'M7S', conversation_id: 'm7-joint', message: prompt, with_assessment: true }),
  })
  const j = await r.json()
  console.log(`\n  HTTP ${r.status}（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`)
  console.log('\n=== 原始响应结构 ===')
  console.log('  keys: ' + Object.keys(j).join(', '))
  console.log('\n=== DeepSeek 的回答 ===')
  console.log(String(j.reply ?? j.message ?? j.content ?? JSON.stringify(j)).slice(0, 3000))

  if (Array.isArray(j.toolCalls) && j.toolCalls.length > 0) {
    console.log(`\n=== 它调用的工具（${j.toolCalls.length} 次）===`)
    for (const tc of j.toolCalls) {
      console.log(`  ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 120)}) → ok=${tc.ok} ${tc.errorCode ?? ''}`)
    }
  }
} catch (e) {
  console.log(`  ❌ 调用失败：${String(e).slice(0, 300)}`)
}

console.log('\n=== ⑤ 对比游戏真实状态 ===')
const s2 = (await get('/api/v1/state')).json
const p2 = s2.snapshot.player
console.log(`  ${p2.name} hp=${p2.health.percent}% hunger=${p2.hunger.percent}% 位置=(${p2.position.tile_x},${p2.position.tile_z})`)
console.log(`  背包: ${JSON.stringify((Array.isArray(s2.snapshot.inventory.items) ? s2.snapshot.inventory.items : []).map((i) => `${i.prefab}x${i.count ?? 1}`))}`)

console.log('\n=== ⑥ 清理控制权 ===')
await post('/api/v1/control/sync', {
  mode: 'SUPERVISED', holder: null, session_id: null, lease_expires_at: null,
  emergency_stop: false, reason: 'M7 完成',
})
console.log('  done')
