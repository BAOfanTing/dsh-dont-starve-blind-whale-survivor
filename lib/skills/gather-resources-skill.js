// 技能 3：按真实需求收集材料（gather_resources）
//
// 流程（任务书 §四 Skill3）：
//   1 确定目标配方（默认核心建家配方；可由实例 data.recipe 覆盖）
//   2 读当前背包/装备数量，算缺口
//   3 找材料来源、选安全采集原子动作
//   4 执行 → 重新读快照核对数量变化 → 未达标继续
//   5 达标完成；超出搜索预算（executor 的 step_calls 上限）→ 失败/阻塞
//
// 中间产物依赖：缺 boards 时，先看 log 够不够 → 不够先砍树，够了再 craft boards（CRAFTED_DEPS）。
// 绝不"缺木板就一直砍树"：每步都重新算缺口，成品数量达标才结束。

import { CORE_RECIPE } from './establish-home.js'
import { missingMaterials, actionForMissing, CRAFTED_DEPS } from './skill-utils.js'

function recipeOf(ctx) {
  const data = ctx.instance?.data ?? {}
  return data.recipe && typeof data.recipe === 'object' ? data.recipe : CORE_RECIPE
}

export const gatherResources = {
  id: 'gather_resources',
  name: '收集资源',
  version: 1,

  steps: [
    {
      id: 'collect',
      title: '按缺口收集材料（含中间产物依赖）',
      isDone(ctx) {
        return Object.keys(missingMaterials(ctx.snapshot, recipeOf(ctx))).length === 0
      },
      nextAction(ctx) {
        const recipe = recipeOf(ctx)
        const missing = missingMaterials(ctx.snapshot, recipe)
        const first = Object.keys(missing)[0]
        if (!first) return { done: true }
        // 中间产物：先把原料补齐（actionForMissing 内部处理 boards/rope/cutstone/transistor 的依赖）
        const act = actionForMissing(ctx.snapshot, first)
        if (act?.blocked) return act
        if (!act) return { blocked: `不知道怎么弄到 ${first}` }
        return act
      },
    },
  ],

  completion(ctx) {
    return Object.keys(missingMaterials(ctx.snapshot, recipeOf(ctx))).length === 0
  },

  failure() { return false },
  retry_policy: { max_step_attempts: 3 },
  timeout_policy: { max_calls_per_step: 24 },
}

export { CRAFTED_DEPS }
