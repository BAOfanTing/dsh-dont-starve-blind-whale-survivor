// TARGET-REFRESH 方案 B：稳定 target_handle（不暴露 GUID，跨扫描稳定，过期即拒）
//
// 证据类型：
//   · UNIT        —— Node 侧参数放宽与"句柄路径不走快照校验"
//   · INTEGRATION —— fengari 沙箱里跑真实 nearby/targetrules/guard（假实体，**不是真机**）
//
// 覆盖任务书 §6 的：
//   1) 附近快照连续刷新时，稳定句柄仍能解析同一目标
//   3) 同一个 #1 在新快照中指向其他实体时，不能误操作
//   4) 目标消失后返回 target_gone

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACTION_SPECS, validateArgs } from '../../lib/dispatcher.js'
import { TOOLS } from '../../lib/tools.js'
import { ents, loadTargets } from '../helpers/target-harness.mjs'

/** 所有接受 #N 的动作都必须同时接受 target_handle */
const TARGET_REF_ACTIONS = Object.entries(ACTION_SPECS)
  .filter(([, spec]) => spec.requiresSnapshot === true)
  .map(([name]) => name)

/** 补上"和引用无关的必填参数"（容器/给予类还有 item、use 还有 action），好把注意力集中在句柄上 */
function withRequired(spec, args) {
  const out = { ...args }
  for (const [name, rule] of Object.entries(spec.args)) {
    if (!rule.required || out[name] !== undefined) continue
    if (name === 'target_ref' || name === 'snapshot_id') continue
    out[name] = rule.pattern === '^[A-Z_]{1,24}$' ? 'ACTIVATE' : 'twigs'
  }
  return out
}

// ─────────────────────────── Node 侧（UNIT）───────────────────────────

test('TH-1：带 target_handle 时不再要求 target_ref / snapshot_id；不带时仍严格要求', () => {
  assert.ok(TARGET_REF_ACTIONS.length >= 10, `应该有十来个动作接受引用，实际 ${TARGET_REF_ACTIONS.length}`)
  for (const name of TARGET_REF_ACTIONS) {
    const spec = ACTION_SPECS[name]
    assert.ok(spec.args.target_handle, `${name} 的参数表里要有 target_handle`)
    // 只有句柄：通过（这是"不会过期"的关键）
    assert.equal(validateArgs(spec, withRequired(spec, { target_handle: 'h1a' })).ok, true, `${name} 只给句柄应该通过`)
    // 什么都不给：仍然拒（不能因为放宽而被静默放过）
    const none = validateArgs(spec, withRequired(spec, {}))
    assert.equal(none.ok, false, `${name} 什么都不给必须拒`)
    assert.match(none.reason, /^missing_arg:/)
    // 句柄形状不对：拒
    for (const bad of ['1a', 'h', 'hZZZ', '#1', 'h1a; rm -rf /', 'x'.repeat(20)]) {
      assert.equal(validateArgs(spec, withRequired(spec, { target_handle: bad })).ok, false,
        `${name} 不该接受句柄 ${JSON.stringify(bad)}`)
    }
    // 两种引用都给也合法（句柄优先），但 extra 字段仍然被拒
    assert.equal(validateArgs(spec, withRequired(spec, { target_handle: 'h1a', target_ref: '#3', snapshot_id: 'r1-n1', guid: 'x' })).ok, false)
  }
})

test('TH-2：工具表里也能看见 target_handle（说明要讲清"跨快照有效、不会过期"）', () => {
  for (const name of TARGET_REF_ACTIONS) {
    const tool = TOOLS.find((t) => t.name === name)
    assert.ok(tool?.inputSchema?.properties?.target_handle, `${name} 的工具参数表缺少 target_handle`)
    assert.match(tool.inputSchema.properties.target_handle.description, /跨|稳定|不会过期/)
    assert.match(tool.description, /target_handle/, `${name} 的说明里要提到 target_handle`)
  }
})

// ─────────────────────────── Lua 侧（INTEGRATION）───────────────────────────

test('TH-3（INTEGRATION）：附近连续刷新时，稳定句柄仍解析**同一个**实体', async () => {
  const env = await loadTargets({ entities: [ents.flint({ guid: 11, x: 4, z: 0 }), ents.twigs({ guid: 12, x: 6, z: 0 })] })
  env.buildNearby()
  const h1 = env.handleOf('flint')
  assert.notEqual(h1, 'nil', '可拾取物应该拿到句柄')
  assert.match(h1, /^h[0-9a-z]+$/, '句柄形状：h + base36')
  assert.doesNotMatch(h1, /11/, '句柄**不能**是 GUID')

  // 连扫三帧（世界内容不变 → 编号复用；即便编号变了，句柄也必须稳定）
  env.buildNearby()
  env.buildNearby()
  const h2 = env.handleOf('flint')
  assert.equal(h2, h1, '同一个目标在多次扫描之间句柄必须稳定')

  // 世界变了（多了一个无关实体）→ 快照号一定换，但同一块燧石的句柄不能变
  const before = env.snap()
  env.setWorld([ents.flint({ guid: 11, x: 4, z: 0 }), ents.twigs({ guid: 12, x: 6, z: 0 }), ents.tree({ guid: 21, x: 12, z: 12 })])
  const after = env.buildNearby()
  assert.notEqual(after, before, '内容变了应该换编号')
  assert.equal(env.handleOf('flint'), h1, '换帧之后句柄仍然指向同一块燧石')

  // 用句柄（**不带 snapshot_id**）→ 必须放行，并且解析到 GUID 11
  env.setCmd(env.cmd({
    action: 'pickup',
    args: { target_handle: h1 },
    snapshot_id: null,
    target_ref: null,
  }))
  const out = env.validate()
  assert.equal(out.split('|')[0], 'true', `句柄应该放行，实际 ${out}`)
  assert.equal(out.split('|')[4], 'flint', '解析到的应该是燧石')
  assert.equal(out.split('|')[5], '11', '解析到的应该是那块燧石（GUID 只用于测试断言，不发给模型）')
})

test('TH-4（INTEGRATION）：#1 在新快照里指向别的实体时，句柄不会跟着跑', async () => {
  // 第一帧：#1 是燧石
  const env = await loadTargets({ entities: [ents.flint({ guid: 11, x: 4, z: 0 })] })
  env.buildNearby()
  const handle = env.handleOf('flint')

  // 第二帧：燧石没了，#1 变成树枝（真机里"#1 指向了别的东西"就是这么发生的）
  env.setWorld([ents.twigs({ guid: 12, x: 4, z: 0 })])
  env.buildNearby()
  assert.equal(env.handleOf('twigs') !== 'nil', true, '树枝自己也该有句柄')

  // ① 用**旧句柄**：目标（那块燧石）已经不在世界里 → target_gone，
  //    **绝不能**顺手换成"编号相同/位置相同的另一个东西"。
  env.setCmd(env.cmd({ action: 'pickup', args: { target_handle: handle }, snapshot_id: null, target_ref: null }))
  let out = env.validate()
  assert.equal(out.split('|')[0], 'false', `旧句柄不该被放行，实际 ${out}`)
  assert.equal(out.split('|')[1], 'target_gone', `应该是 target_gone，实际 ${out}`)

  // ② 用**旧快照的 #1**：快照号已经不匹配 → stale_snapshot（一次都不执行）
  env.setCmd(env.cmd({ action: 'pickup', args: { target_ref: '#1', snapshot_id: 'r-old-n1' } }))
  out = env.validate()
  assert.equal(out.split('|')[1], 'stale_snapshot', `旧快照应该被拒，实际 ${out}`)

  // ③ 用**当前快照的 #1**：那确实就是树枝 —— 模型看清楚了才这么填，属于正常操作。
  env.setCmd(env.cmd({ action: 'pickup', args: { target_ref: '#1', snapshot_id: env.snap() } }))
  out = env.validate()
  assert.equal(out.split('|')[0], 'true', `当前快照的 #1 应该放行，实际 ${out}`)
  assert.equal(out.split('|')[4], 'twigs', '当前 #1 是树枝')
})

test('TH-5（INTEGRATION）：目标消失 / 被捡走 / 进 limbo → 一律拒，且给出准确原因', async () => {
  const env = await loadTargets({ entities: [ents.flint({ guid: 11, x: 4, z: 0 }), ents.twigs({ guid: 12, x: 6, z: 0 })] })
  env.buildNearby()
  const hFlint = env.handleOf('flint')
  const hTwigs = env.handleOf('twigs')

  // 燧石从世界上消失
  env.setWorld([ents.twigs({ guid: 12, x: 6, z: 0 })])
  env.buildNearby()
  env.setCmd(env.cmd({ action: 'pickup', args: { target_handle: hFlint }, snapshot_id: null, target_ref: null }))
  assert.equal(env.validate().split('|')[1], 'target_gone')

  // 树枝被别的玩家拿走了（owner 不为空）
  env.setWorld([`mkent({ prefab = "twigs", guid = 12, x = 6, z = 0, pickup = true, owner = PLAYER })`])
  env.buildNearby()
  assert.equal(env.handleOf('twigs'), 'nil', '被拿走的不能再进可拾取桶 / 不该再发句柄')

  // 用旧句柄 → 也必须是 target_gone（不能解析到一个"被拿走的"东西上）
  env.setCmd(env.cmd({ action: 'pickup', args: { target_handle: hTwigs }, snapshot_id: null, target_ref: null }))
  const out = env.validate()
  assert.equal(out.split('|')[0], 'false', `被拿走的句柄不该放行，实际 ${out}`)
  assert.ok(['target_gone', 'target_taken', 'unknown_handle'].includes(out.split('|')[1]), `实际原因 ${out}`)
})

test('TH-6（INTEGRATION）：句柄绑定会话/角色 —— 换世界后旧句柄必须失效', async () => {
  const env = await loadTargets({ entities: [ents.flint({ guid: 11, x: 4, z: 0 })] })
  env.buildNearby()
  const handle = env.handleOf('flint')
  env.setCmd(env.cmd({ action: 'pickup', args: { target_handle: handle }, snapshot_id: null, target_ref: null }))
  assert.equal(env.validate().split('|')[0], 'true', '同一会话内应该放行')

  // 模拟"重新进世界"：runtime_id / session 变了 → 注册表整体作废
  env.run('Whale.targetrules.BindSession("r-other-0001", "sess-OTHER", "player:KU_t")')
  env.setCmd(env.cmd({ action: 'pickup', args: { target_handle: handle }, snapshot_id: null, target_ref: null }))
  const out = env.validate()
  assert.equal(out.split('|')[0], 'false', `换世界后旧句柄必须失效，实际 ${out}`)
  assert.equal(out.split('|')[1], 'unknown_handle', `应该是 unknown_handle，实际 ${out}`)
})

test('TH-7（INTEGRATION）：句柄不能由模型自己编出来', async () => {
  const env = await loadTargets({ entities: [ents.flint({ guid: 11, x: 4, z: 0 })] })
  env.buildNearby()
  const real = env.handleOf('flint')
  // 挑几个"长得像但不是注册表里的"句柄（含真实句柄的下一个序号）
  const forged = ['hzz', 'hdeadbe', 'hqqqq', 'h999', 'h' + (real === 'h1' ? '2' : '1')]
  for (const fake of forged) {
    assert.notEqual(fake, real, '测试自身要选一个不是真句柄的值')
    env.setCmd(env.cmd({ action: 'pickup', args: { target_handle: fake }, snapshot_id: null, target_ref: null }))
    const out = env.validate()
    assert.equal(out.split('|')[0], 'false', `${fake} 不该被放行`)
    assert.equal(out.split('|')[1], 'unknown_handle', `${fake} 应该是 unknown_handle，实际 ${out}`)
  }
})

test('TH-8（INTEGRATION）：句柄路径下，原有的候选资格 / 成熟度 / 距离复核一条都没省', async () => {
  // 一棵**未成熟**的浆果丛：有句柄，但 harvest 必须因为 not_ready 被拒
  const env = await loadTargets({ entities: [ents.berrybush({ ready: false, x: 1, z: 0 })] })
  env.buildNearby()
  const h = env.handleOf('berrybush')
  assert.notEqual(h, 'nil', '未成熟的植株仍然会被观察（流程需要看到它）')
  env.setCmd(env.cmd({ action: 'harvest', args: { target_handle: h }, snapshot_id: null, target_ref: null }))
  const out = env.validate()
  assert.equal(out.split('|')[0], 'false', `未成熟的不能采，实际 ${out}`)
  assert.equal(out.split('|')[1], 'not_ready', `实际原因 ${out}`)

  // 远处的东西：句柄有效，但距离不够
  const far = await loadTargets({ entities: [ents.flint({ x: 40, z: 0 })] })
  far.buildNearby()
  const hFar = far.handleOf('flint')
  far.setCmd(far.cmd({ action: 'pickup', args: { target_handle: hFar }, snapshot_id: null, target_ref: null }))
  const out2 = far.validate()
  assert.equal(out2.split('|')[0], 'false', `够不着的不该放行，实际 ${out2}`)
  assert.equal(out2.split('|')[1], 'out_of_range', `实际原因 ${out2}`)
})

test('TH-9（INTEGRATION）：句柄对砍树/挖矿同样有效，且仍然要求正确的工作类型', async () => {
  const env = await loadTargets({ entities: [ents.tree({ guid: 21, x: 5, z: 0 }), ents.rock({ guid: 22, x: 6, z: 0 })] })
  env.buildNearby()
  const hTree = env.handleOf('evergreen')
  const hRock = env.handleOf('rock1')
  assert.notEqual(hTree, 'nil')
  assert.notEqual(hRock, 'nil')

  env.setCmd(env.cmd({ action: 'chop', args: { target_handle: hTree }, snapshot_id: null, target_ref: null }))
  let out = env.validate()
  assert.equal(out.split('|')[0], 'true', `砍树应该放行，实际 ${out}`)
  assert.equal(out.split('|')[4], 'evergreen')

  env.setCmd(env.cmd({ action: 'mine', args: { target_handle: hRock }, snapshot_id: null, target_ref: null }))
  out = env.validate()
  assert.equal(out.split('|')[0], 'true', `挖矿应该放行，实际 ${out}`)
  assert.equal(out.split('|')[4], 'rock1')

  // 用砍树的动作去指石头 → 仍然是 wrong_work_action（句柄不改变动作与目标的匹配规则）
  env.setCmd(env.cmd({ action: 'chop', args: { target_handle: hRock }, snapshot_id: null, target_ref: null }))
  out = env.validate()
  assert.equal(out.split('|')[0], 'false', `砍石头不该放行，实际 ${out}`)
  assert.equal(out.split('|')[1], 'wrong_work_action', `实际原因 ${out}`)
})

test('TH-10（INTEGRATION）：gather 类目标（草丛/树苗/花）也要发句柄 —— 否则"能用句柄"是假话', async () => {
  // 真机发现：sapling / grass / flower 拿不到句柄，但 gather 又是接受 target_handle 的动作之一。
  // 这就是"工具说明能用、实际永远拿不到"的说明书漂移，必须堵住。
  const env = await loadTargets({
    entities: [
      `mkent({ prefab = "sapling", guid = 41, x = 2, z = 0, pickable = true, ready = true, product = "twigs" })`,
      `mkent({ prefab = "grass", guid = 42, x = 3, z = 0, pickable = true, ready = true, product = "cutgrass" })`,
      `mkent({ prefab = "flower", guid = 43, x = 4, z = 0, pickable = true, ready = true, product = "petals" })`,
    ],
  })
  env.buildNearby()
  for (const prefab of ['sapling', 'grass', 'flower']) {
    assert.notEqual(env.handleOf(prefab), 'nil', `${prefab} 应该拿到句柄（gather 接受 target_handle）`)
  }
  const h = env.handleOf('sapling')
  env.setCmd(env.cmd({ action: 'gather', args: { target_handle: h }, snapshot_id: null, target_ref: null }))
  const out = env.validate()
  assert.equal(out.split('|')[0], 'true', `gather 用句柄应该放行，实际 ${out}`)
  assert.equal(out.split('|')[4], 'sapling')

  // 采空（未成熟）的草丛：句柄仍然在（目标还在世界里），但 gather 必须被 not_ready 拒
  const unripe = await loadTargets({
    entities: [`mkent({ prefab = "grass", guid = 44, x = 2, z = 0, pickable = true, ready = false, product = "cutgrass" })`],
  })
  unripe.buildNearby()
  const h2 = unripe.handleOf('grass')
  assert.notEqual(h2, 'nil', '未采的草丛也要有句柄（句柄只表示"目标还在"）')
  unripe.setCmd(unripe.cmd({ action: 'gather', args: { target_handle: h2 }, snapshot_id: null, target_ref: null }))
  const out2 = unripe.validate()
  assert.equal(out2.split('|')[0], 'false', `采空的草丛不该放行，实际 ${out2}`)
  assert.equal(out2.split('|')[1], 'not_ready', `实际原因 ${out2}`)
})

test('TH-11（INTEGRATION）：威胁实体（蜘蛛）分配稳定句柄，且 kill 使用 target_handle 成功放行', async () => {
  const env = await loadTargets({
    entities: [
      `mkent({ prefab = "spider", guid = 51, x = 3, z = 0, health = 100, tags = { hostile = true, monster = true, spider = true } })`,
    ],
  })
  env.buildNearby()
  const handle = env.handleOf('spider')
  assert.notEqual(handle, 'nil', '蜘蛛应该拿到稳定句柄（以支持无需快照的 kill/attack）')
  assert.match(handle, /^h[0-9a-z]+$/, '句柄格式必须是 h + base36')

  // 用句柄下发 kill 指令（不需要 snapshot_id / target_ref）
  env.setCmd(env.cmd({ action: 'kill', args: { target_handle: handle }, snapshot_id: null, target_ref: null }))
  const out = env.validate()
  assert.equal(out.split('|')[0], 'true', `kill 用 target_handle 应该放行，实际 ${out}`)
  assert.equal(out.split('|')[4], 'spider', '解析到的目标必须是蜘蛛')
  assert.equal(out.split('|')[5], '51', '解析到的必须是 GUID 51')
})

// ─────────── 真机回归（session 8fab0944）：会移动的怪不该被 6 格窗口拒掉 ───────────
//
// 现象：模型读快照时蜘蛛 hem 在 1.8 格，30 秒后 kill 指令到达时它已游荡到 8 格，
//       直接被 guard 的 6 格上限拒成 out_of_range —— 可 ACTIONS.ATTACK 本身就会寻路过去。

test('TH-12（INTEGRATION）：怪游荡到 8 格外，kill 仍应放行（攻击动作自己会走过去）', async () => {
  // 8 格 = 32 世界单位
  const env = await loadTargets({
    entities: [
      `mkent({ prefab = "spider", guid = 61, x = 32, z = 0, health = 100, tags = { hostile = true, monster = true, spider = true } })`,
    ],
  })
  env.buildNearby()
  const h = env.handleOf('spider')
  assert.notEqual(h, 'nil', '8 格外的蜘蛛仍在扫描半径内，应该有句柄')
  env.setCmd(env.cmd({ action: 'kill', args: { target_handle: h }, snapshot_id: null, target_ref: null }))
  const out = env.validate()
  assert.equal(out.split('|')[0], 'true', `8 格外的蜘蛛不该被拒（旧上限是 6 格），实际 ${out}`)
})

test('TH-13（INTEGRATION）：离谱远的目标（超过 32 格）仍然被拒，不能隔半张地图砍', async () => {
  const env = await loadTargets({
    entities: [
      `mkent({ prefab = "spider", guid = 62, x = 200, z = 0, health = 100, tags = { hostile = true, monster = true, spider = true } })`,
    ],
  })
  env.buildNearby()
  // 200 世界单位 = 50 格，远超扫描半径，nearby 里不会有它 → 句柄拿不到
  const h = env.handleOf('spider')
  assert.equal(h, 'nil', '50 格外的蜘蛛不在附近，不该有句柄')
})


