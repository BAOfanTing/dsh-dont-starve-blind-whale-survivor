// 采集与劳作（13 个动作）
//
// 每个动作声明：riskLevel / category / description / 参数白名单 / 核对方式（verify）。
// 参数白名单是安全边界的一部分：args 里出现的其它键一律被拒（防模型夹带）。

import { countInInventory, findSameEntity, nearestByPrefabs, prefabOfRef, targetItem } from '../state-query.js'
import {
  TARGET_REF_ARGS,
  isKind,
  isKindForAction,
  kindPrefabs,
  kindProducts,
  kindsFor,
} from '../target-kinds.js'

// ─────────────────────────── TARGET-REFRESH：实时目标选择的共用部分 ───────────────────────────
//
// 这五个动作**不接受 target_ref / snapshot_id**：目标由 Lua 在授权那一刻用当前世界状态重新找。
// 参数只有"要哪一类"（固定枚举）+ 可选半径 —— 模型没法传 prefab / GUID / 表达式。
//
// 核对方式（Node 侧不知道 Lua 最终选了哪个实体，所以只认"世界真的变了"）：
//   ① 这一类到手后会进背包的东西真的 +N（权威证据）
//   ② 同一株的"可采"状态翻转（只对植株类）
//   ③ 离得最近的那个同类目标在 after 里没了（弱证据，且只在它本来就在手边时才算）

/** 一个 kind 参数规则（enum 由 target-kinds 派生，Node 与 Lua 用同一份枚举） */
function kindArg(action, { required = true } = {}) {
  return {
    type: 'string',
    maxLength: 32,
    pattern: '^[a-z0-9_]{1,32}$',
    enum: kindsFor(action),
    ...(required ? { required: true } : {}),
  }
}

const RADIUS_ARG = { type: 'number', min: 2, max: 40 }

/** nearest 类动作的核对函数 */
function nearestVerify(action, defaultKind = null) {
  return (before, after, args) => {
    const kind = String(args?.target_kind ?? defaultKind ?? '')
    if (!isKind(kind)) return { ok: false, reason: 'target_kind_not_allowed' }
    if (!isKindForAction(action, kind)) return { ok: false, reason: 'target_kind_mismatch' }

    // ① 权威证据：这一类到手后该出现的东西真的多了
    for (const prefab of kindProducts(kind)) {
      const d = countInInventory(after, prefab) - countInInventory(before, prefab)
      if (d > 0) return { ok: true, prefab, gained: d, kind }
    }

    // ②/③ 兜底：只针对"本来就在手边、而且我们知道它在哪"的那一个目标。
    //   没有 position 就没法判断"消失的是不是它" —— 这种情况下宁可不报成功（失败要安全）。
    const near = nearestByPrefabs(before, kindPrefabs(kind))
    if (near && near.distance <= 3 && near.item?.position) {
      const same = findSameEntity(after, near.item)
      if (same && near.item.harvest_ready === true && same.harvest_ready === false) {
        return { ok: true, how: 'state_flipped', prefab: near.item.prefab, kind }
      }
      if (!same) return { ok: true, how: 'target_gone', prefab: near.item.prefab, kind }
    }
    return { ok: false, reason: 'inventory_unchanged', kind }
  }
}

/** 五个动作共用的说明尾巴（提示词要让模型明白"这类不需要快照号"） */
const NEAREST_NOTE = '服务端会用当前世界状态重新找最近的目标，因此**不需要** snapshot_id / #N，也就不会过期。'

export const gatheringSpecs = {
  /**
   * TARGET-REFRESH：捡最近的某一类地面材料。
   * 只接受固定枚举 target_kind（Node 与 Lua 同一份表），绝不接受 prefab / 坐标 / GUID。
   */
  pickup_nearest: {
    riskLevel: 'R2',
    category: 'gathering',
    description: `捡起最近的一类地面材料。${NEAREST_NOTE}`,
    verifyWaitMs: 3000,
    args: {
      target_kind: kindArg('pickup_nearest'),
      radius: RADIUS_ARG,
    },
    verify: nearestVerify('pickup_nearest'),
  },
  /**
   * TARGET-REFRESH：实时搜地面**白名单**食物并捡起来。
   * 生蘑菇不在自动安全名单里（吃了掉理智），所以 pickup_food 默认只找 safe_ground_food。
   */
  pickup_food: {
    riskLevel: 'R2',
    category: 'gathering',
    description: `实时搜索并捡起地上的安全食物（胡萝卜/浆果/多汁浆果/南瓜等；生蘑菇不算）。${NEAREST_NOTE}`,
    verifyWaitMs: 3000,
    args: {
      target_kind: kindArg('pickup_food', { required: false }),
      radius: RADIUS_ARG,
    },
    verify: nearestVerify('pickup_food', 'safe_ground_food'),
  },
  /**
   * TARGET-REFRESH：采最近**已经成熟**的食物植株。
   * 未成熟的植株在 Lua 侧直接跳过（不是报错）—— 所以模型不会再把"未成熟"当成可采目标。
   */
  harvest_nearest: {
    riskLevel: 'R2',
    category: 'gathering',
    description: `采下最近一株**已经成熟**的食物植物（浆果丛 / 多汁浆果丛 / 地上的胡萝卜 / 成熟蘑菇）。未成熟的会自动跳过。${NEAREST_NOTE}`,
    verifyWaitMs: 4000,
    args: {
      target_kind: kindArg('harvest_nearest'),
      radius: RADIUS_ARG,
    },
    verify: nearestVerify('harvest_nearest'),
  },
  /**
   * TARGET-REFRESH：砍最近的树（自动装斧头，走原有的 chop 链）。
   */
  chop_nearest: {
    riskLevel: 'R2',
    category: 'gathering',
    description: `砍倒最近的一棵树（需要斧头，会自动拿在手上）。${NEAREST_NOTE}`,
    verifyWaitMs: 4000,
    args: {
      target_kind: kindArg('chop_nearest'),
      radius: RADIUS_ARG,
    },
    verify: nearestVerify('chop_nearest'),
  },
  /**
   * TARGET-REFRESH：挖最近的石头（普通石头 / 金矿脉，自动装镐）。
   */
  mine_nearest: {
    riskLevel: 'R2',
    category: 'gathering',
    description: `挖开最近的一块石头（需要镐，会自动拿在手上）。ordinary_rock=普通石头，gold_vein=金矿脉（rock2）。${NEAREST_NOTE}`,
    verifyWaitMs: 4000,
    args: {
      target_kind: kindArg('mine_nearest'),
      radius: RADIUS_ARG,
    },
    verify: nearestVerify('mine_nearest'),
  },
  /**
   * M2.1：按 #N 引用拾取地面普通资源。
   * 只接受 target_ref + snapshot_id，绝不接受 prefab / 坐标 / GUID / 任何授权字段。
   * TARGET-REFRESH：也可以只给 target_handle（跨扫描稳定的句柄，见 nearby 的"句柄h…"）。
   */
  pickup: {
    riskLevel: 'R2',
    category: 'gathering',
    description: '从地上捡起一个普通资源（用当前 nearby 快照里的 #N，或一个稳定句柄 h…）',
    requiresSnapshot: true, // 走 #N 时 args.snapshot_id 必须等于当前快照；带 target_handle 时不需要
    verifyWaitMs: 3000,     // 背包变化要等游戏写下一帧状态文件
    args: {
      ...TARGET_REF_ARGS,
    },
    /**
     * 核对：执行前后「背包里该 prefab 的总数」必须增加。
     * 依据：scripts.zip 的 ACTIONS.PICKUP.fn 最终走 inventory:GiveItem；
     * GiveItem 放不下时会把物品丢回地面，而 PICKUP.fn 仍然 return true
     * —— 所以绝不能只看动作有没有报错。
     */
    verify(before, after, args) {
      // TARGET-REFRESH：句柄路径下 target_ref 为空，退回按句柄取 prefab。
      const item = targetItem(before, args)
      const prefab = item?.prefab ?? prefabOfRef(before, args?.target_ref)
      if (!prefab) return { ok: false, reason: 'unknown_ref' }
      const b = countInInventory(before, prefab)
      const a = countInInventory(after, prefab)
      if (a > b) return { ok: true, prefab, gained: a - b }
      return { ok: false, reason: 'inventory_unchanged', prefab }
    },
  },
  /**
   * M2.3：按 #N 收获已成熟的试点对象（本阶段只有普通浆果丛 berrybush / berrybush2）。
   * 底层原生动作是 ACTIONS.PICK（不是 ACTIONS.HARVEST）。
   * 只接受 target_ref + snapshot_id，绝不接受 prefab / 坐标 / GUID / 任何授权字段。
   */
  harvest: {
    riskLevel: 'R2',
    category: 'gathering',
    description: '采下一个已经成熟的可收获对象（浆果丛、地上的胡萝卜、成熟蘑菇等）',
    requiresSnapshot: true,
    verifyWaitMs: 4000,
    args: {
      ...TARGET_REF_ARGS,
    },
    /**
     * 核对（不能只看原生动作有没有报错）：
     *   ① 背包里该产物数量增加（普通浆果丛的 berries 直接进包）；
     *   ② 同一个对象（prefab + 位置）的 harvest_ready 由 true 变 false（原生 canbepicked 翻转）；
     *   ③ 目标从可收获桶里消失。
     * 三条都不成立就返回 unverified —— 收获确实可能发生但产物落地了，不能因此谎报失败或成功。
     */
    verify(before, after, args) {
      // TARGET-REFRESH：target_ref 与 target_handle 二选一，两种都要能核对。
      const target = targetItem(before, args)
      if (!target) return { ok: false, reason: 'unknown_ref' }
      const product = target.product ?? null
      if (product) {
        const b = countInInventory(before, product)
        const a = countInInventory(after, product)
        if (a > b) return { ok: true, product, gained: a - b, how: "inventory" }
      }
      const same = findSameEntity(after, target)
      if (same && same.harvest_ready === false) return { ok: true, product, how: 'state_flipped' }
      if (!same && target.harvest_ready === true) return { ok: true, product, how: 'target_gone' }
      return { ok: false, reason: 'harvest_state_unchanged', product }
    },
  },
  /**
   * SURVIVAL-03：对实体干活（chop / mine / dig / hammer 共用一套核对）。
   * 都是"目标 workable 被干完 / 目标消失"算成功，产物进背包更好。
   */
  chop: {
    riskLevel: 'R2',
    category: 'gathering',
    description: '砍一棵树（需要斧头）',
    requiresSnapshot: true,
    verifyWaitMs: 4000,
    args: {
      ...TARGET_REF_ARGS,
    },
    verify(before, after, args) {
      const item = targetItem(before, args)
      if (!item) return { ok: false, reason: 'unknown_ref' }
      const same = findSameEntity(after, item)
      const gained = countInInventory(after, 'log') - countInInventory(before, 'log')
      if (gained > 0) return { ok: true, product: 'log', gained }
      if (!same) return { ok: true, how: 'target_gone' }
      return { ok: false, reason: 'work_state_unchanged' }
    },
  },
  mine: {
    riskLevel: 'R2',
    category: 'gathering',
    description: '挖一块石头（需要镐）',
    requiresSnapshot: true,
    verifyWaitMs: 4000,
    args: {
      ...TARGET_REF_ARGS,
    },
    verify(before, after, args) {
      const item = targetItem(before, args)
      if (!item) return { ok: false, reason: 'unknown_ref' }
      const same = findSameEntity(after, item)
      for (const prefab of ['rocks', 'flint', 'goldnugget', 'nitre', 'marble']) {
        const d = countInInventory(after, prefab) - countInInventory(before, prefab)
        if (d > 0) return { ok: true, product: prefab, gained: d }
      }
      if (!same) return { ok: true, how: 'target_gone' }
      return { ok: false, reason: 'work_state_unchanged' }
    },
  },
  dig: {
    riskLevel: 'R2',
    category: 'gathering',
    description: '铲掉草皮/树桩/坟（需要铲子）',
    requiresSnapshot: true,
    verifyWaitMs: 4000,
    args: {
      ...TARGET_REF_ARGS,
    },
    verify(before, after, args) {
      const item = targetItem(before, args)
      if (!item) return { ok: false, reason: 'unknown_ref' }
      const same = findSameEntity(after, item)
      if (!same) return { ok: true, how: 'target_gone' }
      return { ok: false, reason: 'work_state_unchanged' }
    },
  },
  hammer: {
    riskLevel: 'R2',
    category: 'gathering',
    description: '拆掉一个建筑（需要锤子）',
    requiresSnapshot: true,
    verifyWaitMs: 4000,
    args: {
      ...TARGET_REF_ARGS,
    },
    verify(before, after, args) {
      const item = targetItem(before, args)
      if (!item) return { ok: false, reason: 'unknown_ref' }
      const same = findSameEntity(after, item)
      if (!same) return { ok: true, how: 'target_gone' }
      return { ok: false, reason: 'work_state_unchanged' }
    },
  },
  /**
   * SURVIVAL-02：范围采集（借鉴 DontStarveAI 的 harvest_area）。
   * 模型只给"只采哪种（可选）+ 范围 + 上限"，目标由 Lua 侧从**观察同一份白名单**里挑。
   */
  gather_area: {
    riskLevel: 'R2',
    category: 'gathering',
    description: '把附近能采的草丛/树苗/浆果丛/花一次采完（可只采某一种）',
    verifyWaitMs: 4000,
    args: {
      prefab: { type: 'string', pattern: '^[a-z0-9_]{1,32}$', maxLength: 32 },
      radius: { type: 'number', min: 2, max: 40 },
      limit: { type: 'number', min: 1, max: 30, integer: true },
    },
    /**
     * 核对：任一产物进背包即算成功（一次采多种时不可能逐个对账）。
     * 一个都没变才算失败 —— 这时 Lua 那边应该已经报了原因。
     */
    verify(before, after) {
      const prefabs = ['cutgrass', 'twigs', 'berries', 'petals']
      const gained = []
      for (const prefab of prefabs) {
        const d = countInInventory(after, prefab) - countInInventory(before, prefab)
        if (d > 0) gained.push({ prefab, gained: d })
      }
      if (gained.length > 0) {
        const total = gained.reduce((s, g) => s + g.gained, 0)
        return { ok: true, gained: total, products: gained }
      }
      return { ok: false, reason: 'inventory_unchanged' }
    },
  },
  /**
   * SURVIVAL-01：按 #N 采集草丛/树苗（白名单在 Lua 的 gatherrules）。
   * 和 pickup/harvest 完全同构：只接受 target_ref + snapshot_id。
   */
  gather: {
    riskLevel: 'R2',
    category: 'gathering',
    description: '采集草丛（得 cutgrass）、树苗（得 twigs）或花（得 petals，并回理智）（只能用当前 nearby 快照里的 #N）',
    requiresSnapshot: true,
    verifyWaitMs: 3500,
    args: {
      ...TARGET_REF_ARGS,
    },
    /**
     * 核对：产物进背包 / 同一株的"可采"状态翻转 / 目标消失，三条路径命中任一即可。
     * 产物 prefab 由 Lua 的 gatherrules 决定（grass→cutgrass，sapling→twigs），这里照抄同一张表。
     */
    verify(before, after, args) {
      const item = targetItem(before, args)
      if (!item) return { ok: false, reason: 'unknown_ref' }
      const PRODUCT = { grass: 'cutgrass', sapling: 'twigs', flower: 'petals' }
      const product = PRODUCT[item.prefab]
      if (!product) return { ok: false, reason: 'prefab_not_allowed' }
      const b = countInInventory(before, product)
      const a = countInInventory(after, product)
      if (a > b) return { ok: true, product, gained: a - b }
      const same = findSameEntity(after, item)
      if (!same) return { ok: true, product, how: 'target_gone' }
      return { ok: false, reason: 'gather_state_unchanged', product }
    },
  },
}
