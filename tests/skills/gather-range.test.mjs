// Phase R.7.4-A 回归测试：资源距离判断必须与 Lua gather_area 的搜索半径一致。
//
// 真机问题：MATERIAL_SPEC 里 twigs / cutgrass / petals 曾写成 range: Infinity。
// 结果 JS 认为 20 格外的草丛"可采"，直接调 gather_area；而 Lua 只在 8 格内搜，
// 找不到 → rejected → 上层原地重试，角色原地不动。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  gatherMaterial,
  LUA_GATHER_SEARCH_RADIUS,
  PICKUP_INTERACTION_RANGE,
  WORK_NEAREST_RANGE,
} from '../../lib/skills/skill-utils.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATHERING_LUA = join(ROOT, 'DontStarveWhaleSurvivor', 'scripts', 'whale', 'actions', 'gathering.lua')

function snapWith(bucketKey, items, actor = { tileX: 0, tileZ: 0 }) {
  return {
    actor,
    player: { in_light: true },
    nearby: { buckets: { [bucketKey]: items } },
  }
}

test('JS 采集搜索半径常量必须与 Lua gather_area 默认半径一致', () => {
  const lua = readFileSync(GATHERING_LUA, 'utf8')
  const m = lua.match(/j\.data\.radius\s*=\s*tonumber\(ctx\.radius\)\s*or\s*(\d+)/)
  assert.ok(m, 'gathering.lua 里应能找到 gather_area 默认半径（j.data.radius = ... or N）')
  assert.equal(Number(m[1]), LUA_GATHER_SEARCH_RADIUS,
    `Lua 默认采集半径 ${m[1]} 与 JS 常量 ${LUA_GATHER_SEARCH_RADIUS} 不一致，两端必须同步`)
})

test('目标资源在 Lua 搜索范围外 → 必须先 move_to，不能直接 gather_area', () => {
  const far = LUA_GATHER_SEARCH_RADIUS + 7 // 明显超出搜索半径
  for (const [prefab, bucket] of [['twigs', 'harvestables'], ['cutgrass', 'harvestables'], ['petals', 'harvestables']]) {
    const plant = prefab === 'twigs' ? 'sapling' : prefab === 'cutgrass' ? 'grass' : 'flower'
    const snap = snapWith(bucket, [{ prefab: plant, harvest_ready: true, position: { x: far, z: 0 } }])
    const act = gatherMaterial(snap, prefab)
    assert.equal(act.tool, 'move_to', `${prefab} 在 ${far} 格外时必须先 move_to（不能直接 gather_area）`)
    assert.deepEqual(act.args, { x: far, z: 0 })
  }
})

test('目标在搜索范围外很远（100 格）也不会误判为可采集（杜绝 range=Infinity）', () => {
  const snap = snapWith('harvestables', [{ prefab: 'sapling', harvest_ready: true, position: { x: 100, z: 0 } }])
  const act = gatherMaterial(snap, 'twigs')
  assert.equal(act.tool, 'move_to', '100 格外的树苗不该被当成"可以就地 gather_area"')
})

test('目标在搜索范围之内 → 才执行 gather_area', () => {
  const near = LUA_GATHER_SEARCH_RADIUS - 3
  const snap = snapWith('harvestables', [{ prefab: 'grass', harvest_ready: true, position: { x: near, z: 0 } }])
  const act = gatherMaterial(snap, 'cutgrass')
  assert.equal(act.tool, 'gather_area')
  assert.deepEqual(act.args, { prefab: 'grass' })
})

test('pickup / work 半径常量是明确且有限的（不是 Infinity）', () => {
  assert.ok(Number.isFinite(PICKUP_INTERACTION_RANGE) && PICKUP_INTERACTION_RANGE > 0)
  assert.ok(Number.isFinite(WORK_NEAREST_RANGE) && WORK_NEAREST_RANGE > 0)
  // 燧石在 2.5 格外应先靠近再捡
  const snap = snapWith('pickupables', [{ prefab: 'flint', position: { x: 10, z: 0 } }])
  const act = gatherMaterial(snap, 'flint')
  assert.equal(act.tool, 'move_to', '10 格外的燧石必须先 move_to（pickup_nearest 只对手边 2.5 格有效）')
})
