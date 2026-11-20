// 技能 2：建立家园（establish_home）—— 本阶段最重要、真正可执行的多步骤技能。
//
// 流程（任务书 §四 Skill2）：
//   1 检查已有家（有效就直接完成，不重复建）
//   2 勘察（信息不足才有目的地 seek，补资源/食物/空地信息）
//   3 选址（复用 base-site-planner，落 camp_site + backup_site）
//   4 前往营地（move_to，真实到达才算）
//   5 收集核心材料（复用 gather 动作；主选不可达自动切备选）
//   6 建造核心建筑（build 科学机器）
//   7 设家（真实建筑出现后记 home_building_id / home_anchor / camp_site）
//   8 验收（家存在 + 建筑在家附近）
//
// 技能只返回 {tool,args} 原子动作，执行由 skill-executor 走 dispatcher（不另造执行系统）；
// 每步完成由 isDone(快照) 判定（建造必须"看到建筑真实出现"，不只看 ok=true）。

import { hasStructure } from '../planner/development-stages.js'
import { planBaseSite } from '../planner/base-site-planner.js'
import { recordHomeFromSnapshot } from '../planner/planner-core.js'
import { missingMaterials, actionForMissing } from './skill-utils.js'
import { exploreFrontier } from './explore-utils.js'

/** 第一座核心建筑（解锁科技）的配方材料（与 Lua 原生 researchlab 一致：1 金 + 4 木 + 4 石） */
export const CORE_RECIPE = { goldnugget: 1, log: 4, rocks: 4 }

function actorPos(snapshot) {
  const a = snapshot?.actor
  if (a && typeof a.tileX === 'number' && typeof a.tileZ === 'number') return { x: a.tileX, z: a.tileZ }
  return null
}

function distTo(snapshot, point) {
  const p = actorPos(snapshot)
  if (!p || !point) return Infinity
  return Math.hypot(p.x - point.x, p.z - point.z)
}

const ARRIVE_RADIUS = 2

export const establishHome = {
  id: 'establish_home',
  name: '建立家园',
  version: 1,

  steps: [
    // ① 勘察 / 选址
    {
      id: 'survey_and_site',
      title: '勘察附近并选定营地（主选 + 备选）',
      isDone(ctx) {
        const mem = ctx.memory
        return Boolean(mem?.camp_site && typeof mem.camp_site.x === 'number') || Boolean(mem?.home_building_id)
      },
      nextAction(ctx) {
        const { snapshot, memory } = ctx
        const site = planBaseSite(snapshot, memory)
        if (site.sufficient_info && site.primary) {
          memory.camp_site = { x: site.primary.x, z: site.primary.z }
          memory.backup_site = site.backup ? { x: site.backup.x, z: site.backup.z } : null
          return { done: true }
        }
        const reason = String(site.explore_reason ?? '')
        const prefab = /食物|berry/i.test(reason) ? 'berrybush' : 'tree'
        return { tool: 'seek', args: { prefab } }
      },
    },

    // ② 前往营地（主选不可达自动切备选）
    {
      id: 'travel_to_camp',
      title: '前往营地',
      isDone(ctx) {
        const camp = ctx.memory?.camp_site
        if (!camp) return false
        return distTo(ctx.snapshot, camp) <= ARRIVE_RADIUS
      },
      nextAction(ctx, inst) {
        const { snapshot, memory } = ctx
        const tries = inst?.step_attempts?.travel_to_camp ?? 0
        // 主选一直走不到（一次被拒）且有备选 → 标记主选 blocked，切换到备选营地
        if (tries >= 1 && memory?.backup_site && !memory._backup_tried) {
          memory._backup_tried = true
          memory.camp_site = { x: memory.backup_site.x, z: memory.backup_site.z }
          memory.camp_site_blocked_primary = true
        }
        const camp = memory?.camp_site
        if (!camp) return { blocked: '还没有营地坐标（需要先完成选址）' }
        return { tool: 'move_to', args: { x: Math.round(camp.x), z: Math.round(camp.z) } }
      },
    },

    // ③ 收集核心材料
    {
      id: 'gather_materials',
      title: '收集核心材料（金块 / 木头 / 石头）',
      isDone(ctx) {
        return Object.keys(missingMaterials(ctx.snapshot, CORE_RECIPE)).length === 0
      },
      nextAction(ctx) {
        const missing = missingMaterials(ctx.snapshot, CORE_RECIPE)
        const first = Object.keys(missing)[0]
        if (!first) return { done: true }
        const act = actionForMissing(ctx.snapshot, first, ctx.memory)
        return act ?? { blocked: `不知道怎么弄到 ${first}` }
      },
    },

    // ④ 建造核心建筑（科学机器）
    {
      id: 'build_core',
      title: '在营地建第一座科学机器',
      isDone(ctx) {
        return hasStructure(ctx.snapshot, ctx.memory, 'sciencemachine')
      },
      nextAction(ctx) {
        const { snapshot, memory } = ctx
        // 站在营地半径内才建（guardBuild 也会拦，但这里提前给出明确动作）
        const camp = memory?.camp_site
        if (camp && distTo(snapshot, camp) > 8) {
          return { tool: 'move_to', args: { x: Math.round(camp.x), z: Math.round(camp.z) } }
        }
        const missing = missingMaterials(snapshot, CORE_RECIPE)
        if (Object.keys(missing).length > 0) {
          const first = Object.keys(missing)[0]
          return actionForMissing(snapshot, first, memory) ?? { blocked: `材料不足：${first}` }
        }
        return { tool: 'build', args: { recipe: 'sciencemachine' } }
      },
    },

    // ⑤ 设置家（真实建筑出现后登记锚点）
    {
      id: 'set_home',
      title: '把核心建筑坐标记为家',
      isDone(ctx) {
        return typeof ctx.memory?.home_building_id === 'string' && ctx.memory.home_building_id !== ''
      },
      nextAction(ctx) {
        const rec = recordHomeFromSnapshot(ctx.memory, ctx.snapshot)
        if (rec?.recorded) return { done: true }
        if (hasStructure(ctx.snapshot, ctx.memory, 'sciencemachine')) {
          return { done: true } // 已有建筑但观测帧未带坐标：等下一帧观测再登记
        }
        return { blocked: '核心建筑还没真实出现，不能设家（先完成建造）' }
      },
    },
  ],

  completion(ctx) {
    const mem = ctx.memory
    if (!(typeof mem?.home_building_id === 'string' && mem.home_building_id !== '')) return false
    // 家必须真实存在（视野或记忆里能确认）
    return hasStructure(ctx.snapshot, mem, 'sciencemachine')
  },

  failure() { return false },
  retry_policy: { max_step_attempts: 3 },
  timeout_policy: { max_calls_per_step: 30 },
}

export { establishHomeTasks } from './establish-home-adapter.js'
