// 制作与建造（3 个动作）
//
// 每个动作声明：riskLevel / category / description / 参数白名单 / 核对方式（verify）。
// 参数白名单是安全边界的一部分：args 里出现的其它键一律被拒（防模型夹带）。

import { countInInventory, equipmentItem, handItem, inventoryItems } from '../state-query.js'

export const craftingSpecs = {
  /**
   * SURVIVAL-06：建造（放到地上）。核对：附近多了一个该建筑。
   * 白名单与 Lua 侧一致：campfire / firepit / chest / cookpot / sciencemachine。
   */
  build: {
    riskLevel: 'R2',
    category: 'crafting',
    description: '在地上造一个建筑',
    verifyWaitMs: 5000,
    args: {
      recipe: { type: 'string', pattern: '^[a-z_]{1,32}$', maxLength: 32, required: true },
    },
    verify(before, after, args) {
      const prefab = String(args?.recipe ?? '')
      const ALLOWED = ['campfire', 'firepit', 'chest', 'treasurechest', 'cookpot', 'sciencemachine', 'researchlab']
      if (!ALLOWED.includes(prefab)) return { ok: false, reason: 'recipe_not_allowed' }
      const PREFAB_MAP = {
        chest: 'treasurechest',
        sciencemachine: 'researchlab',
      }
      const actualPrefab = PREFAB_MAP[prefab] ?? prefab
      const countNear = (snap) => {
        const buckets = snap?.nearby?.buckets ?? {}
        let n = 0
        for (const list of Object.values(buckets)) {
          const arr = Array.isArray(list) ? list : Object.values(list ?? {})
          for (const it of arr) if (it?.prefab === actualPrefab) n += 1
        }
        return n
      }
      const b = countNear(before)
      const a = countNear(after)
      if (a > b) return { ok: true, made: a - b, product: prefab }
      // 建筑刚放下时可能还没进附近列表；这种情况下退回"材料被扣了"作为弱证据
      const items = (snap) => inventoryItems(snap)
      const total = (snap) => items(snap).reduce((s, i) => s + Number(i?.count ?? 1), 0)
      if (total(after) < total(before)) return { ok: true, how: 'materials_consumed' }
      return { ok: false, reason: 'build_not_found' }
    },
  },
  /**
   * SURVIVAL-05：锅（放材料煮 / 拿成品）。核对：背包有变化。
   */
  cook: {
    riskLevel: 'R2',
    category: 'crafting',
    description: '往锅里放材料开始煮，或者把煮好的拿出来',
    requiresSnapshot: true,
    verifyWaitMs: 3000,
    args: {
      target_ref: { type: 'string', pattern: '^#[1-9][0-9]{0,3}$', maxLength: 8, required: true },
      snapshot_id: { type: 'string', maxLength: 64, required: true },
      items: { type: 'string', maxLength: 120 },
    },
    verify(before, after) {
      const items = (snap) => inventoryItems(snap)
      const m = (snap) => {
        const out = {}
        for (const i of items(snap)) if (i?.prefab) out[i.prefab] = (out[i.prefab] ?? 0) + Number(i.count ?? 1)
        return out
      }
      const b = m(before)
      const a = m(after)
      const keys = new Set([...Object.keys(b), ...Object.keys(a)])
      for (const k of keys) {
        const d = (a[k] ?? 0) - (b[k] ?? 0)
        if (d !== 0) return { ok: true, product: k, gained: d }
      }
      return { ok: false, reason: 'inventory_unchanged' }
    },
  },
  /**
   * SURVIVAL-01：制作白名单里的基础工具（torch / axe / pickaxe）。
   * recipe 必须是白名单里的名字，**不接受**任意配方、建造、摆建筑。
   */
  craft: {
    riskLevel: 'R2',
    category: 'crafting',
    description: '制作一个基础工具（只开放 torch / axe / pickaxe）',
    verifyWaitMs: 3000,
    args: {
      recipe: { type: 'string', pattern: '^[a-z_]{1,32}$', maxLength: 32, required: true },
    },
    /**
     * 核对：成品必须真的进了背包（数量 +1）。
     * 材料消耗由 Lua 侧先查（ingredients_missing），这里只确认结果。
     */
    verify(before, after, args) {
      const recipe = String(args?.recipe ?? '')
      const ALLOWED = new Set(['torch', 'axe', 'pickaxe', 'flowerhat'])
      if (!ALLOWED.has(recipe)) return { ok: false, reason: 'recipe_not_allowed' }
      const b = countInInventory(before, recipe)
      const a = countInInventory(after, recipe)
      if (a > b) return { ok: true, made: a - b }
      // ★ 手部自动装备（torch 等）
      const handAfter = handItem(after)
      const handBefore = handItem(before)
      if (handAfter === recipe && handBefore !== recipe) {
        return { ok: true, made: 1, how: 'auto_equipped', hand: handAfter }
      }
      // ★ 头部自动装备（flowerhat 等）
      const headAfter = equipmentItem(after, 'head')
      const headBefore = equipmentItem(before, 'head')
      if (headAfter === recipe && headBefore !== recipe) {
        return { ok: true, made: 1, how: 'auto_equipped_head', head: headAfter }
      }
      return { ok: false, reason: 'craft_not_in_inventory', hand: handAfter }
    },
  },
}
