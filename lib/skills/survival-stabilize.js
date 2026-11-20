// 技能 1：稳定开局生存（survival_stabilize）
//
// 目标：把 P0/P1 危险清掉 —— 有光、不挨饿、（能弄到就弄到）基础工具。
// 步骤：light → food → tools。每步 isDone 都从快照真实判定，动作交给 executor 走 dispatcher。
//
// 注意：
//   · 沃尔夫冈饥饿流失快，hungerThreshold() 用角色相关阈值（55 vs 40）。
//   · 绝不为集科技材料把角色饿死：food 步骤优先于 tools，且 completion 要求不挨饿。
//   · 遇到"必死威胁/危险区"（survivalLevel=revive/retreat）不在这里硬拼 —— 交给 Lua Reflex 抢占。

import { survivalLevel } from '../planner/survival-priority.js'
import {
  lightOk, lightAction, foodAction, toolAction, hungerThreshold, ownedCount, isNight,
} from './skill-utils.js'

function hungerPct(snapshot) {
  const p = snapshot?.player?.hunger?.percent
  return typeof p === 'number' ? p : 100
}

function healthPct(snapshot) {
  const p = snapshot?.player?.health?.percent
  return typeof p === 'number' ? p : 100
}

function bucket(snapshot, key) {
  const buckets = snapshot?.nearby?.buckets
  if (!buckets) return []
  if (Array.isArray(buckets)) return buckets.find((g) => g?.kind === key)?.items ?? []
  const list = buckets[key]
  return Array.isArray(list) ? list : Object.values(list ?? {})
}

function workableNearby(snapshot) {
  const hasTree = bucket(snapshot, 'resources').some((it) => it?.work_action === 'CHOP' || /tree|evergreen/i.test(String(it?.prefab ?? '')))
  const hasRock = bucket(snapshot, 'resources').some((it) => it?.work_action === 'MINE' || /^rock|boulder/i.test(String(it?.prefab ?? '')))
  return { hasTree, hasRock }
}

export const survivalStabilize = {
  id: 'survival_stabilize',
  name: '稳定生存',
  version: 1,

  preconditions(ctx) {
    const lv = survivalLevel(ctx.snapshot)
    if (lv.key === 'revive') return { ok: false, reason: '角色死亡/灵魂：等待复活' }
    if (lv.key === 'retreat') return { ok: false, reason: `${lv.label}：交给 Reflex 撤离/保命` }
    return { ok: true }
  },

  steps: [
    {
      id: 'light',
      title: '确保有可用光源（天黑必做）',
      isDone(ctx) { return lightOk(ctx.snapshot) },
      nextAction(ctx) {
        const act = lightAction(ctx.snapshot)
        return act ?? { done: true }
      },
    },
    {
      id: 'heal',
      title: '血低：先吃东西/找食物回血，别送',
      isDone(ctx) { return healthPct(ctx.snapshot) >= 45 },
      nextAction(ctx, inst) {
        // 有食物就吃（选择有效回血食物）；没有就按食物链去弄安全食物
        return foodAction(ctx.snapshot, { inst, now: ctx.now, need: 'health' }) ?? { done: true }
      },
    },
    {
      id: 'food',
      title: '吃饱（饥饿回到安全线以上）',
      isDone(ctx) { return hungerPct(ctx.snapshot) >= hungerThreshold(ctx.snapshot) },
      nextAction(ctx, inst) {
        return foodAction(ctx.snapshot, { inst, now: ctx.now, need: 'hunger' }) ?? { done: true }
      },
    },
    {
      id: 'tools',
      title: '弄到基础工具（斧头或镐）',
      isDone(ctx) {
        const s = ctx.snapshot
        if (ownedCount(s, 'axe') >= 1 || ownedCount(s, 'pickaxe') >= 1) return true
        const { hasTree, hasRock } = workableNearby(s)
        // 附近没有树也没有石头 → 无从下手，视为这一步不阻塞生存
        return !hasTree && !hasRock
      },
      nextAction(ctx) {
        const s = ctx.snapshot
        const { hasTree } = workableNearby(s)
        return toolAction(s, hasTree ? 'axe' : 'pickaxe') ?? { done: true }
      },
    },
  ],

  completion(ctx) {
    const s = ctx.snapshot
    if (survivalLevel(s).blocking) return false
    if (s?.actor?.isGhost || s?.dead) return false
    const threats = bucket(s, 'threats')
    const activeAttacker = threats.some((t) => t?.is_attacker || t?.is_targeting_you)
    if (activeAttacker) return false
    return lightOk(s) && hungerPct(s) >= hungerThreshold(s) && healthPct(s) >= 40
  },

  failure() { return false },
  retry_policy: { max_step_attempts: 3 },
  timeout_policy: { max_calls_per_step: 8 },
}
