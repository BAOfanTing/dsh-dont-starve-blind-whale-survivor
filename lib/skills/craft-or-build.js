// 通用"制作/建造"技能（craft_or_build）—— 接管 Stage 2~5 的 build_* 与 gear_* 任务。
// 通过 skill_args.recipe 参数化：缺料先采集（复用 gatherMaterial/actionForMissing，含 CRAFTED 中间产物），
// 到家/科学机器旁，再 craft（物品）或 build（建筑），最后按真实快照证据核验。
//
// 只返回原子动作 {tool,args}，由 skill-executor 走 dispatcher；不另造执行通道。
import { hasStructure } from '../planner/development-stages.js'
import { ownedCount } from '../planner/task-board.js'
import { missingMaterials, actionForMissing } from './skill-utils.js'

/** 建筑 vs 物品：建筑用 build（需在营地/家范围），物品用 craft。 */
const STRUCTURES = new Set(['campfire', 'firepit', 'chest', 'cookpot', 'sciencemachine', 'researchlab', 'researchlab2', 'alchemyengine', 'tent'])
/** 需要科学机器（科技）才能做的物品。 */
const TECH_ITEMS = new Set(['backpack', 'spear', 'armorwood', 'transistor'])
/** 节点侧配方（权威扣减在 Lua craftrules；这里只用于"还差什么/去哪采"规划）。 */
const RECIPES = {
  // 建筑
  campfire: { log: 2, cutgrass: 3 },
  firepit: { log: 2, rocks: 12 },
  chest: { boards: 3 },
  cookpot: { charcoal: 3, twigs: 6, rocks: 6 },
  sciencemachine: { goldnugget: 1, log: 4, rocks: 4 },
  researchlab2: { boards: 4, cutstone: 2, transistor: 2 },
  alchemyengine: { boards: 4, cutstone: 2, transistor: 2 },
  tent: { silk: 6, twigs: 4, rope: 3 },
  // 物品
  backpack: { cutgrass: 4, twigs: 4 },
  spear: { twigs: 2, flint: 1, rope: 1 },
  armorwood: { log: 8, rope: 2 },
  boards: { log: 4 },
  rope: { cutgrass: 3 },
  cutstone: { rocks: 3 },
  transistor: { goldnugget: 2, cutstone: 1 },
  torch: { cutgrass: 2, twigs: 2 },
  axe: { twigs: 1, flint: 1 },
  pickaxe: { twigs: 2, flint: 2 },
  flowerhat: { petals: 12 },
}

function recipeName(ctx) {
  const inst = ctx?.instance
  const args = inst?.skill_args || inst?.data?.skill_args || inst?.data || {}
  return String(args.recipe ?? args.prefab ?? inst?.data?.recipe ?? '')
}
function recipeOf(name) { return RECIPES[name] ?? null }
function isStructure(name) { return STRUCTURES.has(name) }
function needsTech(name) { return TECH_ITEMS.has(name) }
function actorPos(snapshot) {
  const a = snapshot?.actor
  if (a && typeof a.tileX === 'number' && typeof a.tileZ === 'number') return { x: a.tileX, z: a.tileZ }
  return null
}
function distTo(snapshot, p) {
  const a = actorPos(snapshot); if (!a || !p) return Infinity
  return Math.hypot(a.x - p.x, a.z - p.z)
}
/** 建造/科技制作要去的锚点（家 > 营地）。 */
function anchor(memory) {
  const h = memory?.home_anchor
  if (h && typeof h.x === 'number') return { x: h.x, z: h.z }
  const c = memory?.camp_site
  if (c && typeof c.x === 'number') return { x: c.x, z: c.z }
  return null
}
const ARRIVE_RADIUS = 4

function owned(snapshot, name) { return ownedCount(snapshot, name) }

export const craftOrBuild = {
  id: 'craft_or_build',
  name: '制作/建造（通用）',
  version: 1,

  steps: [
    // ① 材料
    {
      id: 'materials',
      title: '备齐配方材料',
      isDone(ctx) {
        const name = recipeName(ctx); const rec = recipeOf(name)
        if (!rec) return true
        return Object.keys(missingMaterials(ctx.snapshot, rec)).length === 0
      },
      nextAction(ctx) {
        const name = recipeName(ctx); const rec = recipeOf(name)
        const missing = rec ? missingMaterials(ctx.snapshot, rec) : {}
        const first = Object.keys(missing)[0]
        if (!first) return { done: true }
        return actionForMissing(ctx.snapshot, first, ctx.memory) ?? { blocked: `不知道怎么弄到 ${first}` }
      },
    },
    // ② 到工作地点（建筑到家/营地；科技物品到家[科学机器]；普通物品随处可做）
    {
      id: 'approach',
      title: '到达建造/制作地点',
      isDone(ctx) {
        const name = recipeName(ctx)
        if (!isStructure(name) && !needsTech(name)) return true
        const a = anchor(ctx.memory)
        if (!a) return false
        return distTo(ctx.snapshot, a) <= ARRIVE_RADIUS
      },
      nextAction(ctx) {
        const name = recipeName(ctx)
        if (!isStructure(name) && !needsTech(name)) return { done: true }
        const a = anchor(ctx.memory)
        if (!a) return { blocked: '还没有营地/家锚点（需先 establish_home 选址建家）' }
        if (needsTech(name) && !hasStructure(ctx.snapshot, ctx.memory, 'sciencemachine')) {
          return { blocked: '还没有科学机器，先在 Stage 2 建 sciencemachine 解锁科技' }
        }
        return { tool: 'move_to', args: { x: Math.round(a.x), z: Math.round(a.z) } }
      },
    },
    // ③ 执行制作/建造并核验真实结果
    {
      id: 'act',
      title: '制作/建造',
      isDone(ctx) {
        const name = recipeName(ctx)
        if (isStructure(name)) return hasStructure(ctx.snapshot, ctx.memory, name) || (name === 'alchemyengine' && hasStructure(ctx.snapshot, ctx.memory, 'researchlab2'))
        return owned(ctx.snapshot, name) >= 1
      },
      nextAction(ctx) {
        const name = recipeName(ctx); const rec = recipeOf(name)
        const missing = rec ? missingMaterials(ctx.snapshot, rec) : {}
        const first = Object.keys(missing)[0]
        if (first) return actionForMissing(ctx.snapshot, first, ctx.memory) ?? { blocked: `材料不足：${first}` }
        if (isStructure(name)) return { tool: 'build', args: { recipe: name } }
        return { tool: 'craft', args: { recipe: name } }
      },
    },
  ],

  completion(ctx) {
    const name = recipeName(ctx)
    if (!name) return false
    if (isStructure(name)) return hasStructure(ctx.snapshot, ctx.memory, name) || (name === 'alchemyengine' && hasStructure(ctx.snapshot, ctx.memory, 'researchlab2'))
    return owned(ctx.snapshot, name) >= 1
  },

  failure() { return false },
  retry_policy: { max_step_attempts: 4 },
  timeout_policy: { max_calls_per_step: 40 },
}

export function materialsFor(recipe) { return RECIPES[recipe] ?? null }
