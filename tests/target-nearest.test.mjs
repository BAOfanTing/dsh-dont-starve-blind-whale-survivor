// TARGET-REFRESH：实时目标选择（Node 枚举 ↔ Lua 枚举一致 + guard 实时找目标）
//
// 证据类型：
//   · UNIT        —— Node 侧的枚举/规格/参数校验（不碰 Lua）
//   · INTEGRATION —— fengari 沙箱里跑真实 targetrules.lua / guard.lua（假实体，**不是真机**）
//
// 覆盖任务书 §6 的：
//   2) 快照编号改变后，实时目标选择仍能找到燧石
//   11) 新增 Node/Lua 工具白名单保持一致（枚举逐条对齐）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ACTION_SPECS, OPEN_ACTIONS, validateArgs } from '../lib/dispatcher.js'
import { TOOLS } from '../lib/tools.js'
import {
  KIND_ACTION,
  KIND_PREFABS,
  TREE_PREFIXES,
  kindPrefabs,
  kindsFor,
  isKindForAction,
  kindProducts,
} from '../lib/actions/target-kinds.js'
import { MOD, ents, loadTargets } from './target-harness.mjs'

// ─────────────────────────── Node 侧（UNIT）───────────────────────────

const NEAREST_ACTIONS = ['pickup_nearest', 'pickup_food', 'harvest_nearest', 'chop_nearest', 'mine_nearest']

test('TN-1：五个实时目标选择动作都在白名单里，且**不需要 snapshot_id**', () => {
  for (const name of NEAREST_ACTIONS) {
    const spec = ACTION_SPECS[name]
    assert.ok(spec, `缺少规格：${name}`)
    assert.notEqual(spec.requiresSnapshot, true, `${name} 不能要求快照（这正是它不会过期的原因）`)
    assert.equal(typeof spec.verify, 'function', `${name} 必须有结果核对`)
    assert.ok(['R1', 'R2'].includes(spec.riskLevel))
    // 参数表里不能出现 target_ref / snapshot_id —— 模型只能给类别
    assert.deepEqual(Object.keys(spec.args).sort(), ['radius', 'target_kind'].sort())
    assert.ok(spec.args.target_kind, `${name} 要有 target_kind`)
  }
  assert.equal(ACTION_SPECS.pickup_food.args.target_kind.required, undefined, 'pickup_food 的类别可以不填（默认安全食物）')
  for (const name of NEAREST_ACTIONS.filter((n) => n !== 'pickup_food')) {
    assert.equal(ACTION_SPECS[name].args.target_kind.required, true, `${name} 的类别必填`)
  }
})

test('TN-2：target_kind 是固定枚举 —— 未知值在 Node 侧就被拒（不会发到游戏）', () => {
  for (const name of NEAREST_ACTIONS) {
    const spec = ACTION_SPECS[name]
    const allowed = spec.args.target_kind.enum
    assert.ok(Array.isArray(allowed) && allowed.length > 0, `${name} 的 target_kind 要有 enum`)
    assert.equal(validateArgs(spec, { target_kind: allowed[0] }).ok, true)
    for (const bad of ['evergreen', 'GUID123', 'os.execute', 'Flint', '']) {
      const r = validateArgs(spec, { target_kind: bad })
      assert.equal(r.ok, false, `${name} 不该接受 target_kind=${JSON.stringify(bad)}`)
    }
    // 不许夹带 prefab / 坐标 / GUID
    for (const extra of [{ prefab: 'flint' }, { x: 1, z: 2 }, { guid: 7 }, { target_ref: '#1' }]) {
      const r = validateArgs(spec, { target_kind: allowed[0], ...extra })
      assert.equal(r.ok, false, `${name} 不该接受夹带字段 ${Object.keys(extra)[0]}`)
      assert.match(r.reason, /^unknown_arg:/)
    }
  }
})

test('TN-3：工具表里的 enum 与规格派生一致（模型看到的和校验的不能是两份表）', () => {
  for (const name of NEAREST_ACTIONS) {
    const tool = TOOLS.find((t) => t.name === name)
    assert.ok(tool, `工具表缺少 ${name}`)
    assert.deepEqual(tool.inputSchema.properties.target_kind.enum, ACTION_SPECS[name].args.target_kind.enum)
    assert.ok(tool.description.length > 40, `${name} 的说明要讲清楚`)
    assert.match(tool.description, /不需要|不会过期/, `${name} 要说明"不需要快照/不会过期"`)
  }
})

test('TN-4：动作与类别不能错配（chop_nearest 不许挖石头）', () => {
  assert.equal(isKindForAction('chop_nearest', 'tree'), true)
  assert.equal(isKindForAction('chop_nearest', 'gold_vein'), false)
  assert.equal(isKindForAction('mine_nearest', 'gold_vein'), true)
  assert.equal(isKindForAction('mine_nearest', 'tree'), false)
  assert.equal(isKindForAction('pickup_food', 'safe_ground_food'), true)
  assert.equal(isKindForAction('pickup_food', 'pumpkin'), true)
  assert.equal(isKindForAction('pickup_food', 'flint'), false)
  assert.equal(isKindForAction('harvest_nearest', 'mushroom'), true)
  assert.equal(isKindForAction('harvest_nearest', 'tree'), false)
  // 每个 nearest 动作的 enum 里都只有自己那一类
  for (const kind of kindsFor('chop_nearest')) assert.equal(KIND_ACTION[kind], 'chop')
  for (const kind of kindsFor('mine_nearest')) assert.equal(KIND_ACTION[kind], 'mine')
})

test('TN-5：核对依据是"这一类该到手的东西"（不是 Lua 说了算）', () => {
  assert.deepEqual(kindProducts('flint'), ['flint'])
  assert.deepEqual(kindProducts('twigs'), ['twigs'])
  assert.ok(kindProducts('tree').includes('log'), '砍树要认 log')
  assert.ok(kindProducts('ordinary_rock').includes('rocks'), '挖普通石头要认 rocks')
  assert.ok(kindProducts('gold_vein').includes('goldnugget'), '挖金矿要认 goldnugget')
  assert.ok(kindProducts('safe_ground_food').includes('pumpkin'), '安全食物要认南瓜')
  assert.ok(kindProducts('ripe_food_plant').includes('berries'))
  // 生蘑菇**不是**自动安全食物（吃了掉理智）
  assert.ok(!kindProducts('safe_ground_food').includes('green_cap'))
  assert.ok(!kindProducts('safe_ground_food').includes('red_cap'))
})

test('TN-11：Node 与 Lua 的 target_kind 枚举/白名单逐条一致（两边不能各写一套）', () => {
  const lua = readFileSync(join(MOD, 'scripts', 'whale', 'targetrules.lua'), 'utf8')

  // KIND_ACTION：解析 Lua 的 T.KIND_ACTION = { name = "action", ... }
  const actionBlock = lua.match(/T\.KIND_ACTION = \{([\s\S]*?)\n\}/)
  assert.ok(actionBlock, '解析不到 T.KIND_ACTION（targetrules.lua 结构变了？）')
  const luaAction = {}
  for (const m of actionBlock[1].matchAll(/([a-z_]+)\s*=\s*"([a-z_]+)"/g)) luaAction[m[1]] = m[2]
  assert.deepEqual(Object.keys(luaAction).sort(), Object.keys(KIND_ACTION).sort(),
    'Node 与 Lua 的 target_kind 清单必须完全一致')
  for (const [kind, action] of Object.entries(luaAction)) {
    assert.equal(action, KIND_ACTION[kind], `${kind} 的动作类型两边不一致`)
  }

  // KIND_PREFABS：逐条比白名单集合
  for (const [kind, prefabs] of Object.entries(KIND_PREFABS)) {
    for (const prefab of prefabs) {
      assert.ok(
        new RegExp(`T\\.KIND_PREFABS[\\s\\S]*?\\b${kind}\\s*=\\s*\\{[\\s\\S]*?\\b${prefab}\\s*=\\s*true`)
          .test(lua.slice(lua.indexOf('T.KIND_PREFABS'))),
        `Lua 侧 ${kind} 的白名单里应该有 ${prefab}`,
      )
    }
  }

  // 树的**前缀**白名单：Lua 用的是前缀匹配，两边必须同源
  const prefixBlock = lua.match(/T\.TREE_PREFIXES = \{([\s\S]*?)\n\}/)
  assert.ok(prefixBlock, '解析不到 T.TREE_PREFIXES')
  const luaPrefixes = [...prefixBlock[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1])
  assert.deepEqual(luaPrefixes.sort(), [...TREE_PREFIXES].sort(), '树的前缀白名单两边必须一致')

  // 树/矿的**能力**约束必须同时存在（光有 prefab 不够）
  assert.match(lua, /workable/, 'Lua 侧必须要求 workable 组件')
  assert.match(lua, /"CHOP"/, 'Lua 侧必须要求 CHOP')
  assert.match(lua, /"MINE"/, 'Lua 侧必须要求 MINE')

  // 两个"并集"类别的白名单也必须同源（否则 Node 说要涨 berries、Lua 却找不到浆果丛）
  const ripeBlock = lua.match(/T\.RIPE_FOOD_PLANT_PREFABS = \{([\s\S]*?)\n\}/)
  assert.ok(ripeBlock, '解析不到 T.RIPE_FOOD_PLANT_PREFABS')
  const luaRipe = [...ripeBlock[1].matchAll(/([a-z_0-9]+)\s*=\s*true/g)].map((m) => m[1]).sort()
  assert.deepEqual(luaRipe, kindPrefabs('ripe_food_plant').slice().sort(),
    'ripe_food_plant 的 prefab 并集两边必须一致')

  const eatrules = readFileSync(join(MOD, 'scripts', 'whale', 'eatrules.lua'), 'utf8')
  const autoBlock = eatrules.match(/E\.AUTO_SAFE = \{([\s\S]*?)\n\}/)
  assert.ok(autoBlock, '解析不到 eatrules 的 AUTO_SAFE')
  const luaAuto = [...autoBlock[1].matchAll(/([a-z_0-9]+)\s*=\s*true/g)].map((m) => m[1]).sort()
  assert.deepEqual(luaAuto, kindPrefabs('safe_ground_food').slice().sort(),
    'safe_ground_food 必须和 eatrules.AUTO_SAFE 完全一致（生蘑菇不算）')
})

// ─────────────────────────── Lua 侧（INTEGRATION）───────────────────────────

test('TN-6（INTEGRATION）：快照编号变了以后，pickup_nearest(flint) 仍能找到燧石', async () => {
  const env = await loadTargets({ entities: [ents.flint({ x: 4, z: 0 }), ents.twigs({ x: 6, z: 0 })] })
  const first = env.buildNearby()
  assert.ok(first.startsWith('r'), `应该拿到 nearby 快照号，实际 ${first}`)

  // 世界变了：多了一个无关实体 → 内容指纹变 → 快照号一定换
  env.setWorld([ents.flint({ x: 4, z: 0 }), ents.twigs({ x: 6, z: 0 }), ents.tree({ x: 10, z: 10 })])
  const second = env.buildNearby()
  assert.notEqual(second, first, '世界内容变了，快照号必须换（这是 stale_snapshot 的来源）')

  // 关键：模型**不带任何 snapshot_id / #N**，只说"要 flint"
  env.setCmd(env.cmd({
    action: 'pickup_nearest',
    args: { target_kind: 'flint' },
    snapshot_id: null,
    target_ref: null,
  }))
  const out = env.validate()
  assert.equal(out.split('|')[0], 'true', `pickup_nearest(flint) 应该通过，实际 ${out}`)
  assert.equal(out.split('|')[2], 'true', '要带出解析好的真实实体')
})

test('TN-7（INTEGRATION）：target_kind 非法 / 与动作错配 → 拒绝，并给出合法清单', async () => {
  const env = await loadTargets({ entities: [ents.flint()] })
  env.buildNearby()

  env.setCmd(env.cmd({ action: 'pickup_nearest', args: { target_kind: 'evergreen' }, snapshot_id: null, target_ref: null }))
  let out = env.validate()
  assert.equal(out.split('|')[1], 'target_kind_not_allowed', `实际 ${out}`)
  assert.match(out.split('|')[3], /flint/, '拒绝时要把合法的 target_kind 列出来')

  env.setCmd(env.cmd({ action: 'chop_nearest', args: { target_kind: 'gold_vein' }, snapshot_id: null, target_ref: null }))
  out = env.validate()
  assert.equal(out.split('|')[1], 'target_kind_mismatch', `实际 ${out}`)
})

test('TN-8（INTEGRATION）：砍树/挖矿只挑白名单内的（冰岩、月岩不算普通石头）', async () => {
  const env = await loadTargets({
    entities: [ents.tree({ x: 5, z: 0 }), ents.rock({ x: 6, z: 0 }), ents.rockIce({ x: 2, z: 0 }), ents.goldVein({ x: 6, z: 2 })],
  })
  env.buildNearby()

  env.setCmd(env.cmd({ action: 'chop_nearest', args: { target_kind: 'tree' }, snapshot_id: null, target_ref: null }))
  assert.equal(env.validate().split('|')[0], 'true', '应该能找到树')

  env.setCmd(env.cmd({ action: 'mine_nearest', args: { target_kind: 'ordinary_rock' }, snapshot_id: null, target_ref: null }))
  assert.equal(env.validate().split('|')[0], 'true', '应该能找到普通石头')

  env.setCmd(env.cmd({ action: 'mine_nearest', args: { target_kind: 'gold_vein' }, snapshot_id: null, target_ref: null }))
  assert.equal(env.validate().split('|')[0], 'true', '应该能找到金矿脉')
})

test('TN-9（INTEGRATION）：附近没有那类东西 → no_target；有但够不着 → out_of_range 并给出坐标', async () => {
  const far = await loadTargets({ entities: [ents.flint({ x: 60, z: 0 })] })
  far.buildNearby()
  far.setCmd(far.cmd({ action: 'pickup_nearest', args: { target_kind: 'flint' }, snapshot_id: null, target_ref: null }))
  let out = far.validate()
  assert.equal(out.split('|')[1], 'out_of_range', `远了应该是 out_of_range，实际 ${out}`)
  assert.match(out.split('|')[3], /move_to/, '要告诉模型先走过去')

  const none = await loadTargets({ entities: [ents.twigs()] })
  none.buildNearby()
  none.setCmd(none.cmd({ action: 'pickup_nearest', args: { target_kind: 'flint' }, snapshot_id: null, target_ref: null }))
  out = none.validate()
  assert.equal(out.split('|')[1], 'no_target', `一类都没有应该是 no_target，实际 ${out}`)
})

test('TN-10（INTEGRATION）：五类动作真的能跑起来（目标由服务端选中，仍然走原执行链）', async () => {
  const env = await loadTargets({
    entities: [
      ents.flint(), ents.berrybush(), ents.pumpkin(),
      // 砍树/挖矿的 reach 是 1.6 格（原生要贴脸才挥得动），所以测试里放近
      ents.tree({ x: 5, z: 0 }), ents.rock({ x: 6, z: 0 }),
    ],
  })
  env.buildNearby()
  const cases = [
    ['pickup_nearest', 'flint'],
    ['chop_nearest', 'tree'],
    ['mine_nearest', 'ordinary_rock'],
    ['harvest_nearest', 'ripe_food_plant'],
    ['pickup_food', undefined],
  ]
  for (const [action, kind] of cases) {
    env.setCmd(env.cmd({
      action,
      args: kind === undefined ? {} : { target_kind: kind },
      snapshot_id: null,
      target_ref: null,
    }))
    const out = env.validate()
    assert.equal(out.split('|')[0], 'true', `${action} 应该通过，实际 ${out}`)
  }
})

test('TN-12：Node 白名单与 Lua 白名单逐条一致（新增动作不许只在一侧）', () => {
  const guard = readFileSync(join(MOD, 'scripts', 'whale', 'guard_specs.lua'), 'utf8')
  const block = guard.match(/Whale\.guard_action_specs = \{([\s\S]*?)\n\}/)
  assert.ok(block, '解析不到 guard_specs.lua 的 guard_action_specs 表')
  const luaActions = [...block[1].matchAll(/^    ([a-z_]+) = \{/gm)].map((m) => m[1]).sort()
  assert.ok(luaActions.length >= 36, `Lua 侧动作表应该至少有 36 条，实际 ${luaActions.length}`)
  assert.deepEqual(luaActions, [...OPEN_ACTIONS].sort(),
    'Lua 的 G.ACTIONS 必须和 Node 的 OPEN_ACTIONS 完全一致（两边都是安全边界）')
})

test('TN-13：新动作**没有**自己的执行通道（仍然过一个 guard + 一个命令出口）', () => {
  const bridge = readFileSync(join(MOD, 'scripts', 'whale', 'bridge.lua'), 'utf8')
  // 仍然只有一条路：guard.validate → actions.Start
  assert.match(bridge, /guard\.validate\(cmd\)/, 'bridge 必须还是先过 guard')
  assert.match(bridge, /Whale\.actions\.Start\(/, '动作仍然由 actions.Start 起')
  // 新动作的类别只是**透传**给执行层，不做特殊分支
  assert.match(bridge, /target_kind = cmd\.args ~= nil and cmd\.args\.target_kind/)
  // bridge 里不能出现"绕过 guard 直接执行新动作"的分支
  for (const name of NEAREST_ACTIONS) {
    assert.doesNotMatch(bridge, new RegExp(`if action == "${name}"`), `bridge 不该为 ${name} 写特例`)
  }
  // 实时目标选择只在这两处：guard 解析目标 + targetrules 找目标
  const guard = readFileSync(join(MOD, 'scripts', 'whale', 'guard.lua'), 'utf8')
  assert.match(guard, /resolve_nearest_target/, 'guard 负责在授权那一刻重新找目标')
  assert.match(guard, /nearby\.ResolveHandle/, '句柄也只能经 guard 解析')
})

test('TN-15：走完整 dispatcher —— 不带快照也能下发，且核对的是"真到手了"', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { LeaseManager } = await import('../lib/control.js')
  const { createDispatcher } = await import('../lib/dispatcher.js')

  const ENV = { runtimeId: 'r-near', sessionId: 'sess-N', shardId: '1', actorId: 'player:KU_n' }
  const snap = (picked) => ({
    stale: false,
    actor: { actorId: 'player:KU_n', valid: true, alive: true, isGhost: false, tileX: 0, tileZ: 0 },
    identity: { sessionId: 'sess-N', shardId: '1' },
    nearby: {
      runtime_id: 'r-near', snapshot_id: 'r-near-n1', status: 'ok',
      buckets: { pickupables: picked ? [] : [{ ref: '#1', prefab: 'flint', distance: 0.5, position: { x: 0, z: 0 } }] },
    },
    player: { inventory: { used: picked ? 1 : 0, slots: 15, items: picked ? [{ prefab: 'flint', count: 1 }] : [] } },
  })
  const dir = mkdtempSync(join(tmpdir(), 'bws-near-'))
  try {
    const control = new LeaseManager({ file: join(dir, 'lease.json'), now: () => Date.now() })
    control.acquire('f8_agent', ENV, { ownerInstanceId: 'inst-A' })
    const calls = []
    const state = { picked: false }
    const d = createDispatcher({
      bridge: {
        call: async (action, args, opts) => {
          calls.push({ action, args, envelope: opts?.envelope })
          state.picked = true
          return { ok: true, text: '捡起了 燧石' }
        },
      },
      control,
      readSnapshot: () => snap(state.picked),
      now: () => 1700000000000,
      timeoutMs: 3000,
    })
    // ★ args 里没有 target_ref / snapshot_id
    const r = await d.dispatch({ tool: 'pickup_nearest', args: { target_kind: 'flint' }, owner: 'f8_agent', ownerInstanceId: 'inst-A' })
    assert.equal(r.status, 'succeeded', `实际 ${r.status}/${r.reason}`)
    assert.equal(r.verified?.prefab, 'flint', '核对要指出到底是哪一样到手了')
    assert.equal(r.verified?.gained, 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].envelope.action, 'pickup_nearest')
    assert.deepEqual(calls[0].envelope.args, { target_kind: 'flint' })
    // 信封里照旧带当前快照号（给 Lua 做诊断），但**校验**不依赖模型给的那个
    assert.equal(calls[0].envelope.snapshot_id, 'r-near-n1')

    // 反过来：没真到手 → unverified（不能因为 Lua 说"我做了"就算成功）
    const d2 = createDispatcher({
      bridge: { call: async () => ({ ok: true, text: '捡起了 燧石' }) },
      control,
      readSnapshot: () => snap(false),
      now: () => 1700000000000,
      timeoutMs: 1200,
    })
    const bad = await d2.dispatch({ tool: 'pickup_nearest', args: { target_kind: 'flint' }, owner: 'f8_agent', ownerInstanceId: 'inst-A' })
    assert.equal(bad.status, 'unverified')
    assert.equal(bad.reason, 'inventory_unchanged')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('TN-16（INTEGRATION）：JOBS 真存在，且 ctx.target 缺失时一律失败（绝不退回按 prefab 搜）', async () => {
  const env = await loadTargets({ entities: [ents.flint()] })
  env.buildNearby()
  env.run(`
    local names = { "pickup_nearest", "pickup_food", "harvest_nearest", "chop_nearest", "mine_nearest" }
    OUT = ""
    for _, n in ipairs(names) do
      if Whale.actions.JOBS[n] == nil then OUT = OUT .. "missing:" .. n .. ";" end
    end
    -- ctx.target == nil 时必须 fail（否则等于绕过了 guard 的白名单/距离校验）
    local j = { step = "start", args = {}, data = {}, ctx = {}, t0 = 0 }
    local st, why = Whale.actions.JOBS.pickup_nearest(j, PLAYER)
    OUT = OUT .. "|" .. tostring(st) .. "|" .. tostring(why)
  `)
  const out = env.get('OUT')
  assert.equal(out.split('|')[0], '', `这些动作必须都注册了：${out}`)
  assert.equal(out.split('|')[1], 'fail', '没有解析好的目标时必须 fail')
  assert.match(out.split('|')[2], /no_resolved_target/)
})
