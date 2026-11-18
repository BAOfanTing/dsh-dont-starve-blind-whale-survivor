// 发展阶段（Development Stages）：长期目标，配置化，不让模型每轮自由发明发展顺序。
//
// 每个阶段有明确的**完成条件**（只看快照 + 世界记忆的真实证据），完成才推进下一阶段。
// 已完成阶段不会无理由重开（由 world-memory.current_stage 锁存）。
//
// 阶段（对齐任务书 §五，按本项目能力裁剪）：
//   0 开局生存 → 1 建立家园 → 2 基础生产 → 3 基础装备 → 4 食物体系 → 5 科技升级 → 6 长期生存

import { countInInventory, inventoryItems } from '../actions/state-query.js'
import { ownedCount } from './task-board.js'

const EDIBLE = new Set([
  'berries', 'berries_juicy', 'carrot', 'corn', 'pumpkin', 'eggplant', 'honey',
  'meat', 'smallmeat', 'froglegs', 'fish',
  'meat_cooked', 'smallmeat_cooked', 'froglegs_cooked', 'fish_cooked',
  'berries_cooked', 'berries_juicy_cooked', 'carrot_cooked', 'corn_cooked', 'pumpkin_cooked', 'eggplant_cooked',
])

const LIGHTS = new Set(['torch', 'lantern', 'minerhat'])

function structureItems(snapshot, key) {
  const buckets = snapshot?.nearby?.buckets
  if (!buckets) return []
  if (Array.isArray(buckets)) return buckets.find((g) => g?.kind === key)?.items ?? []
  const list = buckets[key]
  return Array.isArray(list) ? list : Object.values(list ?? {})
}

/** 当前视野或记忆里是否有某建筑（离开视野靠 known_buildings 兜底，避免重复建） */
export function hasStructure(snapshot, memory, prefab) {
  const aliases = prefab === 'sciencemachine' ? ['sciencemachine', 'researchlab']
    : prefab === 'alchemyengine' ? ['alchemyengine', 'researchlab2'] : [prefab]
  for (const it of structureItems(snapshot, 'structures')) {
    if (aliases.includes(String(it?.prefab ?? ''))) return true
  }
  for (const b of memory?.known_buildings ?? []) {
    if (aliases.includes(String(b?.prefab ?? ''))) return true
  }
  return false
}

function edibleCount(snapshot) {
  let n = 0
  for (const it of inventoryItems(snapshot)) {
    if (EDIBLE.has(String(it?.prefab ?? ''))) n += Number(it.count ?? 1)
  }
  return n
}

function usablePortableLight(snapshot) {
  // 手上有可用光源，或背包里有未耗尽的
  for (const it of inventoryItems(snapshot)) {
    if (LIGHTS.has(String(it?.prefab ?? '')) && (typeof it.percent !== 'number' || it.percent > 0)) return true
  }
  const hands = snapshot?.player?.equipment?.slots?.hands
  const hp = typeof hands === 'string' ? hands : hands?.prefab
  if (hp && LIGHTS.has(hp)) return true
  return snapshot?.player?.in_light === true
}

function canCraftTorchFromMaterials(snapshot) {
  if (countInInventory(snapshot, 'cutgrass') >= 2 && countInInventory(snapshot, 'twigs') >= 2) return true
  if (countInInventory(snapshot, 'log') >= 2 && countInInventory(snapshot, 'rocks') >= 12) return true // firepit
  return false
}

/** 每阶段的完成条件。返回 true 表示该阶段已完成。 */
export const STAGES = [
  {
    index: 0,
    id: 'opening_survival',
    title: '开局生存',
    goal: '先活下来：有光、有吃的、有基础工具',
    isComplete(snapshot) {
      const lightOk = usablePortableLight(snapshot) || canCraftTorchFromMaterials(snapshot)
      const foodOk = edibleCount(snapshot) >= 1
      const toolOk = ownedCount(snapshot, 'axe') >= 1 || ownedCount(snapshot, 'pickaxe') >= 1
      return lightOk && foodOk && toolOk
    },
  },
  {
    index: 1,
    id: 'establish_home',
    title: '建立家园',
    goal: '探索→选址→前往→建第一座核心建筑→设置家',
    isComplete(_snapshot, memory) {
      return typeof memory?.home_building_id === 'string' && memory.home_building_id !== ''
    },
  },
  {
    index: 2,
    id: 'basic_production',
    title: '建立基础生产能力',
    goal: '在家的范围内：科学机器 + 永久光源（火坑/营火）',
    isComplete(snapshot, memory) {
      const sci = hasStructure(snapshot, memory, 'sciencemachine')
      const fire = hasStructure(snapshot, memory, 'firepit') || hasStructure(snapshot, memory, 'campfire')
      return sci && fire
    },
  },
  {
    index: 3,
    id: 'basic_equipment',
    title: '基础装备',
    goal: '背包 + 长矛 + 木甲',
    isComplete(snapshot) {
      return ownedCount(snapshot, 'backpack') >= 1
        && ownedCount(snapshot, 'spear') >= 1
        && ownedCount(snapshot, 'armorwood') >= 1
    },
  },
  {
    index: 4,
    id: 'food_system',
    title: '食物体系',
    goal: '有锅，并维持一定食物储备',
    isComplete(snapshot, memory) {
      return hasStructure(snapshot, memory, 'cookpot') && edibleCount(snapshot) >= 2
    },
  },
  {
    index: 5,
    id: 'tech_upgrade',
    title: '科技升级',
    goal: '炼金引擎 + 帐篷',
    isComplete(snapshot, memory) {
      return hasStructure(snapshot, memory, 'alchemyengine') && hasStructure(snapshot, memory, 'tent')
    },
  },
  {
    index: 6,
    id: 'long_term',
    title: '长期生存',
    goal: '季节准备、猎犬防御、基地维护、资源扩张',
    isComplete() { return false }, // 长期进行
  },
]

export function getStage(index) {
  return STAGES.find((s) => s.index === index) ?? STAGES[0]
}

/** 从当前阶段开始，把已完成的阶段连续推进；返回推进后的阶段与本次完成的里程碑。 */
export function evaluateStage(snapshot, memory) {
  let index = Number.isInteger(memory?.current_stage) ? memory.current_stage : 0
  const completed = []
  const guard = 8
  let steps = 0
  while (index < 6 && steps++ < guard) {
    const stage = getStage(index)
    let done = false
    try { done = stage.isComplete(snapshot, memory) === true } catch { done = false }
    if (!done) break
    completed.push({ index, id: stage.id, title: stage.title })
    index += 1
  }
  return { currentIndex: index, justCompleted: completed, stage: getStage(index) }
}
