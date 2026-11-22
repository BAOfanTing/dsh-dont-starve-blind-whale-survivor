// R8.3 Stage2~5 通用制作/建造技能 + 任务映射回归
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { craftOrBuild, materialsFor } from '../lib/skills/craft-or-build.js'
import { skillIds } from '../lib/skills/index.js'
import { stageTasksFor } from '../lib/planner/planner-core.js'

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
