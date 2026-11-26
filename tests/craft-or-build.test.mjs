// R8.3 Stage2~5 通用制作/建造技能 + 任务映射回归
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { craftOrBuild, materialsFor } from '../lib/skills/craft-or-build.js'
import { skillIds } from '../lib/skills/index.js'
import { stageTasksFor } from '../lib/planner/planner-core.js'
import { STAGES } from '../lib/planner/development-stages.js'

test('COB-1：craft_or_build 已注册', () => {
  assert.ok(skillIds().includes('craft_or_build'), '必须在技能注册表里')
})

test('COB-2：Stage2 的 build_* 任务改绑 craft_or_build 且带 skill_args.recipe', () => {
  const memory = { current_stage: 2, camp_site: { x: 0, z: 0 }, home_building_id: 'h', home_anchor: { x: 0, z: 0, radius: 10 }, known_buildings: [] }
  const snapshot = { nearby: { buckets: {} }, inventory: { items: [] }, player: { equipment: { slots: {} } } }
  const tasks = stageTasksFor(2, { snapshot, memory, sitePlan: null, now: () => 0 })
  const fire = tasks.find((t) => t.id === 'build_firepit')
  assert.ok(fire, 'stage2 应生成 build_firepit')
  assert.equal(fire.skill_id, 'craft_or_build', 'build_* 必须绑 craft_or_build（不再绑 establish_home）')
  assert.equal(fire.skill_args?.recipe, 'firepit')
})

test('COB-3：Stage3 gear_* 任务改绑 craft_or_build（不再是不存在的 crafting_basic）', () => {
  const memory = { current_stage: 3, camp_site: { x: 0, z: 0 } }
  const snapshot = { nearby: { buckets: {} }, inventory: { items: [] }, player: { equipment: { slots: {} } } }
  const tasks = stageTasksFor(3, { snapshot, memory, sitePlan: null, now: () => 0 })
  const gear = tasks.find((t) => t.id === 'gear_spear')
  assert.ok(gear, 'stage3 应生成 gear_spear')
  assert.equal(gear.skill_id, 'craft_or_build')
  assert.equal(gear.skill_args?.recipe, 'spear')
})

test('COB-4：技能结构完整（materials/approach/act + completion）', () => {
  assert.deepEqual(craftOrBuild.steps.map((s) => s.id), ['materials', 'approach', 'act'])
  assert.equal(typeof craftOrBuild.completion, 'function')
  assert.ok(materialsFor('firepit'), 'firepit 配方应可查')
  assert.ok(materialsFor('spear'), 'spear 配方应可查')
})

test('COB-5：Stage2 严格要求 firepit 且自动生成 12 石头与 2 木头采集依赖，造营火不完成阶段 2', () => {
  const stage2 = STAGES[2]
  assert.equal(stage2.id, 'basic_production')

  // 1. 只有科学机器和一次性营火 campfire 时，阶段 2 不能判定为完成
  const snapWithCampfire = {
    nearby: {
      buckets: {
        structures: [
          { prefab: 'sciencemachine', x: 0, z: 0 },
          { prefab: 'campfire', x: 2, z: 2 },
        ],
      },
    },
  }
  const mem = { known_buildings: [] }
  assert.equal(stage2.isComplete(snapWithCampfire, mem), false, 'campfire 不能作为阶段 2 的完成凭证')

  // 2. 只有科学机器和永久火坑 firepit 时，阶段 2 完成
  const snapWithFirepit = {
    nearby: {
      buckets: {
        structures: [
          { prefab: 'sciencemachine', x: 0, z: 0 },
          { prefab: 'firepit', x: 2, z: 2 },
        ],
      },
    },
  }
  assert.equal(stage2.isComplete(snapWithFirepit, mem), true, 'firepit + sciencemachine 完成阶段 2')

  // 3. 材料不足时，stageTasksFor 自动生成收集 12 石头与 2 木头依赖任务
  const emptySnapshot = {
    player: { inventory: { items: [{ prefab: 'rocks', count: 3 }] } },
    nearby: { buckets: { structures: [{ prefab: 'sciencemachine' }] } },
  }
  const memory = { current_stage: 2, camp_site: { x: 0, z: 0 }, home_building_id: 'h', home_anchor: { x: 0, z: 0, radius: 10 }, known_buildings: [] }
  const tasks = stageTasksFor(2, { snapshot: emptySnapshot, memory, sitePlan: null, now: 1000 })

  const rockTask = tasks.find((t) => t.id === 'gather_firepit_rocks')
  assert.ok(rockTask, '应生成收集石头任务')
  assert.equal(rockTask.skill_args.target_items.rocks, 12)
  assert.equal(rockTask.target.count, 12)

  const logTask = tasks.find((t) => t.id === 'gather_firepit_log')
  assert.ok(logTask, '应生成收集木头任务')
  assert.equal(logTask.skill_args.target_items.log, 2)

  const fireTask = tasks.find((t) => t.id === 'build_firepit')
  assert.ok(fireTask, '应生成 build_firepit')
  assert.deepEqual(fireTask.depends_on.sort(), ['gather_firepit_log', 'gather_firepit_rocks'].sort())
  assert.equal(fireTask.priority, 2, '有未满足依赖时优先级降为 2')
})

test('一级科技建筑（cookpot / researchlab2 / alchemyengine）在 approach 阶段未建科学机器时返回 blocked', () => {
  const approach = craftOrBuild.steps.find((s) => s.id === 'approach')
  const act = craftOrBuild.steps.find((s) => s.id === 'act')
  const memoryNoSci = { home_anchor: { x: 0, z: 0 }, known_buildings: [] }
  const snapNoSci = {
    actor: { tileX: 10, tileZ: 10 },
    nearby: { buckets: { structures: [] } },
    inventory: { items: [] },
  }

  for (const recipe of ['cookpot', 'researchlab2', 'alchemyengine']) {
    const res = approach.nextAction({
      snapshot: snapNoSci,
      memory: memoryNoSci,
      instance: { skill_args: { recipe } },
    })
    assert.ok(res.blocked, `${recipe} 缺少科学机器时必须返回 blocked`)
    assert.match(res.blocked, /sciencemachine|科学机器/)
  }

  // 有科学机器（原生名 researchlab）时不再 blocked，返回 move_to；建筑存在时通过 alias 归一判定完成
  const snapWithSci = {
    actor: { tileX: 10, tileZ: 10 },
    nearby: { buckets: { structures: [{ prefab: 'researchlab' }] } },
  }
  const moveRes = approach.nextAction({
    snapshot: snapWithSci,
    memory: memoryNoSci,
    instance: { skill_args: { recipe: 'cookpot' } },
  })
  assert.equal(moveRes.tool, 'move_to')

  const snapWithAlchemy = {
    nearby: { buckets: { structures: [{ prefab: 'researchlab2' }] } },
  }
  assert.equal(act.isDone({ snapshot: snapWithAlchemy, memory: memoryNoSci, instance: { skill_args: { recipe: 'alchemyengine' } } }), true)
  assert.equal(craftOrBuild.completion({ snapshot: snapWithAlchemy, memory: memoryNoSci, instance: { skill_args: { recipe: 'alchemyengine' } } }), true)
})

