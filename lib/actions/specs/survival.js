// 生存与自保（6 个动作）
//
// 每个动作声明：riskLevel / category / description / 参数白名单 / 核对方式（verify）。
// 参数白名单是安全边界的一部分：args 里出现的其它键一律被拒（防模型夹带）。

import { countInInventory, equipmentItem, handItem } from '../state-query.js'
import { TARGET_REF_ARGS } from '../target-kinds.js'

export const survivalSpecs = {
  /**
   * SURVIVAL-04：脱下装备。核对：装备栏真的空了。
   */
  unequip: {
    riskLevel: 'R1',
    category: 'survival',
    description: '脱下手上的/身上的装备，放回背包',
    verifyWaitMs: 1500,
    args: {
      slot: { type: 'string', pattern: '^[a-z0-9_]{1,16}$', maxLength: 16 },
    },
    verify(before, after, args) {
      const slot = String(args?.slot ?? 'hands').toLowerCase()
      if (slot !== 'hands') return { ok: true, how: 'not_checked' } // 其它槽位没渲染，不判死
      const b = handItem(before)
      const a = handItem(after)
      if (b && !a) return { ok: true, unequipped: b }
      if (!b) return { ok: true, how: 'was_empty' }
      // 真机踩到（Cluster_1）：Lua 明确报了"把 torch 放回背包了（背包：torch-1）"，
      // 实际手上也空了，但 verify 判 still_equipped —— 装备块随观察间隔（2 秒）才刷新，
      // verifyWaitMs 当时只有 1500ms，读到的还是旧快照。
      // 兜底：背包里多出了手上那件东西 → 说明确实脱下来了（弱证据，方向正确）。
      if (b && countInInventory(after, b) > countInInventory(before, b)) {
        return { ok: true, unequipped: b, how: 'moved_to_inventory' }
      }
      return { ok: false, reason: 'still_equipped', hand: a }
    },
  },
  /**
   * SURVIVAL-04：给火堆加柴。核对：燃料物品真的少了。
   */
  fuel: {
    riskLevel: 'R1',
    category: 'survival',
    description: '给火堆/火坑添柴',
    requiresSnapshot: true,
    verifyWaitMs: 2500,
    args: {
      ...TARGET_REF_ARGS,
      item: { type: 'string', pattern: '^[a-z0-9_]{1,32}$', maxLength: 32 },
    },
    verify(before, after, args) {
      const prefab = String(args?.item ?? '')
      if (prefab) {
        const used = countInInventory(before, prefab) - countInInventory(after, prefab)
        if (used > 0) return { ok: true, used, prefab }
        return { ok: false, reason: 'fuel_not_consumed', prefab }
      }
      // 没指定燃料：只要背包里有燃料类物品减少就算成功
      for (const f of ['log', 'cutgrass', 'twigs', 'charcoal', 'boards']) {
        const d = countInInventory(before, f) - countInInventory(after, f)
        if (d > 0) return { ok: true, used: d, prefab: f }
      }
      return { ok: false, reason: 'fuel_not_consumed' }
    },
  },
  /**
   * SURVIVAL-03：等一会儿。核对只看"游戏确实在跑"（时间推进）。
   */
  wait: {
    riskLevel: 'R1',
    category: 'survival',
    description: '等一会儿（游戏时间秒）',
    verifyWaitMs: 3000,
    args: {
      seconds: { type: 'number', min: 1, max: 30 },
    },
    verify() {
      // 等待本身不改世界；游戏确认执行了就算成功（真正的"有没有效果"无从核对）
      return { ok: true }
    },
  },
  /**
   * SURVIVAL-03：丢掉背包里的东西。核对：该物品数量真的减少。
   */
  drop: {
    riskLevel: 'R1',
    category: 'survival',
    description: '把背包里的东西丢到地上',
    verifyWaitMs: 3000,
    args: {
      item: { type: 'string', pattern: '^[a-z0-9_]{1,32}$', maxLength: 32, required: true },
    },
    verify(before, after, args) {
      const prefab = String(args?.item ?? '')
      const lost = countInInventory(before, prefab) - countInInventory(after, prefab)
      if (lost > 0) return { ok: true, used: lost }
      return { ok: false, reason: 'inventory_unchanged' }
    },
  },
  /**
   * SURVIVAL-01：吃背包里的白名单食物。
   * 模型只能给 prefab 名（白名单在 Lua 的 eatrules），或者干脆不给（服务端挑最该吃的）。
   * **绝不接受** GUID / 路径 / 任意物品名。
   */
  eat: {
    riskLevel: 'R1',
    category: 'survival',
    description: '吃掉背包里的一份食物（只能吃白名单里的基础食物；不填就自动挑）',
    verifyWaitMs: 2500,
    args: {
      food: { type: 'string', pattern: '^[a-z0-9_]{1,32}$', maxLength: 32 },
    },
    /**
     * 核对：饥饿值必须真的涨了（或该食物数量减少）。
     * 只看动作返回"吃了"是不够的 —— 原生 EAT 在饿满时也可能被吃掉但没收益。
     */
    verify(before, after, args) {
      const hb = before?.player?.hunger?.current
      const ha = after?.player?.hunger?.current
      const gained = typeof hb === 'number' && typeof ha === 'number' ? ha - hb : null
      const prefab = typeof args?.food === 'string' ? args.food : null
      const used = prefab ? countInInventory(before, prefab) - countInInventory(after, prefab) : 0
      if (gained !== null && gained > 0.5) return { ok: true, hungerGained: gained, used }
      if (used > 0) return { ok: true, used }
      const healthBefore = before?.player?.health?.current
      const healthAfter = after?.player?.health?.current
      if (typeof healthBefore === 'number' && typeof healthAfter === 'number' && healthAfter > healthBefore + 0.5) {
        return { ok: true, healthGained: healthAfter - healthBefore, used }
      }
      return { ok: false, reason: 'hunger_unchanged' }
    },
  },
  /**
   * TENT（2026-11-17）：用帐篷/睡袋睡觉。
   *
   * 为什么现在才开放：Lua 的 JOBS.sleep 早就写好了（附近找 components.sleepingbag 的实体
   * ——帐篷就是，或者背包里的睡袋 → 推 SLEEPIN），但一直没接到工具表上，
   * 所以"造出帐篷"之后没有办法真的睡进去。
   *
   * 核对：睡一觉的证据必须是血/理智上涨，或者时间真的往前走了（跨时段/跨天）。
   * 只看 Lua 回执"醒了"不算 —— 那是动作层的自述。
   */
  sleep: {
    riskLevel: 'R2',
    category: 'survival',
    description: '在帐篷/睡袋里睡觉（回血回理智、掉饥饿）。附近要有帐篷（先 build tent），不用给引用',
    verifyWaitMs: 5000,
    args: {
      radius: { type: 'number', min: 2, max: 40 },
    },
    verify(before, after) {
      const num = (snap, key) => {
        const v = snap?.player?.[key]?.current
        return typeof v === 'number' ? v : null
      }
      const healthGain = (() => {
        const b = num(before, 'health'); const a = num(after, 'health')
        return b !== null && a !== null ? a - b : null
      })()
      if (healthGain !== null && healthGain > 0.5) return { ok: true, healthGained: healthGain }
      const sanityGain = (() => {
        const b = num(before, 'sanity'); const a = num(after, 'sanity')
        return b !== null && a !== null ? a - b : null
      })()
      if (sanityGain !== null && sanityGain > 0.5) return { ok: true, sanityGained: sanityGain }
      const wb = before?.world
      const wa = after?.world
      if (wb && wa && (wb.day !== wa.day || wb.phase !== wa.phase)) {
        return { ok: true, how: 'time_advanced', from: wb.phase ?? null, to: wa.phase ?? null }
      }
      return { ok: false, reason: 'sleep_not_confirmed' }
    },
  },
  /**
   * 装备背包里已有的白名单工具或光源，不接受任意物品名 / 槽位。
   */
  equip: {
    riskLevel: 'R1',
    category: 'survival',
    description: '装备背包里的工具、武器、防具或光源（torch / axe / pickaxe / lantern / minerhat / flowerhat / spear）',
    verifyWaitMs: 2000,
    args: {
      item: { type: 'string', pattern: '^[a-z0-9_]{1,32}$', maxLength: 32, required: true },
    },
    /**
     * 核对：装备栏（hand / head）必须真的变成这个物品。
     * 快照里 player.equipment.worn / slots 是游戏写的，不是我们猜的。
     */
    verify(before, after, args) {
      const item = String(args?.item ?? '')
      const ALLOWED = new Set(['torch', 'axe', 'pickaxe', 'lantern', 'minerhat', 'flowerhat', 'spear'])
      if (!ALLOWED.has(item)) return { ok: false, reason: 'item_not_equippable' }
      // ★ 真机 bug：这里曾经自己实现了一套 handOf，只认 worn[].slot/type，
      //   但真机形状是 `{ key: "hands", item: { prefab: "torch" } }`。
      //   结果是火把明明已经拿在手上，equip 仍报 hand_unchanged。
      //   统一用 state-query 的 handItem（同时吃 slots 对象和 worn 数组）。
      const slot = (item === 'minerhat' || item === 'flowerhat') ? 'head' : 'hands'
      const equipped = equipmentItem(after, slot)
      const beforeEquipped = equipmentItem(before, slot)
      // ① 目标物品已经在对应槽位上 → 成功（幂等：本来拿着也算达成）
      if (equipped === item) {
        return { ok: true, hand: slot === 'hands' ? equipped : handItem(after), equipped, slot }
      }
      // ② ★ 真机 bug（2026-11-16）：以前这里一律报 `hand_unchanged`，
      //    可"手没变"和"装备失败"是两件事：
      //      · 本来就拿着它 → 没事（幂等成功）
      //      · 想换但它没进槽位 → 真失败
      //    真机踩到：夜晚 equip torch 报 hand_unchanged，模型以为成功了就没再管，
      //    结果下一步 move_to 被 `dark_no_light` 拒（手其实是空的）—— 误导性极大。
      if (beforeEquipped === item) {
        // 之前就在手上，现在不在 → 被换掉了，这不算我们想要的结果
        return { ok: false, reason: 'equip_failed', hand: handItem(after), equipped, slot, note: '之前拿着但被换掉了' }
      }
      return { ok: false, reason: 'equip_failed', hand: handItem(after), equipped, slot }
    },
  },
}
