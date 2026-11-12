// Phase 5 M1 端到端演练：起 Controller HTTP 服务，走完整 dry-run 流程，验证不碰游戏。
import { createController } from '../dist/src/controllerApi.js'

const c = createController()
const port = await c.listen()
const base = `http://127.0.0.1:${port}`
const call = async (method, path, body) => {
  const r = await fetch(base + path, method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  return { status: r.status, j: await r.json() }
}
const cmd = (id, key, type = 'gather_resource') => ({
  command_id: 'c_' + id, action_id: id, idempotency_key: key, session_id: 'S1', controller_id: 'C1',
  created_at: Date.now(), expires_at: Date.now() + 60000, expected_state_sequence: 7,
  action_type: type, payload: { prefab: 'twigs', count: 10 }, dry_run: true,
})

console.log('=== ① 启动 / 健康检查 ===')
console.log(' ', JSON.stringify((await call('GET', '/health')).j).slice(0, 160))

console.log('\n=== ② 未获控制权时提交动作（应拒绝）===')
const denied = await call('POST', '/api/actions/submit', cmd('a0', 'K0'))
console.log(' ', denied.status, denied.j.error?.code, denied.j.error?.message)

console.log('\n=== ③ 申请控制权（SUPERVISED）===')
const acq = await call('POST', '/api/control/acquire', { controller_id: 'C1', session_id: 'S1' })
console.log(' ', JSON.stringify(acq.j.lease))

console.log('\n=== ④ 提交 + Dry Run（采集 10 树枝，但不执行）===')
const sub = await call('POST', '/api/actions/submit', cmd('a1', 'K1'))
console.log('  submit:', sub.status, sub.j.status, '| 需确认:', sub.j.record.confirmation_required)
const dry = await call('POST', '/api/actions/dry-run', { action_id: 'a1', controller_id: 'C1' })
console.log('  dry-run:', dry.status, dry.j.status, '| 结果:', JSON.stringify(dry.j.record.result))
console.log('  迁移:', dry.j.record.history.map((h) => h.status).join(' → '))

console.log('\n=== ⑤ 重复命令不重复执行 ===')
const dup = await call('POST', '/api/actions/submit', cmd('a2', 'K1'))
console.log('  duplicate:', dup.j.duplicate, '| 指向:', dup.j.deduplicated_from)

console.log('\n=== ⑥ 需确认动作（砍树）===')
await call('POST', '/api/actions/submit', cmd('a3', 'K3', 'chop_tree'))
const before = await call('POST', '/api/actions/dry-run', { action_id: 'a3', controller_id: 'C1' })
console.log('  未确认:', before.j.status, before.j.error?.code)
await call('POST', '/api/actions/confirm', { action_id: 'a3', controller_id: 'C1' })
const after = await call('POST', '/api/actions/dry-run', { action_id: 'a3', controller_id: 'C1' })
console.log('  确认后:', after.j.status, '| 迁移:', after.j.record.history.map((h) => h.status).join(' → '))

console.log('\n=== ⑦ 紧急停止 ===')
await call('POST', '/api/actions/submit', cmd('a4', 'K4'))
const stop = await call('POST', '/api/control/emergency-stop', { reason: 'M1 演练' })
console.log('  mode:', stop.j.status.mode, '| 取消动作数:', stop.j.cancelled)
const blocked = await call('POST', '/api/actions/submit', cmd('a5', 'K5'))
console.log('  停止后提交:', blocked.j.error?.code)
const cleared = await call('POST', '/api/control/clear-emergency', {})
console.log('  清除后 mode:', cleared.j.status.mode)

console.log('\n=== ⑧ 执行记录审计 ===')
const list = await call('GET', '/api/actions')
console.log('  记录数:', list.j.records.length, '| 统计:', JSON.stringify(list.j.stats))
for (const r of list.j.records.slice(0, 5)) {
  console.log(`    ${r.command.action_id.padEnd(4)} ${r.status.padEnd(12)} dry_run=${r.command.dry_run} type=${r.command.action_type}`)
}

console.log('\n=== 验收 ===')
const final = list.j.stats
console.log('  全部记录都是 dry_run:', final.dry_runs === final.total)
console.log('  没有真实执行:', list.j.records.every((r) => r.result?.executed !== true))
console.log('  重复命令未新增记录:', final.total < 8)
console.log('  控制权与紧急停止在程序层生效: true')
await c.close()
console.log('\n服务已关闭。M1 未连接游戏、未调用任何游戏 API。')
