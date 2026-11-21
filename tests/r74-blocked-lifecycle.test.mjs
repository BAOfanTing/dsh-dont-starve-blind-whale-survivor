// Phase R.7.4-A 回归测试 C / F：Task Board blocked 生命周期。
//
// 真机问题：任务只写 blocked_reason、没写 blocked_kind 时，evaluateBoard 会无条件
// 把它重置成 ready → 形成 ready→执行→blocked→ready 的无限横跳。
// 同时验证 unknown / cancelled 不会被错误地重新调度。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validateBoard, evaluateBoard, blockTask, pickNextTask, markDone } from '../lib/planner/task-board.js'

function snap(items = {}) {
  return {
    actor: { valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0 },
    player: { inventory: { items }, equipment: { slots: {}, worn: [] } },
    nearby: { buckets: {} },
  }
}

function boardWith(tasks) {
  return validateBoard({ schema: 'bws.task-board/1', goal: 'g', tasks })
}

const TASK = { id: 't', title: '收集木头', priority: 1, target: { type: 'inventory', prefab: 'log', count: 5 } }

test('R74-C1: 结构化 blocked（resource_missing）在恢复条件未满足前不会变回 ready', () => {
  let board = boardWith([TASK])
  board = blockTask(board, 't', { kind: 'resource_missing', reason: '附近没有木头', now: 1000 })
  assert.equal(board.tasks[0].status, 'blocked')

  const view = evaluateBoard(board, { snapshot: snap(), memory: {}, now: 2000 })
  const t = view.tasks.find((x) => x.id === 't')
  assert.equal(t.status, 'blocked', '恢复条件未满足时不得无条件回到 ready')
  assert.equal(t.blocked_kind, 'resource_missing')
  assert.equal(pickNextTask(view), null, 'blocked 任务不应被选中调度')
})

test('R74-C2: 满足明确的恢复条件（checkPreconditions=true）后，blocked 才能重新变 ready', () => {
  let board = boardWith([TASK])
  board = blockTask(board, 't', { kind: 'resource_missing', reason: '附近没有木头', now: 1000 })
  const view = evaluateBoard(board, { snapshot: snap(), memory: {}, now: 2000, checkPreconditions: () => true })
  const t = view.tasks.find((x) => x.id === 't')
  assert.ok(['ready', 'in_progress'].includes(t.status), '恢复条件满足后应能重新调度')
  assert.equal(t.blocked_kind, null)
})

test('R74-C3: 仅写 blocked_reason 没有 blocked_kind 的旧任务，也不能被无条件解除阻塞', () => {
  const board = boardWith([{ ...TASK, status: 'blocked', blocked_reason: '历史遗留阻塞' }])
  const view = evaluateBoard(board, { snapshot: snap(), memory: {}, now: 2000 })
  const t = view.tasks.find((x) => x.id === 't')
  assert.equal(t.status, 'blocked', '没有结构化 kind 的 blocked 也要保守处理，不能自动 ready')
  // 但显式声明已解决时可以恢复
  const view2 = evaluateBoard(board, { snapshot: snap(), memory: {}, now: 2000, resolvedBlockedTaskIds: ['t'] })
  assert.ok(['ready', 'in_progress'].includes(view2.tasks.find((x) => x.id === 't').status))
})

test('R74-C4: 软阻塞（带退避）冷却到点后才能重试', () => {
  let board = boardWith([TASK])
  board = blockTask(board, 't', { kind: 'resource_missing', reason: '暂时采不到', retryAfterMs: 5000, now: 1000 })
  // attempts=1 → cooldown = 1000 + 20000*1 = 21000
  const coolUntil = board.tasks[0].cooldown_until
  assert.ok(coolUntil > 1000)
  const stillCooling = evaluateBoard(board, { snapshot: snap(), memory: {}, now: coolUntil - 1 })
  assert.equal(stillCooling.tasks.find((x) => x.id === 't').status, 'blocked')
  const afterCool = evaluateBoard(board, { snapshot: snap(), memory: {}, now: coolUntil + 1 })
  assert.ok(['ready', 'in_progress'].includes(afterCool.tasks.find((x) => x.id === 't').status),
    '冷却到点后应允许重新尝试（不能永久卡死）')
})

test('R74-F1: unknown_outcome 是永久保护，绝不自动重新变 ready', () => {
  let board = boardWith([TASK])
  board = blockTask(board, 't', { kind: 'unknown_outcome', reason: 'task_outcome_unknown', now: 1000 })
  const view = evaluateBoard(board, { snapshot: snap(), memory: {}, now: 999999, checkPreconditions: () => true, resolvedBlockedTaskIds: ['t'] })
  const t = view.tasks.find((x) => x.id === 't')
  assert.equal(t.status, 'blocked', 'unknown 结果必须人工核实，不能被任何自动恢复条件解除')
  assert.equal(t.blocked_kind, 'unknown_outcome')
})

test('R74-F2: cancelled 不会重新变成 ready', () => {
  let board = boardWith([TASK])
  board = blockTask(board, 't', { kind: 'cancelled', reason: 'cancelled', now: 1000 })
  const view = evaluateBoard(board, { snapshot: snap(), memory: {}, now: 999999, checkPreconditions: () => true, resolvedBlockedTaskIds: ['t'] })
  assert.equal(view.tasks.find((x) => x.id === 't').status, 'blocked')
  assert.equal(pickNextTask(view), null)
})

test('R74-F3: 依赖阻塞仍然能随依赖完成而自动解锁（不破坏原有依赖语义）', () => {
  let board = boardWith([
    { id: 'a', title: 'A', priority: 1, target: { type: 'camp_site' } },
    { id: 'b', title: 'B', priority: 1, depends_on: ['a'], target: { type: 'home' } },
  ])
  let view = evaluateBoard(board, { snapshot: snap(), memory: {}, now: 1 })
  assert.equal(view.tasks.find((x) => x.id === 'b').status, 'blocked')
  assert.match(view.tasks.find((x) => x.id === 'b').blocked_reason, /dependencies:a/)

  // a 完成后，b 的依赖放行
  view = markDone(view, 'a')
  view = evaluateBoard(view, { snapshot: snap(), memory: { camp_site: { x: 1, z: 1 } }, now: 2 })
  assert.equal(view.tasks.find((x) => x.id === 'b').status, 'ready')
})
