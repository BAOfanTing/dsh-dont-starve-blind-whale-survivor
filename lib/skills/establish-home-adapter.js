// 技能任务适配器：建立家园（Establish Home）
//
// 职责：
//   1. 承接看板 Stage 1 规划，将建家流程展开为看板任务 DAG：
//      勘察选址 → 前往营地 → 补核心材料 → 建第一座核心建筑（科学机器）→ 设置家
//   2. 生成的每个任务明确绑定 skill_id: 'establish_home'，使看板任务直接映射至 establishHome 复合技能；
//   3. 具体执行状态机由 establish-home.js 承载。

import { expandGatherTasks } from './gather-resources.js'
import { CORE_RECIPE as SHARED_CORE_RECIPE } from '../game-data/recipes-and-foods.js'

/** 第一座核心建筑（解锁科技）的配方材料（引自唯一数据源 recipes-and-foods.js） */
export const CORE_RECIPE = SHARED_CORE_RECIPE

/**
 * @param {{snapshot:object, memory:object, sitePlan:object, now?:number}} ctx
 * @returns {Array} 任务数组（交给 mergeBoard）
 */
export function establishHomeTasks({ snapshot, memory, now = Date.now() }) {
  const tasks = []

  // ① 选址（始终保留；camp_site 一旦由 planner-core 依据信息是否足够写入即算完成）
  tasks.push({
    id: 'choose_camp_site',
    title: '勘察附近并选定营地（主选 + 备选）',
    stage: 'establish_home',
    priority: 1,
    depends_on: [],
    skill_id: 'establish_home',
    target: { type: 'camp_site' },
    search_budget: { max_attempts: 8, max_distance_tiles: 40 },
    created_at: now,
  })

  // 选址还没定：只留下"勘察选址"任务；下一步由 planner-core 依据信息是否足够给出"探索"或"选定"
  if (!memory?.camp_site) {
    return tasks
  }

  const { x, z } = memory.camp_site

  // ② 前往营地（真实移动，到达半径 2）
  tasks.push({
    id: 'travel_to_camp',
    title: `前往营地 (${x},${z})`,
    stage: 'establish_home',
    priority: 1,
    depends_on: ['choose_camp_site'],
    skill_id: 'establish_home',
    target: { type: 'move_to', x, z, arrival_radius: 2 },
    created_at: now,
  })

  // ③ 核心材料不足 → 收集任务（可在前往途中/到达后做）
  const { tasks: gatherTasks, missing } = expandGatherTasks(snapshot, CORE_RECIPE, {
    stage: 'establish_home',
    priorityBase: 2,
    dependsOn: ['travel_to_camp'],
    now,
  })
  tasks.push(...gatherTasks)
  const gatherIds = gatherTasks.map((t) => t.id)

  // ④ 建第一座核心建筑（在营地半径内，远一点的同名建筑不算）
  tasks.push({
    id: 'build_first_structure',
    title: `在营地建第一座科学机器（解锁科技）`,
    stage: 'establish_home',
    priority: 1,
    depends_on: ['travel_to_camp', ...gatherIds],
    skill_id: 'establish_home',
    target: {
      type: 'structure',
      prefab: 'sciencemachine',
      near: { x, z, radius: 8 },
      placement: { anchor_id: null, radius: 8 }, // 首个核心建筑无锚点，用营地坐标约束
    },
    created_at: now,
  })

  // ⑤ 建筑真实存在后 → 设置家（planner-core 用观测到的建筑坐标写 home_building_id）
  tasks.push({
    id: 'set_home',
    title: '把核心建筑坐标记为家（home_building_id）',
    stage: 'establish_home',
    priority: 1,
    depends_on: ['build_first_structure'],
    skill_id: 'establish_home',
    target: { type: 'home' },
    created_at: now,
  })

  return tasks
}

/** 备选位置下的完整任务（主选不可达时切换）— 返回一个新的 move_to 目标，用于提示 */
export function travelToBackupTask(memory, now = Date.now()) {
  const b = memory?.backup_site
  if (!b) return null
  return {
    id: 'travel_to_backup',
    title: `改前往备选营地 (${b.x},${b.z})`,
    stage: 'establish_home',
    priority: 2,
    depends_on: [],
    skill_id: 'establish_home',
    target: { type: 'move_to', x: b.x, z: b.z, arrival_radius: 2 },
    created_at: now,
  }
}
