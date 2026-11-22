// 战斗动作规格与核对测试（包含 attack、kill 的参数校验、伤害与击杀核对）
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTION_SPECS, OPEN_ACTIONS, validateArgs } from '../lib/dispatcher.js'
import { TOOLS } from '../lib/tools.js'

test('combat-1：attack 与 kill 在白名单里，且都有 riskLevel 与 verify', () => {
  for (const name of ['attack', 'kill']) {
    assert.ok(OPEN_ACTIONS.includes(name), `${name} 应该在白名单里`)
    const spec = ACTION_SPECS[name]
    assert.ok(spec, `${name} 应该有规格`)
    assert.ok(['R1', 'R2'].includes(spec.riskLevel), `${name} 的 riskLevel 不对`)
    assert.equal(typeof spec.verify, 'function', `${name} 必须有结果核对`)
  }
})

test('combat-2：attack/kill 要 #N + snapshot_id；attack 可以指定攻击次数', () => {
  for (const name of ['attack', 'kill']) {
    const spec = ACTION_SPECS[name]
    assert.equal(spec.requiresSnapshot, true)
    assert.ok(spec.args.target_ref && spec.args.snapshot_id)
    assert.equal(validateArgs(spec, { target_ref: '#2', snapshot_id: 'r1-n2' }).ok, true)
  }
  assert.equal(validateArgs(ACTION_SPECS.attack, { target_ref: '#2', snapshot_id: 'r1-n2', times: 3 }).ok, true)
  assert.equal(validateArgs(ACTION_SPECS.attack, { target_ref: '#2', snapshot_id: 'r1-n2', times: 0 }).ok, false)
  assert.equal(validateArgs(ACTION_SPECS.attack, { target_ref: '#2', snapshot_id: 'r1-n2', times: 51 }).ok, false)
})

const snap = (over = {}) => ({
  player: {
    inventory: {
      items: Object.entries(over.inv ?? {}).map(([prefab, count]) => ({ prefab, count })),
      used: 0,
      slots: 15,
    },
  },
  nearby: { buckets: { resources: over.items ?? [], creatures: over.creatures ?? [] } },
})

test('combat-3：attack 核对 —— 血量下降算成功', () => {
  const spec = ACTION_SPECS.attack
  const spider = { ref: '#3', prefab: 'spider', position: { x: 7, z: 7 }, health: 100 }
  const before = snap({ creatures: [spider] })
  const after = snap({ creatures: [{ ...spider, health: 75 }] })
  const v = spec.verify(before, after, { target_ref: '#3' })
  assert.equal(v.ok, true)
  assert.equal(v.hpFrom, 100)
  assert.equal(v.hpTo, 75)
})

test('combat-4：attack 核对 —— 目标消失（击杀）算成功', () => {
  const spec = ACTION_SPECS.attack
  const spider = { ref: '#3', prefab: 'spider', position: { x: 7, z: 7 }, health: 100 }
  const before = snap({ creatures: [spider] })
  const after = snap({ creatures: [] })
  const v = spec.verify(before, after, { target_ref: '#3' })
  assert.equal(v.ok, true)
  assert.equal(v.how, 'target_gone')
})

test('combat-5：attack 核对 —— 血量未变判失败', () => {
  const spec = ACTION_SPECS.attack
  const spider = { ref: '#3', prefab: 'spider', position: { x: 7, z: 7 }, health: 100 }
  const same = snap({ creatures: [spider] })
  const v = spec.verify(same, same, { target_ref: '#3' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'target_hp_unchanged')
})

test('combat-6：attack / kill 工具描述包含引用与快照说明', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]))
  for (const name of ['attack', 'kill']) {
    assert.match(byName[name].description, /#N/, `${name} 要说明用 #N 引用`)
    assert.match(byName[name].description, /快照 ID|snapshot/, `${name} 要提醒带快照 ID`)
    assert.ok(!byName[name].inputSchema.required.includes('snapshot_id'), `${name} 的 snapshot_id 在 schema 不再必填（由 validateArgs 二选一强制）`)
  }
})

// ─────────── 真机回归（session 8fab0944）：只给 target_handle 时的核对 ───────────
//
// 现象：`attack {target_handle:"hi0", times:5}` 打了蜘蛛巢 5 下，
//       回执却是「游戏说做完了，但没核对上（unknown_ref）」。
// 根因：verify 只认 args.target_ref，句柄路径下它是 undefined → itemOfRef 返回 null。

test('combat-7：只给 target_handle 时，attack 的核对也要能认出目标（不再 unknown_ref）', () => {
  const spec = ACTION_SPECS.attack
  const den = { ref: '#1', handle: 'hi0', prefab: 'spiderden', position: { x: -18, z: 60 }, health: 250 }
  const before = snap({ creatures: [den] })
  const after = snap({ creatures: [{ ...den, health: 122 }] })
  const v = spec.verify(before, after, { target_handle: 'hi0', times: 5 })
  assert.equal(v.ok, true, '血量从 250 掉到 122 必须判成功')
  assert.equal(v.hpFrom, 250)
  assert.equal(v.hpTo, 122)
})

test('combat-8：句柄目标血量没变时仍然判失败（放宽核对不等于放松核对）', () => {
  const spec = ACTION_SPECS.kill
  const spider = { ref: '#2', handle: 'hem', prefab: 'spider', position: { x: -9, z: 61 }, health: 100 }
  const same = snap({ creatures: [spider] })
  const v = spec.verify(same, same, { target_handle: 'hem' })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'target_hp_unchanged')
})

test('combat-9：会移动的生物（蜘蛛）跑开后，不能被误判成"目标消失了"', () => {
  const spec = ACTION_SPECS.kill
  // 打之前：蜘蛛在 (-9,61)
  const before = snap({ creatures: [{ ref: '#2', handle: 'hem', prefab: 'spider', position: { x: -9, z: 61 }, health: 100 }] })
  // 打完：它跑到 (-11,63)，血掉到 60 —— 同一个实体，只是挪了两格
  const after = snap({ creatures: [{ ref: '#1', handle: 'hem', prefab: 'spider', position: { x: -11, z: 63 }, health: 60 }] })
  const v = spec.verify(before, after, { target_handle: 'hem' })
  assert.equal(v.ok, true, '句柄相同就是同一个实体，坐标变了也要能对上')
  assert.equal(v.hpFrom, 100)
  assert.equal(v.hpTo, 60)
  assert.notEqual(v.how, 'target_gone', '不能因为怪挪了位置就谎报"打倒了"')
})

test('combat-10：真的打死了（目标从快照里消失）才算 target_gone', () => {
  const spec = ACTION_SPECS.kill
  const before = snap({ creatures: [{ ref: '#2', handle: 'hem', prefab: 'spider', position: { x: -9, z: 61 }, health: 100 }] })
  const after = snap({ creatures: [] })
  const v = spec.verify(before, after, { target_handle: 'hem' })
  assert.equal(v.ok, true)
  assert.equal(v.how, 'target_gone')
})
