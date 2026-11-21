// 回归：因“控制权/租约”等基础设施瞬时原因（control_denied / lease_expired / runtime_cancelled）
// 失败的任务，必须能重新排队；否则一次租约抖动会把任务永久判死，角色再也不动。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateBoard } from '../lib/planner/task-board.js'

const board = (task) => ({ schema: 'bws.task-board/1', goal: 'x', tasks: [task] })
const ctx = () => ({ snapshot: {}, memory: {}, evaluator: () => ({ current: 0, required: 1, done: false, known: true }) })

test('TB-TRANSIENT：control_denied / lease_expired / runtime_cancelled 失败可重新排队（不永久 failed）', () => {
  for (const reason of ['control_denied', 'lease_expired', 'runtime_cancelled']) {
    const out = evaluateBoard(board({
      id: 'gather_food', title: 't', status: 'failed', attempts: 4,
      blocked_reason: reason, blocked_kind: 'attempts_exhausted', target: { type: 'noop' },
    }), ctx())
    const t = out.tasks[0]
    assert.notEqual(t.status, 'failed', `${reason} 不应把任务永久判死`)
    assert.equal(t.status, 'ready', `${reason} 失败应可重新排队为 ready`)
    assert.equal(t.attempts, 0, `${reason} 失败后 attempts 应清零`)
  }
})

test('TB-TRANSIENT-NEG：其它原因（attempts_exhausted）失败仍保持 failed', () => {
  const out = evaluateBoard(board({
    id: 'x', title: 't', status: 'failed', attempts: 4,
    blocked_reason: 'attempts_exhausted', blocked_kind: 'attempts_exhausted', target: { type: 'noop' },
  }), ctx())
  assert.equal(out.tasks[0].status, 'failed')
})
