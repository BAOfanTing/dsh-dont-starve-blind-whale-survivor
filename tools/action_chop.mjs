// 自主砍树与收集木头脚本
import { existsSync } from 'node:fs'

const MCP = 'http://127.0.0.1:18090/mcp'
const TREE_PREFABS = new Set(['evergreen', 'deciduoustree', 'twiggytree'])

async function rpc(method, params) {
  const r = await fetch(MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  })
  const text = await r.text()
  const raw = text.includes('data:')
    ? text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
    : text
  return JSON.parse(raw)
}

async function call(name, args) {
  const b = await rpc('tools/call', { name, arguments: args })
  const text = (b.result?.content ?? []).map((c) => c.text).join('\n')
  if (b.error) return { text: JSON.stringify(b.error), error: true }
  return { text }
}

async function state() {
  const { text } = await call('get_state', { format: 'json' })
  try { return JSON.parse(text) } catch { return null }
}

function items(snap) {
  const out = []
  for (const [k, list] of Object.entries(snap?.nearby?.buckets ?? {})) {
    for (const it of list ?? []) out.push({ bucket: k, ...it })
  }
  return out
}

console.log('=== 1) 查找附近的树 ===')
let snap = await state()
if (!snap) { console.log('无法读取状态'); process.exit(1) }

const allTrees = items(snap).filter((i) => TREE_PREFABS.has(i.prefab)).sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))
console.log(`找到 ${allTrees.length} 棵树`)
let target = allTrees[0]
if (!target) { console.log('附近没有树'); process.exit(1) }

console.log(`目标树: ${target.ref} ${target.prefab} 距 ${target.distance} 格 (${target.position?.x}, ${target.position?.z})`)

// 如果距离大于 2 格，先靠近
if ((target.distance ?? 99) > 2) {
  console.log(`靠近树 (${target.position.x}, ${target.position.z})...`)
  await call('move_to', { x: target.position.x, z: target.position.z, timeout: 15 })
  await new Promise((r) => setTimeout(r, 2000))
  snap = await state()
  const refreshed = items(snap).filter((i) => TREE_PREFABS.has(i.prefab)).sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0]
  if (refreshed) target = refreshed
}

console.log(`=== 2) 砍树: ${target.ref} @ snapshot ${snap.nearby?.snapshot_id} ===`)
const chopRes = await call('chop', { target_ref: target.ref, snapshot_id: snap.nearby?.snapshot_id })
console.log('砍树回执:', chopRes.text)

// 等待 2 秒查看地上掉落物并拾取木头
await new Promise((r) => setTimeout(r, 2000))
snap = await state()
const groundLogs = items(snap).filter((i) => i.prefab === 'log')
console.log(`地上有 ${groundLogs.length} 块木头`)
for (const l of groundLogs) {
  if ((l.distance ?? 99) <= 3) {
    console.log(`拾取木头 ${l.ref}...`)
    const pickRes = await call('pickup', { target_ref: l.ref, snapshot_id: snap.nearby?.snapshot_id })
    console.log('拾取回执:', pickRes.text)
    await new Promise((r) => setTimeout(r, 1000))
    snap = await state()
  }
}
console.log('=== 完成 ===')
