// 计划层（PLAN）：一次推导 + 稳定保持，减少模型每轮从头规划的开销。
//
// 这里跑**真实实现**（derivePlan / renderPlan / get_state），不 mock 关键逻辑：
//   · 目标优先级必须能从真实快照字段判断出来（灵魂 > 脱战 > 光 > 吃 > 回血 > 工具 > 存粮 > 探索）
//   · 目标仍然成立时不能来回翻烧饼（changed=false、since 保留）
//   · 出现更高优先级的危险时必须立刻切换
//   · get_state 的 JSON 模式仍然是**纯 JSON**，计划放在 plan 字段里
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { derivePlan, renderPlan, PLAN_SCHEMA, GOALS } from '../lib/plan.js'
import { normalizeState } from '../lib/state/snapshot.js'
import { executeTool } from '../lib/tools.js'
import { AiRunner } from '../lib/agent.js'

/** 造一份接近真机的归一化快照；只覆盖测试关心的字段。 */
function makeSnapshot(over = {}) {
  const raw = {
    data: {
      schema: 'bws.state/1',
      observer: { snapshot_id: 's10', sequence: 10, status: 'ok', timestamp: 1, sampled_at: 1, sample_age_ms: 0 },
      actor: {
        valid: true,
        actor_id: 'player:X',
        actor_type: 'player',
        prefab: 'wilson',
        name: '威尔逊',
        alive: true,
        is_ghost: false,
        tile_x: 1,
        tile_z: 2,
        x: 4,
        y: 0,
        z: 8,
        ...(over.actor ?? {}),
      },
      player: {
        health: { current: 100, max: 100, percent: over.health ?? 100 },
        hunger: { current: 100, max: 200, percent: over.hunger ?? 60 },
        sanity: { current: 200, max: 200, percent: over.sanity ?? 90 },
        inventory: { items: over.items ?? {}, slots: 15, is_full: false },
        equipment: over.equipment ?? { slots: {}, worn: [] },
      },
      world: {
        day: over.day ?? 2,
        phase: over.phase ?? 'day',
        phase_name: over.phase === 'night' ? '夜晚' : '白天',
        season: 'autumn',
        season_name: '秋季',
      },
      nearby: {
        runtime_id: 'rt1',
        snapshot_id: 'r1-n2',
        status: 'ok',
        radius: 16,
        buckets: over.buckets ?? {},
      },
    },
  }
  return normalizeState(raw, { ageMs: 0 })
}

const ITEMS = (...entries) => Object.fromEntries(entries.map(([prefab, count], index) => [
  String(index),
  { prefab, count },
]))

test('PLAN-0：没有快照时给出 wait_game，且标明计划变了', () => {
  const plan = derivePlan(null)
  assert.equal(plan.schema, PLAN_SCHEMA)
  assert.equal(plan.goalId, 'wait_game')
  assert.equal(plan.changed, true)
})

test('PLAN-1：灵魂状态最高优先级 —— 先别下动作', () => {
  const snapshot = makeSnapshot({ actor: { is_ghost: true }, hunger: 10, phase: 'night' })
  const plan = derivePlan(snapshot)
  assert.equal(plan.goalId, 'revive')
  assert.match(plan.next, /别下动作/)
})

test('PLAN-2：血少且敌人贴脸 —— 先脱离，而不是先吃东西', () => {
  const snapshot = makeSnapshot({
    health: 40,
    hunger: 15,
    buckets: { threats: [{ ref: '#1', prefab: 'spider', label: '蜘蛛', distance: 3, health: 50 }] },
  })
  const plan = derivePlan(snapshot)
  assert.equal(plan.goalId, 'retreat')
  assert.match(plan.why, /蜘蛛/)
})

test('PLAN-3：夜里没光 —— 用背包材料做火把', () => {
  const snapshot = makeSnapshot({
    phase: 'night',
    items: ITEMS(['cutgrass', 2], ['twigs', 2]),
  })
  const plan = derivePlan(snapshot)
  assert.equal(plan.goalId, 'light')
  assert.match(plan.next, /craft torch/)
})

test('PLAN-4：入夜后背包里已经有火把 —— 直接装备', () => {
  // 真机 0.37.0：黄昏仍有自然光（grue 不攻击），不该举火把；只有 night 才举
  const snapshot = makeSnapshot({ phase: 'night', items: ITEMS(['torch', 1]) })
  const plan = derivePlan(snapshot)
  assert.equal(plan.goalId, 'light')
  assert.match(plan.next, /equip torch/)
})

test('PLAN-5：饥饿低于 40% —— 先吃；背包 items 是对象也要数得出来', () => {
  const snapshot = makeSnapshot({ hunger: 20, items: ITEMS(['berries', 3]) })
  const plan = derivePlan(snapshot)
  assert.equal(plan.goalId, 'eat')
  assert.match(plan.next, /eat/)
})

test('PLAN-6：目标仍然成立时保持稳定（不换方向、since 不变）', () => {
  // 夹具里放一把火把：否则按 SURVIVAL-02.1 的正确语义，白天没光源时目标应当是 prep_light 而不是 explore。
  // 这条测试要验的是"稳定性"，不是"有没有光源"，所以给它一个已备好的火把。
  const torch = ITEMS(['torch', 1])
  const first = derivePlan(makeSnapshot({ items: torch }))
  assert.equal(first.goalId, 'explore')
  const later = makeSnapshot({ day: 3, items: torch })
  const again = derivePlan(later, first)
  assert.equal(again.goalId, 'explore')
  assert.equal(again.changed, false)
  assert.equal(again.since, first.since)
})

test('PLAN-7：更高优先级的危险出现时立刻切换', () => {
  const torch = ITEMS(['torch', 1])
  const first = derivePlan(makeSnapshot({ items: torch }))
  assert.equal(first.goalId, 'explore')
  const hungry = derivePlan(makeSnapshot({ hunger: 20, items: torch }), first)
  assert.equal(hungry.goalId, 'eat')
  assert.equal(hungry.changed, true)
})

test('PLAN-8：旧目标仍成立但优先级更低时，让位给新的更高优先级目标', () => {
  const eating = derivePlan(makeSnapshot({ hunger: 20 }))
  assert.equal(eating.goalId, 'eat')
  const ghost = derivePlan(makeSnapshot({ hunger: 20, actor: { is_ghost: true } }), eating)
  assert.equal(ghost.goalId, 'revive')
  assert.equal(ghost.changed, true)
})

test('PLAN-9：背包里没吃的、附近有成熟浆果 —— 先补食物', () => {
  const snapshot = makeSnapshot({
    hunger: 60,
    buckets: {
      harvestables: [{
        ref: '#1', prefab: 'berrybush', label: '浆果丛', distance: 5, harvest_ready: true,
      }],
    },
  })
  const plan = derivePlan(snapshot)
  assert.equal(plan.goalId, 'stock_food')
  assert.match(plan.next, /harvest/)
})

test('PLAN-14：理智低于 30% 且没有威胁 —— 先补理智，不要等暗影怪刷出来', () => {
  const snapshot = makeSnapshot({ sanity: 20 })
  const plan = derivePlan(snapshot)
  assert.equal(plan.goalId, 'sanity')
  assert.match(plan.next, /flower|花/)
})

test('PLAN-15：低理智 + 暗影怪贴脸 —— 血还够也先脱离', () => {
  const snapshot = makeSnapshot({
    health: 80,
    sanity: 10,
    buckets: {
      threats: [{
        ref: '#1', prefab: 'terrorbeak', label: '爬行恐惧', distance: 3, health: 300,
      }],
    },
  })
  const plan = derivePlan(snapshot)
  assert.equal(plan.goalId, 'retreat')
  assert.match(plan.why, /爬行恐惧/)
})

test('PLAN-16：饥饿 35% —— 新阈值下应提前吃', () => {
  const snapshot = makeSnapshot({ hunger: 35, items: ITEMS(['berries', 1]) })
  const plan = derivePlan(snapshot)
  assert.equal(plan.goalId, 'eat')
})

test('PLAN-17：白天没火把材料但附近有草/树苗 —— 提前备火把材料', () => {
  const snapshot = makeSnapshot({
    phase: 'day',
    buckets: {
      harvestables: [{
        ref: '#1', prefab: 'grass', label: '草丛', distance: 4, harvest_ready: true, product: 'cutgrass',
      }],
    },
  })
  const plan = derivePlan(snapshot)
  assert.equal(plan.goalId, 'prep_light')
  assert.match(plan.next, /cutgrass/)
})

test('PLAN-18：未点燃的火堆不算光源', () => {
  const snapshot = makeSnapshot({
    phase: 'night',
    buckets: {
      structures: [{
        ref: '#1', prefab: 'campfire', label: '营火', distance: 3, fuel_percent: 0,
      }],
    },
  })
  const plan = derivePlan(snapshot)
  assert.equal(plan.goalId, 'light')
})

test('PLAN-19：南瓜灯实际照亮角色时不要求额外光源', () => {
  const snapshot = makeSnapshot({
    phase: 'night',
    buckets: {
      structures: [{
        ref: '#1', prefab: 'pumpkin_lantern', label: '南瓜灯', distance: 5,
      }],
    },
  })
  snapshot.player.in_light = true
  const plan = derivePlan(snapshot)
  assert.notEqual(plan.goalId, 'light')
})

test('PLAN-20：残血且饥饿为零时先找食物，不等自然回血', () => {
  const plan = derivePlan(makeSnapshot({ health: 40, hunger: 0 }))
  assert.equal(plan.goalId, 'eat')
  assert.match(plan.next, /seek|pickup|harvest/)
  assert.doesNotMatch(plan.next, /等回血|血会慢慢回/)
})

test('PLAN-21：不能立即治疗时，低血量不阻塞光源准备', () => {
  const plan = derivePlan(makeSnapshot({ health: 40, items: ITEMS(['berries', 2]) }))
  assert.equal(plan.goalId, 'prep_light')
})

for (const inLight of [false, true]) {
  test(`PLAN-light：实际照明=${inLight} 优先于附近火源和手持物品推测`, () => {
    const snapshot = makeSnapshot({
      phase: 'night',
      items: ITEMS(['torch', 1]),
      equipment: { slots: { hands: { prefab: 'lantern', percent: 100 } } },
      buckets: { structures: [{ ref: '#1', prefab: 'campfire', distance: 6, fuel_percent: 50 }] },
    })
    snapshot.player.in_light = inLight
    const plan = derivePlan(snapshot)
    assert.equal(plan.goalId === 'light', !inLight)
  })
}

test('PLAN-light：没有实际照明数据时，不能仅凭远处火源判安全', () => {
  const snapshot = makeSnapshot({ phase: 'night', buckets: {
    structures: [{ prefab: 'campfire', distance: 6, fuel_percent: 50 }],
  } })
  assert.equal(derivePlan(snapshot).goalId, 'light')
})

for (const item of ['lantern', 'minerhat']) {
  test(`PLAN-light：黑暗中优先装备背包已有的 ${item}`, () => {
    const snapshot = makeSnapshot({ phase: 'night', items: [{ prefab: item, count: 1, percent: 100 }] })
    snapshot.player.in_light = false
    assert.match(derivePlan(snapshot).next, new RegExp(`equip ${item}`))
  })
}

test('PLAN-light：头部已装备的矿工帽计入便携照明储备', () => {
  const snapshot = makeSnapshot({ equipment: { worn: [{ key: 'head', item: { prefab: 'minerhat', percent: 80 } }] } })
  snapshot.player.in_light = true
  assert.notEqual(derivePlan(snapshot).goalId, 'prep_light')
})

test('PLAN-22：低血量优先吃回血食物，不反复吃零回血的生浆果', () => {
  const plan = derivePlan(makeSnapshot({ health: 40, items: ITEMS(['berries', 5], ['carrot_cooked', 1]) }))
  assert.equal(plan.goalId, 'heal')
  assert.match(plan.next, /eat.*carrot_cooked/)
  assert.doesNotMatch(plan.next, /等回血|血会慢慢回/)
  const withoutHealing = derivePlan(makeSnapshot({ health: 40, items: ITEMS(['berries', 5], ['torch', 1]) }))
  assert.doesNotMatch(withoutHealing.next, /等回血|血会慢慢回/)
  assert.match(withoutHealing.next, /seek|pickup/)
})

test('PLAN-23：白天识别熟食和多汁浆果，不带着食物继续找浆果', () => {
  for (const food of ['berries_juicy', 'meat_cooked', 'smallmeat_cooked', 'froglegs_cooked', 'fish_cooked',
    'berries_cooked', 'berries_juicy_cooked', 'carrot_cooked', 'corn_cooked', 'pumpkin_cooked', 'eggplant_cooked']) {
    const plan = derivePlan(makeSnapshot({ hunger: 20, items: ITEMS([food, 1]) }))
    assert.equal(plan.goalId, 'eat', food)
    assert.match(plan.next, /^eat/, food)
  }
  const mushrooms = derivePlan(makeSnapshot({ hunger: 20, items: ITEMS(['red_cap', 1], ['monstermeat', 1]) }))
  assert.doesNotMatch(mushrooms.next, /^eat/)
})

test('PLAN-24：缺食物时优先捡可见安全食物，且建议**不会过期**（TARGET-REFRESH）', () => {
  const buckets = {
    pickupables: [
      { ref: '#1', prefab: 'monstermeat', distance: 1 },
      { ref: '#2', prefab: 'carrot', distance: 3 },
      { ref: '#3', prefab: 'berries', distance: 6 },
    ],
    harvestables: [{ ref: '#4', prefab: 'berrybush', distance: 5, harvest_ready: true }],
  }
  for (const hunger of [20, 60]) {
    const plan = derivePlan(makeSnapshot({ hunger, buckets }))
    assert.equal(plan.goalId, hunger < 40 ? 'eat' : 'stock_food')
    // 以前是 `pickup target_ref=#2 snapshot_id=r1-n2` —— 模型思考一轮之后必然 stale_snapshot。
    // 现在只给类别，由服务端实时找：pickup_food target_kind=carrot
    assert.match(plan.next, /pickup_food target_kind=carrot/, '近处的胡萝卜优先，且用不会过期的类别写法')
    assert.doesNotMatch(plan.next, /snapshot_id=/, '建议里不能再带会过期的 snapshot_id')
    assert.doesNotMatch(plan.next, /monstermeat/)
  }
})

test('PLAN-25：熟食储备充足不再触发存粮，远处或不安全食物不算现成食物', () => {
  const food = { ref: '#1', prefab: 'berrybush', distance: 5, harvest_ready: true }
  const stocked = derivePlan(makeSnapshot({ items: ITEMS(['carrot_cooked', 2], ['torch', 1]), buckets: { harvestables: [food] } }))
  assert.equal(stocked.goalId, 'explore')
  for (const item of [
    { ref: '#2', prefab: 'carrot', distance: 50 },
    { ref: '#2', prefab: 'carrot', distance: null },
    { ref: '#2', prefab: 'red_cap', distance: 1 },
  ]) {
    const plan = derivePlan(makeSnapshot({ hunger: 20, buckets: { pickupables: [item] } }))
    assert.doesNotMatch(plan.next, /pickup.*#2/)
  }
})

test('PLAN-26：黄昏只有低耐久火把仍需准备，但入夜能先举起来救急', () => {
  const items = { 0: { prefab: 'torch', count: 1, percent: 1 } }
  const dusk = derivePlan(makeSnapshot({ phase: 'dusk', items }))
  assert.equal(dusk.goalId, 'prep_light')
  assert.match(dusk.why, /燃料|耐久|储备/)
  const night = derivePlan(makeSnapshot({ phase: 'night', items }))
  assert.equal(night.goalId, 'light')
  assert.match(night.next, /equip torch/)
})

test('PLAN-27：多把火把按剩余燃料合计，不只看有没有', () => {
  for (const [percents, expected] of [[[30, 30], 'prep_light'], [[40, 40], 'explore'], [[0, 80], 'explore']]) {
    const items = percents.map((percent) => ({ prefab: 'torch', count: 1, percent }))
    const plan = derivePlan(makeSnapshot({ phase: 'dusk', items }))
    assert.equal(plan.goalId, expected, String(percents))
  }
})

test('PLAN-28：低耐久火把未补足前保护材料，白天手持时先收起', () => {
  const items = [{ prefab: 'torch', count: 1, percent: 1 }, { prefab: 'twigs', count: 2 }, { prefab: 'flint', count: 1 }]
  const plan = derivePlan(makeSnapshot({ items, buckets: { resources: [{ prefab: 'evergreen', distance: 3 }] } }))
  assert.equal(plan.goalId, 'prep_light')
  assert.ok(!plan.candidates.some((goal) => goal.id === 'tool_axe'))
  const held = derivePlan(makeSnapshot({ equipment: { slots: { hands: { prefab: 'torch', percent: 1 } } } }))
  assert.equal(held.goalId, 'prep_light')
  assert.match(held.next, /unequip.*hands/)
  const craft = derivePlan(makeSnapshot({ items: ITEMS(['cutgrass', 2], ['twigs', 2]) }))
  assert.match(craft.next, /craft torch.*unequip/)
})

test('PLAN-29：沃尔夫冈饥饿流失快 —— 50%即提前进食，65%且断粮即触发存粮', () => {
  const wolfgangEating = derivePlan(makeSnapshot({
    actor: { prefab: 'wolfgang', name: '沃尔夫冈' },
    hunger: 50,
    items: ITEMS(['berries', 2]),
  }))
  assert.equal(wolfgangEating.goalId, 'eat', '沃尔夫冈 50% 饥饿应提前吃东西')

  const wilsonEating = derivePlan(makeSnapshot({
    actor: { prefab: 'wilson', name: '威尔逊' },
    hunger: 50,
    items: ITEMS(['berries', 2]),
  }))
  assert.notEqual(wilsonEating.goalId, 'eat', '威尔逊 50% 饥饿属于正常区间，不进食')

  const wolfgangStock = derivePlan(makeSnapshot({
    actor: { prefab: 'wolfgang', name: '沃尔夫冈' },
    hunger: 65,
    items: ITEMS(['torch', 1]),
    buckets: {},
  }))
  assert.equal(wolfgangStock.goalId, 'stock_food', '沃尔夫冈断粮且饥饿 < 70% 必须触发存粮寻食')
  assert.match(wolfgangStock.next, /seek/, '无现成食物时提示 seek 找食物')
})

test('PLAN-30：较远食物给出 move_to 坐标指引（避免直接盲调 nearest 导致 out_of_range）', () => {
  const farBush = { ref: '#1', prefab: 'berrybush', label: '浆果丛', distance: 15, x: 80, z: -60, harvest_ready: true }
  const plan = derivePlan(makeSnapshot({
    hunger: 60,
    buckets: { harvestables: [farBush] },
  }))
  assert.equal(plan.goalId, 'stock_food')
  assert.match(plan.next, /move_to x=80 z=-60/, '应包含走过去的坐标提示')
  assert.match(plan.next, /harvest_nearest/, '走近后再采摘')
})

test('PLAN-10：compact 只给一行，完整版带原因和下一步', () => {
  const plan = derivePlan(makeSnapshot({ phase: 'night', items: ITEMS(['cutgrass', 2], ['twigs', 2]) }))
  const compact = renderPlan(plan, { compact: true })
  const full = renderPlan(plan)
  assert.match(compact, /当前目标/)
  assert.ok(!compact.includes('## 当前计划'))
  assert.match(full, /## 当前计划/)
  assert.match(full, /原因：/)
  assert.match(full, /下一步：/)
})

function makeCtx(over = {}) {
  const raw = {
    data: {
      schema: 'bws.state/1',
      observer: { snapshot_id: 's10', sequence: 10, status: 'ok', timestamp: 1, sampled_at: 1, sample_age_ms: 0 },
      actor: {
        valid: true, actor_id: 'player:X', actor_type: 'player', prefab: 'wilson', name: '威尔逊',
        alive: true, is_ghost: false, tile_x: 1, tile_z: 2, x: 4, y: 0, z: 8,
      },
      player: {
        health: { current: 100, max: 100, percent: 100 },
        hunger: { current: 100, max: 200, percent: 60 },
        sanity: { current: 200, max: 200, percent: 90 },
        inventory: { items: over.items ?? {}, slots: 15, is_full: false },
        equipment: { slots: {}, worn: [] },
      },
      world: { day: 2, phase: 'day', phase_name: '白天', season: 'autumn', season_name: '秋季' },
      nearby: { runtime_id: 'rt1', snapshot_id: 'r1-n2', status: 'ok', radius: 16, buckets: {} },
    },
  }
  const bridge = {
    readState: () => ({ json: raw, ageMs: 0, path: 'fake.json' }),
    leaseDirs: () => [],
    readLeaseAck: () => null,
  }
  let lastPlan = null
  return {
    bridge,
    notes: { read: () => '', write: () => {} },
    guides: {},
    extraInstructions: '',
    get lastPlan() { return lastPlan },
    setPlan: (plan) => { lastPlan = plan },
  }
}

test('PLAN-11：get_state 文本模式带「当前计划」段', async () => {
  // 带一把火把：确保"白天没光源"不会把目标顶成 prep_light（本测试只验计划段渲染）。
  const ctx = makeCtx({ items: ITEMS(['torch', 1]) })
  const text = await executeTool('get_state', {}, ctx)
  assert.match(text, /## 当前计划/)
  assert.equal(ctx.lastPlan.goalId, 'explore')
})

test('PLAN-12：get_state JSON 模式仍是纯 JSON，计划在 plan 字段里', async () => {
  const ctx = makeCtx({ items: ITEMS(['torch', 1]) })
  const text = await executeTool('get_state', { format: 'json' }, ctx)
  const payload = JSON.parse(text)
  assert.equal(payload.plan.schema, PLAN_SCHEMA)
  assert.equal(payload.plan.goal_id, 'explore')
  assert.equal(payload.plan.changed, true)
})

test('PLAN-13：F8 目标不变时只注入紧凑计划，不再重塞完整状态', async () => {
  const raw = {
    data: {
      schema: 'bws.state/1',
      observer: { snapshot_id: 's10', sequence: 10, status: 'ok', timestamp: 1, sampled_at: 1, sample_age_ms: 0 },
      actor: {
        valid: true, actor_id: 'player:X', actor_type: 'player', prefab: 'wilson', name: '威尔逊',
        alive: true, is_ghost: false, tile_x: 1, tile_z: 2, x: 4, y: 0, z: 8,
      },
      player: {
        health: { current: 100, max: 100, percent: 100 },
        hunger: { current: 100, max: 200, percent: 60 },
        sanity: { current: 200, max: 200, percent: 90 },
        inventory: { items: {}, slots: 15, is_full: false },
        equipment: { slots: {}, worn: [] },
      },
      world: { day: 2, phase: 'day', phase_name: '白天', season: 'autumn', season_name: '秋季' },
      nearby: { runtime_id: 'rt1', snapshot_id: 'r1-n2', status: 'ok', radius: 16, buckets: {} },
    },
  }
  const bridge = {
    readState: () => ({ json: raw, ageMs: 0, path: 'fake.json' }),
    leaseDirs: () => [],
    readLeaseAck: () => null,
  }
  const lastMessages = []
  const runner = new AiRunner({
    log: () => {},
    bridge,
    settings: () => ({ apiKey: 'x', baseUrl: 'http://x', model: 'm', maxTokens: 64 }),
    instructions: () => '规则',
    toolList: () => [],
    chatFn: async (config, messages) => {
      lastMessages.push(messages[messages.length - 1].content)
      if (lastMessages.length === 1) {
        return { content: '', toolCalls: [{ id: 'c1', name: 'gather', args: {} }], rawToolCalls: [] }
      }
      return { content: '(想完了)', toolCalls: [], rawToolCalls: [] }
    },
    callTool: async (name) => (name === 'get_state' ? '状态正文' : 'ok'),
    onStatus: () => {},
  })
  runner.start()
  const deadline = Date.now() + 2000
  while (lastMessages.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  runner.stop('test')
  assert.ok(lastMessages.length >= 2, `应该至少问模型 2 次，实际 ${lastMessages.length}`)
  assert.match(lastMessages[1], /当前目标：/)
  assert.ok(!lastMessages[1].includes('## 当前计划'), '目标没变时不该重塞完整计划')
  assert.ok(!lastMessages[1].includes('状态正文'), '目标没变时不该重塞完整状态')
})

test('PLAN-R4-1：plan.js GOALS 已收敛为纯生存应急规则与开局生存兜底，不含中长期科技与装备制作', () => {
  const goalIds = GOALS.map((g) => g.id)
  // 不包含被剥离的发展科技目标
  assert.equal(goalIds.includes('mine_rock'), false, 'mine_rock 必须移交 TaskBoard')
  assert.equal(goalIds.includes('chop_wood'), false, 'chop_wood 必须移交 TaskBoard')
  assert.equal(goalIds.includes('craft_backpack_and_armor'), false, 'craft_backpack_and_armor 必须移交 TaskBoard')
  assert.equal(goalIds.includes('build_science_machine'), false, 'build_science_machine 必须移交 TaskBoard')

  // 保留的合法生存规则
  const expectedSurvivalGoals = [
    'revive', 'retreat', 'light', 'eat', 'sanity', 'heal',
    'stock_food', 'prep_light', 'tool_axe', 'tool_pickaxe', 'explore',
  ]
  assert.deepEqual(goalIds, expectedSurvivalGoals)
})

test('PLAN-R4-2：Decision Arbiter 与 get_state 单决策输出，消除多头计划干扰', async () => {
  const { createPlanner } = await import('../lib/planner/planner-core.js')
  const { createWorldMemoryStore } = await import('../lib/planner/world-memory.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'bws-r4-arb-'))
  try {
    const memoryStore = createWorldMemoryStore({ dir })
    const planner = createPlanner({ memoryStore })
    const ctx = makeCtx({ items: ITEMS(['torch', 1]) })
    ctx.planner = planner

    const text = await executeTool('get_state', {}, ctx)
    // 只有一个统一决策段
    assert.match(text, /## 当前计划（统一决策）/)
    assert.equal(text.split('## 当前计划').length - 1, 1, '全文本只允许出现一次计划标题')
    assert.doesNotMatch(text, /### 发展阶段/)

    // JSON 模式中 decision 成为统一数据源
    const jsonStr = await executeTool('get_state', { format: 'json' }, ctx)
    const data = JSON.parse(jsonStr)
    assert.ok(data.decision, '必须有 decision 字段')
    assert.equal(data.plan.next, data.decision.next_action)
    assert.equal(data.development.next, data.decision.next_action)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
