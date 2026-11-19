// 技能任务适配器：资源收集（Gather Resources）
//
// 职责：
//   1. 承接看板阶段目标，将"某个配方还缺什么材料"展开成带结构化 skill_id 与 skill_args 的看板任务；
//   2. 复用 skill-utils.js 的权威缺口计算（ownedCount，涵盖背包与装备栏），避免手持物品计数漂移；
//   3. 具体执行由 SkillExecutor.run('gather_resources', skill_args) 逐步驱动。

import { missingMaterials } from './skill-utils.js'

export { missingMaterials }

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

/** 某材料的采集提示（拿不到来源就如实说"需要找/造"） */
export function gatherAction(prefab) {
  const src = INGREDIENT_SOURCE[prefab]
  if (src) return src.action
  return `想办法弄到 ${prefab}（可能是中间产物，先在科学机器旁 craft）`
}

/** 把缺的材料变成"收集任务"。绑定 skill_id 与 skill_args。 */
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
      skill_id: 'gather_resources',
      skill_args: { recipe: { [prefab]: need }, target_items: { [prefab]: need } },
      target: { type: 'inventory', prefab, count: need },
      search_budget: { max_attempts: 6, max_distance_tiles: 40 },
      created_at: now,
    })
  }
  return { tasks, missing }
}
