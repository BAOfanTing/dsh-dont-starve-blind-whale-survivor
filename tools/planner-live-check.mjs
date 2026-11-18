// 实盘只读检查：读取游戏当前写的 whale_state.json，用**新版规划器**（lib/planner/*）跑一遍，
// 打印发展阶段 / 生存优先级 / 营地候选 / 任务看板 / 下一步，以及家园建造门槛对当前真实状态的判定。
//
// 只读：不写命令、不动游戏、不碰插件记忆（用临时目录的记忆库）。用来在"插件进程还没热更新"时
// 验证新规划逻辑在真实世界数据上的行为。用法：node tools/planner-live-check.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GameBridge } from '../lib/bridge.js'
import { normalizeState } from '../lib/state/snapshot.js'
import { createPlanner } from '../lib/planner/planner-core.js'
import { createWorldMemoryStore } from '../lib/planner/world-memory.js'
import { renderPlannerSection } from '../lib/planner/planner-core.js'
import { executeTool } from '../lib/tools.js'

async function main() {
  const bridge = new GameBridge({ log: () => {}, enableHttp: false })
  const st = bridge.readState()
  if (!st || !st.json) {
    console.log('NO_STATE: 找不到 whale_state.json（游戏没进世界？）')
    return
  }
  const snapshot = normalizeState(st.json, { ageMs: st.ageMs ?? 0, path: st.path })
  console.log(`状态文件：${st.path}（${Math.round((st.ageMs ?? 0) / 1000)} 秒前）`)
  console.log(`世界：${snapshot.identity?.worldKey ?? '?'}  第${snapshot.world?.day}天 ${snapshot.world?.phase}  角色 ${snapshot.actor?.prefab}  位置 (${snapshot.actor?.tileX},${snapshot.actor?.tileZ})`)

  const dir = mkdtempSync(join(tmpdir(), 'live-planner-'))
  try {
    const planner = createPlanner({ memoryStore: createWorldMemoryStore({ dir }) })
    const r = planner.plan(snapshot)
    console.log('\n================ 新规划器输出（真实数据） ================')
    console.log(renderPlannerSection(r))
    console.log('\n--- 结构 ---')
    console.log('stageIndex =', r.stageIndex, '/ survival =', JSON.stringify(r.survival))
    console.log('sitePlan.sufficient_info =', r.sitePlan?.sufficient_info, ' primary =', JSON.stringify(r.sitePlan?.primary), ' need_explore =', r.sitePlan?.need_explore)
    console.log('board tasks =')
    for (const t of r.board?.tasks ?? []) console.log(`   [P${t.priority}] ${t.id} ${t.status} (${t.progress?.current}/${t.progress?.required}) ${t.blocked_reason ?? ''}`)
    console.log('nextTask =', r.nextTask?.id ?? null)
    console.log('camp_site =', JSON.stringify(r.memory.camp_site), ' home =', r.memory.home_building_id)

    console.log('\n--- 家园建造门槛 guardBuild（真实状态） ---')
    for (const recipe of ['sciencemachine', 'chest', 'cookpot', 'campfire']) {
      const g = planner.guardBuild(recipe, snapshot)
      console.log(`   build ${recipe}:`, g ? `拒绝(${g.reason}) — ${g.message}` : '放行')
    }

    // 直接用**新代码**走 executeTool('get_state')，读真实游戏状态，展示"重启 DSH 后模型会看到的"效果
    const ctx = {
      bridge,
      planner,
      notes: { read: () => '', write: () => {} },
      guides: {},
      extraInstructions: '',
    }
    const text = await executeTool('get_state', {}, ctx)
    console.log('\n================ 新版 get_state 实际输出（真实游戏状态） ================')
    console.log(text)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main()