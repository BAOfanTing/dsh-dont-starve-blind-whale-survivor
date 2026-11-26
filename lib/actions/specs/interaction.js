// 交互与容器（4 个动作）
//
// 每个动作声明：riskLevel / category / description / 参数白名单 / 核对方式（verify）。
// 参数白名单是安全边界的一部分：args 里出现的其它键一律被拒（防模型夹带）。

import { findSameEntity, inventoryItems, targetItem } from '../state-query.js'
import { TARGET_REF_ARGS } from '../target-kinds.js'

export const interactionSpecs = {
  /**
   * SURVIVAL-05：从容器里拿东西。核对：背包里该物品增加。
   */
  container_take: {
    riskLevel: 'R2',
    category: 'interaction',
    description: '从箱子/冰箱里拿东西出来',
    requiresSnapshot: true,
    verifyWaitMs: 2500,
    args: {
      ...TARGET_REF_ARGS,
      item: { type: 'string', pattern: '^[a-z0-9_]{1,32}$', maxLength: 32 },
      count: { type: 'number', min: 1, max: 40, integer: true },
    },
    verify(before, after, args) {
      const prefab = String(args?.item ?? '')
      const items = (snap) => inventoryItems(snap)
      const countOf = (snap, p) => items(snap).filter((i) => i?.prefab === p).reduce((s, i) => s + Number(i?.count ?? 1), 0)
      if (prefab) {
        const d = countOf(after, prefab) - countOf(before, prefab)
        if (d > 0) return { ok: true, gained: d, product: prefab }
        return { ok: false, reason: 'inventory_unchanged', prefab }
      }
      // 没指定：任一物品增加就算成功
      const prefabs = new Set([...items(before), ...items(after)].map((i) => i?.prefab).filter(Boolean))
      for (const p of prefabs) {
        const d = countOf(after, p) - countOf(before, p)
        if (d > 0) return { ok: true, gained: d, product: p }
      }
      return { ok: false, reason: 'inventory_unchanged' }
    },
  },
  /**
   * SURVIVAL-05：往容器里放东西。核对：背包里该物品减少。
   */
  container_put: {
    riskLevel: 'R2',
    category: 'interaction',
    description: '把背包里的东西放进箱子/冰箱',
    requiresSnapshot: true,
    verifyWaitMs: 2500,
    args: {
      ...TARGET_REF_ARGS,
      item: { type: 'string', pattern: '^[a-z0-9_]{1,32}$', maxLength: 32, required: true },
    },
    verify(before, after, args) {
      const prefab = String(args?.item ?? '')
      const items = (snap) => inventoryItems(snap)
      const countOf = (snap, p) => items(snap).filter((i) => i?.prefab === p).reduce((s, i) => s + Number(i?.count ?? 1), 0)
      const lost = countOf(before, prefab) - countOf(after, prefab)
      if (lost > 0) return { ok: true, used: lost, prefab }
      return { ok: false, reason: 'inventory_unchanged', prefab }
    },
  },
  /**
   * SURVIVAL-05：把东西给某个目标。核对：背包里该物品减少。
   */
  give: {
    riskLevel: 'R2',
    category: 'interaction',
    description: '把背包里的东西给某个目标（猪人/鸟/队友）',
    requiresSnapshot: true,
    verifyWaitMs: 3000,
    args: {
      ...TARGET_REF_ARGS,
      item: { type: 'string', pattern: '^[a-z0-9_]{1,32}$', maxLength: 32, required: true },
    },
    verify(before, after, args) {
      const prefab = String(args?.item ?? '')
      const items = (snap) => inventoryItems(snap)
      const countOf = (snap, p) => items(snap).filter((i) => i?.prefab === p).reduce((s, i) => s + Number(i?.count ?? 1), 0)
      const lost = countOf(before, prefab) - countOf(after, prefab)
      if (lost > 0) return { ok: true, used: lost, prefab }
      return { ok: false, reason: 'inventory_unchanged', prefab }
    },
  },
  /**
   * SURVIVAL-04：通用交互（ACTIVATE / ACTIVATE_CONTAINER / RUMMAGE / TAKEITEM / READ / PICKUP / OPEN_CRAFTING / LIGHT）。
   * 只允许白名单动作名，不给模型任意 ACTIONS。
   */
  use: {
    riskLevel: 'R2',
    category: 'interaction',
    description: '对目标做一次交互（开箱子/读书/使用/激活/取出/点火）',
    requiresSnapshot: true,
    // LIGHT 要等「点着 + 撤离」：给足轮询时间，别在火还没烧起来时就判失败。
    verifyWaitMs: 6000,
    args: {
      ...TARGET_REF_ARGS,
      // 允许下划线：ACTIVATE_CONTAINER / OPEN_CRAFTING 都是真实动作名
      action: { type: 'string', pattern: '^[A-Z_]{1,24}$', maxLength: 24 },
    },
    verify(before, after, args) {
      const item = targetItem(before, args)
      if (!item) return { ok: false, reason: 'unknown_ref' }
      const action = String(args?.action ?? '').toUpperCase()
      if (action === 'LIGHT') {
        const same = findSameEntity(after, item)
        if (!same) return { ok: true, how: 'target_gone' }
        if (same.is_burning === true) return { ok: true, how: 'ignited', prefab: item.prefab }
        if (same.is_burnt === true) return { ok: true, how: 'burnt', prefab: item.prefab }
        return { ok: false, reason: 'target_not_ignited', prefab: item.prefab }
      }
      // 交互可能改背包（取出/读掉），也可能只是打开界面；两者都算"游戏确认执行"
      let gained = 0
      const items = (snap) => inventoryItems(snap)
      const countOf = (snap, prefab) => items(snap).filter((i) => i?.prefab === prefab).reduce((s, i) => s + Number(i?.count ?? 1), 0)
      const prefabs = new Set([...items(before), ...items(after)].map((i) => i?.prefab).filter(Boolean))
      for (const prefab of prefabs) gained += Math.max(0, countOf(after, prefab) - countOf(before, prefab))
      if (gained > 0) return { ok: true, gained }
      const same = findSameEntity(after, item)
      if (!same) return { ok: true, how: 'target_gone' }
      return { ok: true, how: 'interaction_sent' }
    },
  },
}
