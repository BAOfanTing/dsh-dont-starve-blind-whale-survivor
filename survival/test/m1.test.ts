// Phase 5 M1 测试：Action Protocol / Control Manager / Action Registry
//
// 全部是单元测试（dry-run），**不连游戏、不下发真实动作**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTION_STATUSES, ACTION_TYPES, CONTROL_MODES, CONFIRMATION_REQUIRED,
  canTransition, parseActionCommand, type ActionCommand,
} from '../src/protocol.js'
import { ControlManager, ControlDenied } from '../src/controlManager.js'
import { ActionRegistry } from '../src/actionRegistry.js'

let clock = 1000
const now = () => clock
const tick = (ms: number) => { clock += ms }

function cmd(overrides: Partial<ActionCommand> = {}): ActionCommand {
  return {
    command_id: 'cmd_1',
    action_id: 'act_1',
    idempotency_key: 'idem_1',
    session_id: 'S1',
    controller_id: 'C1',
    created_at: now(),
    expires_at: now() + 30_000,
    expected_state_sequence: 1,
    action_type: 'gather_resource',
    payload: { prefab: 'twigs' },
    dry_run: true,
    ...overrides,
  }
}

function setup(mode: 'SUPERVISED' | 'AUTONOMOUS' = 'SUPERVISED') {
  clock = 1000
  const control = new ControlManager({ defaultMode: mode, now, leaseMs: 30_000, renewMs: 30_000 })
  const registry = new ActionRegistry(control, { now, forceDryRun: true })
  control.acquireControl({ controller_id: 'C1', session_id: 'S1', mode })
  return { control, registry }
}

// ───────────────────────── Protocol ─────────────────────────

test('Protocol：9 态 + 5 种控制模式 + 17 个动作类型白名单', () => {
  assert.equal(ACTION_STATUSES.length, 9)
  assert.ok(ACTION_STATUSES.includes('NEEDS_RECONCILIATION'))
  assert.equal(CONTROL_MODES.length, 5)
  assert.equal(ACTION_TYPES.length, 17)
  assert.ok(CONFIRMATION_REQUIRED.has('chop_tree'))
  assert.ok(!CONFIRMATION_REQUIRED.has('gather_resource'), '采摘树枝初期允许受限自动执行')
})

test('Protocol：状态迁移合法性', () => {
  assert.equal(canTransition('PENDING', 'VALIDATING'), true)
  assert.equal(canTransition('RUNNING', 'NEEDS_RECONCILIATION'), true)
  assert.equal(canTransition('SUCCEEDED', 'RUNNING'), false, '终态不能再执行')
  assert.equal(canTransition('PENDING', 'SUCCEEDED'), false, '不能跳过校验直接成功')
  assert.equal(canTransition('NEEDS_RECONCILIATION', 'RUNNING'), false, '需协调态不能重跑')
  assert.equal(canTransition('NEEDS_RECONCILIATION', 'SUCCEEDED'), true, '人工核对后允许结案为成功（不是重跑）')
})

test('Protocol：parseActionCommand 校验必填字段', () => {
  const good = parseActionCommand(cmd(), now())
  assert.equal(good.ok, true)
  const bad = parseActionCommand({ ...cmd(), controller_id: '' }, now())
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'INVALID_ARGUMENT')
})

test('Protocol：未知动作直接拒绝（不让外部传任意 ACTIONS 名）', () => {
  const r = parseActionCommand({ ...cmd(), action_type: 'eval_lua', payload: { code: 'os.execute(...)' } }, now())
  assert.equal(r.ok, false)
  assert.equal(r.code, 'UNKNOWN_ACTION')
})

// ───────────────────────── Control Manager ─────────────────────────

test('Control：默认 SUPERVISED，未申请控制权时拒绝写操作', () => {
  clock = 1000
  const c = new ControlManager({ now })
  assert.equal(c.getControlStatus().mode, 'SUPERVISED')
  assert.throws(
    () => c.assertCanExecute('C1', 'S1'),
    (e: unknown) => (e as ControlDenied).code === 'CONTROL_NOT_HELD',
  )
})

test('Control：acquire → 有效 lease → 放行；release → 拒绝', () => {
  clock = 1000
  const c = new ControlManager({ now })
  const lease = c.acquireControl({ controller_id: 'C1', session_id: 'S1' })
  assert.equal(lease.controller_id, 'C1')
  assert.equal(c.getControlStatus().holder, 'C1')
  assert.equal(c.getControlStatus().lease_valid, true)
  assert.doesNotThrow(() => c.assertCanExecute('C1', 'S1'))
  assert.equal(c.releaseControl('C1'), true)
  assert.throws(() => c.assertCanExecute('C1', 'S1'))
})

test('Control：同一时间只允许一个控制器', () => {
  clock = 1000
  const c = new ControlManager({ now })
  c.acquireControl({ controller_id: 'C1', session_id: 'S1' })
  assert.throws(
    () => c.acquireControl({ controller_id: 'C2', session_id: 'S1' }),
    (e: unknown) => (e as ControlDenied).code === 'CONTROL_NOT_HELD',
  )
  assert.equal(c.getControlStatus().holder, 'C1')
})

test('Control：lease 过期后普通操作被拒，renew 可续期', () => {
  clock = 1000
  const c = new ControlManager({ now, leaseMs: 5000 })
  c.acquireControl({ controller_id: 'C1', session_id: 'S1' })
  tick(3000)
  c.renewControl('C1')
  assert.equal(c.getControlStatus().remaining_ms, 5000)
  tick(6000)
  assert.equal(c.getControlStatus().lease_valid, false)
  assert.throws(
    () => c.assertCanExecute('C1', 'S1'),
    (e: unknown) => (e as ControlDenied).code === 'CONTROL_EXPIRED',
  )
  assert.throws(
    () => c.renewControl('C1'),
    (e: unknown) => (e as ControlDenied).code === 'CONTROL_EXPIRED',
  )
})

test('Control：人工接管优先级最高，撤销 AI lease', () => {
  clock = 1000
  const c = new ControlManager({ now })
  c.acquireControl({ controller_id: 'C1', session_id: 'S1' })
  const status = c.takeManualControl()
  assert.equal(status.mode, 'MANUAL')
  assert.equal(status.holder, null)
  assert.throws(
    () => c.acquireControl({ controller_id: 'C1', session_id: 'S1' }),
    (e: unknown) => (e as ControlDenied).code === 'MANUAL_OVERRIDE',
  )
})

test('Control：PAUSED 拒绝执行，resume 回到 SUPERVISED（不自动回 AUTONOMOUS）', () => {
  clock = 1000
  const c = new ControlManager({ now })
  c.acquireControl({ controller_id: 'C1', session_id: 'S1' })
  c.pause()
  assert.throws(() => c.assertCanExecute('C1', 'S1'))
  c.resume()
  assert.equal(c.getControlStatus().mode, 'SUPERVISED')
  assert.doesNotThrow(() => c.assertCanExecute('C1', 'S1'))
})

test('Control：AUTONOMOUS 必须显式开启，不能由 resume 自动恢复', () => {
  clock = 1000
  const c = new ControlManager({ now })
  c.enableAutonomous()
  assert.equal(c.getControlStatus().mode, 'AUTONOMOUS')
  c.pause()
  c.resume()
  assert.equal(c.getControlStatus().mode, 'SUPERVISED', '恢复必须回到监督模式')
})

test('Control：紧急停止同步生效，撤销 lease 并拒绝一切', () => {
  clock = 1000
  const c = new ControlManager({ now })
  c.acquireControl({ controller_id: 'C1', session_id: 'S1' })
  const s = c.emergencyStop()
  assert.equal(s.mode, 'EMERGENCY_STOP')
  assert.equal(s.holder, null)
  assert.equal(s.emergency_stop, true)
  assert.throws(
    () => c.assertCanExecute('C1', 'S1', { readOnly: true }),
    (e: unknown) => (e as ControlDenied).code === 'EMERGENCY_STOP',
    '紧急停止连只读查询也拒（最高优先级）',
  )
  assert.throws(() => c.acquireControl({ controller_id: 'C2', session_id: 'S1' }))
  assert.equal(c.clearEmergencyStop().mode, 'SUPERVISED')
})

test('Control：只读查询不需要写权限（未获得控制权也能读状态/制定计划）', () => {
  clock = 1000
  const c = new ControlManager({ now })
  assert.doesNotThrow(() => c.assertCanExecute('anyone', 'S1', { readOnly: true }))
})

test('Control：session 不一致被拒', () => {
  clock = 1000
  const c = new ControlManager({ now })
  c.acquireControl({ controller_id: 'C1', session_id: 'S1' })
  assert.throws(() => c.assertCanExecute('C1', 'S2'))
})

// ───────────────────────── Action Registry ─────────────────────────

test('Registry：提交动作（dry-run）→ PENDING，记录完整字段', () => {
  const { registry } = setup()
  const r = registry.submit(cmd())
  assert.equal(r.ok, true)
  assert.equal(r.status, 'PENDING')
  const rec = registry.get('act_1')!
  assert.equal(rec.command.idempotency_key, 'idem_1')
  assert.equal(rec.command.dry_run, true)
  assert.equal(rec.history.length, 1)
})

test('Registry：强制 dry-run（即使外部传 dry_run=false 也被改成 true）', () => {
  const { registry } = setup()
  registry.submit(cmd({ dry_run: false }))
  assert.equal(registry.get('act_1')!.command.dry_run, true)
})

test('Registry：幂等去重 —— 重复 idempotency_key 返回首次记录，不新增、不重复执行', () => {
  const { registry } = setup()
  const a = registry.submit(cmd({ action_id: 'act_1', idempotency_key: 'K' }))
  const b = registry.submit(cmd({ action_id: 'act_2', idempotency_key: 'K' }))
  assert.equal(b.duplicate, true)
  assert.equal(b.action_id, 'act_1', '应指向首次记录')
  assert.equal(registry.stats().total, 1, '不能新增记录')
  assert.equal(registry.stats().duplicates, 0, 'duplicate 是返回标志，不是新记录')
  assert.ok(a.ok && b.ok)
})

test('Registry：action_id 重复直接失败', () => {
  const { registry } = setup()
  registry.submit(cmd({ idempotency_key: 'K1' }))
  const r = registry.submit(cmd({ idempotency_key: 'K2' }))
  assert.equal(r.ok, false)
  assert.equal(r.error?.code, 'DUPLICATE')
})

test('Registry：过期命令直接 FAILED', () => {
  const { registry } = setup()
  const r = registry.submit(cmd({ created_at: 100, expires_at: 200 }))
  assert.equal(r.status, 'FAILED')
  assert.equal(r.error?.code, 'EXPIRED')
})

test('Registry：没有控制权时提交写动作被拒（程序层，不靠提示词）', () => {
  clock = 1000
  const control = new ControlManager({ now })
  const registry = new ActionRegistry(control, { now })
  const r = registry.submit(cmd())
  assert.equal(r.ok, false)
  assert.equal(r.error?.code, 'CONTROL_NOT_HELD')
})

test('Registry：只读动作不需要控制权也能提交', () => {
  clock = 1000
  const control = new ControlManager({ now })
  const registry = new ActionRegistry(control, { now })
  const r = registry.submit(cmd({ action_type: 'get_control_status', idempotency_key: 'K' }))
  assert.equal(r.ok, true)
})

test('Registry：dry-run 全流程（VALIDATING→ACCEPTED→RUNNING→SUCCEEDED），不调用游戏', () => {
  const { registry } = setup()
  registry.submit(cmd({ action_type: 'gather_resource' }))
  const r = registry.dryRun('act_1', 'C1')
  assert.equal(r.ok, true)
  assert.equal(r.status, 'SUCCEEDED')
  const rec = registry.get('act_1')!
  assert.deepEqual(rec.history.map((h) => h.status), ['PENDING', 'VALIDATING', 'ACCEPTED', 'RUNNING', 'SUCCEEDED'])
  assert.equal((rec.result as Record<string, unknown>).executed, false)
  assert.equal((rec.result as Record<string, unknown>).dry_run, true)
})

test('Registry：需要人工确认的动作，未确认时停在 VALIDATING（确认后可续跑，不判 FAILED）', () => {
  const { registry } = setup('AUTONOMOUS') // 即使 AUTONOMOUS，需确认动作仍要 confirm
  registry.submit(cmd({ action_type: 'chop_tree' }))
  const r = registry.dryRun('act_1', 'C1')
  assert.equal(r.ok, false)
  assert.equal(registry.get('act_1')!.status, 'VALIDATING', '停在等待确认，不是终态')
  assert.match(String(r.error?.message), /确认/)
  // 确认后再次 dryRun 可以续跑到 SUCCEEDED
  registry.confirm('act_1', 'C1')
  const again = registry.dryRun('act_1', 'C1')
  assert.equal(again.ok, true)
  assert.equal(again.status, 'SUCCEEDED')
  assert.deepEqual(registry.get('act_1')!.history.map((h) => h.status),
    ['PENDING', 'VALIDATING', 'ACCEPTED', 'RUNNING', 'SUCCEEDED'])
})

test('Registry：confirm 后 dry-run 可完成', () => {
  const { registry } = setup()
  registry.submit(cmd({ action_type: 'craft_item' }))
  registry.confirm('act_1', 'C1')
  const r = registry.dryRun('act_1', 'C1')
  assert.equal(r.status, 'SUCCEEDED')
})

test('Registry：dry-run 完成后不能重复执行（终态保护）', () => {
  const { registry } = setup()
  registry.submit(cmd())
  registry.dryRun('act_1', 'C1')
  const again = registry.dryRun('act_1', 'C1')
  assert.equal(again.ok, false)
  assert.equal(again.error?.code, 'ILLEGAL_TRANSITION')
})

test('Registry：非 dry_run 真实执行被明确拒绝（M1 不实现）', () => {
  clock = 1000
  const control = new ControlManager({ now })
  const registry = new ActionRegistry(control, { now, forceDryRun: false })
  control.acquireControl({ controller_id: 'C1', session_id: 'S1' })
  registry.submit(cmd({ dry_run: false }))
  const r = registry.dryRun('act_1', 'C1')
  assert.equal(r.ok, false)
  assert.equal(r.error?.code, 'NOT_IMPLEMENTED')
})

test('Registry：取消未终结动作；终态不能取消', () => {
  const { registry } = setup()
  registry.submit(cmd())
  assert.equal(registry.cancel('act_1', 'C1').status, 'CANCELLED')
  assert.equal(registry.cancel('act_1', 'C1').ok, false, '已终结不能重复取消')
})

test('Registry：不能取消别人的动作', () => {
  const { registry } = setup()
  registry.submit(cmd())
  const r = registry.cancel('act_1', 'C2')
  assert.equal(r.ok, false)
  assert.equal(r.error?.code, 'CONTROL_NOT_HELD')
})

test('Registry：超时扫描 → 未终结动作变 TIMEOUT / NEEDS_RECONCILIATION', () => {
  const { registry } = setup()
  registry.submit(cmd({ expires_at: 2000, action_id: 'a1', idempotency_key: 'K1' }))
  registry.submit(cmd({ expires_at: 2000, action_id: 'a2', idempotency_key: 'K2' }))
  registry.transition('a2', 'VALIDATING')
  registry.transition('a2', 'ACCEPTED')
  registry.transition('a2', 'RUNNING')
  tick(2000)
  const n = registry.sweepTimeouts()
  assert.equal(n, 2)
  assert.equal(registry.get('a1')!.status, 'TIMEOUT')
  assert.equal(registry.get('a2')!.status, 'NEEDS_RECONCILIATION', '执行中失联 → 结果未知')
})

test('Registry：断线进入 NEEDS_RECONCILIATION 后禁止盲目重放', () => {
  const { registry } = setup()
  registry.submit(cmd())
  for (const s of ['VALIDATING', 'ACCEPTED', 'RUNNING'] as const) registry.transition('act_1', s)
  const r = registry.reconcile('act_1')
  assert.equal(r.status, 'NEEDS_RECONCILIATION')
  assert.equal(registry.isReplayAllowed('act_1'), false, '禁止重放')
  assert.equal(registry.transition('act_1', 'RUNNING').error?.code, 'ILLEGAL_TRANSITION')
})

test('Registry：控制权切换时取消旧控制器所有未终结动作', () => {
  const { control, registry } = setup()
  registry.submit(cmd({ action_id: 'a1', idempotency_key: 'K1' }))
  registry.submit(cmd({ action_id: 'a2', idempotency_key: 'K2' }))
  registry.transition('a2', 'VALIDATING')
  const cancelled = registry.cancelPendingFor('C1', '人工接管')
  assert.equal(cancelled, 2)
  assert.equal(registry.pendingCount(), 0)
  assert.equal(control.getControlStatus().mode, 'SUPERVISED')
})

test('Registry：紧急停止取消所有未终结动作（不被队列阻塞）', () => {
  const { registry } = setup()
  registry.submit(cmd({ action_id: 'a1', idempotency_key: 'K1' }))
  registry.submit(cmd({ action_id: 'a2', idempotency_key: 'K2' }))
  assert.equal(registry.emergencyCancelAll(), 2)
  assert.equal(registry.pendingCount(), 0)
  assert.equal(registry.get('a1')!.status, 'CANCELLED')
})

test('Registry：状态迁移审计历史完整', () => {
  const { registry } = setup()
  registry.submit(cmd())
  registry.transition('act_1', 'VALIDATING', '校验')
  registry.transition('act_1', 'ACCEPTED', '通过')
  registry.cancel('act_1', 'C1')
  const h = registry.get('act_1')!.history
  assert.deepEqual(h.map((x) => x.status), ['PENDING', 'VALIDATING', 'ACCEPTED', 'CANCELLED'])
  assert.equal(h[1]!.reason, '校验')
})

test('Registry：stats 统计正确', () => {
  const { registry } = setup()
  registry.submit(cmd({ action_id: 'a1', idempotency_key: 'K1' }))
  registry.dryRun('a1', 'C1')
  const s = registry.stats()
  assert.equal(s.total, 1)
  assert.equal(s.pending, 0)
  assert.equal(s.by_status.SUCCEEDED, 1)
  assert.equal(s.dry_runs, 1)
})
