// 生存优先级（Survival Priority）：把"现在能不能推进普通长远任务"从快照里判出来。
//
// 与 plan.js 的分工：plan.js 给"当前最该做的一件事 + 下一步"（偏生存与原子动作）；
// 本模块只回答一个更粗的问题：**现在是否被 P0/P1 紧急事件占着**。
//   · 是 → 规划层只显示生存目标，暂不推进家园/科技普通任务（但不丢长期目标）。
//   · 否 → 允许 development-stages / task-board 推进当前阶段任务。
//
// 级别（数字越小越紧急，与任务书 §八一致）：
//   P0 真实生命危险（被攻击/残血/黑夜无光/死亡）
//   P1 紧急生存（临界饥饿/低血/越温）
//   P2 当前重点长期任务
//   P3 普通资源工作
//   P4 低优先探索

import { countInInventory, inventoryItems } from '../actions/state-query.js'

export const P0 = 0, P1 = 1, P2 = 2, P3 = 3, P4 = 4

const LIGHTS = new Set(['torch', 'lantern', 'minerhat'])

const pct = (stat) => (typeof stat?.percent === 'number' ? stat.percent : null)

function nearestThreat(snapshot, within) {
  const buckets = snapshot?.nearby?.buckets
  if (!buckets) return null
  const list = Array.isArray(buckets)
    ? (buckets.find((g) => g?.kind === 'threats')?.items ?? [])
    : (buckets.threats ?? [])
  let best = null
  for (const it of list) {
    if (typeof it?.distance === 'number' && it.distance <= within) {
      if (!best || it.distance < best.distance) best = it
    }
  }
  return best
}

function hasPortableLight(snapshot) {
  for (const it of inventoryItems(snapshot)) {
    if (LIGHTS.has(String(it?.prefab ?? '')) && (typeof it.percent !== 'number' || it.percent > 0)) return true
  }
  const hands = snapshot?.player?.equipment?.slots?.hands
  const hp = typeof hands === 'string' ? hands : hands?.prefab
  return Boolean(hp && LIGHTS.has(hp))
}

function inDangerZone(snapshot) {
  const x = snapshot?.actor?.tileX
  const z = snapshot?.actor?.tileZ
  if (typeof x !== 'number' || typeof z !== 'number') return false
  for (const zone of snapshot?.dangerZones ?? []) {
    if (typeof zone?.x !== 'number' || typeof zone?.z !== 'number') continue
    if (Math.hypot(x - zone.x, z - zone.z) <= Number(zone.radius ?? 10)) return true
  }
  return false
}

/**
 * 判定当前生存级别。
 * @returns {{level:number, key:string, label:string, blocking:boolean}} blocking=true 表示 P0/P1，普通任务让位。
 */
export function survivalLevel(snapshot) {
  const actor = snapshot?.actor
  if (!actor || actor.valid === false || actor.alive === false || actor.isGhost === true) {
    return { level: P0, key: 'revive', label: '角色死亡/灵魂，先等复活', blocking: true }
  }
  const health = pct(snapshot?.player?.health) ?? 100
  const hunger = pct(snapshot?.player?.hunger) ?? 100
  const sanity = pct(snapshot?.player?.sanity) ?? 100
  const phase = snapshot?.world?.phase
  const isWolfgang = actor.prefab === 'wolfgang'

  const threat = nearestThreat(snapshot, 6)
  if (threat && (health < 60 || (sanity < 20 && /terrorbeak|nightmare|crawling/i.test(String(threat.prefab ?? ''))))) {
    return { level: P0, key: 'retreat', label: `威胁贴脸且状态差（${threat.label ?? threat.prefab}）`, blocking: true }
  }
  if (inDangerZone(snapshot)) {
    return { level: P0, key: 'retreat', label: '处于已知危险区', blocking: true }
  }
  if (phase === 'night' && !hasPortableLight(snapshot) && snapshot?.player?.in_light !== true) {
    return { level: P0, key: 'dark', label: '天黑没光源', blocking: true }
  }
  if (hunger < (isWolfgang ? 55 : 40)) {
    return { level: P1, key: 'hungry', label: `饥饿 ${Math.round(hunger)}%`, blocking: true }
  }
  if (health < 45) {
    return { level: P1, key: 'low_health', label: `生命 ${Math.round(health)}%`, blocking: true }
  }
  if (sanity < 45) {
    return { level: P2, key: 'low_sanity', label: `理智 ${Math.round(sanity)}%`, blocking: false }
  }
  return { level: P3, key: 'stable', label: '状态稳定', blocking: false }
}

/** 是否允许推进家园/科技等普通长远任务（没被 P0/P1 占着即可）。 */
export function canRunDevelopment(snapshot) {
  return survivalLevel(snapshot).blocking === false
}
