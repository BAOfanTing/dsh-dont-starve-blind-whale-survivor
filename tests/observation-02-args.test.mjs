// OBSERVATION-02：参数归一化
//
// 真机会话 session-403656e9 里，模型把 target_ref 传成 `15`（数字）和 `"15"`（忘了 #），
// 被硬拒成 bad_type / bad_format，白烧 3 次调用。
//
// 归一化只做**纯格式**处理（补 # 号 / 去空白），**不放宽安全**：
// 归一之后照样要过 snapshot_id 校验和 Lua 的 Resolve。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTION_SPECS, normalizeArgs, validateArgs } from '../lib/dispatcher.js'
import { executeTool } from '../lib/tools.js'

test('OBS2-6：target_ref 的数字/裸数字/带空格都能归一成 #N', () => {
  const spec = ACTION_SPECS.pickup
  for (const [input, want] of [
    [15, '#15'],
    ['15', '#15'],
    ['#15', '#15'],
    [' #15 ', '#15'],
    [15.9, '#15'],
    ['#007', '#7'],   // 去前导零，规范化
  ]) {
    const out = normalizeArgs(spec, { target_ref: input, snapshot_id: 'r1-n2' })
    assert.equal(out.target_ref, want, `${JSON.stringify(input)} 应该归一成 ${want}`)
    assert.equal(validateArgs(spec, out).ok, true, `${JSON.stringify(input)} 归一后应该通过校验`)
  }
})

test('OBS2-7：归一化不放宽安全 —— 非法值仍然被拒', () => {
  const spec = ACTION_SPECS.pickup
  for (const bad of ['abc', '#abc', -1, 0, '1; rm -rf /', 'x'.repeat(40), '#12x']) {
    const out = normalizeArgs(spec, { target_ref: bad, snapshot_id: 'r1-n2' })
    const checked = validateArgs(spec, out)
    assert.equal(checked.ok, false, `${JSON.stringify(bad)} 不该通过（实际 ${checked.reason}）`)
  }
  // 缺 snapshot_id 仍然拒
  assert.equal(validateArgs(spec, normalizeArgs(spec, { target_ref: '#1' })).ok, false)
})

test('OBS2-8：归一化只碰 target_ref 和去空白，不动别的字段', () => {
  const spec = ACTION_SPECS.craft
  const out = normalizeArgs(spec, { recipe: '  axe  ' })
  assert.equal(out.recipe, 'axe', '字符串字段应该去掉首尾空白')
  assert.equal(validateArgs(spec, out).ok, true)

  // 数字字段原样保留
  const moveSpec = ACTION_SPECS.move_to
  const moved = normalizeArgs(moveSpec, { x: 12.5, z: -3 })
  assert.equal(moved.x, 12.5)
  assert.equal(moved.z, -3)
})

test('OBS2-9：未知字段不会被归一化悄悄放进来', () => {
  const spec = ACTION_SPECS.pickup
  const out = normalizeArgs(spec, { target_ref: 1, snapshot_id: 'r1-n2', guid: 'evil', x: 5 })
  assert.equal(out.guid, 'evil', '归一化不做白名单（白名单由 validateArgs 负责）')
  const checked = validateArgs(spec, out)
  assert.equal(checked.ok, false)
  assert.match(checked.reason, /unknown_arg/, `应该报未知参数，实际 ${checked.reason}`)
})

test('OBS2-10：走完整 executeTool 时，模型传数字 target_ref 也能正常下发', async () => {
  const commands = []
  const bridge = {
    readState: () => ({ json: { data: {
      schema: 'bws.state/1',
      observer: { snapshot_id: 's1', sequence: 1, status: 'ok' },
      actor: { valid: true, actor_type: 'player', prefab: 'wilson', name: 'w', alive: true, is_ghost: false, tile_x: 1, tile_z: 2 },
      player: { inventory: { used: 0, items: {}, slots: 15 } },
      world: { day: 1, phase_name: '白天', status: 'ok' },
      nearby: { status: 'ok', snapshot_id: 'r1-n2', radius: 16, buckets: { pickupables: [{ ref: '#1', prefab: 'flint', position: { x: 1, z: 2 }, distance: 0.5 }] } },
    } }, ageMs: 0, mtimeMs: Date.now() }),
    call: async (action, args) => { commands.push({ action, args }); return { ok: true, text: '捡了 flint×1' } },
    leaseDirs: () => [],
    readLeaseAck: () => null,
  }
  const control = {
    validate: () => ({ ok: true, lease: { owner_type: 'system', owner_instance_id: 'i', authority_epoch: 'e', generation: 1, lease_id: 'l', expires_at: Date.now() + 30000 } }),
    readAuthority: () => ({ status: 'active' }),
    completeHandover: () => ({ ok: true }),
  }
  const text = await executeTool('pickup', { target_ref: 1, snapshot_id: 'r1-n2' }, {
    bridge, control, owner: 'system', ownerInstanceId: 'i', notes: { read: () => '', write: () => {} }, guides: {},
  })
  assert.equal(commands.length, 1, `应该下发了 1 条命令，实际 ${commands.length}（回执：${text}）`)
  assert.equal(commands[0].args.target_ref, '#1', '下发到游戏的必须是补好 # 的引用')
})
