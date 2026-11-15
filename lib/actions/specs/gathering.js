// 采集与劳作（8 个动作）
//
// 每个动作声明：riskLevel / category / description / 参数白名单 / 核对方式（verify）。
// 参数白名单是安全边界的一部分：args 里出现的其它键一律被拒（防模型夹带）。

import { countInInventory, findSameEntity, itemOfRef, prefabOfRef } from '../state-query.js'

export const gatheringSpecs = {
  /**
   * M2.1：按 #N 引用拾取地面普通资源。
   * 只接受 target_ref + snapshot_id，绝不接受 prefab / 坐标 / GUID / 任何授权字段。
   */
  pickup: {
    riskLevel: 'R2',
    category: 'gathering',
    description: '从地上捡起一个普通资源（只能用当前 nearby 快照里的 #N）',
    requiresSnapshot: true, // args.snapshot_id 必须等于当前快照
    verifyWaitMs: 3000,     // 背包变化要等游戏写下一帧状态文件
    args: {
      target_ref: { type: 'string', pattern: '^#[1-9][0-9]{0,3}$', maxLength: 8, required: true },
      snapshot_id: { type: 'string', maxLength: 64, required: true },
    },
    /**
     * 核对：执行前后「背包里该 prefab 的总数」必须增加。
     * 依据：scripts.zip 的 ACTIONS.PICKUP.fn 最终走 inventory:GiveItem；
     * GiveItem 放不下时会把物品丢回地面，而 PICKUP.fn 仍然 return true
     * —— 所以绝不能只看动作有没有报错。
     */
    verify(before, after, args) {
      const prefab = prefabOfRef(before, args?.target_ref)
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
      target_ref: { type: 'string', pattern: '^#[1-9][0-9]{0,3}$', maxLength: 8, required: true },
      snapshot_id: { type: 'string', maxLength: 64, required: true },
    },
    /**
     * 核对（不能只看原生动作有没有报错）：
     *   ① 背包里该产物数量增加（普通浆果丛的 berries 直接进包）；
     *   ② 同一个对象（prefab + 位置）的 harvest_ready 由 true 变 false（原生 canbepicked 翻转）；
     *   ③ 目标从可收获桶里消失。
     * 三条都不成立就返回 unverified —— 收获确实可能发生但产物落地了，不能因此谎报失败或成功。
     */
    verify(before, after, args) {
      const ref = args?.target_ref
      const target = itemOfRef(before, ref)
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
      target_ref: { type: 'string', pattern: '^#[1-9][0-9]{0,3}$', maxLength: 8, required: true },
      snapshot_id: { type: 'string', maxLength: 64, required: true },
    },
    verify(before, after, args) {
      const item = itemOfRef(before, args?.target_ref)
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
      target_ref: { type: 'string', pattern: '^#[1-9][0-9]{0,3}$', maxLength: 8, required: true },
      snapshot_id: { type: 'string', maxLength: 64, required: true },
    },
    verify(before, after, args) {
      const item = itemOfRef(before, args?.target_ref)
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
      target_ref: { type: 'string', pattern: '^#[1-9][0-9]{0,3}$', maxLength: 8, required: true },
      snapshot_id: { type: 'string', maxLength: 64, required: true },
    },
    verify(before, after, args) {
      const item = itemOfRef(before, args?.target_ref)
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
      target_ref: { type: 'string', pattern: '^#[1-9][0-9]{0,3}$', maxLength: 8, required: true },
      snapshot_id: { type: 'string', maxLength: 64, required: true },
    },
    verify(before, after, args) {
      const item = itemOfRef(before, args?.target_ref)
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
      prefab: { type: 'string', pattern: '^[a-z_]{1,32}$', maxLength: 32 },
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
      target_ref: { type: 'string', pattern: '^#[1-9][0-9]{0,3}$', maxLength: 8, required: true },
      snapshot_id: { type: 'string', maxLength: 64, required: true },
    },
    /**
     * 核对：产物进背包 / 同一株的"可采"状态翻转 / 目标消失，三条路径命中任一即可。
     * 产物 prefab 由 Lua 的 gatherrules 决定（grass→cutgrass，sapling→twigs），这里照抄同一张表。
     */
    verify(before, after, args) {
      const item = itemOfRef(before, args?.target_ref)
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
