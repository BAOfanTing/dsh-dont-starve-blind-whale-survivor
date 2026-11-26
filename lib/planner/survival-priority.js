// 生存优先级（Survival Priority）：把"现在能不能推进普通长远任务"从快照里判出来。
//
// 与 plan.js 的分工：plan.js 给"当前最该做的一件事 + 下一步"（偏生存与原子动作）；
// 本模块只回答一个更粗的问题：**现在是否被 P0/P1 紧急事件占着**。
//   · 是 → 规划层只显示生存目标，暂不推进家园/科技普通任务（但不丢长期目标）。
//   · 否 → 允许 development-stages / task-board 推进当前阶段任务。
//
// 级别（数字越小越紧急）：
//   P0 真实生命危险（被攻击/残血/黑夜无光/死亡）
//   P1 紧急生存（临界饥饿/低血/越温）
//   P2 当前重点长期任务
//   P3 普通资源工作
//   P4 低优先探索

import { countInInventory, inventoryItems } from '../actions/state-query.js'

export const P0 = 0, P1 = 1, P2 = 2, P3 = 3, P4 = 4

const LIGHTS = new Set(['torch', 'lantern', 'minerhat'])

const pct = (stat) => {
  if (typeof stat?.percent === 'number') return stat.percent
  if (typeof stat?.current === 'number' && typeof stat?.max === 'number' && stat.max > 0) {
    return (stat.current / stat.max) * 100
  }
  return null
}

export function nearestThreat(snapshot, within) {
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

/** 读装备槽条目（含 percent），slots / worn 两种形状都要能吃。 */
function equipmentBlock(snapshot, slot) {
  const eq = snapshot?.player?.equipment
  if (!eq || typeof eq !== 'object') return null
  const slots = eq.slots
  if (slots && typeof slots === 'object' && !Array.isArray(slots)) {
    const h = slots[slot] ?? slots[String(slot).toUpperCase()]
    if (typeof h === 'string' && h !== '') return { prefab: h }
    if (h && typeof h === 'object') return h
  }
  const worn = eq.worn
  if (Array.isArray(worn)) {
    for (const entry of worn) {
      const key = String(entry?.key ?? entry?.slot_key ?? entry?.slot ?? '').toLowerCase()
      if (key !== slot) continue
      const it = entry?.item ?? entry
      if (typeof it === 'string' && it !== '') return { prefab: it }
      if (it && typeof it === 'object') return it
    }
  }
  if (worn && typeof worn === 'object' && !Array.isArray(worn)) {
    const h = worn[slot] ?? worn[String(slot).toUpperCase()]
    if (typeof h === 'string' && h !== '') return { prefab: h }
    if (h && typeof h === 'object') return h
  }
  return null
}

function usableLightBlock(block) {
  if (!block) return false
  const prefab = String(block.prefab ?? '')
  if (!LIGHTS.has(prefab)) return false
  return typeof block.percent !== 'number' || block.percent > 0
}

/**
 * 玩家此刻是否**真的**被可用便携光源照亮（手上/头上）。
 * ★ 不再把背包里的火把算成光源：背包里的火把不发光，夜里仍会被查理攻击。
 *   要判断"安全"，必须结合 player.in_light（实际光照效果），不能只看"有没有带火把"。
 */
function hasPortableLight(snapshot) {
  for (const slot of ['hands', 'head']) {
    if (usableLightBlock(equipmentBlock(snapshot, slot))) return true
  }
  return false
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
export { inDangerZone }

/**
 * 计算「撤离当前危险区」的目标格：从最近的危险区圆心朝角色方向、走到半径 + margin 之外。
 * 没有危险区 / 拿不到坐标 → null。
 * 用途：危险区不该干等 Lua Reflex（它只对贴脸攻击反应），要由 Autopilot 主动 move_to 撤离，
 * 否则会出现「计划说先撤离、Autopilot 却 0 动作」的死锁。
 */
export function dangerZoneEscapeTarget(snapshot, margin = 8) {
  const x = snapshot?.actor?.tileX
  const z = snapshot?.actor?.tileZ
  if (typeof x !== 'number' || typeof z !== 'number') return null
  let best = null
  for (const zone of snapshot?.dangerZones ?? []) {
    if (typeof zone?.x !== 'number' || typeof zone?.z !== 'number') continue
    const r = Number(zone.radius ?? 10)
    const d = Math.hypot(x - zone.x, z - zone.z)
    if (d <= r && (!best || d - r < best.dr)) best = { zone, r, d, dr: d - r }
  }
  if (best) {
    let dx = x - best.zone.x
    let dz = z - best.zone.z
    let len = Math.hypot(dx, dz)
    if (len < 1e-6) { dx = 1; dz = 0; len = 1 }
    const dist = best.r + Math.max(1, margin)
    return {
      x: Math.round(best.zone.x + (dx / len) * dist),
      z: Math.round(best.zone.z + (dz / len) * dist),
    }
  }
  const threat = nearestThreat(snapshot, 6)
  if (threat) {
    const tx = threat.position?.x ?? threat.tile_x ?? (typeof threat.x === 'number' ? Math.round(threat.x / 4) : undefined)
    const tz = threat.position?.z ?? threat.tile_z ?? (typeof threat.z === 'number' ? Math.round(threat.z / 4) : undefined)
    let dx = 1, dz = 0
    if (typeof tx === 'number' && typeof tz === 'number') {
      dx = x - tx
      dz = z - tz
    }
    let len = Math.hypot(dx, dz)
    if (len < 1e-6) { dx = 1; dz = 0; len = 1 }
    const dist = Math.max(8, margin)
    return {
      x: Math.round(x + (dx / len) * dist),
      z: Math.round(z + (dz / len) * dist),
    }
  }
  return null
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
  if (threat && (health < 60 || /hound|spider_warrior/i.test(String(threat.prefab ?? '')) || (sanity < 20 && /terrorbeak|nightmare|crawling/i.test(String(threat.prefab ?? ''))))) {
    const isHound = /hound|spider_warrior/i.test(String(threat.prefab ?? ''))
    const isClose = isHound || (typeof threat.distance === 'number' && threat.distance <= 3) || threat.is_attacker || threat.is_targeting_you || threat.is_chasing
    if (isClose) {
      const label = isHound ? `野狗/强威胁贴脸（${threat.label ?? threat.prefab}），组织防御` : `威胁贴脸且状态差（${threat.label ?? threat.prefab}）`
      return { level: P0, key: 'retreat', attacker: true, is_hound: isHound, label, blocking: true }
    } else {
      const label = `避开附近威胁（${threat.label ?? threat.prefab}）`
      return { level: P0, key: 'retreat', zone: true, is_threat: true, label, blocking: true }
    }
  }
  if (inDangerZone(snapshot)) {
    return { level: P0, key: 'retreat', zone: true, label: '处于已知危险区', blocking: true }
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
