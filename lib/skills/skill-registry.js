// 技能注册表（Skill Registry）：技能自注册、可独立测试。
//
// 技能定义契约：
//   { id, name, version, preconditions(), steps:[{id,title,isDone(ctx),nextAction(ctx,inst)}],
//     completion(), failure(), retry_policy, timeout_policy }
//
// 约束：技能**不重新实现**移动/采集/制作；步骤只返回 {tool,args} 交给 skill-executor 走 dispatcher。
// 所以这里注册的只是"决策 + 验证"，执行统一由 executor + 既有原子动作完成。

const SKILLS = new Map()

function assertFn(name, fn, { required = true } = {}) {
  if (fn === undefined && !required) return
  if (typeof fn !== 'function') throw new Error(`技能 ${name} 缺少函数`)
}

/** 注册一个技能定义；不合法直接抛错（早失败优于运行期诡异）。 */
export function registerSkill(def) {
  if (!def || typeof def !== 'object') throw new Error('技能定义必须是对象')
  if (typeof def.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(def.id)) throw new Error(`非法技能 id：${def.id}`)
  if (!Array.isArray(def.steps) || def.steps.length === 0) throw new Error(`技能 ${def.id} 至少要有一步`)
  if (SKILLS.has(def.id)) throw new Error(`技能已注册：${def.id}`)
  for (const step of def.steps) {
    if (typeof step?.id !== 'string' || step.id === '') throw new Error(`技能 ${def.id} 的步骤缺 id`)
    assertFn(`${def.id}.${step.id}.isDone`, step.isDone)
    assertFn(`${def.id}.${step.id}.nextAction`, step.nextAction)
  }
  assertFn(`${def.id}.preconditions`, def.preconditions, { required: false })
  assertFn(`${def.id}.completion`, def.completion, { required: false })
  const normalized = {
    version: 1,
    retry_policy: { max_step_attempts: 3 },
    timeout_policy: { max_calls_per_step: 8 },
    ...def,
  }
  SKILLS.set(def.id, normalized)
  return normalized
}

export function getSkill(id) {
  return SKILLS.get(String(id)) ?? null
}

export function hasSkill(id) {
  return SKILLS.has(String(id))
}

export function listSkills() {
  return [...SKILLS.values()]
}

export function skillIds() {
  return [...SKILLS.keys()]
}

/** 测试用：清空注册表 */
export function clearSkills() {
  SKILLS.clear()
}
