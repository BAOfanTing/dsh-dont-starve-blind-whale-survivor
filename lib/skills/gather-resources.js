// 技能：资源收集（Gather Resources）
//
// 把"某个配方还缺什么材料"翻译成：①缺哪些 prefab、②每种该用哪个原子动作去弄。
// 只产出任务/提示，不直接下动作 —— 真正干活仍走 dispatcher 的原子动作（pickup_nearest/chop_nearest/mine_nearest/gather_area）。
//
// 配方材料一律来自本文件映射的"原材料→来源"，中间产物（boards/rope/cutstone/transistor）另行 craft；
// 这里不复制游戏配方表（权威数量由 Lua craftrules 决定，Node 只做"差多少"的规划提示）。

import { countInInventory } from '../actions/state-query.js'

/** 原材料 → 采集方式（返回一句可直接照做的原子动作提示） */
export const INGREDIENT_SOURCE = {
  cutgrass: { action: 'gather_area prefab=grass', label: '割草' },
  twigs: { action: 'gather_area prefab=sapling', label: '采树苗' },
  flint: { action: 'pickup_nearest target_kind=flint', label: '捡燧石' },
  log: { action: 'chop_nearest target_kind=tree', label: '砍树' },
  rocks: { action: 'mine_nearest target_kind=ordinary_rock', label: '挖普通石头' },
  goldnugget: { action: 'mine_nearest target_kind=gold_vein', label: '挖金矿脉' },
  petals: { action: 'gather_area prefab=flower', label: '采花' },
  charcoal: { action: 'chop_nearest target_kind=tree（烧过的树）', label: '取木炭' },
  silk: { action: 'fight_spider target_ref=…（打蜘蛛掉）', label: '打蜘蛛取丝' },
}

/** 只能靠 craft 得到的中间产物（提示用） */
export const CRAFTED = new Set(['boards', 'rope', 'cutstone', 'transistor', 'log'])

/** 还缺哪些材料：{ prefab: 差几个 } */
export function missingMaterials(snapshot, recipe) {
  const missing = {}
  for (const [prefab, need] of Object.entries(recipe ?? {})) {
    const have = countInInventory(snapshot, prefab)
    if (have < need) missing[prefab] = need - have
  }
  return missing
}

/** 某材料的采集提示（拿不到来源就如实说"需要找/造"） */
export function gatherAction(prefab) {
  const src = INGREDIENT_SOURCE[prefab]
  if (src) return src.action
  return `想办法弄到 ${prefab}（可能是中间产物，先在科学机器旁 craft）`
}

/** 把缺的材料变成"收集任务"。deadline/budget 由调用方按阶段给。 */
export function expandGatherTasks(snapshot, recipe, { stage = 'general', priorityBase = 3, dependsOn = [], now = Date.now() } = {}) {
  const missing = missingMaterials(snapshot, recipe)
  const tasks = []
  let p = priorityBase
  for (const prefab of Object.keys(missing)) {
    const need = recipe[prefab]
    tasks.push({
      id: `gather_${prefab}`,
      title: `收集 ${prefab}（差 ${missing[prefab]}，目标 ${need}）`,
      stage,
      priority: p++,
      depends_on: [...dependsOn],
      target: { type: 'inventory', prefab, count: need },
      search_budget: { max_attempts: 6, max_distance_tiles: 40 },
      created_at: now,
    })
  }
  return { tasks, missing }
}
