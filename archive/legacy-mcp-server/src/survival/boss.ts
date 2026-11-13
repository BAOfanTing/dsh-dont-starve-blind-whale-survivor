// Phase 6 M6 · Boss Planner（Boss 战准备）
//
// 第一批 Boss：Deerclops / Bearger / Moose-Goose / Antlion / Bee Queen / Dragonfly（外加几个常见大怪）。
//
// 本阶段**不要求自动击杀**。本模块只做四件事：
//   1. 识别 Boss（prefab + 名字 + 血量 + 位置 + 是否在追我）；
//   2. 给出"战前准备度"（护甲/武器/治疗/食物/光源/撤离路线逐项检查）；
//   3. 输出四选一结论：OBSERVE / PREPARE / AVOID / SUPERVISED_COMBAT；
//   4. 生成一份人能直接看的战斗准备报告。
//
// 硬规则：`requires_human_confirmation` 恒为 true。本阶段**没有任何**路径能让 AI 自己开 Boss 战。

import { BOSS_PROFILES, getBossProfile, isBossPrefab, type BossProfile, type BossRecommendation } from './profiles.js'
import { assessReadiness } from './combat.js'
import { planEscape } from './escape.js'
import type { SurvivalContext } from './types.js'

export interface BossPrepItem {
  key: string
  label: string
  ok: boolean
  detail: string
  /** 是否是这一战开打的前提（false = 建议项） */
  required: boolean
}

export interface BossDetection {
  prefab: string
  name: string
  hp_percent: number | null
  distance: number | null
  tile: { x: number | null; z: number | null } | null
  chasing: boolean | null
  attacking: boolean | null
  profile: BossProfile
}

export interface BossReadiness {
  boss_detected: boolean
  boss: BossDetection | null
  known_bosses_checked: string[]
  preparation: BossPrepItem[]
  readiness_score: number
  ready: boolean
  recommendation: BossRecommendation
  /** 本阶段恒为 true：Boss 战必须人工确认 */
  requires_human_confirmation: true
  report: string[]
  escape: { available: boolean; direction: { x: number; z: number } | null; note: string }
  phase_hint: string
  notes: string[]
}

export interface BossOptions {
  /** 想专门评估某个 Boss（不在附近也能查档案） */
  target_prefab?: string | null
}

function pickBossTarget(ctx: SurvivalContext, targetPrefab: string | null): BossDetection | null {
  if (targetPrefab !== null && targetPrefab !== '') {
    const profile = getBossProfile(targetPrefab)
    if (profile === null) return null
    const near = ctx.threats.find((threat) => threat.prefab === targetPrefab)
    if (near === undefined) {
      // 不在视野内：仍然给出档案侧的评估（detected 由调用方看 boss_detected）
      return {
        prefab: profile.prefab,
        name: profile.name,
        hp_percent: null,
        distance: null,
        tile: null,
        chasing: null,
        attacking: null,
        profile,
      }
    }
    return {
      prefab: profile.prefab,
      name: profile.name,
      hp_percent: near.hp,
      distance: near.distance,
      tile: { x: near.tile_x, z: near.tile_z },
      chasing: near.targeting_player,
      attacking: near.attacking,
      profile,
    }
  }

  const nearby = ctx.threats.filter((threat) => threat.is_boss || isBossPrefab(threat.prefab))
  if (nearby.length === 0) return null
  const nearest = nearby.reduce((acc, threat) => {
    if (acc === null) return threat
    return (threat.distance ?? 999) < (acc.distance ?? 999) ? threat : acc
  }, null as (typeof nearby)[number] | null)
  if (nearest === null) return null
  const profile = getBossProfile(nearest.prefab)
  if (profile === null) return null
  return {
    prefab: profile.prefab,
    name: profile.name,
    hp_percent: nearest.hp,
    distance: nearest.distance,
    tile: { x: nearest.tile_x, z: nearest.tile_z },
    chasing: nearest.targeting_player,
    attacking: nearest.attacking,
    profile,
  }
}

export function assessBossReadiness(ctx: SurvivalContext, options: BossOptions = {}): BossReadiness {
  const targetPrefab = typeof options.target_prefab === 'string' && options.target_prefab.length > 0 ? options.target_prefab : null
  const boss = pickBossTarget(ctx, targetPrefab)
  const detected = boss !== null && boss.distance !== null
  const notes: string[] = []
  const report: string[] = []
  const preparation: BossPrepItem[] = []

  if (targetPrefab !== null && boss === null) {
    notes.push(`没有 ${targetPrefab} 的 Boss 档案：按"未知高威胁目标"处理，禁止自动交战`)
    return {
      boss_detected: false,
      boss: null,
      known_bosses_checked: Object.keys(BOSS_PROFILES),
      preparation: [],
      readiness_score: 0,
      ready: false,
      recommendation: 'AVOID',
      requires_human_confirmation: true,
      report: [`未知 Boss prefab「${targetPrefab}」：没有档案，本阶段一律避战。`],
      escape: { available: false, direction: null, note: '未知目标，不给撤离建议' },
      phase_hint: 'AVOID（未知目标）',
      notes,
    }
  }

  const readiness = assessReadiness(ctx)
  const escape = planEscape(ctx)

  if (boss === null) {
    // 没有 Boss：给出"观察"结论 + 这批 Boss 的档案清单，便于提前准备
    report.push('视野内没有发现 Boss。')
    report.push(`已配置档案的 Boss：${Object.values(BOSS_PROFILES).map((profile) => profile.name).join('、')}`)
    report.push('建议：先按当前季节的准备清单囤物资（护甲/武器/治疗/光源/撤离路线），Boss 出现时才有的打。')
    return {
      boss_detected: false,
      boss: null,
      known_bosses_checked: Object.keys(BOSS_PROFILES),
      preparation: [],
      readiness_score: readiness.score,
      ready: false,
      recommendation: 'OBSERVE',
      requires_human_confirmation: true,
      report,
      escape: { available: escape.best !== null, direction: escape.best?.direction ?? null, note: escape.best?.risk ?? '' },
      phase_hint: 'OBSERVE（没有 Boss，先做常规准备）',
      notes,
    }
  }

  const profile = boss.profile

  // 准备度逐项检查（与 profile.required_prep 对齐）
  const addPrep = (key: string, label: string, ok: boolean, detail: string, required: boolean) => {
    preparation.push({ key, label, ok, detail, required })
  }

  const hasArmor = readiness.armor.absorb >= 0.7
  addPrep('armor', '护甲（≥1 套，减伤 ≥70%）', hasArmor,
    readiness.armor.body === null && readiness.armor.head === null
      ? '身上没有任何护甲'
      : `身体 ${readiness.armor.body ?? '无'} / 头部 ${readiness.armor.head ?? '无'}，减伤 ${Math.round(readiness.armor.absorb * 100)}%`,
    true)

  addPrep('weapon', '武器（伤害 ≥34）', (readiness.weapon.damage ?? 0) >= 34,
    readiness.weapon.damage === null ? '没有可用武器' : `手持 ${readiness.weapon.prefab}，约 ${readiness.weapon.damage} 伤害`, true)

  addPrep('healing', '治疗物品（合计 ≥30 点）', readiness.healing.total_hp >= 30,
    readiness.healing.items.length === 0 ? '没有治疗物品' : `${readiness.healing.items.join('/')} ≈ ${readiness.healing.total_hp} 点`,
    true)

  addPrep('food', '食物（≥2 份）', readiness.food.count >= 2, `背包 ${readiness.food.count} 份食物`, false)

  addPrep('light', '光源（夜间）', readiness.light.in_light !== false,
    readiness.light.in_light === null ? '拿不到光照状态' : readiness.light.in_light ? '在光照内' : '夜间没有光源',
    ctx.world.isNight === true)

  const escapeAvailable = escape.best !== null && escape.best.direction !== null
  addPrep('escape_route', '撤离路线', escapeAvailable,
    escapeAvailable ? `往 ${escape.best?.direction?.x},${escape.best?.direction?.z} 方向（背离威胁 12 格）` : '拿不到坐标/没有可用方向',
    true)

  const required = preparation.filter((item) => item.required)
  const passedRequired = required.filter((item) => item.ok).length
  const readinessScore = required.length === 0 ? 0 : Math.round((passedRequired / required.length) * 100)
  const ready = required.every((item) => item.ok)
  const hp = ctx.player.healthPercent ?? 0

  let recommendation: BossRecommendation
  const chasing = boss.chasing === true
  const close = (boss.distance ?? 99) <= 12

  if (!detected) {
    recommendation = 'OBSERVE'
  } else if (!ready) {
    recommendation = chasing || close ? 'AVOID' : 'PREPARE'
  } else if (hp < 50) {
    recommendation = 'AVOID'
    notes.push(`准备度够了但生命只有 ${hp}%：先回血再考虑`)
  } else {
    recommendation = 'SUPERVISED_COMBAT'
  }

  // 战斗准备报告
  report.push(`Boss：${profile.name}（prefab=${profile.prefab}）`)
  report.push(`状态：${detected ? (close ? `在 ${boss.distance} 格内` : `在 ${boss.distance} 格处`) : '不在视野内（仅按档案评估）'}`
    + (boss.hp_percent !== null ? `，血量 ${boss.hp_percent}%` : '') + (chasing ? '，正在追玩家' : ''))
  report.push(`特殊能力：${profile.special_abilities.join('；')}`)
  report.push(`出现时机：${profile.spawn_hint}`)
  report.push(`准备度 ${readinessScore}/100，${ready ? '硬性准备齐全' : `缺口：${required.filter((item) => !item.ok).map((item) => item.label).join('、')}`}`)
  for (const item of preparation) {
    report.push(`  ${item.ok ? '✓' : '✗'} ${item.label} —— ${item.detail}`)
  }
  report.push(`结论：${recommendation}${recommendation === 'SUPERVISED_COMBAT' ? '（必须人工确认才开打；程序不会自动开始）' : ''}`)
  report.push('本阶段不要求自动击杀 Boss：AI 只负责识别、避战、准备和发起人工监督战斗的建议。')

  return {
    boss_detected: detected,
    boss,
    known_bosses_checked: Object.keys(BOSS_PROFILES),
    preparation,
    readiness_score: readinessScore,
    ready,
    recommendation,
    requires_human_confirmation: true,
    report,
    escape: { available: escapeAvailable, direction: escape.best?.direction ?? null, note: escape.best?.risk ?? '' },
    phase_hint: `${recommendation}（${recommendation === 'OBSERVE' ? '继续观察' : recommendation === 'PREPARE' ? '先补准备' : recommendation === 'AVOID' ? '避战' : '人工监督战斗'}）`,
    notes,
  }
}
