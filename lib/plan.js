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
  'berries', 'berries_juicy', 'carrot', 'corn', 'pumpkin', 'eggplant',
  'honey',
  'meat', 'smallmeat', 'froglegs', 'fish',
  'meat_cooked', 'smallmeat_cooked', 'froglegs_cooked', 'fish_cooked',
  'berries_cooked', 'berries_juicy_cooked', 'carrot_cooked', 'corn_cooked',
  'pumpkin_cooked', 'eggplant_cooked',
])

const HEALING_FOODS = new Set([
  'carrot', 'corn', 'pumpkin', 'eggplant', 'honey',
  'meat_cooked', 'smallmeat_cooked', 'froglegs_cooked', 'fish_cooked',
  'berries_cooked', 'berries_juicy_cooked', 'carrot_cooked', 'corn_cooked',
  'pumpkin_cooked', 'eggplant_cooked',
])

const HAND_LIGHTS = new Set(['torch', 'lantern', 'minerhat'])
const TORCH = 'torch'
// 默认开局夜长 60 秒，满火把 75 秒；这里是最低储备，不是长夜时长预测。
const TORCH_RESERVE_PERCENT = 80

// ── 配方（唯一来源：scripts/whale/craftrules.lua → 游戏 recipes.lua）────────────
// 这里只是 Node 侧为了"不依赖 Lua 也能判断下一步"而保留的一份只读副本；
// 真正的材料扣减与校验永远由 Lua 的 craftrules 读取原生 Recipe 完成。
const TORCH_RECIPE = { cutgrass: 2, twigs: 2 }
// ★ firepit 是唯一**不依赖 cutgrass** 的开局光源：原生 Recipe2("firepit",
//   {Ingredient("log",2), Ingredient("rocks",12)}, TECH.NONE)。
//   出生点没草时，火把/营火都做不出来（营火要 3 草），火坑是唯一破局路线；
//   FIREPIT_FUEL_START = dusk+night = 180s，正好盖住整夜。
const FIREPIT_RECIPE = { log: 2, rocks: 12 }
const TOOL_RECIPES = {
  axe: { twigs: 1, flint: 1 },
  pickaxe: { twigs: 2, flint: 2 },
}
const INGREDIENT_SOURCE = { cutgrass: 'grass', twigs: 'sapling', flint: 'flint' }
const INGREDIENT_LABEL = { cutgrass: '草', twigs: '树枝', flint: '燧石' }

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

function healingFood(snapshot) {
  return inventoryItems(snapshot).find((item) => HEALING_FOODS.has(item?.prefab) && Number(item.count ?? 1) > 0)
}

function foodSource(snapshot, foods = EDIBLE) {
  const ground = nearest(snapshot, 'pickupables', (item) => foods.has(item?.prefab))
  if (ground && ground.distance <= 20) return `pickup target_ref=${ground.ref} snapshot_id=${snapshot.nearby.snapshot_id}（${ground.prefab}）`
  if (foods.has('berries')) {
    const bush = nearest(snapshot, 'harvestables', (item) => berryBush(item) && isReadyHarvest(item))
    if (bush && bush.distance <= 20) return `harvest target_ref=${bush.ref} snapshot_id=${snapshot.nearby.snapshot_id}（成熟浆果丛）`
  }
  return null
}

function hand(snapshot) {
  return handItem(snapshot)
}

function hasLight(snapshot) {
  if (typeof snapshot?.player?.in_light === 'boolean') return snapshot.player.in_light
  // 手上要有**还能用**的便携光源（点了、而且有耐久/燃料）；
  // 只看到 prefab 名不算 —— 一把烧光的火把不能当光用。
  const slot = handSlot(snapshot)
  if (slot != null) {
    if (isUsableLightBlock(slot)) return true
  } else if (HAND_LIGHTS.has(String(hand(snapshot) ?? ''))) {
    // 老形状：只拿得到 prefab，没有耐久字段（当作能用，不因此误判为无光）
    return true
  }
  return isUsableLightBlock(handSlot(snapshot, 'head'))
}

/** 装备槽的完整条目（含 percent），读不到返回 null。 */
function handSlot(snapshot, slotKey = 'hands') {
  const eq = snapshot?.player?.equipment
  if (!eq || typeof eq !== 'object') return null
  const slots = eq.slots
  if (slots && typeof slots === 'object' && !Array.isArray(slots)) {
    const h = slots[slotKey] ?? slots[slotKey.toUpperCase()]
    if (typeof h === 'string' && h !== '') return { prefab: h }
    if (h && typeof h === 'object') return h
  }
  const worn = eq.worn
  if (Array.isArray(worn)) {
    for (const entry of worn) {
      const key = String(entry?.key ?? entry?.slot_key ?? entry?.slot ?? '').toLowerCase()
      if (key !== slotKey) continue
      const it = entry?.item ?? entry
      if (typeof it === 'string' && it !== '') return { prefab: it }
      if (it && typeof it === 'object') return it
    }
  }
  if (worn && typeof worn === 'object' && !Array.isArray(worn)) {
    const h = worn[slotKey] ?? worn[slotKey.toUpperCase()]
    if (typeof h === 'string' && h !== '') return { prefab: h }
    if (h && typeof h === 'object') return h
  }
  return null
}

/** 一个物品块（背包项或装备槽）是不是"还能用的便携光源"。 */
function isUsableLightBlock(block) {
  const prefab = String(block?.prefab ?? '')
  if (!HAND_LIGHTS.has(prefab)) return false
  const percent = block?.percent
  if (typeof percent === 'number' && percent <= 0) return false
  return true
}

function portableLights(snapshot) {
  const out = []
  for (const item of inventoryItems(snapshot)) {
    if (isUsableLightBlock(item)) out.push(item)
  }
  const slot = handSlot(snapshot)
  if (slot != null) {
    if (isUsableLightBlock(slot)) out.push(slot)
  } else if (HAND_LIGHTS.has(String(hand(snapshot) ?? '')) && out.length === 0) {
    out.push({ prefab: hand(snapshot) })
  }
  const head = handSlot(snapshot, 'head')
  if (isUsableLightBlock(head)) out.push(head)
  return out
}

function hasPortableLight(snapshot) {
  return portableLights(snapshot).length > 0
}

function hasLightReserve(snapshot) {
  const lights = portableLights(snapshot)
  if (lights.some((item) => item.prefab !== TORCH)) return true
  return lights.reduce((total, item) => total + (item.percent ?? 100) * Number(item.count ?? 1), 0) >= TORCH_RESERVE_PERCENT
}

/**
 * 是否处于**真正需要人工光源**的黑暗。
 * ★ 真机第 14 夜：DST 的 grue 只在 `not inst:IsInLight()` 时攻击，黄昏仍有自然光、
 *   血量全程不掉。把 dusk 也算"黑暗"会让模型/反射在黄昏就举起火把，把 75s 燃料
 *   烧在还有自然光的 120s 里，进 night 时刚好空了 —— 这就是那一夜的死因。
 * 只有 phase === 'night' 才需要点火把；黄昏是最后的备料/制作窗口。
 */
function isDark(snapshot) {
  return snapshot?.world?.phase === 'night'
}

function threatClose(snapshot, within) {
  return nearest(snapshot, 'threats', (item) => typeof item.distance === 'number' && item.distance <= within)
}

/** 缺哪些材料 → { prefab: 差几个 } */
function missingOf(snapshot, recipe) {
  const missing = {}
  for (const [prefab, need] of Object.entries(recipe)) {
    const have = count(snapshot, prefab)
    if (have < need) missing[prefab] = need - have
  }
  return missing
}

const hasAll = (snapshot, recipe) => Object.keys(missingOf(snapshot, recipe)).length === 0

/** 没草时的破局路线：火坑不要 cutgrass，燃料够一整夜。 */
function firepitReady(snapshot) {
  return hasAll(snapshot, FIREPIT_RECIPE)
}

const NEED_TEXT = (missing) => Object.keys(missing).sort()
  .map((prefab) => `${prefab} ${missing[prefab]}`).join(' + ')

/** 白天/黄昏的"准备光源"下一步：做、装备、采、找，四选一。 */
function prepLightNext(snapshot) {
  if (hand(snapshot) === TORCH) return 'unequip slot=hands（天还亮着，先收起火把省燃料，再补储备）'
  const missing = missingOf(snapshot, TORCH_RECIPE)
  if (Object.keys(missing).length === 0) {
    return 'craft torch（2 草 + 2 树枝已经齐了；做好若自动拿在手里，立即 unequip slot=hands 收回背包，入夜再举）'
  }
  const needText = NEED_TEXT(missing)
  // 没草但有木头+石头：火坑不用 cutgrass，是唯一能破局的固定光源
  if (missing.cutgrass && firepitReady(snapshot)) {
    return 'build firepit（2 木头 + 12 石头，不用草；燃料够一整夜，站在旁边别走远）'
  }
  // 有火把但没拿在手里（只可能在黄昏/夜里被 light 目标接管；白天也提醒一句）
  const gather = []
  for (const prefab of Object.keys(missing).sort()) {
    const source = INGREDIENT_SOURCE[prefab]
    if (!source) continue
    if (prefab === 'flint') {
      if (anyWithin(snapshot, 'pickupables', 20, (item) => item?.prefab === 'flint')) gather.push('pickup')
      continue
    }
    if (anyWithin(snapshot, 'harvestables', 20, (item) => item?.prefab === source && isReadyHarvest(item))) {
      gather.push(source)
    }
  }
  if (gather.length > 0) {
    const uniq = [...new Set(gather)]
    return `gather_area ${uniq.slice(0, 1).join('')}（先凑火把材料，还差 ${needText}）`
  }
  const sources = Object.keys(missing).map((p) => INGREDIENT_SOURCE[p]).filter(Boolean)
  const alt = canMaybeFirepit(snapshot)
    ? '；若附近有石头和树，也可 craft pickaxe/axe 凑 2 木头 + 12 石头做 firepit（不用草）'
    : ''
  return `seek ${[...new Set(sources)].join(' / ')}（附近没有火把材料，还差 ${needText}；别为了找材料跑离安全区${alt}）`
}

/** 是否值得把"改走火坑路线"写进提示：附近有树或石头可挖 */
function canMaybeFirepit(snapshot) {
  const hasRocks = anyWithin(snapshot, 'resources', 24, isRock)
  const hasTrees = anyWithin(snapshot, 'resources', 24, isTree)
  return hasRocks && hasTrees
}

function lightNext(snapshot) {
  const missing = missingOf(snapshot, TORCH_RECIPE)
  const carried = portableLights(snapshot)[0]
  if (carried) return `equip ${carried.prefab}（已有可用光源，先装备）`
  if (Object.keys(missing).length === 0) return 'craft torch（空手做会直接拿在手里，不用再 equip）'
  if (firepitReady(snapshot)) return 'build firepit（2 木头 + 12 石头，不用草，燃料够一整夜）'
  const logs = count(snapshot, 'log')
  const grass = count(snapshot, 'cutgrass')
  if (logs >= 2 && grass >= 3) return 'build campfire（2 木头 + 3 干草）'
  const readyGrass = anyWithin(snapshot, 'harvestables', 20, (item) => item?.prefab === 'grass' && isReadyHarvest(item))
  const readySapling = anyWithin(snapshot, 'harvestables', 20, (item) => item?.prefab === 'sapling' && isReadyHarvest(item))
  if (readyGrass || readySapling) {
    return `gather_area 采${readyGrass ? '草' : ''}${readyGrass && readySapling ? '和' : ''}${readySapling ? '树苗' : ''}，凑 2 草 + 2 树枝做火把`
  }
  return 'seek grass 或 sapling，先把火把材料凑齐'
}

function protectedMaterials(snapshot) {
  if (hasLightReserve(snapshot)) return null
  return { ...TORCH_RECIPE }
}

/** 做 tool 会不会把留给火把的材料吃掉（导致火把材料不足）。 */
function wouldBreakTorchReserve(snapshot, toolRecipe) {
  const reserve = protectedMaterials(snapshot)
  if (!reserve) return false
  for (const [prefab, amount] of Object.entries(toolRecipe)) {
    const keep = reserve[prefab] ?? 0
    if (count(snapshot, prefab) - amount < keep) return true
  }
  return false
}

function toolNext(snapshot, want) {
  const recipe = want === 'axe' ? 'axe' : 'pickaxe'
  const need = TOOL_RECIPES[recipe]
  const have = Object.keys(need).every((prefab) => count(snapshot, prefab) >= need[prefab])
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
    title: () => '天黑了，马上弄到光',
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
      : `${foodSource(snapshot) ?? 'seek carrot 或 berrybush 找安全食物'}，拿到食物后 eat`),
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
    // 无法立即治疗时，不能让长期低血量锁死进食、备光和工具准备。
    priority: (snapshot) => healingFood(snapshot) ? 78 : 40,
    when: (snapshot) => (percentOf(snapshot?.player?.health) ?? 100) < 45,
    title: '血太低，先别送',
    why: (snapshot) => `生命 ${percentOf(snapshot?.player?.health) ?? '?'}%`,
    next: (snapshot) => {
      const food = healingFood(snapshot)
      if (food) return `eat food=${food.prefab}（用回血食物治疗，同时远离敌人）`
      return `${foodSource(snapshot, HEALING_FOODS) ?? 'seek carrot 找回血食物'}；保持安全距离，吃饱不会自动恢复生命`
    },
  },
  {
    id: 'prep_light',
    // 火把材料不算成品，能短暂点亮也不等于剩余燃料够用。
    priority: 60,
    when: (snapshot) => !isDark(snapshot) && !hasLightReserve(snapshot),
    title: '白天先把能带走的光源准备好',
    why: (snapshot) => {
      const missing = missingOf(snapshot, TORCH_RECIPE)
      if (Object.keys(missing).length === 0) return '光源储备不足，但火把材料够了，现在就做'
      return `便携光源燃料储备不足，补一把火把还差 ${NEED_TEXT(missing)}`
    },
    next: prepLightNext,
  },
  {
    id: 'tool_axe',
    priority: 55,
    // 火把材料保护：火把还没做出来时，做斧头会吃掉要留给火把的树枝 → 先不做斧头。
    when: (snapshot) => hand(snapshot) !== 'axe' && count(snapshot, 'axe') === 0
      && anyWithin(snapshot, 'resources', 24, isTree)
      && !wouldBreakTorchReserve(snapshot, TOOL_RECIPES.axe),
    title: '附近有树，先弄把斧头',
    why: () => '没有斧头砍不了树，木头是做火堆/工具的基础',
    next: (snapshot) => toolNext(snapshot, 'axe'),
  },
  {
    id: 'tool_pickaxe',
    priority: 50,
    when: (snapshot) => hand(snapshot) !== 'pickaxe' && count(snapshot, 'pickaxe') === 0
      && anyWithin(snapshot, 'resources', 24, isRock)
      && !wouldBreakTorchReserve(snapshot, TOOL_RECIPES.pickaxe),
    title: '附近有石头，先弄把镐',
    why: () => '没有镐挖不了石头，石头是火坑/科学机器的基础',
    next: (snapshot) => toolNext(snapshot, 'pickaxe'),
  },
  {
    id: 'stock_food',
    priority: 65,
    when: (snapshot) => edibleCount(snapshot) < 2 && foodSource(snapshot) !== null,
    title: '背包食物不足，先补食物',
    why: () => '饥饿会一路掉到 0，提前存一点',
    next: (snapshot) => `${foodSource(snapshot)}；背包满了就先用 drop 丢掉不用的`,
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
  // priority 可以是数字，也可以是函数（同一目标按时间/状态在不同优先级之间切换）
  const priorityOf = (goalSpec) => (typeof goalSpec.priority === 'function'
    ? (Number(goalSpec.priority(snapshot)) || 0)
    : (Number(goalSpec.priority) || 0))
  const active = GOALS
    .filter((goalSpec) => goalSpec.when(snapshot))
    .map((goalSpec) => ({ goalSpec, priority: priorityOf(goalSpec) }))
    .sort((left, right) => right.priority - left.priority)
  const topEntry = active[0]
  const top = topEntry ? topEntry.goalSpec : GOALS[GOALS.length - 1]
  const topPriority = topEntry ? topEntry.priority : priorityOf(top)

  // 稳定：手上这件事仍然成立、又没有更高优先级的目标时，不换方向。
  const held = base ? GOALS.find((goalSpec) => goalSpec.id === base.goalId) : null
  let goal = top
  if (held && held.when(snapshot) && topPriority <= priorityOf(held)) goal = held

  const changed = !base || base.goalId !== goal.id
  return {
    schema: PLAN_SCHEMA,
    world,
    goalId: goal.id,
    title: typeof goal.title === 'function' ? goal.title(snapshot) : goal.title,
    why: typeof goal.why === 'function' ? (goal.why(snapshot) ?? '') : (goal.why ?? ''),
    next: typeof goal.next === 'function' ? (goal.next(snapshot) ?? '') : (goal.next ?? ''),
    since: changed ? now : (base.since ?? now),
    candidates: active.slice(0, 3).map((entry) => ({
      id: entry.goalSpec.id,
      title: typeof entry.goalSpec.title === 'function' ? entry.goalSpec.title(snapshot) : entry.goalSpec.title,
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
// 调试/白盒测试用（plan 内部判定，不给模型看）
export const planInternals = { hasPortableLight, isUsableLightBlock, handSlot, missingOf, TORCH_RECIPE, FIREPIT_RECIPE, firepitReady }
