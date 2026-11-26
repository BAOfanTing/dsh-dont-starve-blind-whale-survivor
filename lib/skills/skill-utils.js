// 技能公共工具：把"看快照 + 选原子动作"的判定集中在这里，多个技能复用。
//
// 只做只读判定与「下一步该调哪个原子动作」的映射；**不下发动作**（下发由 skill-executor 走 dispatcher）。
// 核心能力：
//   1) 工具前置：砍树要斧头、挖石头/金矿要镐；没有就先做工具（再采工具材料）。
//   2) 距离感知：pickup_nearest 只在手边 ~2.5 格有效、chop/mine ~2.5 格有效；太远先 move_to 走过去。
// 原子动作优先用实时目标选择类（不依赖 #N/snapshot_id），跨帧稳定。

import { countInInventory, inventoryItems, equipmentItem } from '../actions/state-query.js'
import { ownedCount } from '../planner/task-board.js'
import { findKnownResource, exploreFrontier } from './explore-utils.js'
import {
  AUTO_SAFE_FOOD_SET,
  CRAFTED_DEPS as SHARED_CRAFTED_DEPS,
} from '../game-data/recipes-and-foods.js'

/** 与 eatrules.lua 的 AUTO_SAFE 对齐（引自唯一数据源 recipes-and-foods.js）。 */
export const EDIBLE = AUTO_SAFE_FOOD_SET

const LIGHTS = new Set(['torch', 'lantern', 'minerhat'])

export function isNight(snapshot) {
  return snapshot?.world?.phase === 'night'
}

/** 读某个装备槽的完整条目（含 percent），读不到返回 null。slots / worn 两种形状都要能吃。 */
function equipmentBlock(snapshot, slot) {
  const eq = snapshot?.player?.equipment
  if (!eq || typeof eq !== 'object') return null
  const slots = eq.slots
  if (slots && typeof slots === 'object' && !Array.isArray(slots)) {
    const h = slots[slot] ?? slots[String(slot).toUpperCase()]
    if (typeof h === 'string' && h !== '') return { prefab: h }
    if (h && typeof h === 'object') return h
  }
  const worn = eq.worn
  if (Array.isArray(worn)) {
    for (const entry of worn) {
      const key = String(entry?.key ?? entry?.slot_key ?? entry?.slot ?? '').toLowerCase()
      if (key !== slot) continue
      const it = entry?.item ?? entry
      if (typeof it === 'string' && it !== '') return { prefab: it }
      if (it && typeof it === 'object') return it
    }
  }
  if (worn && typeof worn === 'object' && !Array.isArray(worn)) {
    const h = worn[slot] ?? worn[String(slot).toUpperCase()]
    if (typeof h === 'string' && h !== '') return { prefab: h }
    if (h && typeof h === 'object') return h
  }
  return null
}

function usableLightBlock(block) {
  if (!block) return false
  const prefab = String(block.prefab ?? '')
  if (!LIGHTS.has(prefab)) return false
  return typeof block.percent !== 'number' || block.percent > 0
}

/**
 * 背包里有可用便携光源。★ 这**不等于正在照明** —— 背包里的火把不发光，必须 equip 才有用。
 * 用在 lightAction 判断"要不要 equip"，绝不能当作"玩家已经安全"的依据。
 */
export function hasUsableLightInInventory(snapshot) {
  for (const it of inventoryItems(snapshot)) {
    if (usableLightBlock(it)) return true
  }
  return false
}

/** 背包里第一个可用的便携光源 prefab（用于 equip），没有返回 null。 */
export function firstUsableLightInInventory(snapshot) {
  for (const it of inventoryItems(snapshot)) {
    if (usableLightBlock(it)) return String(it.prefab)
  }
  return null
}

/**
 * 真正"拿在手上 / 戴在头上"的可用光源 —— 只有这种（或 player.in_light）才算玩家真的被照亮。
 * `player.in_light`、附近光源、背包里的便携光源、实际照明效果是**不同概念**：
 *   · 附近有一个南瓜灯不代表玩家在光里；
 *   · 背包里有一把火把不代表玩家在发光；
 * 真正能保命的判据只有 player.in_light 或手上/头上的光源。
 */
export function hasEquippedUsableLight(snapshot) {
  for (const slot of ['hands', 'head']) {
    if (usableLightBlock(equipmentBlock(snapshot, slot))) return true
  }
  return false
}

/** 兼容旧名：hasUsableLight 指"已经装备、正在照明"的光源（不再把背包里的火把算进来）。 */
export function hasUsableLight(snapshot) {
  return hasEquippedUsableLight(snapshot)
}

export function lightOk(snapshot) {
  return snapshot?.player?.in_light === true || hasEquippedUsableLight(snapshot) || !isNight(snapshot)
}

export function edibleCount(snapshot) {
  let n = 0
  for (const it of inventoryItems(snapshot)) {
    if (EDIBLE.has(String(it?.prefab ?? ''))) n += Number(it.count ?? 1)
  }
  return n
}

export function hungerThreshold(snapshot) {
  return snapshot?.actor?.prefab === 'wolfgang' ? 55 : 40
}

// ───────────────────── 快照读取（只读） ─────────────────────

function bucket(snapshot, key) {
  const buckets = snapshot?.nearby?.buckets
  if (!buckets) return []
  if (Array.isArray(buckets)) return buckets.find((g) => g?.kind === key)?.items ?? []
  const list = buckets[key]
  return Array.isArray(list) ? list : Object.values(list ?? {})
}

function posOf(item) {
  const p = item?.position ?? (typeof item?.x === 'number' && typeof item?.z === 'number' ? { x: item.x, z: item.z } : null)
  if (p && typeof p.x === 'number' && typeof p.z === 'number') return { x: p.x, z: p.z }
  return null
}

/** 某桶里最近的一个满足条件的实体，返回 { item, pos, distance } 或 null。 */
function nearest(snapshot, key, pred) {
  let best = null
  for (const it of bucket(snapshot, key)) {
    if (!pred(it)) continue
    const pos = posOf(it)
    let d = typeof it.distance === 'number' ? it.distance : Infinity
    if (pos) {
      const a = snapshot?.actor
      if (a && typeof a.tileX === 'number') d = Math.min(d, Math.hypot(pos.x - a.tileX, pos.z - a.tileZ))
    }
    if (!best || d < best.distance) best = { item: it, pos, distance: d }
  }
  return best
}

function moveTo(pos) {
  return { tool: 'move_to', args: { x: Math.round(pos.x), z: Math.round(pos.z) } }
}

const isTree = (it) => it?.work_action === 'CHOP' || /tree|evergreen|deciduous|birch|twigg/i.test(String(it?.prefab ?? ''))
const isRock = (it) => it?.work_action === 'MINE' || /^rock|boulder/i.test(String(it?.prefab ?? ''))
const isGold = (it) => it?.prefab === 'rock2' || /gold/i.test(String(it?.prefab ?? ''))
const ready = (it) => it?.harvest_ready !== false

// ───────────────────── 材料 / 中间产物 → 原子动作 ─────────────────────

// ───────────────────── 采集距离语义（三个概念必须分开，禁止用一个 range 混表） ─────────────────────
//
//   detectionRange     ：Snapshot 能"看见"资源的范围（nearby 扫描半径，Lua 侧 16~40 格）。
//   interactionRange   ：玩家能"直接交互/采集"的距离（pickup_nearest ~2.5 格；harvest 约 1 格）。
//   gatherSearchRadius ：gather_area 指令**实际搜索**的半径。
//
// ★ gatherSearchRadius 的权威来源在 Lua，不在 JS：
//   DontStarveWhaleSurvivor/scripts/whale/actions/gathering.lua → JOBS.gather_area:
//       j.data.radius = tonumber(ctx.radius) or 8
//   两端必须保持一致：JS 用它判断"资源够不够近、要不要先 move_to"，否则远距直接 gather_area 会被 Lua 拒。
//   修改任何一端都必须同步另一端（由 tests/skills/gather-range.test.mjs 守护）。
export const LUA_GATHER_SEARCH_RADIUS = 8
/** pickup_nearest 只对手边约 2.5 格内有效（Lua pickuprules）。 */
export const PICKUP_INTERACTION_RANGE = 2.5
/** chop_nearest / mine_nearest 的实际有效半径（超过会回 out_of_range，需先 move_to）。 */
export const WORK_NEAREST_RANGE = 2.5

/** 每种原材料的来源桶、判定、seek 关键字、就近动作、走位阈值（超过就先 move_to）。 */
const MATERIAL_SPEC = {
  flint: { bucket: 'pickupables', match: (it) => it?.prefab === 'flint', seek: 'flint', act: { tool: 'pickup_nearest', args: { target_kind: 'flint' } }, range: PICKUP_INTERACTION_RANGE },
  twigs: { bucket: 'harvestables', match: (it) => it?.prefab === 'sapling' && ready(it), seek: 'sapling', act: { tool: 'gather_area', args: { prefab: 'sapling' } }, range: LUA_GATHER_SEARCH_RADIUS },
  cutgrass: { bucket: 'harvestables', match: (it) => it?.prefab === 'grass' && ready(it), seek: 'grass', act: { tool: 'gather_area', args: { prefab: 'grass' } }, range: LUA_GATHER_SEARCH_RADIUS },
  petals: { bucket: 'harvestables', match: (it) => it?.prefab === 'flower' && ready(it), seek: 'flower', act: { tool: 'gather_area', args: { prefab: 'flower' } }, range: LUA_GATHER_SEARCH_RADIUS },
  carrot: { bucket: 'harvestables', match: (it) => /carrot/i.test(String(it?.prefab ?? '')) && ready(it), seek: 'carrot_planted', act: { tool: 'harvest_nearest', args: { target_kind: 'carrot_plant' } }, range: 1.0 },
  berries: { bucket: 'harvestables', match: (it) => /berrybush/i.test(String(it?.prefab ?? '')) && ready(it), seek: 'berrybush', act: { tool: 'harvest_nearest', args: { target_kind: 'berrybush' } }, range: 1.0 },
  log: { bucket: 'resources', match: (it) => isTree(it) && !it?.is_burnt && !it?.is_burning, seek: 'tree', act: { tool: 'chop_nearest', args: { target_kind: 'tree' } }, range: WORK_NEAREST_RANGE },
  rocks: { bucket: 'resources', match: (it) => isRock(it) && !isGold(it), seek: 'rock', act: { tool: 'mine_nearest', args: { target_kind: 'ordinary_rock' } }, range: WORK_NEAREST_RANGE },
  goldnugget: { bucket: 'resources', match: isGold, seek: 'rock2', act: { tool: 'mine_nearest', args: { target_kind: 'gold_vein' } }, range: WORK_NEAREST_RANGE },
}

/** 只能靠 craft 得到的中间产物：需要哪些原料、craft 什么（引自唯一数据源 recipes-and-foods.js）。 */
export const CRAFTED_DEPS = SHARED_CRAFTED_DEPS

export function materialAction(prefab) {
  return MATERIAL_SPEC[prefab]?.act ?? null
}

/** 还差哪些材料：{ prefab: 差几个 }（含手上/装备，和背包一起算）。 */
export function missingMaterials(snapshot, recipe) {
  const missing = {}
  for (const [prefab, need] of Object.entries(recipe ?? {})) {
    const have = ownedCount(snapshot, prefab)
    if (have < need) missing[prefab] = need - have
  }
  return missing
}

function actorPosOf(snapshot) {
  const a = snapshot?.actor
  if (!a) return null
  const x = typeof a.tileX === 'number' ? a.tileX : (typeof a.tile_x === 'number' ? a.tile_x : (typeof a.x === 'number' ? Math.round(a.x / 4) : null))
  const z = typeof a.tileZ === 'number' ? a.tileZ : (typeof a.tile_z === 'number' ? a.tile_z : (typeof a.z === 'number' ? Math.round(a.z / 4) : null))
  return (typeof x === 'number' && typeof z === 'number') ? { x, z } : null
}

/** 采某种原材料的下一步：附近有 → 够近就采/砍/挖，太远就 move_to；附近没有 → 记忆导航或定向探路。 */
export function gatherMaterial(snapshot, prefab, memory = null) {
  const spec = MATERIAL_SPEC[prefab]
  if (!spec) return null
  const found = nearest(snapshot, spec.bucket, spec.match)
  if (found) {
    if (found.pos && found.distance > spec.range) return moveTo(found.pos)
    return spec.act
  }
  // 兜底：地上就有现成的同类物品（例：地上的树枝 twigs / 石头 rocks / 割下的草 cutgrass）
  if (PICK_KIND[prefab]) {
    const ground = nearest(snapshot, 'pickupables', (it) => it?.prefab === prefab)
    if (ground) {
      if (ground.pos && ground.distance > 1.5) return moveTo(ground.pos)
      return { tool: 'pickup_nearest', args: { target_kind: PICK_KIND[prefab] } }
    }
  }

  // 查阅 WorldMemory 已知资源：导航过去，不再原地盲找！
  const actorPos = actorPosOf(snapshot)
  if (memory) {
    const known = findKnownResource(memory, (res) => {
      const p = String(res.prefab || '').toLowerCase()
      if (prefab === 'goldnugget') return p === 'rock2' || p === 'goldnugget'
      if (prefab === 'rocks') return p === 'rock1' || p === 'rock2' || p === 'rocks'
      if (prefab === 'flint') return p === 'flint' || p === 'rock1' || p === 'rock2'
      if (prefab === 'log') return p === 'evergreen' || p === 'deciduoustree' || p === 'tree'
      if (prefab === 'twigs') return p === 'sapling' || p === 'twigs'
      if (prefab === 'cutgrass') return p === 'grass' || p === 'cutgrass'
      if (prefab === 'berries') return p.includes('berrybush')
      if (prefab === 'carrot') return p.includes('carrot')
      return p === prefab || p === spec.seek
    }, actorPos)

    if (known && actorPos) {
      const dist = Math.hypot(known.x - actorPos.x, known.z - actorPos.z)
      if (dist > spec.range) {
        return { tool: 'move_to', args: { x: Math.round(known.x), z: Math.round(known.z) } }
      }
    }
  }

  // 已经探索过（有 explored_regions）但当前视野与已知资源都没有时，朝迷雾开图，避免原地 seek 死循环。
  if (memory && Array.isArray(memory.explored_regions) && memory.explored_regions.length > 0) {
    return exploreFrontier(snapshot, memory)
  }
  return { tool: 'seek', args: { prefab: spec.seek } }
}

/** 地上现成物品 → pickup_nearest 的 target_kind。 */
const PICK_KIND = {
  flint: 'flint', twigs: 'twigs', cutgrass: 'cutgrass', petals: 'petals',
  carrot: 'carrot', berries: 'berries',
  log: 'log', rocks: 'rocks', goldnugget: 'goldnugget', charcoal: 'charcoal',
}

function targetRefArgs(snapshot, item) {
  if (item?.handle) return { target_handle: item.handle }
  const sid = snapshot?.nearby?.snapshot_id
  if (item?.ref && sid) return { target_ref: item.ref, snapshot_id: sid }
  return null
}

function gatherCharcoal(snapshot, memory = null) {
  // 点火后执行层会撤到 6 格外，捡木炭前需先走回火点；
  // 火焰会自行蔓延，每次只需点燃 1 棵树等其烧完后批量拾取，避免连续重复点火；
  // 已烧焦的树已移除 workable 组件（evergreens.lua OnBurnt），只拾取地面木炭不发 chop。
  const ground = nearest(snapshot, 'pickupables', (it) => it?.prefab === 'charcoal')
  if (ground) {
    if (ground.pos && ground.distance > PICKUP_INTERACTION_RANGE) return moveTo(ground.pos)
    return { tool: 'pickup_nearest', args: { target_kind: 'charcoal' } }
  }

  // 有树正在烧：这一片马上就会产出木炭，**原地等**而不是跑去点新树。
  const burningTree = nearest(snapshot, 'resources', (it) => isTree(it) && it?.is_burning === true)
  if (burningTree) {
    // 等得久一点：树要烧 TREE_BURN_TIME≈45 秒才掉炭，5 秒一轮会空转十几轮。
    return { tool: 'wait', args: { seconds: 20 } }
  }

  // 已经烧焦的树：走过去，让下一轮在原地捡到它掉落的木炭（不发 chop）。
  const burntTree = nearest(snapshot, 'resources', (it) => isTree(it) && it?.is_burnt === true)
  if (burntTree) {
    if (burntTree.pos && burntTree.distance > PICKUP_INTERACTION_RANGE) return moveTo(burntTree.pos)
    // 站在焦树旁边但地上暂时没有炭：说明这棵还没掉完，等它一下。
    return { tool: 'wait', args: { seconds: 10 } }
  }

  const tree = nearest(snapshot, 'resources', (it) => isTree(it) && !it?.is_burnt && !it?.is_burning)
  if (tree) {
    const hasLighter = ownedCount(snapshot, 'torch') > 0 || ownedCount(snapshot, 'lighter') > 0
    if (!hasLighter) {
      if (countInInventory(snapshot, 'cutgrass') >= 2 && countInInventory(snapshot, 'twigs') >= 2) {
        return { tool: 'craft', args: { recipe: 'torch' } }
      }
      return actionForMissing(snapshot, countInInventory(snapshot, 'cutgrass') < 2 ? 'cutgrass' : 'twigs', memory)
    }
    if (tree.pos && tree.distance > 4) return moveTo(tree.pos)
    const refArgs = targetRefArgs(snapshot, tree.item)
    if (refArgs) return { tool: 'use', args: { ...refArgs, action: 'LIGHT' } }
  }
  const actorPos = actorPosOf(snapshot)
  if (memory) {
    const known = findKnownResource(memory, (res) => {
      const p = String(res.prefab || '').toLowerCase()
      return p === 'charcoal' || p === 'evergreen' || p === 'deciduoustree' || p === 'tree'
    }, actorPos)
    if (known && actorPos) {
      const dist = Math.hypot(known.x - actorPos.x, known.z - actorPos.z)
      if (dist > 4) return { tool: 'move_to', args: { x: Math.round(known.x), z: Math.round(known.z) } }
    }
  }
  if (memory && Array.isArray(memory.explored_regions) && memory.explored_regions.length > 0) {
    return exploreFrontier(snapshot, memory)
  }
  return { tool: 'seek', args: { prefab: 'evergreen' } }
}

/** 做某个工具（axe/pickaxe）：材料够就 craft；不够就先去采缺的那种原料。 */
export function toolAction(snapshot, which, memory = null) {
  const recipe = which === 'axe' ? { twigs: 1, flint: 1 } : { twigs: 2, flint: 2 }
  const m = missingMaterials(snapshot, recipe)
  if (Object.keys(m).length === 0) return { tool: 'craft', args: { recipe: which } }
  const first = Object.keys(m)[0]
  return gatherMaterial(snapshot, first, memory) ?? { tool: 'seek', args: { prefab: 'flint' } }
}

/**
 * 给"缺某个材料"挑下一步原子动作。
 * 中间产物先补原料再 craft；砍树要斧头、挖石/金要镐，没有就先做工具。
 * @returns {{tool:string,args:object}|{blocked:string}}
 */
export function actionForMissing(snapshot, prefab, memory = null) {
  // ① 中间产物（boards/rope/cutstone/transistor）
  const dep = CRAFTED_DEPS[prefab]
  if (dep) {
    const rawMissing = missingMaterials(snapshot, dep.from)
    if (Object.keys(rawMissing).length === 0) return { tool: 'craft', args: { recipe: dep.craft } }
    return actionForMissing(snapshot, Object.keys(rawMissing)[0], memory)
  }
  // ② 工具前置
  if (prefab === 'log' && ownedCount(snapshot, 'axe') < 1) return toolAction(snapshot, 'axe', memory)
  if ((prefab === 'rocks' || prefab === 'goldnugget') && ownedCount(snapshot, 'pickaxe') < 1) return toolAction(snapshot, 'pickaxe', memory)
  if (prefab === 'charcoal') return gatherCharcoal(snapshot, memory)
  // ③ 直接采
  const act = gatherMaterial(snapshot, prefab, memory)
  return act ?? { blocked: `不知道 ${prefab} 怎么弄（可能需要先 craft）` }
}

// ───────────────────── 生存相关动作 ─────────────────────

export function lightAction(snapshot) {
  if (lightOk(snapshot)) return null
  // 背包里有可用光源（还没装备）→ 立刻装备；背包里的火把不发光，必须拿在手上。
  const invLight = firstUsableLightInInventory(snapshot)
  if (invLight) return { tool: 'equip', args: { item: invLight } }
  if (countInInventory(snapshot, 'cutgrass') >= 2 && countInInventory(snapshot, 'twigs') >= 2) {
    return { tool: 'craft', args: { recipe: 'torch' } }
  }
  if (countInInventory(snapshot, 'log') >= 2 && countInInventory(snapshot, 'rocks') >= 12) {
    return { tool: 'build', args: { recipe: 'firepit' } }
  }
  if (countInInventory(snapshot, 'log') >= 2 && countInInventory(snapshot, 'cutgrass') >= 3) {
    return { tool: 'build', args: { recipe: 'campfire' } }
  }
  return actionForMissing(snapshot, countInInventory(snapshot, 'cutgrass') < 2 ? 'cutgrass' : 'twigs')
}

import { foodAction, collectFoodCandidates, recordTargetFailure, targetIdOf } from './food-candidate-selector.js'
export { foodAction, collectFoodCandidates, recordTargetFailure, targetIdOf }

/** 附近有没有树/石头（决定"要不要弄工具"，没有就不阻塞生存）。 */
export function workableNearby(snapshot) {
  const hasTree = bucket(snapshot, 'resources').some(isTree)
  const hasRock = bucket(snapshot, 'resources').some((it) => isRock(it) && !isGold(it))
  return { hasTree, hasRock }
}

export { ownedCount }
