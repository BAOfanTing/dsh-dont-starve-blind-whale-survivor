// 新手任务手册适配器（Quest Guide Adapter）
//
// 职责：
//   1. 接收来自快照的运行时任务手册数据（snapshot.quest_guide）；
//   2. 优先消费玩家手动追踪的任务（tracked_task），或当前季节开放任务（open_tasks[0]）；
//   3. 自动根据任务所需材料（mats）与完成条件（auto），拆解为 TaskBoard 任务链；
//   4. 材料缺失时前置触发 gather_resources，材料齐全后调度 craft_or_build 或对应技能；
//   5. 纯函数设计，不写盘、不改游戏环境。

import { countInInventory } from '../actions/state-query.js'
import { ownedCount } from './task-board.js'
import { hasStructure } from './development-stages.js'
import { ALL_KNOWN_RECIPES, BUILD_RECIPES } from '../game-data/recipes-and-foods.js'

export const KNOWN_STRUCTURE_RECIPES = {
  firepit: BUILD_RECIPES.firepit,
  sciencemachine: BUILD_RECIPES.sciencemachine,
}

export const KNOWN_RECIPES = ALL_KNOWN_RECIPES

const PREFAB_NAMES = {
  twigs: '树枝',
  cutgrass: '采下的草',
  flint: '燧石',
  rocks: '石头',
  log: '木头',
  goldnugget: '金块',
  boards: '木板',
  cutstone: '石砖',
  rope: '绳子',
  charcoal: '木炭',
  pigskin: '猪皮',
}

/** 检查任务手册中的某个任务在当前快照中是否已被标记完成 */
export function isQuestCompleted(snapshot, questId) {
  if (!questId) return false
  const qg = snapshot?.quest_guide
  if (!qg) return false
  if (qg.done_tasks && qg.done_tasks[questId]) return true
  if (qg.tracked_task && qg.tracked_task.id === questId && qg.tracked_task.done) return true
  return false
}

/**
 * 将任务手册的当前焦点任务转换为一组 TaskBoard 任务。
 * @param {object} param0
 * @returns {Array<object>} Task 列表
 */
export function questGuideTasksFor({ questGuide, snapshot, memory, now = () => Date.now() }) {
  if (!questGuide || !questGuide.installed) return []

  const time = typeof now === 'function' ? now() : Number(now || Date.now())

  // 1. 挑选焦点任务：优先玩家追踪项（未完成），其次首个未完成开放任务
  let targetQuest = null
  if (questGuide.tracked_task && !questGuide.tracked_task.done && !isQuestCompleted(snapshot, questGuide.tracked_task.id)) {
    targetQuest = questGuide.tracked_task
  } else if (Array.isArray(questGuide.open_tasks)) {
    for (const q of questGuide.open_tasks) {
      if (!isQuestCompleted(snapshot, q.id)) {
        targetQuest = q
        break
      }
    }
  }

  if (!targetQuest) return []

  const questId = targetQuest.id
  const mainTaskId = `qg_${questId}`
  const tasks = []

  // 分析 auto 条件组：auto[groupIndex][clauseIndex]
  // 结构：auto = [ [ { k: 'craft', p: ['torch'], n: 1 } ], ... ]
  const autoGroups = Array.isArray(targetQuest.auto) ? targetQuest.auto : []

  // 收集所需材料字典：prefab -> { name, needed }
  const neededItems = new Map()

  // 1) 从 mats 中读取显式材料列表
  if (Array.isArray(targetQuest.mats)) {
    for (const mat of targetQuest.mats) {
      if (!mat) continue
      const prefab = String(mat.icon || mat.name || '').trim()
      if (!prefab) continue
      const needed = Number(mat.n || 1)
      const existing = neededItems.get(prefab)
      if (!existing || existing.needed < needed) {
        neededItems.set(prefab, { name: mat.name || prefab, needed })
      }
    }
  }

  // 2) 分析 auto 中的 get 条件，若 mats 未包含则补充
  for (const group of autoGroups) {
    for (const clause of group || []) {
      if (clause && clause.k === 'get' && Array.isArray(clause.p)) {
        const prefab = clause.p[0]
        if (prefab) {
          const needed = Number(clause.n || 1)
          const existing = neededItems.get(prefab)
          if (!existing || existing.needed < needed) {
            neededItems.set(prefab, { name: prefab, needed })
          }
        }
      }
    }
  }

  // 3) 查找是否有尚未完成的 craft 条件
  let pendingCraftClause = null
  for (const group of autoGroups) {
    for (const clause of group || []) {
      if (clause && clause.k === 'craft') {
        const prefabs = Array.isArray(clause.p) ? clause.p : [clause.p]
        // 优先选择永久火坑 firepit
        const chosen = prefabs.includes('firepit') ? 'firepit' : prefabs[0]

        // 检查身上是否已有物品，或地上/记忆中是否已有该建筑
        let alreadyHave = false
        if (KNOWN_STRUCTURE_RECIPES[chosen] || ['campfire', 'firepit', 'chest', 'cookpot', 'sciencemachine', 'researchlab2', 'tent'].includes(chosen)) {
          alreadyHave = hasStructure(snapshot, memory, chosen)
        } else {
          alreadyHave = prefabs.some((p) => ownedCount(snapshot, p) >= (clause.n || 1))
        }

        if (!alreadyHave) {
          pendingCraftClause = {
            recipe: chosen,
            prefabs,
            count: Number(clause.n || 1),
          }
          break
        }
      }
    }
    if (pendingCraftClause) break
  }

  // 4) 若有待制作目标，补充其配方材料（如 pickaxe 补齐 2 燧石 2 树枝；firepit 补齐 12 石头 2 木头）
  if (pendingCraftClause) {
    // 如果选项包含 firepit 与 campfire，移除仅营火所需的草料，防止无谓卡死
    if (pendingCraftClause.prefabs.includes('firepit') && pendingCraftClause.prefabs.includes('campfire')) {
      neededItems.delete('cutgrass')
    }
    const recipe = pendingCraftClause.recipe
    const recipeMats = KNOWN_RECIPES[recipe] || KNOWN_STRUCTURE_RECIPES[recipe]
    if (recipeMats) {
      for (const [matPrefab, matNeeded] of Object.entries(recipeMats)) {
        const totalNeeded = matNeeded * pendingCraftClause.count
        const existing = neededItems.get(matPrefab)
        if (!existing || existing.needed < totalNeeded) {
          neededItems.set(matPrefab, { name: PREFAB_NAMES[matPrefab] || matPrefab, needed: totalNeeded })
        }
      }
    }
  }

  // 计算材料缺失情况
  const missingMats = []
  for (const [prefab, info] of neededItems.entries()) {
    const have = countInInventory(snapshot, prefab)
    if (have < info.needed) {
      missingMats.push({
        prefab,
        name: info.name,
        count: info.needed - have,
        totalNeeded: info.needed,
      })
    }
  }

  const matDepends = []

  // 为缺失材料生成采集前置任务
  for (const m of missingMats) {
    const gatherTaskId = `gather_for_${questId}_${m.prefab}`
    matDepends.push(gatherTaskId)
    tasks.push({
      id: gatherTaskId,
      title: `收集${m.name}（${targetQuest.title} 还需 ${m.count} 个）`,
      stage: targetQuest.season || 'survival',
      priority: 1,
      depends_on: [],
      skill_id: 'gather_resources',
      skill_args: { target_items: { [m.prefab]: m.totalNeeded } },
      target: { type: 'inventory', prefab: m.prefab, count: m.totalNeeded },
      created_at: time,
    })
  }

  if (pendingCraftClause) {
    // 制作类任务（如制作火炬、斧头、镐等）
    tasks.push({
      id: mainTaskId,
      title: targetQuest.title,
      stage: targetQuest.season || 'survival',
      priority: matDepends.length > 0 ? 2 : 1,
      depends_on: matDepends,
      skill_id: 'craft_or_build',
      skill_args: { recipe: pendingCraftClause.recipe, count: pendingCraftClause.count },
      target: {
        type: 'quest_complete',
        quest_id: questId,
        fallback_prefab: pendingCraftClause.recipe,
        fallback_type: 'inventory',
        count: pendingCraftClause.count,
      },
      created_at: time,
    })
  } else {
    // 收集类或综合类任务（如收集材料备战科技）
    const primaryItems = {}
    for (const [p, info] of neededItems.entries()) {
      primaryItems[p] = info.needed
    }

    tasks.push({
      id: mainTaskId,
      title: targetQuest.title,
      stage: targetQuest.season || 'survival',
      priority: matDepends.length > 0 ? 2 : 1,
      depends_on: matDepends,
      skill_id: 'gather_resources',
      skill_args: { target_items: primaryItems },
      target: {
        type: 'quest_complete',
        quest_id: questId,
      },
      created_at: time,
    })
  }

  return tasks
}
