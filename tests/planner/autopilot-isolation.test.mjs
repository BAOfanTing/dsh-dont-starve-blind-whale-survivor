// R8.4：Autopilot 高层任务驱动与原子工具收口（工具隔离 + 提示词 + 入口统一 + 内部执行链不变）
//
// 目标（任务书 R8.4）：Autopilot 模式下模型只负责"制定和监督高层目标"，
// advance_task 驱动既有任务执行系统；底层原子动作仍由 SkillExecutor 和 Dispatcher 安全执行。
// 这里盯住三件事：
//   1) 模型层：Autopilot 只看到并能调用高层接口；直调原子动作 / run_skill 被拒。
//   2) 提示词：Autopilot 用高层驱动手册；Assisted / Manual 保留完整原子动作手册。
//   3) 内部执行链：advance_task 内部的原子派发**不受**模型层闸门影响（不能误伤 SkillExecutor→Dispatcher）。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  toolList,
  executeTool,
  isToolAllowedInMode,
  AUTOPILOT_TOOL_WHITELIST,
  AUTOPILOT_ATOMIC_REJECT_MESSAGE,
  TOOLS,
} from '../../lib/tools.js'
import { buildInstructions, toolsForExecutionMode } from '../../lib/index.js'
import { WorldRuntimeManager } from '../../lib/planner/world-runtime-manager.js'
import { emptyMemory } from '../../lib/planner/world-memory.js'

const AUTOPILOT_WANT = ['advance_task', 'get_guide', 'get_state', 'stop', 'update_notes']
const ATOMIC_SAMPLES = ['move_to', 'pickup_nearest', 'harvest_nearest', 'chop', 'craft', 'build', 'attack', 'run_skill']

function createMockStore() {
  const data = new Map()
  return {
    load: (wk) => {
      const key = wk || 'unknown_world'
      if (!data.has(key)) data.set(key, emptyMemory(key))
      return data.get(key)
    },
    save: (mem) => { data.set(mem.world_key || 'unknown_world', mem) },
    data,
  }
}

const call = async (name, args, mode) => {
  try { return String(await executeTool(name, args, { executionMode: mode, bridge: null, log: () => {} })) }
  catch (e) { return 'THREW:' + String(e?.message ?? e) }
}

test('TEST-01: toolList(autopilot) 恰好等于高层接口白名单', () => {
  const names = toolList('autopilot').map((t) => t.name).sort()
  assert.deepEqual(names, AUTOPILOT_WANT, 'Autopilot 只暴露 5 个高层接口')
  for (const n of ATOMIC_SAMPLES) {
    assert.ok(!names.includes(n), `Autopilot 不得暴露原子动作 ${n}`)
  }
  // 白名单常量本身与展示结果一致
  assert.deepEqual([...AUTOPILOT_TOOL_WHITELIST].sort(), AUTOPILOT_WANT)
})

test('TEST-02: toolList(assisted/manual) 暴露完整工具集（原子动作 + run_skill + advance_task）', () => {
  for (const mode of ['assisted', 'manual']) {
    const names = toolList(mode).map((t) => t.name)
    for (const n of [...ATOMIC_SAMPLES, 'get_state', 'get_guide', 'update_notes', 'stop']) {
      assert.ok(names.includes(n), `${mode} 应暴露 ${n}`)
    }
    assert.equal(names.length, TOOLS.length, `${mode} 工具数量应等于 TOOLS 全量`)
  }
})

test('TEST-03: 未知 / 非法 executionMode 安全回退为 autopilot 白名单（不意外放开）', () => {
  for (const bad of [undefined, null, '', 'nonsense', 'ALL_IN', 123]) {
    // toolList 默认参数走 autopilot；显式传非法值也回退 autopilot
    const names = toolList(bad).map((t) => t.name).sort()
    assert.deepEqual(names, AUTOPILOT_WANT, `非法模式 ${String(bad)} 必须回退 autopilot 白名单`)
  }
})

test('TEST-04: Autopilot 下直调原子动作 / run_skill 在 dispatch 前被固定文案拒绝', async () => {
  for (const n of ATOMIC_SAMPLES) {
    const text = await call(n, {}, 'autopilot')
    assert.equal(text, AUTOPILOT_ATOMIC_REJECT_MESSAGE, `${n} 应被固定文案拒绝`)
  }
})

test('TEST-05: Autopilot 下高层接口不被模式闸门拒绝；isToolAllowedInMode 判定正确', () => {
  for (const n of AUTOPILOT_WANT) {
    assert.equal(isToolAllowedInMode(n, 'autopilot'), true, `${n} 在 Autopilot 应允许`)
  }
  for (const n of ATOMIC_SAMPLES) {
    assert.equal(isToolAllowedInMode(n, 'autopilot'), false, `${n} 在 Autopilot 应拒绝`)
    assert.equal(isToolAllowedInMode(n, 'assisted'), true, `${n} 在 Assisted 应允许`)
    assert.equal(isToolAllowedInMode(n, 'manual'), true, `${n} 在 Manual 应允许`)
  }
})

test('TEST-06: Assisted / Manual 不按模式拦截原子动作（不是权限拒绝）', async () => {
  for (const mode of ['assisted', 'manual']) {
    const text = await call('move_to', { x: 1, z: 1 }, mode)
    assert.ok(!text.includes('不允许模型直接调用原子动作'), `${mode} 不应按模式拦截 move_to：${text}`)
  }
})

test('TEST-07: buildInstructions(autopilot) 用高层驱动手册，不硬塞原子向主攻略与冲突文案', () => {
  const auto = buildInstructions({ main: '主攻略正文' }, 'autopilot')
  assert.match(auto, /advance_task/, '要讲 advance_task')
  assert.match(auto, /budget_exhausted|stop_reason/, '要教怎么读回执')
  assert.ok(!/能用的动作共\s*\d+\s*个/.test(auto), '不再展示完整动作清单')
  assert.ok(!auto.includes('完整原子动作工具集'), '不得再说"拥有完整原子工具集"')
  assert.ok(!auto.includes('任务看板只是建议'), '不得再说"任务看板只是建议"')
  assert.ok(!auto.includes('主攻略正文'), 'Autopilot 不再硬塞原子向主攻略')
  assert.ok(!auto.includes('## 游戏常识'), 'Autopilot 不包含游戏常识/主攻略段')
})

test('TEST-08: buildInstructions(assisted/manual) 保留完整原子动作手册', () => {
  for (const mode of ['assisted', 'manual']) {
    const text = buildInstructions({ main: '主攻略正文' }, mode)
    assert.match(text, /能用的动作共\s*\d+\s*个/, `${mode} 应保留完整动作清单`)
    assert.match(text, /harvest_nearest/, `${mode} 应说明原子动作`)
  }
  // 默认（不传模式）等于 assisted
  assert.equal(buildInstructions({ main: 'x' }), buildInstructions({ main: 'x' }, 'assisted'))
})

test('TEST-09: 三种入口统一 —— toolsForExecutionMode 跟随配置，且等于 toolList(mode)', () => {
  for (const mode of ['autopilot', 'assisted', 'manual']) {
    const fromConfig = toolsForExecutionMode({ executionMode: mode }).map((t) => t.name).sort()
    const direct = toolList(mode).map((t) => t.name).sort()
    assert.deepEqual(fromConfig, direct, `${mode}: 配置解析结果必须等于 toolList(mode)`)
  }
  // Autopilot 配置下，DSH/MCP 共用入口也只给高层接口
  const auto = toolsForExecutionMode({ executionMode: 'autopilot' }).map((t) => t.name).sort()
  assert.deepEqual(auto, AUTOPILOT_WANT)
})

test('TEST-10: 模型层被拒，但 advance_task 内部执行链仍能派发原子动作（不误伤 SkillExecutor→Dispatcher）', async () => {
  WorldRuntimeManager.clear()
  const store = createMockStore()
  const mem = store.load('world_r84')
  mem.task_board = {
    schema: 'bws.task-board/1',
    goal: '收集木头',
    tasks: [{
      id: 'gather_log',
      title: '收集木头',
      priority: 'normal',
      status: 'ready',
      skill_id: 'gather_resources',
      skill_args: { target_items: { log: 2 } },
      attempts: 0,
      max_attempts: 3,
      cooldown_until: 0,
      progress: { current: 0, required: 2 },
    }],
  }

  let snapCounter = 0
  const snapshots = [
    { identity: { worldKey: 'world_r84' }, inventory: { items: [] }, actor: { tileX: 0, tileZ: 0 } },
    { identity: { worldKey: 'world_r84' }, inventory: { items: [{ prefab: 'log', count: 1 }] }, actor: { tileX: 1, tileZ: 1 } },
    { identity: { worldKey: 'world_r84' }, inventory: { items: [{ prefab: 'log', count: 2 }] }, actor: { tileX: 2, tileZ: 2 } },
  ]
  const dispatched = []
  const dispatcher = {
    dispatch: async ({ tool }) => { dispatched.push(tool); snapCounter++; return { status: 'succeeded', verified: true } },
    describe: (o) => `动作 ${o.status}`,
  }
  const readSnapshot = () => snapshots[Math.min(snapCounter, snapshots.length - 1)]
  const runtime = WorldRuntimeManager.getOrCreate({
    worldKey: 'world_r84', store, dispatcher, readSnapshot, log: () => {},
  })

  // 1) 模型层：直调原子动作被拒
  assert.equal(await call('move_to', { x: 1, z: 1 }, 'autopilot'), AUTOPILOT_ATOMIC_REJECT_MESSAGE)
  assert.equal(dispatched.length, 0, '被拒时一条原子命令都不应下发')

  // 2) 内部执行链：advance_task 仍能派发真正的原子动作（gather_resources → 至少一个游戏动作）
  const report = await runtime.advanceTask({ maxSteps: 5 })
  assert.ok(dispatched.length >= 1, 'advance_task 内部应派发原子动作')
  assert.ok(dispatched.every((t) => t !== 'advance_task'), '内部派发的必须是原子动作，不是 advance_task 自身')
  assert.equal(report.world_key, 'world_r84')
})
