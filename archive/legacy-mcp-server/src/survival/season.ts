// Phase 6 M5 · Season Manager（四季生存管理）
//
// 任务书 §8：不能把季节开始/结束日期写死 —— 这里所有季节判断都来自世界真实状态：
//   world.season / is_autumn..is_summer / elapsed_days_in_season / remaining_days_in_season
// 拿不到剩余天数时**必须明确报告预测不可靠**（`confidence: 'unreliable'`）。
//
// 模块只做两件事：
//   1. 算"这一季准备好了没有"（逐项 checklist + 分数）；
//   2. 给出有序的准备计划（每步都是已实现的工具，AI 自己决定什么时候做）。

import type { SurvivalContext } from './types.js'
import { ARMOR_ABSORB, WEAPON_DAMAGE } from './types.js'

export type Season = 'AUTUMN' | 'WINTER' | 'SPRING' | 'SUMMER' | 'UNKNOWN'

export type SeasonConfidence = 'verified' | 'predicted' | 'unreliable'

export interface SeasonCheck {
  key: string
  label: string
  /** true=达标；false=缺；null=无法判断（数据缺失） */
  ok: boolean | null
  detail: string
  /** 1=不做会死 2=不做会很难受 3=锦上添花 */
  priority: 1 | 2 | 3
}

export interface SeasonStep {
  step: string
  /** 建议使用的工具 */
  tool: string
  why: string
  priority: 1 | 2 | 3
}

export interface SeasonalReadiness {
  season: Season
  day: number | null
  elapsed_days_in_season: number | null
  remaining_days_in_season: number | null
  confidence: SeasonConfidence
  /** 预测不可靠时的明确说明（任务书要求） */
  prediction_note: string
  ready: boolean
  score: number
  checks: SeasonCheck[]
  plan: SeasonStep[]
  warnings: string[]
  data_source: string
}

const INSULATION_ITEMS = ['winter_hat', 'earmuffs', 'beefalohat', 'beehat', 'bushhat', 'top_hat']
const THERMAL_STONE = ['heatrock', 'heatrock2']
const RAIN_GEAR = ['umbrella', 'rainhat', 'raincoat', 'eyebrella', 'waterproofhat']
const SUMMER_GEAR = ['eyebrella', 'strawhat', 'umbrella', 'icepack', 'chilled_amulet', 'luxuryfan', 'summer_hat']
const FUEL_ITEMS = ['log', 'twigs', 'cutgrass', 'charcoal', 'pinecone', 'board']
const FOOD_ITEMS = ['berries', 'carrot', 'corn', 'mushroom', 'red_cap', 'green_cap', 'blue_cap', 'meat', 'cookedmeat', 'monstermeat', 'seeds', 'honey', 'fish', 'meatballs']
const HAMMER_OF_LIGHT = ['torch', 'lantern', 'minerhat', 'pumpkin_lantern']

function countOf(ctx: SurvivalContext, prefabs: string[]): number {
  return ctx.inventory
    .filter((item) => prefabs.includes(item.prefab))
    .reduce((acc, item) => acc + item.count, 0)
}

function bestWeaponDamage(ctx: SurvivalContext): number {
  let best = 0
  for (const prefab of [...ctx.inventory.map((item) => item.prefab), ctx.equipment.hands?.prefab ?? '']) {
    const damage = WEAPON_DAMAGE[prefab]
    if (damage !== undefined && damage > best) best = damage
  }
  return best
}

function bestArmor(ctx: SurvivalContext, equippedOnly = false): number {
  let best = 0
  const prefabs = equippedOnly
    ? [ctx.equipment.body?.prefab ?? '', ctx.equipment.head?.prefab ?? '']
    : [...ctx.inventory.map((item) => item.prefab), ctx.equipment.body?.prefab ?? '', ctx.equipment.head?.prefab ?? '']
  for (const prefab of prefabs) {
    const absorb = ARMOR_ABSORB[prefab]
    if (absorb !== undefined && absorb > best) best = absorb
  }
  return best
}

/** 判断当前季节：优先用游戏给的 season 字段，其次用四季布尔开关 */
export function detectSeason(world: SurvivalContext['world']): { season: Season; source: string } {
  const raw = world.season
  if (typeof raw === 'string') {
    const normalized = raw.trim().toUpperCase()
    if (normalized === 'AUTUMN' || normalized === 'WINTER' || normalized === 'SPRING' || normalized === 'SUMMER') {
      return { season: normalized, source: 'world.season' }
    }
  }
  const flags = world.seasonFlags
  const hits: Season[] = []
  if (flags.winter === true) hits.push('WINTER')
  if (flags.spring === true) hits.push('SPRING')
  if (flags.summer === true) hits.push('SUMMER')
  if (flags.autumn === true) hits.push('AUTUMN')
  if (hits.length === 1) return { season: hits[0] as Season, source: 'world.is_* 布尔开关' }
  return { season: 'UNKNOWN', source: '未知（游戏没给出季节字段）' }
}

export function assessSeason(ctx: SurvivalContext): SeasonalReadiness {
  const { season, source } = detectSeason(ctx.world)
  const remaining = ctx.world.remainingDaysInSeason
  const elapsed = ctx.world.elapsedDaysInSeason
  const warnings: string[] = []
  const checks: SeasonCheck[] = []
  const plan: SeasonStep[] = []

  let confidence: SeasonConfidence = 'unreliable'
  let predictionNote = ''
  if (season !== 'UNKNOWN' && remaining !== null) {
    confidence = 'verified'
    predictionNote = `季节与剩余天数都来自游戏世界状态：${season}，本季还剩 ${remaining} 天`
  } else if (season !== 'UNKNOWN') {
    confidence = 'predicted'
    predictionNote = `季节来自游戏（${source}），但**拿不到剩余天数**：具体哪天换季/哪天来 Boss 只能估，不可靠`
  } else {
    confidence = 'unreliable'
    predictionNote = '拿不到季节数据：下面的季节计划仅供参考，不能当作当前季节的准确判断'
  }
  if (confidence !== 'verified') {
    warnings.push('季节预测不可靠：不要按固定日期安排（例如"第 21 天必来巨鹿"这种假设）')
  }

  const push = (check: SeasonCheck) => checks.push(check)

  // ── 通用检查（每季都要看）──
  const fuel = countOf(ctx, FUEL_ITEMS)
  push({
    key: 'fuel',
    label: '燃料储备',
    ok: fuel >= 6,
    detail: `背包燃料 ${fuel} 个（木/枝/草/炭），夜里续火至少备 6 个`,
    priority: 1,
  })
  const food = countOf(ctx, FOOD_ITEMS)
  push({
    key: 'food',
    label: '食物储备',
    ok: food >= 4,
    detail: `背包可吃的东西 ${food} 个`,
    priority: 1,
  })
  const weaponDamage = bestWeaponDamage(ctx)
  push({
    key: 'weapon',
    label: '武器',
    ok: weaponDamage >= 34,
    detail: weaponDamage === 0 ? '没有可用的武器' : `最好武器约 ${weaponDamage} 伤害`,
    priority: 1,
  })
  const armor = bestArmor(ctx)
  push({
    key: 'armor',
    label: '护甲',
    ok: armor >= 0.7,
    detail: armor === 0 ? '没有护甲' : `最好护甲减伤 ${Math.round(armor * 100)}%`,
    priority: 1,
  })
  const lightItems = countOf(ctx, HAMMER_OF_LIGHT)
  push({
    key: 'light',
    label: '随身光源',
    ok: lightItems > 0 || ctx.environment.inLight === true,
    detail: lightItems > 0 ? `背包里 ${lightItems} 个光源` : ctx.environment.inLight === true ? '当前在光照内，但背包没有备用光源' : '没有光源',
    priority: 1,
  })
  push({
    key: 'base',
    label: '基地/落脚点',
    ok: ctx.nearbyStructures === null ? null : ctx.nearbyStructures >= 3,
    detail: ctx.nearbyStructures === null
      ? '没有附近实体扫描数据，无法判断有没有基地'
      : `附近结构物 ${ctx.nearbyStructures} 个（≥3 才算有个像样的落脚点）`,
    priority: 2,
  })

  // ── 季节专属检查 ──
  if (season === 'AUTUMN') {
    const insulation = countOf(ctx, INSULATION_ITEMS)
    const stone = countOf(ctx, THERMAL_STONE)
    push({ key: 'winter_gear', label: '保暖装备', ok: insulation > 0, detail: insulation > 0 ? `有 ${insulation} 件保暖装备` : '没有帽子类保暖装备（冬天会冻掉血）', priority: 2 })
    push({ key: 'thermal_stone', label: '保温石', ok: stone > 0, detail: stone > 0 ? '有保温石' : '没有保温石（冬天出门很容易冻伤）', priority: 2 })
    push({ key: 'crockpot', label: '烹饪锅', ok: null, detail: '没有查询锅具的数据（附近结构物只能判断"有没有结构"，分不出是不是锅）', priority: 2 })

    plan.push(
      { step: '先把木材备够（砍树 3 棵以上）', tool: 'chop_tree', why: '冬天砍树慢、又冷又黑', priority: 1 },
      { step: '采草/树枝各 10+', tool: 'gather_resource', why: '火把、营火、绳子都要用', priority: 1 },
      { step: '做一把斧头/镐，做一套护甲', tool: 'craft_item', why: '冬季 Boss 与猎犬都需要能打', priority: 1 },
      { step: '做保暖帽 + 保温石', tool: 'craft_item', why: '冬季生存的硬指标', priority: 2 },
      { step: '在基地建营火并囤燃料', tool: 'build_campfire', why: '夜里必须有光和热', priority: 2 },
      { step: '囤 6+ 食物（浆果/烤肉）', tool: 'gather_resource', why: '冬天浆果不长', priority: 2 },
    )
  } else if (season === 'WINTER') {
    const insulation = countOf(ctx, INSULATION_ITEMS)
    const stone = countOf(ctx, THERMAL_STONE)
    const temp = ctx.player.temperature
    push({ key: 'body_temp', label: '体温', ok: temp === null ? null : temp > 5, detail: temp === null ? '拿不到体温' : `当前体温 ${temp}℃（低于 5℃ 开始冻伤）`, priority: 1 })
    push({ key: 'insulation', label: '保暖装备', ok: insulation > 0, detail: insulation > 0 ? `有 ${insulation} 件保暖装备` : '没有保暖装备', priority: 1 })
    push({ key: 'thermal_stone', label: '保温石', ok: stone > 0, detail: stone > 0 ? '有保温石' : '没有保温石', priority: 1 })
    push({ key: 'fuel_winter', label: '取暖燃料', ok: fuel >= 10, detail: `燃料 ${fuel} 个（冬天建议 ≥10）`, priority: 1 })
    if (remaining !== null && remaining <= 5) {
      warnings.push('冬季快结束了：注意春季的雨与青蛙雨')
    }
    warnings.push('冬季 Boss 风险：巨鹿会循着玩家的动静过来，听到吼声先确认护甲/治疗/撤离路线')

    plan.push(
      { step: '优先保证营火不灭（燃料 <15% 就加）', tool: 'build_campfire', why: '冬天冻死比饿死快', priority: 1 },
      { step: '穿保暖装备、带保温石再出门', tool: 'equip_item', why: '体温低于 0℃ 会持续掉血', priority: 1 },
      { step: '白天出门采集，黄昏前回营地', tool: 'move_to', why: '冬季夜晚又长又冷', priority: 1 },
      { step: '听到巨鹿吼声：先确认护甲/治疗/撤离路线', tool: 'get_boss_readiness', why: '冬季 Boss 无法用固定日期预测', priority: 1 },
      { step: '保持 4+ 食物随时可吃', tool: 'eat_item', why: '寒冷会加速饥饿', priority: 2 },
    )
  } else if (season === 'SPRING') {
    const rainGear = countOf(ctx, RAIN_GEAR)
    const wet = ctx.player.wetnessPercent
    const sanity = ctx.player.sanityPercent
    push({ key: 'rain_gear', label: '防雨装备', ok: rainGear > 0, detail: rainGear > 0 ? `有 ${rainGear} 件防雨装备` : '没有雨伞/雨帽/雨衣，下雨会一直潮湿', priority: 1 })
    push({ key: 'wetness', label: '潮湿程度', ok: wet === null ? null : wet < 35, detail: wet === null ? '拿不到潮湿值' : `潮湿 ${wet}%`, priority: 1 })
    push({ key: 'sanity', label: '理智', ok: sanity === null ? null : sanity >= 40, detail: sanity === null ? '拿不到理智' : `理智 ${sanity}%`, priority: 2 })
    push({ key: 'lightning', label: '避雷准备', ok: null, detail: '游戏没有直接给"落雷风险"字段：按"下雨 = 有落雷风险"处理', priority: 2 })
    warnings.push('春季地面会出现青蛙雨/蜜蜂群，不要在同一个小区域久留')

    plan.push(
      { step: '做雨伞或雨帽（防潮湿掉体温）', tool: 'craft_item', why: '潮湿 + 雨 = 体温流失、理智下降', priority: 1 },
      { step: '雨季前把火堆挪到有顶/靠墙的位置', tool: 'build_campfire', why: '雨会浇灭火堆', priority: 2 },
      { step: '雨天不要在空旷地久站（落雷）', tool: 'move_to', why: '春季落雷会打人也会引燃', priority: 1 },
      { step: '关注理智，低了就吃熟食/找安全区', tool: 'eat_item', why: '春季理智掉得快', priority: 2 },
      { step: '青蛙雨开始就往基地或高地走', tool: 'move_to', why: '青蛙成群会围杀', priority: 1 },
    )
  } else if (season === 'SUMMER') {
    const summerGear = countOf(ctx, SUMMER_GEAR)
    const temp = ctx.player.temperature
    push({ key: 'summer_gear', label: '防暑装备', ok: summerGear > 0, detail: summerGear > 0 ? `有 ${summerGear} 件防暑物品` : '没有防暑装备（草帽/遮阳伞/降温石）', priority: 1 })
    push({ key: 'body_temp', label: '体温', ok: temp === null ? null : temp < 60, detail: temp === null ? '拿不到体温' : `当前体温 ${temp}℃（>60℃ 开始过热）`, priority: 1 })
    push({ key: 'fire_safety', label: '基地防火', ok: null, detail: '没有"闷烧/野火"的直接读数：夏季请默认基地有自燃风险', priority: 1 })
    warnings.push('夏季野火/闷烧无法从当前数据读取：离开基地时不要留可燃物堆在火堆旁')

    plan.push(
      { step: '做草帽/遮阳伞，带降温石', tool: 'craft_item', why: '过热掉血很快', priority: 1 },
      { step: '夏天只在早晚出门，正午回阴凉处', tool: 'move_to', why: '正午过热最严重', priority: 1 },
      { step: '基地周围清可燃物、火堆远离建筑', tool: 'move_to', why: '野火会连锁烧基地', priority: 1 },
      { step: '备冰/硝石做降温手段（有的话）', tool: 'craft_item', why: '降温物资是夏季硬通货', priority: 2 },
      { step: '喝水/吃含水食物维持体温', tool: 'eat_item', why: '过热时饥饿也掉得快', priority: 3 },
    )
  } else {
    warnings.push('季节未知：只给通用准备建议')
    plan.push(
      { step: '先确认季节（get_world_status）', tool: 'get_world_status', why: '季节是后面所有计划的前提', priority: 1 },
      { step: '通用准备：燃料、食物、武器、护甲、光源', tool: 'gather_resource', why: '四季通用', priority: 1 },
    )
  }

  const scored = checks.filter((check) => check.ok !== null)
  const passed = scored.filter((check) => check.ok === true).length
  const score = scored.length === 0 ? 0 : Math.round((passed / scored.length) * 100)
  const ready = checks.every((check) => check.priority !== 1 || check.ok !== false)

  return {
    season,
    day: ctx.world.day,
    elapsed_days_in_season: elapsed,
    remaining_days_in_season: remaining,
    confidence,
    prediction_note: predictionNote,
    ready,
    score,
    checks,
    plan,
    warnings,
    data_source: source,
  }
}
