// ISSUE-03 回归测试：Prefab 规范化、建筑识别与 Task Board 完成判定
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateTarget, evaluateBoard } from '../lib/planner/task-board.js'
import { normalizePrefab, isSamePrefab, matchStructure } from '../lib/planner/prefab-utils.js'
import { establishHomeTasks } from '../lib/skills/establish-home-adapter.js'

function makeSnapshotWithStructures(structures = []) {
  return {
    schema: 'bws.state/1',
    actor: { tileX: 0, tileZ: 0 },
    nearby: {
      buckets: {
        structures: structures.map((s, idx) => ({
          ref: `#${idx + 1}`,
          prefab: s.prefab,
          position: { x: s.x, z: s.z },
          distance: Math.hypot(s.x, s.z),
        })),
      },
    },
  }
}

test('PREFAB-01: normalizePrefab 与 isSamePrefab 正确处理别名与规范化', () => {
  assert.equal(normalizePrefab('sciencemachine'), 'researchlab')
  assert.equal(normalizePrefab('researchlab'), 'researchlab')
  assert.equal(normalizePrefab('alchemyengine'), 'researchlab2')
  assert.equal(normalizePrefab('researchlab2'), 'researchlab2')
  assert.equal(normalizePrefab('chest'), 'treasurechest')
  assert.equal(normalizePrefab('treasurechest'), 'treasurechest')

  assert.ok(isSamePrefab('sciencemachine', 'researchlab'))
  assert.ok(isSamePrefab('alchemyengine', 'researchlab2'))
  assert.ok(isSamePrefab('chest', 'treasurechest'))
  assert.ok(!isSamePrefab('sciencemachine', 'alchemyengine'))
})

test('PREFAB-02: researchlab 能够完成 sciencemachine 目标', () => {
  const target = {
    type: 'structure',
    prefab: 'sciencemachine',
    near: { x: 10, z: 10, radius: 8 },
  }
  const snap = makeSnapshotWithStructures([
    { prefab: 'researchlab', x: 12, z: 12 },
  ])
  const res = evaluateTarget(target, snap, {})
  assert.equal(res.done, true, '快照中存在 researchlab 应判定 sciencemachine 目标完成')
  assert.equal(res.current, 1)
})

test('PREFAB-03: researchlab2 能够完成 alchemyengine 目标', () => {
  const target = {
    type: 'structure',
    prefab: 'alchemyengine',
    near: { x: 0, z: 0, radius: 10 },
  }
  const snap = makeSnapshotWithStructures([
    { prefab: 'researchlab2', x: 3, z: 3 },
  ])
  const res = evaluateTarget(target, snap, {})
  assert.equal(res.done, true, '快照中存在 researchlab2 应判定 alchemyengine 目标完成')
})

test('PREFAB-04: treasurechest 能够完成 chest 目标', () => {
  const target = {
    type: 'structure',
    prefab: 'chest',
    near: { x: 0, z: 0, radius: 10 },
  }
  const snap = makeSnapshotWithStructures([
    { prefab: 'treasurechest', x: 2, z: 2 },
  ])
  const res = evaluateTarget(target, snap, {})
  assert.equal(res.done, true, '快照中存在 treasurechest 应判定 chest 目标完成')
})

test('PREFAB-05: 营地范围以外的科学机器不能完成 build_first_structure', () => {
  const target = {
    type: 'structure',
    prefab: 'sciencemachine',
    near: { x: 10, z: 10, radius: 8 },
  }
  // 建筑在 (25, 25)，距离营地 (10,10) 超过 8 格
  const snap = makeSnapshotWithStructures([
    { prefab: 'researchlab', x: 25, z: 25 },
  ])
  const res = evaluateTarget(target, snap, {})
  assert.equal(res.done, false, '超出营地半径的科学机器不能算完成')
  assert.equal(res.reason, 'structure_outside_camp_radius')
})

test('PREFAB-06: 建筑不在快照中，但已存在可靠的 known_buildings 证据时正确判定完成', () => {
  const target = {
    type: 'structure',
    prefab: 'sciencemachine',
    near: { x: 10, z: 10, radius: 8 },
  }
  // 快照中无建筑（角色已离开视野）
  const snap = makeSnapshotWithStructures([])
  const memory = {
    known_buildings: [
      { id: 'building:researchlab@11,11', prefab: 'researchlab', x: 11, z: 11 },
    ],
  }
  const res = evaluateTarget(target, snap, memory)
  assert.equal(res.done, true, 'known_buildings 中在营地范围内的 researchlab 应算作完成')
})

test('PREFAB-07: known_buildings 中在营地范围外的建筑不能算作完成', () => {
  const target = {
    type: 'structure',
    prefab: 'sciencemachine',
    near: { x: 10, z: 10, radius: 8 },
  }
  const snap = makeSnapshotWithStructures([])
  const memory = {
    known_buildings: [
      { id: 'building:researchlab@30,30', prefab: 'researchlab', x: 30, z: 30 },
    ],
  }
  const res = evaluateTarget(target, snap, memory)
  assert.equal(res.done, false, 'known_buildings 中超出营地半径的建筑不得算作完成')
})

test('PREFAB-08: 科学机器完成后，set_home 能自动解锁并推进', () => {
  const camp = { x: 10, z: 10 }
  const memory = {
    camp_site: camp,
    known_buildings: [],
  }
  const snapBefore = makeSnapshotWithStructures([])
  const tasks = establishHomeTasks({ memory, snapshot: snapBefore })
  const board = { schema: 'bws.task-board/1', tasks }

  // 1. 建造前：build_first_structure 为 ready (如果材料齐) 或 pending/blocked，set_home 为 blocked
  const evaluatedBefore = evaluateBoard(board, { snapshot: snapBefore, memory })
  const setHomeBefore = evaluatedBefore.tasks.find((t) => t.id === 'set_home')
  assert.equal(setHomeBefore.status, 'blocked', '科学机器未建成前 set_home 必须处于 blocked')

  // 2. 科学机器在营地内建成（生成 researchlab）
  const snapAfter = makeSnapshotWithStructures([
    { prefab: 'researchlab', x: 11, z: 11 },
  ])
  // travel_to_camp 与收集任务已完成
  const travelTask = board.tasks.find((t) => t.id === 'travel_to_camp')
  if (travelTask) travelTask.status = 'done'
  for (const t of board.tasks) {
    if (t.id.startsWith('gather_')) t.status = 'done'
  }

  const evaluatedAfter = evaluateBoard(board, { snapshot: snapAfter, memory })
  const buildTask = evaluatedAfter.tasks.find((t) => t.id === 'build_first_structure')
  const setHomeAfter = evaluatedAfter.tasks.find((t) => t.id === 'set_home')

  assert.equal(buildTask.status, 'done', '科学机器建成后 build_first_structure 必须变为 done')
  assert.equal(setHomeAfter.status, 'ready', 'build_first_structure 完成后 set_home 必须自动解锁为 ready')
})
