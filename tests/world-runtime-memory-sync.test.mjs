// 回归：WorldRuntime.memory 必须能看到 planner 落到 store 的最新看板。
// 复现真机 bug：get_state 让 planner 落盘 ready 任务，但 Runtime 若沿用创建时的旧 memory
// 就会 advance_task 永远 no_task。reloadMemory() 就地同步后应可见。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WorldRuntime } from '../lib/planner/world-runtime-manager.js'
import { createWorldMemoryStore } from '../lib/planner/world-memory.js'

test('MEMSYNC：Runtime 创建后 planner 落盘的新看板，reloadMemory 后 executor/orchestrator 都能看到', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-memsync-'))
  const store = createWorldMemoryStore({ dir: join(dir, 'mem') })
  const worldKey = 'session:TEST/shard:1'

  // 1) Runtime 先创建（此时磁盘还没有任务看板）
  const runtime = new WorldRuntime({
    worldKey,
    store,
    dispatcher: { dispatch: async () => ({ status: 'succeeded' }), describe: () => '' },
    readSnapshot: () => ({ identity: { worldKey }, actor: {} }),
  })
  const before = runtime.memory.task_board?.tasks?.length ?? 0
  assert.equal(before, 0, '创建时磁盘无任务，Runtime 记忆应为空')

  // 2) 模拟 planner：把 ready 任务写入 store（每次 store.load 返回新对象）
  const mem = store.load(worldKey)
  mem.task_board = {
    schema: 'bws.task-board/1',
    goal: 'gather_food',
    tasks: [{ id: 'gather_food', title: '储备应急食物', status: 'ready', priority: 1 }],
  }
  store.save(mem)

  // 3) 未同步前，Runtime 仍是旧对象（看不到磁盘新任务）
  assert.equal(runtime.memory.task_board?.tasks?.length ?? 0, 0, '不同步时 Runtime 看不到新看板（bug）')

  // 4) reloadMemory 就地同步 → runtime/executor/orchestrator 共享对象都更新
  runtime.reloadMemory()
  assert.equal(runtime.memory.task_board.tasks.length, 1, 'reload 后 Runtime 看到任务')
  assert.equal(runtime.orchestrator.memory, runtime.memory, 'orchestrator 与 Runtime 共享同一 memory 对象')
  assert.equal(runtime.executor.memory, runtime.memory, 'executor 与 Runtime 共享同一 memory 对象')
  assert.equal(runtime.orchestrator.memory.task_board.tasks[0].id, 'gather_food')
})
