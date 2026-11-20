// 技能公共工具：把"看快照 + 选原子动作"的判定集中在这里，多个技能复用。
//
// 只做只读判定与「下一步该调哪个原子动作」的映射；**不下发动作**（下发由 skill-executor 走 dispatcher）。
// 真机踩到的两个必需能力（本文件核心）：
//   1) 工具前置：砍树要斧头、挖石头/金矿要镐；没有就先做工具（再采工具材料）。
//   2) 距离感知：pickup_nearest 只在手边 ~2.5 格有效、chop/mine ~5 格有效；太远先 move_to 走过去。
// 原子动作优先用 target-refresh 类（不吃 #N/snapshot_id），跨帧稳定。

import { countInInventory, inventoryItems, equipmentItem } from '../actions/state-query.js'
import { ownedCount } from '../planner/task-board.js'
import { findKnownResource, exploreFrontier } from './explore-utils.js'

/** 与 eatrules.lua 的 AUTO_SAFE 对齐（不含生蘑菇）。 */
export const EDIBLE = new Set([
  'berries', 'berries_juicy', 'carrot', 'corn', 'pumpkin', 'eggplant', 'honey',
  'meat', 'smallmeat', 'froglegs', 'fish',
  'meat_cooked', 'smallmeat_cooked', 'froglegs_cooked', 'fish_cooked',
  'berries_cooked', 'berries_juicy_cooked', 'carrot_cooked', 'corn_cooked',
  'pumpkin_cooked', 'eggplant_cooked', 'acorn_cooked', 'petals',
])

const LIGHTS = new Set(['torch', 'lantern', 'minerhat'])

export function isNight(snapshot) {
  return snapshot?.world?.phase === 'night'
}

export function hasUsableLight(snapshot) {
  for (const it of inventoryItems(snapshot)) {
    if (LIGHTS.has(String(it?.prefab ?? '')) && (typeof it.percent !== 'number' || it.percent > 0)) return true
  }
  const hands = equipmentItem(snapshot, 'hands')
  return Boolean(hands && LIGHTS.has(hands))
}

export function lightOk(snapshot) {
  return snapshot?.player?.in_light === true || hasUsableLight(snapshot) || !isNight(snapshot)
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

/** 每种原材料的来源桶、判定、seek 关键字、就近动作、走位阈值（超过就先 move_to）。 */
const MATERIAL_SPEC = {
  flint: { bucket: 'pickupables', match: (it) => it?.prefab === 'flint', seek: 'flint', act: { tool: 'pickup_nearest', args: { target_kind: 'flint' } }, range: 2.5 },
  twigs: { bucket: 'harvestables', match: (it) => it?.prefab === 'sapling' && ready(it), seek: 'sapling', act: { tool: 'gather_area', args: { prefab: 'sapling' } }, range: Infinity },
  cutgrass: { bucket: 'harvestables', match: (it) => it?.prefab === 'grass' && ready(it), seek: 'grass', act: { tool: 'gather_area', args: { prefab: 'grass' } }, range: Infinity },
  petals: { bucket: 'harvestables', match: (it) => it?.prefab === 'flower' && ready(it), seek: 'flower', act: { tool: 'gather_area', args: { prefab: 'flower' } }, range: Infinity },
  carrot: { bucket: 'harvestables', match: (it) => /carrot/i.test(String(it?.prefab ?? '')) && ready(it), seek: 'carrot_planted', act: { tool: 'harvest_nearest', args: { target_kind: 'carrot_plant' } }, range: 1.0 },
  berries: { bucket: 'harvestables', match: (it) => /berrybush/i.test(String(it?.prefab ?? '')) && ready(it), seek: 'berrybush', act: { tool: 'harvest_nearest', args: { target_kind: 'berry_bush' } }, range: 1.0 },
  log: { bucket: 'resources', match: isTree, seek: 'tree', act: { tool: 'chop_nearest', args: { target_kind: 'tree' } }, range: 4.5 },
  rocks: { bucket: 'resources', match: (it) => isRock(it) && !isGold(it), seek: 'rock', act: { tool: 'mine_nearest', args: { target_kind: 'ordinary_rock' } }, range: 4.5 },
  goldnugget: { bucket: 'resources', match: isGold, seek: 'rock2', act: { tool: 'mine_nearest', args: { target_kind: 'gold_vein' } }, range: 4.5 },
}

/** 只能靠 craft 得到的中间产物：需要哪些原料、craft 什么。 */
export const CRAFTED_DEPS = {
  boards: { craft: 'boards', from: { log: 4 } },
  rope: { craft: 'rope', from: { cutgrass: 3 } },
  cutstone: { craft: 'cutstone', from: { rocks: 3 } },
  transistor: { craft: 'transistor', from: { goldnugget: 2, cutstone: 1 } },
}

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
  const x = typeof a.tileX === 'number' ? a.tileX : (typeof a.x === 'number' ? a.x : null)
  const z = typeof a.tileZ === 'number' ? a.tileZ : (typeof a.z === 'number' ? a.z : null)
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

  return { tool: 'seek', args: { prefab: spec.seek } }
}

/** 地上现成物品 → pickup_nearest 的 target_kind。 */
const PICK_KIND = {
  flint: 'flint', twigs: 'twigs', cutgrass: 'cutgrass', petals: 'petals',
  carrot: 'carrot', berries: 'berries',
  log: 'log', rocks: 'rocks', goldnugget: 'goldnugget',
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
  // ③ 直接采
  const act = gatherMaterial(snapshot, prefab, memory)
  return act ?? { blocked: `不知道 ${prefab} 怎么弄（可能需要先 craft）` }
}

// ───────────────────── 生存相关动作 ─────────────────────

export function lightAction(snapshot) {
  if (lightOk(snapshot)) return null
  if (hasUsableLight(snapshot)) return { tool: 'equip', args: { item: 'torch' } }
  if (countInInventory(snapshot, 'torch') > 0) return { tool: 'equip', args: { item: 'torch' } }
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
