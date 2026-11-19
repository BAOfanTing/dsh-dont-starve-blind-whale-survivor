// Phase G：统一决策仲裁 + Skill Executor + 三个技能（survival / establish_home / gather_resources）。
//
// 证据类型：UNIT（真实实现 + 合成可变世界 + 假 dispatcher）。
// 说明：这里验证的是**逻辑与真实证据核对**；真机（真实游戏）验收不在自动化里冒充。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeState } from '../lib/state/snapshot.js'
import { executeTool } from '../lib/tools.js'
import { createWorldMemoryStore } from '../lib/planner/world-memory.js'
import { createPlanner } from '../lib/planner/planner-core.js'
import { arbitrate } from '../lib/planner/decision-arbiter.js'
import { getSkill, hasSkill, listSkills, registerSkill, clearSkills } from '../lib/skills/skill-registry.js'
import { SkillExecutor } from '../lib/skills/skill-executor.js'
import { survivalStabilize } from '../lib/skills/survival-stabilize.js'

// ─────────────────────────── 合成可变世界 ───────────────────────────

function makeWorld(over = {}) {
  return {
    worldKey: 'cluster:A/shard:1',
    x: 0, z: 0, prefab: 'wilson', health: 100, hunger: 90, sanity: 90, phase: 'day',
    items: {}, // { idx: {prefab, count, percent?} }
    resources: [
      { prefab: 'evergreen', work_action: 'CHOP', position: { x: 6, z: 5 } },
      { prefab: 'rock1', work_action: 'MINE', position: { x: -5, z: 4 } },
    ],
    harvestables: [
      { prefab: 'berrybush', position: { x: 3, z: 2 }, harvest_ready: true },
      { prefab: 'sapling', position: { x: 2, z: 3 }, harvest_ready: true },
      { prefab: 'grass', position: { x: 1, z: 4 }, harvest_ready: true },
    ],
    pickupables: [{ prefab: 'flint', position: { x: 4, z: 1 } }],
    food: [],
    structures: [], threats: [], dangerZones: [],
    ...over,
  }
}

let itemSeq = 0
function addItem(world, prefab, n = 1) {
  for (const it of Object.values(world.items)) if (it.prefab === prefab) { it.count += n; return }
  world.items[String(itemSeq++)] = { prefab, count: n }
}
function removeItem(world, prefab, n = 1) {
  for (const it of Object.values(world.items)) if (it.prefab === prefab) { it.count = Math.max(0, it.count - n); return }
}
function haveItem(world, prefab) {
  let n = 0
  for (const it of Object.values(world.items)) if (it.prefab === prefab) n += it.count
  return n
}

function snapOf(world) {
  // 合成世界里，实体到角色的距离按当前位置实时算（模拟游戏每帧重算 distance）。
  const withDist = (items) => (items ?? []).map((it) => {
    const p = it?.position
    if (p && typeof p.x === 'number' && typeof p.z === 'number') {
      const d = Math.hypot(p.x - world.x, p.z - world.z)
      return { ...it, distance: Math.round(d * 10) / 10 }
    }
    return it
  })
  const raw = {
    data: {
      schema: 'bws.state/1',
      observer: { snapshot_id: 's', sequence: 1, status: 'ok', timestamp: 1, sampled_at: 1, sample_age_ms: 0 },
      identity: { session_id: 'sess', cluster_id: 'A', shard_id: '1', world_key: world.worldKey, world_key_source: 'cluster_id' },
      actor: { valid: true, alive: true, is_ghost: false, actor_type: 'player', prefab: world.prefab, name: 'W', tile_x: world.x, tile_z: world.z, x: world.x * 4, z: world.z * 4 },
      player: {
        health: { current: world.health, max: 100, percent: world.health },
        hunger: { current: world.hunger * 2, max: 200, percent: world.hunger },
        sanity: { current: world.sanity * 2, max: 200, percent: world.sanity },
        inventory: { items: world.items, slots: 15, is_full: false },
        equipment: { slots: {}, worn: [] },
        in_light: world.phase !== 'night' || world.inLight === true,
      },
      world: { day: 2, phase: world.phase, season: 'autumn' },
      nearby: { runtime_id: 'rt1', snapshot_id: 'r1-n2', status: 'ok', radius: 16, buckets: {
        resources: withDist(world.resources), food: withDist(world.food), harvestables: withDist(world.harvestables),
        pickupables: withDist(world.pickupables), structures: withDist(world.structures), threats: withDist(world.threats),
      } },
      danger_zones: world.dangerZones,
    },
  }
  return normalizeState(raw, { ageMs: 0 })
}

/** 假 dispatcher：按动作改变世界（模拟游戏真实生效）。silent 集合里的动作"假成功但不改世界"。 */
function makeDispatch(world, { silent = new Set(), rejectOn = () => null, calls = [] } = {}) {
  const handle = async (tool, args) => {
    calls.push({ tool, args })
    const rej = rejectOn(tool, args)
    if (rej) return { status: 'rejected', reason: rej }
    if (silent.has(tool)) return { status: 'succeeded' }
    switch (tool) {
      case 'move_to': world.x = args.x; world.z = args.z; return { status: 'succeeded' }
      case 'seek': {
        // 模拟探索：走几步并把目标放进对应桶（位置在角色附近 → 下一步就能采/砍）
        world.x += 2
        const near = { x: world.x + 2, z: world.z }
        const p = args.prefab
        if (p === 'flint' || p === 'twigs') world.pickupables.push({ prefab: p, position: near })
        else if (['sapling', 'grass', 'flower', 'berrybush'].includes(p)) world.harvestables.push({ prefab: p, position: near, harvest_ready: true })
        else if (p === 'tree') world.resources.push({ prefab: 'evergreen', work_action: 'CHOP', position: near })
        else if (p === 'rock') world.resources.push({ prefab: 'rock1', work_action: 'MINE', position: near })
        else if (p === 'gold') world.resources.push({ prefab: 'rock2', work_action: 'MINE', position: near })
        else world.resources.push({ prefab: p, position: near })
        return { status: 'succeeded' }
      }
      case 'gather_area': {
        const map = { grass: 'cutgrass', sapling: 'twigs', flower: 'petals' }
        addItem(world, map[args.prefab] ?? args.prefab, 2)
        return { status: 'succeeded' }
      }
      case 'chop_nearest': addItem(world, 'log', 2); return { status: 'succeeded' }
      case 'mine_nearest':
        if (String(args.target_kind).includes('gold')) addItem(world, 'goldnugget', 1)
        else addItem(world, 'rocks', 2)
        return { status: 'succeeded' }
      case 'pickup_nearest': addItem(world, args.target_kind === 'goldnugget' ? 'goldnugget' : (args.target_kind ?? 'flint'), 1); return { status: 'succeeded' }
      case 'pickup_food': addItem(world, 'berries', 2); return { status: 'succeeded' }
      case 'harvest_nearest': addItem(world, 'berries', 2); return { status: 'succeeded' }
      case 'eat': world.hunger = Math.min(100, world.hunger + 30); return { status: 'succeeded' }
      case 'craft': {
        if (args.recipe === 'boards') { removeItem(world, 'log', 4); addItem(world, 'boards', 1) }
        else if (args.recipe === 'rope') { removeItem(world, 'cutgrass', 3); addItem(world, 'rope', 1) }
        else if (args.recipe === 'cutstone') { removeItem(world, 'rocks', 3); addItem(world, 'cutstone', 1) }
        else if (args.recipe === 'transistor') { removeItem(world, 'goldnugget', 2); removeItem(world, 'cutstone', 1); addItem(world, 'transistor', 1) }
        else addItem(world, args.recipe, 1)
        return { status: 'succeeded' }
      }
      case 'build': {
        const prefab = args.recipe === 'sciencemachine' ? 'sciencemachine' : args.recipe
        world.structures.push({ prefab, position: { x: world.x, z: world.z }, distance: 1 })
        return { status: 'succeeded' }
      }
      case 'equip': return { status: 'succeeded' }
      default: return { status: 'succeeded' }
    }
  }
  return handle
}

function newExec(world, memory, opts = {}) {
  const calls = opts.calls ?? []
  const dispatch = opts.dispatch ?? makeDispatch(world, { calls, ...(opts.dispatchOpts ?? {}) })
  return new SkillExecutor({
    memory,
    worldKey: world.worldKey,
    readSnapshot: () => snapOf(world),
    dispatch,
    describe: (o) => (o ? `${o.status}${o.reason ? ':' + o.reason : ''}` : ''),
    log: () => {},
    save: opts.save ?? (() => {}),
    now: () => 1000,
  })
}

async function drive(exec, skillId, maxCalls = 25) {
  const results = []
  for (let i = 0; i < maxCalls; i++) {
    const r = await exec.run(skillId)
    results.push(r)
    if (r.status === 'completed' || r.status === 'failed' || r.status === 'blocked') return results
    if (r.status === 'rejected') return results
  }
  return results
}

// ─────────────────────────── 技能注册表 ───────────────────────────

test('SKILL-REG：三个内置技能已注册，且能从注册表取到', () => {
  for (const id of ['survival_stabilize', 'establish_home', 'gather_resources']) {
    assert.ok(hasSkill(id), `应注册 ${id}`)
    assert.equal(getSkill(id).id, id)
  }
  assert.ok(listSkills().length >= 3)
})

test('SKILL-REG：重复注册同名技能会抛错（防第二份实例偷跑）', () => {
  assert.throws(() => registerSkill(survivalStabilize), /已注册/)
})

// ─────────────────────────── Skill Executor 框架 ───────────────────────────

test('EXEC-1：能启动技能；同一技能重复调用是恢复而不是新建实例', async () => {
  // 用一个"永远阻塞"的技能，让实例停在 paused，便于观察恢复
  registerSkill({
    id: 'noop_hold', name: 'hold', steps: [{ id: 'x', title: 'x', isDone: () => false, nextAction: () => ({ blocked: 'wait' }) }],
  })
  const mem = {}
  const e = newExec(makeWorld(), mem)
  const r1 = await e.run('noop_hold')
  const inst1 = e.instanceOf('noop_hold')
  assert.equal(inst1.status, 'paused')
  const r2 = await e.run('noop_hold')
  assert.equal(e.instanceOf('noop_hold'), inst1, '重复启动必须复用同一个实例对象')
  assert.equal(Object.keys(mem.skill_instances).length, 1)
})

test('EXEC-2：步骤完成必须有快照证据（ok=true 但没变化 → 不算完成）', async () => {
  let flag = false
  registerSkill({
    id: 'needs_evidence', name: 'ev',
    steps: [{ id: 's', title: 's', isDone: () => flag, nextAction: () => ({ tool: 'wait', args: { seconds: 1 } }) }],
  })
  const world = makeWorld()
  const mem = {}
  // dispatcher 假成功但不改 flag（silent）
  const exec = newExec(world, mem, { dispatch: async () => ({ status: 'succeeded' }) })
  const r = await exec.run('needs_evidence')
  assert.equal(r.status, 'step_in_progress', '没有证据不能判完成')
  assert.equal(exec.instanceOf('needs_evidence').step_index, 0, '步骤不能前进')
  // 现在让证据出现
  flag = true
  const r2 = await exec.run('needs_evidence')
  assert.equal(r2.status, 'completed')
})

test('EXEC-3：失败次数达到上限后技能失败（不无限重试）', async () => {
  registerSkill({
    id: 'always_fail', name: 'f',
    steps: [{ id: 's', title: 's', isDone: () => false, nextAction: () => ({ tool: 'wait', args: { seconds: 1 } }) }],
    retry_policy: { max_step_attempts: 2 }, timeout_policy: { max_calls_per_step: 5 },
  })
  const exec = newExec(makeWorld(), {}, { dispatch: async () => ({ status: 'rejected', reason: 'nope' }) })
  const rs = await drive(exec, 'always_fail', 6)
  assert.equal(rs.at(-1).status, 'failed')
  assert.equal(exec.instanceOf('always_fail').status, 'failed')
})

test('EXEC-4：超出搜索预算 → 失败（防无限采集）', async () => {
  registerSkill({
    id: 'never_done', name: 'n',
    steps: [{ id: 's', title: 's', isDone: () => false, nextAction: () => ({ tool: 'wait', args: { seconds: 1 } }) }],
    retry_policy: { max_step_attempts: 99 }, timeout_policy: { max_calls_per_step: 3 },
  })
  const exec = newExec(makeWorld(), {}, { dispatch: async () => ({ status: 'succeeded' }) })
  const rs = await drive(exec, 'never_done', 10)
  assert.equal(rs.at(-1).status, 'failed')
  assert.match(String(exec.instanceOf('never_done').blocked_reason), /budget/)
})

test('EXEC-5：单角色单技能 —— 启动新技能会暂停旧技能并保留其步骤进度', async () => {
  registerSkill({ id: 'skillA', name: 'A', steps: [{ id: 'a', title: 'a', isDone: () => false, nextAction: () => ({ tool: 'wait', args: { seconds: 1 } }) }] })
  registerSkill({ id: 'skillB', name: 'B', steps: [{ id: 'b', title: 'b', isDone: () => false, nextAction: () => ({ tool: 'wait', args: { seconds: 1 } }) }] })
  const mem = {}
  const exec = newExec(makeWorld(), mem, { dispatch: async () => ({ status: 'succeeded' }) })
  await exec.run('skillA')
  const aStep = exec.instanceOf('skillA').step_index
  await exec.run('skillB')
  assert.equal(exec.instanceOf('skillA').status, 'paused', 'A 应被暂停')
  assert.equal(exec.instanceOf('skillA').step_index, aStep, 'A 的进度要保留')
  assert.equal(exec.instanceOf('skillB').status, 'in_progress')
})

test('EXEC-6：中断后恢复不重放已完成的动作（跳过 isDone 为真的步骤）', async () => {
  const done = { a: false, b: false }
  registerSkill({
    id: 'two_step', name: 'T',
    steps: [
      { id: 'a', title: 'a', isDone: () => done.a, nextAction: () => ({ tool: 'wait', args: { seconds: 1 } }) },
      { id: 'b', title: 'b', isDone: () => done.b, nextAction: () => ({ tool: 'wait', args: { seconds: 1 } }) },
    ],
    completion: () => done.a && done.b,
  })
  const world = makeWorld()
  const mem = {}
  const calls = []
  // 第一次：完成 a（dispatch 后把 done.a 置真）
  const exec1 = newExec(world, mem, {
    calls,
    dispatch: async (tool, args) => { calls.push({ tool, args }); done.a = true; return { status: 'succeeded' } },
  })
  await exec1.run('two_step')
  assert.equal(exec1.instanceOf('two_step').step_index, 1)
  const callsAfterA = calls.length
  // 模拟重启：同一 memory，新 executor
  const exec2 = newExec(world, mem, { calls, dispatch: async (t, a) => { calls.push({ tool: t, args: a }); done.b = true; return { status: 'succeeded' } } })
  const r = await exec2.run('two_step')
  assert.equal(r.status, 'completed')
  // a 步骤不该被再次执行：新增的调用只对应 b（wait 一次）
  assert.equal(calls.length - callsAfterA, 1)
})

// ─────────────────────────── survival_stabilize ───────────────────────────

test('SURV-SKILL：黑暗中会去弄光；弄到光后完成', async () => {
  const world = makeWorld({ phase: 'night', hunger: 80, resources: [], harvestables: [], items: { 0: { prefab: 'cutgrass', count: 2 }, 1: { prefab: 'twigs', count: 2 } } })
  world.inLight = false
  const mem = {}
  const calls = []
  // craft torch 后：晚上装火把（把 in_light 置真）
  const exec = newExec(world, mem, {
    calls,
    dispatch: async (tool, args) => {
      calls.push({ tool, args })
      if (tool === 'craft' && args.recipe === 'torch') { addItem(world, 'torch', 1); removeItem(world, 'cutgrass', 2); removeItem(world, 'twigs', 2); world.inLight = true }
      if (tool === 'equip' && args.item === 'torch') { world.inLight = true }
      return { status: 'succeeded' }
    },
  })
  const rs = await drive(exec, 'survival_stabilize', 12)
  assert.equal(rs.at(-1).status, 'completed', `应完成，实际 ${JSON.stringify(rs.at(-1))}`)
  // 必须尝试过弄光
  assert.ok(calls.some((c) => c.tool === 'craft' || c.tool === 'equip' || c.tool === 'build'), '黑暗时必须弄光')
})

test('EXEC-7：已完成的技能在世界退化后可重新打开（生存技能不能"完成一次就永久罢工"）', async () => {
  let flag = false
  let apply = true
  registerSkill({
    id: 'reopen_x', name: 'R',
    steps: [{ id: 's', title: 's', isDone: () => flag, nextAction: () => ({ tool: 'wait', args: { seconds: 1 } }) }],
    completion: () => flag,
  })
  const world = makeWorld()
  const mem = {}
  const exec = newExec(world, mem, { dispatch: async () => { if (apply) flag = true; return { status: 'succeeded' } } })
  const r1 = await exec.run('reopen_x')
  assert.equal(r1.status, 'completed')
  flag = false
  apply = false
  const r2 = await exec.run('reopen_x')
  assert.notEqual(r2.status, 'completed', '退化后不应直接返回已完成，必须重新打开去救')
  assert.equal(r2.status, 'step_in_progress')
})

test('EXEC-8：非生存技能遇到 P0/P1 生存紧急 → 自动暂停并交回生存（不再埋头建家）', async () => {
  const world = makeWorld({ phase: 'night', hunger: 30 }) // 夜晚无光 + 饿 → P0/P1
  world.inLight = false
  const mem = {}
  const calls = []
  const exec = newExec(world, mem, { calls, dispatch: async () => ({ status: 'succeeded' }) })
  const r = await exec.run('establish_home')
  assert.equal(r.status, 'blocked')
  assert.match(String(r.reason), /survival_preempt/)
  assert.equal(calls.length, 0, '被生存抢占时不应下发任何建家动作')
  assert.equal(exec.instanceOf('establish_home').status, 'paused', '建家技能应被暂停并保留进度')
})

test('EXEC-9：动作 out_of_range → 解析回执坐标先 move_to 过去，不算技能失败', async () => {
  let flag = false
  let moved = false
  registerSkill({
    id: 'range_x', name: 'RG',
    steps: [{ id: 's', title: 's', isDone: () => flag, nextAction: () => ({ tool: 'pickup_nearest', args: { target_kind: 'flint' } }) }],
    completion: () => flag,
  })
  const world = makeWorld()
  const mem = {}
  const calls = []
  const exec = newExec(world, mem, {
    calls,
    dispatch: async (tool, args) => {
      calls.push({ tool, args })
      if (tool === 'pickup_nearest') {
        if (!moved) return { status: 'rejected', reason: 'out_of_range', message: '拒绝：out_of_range｜最近的燧石在 15.2 格外 (37,-45)：先 move_to 过去再试' }
        flag = true
        return { status: 'succeeded' }
      }
      if (tool === 'move_to') { world.x = args.x; world.z = args.z; moved = true; return { status: 'succeeded' } }
      return { status: 'succeeded' }
    },
  })
  const rs = await drive(exec, 'range_x', 10)
  assert.equal(rs.at(-1).status, 'completed', `应完成，实际 ${JSON.stringify(rs.at(-1))}`)
  assert.ok(calls.some((c) => c.tool === 'move_to' && c.args.x === 37 && c.args.z === -45), '应按 out_of_range 坐标 move_to 到 (37,-45)')
})

test('EXEC-10：seek 找到目标并报坐标 → 下一步自动 move_to 过去（不再原地反复 seek）', async () => {
  let flag = false
  registerSkill({
    id: 'seek_x', name: 'S',
    steps: [{ id: 's', title: 's', isDone: () => flag, nextAction: () => ({ tool: 'seek', args: { prefab: 'rock2' } }) }],
    completion: () => flag,
  })
  const world = makeWorld()
  const calls = []
  const exec = newExec(world, {}, {
    calls,
    dispatch: async (tool, args) => {
      calls.push({ tool, args })
      if (tool === 'seek') return { status: 'succeeded', message: '找到了 1 个 rock2：岩石(22,-40)14格。先用 move_to 走过去（或直接对它用动作）' }
      if (tool === 'move_to') { world.x = args.x; world.z = args.z; return { status: 'succeeded' } }
      return { status: 'succeeded' }
    },
  })
  await exec.run('seek_x')          // 第 1 步：seek（应记下坐标）
  await exec.run('seek_x')          // 第 2 步：应 move_to (22,-40)
  assert.ok(calls.some((c) => c.tool === 'move_to' && c.args.x === 22 && c.args.z === -40), 'seek 报坐标后应自动 move_to 过去')
  assert.equal(calls.filter((c) => c.tool === 'seek').length, 1, '不应连续无脑 seek')
})

// ─────────────────────────── establish_home ───────────────────────────

test('HOME-SKILL-1：全新世界无家 → 自动勘察选址→前往→收料→建科学机器→设家→完成', async () => {
  const world = makeWorld()
  const mem = {}
  const calls = []
  const exec = newExec(world, mem, { calls })
  const rs = await drive(exec, 'establish_home', 80)
  assert.equal(rs.at(-1).status, 'completed', `应完成，实际：${JSON.stringify(rs.at(-1))} / 状态 ${JSON.stringify(exec.instanceOf('establish_home'))}`)
  assert.ok(mem.home_building_id, '必须登记 home_building_id')
  assert.ok(mem.camp_site && typeof mem.camp_site.x === 'number', '必须选定营地')
  // 必须真的建过 sciencemachine，且建之前到过营地
  assert.ok(calls.some((c) => c.tool === 'build' && c.args.recipe === 'sciencemachine'), '必须 build 科学机器')
  assert.ok(world.structures.some((s) => s.prefab === 'sciencemachine'), '科学机器必须真实出现')
})

test('HOME-SKILL-2：已经有家 → 直接完成，不重复建', async () => {
  const world = makeWorld({ structures: [{ prefab: 'sciencemachine', position: { x: 0, z: 0 }, distance: 1 }] })
  const mem = { home_building_id: 'building:sciencemachine@0,0', home_anchor: { prefab: 'sciencemachine', x: 0, z: 0, radius: 10 }, camp_site: { x: 0, z: 0 }, known_buildings: [{ id: 'building:sciencemachine@0,0', prefab: 'sciencemachine', x: 0, z: 0 }] }
  const calls = []
  const exec = newExec(world, mem, { calls })
  const r = await exec.run('establish_home')
  assert.equal(r.status, 'completed')
  assert.equal(calls.length, 0, '已有家时不应下发任何建造/收料动作')
})

test('HOME-SKILL-3：主选营地走不到 → 切换备选营地', async () => {
  const world = makeWorld()
  const mem = { camp_site: { x: 30, z: 30 }, backup_site: { x: 5, z: 5 }, skill_instances: {
    establish_home: { skill_id: 'establish_home', status: 'in_progress', step_index: 1, attempts: 0, step_attempts: {}, step_calls: {}, calls: 0, data: {}, started_at: 0, updated_at: 0 },
  } }
  const calls = []
  const exec = newExec(world, mem, {
    calls,
    dispatch: async (tool, args) => {
      calls.push({ tool, args })
      if (tool === 'move_to' && args.x === 30 && args.z === 30) return { status: 'rejected', reason: 'unreachable' }
      if (tool === 'move_to') { world.x = args.x; world.z = args.z; return { status: 'succeeded' } }
      return { status: 'succeeded' }
    },
  })
  // 第一次走主选失败
  await exec.run('establish_home')
  // 第二次应切到备选
  await exec.run('establish_home')
  assert.deepEqual(mem.camp_site, { x: 5, z: 5 }, '主选不可达后应切到备选营地')
})

// ─────────────────────────── gather_resources（含中间产物依赖） ───────────────────────────

test('GATHER-SKILL-1：缺 3 木板且木头充足 → 先做木板而不是一直砍树', async () => {
  const world = makeWorld({ items: {} })
  addItem(world, 'log', 12)
  const mem = { skill_instances: {
    gather_resources: { skill_id: 'gather_resources', status: 'pending', step_index: 0, attempts: 0, step_attempts: {}, step_calls: {}, calls: 0, data: { recipe: { boards: 3 } }, started_at: 0, updated_at: 0 },
  } }
  const calls = []
  const exec = newExec(world, mem, { calls })
  const rs = await drive(exec, 'gather_resources', 20)
  assert.equal(rs.at(-1).status, 'completed', `应完成，实际 ${JSON.stringify(rs.at(-1))}`)
  // 应当是 craft boards，而不是 chop（log 已经够了）
  assert.equal(calls.filter((c) => c.tool === 'craft' && c.args.recipe === 'boards').length, 3)
  assert.equal(calls.filter((c) => c.tool === 'chop_nearest').length, 0, '木头够时不应砍树')
})

test('GATHER-SKILL-2：缺木板且木头不足 → 先砍树补木头，再做木板', async () => {
  const world = makeWorld({ items: {} })
  const mem = { skill_instances: {
    gather_resources: { skill_id: 'gather_resources', status: 'pending', step_index: 0, attempts: 0, step_attempts: {}, step_calls: {}, calls: 0, data: { recipe: { boards: 2 } }, started_at: 0, updated_at: 0 },
  } }
  const calls = []
  const exec = newExec(world, mem, { calls })
  const rs = await drive(exec, 'gather_resources', 60)
  assert.equal(rs.at(-1).status, 'completed', `应完成，实际 ${JSON.stringify(rs.at(-1))}`)
  assert.ok(calls.some((c) => c.tool === 'chop_nearest'), '木头不足时必须先砍树')
  assert.equal(calls.filter((c) => c.tool === 'craft' && c.args.recipe === 'boards').length, 2)
})

test('GATHER-SKILL-3：skill_args 动态传入 target_items 并持久化，后续恢复不丢参数', async () => {
  const world = makeWorld({ items: {} })
  addItem(world, 'flint', 1)
  const mem = { skill_instances: {} }
  const calls = []
  const exec = newExec(world, mem, { calls })
  // 首次调用传入 target_items，要求 2 个燧石
  const r1 = await exec.run('gather_resources', { target_items: { flint: 2 } })
  const inst = mem.skill_instances.gather_resources
  assert.ok(inst, '实例必须已创建')
  assert.deepEqual(inst.data.skill_args.target_items, { flint: 2 })

  // 地上添加 1 个燧石
  addItem(world, 'flint', 1)
  // 第二次调用不带参数，验证原有 skill_args 依然被保留并驱动判定
  const r2 = await exec.run('gather_resources')
  assert.equal(r2.status, 'completed', '燧石补齐至 2 个后技能应判定完成')
  assert.deepEqual(inst.data.skill_args.target_items, { flint: 2 }, '恢复执行时原有 skill_args 必须保留')
})

test('GATHER-SKILL-4：skill_args 支持配方名字符串解析（如 researchlab2）', async () => {
  const world = makeWorld({ items: {} })
  // 预置满足 researchlab2 的成品材料（4 boards, 2 cutstone, 2 transistor）
  addItem(world, 'boards', 4)
  addItem(world, 'cutstone', 2)
  addItem(world, 'transistor', 2)
  const mem = { skill_instances: {} }
  const calls = []
  const exec = newExec(world, mem, { calls })
  // 传入配方名称
  const r = await exec.run('gather_resources', { recipe: 'researchlab2' })
  assert.equal(r.status, 'completed', '传入 researchlab2 配方名且材料齐全时应直接判定完成')
  assert.equal(calls.length, 0, '材料齐全时不应下发任何采集动作')
})

test('GATHER-SKILL-5：run_skill 本地工具端到端透传 skill_args', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-skill-args-'))
  try {
    const store = createWorldMemoryStore({ dir })
    const planner = createPlanner({ memoryStore: store })
    const raw = rawState()
    // 背包里放 2 树枝，传入目标 target_items 只要 2 树枝
    const bridge = { readState: () => ({ json: raw, ageMs: 0, path: 'fake.json' }), leaseDirs: () => [], readLeaseAck: () => null }
    const ctx = { bridge, planner, notes: { read: () => '', write: () => {} }, guides: {}, extraInstructions: '' }
    const text = await executeTool('run_skill', {
      skill_id: 'gather_resources',
      skill_args: { target_items: { sapling: 0 } },
    }, ctx)
    assert.match(text, /技能 gather_resources → completed/)
    const mem = store.load('cluster:A/shard:1')
    assert.deepEqual(mem.skill_instances.gather_resources.data.skill_args, { target_items: { sapling: 0 } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─────────────────────────── 决策仲裁（G1） ───────────────────────────

function devPlanStub(over = {}) {
  return {
    worldKey: 'cluster:A/shard:1',
    stage: { index: 1, id: 'establish_home', title: '建立家园', goal: '探索→选址→建家' },
    stageIndex: 1,
    survival: { blocking: false, level: 3, label: '状态稳定' },
    nextTask: null,
    next: '',
    board: { tasks: [] },
    memory: {},
    primarySite: null, backupSite: null,
    ...over,
  }
}

test('ARB-1：生存 P1（饥饿）优先于建家，next_action 走生存规则', () => {
  const snap = snapOf(makeWorld({ hunger: 20 }))
  const dev = devPlanStub({ nextTask: { id: 'travel_to_camp', title: '前往营地', status: 'ready', priority: 1, progress: { current: 0, required: 1 } }, next: 'move_to' })
  const d = arbitrate(snap, { devPlan: dev, survivalPlan: { goalId: 'eat', title: '先吃东西', why: '饥饿 20%', next: 'eat' } })
  assert.equal(d.priority, 'P1')
  assert.equal(d.next_action, 'eat', '生存时的下一步必须来自生存规则引擎')
  assert.equal(d.current_skill.id, 'survival_stabilize')
  assert.equal(d.current_task, null, '生存时不把建家任务当主任务')
})

test('ARB-2：生存稳定 → 选当前阶段唯一任务（P2），来自看板', () => {
  const snap = snapOf(makeWorld())
  const dev = devPlanStub({ nextTask: { id: 'travel_to_camp', title: '前往营地', status: 'ready', priority: 1, progress: { current: 0, required: 1 } }, next: 'move_to x=3 z=4' })
  const d = arbitrate(snap, { devPlan: dev, survivalPlan: { goalId: 'explore', next: 'seek', why: 'x' } })
  assert.equal(d.priority, 'P2')
  assert.equal(d.current_task.id, 'travel_to_camp')
  assert.equal(d.current_skill.id, 'establish_home')
  assert.equal(d.next_action, 'move_to x=3 z=4')
})

test('ARB-3：同一快照产生稳定的唯一主任务（多次调用一致）', () => {
  const snap = snapOf(makeWorld())
  const dev = devPlanStub({ nextTask: { id: 'build_first_structure', title: 'B', status: 'ready', priority: 1, progress: { current: 0, required: 1 } }, next: 'build' })
  const a = arbitrate(snap, { devPlan: dev, survivalPlan: null })
  const b = arbitrate(snap, { devPlan: dev, survivalPlan: null })
  assert.deepEqual(a.current_task, b.current_task)
})

test('ARB-4：blocked 任务要如实列出阻塞原因（不是模糊"无任务"）', () => {
  const snap = snapOf(makeWorld())
  const dev = devPlanStub({ board: { tasks: [{ id: 'build_first_structure', title: 'B', status: 'blocked', priority: 1, blocked_reason: 'dependencies:travel_to_camp' }] } })
  const d = arbitrate(snap, { devPlan: dev, survivalPlan: { goalId: 'explore', next: 'seek' } })
  assert.ok(d.blocked_tasks.some((b) => b.id === 'build_first_structure'))
  assert.match(d.blocked_tasks[0].reason, /dependencies/)
})

// ─────────────────────────── get_state 单一决策出口（G1 集成） ───────────────────────────

function rawState(over = {}) {
  return {
    data: {
      schema: 'bws.state/1',
      observer: { snapshot_id: 's1', sequence: 1, status: 'ok', timestamp: 1, sampled_at: 1, sample_age_ms: 0 },
      identity: { session_id: 'sess', cluster_id: 'A', shard_id: '1', world_key: 'cluster:A/shard:1', world_key_source: 'cluster_id' },
      actor: { valid: true, alive: true, is_ghost: false, actor_type: 'player', prefab: 'wilson', name: '威尔逊', tile_x: 0, tile_z: 0, x: 0, z: 0 },
      player: {
        health: { current: 100, max: 100, percent: 100 }, hunger: { current: 180, max: 200, percent: 90 }, sanity: { current: 180, max: 200, percent: 90 },
        inventory: { items: { 0: { prefab: 'torch', count: 1, percent: 100 }, 1: { prefab: 'berries', count: 2 }, 2: { prefab: 'axe', count: 1 } }, slots: 15, is_full: false },
        equipment: { slots: {}, worn: [] }, in_light: true,
      },
      world: { day: 2, phase: 'day', phase_name: '白天', season: 'autumn', season_name: '秋季' },
      nearby: { runtime_id: 'rt1', snapshot_id: 'r1-n2', status: 'ok', radius: 16, buckets: {
        resources: [{ prefab: 'evergreen', work_action: 'CHOP', position: { x: 6, z: 5 }, distance: 5 }],
        harvestables: [{ prefab: 'berrybush', position: { x: 3, z: 2 }, distance: 3, harvest_ready: true }],
      } },
      danger_zones: [],
      ...over,
    },
  }
}

test('GETSTATE-G1：装配 planner → 文本只有一个统一决策段，含全部关键字段', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-g-'))
  try {
    const store = createWorldMemoryStore({ dir })
    const planner = createPlanner({ memoryStore: store })
    const raw = rawState()
    const bridge = { readState: () => ({ json: raw, ageMs: 0, path: 'fake.json' }), leaseDirs: () => [], readLeaseAck: () => null }
    const ctx = { bridge, planner, notes: { read: () => '', write: () => {} }, guides: {}, extraInstructions: '' }
    const text = await executeTool('get_state', {}, ctx)
    assert.match(text, /## 当前计划（统一决策）/)
    assert.match(text, /当前发展阶段/)
    assert.match(text, /当前主目标/)
    assert.match(text, /当前 Skill|当前任务/)
    assert.match(text, /当前下一步|下一步/)
    // 旧的两套计划不应同时出现：只能有一个"## 当前计划"标题
    assert.equal(text.split('## 当前计划（统一决策）').length - 1, 1)
    assert.ok(!text.includes('### 发展阶段'), '不应再出现旧的独立发展阶段段（renderPlannerSection）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('GETSTATE-G1-JSON：plan / development 都从同一个 decision 派生', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bws-gj-'))
  try {
    const store = createWorldMemoryStore({ dir })
    const planner = createPlanner({ memoryStore: store })
    const raw = rawState()
    const bridge = { readState: () => ({ json: raw, ageMs: 0, path: 'fake.json' }), leaseDirs: () => [], readLeaseAck: () => null }
    const ctx = { bridge, planner, notes: { read: () => '', write: () => {} }, guides: {}, extraInstructions: '' }
    const text = await executeTool('get_state', { format: 'json' }, ctx)
    const payload = JSON.parse(text)
    assert.ok(payload.decision, '必须有唯一 decision 入口')
    assert.ok(payload.plan && payload.development, '兼容字段仍存在')
    // 两个兼容字段都来自 decision：current_task 一致
    assert.deepEqual(payload.development.current_task, payload.decision.current_task)
    assert.equal(payload.plan.next, payload.decision.next_action)
    assert.equal(payload.development.stage, payload.decision.current_stage.index)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
