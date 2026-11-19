// 技能总装配：注册全部内置技能。新增技能只在这里登记一行，不改 Planner。
import { registerSkill, listSkills } from './skill-registry.js'
import { survivalStabilize } from './survival-stabilize.js'
import { establishHome } from './establish-home.js'
import { gatherResources } from './gather-resources.js'

let registered = false

/** 幂等注册（重复 import 不会重复注册）。 */
export function ensureSkillsRegistered() {
  if (registered) return
  registered = true
  for (const skill of [survivalStabilize, establishHome, gatherResources]) {
    try { registerSkill(skill) } catch (e) {
      // 已注册（热重载）时忽略
      if (!/已注册/.test(String(e?.message ?? e))) throw e
    }
  }
}

ensureSkillsRegistered()

export { listSkills }
export { getSkill, hasSkill, skillIds, registerSkill } from './skill-registry.js'
export { SkillExecutor, runSkillOnce } from './skill-executor.js'
