// 内置 AI 的背包记忆：只吃 dispatcher 的结构化核对结果
//
// 之前是靠正则解析 describe() 的中文回执（"【已核对】cutgrass +1，吃掉 1 个"）。
// 改一句措辞、加一种变化，记忆就会静默失配。这里锁住新契约：
// 文本怎么变都不影响，字段说了算；没有核对结果就绝不动记忆。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyVerified } from '../../lib/agent.js'
import { gatheringSpecs } from '../../lib/actions/specs/gathering.js'

test('采集：product + gained 进背包', () => {
  const inv = applyVerified({}, 'gather', {}, { product: 'cutgrass', gained: 2 })
  assert.equal(inv.cutgrass, 2)
})

test('拾取食物：真实 pickup 核对回传的 prefab 也计入背包', () => {
  const before = {
    player: { inventory: { items: [{ prefab: 'carrot', count: 1 }] } },
    nearby: { buckets: { pickupables: [{ ref: '#2', prefab: 'carrot' }] } },
  }
  const after = { player: { inventory: { items: [{ prefab: 'carrot', count: 3 }] } } }
  const args = { target_ref: '#2', snapshot_id: 'n1' }
  const verified = gatheringSpecs.pickup.verify(before, after, args)
  assert.equal(verified.ok, true)
  assert.deepEqual(applyVerified({ carrot: 1 }, 'pickup', args, verified), { carrot: 3 })
})

test('范围采集：products 里每个产物各自累加', () => {
  const inv = applyVerified({ cutgrass: 1 }, 'gather_area', {}, {
    gained: 4,
    products: [{ prefab: 'cutgrass', gained: 2 }, { prefab: 'twigs', gained: 2 }],
  })
  assert.equal(inv.cutgrass, 3)
  assert.equal(inv.twigs, 2)
})

test('craft：成品进背包，但自动装备的不算（它在手上）', () => {
  assert.equal(applyVerified({}, 'craft', { recipe: 'axe' }, { made: 1 }).axe, 1)
  const auto = applyVerified({}, 'craft', { recipe: 'torch' }, { made: 1, how: 'auto_equipped', hand: 'torch' })
  assert.equal(auto.torch, undefined, '自动装备的火把不在背包里')
  const autoBody = applyVerified({}, 'craft', { recipe: 'backpack' }, { made: 1, how: 'auto_equipped_body' })
  assert.equal(autoBody.backpack, undefined, '任意 auto_equipped* 前缀都不应重复记入背包')
})

test('eat：按 used 扣掉吃的那个，扣到 0 就删键', () => {
  assert.equal(applyVerified({ berries: 3 }, 'eat', { food: 'berries' }, { used: 1 }).berries, 2)
  assert.equal(applyVerified({ berries: 1 }, 'eat', { food: 'berries' }, { used: 1 }).berries, undefined)
})

test('fuel / drop / container_put / give：都按 used 扣', () => {
  for (const tool of ['fuel', 'drop', 'container_put', 'give']) {
    const inv = applyVerified({ twigs: 2 }, tool, { item: 'twigs' }, { used: 1, prefab: 'twigs' })
    assert.equal(inv.twigs, 1, `${tool} 应该扣 1 个`)
  }
})

test('没有核对结果就绝不动记忆（宁可少记，不许瞎猜）', () => {
  const before = { twigs: 2 }
  assert.deepEqual(applyVerified(before, 'gather', {}, null), before)
  assert.deepEqual(applyVerified(before, 'gather', {}, {}), before)
})

test('扣减不会出现负数（快照与记忆不一致时不崩）', () => {
  const inv = applyVerified({}, 'eat', { food: 'berries' }, { used: 5 })
  assert.equal(inv.berries, undefined)
})
