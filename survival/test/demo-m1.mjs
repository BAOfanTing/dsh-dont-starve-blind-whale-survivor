// Phase 5 M1 演示：Dry Run + 幂等 + 控制权 + 紧急停止（不连游戏、不下发真实动作）
//
// 跑法：cd survival && node test/demo-m1.mjs
import { ControlManager } from '../dist/src/controlManager.js'
import { ActionRegistry } from '../dist/src/actionRegistry.js'

let clock = 1000
const now = () => clock

const control = new ControlManager({ now, leaseMs: 30_000 })
const registry = new ActionRegistry(control, { now, forceDryRun: true })

function cmd(id, key, type = 'gather_resource', extra = {}) {
  return {
    command_id: 'cmd_' + id, action_id: id, idempotency_key: key,
    session_id: 'S1', controller_id: 'C1', created_at: now(), expires_at: now() + 30_000,
    expected_state_sequence: 1, action_type: type, payload: { prefab: 'twigs', count: 10 }, dry_run: true,
    ...extra,
  }
}

const show = (label, r) => console.log(`  ${label.padEnd(34)} ok=${String(r.ok).padEnd(5)} status=${r.status.padEnd(12)} ${r.error ? '[' + r.error.code + '] ' + r.error.message.slice(0, 40) : ''}`)

console.log('=== ① 初始状态（未获控制权）===')
console.log('  mode:', control.getControlStatus().mode, '| holder:', control.getControlStatus().holder)
show('未获控制权提交动作', registry.submit(cmd('a0', 'K0')))

console.log('\n=== ② 申请控制权（SUPERVISED）===')
control.acquireControl({ controller_id: 'C1', session_id: 'S1' })
console.log('  holder:', control.getControlStatus().holder, '| lease_valid:', control.getControlStatus().lease_valid)

console.log('\n=== ③ Dry Run 全流程 ===')
const a1 = registry.submit(cmd('a1', 'K1', 'gather_resource'))
show('提交采集树枝', a1)
show('dry-run 执行', registry.dryRun('a1', 'C1'))
const rec1 = registry.get('a1')
console.log('  状态迁移:', rec1.history.map((h) => h.status).join(' → '))
console.log('  结果:', JSON.stringify(rec1.result), ' ← executed=false，没碰游戏')
console.log('  需人工确认:', rec1.confirmation_required)

console.log('\n=== ④ 需确认动作（SUPERVISED 必须确认）===')
registry.submit(cmd('a2', 'K2', 'chop_tree'))
show('未确认直接 dry-run', registry.dryRun('a2', 'C1'))
registry.confirm('a2', 'C1')
registry.confirm('a2', 'C1')
show('确认后再次 dry-run（续跑）', registry.dryRun('a2', 'C1'))
console.log('  a2 迁移:', registry.get('a2').history.map((h) => h.status).join(' → '))

console.log('\n=== ⑤ 重复命令不重复执行（幂等）===')
const first = registry.submit(cmd('a3', 'SAME_KEY'))
const again = registry.submit(cmd('a4', 'SAME_KEY'))
show('首次提交', first)
console.log('  重复提交 -> duplicate=' + again.duplicate + ' 指向 ' + again.deduplicated_from + '（action_id=' + again.action_id + '）')
console.log('  记录总数:', registry.stats().total, '| 非终态:', registry.stats().pending)

console.log('\n=== ⑥ 控制权切换 → 取消旧控制器未完成任务 ===')
registry.submit(cmd('a5', 'K5'))
registry.submit(cmd('a6', 'K6'))
console.log('  切换前 pending:', registry.pendingCount())
const n = registry.cancelPendingFor('C1', '人工接管')
console.log('  已取消:', n, '| 切换后 pending:', registry.pendingCount())
console.log('  a5/a6 状态:', registry.get('a5').status, '/', registry.get('a6').status)

console.log('\n=== ⑦ 紧急停止（同步生效）===')
control.releaseControl('C1')
control.acquireControl({ controller_id: 'C2', session_id: 'S1' })
registry.submit(cmd('a7', 'K7', 'gather_resource', { controller_id: 'C2' }))
const s = control.emergencyStop()
console.log('  mode:', s.mode, '| emergency:', s.emergency_stop, '| holder:', s.holder)
console.log('  紧急取消动作数:', registry.emergencyCancelAll())
console.log('  a7 状态:', registry.get('a7').status)
show('紧急停止后提交新动作', registry.submit(cmd('a8', 'K8', 'gather_resource', { controller_id: 'C2' })))

console.log('\n=== ⑧ 执行记录审计 ===')
console.log('  总记录:', registry.stats().total, '| 各状态:', JSON.stringify(registry.stats().by_status))
console.log('  控制权变更历史:')
for (const h of control.getHistory()) console.log(`    ${h.at} ${h.from ?? '(init)'} → ${h.to}  ${h.reason}`)

console.log('\n=== 结论 ===')
console.log('  M1 全部 dry-run，未调用任何游戏 API；重复命令未重复执行；控制权/紧急停止在程序层生效。')
