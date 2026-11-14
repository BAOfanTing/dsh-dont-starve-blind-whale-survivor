// 目标层（Plan）：把"现在该干什么"从每轮重新推理，变成一次推导 + 稳定保持。
//
// 借鉴 E:\Cache\DontStarveAI-main 的 goals/（长期 → 中期 → 短期）与
// E:\Cache\dayz-ai-survivor-main 的 survival.py（规则优先、只给一个方向、用快照核对）。
//
// 关键约束：
//   · **不改世界、不调模型、不写游戏文件**：纯函数，输入快照，输出一段计划。
//   · **稳定**：当前目标仍然成立时保持不动；只有出现了优先级更高的目标才切换，
//     避免模型每轮在"吃东西 / 砍树 / 探路"之间来回翻烧饼。
//   · **可核对**：目标是否完成由快照字段判断（手上有火把、饥饿回到安全线……），
//     不依赖模型自己说"做完了"。
//
// 计划不是命令：它只告诉模型"当前最值得做的一件事 + 具体下一步"，
// 最终仍由模型决策、由 dispatcher/Lua guard 执行。

import { countInInventory, handItem, inventoryItems } from './actions/state-query.js'

export const PLAN_SCHEMA = 'bws.plan/1'

/** 与 eatrules.lua 的 AUTO_SAFE 保持一致（不把生蘑菇算进自动食物） */
const EDIBLE = new Set([
  'berries', 'carrot', 'corn', 'pumpkin', 'eggplant',
  'honey',
  'meat', 'smallmeat', 'froglegs', 'fish',
])

const HAND_LIGHTS = new Set(['torch', 'lantern', 'minerhat'])
const LIGHT_STRUCTURES = new Set([
  'campfire', 'firepit', 'pumpkin_lantern', 'mushroom_light', 'mushroom_light2',
  'nightlight', 'wall_light',
])
const TORCH = 'torch'

const percentOf = (stat) => (typeof stat?.percent === 'number' ? stat.percent : null)

function itemsOf(snapshot, bucket) {
  const buckets = snapshot?.nearby?.buckets
  if (!buckets) return []
  const list = Array.isArray(buckets)
    ? buckets.find((group) => group?.kind === bucket)?.items
    : buckets[bucket]
  return Array.isArray(list) ? list : []
}

function nearest(snapshot, bucket, predicate = () => true) {
  let best = null
  for (const item of itemsOf(snapshot, bucket)) {
    if (!predicate(item)) continue
    const distance = typeof item.distance === 'number' ? item.distance : Infinity
    if (!best || distance < best.distance) best = { ...item, distance }
  }
  return best
}

function anyWithin(snapshot, bucket, within, predicate = () => true) {
  return itemsOf(snapshot, bucket).some(
    (item) => predicate(item) && typeof item.distance === 'number' && item.distance <= within,
  )
}

const isTree = (item) => item?.work_action === 'CHOP' || /tree|evergreen|deciduous|birch/i.test(String(item?.prefab ?? ''))
const isRock = (item) => item?.work_action === 'MINE' || /^rock|boulder/i.test(String(item?.prefab ?? ''))
const isReadyHarvest = (item) => item?.harvest_ready !== false
const berryBush = (item) => item?.prefab === 'berrybush' || item?.prefab === 'berrybush2'
const flower = (item) => item?.prefab === 'flower'
const shadowCreature = (item) => /terrorbeak|crawlingnightmare|nightmare/i.test(
  String(item?.prefab ?? '') + ' ' + String(item?.label ?? ''),
)

function count(snapshot, prefab) {
  return countInInventory(snapshot, prefab)
}

function edibleCount(snapshot) {
  let total = 0
  // 背包 items 在空表/非连续表时会被 Lua 序列化成对象，不能直接 for...of
  for (const item of inventoryItems(snapshot)) {
    if (EDIBLE.has(String(item?.prefab ?? ''))) total += Number(item.count ?? 1)
  }
  return total
}

function hand(snapshot) {
  return handItem(snapshot)
}

function hasLight(snapshot) {
  if (HAND_LIGHTS.has(String(hand(snapshot) ?? ''))) return true
  return anyWithin(snapshot, 'structures', 12, (item) => {
    if (!LIGHT_STRUCTURES.has(String(item?.prefab ?? ''))) return false
    // 未点燃的火堆也在 structures 里，不能把它当成光源。
    return typeof item?.fuel_percent !== 'number' || item.fuel_percent > 0
  })
}

function isDark(snapshot) {
  const phase = snapshot?.world?.phase
  return phase === 'dusk' || phase === 'night'
}

function threatClose(snapshot, within) {
  return nearest(snapshot, 'threats', (item) => typeof item.distance === 'number' && item.distance <= within)
}

function lightNext(snapshot) {
  if (count(snapshot, TORCH) > 0) return 'equip torch（背包里已经有火把）'
  const grass = count(snapshot, 'cutgrass')
  const twigs = count(snapshot, 'twigs')
  if (grass >= 2 && twigs >= 2) return 'craft torch（空手做会直接拿在手里，不用再 equip）'
  const logs = count(snapshot, 'log')
  if (logs >= 2 && grass >= 3) return 'build campfire（2 木头 + 3 干草）'
  const readyGrass = anyWithin(snapshot, 'harvestables', 20, (item) => item?.prefab === 'grass' && isReadyHarvest(item))
  const readySapling = anyWithin(snapshot, 'harvestables', 20, (item) => item?.prefab === 'sapling' && isReadyHarvest(item))
  if (readyGrass || readySapling) {
    return `gather_area 采${readyGrass ? '草' : ''}${readyGrass && readySapling ? '和' : ''}${readySapling ? '树苗' : ''}，凑 2 草 + 2 树枝做火把`
  }
  return 'seek grass 或 sapling，先把火把材料凑齐'
}

function hasLightMaterials(snapshot) {
  return count(snapshot, 'cutgrass') >= 2 && count(snapshot, 'twigs') >= 2
}

function lightMaterialNear(snapshot) {
  const readyGrass = anyWithin(snapshot, 'harvestables', 20, (item) => item?.prefab === 'grass' && isReadyHarvest(item))
  const readySapling = anyWithin(snapshot, 'harvestables', 20, (item) => item?.prefab === 'sapling' && isReadyHarvest(item))
  return Boolean(readyGrass || readySapling)
}

function toolNext(snapshot, want) {
  const recipe = want === 'axe' ? 'axe' : 'pickaxe'
  const need = want === 'axe' ? { twigs: 1, flint: 1 } : { twigs: 2, flint: 2 }
  const have = ['twigs', 'flint'].every((prefab) => count(snapshot, prefab) >= need[prefab])
  if (have) return `craft ${recipe}，再 equip ${recipe}`
  const flintNear = anyWithin(snapshot, 'pickupables', 24, (item) => item?.prefab === 'flint')
  const twigsNear = anyWithin(snapshot, 'harvestables', 24, (item) => item?.prefab === 'sapling' && isReadyHarvest(item))
  if (flintNear) return 'pickup flint（附近的燧石）'
  if (twigsNear) return 'gather_area 采树苗拿 twigs'
  return 'seek flint（燧石）'
}

/**
 * 目标候选。priority 越大越优先；when() 只用快照字段判断（不改世界）。
 * next() 给模型一句可执行的话，避免它每轮自己从头想步骤。
 */
const GOALS = [
  {
    id: 'revive',
    priority: 100,
    when: (snapshot) => snapshot?.actor?.isGhost === true,
    title: '角色是灵魂状态，先等复活',
    why: () => '灵魂状态不能执行游戏动作',
    next: () => '现在别下动作；把处境告诉玩家（重生石 / 告密者之心 / 换角色）',
  },
  {
    id: 'retreat',
    priority: 95,
    when: (snapshot) => {
      const threat = threatClose(snapshot, 6)
      if (!threat) return false
      const health = percentOf(snapshot?.player?.health) ?? 100
      const sanity = percentOf(snapshot?.player?.sanity) ?? 100
      // 理智见底时刷出来的暗影怪在残血时几乎必杀；血还够也要先拉开。
      return health < 60 || (sanity < 20 && shadowCreature(threat))
    },
    title: '敌人贴脸且血少：先脱离',
    why: (snapshot) => {
      const threat = threatClose(snapshot, 6)
      return `最近威胁 ${threat?.label ?? threat?.prefab ?? '?'} 在 ${threat?.distance ?? '?'} 格，血量 ${percentOf(snapshot?.player?.health) ?? '?'}%`
    },
    next: () => 'move_to 往威胁的反方向走 8~12 格；拉开距离后再决定打、吃还是回家',
  },
  {
    id: 'light',
    priority: 90,
    when: (snapshot) => isDark(snapshot) && !hasLight(snapshot),
    title: (snapshot) => (snapshot?.world?.phase === 'night' ? '天黑了，马上弄到光' : '黄昏了，天黑前弄到光'),
    why: () => '手上没有光源，附近也没有火',
    next: lightNext,
  },
  {
    id: 'eat',
    priority: 80,
    // 30% 才吃已经太晚了：模型思考/走路要几十秒，饥饿到 0 会持续掉血。
    when: (snapshot) => (percentOf(snapshot?.player?.hunger) ?? 100) < 40,
    title: '先吃东西',
    why: (snapshot) => `饥饿 ${percentOf(snapshot?.player?.hunger) ?? '?'}%`,
    next: (snapshot) => (edibleCount(snapshot) > 0
      ? 'eat（不填 food 让服务端挑最该吃的）'
      : (anyWithin(snapshot, 'harvestables', 20, (item) => berryBush(item) && isReadyHarvest(item))
        ? 'harvest 成熟浆果丛，再 eat'
        : 'seek berries 或找地上的食物')),
  },
  {
    id: 'sanity',
    priority: 75,
    when: (snapshot) => (percentOf(snapshot?.player?.sanity) ?? 100) < 30,
    title: '理智太低，别让暗影怪刷出来',
    why: (snapshot) => `理智 ${percentOf(snapshot?.player?.sanity) ?? '?'}%`,
    next: (snapshot) => {
      if (anyWithin(snapshot, 'harvestables', 20, (item) => flower(item) && isReadyHarvest(item))) {
        return 'gather_area flower 采几朵花（每朵回理智），再回安全的地方'
      }
      if (isDark(snapshot)) return '先保证有光（火把/火堆），别在黑暗里掉理智；天亮再去采花'
      return 'seek flower 找花，或者回火堆旁待着；理智低于 30% 不要走夜路'
    },
  },
  {
    id: 'heal',
    priority: 85,
    // 40 血左右就会进入下一步死亡；让它压过“补理智/备火把”，但仍然低于
    // 夜里找光和贴脸脱战。
    when: (snapshot) => (percentOf(snapshot?.player?.health) ?? 100) < 45,
    title: '血太低，先别送',
    why: (snapshot) => `生命 ${percentOf(snapshot?.player?.health) ?? '?'}%`,
    next: (snapshot) => (edibleCount(snapshot) > 0
      ? 'eat 补饥饿（饥饿不为 0 时血会慢慢回），同时远离敌人'
      : '先 move_to 离开危险区，等回血；有药膏再用，没有就别打'),
  },
  {
    id: 'prep_light',
    priority: 58,
    // 白天就先把火把材料备好，别等到黄昏才现找。
    // 只在"附近真的有草/树苗"时触发，避免盖过存粮/探索计划。
    // 即使站在火堆/南瓜灯旁边，也要准备能带走的光源。
    when: (snapshot) => !isDark(snapshot)
      && count(snapshot, TORCH) === 0 && !hasLightMaterials(snapshot)
      && lightMaterialNear(snapshot),
    title: '白天先把火把材料备好',
    why: () => '黄昏再找草/树枝就来不及了',
    next: (snapshot) => (count(snapshot, 'cutgrass') < 2
      ? 'gather_area grass，先采 2 个 cutgrass'
      : 'gather_area sapling，再采 2 个 twigs'),
  },
  {
    id: 'tool_axe',
    priority: 55,
    when: (snapshot) => hand(snapshot) !== 'axe' && count(snapshot, 'axe') === 0
      && anyWithin(snapshot, 'resources', 24, isTree),
    title: '附近有树，先弄把斧头',
    why: () => '没有斧头砍不了树，木头是做火堆/工具的基础',
    next: (snapshot) => toolNext(snapshot, 'axe'),
  },
  {
    id: 'tool_pickaxe',
    priority: 50,
    when: (snapshot) => hand(snapshot) !== 'pickaxe' && count(snapshot, 'pickaxe') === 0
      && anyWithin(snapshot, 'resources', 24, isRock),
    title: '附近有石头，先弄把镐',
    why: () => '没有镐挖不了石头，石头是火坑/科学机器的基础',
    next: (snapshot) => toolNext(snapshot, 'pickaxe'),
  },
  {
    id: 'stock_food',
    priority: 65,
    when: (snapshot) => edibleCount(snapshot) < 2
      && anyWithin(snapshot, 'harvestables', 20, (item) => berryBush(item) && isReadyHarvest(item)),
    title: '背包里没吃的，先补食物',
    why: () => '饥饿会一路掉到 0，提前存一点',
    next: () => 'harvest 成熟浆果丛；背包满了就先用 drop 丢掉不用的',
  },
  {
    id: 'explore',
    priority: 10,
    when: () => true,
    title: '探索周围，找资源与建家点',
    why: () => '没有更紧急的事',
    next: () => 'seek flint / grass / sapling，或朝没走过的方向 move_to 10~20 格',
  },
]

const worldKeyOf = (snapshot) => String(
  snapshot?.nearby?.runtime_id ?? snapshot?.identity?.sessionId ?? 'unknown',
)

/**
 * 推导当前计划。
 * @param {object|null} snapshot normalizeState() 的结果
 * @param {object|null} prev 上一次的计划（用于保持稳定）
 * @param {number} [now] 毫秒时间戳
 */
export function derivePlan(snapshot, prev = null, now = Date.now()) {
  if (!snapshot || snapshot.status === 'missing') {
    return {
      schema: PLAN_SCHEMA,
      world: 'unknown',
      goalId: 'wait_game',
      title: '等游戏连上',
      why: '没有可读的状态文件',
      next: '让玩家读档进世界；然后 get_state',
      since: now,
      candidates: [],
      changed: !prev || prev.goalId !== 'wait_game',
    }
  }

  const world = worldKeyOf(snapshot)
  const base = prev && prev.world === world ? prev : null
  const active = GOALS
    .filter((goalSpec) => goalSpec.when(snapshot))
    .sort((left, right) => right.priority - left.priority)
  const top = active[0] ?? GOALS[GOALS.length - 1]

  // 稳定：手上这件事仍然成立、又没有更高优先级的目标时，不换方向。
  const held = base ? GOALS.find((goalSpec) => goalSpec.id === base.goalId) : null
  let goal = top
  if (held && held.when(snapshot) && top.priority <= held.priority) goal = held

  const changed = !base || base.goalId !== goal.id
  return {
    schema: PLAN_SCHEMA,
    world,
    goalId: goal.id,
    title: typeof goal.title === 'function' ? goal.title(snapshot) : goal.title,
    why: typeof goal.why === 'function' ? (goal.why(snapshot) ?? '') : (goal.why ?? ''),
    next: typeof goal.next === 'function' ? (goal.next(snapshot) ?? '') : (goal.next ?? ''),
    since: changed ? now : (base.since ?? now),
    candidates: active.slice(0, 3).map((goalSpec) => ({
      id: goalSpec.id,
      title: typeof goalSpec.title === 'function' ? goalSpec.title(snapshot) : goalSpec.title,
    })),
    changed,
  }
}

/** 给模型看的计划块。compact=true 时压成一行（每轮提示用）。 */
export function renderPlan(plan, { compact = false } = {}) {
  if (!plan) return ''
  if (compact) {
    return `当前目标：${plan.title}${plan.next ? `；下一步：${plan.next}` : ''}\n`
  }
  const lines = ['## 当前计划', `目标：${plan.title}`]
  if (plan.why) lines.push(`原因：${plan.why}`)
  if (plan.next) lines.push(`下一步：${plan.next}`)
  const alt = (plan.candidates ?? []).filter((candidate) => candidate.id !== plan.goalId)
  if (alt.length > 0) lines.push(`备选：${alt.map((candidate) => candidate.title).join('；')}`)
  lines.push('（计划会随状态自动更新；有更高优先级的危险时会立刻改。）')
  return lines.join('\n') + '\n'
}

/**
 * JSON 模式用的计划对象：字段名跟状态协议保持一致（snake_case）。
 * 模型自己不看这个字段；它是给 MCP 客户端 / 调试工具解析用的。
 */
export function planPayload(plan) {
  if (!plan) return null
  return {
    schema: plan.schema,
    world: plan.world,
    goal_id: plan.goalId,
    title: plan.title,
    why: plan.why,
    next: plan.next,
    since: plan.since,
    changed: plan.changed,
    candidates: (plan.candidates ?? []).map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
    })),
  }
}

export { GOALS }
