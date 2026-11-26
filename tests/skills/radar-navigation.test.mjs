import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyMemory } from '../../lib/planner/world-memory.js'
import { recordExploration, findKnownResource, exploreFrontier } from '../../lib/skills/explore-utils.js'
import { gatherMaterial } from '../../lib/skills/skill-utils.js'
import { foodAction } from '../../lib/skills/food-candidate-selector.js'

test('RADAR-01: 32 格远景雷达将沿途关键资源实时登记到 WorldMemory known_resources', () => {
  const memory = emptyMemory('test_world')
  const snapshot = {
    actor: { tileX: 10, tileZ: 20 },
    nearby: {
      buckets: {
        resources: [
          { prefab: 'rock2', position: { x: 28, z: 25 }, distance: 18.7 }, // 金矿脉
          { prefab: 'evergreen', position: { x: 12, z: 22 }, distance: 2.8 }, // 树木
        ],
        harvestables: [
          { prefab: 'berrybush', position: { x: 35, z: 20 }, distance: 25 }, // 远景成熟浆果
        ],
        structures: [
          { prefab: 'pighouse', position: { x: -10, z: 20 }, distance: 20 }, // 猪人房
        ],
        pickupables: [
          { prefab: 'flint', position: { x: 11, z: 20 }, distance: 1 },
        ],
      },
    },
  }

  recordExploration(memory, snapshot)

  assert.equal(Array.isArray(memory.known_resources), true)
  assert.ok(memory.known_resources.some((r) => r.prefab === 'rock2' && r.category === 'mineral'))
  assert.ok(memory.known_resources.some((r) => r.prefab === 'berrybush' && r.category === 'food'))
  assert.ok(memory.known_resources.some((r) => r.prefab === 'pighouse' && r.category === 'landmark'))

  // 检查开图区域
  assert.equal(Array.isArray(memory.explored_regions), true)
  assert.ok(memory.explored_regions.length >= 1)
  assert.equal(memory.explored_region_count, memory.explored_regions.length)
})

test('RADAR-02: 内存中已记录的资源，gatherMaterial 直接导航前往，不调用 seek', () => {
  const memory = emptyMemory('test_world')
  // 模拟之前探索记录过的金矿
  memory.known_resources.push({
    id: 'rock2@45,60',
    prefab: 'rock2',
    category: 'mineral',
    x: 45,
    z: 60,
    updated_at: Date.now(),
  })

  // 当前快照（当前视野 32 格内什么都没有）
  const snapshot = {
    actor: { tileX: 0, tileZ: 0 },
    nearby: { buckets: { resources: [], harvestables: [], pickupables: [], structures: [] } },
    inventory: { items: { '0': { prefab: 'pickaxe', count: 1 } } },
  }

  const act = gatherMaterial(snapshot, 'goldnugget', memory)
  assert.equal(act.tool, 'move_to', '当记忆中有已知金矿时，应直接 move_to 过去')
  assert.equal(act.args.x, 45)
  assert.equal(act.args.z, 60)
})

test('RADAR-03: 内存中已记录的食物，foodAction 直接 move_to 导航，不调用 seek', () => {
  const memory = emptyMemory('test_world')
  memory.known_resources.push({
    id: 'berrybush@30,40',
    prefab: 'berrybush',
    category: 'food',
    x: 30,
    z: 40,
    updated_at: Date.now(),
  })

  const snapshot = {
    actor: { tileX: 0, tileZ: 0 },
    player: { hunger: { percent: 30 } },
    nearby: { buckets: { resources: [], harvestables: [], pickupables: [], structures: [] } },
    inventory: { items: {} },
  }

  const act = foodAction(snapshot, { memory, need: 'hunger' })
  assert.equal(act.tool, 'move_to', '当记忆中有已知食物时，直接 move_to 过去')
  assert.equal(act.args.x, 30)
  assert.equal(act.args.z, 40)
})

test('RADAR-04: 定向开图 exploreFrontier 直线前压 20 格并绝对避开危险区', () => {
  const memory = emptyMemory('test_world')
  // 在角色正东方 (20, 0) 设置危险区（蜘蛛巢/巨鹿）
  memory.danger_zones.push({ x: 20, z: 0, radius: 10, source: 'threat' })
  // 正西方曾经探索过
  memory.explored_regions.push({ id: 'chunk_-1_0', x: -16, z: 0, radius: 16 })

  const snapshot = {
    actor: { tileX: 0, tileZ: 0 },
  }

  const act = exploreFrontier(snapshot, memory, { distance: 20 })
  assert.equal(act.tool, 'move_to')
  assert.ok(typeof act.args.x === 'number')
  assert.ok(typeof act.args.z === 'number')

  // 验证绝对没有走向正东危险区 (20, 0)
  const distToDanger = Math.hypot(act.args.x - 20, act.args.z - 0)
  assert.ok(distToDanger >= 12, `探路方向必须避开危险区，实际与危险源距离: ${distToDanger}`)

  // 验证前进距离约为 20 格
  const stepDist = Math.hypot(act.args.x - 0, act.args.z - 0)
  assert.ok(Math.abs(stepDist - 20) <= 2, `前压距离应约为 20 格，实际: ${stepDist}`)
})

test('RADAR-05: 贴身采集后已消失的资源自动从 WorldMemory 中移除', () => {
  const memory = emptyMemory('test_world')
  memory.known_resources.push({
    id: 'rock2@10,10',
    prefab: 'rock2',
    category: 'mineral',
    x: 10,
    z: 10,
    updated_at: Date.now() - 5000,
  })

  // 角色已经走到 (10, 10)，当前快照显示该矿石已不存在（被挖采完毕）
  const snapshot = {
    actor: { tileX: 10, tileZ: 10 },
    nearby: {
      buckets: {
        resources: [],
        harvestables: [],
        pickupables: [],
        structures: [],
      },
    },
  }

  recordExploration(memory, snapshot)
  assert.equal(memory.known_resources.some((r) => r.id === 'rock2@10,10'), false, '已采空的资源应从记忆中清除')
})
