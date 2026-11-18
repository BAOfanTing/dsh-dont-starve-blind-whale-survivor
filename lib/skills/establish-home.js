// 技能：建立家园（Establish Home）
//
// 把"建家"展开成一串有依赖的任务：
//   勘察选址 → 前往营地 → 补核心材料 → 建第一座核心建筑（科学机器）→ 设置家
//
// 只在**选址坐标已确定**后才生成"前往/建造/设家"的任务；
// 选址本身由 planner-core 用 base-site-planner 计算，信息不足时本技能只保留"勘察选址"任务并让下一步去探索。
//
// 技能不直接下动作：这些任务经 task-board 评审后，由 planner-core 给出"下一步该调哪个原子动作"的提示。

import { expandGatherTasks } from './gather-resources.js'

/** 第一座核心建筑（解锁科技）的配方材料（与 Lua 原生 researchlab 一致：1 金 + 4 木 + 4 石） */
export const CORE_RECIPE = { goldnugget: 1, log: 4, rocks: 4 }

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
    target: { type: 'move_to', x: b.x, z: b.z, arrival_radius: 2 },
    created_at: now,
  }
}
