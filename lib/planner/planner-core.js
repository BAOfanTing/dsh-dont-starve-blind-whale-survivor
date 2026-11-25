// 规划编排（Planner Core）：把「长期阶段 → 中期任务看板 → 短期原子动作建议」串起来。
//
// 职责（Node，纯逻辑为主；唯一副作用是写世界记忆）：
//   1. 读当前世界的记忆（world-memory）。
//   2. 从快照刷新危险区 / 已知建筑。
//   3. 评估发展阶段（development-stages），已完成就推进并记里程碑（锁存）。
//   4. 用 base-site-planner 算营地候选；信息足够才落 camp_site。
//   5. 生存紧急（survival-priority P0/P1）时：普通任务暂停，只给生存目标（长期目标保留）。
//   6. 否则按当前阶段生成任务、合并进看板、用快照证据评审状态。
//   7. 建筑真实出现后，自动写 home_building_id / home_anchor（camp_site ≠ home）。
//   8. 给出"下一步该调哪个原子动作"的提示 + 给模型看的看板文本。
//
// 边界：本模块**不下发任何动作**，也不新建执行通道；提示里的动作仍由模型经 dispatcher 执行。
// 家园建造门槛 guardBuild() 供 tools.js 在 executeTool('build') 前调用，堵死"材料齐就地建机器"。

import { createWorldMemoryStore, worldKeyOfSnapshot, emptyMemory } from './world-memory.js'
import { countInInventory } from '../actions/state-query.js'
import {
  BOARD_SCHEMA, mergeBoard, evaluateBoard, pickNextTask, normalizeTask, ownedCount,
} from './task-board.js'
import { evaluateStage, getStage, STAGES, hasStructure, edibleCount, usablePortableLight, canCraftTorchFromMaterials } from './development-stages.js'
import { planBaseSite } from './base-site-planner.js'
import { survivalLevel } from './survival-priority.js'
import { TaskSkillOrchestrator } from './task-skill-orchestrator.js'
import { establishHomeTasks } from '../skills/establish-home-adapter.js'
import { expandGatherTasks, gatherAction } from '../skills/gather-resources-adapter.js'
import { missingMaterials } from '../skills/skill-utils.js'
import { matchStructure, normalizePrefab } from './prefab-utils.js'
import { recordExploration } from '../skills/explore-utils.js'
import { questGuideTasksFor } from './quest-guide-adapter.js'

export const CORE_RECIPE = { goldnugget: 1, log: 4, rocks: 4 }

/** 建筑配方材料（Node 侧仅用于"还差什么"的规划提示；权威扣减在 Lua craftrules）。 */
export const BUILD_RECIPES = {
  campfire: { log: 2, cutgrass: 3 },
  firepit: { log: 2, rocks: 12 },
  chest: { boards: 3 },
  cookpot: { charcoal: 3, twigs: 6, rocks: 6 },
  sciencemachine: { ...CORE_RECIPE },
  researchlab2: { boards: 4, cutstone: 2, transistor: 2 },
  tent: { silk: 6, twigs: 4, rope: 3 },
}

/** 需要"有家 + 在锚点范围内"才能建的基地建筑（营火/火坑属于应急，不在此列，允许野外临时用）。 */
export const HOME_STRUCTURES = new Set([
  'sciencemachine', 'researchlab', 'researchlab2', 'alchemyengine',
  'chest', 'treasurechest', 'cookpot', 'tent',
])

const NATIVE_ALIAS = {
  sciencemachine: 'researchlab',
  alchemyengine: 'researchlab2',
  chest: 'treasurechest',
}

function bucketItems(snapshot, key) {
  const buckets = snapshot?.nearby?.buckets
  if (!buckets) return []
  if (Array.isArray(buckets)) return buckets.find((g) => g?.kind === key)?.items ?? []
  const list = buckets[key]
  return Array.isArray(list) ? list : Object.values(list ?? {})
}

function itemPos(item) {
  const p = item?.position
  if (p && typeof p.x === 'number' && typeof p.z === 'number') return { x: p.x, z: p.z }
  if (typeof item?.x === 'number' && typeof item?.z === 'number') return { x: item.x, z: item.z }
  return null
}

const round1 = (v) => Math.round(v * 10) / 10

// ─────────────────────────── 记忆刷新 ───────────────────────────

export function refreshObservation(memory, snapshot) {
  // 危险区（快照近期）
  const zones = [];
  for (const z of [...(memory.danger_zones ?? []), ...(snapshot?.dangerZones ?? [])]) {
    if (typeof z?.x !== 'number' || typeof z?.z !== 'number') continue
    if (!zones.some((q) => Math.abs(q.x - z.x) < 1 && Math.abs(q.z - z.z) < 1)) {
      zones.push({ x: z.x, z: z.z, radius: Number(z.radius ?? 10), source: String(z.source ?? 'threat') })
    }
  }
  memory.danger_zones = zones.slice(-12)

  // 已知建筑（离开视野后靠它复用/避免重复建）
  const buildings = new Map((memory.known_buildings ?? []).map((b) => [b.id, b]))
  for (const it of bucketItems(snapshot, 'structures')) {
    const pos = itemPos(it)
    if (!pos || !it?.prefab) continue
    const id = `building:${it.prefab}@${round1(pos.x)},${round1(pos.z)}`
    buildings.set(id, { id, prefab: it.prefab, x: round1(pos.x), z: round1(pos.z) })
  }
  memory.known_buildings = [...buildings.values()].slice(-40)

  // 沿途开图与关键资源记录（32格远景雷达与迷雾探索）
  recordExploration(memory, snapshot)

  return memory
}

/** 若营地已定、还没家，且附近真的出现了科学机器 → 记录 home（camp_site ≠ home）。 */
export function recordHomeFromSnapshot(memory, snapshot) {
  if (!memory?.camp_site || memory.home_building_id) return { recorded: false }
  const { x, z } = memory.camp_site
  const radius = 8
  for (const it of bucketItems(snapshot, 'structures')) {
    if (!matchStructure(it, 'sciencemachine')) continue
    const pos = itemPos(it)
    if (!pos) continue
    if (Math.hypot(pos.x - x, pos.z - z) > radius) continue
    const id = `building:${it.prefab}@${round1(pos.x)},${round1(pos.z)}`
    memory.home_building_id = id
    memory.home_anchor = { prefab: it.prefab, x: round1(pos.x), z: round1(pos.z), radius: 10 }
    const buildings = new Map((memory.known_buildings ?? []).map((b) => [b.id, b]))
    buildings.set(id, { id, prefab: it.prefab, x: round1(pos.x), z: round1(pos.z) })
    memory.known_buildings = [...buildings.values()].slice(-40)
    return { recorded: true, id }
  }
  return { recorded: false }
}

// ─────────────────────────── 各阶段任务 ───────────────────────────

function nearHome(memory) {
  const h = memory?.home_anchor
  return h && typeof h.x === 'number' ? { x: h.x, z: h.z, radius: Number(h.radius ?? 10) } : null
}

/** 生成"在家范围内建某建筑"的任务 */
function buildNearHomeTask(memory, recipe, { id, priority, dependsOn = [], title, now = Date.now() }) {
  const near = nearHome(memory)
  return {
    id,
    title,
    stage: `stage_${memory.current_stage}`,
    priority,
    depends_on: dependsOn,
    skill_id: 'craft_or_build',
    skill_args: { recipe },
    target: { type: 'structure', prefab: recipe, recipe, near, placement: near ? { anchor_id: memory.home_building_id, radius: near.radius } : null },
    created_at: now,
  }
}

export function stageTasksFor(stageIndex, { snapshot, memory, sitePlan, now = Date.now() }) {
  switch (stageIndex) {
    case 0: {
      const tasks = []
      if (snapshot && edibleCount(snapshot) < 1) {
        const harvestableItems = bucketItems(snapshot, 'harvestables')
        const hasCarrot = harvestableItems.some((it) => /carrot/i.test(String(it?.prefab ?? '')))
        const targetFood = hasCarrot ? 'carrot' : 'berries'
        tasks.push({
          id: 'gather_food',
          title: `储备应急食物（${hasCarrot ? '胡萝卜' : '浆果'}）`,
          stage: 'stage_0',
          priority: 1,
          depends_on: [],
          skill_id: 'gather_resources',
          skill_args: { target_items: { [targetFood]: 1 } },
          target: { type: 'edible', count: 1 },
          created_at: now,
        })
      }
      if (snapshot && !usablePortableLight(snapshot) && !canCraftTorchFromMaterials(snapshot)) {
        tasks.push({
          id: 'gather_torch_materials',
          title: '收集火把材料（草与树枝）',
          stage: 'stage_0',
          priority: 2,
          depends_on: [],
          skill_id: 'gather_resources',
          skill_args: { target_items: { cutgrass: 2, twigs: 2 } },
          target: { type: 'inventory', prefab: 'cutgrass', count: 2 },
          created_at: now,
        })
      }
      if (snapshot && ownedCount(snapshot, 'axe') < 1 && ownedCount(snapshot, 'pickaxe') < 1) {
        tasks.push({
          id: 'gather_tool_materials',
          title: '制作基础工具（斧头/镐）',
          stage: 'stage_0',
          priority: 3,
          depends_on: [],
          skill_id: 'gather_resources',
          skill_args: { target_items: { twigs: 2, flint: 2 } },
          target: { type: 'have_tool', prefab: 'axe' },
          created_at: now,
        })
      }
      return tasks
    }
    case 1:
      return establishHomeTasks({ snapshot, memory, sitePlan, now })
    case 2: {
      const tasks = []
      if (!hasStructure(snapshot, memory, 'firepit')) {
        const firepitDeps = []
        const haveRocks = countInInventory(snapshot, 'rocks')
        const haveLogs = countInInventory(snapshot, 'log')
        if (haveRocks < 12) {
          tasks.push({
            id: 'gather_firepit_rocks',
            title: `收集石头（建石头火坑差 ${12 - haveRocks}，目标 12）`,
            stage: 'stage_2',
            priority: 1,
            depends_on: [],
            skill_id: 'gather_resources',
            skill_args: { target_items: { rocks: 12 } },
            target: { type: 'inventory', prefab: 'rocks', count: 12 },
            created_at: now,
          })
          firepitDeps.push('gather_firepit_rocks')
        }
        if (haveLogs < 2) {
          tasks.push({
            id: 'gather_firepit_log',
            title: `收集木头（建石头火坑差 ${2 - haveLogs}，目标 2）`,
            stage: 'stage_2',
            priority: 1,
            depends_on: [],
            skill_id: 'gather_resources',
            skill_args: { target_items: { log: 2 } },
            target: { type: 'inventory', prefab: 'log', count: 2 },
            created_at: now,
          })
          firepitDeps.push('gather_firepit_log')
        }
        tasks.push(buildNearHomeTask(memory, 'firepit', {
          id: 'build_firepit',
          priority: firepitDeps.length > 0 ? 2 : 1,
          dependsOn: firepitDeps,
          title: '在家范围内建永久火坑（firepit）',
          now,
        }))
      }
      if (!hasStructure(snapshot, memory, 'chest')) {
        tasks.push(buildNearHomeTask(memory, 'chest', { id: 'build_chest', priority: 3, title: '在家范围内建箱子存物资', now }))
      }
      return tasks
    }
    case 3: {
      const tasks = []
      const gear = [
        { prefab: 'backpack', priority: 1, title: '做背包（在科学机器旁 craft）' },
        { prefab: 'spear', priority: 2, title: '做长矛（在科学机器旁 craft）' },
        { prefab: 'armorwood', priority: 3, title: '做木甲（在科学机器旁 craft）' },
      ]
      for (const g of gear) {
        tasks.push({ id: `gear_${g.prefab}`, title: g.title, stage: 'stage_3', priority: g.priority, depends_on: [], skill_id: 'craft_or_build', skill_args: { recipe: g.prefab }, target: { type: 'inventory', prefab: g.prefab, count: 1 }, created_at: now })
      }
      return tasks
    }
    case 4: {
      const tasks = []
      if (!hasStructure(snapshot, memory, 'cookpot')) {
        tasks.push(buildNearHomeTask(memory, 'cookpot', { id: 'build_cookpot', priority: 1, title: '在家范围内建锅（烹饪）', now }))
      }
      return tasks
    }
    case 5: {
      const tasks = []
      if (!hasStructure(snapshot, memory, 'alchemyengine')) {
        tasks.push(buildNearHomeTask(memory, 'researchlab2', { id: 'build_alchemy', priority: 1, title: '在家范围内建炼金引擎', now }))
      }
      if (!hasStructure(snapshot, memory, 'tent')) {
        tasks.push(buildNearHomeTask(memory, 'tent', { id: 'build_tent', priority: 2, title: '在家范围内建帐篷', dependsOn: hasStructure(snapshot, memory, 'alchemyengine') ? [] : ['build_alchemy'], now }))
      }
      return tasks
    }
    default:
      return []
  }
}

// ─────────────────────────── 下一步提示 ───────────────────────────

function missingText(missing) {
  return Object.keys(missing).map((p) => `${p} ×${missing[p]}`).join('、')
}

export function nextHint(task, { snapshot, memory, sitePlan }) {
  if (!task) return ''
  const t = task.target ?? {}

  if (task.id === 'choose_camp_site') {
    if (!sitePlan?.sufficient_info) {
      return `先探索补足信息（${sitePlan?.explore_reason ?? '附近信息不足'}）：用 seek 朝树/石头/食物各走 10~20 格，别乱走，也别忘了回家方向`
    }
    return `营地候选已足够，准备前往 (${sitePlan.primary?.x},${sitePlan.primary?.z})`
  }
  if (t.type === 'move_to') {
    return `move_to x=${t.x} z=${t.z}（去营地 (${t.x},${t.z})，到位后确认是平地、附近无危险再动手）`
  }
  if (task.id.startsWith('gather_') && t.type === 'inventory') {
    return `去收集 ${t.prefab}（目标 ${t.count}）：${gatherAction(t.prefab)}`
  }
  if (t.type === 'structure') {
    const recipe = t.recipe ?? t.prefab
    const missing = missingMaterials(snapshot, BUILD_RECIPES[recipe] ?? {})
    if (Object.keys(missing).length > 0) {
      return `建 ${recipe} 还差材料：${missingText(missing)} —— 先收集，别在材料不齐时硬建`
    }
    if (task.id === 'build_first_structure') {
      const c = memory?.camp_site
      return `站在营地 (${c?.x},${c?.z}) 附近空地 build recipe=${recipe}（必须在营地半径内，远处的同名建筑不算完成）`
    }
    const h = memory?.home_anchor
    return `回营地/在家范围内 build recipe=${recipe}（锚点 (${h?.x},${h?.z}) 半径 ${h?.radius ?? 10} 内；不在范围内不算完成）`
  }
  if (t.type === 'inventory') {
    return `在科学机器旁 craft recipe=${t.prefab}（材料不够先补齐；做好的成品要在背包/装备栏里才算完成）`
  }
  if (t.type === 'quest_complete') {
    if (task.skill_id === 'craft_or_build' && task.skill_args?.recipe) {
      return `执行任务手册目标【${task.title}】：制作 ${task.skill_args.recipe}（材料齐全后 craft recipe=${task.skill_args.recipe}）`
    }
    if (task.skill_id === 'gather_resources') {
      return `执行任务手册目标【${task.title}】：收集所需材料`
    }
    return `执行任务手册目标【${task.title}】`
  }
  if (t.type === 'home') {
    return '核心建筑已真实出现，记录家园锚点（home_building_id）'
  }
  return task.title
}

// ─────────────────────────── 渲染 ───────────────────────────

export function renderPlannerSection(result) {
  if (!result) return ''
  const lines = []
  const stage = result.stage
  lines.push(`### 发展阶段：${stage.index} ${stage.title} —— ${stage.goal}`)
  if (result.survival?.blocking) {
    lines.push(`⚠ 生存优先：${result.survival.label}。普通任务暂停，长期目标保留，恢复后继续。`)
  }
  const site = result.sitePlan
  if (result.stageIndex >= 1 && site?.sufficient_info && site.primary) {
    const b = site.backup ? `；备选 (${site.backup.x},${site.backup.z})` : ''
    lines.push(`营地候选：主选 (${site.primary.x},${site.primary.z})${b}`)
  } else if (result.stageIndex >= 1 && site?.need_explore) {
    lines.push(`营地：信息不足，需要先探索（${site.explore_reason}）`)
  }
  const mem = result.memory
  if (mem?.home_building_id) {
    lines.push(`家：${mem.home_building_id} @ (${mem.home_anchor?.x},${mem.home_anchor?.z})`)
  }
  const tasks = result.board?.tasks ?? []
  if (tasks.length > 0) {
    lines.push('任务看板：')
    const ordered = [...tasks].sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)))
    const nextId = result.nextTask?.id
    for (const t of ordered) {
      const mark = t.id === nextId ? '▶ ' : '  '
      const prog = t.progress ? `(${t.progress.current}/${t.progress.required})` : ''
      const blocked = t.blocked_reason && t.status !== 'done' ? ` ⟵ ${t.blocked_reason}` : ''
      lines.push(`${mark}[P${t.priority}] ${t.id} · ${t.status} ${prog} ${t.title}${blocked}`)
    }
  }
  if (result.next) lines.push(`下一步：${result.next}`)
  return lines.join('\n')
}

// ─────────────────────────── 主流程 ───────────────────────────

export function createPlanner({ memoryStore, now = () => Date.now() } = {}) {
  const store = memoryStore ?? createWorldMemoryStore()

  function loadMemory(snapshot) {
    const wk = worldKeyOfSnapshot(snapshot)
    const mem = store.load(wk)
    // 保证结构完整
    return { wk, mem: mem ?? emptyMemory(wk) }
  }

  /**
   * 计算一次规划结果（并持久化记忆）。不执行任何游戏动作。
   */
  function plan(snapshot) {
    const { wk, mem } = loadMemory(snapshot)
    refreshObservation(mem, snapshot)

    const survival = survivalLevel(snapshot)

    // 阶段推进（锁存）
    const stageEval = evaluateStage(snapshot, mem)
    if (stageEval.currentIndex > mem.current_stage) {
      mem.current_stage = stageEval.currentIndex
      for (const c of stageEval.justCompleted) {
        if (!mem.completed_milestones.includes(`stage_${c.index}_${c.id}`)) {
          mem.completed_milestones.push(`stage_${c.index}_${c.id}`)
        }
      }
    }
    const stage = getStage(mem.current_stage)

    // 营地选址（**只在开局生存稳定、进入建立家园阶段之后**才落定；Stage0 不抢先在出生点定营地）
    const sitePlan = planBaseSite(snapshot, mem)
    if (!mem.camp_site && mem.current_stage >= 1 && sitePlan.sufficient_info && sitePlan.primary) {
      mem.camp_site = { ...sitePlan.primary }
      mem.backup_site = sitePlan.backup ? { ...sitePlan.backup } : null
      if (!mem.completed_milestones.includes('camp_site_selected')) mem.completed_milestones.push('camp_site_selected')
    }

    let board
    let next = ''
    let nextTask = null

    const isQuestGuideActive = Boolean(
      snapshot?.quest_guide?.installed &&
      (snapshot.quest_guide.tracked_task || (Array.isArray(snapshot.quest_guide.open_tasks) && snapshot.quest_guide.open_tasks.length > 0))
    )

    let base = mem.task_board && Array.isArray(mem.task_board.tasks) ? mem.task_board : { schema: BOARD_SCHEMA, goal: '', tasks: [] }
    if (isQuestGuideActive) {
      // 任务手册模式：清除残留的旧阶段 0-6 任务，看板完全由任务手册接管
      const cleanedTasks = (base.tasks || []).filter((t) => t.id.startsWith('qg_') || t.id.startsWith('gather_for_'))
      base = { ...base, tasks: cleanedTasks }
    }

    const desired = isQuestGuideActive
      ? questGuideTasksFor({ questGuide: snapshot.quest_guide, snapshot, memory: mem, now: now() })
      : stageTasksFor(mem.current_stage, { snapshot, memory: mem, sitePlan, now: now() })
    const goalText = isQuestGuideActive
      ? `任务手册自主追踪（${snapshot.quest_guide.tracked_task?.title || snapshot.quest_guide.open_tasks?.[0]?.title || '任务'}）`
      : stage.goal

    board = mergeBoard(base, desired, { goal: goalText, now: now(), snapshot, memory: mem })
    board = evaluateBoard(board, { snapshot, memory: mem, now: now() })

    // 建筑真实出现 → 记录家；然后重评看板（set_home 任务随之完成）
    if (!isQuestGuideActive) {
      const homeRec = recordHomeFromSnapshot(mem, snapshot)
      if (homeRec.recorded) {
        if (!mem.completed_milestones.includes('home_established')) mem.completed_milestones.push('home_established')
        board = evaluateBoard(board, { snapshot, memory: mem, now: now() })
      }
    }

    nextTask = pickNextTask(board)

    if (survival.blocking) {
      next = `先解决生存：${survival.label}。安全恢复后继续${isQuestGuideActive ? '任务手册任务' : '当前阶段任务'}。`
    } else {
      next = nextHint(nextTask, { snapshot, memory: mem, sitePlan })
      if (!nextTask && mem.current_stage === 0 && !isQuestGuideActive) {
        next = '先活下来：确保有光、有吃的、有基础工具（按上方生存目标做），稳定后才进入选址建家。'
      }
    }

    mem.task_board = board
    mem.current_goal = nextTask?.title ?? mem.current_goal ?? null
    mem.updatedAt = now()
    // 未绑定世界时不写盘到"具体世界"，避免把临时坐标冒认成某世界的记忆
    if (wk) store.save(mem)

    return {
      worldKey: wk,
      memory: mem,
      stage,
      stageIndex: mem.current_stage,
      isQuestGuideActive,
      survival,
      sitePlan,
      board,
      nextTask,
      next,
      primarySite: sitePlan?.primary ?? null,
      backupSite: sitePlan?.backup ?? null,
    }
  }

  /**
   * 家园建造门槛：在 executeTool('build') 之前调用。
   * 返回 null 表示允许；返回 {reason,message} 表示拒绝（不下发到游戏）。
   * 目的：堵死"材料齐就地在脚下建科学机器 / 科技建筑"，要求先选址→到场→建核心→设家→在锚点范围内扩建。
   */
  function guardBuild(recipe, snapshot) {
    const name = String(recipe ?? '')
    const native = NATIVE_ALIAS[name] ?? name
    const isHomeStructure = HOME_STRUCTURES.has(name) || HOME_STRUCTURES.has(native)
    if (!isHomeStructure) return null // 营火/火坑等应急建筑不拦

    const { mem } = loadMemory(snapshot)
    const stage = Number(mem.current_stage ?? 0)
    const a = snapshot?.actor
    const actorPos = a && typeof a.tileX === 'number' ? { x: a.tileX, z: a.tileZ } : null

    // 还没有家
    if (!mem.home_building_id) {
      // 阶段闸：还在开局生存阶段时，任何基地建筑都不许建（先活稳，再选址建家）
      if (stage < 1) {
        return {
          reason: 'not_ready_stage',
          message: `还在开局生存阶段：先确保有光、有吃的、有基础工具，稳定后才进入选址建家，现在不能建 ${name}（营地/家都还没有）。`,
        }
      }
      const isFirstCore = native === 'researchlab'
      if (isFirstCore) {
        if (!mem.camp_site || typeof mem.camp_site.x !== 'number') {
          return {
            reason: 'no_camp_site',
            message: `还没选营地：先勘察并选定营地（主选+备选），再前往，最后才建科学机器。不允许"材料够了就在脚下建"。`,
          }
        }
        if (actorPos) {
          const d = Math.hypot(actorPos.x - mem.camp_site.x, actorPos.z - mem.camp_site.z)
          if (d > 8) {
            return {
              reason: 'not_at_camp',
              message: `不在营地范围（营地 (${mem.camp_site.x},${mem.camp_site.z})，你现在约 ${d.toFixed(0)} 格）。先 move_to 到营地并确认平地/安全，再建科学机器。`,
            }
          }
        }
        return null
      }
      return {
        reason: 'no_home',
        message: `还没有家：先在营地建好第一座核心建筑（科学机器）并设置家，才能建 ${name}。`,
      }
    }

    // 已经有家：基地建筑必须在锚点半径内
    const h = mem.home_anchor
    if (h && actorPos && typeof h.x === 'number') {
      const d = Math.hypot(actorPos.x - h.x, actorPos.z - h.z)
      const radius = Number(h.radius ?? 10)
      if (d > radius + 0.5) {
        return {
          reason: 'out_of_home_range',
          message: `基地建筑必须在家的范围内：家在 (${h.x},${h.z}) 半径 ${radius} 格，你现在约 ${d.toFixed(0)} 格。先回营地再建 ${name}。`,
        }
      }
    }
    return null
  }

  function memoryFor(snapshot) {
    return loadMemory(snapshot).mem
  }

  return { plan, guardBuild, memoryFor, store }
}
